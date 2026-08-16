/**
 * Per-page SEO checks (ADR-010).
 *
 * Regex-based analysis of a page's rendered HTML — no DOM, no dependencies.
 * The detection logic (patterns, length thresholds) is ported verbatim from the
 * eds-score scorer; only the output shape differs (findings, not scores). A
 * check returns `null` when the page passes.
 */

import type { AuditFinding } from '../types.js';

function matchTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m?.[1]?.trim() ?? '';
}

function checkTitle(html: string): AuditFinding | null {
  const title = matchTitle(html);
  if (!title) {
    return {
      dimension: 'seo',
      code: 'seo-missing-title',
      severity: 'critical',
      title: 'Missing title tag',
      detail: 'No <title> tag found on the page.',
      suggestion: 'Add a descriptive <title> of 30–60 characters.',
      fix: { tool: 'eds_fix_metadata', field: 'title' },
    };
  }
  const len = title.length;
  if (len >= 30 && len <= 60) return null;
  return {
    dimension: 'seo',
    code: 'seo-title-length',
    severity: 'warning',
    title: 'Title length is outside the ideal range',
    detail: `Title "${title}" is ${len} characters (ideal 30–60).`,
    suggestion: 'Aim for a 30–60 character title so it renders fully in search results.',
    fix: { tool: 'eds_fix_metadata', field: 'title' },
  };
}

function checkMetaDescription(html: string): AuditFinding | null {
  // Match the closing quote to the opening one (backreference) so a description
  // containing an apostrophe isn't truncated at the first ' — a very common
  // false positive with `content="what's new …"`.
  const m =
    html.match(/<meta\s+name=["']description["']\s+content=(["'])([\s\S]*?)\1[^>]*>/i) ??
    html.match(/<meta\s+content=(["'])([\s\S]*?)\1\s+name=["']description["'][^>]*>/i);
  const description = m?.[2]?.trim() ?? '';
  if (!description) {
    return {
      dimension: 'seo',
      code: 'seo-missing-description',
      severity: 'critical',
      title: 'Missing meta description',
      detail: 'No <meta name="description"> found on the page.',
      suggestion: 'Add a 120–160 character meta description summarizing the page.',
      fix: { tool: 'eds_fix_metadata', field: 'description' },
    };
  }
  const len = description.length;
  if (len >= 120 && len <= 160) return null;
  return {
    dimension: 'seo',
    code: 'seo-description-length',
    severity: 'warning',
    title: 'Meta description length is outside the ideal range',
    detail: `Meta description is ${len} characters (ideal 120–160).`,
    suggestion: 'Aim for 120–160 characters so it renders fully in search results.',
    fix: { tool: 'eds_fix_metadata', field: 'description' },
  };
}

function checkH1(html: string): AuditFinding | null {
  const count = (html.match(/<h1[\s>]/gi) ?? []).length;
  if (count === 1) return null;
  if (count === 0) {
    return {
      dimension: 'seo',
      code: 'seo-missing-h1',
      severity: 'critical',
      title: 'No H1 heading',
      detail: 'The page has no <h1> heading.',
      suggestion: 'Add exactly one <h1> that describes the page.',
    };
  }
  return {
    dimension: 'seo',
    code: 'seo-multiple-h1',
    severity: 'warning',
    title: 'Multiple H1 headings',
    detail: `Found ${count} <h1> headings — a page should have exactly one.`,
    suggestion: 'Keep a single <h1>; demote the rest to <h2>/<h3>.',
  };
}

function checkRobots(html: string): AuditFinding | null {
  const m =
    html.match(/<meta\s+name=["']robots["']\s+content=["']([^"']*)["'][^>]*>/i) ??
    html.match(/<meta\s+content=["']([^"']*)["']\s+name=["']robots["'][^>]*>/i);
  const content = m?.[1]?.toLowerCase() ?? '';
  // Only `noindex` (or `none`, which implies noindex) blocks indexing.
  // `nofollow` controls link-following, NOT indexing — do not report it as
  // "blocked from search indexing" (a factually wrong, embarrassing claim).
  if (content.includes('noindex') || content.includes('none')) {
    return {
      dimension: 'seo',
      code: 'seo-noindex',
      severity: 'critical',
      title: 'Page is blocked from search indexing',
      detail: `A robots meta directive is blocking indexing: "${content}".`,
      suggestion: 'Remove noindex/none if this page should appear in search results.',
    };
  }
  return null;
}

function checkCanonical(html: string): AuditFinding | null {
  if (/<link\s+[^>]*rel=["']canonical["'][^>]*>/i.test(html)) return null;
  return {
    dimension: 'seo',
    code: 'seo-missing-canonical',
    severity: 'warning',
    title: 'No canonical URL',
    detail: 'The page does not declare a canonical URL.',
    suggestion: 'Add <link rel="canonical"> to prevent duplicate-content issues.',
  };
}

function checkJsonLd(html: string): AuditFinding | null {
  if (/<script\s+type=["']application\/ld\+json["'][^>]*>/i.test(html)) return null;
  return {
    dimension: 'seo',
    code: 'seo-missing-jsonld',
    severity: 'info',
    title: 'No structured data (JSON-LD)',
    detail: 'The page has no Schema.org JSON-LD markup.',
    suggestion: 'Add JSON-LD structured data to enable rich search results.',
  };
}

function checkOgTags(html: string): AuditFinding | null {
  const hasTitle = /<meta\s+[^>]*property=["']og:title["'][^>]*>/i.test(html);
  const hasDesc = /<meta\s+[^>]*property=["']og:description["'][^>]*>/i.test(html);
  const hasImage = /<meta\s+[^>]*property=["']og:image["'][^>]*>/i.test(html);
  const found = [hasTitle, hasDesc, hasImage].filter(Boolean).length;
  if (found === 3) return null;
  const missing: string[] = [];
  if (!hasTitle) missing.push('og:title');
  if (!hasDesc) missing.push('og:description');
  if (!hasImage) missing.push('og:image');
  return {
    dimension: 'seo',
    code: found === 0 ? 'seo-missing-og' : 'seo-incomplete-og',
    // No OG tags at all is a warning; a partial set is a minor gap.
    severity: found === 0 ? 'warning' : 'info',
    title: found === 0 ? 'No Open Graph tags' : 'Incomplete Open Graph tags',
    detail: `Missing Open Graph tags: ${missing.join(', ')}.`,
    suggestion: 'Add og:title, og:description and og:image for rich social sharing.',
  };
}

/** Run every per-page SEO check and return the findings (passing checks omitted). */
export function seoFindings(html: string): AuditFinding[] {
  return [
    checkTitle(html),
    checkMetaDescription(html),
    checkH1(html),
    checkRobots(html),
    checkCanonical(html),
    checkJsonLd(html),
    checkOgTags(html),
  ].filter((f): f is AuditFinding => f !== null);
}
