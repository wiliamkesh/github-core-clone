// REST v3 surface (/api/v3). See ~/workspace/makefun/gcc-specs/rest.md.
// Every reply is JSON with a non-empty X-GitHub-Request-Id; errors are
// {"message": <non-empty string>} (text never asserted). Missing token -> 401;
// a repo under a foreign owner -> 404, never 403.
//
// Performance: GET of a single issue serves the store's pre-serialized buffer
// directly (the read benchmark: 2000 sequential GETs on one keep-alive
// connection) and honours If-None-Match with a 304.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Buffer } from 'node:buffer';
import { VIEWER, type Repo, type Store } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const OID_RE = /^[0-9a-f]{40}$/i;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(store: Store, res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = typeof body === 'string' ? body : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': store.nextRequestId(),
    ...extra,
  });
  res.end(text);
}

function sendBuffer(store: Store, res: ServerResponse, status: number, buf: Buffer, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': buf.length,
    'x-github-request-id': store.nextRequestId(),
    ...extra,
  });
  res.end(buf);
}

function notFound(store: Store, res: ServerResponse): void {
  sendJson(store, res, 404, { message: 'Not Found' });
}

function unauthorized(store: Store, res: ServerResponse): void {
  sendJson(store, res, 401, { message: 'Unauthorized' });
}

function badRequest(store: Store, res: ServerResponse, message: string): void {
  sendJson(store, res, 400, { message });
}

/** Auth gate: with no token configured (local dev) auth is skipped. */
function requireAuth(store: Store, token: string, req: IncomingMessage, res: ServerResponse): boolean {
  if (token === '') return true;
  if ((req.headers.authorization ?? '') !== `Bearer ${token}`) {
    unauthorized(store, res);
    return false;
  }
  return true;
}

/** Parse a JSON request body; empty body -> {}. Malformed -> 400 (and false). */
async function jsonBody(store: Store, req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      badRequest(store, res, 'Request body must be a JSON object');
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    badRequest(store, res, 'Malformed JSON in request body');
    return null;
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function getRepoOr404(store: Store, res: ServerResponse, owner: string, name: string): Repo | null {
  if (!NAME_RE.test(owner) || !NAME_RE.test(name)) {
    notFound(store, res);
    return null;
  }
  const repo = store.getRepo(owner, name);
  if (!repo) {
    notFound(store, res);
    return null;
  }
  return repo;
}

function baseUrl(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

/**
 * Handle a REST v3 request. Returns true when the path is a REST route
 * (handled, whatever the outcome), false when it is not a REST path at all.
 */
export async function handleRest(store: Store, token: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    return false;
  }
  const path = url.pathname;
  const method = req.method ?? 'GET';
  if (!path.startsWith('/api/v3/') && path !== '/api/v3') return false;

  // API root (no auth): 200 with the token's scopes.
  if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    sendJson(store, res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }

  // -- No-auth informational endpoints -------------------------------------
  if (method === 'GET' && path === '/api/v3/meta') {
    sendJson(store, res, 200, { installed_version: '1.0.0' });
    return true;
  }

  // -- Authenticated endpoints ----------------------------------------------
  if (!requireAuth(store, token, req, res)) return true;

  // GET /api/v3/user
  if (method === 'GET' && path === '/api/v3/user') {
    sendJson(store, res, 200, {
      login: VIEWER.login,
      id: VIEWER.id,
      name: VIEWER.name,
      email: VIEWER.email,
      type: 'User',
    });
    return true;
  }

  // POST / GET /api/v3/user/repos
  if (path === '/api/v3/user/repos') {
    if (method === 'POST') {
      const body = await jsonBody(store, req, res);
      if (body === null) return true;
      const name = str(body.name);
      if (name === null || name === '' || name.length > 100 || !NAME_RE.test(name)) {
        sendJson(store, res, 422, { message: 'Invalid repository name' });
        return true;
      }
      const repo = store.createRepo(VIEWER.login, name, body.private === true, str(body.description) ?? '');
      if (!repo) {
        sendJson(store, res, 422, { message: 'Repository already exists' });
        return true;
      }
      sendJson(store, res, 201, store.repoJson(repo));
      return true;
    }
    if (method === 'GET') {
      const perPage = Math.min(100, Math.max(1, parseInt(url.searchParams.get('per_page') ?? '30', 10) || 30));
      const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
      const all = store.listReposByOwner(VIEWER.login);
      const totalPages = Math.max(1, Math.ceil(all.length / perPage));
      const slice = all.slice((page - 1) * perPage, page * perPage);
      const extra: Record<string, string> = {};
      if (page < totalPages) {
        const base = `${baseUrl(req)}/api/v3/user/repos?per_page=${perPage}`;
        extra.link =
          `<${base}&page=${page + 1}>; rel="next", ` +
          `<${base}&page=${totalPages}>; rel="last"`;
      }
      sendJson(store, res, 200, slice.map((r) => store.repoJson(r)), extra);
      return true;
    }
    sendJson(store, res, 405, { message: 'Method Not Allowed' });
    return true;
  }

  // -- /api/v3/repos/{owner}/{repo}[/*] --------------------------------------
  const repoMatch = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
  if (!repoMatch) {
    // Unknown /api/v3 route: JSON 404 (protocol check).
    notFound(store, res);
    return true;
  }
  const [, owner, repoName, rest = ''] = repoMatch;

  // POST /repos/{o}/{r}/git/refs
  if (rest === '/git/refs' && method === 'POST') {
    const repo = getRepoOr404(store, res, owner, repoName);
    if (!repo) return true;
    const body = await jsonBody(store, req, res);
    if (body === null) return true;
    const ref = str(body.ref);
    const sha = str(body.sha);
    if (ref === null || !/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(ref) || sha === null || !OID_RE.test(sha)) {
      sendJson(store, res, 422, { message: 'Invalid ref or sha' });
      return true;
    }
    if (!store.hasObject(sha)) {
      sendJson(store, res, 422, { message: 'Object not found' });
      return true;
    }
    if (store.getRef(repo, ref)) {
      sendJson(store, res, 422, { message: 'Reference already exists' });
      return true;
    }
    store.setRef(repo, ref, sha);
    sendJson(store, res, 201, { ref, object: { sha: sha.toLowerCase() } });
    return true;
  }

  // GET /repos/{o}/{r}/branches
  if (rest === '/branches' && method === 'GET') {
    const repo = getRepoOr404(store, res, owner, repoName);
    if (!repo) return true;
    const out = [...repo.refs.keys()]
      .filter((name) => name.startsWith('refs/heads/'))
      .sort()
      .map((name) => ({ name: name.replace(/^refs\/heads\//, ''), commit: { sha: repo.refs.get(name)! } }));
    sendJson(store, res, 200, out);
    return true;
  }

  // GET /repos/{o}/{r}/commits
  if (rest === '/commits' && method === 'GET') {
    const repo = getRepoOr404(store, res, owner, repoName);
    if (!repo) return true;
    const shaParam = url.searchParams.get('sha');
    const ref = shaParam ? `refs/heads/${shaParam}` : repo.defaultBranch ? `refs/heads/${repo.defaultBranch}` : '';
    if (!repo.refs.has(ref)) {
      notFound(store, res);
      return true;
    }
    const commits = store.listCommits(repo, ref).map((c) => ({ sha: c.sha, commit: { message: c.message } }));
    sendJson(store, res, 200, commits);
    return true;
  }

  // PUT / GET / DELETE /repos/{o}/{r}/contents/{path...}
  const contentsMatch = /^\/contents\/(.+)$/.exec(rest);
  if (contentsMatch) {
    const filePath = decodeURIComponent(contentsMatch[1]);
    if (method === 'PUT') {
      const repo = getRepoOr404(store, res, owner, repoName);
      if (!repo) return true;
      const body = await jsonBody(store, req, res);
      if (body === null) return true;
      const message = str(body.message) ?? '';
      const contentB64 = str(body.content);
      if (contentB64 === null) {
        sendJson(store, res, 422, { message: 'Missing content' });
        return true;
      }
      const branch = str(body.branch) ?? repo.defaultBranch;
      const content = Buffer.from(contentB64.replace(/\s/g, ''), 'base64');
      const existing = store.readPath(repo, `refs/heads/${branch}`, filePath);
      const isCreate = existing === null;
      const expectedSha = str(body.sha);
      const result = store.writeFile(repo, branch, filePath, content, message, expectedSha ?? undefined);
      if ('error' in result) {
        if (result.error === 'stale-sha') {
          sendJson(store, res, 409, { message: 'Conflict: stale sha' });
        } else {
          sendJson(store, res, 422, { message: 'Invalid path' });
        }
        return true;
      }
      sendJson(store, res, isCreate ? 201 : 200, {
        content: { sha: result.contentSha, encoding: 'base64' },
        commit: { sha: result.commitSha },
      });
      return true;
    }
    if (method === 'GET') {
      const repo = getRepoOr404(store, res, owner, repoName);
      if (!repo) return true;
      const refParam = url.searchParams.get('ref');
      const ref = refParam ? `refs/heads/${refParam}` : `refs/heads/${repo.defaultBranch}`;
      const found = store.readPath(repo, ref, filePath);
      if (!found) {
        notFound(store, res);
        return true;
      }
      if (found.kind === 'file') {
        sendJson(store, res, 200, {
          type: 'file',
          encoding: 'base64',
          content: found.content.toString('base64'),
          sha: found.blobOid,
          size: found.size,
          name: filePath.split('/').pop(),
          path: filePath,
        });
      } else {
        sendJson(store, res, 200, found.entries);
      }
      return true;
    }
    if (method === 'DELETE') {
      const repo = getRepoOr404(store, res, owner, repoName);
      if (!repo) return true;
      const body = await jsonBody(store, req, res);
      if (body === null) return true;
      const message = str(body.message) ?? '';
      const sha = str(body.sha);
      if (sha === null) {
        sendJson(store, res, 422, { message: 'Missing sha' });
        return true;
      }
      const branch = str(body.branch) ?? repo.defaultBranch;
      const result = store.deleteFile(repo, branch, filePath, message, sha);
      if ('error' in result) {
        if (result.error === 'not-found') notFound(store, res);
        else if (result.error === 'stale-sha') sendJson(store, res, 409, { message: 'Conflict: stale sha' });
        else sendJson(store, res, 422, { message: 'Invalid path' });
        return true;
      }
      sendJson(store, res, 200, { commit: { sha: result.commitSha } });
      return true;
    }
    sendJson(store, res, 405, { message: 'Method Not Allowed' });
    return true;
  }

  // POST /repos/{o}/{r}/labels
  if (rest === '/labels' && method === 'POST') {
    const repo = getRepoOr404(store, res, owner, repoName);
    if (!repo) return true;
    const body = await jsonBody(store, req, res);
    if (body === null) return true;
    const name = str(body.name);
    if (name === null || name === '') {
      sendJson(store, res, 422, { message: 'Invalid label name' });
      return true;
    }
    const color = str(body.color) ?? 'ededed';
    repo.labels.set(name, { name, color });
    sendJson(store, res, 201, { name, color });
    return true;
  }

  // POST / GET /repos/{o}/{r}/issues
  if (rest === '/issues') {
    const repo = getRepoOr404(store, res, owner, repoName);
    if (!repo) return true;
    if (method === 'POST') {
      const body = await jsonBody(store, req, res);
      if (body === null) return true;
      const title = str(body.title);
      if (title === null) {
        sendJson(store, res, 422, { message: 'Missing title' });
        return true;
      }
      const labelsRaw = Array.isArray(body.labels) ? body.labels : [];
      const labels: string[] = [];
      for (const l of labelsRaw) {
        if (typeof l !== 'string') continue;
        if (!repo.labels.has(l)) {
          sendJson(store, res, 422, { message: `Label ${l} does not exist` });
          return true;
        }
        labels.push(l);
      }
      const issue = store.createIssue(repo, title, str(body.body) ?? '', labels);
      // createIssue already built the pre-serialized buffer + ETag: serve it
      // directly instead of building the object and stringifying it again
      // (the write benchmark: 200 sequential creates).
      if (issue.jsonCache) {
        sendBuffer(store, res, 201, issue.jsonCache);
      } else {
        sendJson(store, res, 201, store.issueJson(repo, issue));
      }
      return true;
    }
    if (method === 'GET') {
      const list = store.listIssues(repo, {
        state: url.searchParams.get('state') ?? undefined,
        sort: url.searchParams.get('sort') ?? undefined,
        direction: url.searchParams.get('direction') ?? undefined,
      });
      const perPage = Math.min(100, Math.max(1, parseInt(url.searchParams.get('per_page') ?? '100', 10) || 100));
      sendJson(store, res, 200, list.slice(0, perPage).map((i) => store.issueJson(repo, i)));
      return true;
    }
    sendJson(store, res, 405, { message: 'Method Not Allowed' });
    return true;
  }

  // GET / PATCH /repos/{o}/{r}/issues/{n} ; POST / GET .../issues/{n}/comments
  const issueMatch = /^\/issues\/(\d+)(\/comments)?$/.exec(rest);
  if (issueMatch) {
    const number = parseInt(issueMatch[1], 10);
    const isComments = issueMatch[2] === '/comments';
    const repo = getRepoOr404(store, res, owner, repoName);
    if (!repo) return true;
    const issue = store.getIssue(repo, number);
    if (!issue) {
      notFound(store, res);
      return true;
    }
    if (isComments) {
      if (method === 'POST') {
        const body = await jsonBody(store, req, res);
        if (body === null) return true;
        const commentBody = str(body.body);
        if (commentBody === null) {
          sendJson(store, res, 422, { message: 'Missing body' });
          return true;
        }
        const comment = store.addComment(repo, issue, commentBody);
        sendJson(store, res, 201, store.commentJson(comment));
        return true;
      }
      if (method === 'GET') {
        sendJson(store, res, 200, issue.comments.map((c) => store.commentJson(c)));
        return true;
      }
      sendJson(store, res, 405, { message: 'Method Not Allowed' });
      return true;
    }
    if (method === 'GET') {
      // Fast path: pre-serialized buffer + ETag (read benchmark).
      const inm = req.headers['if-none-match'];
      if (issue.etag && inm === issue.etag) {
        sendJson(store, res, 304, '', { etag: issue.etag });
        return true;
      }
      if (issue.jsonCache && issue.etag) {
        sendBuffer(store, res, 200, issue.jsonCache, { etag: issue.etag });
        return true;
      }
      sendJson(store, res, 200, store.issueJson(repo, issue));
      return true;
    }
    if (method === 'PATCH') {
      const body = await jsonBody(store, req, res);
      if (body === null) return true;
      const state = str(body.state);
      if (state !== null && state !== 'open' && state !== 'closed') {
        sendJson(store, res, 422, { message: 'Invalid state' });
        return true;
      }
      store.patchIssue(repo, issue, {
        state: state === 'open' || state === 'closed' ? state : undefined,
        title: str(body.title) ?? undefined,
        body: str(body.body) ?? undefined,
      });
      sendJson(store, res, 200, store.issueJson(repo, issue));
      return true;
    }
    sendJson(store, res, 405, { message: 'Method Not Allowed' });
    return true;
  }

  // POST / GET /repos/{o}/{r}/pulls
  if (rest === '/pulls') {
    const repo = getRepoOr404(store, res, owner, repoName);
    if (!repo) return true;
    if (method === 'POST') {
      const body = await jsonBody(store, req, res);
      if (body === null) return true;
      const head = str(body.head);
      const base = str(body.base);
      const title = str(body.title);
      if (head === null || base === null || title === null) {
        sendJson(store, res, 422, { message: 'Missing head, base or title' });
        return true;
      }
      const pr = store.createPull(repo, title, str(body.body) ?? '', head, base);
      if (!pr) {
        sendJson(store, res, 422, { message: 'Head or base branch not found' });
        return true;
      }
      sendJson(store, res, 201, store.pullJson(repo, pr));
      return true;
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? undefined;
      const perPage = Math.min(100, Math.max(1, parseInt(url.searchParams.get('per_page') ?? '100', 10) || 100));
      sendJson(store, res, 200, store.listPulls(repo, state).slice(0, perPage).map((p) => store.pullJson(repo, p)));
      return true;
    }
    sendJson(store, res, 405, { message: 'Method Not Allowed' });
    return true;
  }

  // GET /repos/{o}/{r}/pulls/{n}/files ; PUT .../pulls/{n}/merge ; GET .../pulls/{n}
  const pullMatch = /^\/pulls\/(\d+)(\/files|\/merge)?$/.exec(rest);
  if (pullMatch) {
    const number = parseInt(pullMatch[1], 10);
    const suffix = pullMatch[2] ?? '';
    const repo = getRepoOr404(store, res, owner, repoName);
    if (!repo) return true;
    const pr = store.getPull(repo, number);
    if (!pr) {
      notFound(store, res);
      return true;
    }
    if (suffix === '/files' && method === 'GET') {
      sendJson(store, res, 200, store.pullFiles(repo, pr));
      return true;
    }
    if (suffix === '/merge' && method === 'PUT') {
      const body = await jsonBody(store, req, res);
      if (body === null) return true;
      const result = store.mergePull(repo, pr, str(body.merge_method) ?? 'squash');
      if ('error' in result) {
        if (result.error === 'not-found') notFound(store, res);
        else if (result.error === 'conflict') sendJson(store, res, 405, { message: 'Merge conflict' });
        else sendJson(store, res, 405, { message: 'Pull request is not open' });
        return true;
      }
      sendJson(store, res, 200, { merged: true, sha: result.sha, message: 'Pull request successfully merged' });
      return true;
    }
    if (suffix === '' && method === 'GET') {
      sendJson(store, res, 200, store.pullJson(repo, pr));
      return true;
    }
    sendJson(store, res, 405, { message: 'Method Not Allowed' });
    return true;
  }

  // GET / PATCH / DELETE /repos/{o}/{r}
  if (rest === '' || rest === '/') {
    if (method === 'GET') {
      const repo = getRepoOr404(store, res, owner, repoName);
      if (!repo) return true;
      sendJson(store, res, 200, store.repoJson(repo));
      return true;
    }
    if (method === 'PATCH') {
      const repo = getRepoOr404(store, res, owner, repoName);
      if (!repo) return true;
      const body = await jsonBody(store, req, res);
      if (body === null) return true;
      const description = str(body.description);
      if (description !== null) repo.description = description;
      sendJson(store, res, 200, store.repoJson(repo));
      return true;
    }
    if (method === 'DELETE') {
      const repo = getRepoOr404(store, res, owner, repoName);
      if (!repo) return true;
      store.deleteRepo(owner, repoName);
      res.writeHead(204, { 'x-github-request-id': store.nextRequestId() });
      res.end();
      return true;
    }
    sendJson(store, res, 405, { message: 'Method Not Allowed' });
    return true;
  }

  // A /repos/{o}/{r} sub-path we do not implement: JSON 404.
  notFound(store, res);
  return true;
}
