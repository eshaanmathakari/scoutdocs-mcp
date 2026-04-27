# scoutdocs-mcp

MCP server that fetches and **searches** the latest stable documentation for any package. Keeps AI coding agents in sync with current APIs instead of relying on stale training data.

Two ways to run it:

- **Local stdio** (Python) — installs into Claude Code / Claude Desktop / Cursor, can read your project's manifests.
- **Hosted Worker** (Cloudflare) — public HTTPS endpoint at `/mcp`, no install required.

## Why

LLMs are trained on a snapshot — the docs they "know" may be months or years old. scoutdocs-mcp gives any MCP client live access to the latest stable version info, READMEs, and search results across docs sites for packages on **PyPI**, **npm**, and **crates.io**.

## How it works

<p align="center">
  <img src="docs/flowchart.svg" alt="scoutdocs-mcp workflow" width="600">
</p>

## Tools

| Tool | Where | What it does |
|------|-------|--------------|
| `get_package_info` | local + hosted | Latest stable version, docs URL, repo, license |
| `get_package_docs` | local + hosted | README / long-description content |
| `search_package_docs` | local + hosted | Bounded discovery: docs URL, `llms.txt` / `llms-full.txt`, sitemap, same-host links — ranks pages by query match |
| `detect_project_dependencies` | local only | Reads pyproject/requirements/uv.lock, package.json/package-lock, Cargo.toml/Cargo.lock |
| `cache_stats` | local only | Local SQLite cache stats |

## Quickstart

### Local (Python stdio)

```bash
pip install scoutdocs-mcp        # or: uv tool install scoutdocs-mcp
```

Add to Claude Code's MCP config (`~/.claude/claude_code_config.json`):

```json
{
  "mcpServers": {
    "scoutdocs": {
      "command": "uvx",
      "args": ["--from", "scoutdocs-mcp", "scoutdocs-mcp"]
    }
  }
}
```

For Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS), use the same shape.

### Hosted (Cloudflare Worker)

Point any MCP client at the public Streamable HTTP endpoint:

```
https://scoutdocs-mcp.<workers-subdomain>.workers.dev/mcp
```

The hosted endpoint is unauthenticated and rate-limited (60 MCP req/min, 10 search req/min per client IP). Search results are capped tighter than local (8 discovered pages × 18k chars / 200k total backstop) but well within Cloudflare free-tier headroom.

## Example prompts

```
> What's the latest version of flask?
> Show me the docs for the serde crate
> Search the httpx docs for "transport"
> What dependencies does this project declare?
```

## Configuration

### GitHub token (optional, local only)

Unauthenticated GitHub API allows 60 req/hr. A token (any scope) raises that to 5,000/hr — useful when fetching READMEs in bulk:

```bash
export GITHUB_TOKEN=ghp_your_token_here
```

### Cache

- **Local stdio**: SQLite at `~/.cache/scoutdocs-mcp/cache.db`, 24h TTL.
- **Hosted Worker**: Cloudflare KV, same 24h TTL, scoped per binding.

### Search caps

The README is **always** included as a free first page. The `max_pages` cap
governs how many *discovered* pages we add on top of it.

| | Hosted | Local default |
|---|---|---|
| Discovered pages | 8 (max 20 via `max_pages` arg) | 15 (max 30 via `max_pages` arg) |
| Chars/page | 18,000 | 24,000 |
| Total backstop | 200,000 | 500,000 |

## Supported ecosystems

| Ecosystem | Registry | Aliases |
|-----------|----------|---------|
| Python | PyPI | `python`, `pypi`, `pip` |
| JavaScript / TypeScript | npm | `javascript`, `typescript`, `npm`, `js`, `ts` |
| Rust | crates.io | `rust`, `cargo`, `crate` |

If no ecosystem is specified, registries are tried in order.

## Repository layout

```
src/scoutdocs_mcp/    Python stdio server (published as scoutdocs-mcp)
worker/               Cloudflare Worker (TypeScript) for the hosted endpoint
tests/                pytest suite (mocked HTTP)
worker/test/          Vitest suite (Cloudflare workers pool)
docs/RELEASE.md       Release & deployment runbook
```

## Status

Beta (`0.2.0b1`). API stable; some discovery sources may evolve. Filed issues welcome at <https://github.com/eshaanmathakari/scoutdocs-mcp/issues>.

## License

MIT
