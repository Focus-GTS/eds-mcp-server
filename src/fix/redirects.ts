/**
 * Redirect fix (ADR-013) — add or update redirect rules by editing the site's
 * `redirects` sheet, so the EDS pipeline serves them at `/redirects.json` (301s).
 *
 * Grounded against Adobe's docs: a redirects sheet is a single document whose
 * table uses the FIRST ROW as column names (`Source`, `Destination`) and each
 * subsequent row as a rule. In DA this is one authored `<table>` document.
 *
 * Because redirects take PRECEDENCE over content (a bad rule hides a live page),
 * the writer is defensive:
 *  - it preserves every untouched row's original HTML byte-for-byte (extra
 *    columns and authored links survive; only changed/new rows are re-rendered);
 *  - it REFUSES to overwrite a present-but-unrecognizable `/redirects` doc (no
 *    silent wipe of existing rules);
 *  - it REFUSES dangerous rules — a self-redirect (loop) or redirecting the site
 *    root `/` (hides the homepage);
 *  - it is idempotent (re-adding the same rule is a no-op).
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

/** The value of a cell: an `<a>`'s href when present (the real target), else text. */
function cellValue(inner: string): string {
  const a = /<a\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)')/i.exec(inner);
  if (a) return (a[2] ?? a[3] ?? '').trim();
  return stripTags(inner);
}

interface ParsedTable {
  headerHtml: string;
  headers: string[];
  rows: Array<{ html: string; cells: string[] }>;
}

const CELL_RE = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
function cellsOf(trHtml: string): string[] {
  return [...trHtml.matchAll(CELL_RE)].map((c) => cellValue(c[1]));
}

/** Parse the first `<table>` into its raw header + rows (each row keeps its HTML). */
export function parseTable(html: string): ParsedTable | null {
  const t = /<table\b[^>]*>([\s\S]*?)<\/table>/i.exec(html);
  if (!t) return null;
  const trs = [...t[1].matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)].map((m) => m[0]);
  if (trs.length === 0) return null;
  return {
    headerHtml: trs[0],
    headers: cellsOf(trs[0]),
    rows: trs.slice(1).map((html) => ({ html, cells: cellsOf(html) })),
  };
}

/** Read the existing redirect rules from the sheet's DA source. */
export function parseRedirects(html: string): RedirectRule[] {
  const table = parseTable(html);
  if (!table) return [];
  const si = table.headers.findIndex((h) => h.toLowerCase() === 'source');
  const di = table.headers.findIndex((h) => h.toLowerCase() === 'destination');
  if (si < 0 || di < 0) return [];
  return table.rows
    .filter((r) => (r.cells[si] ?? '').trim())
    .map((r) => ({ source: (r.cells[si] ?? '').trim(), destination: (r.cells[di] ?? '').trim() }));
}

function buildRow(cells: string[]): string {
  return `        <tr>${cells.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`;
}
function buildDoc(rowHtml: string[]): string {
  return `<body>\n  <main>\n    <div>\n      <table>\n${rowHtml.join('\n')}\n      </table>\n    </div>\n  </main>\n</body>`;
}

/**
 * Apply redirect `rules` to the sheet's DA source (`html`, or null to start a new
 * sheet). Returns the new HTML and the rules that actually changed (empty ⇒ all
 * already present, `html` returned unchanged).
 *
 * Throws on: an existing doc that isn't a recognizable sheet; a sheet without
 * Source/Destination columns; a self-redirect; or redirecting the site root.
 */
export function applyRedirects(html: string | null, rules: RedirectRule[]): ApplyRedirectsResult {
  const trimmed = (html ?? '').trim();
  const table = trimmed ? parseTable(html!) : null;
  if (trimmed && !table) {
    throw new Error('The existing /redirects document is not a recognizable sheet (no table) — refusing to overwrite it.');
  }

  // Refuse obviously dangerous rules — redirects take precedence over content.
  for (const rule of rules) {
    const src = rule.source.trim();
    const dest = rule.destination.trim();
    if (src && src === dest) {
      throw new Error(`Refusing a self-redirect (${src} → ${dest}) — it would loop and hide the page.`);
    }
    if (src === '/') {
      throw new Error('Refusing to redirect the site root "/" — it would hide the homepage.');
    }
  }

  const headers = table ? table.headers : ['Source', 'Destination'];
  const si = headers.findIndex((h) => h.trim().toLowerCase() === 'source');
  const di = headers.findIndex((h) => h.trim().toLowerCase() === 'destination');
  if (table && (si < 0 || di < 0)) {
    throw new Error('The existing /redirects sheet has no Source/Destination columns — refusing to edit it.');
  }
  const S = si < 0 ? 0 : si;
  const D = di < 0 ? 1 : di;

  const rows = table ? table.rows.map((r) => ({ html: r.html, cells: [...r.cells] })) : [];
  const indexBySource = new Map<string, number>();
  rows.forEach((r, i) => {
    const s = (r.cells[S] ?? '').trim();
    if (s) indexBySource.set(s, i);
  });

  const changes: RedirectChange[] = [];
  const changed = new Set<number>();
  for (const rule of rules) {
    const src = rule.source.trim();
    const dest = rule.destination.trim();
    if (!src) continue;
    const idx = indexBySource.get(src);
    const from = idx !== undefined ? (rows[idx].cells[D] ?? '').trim() : null;
    if (from === dest) continue; // idempotent no-op
    changes.push({ source: src, from, to: dest });
    if (idx !== undefined) {
      rows[idx].cells[D] = dest;
      changed.add(idx);
    } else {
      const cells = new Array(headers.length).fill('');
      cells[S] = src;
      cells[D] = dest;
      rows.push({ html: '', cells });
      changed.add(rows.length - 1);
      indexBySource.set(src, rows.length - 1);
    }
  }

  if (changes.length === 0) return { html: html!, changes: [] };

  // Preserve the header and every untouched row VERBATIM; re-render only the
  // rows that changed (or are new).
  const headerRow = table ? `        ${table.headerHtml.trim()}` : buildRow(headers);
  const rowHtml = rows.map((r, i) => (changed.has(i) ? buildRow(r.cells) : `        ${r.html.trim()}`));
  return { html: buildDoc([headerRow, ...rowHtml]), changes };
}
