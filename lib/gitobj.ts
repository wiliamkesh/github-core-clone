// Git object model: SHA-1 content-addressed objects (blob, tree, commit, tag).
// Standard git formats; the suite's git client verifies hashes and round-trips,
// so serialization must be byte-exact. No wall clock here: timestamps come from
// the store's logical clock so a replay is byte-identical.
import { createHash } from 'node:crypto';

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  readonly type: ObjType;
  /** Raw content bytes (without the "<type> <size>\0" header). */
  readonly data: Buffer;
  /** SHA-1 hex id = sha1("<type> <size>\0" + data). */
  readonly id: string;
}

export function sha1(buf: Buffer): string {
  return createHash('sha1').update(buf).digest('hex');
}

/** Build an object from its type and raw content bytes. */
export function makeObject(type: ObjType, data: Buffer): GitObject {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  const id = sha1(Buffer.concat([header, data]));
  return { type, data, id };
}

/** Serialize an object to its full on-disk/wire form ("<type> <size>\0" + data). */
export function serializeObject(obj: GitObject): Buffer {
  const header = Buffer.from(`${obj.type} ${obj.data.length}\0`, 'ascii');
  return Buffer.concat([header, obj.data]);
}

/** Parse a full object ("<type> <size>\0" + data) back into its parts. */
export function parseObject(buf: Buffer): GitObject {
  const nul = buf.indexOf(0);
  const header = buf.subarray(0, nul).toString('ascii');
  const [type, sizeStr] = header.split(' ');
  const size = parseInt(sizeStr, 10);
  const data = buf.subarray(nul + 1);
  if (data.length !== size) throw new Error(`object size mismatch: header ${size}, got ${data.length}`);
  return { type: type as ObjType, data: Buffer.from(data), id: sha1(buf) };
}

// ---------------------------------------------------------------------------
// Blobs
// ---------------------------------------------------------------------------
export function makeBlob(content: Buffer): GitObject {
  return makeObject('blob', content);
}

// ---------------------------------------------------------------------------
// Trees
// ---------------------------------------------------------------------------
export interface TreeEntry {
  /** File mode as an octal string without leading zeros: "100644", "100755", "120000", "40000". */
  mode: string;
  name: string;
  /** 20-byte binary SHA-1 of the child object. */
  id: Buffer;
}

/** Git sorts tree entries by name, treating directories as if their name ends with "/". */
export function sortTreeEntries(entries: TreeEntry[]): TreeEntry[] {
  return [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
}

/** Serialize a tree to its content bytes (entries sorted git-style). */
export function serializeTree(entries: TreeEntry[]): Buffer {
  const sorted = sortTreeEntries(entries);
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(e.id);
  }
  return Buffer.concat(parts);
}

export function makeTree(entries: TreeEntry[]): GitObject {
  return makeObject('tree', serializeTree(entries));
}

/** Parse tree content bytes into entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    const nul = data.indexOf(0, space);
    const mode = data.subarray(off, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const id = Buffer.from(data.subarray(nul + 1, nul + 21));
    entries.push({ mode, name, id });
    off = nul + 21;
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------
export interface CommitInfo {
  tree: string; // hex SHA-1
  parents: string[]; // hex SHA-1s
  author: string; // "Name <email> 1234567890 +0000"
  committer: string; // same shape
  message: string;
}

export function serializeCommit(c: CommitInfo): Buffer {
  const lines: string[] = [`tree ${c.tree}`];
  for (const p of c.parents) lines.push(`parent ${p}`);
  lines.push(`author ${c.author}`);
  lines.push(`committer ${c.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${c.message}`, 'utf8');
}

export function makeCommit(c: CommitInfo): GitObject {
  return makeObject('commit', serializeCommit(c));
}

/** Parse commit content bytes. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const message = headEnd >= 0 ? text.slice(headEnd + 2) : '';
  const parents: string[] = [];
  let tree = '';
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

// ---------------------------------------------------------------------------
// Tags (annotated)
// ---------------------------------------------------------------------------
export interface TagInfo {
  object: string; // hex SHA-1 of the tagged object
  type: ObjType;
  tag: string;
  tagger: string;
  message: string;
}

export function serializeTag(t: TagInfo): Buffer {
  return Buffer.from(
    `object ${t.object}\ntype ${t.type}\ntag ${t.tag}\ntagger ${t.tagger}\n\n${t.message}`,
    'utf8',
  );
}

export function makeTag(t: TagInfo): GitObject {
  return makeObject('tag', serializeTag(t));
}

/** Hex SHA-1 string -> 20-byte buffer. */
export function hexToBytes(hex: string): Buffer {
  return Buffer.from(hex, 'hex');
}

/** 20-byte buffer -> hex SHA-1 string. */
export function bytesToHex(buf: Buffer): string {
  return buf.toString('hex');
}
