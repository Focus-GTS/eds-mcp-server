/**
 * Public library surface for `@focusgts/eds-mcp-server`.
 *
 * This is the package's `main`/`types` entry. It is import-safe and has NO side
 * effects — importing it never starts a server or reads argv/env. The CLI (which
 * does start the stdio server and calls process.exit) lives in `index.ts` and is
 * exposed only as the `eds-mcp-server` bin.
 *
 * Use this to embed the EDS tooling in your own process:
 *
 *   import { createServer, EdsClient } from '@focusgts/eds-mcp-server';
 */

export { createServer } from './mcp/server.js';
export { EdsClient } from './eds-admin/client.js';

export {
  login,
  getValidToken,
  loadToken,
  saveToken,
  clearToken,
  getTokenPath,
  getTokenDir,
  NeedsLoginError,
  NEEDS_LOGIN_MESSAGE,
} from './auth/index.js';
export type { LoginOptions, LoginResult, StoredToken } from './auth/index.js';

export { formatError, EdsApiError } from './utils/errors.js';

export type * from './eds-admin/types.js';
