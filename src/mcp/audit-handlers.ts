/**
 * MCP tool handlers for the content audit (ADR-010).
 *
 * `eds_audit_page` audits one page; `eds_audit_site` sweeps the site. Both
 * return a prioritized, human-readable findings report.
 */

import type { EdsClient } from '../eds-admin/client.js';
import { formatError } from '../utils/errors.js';
import { auditSite, auditSinglePage, type AuditSiteOptions } from '../audit/engine.js';
import type { AuditDimension, AuditFinding, AuditReport } from '../audit/types.js';

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
