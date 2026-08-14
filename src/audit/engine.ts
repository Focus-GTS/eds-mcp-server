/**
 * Content-audit engine (ADR-010).
 *
 * `auditPage` runs the per-page SEO + accessibility checks over a single page's
 * HTML. `auditSite` sweeps the site: per-page checks across the page index
 * (bounded concurrency) plus site-level checks (freshness, sitemap coverage,
 * and — when a domain is supplied — RUM performance and 404s).
 *
 * All data comes from the EdsClient (server-side, owner/repo/ref addressed);
 * there is no Google PageSpeed dependency — performance uses Adobe's own RUM.
 */

import type { EdsClient } from '../eds-admin/client.js';
import type {
  EdsQueryIndexEntry,
  EdsSitemapEntry,
  EdsCwvData,
  Eds404Entry,
} from '../eds-admin/types.js';
import {
  ALL_DIMENSIONS,
  type AuditDimension,
  type AuditFinding,
  type AuditReport,
} from './types.js';
import { seoFindings } from './checks/seo.js';
import { accessibilityFindings } from './checks/accessibility.js';

const SEVERITY_ORDER: Record<AuditFinding['severity'], number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

/** Sort findings critical-first, stable within a severity. */
function sortFindings(findings: AuditFinding[]): AuditFinding[] {
  return [...findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

/** Run every per-page check over one page's HTML. */
export function auditPage(html: string, path?: string): AuditFinding[] {
  const findings = [...seoFindings(html), ...accessibilityFindings(html)];
  if (path) for (const f of findings) f.page = path;
  return sortFindings(findings);
}

/** Run `fn` over `items` with at most `concurrency` in flight at once. */
async function mapWithConcurrency<T>(
  items: T[],
  fn: (item: T) => Promise<void>,
  concurrency: number,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]);
    }
  };
  const size = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: size }, () => worker()));
}

// ---------------------------------------------------------------------------
// Site-level checks
// ---------------------------------------------------------------------------

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

function preview(paths: string[], n = 10): string {
  const shown = paths.slice(0, n).join(', ');
  return paths.length > n ? `${shown}, …` : shown;
}

/** Pages not updated in over a year (query-index `lastModified`, unix seconds). */
function freshnessFindings(entries: EdsQueryIndexEntry[], now: number): AuditFinding[] {
  const stale = entries.filter(
    (e) => typeof e.lastModified === 'number' && now - e.lastModified * 1000 > YEAR_MS,
  );
  if (stale.length === 0) return [];
  return [
    {
      dimension: 'freshness',
      severity: 'warning',
      title: `${stale.length} page(s) not updated in over a year`,
      detail: `Stale pages: ${preview(stale.map((e) => e.path))}`,
      suggestion: 'Review and refresh outdated content, or confirm it is still accurate.',
    },
  ];
}

/** Sitemap presence + coverage of the page index. */
function sitemapFindings(
  sitemap: EdsSitemapEntry[],
  entries: EdsQueryIndexEntry[],
): AuditFinding[] {
  if (sitemap.length === 0) {
    return [
      {
        dimension: 'sitemap',
        severity: 'warning',
        title: 'No sitemap entries',
        detail: 'sitemap.xml returned no URLs.',
        suggestion: 'Publish a sitemap.xml so search engines can discover every page.',
      },
    ];
  }
  const sitemapPaths = new Set(
    sitemap.map((s) => {
      try {
        return new URL(s.loc).pathname;
      } catch {
        return s.loc;
      }
    }),
  );
  const missing = entries.map((e) => e.path).filter((p) => !sitemapPaths.has(p));
  if (missing.length === 0) return [];
  return [
    {
      dimension: 'sitemap',
      severity: 'info',
      title: `${missing.length} indexed page(s) missing from the sitemap`,
      detail: `Not in sitemap: ${preview(missing)}`,
      suggestion: 'Ensure the sitemap includes every published page.',
    },
  ];
}

/** Core Web Vitals from RUM — flag pages exceeding the "good" thresholds. */
function performanceFindings(cwv: EdsCwvData[]): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const worst = (rows: EdsCwvData[], fmt: (c: EdsCwvData) => string, by: (c: EdsCwvData) => number) =>
    [...rows].sort((a, b) => by(b) - by(a)).slice(0, 5).map(fmt).join(', ');

  const slowLcp = cwv.filter((c) => c.lcp > 2500);
  if (slowLcp.length > 0) {
    findings.push({
      dimension: 'performance',
      severity: 'warning',
      title: `${slowLcp.length} page(s) with slow LCP (>2.5s)`,
      detail: `Worst: ${worst(slowLcp, (c) => `${c.url} ${Math.round(c.lcp)}ms`, (c) => c.lcp)}`,
      suggestion: 'Optimize the largest content element — images, fonts, render-blocking resources.',
    });
  }
  const shiftyCls = cwv.filter((c) => c.cls > 0.1);
  if (shiftyCls.length > 0) {
    findings.push({
      dimension: 'performance',
      severity: 'warning',
      title: `${shiftyCls.length} page(s) with layout shift (CLS >0.1)`,
      detail: `Worst: ${worst(shiftyCls, (c) => `${c.url} ${c.cls.toFixed(2)}`, (c) => c.cls)}`,
      suggestion: 'Set explicit width/height on media and reserve space for late-loading content.',
    });
  }
  const laggyInp = cwv.filter((c) => c.inp > 200);
  if (laggyInp.length > 0) {
    findings.push({
      dimension: 'performance',
      severity: 'warning',
      title: `${laggyInp.length} page(s) with slow interaction (INP >200ms)`,
      detail: `Worst: ${worst(laggyInp, (c) => `${c.url} ${Math.round(c.inp)}ms`, (c) => c.inp)}`,
      suggestion: 'Reduce long tasks and third-party JavaScript on the main thread.',
    });
  }
  return findings;
}

/** 404s from RUM — the top broken URLs by traffic. */
function link404Findings(entries: Eds404Entry[]): AuditFinding[] {
  if (entries.length === 0) return [];
  const top = [...entries].sort((a, b) => b.views - a.views).slice(0, 10);
  return [
    {
      dimension: 'links',
      severity: 'warning',
      title: `${entries.length} URL(s) returning 404`,
      detail: `Top 404s: ${top.map((e) => `${e.url} (${e.views} views)`).join(', ')}`,
      suggestion: 'Add redirects for these URLs, or fix the links pointing to them.',
    },
  ];
}

// ---------------------------------------------------------------------------
// Site audit
// ---------------------------------------------------------------------------

export interface AuditSiteOptions {
  /** Only audit pages under this path prefix (e.g. "/blog/"). */
  pathPrefix?: string;
  /** Max pages to fetch HTML for (per-page checks). Default 50. */
  maxPages?: number;
  /** Which dimensions to run. Default: all. */
  dimensions?: AuditDimension[];
  /** Live domain for RUM (performance, links). Omit to skip RUM checks. */
  domain?: string;
  /** RUM window in days. Default 7. */
  days?: number;
}

function summarize(scope: AuditReport['scope'], target: string, findings: AuditFinding[], skipped: string[], truncated: boolean, pagesAudited?: number): AuditReport {
  const sorted = sortFindings(findings);
  return {
    scope,
    target,
    findings: sorted,
    summary: {
      critical: sorted.filter((f) => f.severity === 'critical').length,
      warning: sorted.filter((f) => f.severity === 'warning').length,
      info: sorted.filter((f) => f.severity === 'info').length,
      total: sorted.length,
      ...(pagesAudited !== undefined ? { pagesAudited } : {}),
    },
    skipped,
    truncated,
  };
}

/** Audit a whole site (or a subtree). */
export async function auditSite(
  client: EdsClient,
  options: AuditSiteOptions = {},
): Promise<AuditReport> {
  const maxPages = options.maxPages ?? 50;
  const dims = new Set(options.dimensions ?? ALL_DIMENSIONS);
  const days = options.days ?? 7;
  const findings: AuditFinding[] = [];
  const skipped: string[] = [];

  // 1. Page index (query-index). One fetch, generous cap.
  const index = await client.listPages(1000, 0);
  let entries = index.data;
  if (options.pathPrefix) {
    entries = entries.filter((e) => e.path.startsWith(options.pathPrefix!));
  }

  // 2. Per-page SEO + accessibility (bounded concurrency, capped by maxPages).
  const wantsPageChecks = dims.has('seo') || dims.has('accessibility');
  const toAudit = entries.slice(0, maxPages);
  const truncated = entries.length > maxPages && wantsPageChecks;
  if (wantsPageChecks) {
    await mapWithConcurrency(
      toAudit,
      async (entry) => {
        try {
          const { html } = await client.getPageContent(entry.path);
          if (dims.has('seo')) {
            for (const f of seoFindings(html)) findings.push({ ...f, page: entry.path });
          }
          if (dims.has('accessibility')) {
            for (const f of accessibilityFindings(html)) findings.push({ ...f, page: entry.path });
          }
        } catch (error) {
          findings.push({
            dimension: 'links',
            severity: 'info',
            page: entry.path,
            title: 'Page could not be fetched',
            detail: error instanceof Error ? error.message : String(error),
            suggestion: 'Confirm the page is published and reachable.',
          });
        }
      },
      6,
    );
  }

  const now = Date.now();

  // 3. Freshness (query-index lastModified) — no extra fetch.
  if (dims.has('freshness')) findings.push(...freshnessFindings(entries, now));

  // 4. Sitemap coverage.
  if (dims.has('sitemap')) {
    try {
      const sitemap = await client.getSitemap();
      findings.push(...sitemapFindings(sitemap, entries));
    } catch (error) {
      skipped.push(`sitemap (${error instanceof Error ? error.message : 'unavailable'})`);
    }
  }

  // 5. Performance (RUM) — needs a domain.
  if (dims.has('performance')) {
    if (options.domain) {
      try {
        findings.push(...performanceFindings(await client.getCwv(options.domain, days)));
      } catch (error) {
        skipped.push(`performance (${error instanceof Error ? error.message : 'RUM unavailable'})`);
      }
    } else {
      skipped.push('performance (pass a domain + set EDS_DOMAIN_KEY for RUM data)');
    }
  }

  // 6. 404s (RUM) — needs a domain.
  if (dims.has('links')) {
    if (options.domain) {
      try {
        findings.push(...link404Findings(await client.get404s(options.domain, days)));
      } catch (error) {
        skipped.push(`links/404s (${error instanceof Error ? error.message : 'RUM unavailable'})`);
      }
    } else {
      skipped.push('links/404s (pass a domain + set EDS_DOMAIN_KEY for RUM data)');
    }
  }

  const target = options.pathPrefix ? options.pathPrefix : '(whole site)';
  return summarize('site', target, findings, skipped, truncated, wantsPageChecks ? toAudit.length : 0);
}

/** Audit a single page from its HTML. */
export function auditSinglePage(html: string, path: string): AuditReport {
  return summarize('page', path, auditPage(html, path), [], false);
}
