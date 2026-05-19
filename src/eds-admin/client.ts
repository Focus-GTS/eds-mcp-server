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
} from './types.js';

export class EdsClient {
  private readonly owner: string;
  private readonly repo: string;
  private readonly ref: string;
  private readonly apiKey?: string;
  private readonly domainKey?: string;

  private readonly adminBase = 'https://admin.hlx.page';
  private readonly rumQueryBase =
    'https://helix-pages.anywhere.run/helix-services/run-query@v3';

  constructor(options: EdsClientOptions) {
    this.owner = options.owner;
    this.repo = options.repo;
    this.ref = options.ref ?? 'main';
    this.apiKey = options.apiKey;
    this.domainKey = options.domainKey;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Strip a leading slash so paths are always relative. */
  private normalizePath(path: string): string {
    return path.replace(/^\/+/, '');
  }

  /** Build the AEM Live content origin for this site. */
  private get contentOrigin(): string {
    return `https://${this.ref}--${this.repo}--${this.owner}.aem.live`;
  }

  /** Return common headers for Admin API requests. */
  private getAdminHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Accept': 'application/json',
    };
    if (this.apiKey) {
      headers['x-auth-token'] = this.apiKey;
    }
    return headers;
  }

  /**
   * Generic HTTP request helper with error handling.
   *
   * Throws a descriptive error when the response status is not ok.
   */
  private async request<T>(
    url: string,
    options?: RequestInit,
  ): Promise<T> {
    const response = await fetch(url, options);

    if (!response.ok) {
      const body = await response.text().catch(() => '(no body)');
      throw new Error(
        `EDS API error: ${response.status} ${response.statusText} — ${url}\n${body}`,
      );
    }

    // Some endpoints (DELETE, cache purge) may return 204 No Content.
    const contentType = response.headers.get('content-type') ?? '';
    if (
      response.status === 204 ||
      response.headers.get('content-length') === '0'
    ) {
      return {} as T;
    }

    if (contentType.includes('application/json')) {
      return (await response.json()) as T;
    }

    // Fall back to returning the raw text wrapped in the expected shape.
    return (await response.text()) as unknown as T;
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
      headers: this.getAdminHeaders(),
    });
  }

  /** Publish a page — POST /live/{owner}/{repo}/{ref}/{path} */
  async publishPage(path: string): Promise<EdsPublishResponse> {
    const normalized = this.normalizePath(path);
    const url = `${this.adminBase}/live/${this.owner}/${this.repo}/${this.ref}/${normalized}`;

    return this.request<EdsPublishResponse>(url, {
      method: 'POST',
      headers: this.getAdminHeaders(),
    });
  }

  /** Unpublish a page — DELETE /live/{owner}/{repo}/{ref}/{path} */
  async unpublishPage(path: string): Promise<EdsPublishResponse> {
    const normalized = this.normalizePath(path);
    const url = `${this.adminBase}/live/${this.owner}/${this.repo}/${this.ref}/${normalized}`;

    return this.request<EdsPublishResponse>(url, {
      method: 'DELETE',
      headers: this.getAdminHeaders(),
    });
  }

  /** Get preview + live status — GET /status/{owner}/{repo}/{ref}/{path} */
  async getStatus(path: string): Promise<EdsStatus> {
    const normalized = this.normalizePath(path);
    const url = `${this.adminBase}/status/${this.owner}/${this.repo}/${this.ref}/${normalized}`;

    return this.request<EdsStatus>(url, {
      method: 'GET',
      headers: this.getAdminHeaders(),
    });
  }

  /** Purge CDN cache — POST /cache/{owner}/{repo}/{ref}/{path} */
  async purgeCache(path: string): Promise<EdsCacheResponse> {
    const normalized = this.normalizePath(path);
    const url = `${this.adminBase}/cache/${this.owner}/${this.repo}/${this.ref}/${normalized}`;

    return this.request<EdsCacheResponse>(url, {
      method: 'POST',
      headers: this.getAdminHeaders(),
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
      headers: this.getAdminHeaders(),
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
        headers: this.getAdminHeaders(),
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
        headers: this.getAdminHeaders(),
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
}
