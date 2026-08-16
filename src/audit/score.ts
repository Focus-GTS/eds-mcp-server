/**
 * Shared health-scoring (ADR-014 / ADR-016).
 *
 * The audit is findings-based; a health score is derived from those findings,
 * transparently and identically wherever it's shown — the report, a snapshot,
 * the trend. One source of truth so the numbers never disagree.
 */

import { ALL_DIMENSIONS, type AuditDimension, type AuditFinding, type AuditReport } from './types.js';

/** Letter grade for a 0–100 score. */
export function grade(score: number): string {
  if (score >= 95) return 'A+';
  if (score >= 85) return 'A';
  if (score >= 70) return 'B';
  if (score >= 55) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

/** Health score for a dimension, derived from its findings, normalized by pages. */
export function scoreDimension(findings: AuditFinding[], pages: number): number {
  const weighted = findings.reduce(
    (s, f) => s + (f.severity === 'critical' ? 3 : f.severity === 'warning' ? 1 : 0.25),
    0,
  );
  const perPage = weighted / Math.max(1, pages);
  return Math.max(0, Math.min(100, Math.round(100 - perPage * 10)));
}

/** good ≥85, fair ≥55, else poor — the semantic color band for a score. */
export function scoreClass(score: number): string {
  return score >= 85 ? 'good' : score >= 55 ? 'fair' : 'poor';
}

/** The scores derived from an audit: per-dimension (only those that ran) + overall. */
export interface AuditScores {
  overall: number;
  dimensions: Partial<Record<AuditDimension, number>>;
  skipped: AuditDimension[];
}

/**
 * Derive the health scores from an audit report. A dimension the audit couldn't
 * run (listed in `report.skipped`) is omitted from `dimensions` and never
 * averaged into `overall` — a skipped check is "not run", never a fake 0 or 100.
 */
export function computeScores(report: AuditReport): AuditScores {
  const pages = report.summary.pagesAudited ?? 1;
  // Only score dimensions the audit ATTEMPTED. A dimension not attempted (excluded
  // by the `dimensions` filter) must never be scored — an empty findings list would
  // otherwise read as a perfect 100 and corrupt the trend. Fall back to all
  // dimensions for older reports without the field.
  const attempted = report.dimensions ?? ALL_DIMENSIONS;
  const skipped = attempted.filter((d) => report.skipped.some((s) => s.startsWith(d)));
  const skippedSet = new Set(skipped);

  const dimensions: Partial<Record<AuditDimension, number>> = {};
  const ran: number[] = [];
  for (const dim of attempted) {
    if (skippedSet.has(dim)) continue;
    const s = scoreDimension(
      report.findings.filter((f) => f.dimension === dim),
      pages,
    );
    dimensions[dim] = s;
    ran.push(s);
  }
  const overall = ran.length ? Math.round(ran.reduce((a, b) => a + b, 0) / ran.length) : 0;
  return { overall, dimensions, skipped };
}
