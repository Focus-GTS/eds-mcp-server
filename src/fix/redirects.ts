/**
 * Redirect fix (ADR-013) — add or update redirect rules by editing the site's
 * `redirects` sheet, so the EDS pipeline serves them at `/redirects.json` (301s).
 *
 * Grounded against Adobe's docs: a redirects sheet is a single document whose
 * table uses the FIRST ROW as column names (`Source`, `Destination`) and each
 * subsequent row as a rule. In DA this is one authored `<table>` document.
 *
 * The writer is careful (the metadata-review lesson): it preserves the sheet's
 * existing headers and any extra columns, only updating the Destination of a
 * matching Source or appending a new row — it never rebuilds rows from a lossy
 * projection, and it is idempotent (re-adding the same rule is a no-op).
 */

/** One redirect rule. */
export interface RedirectRule {
  source: string;
  destination: string;
}

/** One rule the fix changed. */
export interface RedirectChange {
  source: string;
  from: string | null;
  to: string;
}

/** Result of applying redirect rules to the sheet's DA source. */
export interface ApplyRedirectsResult {
  html: string;
  changes: RedirectChange[];
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function decodeEntities(s: string): string {
  const m: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#x27': "'", '#39': "'" };
  return s.replace(/&(amp|lt|gt|quot|#x27|#39);/g, (_, e) => m[e]);
}
function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, '')).trim();
}

interface ParsedTable {
  headers: string[];
  rows: string[][];
}

/** Parse the first `<table>` into a header row + data rows (cell text). */
export function parseTable(html: string): ParsedTable | null {
  const t = /<table\b[^>]*>([\s\S]*?)<\/table>/i.exec(html);
  if (!t) return null;
  const trs = [...t[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
  const rows = trs.map((tr) =>
    [...tr[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => stripTags(c[1])),
  );
  if (rows.length === 0) return null;
  return { headers: rows[0], rows: rows.slice(1) };
}

/** Read the existing redirect rules from the sheet's DA source. */
export function parseRedirects(html: string): RedirectRule[] {
  const table = parseTable(html);
  if (!table) return [];
  const si = table.headers.findIndex((h) => h.toLowerCase() === 'source');
  const di = table.headers.findIndex((h) => h.toLowerCase() === 'destination');
  if (si < 0 || di < 0) return [];
  return table.rows
    .filter((r) => (r[si] ?? '').trim())
    .map((r) => ({ source: (r[si] ?? '').trim(), destination: (r[di] ?? '').trim() }));
}

function buildRedirectsDoc(headers: string[], rows: string[][]): string {
  const rowHtml = (cells: string[]) =>
    `        <tr>${cells.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`;
  const body = [rowHtml(headers), ...rows.map((r) => rowHtml(headers.map((_, i) => r[i] ?? '')))].join('\n');
  return `<body>\n  <main>\n    <div>\n      <table>\n${body}\n      </table>\n    </div>\n  </main>\n</body>`;
}

/**
 * Apply redirect `rules` to the sheet's DA source (`html`, or null to start a new
 * sheet). Updates the Destination of a matching Source or appends a new row,
 * preserving headers and any extra columns. Returns the new HTML and the rules
 * that actually changed (empty ⇒ all already present, `html` returned unchanged).
 *
 * Throws if an existing sheet has no Source/Destination columns (refuse to
 * clobber an unfamiliar sheet).
 */
export function applyRedirects(html: string | null, rules: RedirectRule[]): ApplyRedirectsResult {
  const table = html ? parseTable(html) : null;
  const headers = table ? table.headers : ['Source', 'Destination'];
  const si = headers.findIndex((h) => h.trim().toLowerCase() === 'source');
  const di = headers.findIndex((h) => h.trim().toLowerCase() === 'destination');
  if (table && (si < 0 || di < 0)) {
    throw new Error('The existing /redirects sheet has no Source/Destination columns — refusing to edit it.');
  }
  const S = si < 0 ? 0 : si;
  const D = di < 0 ? 1 : di;

  const rows: string[][] = table ? table.rows.map((r) => [...r]) : [];
  const indexBySource = new Map<string, number>();
  rows.forEach((r, i) => {
    const s = (r[S] ?? '').trim();
    if (s) indexBySource.set(s, i);
  });

  const changes: RedirectChange[] = [];
  for (const rule of rules) {
    const src = rule.source.trim();
    const dest = rule.destination.trim();
    if (!src) continue;
    const idx = indexBySource.get(src);
    const from = idx !== undefined ? (rows[idx][D] ?? '').trim() : null;
    if (from === dest) continue; // idempotent no-op
    changes.push({ source: src, from, to: dest });
    if (idx !== undefined) {
      rows[idx][D] = dest;
    } else {
      const newRow = new Array(headers.length).fill('');
      newRow[S] = src;
      newRow[D] = dest;
      rows.push(newRow);
      indexBySource.set(src, rows.length - 1);
    }
  }

  if (changes.length === 0) return { html: html ?? buildRedirectsDoc(headers, rows), changes: [] };
  return { html: buildRedirectsDoc(headers, rows), changes };
}
