import { describe, it, expect, vi, beforeEach } from 'vitest';
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
    bulkPreview: vi.fn().mockResolvedValue({ succeeded: ['/about', '/blog'], failed: [] }),
    bulkPublish: vi.fn().mockResolvedValue({ succeeded: ['/about'], failed: [] }),
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
  it('handleBulkPreview returns success count', async () => {
    const client = mockClient();
    const result = await handleBulkPreview(client, { paths: ['/about', '/blog'] });
    expect(result.content[0].text).toContain('2 succeeded');
    expect(result.content[0].text).toContain('0 failed');
  });

  it('handleBulkPreview reports failures', async () => {
    const client = mockClient({
      bulkPreview: vi.fn().mockResolvedValue({
        succeeded: ['/about'],
        failed: [{ path: '/missing', error: '404 Not Found' }],
      }),
    });
    const result = await handleBulkPreview(client, { paths: ['/about', '/missing'] });
    expect(result.content[0].text).toContain('1 succeeded');
    expect(result.content[0].text).toContain('1 failed');
    expect(result.content[0].text).toContain('404');
  });

  it('handleBulkPublish returns success count', async () => {
    const client = mockClient();
    const result = await handleBulkPublish(client, { paths: ['/about'] });
    expect(result.content[0].text).toContain('1 succeeded');
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
    const client = new EdsClient({
      owner: 'test',
      repo: 'test',
      domainKey: 'super-secret-domain-key',
    });
    await expect(client.getCwv('example.com')).rejects.toThrow(/REDACTED/);
    await expect(client.getCwv('example.com')).rejects.not.toThrow('super-secret-domain-key');
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
