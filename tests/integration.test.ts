import { describe, it, expect } from 'vitest';
import { EdsClient } from '../src/eds-admin/client.js';

const LIVE = process.env.EDS_INTEGRATION === 'true';

const client = new EdsClient({
  owner: 'adobe',
  repo: 'helix-website',
  ref: 'main',
});

describe.skipIf(!LIVE)('Integration: Public Content APIs', () => {
  it('fetches page content via .plain.html', async () => {
    const page = await client.getPageContent('/');
    expect(page.html).toBeDefined();
    expect(page.html.length).toBeGreaterThan(0);
    expect(page.path).toBe('/');
  }, 15000);

  it('lists pages from query-index.json', async () => {
    const index = await client.listPages(5, 0);
    expect(index.data).toBeDefined();
    expect(Array.isArray(index.data)).toBe(true);
    expect(index.data.length).toBeGreaterThan(0);
    expect(index.data[0]).toHaveProperty('path');
    expect(index.data[0]).toHaveProperty('title');
  }, 15000);

  it('fetches sitemap.xml and parses entries', async () => {
    const entries = await client.getSitemap();
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0]).toHaveProperty('loc');
    expect(entries[0].loc).toMatch(/^https?:\/\//);
  }, 15000);

  it('fetches metadata.json', async () => {
    const metadata = await client.getMetadata();
    expect(metadata).toBeDefined();
    expect(typeof metadata).toBe('object');
  }, 15000);
});

describe.skipIf(!LIVE)('Integration: Admin API (read-only, no auth)', () => {
  it('gets status for a page (may return 401 without key)', async () => {
    try {
      const status = await client.getStatus('/');
      expect(status).toHaveProperty('preview');
      expect(status).toHaveProperty('live');
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      expect(msg).toMatch(/401|403|EDS API error/);
    }
  }, 15000);
});

describe('Integration: MCP Server creation', () => {
  it('creates a server with all 37 tools registered', async () => {
    const { createServer } = await import('../src/mcp/server.js');
    const server = createServer({ owner: 'adobe', repo: 'helix-website' });
    expect(server).toBeDefined();
    // Assert the real registered-tool count so the tool-count claim can't drift.
    const registered = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    const names = Object.keys(registered);
    expect(names).toHaveLength(37);
    // Spot-check that the EDS, DA, audit, and fix tool families are all present.
    expect(names).toContain('eds_publish_page');
    expect(names).toContain('eds_bulk_publish');
    expect(names).toContain('eds_da_get_source');
    expect(names).toContain('eds_da_put_source');
    expect(names).toContain('eds_audit_page');
    expect(names).toContain('eds_audit_site');
    expect(names).toContain('eds_fix_metadata');
    expect(names).toContain('eds_bulk_fix_metadata');
    expect(names).toContain('eds_fix_redirect');
    expect(names).toContain('eds_audit_report');
  });

  it('the library entry (lib.ts) is import-safe and exposes the public API', async () => {
    // Importing the package must NOT start a server or read argv/env — that is
    // the CLI's job (index.ts). lib.ts is the main/types entry.
    const lib = await import('../src/lib.js');
    expect(typeof lib.createServer).toBe('function');
    expect(typeof lib.EdsClient).toBe('function');
    expect(typeof lib.login).toBe('function');
    expect(typeof lib.EdsApiError).toBe('function');
    const server = lib.createServer({ owner: 'o', repo: 'r' });
    expect(server).toBeDefined();
  });
});
