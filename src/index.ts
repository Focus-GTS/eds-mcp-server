#!/usr/bin/env node

/**
 * Entry point for the EDS MCP server.
 *
 * Reads configuration from environment variables and starts the server using
 * the stdio transport, which is the standard mechanism for local MCP servers
 * used by Claude Code, Cursor, and other AI-assisted development tools.
 *
 * Required env vars:
 *   EDS_OWNER  — GitHub org / user that owns the EDS site repository
 *   EDS_REPO   — GitHub repository name
 *
 * Optional env vars:
 *   EDS_REF        — Git ref / branch (default: "main")
 *   EDS_API_KEY    — Admin API key for preview / publish / cache operations
 *   EDS_DOMAIN_KEY — OpTel domain key for CWV / 404 / experiment queries
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './mcp/server.js';
import { login, clearToken, loadToken, getTokenPath } from './auth/index.js';

/** Parse `--flag value` and `--flag=value` style CLI arguments. */
function parseFlag(argv: string[], name: string): string | undefined {
  const prefix = `--${name}`;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === prefix) {
      return argv[i + 1];
    }
    if (arg.startsWith(`${prefix}=`)) {
      return arg.slice(prefix.length + 1);
    }
  }
  return undefined;
}

/**
 * `login` subcommand — run the browser sign-in flow and exit.
 *
 * Reads owner/repo/ref from EDS_OWNER/EDS_REPO/EDS_REF or
 * `--owner`/`--repo`/`--ref` flags. Never starts the MCP server.
 */
async function runLogin(argv: string[]): Promise<never> {
  const owner = parseFlag(argv, 'owner') ?? process.env.EDS_OWNER;
  const repo = parseFlag(argv, 'repo') ?? process.env.EDS_REPO;
  const ref = parseFlag(argv, 'ref') ?? process.env.EDS_REF ?? 'main';

  if (!owner || !repo) {
    process.stderr.write(
      [
        'EDS MCP Server — login requires the site owner and repo.',
        '',
        'Provide them via environment variables:',
        '  EDS_OWNER=<org> EDS_REPO=<repo> npx @focusgts/eds-mcp-server login',
        '',
        'Or via flags:',
        '  npx @focusgts/eds-mcp-server login --owner <org> --repo <repo> [--ref main]',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }

  try {
    const result = await login({ owner, repo, ref });
    const expiry = new Date(result.expiresAt).toISOString();
    process.stderr.write(
      `\nSigned in to ${owner}/${repo} (ref: ${ref}). Token cached until ${expiry}.\n`,
    );
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`\nLogin failed: ${message}\n`);
    process.exit(1);
  }
}

/**
 * `logout` subcommand — clear the cached admin token and exit.
 */
function runLogout(): never {
  const path = getTokenPath();
  const hadToken = loadToken() !== null;
  clearToken();
  process.stderr.write(
    hadToken
      ? `\nSigned out. Cleared the cached token at ${path}.\n`
      : `\nNo cached token to clear (${path}).\n`,
  );
  process.exit(0);
}

if (process.argv[2] === 'login') {
  await runLogin(process.argv.slice(3));
}

if (process.argv[2] === 'logout') {
  runLogout();
}

const owner = process.env.EDS_OWNER;
const repo = process.env.EDS_REPO;
const ref = process.env.EDS_REF || 'main';
const apiKey = process.env.EDS_API_KEY;
const domainKey = process.env.EDS_DOMAIN_KEY;
const daToken = process.env.EDS_DA_TOKEN;
const daOrg = process.env.EDS_DA_ORG;
const daRepo = process.env.EDS_DA_REPO;

if (!owner || !repo) {
  process.stderr.write(
    [
      'EDS MCP Server — missing required environment variables.',
      '',
      'Required:',
      '  EDS_OWNER   GitHub org or user that owns the site repository',
      '  EDS_REPO    GitHub repository name',
      '',
      'Optional:',
      '  EDS_REF        Git ref / branch (default: main)',
      '  EDS_API_KEY    Admin API key for write operations',
      '  EDS_DOMAIN_KEY OpTel domain key for analytics queries',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

const server = createServer({
  owner,
  repo,
  ref,
  apiKey,
  domainKey,
  daToken,
  daOrg,
  daRepo,
});
const transport = new StdioServerTransport();

async function shutdown() {
  await server.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await server.connect(transport);
