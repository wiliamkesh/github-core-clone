// Git smart-HTTP surface: upload-pack v2 (+ v0 fallback) and receive-pack v0.
// Speaks the suite's git client (kit program/env/src/git-client.ts) and real git.
// See ~/workspace/makefun/gcc-specs/git.md for the full contract.
//
// Design notes:
// - Whole objects only on generate (no deltas): the suite accepts that and it is
//   faster to build. Parsing accepts deltas (pack.ts) because real git sends them.
// - Depth-1 single-want fetches (the clone benchmark: 50 concurrent clones of
//   the same tip) reuse a memoized pack on the repo, invalidated by any ref
//   change (store.setRef clears it).
// - No wall clock: commits the server builds (contents API / merges) use the
//   store's logical clock; pushed objects are stored byte-identically.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Buffer } from 'node:buffer';
import { encodePack, parsePack } from './pack.ts';
import { parseCommit, parseTree } from './gitobj.ts';
import { pktDelim, pktFlush, pktLine, parseAllPktLines, parsePktLines } from './pktline.ts';
import { ZERO_OID, type Repo, type Store } from './store.ts';

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const OID_RE = /^[0-9a-f]{40}$/;

/** Shared empty body (avoids allocating a Buffer for body-less requests). */
const EMPTY = Buffer.alloc(0);

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // Single-chunk fast path: most payloads (push/clone/fetch) arrive in one
    // TCP chunk. Keep the first chunk directly; only allocate the array +
    // Buffer.concat when a second chunk arrives.
    let first: Buffer | null = null;
    let rest: Buffer[] | null = null;
    req.on('data', (c: Buffer) => {
      if (first === null) {
        first = c;
      } else {
        if (rest === null) rest = [first];
        rest.push(c);
      }
    });
    req.on('end', () => {
      if (rest !== null) resolve(Buffer.concat(rest));
      else resolve(first ?? EMPTY);
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, store: Store, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': store.nextRequestId(),
  });
  res.end(body);
}

function sendJson(store: Store, res: ServerResponse, status: number, body: unknown): void {
  send(res, store, status, 'application/json; charset=utf-8', Buffer.from(`${JSON.stringify(body)}\n`, 'utf8'));
}

/** Split a sideband payload stream into band-1 packets (max pkt-line 65520). */
function sideband(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65515; // 1 band byte + 65515 data bytes = 65516 payload
  for (let off = 0; off < pack.length; off += CHUNK) {
    const slice = pack.subarray(off, Math.min(pack.length, off + CHUNK));
    const payload = Buffer.concat([Buffer.from([1]), slice]);
    parts.push(pktLine(payload));
  }
  if (pack.length === 0) {
    // An empty pack is still 32 bytes (header + trailer), so this never fires;
    // kept for safety: a packfile section needs >= 1 sideband packet.
    parts.push(pktLine(Buffer.from([1])));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/**
 * Report-status as sideband band-1 packets. TWO flushes are required, at
 * two different levels (verified against git 2.43.0 source + live git CLI):
 *  1. an INNER flush inside the band-1 payload: the report stream is itself
 *     a pkt-line stream, and receive_status reads it until a flush — EOF
 *     without one dies with "the remote end hung up unexpectedly".
 *     (Real git's builtin/receive-pack.c report(): packet_buf_flush(&buf)
 *     BEFORE send_sideband(1, 1, buf...).)
 *  2. an OUTER bare flush after the band-1 packets: recv_sideband only
 *     returns success (SIDEBAND_FLUSH = 0) when it reads a flush packet;
 *     end-of-body without one is SIDEBAND_PROTOCOL_ERROR ("unexpected
 *     disconnect while reading sideband packet" / "error in sideband
 *     demultiplexer", push exits non-zero even though the ref updated).
 */
function sidebandReport(report: Buffer): Buffer {
  const framed = Buffer.concat([report, pktFlush()]);
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let off = 0; off < framed.length; off += CHUNK) {
    const slice = framed.subarray(off, Math.min(framed.length, off + CHUNK));
    const payload = Buffer.concat([Buffer.from([1]), slice]);
    parts.push(pktLine(payload));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** Follow annotated tags to their ultimate target; returns the commit oid or null. */
function peelTag(store: Store, oid: string): string | null {
  let cur = oid.toLowerCase();
  for (let i = 0; i < 10; i++) {
    const obj = store.getObject(cur);
    if (!obj || obj.type !== 'tag') return obj?.type === 'commit' ? cur : null;
    const text = obj.data.toString('utf8');
    const mObj = /^object ([0-9a-f]{40})$/m.exec(text);
    const mType = /^type (\w+)$/m.exec(text);
    if (!mObj || !mType) return null;
    if (mType[1] !== 'tag') return mType[1] === 'commit' ? mObj[1] : null;
    cur = mObj[1];
  }
  return null;
}

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
}

/** All refs of a repo, HEAD first, then heads/tags sorted. */
function listRefs(store: Store, repo: Repo, peel: boolean): RefLine[] {
  const out: RefLine[] = [];
  const head = store.headOid(repo);
  if (head) {
    out.push({ oid: head, name: 'HEAD', symrefTarget: store.headRef(repo) });
  }
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const line: RefLine = { oid, name };
    if (peel && name.startsWith('refs/tags/')) {
      const peeled = peelTag(store, oid);
      if (peeled) line.peeled = peeled;
    }
    out.push(line);
  }
  return out;
}

function formatRefLine(line: RefLine): string {
  let s = `${line.oid} ${line.name}`;
  if (line.symrefTarget) s += ` symref-target:${line.symrefTarget}`;
  if (line.peeled) s += ` peeled:${line.peeled}`;
  return `${s}\n`;
}

// ---------------------------------------------------------------------------
// Advertisements
// ---------------------------------------------------------------------------
/** The v2 capability advertisement never changes: build it once, not per info/refs. */
const UPLOAD_PACK_AD_V2 = Buffer.concat([
  pktLine('version 2\n'),
  pktLine('ls-refs=unborn\n'),
  pktLine('fetch=shallow\n'),
  pktLine('object-format=sha1\n'),
  pktFlush(),
]);

function uploadPackAdvertiseV2(): Buffer {
  return UPLOAD_PACK_AD_V2;
}

function uploadPackAdvertiseV0(store: Store, repo: Repo): Buffer {
  const refs = listRefs(store, repo, true);
  const caps = 'side-band-64k multi_ack thin-pack ofs-delta shallow agent=makefun-github-core-clone/1 symref=HEAD:refs/heads/main';
  const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), pktFlush()];
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((line, i) => {
      let s = formatRefLine(line).slice(0, -1); // strip \n, re-add below
      if (i === 0) s += `\0${caps}`;
      parts.push(pktLine(`${s}\n`));
      if (line.name.startsWith('refs/tags/') && line.peeled) {
        parts.push(pktLine(`${line.peeled} ${line.name}^{}\n`));
      }
    });
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function receivePackAdvertise(store: Store, repo: Repo): Buffer {
  const refs = listRefs(store, repo, true);
  const caps =
    'report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=makefun-github-core-clone/1 symref=HEAD:refs/heads/main';
  const parts: Buffer[] = [pktLine('# service=git-receive-pack\n'), pktFlush()];
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((line, i) => {
      let s = formatRefLine(line).slice(0, -1);
      if (i === 0) s += `\0${caps}`;
      parts.push(pktLine(`${s}\n`));
      if (line.name.startsWith('refs/tags/') && line.peeled) {
        parts.push(pktLine(`${line.peeled} ${line.name}^{}\n`));
      }
    });
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Fetch computation (shared by v2 and v0)
// ---------------------------------------------------------------------------
interface FetchPlan {
  wants: string[];
  haves: string[];
  shallows: string[]; // client's current shallow boundaries
  deepen: number | null;
}

interface FetchResult {
  /** Pack bytes to send (possibly an empty pack). */
  pack: Buffer;
  /** Boundary commits to report as shallow. */
  shallow: string[];
  /** Old boundaries that are no longer boundaries. */
  unshallow: string[];
  /** Haves the server holds (for ACK lines). */
  acked: string[];
}

/**
 * Compute what a fetch must deliver.
 * - Included commits: BFS from wants, distance < deepen (or unbounded), never
 *   traversing past a client-declared shallow boundary.
 * - Sent objects: reachable closure of included commits, minus the closure of
 *   the haves.
 */
function planFetch(store: Store, plan: FetchPlan): FetchResult {
  const D = plan.deepen ?? Infinity;
  const clientShallow = new Set(plan.shallows.map((s) => s.toLowerCase()));
  const included = new Set<string>();
  // BFS by distance from the wants. Tags are wants too (clone asks for tag
  // oids): include the tag object and walk to its target at the same depth.
  const queue: { oid: string; dist: number }[] = plan.wants.map((w) => ({ oid: w.toLowerCase(), dist: 0 }));
  const seenDist = new Map<string, number>();
  while (queue.length > 0) {
    const { oid, dist } = queue.shift()!;
    if (seenDist.has(oid) || dist >= D || oid === ZERO_OID) continue;
    seenDist.set(oid, dist);
    const obj = store.getObject(oid);
    if (!obj) continue;
    included.add(oid);
    if (obj.type === 'commit') {
      const info = parseCommit(obj.data);
      // A shallow boundary blocks traversal ONLY when no deepen was asked:
      // deepen=N redefines the depth from the wants, so the old boundary's
      // parents are included up to the new depth. (The shallow lines still
      // matter for the have-exclusion below and for unshallow reporting.)
      if (plan.deepen === null && clientShallow.has(oid)) continue;
      for (const p of info.parents) queue.push({ oid: p.toLowerCase(), dist: dist + 1 });
    } else if (obj.type === 'tag') {
      const text = obj.data.toString('utf8');
      const m = /^object ([0-9a-f]{40})$/m.exec(text);
      if (m) queue.push({ oid: m[1], dist });
    }
  }
  // Boundary commits are included commits with a parent that is NOT included.
  const shallow: string[] = [];
  for (const oid of included) {
    const obj = store.getObject(oid);
    if (!obj || obj.type !== 'commit') continue;
    const info = parseCommit(obj.data);
    if (info.parents.length > 0 && info.parents.some((p) => !included.has(p.toLowerCase()))) {
      shallow.push(oid);
    }
  }
  // Unshallow: a client boundary that is now included AND has an included parent.
  const unshallow: string[] = [];
  for (const oid of clientShallow) {
    if (!included.has(oid)) continue;
    const obj = store.getObject(oid);
    if (!obj || obj.type !== 'commit') continue;
    const info = parseCommit(obj.data);
    if (info.parents.some((p) => included.has(p.toLowerCase()))) unshallow.push(oid);
  }
  // Objects to send: the depth-limited closure of the included commits
  // (parents only when they are themselves included — the shallow limit),
  // minus what the client holds. What the client holds is the closure of
  // the haves STOPPED at its shallow boundaries: a shallow clone holds the
  // boundary commit and its tree, but NOT the boundary's parents.
  const haveClosure = new Set(
    store.reachableObjects(plan.haves, new Set(), undefined, new Set(plan.shallows.map((s) => s.toLowerCase()))),
  );
  const toSend = store.reachableObjects([...included], haveClosure, included);
  const objects = toSend
    .map((oid) => store.getObject(oid))
    .filter((o): o is NonNullable<typeof o> => o !== undefined);
  const acked = plan.haves.filter((h) => store.hasObject(h));
  return { pack: encodePack(objects, { level: 1 }), shallow, unshallow, acked };
}

// ---------------------------------------------------------------------------
// upload-pack v2: ls-refs / fetch
// ---------------------------------------------------------------------------
function handleLsRefs(store: Store, repo: Repo, args: Map<string, string[]>, res: ServerResponse): void {
  const peel = !args.has('peel') || args.get('peel')![0] !== 'false';
  const symrefs = !args.has('symrefs') || args.get('symrefs')![0] !== 'false';
  const prefixes = args.get('ref-prefix') ?? [];
  let refs = listRefs(store, repo, peel);
  if (!symrefs) refs = refs.map((r) => ({ ...r, symrefTarget: undefined }));
  if (prefixes.length > 0) {
    refs = refs.filter((r) => prefixes.some((p) => r.name.startsWith(p)));
  }
  const parts = refs.map((r) => pktLine(formatRefLine(r)));
  // Empty repo: report the unborn HEAD so real git (and the suite's client)
  // know the default branch is refs/heads/main. Not a refs/* ref, so it
  // does not count toward "0 refs" in clone-empty. Real git sends
  // ref-prefixes including "HEAD" with its ls-refs, so the unborn line is
  // emitted whenever "HEAD" passes the prefix filter (or no filter given).
  if (refs.length === 0 && args.has('unborn')) {
    const headMatches = prefixes.length === 0 || prefixes.some((p) => 'HEAD'.startsWith(p));
    if (headMatches) {
      const target = symrefs ? ' symref-target:refs/heads/main' : '';
      parts.push(pktLine(`unborn HEAD${target}\n`));
    }
  }
  parts.push(pktFlush());
  send(res, store, 200, UPLOAD_RESULT, Buffer.concat(parts));
}

/**
 * Frame a depth-1 (no-haves) fetch response: shallow-info + packfile +
 * sideband. Byte-identical to what the shared builder below produces for
 * this path (no acknowledgments section: no haves were sent).
 */
function framePackResponse(shallow: string[], unshallow: string[], pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const s of unshallow) parts.push(pktLine(`unshallow ${s}\n`));
    parts.push(pktFlush());
  }
  parts.push(pktLine('packfile\n'), sideband(pack));
  return Buffer.concat(parts);
}

function handleFetchV2(store: Store, repo: Repo, plan: FetchPlan, res: ServerResponse): void {
  const hasHaves = plan.haves.length > 0;
  // Depth-1 single-want fast path (clone benchmark): memoized full response
  // per tip. The hit path sends the cached buffer with zero framing work.
  if (plan.wants.length === 1 && plan.deepen === 1 && plan.haves.length === 0) {
    const want = plan.wants[0].toLowerCase();
    const cached = repo.clonePackCache;
    if (cached && cached.tip === want) {
      send(res, store, 200, UPLOAD_RESULT, cached.responseBody);
      return;
    }
    const result = planFetch(store, plan);
    const responseBody = framePackResponse(result.shallow, result.unshallow, result.pack);
    repo.clonePackCache = { tip: want, pack: result.pack, shallow: result.shallow, responseBody };
    send(res, store, 200, UPLOAD_RESULT, responseBody);
    return;
  }
  const result = planFetch(store, plan);
  const pack = result.pack;
  const shallow = result.shallow;
  const unshallow = result.unshallow;
  const acked = result.acked;
  const parts: Buffer[] = [];
  // Acknowledgments ONLY when the client sent haves (negotiation round).
  // Real git (fetch-pack.c) goes straight to FETCH_GET_PACK when no haves
  // were sent and dies "expected 'packfile', received 'acknowledgments'"
  // if the section is present anyway. When haves were sent, the section is
  // mandatory, ends with DELIM (not flush) when "ready" is sent — "ready"
  // means a packfile follows — and we always send a packfile (possibly an
  // empty one for want==have), so "ready" is always sent here.
  if (hasHaves) {
    parts.push(pktLine('acknowledgments\n'));
    if (acked.length > 0) {
      for (const a of acked) parts.push(pktLine(`ACK ${a}\n`));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(pktLine('ready\n'));
    parts.push(pktDelim());
  }
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const s of unshallow) parts.push(pktLine(`unshallow ${s}\n`));
    parts.push(pktFlush());
  }
  parts.push(pktLine('packfile\n'), sideband(pack));
  send(res, store, 200, UPLOAD_RESULT, Buffer.concat(parts));
}

/** Parse a v2 command body into (command, args). Throws on malformed input.
 * Lines are `key=value` (command=, agent=, object-format=) OR `key value`
 * (want, have, shallow, deepen, ref-prefix, filter) OR a bare word
 * (thin-pack, no-progress, ofs-delta, peel, symrefs, unborn, done). */
function parseV2Command(body: Buffer): { command: string; args: Map<string, string[]> } {
  const items = parseAllPktLines(body);
  const args = new Map<string, string[]>();
  let command = '';
  let afterDelim = false;
  for (const it of items) {
    if (it.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (it.kind !== 'data') continue;
    const line = it.data.toString('utf8').replace(/\n$/, '');
    let key: string;
    let value: string;
    const eq = line.indexOf('=');
    const sp = line.indexOf(' ');
    if (eq >= 0 && (sp < 0 || eq < sp)) {
      key = line.slice(0, eq);
      value = line.slice(eq + 1);
    } else if (sp >= 0) {
      key = line.slice(0, sp);
      value = line.slice(sp + 1);
    } else {
      key = line;
      value = '';
    }
    if (key === 'command') {
      command = value;
      continue;
    }
    void afterDelim;
    const list = args.get(key) ?? [];
    list.push(value);
    args.set(key, list);
  }
  return { command, args };
}

function handleUploadPackV2(store: Store, repo: Repo, body: Buffer, res: ServerResponse): void {
  let parsed;
  try {
    parsed = parseV2Command(body);
  } catch {
    sendJson(store, res, 400, { message: 'Malformed pkt-line request' });
    return;
  }
  if (parsed.command === 'ls-refs') {
    handleLsRefs(store, repo, parsed.args, res);
    return;
  }
  if (parsed.command === 'fetch') {
    const wants = parsed.args.get('want') ?? [];
    const haves = parsed.args.get('have') ?? [];
    const shallows = parsed.args.get('shallow') ?? [];
    const deepenRaw = parsed.args.get('deepen')?.[0];
    const deepen = deepenRaw !== undefined ? parseInt(deepenRaw, 10) : null;
    if (wants.some((w) => !OID_RE.test(w)) || haves.some((h) => !OID_RE.test(h))) {
      sendJson(store, res, 400, { message: 'Bad object id in fetch' });
      return;
    }
    handleFetchV2(store, repo, { wants, haves, shallows, deepen: deepen !== null && !Number.isNaN(deepen) ? deepen : null }, res);
    return;
  }
  sendJson(store, res, 400, { message: `Unknown upload-pack command ${parsed.command}` });
}

// ---------------------------------------------------------------------------
// upload-pack v0 fetch (fallback; the suite uses v2, real git may use v0)
// ---------------------------------------------------------------------------
function handleUploadPackV0(store: Store, repo: Repo, body: Buffer, res: ServerResponse): void {
  // Two sections separated by a flush: wants (+caps on first want), then haves + done.
  let first;
  try {
    first = parsePktLines(body, 0);
  } catch {
    sendJson(store, res, 400, { message: 'Malformed pkt-line request' });
    return;
  }
  const wants: string[] = [];
  const haves: string[] = [];
  const shallows: string[] = [];
  let deepen: number | null = null;
  const readSection = (items: ReturnType<typeof parsePktLines>['items']): void => {
    for (const it of items) {
      if (it.kind !== 'data') continue;
      const line = it.data.toString('utf8').replace(/\n$/, '');
      if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]);
      else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) shallows.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) deepen = parseInt(line.slice(7), 10);
    }
  };
  readSection(first.items);
  let off = first.next;
  while (off < body.length) {
    const chunk = parsePktLines(body, off);
    readSection(chunk.items);
    off = chunk.next;
    if (chunk.items.some((i) => i.kind === 'flush')) break;
  }
  if (wants.some((w) => !OID_RE.test(w))) {
    sendJson(store, res, 400, { message: 'Bad object id in fetch' });
    return;
  }
  const result = planFetch(store, { wants, haves, shallows, deepen });
  const parts: Buffer[] = [];
  if (result.acked.length > 0) {
    for (const a of result.acked) parts.push(pktLine(`ACK ${a}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const s of result.shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const s of result.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
  parts.push(sideband(result.pack));
  send(res, store, 200, UPLOAD_RESULT, Buffer.concat(parts));
}

// ---------------------------------------------------------------------------
// receive-pack v0 (push)
// ---------------------------------------------------------------------------
interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(store: Store, repo: Repo, body: Buffer, res: ServerResponse): void {
  let first;
  try {
    first = parsePktLines(body, 0);
  } catch {
    sendJson(store, res, 400, { message: 'Malformed pkt-line request' });
    return;
  }
  const lines: string[] = [];
  let clientCaps = '';
  for (const it of first.items) {
    if (it.kind !== 'data') continue;
    let line = it.data.toString('utf8');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      clientCaps = line.slice(nul + 1).replace(/\n$/, '');
      line = line.slice(0, nul);
    }
    lines.push(line.replace(/\n$/, ''));
  }
  const commands: PushCommand[] = [];
  for (const line of lines) {
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (!m) {
      sendJson(store, res, 400, { message: `Malformed push command ${JSON.stringify(line)}` });
      return;
    }
    commands.push({ oldOid: m[1], newOid: m[2], ref: m[3] });
  }
  const packBytes = body.subarray(first.next);
  const needsPack = commands.some((c) => c.newOid !== ZERO_OID);
  let unpackError: string | null = null;
  if (needsPack) {
    if (packBytes.length === 0) {
      unpackError = 'missing pack';
    } else {
      try {
        // REF_DELTA bases may live in the store, not the pack (thin packs
        // from real git clients): resolveBase falls back to stored objects.
        const objects = parsePack(packBytes, (id) => store.getObject(id));
        for (const obj of objects) store.putObject(obj);
      } catch (err) {
        unpackError = err instanceof Error ? err.message : 'pack parse failed';
      }
    }
  }
  // Apply ref updates.
  const report: string[] = [];
  if (unpackError) {
    report.push(`unpack ${unpackError}\n`);
    for (const c of commands) report.push(`ng ${c.ref} unpack-failed\n`);
  } else {
    report.push('unpack ok\n');
    for (const c of commands) {
      if (!c.ref.startsWith('refs/') || c.ref.length > 200 || /\s/.test(c.ref)) {
        report.push(`ng ${c.ref} invalid-ref\n`);
        continue;
      }
      const current = store.getRef(repo, c.ref);
      if (c.newOid === ZERO_OID) {
        // Delete.
        if (!current) {
          report.push(`ng ${c.ref} delete-non-existent\n`);
        } else if (c.oldOid !== ZERO_OID && c.oldOid !== current) {
          report.push(`ng ${c.ref} non-fast-forward\n`);
        } else {
          store.deleteRef(repo, c.ref);
          report.push(`ok ${c.ref}\n`);
        }
        continue;
      }
      if (!store.hasObject(c.newOid)) {
        report.push(`ng ${c.ref} object-not-found\n`);
        continue;
      }
      if (c.oldOid === ZERO_OID) {
        // Create.
        if (current) {
          report.push(`ng ${c.ref} already-exists\n`);
        } else {
          store.setRef(repo, c.ref, c.newOid);
          report.push(`ok ${c.ref}\n`);
        }
        continue;
      }
      // Update: old must match, new must descend from old.
      if (current !== c.oldOid) {
        report.push(`ng ${c.ref} non-fast-forward\n`);
      } else if (!store.isAncestor(c.oldOid, c.newOid)) {
        report.push(`ng ${c.ref} non-fast-forward\n`);
      } else {
        store.setRef(repo, c.ref, c.newOid);
        report.push(`ok ${c.ref}\n`);
      }
    }
  }
  const reportBytes = Buffer.concat(report.map((l) => pktLine(l)));
  const useSideband = clientCaps.split(' ').includes('side-band-64k');
  const bodyOut = useSideband ? sidebandReport(reportBytes) : Buffer.concat([reportBytes, pktFlush()]);
  send(res, store, 200, RECEIVE_RESULT, bodyOut);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
/**
 * Handle a git smart-HTTP request. Returns true when the path is a git route
 * (handled, whatever the outcome), false when it is not a git path at all.
 */
export async function handleGit(store: Store, token: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    return false;
  }
  const m = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname);
  if (!m) return false;
  const [, owner, repoName, service] = m;
  if (!NAME_RE.test(owner) || !NAME_RE.test(repoName)) {
    sendJson(store, res, 404, { message: 'Not Found' });
    return true;
  }
  // Auth: the suite always sends the trial token. With no token configured
  // (local dev) auth is skipped.
  if (token !== '') {
    const auth = req.headers.authorization ?? '';
    if (auth !== `Bearer ${token}`) {
      sendJson(store, res, 401, { message: 'Unauthorized' });
      return true;
    }
  }
  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    sendJson(store, res, 404, { message: 'Not Found' });
    return true;
  }
  const method = req.method ?? 'GET';
  if (service === 'info/refs') {
    if (method !== 'GET') {
      sendJson(store, res, 405, { message: 'Method Not Allowed' });
      return true;
    }
    const svc = url.searchParams.get('service');
    if (svc === 'git-upload-pack') {
      if ((req.headers['git-protocol'] ?? '') === 'version=2') {
        send(res, store, 200, UPLOAD_AD, uploadPackAdvertiseV2());
      } else {
        send(res, store, 200, UPLOAD_AD, uploadPackAdvertiseV0(store, repo));
      }
      return true;
    }
    if (svc === 'git-receive-pack') {
      send(res, store, 200, RECEIVE_AD, receivePackAdvertise(store, repo));
      return true;
    }
    sendJson(store, res, 400, { message: 'Unknown service' });
    return true;
  }
  if (method !== 'POST') {
    sendJson(store, res, 405, { message: 'Method Not Allowed' });
    return true;
  }
  const body = await readBody(req);
  if (service === 'git-upload-pack') {
    if ((req.headers['git-protocol'] ?? '') === 'version=2') {
      handleUploadPackV2(store, repo, body, res);
    } else {
      handleUploadPackV0(store, repo, body, res);
    }
    return true;
  }
  // git-receive-pack
  handleReceivePack(store, repo, body, res);
  return true;
}

// Re-exported for tests: parse a tag object to its commit.
export { peelTag };
export type { FetchPlan };
