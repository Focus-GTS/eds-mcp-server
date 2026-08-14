/**
 * Metadata fix (ADR-011) — add or correct a page's `<head>` metadata by editing
 * its DA source, so the EDS pipeline emits the right `<meta>` tags.
 *
 * EDS reads per-page metadata from a **Metadata block** in the authored document.
 * Grounded against Adobe's own pipeline (`helix-html-pipeline`
 * `src/steps/extract-metadata.js`): it does `select('div.metadata', document)`,
 * reads each row as `[name, value] = row.children`, and for the image field pulls
 * the `src` from an `<img>` inside the value cell. So the DA source shape is:
 *
 *   <div class="metadata">
 *     <div><div>Title</div><div>value</div></div>
 *     <div><div>Description</div><div>value</div></div>
 *     <div><div>Image</div><div><img src="…"></div></div>
 *   </div>
 *
 * The writer edits that block with a depth-aware scanner (no DOM dependency),
 * and is careful never to corrupt the document:
 *  - it **preserves untouched rows verbatim** (so an existing Image/`<img>` row or
 *    an authored link in a value is never flattened away when another field is
 *    changed);
 *  - it matches the metadata block even when it carries variant classes
 *    (`class="metadata foo"`), any attribute order, or single quotes — so it never
 *    appends a duplicate block that the pipeline would ignore;
 *  - metadata keys round-trip reversibly (`Image Alt` ⇄ `image-alt`), so repeated
 *    fixes are idempotent and never accumulate duplicate rows.
 */

/** Metadata fields a fix can set. Keys are matched case-insensitively. */
export interface MetadataFields {
  title?: string;
  description?: string;
  image?: string;
  'image-alt'?: string;
  [key: string]: string | undefined;
}

/** One field the fix changed. */
export interface MetadataChange {
  field: string;
  from: string | null;
  to: string;
}

/** Result of applying metadata to a page's DA source. */
export interface ApplyMetadataResult {
  html: string;
  changes: MetadataChange[];
}

const LABELS: Record<string, string> = {
  title: 'Title',
  description: 'Description',
  image: 'Image',
  'image-alt': 'Image Alt',
  url: 'URL',
};

/** Canonical key ⇄ display label. Reversible: `Image Alt` ⇄ `image-alt`. */
function normalizeKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '-');
}
function labelFor(key: string): string {
  return LABELS[key] ?? key.replace(/(^|-)([a-z])/g, (_, s, c) => (s === '-' ? ' ' : '') + c.toUpperCase());
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Decode entities in a single left-to-right pass (so `&amp;lt;` → `&lt;`, not `<`). */
function decodeEntities(s: string): string {
  const map: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#x27': "'", '#39': "'" };
  return s.replace(/&(amp|lt|gt|quot|#x27|#39);/g, (_, e) => map[e]);
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, '')).trim();
}

/**
 * The comparable value of a metadata value cell: an image's `src` when the cell
 * holds an `<img>` (matching the pipeline), otherwise its plain text.
 */
function cellValue(inner: string): string {
  const img = /<img\b[^>]*\bsrc\s*=\s*("([^"]*)"|'([^']*)')/i.exec(inner);
  if (img) return img[2] ?? img[3] ?? '';
  return stripTags(inner);
}

/** From `innerStart`, find the matching `</div>` (depth-aware, ignores `<div/>`). */
function scanDivClose(html: string, innerStart: number): { innerEnd: number; end: number } | null {
  const tag = /<div\b[^>]*>|<\/div\s*>/gi;
  tag.lastIndex = innerStart;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(html)) !== null) {
    if (m[0][1] === '/') {
      depth--;
      if (depth === 0) return { innerEnd: m.index, end: tag.lastIndex };
    } else if (!m[0].endsWith('/>')) {
      depth++;
    }
  }
  return null;
}

/**
 * Find a `<div>` whose `class` attribute contains `className` as a
 * whitespace-delimited token — in any attribute position, either quote style,
 * and tolerating variant classes (`class="metadata foo"`). Depth-aware.
 */
export function findDivBlock(
  html: string,
  className: string,
): { start: number; end: number; inner: string } | null {
  const divRe = /<div\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = divRe.exec(html)) !== null) {
    if (m[0].endsWith('/>')) continue;
    const classAttr = /\bclass\s*=\s*("([^"]*)"|'([^']*)')/i.exec(m[1]);
    if (!classAttr) continue;
    const classes = (classAttr[2] ?? classAttr[3] ?? '').split(/\s+/);
    if (!classes.includes(className)) continue;
    const innerStart = m.index + m[0].length;
    const close = scanDivClose(html, innerStart);
    if (!close) return null;
    return { start: m.index, end: close.end, inner: html.slice(innerStart, close.innerEnd) };
  }
  return null;
}

/** Each top-level `<div>` block's outer + inner HTML (depth-aware). */
function topLevelDivBlocks(html: string): Array<{ outer: string; inner: string }> {
  const out: Array<{ outer: string; inner: string }> = [];
  let i = 0;
  while (i < html.length) {
    const open = /<div\b[^>]*>/i.exec(html.slice(i));
    if (!open) break;
    const openAbs = i + open.index;
    if (open[0].endsWith('/>')) { i = openAbs + open[0].length; continue; }
    const innerStart = openAbs + open[0].length;
    const close = scanDivClose(html, innerStart);
    if (!close) break;
    out.push({ outer: html.slice(openAbs, close.end), inner: html.slice(innerStart, close.innerEnd) });
    i = close.end;
  }
  return out;
}

interface Row {
  key: string;
  value: string;
  outer: string;
}

function parseRows(blockInner: string): Row[] {
  const rows: Row[] = [];
  for (const row of topLevelDivBlocks(blockInner)) {
    const cells = topLevelDivBlocks(row.inner);
    if (cells.length >= 2) {
      rows.push({ key: normalizeKey(stripTags(cells[0].inner)), value: cellValue(cells[1].inner), outer: row.outer });
    } else {
      rows.push({ key: '', value: '', outer: row.outer }); // malformed — preserve verbatim
    }
  }
  return rows;
}

/** Parse a metadata block's rows into a key → value map (test/inspection helper). */
export function parseMetadataRows(inner: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of parseRows(inner)) if (r.key) map.set(r.key, r.value);
  return map;
}

function valueCell(key: string, value: string): string {
  // The pipeline resolves the image field from an <img> in the cell.
  if (key === 'image') return `<img src="${escapeHtml(value)}">`;
  return `<p>${escapeHtml(value)}</p>`;
}

function buildRow(key: string, value: string, indent = '      '): string {
  return (
    `${indent}<div>\n` +
    `${indent}  <div><p>${escapeHtml(labelFor(key))}</p></div>\n` +
    `${indent}  <div>${valueCell(key, value)}</div>\n` +
    `${indent}</div>`
  );
}

function assembleBlock(rowHtml: string[]): string {
  return `<div class="metadata">\n${rowHtml.join('\n')}\n    </div>`;
}

/** Build a fresh `<div class="metadata">` block from a key → value map. */
export function buildMetadataBlock(fields: Map<string, string>): string {
  const rows = [...fields.entries()].filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => buildRow(k, v));
  return assembleBlock(rows);
}

/**
 * Apply metadata `fields` to a page's DA source HTML.
 *
 * Merges into an existing metadata block — rebuilding only the rows that change,
 * preserving every other row **verbatim** (including `<img>` and authored markup)
 * — or inserts a new block before `</main>` (or `</body>`). Returns the new HTML
 * and the fields that actually changed; an empty change list means the page was
 * already correct and `html` is returned unchanged.
 */
export function applyMetadata(html: string, fields: MetadataFields): ApplyMetadataResult {
  const block = findDivBlock(html, 'metadata');
  const rows = block ? parseRows(block.inner) : [];
  const byKey = new Map(rows.filter((r) => r.key).map((r) => [r.key, r] as const));

  const changes: MetadataChange[] = [];
  const newValueByKey = new Map<string, string>();
  for (const [rawKey, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const key = normalizeKey(rawKey);
    const from = byKey.get(key)?.value ?? null;
    if (from !== value) {
      changes.push({ field: key, from, to: value });
      newValueByKey.set(key, value);
    }
  }
  if (changes.length === 0) return { html, changes: [] };

  // Assemble: rebuild only changed rows; keep every other row byte-for-byte.
  const assembled: string[] = [];
  const used = new Set<string>();
  for (const r of rows) {
    if (r.key && newValueByKey.has(r.key)) {
      assembled.push(buildRow(r.key, newValueByKey.get(r.key)!));
    } else {
      assembled.push(r.outer.trim());
    }
    if (r.key) used.add(r.key);
  }
  for (const [key, value] of newValueByKey) {
    if (!used.has(key)) assembled.push(buildRow(key, value));
  }
  const newBlock = assembleBlock(assembled);

  if (block) {
    return { html: html.slice(0, block.start) + newBlock + html.slice(block.end), changes };
  }
  const mainClose = html.search(/<\/main>/i);
  if (mainClose >= 0) return { html: `${html.slice(0, mainClose)}${newBlock}\n${html.slice(mainClose)}`, changes };
  const bodyClose = html.search(/<\/body>/i);
  if (bodyClose >= 0) return { html: `${html.slice(0, bodyClose)}${newBlock}\n${html.slice(bodyClose)}`, changes };
  return { html: `${html}\n${newBlock}`, changes };
}
