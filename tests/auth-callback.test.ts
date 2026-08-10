/**
 * Integration test: simulate exactly what admin.hlx.page does to our loopback
 * login callback, end to end.
 *
 * This stands up the REAL callback server from `login()` and drives it the way
 * Adobe's browser page does (per the adobe/helix-cli contract):
 *   1. a CORS preflight (OPTIONS) from origin https://admin.hlx.page
 *   2. a cross-origin POST carrying `{ state, siteToken }`
 *
 * It proves our implementation handles the preflight, captures the token from
 * the POST body, and caches it — with no Adobe login, no network, no creds.
 *
 * The system browser is mocked out (we only need the URL it would open, to
 * read the bound port + state nonce), and the token cache is redirected to a
 * temp HOME so the real ~/.aem/auth-token.json is never touched.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Capture the URL that login() would open, instead of launching a browser.
const { opened } = vi.hoisted(() => ({ opened: [] as string[] }));
vi.mock('../src/auth/browser.js', () => ({
  openBrowser: (url: string) => {
    opened.push(url);
  },
}));

import { login } from '../src/auth/admin-login.js';
import { loadToken, getTokenPath } from '../src/auth/token-store.js';

const ADMIN_ORIGIN = 'https://admin.hlx.page';

/** Poll until `fn` returns a defined value, or time out. */
async function waitFor<T>(fn: () => T | undefined, timeoutMs = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Parse the captured login URL into the callback base URL + state nonce. */
function callbackFromOpenedUrl(openedUrl: string): { base: string; state: string } {
  const parsed = new URL(openedUrl);
  const redirect = new URL(parsed.searchParams.get('redirect_uri') as string);
  const state = parsed.searchParams.get('state') as string;
  // Hit loopback directly on the port the server actually bound.
  const base = `http://127.0.0.1:${redirect.port}${redirect.pathname}`;
  return { base, state };
}

describe('admin login callback — simulating admin.hlx.page end to end', () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    opened.length = 0;
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), 'eds-auth-'));
    process.env.HOME = home; // redirect ~/.aem away from the real file
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('answers the CORS preflight, captures the POSTed siteToken, and caches it', async () => {
    const loginPromise = login({ owner: 'acme', repo: 'site', ref: 'main' });

    const { base, state } = callbackFromOpenedUrl(await waitFor(() => opened[0]));

    // 1. CORS preflight, exactly as the browser sends it.
    const preflight = await fetch(base, {
      method: 'OPTIONS',
      headers: { origin: ADMIN_ORIGIN, 'access-control-request-method': 'POST' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(ADMIN_ORIGIN);
    expect(preflight.headers.get('access-control-allow-methods') ?? '').toContain('POST');
    expect((preflight.headers.get('access-control-allow-headers') ?? '').toLowerCase()).toContain(
      'content-type',
    );

    // 2. The token POST (helix-cli sends `{ state, siteToken }`).
    const post = await fetch(base, {
      method: 'POST',
      headers: { origin: ADMIN_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ state, siteToken: 'sim-site-token-abc123' }),
    });
    expect(post.status).toBe(200);
    expect(post.headers.get('access-control-allow-origin')).toBe(ADMIN_ORIGIN);

    // 3. login() resolves with the captured token...
    const result = await loginPromise;
    expect(result.token).toBe('sim-site-token-abc123');
    expect(result.owner).toBe('acme');
    expect(result.repo).toBe('site');

    // 4. ...and it was cached to the (temp) ~/.aem/auth-token.json.
    expect(getTokenPath().startsWith(home)).toBe(true);
    const cached = loadToken();
    expect(cached?.token).toBe('sim-site-token-abc123');
  });

  it('is reachable at the literal localhost redirect_uri (IPv4/IPv6 regression)', async () => {
    // Regression for the "connection refused on localhost callback" bug: the
    // server must answer at the exact `localhost` URL Adobe redirects to — even
    // when localhost resolves to ::1 (IPv6), not just 127.0.0.1.
    const loginPromise = login({ owner: 'acme', repo: 'site', ref: 'main' });
    const openedUrl = await waitFor(() => opened[0]);
    const parsed = new URL(openedUrl);
    const redirectUri = parsed.searchParams.get('redirect_uri') as string; // http://localhost:PORT/...
    const state = parsed.searchParams.get('state') as string;
    expect(redirectUri.startsWith('http://localhost:')).toBe(true);

    // Hit the literal localhost URL — NOT 127.0.0.1.
    const post = await fetch(redirectUri, {
      method: 'POST',
      headers: { origin: ADMIN_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ state, siteToken: 'localhost-reachable' }),
    });
    expect(post.status).toBe(200);

    const result = await loginPromise;
    expect(result.token).toBe('localhost-reachable');
  });

  it('also accepts the `authToken` field name (Adobe skill variant)', async () => {
    const loginPromise = login({ owner: 'acme', repo: 'site' });
    const { base, state } = callbackFromOpenedUrl(await waitFor(() => opened[0]));

    const post = await fetch(base, {
      method: 'POST',
      headers: { origin: ADMIN_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ state, authToken: 'sim-auth-token-xyz' }),
    });
    expect(post.status).toBe(200);

    const result = await loginPromise;
    expect(result.token).toBe('sim-auth-token-xyz');
  });

  it('times out with a message pointing to Chrome/Firefox and EDS_API_KEY', async () => {
    // Fake only the timer APIs so the loopback server's IO callbacks still fire
    // (server.listen / openBrowser run via libuv, not via setTimeout).
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const loginPromise = login({ owner: 'acme', repo: 'site', ref: 'main' });
      // Attach the rejection handler before firing the timer so it's never
      // momentarily unhandled.
      const rejection = expect(loginPromise).rejects.toThrow(/EDS_API_KEY/);

      // Wait for the server to bind and openBrowser to record the login URL.
      while (opened.length === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      // Fire the 120s login timeout (no callback ever arrives).
      vi.advanceTimersByTime(120_000);

      await rejection;
      // Also assert it steers users to a supported browser.
      await expect(loginPromise).rejects.toThrow(/Chrome or Firefox/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a POST that omits state entirely (token-injection guard)', async () => {
    // A callback with no `state` must be rejected, not treated as valid — a
    // stateless POST from any page the user visits during login would otherwise
    // inject an attacker-chosen token into the cache.
    const loginPromise = login({ owner: 'acme', repo: 'site', ref: 'main' });
    const rejection = expect(loginPromise).rejects.toThrow(/state/i);
    const { base } = callbackFromOpenedUrl(await waitFor(() => opened[0]));

    const post = await fetch(base, {
      method: 'POST',
      headers: { origin: ADMIN_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ siteToken: 'attacker-controlled-token' }),
    });
    expect(post.status).toBe(400);

    await rejection;

    // The attacker's token must never have been cached.
    expect(loadToken()?.token).not.toBe('attacker-controlled-token');
  });

  it('rejects a POST whose state does not match (CSRF guard)', async () => {
    const loginPromise = login({ owner: 'acme', repo: 'site', ref: 'main' });
    // Attach the rejection handler BEFORE triggering the reject, so the
    // rejection is never momentarily unhandled.
    const rejection = expect(loginPromise).rejects.toThrow(/state/i);
    const { base } = callbackFromOpenedUrl(await waitFor(() => opened[0]));

    const post = await fetch(base, {
      method: 'POST',
      headers: { origin: ADMIN_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'not-the-real-nonce', siteToken: 'should-be-ignored' }),
    });
    expect(post.status).toBe(400);

    await rejection;
  });
});
