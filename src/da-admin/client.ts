/**
 * Document Authoring (DA) Admin API client (admin.da.live).
 *
 * Provides direct access to a site's authored source documents — the source of
 * truth behind an EDS site — complementing the query-index/preview content path
 * in the EDS client. Endpoints and request shapes are adopted from Adobe's
 * adobe-rnd/da-mcp (credited in ADR-007); auth is simple bearer-token
 * pass-through (no IMS flow).
 */

import type {
  DaClientOptions,
  DaSourceEntry,
  DaSourceContent,
  DaVersion,
  DaOperationResponse,
  DaDocument,
  DaExportResult,
  DaPushResult,
} from './types.js';
import { EdsApiError } from '../utils/errors.js';

/** Friendly message shown when a DA operation is attempted without a token. */
export const NEEDS_DA_TOKEN_MESSAGE =
  'No DA token configured. Set EDS_DA_TOKEN to a Document Authoring API token to use the DA content tools — see the README.';

/** Sleep for `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class DaClient {
  private readonly token?: string;
  private readonly org: string;
  private readonly repo: string;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly maxRetryMs: number;

  private readonly adminBase = 'https://admin.da.live';
  private static readonly REQUEST_TIMEOUT_MS = 30_000;

  constructor(options: DaClientOptions) {
    this.token = options.token;
    this.org = options.org;
    this.repo = options.repo;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseMs = options.retryBaseMs ?? 500;
    this.maxRetryMs = options.maxRetryMs ?? 20_000;
  }

  /** Whether a DA token is configured. */
  get hasToken(): boolean {
    return typeof this.token === 'string' && this.token.length > 0;
  }

  // -------------------------------------------------------------------------
  // Content operations
  // -------------------------------------------------------------------------

  /** List sources/directories under a path — GET /list/{org}/{repo}[/{path}]. */
  async listSources(path?: string): Promise<DaSourceEntry[]> {
    const suffix = path ? `/${this.normalizePath(path)}` : '';
    const res = await this.request(`/list/${this.org}/${this.repo}${suffix}`, {
      method: 'GET',
    });
    const body = (await res.json().catch(() => null)) as unknown;
    // The API may return a bare array or a { sources: [...] } wrapper.
    let entries: DaSourceEntry[] = [];
    if (Array.isArray(body)) {
      entries = body as DaSourceEntry[];
    } else if (body && typeof body === 'object' && Array.isArray((body as { sources?: unknown }).sources)) {
      entries = (body as { sources: DaSourceEntry[] }).sources;
    }
    // DA list paths include the /{org}/{repo} prefix; strip it so a listed path
    // is site-relative and can be passed straight back to get_source/put_source.
    return entries.map((e) => ({ ...e, path: this.stripSitePrefix(e.path) }));
  }

  /** Remove the leading /{org}/{repo} from a DA-returned path. */
  private stripSitePrefix(path?: string): string | undefined {
    if (!path) return path;
    const prefix = `/${this.org}/${this.repo}`;
    if (path === prefix) return '/';
    if (path.startsWith(`${prefix}/`)) return path.slice(prefix.length);
    return path;
  }

  /** Get a document's raw source — GET /source/{org}/{repo}/{path}. */
  async getSource(path: string): Promise<DaSourceContent> {
    const norm = this.normalizeDocPath(path);
    const res = await this.request(`/source/${this.org}/${this.repo}/${norm}`, {
      method: 'GET',
    });
    const content = await res.text();
    return {
      path: `/${norm}`,
      content,
      contentType: res.headers.get('content-type') ?? undefined,
    };
  }

  /**
   * Create or update a document's source — POST /source/{org}/{repo}/{path}
   * with a `data` form field. DA's POST upserts, so this is one operation.
   */
  async putSource(
    path: string,
    content: string,
    contentType = 'text/html',
  ): Promise<DaOperationResponse> {
    const norm = this.normalizeDocPath(path);
    const form = new FormData();
    form.append('data', new Blob([content], { type: contentType }));
    const res = await this.request(`/source/${this.org}/${this.repo}/${norm}`, {
      method: 'POST',
      body: form,
    });
    return { status: res.status, path: `/${norm}` };
  }

  /** Delete a document — DELETE /source/{org}/{repo}/{path}. */
  async deleteSource(path: string): Promise<DaOperationResponse> {
    const norm = this.normalizeDocPath(path);
    const res = await this.request(`/source/${this.org}/${this.repo}/${norm}`, {
      method: 'DELETE',
    });
    return { status: res.status, path: `/${norm}` };
  }

  /** Copy a document — POST /copy/{org}/{repo}/{from} with a destination. */
  async copySource(from: string, to: string): Promise<DaOperationResponse> {
    return this.copyOrMove('copy', from, to);
  }

  /** Move a document — POST /move/{org}/{repo}/{from} with a destination. */
  async moveSource(from: string, to: string): Promise<DaOperationResponse> {
    return this.copyOrMove('move', from, to);
  }

  private async copyOrMove(
    verb: 'copy' | 'move',
    from: string,
    to: string,
  ): Promise<DaOperationResponse> {
    const src = this.normalizeDocPath(from);
    const dst = this.normalizeDocPath(to);
    const form = new FormData();
    form.append('destination', `/${this.org}/${this.repo}/${dst}`);
    const res = await this.request(`/${verb}/${this.org}/${this.repo}/${src}`, {
      method: 'POST',
      body: form,
    });
    return { status: res.status, path: `/${dst}` };
  }

  /** Get a document's version history — GET /versionlist/{org}/{repo}/{path}. */
  async getVersions(path: string): Promise<DaVersion[]> {
    const norm = this.normalizeDocPath(path);
    const res = await this.request(
      `/versionlist/${this.org}/${this.repo}/${norm}`,
      { method: 'GET' },
    );
    const body = (await res.json().catch(() => null)) as unknown;
    if (Array.isArray(body)) return body as DaVersion[];
    if (body && typeof body === 'object' && Array.isArray((body as { versions?: unknown }).versions)) {
      return (body as { versions: DaVersion[] }).versions;
    }
    return [];
  }

  // -------------------------------------------------------------------------
  // Bulk content operations (the agent-native "clone" model, ADR-008)
  // -------------------------------------------------------------------------

  /**
   * Export a whole DA subtree in one call: recursively list every document
   * under `path` and fetch its source concurrently. This is the agent-native
   * "clone" read — one call instead of the agent orchestrating N list+get
   * calls. Bounded by `maxFiles` (flags `truncated`) and resilient to
   * individual fetch failures (reported in `failed`, never dropped silently).
   */
  async exportTree(
    path: string,
    options: { maxFiles?: number; concurrency?: number } = {},
  ): Promise<DaExportResult> {
    const maxFiles = options.maxFiles ?? 100;
    const concurrency = options.concurrency ?? 6;

    // Breadth-first discovery of file paths (folders end with '/').
    const files: string[] = [];
    const queue: string[] = [path];
    let truncated = false;
    while (queue.length > 0 && files.length < maxFiles) {
      const dir = queue.shift() as string;
      const entries = await this.listSources(dir);
      for (const entry of entries) {
        if (!entry.path) continue;
        if (entry.path.endsWith('/')) {
          queue.push(entry.path);
        } else if (files.length < maxFiles) {
          files.push(entry.path);
        } else {
          truncated = true;
        }
      }
    }
    if (queue.length > 0) truncated = true;

    const documents: DaDocument[] = [];
    const failed: Array<{ path: string; error: string }> = [];
    await this.mapWithConcurrency(
      files,
      async (filePath) => {
        try {
          const src = await this.getSource(filePath);
          documents.push({ path: src.path, content: src.content, contentType: src.contentType });
        } catch (error) {
          failed.push({ path: filePath, error: error instanceof Error ? error.message : String(error) });
        }
      },
      concurrency,
    );

    return { documents, fileCount: files.length, truncated, failed };
  }

  /**
   * Push many documents back to DA in one call, concurrently. The "push" half
   * of the bulk model. Returns per-document succeeded/failed (partial failures
   * never abort the whole batch).
   */
  async pushDocuments(
    documents: DaDocument[],
    options: { concurrency?: number } = {},
  ): Promise<DaPushResult> {
    const concurrency = options.concurrency ?? 6;
    const succeeded: string[] = [];
    const failed: Array<{ path: string; error: string }> = [];
    await this.mapWithConcurrency(
      documents,
      async (doc) => {
        try {
          await this.putSource(doc.path, doc.content, doc.contentType);
          succeeded.push(doc.path);
        } catch (error) {
          failed.push({ path: doc.path, error: error instanceof Error ? error.message : String(error) });
        }
      },
      concurrency,
    );
    return { succeeded, failed };
  }

  /** Run `fn` over `items` with at most `concurrency` in flight at once. */
  private async mapWithConcurrency<T>(
    items: T[],
    fn: (item: T) => Promise<void>,
    concurrency: number,
  ): Promise<void> {
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < items.length) {
        const index = next;
        next += 1;
        await fn(items[index]);
      }
    };
    const size = Math.max(1, Math.min(concurrency, items.length));
    await Promise.all(Array.from({ length: size }, () => worker()));
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Normalize a folder/collection path: drop empty segments (leading, trailing,
   * and internal `//`), reject traversal, and percent-encode each segment.
   */
  private normalizePath(path: string): string {
    return path
      .split('/')
      .filter((seg) => seg.length > 0)
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

  /**
   * Normalize a DA *document* path. DA distinguishes files from folders by the
   * presence of an extension, so a document path with no extension gets `.html`
   * appended — mirroring adobe-rnd/da-mcp's `normalizePagePath`. Without this,
   * `get_source("index")` would 404 and `put_source("blog/post")` would create a
   * folder-shaped object instead of a page.
   */
  private normalizeDocPath(path: string): string {
    const norm = this.normalizePath(path);
    if (norm === '') return norm;
    const lastEncoded = norm.split('/').pop() ?? '';
    let lastDecoded: string;
    try {
      lastDecoded = decodeURIComponent(lastEncoded);
    } catch {
      lastDecoded = lastEncoded;
    }
    const hasExtension = lastDecoded.lastIndexOf('.') > 0;
    return hasExtension ? norm : `${norm}.html`;
  }

  /**
   * Authenticated request to the DA Admin API, with retry on transient overload
   * and friendly typed errors. The DA token rides in the Authorization header
   * (never the URL), so it cannot leak into error messages.
   */
  private async request(
    endpoint: string,
    options: RequestInit,
  ): Promise<Response> {
    if (!this.hasToken) {
      throw new EdsApiError(401, NEEDS_DA_TOKEN_MESSAGE);
    }
    const url = `${this.adminBase}${endpoint}`;
    const headers = new Headers(options.headers);
    headers.set('Authorization', `Bearer ${this.token}`);
    // Tag writes so DA attributes the version author as an agent.
    headers.set('x-da-initiator', 'mcp');

    let sleptMs = 0;
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url, {
        ...options,
        headers,
        signal: AbortSignal.timeout(DaClient.REQUEST_TIMEOUT_MS),
      });

      if (response.ok) return response;

      if (attempt < this.maxRetries && this.isRetryable(response, options)) {
        const delay = this.retryDelayMs(response, attempt);
        // Bound total sleep so a hostile Retry-After can't hang the call.
        if (sleptMs + delay <= this.maxRetryMs) {
          sleptMs += delay;
          await sleep(delay);
          continue;
        }
      }

      await this.throwForStatus(response, url);
    }
  }

  private isRetryable(response: Response, options: RequestInit): boolean {
    if (response.status === 429) return true;
    if (response.status !== 503) return false;
    const method = (options.method ?? 'GET').toUpperCase();
    return method === 'GET' || method === 'HEAD';
  }

  private retryDelayMs(response: Response, attempt: number): number {
    const header = response.headers.get('retry-after');
    if (header) {
      const seconds = Number(header);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(seconds * 1000, 30_000);
      }
      const date = Date.parse(header);
      if (!Number.isNaN(date)) {
        return Math.min(Math.max(date - Date.now(), 0), 30_000);
      }
    }
    const backoff = this.retryBaseMs * 2 ** attempt;
    const jitter = this.retryBaseMs * 0.25 * Math.random();
    return Math.min(backoff + jitter, 30_000);
  }

  private async throwForStatus(response: Response, url: string): Promise<never> {
    const body = await response.text().catch(() => '');
    switch (response.status) {
      case 401:
        throw new EdsApiError(401, `${NEEDS_DA_TOKEN_MESSAGE} (the DA token was rejected)`, { url });
      case 403:
        throw new EdsApiError(403, 'Access denied by DA (403). The token lacks permission for this document.', { url });
      case 404:
        throw new EdsApiError(404, 'DA source not found (404). Check the org/site and path.', { url });
      case 429:
        throw new EdsApiError(429, 'Rate limited by DA (429) after retries. Please retry shortly.', { url });
      default:
        throw new EdsApiError(
          response.status,
          `DA API error: ${response.status} ${response.statusText || ''}`.trim(),
          { url, details: body || undefined },
        );
    }
  }
}
