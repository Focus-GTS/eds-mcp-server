# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
