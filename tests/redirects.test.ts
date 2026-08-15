import { describe, it, expect } from 'vitest';
import type { DaClient } from '../src/da-admin/client.js';
import type { EdsClient } from '../src/eds-admin/client.js';
import { applyRedirects, parseRedirects } from '../src/fix/redirects.js';
import { handleFixRedirect } from '../src/mcp/fix-handlers.js';

// An EDS/DA sheet is a JSON document (verified live: a 301 on the sandbox).
const SHEET = JSON.stringify({
  ':type': 'sheet',
  ':sheetname': 'data',
  total: 1,
  limit: 1,
  offset: 0,
  data: [{ Source: '/old', Destination: '/new' }],
});
const SHEET_3COL = JSON.stringify({
  ':type': 'sheet',
  ':sheetname': 'data',
  total: 1,
  limit: 1,
  offset: 0,
  data: [{ Source: '/old', Destination: '/new', Note: 'keep me' }],
});

// ---------------------------------------------------------------------------
// parse / applyRedirects
// ---------------------------------------------------------------------------

describe('parseRedirects', () => {
  it('reads Source/Destination rows from the JSON sheet', () => {
    expect(parseRedirects(SHEET)).toEqual([{ source: '/old', destination: '/new' }]);
  });
});

describe('applyRedirects', () => {
  it('creates a new JSON sheet (with :type sheet) when none exists', () => {
    const { content, changes } = applyRedirects(null, [{ source: '/a', destination: '/b' }]);
    expect(changes).toEqual([{ source: '/a', from: null, to: '/b' }]);
    const json = JSON.parse(content);
    expect(json[':type']).toBe('sheet');
    expect(json.data).toEqual([{ Source: '/a', Destination: '/b' }]);
    expect(json.total).toBe(1);
    expect(parseRedirects(content)).toEqual([{ source: '/a', destination: '/b' }]);
  });

  it('appends a rule while preserving existing ones', () => {
    const { content, changes } = applyRedirects(SHEET, [{ source: '/gone', destination: '/home' }]);
    expect(changes).toEqual([{ source: '/gone', from: null, to: '/home' }]);
    expect(parseRedirects(content)).toEqual([
      { source: '/old', destination: '/new' },
      { source: '/gone', destination: '/home' },
    ]);
  });

  it('updates an existing source in place (no duplicate row)', () => {
    const { content, changes } = applyRedirects(SHEET, [{ source: '/old', destination: '/newer' }]);
    expect(changes).toEqual([{ source: '/old', from: '/new', to: '/newer' }]);
    expect(parseRedirects(content)).toEqual([{ source: '/old', destination: '/newer' }]);
  });

  it('is idempotent — re-adding the same rule is a no-op', () => {
    const first = applyRedirects(SHEET, [{ source: '/old', destination: '/new' }]);
    expect(first.changes).toEqual([]);
    expect(first.content).toBe(SHEET);
  });

  it('preserves extra columns on existing rows (no data loss)', () => {
    const { content } = applyRedirects(SHEET_3COL, [{ source: '/x', destination: '/y' }]);
    const json = JSON.parse(content);
    expect(json.data[0]).toEqual({ Source: '/old', Destination: '/new', Note: 'keep me' }); // Note survives
    expect(json.data[1]).toEqual({ Source: '/x', Destination: '/y' });
  });

  it('escapes nothing weird — query-string destinations round-trip', () => {
    const { content } = applyRedirects(null, [{ source: '/a', destination: '/b?x=1&y=2' }]);
    expect(parseRedirects(content)).toEqual([{ source: '/a', destination: '/b?x=1&y=2' }]);
  });

  // --- Guards (adversarial-review findings) ---

  it('refuses a self-redirect (loop that would hide the page)', () => {
    expect(() => applyRedirects(null, [{ source: '/x', destination: '/x' }])).toThrow(/self-redirect/i);
  });

  it('refuses to redirect the site root "/" (would hide the homepage)', () => {
    expect(() => applyRedirects(null, [{ source: '/', destination: '/home' }])).toThrow(/root|homepage/i);
  });

  it('refuses to overwrite a non-JSON /redirects.json (no silent wipe)', () => {
    expect(() => applyRedirects('<body>not json</body>', [{ source: '/a', destination: '/b' }])).toThrow(
      /valid JSON|refusing to overwrite/i,
    );
  });

  it('refuses to edit a multi-sheet workbook', () => {
    const multi = JSON.stringify({ ':type': 'multi-sheet', ':names': ['data'], data: { data: [] } });
    expect(() => applyRedirects(multi, [{ source: '/a', destination: '/b' }])).toThrow(/multi-sheet/i);
  });
});

// ---------------------------------------------------------------------------
// handleFixRedirect
// ---------------------------------------------------------------------------

function notFound() {
  return Object.assign(new Error('not found'), { status: 404 });
}
function fakeDa(over: Record<string, unknown> = {}): DaClient {
  return {
    getSource: async () => { throw notFound(); }, // default: no redirects sheet yet
    pushDocuments: async (docs: Array<{ path: string }>, opts?: { withUndo?: boolean }) => ({
      succeeded: docs.map((d) => d.path),
      failed: [],
      ...(opts?.withUndo ? { undo: { restore: [], remove: ['/redirects.json'] } } : {}),
    }),
    ...over,
  } as unknown as DaClient;
}
function fakeEds(over: Record<string, unknown> = {}): EdsClient {
  return { previewAndPublish: async () => ({ preview: {}, publish: {} }), ...over } as unknown as EdsClient;
}

describe('handleFixRedirect', () => {
  it('creates the redirects sheet when none exists', async () => {
    const res = await handleFixRedirect(fakeDa(), fakeEds(), { redirects: [{ source: '/gone', destination: '/home' }] });
    expect(res.content[0].text).toContain('Created the redirects sheet — 1 rule');
  });

  it('writes JSON to /redirects.json', async () => {
    let wrote: { path: string; content: string; contentType?: string } | undefined;
    const da = fakeDa({
      pushDocuments: async (docs: Array<{ path: string; content: string; contentType?: string }>) => {
        wrote = docs[0];
        return { succeeded: docs.map((d) => d.path), failed: [], undo: { restore: [], remove: ['/redirects.json'] } };
      },
    });
    await handleFixRedirect(da, fakeEds(), { redirects: [{ source: '/gone', destination: '/home' }] });
    expect(wrote?.path).toBe('/redirects.json');
    expect(wrote?.contentType).toBe('application/json');
    expect(JSON.parse(wrote!.content)[':type']).toBe('sheet');
  });

  it('dryRun previews the rules and writes nothing', async () => {
    let wrote = false;
    const da = fakeDa({ pushDocuments: async () => { wrote = true; return { succeeded: [], failed: [] }; } });
    const res = await handleFixRedirect(da, fakeEds(), { redirects: [{ source: '/gone', destination: '/home' }], dryRun: true });
    expect(res.content[0].text).toContain('Dry run — nothing written');
    expect(res.content[0].text).toContain('/gone → /home');
    expect(wrote).toBe(false);
  });

  it('updates an existing sheet and always returns an undo handle', async () => {
    const da = fakeDa({ getSource: async () => ({ path: '/redirects.json', content: SHEET, contentType: 'application/json' }) });
    const res = await handleFixRedirect(da, fakeEds(), { redirects: [{ source: '/second', destination: '/2' }] });
    expect(res.content[0].text).toContain('Updated the redirects sheet — 1 rule');
    expect(res.content[0].text).toContain('eds_da_rollback');
  });

  it('publishes /redirects.json when publish:true', async () => {
    let published: string | undefined;
    const eds = fakeEds({ previewAndPublish: async (p: string) => { published = p; return { preview: {}, publish: {} }; } });
    const res = await handleFixRedirect(fakeDa(), eds, { redirects: [{ source: '/gone', destination: '/home' }], publish: true });
    expect(published).toBe('/redirects.json');
    expect(res.content[0].text).toContain('redirects are live');
  });

  it('reports a no-op when the rule is already present', async () => {
    const da = fakeDa({ getSource: async () => ({ path: '/redirects.json', content: SHEET, contentType: 'application/json' }) });
    const res = await handleFixRedirect(da, fakeEds(), { redirects: [{ source: '/old', destination: '/new' }] });
    expect(res.content[0].text).toContain('No redirect changes needed');
  });

  it('surfaces a refusal to overwrite an unrecognizable sheet via isError', async () => {
    const da = fakeDa({ getSource: async () => ({ path: '/redirects.json', content: 'not json', contentType: 'application/json' }) });
    const res = await handleFixRedirect(da, fakeEds(), { redirects: [{ source: '/a', destination: '/b' }] });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/valid JSON|refusing/i);
  });
});
