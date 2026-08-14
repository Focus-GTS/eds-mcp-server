/**
 * Types for the content-audit layer (ADR-010).
 *
 * The audit produces a flat, prioritized list of {@link AuditFinding}s — the
 * agent-native "tell me what's wrong" surface. Unlike the eds-score web tool,
 * there is no numeric grade: an agent wants actionable issues, not a letter.
 */

/** The quality dimension a finding belongs to. */
export type AuditDimension =
  | 'seo'
  | 'accessibility'
  | 'performance'
  | 'freshness'
  | 'links'
  | 'sitemap';

/** Severity of a finding, most to least urgent. */
export type AuditSeverity = 'critical' | 'warning' | 'info';

/** Every dimension the audit can cover. */
export const ALL_DIMENSIONS: AuditDimension[] = [
  'seo',
  'accessibility',
  'performance',
  'freshness',
  'links',
  'sitemap',
];

/** One thing worth fixing, found by a check. */
export interface AuditFinding {
  /** Which quality dimension this belongs to. */
  dimension: AuditDimension;
  /** How urgent it is. */
  severity: AuditSeverity;
  /** Site-relative page path, when the finding is page-specific. */
  page?: string;
  /** Short label for the issue. */
  title: string;
  /** What was actually found. */
  detail: string;
  /** What to do about it. */
  suggestion?: string;
}

/** The result of an audit — a prioritized findings list plus roll-up counts. */
export interface AuditReport {
  /** Whether this was a single page or a whole-site sweep. */
  scope: 'page' | 'site';
  /** What was audited (a path, or the site root/prefix). */
  target: string;
  /** Findings, sorted critical-first. */
  findings: AuditFinding[];
  /** Roll-up counts. */
  summary: {
    critical: number;
    warning: number;
    info: number;
    total: number;
    /** Number of pages inspected (site scope only). */
    pagesAudited?: number;
  };
  /** Dimensions that could not run (e.g. RUM without a domain key), never silent. */
  skipped: string[];
  /** True when the sweep hit the page cap and some pages were not audited. */
  truncated: boolean;
}
