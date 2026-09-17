"""scoutdocs-mcp server (stdio).

Tools exposed to the MCP client:
  get_package_info             Latest stable version + metadata, or an exact version
  get_package_docs             README / long description content, or an exact version
  search_package_docs          Bounded discovery across docs sites
  detect_project_dependencies  Inspect local manifests/lockfiles
  cache_stats                  Local cache statistics

An exact version is served exactly or not at all: it is never silently
replaced with the latest stable release.
"""

import asyncio
import json
import logging
from typing import Any, Optional

import mcp.server.stdio
import mcp.types as types
from mcp.server import Server

from pathlib import Path

from .registries import fetch_package, REGISTRY_MAP
from .docs_fetcher import fetch_docs_content_with_provenance
from .cache import DocsCache
from .manifests import detect_project_dependencies
from .versions import InvalidExactVersion, validate_version
from .search import (
    DEFAULT_MAX_PAGES,
    DEFAULT_CHARS_PER_PAGE,
    DEFAULT_TOTAL_CHARS,
    search_package_docs,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

server = Server("scoutdocs")
cache = DocsCache()


@server.list_tools()
async def list_tools() -> list[types.Tool]:
    return [
        types.Tool(
            name="get_package_info",
            description=(
                "Get metadata for a package: latest stable version, description, "
                "docs URL, repository, license. Supports Python (PyPI), "
                "JavaScript/TypeScript (npm), and Rust (crates.io). Pass 'version' "
                "to describe one exact release instead of the latest."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "package": {
                        "type": "string",
                        "description": "Package name (e.g., 'requests', 'express', 'serde')",
                    },
                    "ecosystem": {
                        "type": "string",
                        "description": "Language/ecosystem: python, javascript, typescript, rust. Auto-detected if omitted.",
                        "enum": list(set(REGISTRY_MAP.keys())),
                    },
                    "version": {
                        "type": "string",
                        "description": (
                            "Exact version to describe (e.g., '8.1.7'). Omit for the latest "
                            "stable release. An exact version is served exactly or not at "
                            "all — it is never silently replaced by latest."
                        ),
                    },
                },
                "required": ["package"],
            },
        ),
        types.Tool(
            name="get_package_docs",
            description=(
                "Fetch actual documentation content for a package. Returns README "
                "or description text. Use get_package_info first to check version. "
                "Pass 'version' to read one exact release's documentation."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "package": {
                        "type": "string",
                        "description": "Package name",
                    },
                    "ecosystem": {
                        "type": "string",
                        "description": "Language/ecosystem (auto-detected if omitted)",
                        "enum": list(set(REGISTRY_MAP.keys())),
                    },
                    "version": {
                        "type": "string",
                        "description": (
                            "Exact version to read (e.g., '8.1.7'). Omit for the latest "
                            "stable release. An exact version is served exactly or not at "
                            "all — content from another version is never substituted."
                        ),
                    },
                },
                "required": ["package"],
            },
        ),
        types.Tool(
            name="search_package_docs",
            description=(
                "Search a package's documentation for a query. Discovers pages from "
                "the registry's docs/homepage, llms.txt / llms-full.txt, sitemap.xml, "
                "and same-host links. Returns the highest-scoring pages with source URLs. "
                "Bounded to a small set of pages and characters."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "package": {"type": "string", "description": "Package name"},
                    "query": {
                        "type": "string",
                        "description": "Free-text query (matched case-insensitively)",
                    },
                    "ecosystem": {
                        "type": "string",
                        "description": "Language/ecosystem (auto-detected if omitted)",
                        "enum": list(set(REGISTRY_MAP.keys())),
                    },
                    "max_pages": {
                        "type": "integer",
                        "description": f"Max pages to return (default {DEFAULT_MAX_PAGES})",
                        "minimum": 1,
                        "maximum": 30,
                    },
                },
                "required": ["package", "query"],
            },
        ),
        types.Tool(
            name="detect_project_dependencies",
            description=(
                "Inspect manifests/lockfiles in a local project directory and return "
                "the declared dependencies. Supports Python (pyproject.toml, "
                "requirements*.txt, uv.lock), npm (package.json, package-lock.json), "
                "and Rust (Cargo.toml, Cargo.lock). Local-only — runs on the user's machine. "
                "Pair a declared_version with get_package_docs(version=...) to read the "
                "docs for the version the project actually pins."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "root": {
                        "type": "string",
                        "description": "Project root directory (defaults to the server's cwd).",
                    },
                    "include_dev": {
                        "type": "boolean",
                        "description": "Include dev/test/peer dependencies (default false).",
                    },
                },
            },
        ),
        types.Tool(
            name="cache_stats",
            description="Get cache statistics (total entries, valid, expired).",
            inputSchema={"type": "object", "properties": {}},
        ),
    ]

@server.call_tool()
async def call_tool(name: str, arguments: dict[str, Any]) -> list[types.TextContent]:
    if name == "get_package_info":
        return await _handle_get_info(arguments)
    elif name == "get_package_docs":
        return await _handle_get_docs(arguments)
    elif name == "search_package_docs":
        return await _handle_search(arguments)
    elif name == "detect_project_dependencies":
        return _handle_detect(arguments)
    elif name == "cache_stats":
        stats = cache.stats()
        return [types.TextContent(type="text", text=json.dumps(stats, indent=2))]
    else:
        return [types.TextContent(type="text", text=f"Unknown tool: {name}")]


def _handle_detect(args: dict) -> list[types.TextContent]:
    root_arg = args.get("root")
    include_dev = bool(args.get("include_dev", False))
    root = Path(root_arg).expanduser() if root_arg else None
    deps = detect_project_dependencies(root=root, include_dev=include_dev)
    payload = {
        "root": str(root or Path.cwd()),
        "include_dev": include_dev,
        "count": len(deps),
        "dependencies": [
            {
                "name": d.name,
                "ecosystem": d.ecosystem,
                "declared_version": d.declared_version,
                "source_file": d.source_file,
                "is_dev": d.is_dev,
            }
            for d in deps
        ],
    }
    return [types.TextContent(type="text", text=json.dumps(payload, indent=2))]


async def _handle_search(args: dict) -> list[types.TextContent]:
    package = args["package"]
    query = args["query"]
    ecosystem = args.get("ecosystem")
    max_pages = int(args.get("max_pages") or DEFAULT_MAX_PAGES)

    cache_key = f"search:{ecosystem or 'auto'}:{package}:{max_pages}:{query.lower()}"
    cached = cache.get(cache_key)
    if cached:
        return [types.TextContent(type="text", text=cached["rendered"])]

    result = await search_package_docs(
        package,
        query,
        ecosystem=ecosystem,
        max_pages=max_pages,
        max_chars_per_page=DEFAULT_CHARS_PER_PAGE,
        max_total_chars=DEFAULT_TOTAL_CHARS,
    )
    if result is None:
        return [
            types.TextContent(
                type="text",
                text=f"Package '{package}' not found"
                + (f" in {ecosystem}" if ecosystem else " in any registry"),
            )
        ]
    rendered = result.render()
    cache.set(cache_key, {"rendered": rendered})
    return [types.TextContent(type="text", text=rendered)]


def _invalid_version_text(package: str, raw: object) -> str:
    return (
        f"'{raw}' is not an exact version, so nothing was fetched for "
        f"'{package}'. Pass a version like '8.1.7', or omit 'version' to use "
        f"the latest stable release."
    )


def _exact_not_found_text(
    package: str, ecosystem: Optional[str], version: str, *, what: str
) -> str:
    target = package + (f" in {ecosystem}" if ecosystem else " in any registry")
    return (
        f"Version '{version}' not found for package {target}. "
        f"No other version's {what} was substituted."
    )


def _requested_version(args: dict) -> Optional[str]:
    """Return the validated exact version, or None when the latest is wanted.

    Raises InvalidExactVersion for anything that is not an exact version.
    """
    raw = args.get("version")
    if raw is None:
        return None
    return validate_version(raw)


async def _handle_get_info(args: dict) -> list[types.TextContent]:
    package = args["package"]
    ecosystem = args.get("ecosystem")

    try:
        version = _requested_version(args)
    except InvalidExactVersion:
        return [
            types.TextContent(
                type="text",
                text=_invalid_version_text(package, args.get("version")),
            )
        ]

    cache_key = f"info:{ecosystem or 'auto'}:{package}@{version or 'latest'}"
    cached = cache.get(cache_key)
    if cached:
        cached["_cached"] = True
        return [types.TextContent(type="text", text=json.dumps(cached, indent=2))]

    info = await fetch_package(package, ecosystem, version)
    if not info:
        if version is not None:
            return [
                types.TextContent(
                    type="text",
                    text=_exact_not_found_text(
                        package, ecosystem, version, what="metadata"
                    ),
                )
            ]
        return [types.TextContent(
            type="text",
            text=f"Package '{package}' not found" + (f" in {ecosystem}" if ecosystem else " in any registry"),
        )]

    if version is not None:
        result = {
            "name": info.name,
            "ecosystem": info.ecosystem,
            "requested_version": version,
            "resolved_version": info.version or version,
            "version_source": "exact",
            "description": info.description,
            "docs_url": info.docs_url,
            "repository": info.repository,
            "homepage": info.homepage,
            "license": info.license,
        }
    else:
        result = {
            "name": info.name,
            "ecosystem": info.ecosystem,
            "latest_stable": info.latest_stable,
            "version_source": "latest_stable",
            "description": info.description,
            "docs_url": info.docs_url,
            "repository": info.repository,
            "homepage": info.homepage,
            "license": info.license,
        }
    cache.set(cache_key, result)
    return [types.TextContent(type="text", text=json.dumps(result, indent=2))]


async def _handle_get_docs(args: dict) -> list[types.TextContent]:
    package = args["package"]
    ecosystem = args.get("ecosystem")

    try:
        version = _requested_version(args)
    except InvalidExactVersion:
        return [
            types.TextContent(
                type="text",
                text=_invalid_version_text(package, args.get("version")),
            )
        ]

    cache_key = f"docs:{ecosystem or 'auto'}:{package}@{version or 'latest'}"
    cached = cache.get(cache_key)
    if cached:
        return [types.TextContent(type="text", text=cached.get("content", "No docs cached"))]

    # Package info first: it resolves the ecosystem and the source URLs for
    # the requested version, and proves the version exists.
    info = await fetch_package(package, ecosystem, version)
    if not info:
        if version is not None:
            return [
                types.TextContent(
                    type="text",
                    text=_exact_not_found_text(
                        package, ecosystem, version, what="documentation"
                    ),
                )
            ]
        return [types.TextContent(
            type="text",
            text=f"Package '{package}' not found",
        )]

    document = await fetch_docs_content_with_provenance(
        package=info.name,
        ecosystem=info.ecosystem,
        docs_url=info.docs_url,
        repo_url=info.repository,
        version=version,
    )

    resolved = info.version if version is not None else info.latest_stable

    if not document:
        label = f"{info.name} v{resolved}" if resolved else info.name
        msg = f"No documentation content found for {label} ({info.ecosystem})"
        if version is not None:
            msg += "\nNo content from another version was substituted."
        if info.docs_url:
            msg += f"\nDocs URL: {info.docs_url}"
        if info.repository:
            msg += f"\nRepository: {info.repository}"
        return [types.TextContent(type="text", text=msg)]

    if version is not None:
        header = f"# {info.name} v{resolved} ({info.ecosystem})\nVersion: exact ({version})\n"
    else:
        header = f"# {info.name} v{resolved} ({info.ecosystem})\nVersion: latest stable\n"
    header += f"License: {info.license or 'unknown'}\n"
    header += f"Source: {document.source} ({document.source_url})\n"
    if info.docs_url:
        header += f"Docs: {info.docs_url}\n"
    header += "\n---\n\n"

    full_content = header + document.content
    cache.set(cache_key, {"content": full_content})
    return [types.TextContent(type="text", text=full_content)]


async def amain():
    async with mcp.server.stdio.stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream,
            write_stream,
            server.create_initialization_options(),
        )


def main():
    asyncio.run(amain())


if __name__ == "__main__":
    main()
