# EDS MCP Server

MCP server for Adobe Edge Delivery Services. Provides 35 tools for AI agents to manage EDS sites: preview, publish, bulk operations, search, redirects, read content, query metrics, and configure sites.

## Architecture

Follows Adobe's MCP conventions (derived from `adobe-rnd/da-mcp`):
- TypeScript + `@modelcontextprotocol/sdk` + `zod`
- Stateless per-request
- Tool naming: `eds_{verb}_{noun}`
- Stdio transport for local use (Claude Code, Cursor)

## Project Structure

```
src/
  index.ts              -- Entry point, reads env vars, connects stdio transport
  mcp/
    server.ts           -- McpServer factory, all 35 tool registrations with Zod schemas
    handlers.ts         -- One async function per tool
  eds-admin/
    client.ts           -- HTTP client wrapping all EDS APIs
    types.ts            -- TypeScript interfaces
  utils/
    errors.ts           -- Error formatting + typed EdsApiError
  lib.ts                -- Import-safe public library surface (main/types entry)
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `EDS_OWNER` | Yes | GitHub org/owner for the EDS site |
| `EDS_REPO` | Yes | GitHub repo name |
| `EDS_REF` | No | Git ref (default: `main`) |
| `EDS_API_KEY` | No | Admin API token override (see Authentication). Browser login is the alternative for interactive use. |
| `EDS_DOMAIN_KEY` | No | OpTel domain key (required for CWV/404/experiment queries) |
| `EDS_DA_TOKEN` | No | Document Authoring API token (required for `eds_da_*` tools) |
| `EDS_DA_ORG` | No | DA org (defaults to `EDS_OWNER`) |
| `EDS_DA_REPO` | No | DA repo/site (defaults to `EDS_REPO`) |

## Authentication

Admin operations require an EDS Admin token, resolved at request time by `src/auth/getValidToken`:

1. **`EDS_API_KEY` override** — if set, always used (bypasses cache). Keeps CI / automation working unchanged.
2. **Cached browser-login token** — `~/.aem/auth-token.json`, used when valid (not within 60s of expiry) and owner/repo match.
3. Otherwise a `NeedsLoginError` surfaces as a friendly MCP error: *"Run `npx @focusgts/eds-mcp-server login` to sign in."*

Interactive sign-in (Adobe's hlx admin flow, same as the AEM CLI) — recommended for interactive use:

```bash
EDS_OWNER=myorg EDS_REPO=mysite npx @focusgts/eds-mcp-server login
```

This opens the system browser to `admin.hlx.page/login/{owner}/{repo}/{ref}?client_id=aem-cli&...`, runs a local loopback callback server on a random port, and caches the returned admin site token (mode `0600`, ~24h TTL). The token is a Google-brokered admin site token delivered to the localhost callback — not an Adobe IMS token. The MCP server runs headless over stdio and never auto-opens a browser.

**Use Chrome or Firefox — Safari is not supported** (Safari blocks the HTTP-localhost callback, the same limitation as Adobe's own AEM CLI). When browser sign-in isn't available, set `EDS_API_KEY` instead (see the README for how to obtain a token).

Auth code lives in `src/auth/`:
- `token-store.ts` — load/save/clear `~/.aem/auth-token.json` (0600)
- `browser.ts` — cross-platform `openBrowser` (never throws; prints URL as fallback)
- `admin-login.ts` — `login()` browser flow + 120s timeout + callback server
- `index.ts` — `getValidToken()` resolution + `NeedsLoginError`

Read-only content/analytics tools never require a token.

## Build & Run

```bash
npm install
npm run build
npm start

# Or dev mode:
npm run dev
```

## Adding to Claude Code

```bash
claude mcp add eds -- npx @focusgts/eds-mcp-server
```

With env vars:
```bash
EDS_OWNER=myorg EDS_REPO=mysite claude mcp add eds -- npx @focusgts/eds-mcp-server
```

## Tools

| Tool | Description |
|------|-------------|
| `eds_preview_page` | Trigger preview for a page |
| `eds_publish_page` | Publish a page to live |
| `eds_unpublish_page` | Remove a page from live |
| `eds_get_status` | Get resource status (preview, live, code) |
| `eds_purge_cache` | Purge CDN cache |
| `eds_get_page` | Fetch rendered page content |
| `eds_list_pages` | Query the site page index |
| `eds_get_metadata` | Fetch site metadata |
| `eds_get_sitemap` | Parse sitemap.xml |
| `eds_get_cwv` | Core Web Vitals metrics |
| `eds_get_404s` | 404 error report |
| `eds_get_experiments` | A/B experiment results |
| `eds_get_config` | Site configuration |
| `eds_get_logs` | Project activity logs |
| `eds_get_api_keys` | List API keys |
| `eds_bulk_preview` | Start an async bulk preview job over many pages |
| `eds_bulk_publish` | Start an async bulk publish job over many pages |
| `eds_get_job_status` | Poll the progress of a bulk job |
| `eds_preview_and_publish` | Preview + publish in one operation |
| `eds_get_redirects` | Fetch redirect rules |
| `eds_search_pages` | Search pages by keyword |
| `eds_da_list_sources` | List Document Authoring (DA) sources/folders |
| `eds_da_get_source` | Get a DA document's raw authored source |
| `eds_da_put_source` | Create/update a DA document's source |
| `eds_da_delete_source` | Delete a DA document |
| `eds_da_copy_source` | Copy a DA document |
| `eds_da_move_source` | Move/rename a DA document |
| `eds_da_get_versions` | Get a DA document's version history |
| `eds_da_export` | Bulk-export a whole DA subtree in one call (agent-native "clone" read) |
| `eds_da_push` | Bulk-push many edited DA documents in one call (supports `dryRun` preview and `withUndo` reversible writes) |
| `eds_da_rollback` | Undo a `withUndo` push — restore prior content and remove created docs |
| `eds_audit_page` | Audit one page for SEO + accessibility issues (prioritized findings) |
| `eds_audit_site` | Sweep the site for SEO, accessibility, freshness, sitemap, performance (RUM) + 404 issues |
| `eds_fix_metadata` | Fix a page's title/description/OG image via its DA Metadata block (dry-run + undo, optional publish) |
| `eds_bulk_fix_metadata` | Fix metadata across many pages in one batch with a single aggregated undo (dry-run + optional publish) |

DA tools (`eds_da_*`) access the authored source directly via `admin.da.live` (adopted from `adobe-rnd/da-mcp`, per ADR-007). `eds_da_export`/`eds_da_push` are the bulk "clone" model (ADR-008) — the efficiency of `aem content clone` for agents, no local checkout. They require `EDS_DA_TOKEN`; DA client code lives in `src/da-admin/`.

**Safe writes (ADR-009).** `eds_da_push` is safe by default: pass `dryRun: true` to preview exactly what would change (create / update / unchanged, with line-diff counts) and write nothing, or `withUndo: true` to capture the prior state and get back an `undo` object. Feed that object to `eds_da_rollback` to reverse the push — restoring updated docs to their prior content and deleting the ones the push created. This is what makes pointing the server at a production site trustworthy: preview before writing, undo after.

**Bulk fixes (ADR-012).** `eds_bulk_fix_metadata` applies per-page metadata fixes across many pages (`pages: [{path, metadata}]`) in one call: reuses the ADR-011 writer, pushes all changed pages in a single `eds_da_push withUndo` so the result carries **one** undo that reverts the whole batch, with optional `publish` (bounded-concurrency preview+publish). Partial-failure tolerant (unreadable pages recorded, never abort). Handler in `src/mcp/fix-handlers.ts`.

**Safe fixes (ADR-011).** `eds_fix_metadata` repairs a page's SEO/social metadata (title, description, OG image) by editing its DA-source **Metadata block** (`<div class="metadata">` — format grounded in `helix-html-pipeline` `extract-metadata.js`), routed through the ADR-009 safe-writes path (dry-run + `withUndo` → `eds_da_rollback`). Idempotent: merges into an existing block, never duplicates, preserves untouched rows. `publish:true` previews+publishes so the change goes live (a DA write alone isn't live until republished). The agent supplies the values; the tool is a deterministic safe-writer. Fix code lives in `src/fix/`. This is the "Executor" the ops-agent ADRs (002/003/006) envisioned.

**Content audit (ADR-010).** `eds_audit_page` and `eds_audit_site` are read-only "what's wrong" tools. They run regex-based SEO + accessibility checks on page HTML (ported from the eds-score scorers), plus site-level freshness (query-index `lastModified`), sitemap coverage, and — when a `domain` is passed (needs `EDS_DOMAIN_KEY`) — RUM performance (Core Web Vitals) and 404s. Output is a prioritized `AuditFinding` list (severity + dimension + suggested fix); RUM dimensions skip loudly (listed in `skipped`) when no domain/key, never silently. No Google PageSpeed dependency. Audit code lives in `src/audit/`. Pairs with the safe-writes tools to fix what it finds.

## Conventions

- All handlers wrap in try/catch, return `{ isError: true }` on failure
- Zod schemas use `.describe()` on every field
- Error messages include HTTP status when available
- No external dependencies beyond MCP SDK and Zod
