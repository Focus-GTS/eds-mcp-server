# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
