# EDS MCP Server

MCP server for Adobe Edge Delivery Services. Provides 15 tools for AI agents to manage EDS sites: preview, publish, read content, query metrics, and configure sites.

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
    server.ts           -- McpServer factory, all 15 tool registrations with Zod schemas
    handlers.ts         -- One async function per tool
  eds-admin/
    client.ts           -- HTTP client wrapping all EDS APIs
    types.ts            -- TypeScript interfaces
  utils/
    url.ts              -- EDS URL construction helpers
    errors.ts           -- Error formatting
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `EDS_OWNER` | Yes | GitHub org/owner for the EDS site |
| `EDS_REPO` | Yes | GitHub repo name |
| `EDS_REF` | No | Git ref (default: `main`) |
| `EDS_API_KEY` | No | Admin API key (required for preview/publish/cache operations) |
| `EDS_DOMAIN_KEY` | No | OpTel domain key (required for CWV/404/experiment queries) |

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

## Conventions

- All handlers wrap in try/catch, return `{ isError: true }` on failure
- Zod schemas use `.describe()` on every field
- Error messages include HTTP status when available
- No external dependencies beyond MCP SDK and Zod
