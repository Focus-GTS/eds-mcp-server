/**
 * MCP server factory for the EDS MCP server.
 *
 * Creates a {@link McpServer} instance with all 37 tools registered.
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
import { DaClient } from '../da-admin/client.js';
import type { EdsClientOptions } from '../eds-admin/types.js';
import * as handlers from './handlers.js';
import * as daHandlers from './da-handlers.js';
import * as auditHandlers from './audit-handlers.js';
import * as fixHandlers from './fix-handlers.js';
import { ALL_DIMENSIONS } from '../audit/types.js';

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
  const daClient = new DaClient({
    token: options.daToken,
    org: options.daOrg ?? options.owner,
    repo: options.daRepo ?? options.repo,
  });

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
      offset: positiveInt
        .optional()
        .describe('Number of matches to skip, for paging through results (default 0)'),
    },
    async (args) => handlers.handleSearchPages(client, args),
  );

  // ---------------------------------------------------------------------------
  // Document Authoring (DA) content tools — direct access to the authored
  // source (admin.da.live). Require EDS_DA_TOKEN; adopted from adobe-rnd/da-mcp.
  // ---------------------------------------------------------------------------

  const daSourcePath = z
    .string()
    .min(1, 'Path must not be empty')
    .refine(
      (v) =>
        !v.split('/').some((s) => {
          let decoded: string;
          try {
            decoded = decodeURIComponent(s);
          } catch {
            decoded = s;
          }
          return decoded === '..' || decoded === '.';
        }),
      { message: 'Path must not contain traversal segments (.. or .)' },
    );

  server.tool(
    'eds_da_list_sources',
    'List authored source documents and folders in Document Authoring (DA) under a path. Requires EDS_DA_TOKEN.',
    {
      path: z
        .string()
        .optional()
        .describe('DA folder path to list (e.g., "blog"); omit for the site root'),
    },
    async (args) => daHandlers.handleDaListSources(daClient, args),
  );

  server.tool(
    'eds_da_get_source',
    'Get the raw authored source (typically HTML) of a Document Authoring document — the source of truth, not the rendered/previewed output. Requires EDS_DA_TOKEN.',
    {
      path: daSourcePath.describe('DA document path; ".html" is assumed when no extension is given (e.g., "index" → index.html, or "data.json")'),
    },
    async (args) => daHandlers.handleDaGetSource(daClient, args),
  );

  server.tool(
    'eds_da_put_source',
    'Create or update (upsert) the authored source of a Document Authoring document. Requires EDS_DA_TOKEN.',
    {
      path: daSourcePath.describe('DA document path to write; ".html" is assumed when no extension is given (e.g., "blog/my-post" → blog/my-post.html)'),
      content: z.string().describe('The full source content to store (typically HTML)'),
      contentType: z
        .string()
        .optional()
        .describe('MIME type of the content (default: text/html)'),
    },
    async (args) => daHandlers.handleDaPutSource(daClient, args),
  );

  server.tool(
    'eds_da_delete_source',
    'Delete an authored source document from Document Authoring. Requires EDS_DA_TOKEN.',
    {
      path: daSourcePath.describe('DA document path to delete'),
    },
    async (args) => daHandlers.handleDaDeleteSource(daClient, args),
  );

  server.tool(
    'eds_da_copy_source',
    'Copy an authored source document to another path in Document Authoring. Requires EDS_DA_TOKEN.',
    {
      from: daSourcePath.describe('Source DA document path'),
      to: daSourcePath.describe('Destination DA document path'),
    },
    async (args) => daHandlers.handleDaCopySource(daClient, args),
  );

  server.tool(
    'eds_da_move_source',
    'Move (rename) an authored source document to another path in Document Authoring. Requires EDS_DA_TOKEN.',
    {
      from: daSourcePath.describe('Source DA document path'),
      to: daSourcePath.describe('Destination DA document path'),
    },
    async (args) => daHandlers.handleDaMoveSource(daClient, args),
  );

  server.tool(
    'eds_da_get_versions',
    'Get the version history of a Document Authoring source document. Requires EDS_DA_TOKEN.',
    {
      path: daSourcePath.describe('DA document path'),
    },
    async (args) => daHandlers.handleDaGetVersions(daClient, args),
  );

  server.tool(
    'eds_da_export',
    'Bulk-export a whole Document Authoring subtree in one call: recursively fetch every document under a path and return all their sources together. The efficient "clone" read for operating on many pages at once (vs. one get per page). Requires EDS_DA_TOKEN.',
    {
      path: z
        .string()
        .refine(
          (v) =>
            !v.split('/').some((s) => {
              let decoded: string;
              try {
                decoded = decodeURIComponent(s);
              } catch {
                decoded = s;
              }
              return decoded === '..' || decoded === '.';
            }),
          { message: 'Path must not contain traversal segments (.. or .)' },
        )
        .describe('DA folder path to export (e.g., "blog"); use "" for the whole site'),
      maxFiles: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .describe('Maximum documents to fetch (default 100); result flags truncation if exceeded'),
    },
    async (args) => daHandlers.handleDaExport(daClient, args),
  );

  server.tool(
    'eds_da_push',
    'Bulk-push many edited Document Authoring documents back in one call. Set dryRun to PREVIEW what would change (create/update/unchanged) without writing anything — safest to run this first. Set withUndo to make the write reversible (returns an undo object for eds_da_rollback). Requires EDS_DA_TOKEN.',
    {
      documents: z
        .array(
          z.object({
            path: daSourcePath.describe('DA document path to write'),
            content: z.string().describe('The full source content (typically HTML)'),
            contentType: z.string().optional().describe('MIME type (default: text/html)'),
          }),
        )
        .min(1)
        .max(1000)
        .describe('The documents to write back'),
      dryRun: z
        .boolean()
        .optional()
        .describe('Preview the changes without writing anything (recommended first pass)'),
      withUndo: z
        .boolean()
        .optional()
        .describe('Capture prior state so the push can be reverted with eds_da_rollback'),
    },
    async (args) => daHandlers.handleDaPush(daClient, args),
  );

  server.tool(
    'eds_da_rollback',
    'Undo a previous eds_da_push. Pass the exact `undo` object returned by a push that used withUndo — it restores overwritten documents and deletes newly-created ones. Requires EDS_DA_TOKEN.',
    {
      undo: z
        .object({
          restore: z
            .array(
              z.object({
                path: daSourcePath.describe('Prior document path'),
                content: z.string(),
                contentType: z.string().optional(),
              }),
            )
            .describe('Prior document contents to re-write'),
          remove: z.array(daSourcePath).describe('Paths the push created, to delete'),
        })
        .describe('The undo object returned by a withUndo push'),
    },
    async (args) => daHandlers.handleDaRollback(daClient, args),
  );

  // -------------------------------------------------------------------------
  // Content audit (ADR-010) — find what's wrong, prioritized and actionable
  // -------------------------------------------------------------------------

  server.tool(
    'eds_audit_page',
    'Audit a single page for SEO and accessibility issues (missing title/description, no H1, images without alt text, missing landmarks, etc.). Returns a prioritized list of findings with suggested fixes. Read-only.',
    {
      path: edsPath.describe('Site-relative page path to audit (e.g. /blog/post)'),
    },
    async (args) => auditHandlers.handleAuditPage(client, args),
  );

  server.tool(
    'eds_audit_site',
    'Sweep the whole site (or a subtree) and return a prioritized list of content-quality issues across SEO, accessibility, freshness, sitemap coverage, and — when a domain is supplied — performance (Core Web Vitals) and 404s from real-user data. Read-only; safe to run anytime. Pair with the eds_da_* write tools to fix what it finds.',
    {
      pathPrefix: z
        .string()
        .optional()
        .describe('Only audit pages under this path prefix (e.g. "/blog/"). Omit for the whole site.'),
      maxPages: z
        .number()
        .int()
        .positive()
        .max(1000)
        .optional()
        .describe('Max pages to fetch for per-page checks (default 50).'),
      dimensions: z
        .array(z.enum(ALL_DIMENSIONS as [string, ...string[]]))
        .optional()
        .describe(`Which dimensions to run (default all): ${ALL_DIMENSIONS.join(', ')}.`),
      domain: z
        .string()
        .optional()
        .describe('Live domain (e.g. www.example.com) for RUM-based performance and 404 checks. Requires EDS_DOMAIN_KEY. Omit to skip those.'),
      days: z
        .number()
        .int()
        .positive()
        .max(365)
        .optional()
        .describe('RUM look-back window in days (default 7).'),
    },
    async (args) =>
      auditHandlers.handleAuditSite(client, args as Parameters<typeof auditHandlers.handleAuditSite>[1]),
  );

  server.tool(
    'eds_audit_report',
    'Run a site audit and return a beautiful, self-contained HTML site-health report — per-dimension health scores, a prioritized issue list, and the suggested fixes — ready to save, host, or share. Same options as eds_audit_site. Read-only.',
    {
      pathPrefix: z.string().optional().describe('Only audit pages under this path prefix. Omit for the whole site.'),
      maxPages: z.number().int().positive().max(1000).optional().describe('Max pages to fetch for per-page checks (default 50).'),
      dimensions: z
        .array(z.enum(ALL_DIMENSIONS as [string, ...string[]]))
        .optional()
        .describe(`Which dimensions to include (default all): ${ALL_DIMENSIONS.join(', ')}.`),
      domain: z.string().optional().describe('Live domain for RUM-based performance and 404 checks (needs EDS_DOMAIN_KEY). Also used as the report title.'),
      days: z.number().int().positive().max(365).optional().describe('RUM look-back window in days (default 7).'),
    },
    async (args) => {
      const site = args.domain ?? `${options.owner}/${options.repo}`;
      return auditHandlers.handleAuditReport(
        client,
        site,
        args as Parameters<typeof auditHandlers.handleAuditReport>[2],
      );
    },
  );

  // -------------------------------------------------------------------------
  // Safe fixes (ADR-011) — repair audit findings through the safe-writes layer
  // -------------------------------------------------------------------------

  server.tool(
    'eds_fix_metadata',
    'Fix a page\'s SEO/social metadata (title, description, Open Graph image) by editing its Document Authoring source. Adds or updates the page\'s Metadata block idempotently, through the safe-writes path (dry-run + undo). The AGENT supplies the values (e.g. write a good meta description); this tool writes them correctly and reversibly. Requires EDS_DA_TOKEN. Set publish:true to preview+publish so the change goes live.',
    {
      path: edsPath.describe('Site-relative page path to fix (e.g. /blog/post)'),
      metadata: z
        .object({
          title: z.string().optional().describe('Page title (aim for 30–60 characters)'),
          description: z.string().optional().describe('Meta description (aim for 120–160 characters)'),
          image: z.string().optional().describe('Open Graph / social share image URL'),
          imageAlt: z.string().optional().describe('Alt text for the social image'),
        })
        .describe('Metadata fields to set (only the ones provided are changed)'),
      dryRun: z
        .boolean()
        .optional()
        .describe('Preview the before/after without writing (recommended first pass)'),
      withUndo: z
        .boolean()
        .optional()
        .describe('Make the write reversible — returns an undo object for eds_da_rollback'),
      publish: z
        .boolean()
        .optional()
        .describe('Preview + publish the page after writing so the change goes live'),
    },
    async (args) => {
      const { imageAlt, ...rest } = args.metadata;
      const metadata = { ...rest, ...(imageAlt !== undefined ? { 'image-alt': imageAlt } : {}) };
      return fixHandlers.handleFixMetadata(daClient, client, {
        path: args.path,
        metadata,
        dryRun: args.dryRun,
        withUndo: args.withUndo,
        publish: args.publish,
      });
    },
  );

  server.tool(
    'eds_bulk_fix_metadata',
    'Fix SEO/social metadata across MANY pages in one reversible operation. Takes a list of { path, metadata } (the agent supplies each page\'s values after auditing). Writes all changed pages in a single batch and returns ONE undo object that reverts the entire batch via eds_da_rollback. dryRun previews the whole plan; publish:true previews+publishes the batch live. Requires EDS_DA_TOKEN. Pair with eds_audit_site to fix a site\'s findings at once.',
    {
      pages: z
        .array(
          z.object({
            path: edsPath.describe('Site-relative page path'),
            metadata: z
              .object({
                title: z.string().optional(),
                description: z.string().optional(),
                image: z.string().optional(),
                imageAlt: z.string().optional(),
              })
              .describe('Metadata fields to set on this page (only provided ones change)'),
          }),
        )
        .min(1)
        .max(500)
        .describe('The pages to fix, each with its own metadata values'),
      dryRun: z.boolean().optional().describe('Preview the whole plan without writing (recommended first pass)'),
      publish: z.boolean().optional().describe('Preview + publish the changed pages so the batch goes live'),
    },
    async (args) => {
      const pages = args.pages.map((p) => {
        const { imageAlt, ...rest } = p.metadata;
        return { path: p.path, metadata: { ...rest, ...(imageAlt !== undefined ? { 'image-alt': imageAlt } : {}) } };
      });
      return fixHandlers.handleBulkFixMetadata(daClient, client, { pages, dryRun: args.dryRun, publish: args.publish });
    },
  );

  server.tool(
    'eds_fix_redirect',
    'Fix broken links (404s) by adding redirect rules to the site\'s `redirects` sheet — the EDS mechanism that serves 301 redirects. Pass one or many { source, destination } rules (source = relative path like /old-page; destination = a relative path or full URL). Idempotent (updates a rule for an existing source, never duplicates). Routed through the safe-writes path (dry-run + undo); publish:true publishes the sheet so redirects go live. Requires EDS_DA_TOKEN. Pair with eds_audit_site (which surfaces the top 404s from real-user data).',
    {
      redirects: z
        .array(
          z.object({
            source: z.string().min(1).describe('The path that should redirect (relative, e.g. /old-page)'),
            destination: z.string().min(1).describe('Where it should go — a relative path or a full URL'),
          }),
        )
        .min(1)
        .max(500)
        .describe('The redirect rules to add or update'),
      dryRun: z.boolean().optional().describe('Preview the rules without writing (recommended first pass)'),
      publish: z.boolean().optional().describe('Preview + publish the redirects sheet so the rules go live'),
    },
    async (args) =>
      fixHandlers.handleFixRedirect(daClient, client, {
        redirects: args.redirects,
        dryRun: args.dryRun,
        publish: args.publish,
      }),
  );

  return server;
}
