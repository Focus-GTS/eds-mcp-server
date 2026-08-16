# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Track it — site health over time** (ADR-016). Two tools turn the one-off audit
  into a trend:
  - `eds_audit_snapshot` — run the site audit and record its scores (overall +
    per-dimension + counts) as a row in a **history sheet in the site's own
    Document Authoring content** (default `/audit-history.json`, kept **private /
    unpublished** by default — scores stay yours). One row per day (a same-day
    re-run updates it; idempotent when nothing changed). Returns the change since
    the last snapshot (e.g. "89, ▲7 vs 2026-08-09"). `dryRun` previews the row;
    `publish:true` makes the sheet live. Requires `EDS_DA_TOKEN`.
  - `eds_audit_trend` — read that history and return a **self-contained,
    theme-aware HTML trend view**: an SVG sparkline of the overall score over time
    plus per-dimension movement since the last snapshot. `format:'text'` returns a
    short summary instead. Read-only.
  - Health scoring is now shared (`src/audit/score.ts` `computeScores`) so the
    report, snapshot, and trend always agree. History stored as an EDS sheet, read
    defensively (same discipline as the redirects sheet). 40 tools total.

## [0.12.0] - 2026-08-16

### Added
- **Fix-from-audit — close the loop** (ADR-015). `eds_fix_audit` applies the
  audit's fixable findings — SEO metadata **and** broken-link redirects — in a
  single reversible batch. Audit findings now carry a stable `code` and, where a
  shipped writer can repair them, a `fix` descriptor; the tool takes agent-
  supplied `metadata` and/or `redirects` values (it **never fabricates copy**) and
  pushes every changed document (metadata pages + `/redirects.json`) in one
  `withUndo` push, so a **single** `eds_da_rollback` reverses the whole mixed
  batch. `dryRun` previews the combined plan; `publish:true` makes it live. Pure
  orchestration over the ADR-011/013 writers — no new write logic. The report
  (ADR-014) now marks repairable findings with a **✦ Fixable** chip and an honest
  "N of M can be fixed in place" lead. 38 tools total.
- **Shareable site-health report** (ADR-014). `eds_audit_report` runs the site
  audit and returns a **self-contained, theme-aware HTML report** (inline
  CSS/SVG, no external assets, no dependencies): an overall grade, per-dimension
  health scores (SEO, accessibility, performance, freshness, links, sitemap)
  shown as circular gauges, and a prioritized issue list — identical findings
  collapsed across pages — each with its suggested fix and a hover explainer.
  Dimensions that couldn't run are shown as "not run yet", never a fake score;
  the health score is derived transparently from the findings. Same options as
  `eds_audit_site`. Read-only.

## [0.11.0] - 2026-08-15

### Added
- **Redirect fixes — close the 404 loop** (ADR-013). `eds_fix_redirect` fixes
  broken links by adding 301 redirect rules to the site's `redirects` sheet — the
  EDS mechanism served at `/redirects.json`. Takes one or many `{ source,
  destination }` rules; reads the existing `/redirects` document (or creates a new
  sheet), updates a rule for a matching Source or appends a new row, and
  **preserves the sheet's headers and any extra columns** (no data loss).
  Idempotent, routed through the safe-writes path (`dryRun` + `withUndo` →
  `eds_da_rollback`), with optional `publish`. All rules live in one sheet, so a
  single tool handles one rule or many. Pairs with `eds_audit_site` (which
  surfaces the top 404s from real-user data) — the audit now has a fix for every
  major finding type. 36 tools total.

## [0.10.0] - 2026-08-14

### Added
- **Bulk safe fixes** (ADR-012). `eds_bulk_fix_metadata` — fix SEO/social metadata
  across many pages in one reversible operation. Takes `pages: [{ path, metadata }]`
  (the agent supplies each page's values), applies the ADR-011 metadata writer to
  each, and pushes every changed page in a single `eds_da_push withUndo` so the
  result carries **one** undo object that reverts the entire batch via
  `eds_da_rollback`. `dryRun` previews the whole plan; `publish:true` previews +
  publishes the changed pages (bounded concurrency). Partial-failure tolerant —
  unreadable pages are recorded, never abort the batch. 35 tools total.

## [0.9.0] - 2026-08-14

### Added
- **Safe fixes — repair what the audit finds** (ADR-011). The "Executor" the
  ops-agent ADRs envisioned, now buildable on top of safe writes:
  - `eds_fix_metadata` — add/update a page's title, meta description, and Open
    Graph image by editing its Document Authoring **Metadata block**. Idempotent
    (merges into an existing block, never duplicates; preserves untouched rows),
    routed through the ADR-009 safe-writes path (`dryRun` preview + `withUndo` →
    `eds_da_rollback`). Optional `publish:true` previews+publishes so the change
    goes live. The agent supplies the content; the tool writes it correctly and
    reversibly. Block format grounded in Adobe's own `helix-html-pipeline`
    (`extract-metadata.js`). 34 tools total.

### Changed
- `login()` gains a configurable `timeoutMs` (the hardcoded 120s browser-callback
  window was too tight for interactive sign-in).

## [0.8.0] - 2026-08-14

### Added
- **Content audit — find what's wrong** (ADR-010). A read-only quality-audit
  layer that returns a prioritized, actionable findings list:
  - `eds_audit_page` — SEO + accessibility checks on a single page's HTML
    (missing/short title & description, no/duplicate H1, noindex, missing
    canonical/OG/JSON-LD; images with no alt attribute, heading-level skips,
    missing landmarks, non-descriptive link text, unlabeled form inputs).
    Checks are EDS-aware — e.g. `alt=""` (valid decorative markup) and the
    client-side `<html lang>` are not false-flagged.
  - `eds_audit_site` — bulk sweep (bounded concurrency, `maxPages` cap) running
    the per-page checks across the page index plus site-level checks: freshness
    (query-index `lastModified`), sitemap coverage, and — when a `domain` is
    supplied — performance (Core Web Vitals) and 404s from Adobe RUM. Filter by
    `pathPrefix` and `dimensions`.
  Findings use a unified severity-first shape (`critical`/`warning`/`info` +
  dimension + suggested fix). RUM dimensions are recorded in `skipped` (never
  dropped silently) when no domain/key is available. No Google PageSpeed
  dependency — performance uses Adobe's own real-user data. 33 tools total.

## [0.7.0] - 2026-08-14

### Added
- **Safe writes — dry-run preview and rollback** (ADR-009). Makes bulk writes
  safe by default, the trust differentiator for pointing the server at a
  production site:
  - `eds_da_push` gains `dryRun` — read the current remote state for each path
    and return a plan (`N create, M update, K unchanged`, with per-document
    line-diff counts) **without writing anything**. Always safe to run first.
  - `eds_da_push` gains `withUndo` — capture each affected document's prior
    state before overwriting and return an `undo` object (prior content of
    updated docs + paths of newly-created docs).
  - `eds_da_rollback` (new tool) — take that `undo` object and reverse the push:
    restore updated docs to their prior content and delete the docs the push
    created. Partial-failure tolerant; reports what was restored/removed.
  Builds on DA's native per-write versioning (each write is already snapshotted,
  tagged `x-da-initiator: mcp`). 31 tools total.

## [0.6.0] - 2026-08-13

### Added
- **Bulk content operations — the agent-native "clone" model** (ADR-008). Two
  tools deliver the efficiency of `aem content clone` (bulk-fetch → operate →
  bulk-push) for agents, with no local checkout or `aem-cli` dependency:
  - `eds_da_export` — recursively fetch a whole DA subtree in one call
    (bounded concurrency), returning every document's source. Capped by
    `maxFiles` with a `truncated` flag; individual fetch failures are reported,
    never dropped silently.
  - `eds_da_push` — write many `{ path, content }` documents back in one call
    (bounded concurrency), returning per-document succeeded/failed.
  Both run through the v0.5.0 `DaClient` (same auth, `.html` normalization,
  traversal guard, bounded retry). 30 tools total.

## [0.5.0] - 2026-08-12

### Added
- **Document Authoring (DA) content access** (ADR-007). Seven new `eds_da_*`
  tools give direct access to a site's authored source via `admin.da.live` —
  the source of truth, not the rendered/previewed output: `list_sources`,
  `get_source`, `put_source`, `delete_source`, `copy_source`, `move_source`,
  `get_versions`. Endpoints and request shapes are adopted from Adobe's
  `adobe-rnd/da-mcp` (credited). Auth is a bearer token via `EDS_DA_TOKEN`
  (org/site default to `EDS_OWNER`/`EDS_REPO`, overridable with
  `EDS_DA_ORG`/`EDS_DA_REPO`). Without a token the DA tools return a friendly
  "set EDS_DA_TOKEN" message. Same retry/backoff and traversal-guard discipline
  as the EDS client.

### Changed
- **Bounded retry time.** Retries now share a total sleep budget (default 20s),
  so a hostile or large `Retry-After` can no longer make a single tool call hang
  for the full per-retry cap × attempts. Applies to both the EDS and DA clients.
- **Search no longer refetches the index on every call.** `eds_search_pages`
  caches the query index briefly (60s), so paging through results and
  back-to-back searches reuse it instead of pulling thousands of rows each time.

## [0.4.0] - 2026-08-11

### Added
- `eds_get_job_status` tool to poll the progress of an asynchronous bulk job.
- `logout` CLI subcommand to clear the cached admin token.
- `offset` parameter on `eds_search_pages` to page through match results.
- Automatic retry with backoff (honoring `Retry-After`) on `429`/`503` responses.

### Changed
- **Bulk preview/publish are now asynchronous jobs.** `eds_bulk_preview` and
  `eds_bulk_publish` use the Admin API's native bulk endpoints
  (`POST /preview|live/{owner}/{repo}/{ref}/*` with a `{ paths }` body), which
  queue one server-side job and return a handle immediately, instead of looping
  one request per path. This removes the client-timeout ceiling on large
  batches; the per-page cap is raised from 100 to 1000 and a `forceUpdate`
  option is exposed. Track completion with `eds_get_job_status`.
- **Friendlier API errors.** `401` clears the cached login token and prompts a
  re-login (or flags a rejected `EDS_API_KEY`); `403` explains it is a
  permission issue; `404` and `429` get actionable messages. Errors are now a
  typed `EdsApiError` carrying the status.
- Importing the package no longer starts a server: `main`/`types` point at a new
  side-effect-free library entry (`lib.ts`); the stdio CLI remains the `bin`.

### Fixed
- `eds_get_redirects` no longer reports every failure as "no redirects" — only a
  genuine `404` maps to empty; auth/network errors now surface.
- Published tarball no longer ships dangling source maps (they resolved to
  nothing without `src/`).

### Internal
- Working ESLint (flat config) wired into CI, the release gates, and
  `prepublishOnly`; test coverage reporting added.

## [0.3.2] - 2026-08-10

### Security
- **Path handling hardened.** Each path segment is now decoded to catch
  disguised traversal (`..`, `%2e%2e`, backslash separators) and then
  percent-encoded, so a crafted path can no longer escape the intended
  `/{verb}/{owner}/{repo}/{ref}/` prefix. Because the admin token is scoped to
  the user's identity across every site they can reach — not to a single repo —
  this closes a path where a prompt-injected agent could act on another site.
  Query/fragment injection (`?`, `#`) is closed by the same change.
- **Login callback locked down.** The `state` nonce is now mandatory (a missing
  state is rejected, matching Adobe's own `helix-cli` contract), and the
  callback rejects any non-loopback client. Together these close a
  token-injection / session-fixation vector where a page visited during login
  could plant an attacker-chosen token.
- **`EDS_DOMAIN_KEY` no longer leaks.** The domain key is redacted from error
  messages — both the request URL and the upstream response body.

### Fixed
- `eds_list_pages` and `eds_search_pages` no longer fail the entire call when a
  query-index row omits `lastModified`; the value degrades to a dash. Timestamps
  emitted in milliseconds are normalized instead of rendering a garbage year.
- `eds_unpublish_page` and `eds_purge_cache` no longer print `undefined` for the
  path on a 204 No Content response; they fall back to the requested path.
- The login callback now logs a clear reason when it rejects a non-loopback
  caller (e.g. a containerized server reached from the host browser), instead of
  leaving the user with a misleading 120-second timeout.

### Changed
- `EdsPublishResponse.path`, `EdsCacheResponse.path`, and
  `EdsQueryIndexEntry.lastModified` are now typed optional, matching the real
  API responses.
