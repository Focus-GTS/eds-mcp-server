/**
 * Audit history (ADR-016) — read/append the site-health history sheet.
 *
 * History lives in the site's own DA as a JSON sheet (same shape as the redirects
 * sheet, ADR-013): `{ ":type":"sheet", ":sheetname":"data", total, limit, offset,
 * data:[{ date, overall, seo, …, critical, warning, info, total, pages }] }`, one
 * row per snapshot. Compact numbers only — the findings themselves churn and would
 * bloat the sheet; the derived numbers are what trends.
 *
 * The sheet is user-editable content, so read defensively: coerce types, tolerate
 * missing/extra columns, never crash on a hand-edited row — but refuse to
 * overwrite something that isn't a recognizable single sheet.
 */

import type { AuditDimension } from './types.js';

/** Dimension columns, in display order. */
export const DIMENSION_COLUMNS: AuditDimension[] = [
  'seo',
  'accessibility',
  'performance',
  'freshness',
  'links',
  'sitemap',
];

const COUNT_COLUMNS = ['critical', 'warning', 'info', 'total', 'pages'] as const;
const SCHEMA_COLUMNS = new Set<string>(['date', 'overall', ...DIMENSION_COLUMNS, ...COUNT_COLUMNS]);

/** One recorded point in the history. */
export interface Snapshot {
  /** ISO calendar date, YYYY-MM-DD. */
  date: string;
  overall: number;
  /** Only the dimensions that ran this snapshot. */
  dimensions: Partial<Record<AuditDimension, number>>;
  counts: { critical: number; warning: number; info: number; total: number; pages: number };
}

interface SheetJson {
  data?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

function emptySheet(): SheetJson {
  return { ':type': 'sheet', ':sheetname': 'data', total: 0, limit: 0, offset: 0, data: [] };
}

/** Parse + validate an existing history sheet, refusing anything unrecognizable. */
function readSheet(content: string, path: string): SheetJson {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    throw new Error(`${path} is not valid JSON — it does not look like a history sheet.`);
  }
  if (!json || typeof json !== 'object') {
    throw new Error(`${path} is not a sheet.`);
  }
  const sheet = json as SheetJson;
  if (sheet[':type'] === 'multi-sheet') {
    throw new Error(`${path} is a multi-sheet workbook — not supported.`);
  }
  if (!Array.isArray(sheet.data)) {
    throw new Error(`${path} has no data rows.`);
  }
  return sheet;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** A finite score clamped to the valid 0–100 range. */
const clampScore = (v: unknown): number => Math.max(0, Math.min(100, num(v)));

/** True for a usable sheet row: an object with a date and a finite overall. */
function isValidRow(r: unknown): r is Record<string, unknown> {
  return (
    !!r &&
    typeof r === 'object' &&
    String((r as Record<string, unknown>).date ?? '').trim() !== '' &&
    Number.isFinite(Number((r as Record<string, unknown>).overall))
  );
}

/** Read the history sheet's rows into typed, date-sorted snapshots. */
export function parseHistory(content: string | null, path = '/audit-history.json'): Snapshot[] {
  if (!content || !content.trim()) return [];
  const sheet = readSheet(content, path);
  // Ignore malformed / hand-edited rows (non-objects, missing date, or a missing
  // overall) rather than crashing or plotting a phantom 0.
  return (sheet.data as unknown[])
    .filter(isValidRow)
    .map((r) => {
      const dimensions: Partial<Record<AuditDimension, number>> = {};
      for (const d of DIMENSION_COLUMNS) {
        const v = r[d];
        if (v !== undefined && v !== null && v !== '') dimensions[d] = clampScore(v);
      }
      return {
        date: String(r.date).trim(),
        overall: clampScore(r.overall),
        dimensions,
        counts: {
          critical: num(r.critical),
          warning: num(r.warning),
          info: num(r.info),
          total: num(r.total),
          pages: num(r.pages),
        },
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Build a sheet row from a snapshot, carrying over any non-schema columns. */
function buildRow(snap: Snapshot, existing: Record<string, unknown> = {}): Record<string, unknown> {
  const row: Record<string, unknown> = { date: snap.date, overall: snap.overall };
  for (const d of DIMENSION_COLUMNS) {
    if (snap.dimensions[d] !== undefined) row[d] = snap.dimensions[d];
  }
  row.critical = snap.counts.critical;
  row.warning = snap.counts.warning;
  row.info = snap.counts.info;
  row.total = snap.counts.total;
  row.pages = snap.counts.pages;
  // Preserve any columns a user (or a future version) added that aren't ours.
  for (const [k, v] of Object.entries(existing)) {
    if (!SCHEMA_COLUMNS.has(k)) row[k] = v;
  }
  return row;
}

/** True when the schema fields of a built row equal an existing row (idempotency). */
function sameSchemaValues(row: Record<string, unknown>, existing: Record<string, unknown>): boolean {
  for (const k of SCHEMA_COLUMNS) {
    const a = row[k];
    const b = existing[k];
    if (a === undefined && (b === undefined || b === null || b === '')) continue;
    if (num(a) !== num(b)) {
      // date is a string, compare directly
      if (k === 'date' ? String(a ?? '') !== String(b ?? '') : true) return false;
    }
  }
  return true;
}

export interface ApplyHistoryResult {
  content: string;
  changed: boolean;
  /** The snapshot immediately before this one's date (for the delta message). */
  previous: Snapshot | null;
}

/**
 * Append (or, for a same-date re-run, update) `snap` in the history sheet.
 * `content` is the existing DA source, or null to start a fresh sheet. Rows are
 * kept sorted by date. Idempotent: a same-date row with identical numbers returns
 * `changed:false` and the original content unchanged.
 */
export function applyHistory(
  content: string | null,
  snap: Snapshot,
  path = '/audit-history.json',
): ApplyHistoryResult {
  const trimmed = (content ?? '').trim();
  const sheet = trimmed ? readSheet(content!, path) : emptySheet();
  // Drop any malformed (non-object) array entries so a hand-edited `null` row
  // can't crash the sort/find below — cleans the sheet on write.
  const data = (sheet.data as unknown[]).filter(
    (r): r is Record<string, unknown> => !!r && typeof r === 'object',
  );
  sheet.data = data;

  // The snapshot strictly before this date (in the pre-update series).
  const priorSeries = parseHistory(trimmed ? content! : null, path).filter((s) => s.date < snap.date);
  const previous = priorSeries.length ? priorSeries[priorSeries.length - 1] : null;

  const idx = data.findIndex((r) => String(r.date ?? '').trim() === snap.date);
  const row = buildRow(snap, idx >= 0 ? data[idx] : {});

  if (idx >= 0 && sameSchemaValues(row, data[idx])) {
    return { content: content!, changed: false, previous };
  }
  if (idx >= 0) data[idx] = row;
  else data.push(row);

  data.sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')));
  sheet.total = data.length;
  sheet.limit = data.length;
  sheet.offset = 0;
  if (!sheet[':type']) sheet[':type'] = 'sheet';
  if (!sheet[':sheetname']) sheet[':sheetname'] = 'data';
  return { content: JSON.stringify(sheet, null, 2), changed: true, previous };
}

/** A change between two snapshots. */
export interface Delta {
  overall: number;
  dimensions: Partial<Record<AuditDimension, number>>;
}

/** Per-field delta from `from` to `to` (to − from). */
export function delta(from: Snapshot, to: Snapshot): Delta {
  const dimensions: Partial<Record<AuditDimension, number>> = {};
  for (const d of DIMENSION_COLUMNS) {
    if (to.dimensions[d] !== undefined && from.dimensions[d] !== undefined) {
      dimensions[d] = (to.dimensions[d] as number) - (from.dimensions[d] as number);
    }
  }
  return { overall: to.overall - from.overall, dimensions };
}
