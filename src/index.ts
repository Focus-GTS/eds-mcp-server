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

const owner = process.env.EDS_OWNER;
const repo = process.env.EDS_REPO;
const ref = process.env.EDS_REF || 'main';
const apiKey = process.env.EDS_API_KEY;
const domainKey = process.env.EDS_DOMAIN_KEY;

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

const server = createServer({ owner, repo, ref, apiKey, domainKey });
const transport = new StdioServerTransport();

async function shutdown() {
  await server.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await server.connect(transport);
