/**
 * Persistent token store for the EDS Admin API.
 *
 * Caches the admin site token obtained via the browser login flow at
 * `~/.aem/auth-token.json` so that users don't have to re-authenticate on
 * every invocation. The file is written with mode 0600 (owner read/write
 * only) because it contains a bearer credential.
 *
 * The on-disk shape is:
 *   { token, expiresAt, owner, repo, ref }
 *
 * Uses only Node built-ins — no external dependencies.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
} from 'node:fs';

/** Persisted token record written to `~/.aem/auth-token.json`. */
export interface StoredToken {
  /** The admin site token used as the `x-auth-token` header value. */
  token: string;
  /** Epoch milliseconds after which the token must be considered expired. */
  expiresAt: number;
  /** GitHub org / owner the token was issued for. */
  owner: string;
  /** GitHub repository the token was issued for. */
  repo: string;
  /** Git ref / branch the token was issued for. */
  ref: string;
}

/** Directory holding the cached token (`~/.aem`). */
export function getTokenDir(): string {
  return join(homedir(), '.aem');
}

/** Absolute path to the cached token file (`~/.aem/auth-token.json`). */
export function getTokenPath(): string {
  return join(getTokenDir(), 'auth-token.json');
}

/**
 * Load the cached token, or `null` if none exists or the file is corrupt.
 *
 * Never throws — a missing or unparseable file is treated as "no token".
 */
export function loadToken(): StoredToken | null {
  const path = getTokenPath();

  try {
    if (!existsSync(path)) {
      return null;
    }
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;

    if (!isStoredToken(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    // Corrupt JSON, permission error, etc. — behave as if no token exists.
    return null;
  }
}

/**
 * Persist a token to `~/.aem/auth-token.json` with mode 0600.
 *
 * Ensures the parent directory exists. Throws only if the write itself
 * fails (e.g. disk full, read-only filesystem).
 */
export function saveToken(data: StoredToken): void {
  const dir = getTokenDir();
  const path = getTokenPath();

  mkdirSync(dir, { recursive: true, mode: 0o700 });

  writeFileSync(path, JSON.stringify(data, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
}

/**
 * Remove the cached token. Never throws if the file is already absent.
 */
export function clearToken(): void {
  const path = getTokenPath();
  try {
    rmSync(path, { force: true });
  } catch {
    // Best-effort — nothing to do if removal fails.
  }
}

/** Type guard validating the on-disk token shape. */
function isStoredToken(value: unknown): value is StoredToken {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.token === 'string' &&
    obj.token.length > 0 &&
    typeof obj.expiresAt === 'number' &&
    typeof obj.owner === 'string' &&
    typeof obj.repo === 'string' &&
    typeof obj.ref === 'string'
  );
}
