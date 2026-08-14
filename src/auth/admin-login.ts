/**
 * Browser-based login flow for the EDS Admin API.
 *
 * Mirrors Adobe's official AEM CLI login: we spin up a local HTTP callback
 * server on a random free port, open the system browser to the hlx login
 * endpoint with that port as the redirect URI, wait for the token to be
 * delivered back to the callback, cache it, and return it.
 *
 * Uses only Node built-ins (`http`, `crypto`) plus the local token store and
 * browser helpers — no external dependencies.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { type AddressInfo } from 'node:net';
import process from 'node:process';
import { openBrowser } from './browser.js';
import { saveToken, type StoredToken } from './token-store.js';

/** Inputs needed to initiate a login. */
export interface LoginOptions {
  owner: string;
  repo: string;
  /** Git ref / branch. Defaults to "main" when omitted. */
  ref?: string;
  /** How long to wait for the browser callback, in ms. Defaults to 120000. */
  timeoutMs?: number;
}

/** Result of a successful login. */
export interface LoginResult {
  token: string;
  expiresAt: number;
  owner: string;
  repo: string;
  ref: string;
}

const ADMIN_LOGIN_BASE = 'https://admin.hlx.page/login';
const CLIENT_ID = 'aem-cli';
// Path used by Adobe's own AEM CLI (adobe/helix-cli) for the login callback.
// admin.hlx.page POSTs the token cross-origin to this exact path.
const CALLBACK_PATH = '/.aem/cli/login/ack';
const LOGIN_TIMEOUT_MS = 120_000;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Origins admin.hlx.page uses to POST the token to our loopback callback.
 * The browser sends a CORS preflight first, so the callback must echo these.
 */
const ALLOWED_ORIGINS = ['https://admin.hlx.page', 'https://admin-ci.hlx.page'];

/**
 * Field names we accept as carrying the access token. `siteToken` is what
 * adobe/helix-cli reads; `authToken` is what Adobe's own auth skill uses — both
 * are the same value. The remaining names are liberal fallbacks.
 */
const TOKEN_FIELDS = [
  'siteToken',
  'authToken',
  'token',
  'access_token',
  'accessToken',
  'id_token',
  'idToken',
];
/** Field names we accept as carrying an explicit expiry. */
const EXPIRY_FIELDS = ['expiresAt', 'expires_at', 'expiresIn', 'expires_in', 'exp'];

/**
 * Build the hlx admin login URL for a site.
 *
 * Exported so tests can assert on the URL shape without binding a server.
 */
export function buildLoginUrl(params: {
  owner: string;
  repo: string;
  ref: string;
  port: number;
  state: string;
}): string {
  const { owner, repo, ref, port, state } = params;
  const redirectUri = `http://localhost:${port}${CALLBACK_PATH}`;
  const query = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    state,
    // Mirror Adobe's AEM CLI: force the account chooser so the user can pick
    // the right identity rather than being silently signed in.
    selectAccount: 'true',
  });
  return `${ADMIN_LOGIN_BASE}/${owner}/${repo}/${ref}?${query.toString()}`;
}

/** Generate a random hex nonce used as the OAuth `state` parameter. */
export function generateNonce(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Run the full browser login flow.
 *
 * 1. Bind a local callback server on a random free port.
 * 2. Open the browser to the hlx login endpoint.
 * 3. Wait (up to 120s) for the token to arrive at the callback.
 * 4. Verify the returned `state` matches our nonce.
 * 5. Cache the token at `~/.aem/auth-token.json` (mode 0600) and return it.
 */
export async function login(options: LoginOptions): Promise<LoginResult> {
  const owner = options.owner;
  const repo = options.repo;
  const ref = options.ref ?? 'main';
  const timeoutMs = options.timeoutMs ?? LOGIN_TIMEOUT_MS;
  const state = generateNonce();

  return new Promise<LoginResult>((resolve, reject) => {
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;

    const server = createServer((req, res) => {
      void routeRequest(req, res);
    });

    /** Resolve or reject exactly once, then tear the server down. */
    function settle(action: () => void): void {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      // Run the resolve/reject exactly once, whether it fires from the close
      // callback or the failsafe timer below.
      let ran = false;
      const runOnce = (): void => {
        if (ran) return;
        ran = true;
        action();
      };
      server.close(() => runOnce());
      // Failsafe in case close() hangs on a lingering keep-alive socket.
      const failsafe = setTimeout(() => runOnce(), 250);
      failsafe.unref();
    }

    /** Route an inbound request; only `/callback` is meaningful. */
    async function routeRequest(
      req: IncomingMessage,
      res: ServerResponse,
    ): Promise<void> {
      try {
        // The callback may be reachable on a LAN address (the server binds the
        // unspecified address so `localhost` resolves on both IPv4 and IPv6).
        // Only the local machine's own browser should ever reach it, so reject
        // anything that isn't a loopback client outright.
        if (!isLoopbackRequest(req)) {
          // Not settling here: a stray LAN probe during a real login must not
          // abort it. But log it, so a container user (browser on host, server
          // in the container → a bridge IP, not loopback) can see why sign-in
          // never completes instead of hitting the misleading 120s timeout.
          process.stderr.write(
            `\nRejected a non-loopback callback from ${req.socket.remoteAddress ?? 'unknown'}. ` +
              'Login only accepts connections from this machine; a containerized ' +
              'server cannot receive the host browser callback — run login on the host ' +
              'or set EDS_API_KEY instead.\n',
          );
          res.statusCode = 403;
          res.end('Forbidden');
          return;
        }

        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname !== CALLBACK_PATH) {
          res.statusCode = 404;
          res.end('Not found');
          return;
        }

        // admin.hlx.page delivers the token via a cross-origin POST, so the
        // browser sends a CORS preflight (OPTIONS) first. Without these headers
        // the browser blocks the POST and the token never reaches us.
        applyCors(req, res);
        if (req.method === 'OPTIONS') {
          res.statusCode = 204;
          res.end();
          return;
        }

        const fields = await collectFields(req, url);
        logReceived(fields);

        // CSRF defence: the returned state MUST be present and match our nonce.
        // Adobe's flow always echoes `state` back (per the adobe/helix-cli
        // contract this mirrors), so a missing state is not a legitimate
        // callback — accepting one would let any page POST a token of its
        // choosing into the cache (token injection / session fixation).
        const returnedState = fields.state;
        if (returnedState !== state) {
          res.statusCode = 400;
          res.end(errorHtml('State missing or mismatched — possible CSRF. Please retry login.'));
          settle(() =>
            reject(
              new Error('Login failed: state nonce missing or did not match (possible CSRF).'),
            ),
          );
          return;
        }

        const token = pickFirst(fields, TOKEN_FIELDS);
        if (!token) {
          res.statusCode = 400;
          res.end(errorHtml('No token was returned by the login endpoint.'));
          settle(() =>
            reject(
              new Error(
                'Login failed: callback did not include a token. ' +
                  `Received fields: ${Object.keys(fields).join(', ') || '(none)'}. ` +
                  'Use Google Chrome or Firefox to sign in (Safari is not supported), ' +
                  'or set EDS_API_KEY instead — see the README.',
              ),
            ),
          );
          return;
        }

        const expiresAt = resolveExpiry(fields);
        const stored: StoredToken = { token, expiresAt, owner, repo, ref };
        // Persist before responding so the token survives a caller crash.
        saveToken(stored);

        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(successHtml());

        settle(() => resolve({ ...stored }));
      } catch (err) {
        settle(() => reject(asError(err)));
      }
    }

    server.on('error', (err) => {
      settle(() => reject(asError(err)));
    });

    // Bind to a random free port on ALL interfaces (dual-stack) rather than
    // 127.0.0.1 only. The redirect_uri uses the `localhost` hostname, which the
    // OS may resolve to IPv6 (::1) — notably on macOS. Binding to 127.0.0.1
    // alone leaves nothing listening on ::1, so the post-login callback gets
    // "connection refused". Omitting the host binds the unspecified address
    // (dual-stack), so `localhost` reaches us whether it resolves to ::1 or
    // 127.0.0.1. The transient server is protected by the `state` nonce.
    server.listen(0, () => {
      const address = server.address() as AddressInfo | null;
      if (!address || typeof address.port !== 'number') {
        settle(() =>
          reject(new Error('Login failed: could not determine callback port.')),
        );
        return;
      }
      const port = address.port;
      const loginUrl = buildLoginUrl({ owner, repo, ref, port, state });
      openBrowser(loginUrl);

      process.stderr.write(
        `\nWaiting for sign-in to complete (timeout ${timeoutMs / 1000}s)...\n` +
          'Use Google Chrome or Firefox to sign in (Safari blocks the local callback). ' +
          "If it doesn't complete, set EDS_API_KEY instead — see the README.\n",
      );

      timeout = setTimeout(() => {
        settle(() =>
          reject(
            new Error(
              `Login timed out after ${timeoutMs / 1000}s — no callback was received. ` +
                'Safari is not supported (it blocks the local callback) — use Google Chrome or Firefox. ' +
                'Alternatively, set EDS_API_KEY instead of signing in — see the README.',
            ),
          ),
        );
      }, timeoutMs);
      timeout.unref();
    });
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Collect candidate fields from BOTH the query string and (for POST) the
 * request body, parsing form-encoded or JSON bodies liberally.
 */
async function collectFields(
  req: IncomingMessage,
  url: URL,
): Promise<Record<string, string>> {
  const fields: Record<string, string> = {};

  // 1. Query-string params (GET redirect or POST with query).
  for (const [key, value] of url.searchParams.entries()) {
    fields[key] = value;
  }

  // 2. Request body (POST).
  if (req.method === 'POST') {
    const body = await readBody(req);
    if (body) {
      const contentType = (req.headers['content-type'] ?? '').toLowerCase();
      if (contentType.includes('application/json')) {
        try {
          const json = JSON.parse(body) as Record<string, unknown>;
          for (const [key, value] of Object.entries(json)) {
            if (value != null) fields[key] = String(value);
          }
        } catch {
          // Ignore malformed JSON; query params may still carry the token.
        }
      } else {
        // Treat as form-encoded (the most common shape).
        try {
          const params = new URLSearchParams(body);
          for (const [key, value] of params.entries()) {
            fields[key] = value;
          }
        } catch {
          // Ignore — nothing more we can do with an opaque body.
        }
      }
    }
  }

  return fields;
}

/** Read a request body to a string, capped to avoid unbounded memory use. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const MAX = 1_000_000; // 1 MB ceiling
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX) chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

/**
 * Apply the CORS headers admin.hlx.page's browser page needs to POST the token
 * to our loopback server. Only echoes the allow-origin for trusted origins.
 */
function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
}

/** Return the first non-empty value among the given candidate field names. */
function pickFirst(
  fields: Record<string, string>,
  names: string[],
): string | undefined {
  for (const name of names) {
    const value = fields[name];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

/**
 * Resolve an absolute expiry timestamp (epoch ms) from any expiry field the
 * endpoint may have returned; falls back to a 24h TTL.
 */
function resolveExpiry(fields: Record<string, string>): number {
  const now = Date.now();
  const raw = pickFirst(fields, EXPIRY_FIELDS);
  if (!raw) {
    return now + DEFAULT_TTL_MS;
  }

  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0) {
    return now + DEFAULT_TTL_MS;
  }

  // Heuristics for the many ways an expiry can be expressed:
  // - "expiresIn"/"expires_in": a duration in seconds from now.
  // - "exp": an absolute epoch in SECONDS (standard JWT claim).
  // - large absolute value: epoch in milliseconds.
  if ('expiresIn' in fields || 'expires_in' in fields) {
    return now + num * 1000;
  }
  if (num < 1e12) {
    return num * 1000; // epoch seconds -> ms
  }
  return num; // already epoch ms
}

/** Log what the callback received (token value redacted). */
function logReceived(fields: Record<string, string>): void {
  const summary = Object.entries(fields).map(([key, value]) => {
    const sensitive = TOKEN_FIELDS.includes(key);
    return `${key}=${sensitive ? `<redacted:${value.length} chars>` : value}`;
  });
  process.stderr.write(
    `\nCallback received: ${summary.join(', ') || '(no fields)'}\n`,
  );
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * True only when the request originates from this machine's loopback interface.
 * Covers IPv4 loopback (127.0.0.0/8), IPv6 loopback (::1), and IPv4-mapped IPv6
 * (`::ffff:127.x.x.x`).
 */
function isLoopbackRequest(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress;
  if (!addr) return false;
  if (addr === '::1') return true;
  const v4 = addr.startsWith('::ffff:') ? addr.slice('::ffff:'.length) : addr;
  return /^127\./.test(v4);
}

// ---------------------------------------------------------------------------
// HTML responses
// ---------------------------------------------------------------------------

function successHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Signed in</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         background: #f5f5f5; color: #1a1a1a; display: flex; align-items: center;
         justify-content: center; height: 100vh; margin: 0; }
  .card { background: #fff; padding: 2.5rem 3rem; border-radius: 12px;
          box-shadow: 0 4px 24px rgba(0,0,0,0.08); text-align: center; max-width: 420px; }
  .check { font-size: 3rem; line-height: 1; color: #2e7d32; }
  h1 { font-size: 1.4rem; margin: 0.75rem 0 0.5rem; }
  p { color: #555; margin: 0; }
</style>
</head>
<body>
  <div class="card">
    <div class="check">&#10003;</div>
    <h1>You're logged in</h1>
    <p>You can close this tab and return to your terminal.</p>
  </div>
</body>
</html>`;
}

function errorHtml(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Login error</title></head>
<body style="font-family: sans-serif; padding: 2rem;">
  <h1>Login failed</h1>
  <p>${escapeHtml(message)}</p>
  <p>You can close this tab and try again from your terminal.</p>
</body>
</html>`;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
