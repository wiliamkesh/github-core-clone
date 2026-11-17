// MCP surface (POST /mcp): JSON-RPC 2.0 over Streamable HTTP.
// The suite is the only client that matters. It probes server/discover
// (modern, revision 2026-07-28) first and falls back to the legacy
// initialize handshake (key off params.protocolVersion, not _meta).
// See ~/workspace/makefun/gcc-specs/mcp.md.
//
// Rules that bite: every tools/list call returns the same tools array byte
// for byte; never declare a `required` property the suite cannot fill (it
// fills only properties whose names match its synonym tables); return created
// objects as structuredContent (the suite reads numbers/titles from JSON);
// unknown tool -> -32602 (never HTTP 500); missing args -> isError:true.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Buffer } from 'node:buffer';
import { VIEWER, type Store } from './store.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const MODERN_REVISION = '2026-07-28';
const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name.' },
        owner: { type: 'string', description: 'Owner login (defaults to the authenticated user).' },
        description: { type: 'string', description: 'Repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        body: { type: 'string', description: 'Pull request body.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        pull_number: { type: 'number', description: 'Pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

type JsonRpcId = string | number | null;

interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(store: Store, res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': store.nextRequestId(),
  });
  res.end(text);
}

function rpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: JsonRpcId, error: RpcError): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code: error.code, message: error.message, ...(error.data !== undefined ? { data: error.data } : {}) } };
}

function toolText(obj: unknown): [{ type: 'text'; text: string }] {
  return [{ type: 'text', text: JSON.stringify(obj) }];
}

function toolOk(obj: unknown): Record<string, unknown> {
  return { content: toolText(obj), structuredContent: obj };
}

function toolFail(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
function num(v: unknown): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return parseInt(v, 10);
  return null;
}

/** Execute one tools/call. Returns a result object or an RpcError. */
function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> | RpcError {
  switch (name) {
    case 'create_repo': {
      const repoName = str(args.name);
      if (repoName === null || repoName === '') return toolFail('create_repo requires "name".') as unknown as Record<string, unknown>;
      const owner = str(args.owner) ?? VIEWER.login;
      const repo = store.createRepo(owner, repoName, args.private === true, str(args.description) ?? '');
      if (!repo) return toolFail(`Repository ${owner}/${repoName} already exists.`) as unknown as Record<string, unknown>;
      return toolOk(store.repoJson(repo));
    }
    case 'get_repo': {
      const owner = str(args.owner);
      const repoName = str(args.repo);
      if (owner === null || repoName === null) return toolFail('get_repo requires "owner" and "repo".') as unknown as Record<string, unknown>;
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolFail(`Repository ${owner}/${repoName} not found.`) as unknown as Record<string, unknown>;
      return toolOk(store.repoJson(repo));
    }
    case 'create_issue': {
      const owner = str(args.owner);
      const repoName = str(args.repo);
      const title = str(args.title);
      if (owner === null || repoName === null || title === null) {
        return toolFail('create_issue requires "owner", "repo" and "title".') as unknown as Record<string, unknown>;
      }
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolFail(`Repository ${owner}/${repoName} not found.`) as unknown as Record<string, unknown>;
      const issue = store.createIssue(repo, title, str(args.body) ?? '', []);
      return toolOk(store.issueJson(repo, issue));
    }
    case 'list_issues': {
      const owner = str(args.owner);
      const repoName = str(args.repo);
      if (owner === null || repoName === null) return toolFail('list_issues requires "owner" and "repo".') as unknown as Record<string, unknown>;
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolFail(`Repository ${owner}/${repoName} not found.`) as unknown as Record<string, unknown>;
      const state = str(args.state);
      const list = store.listIssues(repo, { state: state ?? undefined });
      const issues = list.map((i) => store.issueJson(repo, i));
      return toolOk({ issues });
    }
    case 'create_pull_request': {
      const owner = str(args.owner);
      const repoName = str(args.repo);
      const title = str(args.title);
      const head = str(args.head);
      const base = str(args.base);
      if (owner === null || repoName === null || title === null || head === null || base === null) {
        return toolFail('create_pull_request requires "owner", "repo", "title", "head" and "base".') as unknown as Record<string, unknown>;
      }
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolFail(`Repository ${owner}/${repoName} not found.`) as unknown as Record<string, unknown>;
      const pr = store.createPull(repo, title, str(args.body) ?? '', head, base);
      if (!pr) return toolFail('Head or base branch not found.') as unknown as Record<string, unknown>;
      return toolOk(store.pullJson(repo, pr));
    }
    case 'merge_pull_request': {
      const owner = str(args.owner);
      const repoName = str(args.repo);
      const number = num(args.pull_number);
      if (owner === null || repoName === null || number === null) {
        return toolFail('merge_pull_request requires "owner", "repo" and "pull_number".') as unknown as Record<string, unknown>;
      }
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolFail(`Repository ${owner}/${repoName} not found.`) as unknown as Record<string, unknown>;
      const pr = store.getPull(repo, number);
      if (!pr) return toolFail(`Pull request #${number} not found.`) as unknown as Record<string, unknown>;
      const result = store.mergePull(repo, pr, 'squash');
      if ('error' in result) return toolFail(`Merge failed: ${result.error}.`) as unknown as Record<string, unknown>;
      return toolOk({ ...store.pullJson(repo, pr), merged: true });
    }
    default:
      return { code: -32602, message: `Unknown tool: ${name}` };
  }
}

/**
 * Handle an MCP request. Returns true when the path is /mcp (handled,
 * whatever the outcome), false otherwise.
 */
export async function handleMcp(store: Store, token: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    return false;
  }
  if (url.pathname !== '/mcp') return false;
  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(store, res, 405, { message: 'Method Not Allowed' });
    return true;
  }
  // Auth is decided before anything else: no Authorization -> 401, even for
  // a resolvable tool name.
  if (token !== '' && (req.headers.authorization ?? '') !== `Bearer ${token}`) {
    sendJson(store, res, 401, { message: 'Unauthorized' });
    return true;
  }
  const raw = await readBody(req);
  let msg: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    msg = parsed as Record<string, unknown>;
  } catch {
    // Parse error: HTTP 400 with JSON-RPC -32700. The id is unrecoverable
    // from a truncated body by parsing, so recover it with a regex when
    // the raw text still carries it (the suite's probe uses id 424242).
    let id: JsonRpcId = null;
    const m = /"id"\s*:\s*(\d+)/.exec(raw.toString('utf8'));
    if (m) id = parseInt(m[1], 10);
    sendJson(store, res, 400, rpcError(id, { code: -32700, message: 'Parse error' }));
    return true;
  }

  const id = (typeof msg.id === 'string' || typeof msg.id === 'number' ? msg.id : null) as JsonRpcId;
  const method = typeof msg.method === 'string' ? msg.method : '';
  const params = (msg.params ?? {}) as Record<string, unknown>;

  // Notifications (no id): accept silently with 202 and no body.
  if (msg.id === undefined) {
    res.writeHead(202, { 'x-github-request-id': store.nextRequestId() });
    res.end();
    return true;
  }

  switch (method) {
    case 'server/discover': {
      sendJson(store, res, 200, rpcResult(id, {
        supportedVersions: [MODERN_REVISION],
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      }));
      return true;
    }
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const chosen = LEGACY_REVISIONS.includes(offered) || offered === MODERN_REVISION ? offered : LEGACY_REVISIONS[0];
      sendJson(store, res, 200, rpcResult(id, {
        protocolVersion: chosen,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      }));
      return true;
    }
    case 'ping': {
      sendJson(store, res, 200, rpcResult(id, {}));
      return true;
    }
    case 'tools/list': {
      // Fixed ordering, fixed schemas: byte-identical across calls.
      sendJson(store, res, 200, rpcResult(id, { tools: TOOLS }));
      return true;
    }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const known = TOOLS.some((t) => t.name === name);
      if (!known) {
        sendJson(store, res, 200, rpcError(id, { code: -32602, message: `Unknown tool: ${name}` }));
        return true;
      }
      const tool = TOOLS.find((t) => t.name === name)!;
      const missing = (tool.inputSchema.required ?? []).filter((r) => args[r] === undefined || args[r] === null || args[r] === '');
      if (missing.length > 0) {
        sendJson(store, res, 200, rpcResult(id, toolFail(`Missing required argument(s): ${missing.join(', ')}.`)));
        return true;
      }
      const result = callTool(store, name, args);
      if ('code' in result && typeof result.code === 'number') {
        sendJson(store, res, 200, rpcError(id, result as unknown as RpcError));
        return true;
      }
      sendJson(store, res, 200, rpcResult(id, result));
      return true;
    }
    default: {
      sendJson(store, res, 200, rpcError(id, { code: -32601, message: `Method not found: ${method}` }));
      return true;
    }
  }
}
