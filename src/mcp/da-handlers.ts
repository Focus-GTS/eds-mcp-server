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
      const p = e.path ?? e.name ?? '(unnamed)';
      // DA folders have no extension; mark them with a trailing slash so the
      // listing distinguishes folders from files at a glance.
      const isFolder = !e.ext && !/\.[^/]+$/.test(p);
      lines.push(`  ${p}${isFolder && !p.endsWith('/') ? '/' : ''}`);
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

export async function handleDaExport(
  client: DaClient,
  args: { path: string; maxFiles?: number },
) {
  try {
    const result = await client.exportTree(args.path, { maxFiles: args.maxFiles });
    const root = `/${args.path.replace(/^\/+/, '')}`;
    if (result.documents.length === 0 && result.failed.length === 0 && !result.truncated) {
      return textResult(`No documents found under ${root}.`);
    }
    const header = [
      `Exported ${result.documents.length} document${result.documents.length === 1 ? '' : 's'} from ${root}.`,
    ];
    if (result.truncated) {
      header.push(`(May be incomplete — hit the maxFiles cap with folders left. Narrow the path or raise maxFiles.)`);
    }
    if (result.failed.length > 0) {
      header.push(`(${result.failed.length} item(s) could not be read: ${result.failed.map((f) => f.path).join(', ')})`);
    }

    // Bound the response size: inline document content up to a byte budget, then
    // list the remaining paths so the agent knows they exist (fetch individually).
    const MAX_OUTPUT_CHARS = 800_000;
    const blocks: string[] = [];
    const omitted: string[] = [];
    let used = header.join('\n').length;
    for (const d of result.documents) {
      const block = `=== ${d.path} ===\n${d.content}`;
      if (blocks.length === 0 || used + block.length <= MAX_OUTPUT_CHARS) {
        blocks.push(block);
        used += block.length + 1;
      } else {
        omitted.push(d.path);
      }
    }
    if (omitted.length > 0) {
      const shown = omitted.slice(0, 30).join(', ');
      header.push(
        `(${omitted.length} document(s) omitted from this response to stay within size limits — fetch individually with eds_da_get_source: ${shown}${omitted.length > 30 ? ', …' : ''})`,
      );
    }
    return textResult([...header, '', ...blocks].join('\n'));
  } catch (error) {
    return errorResult(error);
  }
}

export async function handleDaPush(
  client: DaClient,
  args: {
    documents: Array<{ path: string; content: string; contentType?: string }>;
    dryRun?: boolean;
    withUndo?: boolean;
  },
) {
  try {
    // Dry-run: preview what would change, write nothing.
    if (args.dryRun) {
      const preview = await client.previewPush(args.documents);
      const s = preview.summary;
      const lines = [
        `Dry run — nothing was written. ${s.create} create, ${s.update} update, ${s.unchanged} unchanged.`,
        '',
      ];
      for (const e of preview.plan) {
        const detail =
          e.action === 'update' && e.changes
            ? ` (+${e.changes.added}/-${e.changes.removed} lines)`
            : '';
        lines.push(`  ${e.action.toUpperCase().padEnd(9)} ${e.path}${detail}`);
      }
      return textResult(lines.join('\n'));
    }

    const result = await client.pushDocuments(args.documents, { withUndo: args.withUndo });
    const lines = [
      `Pushed ${result.succeeded.length} document${result.succeeded.length === 1 ? '' : 's'}; ${result.failed.length} failed.`,
    ];
    if (result.succeeded.length > 0) {
      lines.push('', 'Succeeded:');
      for (const p of result.succeeded) lines.push(`  ✓ ${p}`);
    }
    if (result.failed.length > 0) {
      lines.push('', 'Failed:');
      for (const f of result.failed) lines.push(`  ✗ ${f.path} — ${f.error}`);
    }
    if (result.undo) {
      lines.push(
        '',
        'To undo this push, call eds_da_rollback with this exact object:',
        JSON.stringify({ undo: result.undo }),
      );
    }
    return textResult(lines.join('\n'));
  } catch (error) {
    return errorResult(error);
  }
}

export async function handleDaRollback(
  client: DaClient,
  args: { undo: { restore: Array<{ path: string; content: string; contentType?: string }>; remove: string[] } },
) {
  try {
    const result = await client.rollback(args.undo);
    const lines = [
      `Rolled back: ${result.succeeded.length} restored/removed; ${result.failed.length} failed.`,
    ];
    if (result.failed.length > 0) {
      lines.push('', 'Failed:');
      for (const f of result.failed) lines.push(`  ✗ ${f.path} — ${f.error}`);
    }
    return textResult(lines.join('\n'));
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
