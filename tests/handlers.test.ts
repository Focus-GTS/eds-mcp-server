import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  handlePreviewPage,
  handlePublishPage,
  handleUnpublishPage,
  handleGetStatus,
  handlePurgeCache,
  handleGetPage,
  handleListPages,
  handleGetMetadata,
  handleGetSitemap,
  handleGetCwv,
  handleGet404s,
  handleGetExperiments,
  handleGetConfig,
  handleGetLogs,
  handleGetApiKeys,
  handleBulkPreview,
  handleBulkPublish,
  handleGetJobStatus,
  handlePreviewAndPublish,
  handleGetRedirects,
  handleSearchPages,
} from '../src/mcp/handlers.js';
import type { EdsClient } from '../src/eds-admin/client.js';

function mockClient(overrides: Partial<EdsClient> = {}): EdsClient {
  return {
    previewPage: vi.fn().mockResolvedValue({ path: '/about', status: 200, resourcePath: 'https://main--site--org.aem.page/about' }),
    publishPage: vi.fn().mockResolvedValue({ path: '/about', status: 200, resourcePath: 'https://main--site--org.aem.live/about' }),
    unpublishPage: vi.fn().mockResolvedValue({ path: '/about', status: 204 }),
    getStatus: vi.fn().mockResolvedValue({ path: '/about', preview: { status: 200, url: 'https://main--site--org.aem.page/about' }, live: { status: 200, url: 'https://main--site--org.aem.live/about' } }),
    purgeCache: vi.fn().mockResolvedValue({ path: '/about', status: 200, message: 'Purged' }),
    getPageContent: vi.fn().mockResolvedValue({ path: '/about', html: '<h1>About</h1>' }),
    listPages: vi.fn().mockResolvedValue({ total: 1, offset: 0, limit: 100, data: [{ path: '/about', title: 'About', description: 'About page', image: '', lastModified: 1716100000 }] }),
    getMetadata: vi.fn().mockResolvedValue({ title: 'My Site', description: 'A site' }),
    getSitemap: vi.fn().mockResolvedValue([{ loc: 'https://example.com/about', lastmod: '2026-05-19' }]),
    getCwv: vi.fn().mockResolvedValue([{ url: '/about', lcp: 1200, cls: 0.05, inp: 80, ttfb: 300, pageViews: 500 }]),
    get404s: vi.fn().mockResolvedValue([{ url: '/old-page', views: 42, sources: ['https://referrer.com'] }]),
    getExperiments: vi.fn().mockResolvedValue([{ experiment: 'hero-test', variant: 'control', clicks: 100, converts: 10, views: 500 }, { experiment: 'hero-test', variant: 'challenger', clicks: 120, converts: 15, views: 480 }]),
    getConfig: vi.fn().mockResolvedValue({ cdn: { prod: { host: 'example.com' } } }),
    getLogs: vi.fn().mockResolvedValue([{ timestamp: '2026-05-19T10:00:00Z', action: 'publish', path: '/about', user: 'dave@focusgts.com' }]),
    getApiKeys: vi.fn().mockResolvedValue([{ id: 'key-1', name: 'CI Key', role: 'publish', createdAt: '2026-05-01' }]),
    bulkPreview: vi.fn().mockResolvedValue({ topic: 'preview', name: 'job-1', state: 'created', pathCount: 2 }),
    bulkPublish: vi.fn().mockResolvedValue({ topic: 'publish', name: 'job-2', state: 'created', pathCount: 1 }),
    getJobStatus: vi.fn().mockResolvedValue({ topic: 'preview', name: 'job-1', state: 'stopped', progress: { total: 2, processed: 2, failed: 0 } }),
    previewAndPublish: vi.fn().mockResolvedValue({
      preview: { path: '/about', status: 200, resourcePath: 'https://main--site--org.aem.page/about' },
      publish: { path: '/about', status: 200, resourcePath: 'https://main--site--org.aem.live/about' },
    }),
    getRedirects: vi.fn().mockResolvedValue([{ source: '/old', destination: '/new', type: 301 }]),
    searchPages: vi.fn().mockResolvedValue({ total: 1, offset: 0, limit: 20, data: [{ path: '/about', title: 'About', description: 'About page', image: '', lastModified: 1716100000 }] }),
    ...overrides,
  } as unknown as EdsClient;
}

describe('Publishing handlers', () => {
  it('handlePreviewPage returns success', async () => {
    const client = mockClient();
    const result = await handlePreviewPage(client, { path: '/about' });
    expect(result.content[0].text).toContain('Preview triggered');
    expect(result).not.toHaveProperty('isError');
  });

  it('handlePublishPage returns success', async () => {
    const client = mockClient();
    const result = await handlePublishPage(client, { path: '/about' });
    expect(result.content[0].text).toContain('Published');
  });

  it('handleUnpublishPage returns success', async () => {
    const client = mockClient();
    const result = await handleUnpublishPage(client, { path: '/about' });
    expect(result.content[0].text).toContain('Unpublished');
  });

  it('handleGetStatus returns formatted status', async () => {
    const client = mockClient();
    const result = await handleGetStatus(client, { path: '/about' });
    expect(result.content[0].text).toContain('Preview:');
    expect(result.content[0].text).toContain('Live:');
  });

  it('handlePurgeCache returns success', async () => {
    const client = mockClient();
    const result = await handlePurgeCache(client, { path: '/about' });
    expect(result.content[0].text).toContain('Cache purged');
  });

  it('returns error on failure', async () => {
    const client = mockClient({ previewPage: vi.fn().mockRejectedValue(new Error('403 Forbidden')) });
    const result = await handlePreviewPage(client, { path: '/about' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('403');
  });

  it('returns error on path traversal attempt', async () => {
    const client = mockClient({
      previewPage: vi.fn().mockRejectedValue(new Error('Invalid path: traversal segments are not allowed')),
    });
    const result = await handlePreviewPage(client, { path: '/../etc/passwd' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('traversal');
  });
});

describe('Content reading handlers', () => {
  it('handleGetPage returns HTML', async () => {
    const client = mockClient();
    const result = await handleGetPage(client, { path: '/about' });
    expect(result.content[0].text).toContain('<h1>About</h1>');
  });

  it('handleListPages returns formatted list', async () => {
    const client = mockClient();
    const result = await handleListPages(client, {});
    expect(result.content[0].text).toContain('/about');
    expect(result.content[0].text).toContain('About');
  });

  it('handleGetMetadata returns JSON', async () => {
    const client = mockClient();
    const result = await handleGetMetadata(client, {} as Record<string, never>);
    expect(result.content[0].text).toContain('My Site');
  });

  it('handleGetSitemap returns URL list', async () => {
    const client = mockClient();
    const result = await handleGetSitemap(client, {} as Record<string, never>);
    expect(result.content[0].text).toContain('https://example.com/about');
    expect(result.content[0].text).toContain('1 URLs');
  });
});

describe('OpTel handlers', () => {
  it('handleGetCwv returns formatted table', async () => {
    const client = mockClient();
    const result = await handleGetCwv(client, { domain: 'example.com' });
    expect(result.content[0].text).toContain('LCP');
    expect(result.content[0].text).toContain('1200');
  });

  it('handleGetCwv handles empty data', async () => {
    const client = mockClient({ getCwv: vi.fn().mockResolvedValue([]) });
    const result = await handleGetCwv(client, { domain: 'example.com' });
    expect(result.content[0].text).toContain('No Core Web Vitals data');
  });

  it('handleGet404s returns error list', async () => {
    const client = mockClient();
    const result = await handleGet404s(client, { domain: 'example.com' });
    expect(result.content[0].text).toContain('/old-page');
    expect(result.content[0].text).toContain('42 hits');
  });

  it('handleGetExperiments returns grouped variants', async () => {
    const client = mockClient();
    const result = await handleGetExperiments(client, { domain: 'example.com' });
    expect(result.content[0].text).toContain('hero-test');
    expect(result.content[0].text).toContain('control');
    expect(result.content[0].text).toContain('challenger');
  });
});

describe('Configuration handlers', () => {
  it('handleGetConfig returns JSON', async () => {
    const client = mockClient();
    const result = await handleGetConfig(client, {} as Record<string, never>);
    expect(result.content[0].text).toContain('example.com');
  });

  it('handleGetLogs returns formatted entries', async () => {
    const client = mockClient();
    const result = await handleGetLogs(client, {});
    expect(result.content[0].text).toContain('publish');
    expect(result.content[0].text).toContain('dave@focusgts.com');
  });

  it('handleGetApiKeys returns key list', async () => {
    const client = mockClient();
    const result = await handleGetApiKeys(client, {} as Record<string, never>);
    expect(result.content[0].text).toContain('CI Key');
    expect(result.content[0].text).toContain('publish');
  });
});

describe('Bulk operation handlers', () => {
  it('handleBulkPreview starts a job and points at the poll tool', async () => {
    const client = mockClient();
    const result = await handleBulkPreview(client, { paths: ['/about', '/blog'] });
    expect(result).not.toHaveProperty('isError');
    expect(result.content[0].text).toContain('Bulk preview job started');
    expect(result.content[0].text).toContain('2 paths queued');
    expect(result.content[0].text).toContain('preview/job-1');
    expect(result.content[0].text).toContain('eds_get_job_status');
  });

  it('handleBulkPreview forwards forceUpdate to the client', async () => {
    const bulkPreview = vi.fn().mockResolvedValue({ topic: 'preview', name: 'j', state: 'created', pathCount: 1 });
    const client = mockClient({ bulkPreview });
    await handleBulkPreview(client, { paths: ['/about'], forceUpdate: true });
    expect(bulkPreview).toHaveBeenCalledWith(['/about'], { forceUpdate: true });
  });

  it('handleBulkPublish starts a publish job', async () => {
    const client = mockClient();
    const result = await handleBulkPublish(client, { paths: ['/about'] });
    expect(result.content[0].text).toContain('Bulk publish job started');
    expect(result.content[0].text).toContain('publish/job-2');
  });

  it('handleGetJobStatus reports progress and finished state', async () => {
    const client = mockClient();
    const result = await handleGetJobStatus(client, { topic: 'preview', name: 'job-1' });
    expect(result.content[0].text).toContain('state: stopped');
    expect(result.content[0].text).toContain('finished');
    expect(result.content[0].text).toContain('2/2 processed');
  });

  it('handleGetJobStatus shows in-progress jobs with failures', async () => {
    const client = mockClient({
      getJobStatus: vi.fn().mockResolvedValue({
        topic: 'publish', name: 'job-9', state: 'running',
        progress: { total: 10, processed: 4, failed: 1 },
      }),
    });
    const result = await handleGetJobStatus(client, { topic: 'publish', name: 'job-9' });
    expect(result.content[0].text).toContain('in progress');
    expect(result.content[0].text).toContain('4/10 processed');
    expect(result.content[0].text).toContain('1 failed');
  });

  it('handlePreviewAndPublish returns both results', async () => {
    const client = mockClient();
    const result = await handlePreviewAndPublish(client, { path: '/about' });
    expect(result.content[0].text).toContain('Preview + Publish completed');
    expect(result.content[0].text).toContain('aem.page');
    expect(result.content[0].text).toContain('aem.live');
  });
});

describe('Redirects handler', () => {
  it('handleGetRedirects returns formatted table', async () => {
    const client = mockClient({
      getRedirects: vi.fn().mockResolvedValue([
        { source: '/old-page', destination: '/new-page', type: 301 },
        { source: '/legacy', destination: 'https://other.com/page', type: 302 },
      ]),
    });
    const result = await handleGetRedirects(client, {} as Record<string, never>);
    expect(result.content[0].text).toContain('2 rules');
    expect(result.content[0].text).toContain('/old-page');
    expect(result.content[0].text).toContain('301');
  });

  it('handleGetRedirects handles empty', async () => {
    const client = mockClient({ getRedirects: vi.fn().mockResolvedValue([]) });
    const result = await handleGetRedirects(client, {} as Record<string, never>);
    expect(result.content[0].text).toContain('No redirects found');
  });
});

describe('Search handler', () => {
  it('handleSearchPages returns matching pages', async () => {
    const client = mockClient({
      searchPages: vi.fn().mockResolvedValue({
        total: 1,
        offset: 0,
        limit: 20,
        data: [{ path: '/about', title: 'About Us', description: 'Learn about us', image: '', lastModified: 1716100000 }],
      }),
    });
    const result = await handleSearchPages(client, { query: 'about' });
    expect(result.content[0].text).toContain('1 matches');
    expect(result.content[0].text).toContain('About Us');
  });

  it('handleSearchPages handles no results', async () => {
    const client = mockClient({
      searchPages: vi.fn().mockResolvedValue({ total: 0, offset: 0, limit: 20, data: [] }),
    });
    const result = await handleSearchPages(client, { query: 'nonexistent' });
    expect(result.content[0].text).toContain('No pages matching');
  });
});

describe('EdsClient path traversal rejection', () => {
  it('rejects paths containing .. segments', async () => {
    const { EdsClient } = await import('../src/eds-admin/client.js');
    const client = new EdsClient({ owner: 'test', repo: 'test' });
    await expect(client.previewPage('/../etc/passwd')).rejects.toThrow('traversal');
  });

  it('rejects paths containing . segments', async () => {
    const { EdsClient } = await import('../src/eds-admin/client.js');
    const client = new EdsClient({ owner: 'test', repo: 'test' });
    await expect(client.previewPage('/./sneaky')).rejects.toThrow('traversal');
  });

  it('allows normal nested paths', async () => {
    const { EdsClient } = await import('../src/eds-admin/client.js');
    const client = new EdsClient({ owner: 'test', repo: 'test' });
    // This will fail at the fetch level (no real server), but should NOT throw a traversal error
    await expect(client.previewPage('/blog/my-post')).rejects.not.toThrow('traversal');
  });

  it('rejects percent-encoded traversal (%2e%2e) that the URL parser would collapse', async () => {
    const { EdsClient } = await import('../src/eds-admin/client.js');
    const client = new EdsClient({ owner: 'test', repo: 'test' });
    await expect(
      client.unpublishPage('%2e%2e/%2e%2e/%2e%2e/%2e%2e/live/victim/repo/main/x'),
    ).rejects.toThrow('traversal');
  });

  it('rejects backslash-separated traversal segments', async () => {
    const { EdsClient } = await import('../src/eds-admin/client.js');
    const client = new EdsClient({ owner: 'test', repo: 'test' });
    await expect(
      client.unpublishPage('..\\..\\..\\..\\live/victim/repo/main/x'),
    ).rejects.toThrow(/separator|traversal/);
  });
});

describe('EdsClient secret redaction', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('redacts the domain key from error messages on a failed RUM call', async () => {
    const { EdsClient } = await import('../src/eds-admin/client.js');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        headers: new Headers(),
        text: () => Promise.resolve('boom'),
      }),
    );
    const { formatError } = await import('../src/utils/errors.js');
    const client = new EdsClient({
      owner: 'test',
      repo: 'test',
      domainKey: 'super-secret-domain-key',
    });
    const err = await client.getCwv('example.com').catch((e) => e);
    const rendered = formatError(err);
    expect(rendered).toMatch(/REDACTED/);
    expect(rendered).not.toContain('super-secret-domain-key');
    vi.unstubAllGlobals();
  });

  it('scrubs the domain key even when the upstream error body echoes it', async () => {
    const { EdsClient } = await import('../src/eds-admin/client.js');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        headers: new Headers(),
        // Some services reflect the request (including the key) in the error.
        text: () => Promise.resolve('invalid domainkey=super-secret-domain-key'),
      }),
    );
    const client = new EdsClient({
      owner: 'test',
      repo: 'test',
      domainKey: 'super-secret-domain-key',
    });
    await expect(client.getCwv('example.com')).rejects.not.toThrow('super-secret-domain-key');
    vi.unstubAllGlobals();
  });
});

describe('EdsClient bulk job API (wire contract)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('bulkPreview POSTs paths to /preview/{owner}/{repo}/{ref}/* and parses the 202 job', async () => {
    const { EdsClient } = await import('../src/eds-admin/client.js');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({
        status: 202,
        job: { topic: 'preview', name: 'job-abc', state: 'created' },
        links: { self: 'https://admin.hlx.page/job/o/r/main/preview/job-abc' },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new EdsClient({ owner: 'o', repo: 'r', apiKey: 'k' });
    const job = await client.bulkPreview(['/a', '/b'], { forceUpdate: true });

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://admin.hlx.page/preview/o/r/main/*');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ paths: ['/a', '/b'], forceUpdate: true });
    expect(job).toMatchObject({ topic: 'preview', name: 'job-abc', state: 'created', pathCount: 2 });
    vi.unstubAllGlobals();
  });

  it('bulkPublish POSTs to /live/{owner}/{repo}/{ref}/* and reports the publish topic', async () => {
    const { EdsClient } = await import('../src/eds-admin/client.js');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ status: 202, job: { topic: 'publish', name: 'job-9', state: 'created' } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new EdsClient({ owner: 'o', repo: 'r', apiKey: 'k' });
    const job = await client.bulkPublish(['/a']);

    expect(fetchMock.mock.calls[0][0]).toBe('https://admin.hlx.page/live/o/r/main/*');
    expect(job.topic).toBe('publish');
    vi.unstubAllGlobals();
  });

  it('getJobStatus GETs the details endpoint and returns the parsed status', async () => {
    const { EdsClient } = await import('../src/eds-admin/client.js');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({
        topic: 'preview', name: 'job-abc', state: 'stopped',
        progress: { total: 2, processed: 2, failed: 0 },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new EdsClient({ owner: 'o', repo: 'r', apiKey: 'k' });
    const status = await client.getJobStatus('preview', 'job-abc');

    expect(fetchMock.mock.calls[0][0]).toBe('https://admin.hlx.page/job/o/r/main/preview/job-abc/details');
    expect(status.state).toBe('stopped');
    expect(status.progress?.processed).toBe(2);
    vi.unstubAllGlobals();
  });
});

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    headers: new Headers({ 'content-type': 'application/json', ...headers }),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

describe('EdsClient error handling', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it('retries a 429 with backoff, then succeeds', async () => {
    const { EdsClient } = await import('../src/eds-admin/client.js');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 429, statusText: 'Too Many Requests', headers: new Headers({ 'retry-after': '0' }), text: () => Promise.resolve('slow down') })
      .mockResolvedValueOnce(jsonResponse(200, { path: '/about', status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new EdsClient({ owner: 'o', repo: 'r', apiKey: 'k', retryBaseMs: 0 });
    const res = await client.previewPage('/about');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
  });

  it('gives up after maxRetries on persistent 429 with a friendly message', async () => {
    const { EdsClient } = await import('../src/eds-admin/client.js');
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 429, statusText: 'Too Many Requests', headers: new Headers(), text: () => Promise.resolve('') });
    vi.stubGlobal('fetch', fetchMock);

    const client = new EdsClient({ owner: 'o', repo: 'r', apiKey: 'k', retryBaseMs: 0, maxRetries: 2 });
    await expect(client.previewPage('/about')).rejects.toThrow(/Rate limited/);
    expect(fetchMock).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('maps a 401 with EDS_API_KEY to a key-rejected message', async () => {
    const { EdsClient } = await import('../src/eds-admin/client.js');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized', headers: new Headers(), text: () => Promise.resolve('') }));
    const client = new EdsClient({ owner: 'o', repo: 'r', apiKey: 'bad' });
    await expect(client.previewPage('/about')).rejects.toThrow(/EDS_API_KEY was rejected/);
  });

  it('maps 403 and 404 to actionable messages', async () => {
    const { EdsClient } = await import('../src/eds-admin/client.js');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, statusText: 'Forbidden', headers: new Headers(), text: () => Promise.resolve('') }));
    let client = new EdsClient({ owner: 'o', repo: 'r', apiKey: 'k' });
    await expect(client.previewPage('/x')).rejects.toThrow(/Access denied/);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found', headers: new Headers(), text: () => Promise.resolve('') }));
    client = new EdsClient({ owner: 'o', repo: 'r', apiKey: 'k' });
    await expect(client.getStatus('/x')).rejects.toThrow(/Not found/);
  });

  it('getRedirects returns [] on 404 but rethrows other failures', async () => {
    const { EdsClient } = await import('../src/eds-admin/client.js');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found', headers: new Headers(), text: () => Promise.resolve('') }));
    let client = new EdsClient({ owner: 'o', repo: 'r' });
    await expect(client.getRedirects()).resolves.toEqual([]);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'Server Error', headers: new Headers(), text: () => Promise.resolve('boom') }));
    client = new EdsClient({ owner: 'o', repo: 'r' });
    await expect(client.getRedirects()).rejects.toThrow(/500/);
  });
});

describe('EdsClient 401 clears the cached login token', () => {
  let home: string;
  let prevHome: string | undefined;
  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), 'eds-401-'));
    process.env.HOME = home;
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('a cached-token 401 clears the token and asks the user to re-login', async () => {
    const { EdsClient } = await import('../src/eds-admin/client.js');
    const { saveToken, loadToken } = await import('../src/auth/token-store.js');
    saveToken({ token: 'cached', expiresAt: Date.now() + 3_600_000, owner: 'o', repo: 'r', ref: 'main' });
    expect(loadToken()).not.toBeNull();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized', headers: new Headers(), text: () => Promise.resolve('') }));
    const client = new EdsClient({ owner: 'o', repo: 'r' }); // no apiKey → uses cache
    await expect(client.previewPage('/about')).rejects.toThrow(/login/i);
    expect(loadToken()).toBeNull(); // token was cleared
  });
});

describe('searchPages result paging', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it('pages through matches with offset/limit and reports total', async () => {
    const { EdsClient } = await import('../src/eds-admin/client.js');
    const data = [
      { path: '/blog/a', title: 'Blog A', description: '', image: '', lastModified: 1 },
      { path: '/blog/b', title: 'Blog B', description: '', image: '', lastModified: 1 },
      { path: '/blog/c', title: 'Blog C', description: '', image: '', lastModified: 1 },
      { path: '/about', title: 'About', description: '', image: '', lastModified: 1 },
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { total: 4, offset: 0, limit: 5000, data })));
    const client = new EdsClient({ owner: 'o', repo: 'r' });
    const res = await client.searchPages('blog', 2, 1);
    expect(res.total).toBe(3);
    expect(res.offset).toBe(1);
    expect(res.data.map((d) => d.path)).toEqual(['/blog/b', '/blog/c']);
  });

  it('flags truncated when the index reports more rows than were scanned', async () => {
    const { EdsClient } = await import('../src/eds-admin/client.js');
    const data = [{ path: '/a', title: 'a', description: '', image: '', lastModified: 1 }];
    // total (10) > data.length (1) → the scan didn't see everything.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { total: 10, offset: 0, limit: 5000, data })));
    const client = new EdsClient({ owner: 'o', repo: 'r' });
    const res = await client.searchPages('nomatch', 20, 0);
    expect(res.truncated).toBe(true);
  });

  it('does not flag truncated when the whole index was returned', async () => {
    const { EdsClient } = await import('../src/eds-admin/client.js');
    const data = [{ path: '/a', title: 'a', description: '', image: '', lastModified: 1 }];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { total: 1, offset: 0, limit: 5000, data })));
    const client = new EdsClient({ owner: 'o', repo: 'r' });
    const res = await client.searchPages('a', 20, 0);
    expect(res.truncated).toBe(false);
  });
});

describe('bulk path normalization & job-handle safety', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it('makes bulk paths absolute (leading slash) in the request body', async () => {
    const { EdsClient } = await import('../src/eds-admin/client.js');
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(202, { job: { topic: 'publish', name: 'j1', state: 'created' } }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new EdsClient({ owner: 'o', repo: 'r', apiKey: 'k' });
    await client.bulkPublish(['about', 'blog/post', '/already', '//weird']);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.paths).toEqual(['/about', '/blog/post', '/already', '/weird']);
  });

  it('rejects a traversal path in a bulk batch', async () => {
    const { EdsClient } = await import('../src/eds-admin/client.js');
    vi.stubGlobal('fetch', vi.fn());
    const client = new EdsClient({ owner: 'o', repo: 'r', apiKey: 'k' });
    await expect(client.bulkPreview(['a/../b'])).rejects.toThrow(/traversal/);
  });

  it('throws (not a dead-end handle) when a 202 carries no job name', async () => {
    const { EdsClient } = await import('../src/eds-admin/client.js');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(202, { status: 202 })));
    const client = new EdsClient({ owner: 'o', repo: 'r', apiKey: 'k' });
    await expect(client.bulkPublish(['/a'])).rejects.toThrow(/no job handle/i);
  });
});

describe('retry is idempotency-aware (no duplicated writes)', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it('does NOT retry a POST on 503 (could duplicate a bulk publish)', async () => {
    const { EdsClient } = await import('../src/eds-admin/client.js');
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503, statusText: 'Unavailable', headers: new Headers(), text: () => Promise.resolve('') });
    vi.stubGlobal('fetch', fetchMock);
    const client = new EdsClient({ owner: 'o', repo: 'r', apiKey: 'k', retryBaseMs: 0 });
    await expect(client.bulkPublish(['/a'])).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry
  });

  it('DOES retry a GET on 503 (idempotent)', async () => {
    const { EdsClient } = await import('../src/eds-admin/client.js');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503, statusText: 'Unavailable', headers: new Headers(), text: () => Promise.resolve('') })
      .mockResolvedValueOnce(jsonResponse(200, { path: '/a', preview: { status: 200 }, live: { status: 200 } }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new EdsClient({ owner: 'o', repo: 'r', apiKey: 'k', retryBaseMs: 0 });
    await client.getStatus('/a');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('DOES retry a POST on 429 (request was not processed)', async () => {
    const { EdsClient } = await import('../src/eds-admin/client.js');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 429, statusText: 'Too Many', headers: new Headers(), text: () => Promise.resolve('') })
      .mockResolvedValueOnce(jsonResponse(202, { job: { topic: 'publish', name: 'j', state: 'created' } }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new EdsClient({ owner: 'o', repo: 'r', apiKey: 'k', retryBaseMs: 0 });
    await client.bulkPublish(['/a']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('EdsClient read methods (parsing)', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  function textResponse(status: number, body: string, contentType = 'text/plain') {
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: '',
      headers: new Headers({ 'content-type': contentType }),
      text: () => Promise.resolve(body),
      json: () => Promise.resolve(JSON.parse(body)),
    };
  }

  it('getSitemap parses <url>/<loc>/<lastmod> from XML', async () => {
    const { EdsClient } = await import('../src/eds-admin/client.js');
    const xml = '<urlset><url><loc>https://x/a</loc><lastmod>2026-01-01</lastmod></url><url><loc>https://x/b</loc></url></urlset>';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(textResponse(200, xml, 'application/xml')));
    const client = new EdsClient({ owner: 'o', repo: 'r' });
    const entries = await client.getSitemap();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ loc: 'https://x/a', lastmod: '2026-01-01' });
    expect(entries[1]).toEqual({ loc: 'https://x/b' });
  });

  it('getCwv unwraps the { results: { data } } RUM envelope', async () => {
    const { EdsClient } = await import('../src/eds-admin/client.js');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(textResponse(200, JSON.stringify({ results: { data: [{ url: '/a', lcp: 1, cls: 0, inp: 1, ttfb: 1, pageViews: 1 }] } }), 'application/json')));
    const client = new EdsClient({ owner: 'o', repo: 'r' });
    const data = await client.getCwv('example.com');
    expect(data).toHaveLength(1);
    expect(data[0].url).toBe('/a');
  });

  it('getPageContent requests the .plain.html rendition and returns the logical path', async () => {
    const { EdsClient } = await import('../src/eds-admin/client.js');
    const fetchMock = vi.fn().mockResolvedValue(textResponse(200, '<h1>About</h1>', 'text/html'));
    vi.stubGlobal('fetch', fetchMock);
    const client = new EdsClient({ owner: 'o', repo: 'r' });
    const page = await client.getPageContent('/about');
    expect(fetchMock.mock.calls[0][0]).toBe('https://main--r--o.aem.live/about.plain.html');
    expect(page).toEqual({ path: '/about', html: '<h1>About</h1>' });
  });

  it('getPageContent maps the root path to index.plain.html', async () => {
    const { EdsClient } = await import('../src/eds-admin/client.js');
    const fetchMock = vi.fn().mockResolvedValue(textResponse(200, '<h1>Home</h1>', 'text/html'));
    vi.stubGlobal('fetch', fetchMock);
    const client = new EdsClient({ owner: 'o', repo: 'r' });
    await client.getPageContent('/');
    expect(fetchMock.mock.calls[0][0]).toBe('https://main--r--o.aem.live/index.plain.html');
  });

  it('previewAndPublish issues preview then publish', async () => {
    const { EdsClient } = await import('../src/eds-admin/client.js');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(textResponse(200, JSON.stringify({ path: '/a', status: 200, resourcePath: 'p' }), 'application/json'))
      .mockResolvedValueOnce(textResponse(200, JSON.stringify({ path: '/a', status: 200, resourcePath: 'l' }), 'application/json'));
    vi.stubGlobal('fetch', fetchMock);
    const client = new EdsClient({ owner: 'o', repo: 'r', apiKey: 'k' });
    const res = await client.previewAndPublish('/a');
    expect(fetchMock.mock.calls[0][0]).toContain('/preview/o/r/main/a');
    expect(fetchMock.mock.calls[1][0]).toContain('/live/o/r/main/a');
    expect(res.preview.status).toBe(200);
    expect(res.publish.status).toBe(200);
  });

  it('getConfig / getLogs / getApiKeys parse their responses', async () => {
    const { EdsClient } = await import('../src/eds-admin/client.js');
    const client = new EdsClient({ owner: 'o', repo: 'r', apiKey: 'k' });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(textResponse(200, JSON.stringify({ cdn: { prod: {} } }), 'application/json')));
    expect(await client.getConfig()).toHaveProperty('cdn');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(textResponse(200, JSON.stringify([{ timestamp: 't', action: 'publish', path: '/a', user: 'u' }]), 'application/json')));
    expect(await client.getLogs()).toHaveLength(1);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(textResponse(200, JSON.stringify({ data: [{ id: '1', name: 'k', role: 'publish', createdAt: 'd' }] }), 'application/json')));
    expect(await client.getApiKeys()).toHaveLength(1);
  });
});

describe('query-index lastModified in milliseconds', () => {
  it('handleListPages normalizes a millisecond timestamp instead of rendering garbage', async () => {
    const client = mockClient({
      listPages: vi.fn().mockResolvedValue({
        total: 1,
        offset: 0,
        limit: 100,
        // 1767225600000 ms = 2026-01-01; the naive path rendered "+057971-02".
        data: [{ path: '/about', title: 'About', description: '', image: '', lastModified: 1767225600000 }],
      }),
    });
    const result = await handleListPages(client, {});
    expect(result.content[0].text).toContain('2026-01-01');
    expect(result.content[0].text).not.toContain('+0');
  });
});

describe('query-index rows with a missing lastModified', () => {
  it('handleListPages degrades to a dash instead of crashing', async () => {
    const client = mockClient({
      listPages: vi.fn().mockResolvedValue({
        total: 1,
        offset: 0,
        limit: 100,
        // Real sheets frequently omit lastModified — this used to throw RangeError.
        data: [{ path: '/about', title: 'About', description: '', image: '' }],
      }),
    });
    const result = await handleListPages(client, {});
    expect(result).not.toHaveProperty('isError');
    expect(result.content[0].text).toContain('/about');
    expect(result.content[0].text).toContain('—');
  });

  it('handleSearchPages degrades to a dash instead of crashing', async () => {
    const client = mockClient({
      searchPages: vi.fn().mockResolvedValue({
        total: 1,
        offset: 0,
        limit: 20,
        data: [{ path: '/about', title: 'About', description: '', image: '' }],
      }),
    });
    const result = await handleSearchPages(client, { query: 'about' });
    expect(result).not.toHaveProperty('isError');
    expect(result.content[0].text).toContain('/about');
  });
});

describe('204 No Content fallbacks', () => {
  it('handleUnpublishPage names the requested path when the body is empty', async () => {
    const client = mockClient({
      // A 204 response carries no body, so the client returns only { status }.
      unpublishPage: vi.fn().mockResolvedValue({ status: 204 }),
    });
    const result = await handleUnpublishPage(client, { path: '/about' });
    expect(result.content[0].text).toContain('Unpublished /about');
    expect(result.content[0].text).not.toContain('undefined');
  });

  it('handlePurgeCache names the requested path when the body is empty', async () => {
    const client = mockClient({
      purgeCache: vi.fn().mockResolvedValue({ status: 204 }),
    });
    const result = await handlePurgeCache(client, { path: '/about' });
    expect(result.content[0].text).toContain('Cache purged for /about');
    expect(result.content[0].text).not.toContain('undefined');
  });
});
