/** scoutdocs-mcp Cloudflare Worker entrypoint.
 *
 * Routes:
 *   GET  /            Liveness/health (returns server info as plain text)
 *   POST /mcp         JSON-RPC request → JSON-RPC response
 *   OPTIONS /mcp      CORS preflight
 *
 * Streamable HTTP at /mcp without sessions. Tools are stateless, so each POST
 * is a self-contained request/response. Notifications (no `id`) get HTTP 202.
 */

import { dispatchMcp, getToolByName } from "./mcp.js";
import type { JsonRpcRequest } from "./mcp.js";
import type { Env } from "./types.js";

const BASE_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, MCP-Protocol-Version, Mcp-Session-Id, Authorization, Last-Event-ID",
  "Access-Control-Max-Age": "86400",
  Vary: "Origin",
};

function jsonResponse(body: unknown, headers: Record<string, string>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  });
}

function configuredOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

function originAllowed(request: Request, env: Env): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  const allowed = configuredOrigins(env);
  return allowed.includes("*") || allowed.includes(origin);
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("Origin");
  const allowed = configuredOrigins(env);
  const allowOrigin = origin && (allowed.includes("*") || allowed.includes(origin)) ? origin : "*";
  return { ...BASE_CORS_HEADERS, "Access-Control-Allow-Origin": allowOrigin };
}

function clientKey(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}

async function checkRateLimit(
  request: Request,
  env: Env,
  bucket: "general" | "search",
): Promise<boolean> {
  const limiter = bucket === "search" ? env.RATE_LIMIT_SEARCH : env.RATE_LIMIT_MCP;
  if (!limiter) return true; // not configured (e.g. local tests)
  try {
    const { success } = await limiter.limit({ key: clientKey(request) });
    return success;
  } catch {
    return true; // fail open if the limiter errors out
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      if (!originAllowed(request, env)) {
        return new Response("origin not allowed", { status: 403, headers: cors });
      }
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname === "/" && request.method === "GET") {
      return new Response(
        `scoutdocs-mcp ${env.SCOUTDOCS_VERSION}\nPOST JSON-RPC to /mcp\n`,
        { status: 200, headers: { "content-type": "text/plain", ...cors } },
      );
    }

    if (url.pathname !== "/mcp") {
      return new Response("not found", { status: 404, headers: cors });
    }

    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405, headers: cors });
    }

    if (!originAllowed(request, env)) {
      return new Response("origin not allowed", { status: 403, headers: cors });
    }

    // Always charge the general bucket. Charge the search bucket too if the
    // request targets the search tool — keeps expensive tools rate-limited
    // separately without double-charging cheap calls.
    if (!(await checkRateLimit(request, env, "general"))) {
      return jsonResponse(
        { jsonrpc: "2.0", id: null, error: { code: -32029, message: "rate limit exceeded" } },
        cors,
        429,
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonResponse(
        { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } },
        cors,
        400,
      );
    }

    if (!isJsonRpcRequest(body)) {
      return jsonResponse(
        { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } },
        cors,
        400,
      );
    }

    if (body.method === "tools/call") {
      const toolName = (body.params as { name?: string } | undefined)?.name;
      if (toolName) {
        const tool = getToolByName(toolName);
        if (tool?.rateLimitBucket === "search") {
          if (!(await checkRateLimit(request, env, "search"))) {
            return jsonResponse(
              {
                jsonrpc: "2.0",
                id: body.id ?? null,
                error: { code: -32029, message: "search rate limit exceeded" },
              },
              cors,
              429,
            );
          }
        }
      }
    }

    const response = await dispatchMcp(body, env);
    if (response === null) {
      // Notification — accepted, with no response body.
      return new Response(null, { status: 202, headers: cors });
    }
    return jsonResponse(response, cors, 200);
  },
} satisfies ExportedHandler<Env>;

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.jsonrpc === "2.0" && typeof v.method === "string";
}
