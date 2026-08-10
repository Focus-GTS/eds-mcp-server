import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// We point the token store at a throwaway home dir by overriding $HOME, which
// `os.homedir()` honours. This avoids mocking node:os (which makes vitest
// create duplicate module graphs and breaks the single-instance token store).
let tempHome: string;
let originalHome: string | undefined;

import {
  saveToken,
  loadToken,
  clearToken,
  getTokenPath,
  getValidToken,
  NeedsLoginError,
  NEEDS_LOGIN_MESSAGE,
  type StoredToken,
} from '../src/auth/index.js';
import {
  buildLoginUrl,
  generateNonce,
} from '../src/auth/admin-login.js';

const BASE: Omit<StoredToken, 'token' | 'expiresAt'> = {
  owner: 'acme',
  repo: 'site',
  ref: 'main',
};

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'eds-auth-test-'));
  originalHome = process.env.HOME;
  process.env.HOME = tempHome;
  // Windows uses USERPROFILE; set it too so the suite is portable.
  process.env.USERPROFILE = tempHome;
});

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (tempHome && existsSync(tempHome)) {
    rmSync(tempHome, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// token-store
// ---------------------------------------------------------------------------

describe('token-store', () => {
  it('saves and loads a token round-trip', () => {
    const token: StoredToken = {
      token: 'abc123',
      expiresAt: Date.now() + 60_000,
      ...BASE,
    };
    saveToken(token);

    const loaded = loadToken();
    expect(loaded).not.toBeNull();
    expect(loaded).toEqual(token);
  });

  it('caches the token at ~/.aem/auth-token.json', () => {
    expect(getTokenPath().endsWith(join('.aem', 'auth-token.json'))).toBe(true);
  });

  it('writes the token file with 0600 permissions', () => {
    saveToken({ token: 'secret', expiresAt: Date.now() + 60_000, ...BASE });
    const mode = statSync(getTokenPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('returns null when no token file exists', () => {
    expect(loadToken()).toBeNull();
  });

  it('returns null for a corrupt token file', () => {
    saveToken({ token: 'good', expiresAt: Date.now() + 60_000, ...BASE });
    // Corrupt the file on disk.
    writeFileSync(getTokenPath(), '{ not valid json', 'utf8');
    expect(loadToken()).toBeNull();
  });

  it('clears a saved token', () => {
    saveToken({ token: 'gone', expiresAt: Date.now() + 60_000, ...BASE });
    expect(loadToken()).not.toBeNull();
    clearToken();
    expect(loadToken()).toBeNull();
  });

  it('clearToken does not throw when no token exists', () => {
    expect(() => clearToken()).not.toThrow();
  });

  it('preserves the explicit expiresAt across a round-trip', () => {
    const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
    saveToken({ token: 't', expiresAt, ...BASE });
    expect(loadToken()?.expiresAt).toBe(expiresAt);
  });
});

// ---------------------------------------------------------------------------
// getValidToken
// ---------------------------------------------------------------------------

describe('getValidToken', () => {
  it('returns the override (EDS_API_KEY) when set, bypassing the cache', () => {
    // Even with a valid cached token, the override should win.
    saveToken({ token: 'cached', expiresAt: Date.now() + 600_000, ...BASE });
    const token = getValidToken({
      owner: 'acme',
      repo: 'site',
      ref: 'main',
      override: 'env-api-key',
    });
    expect(token).toBe('env-api-key');
  });

  it('returns a valid cached token when no override is set', () => {
    saveToken({ token: 'cached-token', expiresAt: Date.now() + 600_000, ...BASE });
    const token = getValidToken({ owner: 'acme', repo: 'site', ref: 'main' });
    expect(token).toBe('cached-token');
  });

  it('throws NeedsLoginError when no token is cached', () => {
    expect(() =>
      getValidToken({ owner: 'acme', repo: 'site', ref: 'main' }),
    ).toThrow(NeedsLoginError);
  });

  it('throws NeedsLoginError when the cached token is expired', () => {
    saveToken({ token: 'old', expiresAt: Date.now() - 1000, ...BASE });
    expect(() =>
      getValidToken({ owner: 'acme', repo: 'site', ref: 'main' }),
    ).toThrow(NeedsLoginError);
  });

  it('throws NeedsLoginError within the 60s expiry skew window', () => {
    // Expires in 30s — inside the 60s skew, so treated as already expired.
    saveToken({ token: 'soon', expiresAt: Date.now() + 30_000, ...BASE });
    expect(() =>
      getValidToken({ owner: 'acme', repo: 'site', ref: 'main' }),
    ).toThrow(NeedsLoginError);
  });

  it('throws NeedsLoginError when owner/repo do not match the cached token', () => {
    saveToken({ token: 'other', expiresAt: Date.now() + 60_000, ...BASE });
    expect(() =>
      getValidToken({ owner: 'different', repo: 'site', ref: 'main' }),
    ).toThrow(NeedsLoginError);
  });

  it('NeedsLoginError carries the friendly run-login message', () => {
    try {
      getValidToken({ owner: 'acme', repo: 'site', ref: 'main' });
      expect.fail('expected NeedsLoginError');
    } catch (err) {
      expect(err).toBeInstanceOf(NeedsLoginError);
      expect((err as Error).message).toBe(NEEDS_LOGIN_MESSAGE);
      expect((err as Error).message).toContain('npx @focusgts/eds-mcp-server login');
    }
  });

  it('empty override falls through to the cache', () => {
    saveToken({ token: 'cached', expiresAt: Date.now() + 600_000, ...BASE });
    const token = getValidToken({
      owner: 'acme',
      repo: 'site',
      ref: 'main',
      override: '',
    });
    expect(token).toBe('cached');
  });
});

// ---------------------------------------------------------------------------
// login URL construction
// ---------------------------------------------------------------------------

describe('buildLoginUrl', () => {
  const url = buildLoginUrl({
    owner: 'acme',
    repo: 'site',
    ref: 'main',
    port: 49152,
    state: 'deadbeef',
  });
  const parsed = new URL(url);

  it('targets the hlx admin login endpoint with owner/repo/ref in the path', () => {
    expect(parsed.origin).toBe('https://admin.hlx.page');
    expect(parsed.pathname).toBe('/login/acme/site/main');
  });

  it('uses client_id=aem-cli', () => {
    expect(parsed.searchParams.get('client_id')).toBe('aem-cli');
  });

  it('uses a localhost redirect_uri with the aem-cli callback path and port', () => {
    const redirect = parsed.searchParams.get('redirect_uri');
    expect(redirect).toBe('http://localhost:49152/.aem/cli/login/ack');
  });

  it('includes the state nonce', () => {
    expect(parsed.searchParams.get('state')).toBe('deadbeef');
  });

  it('forces the account chooser with selectAccount=true', () => {
    expect(parsed.searchParams.get('selectAccount')).toBe('true');
  });
});

describe('generateNonce', () => {
  it('returns a random 32-char hex string', () => {
    const a = generateNonce();
    const b = generateNonce();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});
