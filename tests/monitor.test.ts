import { describe, it, expect, vi, afterEach } from 'vitest';
import type { DaClient } from '../src/da-admin/client.js';
import type { EdsClient } from '../src/eds-admin/client.js';
import { assessChange, buildAlert, crossesThreshold } from '../src/audit/monitor.js';
import { applyHistory, type Snapshot } from '../src/audit/history.js';
import { handleAuditMonitor } from '../src/mcp/audit-handlers.js';

function snap(date: string, over: Partial<Snapshot> = {}): Snapshot {
  return {
    date,
    overall: 90,
    dimensions: { seo: 90, accessibility: 100 },
    counts: { critical: 0, warning: 1, info: 2, total: 3, pages: 5 },
    ...over,
  };
}

describe('assessChange', () => {
  it('is a baseline (ok) when there is no previous snapshot', () => {
    const a = assessChange(null, snap('2026-08-01'));
    expect(a.status).toBe('ok');
    expect(a.baseline).toBe(true);
    expect(a.overallDelta).toBeNull();
  });

  it('is BROKEN when a new critical appears', () => {
    const prev = snap('2026-08-01', { counts: { critical: 0, warning: 1, info: 2, total: 3, pages: 5 } });
    const curr = snap('2026-08-02', { overall: 80, counts: { critical: 2, warning: 1, info: 2, total: 5, pages: 5 } });
    const a = assessChange(prev, curr);
    expect(a.status).toBe('broken');
    expect(a.regressions.join(' ')).toMatch(/2 new critical/);
  });

  it('is BROKEN when a dimension falls to poor', () => {
    const prev = snap('2026-08-01', { dimensions: { seo: 90, accessibility: 100 } });
    const curr = snap('2026-08-02', { dimensions: { seo: 40, accessibility: 100 } });
    const a = assessChange(prev, curr);
    expect(a.status).toBe('broken');
    expect(a.regressions.join(' ')).toMatch(/SEO fell to poor/);
  });

  it('is DEGRADED on an overall drop past the threshold (no new critical)', () => {
    const prev = snap('2026-08-01', { overall: 90 });
    const curr = snap('2026-08-02', { overall: 82 });
    const a = assessChange(prev, curr, { degradeDrop: 5 });
    expect(a.status).toBe('degraded');
    expect(a.overallDelta).toBe(-8);
  });

  it('is OK with no regression, and lists improvements', () => {
    const prev = snap('2026-08-01', { overall: 80, counts: { critical: 2, warning: 1, info: 2, total: 5, pages: 5 } });
    const curr = snap('2026-08-02', { overall: 90, counts: { critical: 0, warning: 1, info: 2, total: 3, pages: 5 } });
    const a = assessChange(prev, curr);
    expect(a.status).toBe('ok');
    expect(a.improvements.join(' ')).toMatch(/critical issues resolved/);
  });

  it('catches a steep drop WITHIN the poor band (review #5)', () => {
    const prev = snap('2026-08-01', { dimensions: { seo: 50, accessibility: 100 } }); // already poor
    const curr = snap('2026-08-02', { dimensions: { seo: 21, accessibility: 100 } }); // collapses further
    const a = assessChange(prev, curr);
    expect(a.status).toBe('degraded');
    expect(a.regressions.join(' ')).toMatch(/SEO dropped 29 points/);
  });

  it('does NOT fire an overall regression when the dimension SETS differ (review #4)', () => {
    // prev measured seo only; curr measured seo + performance → different denominators.
    const prev = snap('2026-08-01', { overall: 90, dimensions: { seo: 90 } });
    const curr = snap('2026-08-02', { overall: 70, dimensions: { seo: 90, performance: 50 } });
    const a = assessChange(curr.dimensions ? prev : null, curr);
    expect(a.regressions.join(' ')).not.toMatch(/overall dropped/);
    expect(a.status).toBe('ok'); // newly-measured performance isn't a regression
  });

  it('crossesThreshold ranks ok < degraded < broken', () => {
    expect(crossesThreshold('broken', 'broken')).toBe(true);
    expect(crossesThreshold('degraded', 'broken')).toBe(false);
    expect(crossesThreshold('degraded', 'degraded')).toBe(true);
    expect(crossesThreshold('ok', 'degraded')).toBe(false);
  });
});

describe('buildAlert', () => {
  it('is compact, carries public data, and works for Slack (text) + Discord (content)', () => {
    const a = assessChange(snap('2026-08-01'), snap('2026-08-02', { overall: 71, counts: { critical: 3, warning: 1, info: 2, total: 6, pages: 5 } }));
    const p = buildAlert('acme.com', snap('2026-08-02', { overall: 71 }), a, ['Missing title tag', 'Broken links']);
    expect(p.text).toContain('acme.com');
    expect(p.text).toContain('71/100');
    expect(p.text).toBe(p.content); // Slack reads text, Discord reads content
    expect(p.status).toBe('broken');
    // secret-free: no token-ish material
    expect(p.text).not.toMatch(/eyJ|token|EDS_DA/i);
  });
});

// ---------------------------------------------------------------------------
// handleAuditMonitor — records, classifies, and alerts
// ---------------------------------------------------------------------------

const now = Math.floor(Date.now() / 1000);
// A page missing its title AND description → yields SEO criticals → "broken".
const BROKEN_HTML = '<html lang="en"><head></head><body><main><h1>Hi</h1></main></body></html>';
function fakeEds(html = BROKEN_HTML, over: Record<string, unknown> = {}): EdsClient {
  return {
    listPages: async () => ({ total: 1, offset: 0, limit: 1000, data: [{ path: '/a', title: '', description: '', image: '', lastModified: now }] }),
    getRenderedPage: async () => ({ path: '/a', html }),
    getSitemap: async () => [{ loc: 'https://x/a' }],
    previewAndPublish: async () => ({ preview: {}, publish: {} }),
    ...over,
  } as unknown as EdsClient;
}
// Seed history with a clean previous day (0 criticals) so today reads as a regression.
const seeded = applyHistory(null, { date: '2026-01-01', overall: 100, dimensions: { seo: 100, accessibility: 100 }, counts: { critical: 0, warning: 0, info: 0, total: 0, pages: 1 } }).content;
function fakeDa(over: Record<string, unknown> = {}): DaClient {
  return {
    getSource: async () => ({ path: '/audit-history.json', content: seeded, contentType: 'application/json' }),
    pushDocuments: async (docs: Array<{ path: string }>) => ({ succeeded: docs.map((d) => d.path), failed: [] }),
    ...over,
  } as unknown as DaClient;
}

afterEach(() => vi.unstubAllGlobals());

describe('handleAuditMonitor', () => {
  it('records a snapshot and reports a BROKEN status when new criticals appear', async () => {
    const res = await handleAuditMonitor(fakeDa(), fakeEds(), 'acme.com', {});
    expect(res.content[0].text).toMatch(/Monitor: BROKEN/);
    expect(res.content[0].text).toMatch(/Regressed:/);
  });

  it('fires the webhook when the status crosses alertOn (broken), with a secret-free payload', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
      calls.push({ url, body: init.body });
      return { ok: true, status: 200 } as Response;
    });
    const res = await handleAuditMonitor(fakeDa(), fakeEds(), 'acme.com', { webhook: 'https://hooks.example.com/x', alertOn: 'broken' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://hooks.example.com/x');
    const payload = JSON.parse(calls[0].body);
    expect(payload.text).toContain('[broken]');
    expect(calls[0].body).not.toMatch(/eyJ|EDS_DA_TOKEN/); // no secrets in the payload
    expect(res.content[0].text).toMatch(/alert sent to webhook/);
  });

  it('rejects a non-https webhook without calling fetch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await handleAuditMonitor(fakeDa(), fakeEds(), 'acme.com', { webhook: 'http://insecure.example.com/x', alertOn: 'broken' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res.content[0].text).toMatch(/only https/);
  });

  it('still fires the alert even when recording the snapshot fails (review #3)', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url);
      return { ok: true, status: 200 } as Response;
    });
    const da = fakeDa({ pushDocuments: async () => ({ succeeded: [], failed: [{ path: '/audit-history.json', error: '503 Service Unavailable' }] }) });
    const res = await handleAuditMonitor(da, fakeEds(), 'acme.com', { webhook: 'https://hooks.example.com/x', alertOn: 'broken' });
    expect(calls).toHaveLength(1); // alert fired despite the write failure
    expect(res.content[0].text).toMatch(/alert sent to webhook/);
    expect(res.content[0].text).toMatch(/could not record the snapshot/);
  });

  it('does NOT alert when the status is below the threshold', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    // A clean page (good title + description) → no regression vs the seeded 100 → ok.
    const cleanHtml = `<html lang="en"><head><title>${'T'.repeat(40)}</title><meta name="description" content="${'d'.repeat(130)}"></head><body><main><h1>Hi</h1></main></body></html>`;
    const res = await handleAuditMonitor(fakeDa(), fakeEds(cleanHtml), 'acme.com', { webhook: 'https://hooks.example.com/x', alertOn: 'broken' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res.content[0].text).toMatch(/No alert/);
  });
});
