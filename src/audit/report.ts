/**
 * Site-health report (ADR-014) — render an {@link AuditReport} as a
 * self-contained, theme-aware HTML document (inline CSS + inline SVG gauges, no
 * external assets, no dependencies). The value of the audit, made visible and
 * shareable.
 *
 * The health score is derived transparently from the findings (not a fabricated
 * metric) and the report says so; dimensions that could not run are shown as
 * "not run", never as a misleading score.
 */

import { ALL_DIMENSIONS, type AuditDimension, type AuditFinding, type AuditReport } from './types.js';
import { grade, scoreClass, scoreDimension } from './score.js';
import { NAVIGATOR_ACCENT, NAVIGATOR_LOGO, NAVIGATOR_NAME } from './brand-navigator.js';

const DIMENSION_LABELS: Record<AuditDimension, string> = {
  seo: 'SEO',
  accessibility: 'Accessibility',
  performance: 'Performance',
  freshness: 'Freshness',
  links: 'Links & 404s',
  sitemap: 'Sitemap',
};

/** Plain-English, one-line explanation of each dimension — shown on hover. */
const DIMENSION_TIPS: Record<AuditDimension, string> = {
  seo: 'How easily Google can find and understand your pages — titles, descriptions, headings and page structure.',
  accessibility: 'How usable your site is for people with disabilities — image alt text, form labels, headings and landmarks.',
  performance: 'How fast your pages load for real visitors (Google’s Core Web Vitals), measured from Adobe’s real-user data.',
  freshness: 'How recently your pages were updated — flags stale content that hasn’t been touched in a long time.',
  links: 'Broken links and “page not found” (404) errors your real visitors are actually hitting.',
  sitemap: 'Whether your sitemap correctly lists your pages so search engines can discover all of them.',
};

const SEVERITY_ORDER: Record<AuditFinding['severity'], number> = { critical: 0, warning: 1, info: 2 };

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Inline SVG ring gauge. Colors/type come from CSS classes so it stays theme-aware. */
function gauge(opts: { size: number; sw: number; score: number; center: string; centerSize: number }): string {
  const c = opts.size / 2;
  const r = c - opts.sw / 2 - 1;
  const circ = 2 * Math.PI * r;
  const off = circ * (1 - Math.max(0, Math.min(100, opts.score)) / 100);
  const cls = scoreClass(opts.score);
  return (
    `<svg class="gauge" width="${opts.size}" height="${opts.size}" viewBox="0 0 ${opts.size} ${opts.size}" aria-hidden="true">` +
    `<circle class="track" cx="${c}" cy="${c}" r="${r.toFixed(1)}" stroke-width="${opts.sw}" fill="none"/>` +
    `<circle class="arc ${cls}" cx="${c}" cy="${c}" r="${r.toFixed(1)}" stroke-width="${opts.sw}" fill="none" stroke-linecap="round" stroke-dasharray="${circ.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 ${c} ${c})"/>` +
    `<text class="gtext ${cls}" x="${c}" y="${c}" text-anchor="middle" dominant-baseline="central" style="font-size:${opts.centerSize}px">${opts.center}</text>` +
    `</svg>`
  );
}

interface Group {
  dimension: AuditDimension;
  severity: AuditFinding['severity'];
  title: string;
  suggestion?: string;
  pages: string[];
  /** True when the underlying findings carry a fix this server can apply (ADR-015). */
  fixable: boolean;
}

function groupFindings(findings: AuditFinding[]): Group[] {
  const map = new Map<string, Group>();
  for (const f of findings) {
    const key = `${f.dimension}|${f.title}`;
    let g = map.get(key);
    if (!g) {
      g = { dimension: f.dimension, severity: f.severity, title: f.title, suggestion: f.suggestion, pages: [], fixable: false };
      map.set(key, g);
    }
    if (f.fix) g.fixable = true;
    if (f.page && !g.pages.includes(f.page)) g.pages.push(f.page);
  }
  return [...map.values()].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.pages.length - a.pages.length,
  );
}

const STYLE = `
:root{
  --bg:#eef1f7;--panel:#ffffff;--ink:#0e1730;--muted:#5c688a;--faint:#8a95b4;--line:#e4e8f1;--track:#e7ebf4;
  --accent:#5b54e6;--good:#12a150;--fair:#d18700;--poor:#e0402f;--navp:#7647dd;
  --shadow:0 1px 2px rgba(16,24,48,.04),0 8px 24px rgba(16,24,48,.06);
  --mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --bg:#080c18;--panel:#111a30;--ink:#eef2fb;--muted:#98a4c6;--faint:#6f7ca3;--line:#212d4c;--track:#1c2743;
  --accent:#9a8dff;--good:#38c47f;--fair:#eab53f;--poor:#f26a5a;--navp:#9a8dff;
  --shadow:0 1px 2px rgba(0,0,0,.3),0 10px 30px rgba(0,0,0,.35);
}}
:root[data-theme="dark"]{
  --bg:#080c18;--panel:#111a30;--ink:#eef2fb;--muted:#98a4c6;--faint:#6f7ca3;--line:#212d4c;--track:#1c2743;
  --accent:#9a8dff;--good:#38c47f;--fair:#eab53f;--poor:#f26a5a;--navp:#9a8dff;
  --shadow:0 1px 2px rgba(0,0,0,.3),0 10px 30px rgba(0,0,0,.35);
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:15px;line-height:1.55;-webkit-font-smoothing:antialiased}
.wrap{max-width:900px;margin:0 auto;padding:40px 20px 72px}
.gauge .track{stroke:var(--track)}
.gauge .arc.good{stroke:var(--good)}.gauge .arc.fair{stroke:var(--fair)}.gauge .arc.poor{stroke:var(--poor)}
.gauge .gtext{font-family:var(--mono);font-weight:700;font-variant-numeric:tabular-nums}
.gtext.good{fill:var(--good)}.gtext.fair{fill:var(--fair)}.gtext.poor{fill:var(--poor)}

.hero{position:relative;background:var(--panel);border:1px solid var(--line);border-radius:20px;box-shadow:var(--shadow);
  padding:30px 32px;display:flex;gap:28px;align-items:center;flex-wrap:wrap;overflow:hidden}
.hero::before{content:"";position:absolute;inset:0 0 auto 0;height:3px;background:linear-gradient(90deg,var(--accent),transparent 70%)}
.hero-main{flex:1;min-width:230px}
.brand{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--accent);font-weight:700}
.hero h1{margin:8px 0 4px;font-size:28px;font-weight:800;letter-spacing:-.01em;text-wrap:balance;word-break:break-word}
.meta{color:var(--muted);font-size:13px}
.pills{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}
.pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--muted);
  background:var(--bg);border:1px solid var(--line);border-radius:999px;padding:4px 11px}
.pill::before{content:"";width:8px;height:8px;border-radius:50%;background:currentColor}
.pill.crit{color:var(--poor)}.pill.warn{color:var(--fair)}.pill.info{color:var(--accent)}
.hero-gauge{display:flex;flex-direction:column;align-items:center;gap:8px}
.hero-gauge .cap{font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}

.section-title{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);font-weight:700;margin:34px 2px 14px}
.gauges{display:grid;grid-template-columns:repeat(var(--cols,3),minmax(0,1fr));gap:14px}
@media(max-width:560px){.gauges{grid-template-columns:repeat(2,minmax(0,1fr))}}
.ga{position:relative;background:var(--panel);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow);
  padding:18px 12px 16px;display:flex;flex-direction:column;align-items:center;gap:6px;text-align:center;
  cursor:help;outline:none;transition:border-color .14s,box-shadow .14s}
.ga:hover,.ga:focus-visible{border-color:var(--accent)}
.ga:focus-visible{box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 30%,transparent)}
.ga .lab{font-size:13px;font-weight:600}
.ga .sub{font-size:11.5px;color:var(--muted)}
.ga.skip{justify-content:center;min-height:150px;color:var(--faint)}
.ga.skip .lab{color:var(--muted);font-size:14px}
.ga.skip .nr{font-size:11.5px;font-weight:600;color:var(--faint);text-transform:uppercase;letter-spacing:.06em}
/* Hover / focus explainer bubble */
.ga[data-tip]::after{content:attr(data-tip);position:absolute;left:50%;bottom:calc(100% + 9px);
  transform:translateX(-50%) translateY(4px);width:230px;max-width:78vw;
  background:var(--ink);color:var(--panel);font-size:12px;line-height:1.45;font-weight:500;text-align:left;
  padding:10px 12px;border-radius:10px;box-shadow:0 8px 24px rgba(16,24,48,.22);
  opacity:0;pointer-events:none;transition:opacity .14s,transform .14s;z-index:10}
.ga[data-tip]::before{content:"";position:absolute;left:50%;bottom:calc(100% + 3px);transform:translateX(-50%);
  border:6px solid transparent;border-top-color:var(--ink);opacity:0;transition:opacity .14s;z-index:10}
.ga[data-tip]:hover::after,.ga[data-tip]:focus-visible::after{opacity:1;transform:translateX(-50%) translateY(0)}
.ga[data-tip]:hover::before,.ga[data-tip]:focus-visible::before{opacity:1}
@media(hover:none){.ga{cursor:default}}

.issue{position:relative;background:var(--panel);border:1px solid var(--line);border-left:4px solid var(--line);
  border-radius:12px;box-shadow:var(--shadow);padding:14px 16px 14px 18px;margin-bottom:10px}
.issue.critical{border-left-color:var(--poor)}
.issue.warning{border-left-color:var(--fair)}
.issue.info{border-left-color:var(--accent)}
.itop{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.sev{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;padding:2px 8px;border-radius:6px;color:#fff}
.issue.critical .sev{background:var(--poor)}.issue.warning .sev{background:var(--fair)}.issue.info .sev{background:var(--accent)}
.chip{font-size:11px;font-weight:600;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:2px 9px}
.fixable{font-size:10.5px;font-weight:700;letter-spacing:.02em;color:var(--good);
  background:color-mix(in srgb,var(--good) 12%,transparent);border:1px solid color-mix(in srgb,var(--good) 34%,transparent);
  border-radius:999px;padding:2px 9px;white-space:nowrap}
.fixlead{font-size:13.5px;color:var(--muted);background:var(--panel);border:1px solid var(--line);border-radius:12px;
  box-shadow:var(--shadow);padding:12px 15px;margin-bottom:14px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.fixlead code,footer code{font-family:var(--mono)}
.ititle{font-weight:600}
.count{margin-left:auto;font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}
.fix{margin-top:7px;font-size:13.5px;color:var(--muted)}
.fix b{color:var(--ink);font-weight:600}
.pages{margin-top:8px;font-size:11.5px;color:var(--faint);font-family:var(--mono);word-break:break-word}
.clean{background:var(--panel);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);
  padding:26px;text-align:center;color:var(--good);font-weight:700;font-size:17px}
.note{font-size:12px;color:var(--faint);margin-top:8px}
footer{margin-top:34px;padding-top:18px;border-top:1px solid var(--line);color:var(--faint);font-size:12px;text-align:center;line-height:1.7}
footer a{color:var(--accent);text-decoration:none}
footer code{font-family:var(--mono);font-size:11.5px;background:var(--bg);border:1px solid var(--line);border-radius:5px;padding:1px 5px}
/* Navigator credit — subtle but unmistakable, on every report (ADR-017) */
.nav-credit{margin-bottom:16px;padding:18px 20px;background:var(--panel);border:1px solid var(--line);
  border-top:3px solid var(--navp);border-radius:14px;box-shadow:var(--shadow);text-align:center}
.nav-mark{font-size:17px;font-weight:800;letter-spacing:-.01em;color:var(--ink)}
.nav-mark .nav-hl{color:var(--navp)}
.nav-tag{font-size:12.5px;color:var(--muted);margin-top:4px}
.nav-cta{margin-top:10px;font-size:12.5px;font-weight:600}
.nav-cta a{color:var(--navp);text-decoration:none}
.nav-cta a:hover{text-decoration:underline}
.nav-cta .sep{color:var(--faint);margin:0 9px}
.fine{font-size:12px;color:var(--faint);line-height:1.6}

/* Branding (ADR-017) — client-ready deliverable */
.letterhead{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;
  padding-bottom:18px;margin-bottom:20px;border-bottom:2px solid var(--accent)}
.lh-logo{height:64px;width:auto;max-width:340px;display:block}
.lh-wordmark{font-size:20px;font-weight:800;letter-spacing:-.01em;color:var(--ink)}
.lh-for{text-align:right;font-size:12px;color:var(--faint);line-height:1.5}
.lh-for .lh-label{display:block;text-transform:uppercase;letter-spacing:.1em;font-size:10.5px}
.lh-for b{color:var(--ink);font-size:15px;font-weight:700}
.lh-for .lh-date{display:block;font-variant-numeric:tabular-nums}
.exec{background:var(--panel);border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:12px;
  box-shadow:var(--shadow);padding:20px 24px;font-size:15px;line-height:1.65;color:var(--muted)}
.exec p{margin:0 0 12px}.exec p:last-child{margin:0}.exec p:first-child{color:var(--ink)}
.pdfbtn{position:fixed;top:16px;right:16px;z-index:20;font:inherit;font-size:13px;font-weight:650;cursor:pointer;
  background:var(--accent);color:#fff;border:none;border-radius:9px;padding:9px 15px;box-shadow:0 6px 20px rgba(16,24,48,.25)}
.pdfbtn:hover{filter:brightness(1.06)}

@media print{
  :root{--bg:#fff;--panel:#fff;--ink:#0e1730;--muted:#3d485f;--faint:#6b748c;--line:#d7dced;--track:#e7ebf4}
  *{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  body{background:#fff}
  .wrap{max-width:none;padding:0}
  .pdfbtn{display:none}
  .hero,.ga,.issue,.exec,.fixlead,.gauges,.clean{box-shadow:none}
  .issue,.ga,.exec,.hero,.clean{break-inside:avoid;page-break-inside:avoid}
  .section-title{break-after:avoid;page-break-after:avoid}
  a[href]{color:inherit;text-decoration:none}
}
`.trim();

/** Agency branding for a client-ready report (ADR-017). All optional. */
export interface BrandOptions {
  /** Agency name, rendered as the "prepared by" wordmark. */
  agency?: string;
  /** The client this report is prepared for. */
  preparedFor?: string;
  /** Hex accent color that replaces the report's default (validated). */
  accentColor?: string;
  /** A logo, as a `data:` URI or `https://` URL, embedded in the letterhead. */
  logo?: string;
}

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
// Only a `data:` image URI — never `https://`. This keeps every report fully
// self-contained (works offline, no CSP issues) and, crucially, prevents a report
// emailed to a client from becoming a tracking beacon that pings a logo host on
// open (ADR-017 privacy). A malformed data-URI degrades to the wordmark at render.
const SAFE_LOGO = /^data:image\/[a-z+]+;/i;
/** Max embedded logo size (a data-URI). A larger custom logo falls back to the default. */
const LOGO_CAP = 512 * 1024;

/** A custom accent must be valid hex AND not so light it vanishes on the light ground. */
function usableAccent(hex: string): boolean {
  if (!HEX_COLOR.test(hex)) return false;
  const h = hex.slice(1);
  const full = h.length === 3 ? h.replace(/./g, (c) => c + c) : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum <= 0.75; // reject near-white accents (would be invisible / illegible)
}

/** A deterministic, factual executive summary from the numbers (agent can override). */
function factualSummary(
  report: AuditReport,
  overall: number,
  perDim: Array<{ dim: AuditDimension; skipped: boolean; score: number }>,
  fixableGroups: number,
  site: string,
): string {
  const s = report.summary;
  const scored = perDim.filter((d) => !d.skipped);
  const sorted = [...scored].sort((a, b) => b.score - a.score);
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];
  const parts: string[] = [];
  parts.push(
    `${site} scores ${overall}/100 (grade ${grade(overall)}) across ${s.total} finding${s.total === 1 ? '' : 's'} on ${report.summary.pagesAudited ?? 0} page${(report.summary.pagesAudited ?? 0) === 1 ? '' : 's'}.`,
  );
  if (s.critical > 0 || s.warning > 0) {
    parts.push(
      `${s.critical} critical and ${s.warning} warning issue${s.critical + s.warning === 1 ? '' : 's'} were identified${fixableGroups > 0 ? `, of which ${fixableGroups} issue type${fixableGroups === 1 ? '' : 's'} can be fixed in place` : ''}.`,
    );
  } else {
    parts.push('No critical or warning issues were found — the site is in strong shape.');
  }
  if (best && worst && best.dim !== worst.dim) {
    parts.push(
      `${DIMENSION_LABELS[best.dim]} is the strongest area (${best.score}/100); ${DIMENSION_LABELS[worst.dim]} needs the most attention (${worst.score}/100).`,
    );
  }
  return parts.join(' ');
}

/** Render an audit report as a self-contained HTML document. */
export function generateReport(
  report: AuditReport,
  meta: { site: string; generatedAt: string; brand?: BrandOptions; executiveSummary?: string },
): string {
  const pages = report.summary.pagesAudited ?? 1;
  // Only card the dimensions the audit ATTEMPTED — a dimension excluded by the
  // `dimensions` filter is neither scored nor shown (never a fake 100). Fall back
  // to all dimensions for older reports without the field.
  const attempted = report.dimensions ?? ALL_DIMENSIONS;
  const skippedDims = new Set(attempted.filter((d) => report.skipped.some((s) => s.startsWith(d))));

  const perDim = attempted.map((dim) => {
    const findings = report.findings.filter((f) => f.dimension === dim);
    if (skippedDims.has(dim)) return { dim, skipped: true as const, score: 0, findings };
    return { dim, skipped: false as const, score: scoreDimension(findings, pages), findings };
  });
  const scored = perDim.filter((d) => !d.skipped);
  const overall = scored.length ? Math.round(scored.reduce((s, d) => s + d.score, 0) / scored.length) : 0;

  const gaugesHtml = perDim
    .map((d) => {
      const label = esc(DIMENSION_LABELS[d.dim]);
      const tip = esc(DIMENSION_TIPS[d.dim]);
      if (d.skipped) {
        return (
          `<div class="ga skip" tabindex="0" data-tip="${tip}" aria-label="${label}: ${tip}">` +
          `<div class="lab">${label}</div>` +
          `<div class="nr">Not run yet</div>` +
          `<div class="sub">This one reads your real-visitor data — add your site’s live domain to switch it on.</div></div>`
        );
      }
      const n = d.findings.length;
      return (
        `<div class="ga" tabindex="0" data-tip="${tip}" aria-label="${label}: ${tip}">` +
        `${gauge({ size: 92, sw: 8, score: d.score, center: String(d.score), centerSize: 26 })}` +
        `<div class="lab">${label}</div>` +
        `<div class="sub">Grade ${grade(d.score)} · ${n} issue${n === 1 ? '' : 's'}</div></div>`
      );
    })
    .join('');

  // Choose a column count so the cards always split into even rows — never a
  // lone orphan on its own line. Favor 3-wide, but drop to 2 for 4 cards (2×2).
  const nCards = perDim.length;
  const cols = nCards <= 3 ? nCards : nCards === 4 ? 2 : 3;

  const groups = groupFindings(report.findings);
  const fixableGroups = groups.filter((g) => g.fixable).length;
  const issuesHtml = groups.length
    ? groups
        .slice(0, 100)
        .map((g) => {
          const pageList = g.pages.length
            ? `<div class="pages">${g.pages.length} page${g.pages.length === 1 ? '' : 's'}: ${esc(g.pages.slice(0, 25).join('  ·  '))}${g.pages.length > 25 ? '  ·  …' : ''}</div>`
            : '';
          const fix = g.suggestion ? `<div class="fix"><b>Fix</b> — ${esc(g.suggestion)}</div>` : '';
          const count = g.pages.length ? `<span class="count">${g.pages.length} page${g.pages.length === 1 ? '' : 's'}</span>` : '';
          const fixable = g.fixable
            ? `<span class="fixable" title="This server can fix this for you — ask your AI agent to apply it (previewed first, one-click undo).">✦ Fixable</span>`
            : '';
          return (
            `<div class="issue ${g.severity}"><div class="itop">` +
            `<span class="sev">${g.severity}</span>` +
            `<span class="chip">${esc(DIMENSION_LABELS[g.dimension])}</span>` +
            `<span class="ititle">${esc(g.title)}</span>${fixable}${count}</div>${fix}${pageList}</div>`
          );
        })
        .join('')
    : `<div class="clean">No issues found. ✓</div>`;

  const s = report.summary;
  const skippedLabels = ALL_DIMENSIONS.filter((d) => skippedDims.has(d)).map((d) => DIMENSION_LABELS[d]);
  const skippedNote = skippedLabels.length
    ? `<div class="note">Not measured yet: ${esc(skippedLabels.join(' · '))} — these read your site’s real-visitor data. Add your live domain to switch them on.</div>`
    : '';

  // --- Branding (ADR-017) — Navigator is the DEFAULT on every report; the
  // optional brand.* inputs override it. All inputs validated before touching
  // markup/CSS. The full treatment (letterhead + accent + executive summary +
  // Save-as-PDF) always renders — every report is a Navigator-branded artifact.
  const brand = meta.brand;
  const accent = brand?.accentColor && usableAccent(brand.accentColor) ? brand.accentColor : NAVIGATOR_ACCENT;
  const logo = brand?.logo && SAFE_LOGO.test(brand.logo) && brand.logo.length <= LOGO_CAP ? brand.logo : NAVIGATOR_LOGO;
  const customAgency = brand?.agency?.trim();
  const agency = customAgency || NAVIGATOR_NAME;
  const preparedFor = brand?.preparedFor?.trim();

  const letterhead =
    `<div class="letterhead">` +
    // If a custom logo fails to load (bad data-URI), hide it and reveal the
    // wordmark — never a broken-image icon on a client-facing document (ADR-017).
    `<div class="lh-brand"><img class="lh-logo" src="${esc(logo)}" alt="${esc(agency)}" onerror="this.style.display='none';this.nextElementSibling.hidden=false"><span class="lh-wordmark" hidden>${esc(agency)}</span></div>` +
    (preparedFor
      ? `<div class="lh-for"><span class="lh-label">Prepared for</span><b>${esc(preparedFor)}</b><span class="lh-date">${esc(meta.generatedAt)}</span></div>`
      : `<div class="lh-for"><span class="lh-date">${esc(meta.generatedAt)}</span></div>`) +
    `</div>`;

  const summaryText = meta.executiveSummary?.trim() || factualSummary(report, overall, perDim, fixableGroups, meta.site);
  const execSection =
    `<div class="section-title">Executive summary</div>` +
    `<section class="exec">${summaryText.split(/\n\n+/).map((p) => `<p>${esc(p.trim())}</p>`).join('')}</section>`;

  const pdfButton = `<button class="pdfbtn" onclick="window.print()">↧ Save as PDF</button>`;
  // The Navigator footer credit already carries attribution; only add a
  // "Prepared by" line when a custom (white-label) agency is supplied.
  const footerBrand = customAgency ? `Prepared by ${esc(customAgency)} · ` : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Website Health Report — ${esc(meta.site)}</title>
<style>${STYLE}</style>
</head>
<body>
${pdfButton}
<div class="wrap" style="--accent:${accent}">
  ${letterhead}
  <header class="hero">
    <div class="hero-main">
      <div class="brand">Website Health Report</div>
      <h1>${esc(meta.site)}</h1>
      <div class="meta">Audited ${esc(meta.generatedAt)} · ${pages} page${pages === 1 ? '' : 's'} inspected</div>
      <div class="pills">
        <span class="pill crit">${s.critical} critical</span>
        <span class="pill warn">${s.warning} warning</span>
        <span class="pill info">${s.info} info</span>
      </div>
      ${skippedNote}
    </div>
    <div class="hero-gauge">
      ${gauge({ size: 132, sw: 11, score: overall, center: grade(overall), centerSize: 40 })}
      <div class="cap">${overall}/100 overall</div>
    </div>
  </header>

  ${execSection}

  <div class="section-title">By dimension</div>
  <section class="gauges" style="--cols:${cols}">${gaugesHtml}</section>

  <div class="section-title">Prioritized issues${groups.length > 100 ? ` — showing 100 of ${groups.length}` : ''}</div>
  ${fixableGroups > 0 ? `<div class="fixlead"><span class="fixable">✦ Fixable</span> ${fixableGroups} of ${groups.length} issue type${groups.length === 1 ? '' : 's'} can be fixed in place — ask your AI agent to apply them with <code>eds_fix_audit</code> (previewed first, one-click undo).</div>` : ''}
  ${issuesHtml}

  <footer>
    <div class="nav-credit">
      <div class="nav-mark">Focus GTS <span class="nav-hl">▸ Navigator</span></div>
      <div class="nav-tag">Free EDS site-health check — from the team behind Adobe Edge Delivery MCP tooling.</div>
      <div class="nav-cta"><a href="https://focusgts.com/contactus/">Book a call</a><span class="sep">·</span><a href="https://focusgts.com/navigator/">Explore Navigator</a><span class="sep">·</span><a href="https://focusgts.com/eds-score/">Free audit</a></div>
    </div>
    <div class="fine">
      ${footerBrand}Generated by <a href="https://www.npmjs.com/package/@focusgts/eds-mcp-server">@focusgts/eds-mcp-server</a> · health score derived from findings${fixableGroups > 0 ? ` · issues marked <span class="fixable">✦ Fixable</span> can be repaired with the <code>eds_fix_*</code> tools — safely, with undo` : ''}.
    </div>
  </footer>
</div>
</body>
</html>`;
}
