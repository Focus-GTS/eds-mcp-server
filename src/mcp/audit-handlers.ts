/**
 * MCP tool handlers for the content audit (ADR-010).
 *
 * `eds_audit_page` audits one page; `eds_audit_site` sweeps the site. Both
 * return a prioritized, human-readable findings report.
 */

import type { EdsClient } from '../eds-admin/client.js';
import type { DaClient } from '../da-admin/client.js';
import { formatError } from '../utils/errors.js';
import { auditSite, auditSinglePage, type AuditSiteOptions } from '../audit/engine.js';
import type { AuditDimension, AuditFinding, AuditReport } from '../audit/types.js';
import { generateReport } from '../audit/report.js';
import { computeScores } from '../audit/score.js';
import { applyHistory, parseHistory, delta, DIMENSION_COLUMNS, type Snapshot } from '../audit/history.js';
import { renderTrend } from '../audit/trend.js';

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function errorResult(error: unknown) {
  return {
    content: [{ type: 'text' as const, text: `Error: ${formatError(error)}` }],
    isError: true as const,
  };
}

const SEVERITY_LABEL: Record<AuditFinding['severity'], string> = {
  critical: 'CRITICAL',
  warning: 'WARNING',
  info: 'INFO',
};

/** Cap the number of findings rendered so a huge site can't blow the response. */
const MAX_RENDERED = 200;

function formatReport(report: AuditReport): string {
  const { summary } = report;
  const lines: string[] = [];

  const scopeLabel = report.scope === 'page' ? `page ${report.target}` : `site ${report.target}`;
  lines.push(
    `Audit of ${scopeLabel} — ${summary.critical} critical, ${summary.warning} warning, ${summary.info} info (${summary.total} finding${summary.total === 1 ? '' : 's'}).`,
  );
  if (summary.pagesAudited !== undefined && report.scope === 'site') {
    lines.push(`Pages inspected: ${summary.pagesAudited}${report.truncated ? ' (hit the page cap — raise maxPages or narrow pathPrefix for full coverage)' : ''}.`);
  }
  if (report.skipped.length > 0) {
    lines.push(`Skipped: ${report.skipped.join('; ')}.`);
  }

  if (summary.total === 0) {
    lines.push('', 'No issues found. ✓');
    return lines.join('\n');
  }

  const rendered = report.findings.slice(0, MAX_RENDERED);
  let lastSeverity: AuditFinding['severity'] | null = null;
  for (const f of rendered) {
    if (f.severity !== lastSeverity) {
      lines.push('', SEVERITY_LABEL[f.severity]);
      lastSeverity = f.severity;
    }
    const where = f.page ? ` — ${f.page}` : '';
    lines.push(`  [${f.dimension}] ${f.title}${where}`);
    lines.push(`      ${f.detail}`);
    if (f.suggestion) lines.push(`      → ${f.suggestion}`);
  }
  if (report.findings.length > MAX_RENDERED) {
    lines.push('', `(${report.findings.length - MAX_RENDERED} more finding(s) not shown — narrow the audit with pathPrefix or dimensions.)`);
  }

  return lines.join('\n');
}

export async function handleAuditPage(
  client: EdsClient,
  args: { path: string },
) {
  try {
    const { html } = await client.getRenderedPage(args.path);
    return textResult(formatReport(auditSinglePage(html, args.path)));
  } catch (error) {
    return errorResult(error);
  }
}

export async function handleAuditReport(
  client: EdsClient,
  site: string,
  args: {
    pathPrefix?: string;
    maxPages?: number;
    dimensions?: AuditDimension[];
    domain?: string;
    days?: number;
  },
) {
  try {
    const options: AuditSiteOptions = {
      pathPrefix: args.pathPrefix,
      maxPages: args.maxPages,
      dimensions: args.dimensions,
      domain: args.domain,
      days: args.days,
    };
    const report = await auditSite(client, options);
    const html = generateReport(report, { site, generatedAt: new Date().toISOString().slice(0, 10) });
    return textResult(html);
  } catch (error) {
    return errorResult(error);
  }
}

export async function handleAuditSite(
  client: EdsClient,
  args: {
    pathPrefix?: string;
    maxPages?: number;
    dimensions?: AuditDimension[];
    domain?: string;
    days?: number;
  },
) {
  try {
    const options: AuditSiteOptions = {
      pathPrefix: args.pathPrefix,
      maxPages: args.maxPages,
      dimensions: args.dimensions,
      domain: args.domain,
      days: args.days,
    };
    return textResult(formatReport(await auditSite(client, options)));
  } catch (error) {
    return errorResult(error);
  }
}

const arrow = (n: number): string => (n > 0 ? `▲${n}` : n < 0 ? `▼${Math.abs(n)}` : '±0');

/** Read a DA source, or null if it does not exist (404). */
async function getSourceOrNull(daClient: DaClient, path: string) {
  try {
    return await daClient.getSource(path);
  } catch (e) {
    if (e && typeof e === 'object' && 'status' in e && (e as { status: number }).status === 404) return null;
    throw e;
  }
}

/** Build a snapshot from a fresh audit (ADR-016). */
function snapshotFromReport(report: AuditReport, date: string): Snapshot {
  const scores = computeScores(report);
  const s = report.summary;
  return {
    date,
    overall: scores.overall,
    dimensions: scores.dimensions,
    counts: { critical: s.critical, warning: s.warning, info: s.info, total: s.total, pages: s.pagesAudited ?? 0 },
  };
}

export async function handleAuditSnapshot(
  daClient: DaClient,
  edsClient: EdsClient,
  args: {
    historyPath?: string;
    pathPrefix?: string;
    maxPages?: number;
    dimensions?: AuditDimension[];
    domain?: string;
    days?: number;
    dryRun?: boolean;
    publish?: boolean;
  },
) {
  try {
    const path = args.historyPath ?? '/audit-history.json';
    const options: AuditSiteOptions = {
      pathPrefix: args.pathPrefix,
      maxPages: args.maxPages,
      dimensions: args.dimensions,
      domain: args.domain,
      days: args.days,
    };
    const report = await auditSite(edsClient, options);
    const date = new Date().toISOString().slice(0, 10);
    const snap = snapshotFromReport(report, date);

    let existing: string | null = null;
    try {
      const src = await getSourceOrNull(daClient, path);
      existing = src?.content ?? null;
    } catch (e) {
      return errorResult(e);
    }

    let applied;
    try {
      applied = applyHistory(existing, snap, path);
    } catch (e) {
      return errorResult(e); // unrecognizable / multi-sheet existing sheet
    }
    const { previous } = applied;

    const deltaLine = previous
      ? ` (${arrow(snap.overall - previous.overall)} vs ${previous.date})`
      : ' (first snapshot recorded)';
    const scoreLine = `Overall ${snap.overall}/100${deltaLine}. ${snap.counts.critical} critical, ${snap.counts.warning} warning, ${snap.counts.info} info across ${snap.counts.pages} page(s).`;

    if (!applied.changed) {
      return textResult(`Already recorded for ${date} with identical scores — nothing written.\n${scoreLine}`);
    }

    if (args.dryRun) {
      return textResult(`Dry run — nothing written. Would record ${date} to ${path}:\n${scoreLine}`);
    }

    // A history append is low-risk (readSheet refuses to overwrite an
    // unrecognizable/multi-sheet doc, and DA versions every write), so this
    // deliberately forgoes withUndo — the snapshot response stays clean, and any
    // bad write is recoverable from DA's own per-doc version history.
    const push = await daClient.pushDocuments([{ path, content: applied.content, contentType: 'application/json' }], {});
    if (push.failed.length > 0) {
      return errorResult(new Error(`Failed to write ${path}: ${push.failed[0].error}`));
    }

    const lines = [`Recorded snapshot for ${date} to ${path}.`, scoreLine];
    if (args.publish) {
      try {
        await edsClient.previewAndPublish(path);
        lines.push('Previewed + published the history sheet.');
      } catch (e) {
        lines.push(`(Written to DA, but publish failed: ${formatError(e)}.)`);
      }
    } else {
      lines.push('(Kept in DA, unpublished — your scores stay private. Pass publish:true to make the sheet live.)');
    }
    lines.push('View the trend any time with eds_audit_trend.');
    return textResult(lines.join('\n'));
  } catch (error) {
    return errorResult(error);
  }
}

export async function handleAuditTrend(
  daClient: DaClient,
  site: string,
  args: { historyPath?: string; format?: 'html' | 'text' },
) {
  try {
    const path = args.historyPath ?? '/audit-history.json';
    let content: string | null = null;
    try {
      const src = await getSourceOrNull(daClient, path);
      content = src?.content ?? null;
    } catch (e) {
      return errorResult(e);
    }
    const snapshots = parseHistory(content, path);

    if (args.format === 'text') {
      if (snapshots.length === 0) {
        return textResult(`No history yet at ${path}. Record a point with eds_audit_snapshot, then run again over time.`);
      }
      const latest = snapshots[snapshots.length - 1];
      const first = snapshots[0];
      const prev = snapshots.length > 1 ? snapshots[snapshots.length - 2] : null;
      const lines = [
        `${site} — ${snapshots.length} snapshot(s), latest ${latest.date}.`,
        `Overall ${latest.overall}/100${snapshots.length > 1 ? ` (${arrow(latest.overall - first.overall)} since ${first.date})` : ''}.`,
      ];
      if (prev) {
        const d = delta(prev, latest);
        const dims = DIMENSION_COLUMNS.filter((dim) => d.dimensions[dim] !== undefined)
          .map((dim) => `${dim} ${arrow(d.dimensions[dim] as number)}`)
          .join(', ');
        lines.push(`Since ${prev.date}: ${dims || '(no per-dimension change)'}.`);
      }
      return textResult(lines.join('\n'));
    }

    return textResult(renderTrend(snapshots, { site }));
  } catch (error) {
    return errorResult(error);
  }
}
