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
