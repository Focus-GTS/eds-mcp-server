# EDS MCP Server

MCP server for Adobe Edge Delivery Services. Provides 21 tools for AI agents to manage EDS sites: preview, publish, bulk operations, search, redirects, read content, query metrics, and configure sites.

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
    server.ts           -- McpServer factory, all 21 tool registrations with Zod schemas
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

## Conventions

- All handlers wrap in try/catch, return `{ isError: true }` on failure
- Zod schemas use `.describe()` on every field
- Error messages include HTTP status when available
- No external dependencies beyond MCP SDK and Zod
