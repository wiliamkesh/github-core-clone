// The entry's HTTP surface: git smart HTTP, REST v3, GraphQL v4 and MCP,
// all served from one in-memory Store. main.ts owns the lifecycle (bind,
// register, poll /done); this file owns the server.
//
// Every reply carries a non-empty X-GitHub-Request-Id (protocol checks).
// Auth: the trial token from MAKEFUN_SHOP_TOKEN; with no token configured
// (local dev) auth is skipped by the individual handlers.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './lib/store.ts';
import { handleGit } from './lib/git.ts';
import { handleRest } from './lib/rest.ts';
import { handleGraphql } from './lib/graphql.ts';
import { handleMcp } from './lib/mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** Answer one request with a JSON body; `headers` go beside the JSON ones. */
function sendJson(store: Store, res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': store.nextRequestId(),
    ...headers,
  });
  res.end(text);
}

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const raw = req.url ?? '/';
        // Route on the raw path prefix so a REST request never pays for the
        // git handler's URL parse (and vice versa). Handlers still validate
        // with their own parse, so a path the prefix check misroutes is
        // answered 404 by the handler it lands in, exactly as before.
        // Paths no prefix matches (healthz, unknown routes, odd encodings)
        // fall through to every handler in the original order.
        let handled = false;
        if (raw.startsWith('/api/v3/') || raw === '/api/v3') {
          handled = await handleRest(store, token, req, res);
        }
        if (!handled && raw.includes('.git/')) {
          handled = await handleGit(store, token, req, res);
        }
        if (!handled && raw.startsWith('/api/graphql')) {
          handled = await handleGraphql(store, token, req, res);
        }
        if (!handled && (raw === '/mcp' || raw.startsWith('/mcp/') || raw.startsWith('/mcp?'))) {
          handled = await handleMcp(store, token, req, res);
        }
        if (!handled) {
          handled =
            (await handleGit(store, token, req, res)) ||
            (await handleRest(store, token, req, res)) ||
            (await handleGraphql(store, token, req, res)) ||
            (await handleMcp(store, token, req, res));
        }
        if (handled) return;

        const path = pathOf(req);
        const method = req.method ?? 'GET';

        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          sendJson(store, res, 200, { ok: true });
          return;
        }

        // The GitHub API root: a 200 with the token's scopes, as api.github.com answers GET /.
        if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
          sendJson(store, res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
          return;
        }

        // Everything else, every method: GitHub's 404 body.
        sendJson(store, res, 404, { message: 'Not Found' });
      } catch (err) {
        if (!res.writableEnded) {
          try {
            sendJson(store, res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
          } catch {
            res.destroy();
          }
        }
      }
    })();
  });
  // Small sequential request/response pairs (the benchmarks) must not wait on
  // Nagle: disable it on every accepted socket.
  server.on('connection', (socket) => {
    socket.setNoDelay(true);
  });
  return server;
}
