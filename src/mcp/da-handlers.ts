/**
 * MCP tool handlers for Document Authoring (DA) content access.
 *
 * Each function wraps a {@link DaClient} call and returns the MCP-standard
 * result shape. Mirrors the error-handling convention of the EDS handlers.
 */

import type { DaClient } from '../da-admin/client.js';
import { formatError } from '../utils/errors.js';

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function errorResult(error: unknown) {
  return {
    content: [{ type: 'text' as const, text: `Error: ${formatError(error)}` }],
    isError: true as const,
  };
}

export async function handleDaListSources(
  client: DaClient,
  args: { path?: string },
) {
  try {
    const entries = await client.listSources(args.path);
    if (entries.length === 0) {
      return textResult(`No DA sources found${args.path ? ` under /${args.path}` : ''}.`);
    }
    const lines = [`DA sources: ${entries.length}`, ''];
    for (const e of entries) {
      // Paths are site-relative and already carry a file extension (files) or a
      // trailing slash (folders), so they read cleanly as-is.
      lines.push(`  ${e.path ?? e.name ?? '(unnamed)'}`);
    }
    return textResult(lines.join('\n'));
  } catch (error) {
    return errorResult(error);
  }
}

export async function handleDaGetSource(
  client: DaClient,
  args: { path: string },
) {
  try {
    const source = await client.getSource(args.path);
    return textResult(source.content);
  } catch (error) {
    return errorResult(error);
  }
}

export async function handleDaPutSource(
  client: DaClient,
  args: { path: string; content: string; contentType?: string },
) {
  try {
    const result = await client.putSource(args.path, args.content, args.contentType);
    return textResult(`Saved DA source ${result.path} (status ${result.status}).`);
  } catch (error) {
    return errorResult(error);
  }
}

export async function handleDaDeleteSource(
  client: DaClient,
  args: { path: string },
) {
  try {
    const result = await client.deleteSource(args.path);
    return textResult(`Deleted DA source ${result.path} (status ${result.status}).`);
  } catch (error) {
    return errorResult(error);
  }
}

export async function handleDaCopySource(
  client: DaClient,
  args: { from: string; to: string },
) {
  try {
    const result = await client.copySource(args.from, args.to);
    return textResult(`Copied /${args.from.replace(/^\/+/, '')} → ${result.path} (status ${result.status}).`);
  } catch (error) {
    return errorResult(error);
  }
}

export async function handleDaMoveSource(
  client: DaClient,
  args: { from: string; to: string },
) {
  try {
    const result = await client.moveSource(args.from, args.to);
    return textResult(`Moved /${args.from.replace(/^\/+/, '')} → ${result.path} (status ${result.status}).`);
  } catch (error) {
    return errorResult(error);
  }
}

export async function handleDaGetVersions(
  client: DaClient,
  args: { path: string },
) {
  try {
    const versions = await client.getVersions(args.path);
    if (versions.length === 0) {
      return textResult(`No version history for /${args.path.replace(/^\/+/, '')}.`);
    }
    const lines = [`Versions for /${args.path.replace(/^\/+/, '')}: ${versions.length}`, ''];
    for (const v of versions) {
      const when = v.timestamp !== undefined ? ` (${v.timestamp})` : '';
      const who = v.author ? ` — ${v.author}` : '';
      const label = v.label ? ` "${v.label}"` : '';
      lines.push(`  ${v.path ?? ''}${when}${who}${label}`);
    }
    return textResult(lines.join('\n'));
  } catch (error) {
    return errorResult(error);
  }
}
