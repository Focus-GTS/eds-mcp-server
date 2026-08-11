/**
 * EDS Admin API client.
 *
 * Wraps three API surfaces behind a single class:
 *   1. Admin API   — admin.hlx.page  (preview, publish, unpublish, status, cache, config, logs)
 *   2. Content API — *.aem.live      (plain.html, query-index.json, metadata.json, sitemap.xml)
 *   3. OpTel / RUM — helix-pages.anywhere.run/helix-services/run-query@v3 (CWV, 404s, experiments)
 */

import type {
  EdsStatus,
  EdsPreviewResponse,
  EdsPublishResponse,
  EdsCacheResponse,
  EdsPageContent,
  EdsQueryIndexResponse,
  EdsSitemapEntry,
  EdsCwvData,
  Eds404Entry,
  EdsExperimentData,
  EdsConfigResponse,
  EdsLogEntry,
  EdsApiKey,
  EdsClientOptions,
  EdsBulkJob,
  EdsJobStatus,
  EdsRedirectEntry,
} from './types.js';
import { getValidToken, clearToken, NEEDS_LOGIN_MESSAGE } from '../auth/index.js';
import { EdsApiError } from '../utils/errors.js';

/** Sleep for `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Raw 202 response from the bulk preview/publish endpoints. */
interface EdsBulkJobResponse {
  status?: number;
  messageId?: string;
  job?: {
    topic?: string;
    name?: string;
    state?: string;
    startTime?: string;
    data?: { paths?: string[] };
  };
  links?: { self?: string; list?: string };
}

/** Query parameters whose values are secrets and must never reach a caller. */
const SECRET_QUERY_PARAMS = ['domainkey', 'domainKey'];

/**
 * Redact secret query parameters from a URL before it goes into an error
 * message. `EDS_DOMAIN_KEY` is carried as the `domainkey` query param on RUM
 * requests; without this it would surface verbatim to the MCP client and its
 * logs on any failed CWV/404/experiment call.
 */
function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    let redacted = false;
    for (const key of SECRET_QUERY_PARAMS) {
      if (u.searchParams.has(key)) {
        // Plain token, not "<redacted>": URL serialization percent-encodes the
        // angle brackets into %3C…%3E, which reads like a real value.
        u.searchParams.set(key, 'REDACTED');
        redacted = true;
      }
    }
    return redacted ? u.toString() : raw;
  } catch {
    return raw;
  }
}

export class EdsClient {
  private readonly owner: string;
  private readonly repo: string;
  private readonly ref: string;
  private readonly apiKey?: string;
  private readonly domainKey?: string;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;

  private readonly adminBase = 'https://admin.hlx.page';
  private readonly rumQueryBase =
    'https://helix-pages.anywhere.run/helix-services/run-query@v3';

  constructor(options: EdsClientOptions) {
    this.owner = options.owner;
    this.repo = options.repo;
    this.ref = options.ref ?? 'main';
    this.apiKey = options.apiKey;
    this.domainKey = options.domainKey;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseMs = options.retryBaseMs ?? 500;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Strip leading slashes, reject path traversal, and percent-encode each
   * segment so it cannot alter the request target.
   *
   * A blocklist that only rejects literal `..`/`.` segments is bypassable:
   * the WHATWG URL parser collapses percent-encoded (`%2e%2e`) and
   * backslash-separated dot segments, and bare `?`/`#` inject a query or
   * fragment. Because the admin token is scoped to the user's identity across
   * every site they can reach — not to one repo — such a bypass would let a
   * request escape the intended `/{verb}/{owner}/{repo}/{ref}/` prefix and act
   * on another site. So we decode each segment to catch disguised traversal,
   * then re-encode it. `encodeURIComponent` leaves `.` untouched, so legitimate
   * paths like `blog/post-1` and `foo.plain.html` are unchanged.
   */
  private normalizePath(path: string): string {
    const cleaned = path.replace(/^\/+/, '');
    return cleaned
      .split('/')
      .map((seg) => {
        let decoded: string;
        try {
          decoded = decodeURIComponent(seg);
        } catch {
          decoded = seg;
        }
        if (decoded === '..' || decoded === '.') {
          throw new Error(`Invalid path: traversal segments are not allowed — ${path}`);
        }
        if (/[\\/]/.test(decoded)) {
          throw new Error(`Invalid path: illegal separator inside a segment — ${path}`);
        }
        return encodeURIComponent(decoded);
      })
      .join('/');
  }

  /** Build the AEM Live content origin for this site. */
  private get contentOrigin(): string {
    return `https://${this.ref}--${this.repo}--${this.owner}.aem.live`;
  }

  /**
   * Resolve headers for an authenticated Admin API request.
   *
   * The auth token is resolved at request time: an explicit `EDS_API_KEY`
   * (`this.apiKey`) is used as an override for backward compatibility, and
   * otherwise the cached browser-login token is used. Throws
   * `NeedsLoginError` (surfaced to the caller as a friendly MCP error) when
   * no usable credential exists.
   */
  private async resolveAdminHeaders(): Promise<Record<string, string>> {
    const token = getValidToken({
      owner: this.owner,
      repo: this.repo,
      ref: this.ref,
      override: this.apiKey,
    });

    return {
      'Accept': 'application/json',
      'x-auth-token': token,
    };
  }

  /**
   * Generic HTTP request helper with error handling.
   *
   * Throws a descriptive error when the response status is not ok.
   */
  private static readonly REQUEST_TIMEOUT_MS = 30_000;

  private async request<T>(
    url: string,
    options?: RequestInit,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(EdsClient.REQUEST_TIMEOUT_MS),
      });

      if (response.ok) {
        return this.parseOk<T>(response);
      }

      // Transient overload (429 Too Many Requests / 503) — back off and retry,
      // honoring a Retry-After header when present, up to `maxRetries` times.
      if (
        (response.status === 429 || response.status === 503) &&
        attempt < this.maxRetries
      ) {
        await sleep(this.retryDelayMs(response, attempt));
        continue;
      }

      await this.throwForStatus(response, url, options);
    }
  }

  /** Parse a successful (2xx) response into the expected type. */
  private async parseOk<T>(response: Response): Promise<T> {
    // Some endpoints (DELETE, cache purge) may return 204 No Content.
    const contentType = response.headers.get('content-type') ?? '';
    if (
      response.status === 204 ||
      response.headers.get('content-length') === '0'
    ) {
      return { status: response.status } as T;
    }

    if (contentType.includes('application/json')) {
      return (await response.json()) as T;
    }

    // Fall back to returning the raw text wrapped in the expected shape.
    return (await response.text()) as unknown as T;
  }

  /** Compute the backoff delay for a retryable response. */
  private retryDelayMs(response: Response, attempt: number): number {
    const header = response.headers.get('retry-after');
    if (header) {
      // Retry-After is either a number of seconds or an HTTP date.
      const seconds = Number(header);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(seconds * 1000, 30_000);
      }
      const date = Date.parse(header);
      if (!Number.isNaN(date)) {
        return Math.min(Math.max(date - Date.now(), 0), 30_000);
      }
    }
    // Exponential backoff with a little jitter so retries don't sync up.
    const backoff = this.retryBaseMs * 2 ** attempt;
    const jitter = this.retryBaseMs * 0.25 * Math.random();
    return Math.min(backoff + jitter, 30_000);
  }

  /**
   * Map a non-2xx response to a friendly, typed {@link EdsApiError}.
   *
   * 401/403/404/429 get actionable guidance; everything else keeps the raw
   * status/body (with secrets redacted) for debugging.
   */
  private async throwForStatus(
    response: Response,
    url: string,
    options?: RequestInit,
  ): Promise<never> {
    const body = await response.text().catch(() => '');
    // Redact the URL's secret params, and scrub the domain key from the body in
    // case the upstream service echoes it back verbatim.
    const safeBody = this.domainKey
      ? body.split(this.domainKey).join('REDACTED')
      : body;
    const safeUrl = redactUrl(url);
    const wasAuthed = this.hadAuthHeader(options);

    switch (response.status) {
      case 401: {
        // The admin token was rejected. If it came from the cache (not the
        // EDS_API_KEY override), clear it so the next call prompts a re-login.
        if (wasAuthed && !this.apiKey) {
          clearToken();
          throw new EdsApiError(401, NEEDS_LOGIN_MESSAGE, { url: safeUrl });
        }
        if (wasAuthed && this.apiKey) {
          throw new EdsApiError(
            401,
            'EDS_API_KEY was rejected (401 Unauthorized). Check the key is current and scoped to this site.',
            { url: safeUrl },
          );
        }
        break;
      }
      case 403:
        throw new EdsApiError(
          403,
          'Access denied (403 Forbidden). Your token is valid but lacks permission for this operation on this site.',
          { url: safeUrl },
        );
      case 404:
        throw new EdsApiError(
          404,
          'Not found (404). The resource may not exist, or may not have been previewed/published yet.',
          { url: safeUrl },
        );
      case 429:
        throw new EdsApiError(
          429,
          'Rate limited by the EDS Admin API (429) after retries. Please retry in a moment.',
          { url: safeUrl },
        );
      default:
        break;
    }

    throw new EdsApiError(
      response.status,
      `EDS API error: ${response.status} ${response.statusText || ''}`.trim(),
      { url: safeUrl, details: safeBody || undefined },
    );
  }

  /** Whether an outgoing request carried the admin auth header. */
  private hadAuthHeader(options?: RequestInit): boolean {
    const headers = options?.headers;
    if (!headers) return false;
    if (headers instanceof Headers) return headers.has('x-auth-token');
    if (Array.isArray(headers)) {
      return headers.some(([k]) => k.toLowerCase() === 'x-auth-token');
    }
    return Object.keys(headers).some((k) => k.toLowerCase() === 'x-auth-token');
  }

  // -------------------------------------------------------------------------
  // Publishing Operations (Admin API)
  // -------------------------------------------------------------------------

  /** Preview a page — POST /preview/{owner}/{repo}/{ref}/{path} */
  async previewPage(path: string): Promise<EdsPreviewResponse> {
    const normalized = this.normalizePath(path);
    const url = `${this.adminBase}/preview/${this.owner}/${this.repo}/${this.ref}/${normalized}`;

    return this.request<EdsPreviewResponse>(url, {
      method: 'POST',
      headers: await this.resolveAdminHeaders(),
    });
  }

  /** Publish a page — POST /live/{owner}/{repo}/{ref}/{path} */
  async publishPage(path: string): Promise<EdsPublishResponse> {
    const normalized = this.normalizePath(path);
    const url = `${this.adminBase}/live/${this.owner}/${this.repo}/${this.ref}/${normalized}`;

    return this.request<EdsPublishResponse>(url, {
      method: 'POST',
      headers: await this.resolveAdminHeaders(),
    });
  }

  /** Unpublish a page — DELETE /live/{owner}/{repo}/{ref}/{path} */
  async unpublishPage(path: string): Promise<EdsPublishResponse> {
    const normalized = this.normalizePath(path);
    const url = `${this.adminBase}/live/${this.owner}/${this.repo}/${this.ref}/${normalized}`;

    return this.request<EdsPublishResponse>(url, {
      method: 'DELETE',
      headers: await this.resolveAdminHeaders(),
    });
  }

  /** Get preview + live status — GET /status/{owner}/{repo}/{ref}/{path} */
  async getStatus(path: string): Promise<EdsStatus> {
    const normalized = this.normalizePath(path);
    const url = `${this.adminBase}/status/${this.owner}/${this.repo}/${this.ref}/${normalized}`;

    return this.request<EdsStatus>(url, {
      method: 'GET',
      headers: await this.resolveAdminHeaders(),
    });
  }

  /** Purge CDN cache — POST /cache/{owner}/{repo}/{ref}/{path} */
  async purgeCache(path: string): Promise<EdsCacheResponse> {
    const normalized = this.normalizePath(path);
    const url = `${this.adminBase}/cache/${this.owner}/${this.repo}/${this.ref}/${normalized}`;

    return this.request<EdsCacheResponse>(url, {
      method: 'POST',
      headers: await this.resolveAdminHeaders(),
    });
  }

  // -------------------------------------------------------------------------
  // Content Reading (Public Content APIs)
  // -------------------------------------------------------------------------

  /**
   * Fetch the plain HTML rendition of a page.
   *
   * GET https://{ref}--{repo}--{owner}.aem.live/{path}.plain.html
   */
  async getPageContent(path: string): Promise<EdsPageContent> {
    let normalized = this.normalizePath(path);

    // Root path needs index.plain.html
    if (normalized === '' || normalized === '/') {
      normalized = 'index.plain.html';
    } else if (!normalized.endsWith('.plain.html')) {
      // Strip any trailing .html so we don't end up with .html.plain.html
      normalized = normalized.replace(/\.html$/, '');
      normalized = `${normalized}.plain.html`;
    }

    const url = `${this.contentOrigin}/${normalized}`;
    const html = await this.request<string>(url, { method: 'GET' });

    // Re-derive the logical path (without .plain.html) for the response.
    const logicalPath = `/${this.normalizePath(path).replace(/\.plain\.html$/, '').replace(/\.html$/, '')}`;

    return {
      path: logicalPath,
      html: typeof html === 'string' ? html : String(html),
    };
  }

  /**
   * List pages from the query index.
   *
   * GET https://{ref}--{repo}--{owner}.aem.live/query-index.json?limit=N&offset=N
   */
  async listPages(
    limit: number = 100,
    offset: number = 0,
  ): Promise<EdsQueryIndexResponse> {
    const params = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
    });
    const url = `${this.contentOrigin}/query-index.json?${params.toString()}`;

    return this.request<EdsQueryIndexResponse>(url, { method: 'GET' });
  }

  /**
   * Fetch the site metadata sheet.
   *
   * GET https://{ref}--{repo}--{owner}.aem.live/metadata.json
   */
  async getMetadata(): Promise<Record<string, unknown>> {
    const url = `${this.contentOrigin}/metadata.json`;
    return this.request<Record<string, unknown>>(url, { method: 'GET' });
  }

  /**
   * Fetch and parse the sitemap.
   *
   * GET https://{ref}--{repo}--{owner}.aem.live/sitemap.xml
   *
   * Uses regex extraction rather than an XML parser to avoid extra
   * dependencies.
   */
  async getSitemap(): Promise<EdsSitemapEntry[]> {
    const url = `${this.contentOrigin}/sitemap.xml`;
    const xml = await this.request<string>(url, { method: 'GET' });
    const xmlStr = typeof xml === 'string' ? xml : String(xml);

    const entries: EdsSitemapEntry[] = [];
    const urlBlockRegex = /<url>([\s\S]*?)<\/url>/g;
    let match: RegExpExecArray | null;

    while ((match = urlBlockRegex.exec(xmlStr)) !== null) {
      const block = match[1];
      const locMatch = /<loc>\s*(.*?)\s*<\/loc>/.exec(block);
      if (!locMatch) continue;

      const entry: EdsSitemapEntry = { loc: locMatch[1] };

      const lastmodMatch = /<lastmod>\s*(.*?)\s*<\/lastmod>/.exec(block);
      if (lastmodMatch) {
        entry.lastmod = lastmodMatch[1];
      }

      entries.push(entry);
    }

    return entries;
  }

  // -------------------------------------------------------------------------
  // OpTel / Performance (RUM Query API)
  // -------------------------------------------------------------------------

  /**
   * Build URL params shared across all RUM queries.
   */
  private buildRumParams(
    domain: string,
    days: number = 7,
  ): URLSearchParams {
    const params = new URLSearchParams({
      domain,
      interval: String(days),
    });
    if (this.domainKey) {
      params.set('domainkey', this.domainKey);
    }
    return params;
  }

  /**
   * Get Core Web Vitals data for a domain.
   *
   * GET {rumQueryBase}/rum-dashboard?domain=...&interval=...&domainkey=...
   */
  async getCwv(
    domain: string,
    days: number = 7,
  ): Promise<EdsCwvData[]> {
    const params = this.buildRumParams(domain, days);
    const url = `${this.rumQueryBase}/rum-dashboard?${params.toString()}`;

    const result = await this.request<{ results: { data: EdsCwvData[] } }>(
      url,
      { method: 'GET' },
    );

    // The RUM API wraps results in { results: { data: [...] } }.
    // Gracefully handle both the wrapped and unwrapped shapes.
    if (result && typeof result === 'object' && 'results' in result) {
      return (result as { results: { data: EdsCwvData[] } }).results.data;
    }
    if (Array.isArray(result)) {
      return result as EdsCwvData[];
    }
    return [];
  }

  /**
   * Get 404 data for a domain.
   *
   * GET {rumQueryBase}/rum-404?domain=...&interval=...&domainkey=...
   */
  async get404s(
    domain: string,
    days: number = 7,
  ): Promise<Eds404Entry[]> {
    const params = this.buildRumParams(domain, days);
    const url = `${this.rumQueryBase}/rum-404?${params.toString()}`;

    const result = await this.request<{ results: { data: Eds404Entry[] } }>(
      url,
      { method: 'GET' },
    );

    if (result && typeof result === 'object' && 'results' in result) {
      return (result as { results: { data: Eds404Entry[] } }).results.data;
    }
    if (Array.isArray(result)) {
      return result as Eds404Entry[];
    }
    return [];
  }

  /**
   * Get experimentation data for a domain.
   *
   * GET {rumQueryBase}/rum-experiment?domain=...&interval=...&domainkey=...
   */
  async getExperiments(
    domain: string,
    experiment?: string,
  ): Promise<EdsExperimentData[]> {
    const params = this.buildRumParams(domain);
    if (experiment) {
      params.set('experiment', experiment);
    }
    const url = `${this.rumQueryBase}/rum-experiment?${params.toString()}`;

    const result = await this.request<{ results: { data: EdsExperimentData[] } }>(
      url,
      { method: 'GET' },
    );

    if (result && typeof result === 'object' && 'results' in result) {
      return (result as { results: { data: EdsExperimentData[] } }).results.data;
    }
    if (Array.isArray(result)) {
      return result as EdsExperimentData[];
    }
    return [];
  }

  // -------------------------------------------------------------------------
  // Configuration & Logs (Admin API)
  // -------------------------------------------------------------------------

  /**
   * Get site configuration.
   *
   * GET /config/{owner}/sites/{repo}.json
   */
  async getConfig(): Promise<EdsConfigResponse> {
    const url = `${this.adminBase}/config/${this.owner}/sites/${this.repo}.json`;

    return this.request<EdsConfigResponse>(url, {
      method: 'GET',
      headers: await this.resolveAdminHeaders(),
    });
  }

  /**
   * Get admin audit logs.
   *
   * GET /log/{owner}/{repo}/{ref}
   */
  async getLogs(limit?: number): Promise<EdsLogEntry[]> {
    let url = `${this.adminBase}/log/${this.owner}/${this.repo}/${this.ref}`;
    if (limit !== undefined) {
      const params = new URLSearchParams({ limit: String(limit) });
      url = `${url}?${params.toString()}`;
    }

    const result = await this.request<EdsLogEntry[] | { data: EdsLogEntry[] }>(
      url,
      {
        method: 'GET',
        headers: await this.resolveAdminHeaders(),
      },
    );

    // Handle both array and wrapped responses.
    if (Array.isArray(result)) {
      return result;
    }
    if (result && typeof result === 'object' && 'data' in result) {
      return (result as { data: EdsLogEntry[] }).data;
    }
    return [];
  }

  /**
   * Get API keys configured for this site.
   *
   * GET /config/{owner}/sites/{repo}/apiKeys.json
   */
  async getApiKeys(): Promise<EdsApiKey[]> {
    const url = `${this.adminBase}/config/${this.owner}/sites/${this.repo}/apiKeys.json`;

    const result = await this.request<EdsApiKey[] | { data: EdsApiKey[] }>(
      url,
      {
        method: 'GET',
        headers: await this.resolveAdminHeaders(),
      },
    );

    if (Array.isArray(result)) {
      return result;
    }
    if (result && typeof result === 'object' && 'data' in result) {
      return (result as { data: EdsApiKey[] }).data;
    }
    return [];
  }

  // -------------------------------------------------------------------------
  // Bulk Operations (Admin API)
  // -------------------------------------------------------------------------

  /**
   * Start a bulk preview job — POST /preview/{owner}/{repo}/{ref}/* with a
   * `{ paths }` body. The Admin API queues one asynchronous job over every
   * path and returns a 202 immediately; poll {@link getJobStatus} for progress.
   *
   * This replaces the old per-path loop, which serialized N requests and blew
   * past client timeouts on large batches.
   */
  async bulkPreview(
    paths: string[],
    options?: { forceUpdate?: boolean },
  ): Promise<EdsBulkJob> {
    return this.startBulkJob('preview', paths, options);
  }

  /**
   * Start a bulk publish job — POST /live/{owner}/{repo}/{ref}/* with a
   * `{ paths }` body. Asynchronous; poll {@link getJobStatus} for progress.
   */
  async bulkPublish(
    paths: string[],
    options?: { forceUpdate?: boolean },
  ): Promise<EdsBulkJob> {
    return this.startBulkJob('live', paths, options);
  }

  /** Shared implementation for the two bulk endpoints. */
  private async startBulkJob(
    verb: 'preview' | 'live',
    paths: string[],
    options?: { forceUpdate?: boolean },
  ): Promise<EdsBulkJob> {
    const url = `${this.adminBase}/${verb}/${this.owner}/${this.repo}/${this.ref}/*`;
    const body: Record<string, unknown> = { paths };
    if (options?.forceUpdate !== undefined) {
      body.forceUpdate = options.forceUpdate;
    }

    const headers = {
      ...(await this.resolveAdminHeaders()),
      'Content-Type': 'application/json',
    };

    const res = await this.request<EdsBulkJobResponse>(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    const job = res.job ?? {};
    return {
      // The publish endpoint is /live/* but its job topic is "publish".
      topic: job.topic ?? (verb === 'live' ? 'publish' : 'preview'),
      name: job.name ?? '',
      state: job.state ?? 'created',
      startTime: job.startTime,
      pathCount: paths.length,
      self: res.links?.self,
    };
  }

  /**
   * Poll a bulk job's progress.
   *
   * GET /job/{owner}/{repo}/{ref}/{topic}/{name}/details
   */
  async getJobStatus(topic: string, name: string): Promise<EdsJobStatus> {
    const url = `${this.adminBase}/job/${this.owner}/${this.repo}/${this.ref}/${encodeURIComponent(
      topic,
    )}/${encodeURIComponent(name)}/details`;

    return this.request<EdsJobStatus>(url, {
      method: 'GET',
      headers: await this.resolveAdminHeaders(),
    });
  }

  /**
   * Preview a page and then immediately publish it.
   */
  async previewAndPublish(path: string): Promise<{ preview: EdsPreviewResponse; publish: EdsPublishResponse }> {
    const preview = await this.previewPage(path);
    const publish = await this.publishPage(path);
    return { preview, publish };
  }

  // -------------------------------------------------------------------------
  // Redirects (Content API)
  // -------------------------------------------------------------------------

  /**
   * Fetch and parse the redirects spreadsheet.
   *
   * GET https://{ref}--{repo}--{owner}.aem.live/redirects.json
   */
  async getRedirects(): Promise<EdsRedirectEntry[]> {
    const url = `${this.contentOrigin}/redirects.json`;

    try {
      const result = await this.request<{ data: Array<Record<string, string>> } | Array<Record<string, string>>>(
        url,
        { method: 'GET' },
      );

      const rows = Array.isArray(result)
        ? result
        : (result && typeof result === 'object' && 'data' in result)
          ? (result as { data: Array<Record<string, string>> }).data
          : [];

      return rows.map((row) => ({
        source: row.Source ?? row.source ?? '',
        destination: row.Destination ?? row.destination ?? '',
        type: parseInt(row.Type ?? row.type ?? '301', 10) || 301,
      })).filter((r) => r.source && r.destination);
    } catch (error) {
      // A missing redirects.json (404) legitimately means "no redirects".
      // Any other failure (auth, network) must surface, not masquerade as empty.
      if (error instanceof EdsApiError && error.status === 404) {
        return [];
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Search (Content API — client-side filtering)
  // -------------------------------------------------------------------------

  /**
   * The query index has no server-side full-text search, so search scans the
   * index client-side. This caps how many rows are pulled per search to bound
   * memory/latency; if a site's index exceeds it, matches beyond the cap are
   * not seen and the result is flagged `truncated`.
   */
  private static readonly SEARCH_SCAN_CAP = 5000;

  /**
   * Search pages in the query index by keyword.
   *
   * Scans up to {@link SEARCH_SCAN_CAP} index rows and filters client-side by
   * title, description, or path. `offset`/`limit` page through the *matches*
   * (not the raw index), so callers can walk a large result set.
   */
  async searchPages(
    query: string,
    limit: number = 20,
    offset: number = 0,
  ): Promise<EdsQueryIndexResponse> {
    const index = await this.listPages(EdsClient.SEARCH_SCAN_CAP, 0);
    const q = query.toLowerCase();

    const filtered = index.data.filter((entry) =>
      entry.title?.toLowerCase().includes(q) ||
      entry.description?.toLowerCase().includes(q) ||
      entry.path?.toLowerCase().includes(q),
    );

    return {
      total: filtered.length,
      offset,
      limit,
      data: filtered.slice(offset, offset + limit),
      // The index itself was longer than we scanned — matches may be missing.
      truncated: index.data.length >= EdsClient.SEARCH_SCAN_CAP,
    };
  }
}
