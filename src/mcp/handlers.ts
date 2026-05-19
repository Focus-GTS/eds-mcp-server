/**
 * MCP tool handlers for the EDS MCP server.
 *
 * Each exported function corresponds to one registered tool. It receives a
 * shared {@link EdsClient} instance and the validated arguments, then returns
 * the MCP-standard result shape (`content` array with optional `isError`).
 *
 * Error handling follows Adobe's da-mcp convention: every handler wraps its
 * work in try/catch and delegates to {@link formatError} for consistent
 * error messages.
 */

import type { EdsClient } from '../eds-admin/client.js';
import { formatError } from '../utils/errors.js';

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

/** Wrap a string in the MCP text-content result shape. */
function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

/** Wrap an error in the MCP error-result shape. */
function errorResult(error: unknown) {
  return {
    content: [{ type: 'text' as const, text: `Error: ${formatError(error)}` }],
    isError: true as const,
  };
}

// ---------------------------------------------------------------------------
// Publishing tools
// ---------------------------------------------------------------------------

export async function handlePreviewPage(
  client: EdsClient,
  args: { path: string },
) {
  try {
    const result = await client.previewPage(args.path);
    const lines = [
      `Preview triggered for ${result.path}`,
      `Status: ${result.status}`,
      `URL: ${result.resourcePath}`,
    ];
    if (result.links) {
      for (const [rel, href] of Object.entries(result.links)) {
        lines.push(`${rel}: ${href}`);
      }
    }
    return textResult(lines.join('\n'));
  } catch (error) {
    return errorResult(error);
  }
}

export async function handlePublishPage(
  client: EdsClient,
  args: { path: string },
) {
  try {
    const result = await client.publishPage(args.path);
    const lines = [
      `Published ${result.path}`,
      `Status: ${result.status}`,
      `Live URL: ${result.resourcePath}`,
    ];
    if (result.links) {
      for (const [rel, href] of Object.entries(result.links)) {
        lines.push(`${rel}: ${href}`);
      }
    }
    return textResult(lines.join('\n'));
  } catch (error) {
    return errorResult(error);
  }
}

export async function handleUnpublishPage(
  client: EdsClient,
  args: { path: string },
) {
  try {
    const result = await client.unpublishPage(args.path);
    const lines = [
      `Unpublished ${result.path}`,
      `Status: ${result.status}`,
    ];
    return textResult(lines.join('\n'));
  } catch (error) {
    return errorResult(error);
  }
}

export async function handleGetStatus(
  client: EdsClient,
  args: { path: string },
) {
  try {
    const status = await client.getStatus(args.path);
    const lines = [`Status for ${status.path}`, ''];

    lines.push(`Preview: ${status.preview.status}`);
    if (status.preview.url) lines.push(`  URL: ${status.preview.url}`);
    if (status.preview.lastModified) lines.push(`  Modified: ${status.preview.lastModified}`);
    if (status.preview.sourceLocation) lines.push(`  Source: ${status.preview.sourceLocation}`);

    lines.push(`Live: ${status.live.status}`);
    if (status.live.url) lines.push(`  URL: ${status.live.url}`);
    if (status.live.lastModified) lines.push(`  Modified: ${status.live.lastModified}`);

    if (status.code) {
      lines.push(`Code: ${status.code.status}`);
      if (status.code.url) lines.push(`  URL: ${status.code.url}`);
    }

    return textResult(lines.join('\n'));
  } catch (error) {
    return errorResult(error);
  }
}

export async function handlePurgeCache(
  client: EdsClient,
  args: { path: string },
) {
  try {
    const result = await client.purgeCache(args.path);
    const lines = [
      `Cache purged for ${result.path}`,
      `Status: ${result.status}`,
    ];
    if (result.message) {
      lines.push(`Message: ${result.message}`);
    }
    return textResult(lines.join('\n'));
  } catch (error) {
    return errorResult(error);
  }
}

// ---------------------------------------------------------------------------
// Content reading tools
// ---------------------------------------------------------------------------

export async function handleGetPage(
  client: EdsClient,
  args: { path: string },
) {
  try {
    const page = await client.getPageContent(args.path);
    return textResult(page.html);
  } catch (error) {
    return errorResult(error);
  }
}

export async function handleListPages(
  client: EdsClient,
  args: { limit?: number; offset?: number },
) {
  try {
    const index = await client.listPages(args.limit, args.offset);
    const lines = [
      `Pages: ${index.total} total (showing ${index.data.length}, offset ${index.offset})`,
      '',
    ];
    for (const entry of index.data) {
      const modified = new Date(entry.lastModified * 1000).toISOString().slice(0, 10);
      lines.push(`  ${entry.path}  —  ${entry.title}  (${modified})`);
    }
    return textResult(lines.join('\n'));
  } catch (error) {
    return errorResult(error);
  }
}

export async function handleGetMetadata(
  client: EdsClient,
  _args: Record<string, never>,
) {
  try {
    const metadata = await client.getMetadata();
    return textResult(JSON.stringify(metadata, null, 2));
  } catch (error) {
    return errorResult(error);
  }
}

export async function handleGetSitemap(
  client: EdsClient,
  _args: Record<string, never>,
) {
  try {
    const entries = await client.getSitemap();
    const lines = [`Sitemap: ${entries.length} URLs`, ''];
    for (const entry of entries) {
      const mod = entry.lastmod ? `  (${entry.lastmod})` : '';
      lines.push(`  ${entry.loc}${mod}`);
    }
    return textResult(lines.join('\n'));
  } catch (error) {
    return errorResult(error);
  }
}

// ---------------------------------------------------------------------------
// OpTel / analytics tools
// ---------------------------------------------------------------------------

export async function handleGetCwv(
  client: EdsClient,
  args: { domain: string; days?: number },
) {
  try {
    const data = await client.getCwv(args.domain, args.days);

    if (data.length === 0) {
      return textResult('No Core Web Vitals data available for the requested period.');
    }

    // Format as a readable table
    const header = 'URL                                          LCP(ms)  CLS    INP(ms)  TTFB(ms)  Views';
    const separator = '-'.repeat(header.length);
    const rows = data.map((row) => {
      const url = row.url.length > 44 ? `${row.url.slice(0, 41)}...` : row.url.padEnd(44);
      return `${url} ${String(row.lcp).padStart(7)}  ${row.cls.toFixed(3).padStart(5)}  ${String(row.inp).padStart(7)}  ${String(row.ttfb).padStart(8)}  ${String(row.pageViews).padStart(5)}`;
    });

    return textResult([header, separator, ...rows].join('\n'));
  } catch (error) {
    return errorResult(error);
  }
}

export async function handleGet404s(
  client: EdsClient,
  args: { domain: string; days?: number },
) {
  try {
    const entries = await client.get404s(args.domain, args.days);

    if (entries.length === 0) {
      return textResult('No 404 errors found for the requested period.');
    }

    const lines = [`404 Errors: ${entries.length} unique URLs`, ''];
    for (const entry of entries) {
      lines.push(`  ${entry.url}  (${entry.views} hits)`);
      if (entry.sources.length > 0) {
        for (const source of entry.sources) {
          lines.push(`    ← ${source}`);
        }
      }
    }
    return textResult(lines.join('\n'));
  } catch (error) {
    return errorResult(error);
  }
}

export async function handleGetExperiments(
  client: EdsClient,
  args: { domain: string; experiment?: string },
) {
  try {
    const data = await client.getExperiments(args.domain, args.experiment);

    if (data.length === 0) {
      return textResult('No experiment data available.');
    }

    // Group by experiment ID for readability
    const grouped = new Map<string, typeof data>();
    for (const row of data) {
      const group = grouped.get(row.experiment) ?? [];
      group.push(row);
      grouped.set(row.experiment, group);
    }

    const lines: string[] = [];
    for (const [expId, variants] of grouped) {
      lines.push(`Experiment: ${expId}`);
      lines.push('  Variant          Views   Clicks  Converts  Conv%');
      lines.push('  ' + '-'.repeat(56));
      for (const v of variants) {
        const convRate = v.views > 0 ? ((v.converts / v.views) * 100).toFixed(1) : '0.0';
        const name = v.variant.padEnd(16);
        lines.push(
          `  ${name} ${String(v.views).padStart(6)}   ${String(v.clicks).padStart(6)}  ${String(v.converts).padStart(8)}  ${convRate.padStart(5)}%`,
        );
      }
      lines.push('');
    }

    return textResult(lines.join('\n'));
  } catch (error) {
    return errorResult(error);
  }
}

// ---------------------------------------------------------------------------
// Configuration tools
// ---------------------------------------------------------------------------

export async function handleGetConfig(
  client: EdsClient,
  _args: Record<string, never>,
) {
  try {
    const config = await client.getConfig();
    return textResult(JSON.stringify(config, null, 2));
  } catch (error) {
    return errorResult(error);
  }
}

export async function handleGetLogs(
  client: EdsClient,
  args: { limit?: number },
) {
  try {
    const entries = await client.getLogs(args.limit);

    if (entries.length === 0) {
      return textResult('No log entries found.');
    }

    const lines = [`Activity log: ${entries.length} entries`, ''];
    for (const entry of entries) {
      lines.push(`  [${entry.timestamp}] ${entry.action} ${entry.path} — ${entry.user}`);
    }
    return textResult(lines.join('\n'));
  } catch (error) {
    return errorResult(error);
  }
}

export async function handleGetApiKeys(
  client: EdsClient,
  _args: Record<string, never>,
) {
  try {
    const keys = await client.getApiKeys();

    if (keys.length === 0) {
      return textResult('No API keys configured.');
    }

    const lines = [`API Keys: ${keys.length}`, ''];
    for (const key of keys) {
      lines.push(`  ${key.name} (${key.role})  id=${key.id}  created=${key.createdAt}`);
    }
    return textResult(lines.join('\n'));
  } catch (error) {
    return errorResult(error);
  }
}
