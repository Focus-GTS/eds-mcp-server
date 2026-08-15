import { describe, it, expect } from 'vitest';
import type { EdsClient } from '../src/eds-admin/client.js';
import type { AuditReport } from '../src/audit/types.js';
import { generateReport } from '../src/audit/report.js';
import { handleAuditReport } from '../src/mcp/audit-handlers.js';

function makeReport(over: Partial<AuditReport> = {}): AuditReport {
  return {
    scope: 'site',
    target: '(whole site)',
    findings: [
      { dimension: 'seo', severity: 'critical', title: 'Missing meta description', detail: 'no desc', suggestion: 'Add a 120–160 char description.', page: '/a' },
      { dimension: 'seo', severity: 'critical', title: 'Missing meta description', detail: 'no desc', suggestion: 'Add a 120–160 char description.', page: '/b' },
      { dimension: 'accessibility', severity: 'warning', title: 'Missing landmark regions', detail: 'no main', page: '/a' },
    ],
    summary: { critical: 2, warning: 1, info: 0, total: 3, pagesAudited: 5 },
    skipped: ['performance (needs a domain)', 'links/404s (needs a domain)'],
    truncated: false,
    ...over,
  };
}

const META = { site: 'acme.com', generatedAt: '2026-08-15' };

describe('generateReport', () => {
  it('produces a self-contained HTML document', () => {
    const html = generateReport(makeReport(), META);
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('<style>'); // inline CSS, no external assets
    expect(html).not.toMatch(/<link[^>]+href|<script[^>]+src=/i); // truly self-contained
    expect(html).toContain('<title>Site Health — acme.com</title>');
    expect(html).toContain('acme.com');
    expect(html).toContain(`Audited ${META.generatedAt}`);
  });

  it('collapses the same finding across pages into one row with the page list', () => {
    const html = generateReport(makeReport(), META);
    expect((html.match(/Missing meta description/g) ?? []).length).toBe(1); // one row, not two
    expect(html).toContain('/a'); // both affected pages listed
    expect(html).toContain('/b');
    expect(html).toContain('2 pages'); // the aggregate count
    expect(html).toContain('Add a 120–160 char description.');
  });

  it('shows skipped dimensions as "not run", never a fake score', () => {
    const html = generateReport(makeReport(), META);
    // Performance and Links were skipped.
    expect(html).toContain('Not run');
    expect(html).toContain('Performance');
    expect(html).toContain('Links &amp; 404s');
  });

  it('scores a dimension lower when it has criticals, and renders a gauge', () => {
    // SEO has 2 criticals over 5 pages -> below 100; Freshness has none -> 100.
    const html = generateReport(makeReport(), META);
    // Freshness ran with no findings -> perfect score shown in its gauge.
    expect(html).toContain('>100</text>');
    expect(html).toContain('Freshness');
    // The overall ring gauge is present (an SVG arc, color-coded).
    expect(html).toMatch(/class="arc (good|fair|poor)"/);
  });

  it('renders a clean report when there are no findings', () => {
    const clean = makeReport({ findings: [], summary: { critical: 0, warning: 0, info: 0, total: 0, pagesAudited: 3 }, skipped: [] });
    const html = generateReport(clean, META);
    expect(html).toContain('No issues found');
  });

  it('escapes HTML in finding content', () => {
    const evil = makeReport({
      findings: [{ dimension: 'seo', severity: 'warning', title: 'Weird <script> title', detail: 'x', suggestion: 'a & b', page: '/<x>' }],
      summary: { critical: 0, warning: 1, info: 0, total: 1, pagesAudited: 1 },
    });
    const html = generateReport(evil, META);
    expect(html).toContain('Weird &lt;script&gt; title');
    expect(html).toContain('a &amp; b');
    expect(html).not.toContain('<script> title');
  });
});

describe('handleAuditReport', () => {
  it('runs the audit and returns an HTML report', async () => {
    const now = Math.floor(Date.now() / 1000);
    const client = {
      listPages: async () => ({ total: 1, offset: 0, limit: 1000, data: [{ path: '/a', title: '', description: '', image: '', lastModified: now }] }),
      getRenderedPage: async () => ({ path: '/a', html: `<html lang="en"><head><title>${'T'.repeat(40)}</title></head><body><main><h1>Hi</h1></main></body></html>` }),
      getSitemap: async () => [{ loc: 'https://x/a' }],
    } as unknown as EdsClient;
    const res = await handleAuditReport(client, 'acme/site', {});
    expect(res.content[0].text).toMatch(/^<!doctype html>/i);
    expect(res.content[0].text).toContain('Site Health — acme/site');
  });
});
