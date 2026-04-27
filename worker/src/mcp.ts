/** Minimal MCP server for the Worker.
 *
 * We implement just the surface we need:
 *   - initialize / notifications/initialized
 *   - ping
 *   - tools/list
 *   - tools/call
 *
 * That covers all current public MCP clients (Claude Code, Cursor, MCP
 * Inspector, etc.) for tool-only servers. Resources/prompts/sampling are
 * deliberately not advertised.
 */

import { cacheGet, cachePut } from "./cache.js";
import { fetchReadmeFor } from "./docs.js";
import { ECOSYSTEMS, fetchPackage } from "./registries.js";
import { renderSearchResult, searchPackageDocs } from "./search.js";
import type { Env } from "./types.js";

const PROTOCOL_VERSION = "2025-03-26";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface ToolContent {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, env: Env) => Promise<ToolContent>;
  rateLimitBucket: "general" | "search";
}

const TOOLS: ToolDef[] = [
  {
    name: "get_package_info",
    description:
      "Latest stable version + metadata for a package on PyPI, npm, or crates.io.",
    inputSchema: {
      type: "object",
      properties: {
        package: { type: "string", description: "Package name" },
        ecosystem: {
          type: "string",
          description: "Language/ecosystem (auto-detected if omitted)",
          enum: ECOSYSTEMS,
        },
      },
      required: ["package"],
    },
    rateLimitBucket: "general",
    handler: async (args, env) => {
      const pkg = String(args.package ?? "").trim();
      const ecosystem = args.ecosystem ? String(args.ecosystem) : undefined;
      if (!pkg) return errorContent("`package` is required");
      if (pkg.length > 214) return errorContent("`package` is too long");

      const key = `info:${ecosystem ?? "auto"}:${pkg}`;
      const cached = await cacheGet<unknown>(env, key);
      if (cached) return jsonContent(cached);

      const info = await fetchPackage(pkg, ecosystem, env);
      if (!info) {
        return errorContent(
          `Package '${pkg}' not found${ecosystem ? ` in ${ecosystem}` : " in any registry"}`,
        );
      }
      await cachePut(env, key, info);
      return jsonContent(info);
    },
  },
  {
    name: "get_package_docs",
    description: "Fetch the README or long description content for a package.",
    inputSchema: {
      type: "object",
      properties: {
        package: { type: "string", description: "Package name" },
        ecosystem: {
          type: "string",
          description: "Language/ecosystem (auto-detected if omitted)",
          enum: ECOSYSTEMS,
        },
      },
      required: ["package"],
    },
    rateLimitBucket: "general",
    handler: async (args, env) => {
      const pkg = String(args.package ?? "").trim();
      const ecosystem = args.ecosystem ? String(args.ecosystem) : undefined;
      if (!pkg) return errorContent("`package` is required");

      const key = `docs:${ecosystem ?? "auto"}:${pkg}`;
      const cached = await cacheGet<{ text: string }>(env, key);
      if (cached) return textContent(cached.text);

      const info = await fetchPackage(pkg, ecosystem, env);
      if (!info) return errorContent(`Package '${pkg}' not found`);

      const readme = await fetchReadmeFor(info, env);
      if (!readme) {
        return textContent(
          `No documentation content found for ${info.name} (${info.ecosystem})`,
        );
      }
      const header =
        `# ${info.name} v${info.latest_stable} (${info.ecosystem})\n` +
        `License: ${info.license ?? "unknown"}\n` +
        (info.docs_url ? `Docs: ${info.docs_url}\n` : "") +
        "\n---\n\n";
      const text = header + readme;
      await cachePut(env, key, { text });
      return textContent(text);
    },
  },
  {
    name: "search_package_docs",
    description:
      "Search a package's docs. Discovers pages from registry hints, llms.txt / llms-full.txt, sitemap.xml, and same-host links. Bounded to a small set of pages and characters.",
    inputSchema: {
      type: "object",
      properties: {
        package: { type: "string", description: "Package name" },
        query: { type: "string", description: "Free-text query (case-insensitive)" },
        ecosystem: {
          type: "string",
          description: "Language/ecosystem (auto-detected if omitted)",
          enum: ECOSYSTEMS,
        },
        max_pages: {
          type: "integer",
          description: "Max pages to return (default 8, max 20)",
          minimum: 1,
          maximum: 20,
        },
      },
      required: ["package", "query"],
    },
    rateLimitBucket: "search",
    handler: async (args, env) => {
      const pkg = String(args.package ?? "").trim();
      const query = String(args.query ?? "").trim();
      const ecosystem = args.ecosystem ? String(args.ecosystem) : undefined;
      const maxPages = clampInt(args.max_pages, 1, 20);

      if (!pkg) return errorContent("`package` is required");
      if (!query) return errorContent("`query` is required");
      if (query.length > 500) return errorContent("`query` is too long");

      const key = `search:${ecosystem ?? "auto"}:${pkg}:${maxPages ?? "d"}:${query.toLowerCase()}`;
      const cached = await cacheGet<{ text: string }>(env, key);
      if (cached) return textContent(cached.text);

      const result = await searchPackageDocs(pkg, query, ecosystem, env, {
        maxPages: maxPages,
      });
      if (!result) return errorContent(`Package '${pkg}' not found`);
      const text = renderSearchResult(result);
      await cachePut(env, key, { text });
      return textContent(text);
    },
  },
];

function jsonContent(value: unknown): ToolContent {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function textContent(text: string): ToolContent {
  return { content: [{ type: "text", text }] };
}

function errorContent(text: string): ToolContent {
  return { content: [{ type: "text", text }], isError: true };
}

function clampInt(value: unknown, min: number, max: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return undefined;
  return Math.max(min, Math.min(max, n));
}

export function getToolByName(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}

export async function dispatchMcp(req: JsonRpcRequest, env: Env): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null;
  switch (req.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          serverInfo: { name: "scoutdocs", version: env.SCOUTDOCS_VERSION },
          capabilities: { tools: { listChanged: false } },
        },
      };

    case "notifications/initialized":
    case "notifications/cancelled":
      // Notifications get no response.
      return null;

    case "ping":
      return { jsonrpc: "2.0", id, result: {} };

    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: TOOLS.map(({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema,
          })),
        },
      };

    case "tools/call": {
      const params = (req.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      const tool = params.name ? getToolByName(params.name) : undefined;
      if (!tool) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: `Unknown tool: ${params.name ?? ""}` },
        };
      }
      try {
        const result = await tool.handler(params.arguments ?? {}, env);
        return { jsonrpc: "2.0", id, result };
      } catch (err) {
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32000,
            message: err instanceof Error ? err.message : "tool execution failed",
          },
        };
      }
    }

    default:
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${req.method}` },
      };
  }
}

export { TOOLS };
export type { JsonRpcRequest, JsonRpcResponse };
