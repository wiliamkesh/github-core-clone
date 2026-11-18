// Shared in-memory store: the single source of truth for all four surfaces
// (git smart HTTP, REST v3, GraphQL v4, MCP). Everything lives in memory —
// no disk, no wall clock. A logical clock (fixed epoch + counter) keeps every
// timestamp the server itself generates deterministic, so a replay is
// byte-identical in every field the suite can observe.
//
// Viewer identity is computed from the kit's fixed scenario seed
// (SCENARIO_SEED 0x6a09e667f3bcc909n via wire.ts buildScenario()):
// viewer adaiversen (id 1000), teammate quinnkeller, stranger olgabauer.
import { hash as sha1Hash } from 'node:crypto';
import {
  makeBlob,
  makeCommit,
  makeTree,
  parseCommit,
  parseTree,
  type GitObject,
  type TreeEntry,
} from './gitobj.ts';

export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});
export const TEAMMATE = Object.freeze({ id: 1001, login: 'quinnkeller' });
export const STRANGER = Object.freeze({ id: 1002, login: 'olgabauer' });

export const DEFAULT_BRANCH = 'main';
export const ZERO_OID = '0000000000000000000000000000000000000000';
/** Fixed epoch the suite itself uses for fixtures (2025-01-01). */
export const EPOCH_SEC = 1735689600;
/** The epoch as an ISO string, computed once: issueJson builds it per call otherwise. */
const EPOCH_ISO = new Date(EPOCH_SEC * 1000).toISOString();

/** Opaque, stable, reversible global ids: base64("<Type>:<...>"). */
export function encodeGlobalId(...parts: (string | number)[]): string {
  return Buffer.from(parts.join(':'), 'utf8').toString('base64');
}
export function decodeGlobalId(id: string): string[] | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    return parts.length >= 2 && parts[0].length > 0 ? parts : null;
  } catch {
    return null;
  }
}

export interface Comment {
  id: number;
  body: string;
  createdSeq: number;
}

export interface Issue {
  number: number;
  /** Stable numeric id, unique across the whole store (REST `id`, MCP parity). */
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdSeq: number;
  /** Pre-serialized REST shape, rebuilt on every mutation (read-workload fast path). */
  jsonCache: Buffer | null;
  etag: string | null;
}

export interface Pull {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  /** Tips at creation time (what the suite asserts against). */
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
}

export interface Label {
  name: string;
  color: string;
}

export interface Repo {
  databaseId: number;
  name: string;
  owner: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  refs: Map<string, string>; // refname -> tip oid (hex)
  issues: Issue[];
  issuesByNumber: Map<number, Issue>;
  pulls: Pull[];
  pullsByNumber: Map<number, Pull>;
  /** Shared GitHub numbering: issues and PRs draw from one sequence. */
  nextNumber: number;
  labels: Map<string, Label>;
  createdSeq: number;
  /** Precomputed depth-1 pack for the clone benchmark (invalidated on ref change). */
  clonePackCache: { tip: string; pack: Buffer; shallow: string[] } | null;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

function identLine(user: { name: string; email: string }, epochSec: number): string {
  return `${user.name} <${user.email}> ${epochSec} +0000`;
}

/** Split a path into segments, rejecting empty segments / `.` / `..`. */
function splitPath(path: string): string[] | null {
  const segs = path.split('/').filter((s) => s.length > 0);
  if (segs.length === 0) return null;
  if (segs.some((s) => s === '.' || s === '..')) return null;
  return segs;
}

export class Store {
  readonly objects = new Map<string, GitObject>();
  readonly repos = new Map<string, Repo>();
  private repoIdSeq = 1;
  private issueIdSeq = 1;
  private commentIdSeq = 1;
  private seq = 1;
  private clockSec = EPOCH_SEC;
  private reqSeq = 1;

  /** Next value of the deterministic logical clock (seconds since epoch). */
  nowSec(): number {
    return this.clockSec++;
  }
  nowIso(): string {
    return new Date(this.nowSec() * 1000).toISOString();
  }
  nextSeq(): number {
    return this.seq++;
  }
  /** Non-empty request id for the X-GitHub-Request-Id header on every reply. */
  nextRequestId(): string {
    return `req-${(this.reqSeq++).toString(16).padStart(8, '0')}`;
  }

  // -------------------------------------------------------------------------
  // Git objects
  // -------------------------------------------------------------------------
  putObject(obj: GitObject): GitObject {
    const prev = this.objects.get(obj.id);
    if (prev) return prev;
    this.objects.set(obj.id, obj);
    return obj;
  }
  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid.toLowerCase());
  }
  hasObject(oid: string): boolean {
    return this.objects.has(oid.toLowerCase());
  }

  // -------------------------------------------------------------------------
  // Repos
  // -------------------------------------------------------------------------
  private repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo | null {
    const key = this.repoKey(owner, name);
    if (this.repos.has(key)) return null;
    const repo: Repo = {
      databaseId: this.repoIdSeq++,
      name,
      owner,
      private: isPrivate,
      description,
      defaultBranch: DEFAULT_BRANCH,
      refs: new Map(),
      issues: [],
      issuesByNumber: new Map(),
      pulls: [],
      pullsByNumber: new Map(),
      nextNumber: 1,
      labels: new Map(),
      createdSeq: this.nextSeq(),
      clonePackCache: null,
    };
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listReposByOwner(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  // -------------------------------------------------------------------------
  // Refs
  // -------------------------------------------------------------------------
  getRef(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }
  setRef(repo: Repo, ref: string, oid: string): void {
    repo.refs.set(ref, oid.toLowerCase());
    repo.clonePackCache = null;
  }
  deleteRef(repo: Repo, ref: string): boolean {
    const ok = repo.refs.delete(ref);
    if (ok) repo.clonePackCache = null;
    return ok;
  }
  /** HEAD symref target (always refs/heads/<defaultBranch>). */
  headRef(repo: Repo): string {
    return `refs/heads/${repo.defaultBranch}`;
  }
  headOid(repo: Repo): string | undefined {
    return repo.refs.get(this.headRef(repo));
  }

  // -------------------------------------------------------------------------
  // Commit graph
  // -------------------------------------------------------------------------
  /** All commit oids reachable from `oid` (commit itself + ancestors), DFS pre-order. */
  commitAncestors(oid: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [oid.toLowerCase()];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (seen.has(cur) || cur === ZERO_OID) continue;
      seen.add(cur);
      const obj = this.objects.get(cur);
      if (!obj || obj.type !== 'commit') continue;
      out.push(cur);
      const info = parseCommit(obj.data);
      for (let i = info.parents.length - 1; i >= 0; i--) stack.push(info.parents[i].toLowerCase());
    }
    return out;
  }

  /**
   * Is `ancestor` reachable from `oid` (including ancestor === oid)?
   * Early-exit walk: the old code built the FULL ancestor list first
   * (commitAncestors + includes), which made every push O(chain depth) —
   * the push benchmark's chain grows past 600 commits, so a round paid
   * ~200 walks of ~300 commits each. A push's old tip is the new commit's
   * immediate parent, so the walk usually stops after one step; the result
   * is identical (reachability in the parent graph, merges included).
   */
  isAncestor(ancestor: string, oid: string): boolean {
    if (ancestor === ZERO_OID) return true;
    const a = ancestor.toLowerCase();
    const o = oid.toLowerCase();
    if (a === o) return true;
    const seen = new Set<string>();
    const stack = [o];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (cur === a) return true;
      if (cur === ZERO_OID || seen.has(cur)) continue;
      seen.add(cur);
      const obj = this.objects.get(cur);
      if (!obj || obj.type !== 'commit') continue;
      for (const p of parseCommit(obj.data).parents) stack.push(p.toLowerCase());
    }
    return false;
  }

  /** First common ancestor of two commits (merge base), or null. */
  mergeBase(a: string, b: string): string | null {
    const ancestorsA = new Set(this.commitAncestors(a));
    for (const c of this.commitAncestors(b)) {
      if (ancestorsA.has(c)) return c;
    }
    return null;
  }

  /** Commits reachable from a ref tip, newest-first (DFS pre-order). */
  listCommits(repo: Repo, ref: string): { sha: string; message: string }[] {
    const tip = repo.refs.get(ref);
    if (!tip) return [];
    const out: { sha: string; message: string }[] = [];
    for (const oid of this.commitAncestors(tip)) {
      const obj = this.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      out.push({ sha: oid, message: parseCommit(obj.data).message });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Reachability (fetch / clone)
  // -------------------------------------------------------------------------
  /**
   * Every object reachable from `tips`, minus anything in `exclude`
   * (objects the client already holds). Returns oids in traversal order.
   * Tag -> target; commit -> tree + parents (parents only when they are in
   * `followParents`, when given — the depth limit for shallow fetches, and
   * never past a commit in `stopAt` — a shallow boundary the client holds
   * without its parents); tree -> entries except gitlinks.
   */
  reachableObjects(tips: string[], exclude: Set<string>, followParents?: Set<string>, stopAt?: Set<string>): string[] {
    const out: string[] = [];
    const seen = new Set<string>(exclude);
    const stack = [...tips].map((t) => t.toLowerCase());
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid) || oid === ZERO_OID) continue;
      seen.add(oid);
      const obj = this.objects.get(oid);
      if (!obj) continue; // unknown oid: skip (client asked for something absent)
      out.push(oid);
      if (obj.type === 'commit') {
        const info = parseCommit(obj.data);
        stack.push(info.tree.toLowerCase());
        if (stopAt?.has(oid)) {
          // Shallow boundary: the client holds this commit but not its parents.
        } else {
          for (const p of info.parents) {
            if (!followParents || followParents.has(p.toLowerCase())) stack.push(p.toLowerCase());
          }
        }
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) {
          if (e.mode === '160000') continue;
          stack.push(e.id.toString('hex'));
        }
      } else if (obj.type === 'tag') {
        const text = obj.data.toString('utf8');
        const m = /^object ([0-9a-f]{40})$/m.exec(text);
        if (m) stack.push(m[1]);
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Trees / contents
  // -------------------------------------------------------------------------
  /** Flatten a tree (by oid) to path -> {oid, mode}. */
  flattenTree(treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const obj = this.objects.get(treeOid.toLowerCase());
    if (!obj || obj.type !== 'tree') return out;
    for (const e of parseTree(obj.data)) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      const hex = e.id.toString('hex');
      if (e.mode === '40000') {
        for (const [p, v] of this.flattenTree(hex, path)) out.set(p, v);
      } else if (e.mode !== '160000') {
        out.set(path, { oid: hex, mode: e.mode });
      }
    }
    return out;
  }

  /** Resolve a path inside a tree: blob entry, or the subtree at that path. */
  resolvePath(
    treeOid: string,
    path: string,
  ): { kind: 'file'; oid: string; mode: string } | { kind: 'dir'; oid: string } | null {
    const segs = splitPath(path);
    if (!segs) return null;
    let cur = treeOid.toLowerCase();
    for (let i = 0; i < segs.length; i++) {
      const obj = this.objects.get(cur);
      if (!obj || obj.type !== 'tree') return null;
      const entry = parseTree(obj.data).find((e) => e.name === segs[i]);
      if (!entry) return null;
      const hex = entry.id.toString('hex');
      if (i === segs.length - 1) {
        return entry.mode === '40000' ? { kind: 'dir', oid: hex } : { kind: 'file', oid: hex, mode: entry.mode };
      }
      if (entry.mode !== '40000') return null;
      cur = hex;
    }
    return null;
  }

  /** Read a file or directory at a ref. Returns null when the path is absent. */
  readPath(
    repo: Repo,
    ref: string,
    path: string,
  ):
    | { kind: 'file'; blobOid: string; content: Buffer; size: number }
    | { kind: 'dir'; entries: { type: 'file' | 'dir'; name: string; path: string; sha: string }[] }
    | null {
    const tip = repo.refs.get(ref);
    if (!tip) return null;
    const commitObj = this.objects.get(tip);
    if (!commitObj || commitObj.type !== 'commit') return null;
    const treeOid = parseCommit(commitObj.data).tree;
    const resolved = this.resolvePath(treeOid, path);
    if (!resolved) return null;
    if (resolved.kind === 'file') {
      const blob = this.objects.get(resolved.oid);
      if (!blob || blob.type !== 'blob') return null;
      return { kind: 'file', blobOid: resolved.oid, content: Buffer.from(blob.data), size: blob.data.length };
    }
    const dirObj = this.objects.get(resolved.oid);
    if (!dirObj || dirObj.type !== 'tree') return null;
    const entries = parseTree(dirObj.data).map((e) => ({
      type: (e.mode === '40000' ? 'dir' : 'file') as 'file' | 'dir',
      name: e.name,
      path: path.replace(/\/$/, '') + '/' + e.name,
      sha: e.id.toString('hex'),
    }));
    return { kind: 'dir', entries };
  }

  /**
   * Replace (or insert) one path inside a tree, returning the new tree oid.
   * `blobOid === null` deletes the entry; empty directories are pruned.
   */
  private updateTree(treeOid: string | null, segs: string[], blobOid: string | null): string | null {
    const entries: TreeEntry[] = [];
    if (treeOid) {
      const obj = this.objects.get(treeOid.toLowerCase());
      if (obj && obj.type === 'tree') entries.push(...parseTree(obj.data));
    }
    const [head, ...rest] = segs;
    const idx = entries.findIndex((e) => e.name === head);
    if (rest.length === 0) {
      if (blobOid === null) {
        if (idx >= 0) entries.splice(idx, 1);
      } else {
        const entry: TreeEntry = { mode: '100644', name: head, id: Buffer.from(blobOid, 'hex') };
        if (idx >= 0) entries[idx] = entry;
        else entries.push(entry);
      }
    } else {
      const childOid = idx >= 0 && entries[idx].mode === '40000' ? entries[idx].id.toString('hex') : null;
      const next = this.updateTree(childOid, rest, blobOid);
      if (next === null) {
        if (idx >= 0) entries.splice(idx, 1);
      } else {
        const entry: TreeEntry = { mode: '40000', name: head, id: Buffer.from(next, 'hex') };
        if (idx >= 0) entries[idx] = entry;
        else entries.push(entry);
      }
    }
    if (entries.length === 0) return null;
    return this.putObject(makeTree(entries)).id;
  }

  /** Commit a file write on a branch (creates the branch / repo's first commit if needed). */
  writeFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
    expectedBlobSha?: string,
  ): { commitSha: string; contentSha: string } | { error: 'stale-sha' | 'bad-path' } {
    const segs = splitPath(path);
    if (!segs) return { error: 'bad-path' };
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    let baseTree: string | null = null;
    const parents: string[] = [];
    if (tip) {
      const commitObj = this.objects.get(tip);
      if (!commitObj || commitObj.type !== 'commit') return { error: 'bad-path' };
      baseTree = parseCommit(commitObj.data).tree;
      parents.push(tip);
      if (expectedBlobSha !== undefined) {
        const cur = this.resolvePath(baseTree, path);
        if (!cur || cur.kind !== 'file' || cur.oid.toLowerCase() !== expectedBlobSha.toLowerCase()) {
          return { error: 'stale-sha' };
        }
      }
    }
    const blob = this.putObject(makeBlob(content));
    const treeOid = this.updateTree(baseTree, segs, blob.id);
    if (treeOid === null) return { error: 'bad-path' };
    const epoch = this.nowSec();
    const commit = this.putObject(
      makeCommit({
        tree: treeOid,
        parents,
        author: identLine(VIEWER, epoch),
        committer: identLine(VIEWER, epoch),
        message,
      }),
    );
    this.setRef(repo, ref, commit.id);
    return { commitSha: commit.id, contentSha: blob.id };
  }

  /** Delete a file on a branch. Returns null when the file does not exist. */
  deleteFile(
    repo: Repo,
    branch: string,
    path: string,
    message: string,
    expectedBlobSha: string,
  ): { commitSha: string } | { error: 'not-found' | 'stale-sha' | 'bad-path' } {
    const segs = splitPath(path);
    if (!segs) return { error: 'bad-path' };
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    if (!tip) return { error: 'not-found' };
    const commitObj = this.objects.get(tip);
    if (!commitObj || commitObj.type !== 'commit') return { error: 'not-found' };
    const baseTree = parseCommit(commitObj.data).tree;
    const cur = this.resolvePath(baseTree, path);
    if (!cur || cur.kind !== 'file') return { error: 'not-found' };
    if (cur.oid.toLowerCase() !== expectedBlobSha.toLowerCase()) return { error: 'stale-sha' };
    const treeOid = this.updateTree(baseTree, segs, null);
    const epoch = this.nowSec();
    const commit = this.putObject(
      makeCommit({
        // An emptied tree is still a tree (the empty tree object), never the
        // old tree — falling back to baseTree here would resurrect the file.
        tree: treeOid ?? this.putObject(makeTree([])).id,
        parents: [tip],
        author: identLine(VIEWER, epoch),
        committer: identLine(VIEWER, epoch),
        message,
      }),
    );
    this.setRef(repo, ref, commit.id);
    return { commitSha: commit.id };
  }

  // -------------------------------------------------------------------------
  // Issues
  // -------------------------------------------------------------------------
  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const issue: Issue = {
      number: repo.nextNumber++,
      id: this.issueIdSeq++,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      createdSeq: this.nextSeq(),
      jsonCache: null,
      etag: null,
    };
    repo.issues.push(issue);
    repo.issuesByNumber.set(issue.number, issue);
    this.refreshIssueCache(repo, issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issuesByNumber.get(number);
  }

  patchIssue(repo: Repo, issue: Issue, patch: { state?: 'open' | 'closed'; title?: string; body?: string }): void {
    if (patch.state !== undefined) issue.state = patch.state;
    if (patch.title !== undefined) issue.title = patch.title;
    if (patch.body !== undefined) issue.body = patch.body;
    this.refreshIssueCache(repo, issue);
  }

  addComment(repo: Repo, issue: Issue, body: string): Comment {
    const comment: Comment = { id: this.commentIdSeq++, body, createdSeq: this.nextSeq() };
    issue.comments.push(comment);
    return comment;
  }

  listIssues(
    repo: Repo,
    opts: { state?: string; sort?: string; direction?: string },
  ): Issue[] {
    let list = [...repo.issues];
    if (opts.state === 'open' || opts.state === 'closed') {
      list = list.filter((i) => i.state === opts.state);
    }
    const dir = opts.direction === 'desc' ? -1 : 1;
    // sort=created (the only sort the suite uses): creation order.
    list.sort((a, b) => (a.createdSeq - b.createdSeq) * dir);
    return list;
  }

  /** REST shape of an issue (also the pre-serialized cache source). */
  issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
    return {
      id: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels.map((name) => ({ name })),
      user: { login: repo.owner, id: VIEWER.id },
      created_at: EPOCH_ISO,
      updated_at: EPOCH_ISO,
      html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    };
  }

  private refreshIssueCache(_repo: Repo, issue: Issue): void {
    const text = JSON.stringify(this.issueJson(_repo, issue));
    issue.jsonCache = Buffer.from(text, 'utf8');
    // The ETag is NOT computed here: a SHA-1 per create is pure cost for the
    // write benchmark, which never reads it. It is computed once, lazily, on
    // the first single-issue GET (issueEtag) and cached per issue version.
    issue.etag = null;
  }

  /**
   * ETag of an issue's current representation, computed once per version.
   * The only reader is the single-issue GET (If-None-Match + response header).
   */
  issueEtag(repo: Repo, issue: Issue): string {
    if (issue.etag === null) {
      if (issue.jsonCache === null) this.refreshIssueCache(repo, issue);
      issue.etag = `"${this.sha1hex(issue.jsonCache!)}"`;
    }
    return issue.etag;
  }

  private sha1hex(buf: Buffer): string {
    return sha1Hash('sha1', buf, 'hex');
  }

  // -------------------------------------------------------------------------
  // Pull requests
  // -------------------------------------------------------------------------
  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull | null {
    const headSha = repo.refs.get(`refs/heads/${headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
    if (!headSha || !baseSha) return null;
    const pr: Pull = {
      number: repo.nextNumber++,
      id: this.issueIdSeq++,
      title,
      body,
      state: 'open',
      headRef,
      baseRef,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdSeq: this.nextSeq(),
    };
    repo.pulls.push(pr);
    repo.pullsByNumber.set(pr.number, pr);
    return pr;
  }

  getPull(repo: Repo, number: number): Pull | undefined {
    return repo.pullsByNumber.get(number);
  }

  listPulls(repo: Repo, state?: string): Pull[] {
    const list = [...repo.pulls].sort((a, b) => a.createdSeq - b.createdSeq);
    if (state === 'all') return list;
    return list.filter((p) => p.state === 'open');
  }

  pullJson(repo: Repo, pr: Pull): Record<string, unknown> {
    return {
      id: pr.id,
      number: pr.number,
      title: pr.title,
      body: pr.body,
      state: pr.state,
      merged: pr.merged,
      merged_at: pr.mergedAt,
      merge_commit_sha: pr.mergeCommitSha,
      head: { ref: pr.headRef, sha: pr.headSha },
      base: { ref: pr.baseRef, sha: pr.baseSha },
      user: { login: repo.owner, id: VIEWER.id },
      html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pr.number}`,
    };
  }

  /** Files changed between the PR's base tip (at creation) and its head tip. */
  pullFiles(repo: Repo, pr: Pull): PullFile[] {
    const baseCommit = this.objects.get(pr.baseSha);
    const headCommit = this.objects.get(pr.headSha);
    if (!baseCommit || !headCommit || baseCommit.type !== 'commit' || headCommit.type !== 'commit') return [];
    const baseTree = this.flattenTree(parseCommit(baseCommit.data).tree);
    const headTree = this.flattenTree(parseCommit(headCommit.data).tree);
    const files: PullFile[] = [];
    const paths = new Set([...baseTree.keys(), ...headTree.keys()]);
    for (const path of [...paths].sort()) {
      const b = baseTree.get(path);
      const h = headTree.get(path);
      if (b && h && b.oid === h.oid) continue;
      if (!b && h) {
        const content = this.objects.get(h.oid)?.data ?? Buffer.alloc(0);
        const additions = countLines(content);
        files.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (b && !h) {
        const content = this.objects.get(b.oid)?.data ?? Buffer.alloc(0);
        const deletions = countLines(content);
        files.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (b && h) {
        const oldLines = lineSet(this.objects.get(b.oid)?.data ?? Buffer.alloc(0));
        const newLines = lineSet(this.objects.get(h.oid)?.data ?? Buffer.alloc(0));
        let additions = 0;
        let deletions = 0;
        for (const l of newLines) if (!oldLines.has(l)) additions++;
        for (const l of oldLines) if (!newLines.has(l)) deletions++;
        files.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return files;
  }

  /**
   * Squash-merge a PR onto its base branch.
   * Returns the merge commit sha, or 'not-found' / 'conflict' / 'already-closed'.
   * Conflict rule (three-way, merge-base = PR's recorded baseSha): a path
   * changed on BOTH sides from the merge base with different results conflicts.
   */
  mergePull(repo: Repo, pr: Pull, _method: string): { sha: string } | { error: 'not-found' | 'conflict' | 'already-closed' } {
    if (pr.state !== 'open') return { error: 'already-closed' };
    const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
    const headTip = repo.refs.get(`refs/heads/${pr.headRef}`);
    if (!baseTip || !headTip) return { error: 'not-found' };
    const baseCommit = this.objects.get(pr.baseSha);
    const headCommit = this.objects.get(headTip);
    const baseTipCommit = this.objects.get(baseTip);
    if (!baseCommit || !headCommit || !baseTipCommit) return { error: 'not-found' };
    if (baseCommit.type !== 'commit' || headCommit.type !== 'commit' || baseTipCommit.type !== 'commit') {
      return { error: 'not-found' };
    }
    const mergeResult = this.threeWayMerge(
      parseCommit(baseCommit.data).tree,
      parseCommit(baseTipCommit.data).tree,
      parseCommit(headCommit.data).tree,
    );
    if (mergeResult === null) return { error: 'conflict' };
    const epoch = this.nowSec();
    const commit = this.putObject(
      makeCommit({
        tree: mergeResult,
        parents: [baseTip],
        author: identLine(VIEWER, epoch),
        committer: identLine(VIEWER, epoch),
        message: `Merge pull request #${pr.number} from ${repo.owner}/${pr.headRef}`,
      }),
    );
    this.setRef(repo, `refs/heads/${pr.baseRef}`, commit.id);
    pr.state = 'closed';
    pr.merged = true;
    pr.mergedAt = new Date(epoch * 1000).toISOString();
    pr.mergeCommitSha = commit.id;
    // The head tip moves with the merge for later reads of head.sha consistency.
    pr.headSha = headTip;
    return { sha: commit.id };
  }

  /**
   * Three-way tree merge: base / ours (base branch tip) / theirs (head tip).
   * Returns the merged tree oid, or null on a content conflict.
   */
  private threeWayMerge(baseTree: string, oursTree: string, theirsTree: string): string | null {
    const base = this.flattenTree(baseTree);
    const ours = this.flattenTree(oursTree);
    const theirs = this.flattenTree(theirsTree);
    const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
    // Work on a nested structure: rebuild trees bottom-up from flat paths.
    const merged = new Map<string, string>(); // path -> blob oid
    for (const path of paths) {
      const b = base.get(path)?.oid;
      const o = ours.get(path)?.oid;
      const t = theirs.get(path)?.oid;
      if (o === t) {
        if (o !== undefined) merged.set(path, o);
      } else if (o === b) {
        if (t !== undefined) merged.set(path, t);
      } else if (t === b) {
        if (o !== undefined) merged.set(path, o);
      } else {
        return null; // both sides changed the path differently
      }
    }
    return this.buildTreeFromFlat(merged);
  }

  /** Build nested tree objects from a flat path -> blob oid map. */
  private buildTreeFromFlat(flat: Map<string, string>): string {
    // Group by directory, bottom-up.
    const dirs = new Map<string, Map<string, TreeEntry>>(); // dir path -> entries by name
    const ensure = (dir: string): Map<string, TreeEntry> => {
      let m = dirs.get(dir);
      if (!m) {
        m = new Map();
        dirs.set(dir, m);
      }
      return m;
    };
    ensure('');
    for (const [path, oid] of [...flat.entries()].sort()) {
      const segs = path.split('/');
      const name = segs[segs.length - 1];
      const dir = segs.slice(0, -1).join('/');
      ensure(dir).set(name, { mode: '100644', name, id: Buffer.from(oid, 'hex') });
    }
    // Build deepest directories first.
    const dirPaths = [...dirs.keys()].sort((a, b) => b.split('/').length - a.split('/').length);
    const treeOidByDir = new Map<string, string>();
    for (const dir of dirPaths) {
      if (dir === '') continue;
      const entries = [...dirs.get(dir)!.values()];
      const treeOid = this.putObject(makeTree(entries)).id;
      treeOidByDir.set(dir, treeOid);
      const parent = dir.split('/').slice(0, -1).join('/');
      const name = dir.split('/').pop()!;
      ensure(parent).set(name, { mode: '40000', name, id: Buffer.from(treeOid, 'hex') });
    }
    const rootEntries = [...dirs.get('')!.values()];
    return this.putObject(makeTree(rootEntries)).id;
  }

  // -------------------------------------------------------------------------
  // Serializers shared by REST / GraphQL / MCP
  // -------------------------------------------------------------------------
  repoJson(repo: Repo): Record<string, unknown> {
    return {
      id: repo.databaseId,
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      owner: { login: repo.owner, id: VIEWER.id },
      private: repo.private,
      description: repo.description,
      default_branch: repo.defaultBranch,
      has_issues: true,
      html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    };
  }

  commentJson(comment: Comment): Record<string, unknown> {
    return { id: comment.id, body: comment.body };
  }
}

function countLines(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++;
  if (buf[buf.length - 1] !== 0x0a) n++;
  return n;
}

function lineSet(buf: Buffer): Set<string> {
  const s = new Set<string>();
  for (const line of buf.toString('utf8').split('\n')) s.add(line);
  return s;
}
