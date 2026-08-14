/**
 * Metadata fix (ADR-011) — add or correct a page's `<head>` metadata by editing
 * its DA source, so the EDS pipeline emits the right `<meta>` tags.
 *
 * EDS reads per-page metadata from a **Metadata block** in the authored document.
 * Grounded against Adobe's own pipeline (`helix-html-pipeline`
 * `src/steps/extract-metadata.js`): it does `select('div.metadata', document)`
 * and reads each row as `[name, value] = row.children`. So the DA source shape is:
 *
 *   <div class="metadata">
 *     <div><div>Title</div><div>value</div></div>
 *     <div><div>Description</div><div>value</div></div>
 *   </div>
 *
 * This module edits that block with a depth-aware scanner (no DOM dependency,
 * matching the rest of the codebase), idempotently: it merges new fields into any
 * existing block rather than appending a second one, and preserves rows it isn't
 * changing.
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
  /** The new DA source (unchanged when there is nothing to do). */
  html: string;
  /** Fields that actually changed (empty ⇒ no-op, already correct). */
  changes: MetadataChange[];
}

/** Human-facing label for a known metadata key (falls back to Title-case). */
const LABELS: Record<string, string> = {
  title: 'Title',
  description: 'Description',
  image: 'Image',
  'image-alt': 'Image Alt',
  url: 'URL',
};

function labelFor(key: string): string {
  return LABELS[key] ?? key.replace(/(^|\s|-)([a-z])/g, (_, s, c) => s + c.toUpperCase());
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").trim();
}

/**
 * Find a `<div class="NAME">…</div>` block with a depth-aware scan (so nested
 * `<div>`s inside the block don't terminate it early). Returns the block's outer
 * bounds and inner HTML, or null if absent.
 */
export function findDivBlock(
  html: string,
  className: string,
): { start: number; end: number; inner: string } | null {
  const open = new RegExp(`<div\\s+class="${className}"[^>]*>`, 'i').exec(html);
  if (!open) return null;
  const start = open.index;
  const innerStart = start + open[0].length;
  const tag = /<\/?div\b[^>]*>/gi;
  tag.lastIndex = innerStart;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(html)) !== null) {
    if (m[0].startsWith('</')) {
      depth--;
      if (depth === 0) return { start, end: tag.lastIndex, inner: html.slice(innerStart, m.index) };
    } else {
      depth++;
    }
  }
  return null; // unbalanced — treat as absent
}

/** Return the inner HTML of each top-level `<div>` in `html` (depth-aware). */
function topLevelDivs(html: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < html.length) {
    const open = /<div\b[^>]*>/i.exec(html.slice(i));
    if (!open) break;
    const openAbs = i + open.index;
    const innerStart = openAbs + open[0].length;
    const tag = /<\/?div\b[^>]*>/gi;
    tag.lastIndex = innerStart;
    let depth = 1;
    let end = -1;
    let m: RegExpExecArray | null;
    while ((m = tag.exec(html)) !== null) {
      if (m[0].startsWith('</')) {
        depth--;
        if (depth === 0) {
          out.push(html.slice(innerStart, m.index));
          end = tag.lastIndex;
          break;
        }
      } else {
        depth++;
      }
    }
    if (end === -1) break; // unbalanced
    i = end;
  }
  return out;
}

/** Parse a metadata block's rows into a lowercased key → text-value map. */
export function parseMetadataRows(inner: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of topLevelDivs(inner)) {
    const cells = topLevelDivs(row);
    if (cells.length >= 2) {
      const key = stripTags(cells[0]).toLowerCase();
      const value = stripTags(cells[1]);
      if (key) map.set(key, value);
    }
  }
  return map;
}

/** Build a `<div class="metadata">` block from a key → value map (DA shape). */
export function buildMetadataBlock(fields: Map<string, string>, indent = '      '): string {
  const rows = [...fields.entries()]
    .filter(([, v]) => v !== undefined && v !== '')
    .map(
      ([k, v]) =>
        `${indent}<div>\n${indent}  <div><p>${escapeHtml(labelFor(k))}</p></div>\n${indent}  <div><p>${escapeHtml(v)}</p></div>\n${indent}</div>`,
    )
    .join('\n');
  return `<div class="metadata">\n${rows}\n${indent.slice(0, -2)}</div>`;
}

/**
 * Apply metadata `fields` to a page's DA source HTML.
 *
 * Merges into an existing metadata block (idempotent — no duplicate blocks, and
 * rows not being changed are preserved), or inserts a new block before `</main>`.
 * Returns the new HTML and the list of fields that actually changed; an empty
 * change list means the page was already correct and `html` is returned as-is.
 */
export function applyMetadata(html: string, fields: MetadataFields): ApplyMetadataResult {
  const block = findDivBlock(html, 'metadata');
  const existing = block ? parseMetadataRows(block.inner) : new Map<string, string>();

  const changes: MetadataChange[] = [];
  const merged = new Map(existing);
  for (const [rawKey, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const key = rawKey.toLowerCase();
    const from = existing.get(key) ?? null;
    if (from !== value) changes.push({ field: key, from, to: value });
    merged.set(key, value);
  }

  if (changes.length === 0) return { html, changes: [] };

  const newBlock = buildMetadataBlock(merged);
  if (block) {
    return { html: html.slice(0, block.start) + newBlock + html.slice(block.end), changes };
  }
  const mainClose = html.search(/<\/main>/i);
  if (mainClose >= 0) {
    return { html: `${html.slice(0, mainClose)}${newBlock}\n${html.slice(mainClose)}`, changes };
  }
  return { html: `${html}\n${newBlock}`, changes };
}
