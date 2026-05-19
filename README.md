# EDS MCP Server

MCP server for Adobe Edge Delivery Services. Gives AI agents (Claude Code, Cursor, GitHub Copilot) programmatic access to EDS operations — preview, publish, read content, query performance metrics, and manage site configuration.

**15 tools. Zero dependencies beyond the MCP SDK. Works with any EDS site.**

## Quick Start

### Claude Code

```bash
claude mcp add eds -e EDS_OWNER=your-org -e EDS_REPO=your-site -- npx @focusgts/eds-mcp-server
```

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "eds": {
      "command": "npx",
      "args": ["@focusgts/eds-mcp-server"],
      "env": {
        "EDS_OWNER": "your-org",
        "EDS_REPO": "your-site"
      }
    }
  }
}
```

### VS Code (GitHub Copilot)

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "eds": {
      "command": "npx",
      "args": ["@focusgts/eds-mcp-server"],
      "env": {
        "EDS_OWNER": "your-org",
        "EDS_REPO": "your-site"
      }
    }
  }
}
```

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `EDS_OWNER` | Yes | GitHub org/user that owns the EDS site repo |
| `EDS_REPO` | Yes | GitHub repository name |
| `EDS_REF` | No | Git branch (default: `main`) |
| `EDS_API_KEY` | No | Admin API key for preview/publish/cache operations |
| `EDS_DOMAIN_KEY` | No | OpTel domain key for analytics queries |

**Read-only tools** (content, sitemap, metadata, query index) work with no keys at all. **Write tools** (preview, publish, cache purge) need `EDS_API_KEY`. **Analytics tools** (CWV, 404s, experiments) need `EDS_DOMAIN_KEY`.

## Tools

### Publishing Operations

| Tool | Description |
|------|-------------|
| `eds_preview_page` | Trigger preview for a page so content source changes appear on `*.aem.page` |
| `eds_publish_page` | Publish a page from preview to the live production domain (`*.aem.live`) |
| `eds_unpublish_page` | Remove a page from the live site |
| `eds_get_status` | Get preview, live, and code-bus status for a resource |
| `eds_purge_cache` | Purge CDN cache for a page path |

### Content Reading

| Tool | Description |
|------|-------------|
| `eds_get_page` | Fetch rendered page content via `.plain.html` |
| `eds_list_pages` | Query the site's page index with pagination |
| `eds_get_metadata` | Fetch the site metadata sheet |
| `eds_get_sitemap` | Fetch and parse `sitemap.xml` |

### Analytics (OpTel)

| Tool | Description |
|------|-------------|
| `eds_get_cwv` | Core Web Vitals (LCP, CLS, INP, TTFB) by page |
| `eds_get_404s` | 404 error report with hit counts and referrers |
| `eds_get_experiments` | A/B experiment results with conversion rates |

### Configuration

| Tool | Description |
|------|-------------|
| `eds_get_config` | Read site configuration |
| `eds_get_logs` | Project activity log (preview, publish, config actions) |
| `eds_get_api_keys` | List API keys configured for the site |

## Examples

Once connected, ask your AI agent:

```
"What pages are on this EDS site?"           -> eds_list_pages
"Show me the content of the about page"      -> eds_get_page
"What are the Core Web Vitals for this site?" -> eds_get_cwv
"Preview the homepage"                       -> eds_preview_page
"Publish the blog post I just edited"        -> eds_publish_page
"Are there any 404 errors on the site?"      -> eds_get_404s
"Show me the site configuration"             -> eds_get_config
```

## How It Works

This is a local MCP server that runs on your machine via stdio. When you connect it to Claude Code, Cursor, or another MCP-compatible AI tool, the agent can call these tools to interact with your EDS site's real APIs:

- **Admin API** (`admin.hlx.page`) for preview, publish, cache, config, and logs
- **Content API** (`*.aem.live`) for page content, query index, metadata, and sitemap
- **OpTel API** (`rum.hlx.page`) for Core Web Vitals, 404 tracking, and experiment data

No sandbox or local AEM instance needed. The server talks directly to the live EDS infrastructure.

## Architecture

Built following Adobe's MCP server conventions (derived from `adobe-rnd/da-mcp`):

- TypeScript + `@modelcontextprotocol/sdk` + `zod`
- Stateless per-request
- Tool naming: `eds_{verb}_{noun}`
- Stdio transport for local use
- Native `fetch()` (Node 18+, zero HTTP dependencies)

## Development

```bash
git clone https://github.com/Focus-GTS/eds-mcp-server.git
cd eds-mcp-server
npm install
npm run build
npm test
```

## About

Built by [FocusGTS](https://focusgts.com) — Adobe Silver Solution Partner specializing in Edge Delivery Services.

## License

Apache-2.0
