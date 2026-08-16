/**
 * Trend view (ADR-016) — render the audit history as a self-contained,
 * theme-aware HTML page: an SVG sparkline of the overall score over time plus
 * per-dimension movement since the previous snapshot. Same palette as the report
 * (ADR-014), no external assets, no dependencies.
 */

import type { AuditDimension } from './types.js';
import { grade, scoreClass } from './score.js';
import { DIMENSION_COLUMNS, delta, type Snapshot } from './history.js';

const DIMENSION_LABELS: Record<AuditDimension, string> = {
  seo: 'SEO',
  accessibility: 'Accessibility',
  performance: 'Performance',
  freshness: 'Freshness',
  links: 'Links & 404s',
  sitemap: 'Sitemap',
};

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const STYLE = `
:root{
  --bg:#eef1f7;--panel:#ffffff;--ink:#0e1730;--muted:#5c688a;--faint:#8a95b4;--line:#e4e8f1;
  --accent:#5b54e6;--good:#12a150;--fair:#d18700;--poor:#e0402f;
  --shadow:0 1px 2px rgba(16,24,48,.04),0 8px 24px rgba(16,24,48,.06);
  --mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --bg:#080c18;--panel:#111a30;--ink:#eef2fb;--muted:#98a4c6;--faint:#6f7ca3;--line:#212d4c;
  --accent:#9a8dff;--good:#38c47f;--fair:#eab53f;--poor:#f26a5a;
  --shadow:0 1px 2px rgba(0,0,0,.3),0 10px 30px rgba(0,0,0,.35);
}}
:root[data-theme="dark"]{
  --bg:#080c18;--panel:#111a30;--ink:#eef2fb;--muted:#98a4c6;--faint:#6f7ca3;--line:#212d4c;
  --accent:#9a8dff;--good:#38c47f;--fair:#eab53f;--poor:#f26a5a;
  --shadow:0 1px 2px rgba(0,0,0,.3),0 10px 30px rgba(0,0,0,.35);
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:15px;line-height:1.55;-webkit-font-smoothing:antialiased}
.wrap{max-width:820px;margin:0 auto;padding:40px 20px 72px}
.hero{position:relative;background:var(--panel);border:1px solid var(--line);border-radius:20px;box-shadow:var(--shadow);
  padding:28px 30px;overflow:hidden}
.hero::before{content:"";position:absolute;inset:0 0 auto 0;height:3px;background:linear-gradient(90deg,var(--accent),transparent 70%)}
.brand{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--accent);font-weight:700}
.hero h1{margin:8px 0 4px;font-size:26px;font-weight:800;letter-spacing:-.01em;word-break:break-word}
.meta{color:var(--muted);font-size:13px}
.headline{display:flex;align-items:baseline;gap:16px;flex-wrap:wrap;margin-top:18px}
.big{font-family:var(--mono);font-size:52px;font-weight:800;line-height:1;letter-spacing:-.02em}
.big .unit{font-size:19px;color:var(--faint);font-weight:600}
.big.good{color:var(--good)}.big.fair{color:var(--fair)}.big.poor{color:var(--poor)}
.grade{font-family:var(--mono);font-weight:700;font-size:15px;color:var(--muted)}
.change{font-size:14px;font-weight:700}
.change.up{color:var(--good)}.change.down{color:var(--poor)}.change.flat{color:var(--faint)}
.chartcard{background:var(--panel);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow);padding:20px 22px;margin-top:18px}
.chartcard svg{width:100%;height:auto;display:block;overflow:visible}
.axis{font-family:var(--mono);font-size:11px;fill:var(--faint)}
.section-title{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);font-weight:700;margin:30px 2px 12px}
.deltas{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.drow{display:flex;justify-content:space-between;align-items:center;background:var(--panel);border:1px solid var(--line);
  border-radius:12px;box-shadow:var(--shadow);padding:12px 14px;font-size:13.5px;font-weight:600}
.drow .now{font-family:var(--mono);color:var(--muted);font-weight:600}
.drow .d{font-family:var(--mono);font-weight:700;margin-left:8px}
.d.up{color:var(--good)}.d.down{color:var(--poor)}.d.flat{color:var(--faint)}
.empty{background:var(--panel);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);
  padding:26px;text-align:center;color:var(--muted)}
.empty code{font-family:var(--mono);font-size:13px;background:var(--bg);border:1px solid var(--line);border-radius:5px;padding:1px 6px}
footer{margin-top:34px;padding-top:18px;border-top:1px solid var(--line);color:var(--faint);font-size:12px;text-align:center}
footer a{color:var(--accent);text-decoration:none}
`.trim();

function arrow(n: number): { cls: string; text: string } {
  if (n > 0) return { cls: 'up', text: `▲ ${n}` };
  if (n < 0) return { cls: 'down', text: `▼ ${Math.abs(n)}` };
  return { cls: 'flat', text: '± 0' };
}

/** SVG sparkline of the overall score over time (auto-scaled Y, labelled ends). */
function sparkline(snaps: Snapshot[]): string {
  const W = 720;
  const H = 200;
  const padX = 8;
  const padTop = 14;
  const padBottom = 26;
  const scores = snaps.map((s) => s.overall);
  const lo = Math.max(0, Math.min(...scores) - 3);
  const hi = Math.min(100, Math.max(...scores) + 3);
  const span = hi - lo || 1;
  const n = snaps.length;
  const x = (i: number) => (n === 1 ? W / 2 : padX + (i * (W - 2 * padX)) / (n - 1));
  const y = (v: number) => padTop + (1 - (v - lo) / span) * (H - padTop - padBottom);

  const pts = snaps.map((s, i) => `${x(i).toFixed(1)},${y(s.overall).toFixed(1)}`);
  const baseline = (H - padBottom).toFixed(1);
  const area = `M${x(0).toFixed(1)},${baseline} L${pts.join(' L')} L${x(n - 1).toFixed(1)},${baseline} Z`;
  const last = snaps[n - 1];
  const first = snaps[0];

  const dots = snaps
    .map((s, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(s.overall).toFixed(1)}" r="${i === n - 1 ? 5 : 3}" fill="var(--accent)"/>`)
    .join('');

  return (
    `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Overall health score over time">` +
    `<path d="${area}" fill="var(--accent)" opacity="0.10"/>` +
    `<polyline points="${pts.join(' ')}" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>` +
    dots +
    `<text class="axis" x="${x(0).toFixed(1)}" y="${(H - 8).toFixed(1)}" text-anchor="start">${esc(first.date)}</text>` +
    (n > 1 ? `<text class="axis" x="${x(n - 1).toFixed(1)}" y="${(H - 8).toFixed(1)}" text-anchor="end">${esc(last.date)}</text>` : '') +
    `</svg>`
  );
}

/** Render the trend as a self-contained HTML document. */
export function renderTrend(snapshots: Snapshot[], meta: { site: string }): string {
  const head = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Health Trend — ${esc(meta.site)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
  <header class="hero">
    <div class="brand">EDS Site Health · Trend</div>
    <h1>${esc(meta.site)}</h1>`;

  const foot = `
  <footer>
    Generated by <a href="https://www.npmjs.com/package/@focusgts/eds-mcp-server">@focusgts/eds-mcp-server</a> · record a point any time with <code style="font-family:var(--mono)">eds_audit_snapshot</code>
  </footer>
</div>
</body>
</html>`;

  if (snapshots.length === 0) {
    return (
      head +
      `\n    <div class="meta">No history yet.</div>\n  </header>\n` +
      `  <div class="empty">Run <code>eds_audit_snapshot</code> to record your first point, then again over time to see the trend.</div>` +
      foot
    );
  }

  const latest = snapshots[snapshots.length - 1];
  const first = snapshots[0];
  const cls = scoreClass(latest.overall);

  // Change vs the first recorded snapshot (the "since you started" story).
  const sinceStart = latest.overall - first.overall;
  const startArrow = arrow(sinceStart);
  const changeLine =
    snapshots.length > 1
      ? `<span class="change ${startArrow.cls}">${startArrow.text} point${Math.abs(sinceStart) === 1 ? '' : 's'} since ${esc(first.date)}</span>`
      : `<span class="change flat">first snapshot — run again later to see the trend</span>`;

  const chart =
    snapshots.length > 1
      ? `<div class="chartcard">${sparkline(snapshots)}</div>`
      : `<div class="empty">One snapshot so far (${esc(first.date)}). Record another with <code>eds_audit_snapshot</code> to draw the line.</div>`;

  // Per-dimension movement vs the previous snapshot.
  const prev = snapshots.length > 1 ? snapshots[snapshots.length - 2] : null;
  const d = prev ? delta(prev, latest) : null;
  const dimRows = DIMENSION_COLUMNS.filter((dim) => latest.dimensions[dim] !== undefined)
    .map((dim) => {
      const now = latest.dimensions[dim] as number;
      const change = d?.dimensions[dim];
      const a = change !== undefined ? arrow(change) : { cls: 'flat', text: '—' };
      return `<div class="drow"><span>${esc(DIMENSION_LABELS[dim])}</span><span><span class="now">${now}</span><span class="d ${a.cls}">${a.text}</span></span></div>`;
    })
    .join('');
  const dimSection = dimRows
    ? `<div class="section-title">By dimension${prev ? ` · vs ${esc(prev.date)}` : ''}</div><div class="deltas">${dimRows}</div>`
    : '';

  return (
    head +
    `\n    <div class="meta">${snapshots.length} snapshot${snapshots.length === 1 ? '' : 's'} · latest ${esc(latest.date)}</div>` +
    `\n    <div class="headline"><div class="big ${cls}">${latest.overall}<span class="unit">/100</span></div>` +
    `<span class="grade">Grade ${grade(latest.overall)}</span>${changeLine}</div>` +
    `\n  </header>\n  ${chart}\n  ${dimSection}` +
    foot
  );
}
