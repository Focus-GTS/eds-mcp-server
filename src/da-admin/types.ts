/**
 * Types for the Document Authoring (DA) Admin API (admin.da.live).
 *
 * DA is Adobe's authored-document source for EDS sites. These types cover the
 * content-access surface adopted from adobe-rnd/da-mcp (credited in ADR-007):
 * list, read, write, copy/move, and version history of source documents.
 */

/** Options for constructing a {@link DaClient}. */
export interface DaClientOptions {
  /** DA API bearer token (EDS_DA_TOKEN). When absent, DA tools return a
   *  friendly "set EDS_DA_TOKEN" error rather than failing obscurely. */
  token?: string;
  /** DA org. Defaults to the site owner (EDS_OWNER). */
  org: string;
  /** DA repo/site. Defaults to the site repo (EDS_REPO). */
  repo: string;
  /** Max automatic retries on 429/503 (default 3). */
  maxRetries?: number;
  /** Base backoff in ms between retries (default 500). Set 0 in tests. */
  retryBaseMs?: number;
  /** Total time budget for retry sleeps in ms (default 20000). Bounds hangs. */
  maxRetryMs?: number;
}

/** One entry in a DA directory listing. */
export interface DaSourceEntry {
  /** Site-relative path of the entry. */
  path?: string;
  /** Display name. */
  name?: string;
  /** File extension (absent for directories). */
  ext?: string;
  /** Last-modified time (epoch ms or ISO string, as the API returns it). */
  lastModified?: number | string;
}

/** The raw source content of a DA document. */
export interface DaSourceContent {
  /** Site-relative path of the document. */
  path: string;
  /** Raw source content (typically HTML). */
  content: string;
  /** MIME type reported by the API, when present. */
  contentType?: string;
}

/** One entry in a document's version history. */
export interface DaVersion {
  /** Version id / resource path. */
  path?: string;
  /** Version timestamp. */
  timestamp?: number | string;
  /** Author/user, when reported. */
  author?: string;
  /** Free-form label, when reported. */
  label?: string;
}

/** Result of a DA write/copy/move/delete operation. */
export interface DaOperationResponse {
  /** HTTP status of the operation. */
  status: number;
  /** Affected path, when the API echoes it. */
  path?: string;
}

/** A single authored document (path + its source content). */
export interface DaDocument {
  /** Site-relative document path (e.g. /blog/post.html). */
  path: string;
  /** Raw source content. */
  content: string;
  /** MIME type, when known. */
  contentType?: string;
}

/** Result of a bulk export of a DA subtree. */
export interface DaExportResult {
  /** Every document fetched successfully under the exported path. */
  documents: DaDocument[];
  /** Number of files attempted (bounded by `maxFiles`), not necessarily all that exist. */
  fileCount: number;
  /** True when the subtree exceeded the `maxFiles` cap — some files omitted. */
  truncated: boolean;
  /** Files discovered but not fetchable (e.g. deleted mid-export), not dropped silently. */
  failed: Array<{ path: string; error: string }>;
}

/** Result of a bulk push of many documents. */
export interface DaPushResult {
  /** Paths written successfully. */
  succeeded: string[];
  /** Paths that failed, with the error message. */
  failed: Array<{ path: string; error: string }>;
  /**
   * Present when the push was made with `withUndo`. The reverse operation:
   * `restore` re-writes the prior content of updated docs, `remove` deletes
   * the docs this push newly created. Pass it to `eds_da_rollback` to undo.
   */
  undo?: DaUndo;
}

/** One document's status in a dry-run push preview. */
export interface DaPushPlanEntry {
  /** Site-relative document path. */
  path: string;
  /** What the push would do to it. */
  action: 'create' | 'update' | 'unchanged';
  /** For updates: line-level change counts (added/removed). */
  changes?: { added: number; removed: number };
}

/** Result of a dry-run push preview (no writes performed). */
export interface DaPushPreview {
  /** Per-document plan. */
  plan: DaPushPlanEntry[];
  /** Roll-up counts. */
  summary: { create: number; update: number; unchanged: number };
}

/** The reverse of a push, used to undo it. */
export interface DaUndo {
  /** Prior content to re-write (undoes updates). */
  restore: DaDocument[];
  /** Paths the push created, to delete (undoes creates). */
  remove: string[];
}
