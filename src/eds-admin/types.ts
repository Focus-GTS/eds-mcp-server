/**
 * TypeScript interfaces for Adobe Edge Delivery Services admin and content APIs.
 *
 * These types mirror the response shapes returned by the EDS Admin API
 * (admin.hlx.page), the content delivery layer (*.aem.live / *.aem.page),
 * and the RUM / analytics services.
 */

// ---------------------------------------------------------------------------
// Admin API — status
// ---------------------------------------------------------------------------

export interface EdsResourceStatus {
  /** HTTP status code of the last operation (200, 304, 404, etc.) */
  status: number;
  /** Absolute URL of the published or previewed resource */
  url?: string;
  /** ISO-8601 timestamp of the last modification */
  lastModified?: string;
  /** Source location in the content repository (e.g. SharePoint / Google Drive path) */
  sourceLocation?: string;
  /** Source last-modified timestamp */
  sourceLastModified?: string;
  /** Content hash / ETag when available */
  contentBusId?: string;
  /** Permissions object when returned by the API */
  permissions?: string[];
}

export interface EdsStatus {
  /** Path of the resource within the site */
  path: string;
  /** Preview environment status */
  preview: EdsResourceStatus;
  /** Live / production environment status */
  live: EdsResourceStatus;
  /** Code bus status (JS/CSS bundles) */
  code?: EdsResourceStatus;
}

// ---------------------------------------------------------------------------
// Admin API — preview / publish / cache
// ---------------------------------------------------------------------------

export interface EdsPreviewResponse {
  /** Path that was previewed */
  path: string;
  /** Fully-qualified preview URL (*.aem.page) */
  resourcePath: string;
  /** HTTP status code */
  status: number;
  /** Additional links returned by the API */
  links?: Record<string, string>;
}

export interface EdsPublishResponse {
  /**
   * Path that was published. Absent on a 204 No Content response (e.g. an
   * unpublish/DELETE), which carries no body — callers fall back to the
   * requested path.
   */
  path?: string;
  /** Fully-qualified live URL (*.aem.live). Absent on a 204 response. */
  resourcePath?: string;
  /** HTTP status code */
  status: number;
  /** Additional links returned by the API */
  links?: Record<string, string>;
}

export interface EdsCacheResponse {
  /** Path whose cache was purged. Absent on a 204 No Content response. */
  path?: string;
  /** HTTP status code of the purge request */
  status: number;
  /** Human-readable message from the purge endpoint */
  message?: string;
}

// ---------------------------------------------------------------------------
// Content — plain HTML and query index
// ---------------------------------------------------------------------------

export interface EdsPageContent {
  /** Site-relative path of the page */
  path: string;
  /** Raw HTML returned from the plain.html endpoint */
  html: string;
}

export interface EdsQueryIndexEntry {
  /** Site-relative path */
  path: string;
  /** Page title */
  title: string;
  /** Meta description */
  description: string;
  /** Hero / og:image URL */
  image: string;
  /**
   * Unix timestamp (seconds) of last modification. Frequently omitted by real
   * query-index sheets, so treat as optional and render defensively.
   */
  lastModified?: number;
}

export interface EdsQueryIndexResponse {
  /** Total number of entries matching the query */
  total: number;
  /** Pagination offset used in this response */
  offset: number;
  /** Maximum number of entries returned per page */
  limit: number;
  /** Array of index entries */
  data: EdsQueryIndexEntry[];
  /**
   * Set by search when the index exceeded the scan cap, so some matches beyond
   * the cap may be missing. Absent/false means the whole index was scanned.
   */
  truncated?: boolean;
}

// ---------------------------------------------------------------------------
// Content — sitemap
// ---------------------------------------------------------------------------

export interface EdsSitemapEntry {
  /** Absolute URL of the page */
  loc: string;
  /** ISO-8601 date of last modification */
  lastmod?: string;
}

// ---------------------------------------------------------------------------
// RUM / Analytics — Core Web Vitals
// ---------------------------------------------------------------------------

export interface EdsCwvData {
  /** Page URL or path */
  url: string;
  /** Largest Contentful Paint in milliseconds */
  lcp: number;
  /** Cumulative Layout Shift (unitless score) */
  cls: number;
  /** Interaction to Next Paint in milliseconds */
  inp: number;
  /** Time to First Byte in milliseconds */
  ttfb: number;
  /** Total page views in the queried interval */
  pageViews: number;
}

// ---------------------------------------------------------------------------
// RUM / Analytics — 404 tracking
// ---------------------------------------------------------------------------

export interface Eds404Entry {
  /** URL that returned a 404 */
  url: string;
  /** Number of times this 404 was seen */
  views: number;
  /** Referrer URLs or source identifiers that linked to this 404 */
  sources: string[];
}

// ---------------------------------------------------------------------------
// RUM / Analytics — experimentation
// ---------------------------------------------------------------------------

export interface EdsExperimentData {
  /** Experiment identifier */
  experiment: string;
  /** Variant name (e.g. "control", "challenger-1") */
  variant: string;
  /** Total click events attributed to this variant */
  clicks: number;
  /** Total conversion events attributed to this variant */
  converts: number;
  /** Total page views for this variant */
  views: number;
}

// ---------------------------------------------------------------------------
// Site configuration
// ---------------------------------------------------------------------------

export interface EdsConfigResponse {
  /** Raw JSON configuration object from /.helix/config.json or equivalent */
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export interface EdsLogEntry {
  /** ISO-8601 timestamp of the action */
  timestamp: string;
  /** Action performed (e.g. "preview", "publish", "delete") */
  action: string;
  /** Site-relative path affected */
  path: string;
  /** User or service account that triggered the action */
  user: string;
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

export interface EdsApiKey {
  /** Unique key identifier */
  id: string;
  /** Human-readable name / label */
  name: string;
  /** Role granted by this key (e.g. "admin", "publish") */
  role: string;
  /** ISO-8601 creation timestamp */
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Bulk operations
// ---------------------------------------------------------------------------

/**
 * A bulk job accepted by the Admin API (202 response). Bulk preview/publish are
 * asynchronous: one call queues a server-side job over many paths, and progress
 * is polled separately via {@link EdsJobStatus}.
 */
export interface EdsBulkJob {
  /** Job topic — "preview" or "publish" — used when polling status. */
  topic: string;
  /** Server-assigned job name, used when polling status. */
  name: string;
  /** Lifecycle state: "created", "running", or "stopped" (finished). */
  state: string;
  /** ISO-8601 time the job started, when provided. */
  startTime?: string;
  /** Number of paths submitted in this job. */
  pathCount: number;
  /** Absolute URL to poll this job, when the API returns one. */
  self?: string;
}

/** Progress of a bulk job, from GET /job/.../{topic}/{name}[/details]. */
export interface EdsJobStatus {
  /** Job topic — "preview" or "publish". */
  topic: string;
  /** Job name. */
  name: string;
  /** Lifecycle state: "created", "running", or "stopped" (finished). */
  state: string;
  /** ISO-8601 time the job started, when provided. */
  startTime?: string;
  /** Progress counters, when the API reports them. */
  progress?: {
    total?: number;
    processed?: number;
    failed?: number;
  };
  /** Per-job detail (paths in the batch), present on the /details response. */
  data?: {
    paths?: string[];
  };
}

// ---------------------------------------------------------------------------
// Redirects
// ---------------------------------------------------------------------------

export interface EdsRedirectEntry {
  /** Source path (from) */
  source: string;
  /** Destination URL or path (to) */
  destination: string;
  /** HTTP status code — 301 (permanent) or 302 (temporary) */
  type: number;
}

// ---------------------------------------------------------------------------
// Client options — used when constructing the EDS admin client
// ---------------------------------------------------------------------------

export interface EdsClientOptions {
  /** GitHub organisation or user that owns the repository */
  owner: string;
  /** GitHub repository name */
  repo: string;
  /** Git ref (branch name). Defaults to "main" when omitted */
  ref?: string;
  /** Admin API key for authenticated operations */
  apiKey?: string;
  /** Domain key used for RUM / analytics queries */
  domainKey?: string;
  /** Max automatic retries on 429/503 responses (default 3). */
  maxRetries?: number;
  /** Base backoff in ms between retries (default 500). Set 0 in tests. */
  retryBaseMs?: number;
  /** Total time budget for retry sleeps in ms (default 20000). Bounds hangs. */
  maxRetryMs?: number;
  /** Document Authoring (DA) API token (EDS_DA_TOKEN). Enables the DA tools. */
  daToken?: string;
  /** DA org. Defaults to `owner` when omitted. */
  daOrg?: string;
  /** DA repo/site. Defaults to `repo` when omitted. */
  daRepo?: string;
}
