/**
 * Scheduled-monitoring assessment (ADR-018) — the "watch primitive."
 *
 * Pure functions: given the previous and current {@link Snapshot}, decide whether
 * the site regressed and to what degree, and build a compact, secret-free alert
 * payload. The heartbeat (cron/GitHub Action/agent runtime) and the network POST
 * live in the handler; everything here is deterministic and testable.
 */

import type { AuditDimension } from './types.js';
import { DIMENSION_COLUMNS, type Snapshot } from './history.js';

const LABELS: Record<AuditDimension, string> = {
  seo: 'SEO',
  accessibility: 'Accessibility',
  performance: 'Performance',
  freshness: 'Freshness',
  links: 'Links & 404s',
  sitemap: 'Sitemap',
};

/** ok = no regression · degraded = worse but not critical · broken = a new critical / a dimension fell to poor. */
export type MonitorStatus = 'ok' | 'degraded' | 'broken';

const RANK: Record<MonitorStatus, number> = { ok: 0, degraded: 1, broken: 2 };

/** Should a status at least as severe as `threshold` fire an alert? */
export function crossesThreshold(status: MonitorStatus, threshold: MonitorStatus): boolean {
  return RANK[status] >= RANK[threshold];
}

const band = (s: number): 'good' | 'fair' | 'poor' => (s >= 85 ? 'good' : s >= 55 ? 'fair' : 'poor');

export interface Assessment {
  status: MonitorStatus;
  /** Overall score change vs the previous snapshot (null on the first-ever check). */
  overallDelta: number | null;
  regressions: string[];
  improvements: string[];
  /** True when there was no prior snapshot to compare against (baseline). */
  baseline: boolean;
}

/**
 * Compare the current snapshot to the previous one and classify the change.
 * With no previous snapshot it's a baseline (`ok`, nothing to compare).
 */
export function assessChange(
  prev: Snapshot | null,
  curr: Snapshot,
  opts: { degradeDrop?: number } = {},
): Assessment {
  const degradeDrop = opts.degradeDrop ?? 5;
  if (!prev) {
    return { status: 'ok', overallDelta: null, regressions: [], improvements: [], baseline: true };
  }

  const regressions: string[] = [];
  const improvements: string[] = [];

  const criticalDelta = curr.counts.critical - prev.counts.critical;
  if (criticalDelta > 0) regressions.push(`${criticalDelta} new critical issue${criticalDelta === 1 ? '' : 's'} (now ${curr.counts.critical})`);
  else if (criticalDelta < 0) improvements.push(`${-criticalDelta} critical issue${-criticalDelta === 1 ? '' : 's'} resolved`);

  // A large single-dimension drop that stays in (or lands in) a concerning band
  // must still register — a band-crossing check alone misses e.g. poor 50 → 21.
  const DIM_DROP = 15;
  let dimBrokeToPoor = false;
  for (const d of DIMENSION_COLUMNS) {
    const p = prev.dimensions[d];
    const c = curr.dimensions[d];
    if (p === undefined || c === undefined) continue;
    const pb = band(p);
    const cb = band(c);
    if (pb !== 'poor' && cb === 'poor') {
      regressions.push(`${LABELS[d]} fell to poor (${c}/100)`);
      dimBrokeToPoor = true;
    } else if (pb === 'good' && cb === 'fair') {
      regressions.push(`${LABELS[d]} slipped to fair (${c}/100)`);
    } else if (cb !== 'good' && c - p <= -DIM_DROP) {
      // A steep drop that isn't a band crossing but lands in fair/poor territory.
      regressions.push(`${LABELS[d]} dropped ${p - c} points (now ${c}/100)`);
    } else if (pb === 'poor' && cb !== 'poor') {
      improvements.push(`${LABELS[d]} recovered (${c}/100)`);
    }
  }

  // Only treat an OVERALL move as a regression/improvement when both snapshots
  // measured the SAME dimensions — otherwise the average is over different
  // denominators (e.g. RUM present one run, absent the next) and the delta is a
  // false signal. The number is still reported by the caller; it just won't
  // trigger a status change here.
  const overallDelta = curr.overall - prev.overall;
  const sameDims = Object.keys(prev.dimensions).sort().join(',') === Object.keys(curr.dimensions).sort().join(',');
  if (sameDims && overallDelta <= -degradeDrop) regressions.push(`overall dropped ${-overallDelta} points (now ${curr.overall})`);
  else if (sameDims && overallDelta >= degradeDrop) improvements.push(`overall up ${overallDelta} points (now ${curr.overall})`);

  const warnDelta = curr.counts.warning - prev.counts.warning;
  if (warnDelta > 0) regressions.push(`${warnDelta} new warning${warnDelta === 1 ? '' : 's'} (now ${curr.counts.warning})`);

  let status: MonitorStatus = 'ok';
  if (criticalDelta > 0 || dimBrokeToPoor) status = 'broken';
  else if (regressions.length > 0) status = 'degraded';

  return { status, overallDelta, regressions, improvements, baseline: false };
}

const EMOJI: Record<MonitorStatus, string> = { ok: '🟢', degraded: '🟡', broken: '🔴' };

/**
 * Build a compact, SECRET-FREE alert message + payload. Shaped to satisfy Slack
 * (`text`), Discord (`content`), and generic webhooks (the full JSON) at once.
 * Carries only public audit data — never a token or the history sheet.
 */
export function buildAlert(
  site: string,
  curr: Snapshot,
  a: Assessment,
  topIssues: string[] = [],
): { text: string; content: string; status: MonitorStatus; site: string; overall: number; summary: string } {
  const headline = `${EMOJI[a.status]} [${a.status}] ${site} — overall ${curr.overall}/100${a.overallDelta !== null ? ` (${a.overallDelta >= 0 ? '▲' : '▼'}${Math.abs(a.overallDelta)})` : ''}`;
  const lines = [headline];
  if (a.regressions.length) lines.push('Regressed: ' + a.regressions.join('; ') + '.');
  if (topIssues.length) lines.push('Top issues: ' + topIssues.slice(0, 3).join('; ') + '.');
  lines.push('Run eds_audit_report for the full breakdown.');
  const text = lines.join('\n');
  return { text, content: text, status: a.status, site, overall: curr.overall, summary: text };
}
