/**
 * Site-health report (ADR-014) — render an {@link AuditReport} as a
 * self-contained, theme-aware HTML document (inline CSS, no external assets, no
 * dependencies). The value of the audit, made visible and shareable.
 *
 * The health score is derived transparently from the findings (not a fabricated
 * metric) and the report says so; dimensions that could not run are shown as
 * "not run", never as a misleading score.
 */

import { ALL_DIMENSIONS, type AuditDimension, type AuditFinding, type AuditReport } from './types.js';

const DIMENSION_LABELS: Record<AuditDimension, string> = {
  seo: 'SEO',
  accessibility: 'Accessibility',
  performance: 'Performance',
  freshness: 'Freshness',
  links: 'Links & 404s',
  sitemap: 'Sitemap',
};

const SEVERITY_ORDER: Record<AuditFinding['severity'], number> = { critical: 0, warning: 1, info: 2 };

function grade(score: number): string {
  if (score >= 95) return 'A+';
  if (score >= 85) return 'A';
  if (score >= 70) return 'B';
  if (score >= 55) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

/** Health score for a dimension, derived from its findings, normalized by pages. */
function scoreDimension(findings: AuditFinding[], pages: number): number {
  const weighted = findings.reduce(
    (s, f) => s + (f.severity === 'critical' ? 3 : f.severity === 'warning' ? 1 : 0.25),
    0,
  );
  const perPage = weighted / Math.max(1, pages);
  return Math.max(0, Math.min(100, Math.round(100 - perPage * 10)));
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

interface Group {
  dimension: AuditDimension;
  severity: AuditFinding['severity'];
  title: string;
  suggestion?: string;
  pages: string[];
}

/** Collapse identical findings across pages into one row with the page list. */
function groupFindings(findings: AuditFinding[]): Group[] {
  const map = new Map<string, Group>();
  for (const f of findings) {
    const key = `${f.dimension}|${f.title}`;
    let g = map.get(key);
    if (!g) {
      g = { dimension: f.dimension, severity: f.severity, title: f.title, suggestion: f.suggestion, pages: [] };
      map.set(key, g);
    }
    if (f.page && !g.pages.includes(f.page)) g.pages.push(f.page);
  }
  return [...map.values()].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.pages.length - a.pages.length,
  );
}

function scoreClass(score: number): string {
  return score >= 85 ? 'good' : score >= 55 ? 'fair' : 'poor';
}

const STYLE = `
:root{--bg:#f6f7fb;--card:#fff;--ink:#0f1730;--muted:#5b6689;--line:#e5e8f2;--good:#1f9d5c;--fair:#c98a00;--poor:#d33a2c;--accent:#6E56CF;--crit:#d33a2c;--warn:#c98a00;--info:#4b74d1}
:root[data-theme="dark"],:root:not([data-theme="light"]){}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0b1020;--card:#121a30;--ink:#eef1f8;--muted:#9aa6c8;--line:#25304e;--good:#3ec77f;--fair:#e8b23a;--poor:#f26a5c;--accent:#a48bff;--crit:#f26a5c;--warn:#e8b23a;--info:#7fa8ff}}
:root[data-theme="dark"]{--bg:#0b1020;--card:#121a30;--ink:#eef1f8;--muted:#9aa6c8;--line:#25304e;--good:#3ec77f;--fair:#e8b23a;--poor:#f26a5c;--accent:#a48bff;--crit:#f26a5c;--warn:#e8b23a;--info:#7fa8ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.wrap{max-width:960px;margin:0 auto;padding:32px 20px 64px}
.hero{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px 28px 24px;display:flex;gap:24px;align-items:center;flex-wrap:wrap}
.hero .left{flex:1;min-width:240px}
.brand{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);font-weight:700}
.hero h1{margin:6px 0 4px;font-size:26px;word-break:break-word}
.hero .meta{color:var(--muted);font-size:13px}
.ograde{display:flex;flex-direction:column;align-items:center;gap:6px}
.ring{width:96px;height:96px;border-radius:50%;display:grid;place-items:center;font-size:34px;font-weight:800;color:#fff}
.ring.good{background:var(--good)}.ring.fair{background:var(--fair)}.ring.poor{background:var(--poor)}
.ograde .sub{font-size:12px;color:var(--muted)}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:14px;margin:22px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px}
.card .dim{font-size:13px;color:var(--muted);font-weight:600}
.card .num{font-size:30px;font-weight:800;margin-top:6px;line-height:1}
.card .num.good{color:var(--good)}.card .num.fair{color:var(--fair)}.card .num.poor{color:var(--poor)}
.card .g{font-size:12px;color:var(--muted);margin-top:2px}
.card .issues-n{margin-top:10px;font-size:12px;color:var(--muted)}
.card.skipped .num{font-size:16px;color:var(--muted);font-weight:600;margin-top:10px}
h2{font-size:18px;margin:28px 0 12px}
.issue{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:10px}
.issue .top{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.badge{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;padding:3px 8px;border-radius:999px;color:#fff}
.badge.critical{background:var(--crit)}.badge.warning{background:var(--warn)}.badge.info{background:var(--info)}
.chip{font-size:11px;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:2px 8px}
.issue .title{font-weight:600}
.issue .fix{margin-top:6px;font-size:13px;color:var(--muted)}
.issue .fix b{color:var(--ink);font-weight:600}
.issue .pages{margin-top:8px;font-size:12px;color:var(--muted);word-break:break-word}
.clean{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;text-align:center;color:var(--good);font-weight:600}
.note{font-size:12px;color:var(--muted);margin-top:6px}
footer{margin-top:32px;padding-top:16px;border-top:1px solid var(--line);color:var(--muted);font-size:12px;text-align:center}
footer a{color:var(--accent);text-decoration:none}
`.trim();

/** Render an audit report as a self-contained HTML document. */
export function generateReport(
  report: AuditReport,
  meta: { site: string; generatedAt: string },
): string {
  const pages = report.summary.pagesAudited ?? 1;
  const skippedDims = new Set(
    ALL_DIMENSIONS.filter((d) => report.skipped.some((s) => s.startsWith(d))),
  );

  const perDim = ALL_DIMENSIONS.map((dim) => {
    const findings = report.findings.filter((f) => f.dimension === dim);
    if (skippedDims.has(dim)) return { dim, skipped: true as const, score: 0, findings };
    return { dim, skipped: false as const, score: scoreDimension(findings, pages), findings };
  });
  const scored = perDim.filter((d) => !d.skipped);
  const overall = scored.length ? Math.round(scored.reduce((s, d) => s + d.score, 0) / scored.length) : 0;

  const cardsHtml = perDim
    .map((d) => {
      const label = esc(DIMENSION_LABELS[d.dim]);
      if (d.skipped) {
        return `<div class="card skipped"><div class="dim">${label}</div><div class="num">not run</div><div class="issues-n">needs a domain / EDS_DOMAIN_KEY</div></div>`;
      }
      const cls = scoreClass(d.score);
      const n = d.findings.length;
      return `<div class="card"><div class="dim">${label}</div><div class="num ${cls}">${d.score}</div><div class="g">${grade(d.score)}</div><div class="issues-n">${n} issue${n === 1 ? '' : 's'}</div></div>`;
    })
    .join('');

  const groups = groupFindings(report.findings);
  const issuesHtml = groups.length
    ? groups
        .slice(0, 100)
        .map((g) => {
          const pageList = g.pages.length
            ? `<div class="pages">${g.pages.length} page${g.pages.length === 1 ? '' : 's'}: ${esc(g.pages.slice(0, 25).join(', '))}${g.pages.length > 25 ? ', …' : ''}</div>`
            : '';
          const fix = g.suggestion ? `<div class="fix"><b>Fix:</b> ${esc(g.suggestion)}</div>` : '';
          return `<div class="issue"><div class="top"><span class="badge ${g.severity}">${g.severity}</span><span class="chip">${esc(DIMENSION_LABELS[g.dimension])}</span><span class="title">${esc(g.title)}</span></div>${fix}${pageList}</div>`;
        })
        .join('')
    : `<div class="clean">No issues found. ✓</div>`;

  const s = report.summary;
  const summaryLine =
    s.total === 0
      ? 'No issues found.'
      : `${s.critical} critical · ${s.warning} warning · ${s.info} info across ${pages} page${pages === 1 ? '' : 's'}`;
  const oCls = scoreClass(overall);
  const skippedNote = report.skipped.length
    ? `<div class="note">Not run: ${esc(report.skipped.join('; '))}</div>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Site Health — ${esc(meta.site)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
  <header class="hero">
    <div class="left">
      <div class="brand">EDS Site Health</div>
      <h1>${esc(meta.site)}</h1>
      <div class="meta">Audited ${esc(meta.generatedAt)} · ${pages} page${pages === 1 ? '' : 's'} inspected</div>
      ${skippedNote}
    </div>
    <div class="ograde">
      <div class="ring ${oCls}">${grade(overall)}</div>
      <div class="sub">${overall}/100 · ${esc(summaryLine)}</div>
    </div>
  </header>
  <section class="cards">${cardsHtml}</section>
  <h2>Prioritized issues${groups.length > 100 ? ` <span class="chip">showing 100 of ${groups.length}</span>` : ''}</h2>
  ${issuesHtml}
  <footer>
    Generated by <a href="https://www.npmjs.com/package/@focusgts/eds-mcp-server">@focusgts/eds-mcp-server</a> ·
    health score derived from findings · every issue above can be auto-fixed with the <code>eds_fix_*</code> tools.
  </footer>
</div>
</body>
</html>`;
}
