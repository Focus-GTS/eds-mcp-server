import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DaClient } from '../src/da-admin/client.js';
import {
  handleDaListSources,
  handleDaGetSource,
  handleDaPutSource,
  handleDaDeleteSource,
  handleDaCopySource,
  handleDaMoveSource,
  handleDaGetVersions,
  handleDaExport,
  handleDaPush,
  handleDaRollback,
} from '../src/mcp/da-handlers.js';

function jsonRes(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    headers: new Headers({ 'content-type': 'application/json', ...headers }),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  };
}
function textRes(status: number, body: string, ct = 'text/html') {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    headers: new Headers({ 'content-type': ct }),
    text: () => Promise.resolve(body),
    json: () => Promise.resolve(JSON.parse(body)),
  };
}

const opts = { token: 'da-token', org: 'o', repo: 'r' };

describe('DaClient wire contract (admin.da.live)', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it('sends the bearer token and x-da-initiator header, never the token in the URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(textRes(200, '<h1>hi</h1>'));
    vi.stubGlobal('fetch', fetchMock);
    await new DaClient(opts).getSource('index');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://admin.da.live/source/o/r/index.html'); // .html assumed
    const headers = init.headers as Headers;
    expect(headers.get('authorization')).toBe('Bearer da-token');
    expect(headers.get('x-da-initiator')).toBe('mcp');
    expect(String(url)).not.toContain('da-token');
  });

  it('getSource returns raw content + logical path (.html appended)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(textRes(200, '<h1>About</h1>')));
    const src = await new DaClient(opts).getSource('blog/post');
    expect(src).toEqual({ path: '/blog/post.html', content: '<h1>About</h1>', contentType: 'text/html' });
  });

  it('preserves an explicit extension instead of appending .html', async () => {
    const fetchMock = vi.fn().mockResolvedValue(textRes(200, '{}', 'application/json'));
    vi.stubGlobal('fetch', fetchMock);
    await new DaClient(opts).getSource('config/data.json');
    expect(fetchMock.mock.calls[0][0]).toBe('https://admin.da.live/source/o/r/config/data.json');
  });

  it('listSources GETs /list, strips the /{org}/{repo} prefix, and handles both shapes', async () => {
    const raw = [
      { path: '/o/r/blog/post.html', name: 'post.html', ext: 'html' },
      { path: '/o/r/blog/drafts', name: 'drafts' },
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(200, raw)));
    const out = await new DaClient(opts).listSources('blog');
    // A listed path is now site-relative and feeds straight back into get_source.
    expect(out.map((e) => e.path)).toEqual(['/blog/post.html', '/blog/drafts']);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(200, { sources: raw, path: '/blog' })));
    const wrapped = await new DaClient(opts).listSources('blog');
    expect(wrapped.map((e) => e.path)).toEqual(['/blog/post.html', '/blog/drafts']);
  });

  it('listSources follows the da-continuation-token across pages (no silent truncation)', async () => {
    const { DaClient } = await import('../src/da-admin/client.js');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonRes(200, [{ path: '/o/r/blog/a.html', name: 'a.html', ext: 'html' }], { 'da-continuation-token': 'tok2' }))
      .mockResolvedValueOnce(jsonRes(200, [{ path: '/o/r/blog/b.html', name: 'b.html', ext: 'html' }])); // no token → last page
    vi.stubGlobal('fetch', fetchMock);
    const out = await new DaClient(opts).listSources('blog');
    expect(out.map((e) => e.path)).toEqual(['/blog/a.html', '/blog/b.html']); // both pages
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The 2nd request carried the continuation token from the 1st response.
    expect((fetchMock.mock.calls[1][1].headers as Headers).get('da-continuation-token')).toBe('tok2');
  });

  it('putSource POSTs multipart form-data to /source with the content', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes(201, {}));
    vi.stubGlobal('fetch', fetchMock);
    const res = await new DaClient(opts).putSource('blog/post', '<h1>x</h1>');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://admin.da.live/source/o/r/blog/post.html'); // .html assumed
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).has('data')).toBe(true);
    expect(res).toEqual({ status: 201, path: '/blog/post.html' });
  });

  it('deleteSource DELETEs /source', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes(200, {}));
    vi.stubGlobal('fetch', fetchMock);
    await new DaClient(opts).deleteSource('old');
    expect(fetchMock.mock.calls[0][0]).toBe('https://admin.da.live/source/o/r/old.html');
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');
  });

  it('copySource POSTs /copy with an absolute .html destination', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes(200, {}));
    vi.stubGlobal('fetch', fetchMock);
    await new DaClient(opts).copySource('a', 'b');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://admin.da.live/copy/o/r/a.html');
    expect((init.body as FormData).get('destination')).toBe('/o/r/b.html');
  });

  it('moveSource POSTs /move', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes(200, {}));
    vi.stubGlobal('fetch', fetchMock);
    await new DaClient(opts).moveSource('a', 'b');
    expect(fetchMock.mock.calls[0][0]).toBe('https://admin.da.live/move/o/r/a.html');
  });

  it('getVersions GETs /versionlist and parses the real bare-array shape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(200, [{ path: 'v1', author: 'me' }])));
    const versions = await new DaClient(opts).getVersions('index');
    expect(versions).toHaveLength(1);
  });

  it('rejects traversal paths', async () => {
    vi.stubGlobal('fetch', vi.fn());
    await expect(new DaClient(opts).getSource('a/../b')).rejects.toThrow(/traversal/);
  });
});

describe('DaClient auth + errors', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it('without a token, throws the friendly "set EDS_DA_TOKEN" message and never calls fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = new DaClient({ org: 'o', repo: 'r' }); // no token
    expect(client.hasToken).toBe(false);
    await expect(client.getSource('index')).rejects.toThrow(/EDS_DA_TOKEN/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps 404 and 403 to actionable messages', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found', headers: new Headers(), text: () => Promise.resolve('') }));
    await expect(new DaClient(opts).getSource('nope')).rejects.toThrow(/not found/i);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, statusText: 'Forbidden', headers: new Headers(), text: () => Promise.resolve('') }));
    await expect(new DaClient(opts).getSource('secret')).rejects.toThrow(/Access denied/);
  });

  it('retries a 429 then succeeds (GET)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 429, statusText: 'Too Many', headers: new Headers({ 'retry-after': '0' }), text: () => Promise.resolve('') })
      .mockResolvedValueOnce(textRes(200, '<h1>ok</h1>'));
    vi.stubGlobal('fetch', fetchMock);
    await new DaClient({ ...opts, retryBaseMs: 0 }).getSource('index');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a POST on 503 (avoid duplicate writes)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503, statusText: 'Unavailable', headers: new Headers(), text: () => Promise.resolve('') });
    vi.stubGlobal('fetch', fetchMock);
    await expect(new DaClient({ ...opts, retryBaseMs: 0 }).putSource('a', 'x')).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('DA bulk export/push (agent-native clone model)', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  // Route fetch by URL so we can simulate the recursive list + get fan-out.
  function router(map: Record<string, () => ReturnType<typeof jsonRes>>) {
    return vi.fn((url: unknown) => {
      const key = String(url);
      const make = map[key];
      if (make) return Promise.resolve(make());
      return Promise.resolve({ ok: false, status: 404, statusText: 'Not Found', headers: new Headers(), text: () => Promise.resolve('') });
    });
  }

  it('exportTree recurses into folders and fetches every source in one call', async () => {
    const { DaClient } = await import('../src/da-admin/client.js');
    vi.stubGlobal('fetch', router({
      'https://admin.da.live/list/o/r/blog': () => jsonRes(200, [
        { path: '/o/r/blog/a.html', name: 'a.html', ext: 'html' },
        { path: '/o/r/blog/sub', name: 'sub' }, // real DA folder: no ext, no trailing slash
      ]),
      'https://admin.da.live/list/o/r/blog/sub': () => jsonRes(200, [
        { path: '/o/r/blog/sub/c.html', name: 'c.html', ext: 'html' },
      ]),
      'https://admin.da.live/source/o/r/blog/a.html': () => textRes(200, '<h1>a</h1>'),
      'https://admin.da.live/source/o/r/blog/sub/c.html': () => textRes(200, '<h1>c</h1>'),
    }));
    const result = await new DaClient(opts).exportTree('blog');
    expect(result.fileCount).toBe(2);
    expect(result.documents.map((d) => d.path).sort()).toEqual(['/blog/a.html', '/blog/sub/c.html']);
    expect(result.documents.find((d) => d.path === '/blog/a.html')?.content).toBe('<h1>a</h1>');
    expect(result.truncated).toBe(false);
    expect(result.failed).toEqual([]);
  });

  it('exportTree honors maxFiles and flags truncation', async () => {
    const { DaClient } = await import('../src/da-admin/client.js');
    vi.stubGlobal('fetch', router({
      'https://admin.da.live/list/o/r/blog': () => jsonRes(200, [
        { path: '/o/r/blog/a.html', ext: 'html' },
        { path: '/o/r/blog/b.html', ext: 'html' },
        { path: '/o/r/blog/c.html', ext: 'html' },
      ]),
      'https://admin.da.live/source/o/r/blog/a.html': () => textRes(200, 'a'),
      'https://admin.da.live/source/o/r/blog/b.html': () => textRes(200, 'b'),
      'https://admin.da.live/source/o/r/blog/c.html': () => textRes(200, 'c'),
    }));
    const result = await new DaClient(opts).exportTree('blog', { maxFiles: 2 });
    expect(result.fileCount).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it('exportTree records a file that fails to fetch instead of dropping it', async () => {
    const { DaClient } = await import('../src/da-admin/client.js');
    vi.stubGlobal('fetch', router({
      'https://admin.da.live/list/o/r/blog': () => jsonRes(200, [
        { path: '/o/r/blog/ok.html', ext: 'html' },
        { path: '/o/r/blog/bad.html', ext: 'html' },
      ]),
      'https://admin.da.live/source/o/r/blog/ok.html': () => textRes(200, '<h1>ok</h1>'),
      // bad.html falls through to the 404 default
    }));
    const result = await new DaClient(opts).exportTree('blog');
    expect(result.documents.map((d) => d.path)).toEqual(['/blog/ok.html']);
    expect(result.failed.map((f) => f.path)).toEqual(['/blog/bad.html']);
  });

  it('pushDocuments writes a batch and reports succeeded/failed', async () => {
    const { DaClient } = await import('../src/da-admin/client.js');
    vi.stubGlobal('fetch', router({
      'https://admin.da.live/source/o/r/good.html': () => jsonRes(200, {}),
      // bad.html → 404 default (failure)
    }));
    const result = await new DaClient(opts).pushDocuments([
      { path: 'good', content: '<p>g</p>' },
      { path: 'bad', content: '<p>b</p>' },
    ]);
    expect(result.succeeded).toEqual(['good']);
    expect(result.failed.map((f) => f.path)).toEqual(['bad']);
  });

  it('a folder that fails to list is recorded, not fatal (C1)', async () => {
    const { DaClient } = await import('../src/da-admin/client.js');
    vi.stubGlobal('fetch', router({
      'https://admin.da.live/list/o/r/blog': () => jsonRes(200, [
        { path: '/o/r/blog/a.html', name: 'a.html', ext: 'html' },
        { path: '/o/r/blog/private', name: 'private' }, // folder: no ext
      ]),
      'https://admin.da.live/list/o/r/blog/private': () => jsonRes(403, {}), // 403 → throws
      'https://admin.da.live/source/o/r/blog/a.html': () => textRes(200, '<h1>a</h1>'),
    }));
    const result = await new DaClient(opts).exportTree('blog');
    expect(result.documents.map((d) => d.path)).toEqual(['/blog/a.html']); // still returned
    expect(result.failed.map((f) => f.path)).toEqual(['/blog/private']); // recorded, not dropped
  });

  it('does not escape the subtree or double-count a repeated/foreign folder (C2)', async () => {
    const { DaClient } = await import('../src/da-admin/client.js');
    const fetchMock = router({
      'https://admin.da.live/list/o/r/blog': () => jsonRes(200, [
        { path: '/o/r/blog/a.html', name: 'a.html', ext: 'html' },
        { path: '/o/r/blog/sub', name: 'sub' }, // in-tree folder (no ext)
        { path: '/o/r/other', name: 'other' }, // OUT of subtree — must not be walked
        { path: '/o/r/blog/sub', name: 'sub' }, // duplicate — must not double-walk
      ]),
      'https://admin.da.live/list/o/r/blog/sub': () => jsonRes(200, [{ path: '/o/r/blog/sub/c.html', name: 'c.html', ext: 'html' }]),
      'https://admin.da.live/source/o/r/blog/a.html': () => textRes(200, 'a'),
      'https://admin.da.live/source/o/r/blog/sub/c.html': () => textRes(200, 'c'),
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await new DaClient(opts).exportTree('blog');
    expect(result.documents.map((d) => d.path).sort()).toEqual(['/blog/a.html', '/blog/sub/c.html']);
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).not.toContain('https://admin.da.live/list/o/r/other'); // never escaped the subtree
    expect(urls.filter((u) => u === 'https://admin.da.live/list/o/r/blog/sub')).toHaveLength(1); // walked once
  });

  it('handleDaExport bounds the response size and lists omitted docs (C4)', async () => {
    const { DaClient } = await import('../src/da-admin/client.js');
    const big = 'x'.repeat(300_000);
    vi.stubGlobal('fetch', router({
      'https://admin.da.live/list/o/r/blog': () => jsonRes(200, [
        { path: '/o/r/blog/1.html', ext: 'html' },
        { path: '/o/r/blog/2.html', ext: 'html' },
        { path: '/o/r/blog/3.html', ext: 'html' },
        { path: '/o/r/blog/4.html', ext: 'html' },
      ]),
      'https://admin.da.live/source/o/r/blog/1.html': () => textRes(200, big),
      'https://admin.da.live/source/o/r/blog/2.html': () => textRes(200, big),
      'https://admin.da.live/source/o/r/blog/3.html': () => textRes(200, big),
      'https://admin.da.live/source/o/r/blog/4.html': () => textRes(200, big),
    }));
    const result = await handleDaExport(new DaClient(opts), { path: 'blog' });
    expect(result.content[0].text.length).toBeLessThan(1_000_000); // 4×300KB would be 1.2MB
    expect(result.content[0].text).toContain('omitted from this response');
  });

  it('handleDaExport delimits each document by path', async () => {
    const { DaClient } = await import('../src/da-admin/client.js');
    vi.stubGlobal('fetch', router({
      'https://admin.da.live/list/o/r/blog': () => jsonRes(200, [{ path: '/o/r/blog/a.html', ext: 'html' }]),
      'https://admin.da.live/source/o/r/blog/a.html': () => textRes(200, '<h1>a</h1>'),
    }));
    const result = await handleDaExport(new DaClient(opts), { path: 'blog' });
    expect(result.content[0].text).toContain('Exported 1 document');
    expect(result.content[0].text).toContain('=== /blog/a.html ===');
    expect(result.content[0].text).toContain('<h1>a</h1>');
  });

  it('handleDaPush summarizes the batch result', async () => {
    const { DaClient } = await import('../src/da-admin/client.js');
    vi.stubGlobal('fetch', router({
      'https://admin.da.live/source/o/r/x.html': () => jsonRes(200, {}),
    }));
    const result = await handleDaPush(new DaClient(opts), { documents: [{ path: 'x', content: '<p>x</p>' }] });
    expect(result.content[0].text).toContain('Pushed 1 document');
  });
});

describe('DA handlers', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it('handleDaGetSource returns the source content', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(textRes(200, '<h1>Doc</h1>')));
    const result = await handleDaGetSource(new DaClient(opts), { path: 'index' });
    expect(result.content[0].text).toBe('<h1>Doc</h1>');
  });

  it('handleDaListSources formats the listing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(200, [{ path: '/a', ext: 'html' }, { path: '/blog', name: 'blog' }])));
    const result = await handleDaListSources(new DaClient(opts), {});
    expect(result.content[0].text).toContain('DA sources: 2');
  });

  it('handleDaPutSource confirms the save', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(200, {})));
    const result = await handleDaPutSource(new DaClient(opts), { path: 'blog/x', content: '<p>hi</p>' });
    expect(result.content[0].text).toContain('Saved DA source /blog/x');
  });

  it('handleDaDeleteSource / copy / move / versions produce readable output', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(200, {})));
    const del = await handleDaDeleteSource(new DaClient(opts), { path: 'old' });
    expect(del.content[0].text).toContain('Deleted DA source /old');
    const cp = await handleDaCopySource(new DaClient(opts), { from: 'a', to: 'b' });
    expect(cp.content[0].text).toContain('Copied /a → /b');
    const mv = await handleDaMoveSource(new DaClient(opts), { from: 'a', to: 'b' });
    expect(mv.content[0].text).toContain('Moved /a → /b');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(200, { versions: [{ path: 'v1', author: 'me' }] })));
    const ver = await handleDaGetVersions(new DaClient(opts), { path: 'index' });
    expect(ver.content[0].text).toContain('Versions for /index: 1');
  });

  it('a DA handler surfaces the missing-token error via isError', async () => {
    const result = await handleDaGetSource(new DaClient({ org: 'o', repo: 'r' }), { path: 'index' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('EDS_DA_TOKEN');
  });
});

describe('DA safe writes (dry-run preview + rollback)', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  // Route by method+URL so we can distinguish the GET (read prior state) from the
  // PUT/DELETE (the write) that a safe-write cycle makes against the same path.
  function methodRouter(map: Record<string, () => ReturnType<typeof jsonRes>>) {
    return vi.fn((url: unknown, init?: { method?: string }) => {
      const key = `${(init?.method ?? 'GET').toUpperCase()} ${String(url)}`;
      const make = map[key];
      if (make) return Promise.resolve(make());
      return Promise.resolve({ ok: false, status: 404, statusText: 'Not Found', headers: new Headers(), text: () => Promise.resolve('') });
    });
  }

  it('previewPush classifies create / update / unchanged with line counts, writing nothing', async () => {
    const fetchMock = methodRouter({
      // exists, different content → update (+1 line: <p>b</p> added, <p>a</p> removed)
      'GET https://admin.da.live/source/o/r/edit.html': () => textRes(200, '<p>a</p>'),
      // exists, identical content → unchanged
      'GET https://admin.da.live/source/o/r/same.html': () => textRes(200, '<p>same</p>'),
      // 'new.html' GET falls through to 404 default → create
    });
    vi.stubGlobal('fetch', fetchMock);
    const preview = await new DaClient(opts).previewPush([
      { path: 'edit', content: '<p>b</p>' },
      { path: 'same', content: '<p>same</p>' },
      { path: 'new', content: '<p>new</p>' },
    ]);
    expect(preview.summary).toEqual({ create: 1, update: 1, unchanged: 1 });
    const byAction = Object.fromEntries(preview.plan.map((e) => [e.action, e]));
    expect(byAction.create.path).toBe('/new.html');
    expect(byAction.unchanged.path).toBe('/same.html');
    expect(byAction.update).toMatchObject({ path: '/edit.html', changes: { added: 1, removed: 1 } });
    // Read-only: no PUT/DELETE was issued.
    const writes = fetchMock.mock.calls.filter((c) => ['POST', 'DELETE'].includes((c[1]?.method ?? 'GET').toUpperCase()));
    expect(writes).toHaveLength(0);
  });

  it('pushDocuments withUndo captures prior state (restore for updates, remove for creates)', async () => {
    const fetchMock = methodRouter({
      'GET https://admin.da.live/source/o/r/edit.html': () => textRes(200, '<p>old</p>'),
      // 'new.html' GET → 404 (create)
      'POST https://admin.da.live/source/o/r/edit.html': () => jsonRes(200, {}),
      'POST https://admin.da.live/source/o/r/new.html': () => jsonRes(200, {}),
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await new DaClient(opts).pushDocuments(
      [
        { path: 'edit', content: '<p>new content</p>' },
        { path: 'new', content: '<p>fresh</p>' },
      ],
      { withUndo: true },
    );
    expect(result.succeeded.sort()).toEqual(['edit', 'new']);
    expect(result.undo).toBeDefined();
    expect(result.undo?.restore).toEqual([{ path: '/edit.html', content: '<p>old</p>', contentType: 'text/html' }]);
    expect(result.undo?.remove).toEqual(['/new.html']);
  });

  it('rollback restores updated docs and deletes created docs', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn((url: unknown, init?: { method?: string }) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push(`${method} ${String(url)}`);
      return Promise.resolve(jsonRes(200, {}));
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await new DaClient(opts).rollback({
      restore: [{ path: '/edit.html', content: '<p>old</p>', contentType: 'text/html' }],
      remove: ['/new.html'],
    });
    expect(result.failed).toEqual([]);
    expect(result.succeeded).toEqual(['/edit.html', '/new.html']);
    expect(calls).toContain('POST https://admin.da.live/source/o/r/edit.html'); // restored prior content
    expect(calls).toContain('DELETE https://admin.da.live/source/o/r/new.html'); // deleted the created doc
  });

  it('a full preview → push withUndo → rollback cycle restores the EXACT prior content', async () => {
    // Mutable in-memory store that persists the ACTUAL written bytes, so a
    // faithful restore is genuinely verifiable end-to-end (not a marker).
    const store = new Map<string, string>([['edit.html', '<p>original</p>']]);
    const fetchMock = vi.fn(async (url: unknown, init?: { method?: string; body?: unknown }) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      const file = String(url).replace('https://admin.da.live/source/o/r/', '');
      if (method === 'GET') {
        return store.has(file) ? textRes(200, store.get(file)!) : { ok: false, status: 404, statusText: 'NF', headers: new Headers(), text: () => Promise.resolve('') };
      }
      if (method === 'POST') {
        const data = (init?.body as FormData | undefined)?.get('data');
        store.set(file, data instanceof Blob ? await data.text() : String(data ?? ''));
        return jsonRes(200, {});
      }
      if (method === 'DELETE') { store.delete(file); return jsonRes(200, {}); }
      return jsonRes(200, {});
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new DaClient(opts);
    const docs = [
      { path: 'edit', content: '<p>changed</p>' },
      { path: 'new', content: '<p>brand new</p>' },
    ];
    const preview = await client.previewPush(docs);
    expect(preview.summary).toEqual({ create: 1, update: 1, unchanged: 0 });
    const push = await client.pushDocuments(docs, { withUndo: true });
    expect(store.get('edit.html')).toBe('<p>changed</p>'); // update applied live
    expect(store.get('new.html')).toBe('<p>brand new</p>'); // create applied live
    // Roll back using the undo object EXACTLY as returned — no hand-editing.
    await client.rollback(push.undo!);
    expect(store.get('edit.html')).toBe('<p>original</p>'); // faithfully restored
    expect(store.has('new.html')).toBe(false); // created doc removed
  });

  it('withUndo: a FAILED write is never recorded in undo (no phantom rollback target)', async () => {
    // The create's write fails (403). Its path must NOT land in undo.remove —
    // else a later rollback would delete a doc this push never created.
    const fetchMock = methodRouter({
      // GET new.html → 404 default (create); its POST fails:
      'POST https://admin.da.live/source/o/r/new.html': () => ({ ok: false, status: 403, statusText: 'Forbidden', headers: new Headers(), text: () => Promise.resolve('') }) as ReturnType<typeof jsonRes>,
      // a sibling update that DOES succeed, to prove good entries are still captured:
      'GET https://admin.da.live/source/o/r/edit.html': () => textRes(200, '<p>old</p>'),
      'POST https://admin.da.live/source/o/r/edit.html': () => jsonRes(200, {}),
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await new DaClient(opts).pushDocuments(
      [{ path: 'new', content: '<p>n</p>' }, { path: 'edit', content: '<p>changed</p>' }],
      { withUndo: true },
    );
    expect(result.failed.map((f) => f.path)).toEqual(['new']);
    expect(result.succeeded).toEqual(['edit']);
    expect(result.undo?.remove).toEqual([]); // the failed create is NOT a rollback target
    expect(result.undo?.restore).toEqual([{ path: '/edit.html', content: '<p>old</p>', contentType: 'text/html' }]);
  });

  it('withUndo: an unchanged doc is skipped — no write, no undo entry', async () => {
    const fetchMock = methodRouter({
      'GET https://admin.da.live/source/o/r/same.html': () => textRes(200, '<p>same</p>'),
      // POST same.html intentionally unmapped → would 404 if a write were attempted.
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await new DaClient(opts).pushDocuments(
      [{ path: 'same', content: '<p>same</p>' }],
      { withUndo: true },
    );
    expect(result.succeeded).toEqual(['same']); // already in desired state
    expect(result.failed).toEqual([]);
    expect(result.undo?.restore).toEqual([]);
    expect(result.undo?.remove).toEqual([]);
    const writes = fetchMock.mock.calls.filter((c) => (c[1]?.method ?? 'GET').toUpperCase() === 'POST');
    expect(writes).toHaveLength(0); // no spurious version written
  });

  it('handleDaPush dryRun previews without writing and formats the plan', async () => {
    const fetchMock = vi.fn((url: unknown, init?: { method?: string }) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method !== 'GET') throw new Error('dry run must not write');
      return Promise.resolve(String(url).includes('edit') ? textRes(200, '<p>a</p>') : { ok: false, status: 404, statusText: 'NF', headers: new Headers(), text: () => Promise.resolve('') });
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await handleDaPush(new DaClient(opts), {
      documents: [{ path: 'edit', content: '<p>b</p>' }, { path: 'new', content: '<p>n</p>' }],
      dryRun: true,
    });
    expect(result.content[0].text).toContain('Dry run — nothing was written');
    expect(result.content[0].text).toContain('1 create, 1 update');
    expect(result.content[0].text).toMatch(/CREATE\s+\/new\.html/);
    expect(result.content[0].text).toMatch(/UPDATE\s+\/edit\.html/);
  });

  it('handleDaPush withUndo appends the undo object for eds_da_rollback', async () => {
    vi.stubGlobal('fetch', methodRouter({
      'POST https://admin.da.live/source/o/r/new.html': () => jsonRes(200, {}),
      // GET new.html → 404 (create → remove list)
    }));
    const result = await handleDaPush(new DaClient(opts), {
      documents: [{ path: 'new', content: '<p>n</p>' }],
      withUndo: true,
    });
    expect(result.content[0].text).toContain('eds_da_rollback');
    expect(result.content[0].text).toContain('"remove":["/new.html"]');
  });

  it('handleDaRollback reports what was restored/removed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(200, {})));
    const result = await handleDaRollback(new DaClient(opts), {
      undo: { restore: [{ path: '/edit.html', content: '<p>old</p>' }], remove: ['/new.html'] },
    });
    expect(result.content[0].text).toContain('Rolled back: 2 restored/removed; 0 failed');
  });
});
