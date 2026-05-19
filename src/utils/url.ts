/**
 * URL construction helpers for Adobe Edge Delivery Services.
 *
 * EDS uses a predictable URL scheme across its admin, preview, live, and
 * analytics surfaces. These helpers centralise that logic so tool handlers
 * never build URLs by hand.
 */

const ADMIN_ORIGIN = 'https://admin.hlx.page';
const LIVE_ORIGIN_SUFFIX = '.aem.live';
const PREVIEW_ORIGIN_SUFFIX = '.aem.page';
const RUM_QUERY_BASE = 'https://helix-pages.anywhere.run/helix-services/run-query@v3';

/**
 * Strip a leading slash (if present) and collapse consecutive slashes so that
 * the path can be safely appended to a base URL.
 *
 * Edge cases handled:
 * - Empty string / undefined => returns empty string
 * - Root path "/" => returns empty string
 * - Multiple leading slashes => all removed
 * - Trailing slashes preserved (the admin API treats them as meaningful)
 */
export function normalizePath(path: string | undefined | null): string {
  if (!path) {
    return '';
  }

  // Collapse runs of slashes into one, then strip the leading slash.
  const collapsed = path.replace(/\/{2,}/g, '/');
  return collapsed.replace(/^\//, '');
}

/**
 * Build an EDS Admin API URL.
 *
 * Pattern: `https://admin.hlx.page/{action}/{owner}/{repo}/{ref}/{path}`
 *
 * @param owner  - GitHub org or user
 * @param repo   - GitHub repository name
 * @param ref    - Git branch (defaults to "main")
 * @param path   - Site-relative path (leading slash optional)
 * @param action - Admin action: "status", "preview", "live", "code", "cache"
 */
export function buildAdminUrl(
  owner: string,
  repo: string,
  ref: string,
  path: string,
  action: string,
): string {
  const normalized = normalizePath(path);
  const segments = [action, owner, repo, ref];

  if (normalized) {
    segments.push(normalized);
  }

  return `${ADMIN_ORIGIN}/${segments.join('/')}`;
}

/**
 * Build a content delivery URL on the live (*.aem.live) domain.
 *
 * Pattern: `https://{ref}--{repo}--{owner}.aem.live/{path}{extension}`
 *
 * @param owner     - GitHub org or user
 * @param repo      - GitHub repository name
 * @param ref       - Git branch (defaults to "main")
 * @param path      - Site-relative path
 * @param extension - Optional file extension to append (e.g. ".plain.html")
 */
export function buildContentUrl(
  owner: string,
  repo: string,
  ref: string,
  path: string,
  extension?: string,
): string {
  const normalized = normalizePath(path);
  const host = `${ref}--${repo}--${owner}${LIVE_ORIGIN_SUFFIX}`;
  const ext = extension ?? '';

  if (normalized) {
    return `https://${host}/${normalized}${ext}`;
  }

  return `https://${host}/${ext}`;
}

/**
 * Build a preview URL on the *.aem.page domain.
 *
 * Pattern: `https://{ref}--{repo}--{owner}.aem.page/{path}`
 *
 * @param owner - GitHub org or user
 * @param repo  - GitHub repository name
 * @param ref   - Git branch (defaults to "main")
 * @param path  - Site-relative path
 */
export function buildPreviewUrl(
  owner: string,
  repo: string,
  ref: string,
  path: string,
): string {
  const normalized = normalizePath(path);
  const host = `${ref}--${repo}--${owner}${PREVIEW_ORIGIN_SUFFIX}`;

  if (normalized) {
    return `https://${host}/${normalized}`;
  }

  return `https://${host}/`;
}

/**
 * Build a RUM analytics query URL.
 *
 * Pattern: `https://helix-pages.anywhere.run/helix-services/run-query@v3/{query}`
 *
 * @param query - Query endpoint name (e.g. "rum-dashboard", "rum-404", "rum-experiments")
 */
export function buildRumQueryUrl(query: string): string {
  const normalized = normalizePath(query);
  return `${RUM_QUERY_BASE}/${normalized}`;
}
