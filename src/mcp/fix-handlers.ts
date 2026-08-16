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
import { applyRedirects, type RedirectRule } from '../fix/redirects.js';

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function errorResult(error: unknown) {
  return {
    content: [{ type: 'text' as const, text: `Error: ${formatError(error)}` }],
    isError: true as const,
  };
}

/** Run `fn` over `items` with at most `concurrency` in flight at once. */
async function mapWithConcurrency<T>(
  items: T[],
  fn: (item: T) => Promise<void>,
  concurrency: number,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]);
    }
  };
  const size = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: size }, () => worker()));
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

export async function handleBulkFixMetadata(
  daClient: DaClient,
  edsClient: EdsClient,
  args: {
    pages: Array<{ path: string; metadata: MetadataFields }>;
    dryRun?: boolean;
    publish?: boolean;
  },
) {
  try {
    // Dedupe input by DA-normalized path (case-sensitive; strip a leading "/"
    // and a trailing ".html"), MERGING metadata so two entries for the same page
    // combine rather than racing each other on write (which would produce a
    // nondeterministic result and a broken undo).
    const deduped = new Map<string, { path: string; metadata: MetadataFields }>();
    for (const p of args.pages) {
      const key = p.path.replace(/^\/+/, '').replace(/\.html$/i, '');
      const existing = deduped.get(key);
      if (existing) existing.metadata = { ...existing.metadata, ...p.metadata };
      else deduped.set(key, { path: p.path, metadata: { ...p.metadata } });
    }
    const pages = [...deduped.values()];

    // 1. Read + transform each page (bounded concurrency). Collect only the
    //    pages that actually change; record read failures without aborting.
    const plans: Array<{
      path: string;
      sourcePath: string;
      contentType?: string;
      html: string;
      fields: string[];
    }> = [];
    const readFailed: Array<{ path: string; error: string }> = [];
    await mapWithConcurrency(
      pages,
      async (p) => {
        try {
          const source = await daClient.getSource(p.path);
          const { html, changes } = applyMetadata(source.content, p.metadata);
          if (changes.length > 0) {
            plans.push({ path: p.path, sourcePath: source.path, contentType: source.contentType, html, fields: changes.map((c) => c.field) });
          }
        } catch (e) {
          readFailed.push({ path: p.path, error: e instanceof Error ? e.message : String(e) });
        }
      },
      6,
    );
    const unchanged = pages.length - plans.length - readFailed.length;

    // 2. Dry run: full plan, no writes.
    if (args.dryRun) {
      const lines = [
        `Dry run — nothing written. ${plans.length} page(s) would change, ${unchanged} already correct, ${readFailed.length} unreadable.`,
      ];
      if (plans.length > 0) {
        lines.push('', 'Would change:');
        for (const pl of plans) lines.push(`  ${pl.sourcePath}: ${pl.fields.join(', ')}`);
      }
      if (readFailed.length > 0) {
        lines.push('', 'Could not read:');
        for (const f of readFailed) lines.push(`  ✗ ${f.path} — ${f.error}`);
      }
      return textResult(lines.join('\n'));
    }

    if (plans.length === 0) {
      // Lead with the failure when nothing could be read (e.g. bad token) so it
      // doesn't read as a success.
      if (readFailed.length > 0) {
        const lines = [
          `Nothing written — ${readFailed.length} page(s) could not be read; ${unchanged} already correct.`,
          '',
          'Could not read:',
        ];
        for (const f of readFailed) lines.push(`  ✗ ${f.path} — ${f.error}`);
        return textResult(lines.join('\n'));
      }
      return textResult(`No changes needed — ${unchanged} page(s) already correct.`);
    }

    // 3. Push ALL changed pages in ONE batch → a single aggregated undo.
    const result = await daClient.pushDocuments(
      plans.map((pl) => ({ path: pl.sourcePath, content: pl.html, contentType: pl.contentType })),
      { withUndo: true },
    );

    const lines = [
      `Fixed ${result.succeeded.length} page(s) in one batch; ${result.failed.length} write failure(s); ${unchanged} already correct; ${readFailed.length} unreadable.`,
    ];

    // 4. Optionally publish the pages that were written.
    if (args.publish && result.succeeded.length > 0) {
      const written = new Set(result.succeeded);
      const toPublish = plans.filter((pl) => written.has(pl.sourcePath)).map((pl) => pl.path);
      let published = 0;
      const pubFailed: string[] = [];
      await mapWithConcurrency(
        toPublish,
        async (path) => {
          try {
            await edsClient.previewAndPublish(path);
            published++;
          } catch {
            pubFailed.push(path);
          }
        },
        6,
      );
      lines.push(`Published ${published}/${toPublish.length} page(s) live${pubFailed.length ? ` (${pubFailed.length} publish failure(s))` : ''}.`);
    } else if (result.succeeded.length > 0) {
      lines.push('(Written to DA. Pass publish:true to make the batch live.)');
    }

    if (readFailed.length > 0) {
      lines.push('', 'Could not read:');
      for (const f of readFailed) lines.push(`  ✗ ${f.path} — ${f.error}`);
    }
    if (result.failed.length > 0) {
      lines.push('', 'Write failures:');
      for (const f of result.failed) lines.push(`  ✗ ${f.path} — ${f.error}`);
    }
    // Return the aggregated undo — but never inline a giant blob. A large batch's
    // undo carries every page's full prior HTML; past a size cap, inlining it is
    // unusable, so advise smaller batches (DA versioning is the per-page fallback).
    if (result.undo && (result.undo.restore.length > 0 || result.undo.remove.length > 0)) {
      const undoJson = JSON.stringify({ undo: result.undo });
      const UNDO_INLINE_CAP = 200_000;
      if (undoJson.length <= UNDO_INLINE_CAP) {
        lines.push('', 'To undo this ENTIRE batch in one call, use eds_da_rollback with:', undoJson);
      } else {
        lines.push(
          '',
          `(This batch's undo is ${Math.round(undoJson.length / 1024)} KB — too large to return inline. For a single returnable undo, run smaller batches; DA also versions every page, so any page can be reverted from its version history.)`,
        );
      }
    }
    return textResult(lines.join('\n'));
  } catch (error) {
    return errorResult(error);
  }
}

/** Read a DA source, or null if it does not exist (404). */
async function getSourceOrNull(daClient: DaClient, path: string) {
  try {
    return await daClient.getSource(path);
  } catch (e) {
    if (e && typeof e === 'object' && 'status' in e && (e as { status: number }).status === 404) return null;
    throw e;
  }
}

export async function handleFixRedirect(
  daClient: DaClient,
  edsClient: EdsClient,
  args: {
    redirects: RedirectRule[];
    dryRun?: boolean;
    publish?: boolean;
  },
) {
  try {
    // The redirects sheet is a JSON document at /redirects.json (an EDS sheet —
    // NOT an HTML table, which would become a block).
    const existing = await getSourceOrNull(daClient, '/redirects.json');

    let applied;
    try {
      applied = applyRedirects(existing?.content ?? null, args.redirects);
    } catch (e) {
      return errorResult(e); // e.g. an unrecognizable / multi-sheet existing doc
    }
    const { content, changes } = applied;

    if (changes.length === 0) {
      return textResult('No redirect changes needed — every rule is already in the sheet.');
    }

    if (args.dryRun) {
      const lines = [
        `Dry run — nothing written. ${changes.length} redirect rule(s) would ${existing ? 'change' : 'be created'}:`,
        '',
      ];
      for (const c of changes) lines.push(`  ${c.source} → ${c.to}${c.from ? ` (was ${c.from})` : ''}`);
      return textResult(lines.join('\n'));
    }

    // Always capture undo — a bad redirect hides a live page, so this write must
    // always be reversible.
    const push = await daClient.pushDocuments(
      [{ path: '/redirects.json', content, contentType: 'application/json' }],
      { withUndo: true },
    );
    if (push.failed.length > 0) {
      return errorResult(new Error(`Failed to write /redirects.json: ${push.failed[0].error}`));
    }

    const lines = [`${existing ? 'Updated' : 'Created'} the redirects sheet — ${changes.length} rule(s).`];
    if (args.publish) {
      try {
        await edsClient.previewAndPublish('/redirects.json');
        lines.push('Previewed + published — the redirects are live.');
      } catch (e) {
        lines.push(`(Written to DA, but publish failed: ${formatError(e)} — publish /redirects.json manually.)`);
      }
    } else {
      lines.push('(Written to DA. Pass publish:true, or publish /redirects.json, to make them live.)');
    }
    if (push.undo) {
      lines.push('', 'To undo, call eds_da_rollback with:', JSON.stringify({ undo: push.undo }));
    }
    return textResult(lines.join('\n'));
  } catch (error) {
    return errorResult(error);
  }
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Apply the fixes an audit surfaced, across mixed types, in ONE reversible
 * operation (ADR-015). Takes agent-supplied metadata fixes and/or redirect rules
 * — the values the agent wrote from the findings (the tool never invents copy) —
 * and pushes every changed document (metadata pages + the redirects sheet) in a
 * single `withUndo` push, so ONE `eds_da_rollback` reverses the entire batch.
 * Pure orchestration over the ADR-011/013 transforms; no new write logic.
 */
export async function handleFixAudit(
  daClient: DaClient,
  edsClient: EdsClient,
  args: {
    metadata?: Array<{ path: string; metadata: MetadataFields }>;
    redirects?: RedirectRule[];
    dryRun?: boolean;
    publish?: boolean;
  },
) {
  try {
    const metaInput = args.metadata ?? [];
    const redirectInput = args.redirects ?? [];
    if (metaInput.length === 0 && redirectInput.length === 0) {
      return errorResult(
        new Error(
          'Nothing to fix — supply `metadata` fixes and/or `redirects`. These are the audit findings that carry a `fix`; the agent provides the values (this tool never invents copy).',
        ),
      );
    }

    // 1. Metadata — dedupe+merge by DA-normalized path (same discipline as
    //    bulk-fix, so two entries for one page can't race on write), then
    //    read+transform each. Read failures are recorded, never abort the batch.
    const deduped = new Map<string, { path: string; metadata: MetadataFields }>();
    for (const p of metaInput) {
      const key = p.path.replace(/^\/+/, '').replace(/\.html$/i, '');
      const existing = deduped.get(key);
      if (existing) existing.metadata = { ...existing.metadata, ...p.metadata };
      else deduped.set(key, { path: p.path, metadata: { ...p.metadata } });
    }
    const pages = [...deduped.values()];

    const plans: Array<{ path: string; sourcePath: string; contentType?: string; html: string; fields: string[] }> = [];
    const readFailed: Array<{ path: string; error: string }> = [];
    await mapWithConcurrency(
      pages,
      async (p) => {
        try {
          const source = await daClient.getSource(p.path);
          const { html, changes } = applyMetadata(source.content, p.metadata);
          if (changes.length > 0) {
            plans.push({ path: p.path, sourcePath: source.path, contentType: source.contentType, html, fields: changes.map((c) => c.field) });
          }
        } catch (e) {
          readFailed.push({ path: p.path, error: errMsg(e) });
        }
      },
      6,
    );
    const metaUnchanged = pages.length - plans.length - readFailed.length;

    // 2. Redirects — read the existing sheet and apply the rules.
    let redirectDoc: { content: string; count: number; existed: boolean } | null = null;
    if (redirectInput.length > 0) {
      const existing = await getSourceOrNull(daClient, '/redirects.json');
      let applied;
      try {
        applied = applyRedirects(existing?.content ?? null, redirectInput);
      } catch (e) {
        return errorResult(e); // unrecognizable / multi-sheet existing doc
      }
      if (applied.changes.length > 0) {
        redirectDoc = { content: applied.content, count: applied.changes.length, existed: !!existing };
      }
    }

    // 3. Dry run — the full combined plan, no writes.
    if (args.dryRun) {
      const lines = [
        `Dry run — nothing written. Would change ${plans.length} page(s) and ${redirectDoc ? redirectDoc.count : 0} redirect rule(s); ${metaUnchanged} page(s) already correct; ${readFailed.length} unreadable.`,
      ];
      if (plans.length > 0) {
        lines.push('', 'Metadata:');
        for (const pl of plans) lines.push(`  ${pl.sourcePath}: ${pl.fields.join(', ')}`);
      }
      if (redirectDoc) {
        lines.push('', `Redirects (${redirectDoc.existed ? 'update' : 'create'} /redirects.json): ${redirectDoc.count} rule(s).`);
      }
      if (readFailed.length > 0) {
        lines.push('', 'Could not read:');
        for (const f of readFailed) lines.push(`  ✗ ${f.path} — ${f.error}`);
      }
      return textResult(lines.join('\n'));
    }

    // Nothing actually changes.
    if (plans.length === 0 && !redirectDoc) {
      if (readFailed.length > 0) {
        const lines = [`Nothing written — ${readFailed.length} page(s) could not be read; ${metaUnchanged} already correct.`, '', 'Could not read:'];
        for (const f of readFailed) lines.push(`  ✗ ${f.path} — ${f.error}`);
        return textResult(lines.join('\n'));
      }
      return textResult('No changes needed — everything the audit flagged is already correct.');
    }

    // 4. Push EVERYTHING in one batch → a single unified undo across mixed types.
    const docs = plans.map((pl) => ({ path: pl.sourcePath, content: pl.html, contentType: pl.contentType }));
    if (redirectDoc) docs.push({ path: '/redirects.json', content: redirectDoc.content, contentType: 'application/json' });
    const result = await daClient.pushDocuments(docs, { withUndo: true });

    // Report what ACTUALLY got written, not what was planned — a partial write
    // failure (e.g. one page 403s) must never read as success.
    const written = new Set(result.succeeded);
    const pagesFixed = plans.filter((pl) => written.has(pl.sourcePath)).length;
    const redirectsFixed = redirectDoc && written.has('/redirects.json') ? redirectDoc.count : 0;

    const lines = [
      `Fixed ${pagesFixed} page(s)${redirectsFixed ? ` and ${redirectsFixed} redirect rule(s)` : ''} in one reversible batch; ${result.failed.length} write failure(s); ${metaUnchanged} page(s) already correct; ${readFailed.length} unreadable.`,
    ];

    // 5. Optionally publish everything that was written.
    if (args.publish && result.succeeded.length > 0) {
      const toPublish = plans.filter((pl) => written.has(pl.sourcePath)).map((pl) => pl.path);
      if (redirectDoc && written.has('/redirects.json')) toPublish.push('/redirects.json');
      let published = 0;
      const pubFailed: string[] = [];
      await mapWithConcurrency(
        toPublish,
        async (path) => {
          try {
            await edsClient.previewAndPublish(path);
            published++;
          } catch {
            pubFailed.push(path);
          }
        },
        6,
      );
      lines.push(`Published ${published}/${toPublish.length} live${pubFailed.length ? ` (${pubFailed.length} publish failure(s))` : ''}.`);
    } else if (result.succeeded.length > 0) {
      lines.push('(Written to DA. Pass publish:true to make the batch live.)');
    }

    if (readFailed.length > 0) {
      lines.push('', 'Could not read:');
      for (const f of readFailed) lines.push(`  ✗ ${f.path} — ${f.error}`);
    }
    if (result.failed.length > 0) {
      lines.push('', 'Write failures:');
      for (const f of result.failed) lines.push(`  ✗ ${f.path} — ${f.error}`);
    }

    // One aggregated undo for the whole batch (metadata + redirects), capped so a
    // huge batch's undo isn't inlined unusably (DA versions each doc as a fallback).
    if (result.undo && (result.undo.restore.length > 0 || result.undo.remove.length > 0)) {
      const undoJson = JSON.stringify({ undo: result.undo });
      if (undoJson.length <= 200_000) {
        lines.push('', 'To undo this ENTIRE batch in one call, use eds_da_rollback with:', undoJson);
        // eds_da_rollback restores the DA *source* but does not republish. If this
        // batch went live, the old (now-wrong) version keeps serving until the
        // reverted docs are republished — critical for a redirect, which hides a
        // live page. Say so, honestly.
        if (args.publish) {
          lines.push(
            '',
            'Note: this batch was published. eds_da_rollback restores the source but does NOT republish — after rolling back, republish the affected paths (including /redirects.json) so the revert goes live.',
          );
        }
      } else {
        lines.push('', `(This batch's undo is ${Math.round(undoJson.length / 1024)} KB — too large to return inline. Run smaller batches; DA also versions every doc for per-doc revert.)`);
      }
    }
    return textResult(lines.join('\n'));
  } catch (error) {
    return errorResult(error);
  }
}
