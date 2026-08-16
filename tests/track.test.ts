import { describe, it, expect } from 'vitest';
import type { DaClient } from '../src/da-admin/client.js';
import type { EdsClient } from '../src/eds-admin/client.js';
import { parseHistory, applyHistory, delta, type Snapshot } from '../src/audit/history.js';
import { renderTrend } from '../src/audit/trend.js';
import { handleAuditSnapshot, handleAuditTrend } from '../src/mcp/audit-handlers.js';
import { computeScores } from '../src/audit/score.js';
import type { AuditReport } from '../src/audit/types.js';

function snap(date: string, overall: number, over: Partial<Snapshot> = {}): Snapshot {
  return {
    date,
    overall,
    dimensions: { seo: overall, accessibility: 100 },
    counts: { critical: 0, warning: 1, info: 2, total: 3, pages: 5 },
    ...over,
  };
}

// ---------------------------------------------------------------------------
// history.ts — the sheet reader/writer
// ---------------------------------------------------------------------------

describe('applyHistory / parseHistory', () => {
  it('creates a fresh sheet from null and round-trips', () => {
    const { content, changed, previous } = applyHistory(null, snap('2026-08-01', 80));
    expect(changed).toBe(true);
    expect(previous).toBeNull();
    const parsed = JSON.parse(content);
    expect(parsed[':type']).toBe('sheet');
    expect(parsed.data).toHaveLength(1);
    const back = parseHistory(content);
    expect(back[0]).toMatchObject({ date: '2026-08-01', overall: 80 });
    expect(back[0].dimensions.seo).toBe(80);
  });

  it('appends a new date and keeps rows date-sorted, with previous = the prior day', () => {
    const first = applyHistory(null, snap('2026-08-01', 80)).content;
    const { content, previous } = applyHistory(first, snap('2026-08-08', 89));
    expect(previous?.date).toBe('2026-08-01'); // delta baseline is the prior snapshot
    const series = parseHistory(content);
    expect(series.map((s) => s.date)).toEqual(['2026-08-01', '2026-08-08']);
    expect(series[1].overall).toBe(89);
  });

  it('updates a same-day row (latest run wins) rather than duplicating', () => {
    const v1 = applyHistory(null, snap('2026-08-01', 80)).content;
    const { content, changed } = applyHistory(v1, snap('2026-08-01', 85));
    expect(changed).toBe(true);
    const series = parseHistory(content);
    expect(series).toHaveLength(1); // not two rows for the same date
    expect(series[0].overall).toBe(85);
  });

  it('is idempotent — same date + identical numbers writes nothing', () => {
    const v1 = applyHistory(null, snap('2026-08-01', 80)).content;
    const again = applyHistory(v1, snap('2026-08-01', 80));
    expect(again.changed).toBe(false);
    expect(again.content).toBe(v1);
  });

  it('preserves extra columns a user added to a row', () => {
    const sheet = JSON.stringify({
      ':type': 'sheet',
      ':sheetname': 'data',
      data: [{ date: '2026-08-01', overall: 80, note: 'launch day' }],
    });
    const { content } = applyHistory(sheet, snap('2026-08-01', 85));
    expect(JSON.parse(content).data[0].note).toBe('launch day');
  });

  it('coerces stringified numbers on read (a published sheet may stringify)', () => {
    const sheet = JSON.stringify({
      ':type': 'sheet',
      ':sheetname': 'data',
      data: [{ date: '2026-08-01', overall: '80', seo: '75', critical: '0', total: '3' }],
    });
    const series = parseHistory(sheet);
    expect(series[0].overall).toBe(80);
    expect(series[0].dimensions.seo).toBe(75);
    expect(series[0].counts.total).toBe(3);
  });

  it('refuses to overwrite an unrecognizable / multi-sheet existing doc', () => {
    expect(() => applyHistory('not json', snap('2026-08-01', 80))).toThrow(/not valid JSON/);
    expect(() => applyHistory(JSON.stringify({ ':type': 'multi-sheet' }), snap('2026-08-01', 80))).toThrow(/multi-sheet/);
  });

  it('parseHistory tolerates empty/absent content', () => {
    expect(parseHistory(null)).toEqual([]);
    expect(parseHistory('')).toEqual([]);
  });

  it('delta computes per-field change (to − from), only for dimensions in both', () => {
    const d = delta(snap('2026-08-01', 80), snap('2026-08-08', 89));
    expect(d.overall).toBe(9);
    expect(d.dimensions.seo).toBe(9);
  });

  // --- Regression: defensive reads (ADR-016 review MEDIUMs) ---

  it('drops a row with a missing overall instead of plotting a phantom 0', () => {
    const sheet = JSON.stringify({
      ':type': 'sheet',
      ':sheetname': 'data',
      data: [
        { date: '2026-08-01', overall: 80 },
        { date: '2026-08-02' }, // hand-edited, no overall
      ],
    });
    const series = parseHistory(sheet);
    expect(series).toHaveLength(1);
    expect(series[0].overall).toBe(80);
  });

  it('tolerates a null row on read AND on write — never throws', () => {
    const sheet = JSON.stringify({
      ':type': 'sheet',
      ':sheetname': 'data',
      data: [null, { date: '2026-08-01', overall: 80 }],
    });
    expect(() => parseHistory(sheet)).not.toThrow();
    expect(parseHistory(sheet)).toHaveLength(1);
    // Writing cleans the null row out rather than crashing on it.
    const { content } = applyHistory(sheet, snap('2026-08-08', 85));
    const data = JSON.parse(content).data;
    expect(data.every((r: unknown) => r && typeof r === 'object')).toBe(true);
    expect(parseHistory(content).map((s) => s.date)).toEqual(['2026-08-01', '2026-08-08']);
  });

  it('clamps an out-of-range overall on read', () => {
    const sheet = JSON.stringify({ ':type': 'sheet', ':sheetname': 'data', data: [{ date: '2026-08-01', overall: 150 }] });
    expect(parseHistory(sheet)[0].overall).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// score.ts — only score ATTEMPTED dimensions (ADR-016 review: HIGH)
// ---------------------------------------------------------------------------

function report(over: Partial<AuditReport> = {}): AuditReport {
  return {
    scope: 'site',
    target: '(whole site)',
    findings: [],
    summary: { critical: 0, warning: 0, info: 0, total: 0, pagesAudited: 5 },
    skipped: [],
    dimensions: ['seo', 'accessibility', 'performance', 'freshness', 'links', 'sitemap'],
    truncated: false,
    ...over,
  };
}

describe('computeScores — never a fake 100 for an unrun dimension', () => {
  it('scores ONLY the attempted dimensions when a filter was used', () => {
    // A `dimensions: ['seo']` run: only SEO was attempted. The others must NOT
    // appear (they would otherwise score a perfect 100 from an empty findings list).
    const r = report({
      dimensions: ['seo'],
      findings: [
        { dimension: 'seo', code: 'seo-missing-description', severity: 'critical', title: 'x', detail: 'x', page: '/a' },
      ],
    });
    const s = computeScores(r);
    expect(Object.keys(s.dimensions)).toEqual(['seo']); // not accessibility/freshness/etc
    expect(s.dimensions.accessibility).toBeUndefined();
    expect(s.overall).toBe(s.dimensions.seo); // overall = the one dimension that ran
    expect(s.overall).toBeLessThan(100); // and it reflects the real finding
  });

  it('omits a skipped (RUM) dimension from the score, never a fake number', () => {
    const r = report({ skipped: ['performance (needs a domain)', 'links/404s (needs a domain)'] });
    const s = computeScores(r);
    expect(s.dimensions.performance).toBeUndefined();
    expect(s.dimensions.links).toBeUndefined();
    expect(s.skipped).toEqual(['performance', 'links']);
    // Four clean dimensions with no findings → all 100 → overall 100.
    expect(s.overall).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// trend.ts — the HTML view
// ---------------------------------------------------------------------------

describe('renderTrend', () => {
  const META = { site: 'acme.com' };

  it('is a self-contained HTML doc with no external assets', () => {
    const html = renderTrend([snap('2026-08-01', 80), snap('2026-08-08', 89)], META);
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('<style>');
    expect(html).not.toMatch(/<link[^>]+href|<script[^>]+src=/i);
    expect(html).toContain('acme.com');
  });

  it('prompts to record a snapshot when there is no history', () => {
    const html = renderTrend([], META);
    expect(html).toContain('eds_audit_snapshot');
    expect(html).not.toContain('<polyline'); // no chart
  });

  it('draws a sparkline and the since-start change for multiple snapshots', () => {
    const html = renderTrend([snap('2026-08-01', 71), snap('2026-08-08', 89)], META);
    expect(html).toContain('<polyline'); // the trend line
    expect(html).toContain('89'); // latest score
    expect(html).toContain('▲ 18'); // since the first snapshot
    expect(html).toContain('2026-08-01'); // axis label
  });

  it('handles a single snapshot without claiming a trend', () => {
    const html = renderTrend([snap('2026-08-01', 80)], META);
    expect(html).not.toContain('<polyline');
    expect(html).toContain('first snapshot');
  });
});

// ---------------------------------------------------------------------------
// handlers — snapshot + trend
// ---------------------------------------------------------------------------

const now = Math.floor(Date.now() / 1000);
function fakeEds(over: Record<string, unknown> = {}): EdsClient {
  return {
    listPages: async () => ({ total: 1, offset: 0, limit: 1000, data: [{ path: '/a', title: '', description: '', image: '', lastModified: now }] }),
    getRenderedPage: async () => ({ path: '/a', html: `<html lang="en"><head><title>${'T'.repeat(40)}</title><meta name="description" content="${'d'.repeat(130)}"></head><body><main><h1>Hi</h1></main></body></html>` }),
    getSitemap: async () => [{ loc: 'https://x/a' }],
    previewAndPublish: async () => ({ preview: {}, publish: {} }),
    ...over,
  } as unknown as EdsClient;
}
function fakeDa(over: Record<string, unknown> = {}): DaClient {
  return {
    getSource: async () => {
      const e = new Error('not found') as Error & { status: number };
      e.status = 404;
      throw e;
    },
    pushDocuments: async (docs: Array<{ path: string }>) => ({ succeeded: docs.map((d) => d.path), failed: [] }),
    ...over,
  } as unknown as DaClient;
}

describe('handleAuditSnapshot', () => {
  it('records the first snapshot and writes the history sheet', async () => {
    let wrote: string | null = null;
    const da = fakeDa({
      pushDocuments: async (docs: Array<{ path: string; content: string }>) => {
        wrote = docs[0].content;
        return { succeeded: docs.map((d) => d.path), failed: [] };
      },
    });
    const res = await handleAuditSnapshot(da, fakeEds(), {});
    expect(res.content[0].text).toMatch(/Recorded snapshot/);
    expect(res.content[0].text).toMatch(/first snapshot recorded/);
    expect(wrote).toContain('"date"');
    // Default is private (unpublished).
    expect(res.content[0].text).toMatch(/stay private|unpublished/);
  });

  it('dryRun previews the row and writes nothing', async () => {
    let wrote = false;
    const da = fakeDa({ pushDocuments: async () => { wrote = true; return { succeeded: [], failed: [] }; } });
    const res = await handleAuditSnapshot(da, fakeEds(), { dryRun: true });
    expect(wrote).toBe(false);
    expect(res.content[0].text).toMatch(/Dry run/);
  });

  it('publish:true previews + publishes the sheet', async () => {
    let published = false;
    const eds = fakeEds({ previewAndPublish: async () => { published = true; return { preview: {}, publish: {} }; } });
    const res = await handleAuditSnapshot(fakeDa(), eds, { publish: true });
    expect(published).toBe(true);
    expect(res.content[0].text).toMatch(/published/i);
  });
});

describe('handleAuditTrend', () => {
  it('returns the HTML trend view by default', async () => {
    const sheet = applyHistory(null, snap('2026-08-01', 80)).content;
    const da = fakeDa({ getSource: async () => ({ path: '/audit-history.json', content: sheet, contentType: 'application/json' }) });
    const res = await handleAuditTrend(da, 'acme/site', {});
    expect(res.content[0].text).toMatch(/^<!doctype html>/i);
  });

  it('format:text returns a short summary', async () => {
    let s = applyHistory(null, snap('2026-08-01', 71)).content;
    s = applyHistory(s, snap('2026-08-08', 89)).content;
    const da = fakeDa({ getSource: async () => ({ path: '/audit-history.json', content: s, contentType: 'application/json' }) });
    const res = await handleAuditTrend(da, 'acme/site', { format: 'text' });
    expect(res.content[0].text).toContain('89/100');
    expect(res.content[0].text).toContain('▲18');
  });

  it('reports no history gracefully when the sheet is absent', async () => {
    const res = await handleAuditTrend(fakeDa(), 'acme/site', { format: 'text' });
    expect(res.content[0].text).toMatch(/No history yet/);
  });
});
