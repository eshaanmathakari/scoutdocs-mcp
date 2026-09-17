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
import { fetchReadmeForWithProvenance } from "./docs.js";
import { ECOSYSTEMS, fetchPackage } from "./registries.js";
import { renderSearchResult, searchPackageDocs } from "./search.js";
import type { Env } from "./types.js";
import { InvalidExactVersion, validateVersion } from "./versions.js";

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

const VERSION_PROPERTY = {
  type: "string",
  description:
    "Exact version (e.g. '8.1.7'). Omit for the latest stable release. An exact version is served exactly or not at all — it is never silently replaced by latest.",
};

/** The validated exact version, or null when the latest is wanted.
 * Throws InvalidExactVersion for anything that is not an exact version. */
function parseRequestedVersion(args: Record<string, unknown>): string | null {
  const raw = args.version;
  if (raw === undefined || raw === null) return null;
  return validateVersion(raw);
}

function invalidVersionText(pkg: string, raw: unknown): string {
  return (
    `'${String(raw)}' is not an exact version, so nothing was fetched for '${pkg}'. ` +
    `Pass a version like '8.1.7', or omit 'version' to use the latest stable release.`
  );
}

function exactNotFoundText(
  pkg: string,
  ecosystem: string | undefined,
  version: string,
  what: "metadata" | "documentation",
): string {
  const target = pkg + (ecosystem ? ` in ${ecosystem}` : " in any registry");
  return `Version '${version}' not found for package ${target}. No other version's ${what} was substituted.`;
}

const TOOLS: ToolDef[] = [
  {
    name: "get_package_info",
    description:
      "Latest stable version + metadata for a package on PyPI, npm, or crates.io. Pass 'version' to describe one exact release instead of the latest.",
    inputSchema: {
      type: "object",
      properties: {
        package: { type: "string", description: "Package name" },
        ecosystem: {
          type: "string",
          description: "Language/ecosystem (auto-detected if omitted)",
          enum: ECOSYSTEMS,
        },
        version: VERSION_PROPERTY,
      },
      required: ["package"],
    },
    rateLimitBucket: "general",
    handler: async (args, env) => {
      const pkg = String(args.package ?? "").trim();
      const ecosystem = args.ecosystem ? String(args.ecosystem) : undefined;
      if (!pkg) return errorContent("`package` is required");
      if (pkg.length > 214) return errorContent("`package` is too long");

      let version: string | null;
      try {
        version = parseRequestedVersion(args);
      } catch (err) {
        if (err instanceof InvalidExactVersion) {
          return errorContent(invalidVersionText(pkg, args.version));
        }
        throw err;
      }

      const key = `info:${ecosystem ?? "auto"}:${pkg}@${version ?? "latest"}`;
      const cached = await cacheGet<unknown>(env, key);
      if (cached) return jsonContent(cached);

      const info = await fetchPackage(pkg, ecosystem, env, version);
      if (!info) {
        if (version) return errorContent(exactNotFoundText(pkg, ecosystem, version, "metadata"));
        return errorContent(
          `Package '${pkg}' not found${ecosystem ? ` in ${ecosystem}` : " in any registry"}`,
        );
      }

      const result = version
        ? {
            name: info.name,
            ecosystem: info.ecosystem,
            requested_version: version,
            resolved_version: info.version ?? version,
            version_source: "exact",
            description: info.description,
            docs_url: info.docs_url,
            repository: info.repository,
            homepage: info.homepage,
            license: info.license,
          }
        : {
            name: info.name,
            ecosystem: info.ecosystem,
            latest_stable: info.latest_stable,
            version_source: "latest_stable",
            description: info.description,
            docs_url: info.docs_url,
            repository: info.repository,
            homepage: info.homepage,
            license: info.license,
          };
      await cachePut(env, key, result);
      return jsonContent(result);
    },
  },
  {
    name: "get_package_docs",
    description:
      "Fetch the README or long description content for a package. Pass 'version' to read one exact release's documentation.",
    inputSchema: {
      type: "object",
      properties: {
        package: { type: "string", description: "Package name" },
        ecosystem: {
          type: "string",
          description: "Language/ecosystem (auto-detected if omitted)",
          enum: ECOSYSTEMS,
        },
        version: VERSION_PROPERTY,
      },
      required: ["package"],
    },
    rateLimitBucket: "general",
    handler: async (args, env) => {
      const pkg = String(args.package ?? "").trim();
      const ecosystem = args.ecosystem ? String(args.ecosystem) : undefined;
      if (!pkg) return errorContent("`package` is required");

      let version: string | null;
      try {
        version = parseRequestedVersion(args);
      } catch (err) {
        if (err instanceof InvalidExactVersion) {
          return errorContent(invalidVersionText(pkg, args.version));
        }
        throw err;
      }

      const key = `docs:${ecosystem ?? "auto"}:${pkg}@${version ?? "latest"}`;
      const cached = await cacheGet<{ text: string }>(env, key);
      if (cached) return textContent(cached.text);

      const info = await fetchPackage(pkg, ecosystem, env, version);
      if (!info) {
        if (version) return errorContent(exactNotFoundText(pkg, ecosystem, version, "documentation"));
        return errorContent(`Package '${pkg}' not found`);
      }

      const doc = await fetchReadmeForWithProvenance(info, env, version);
      const resolved = version ? (info.version ?? version) : (info.latest_stable ?? "");

      if (!doc) {
        const label = resolved ? `${info.name} v${resolved}` : info.name;
        let msg = `No documentation content found for ${label} (${info.ecosystem})`;
        if (version) msg += "\nNo content from another version was substituted.";
        if (info.docs_url) msg += `\nDocs URL: ${info.docs_url}`;
        if (info.repository) msg += `\nRepository: ${info.repository}`;
        return textContent(msg);
      }

      let header =
        `# ${info.name} v${resolved} (${info.ecosystem})\n` +
        (version ? `Version: exact (${version})\n` : "Version: latest stable\n") +
        `License: ${info.license ?? "unknown"}\n` +
        `Source: ${doc.source} (${doc.source_url})\n` +
        (info.docs_url ? `Docs: ${info.docs_url}\n` : "") +
        "\n---\n\n";
      const text = header + doc.text;
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
