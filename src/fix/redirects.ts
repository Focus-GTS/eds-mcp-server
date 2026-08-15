/**
 * Redirect fix (ADR-013) — add or update redirect rules by editing the site's
 * `redirects` sheet, so the EDS pipeline serves them at `/redirects.json` (301s).
 *
 * Grounded and LIVE-VERIFIED against real EDS: an EDS/DA sheet is a JSON document
 * (not an HTML table — a table in a page becomes a *block*). The DA source of a
 * single sheet is `{ ":type":"sheet", ":sheetname":"data", total, limit, offset,
 * data:[{Source, Destination}, …] }` at `/redirects.json` (the shape da.live's
 * own sheet editor writes; confirmed by a working 301 on the sandbox).
 *
 * Because redirects take PRECEDENCE over content (a bad rule hides a live page),
 * the writer is defensive: it refuses to overwrite an unrecognizable or
 * multi-sheet doc, refuses a self-redirect or a root `/` redirect, preserves any
 * extra keys/columns, and is idempotent.
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

/** Result of applying redirect rules to the sheet's DA source (JSON). */
export interface ApplyRedirectsResult {
  content: string;
  changes: RedirectChange[];
}

interface SheetJson {
  data?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

function emptySheet(): SheetJson {
  return { ':type': 'sheet', ':sheetname': 'data', total: 0, limit: 0, offset: 0, data: [] };
}

/** Parse + validate an existing redirects sheet, refusing anything we shouldn't edit. */
function readSheet(content: string): SheetJson {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    throw new Error('The existing /redirects.json is not valid JSON — refusing to overwrite it.');
  }
  if (!json || typeof json !== 'object') {
    throw new Error('The existing /redirects.json is not a sheet — refusing to overwrite it.');
  }
  const sheet = json as SheetJson;
  if (sheet[':type'] === 'multi-sheet') {
    throw new Error('The existing /redirects.json is a multi-sheet workbook — editing it is not supported yet.');
  }
  if (!Array.isArray(sheet.data)) {
    throw new Error('The existing /redirects.json has no data rows — refusing to overwrite it.');
  }
  return sheet;
}

/** Read the existing redirect rules from the sheet's DA source. */
export function parseRedirects(content: string): RedirectRule[] {
  const sheet = readSheet(content);
  return (sheet.data as Array<Record<string, unknown>>)
    .filter((r) => String(r.Source ?? '').trim())
    .map((r) => ({ source: String(r.Source ?? '').trim(), destination: String(r.Destination ?? '').trim() }));
}

/**
 * Apply redirect `rules` to the sheet's DA source (`content`, or null to start a
 * new sheet). Updates the Destination of a matching Source or appends a new row,
 * preserving every other row/column and any extra sheet keys. Returns the new
 * JSON content and the rules that actually changed (empty ⇒ all already present,
 * `content` returned unchanged).
 *
 * Throws on: an unrecognizable/multi-sheet existing doc; a self-redirect; or
 * redirecting the site root.
 */
export function applyRedirects(content: string | null, rules: RedirectRule[]): ApplyRedirectsResult {
  // Refuse obviously dangerous rules first — redirects take precedence over content.
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

  const trimmed = (content ?? '').trim();
  const sheet = trimmed ? readSheet(content!) : emptySheet();
  const data = sheet.data as Array<Record<string, unknown>>;

  const indexBySource = new Map<string, number>();
  data.forEach((row, i) => {
    const s = String(row.Source ?? '').trim();
    if (s) indexBySource.set(s, i);
  });

  const changes: RedirectChange[] = [];
  for (const rule of rules) {
    const src = rule.source.trim();
    const dest = rule.destination.trim();
    if (!src) continue;
    const idx = indexBySource.get(src);
    const from = idx !== undefined ? String(data[idx].Destination ?? '').trim() : null;
    if (from === dest) continue; // idempotent no-op
    changes.push({ source: src, from, to: dest });
    if (idx !== undefined) {
      data[idx].Destination = dest; // preserves any other columns on the row
    } else {
      data.push({ Source: src, Destination: dest });
      indexBySource.set(src, data.length - 1);
    }
  }

  if (changes.length === 0) return { content: content!, changes: [] };

  sheet.total = data.length;
  sheet.limit = data.length;
  sheet.offset = 0;
  if (!sheet[':type']) sheet[':type'] = 'sheet';
  if (!sheet[':sheetname']) sheet[':sheetname'] = 'data';
  return { content: JSON.stringify(sheet, null, 2), changes };
}
