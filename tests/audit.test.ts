import { describe, it, expect } from 'vitest';
import type { EdsClient } from '../src/eds-admin/client.js';
import { seoFindings } from '../src/audit/checks/seo.js';
import { accessibilityFindings } from '../src/audit/checks/accessibility.js';
import { auditPage, auditSite, auditSinglePage } from '../src/audit/engine.js';
import { handleAuditPage, handleAuditSite } from '../src/mcp/audit-handlers.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TITLE = 'T'.repeat(40); // 40 chars -> within the ideal 30-60
const DESC = 'D'.repeat(140); // 140 chars -> within the ideal 120-160

/** A page that passes every per-page check. */
const CLEAN = `<html lang="en"><head>
<title>${TITLE}</title>
<meta name="description" content="${DESC}">
<link rel="canonical" href="https://example.com/x">
<meta property="og:title" content="t">
<meta property="og:description" content="d">
<meta property="og:image" content="https://example.com/i.jpg">
<script type="application/ld+json">{"@type":"WebPage"}</script>
</head><body>
<nav><a href="/products">Our products</a></nav>
<main>
  <h1>Heading</h1>
  <h2>Subsection</h2>
  <img src="/hero.jpg" alt="A descriptive hero image">
  <form><label for="email">Email</label><input id="email" type="text"></form>
</main>
<footer><a href="/contact">Contact the team</a></footer>
</body></html>`;

/** A page that fails many checks. */
const BAD = `<html><head></head><body>
<h1>One</h1><h1>Two</h1>
<img src="/a.jpg"><img src="/b.jpg">
<a href="/x">click here</a>
<form><input id="e" type="text"></form>
</body></html>`;

// ---------------------------------------------------------------------------
// SEO checks
// ---------------------------------------------------------------------------

describe('seoFindings', () => {
  it('reports nothing for a clean page', () => {
    expect(seoFindings(CLEAN)).toEqual([]);
  });

  it('flags a missing title as critical', () => {
    const f = seoFindings('<html><head></head><body></body></html>').find((x) => x.title === 'Missing title tag');
    expect(f?.severity).toBe('critical');
  });

  it('flags a too-short title as a warning (not critical)', () => {
    const f = seoFindings('<html><head><title>Short</title></head><body></body></html>')
      .find((x) => x.title.includes('Title length'));
    expect(f?.severity).toBe('warning');
  });

  it('flags a missing meta description as critical', () => {
    const f = seoFindings('<html><head><title>' + TITLE + '</title></head><body></body></html>')
      .find((x) => x.title === 'Missing meta description');
    expect(f?.severity).toBe('critical');
  });

  it('flags no H1 as critical and multiple H1 as warning', () => {
    const none = seoFindings('<html><head></head><body></body></html>').find((x) => x.title === 'No H1 heading');
    expect(none?.severity).toBe('critical');
    const many = seoFindings('<html><head></head><body><h1>a</h1><h1>b</h1></body></html>')
      .find((x) => x.title === 'Multiple H1 headings');
    expect(many?.severity).toBe('warning');
  });

  it('flags a noindex robots directive as critical', () => {
    const html = '<html><head><meta name="robots" content="noindex"></head><body></body></html>';
    const f = seoFindings(html).find((x) => x.title.includes('blocked from search'));
    expect(f?.severity).toBe('critical');
  });

  it('grades JSON-LD as info and Open Graph absence as warning', () => {
    const findings = seoFindings('<html><head></head><body></body></html>');
    expect(findings.find((x) => x.title.includes('structured data'))?.severity).toBe('info');
    expect(findings.find((x) => x.title === 'No Open Graph tags')?.severity).toBe('warning');
  });

  it('does not truncate a description containing an apostrophe', () => {
    // Good-length (135 char) description with an apostrophe — must NOT be flagged.
    const desc = `It's ${'x'.repeat(130)}`;
    const html = `<html><head><meta name="description" content="${desc}"></head><body></body></html>`;
    expect(seoFindings(html).find((x) => x.title.includes('Meta description'))).toBeUndefined();
  });

  it('flags noindex but NOT nofollow as blocked-from-indexing', () => {
    const noindex = '<html><head><meta name="robots" content="noindex"></head><body></body></html>';
    expect(seoFindings(noindex).some((x) => x.title.includes('blocked from search'))).toBe(true);
    const nofollow = '<html><head><meta name="robots" content="nofollow"></head><body></body></html>';
    expect(seoFindings(nofollow).some((x) => x.title.includes('blocked from search'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Accessibility checks
// ---------------------------------------------------------------------------

describe('accessibilityFindings', () => {
  it('reports nothing for a clean page', () => {
    expect(accessibilityFindings(CLEAN)).toEqual([]);
  });

  it('flags a majority of images missing alt text as critical', () => {
    const html = '<html lang="en"><body><img src="a"><img src="b"><img src="c" alt="ok"></body></html>';
    const f = accessibilityFindings(html).find((x) => x.title === 'Images missing an alt attribute');
    expect(f?.severity).toBe('critical'); // 2 of 3 missing -> ratio > 0.5
    expect(f?.detail).toContain('2 of 3');
  });

  it('does not flag decorative images with role=presentation', () => {
    const html = '<html lang="en"><main></main><nav></nav><footer></footer><img src="a" role="presentation"></html>';
    expect(accessibilityFindings(html).find((x) => x.title === 'Images missing an alt attribute')).toBeUndefined();
  });

  it('does NOT flag a missing lang attribute (EDS applies it client-side)', () => {
    // Every EDS page serves bare <html>; flagging it would false-positive on all.
    const f = accessibilityFindings('<html><body></body></html>').find((x) => x.title === 'No language attribute');
    expect(f).toBeUndefined();
  });

  it('flags an unlabeled form input', () => {
    const html = '<html lang="en"><main></main><nav></nav><footer></footer><form><input id="x" type="text"></form></html>';
    const f = accessibilityFindings(html).find((x) => x.title === 'Form inputs missing labels');
    expect(f).toBeDefined();
    expect(f?.severity).toBe('critical'); // 1 of 1 -> ratio > 0.5
  });

  it('flags missing landmark regions when none are present', () => {
    const f = accessibilityFindings('<html lang="en"><body><p>hi</p></body></html>')
      .find((x) => x.title === 'Missing landmark regions');
    expect(f?.severity).toBe('warning');
  });
});

// ---------------------------------------------------------------------------
// auditPage
// ---------------------------------------------------------------------------

describe('auditPage', () => {
  it('combines SEO + accessibility and sorts critical-first', () => {
    const findings = auditPage(BAD, '/bad');
    expect(findings.length).toBeGreaterThan(0);
    // Every finding is tagged with the page path.
    expect(findings.every((f) => f.page === '/bad')).toBe(true);
    // Sorted: no warning/info appears before a critical.
    const order = { critical: 0, warning: 1, info: 2 };
    for (let i = 1; i < findings.length; i++) {
      expect(order[findings[i].severity]).toBeGreaterThanOrEqual(order[findings[i - 1].severity]);
    }
  });

  it('returns an empty report for a clean page', () => {
    const report = auditSinglePage(CLEAN, '/clean');
    expect(report.summary.total).toBe(0);
    expect(report.scope).toBe('page');
  });
});

// ---------------------------------------------------------------------------
// auditSite (fake client)
// ---------------------------------------------------------------------------

const NOW_S = Math.floor(Date.now() / 1000);
const STALE_S = NOW_S - 400 * 24 * 60 * 60; // >1 year ago

function fakeClient(over: Partial<Record<string, unknown>> = {}): EdsClient {
  return {
    listPages: async () => ({
      total: 2,
      offset: 0,
      limit: 1000,
      data: [
        { path: '/a', title: '', description: '', image: '', lastModified: STALE_S },
        { path: '/b', title: '', description: '', image: '', lastModified: NOW_S },
      ],
    }),
    getRenderedPage: async (path: string) => ({ path, html: path === '/a' ? BAD : CLEAN }),
    getSitemap: async () => [{ loc: 'https://example.com/a' }], // /b missing
    getCwv: async () => [{ url: '/a', lcp: 5000, cls: 0.3, inp: 400, ttfb: 100, pageViews: 50 }],
    get404s: async () => [{ url: '/gone', views: 12, sources: [] }],
    ...over,
  } as unknown as EdsClient;
}

describe('auditSite', () => {
  it('audits each page and rolls up per-page + site-level findings', async () => {
    const report = await auditSite(fakeClient(), { domain: 'example.com' });
    expect(report.scope).toBe('site');
    expect(report.summary.pagesAudited).toBe(2);
    // Page /a (BAD) produces SEO + a11y findings tagged to it.
    expect(report.findings.some((f) => f.page === '/a' && f.dimension === 'seo')).toBe(true);
    // Freshness flags the stale page.
    expect(report.findings.some((f) => f.dimension === 'freshness')).toBe(true);
    // Sitemap coverage flags /b missing from the sitemap.
    expect(report.findings.some((f) => f.dimension === 'sitemap')).toBe(true);
    // Performance + 404s ran because a domain was supplied.
    expect(report.findings.some((f) => f.dimension === 'performance')).toBe(true);
    expect(report.findings.some((f) => f.dimension === 'links' && f.title.includes('404'))).toBe(true);
    expect(report.skipped).toEqual([]);
  });

  it('skips RUM checks (never silently) when no domain is given', async () => {
    const report = await auditSite(fakeClient());
    expect(report.findings.some((f) => f.dimension === 'performance')).toBe(false);
    expect(report.skipped.some((s) => s.startsWith('performance'))).toBe(true);
    expect(report.skipped.some((s) => s.startsWith('links/404s'))).toBe(true);
  });

  it('honors maxPages and flags truncation', async () => {
    const report = await auditSite(fakeClient(), { maxPages: 1, dimensions: ['seo'] });
    expect(report.summary.pagesAudited).toBe(1);
    expect(report.truncated).toBe(true);
  });

  it('runs only the requested dimensions', async () => {
    const report = await auditSite(fakeClient(), { dimensions: ['seo'] });
    const dims = new Set(report.findings.map((f) => f.dimension));
    expect(dims.has('seo')).toBe(true);
    expect(dims.has('accessibility')).toBe(false);
    expect(dims.has('freshness')).toBe(false);
  });

  it('records a page that fails to fetch instead of aborting', async () => {
    const client = fakeClient({
      getRenderedPage: async (path: string) => {
        if (path === '/a') throw new Error('boom');
        return { path, html: CLEAN };
      },
    });
    const report = await auditSite(client, { dimensions: ['seo', 'accessibility'] });
    expect(report.findings.some((f) => f.title === 'Page could not be fetched' && f.page === '/a')).toBe(true);
  });

  it('matches sitemap coverage despite trailing slashes', async () => {
    const client = fakeClient({
      listPages: async () => ({
        total: 1, offset: 0, limit: 1000,
        data: [{ path: '/a', title: '', description: '', image: '', lastModified: NOW_S }],
      }),
      getSitemap: async () => [{ loc: 'https://example.com/a/' }], // trailing slash vs index "/a"
    });
    const report = await auditSite(client, { dimensions: ['sitemap'] });
    // /a is covered by the sitemap (once slashes are normalized) -> no finding.
    expect(report.findings.filter((f) => f.dimension === 'sitemap')).toEqual([]);
  });

  it('respects a pathPrefix filter', async () => {
    const report = await auditSite(fakeClient(), { pathPrefix: '/b', dimensions: ['seo'] });
    // Only /b (CLEAN) is under the prefix -> no SEO findings, 1 page audited.
    expect(report.summary.pagesAudited).toBe(1);
    expect(report.findings.filter((f) => f.dimension === 'seo')).toEqual([]);
    expect(report.target).toBe('/b');
  });
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

describe('audit handlers', () => {
  it('handleAuditPage formats a readable report', async () => {
    const client = { getRenderedPage: async () => ({ path: '/bad', html: BAD }) } as unknown as EdsClient;
    const res = await handleAuditPage(client, { path: '/bad' });
    expect(res.content[0].text).toContain('Audit of page /bad');
    expect(res.content[0].text).toContain('CRITICAL');
  });

  it('handleAuditPage surfaces a fetch error via isError', async () => {
    const client = { getRenderedPage: async () => { throw new Error('nope'); } } as unknown as EdsClient;
    const res = await handleAuditPage(client, { path: '/x' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Error:');
  });

  it('handleAuditSite formats the summary and notes skipped dimensions', async () => {
    const res = await handleAuditSite(fakeClient(), {});
    expect(res.content[0].text).toContain('Audit of site (whole site)');
    expect(res.content[0].text).toMatch(/Pages inspected: 2/);
    expect(res.content[0].text).toContain('Skipped:');
  });

  it('handleAuditSite reports a clean subtree with no issues', async () => {
    const client = fakeClient({
      listPages: async () => ({ total: 1, offset: 0, limit: 1000, data: [{ path: '/b', title: '', description: '', image: '', lastModified: NOW_S }] }),
    });
    const res = await handleAuditSite(client, { dimensions: ['seo', 'accessibility'] });
    expect(res.content[0].text).toContain('No issues found');
  });
});
