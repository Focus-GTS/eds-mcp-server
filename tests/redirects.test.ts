import { describe, it, expect } from 'vitest';
import type { DaClient } from '../src/da-admin/client.js';
import type { EdsClient } from '../src/eds-admin/client.js';
import { applyRedirects, parseRedirects, parseTable } from '../src/fix/redirects.js';
import { handleFixRedirect } from '../src/mcp/fix-handlers.js';

const SHEET = `<body><main><div><table>
  <tr><td>Source</td><td>Destination</td></tr>
  <tr><td>/old</td><td>/new</td></tr>
</table></div></main></body>`;

const SHEET_3COL = `<body><main><div><table>
  <tr><td>Source</td><td>Destination</td><td>Note</td></tr>
  <tr><td>/old</td><td>/new</td><td>keep me</td></tr>
</table></div></main></body>`;

// ---------------------------------------------------------------------------
// applyRedirects / parse
// ---------------------------------------------------------------------------

describe('parseTable / parseRedirects', () => {
  it('reads Source/Destination rows from a sheet', () => {
    expect(parseTable(SHEET)?.headers).toEqual(['Source', 'Destination']);
    expect(parseRedirects(SHEET)).toEqual([{ source: '/old', destination: '/new' }]);
  });

  it('returns [] for a doc without a table', () => {
    expect(parseRedirects('<body><p>hi</p></body>')).toEqual([]);
  });
});

describe('applyRedirects', () => {
  it('creates a new sheet when none exists', () => {
    const { html, changes } = applyRedirects(null, [{ source: '/a', destination: '/b' }]);
    expect(changes).toEqual([{ source: '/a', from: null, to: '/b' }]);
    expect(html).toContain('<table>');
    expect(parseRedirects(html)).toEqual([{ source: '/a', destination: '/b' }]);
    expect(parseTable(html)?.headers).toEqual(['Source', 'Destination']);
  });

  it('appends a rule while preserving existing ones', () => {
    const { html, changes } = applyRedirects(SHEET, [{ source: '/gone', destination: '/home' }]);
    expect(changes).toEqual([{ source: '/gone', from: null, to: '/home' }]);
    expect(parseRedirects(html)).toEqual([
      { source: '/old', destination: '/new' },
      { source: '/gone', destination: '/home' },
    ]);
  });

  it('updates an existing source in place (no duplicate row)', () => {
    const { html, changes } = applyRedirects(SHEET, [{ source: '/old', destination: '/newer' }]);
    expect(changes).toEqual([{ source: '/old', from: '/new', to: '/newer' }]);
    const rules = parseRedirects(html);
    expect(rules).toEqual([{ source: '/old', destination: '/newer' }]); // one row, updated
  });

  it('is idempotent — re-adding the same rule is a no-op', () => {
    const first = applyRedirects(SHEET, [{ source: '/old', destination: '/new' }]);
    expect(first.changes).toEqual([]);
    expect(first.html).toBe(SHEET); // returned unchanged
  });

  it('preserves extra columns on existing rows (no data loss)', () => {
    const { html } = applyRedirects(SHEET_3COL, [{ source: '/x', destination: '/y' }]);
    expect(html).toContain('keep me'); // the Note on the existing row survives
    expect(parseTable(html)?.headers).toEqual(['Source', 'Destination', 'Note']);
    expect(parseRedirects(html)).toEqual([
      { source: '/old', destination: '/new' },
      { source: '/x', destination: '/y' },
    ]);
  });

  it('refuses to edit a sheet without Source/Destination columns', () => {
    const bad = '<body><table><tr><td>Foo</td><td>Bar</td></tr><tr><td>1</td><td>2</td></tr></table></body>';
    expect(() => applyRedirects(bad, [{ source: '/a', destination: '/b' }])).toThrow(/Source\/Destination/);
  });

  it('escapes HTML in rule values', () => {
    const { html } = applyRedirects(null, [{ source: '/a', destination: '/b?x=1&y=2' }]);
    expect(html).toContain('/b?x=1&amp;y=2');
  });

  // --- Regression tests for adversarial-review findings ---

  it('refuses a self-redirect (loop that would hide the page)', () => {
    expect(() => applyRedirects(null, [{ source: '/x', destination: '/x' }])).toThrow(/self-redirect/i);
  });

  it('refuses to redirect the site root "/" (would hide the homepage)', () => {
    expect(() => applyRedirects(null, [{ source: '/', destination: '/home' }])).toThrow(/root|homepage/i);
  });

  it('refuses to overwrite a present-but-unrecognizable /redirects doc (no silent wipe)', () => {
    expect(() => applyRedirects('<body><p>not a sheet</p></body>', [{ source: '/a', destination: '/b' }])).toThrow(
      /recognizable sheet|refusing to overwrite/i,
    );
  });

  it('preserves an untouched row with an authored link verbatim (no destination loss)', () => {
    const linked = `<body><main><div><table>
  <tr><td>Source</td><td>Destination</td></tr>
  <tr><td>/promo</td><td><a href="https://x.com/deep">https://x.com/deep</a></td></tr>
</table></div></main></body>`;
    const { html } = applyRedirects(linked, [{ source: '/new', destination: '/n' }]);
    expect(html).toContain('href="https://x.com/deep"'); // untouched row's link survives
    expect(parseRedirects(html)).toContainEqual({ source: '/promo', destination: 'https://x.com/deep' });
  });

  it('reads an authored-link destination as its href, not the link text', () => {
    const linked = '<body><table><tr><td>Source</td><td>Destination</td></tr><tr><td>/promo</td><td><a href="https://x.com/deep">go</a></td></tr></table></body>';
    expect(parseRedirects(linked)).toEqual([{ source: '/promo', destination: 'https://x.com/deep' }]);
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
      ...(opts?.withUndo ? { undo: { restore: [], remove: ['/redirects.html'] } } : {}),
    }),
    ...over,
  } as unknown as DaClient;
}
function fakeEds(over: Record<string, unknown> = {}): EdsClient {
  return { previewAndPublish: async () => ({ preview: {}, publish: {} }), ...over } as unknown as EdsClient;
}

describe('handleFixRedirect', () => {
  it('creates the redirects sheet when none exists', async () => {
    const res = await handleFixRedirect(fakeDa(), fakeEds(), {
      redirects: [{ source: '/gone', destination: '/home' }],
    });
    expect(res.content[0].text).toContain('Created the redirects sheet — 1 rule');
  });

  it('dryRun previews the rules and writes nothing', async () => {
    let wrote = false;
    const da = fakeDa({ pushDocuments: async () => { wrote = true; return { succeeded: [], failed: [] }; } });
    const res = await handleFixRedirect(da, fakeEds(), {
      redirects: [{ source: '/gone', destination: '/home' }],
      dryRun: true,
    });
    expect(res.content[0].text).toContain('Dry run — nothing written');
    expect(res.content[0].text).toContain('/gone → /home');
    expect(wrote).toBe(false);
  });

  it('updates an existing sheet and returns an undo handle', async () => {
    const da = fakeDa({
      getSource: async () => ({ path: '/redirects.html', content: SHEET, contentType: 'text/html' }),
    });
    const res = await handleFixRedirect(da, fakeEds(), {
      redirects: [{ source: '/second', destination: '/2' }],
      withUndo: true,
    });
    expect(res.content[0].text).toContain('Updated the redirects sheet — 1 rule');
    expect(res.content[0].text).toContain('eds_da_rollback');
  });

  it('publishes when publish:true', async () => {
    let published = false;
    const eds = fakeEds({ previewAndPublish: async () => { published = true; return { preview: {}, publish: {} }; } });
    const res = await handleFixRedirect(fakeDa(), eds, {
      redirects: [{ source: '/gone', destination: '/home' }],
      publish: true,
    });
    expect(published).toBe(true);
    expect(res.content[0].text).toContain('redirects are live');
  });

  it('reports a no-op when the rule is already present', async () => {
    const da = fakeDa({
      getSource: async () => ({ path: '/redirects.html', content: SHEET, contentType: 'text/html' }),
    });
    const res = await handleFixRedirect(da, fakeEds(), {
      redirects: [{ source: '/old', destination: '/new' }], // already in SHEET
    });
    expect(res.content[0].text).toContain('No redirect changes needed');
  });

  it('always captures undo (a redirect can hide a page, so it must be reversible)', async () => {
    const res = await handleFixRedirect(fakeDa(), fakeEds(), {
      redirects: [{ source: '/gone', destination: '/home' }],
    });
    expect(res.content[0].text).toContain('eds_da_rollback');
  });

  it('surfaces a refusal to edit an unfamiliar sheet via isError', async () => {
    const da = fakeDa({
      getSource: async () => ({ path: '/redirects.html', content: '<body><table><tr><td>Foo</td><td>Bar</td></tr><tr><td>1</td><td>2</td></tr></table></body>', contentType: 'text/html' }),
    });
    const res = await handleFixRedirect(da, fakeEds(), { redirects: [{ source: '/a', destination: '/b' }] });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Source/Destination');
  });
});
