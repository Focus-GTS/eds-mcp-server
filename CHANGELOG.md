# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
