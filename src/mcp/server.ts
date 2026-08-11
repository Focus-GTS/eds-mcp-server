/**
 * MCP server factory for the EDS MCP server.
 *
 * Creates a {@link McpServer} instance with all 21 EDS tools registered.
 * Tool naming follows the `eds_{verb}_{noun}` convention used by Adobe's
 * first-party MCP servers.
 *
 * Each tool is wired to its corresponding handler in `./handlers.ts` and
 * shares a single {@link EdsClient} instance for the lifetime of the server.
 */

import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { EdsClient } from '../eds-admin/client.js';
import type { EdsClientOptions } from '../eds-admin/types.js';
import * as handlers from './handlers.js';

const require = createRequire(import.meta.url);
const { version } = require('../../package.json') as { version: string };

const edsPath = z
  .string()
  .min(1, 'Path must not be empty')
  .refine(
    (v) =>
      !v.split('/').some((s) => {
        // Decode first so percent-encoded traversal (`%2e%2e`) is caught too.
        let decoded: string;
        try {
          decoded = decodeURIComponent(s);
        } catch {
          decoded = s;
        }
        return decoded === '..' || decoded === '.';
      }),
    {
      message: 'Path must not contain traversal segments (.. or .)',
    },
  );

const edsDomain = z
  .string()
  .min(1)
  .refine((v) => !v.startsWith('http'), {
    message: 'Provide the bare domain (e.g. www.example.com), not a full URL',
  });

const positiveInt = z.number().int().min(0);

/**
 * Create a fully-configured MCP server with all EDS tools.
 *
 * @param options - Connection options forwarded to the underlying EDS client.
 * @returns A ready-to-connect {@link McpServer} instance.
 */
export function createServer(options: EdsClientOptions): McpServer {
  const server = new McpServer({
    name: 'eds-mcp-server',
    version,
  });

  const client = new EdsClient(options);

  // ---------------------------------------------------------------------------
  // Publishing tools
  // ---------------------------------------------------------------------------

  server.tool(
    'eds_preview_page',
    'Trigger preview for an EDS page so changes from the content source are reflected on the preview domain (*.aem.page)',
    {
      path: edsPath
        .describe('Page path relative to the site root (e.g., /about or /blog/my-post)'),
    },
    async (args) => handlers.handlePreviewPage(client, args),
  );

  server.tool(
    'eds_publish_page',
    'Publish an EDS page from preview to the live production domain (*.aem.live)',
    {
      path: edsPath
        .describe('Page path to publish (e.g., /about)'),
    },
    async (args) => handlers.handlePublishPage(client, args),
  );

  server.tool(
    'eds_unpublish_page',
    'Remove an EDS page from the live production site. The page will no longer be publicly accessible.',
    {
      path: edsPath
        .describe('Page path to unpublish (e.g., /blog/old-post)'),
    },
    async (args) => handlers.handleUnpublishPage(client, args),
  );

  server.tool(
    'eds_get_status',
    'Get the current preview, live, and code-bus status for an EDS resource including URLs and modification timestamps',
    {
      path: edsPath
        .describe('Resource path to check status for (e.g., /about or /scripts/main.js)'),
    },
    async (args) => handlers.handleGetStatus(client, args),
  );

  server.tool(
    'eds_purge_cache',
    'Purge the CDN cache for an EDS page path so the next request fetches fresh content',
    {
      path: edsPath
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
      path: edsPath
        .describe('Page path to fetch content for (e.g., /about)'),
    },
    async (args) => handlers.handleGetPage(client, args),
  );

  server.tool(
    'eds_list_pages',
    'List pages from the site query index with pagination support',
    {
      limit: positiveInt
        .max(1000)
        .optional()
        .describe('Maximum number of pages to return (default 100)'),
      offset: positiveInt
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
      domain: edsDomain
        .describe('Site domain to query (e.g., www.example.com)'),
      days: positiveInt
        .min(1)
        .max(90)
        .optional()
        .describe('Number of days to include in the report (default 7)'),
    },
    async (args) => handlers.handleGetCwv(client, args),
  );

  server.tool(
    'eds_get_404s',
    'Get a report of 404 errors for an EDS site including hit counts and referrer sources',
    {
      domain: edsDomain
        .describe('Site domain to query (e.g., www.example.com)'),
      days: positiveInt
        .min(1)
        .max(90)
        .optional()
        .describe('Number of days to include in the report (default 7)'),
    },
    async (args) => handlers.handleGet404s(client, args),
  );

  server.tool(
    'eds_get_experiments',
    'Get A/B experiment results for an EDS site including variant views, clicks, and conversion rates',
    {
      domain: edsDomain
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
      limit: positiveInt
        .max(500)
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

  // ---------------------------------------------------------------------------
  // Bulk operation tools
  // ---------------------------------------------------------------------------

  server.tool(
    'eds_bulk_preview',
    'Start an asynchronous bulk preview job over many pages in one call. Returns a job handle immediately; poll eds_get_job_status for progress. Use for section updates or content migrations.',
    {
      paths: z
        .array(edsPath)
        .min(1)
        .max(1000)
        .describe('Array of page paths to preview (e.g., ["/blog/post-1", "/blog/post-2"])'),
      forceUpdate: z
        .boolean()
        .optional()
        .describe('Re-process every path even if unchanged (default: only new/modified)'),
    },
    async (args) => handlers.handleBulkPreview(client, args),
  );

  server.tool(
    'eds_bulk_publish',
    'Start an asynchronous bulk publish job from preview to the live production domain over many pages in one call. Returns a job handle immediately; poll eds_get_job_status for progress.',
    {
      paths: z
        .array(edsPath)
        .min(1)
        .max(1000)
        .describe('Array of page paths to publish (e.g., ["/blog/post-1", "/blog/post-2"])'),
      forceUpdate: z
        .boolean()
        .optional()
        .describe('Re-process every path even if unchanged (default: only new/modified)'),
    },
    async (args) => handlers.handleBulkPublish(client, args),
  );

  server.tool(
    'eds_get_job_status',
    'Check the progress of an asynchronous bulk job started by eds_bulk_preview or eds_bulk_publish. Reports state (created/running/stopped) and processed/failed counts.',
    {
      topic: z
        .string()
        .min(1)
        .describe('Job topic returned by the bulk operation (e.g., "preview" or "publish")'),
      name: z
        .string()
        .min(1)
        .describe('Job name returned by the bulk operation'),
    },
    async (args) => handlers.handleGetJobStatus(client, args),
  );

  server.tool(
    'eds_preview_and_publish',
    'Preview a page and then immediately publish it to live in a single atomic operation. The most common EDS workflow.',
    {
      path: edsPath
        .describe('Page path to preview and publish (e.g., /about)'),
    },
    async (args) => handlers.handlePreviewAndPublish(client, args),
  );

  // ---------------------------------------------------------------------------
  // Redirects
  // ---------------------------------------------------------------------------

  server.tool(
    'eds_get_redirects',
    'Fetch and parse the site redirects spreadsheet (redirects.json). Returns all redirect rules with source, destination, and type (301/302).',
    {},
    async () => handlers.handleGetRedirects(client, {} as Record<string, never>),
  );

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------

  server.tool(
    'eds_search_pages',
    'Search for pages by keyword across titles, descriptions, and paths in the site query index',
    {
      query: z
        .string()
        .min(1)
        .describe('Search term to match against page titles, descriptions, and paths'),
      limit: positiveInt
        .max(100)
        .optional()
        .describe('Maximum number of results to return (default 20)'),
    },
    async (args) => handlers.handleSearchPages(client, args),
  );

  return server;
}
