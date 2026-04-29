/** Tests for the MCP JSON-RPC dispatch (uses miniflare's KV; mocks fetch). */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { env, SELF } from "cloudflare:test";

import { dispatchMcp } from "../src/mcp";
import type { Env } from "../src/types";

const testEnv = env as unknown as Env;

const PYPI_PAYLOAD = {
  info: {
    name: "requests",
    version: "2.32.3",
    summary: "Python HTTP for Humans.",
    home_page: "https://requests.readthedocs.io",
    docs_url: null,
    license: "Apache-2.0",
    description: "long description body",
    project_urls: {
      Source: "https://github.com/psf/requests",
      Documentation: "https://requests.readthedocs.io",
    },
  },
  releases: {
    "2.32.3": [{ filename: "requests-2.32.3.whl" }],
    "2.32.2": [{ filename: "requests-2.32.2.tar.gz" }],
  },
};

function mockFetch(handler: (req: Request) => Promise<Response> | Response) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    return handler(req);
  });
}

beforeEach(async () => {
  // Clear KV between tests (miniflare gives a fresh namespace per test by default,
  // but be explicit to avoid surprises).
  const list = await testEnv.CACHE.list();
  await Promise.all(list.keys.map((k) => testEnv.CACHE.delete(k.name)));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("initialize", () => {
  it("returns server info and tool capability", async () => {
    const resp = await dispatchMcp(
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      testEnv,
    );
    expect(resp).not.toBeNull();
    expect(resp!.result).toMatchObject({
      protocolVersion: expect.any(String),
      serverInfo: { name: "scoutdocs" },
      capabilities: { tools: {} },
    });
  });
});

describe("tools/list", () => {
  it("lists the three hosted tools", async () => {
    const resp = await dispatchMcp(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      testEnv,
    );
    const names = (resp!.result as { tools: Array<{ name: string }> }).tools.map(
      (t) => t.name,
    );
    expect(names.sort()).toEqual([
      "get_package_docs",
      "get_package_info",
      "search_package_docs",
    ]);
  });
});

describe("tools/call get_package_info", () => {
  it("returns package metadata via fetched JSON", async () => {
    mockFetch(async (req) => {
      if (req.url === "https://pypi.org/pypi/requests/json") {
        return new Response(JSON.stringify(PYPI_PAYLOAD), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not mocked", { status: 404 });
    });

    const resp = await dispatchMcp(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "get_package_info", arguments: { package: "requests" } },
      },
      testEnv,
    );
    expect(resp!.error).toBeUndefined();
    const text = (resp!.result as { content: Array<{ text: string }> }).content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed).toMatchObject({
      name: "requests",
      ecosystem: "python",
      latest_stable: "2.32.3",
      license: "Apache-2.0",
    });
  });

  it("caches the second call (no second fetch)", async () => {
    const spy = mockFetch(async () =>
      new Response(JSON.stringify(PYPI_PAYLOAD), {
        headers: { "content-type": "application/json" },
      }),
    );

    const call = () =>
      dispatchMcp(
        {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: {
            name: "get_package_info",
            arguments: { package: "requests", ecosystem: "python" },
          },
        },
        testEnv,
      );

    await call();
    const before = spy.mock.calls.length;
    await call();
    const after = spy.mock.calls.length;
    expect(after).toBe(before);
  });

  it("returns isError when the package is missing in all registries", async () => {
    mockFetch(async () => new Response("not found", { status: 404 }));

    const resp = await dispatchMcp(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "get_package_info", arguments: { package: "ghost-pkg-xyz" } },
      },
      testEnv,
    );
    const result = resp!.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("ghost-pkg-xyz");
  });
});

describe("tools/call validation", () => {
  it("rejects unknown tool name", async () => {
    const resp = await dispatchMcp(
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "what_is_this" },
      },
      testEnv,
    );
    expect(resp!.error?.code).toBe(-32602);
  });

  it("rejects empty package", async () => {
    const resp = await dispatchMcp(
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "get_package_info", arguments: { package: "" } },
      },
      testEnv,
    );
    const result = resp!.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
  });

  it("rejects oversized query in search", async () => {
    const resp = await dispatchMcp(
      {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: {
          name: "search_package_docs",
          arguments: { package: "requests", query: "x".repeat(501) },
        },
      },
      testEnv,
    );
    const result = resp!.result as { isError?: boolean };
    expect(result.isError).toBe(true);
  });
});

describe("notifications", () => {
  it("returns null for notifications/initialized", async () => {
    const resp = await dispatchMcp(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      testEnv,
    );
    expect(resp).toBeNull();
  });
});

describe("HTTP transport", () => {
  it("returns 202 for accepted notifications", async () => {
    const resp = await SELF.fetch("https://example.com/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    });

    expect(resp.status).toBe(202);
    expect(await resp.text()).toBe("");
  });

  it("rejects browser origins unless explicitly allowed", async () => {
    const resp = await SELF.fetch("https://example.com/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Origin: "https://attacker.example",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });

    expect(resp.status).toBe(403);
    expect(await resp.text()).toContain("origin not allowed");
  });
});
