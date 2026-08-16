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

/**
 * Stable identifier for a *kind* of issue (ADR-015). Lets tooling route a
 * finding to its fix without re-deriving from the human title. Kebab-case,
 * `dimension-issue`. These are a quasi-public contract — agents key off them —
 * so name them once and keep them stable.
 */
export type AuditCode =
  | 'seo-missing-title'
  | 'seo-title-length'
  | 'seo-missing-description'
  | 'seo-description-length'
  | 'seo-missing-h1'
  | 'seo-multiple-h1'
  | 'seo-noindex'
  | 'seo-missing-canonical'
  | 'seo-missing-jsonld'
  | 'seo-missing-og'
  | 'seo-incomplete-og'
  | 'a11y-missing-alt'
  | 'a11y-no-headings'
  | 'a11y-heading-skip'
  | 'a11y-vague-link-text'
  | 'a11y-missing-landmarks'
  | 'a11y-unlabeled-inputs'
  | 'freshness-stale'
  | 'sitemap-empty'
  | 'sitemap-missing-pages'
  | 'perf-slow-lcp'
  | 'perf-high-cls'
  | 'perf-slow-inp'
  | 'links-broken-404'
  | 'page-unfetchable';

/** What a fix writes. */
export type FixField = 'title' | 'description' | 'ogImage' | 'redirect';

/**
 * How to repair a finding (ADR-015). Present only on findings our shipped safe
 * writers can actually fix; `eds_fix_audit` routes on it. The target page is the
 * finding's own `page`. Every current fixable field needs an agent-supplied
 * value — the tool never fabricates copy.
 */
export interface FindingFix {
  /** The tool that repairs this finding. */
  tool: 'eds_fix_metadata' | 'eds_fix_redirect';
  /** Which value it writes. */
  field: FixField;
}

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
  /** Stable machine identifier for the kind of issue (ADR-015). */
  code: AuditCode;
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
  /** How to repair it, when a shipped safe writer can (ADR-015). */
  fix?: FindingFix;
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
  /**
   * The dimensions this audit ATTEMPTED (the requested set — all by default, or
   * the `dimensions` filter). Scoring covers only these minus `skipped`; a
   * dimension not attempted is neither scored nor shown, never a fake 100.
   */
  dimensions: AuditDimension[];
  /** True when the sweep hit the page cap and some pages were not audited. */
  truncated: boolean;
}
