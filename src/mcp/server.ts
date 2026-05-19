/**
 * MCP server factory for the EDS MCP server.
 *
 * Creates a {@link McpServer} instance with all 15 EDS tools registered.
 * Tool naming follows the `eds_{verb}_{noun}` convention used by Adobe's
 * first-party MCP servers.
 *
 * Each tool is wired to its corresponding handler in `./handlers.ts` and
 * shares a single {@link EdsClient} instance for the lifetime of the server.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { EdsClient } from '../eds-admin/client.js';
import type { EdsClientOptions } from '../eds-admin/types.js';
import * as handlers from './handlers.js';

/**
 * Create a fully-configured MCP server with all EDS tools.
 *
 * @param options - Connection options forwarded to the underlying EDS client.
 * @returns A ready-to-connect {@link McpServer} instance.
 */
export function createServer(options: EdsClientOptions): McpServer {
  const server = new McpServer({
    name: 'eds-mcp-server',
    version: '0.1.0',
  });

  const client = new EdsClient(options);

  // ---------------------------------------------------------------------------
  // Publishing tools
  // ---------------------------------------------------------------------------

  server.tool(
    'eds_preview_page',
    'Trigger preview for an EDS page so changes from the content source are reflected on the preview domain (*.aem.page)',
    {
      path: z
        .string()
        .describe('Page path relative to the site root (e.g., /about or /blog/my-post)'),
    },
    async (args) => handlers.handlePreviewPage(client, args),
  );

  server.tool(
    'eds_publish_page',
    'Publish an EDS page from preview to the live production domain (*.aem.live)',
    {
      path: z
        .string()
        .describe('Page path to publish (e.g., /about)'),
    },
    async (args) => handlers.handlePublishPage(client, args),
  );

  server.tool(
    'eds_unpublish_page',
    'Remove an EDS page from the live production site. The page will no longer be publicly accessible.',
    {
      path: z
        .string()
        .describe('Page path to unpublish (e.g., /blog/old-post)'),
    },
    async (args) => handlers.handleUnpublishPage(client, args),
  );

  server.tool(
    'eds_get_status',
    'Get the current preview, live, and code-bus status for an EDS resource including URLs and modification timestamps',
    {
      path: z
        .string()
        .describe('Resource path to check status for (e.g., /about or /scripts/main.js)'),
    },
    async (args) => handlers.handleGetStatus(client, args),
  );

  server.tool(
    'eds_purge_cache',
    'Purge the CDN cache for an EDS page path so the next request fetches fresh content',
    {
      path: z
        .string()
        .describe('Page path whose CDN cache should be purged (e.g., /about)'),
    },
    async (args) => handlers.handlePurgeCache(client, args),
  );

  // ---------------------------------------------------------------------------
  // Content reading tools
  // ---------------------------------------------------------------------------

  server.tool(
    'eds_get_page',
    'Fetch the rendered HTML content of an EDS page via the .plain.html endpoint',
    {
      path: z
        .string()
        .describe('Page path to fetch content for (e.g., /about)'),
    },
    async (args) => handlers.handleGetPage(client, args),
  );

  server.tool(
    'eds_list_pages',
    'List pages from the site query index with pagination support',
    {
      limit: z
        .number()
        .optional()
        .describe('Maximum number of pages to return (default 100)'),
      offset: z
        .number()
        .optional()
        .describe('Pagination offset (default 0)'),
    },
    async (args) => handlers.handleListPages(client, args),
  );

  server.tool(
    'eds_get_metadata',
    'Fetch the site-wide metadata sheet (metadata.json) containing SEO and social meta values',
    {},
    async () => handlers.handleGetMetadata(client, {} as Record<string, never>),
  );

  server.tool(
    'eds_get_sitemap',
    'Fetch and parse the site sitemap.xml, returning all URLs with last-modified dates',
    {},
    async () => handlers.handleGetSitemap(client, {} as Record<string, never>),
  );

  // ---------------------------------------------------------------------------
  // OpTel / analytics tools
  // ---------------------------------------------------------------------------

  server.tool(
    'eds_get_cwv',
    'Get Core Web Vitals (LCP, CLS, INP, TTFB) for an EDS site from the RUM data pipeline',
    {
      domain: z
        .string()
        .describe('Site domain to query (e.g., www.example.com)'),
      days: z
        .number()
        .optional()
        .describe('Number of days to include in the report (default 7)'),
    },
    async (args) => handlers.handleGetCwv(client, args),
  );

  server.tool(
    'eds_get_404s',
    'Get a report of 404 errors for an EDS site including hit counts and referrer sources',
    {
      domain: z
        .string()
        .describe('Site domain to query (e.g., www.example.com)'),
      days: z
        .number()
        .optional()
        .describe('Number of days to include in the report (default 7)'),
    },
    async (args) => handlers.handleGet404s(client, args),
  );

  server.tool(
    'eds_get_experiments',
    'Get A/B experiment results for an EDS site including variant views, clicks, and conversion rates',
    {
      domain: z
        .string()
        .describe('Site domain to query (e.g., www.example.com)'),
      experiment: z
        .string()
        .optional()
        .describe('Specific experiment ID to filter results (omit for all experiments)'),
    },
    async (args) => handlers.handleGetExperiments(client, args),
  );

  // ---------------------------------------------------------------------------
  // Configuration tools
  // ---------------------------------------------------------------------------

  server.tool(
    'eds_get_config',
    'Read the site configuration from the EDS config endpoint (fstab, headers, redirects, etc.)',
    {},
    async () => handlers.handleGetConfig(client, {} as Record<string, never>),
  );

  server.tool(
    'eds_get_logs',
    'Get the project activity log showing recent preview, publish, and configuration actions',
    {
      limit: z
        .number()
        .optional()
        .describe('Maximum number of log entries to return (default 50)'),
    },
    async (args) => handlers.handleGetLogs(client, args),
  );

  server.tool(
    'eds_get_api_keys',
    'List the API keys configured for the EDS site including their roles and creation dates',
    {},
    async () => handlers.handleGetApiKeys(client, {} as Record<string, never>),
  );

  return server;
}
