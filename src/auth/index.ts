/**
 * Auth entry point for the EDS Admin API.
 *
 * `getValidToken` is the single resolution point used at request time by the
 * admin client. It implements the precedence:
 *
 *   1. Explicit override (the legacy `EDS_API_KEY`) — always wins, bypasses
 *      the cache so CI / automation keeps working unchanged.
 *   2. A valid cached token from the browser login flow (`~/.aem/auth-token.json`),
 *      provided it isn't within 60s of expiry and matches owner/repo.
 *   3. Otherwise throw {@link NeedsLoginError} with a friendly "run login"
 *      message. We never auto-open a browser here because the MCP server runs
 *      headless over stdio.
 */

import { loadToken } from './token-store.js';

export { login } from './admin-login.js';
export type { LoginOptions, LoginResult } from './admin-login.js';
export {
  loadToken,
  saveToken,
  clearToken,
  getTokenPath,
  getTokenDir,
} from './token-store.js';
export type { StoredToken } from './token-store.js';

/** Skew applied before a cached token's expiry so we never use a stale token. */
const EXPIRY_SKEW_MS = 60_000;

/** Friendly message shown whenever a fresh login is required. */
export const NEEDS_LOGIN_MESSAGE =
  'No valid EDS Admin token. Run `npx @focusgts/eds-mcp-server login` to sign in.';

/**
 * Error thrown when an admin operation is attempted without a usable token.
 *
 * Surfaces through the normal MCP error path (handlers wrap in try/catch via
 * `formatError`) so the user sees the friendly "run login" guidance.
 */
export class NeedsLoginError extends Error {
  readonly code = 'NEEDS_LOGIN';

  constructor(message: string = NEEDS_LOGIN_MESSAGE) {
    super(message);
    this.name = 'NeedsLoginError';
  }
}

/** Inputs for resolving a token at request time. */
export interface GetValidTokenOptions {
  owner: string;
  repo: string;
  ref?: string;
  /** Explicit override (the legacy `EDS_API_KEY`). Bypasses the cache. */
  override?: string;
}

/**
 * Resolve a usable admin token, or throw {@link NeedsLoginError}.
 *
 * @throws {NeedsLoginError} when no override is set and no valid cached token
 *         exists for the requested owner/repo.
 */
export function getValidToken(options: GetValidTokenOptions): string {
  const { owner, repo, override } = options;

  // 1. Override always wins and bypasses the cache.
  if (override && override.length > 0) {
    return override;
  }

  // 2. Fall back to a cached token from the browser login flow.
  const cached = loadToken();
  if (
    cached &&
    cached.owner === owner &&
    cached.repo === repo &&
    Date.now() < cached.expiresAt - EXPIRY_SKEW_MS
  ) {
    return cached.token;
  }

  // 3. No usable credential — guide the user to sign in.
  throw new NeedsLoginError();
}
