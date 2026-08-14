import { describe, it, expect } from 'vitest';
import type { DaClient } from '../src/da-admin/client.js';
import type { EdsClient } from '../src/eds-admin/client.js';
import {
  applyMetadata,
  findDivBlock,
  parseMetadataRows,
  buildMetadataBlock,
} from '../src/fix/metadata.js';
import { handleFixMetadata, handleBulkFixMetadata } from '../src/mcp/fix-handlers.js';

// A minimal DA source: content section, no metadata block.
const PAGE = `<body>
  <header></header>
  <main>
    <div>
      <h1>Hello</h1>
      <p>Some content.</p>
    </div>
  </main>
  <footer></footer>
</body>`;

// A DA source that already has a metadata block with a Title row.
const PAGE_WITH_META = `<body>
  <main>
    <div><h1>Hi</h1></div>
    <div class="metadata">
      <div><div><p>Title</p></div><div><p>Old Title</p></div></div>
    </div>
  </main>
</body>`;

// ---------------------------------------------------------------------------
// Core: findDivBlock / parse / build
// ---------------------------------------------------------------------------

describe('findDivBlock (depth-aware)', () => {
  it('captures a block including its nested <div>s', () => {
    const html = `x<div class="metadata"><div><div>a</div><div>b</div></div></div>y`;
    const b = findDivBlock(html, 'metadata')!;
    expect(b).not.toBeNull();
    expect(b.inner).toBe('<div><div>a</div><div>b</div></div>');
    expect(html.slice(b.end)).toBe('y');
  });

  it('returns null when the block is absent', () => {
    expect(findDivBlock('<div class="other"></div>', 'metadata')).toBeNull();
  });
});

describe('parseMetadataRows', () => {
  it('reads key/value rows into a lowercased map, stripping tags', () => {
    const inner =
      '<div><div><p>Title</p></div><div><p>My Title</p></div></div>' +
      '<div><div>Description</div><div>My description</div></div>';
    const map = parseMetadataRows(inner);
    expect(map.get('title')).toBe('My Title');
    expect(map.get('description')).toBe('My description');
  });
});

describe('buildMetadataBlock', () => {
  it('emits the div.metadata shape the pipeline expects and round-trips', () => {
    const block = buildMetadataBlock(new Map([['description', 'Hello world']]));
    expect(block).toMatch(/^<div class="metadata">/);
    expect(block).toContain('<div><p>Description</p></div>');
    // Round-trips through the parser.
    const inner = findDivBlock(block, 'metadata')!.inner;
    expect(parseMetadataRows(inner).get('description')).toBe('Hello world');
  });
});

// ---------------------------------------------------------------------------
// applyMetadata
// ---------------------------------------------------------------------------

describe('applyMetadata', () => {
  it('inserts a new metadata block before </main> when none exists', () => {
    const { html, changes } = applyMetadata(PAGE, { description: 'A helpful description of the page.' });
    expect(changes).toEqual([{ field: 'description', from: null, to: 'A helpful description of the page.' }]);
    expect(html).toContain('<div class="metadata">');
    // Block sits before the closing </main>, content preserved.
    expect(html.indexOf('<div class="metadata">')).toBeLessThan(html.indexOf('</main>'));
    expect(html).toContain('<h1>Hello</h1>');
    // Parsing the result back yields the description.
    expect(parseMetadataRows(findDivBlock(html, 'metadata')!.inner).get('description')).toBe('A helpful description of the page.');
  });

  it('merges into an existing block, preserving untouched rows and never duplicating', () => {
    const { html, changes } = applyMetadata(PAGE_WITH_META, { description: 'New desc' });
    expect(changes).toEqual([{ field: 'description', from: null, to: 'New desc' }]);
    // Exactly one metadata block.
    expect(html.match(/<div class="metadata">/g)).toHaveLength(1);
    const rows = parseMetadataRows(findDivBlock(html, 'metadata')!.inner);
    expect(rows.get('title')).toBe('Old Title'); // preserved
    expect(rows.get('description')).toBe('New desc'); // added
  });

  it('updates an existing field and reports the from → to change', () => {
    const { changes } = applyMetadata(PAGE_WITH_META, { title: 'A Brand New Title For The Page' });
    expect(changes).toEqual([{ field: 'title', from: 'Old Title', to: 'A Brand New Title For The Page' }]);
  });

  it('is idempotent — re-applying the same value is a no-op', () => {
    const first = applyMetadata(PAGE, { description: 'Stable description text.' });
    const second = applyMetadata(first.html, { description: 'Stable description text.' });
    expect(second.changes).toEqual([]);
    expect(second.html).toBe(first.html); // unchanged, returned as-is
  });

  it('escapes HTML in values', () => {
    const { html } = applyMetadata(PAGE, { description: 'A & B <script>' });
    expect(html).toContain('A &amp; B &lt;script&gt;');
  });

  // --- Regression tests for adversarial-review findings ---

  it('preserves an existing <img> Image row when only the description changes (no OG-image loss)', () => {
    const withImg = `<main>
      <div class="metadata">
        <div><div><p>Title</p></div><div><p>Old</p></div></div>
        <div><div><p>Image</p></div><div><img src="./media_abc.png"></div></div>
      </div>
    </main>`;
    const { html, changes } = applyMetadata(withImg, { description: 'A brand new description of the page.' });
    expect(changes.map((c) => c.field)).toEqual(['description']);
    expect(html).toContain('./media_abc.png'); // the image row survived, verbatim
    expect(html.match(/<div class="metadata">/g)).toHaveLength(1);
    const rows = parseMetadataRows(findDivBlock(html, 'metadata')!.inner);
    expect(rows.get('image')).toBe('./media_abc.png');
    expect(rows.get('title')).toBe('Old');
  });

  it('matches a metadata block with a variant class / single quotes / attribute order (no duplicate)', () => {
    for (const open of ['<div class="metadata variant">', "<div class='metadata'>", '<div id="x" class="metadata">']) {
      const html = `<main>${open}<div><div><p>Title</p></div><div><p>Old</p></div></div></div></main>`;
      const { html: out, changes } = applyMetadata(html, { description: 'D' });
      expect(changes).toHaveLength(1);
      // Exactly one metadata block — the existing one was updated in place.
      expect(out.match(/class=["'][^"']*\bmetadata\b/g)).toHaveLength(1);
      expect(out).toContain('Description');
    }
  });

  it('does not match a lookalike class like "metadata-foo"', () => {
    expect(findDivBlock('<div class="metadata-foo"><div>x</div></div>', 'metadata')).toBeNull();
  });

  it('image-alt round-trips and is idempotent (no duplicate rows)', () => {
    const first = applyMetadata(PAGE, { 'image-alt': 'A descriptive hero image' });
    const second = applyMetadata(first.html, { 'image-alt': 'A descriptive hero image' });
    expect(second.changes).toEqual([]);
    expect(second.html).toBe(first.html);
    expect(first.html.match(/Image Alt/g)).toHaveLength(1);
  });

  it('writes the image field as an <img> (what the pipeline reads) and is idempotent', () => {
    const { html } = applyMetadata(PAGE, { image: 'https://example.com/og.png' });
    expect(html).toContain('<img src="https://example.com/og.png">');
    const again = applyMetadata(html, { image: 'https://example.com/og.png' });
    expect(again.changes).toEqual([]); // src compared, not stripped text
  });
});

// ---------------------------------------------------------------------------
// handleFixMetadata
// ---------------------------------------------------------------------------

function fakeDa(over: Record<string, unknown> = {}): DaClient {
  return {
    getSource: async () => ({ path: '/blog/post.html', content: PAGE, contentType: 'text/html' }),
    pushDocuments: async (docs: Array<{ path: string }>, opts?: { withUndo?: boolean }) => ({
      succeeded: docs.map((d) => d.path),
      failed: [],
      ...(opts?.withUndo ? { undo: { restore: [], remove: ['/blog/post.html'] } } : {}),
    }),
    ...over,
  } as unknown as DaClient;
}

function fakeEds(over: Record<string, unknown> = {}): EdsClient {
  return {
    previewAndPublish: async () => ({ preview: { status: 200 }, publish: { status: 200 } }),
    ...over,
  } as unknown as EdsClient;
}

describe('handleFixMetadata', () => {
  it('dryRun shows the before/after and writes nothing', async () => {
    let wrote = false;
    const da = fakeDa({ pushDocuments: async () => { wrote = true; return { succeeded: [], failed: [] }; } });
    const res = await handleFixMetadata(da, fakeEds(), {
      path: '/blog/post',
      metadata: { description: 'A fresh description.' },
      dryRun: true,
    });
    expect(res.content[0].text).toContain('Dry run — nothing written');
    expect(res.content[0].text).toContain('description: (none) → "A fresh description."');
    expect(wrote).toBe(false);
  });

  it('writes via the safe-writes path and returns an undo handle', async () => {
    const res = await handleFixMetadata(fakeDa(), fakeEds(), {
      path: '/blog/post',
      metadata: { description: 'A fresh description.' },
      withUndo: true,
    });
    expect(res.content[0].text).toContain('Updated metadata on /blog/post.html: description');
    expect(res.content[0].text).toContain('eds_da_rollback');
    expect(res.content[0].text).toContain('"remove":["/blog/post.html"]');
  });

  it('publishes when publish:true', async () => {
    let published = false;
    const eds = fakeEds({ previewAndPublish: async () => { published = true; return { preview: {}, publish: {} }; } });
    const res = await handleFixMetadata(fakeDa(), eds, {
      path: '/blog/post',
      metadata: { description: 'A fresh description.' },
      publish: true,
    });
    expect(published).toBe(true);
    expect(res.content[0].text).toContain('the change is live');
  });

  it('reports a no-op when the metadata is already correct', async () => {
    // Source already contains the description we would set.
    const already = applyMetadata(PAGE, { description: 'Already here.' }).html;
    const da = fakeDa({ getSource: async () => ({ path: '/blog/post.html', content: already, contentType: 'text/html' }) });
    const res = await handleFixMetadata(da, fakeEds(), {
      path: '/blog/post',
      metadata: { description: 'Already here.' },
    });
    expect(res.content[0].text).toContain('No metadata changes needed');
  });

  it('surfaces a write failure via isError', async () => {
    const da = fakeDa({ pushDocuments: async (docs: Array<{ path: string }>) => ({ succeeded: [], failed: [{ path: docs[0].path, error: '403 Forbidden' }] }) });
    const res = await handleFixMetadata(da, fakeEds(), {
      path: '/blog/post',
      metadata: { description: 'A fresh description.' },
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('403 Forbidden');
  });
});

// ---------------------------------------------------------------------------
// handleBulkFixMetadata
// ---------------------------------------------------------------------------

// A page that already has the description "Has it" (so a fix to that value is a no-op).
const PAGE_HAS_DESC = applyMetadata(PAGE, { description: 'Has it' }).html;

function bulkDa(over: Record<string, unknown> = {}): DaClient {
  const sources: Record<string, string> = { '/a': PAGE, '/b': PAGE_HAS_DESC };
  return {
    getSource: async (p: string) => {
      const key = p.replace(/\.html$/, '');
      if (key === '/c' || key === 'c') throw new Error('404 not found');
      const content = sources[key] ?? sources['/' + key];
      return { path: `${key.startsWith('/') ? key : '/' + key}.html`, content, contentType: 'text/html' };
    },
    pushDocuments: async (docs: Array<{ path: string }>, opts?: { withUndo?: boolean }) => ({
      succeeded: docs.map((d) => d.path),
      failed: [],
      ...(opts?.withUndo ? { undo: { restore: docs.map((d) => ({ path: d.path, content: 'prior' })), remove: [] } } : {}),
    }),
    ...over,
  } as unknown as DaClient;
}

describe('handleBulkFixMetadata', () => {
  it('changes only the pages that need it and returns ONE undo for the batch', async () => {
    const res = await handleBulkFixMetadata(bulkDa(), fakeEds(), {
      pages: [
        { path: '/a', metadata: { description: 'A new description for page A.' } },
        { path: '/b', metadata: { description: 'Has it' } }, // already correct -> no-op
      ],
    });
    const text = res.content[0].text;
    expect(text).toContain('Fixed 1 page(s) in one batch');
    expect(text).toContain('1 already correct');
    // A single undo object covers the whole batch.
    expect(text).toContain('undo this ENTIRE batch');
    expect((text.match(/"undo":/g) ?? []).length).toBe(1);
  });

  it('dryRun previews the whole plan and writes nothing', async () => {
    let wrote = false;
    const da = bulkDa({ pushDocuments: async () => { wrote = true; return { succeeded: [], failed: [] }; } });
    const res = await handleBulkFixMetadata(da, fakeEds(), {
      pages: [{ path: '/a', metadata: { description: 'X marks the spot on page A here.' } }],
      dryRun: true,
    });
    expect(res.content[0].text).toContain('Dry run — nothing written. 1 page(s) would change');
    expect(wrote).toBe(false);
  });

  it('records unreadable pages without aborting the batch', async () => {
    const res = await handleBulkFixMetadata(bulkDa(), fakeEds(), {
      pages: [
        { path: '/a', metadata: { description: 'A fresh description for A.' } },
        { path: '/c', metadata: { description: 'never read' } }, // getSource throws
      ],
    });
    const text = res.content[0].text;
    expect(text).toContain('Fixed 1 page(s)');
    expect(text).toContain('1 unreadable');
  });

  it('publishes the written pages when publish:true', async () => {
    const publishedPaths: string[] = [];
    const eds = fakeEds({ previewAndPublish: async (p: string) => { publishedPaths.push(p); return { preview: {}, publish: {} }; } });
    const res = await handleBulkFixMetadata(bulkDa(), eds, {
      pages: [{ path: '/a', metadata: { description: 'A description worth publishing now.' } }],
      publish: true,
    });
    expect(publishedPaths).toEqual(['/a']);
    expect(res.content[0].text).toContain('Published 1/1 page(s) live');
  });

  it('reports a clean no-op when every page is already correct', async () => {
    const res = await handleBulkFixMetadata(bulkDa(), fakeEds(), {
      pages: [{ path: '/b', metadata: { description: 'Has it' } }],
    });
    expect(res.content[0].text).toContain('No changes needed');
  });
});
