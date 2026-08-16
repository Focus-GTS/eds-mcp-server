/**
 * Per-page accessibility checks (ADR-010).
 *
 * Regex-based analysis of a page's rendered HTML — no DOM, no dependencies.
 * Detection logic (patterns, ratio thresholds) is ported verbatim from the
 * eds-score scorer; only the output shape differs. A check returns `null` when
 * the page passes.
 */

import type { AuditFinding } from '../types.js';

function checkImageAltText(html: string): AuditFinding | null {
  const images = html.match(/<img\s[^>]*>/gi) ?? [];
  if (images.length === 0) return null;

  let missing = 0;
  for (const img of images) {
    // Only a TRULY absent alt attribute is a WCAG failure (screen readers then
    // announce the file name). `alt=""` is the spec-correct decorative marker —
    // valid, not a violation — and EDS emits it whenever an author leaves alt
    // blank, so treating it as "missing" would false-positive across EDS sites.
    const hasAltAttr = /\balt\s*=/i.test(img);
    if (!hasAltAttr) {
      const decorative =
        /role=["']presentation["']/i.test(img) || /aria-hidden=["']true["']/i.test(img);
      if (!decorative) missing++;
    }
  }
  if (missing === 0) return null;

  const ratio = missing / images.length;
  return {
    dimension: 'accessibility',
    // A majority of images with no alt attribute is a real barrier; a few is a warning.
    code: 'a11y-missing-alt',
    severity: ratio > 0.5 ? 'critical' : 'warning',
    title: 'Images missing an alt attribute',
    detail: `${missing} of ${images.length} images have no alt attribute at all.`,
    suggestion: 'Add alt text (or alt="" for genuinely decorative images).',
  };
}

function checkHeadingHierarchy(html: string): AuditFinding | null {
  const re = /<h([1-6])[\s>]/gi;
  const levels: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) levels.push(parseInt(m[1], 10));

  if (levels.length === 0) {
    return {
      dimension: 'accessibility',
      code: 'a11y-no-headings',
      severity: 'warning',
      title: 'No headings on the page',
      detail: 'The page has no heading elements to structure its content.',
      suggestion: 'Add a heading outline (one <h1>, then <h2>/<h3>) for screen-reader navigation.',
    };
  }

  let skips = 0;
  for (let i = 1; i < levels.length; i++) {
    if (levels[i] > levels[i - 1] + 1) skips++;
  }
  if (skips === 0) return null;
  return {
    dimension: 'accessibility',
    code: 'a11y-heading-skip',
    severity: skips > 2 ? 'warning' : 'info',
    title: 'Heading levels skip',
    detail: `Found ${skips} heading-level skip(s) across ${levels.length} headings (e.g. h1 → h3).`,
    suggestion: 'Do not skip heading levels; step down one at a time.',
  };
}

function checkLinkText(html: string): AuditFinding | null {
  const re = /<a\s[^>]*>([\s\S]*?)<\/a>/gi;
  const bad = new Set(['click here', 'read more', 'learn more', 'here', 'more', 'link']);
  let total = 0;
  let generic = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    total++;
    const text = m[1].replace(/<[^>]*>/g, '').trim().toLowerCase();
    if (text && bad.has(text)) generic++;
  }
  if (total === 0 || generic === 0) return null;
  return {
    dimension: 'accessibility',
    code: 'a11y-vague-link-text',
    severity: 'info',
    title: 'Non-descriptive link text',
    detail: `${generic} of ${total} links use generic text (e.g. "click here", "read more").`,
    suggestion: 'Use link text that describes the destination out of context.',
  };
}

function checkAriaLandmarks(html: string): AuditFinding | null {
  const hasMain = /<main[\s>]/i.test(html) || /role=["']main["']/i.test(html);
  // <header>/banner counts as the top landmark: EDS loads <nav> into the header
  // client-side, so requiring a literal <nav> in the served HTML would
  // false-positive on every EDS site.
  const hasNav =
    /<nav[\s>]/i.test(html) ||
    /role=["']navigation["']/i.test(html) ||
    /<header[\s>]/i.test(html) ||
    /role=["']banner["']/i.test(html);
  const hasFooter = /<footer[\s>]/i.test(html) || /role=["']contentinfo["']/i.test(html);
  const found = [hasMain, hasNav, hasFooter].filter(Boolean).length;
  if (found === 3) return null;
  const missing: string[] = [];
  if (!hasMain) missing.push('main');
  if (!hasNav) missing.push('header/nav');
  if (!hasFooter) missing.push('footer');
  return {
    dimension: 'accessibility',
    code: 'a11y-missing-landmarks',
    severity: found === 0 ? 'warning' : 'info',
    title: 'Missing landmark regions',
    detail: `Missing landmark region(s): ${missing.join(', ')}.`,
    suggestion: 'Use semantic <main>, <nav> and <footer> for screen-reader navigation.',
  };
}

// NOTE: there is deliberately no `<html lang>` check. Edge Delivery Services
// applies `document.documentElement.lang` client-side (from metadata) — every
// EDS page, including Adobe's own www.aem.live, serves bare `<html>` at the
// origin. Auditing the served HTML for lang would false-positive a "critical"
// on 100% of pages of every EDS site, which is wrong and misleading.

function checkFormLabels(html: string): AuditFinding | null {
  const re = /<(?:input|select|textarea)\s[^>]*>/gi;
  const controls: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    const type = tag.match(/type=["']([^"']*)["']/i)?.[1]?.toLowerCase() ?? 'text';
    if (['hidden', 'submit', 'button', 'image'].includes(type)) continue;
    controls.push(tag);
  }
  if (controls.length === 0) return null;

  let unlabeled = 0;
  for (const control of controls) {
    const hasAriaLabel = /aria-label=["'][^"']+["']/i.test(control);
    const hasAriaLabelledBy = /aria-labelledby=["'][^"']+["']/i.test(control);
    const hasTitle = /title=["'][^"']+["']/i.test(control);
    const id = control.match(/\bid=["']([^"']*)["']/i)?.[1];
    let hasAssociatedLabel = false;
    if (id) {
      // Escape regex metacharacters — ids like "a[0]" would otherwise mis-match
      // or throw (and throwing would drop the whole page to a fetch "failure").
      const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      hasAssociatedLabel = new RegExp(`<label\\s[^>]*for=["']${escaped}["']`, 'i').test(html);
    }
    if (!hasAriaLabel && !hasAriaLabelledBy && !hasTitle && !hasAssociatedLabel) unlabeled++;
  }
  if (unlabeled === 0) return null;

  const ratio = unlabeled / controls.length;
  return {
    dimension: 'accessibility',
    code: 'a11y-unlabeled-inputs',
    severity: ratio > 0.5 ? 'critical' : 'warning',
    title: 'Form inputs missing labels',
    detail: `${unlabeled} of ${controls.length} form inputs have no associated label.`,
    suggestion: 'Associate each input with a <label for>, aria-label, or aria-labelledby.',
  };
}

/** Run every per-page accessibility check and return the findings. */
export function accessibilityFindings(html: string): AuditFinding[] {
  return [
    checkImageAltText(html),
    checkHeadingHierarchy(html),
    checkLinkText(html),
    checkAriaLandmarks(html),
    checkFormLabels(html),
  ].filter((f): f is AuditFinding => f !== null);
}
