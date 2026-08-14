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
  DaPushPreview,
  DaPushPlanEntry,
  DaUndo,
} from './types.js';
import { EdsApiError } from '../utils/errors.js';

/** Friendly message shown when a DA operation is attempted without a token. */
export const NEEDS_DA_TOKEN_MESSAGE =
  'No DA token configured. Set EDS_DA_TOKEN to a Document Authoring API token to use the DA content tools — see the README.';

/** Sleep for `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Count added/removed lines between two versions (multiset line difference). */
function lineChanges(oldContent: string, newContent: string): { added: number; removed: number } {
  const tally = (text: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (const line of text.split('\n')) m.set(line, (m.get(line) ?? 0) + 1);
    return m;
  };
  const oldT = tally(oldContent);
  const newT = tally(newContent);
  let added = 0;
  let removed = 0;
  for (const [line, n] of newT) added += Math.max(0, n - (oldT.get(line) ?? 0));
  for (const [line, n] of oldT) removed += Math.max(0, n - (newT.get(line) ?? 0));
  return { added, removed };
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

  /**
   * List sources/directories under a path — GET /list/{org}/{repo}[/{path}].
   *
   * DA paginates the listing (S3's 1000-key default) via the
   * `da-continuation-token` header, in and out. We follow it to completion so
   * large folders aren't silently truncated (which would make an export report
   * "complete" while missing files).
   */
  async listSources(path?: string): Promise<DaSourceEntry[]> {
    const suffix = path ? `/${this.normalizePath(path)}` : '';
    const endpoint = `/list/${this.org}/${this.repo}${suffix}`;
    const all: DaSourceEntry[] = [];
    let token: string | null = null;
    // Safety cap so a misbehaving token loop can't run forever (~50k entries).
    for (let page = 0; page < 50; page++) {
      const res = await this.request(endpoint, {
        method: 'GET',
        headers: token ? { 'da-continuation-token': token } : undefined,
      });
      const body = (await res.json().catch(() => null)) as unknown;
      // The API may return a bare array or a { sources: [...] } wrapper.
      let entries: DaSourceEntry[] = [];
      if (Array.isArray(body)) {
        entries = body as DaSourceEntry[];
      } else if (body && typeof body === 'object' && Array.isArray((body as { sources?: unknown }).sources)) {
        entries = (body as { sources: DaSourceEntry[] }).sources;
      }
      // DA list paths include the /{org}/{repo} prefix; strip it so a listed
      // path is site-relative and can be passed back to get_source/put_source.
      for (const e of entries) all.push({ ...e, path: this.stripSitePrefix(e.path) });

      token = res.headers.get('da-continuation-token') || null;
      if (!token) break;
    }
    return all;
  }

  /** True when a listing entry is a file (has a file extension); DA folders have none. */
  private hasExtension(entry: DaSourceEntry): boolean {
    if (typeof entry.ext === 'string' && entry.ext.length > 0) return true;
    const last = (entry.path ?? '').split('/').pop() ?? '';
    return last.lastIndexOf('.') > 0;
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

    // Only descend into folders under the requested root, so a stray or
    // self-referential listing entry can't walk us out of the subtree.
    const rootNorm = path.replace(/^\/+|\/+$/g, '');
    const rootPrefix = rootNorm === '' ? '/' : `/${rootNorm}/`;
    const inTree = (p: string): boolean =>
      rootNorm === '' || p === `/${rootNorm}` || p.startsWith(rootPrefix);
    const dirKey = (p: string): string => p.replace(/^\/+|\/+$/g, '');

    // Breadth-first discovery of file paths (folders end with '/'). A `visited`
    // set defends against cycles/duplicates; folder listings are guarded so one
    // unreadable folder is recorded and skipped, not fatal to the whole export.
    const files: string[] = [];
    const failed: Array<{ path: string; error: string }> = [];
    const visited = new Set<string>();
    const queue: string[] = [path];
    let skippedFile = false;
    while (queue.length > 0 && files.length < maxFiles) {
      const dir = queue.shift() as string;
      const key = dirKey(dir);
      if (visited.has(key)) continue;
      visited.add(key);

      let entries: DaSourceEntry[];
      try {
        entries = await this.listSources(dir);
      } catch (error) {
        failed.push({ path: dir, error: error instanceof Error ? error.message : String(error) });
        continue;
      }

      for (const entry of entries) {
        if (!entry.path) continue;
        // DA marks folders by the ABSENCE of a file extension (verified against
        // adobe/da-admin formatList: CommonPrefixes → { path, name } with no
        // `ext`; folder paths have no trailing slash). A trailing-slash check
        // would never match a real folder and silently flatten the export.
        const isFolder = !this.hasExtension(entry);
        if (isFolder) {
          if (!visited.has(dirKey(entry.path)) && inTree(entry.path)) {
            queue.push(entry.path);
          }
        } else if (!inTree(entry.path)) {
          // A file outside the requested subtree (shouldn't happen, but the
          // containment invariant applies to files too, not just folders).
          continue;
        } else if (files.length < maxFiles) {
          files.push(entry.path);
        } else {
          skippedFile = true;
        }
      }
    }
    // Truncated only when we genuinely stopped short: a file was skipped, or we
    // hit the cap with folders still unexplored.
    const truncated = skippedFile || (files.length >= maxFiles && queue.length > 0);

    const documents: DaDocument[] = [];
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
    options: { concurrency?: number; withUndo?: boolean } = {},
  ): Promise<DaPushResult> {
    const concurrency = options.concurrency ?? 6;
    const succeeded: string[] = [];
    const failed: Array<{ path: string; error: string }> = [];
    const restore: DaDocument[] = [];
    const remove: string[] = [];
    await this.mapWithConcurrency(
      documents,
      async (doc) => {
        try {
          // Read prior state first (needed for the undo entry and to skip no-op
          // writes), but only RECORD the undo entry AFTER the write succeeds.
          // Recording before the write would let a failed write leave a phantom
          // undo entry — e.g. a `remove` for a doc that was never created, which
          // rollback would then delete: the safety feature causing data loss.
          let prior: DaSourceContent | null = null;
          if (options.withUndo) {
            prior = await this.getSourceOrNull(doc.path);
            // Already in the desired state: don't write a spurious version, and
            // there's nothing to undo. Mirrors previewPush's `unchanged`.
            if (prior && prior.content === doc.content) {
              succeeded.push(doc.path);
              return;
            }
          }
          await this.putSource(doc.path, doc.content, doc.contentType);
          succeeded.push(doc.path);
          if (options.withUndo) {
            if (prior) restore.push(prior);
            else remove.push(this.docPath(doc.path));
          }
        } catch (error) {
          failed.push({ path: doc.path, error: error instanceof Error ? error.message : String(error) });
        }
      },
      concurrency,
    );
    const result: DaPushResult = { succeeded, failed };
    if (options.withUndo) result.undo = { restore, remove };
    return result;
  }

  /**
   * Preview a push without writing: classify each document as create / update /
   * unchanged (with line-change counts for updates). Read-only, so always safe.
   */
  async previewPush(documents: DaDocument[]): Promise<DaPushPreview> {
    const plan: DaPushPlanEntry[] = [];
    await this.mapWithConcurrency(
      documents,
      async (doc) => {
        const prior = await this.getSourceOrNull(doc.path);
        if (prior === null) {
          plan.push({ path: this.docPath(doc.path), action: 'create' });
        } else if (prior.content === doc.content) {
          plan.push({ path: prior.path, action: 'unchanged' });
        } else {
          plan.push({ path: prior.path, action: 'update', changes: lineChanges(prior.content, doc.content) });
        }
      },
      6,
    );
    const summary = { create: 0, update: 0, unchanged: 0 };
    for (const e of plan) summary[e.action] += 1;
    return { plan, summary };
  }

  /**
   * Undo a push: re-write the prior content of updated docs and delete the docs
   * the push created. Takes the `undo` object returned by a `withUndo` push.
   */
  async rollback(undo: DaUndo): Promise<DaPushResult> {
    const restored = await this.pushDocuments(undo.restore);
    const removed: string[] = [];
    const failed = [...restored.failed];
    await this.mapWithConcurrency(
      undo.remove,
      async (path) => {
        try {
          await this.deleteSource(path);
          removed.push(this.docPath(path));
        } catch (error) {
          failed.push({ path, error: error instanceof Error ? error.message : String(error) });
        }
      },
      6,
    );
    return { succeeded: [...restored.succeeded, ...removed], failed };
  }

  /** Get a document's source, or null if it does not exist (404). */
  private async getSourceOrNull(path: string): Promise<DaSourceContent | null> {
    try {
      return await this.getSource(path);
    } catch (error) {
      if (error instanceof EdsApiError && error.status === 404) return null;
      throw error;
    }
  }

  /** The site-relative document path a write would target (with .html applied). */
  private docPath(path: string): string {
    return `/${this.normalizeDocPath(path)}`;
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
