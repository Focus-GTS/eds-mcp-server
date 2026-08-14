/**
 * MCP tool handlers for the safe-fix layer (ADR-011).
 *
 * `eds_fix_metadata` repairs a page's `<head>` metadata by editing its DA source
 * through the ADR-009 safe-writes path (preview + undo), and can optionally
 * preview+publish so the change goes live. The agent supplies the content; this
 * handler writes it correctly and reversibly.
 */

import type { EdsClient } from '../eds-admin/client.js';
import type { DaClient } from '../da-admin/client.js';
import { formatError } from '../utils/errors.js';
import { applyMetadata, type MetadataFields } from '../fix/metadata.js';

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function errorResult(error: unknown) {
  return {
    content: [{ type: 'text' as const, text: `Error: ${formatError(error)}` }],
    isError: true as const,
  };
}

export async function handleFixMetadata(
  daClient: DaClient,
  edsClient: EdsClient,
  args: {
    path: string;
    metadata: MetadataFields;
    dryRun?: boolean;
    withUndo?: boolean;
    publish?: boolean;
  },
) {
  try {
    const source = await daClient.getSource(args.path);
    const { html, changes } = applyMetadata(source.content, args.metadata);

    if (changes.length === 0) {
      return textResult(`No metadata changes needed for ${source.path} — already correct.`);
    }

    // Dry run: show the before/after, write nothing.
    if (args.dryRun) {
      const lines = [
        `Dry run — nothing written. ${changes.length} metadata field(s) would change on ${source.path}:`,
        '',
      ];
      for (const c of changes) {
        lines.push(`  ${c.field}: ${c.from === null ? '(none)' : `"${c.from}"`} → "${c.to}"`);
      }
      return textResult(lines.join('\n'));
    }

    // Write through the safe-writes path.
    const result = await daClient.pushDocuments(
      [{ path: source.path, content: html, contentType: source.contentType }],
      { withUndo: args.withUndo },
    );
    if (result.failed.length > 0) {
      return errorResult(new Error(`Failed to write ${source.path}: ${result.failed[0].error}`));
    }

    const lines = [`Updated metadata on ${source.path}: ${changes.map((c) => c.field).join(', ')}.`];

    // Optionally make it live — a DA write alone is not visible until republished.
    if (args.publish) {
      try {
        await edsClient.previewAndPublish(args.path);
        lines.push('Previewed + published — the change is live.');
      } catch (e) {
        lines.push(`(Written to DA, but publish failed: ${formatError(e)} — run eds_preview_and_publish manually.)`);
      }
    } else {
      lines.push('(Written to DA. Pass publish:true, or run eds_preview_and_publish, to make it live.)');
    }

    if (result.undo) {
      lines.push('', 'To undo this change, call eds_da_rollback with:', JSON.stringify({ undo: result.undo }));
    }
    return textResult(lines.join('\n'));
  } catch (error) {
    return errorResult(error);
  }
}
