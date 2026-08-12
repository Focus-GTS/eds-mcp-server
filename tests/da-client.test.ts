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
      { path: '/o/r/blog/drafts/', name: 'drafts' },
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(200, raw)));
    const out = await new DaClient(opts).listSources('blog');
    // A listed path is now site-relative and feeds straight back into get_source.
    expect(out.map((e) => e.path)).toEqual(['/blog/post.html', '/blog/drafts/']);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(200, { sources: raw, path: '/blog' })));
    const wrapped = await new DaClient(opts).listSources('blog');
    expect(wrapped.map((e) => e.path)).toEqual(['/blog/post.html', '/blog/drafts/']);
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
