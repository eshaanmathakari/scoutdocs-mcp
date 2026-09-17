/** Exact-version behaviour: served exactly as asked, or refused — never substituted.
 *
 * Mirrors the local server's tests so the hosted endpoint and the Python
 * package keep the same public contract.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";

import { dispatchMcp } from "../src/mcp";
import { InvalidExactVersion, registryUrl, validateVersion } from "../src/versions";
import type { Env } from "../src/types";

const testEnv = env as unknown as Env;

type McpResponse = Awaited<ReturnType<typeof dispatchMcp>>;

function mockFetch(handler: (req: Request) => Promise<Response> | Response) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    return handler(req);
  });
}

async function callTool(name: string, args: Record<string, unknown>): Promise<McpResponse> {
  return dispatchMcp(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    testEnv,
  );
}

function resultText(resp: McpResponse): string {
  return (resp!.result as { content: Array<{ text: string }> }).content[0].text;
}

function resultIsError(resp: McpResponse): boolean {
  return Boolean((resp!.result as { isError?: boolean }).isError);
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}

const CLICK_8_1_7 = {
  info: {
    name: "click",
    version: "8.1.7",
    summary: "Composable command line interface toolkit",
    home_page: "https://palletsprojects.com/p/click/",
    docs_url: "https://click.palletsprojects.com/",
    license: "BSD-3-Clause",
    description: "Click 8.1.7 long description",
    project_urls: {},
  },
  releases: { "8.1.7": [{ filename: "click-8.1.7.tar.gz" }] },
};

beforeEach(async () => {
  const list = await testEnv.CACHE.list();
  await Promise.all(list.keys.map((k) => testEnv.CACHE.delete(k.name)));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("validateVersion", () => {
  it("accepts plausible exact versions", () => {
    for (const v of ["8.1.7", "1.0.0-rc.1", "0.2.0b4", "2024.1.1", "1.0.0+build.7"]) {
      expect(validateVersion(v)).toBe(v);
    }
  });

  it("refuses anything that is not an exact version", () => {
    const bad: unknown[] = [
      "",
      " latest",
      "latest",
      "next",
      "8.1.7 ",
      "8.1.7/../evil",
      "8.1.7?x=1",
      "no-digit",
      "a".repeat(65),
      81,
      null,
    ];
    for (const v of bad) {
      expect(() => validateVersion(v)).toThrow(InvalidExactVersion);
    }
  });
});

describe("registryUrl", () => {
  it("builds latest and version-specific URLs", () => {
    expect(registryUrl("click", "python")).toBe("https://pypi.org/pypi/click/json");
    expect(registryUrl("click", "python", "8.1.7")).toBe(
      "https://pypi.org/pypi/click/8.1.7/json",
    );
    expect(registryUrl("express", "npm", "4.18.2")).toBe(
      "https://registry.npmjs.org/express/4.18.2",
    );
    expect(registryUrl("serde", "cargo", "1.0.200")).toBe(
      "https://crates.io/api/v1/crates/serde/1.0.200",
    );
  });

  it("rejects unknown ecosystems", () => {
    expect(() => registryUrl("x", "cobol")).toThrow();
  });
});

describe("tool schemas", () => {
  it("expose the version argument", async () => {
    const resp = await dispatchMcp({ jsonrpc: "2.0", id: 2, method: "tools/list" }, testEnv);
    const tools = (resp!.result as {
      tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>;
    }).tools;
    for (const name of ["get_package_info", "get_package_docs"]) {
      const tool = tools.find((t) => t.name === name)!;
      expect(tool.inputSchema.properties).toHaveProperty("version");
    }
  });
});

describe("get_package_info with an exact version", () => {
  it("serves the version-specific document", async () => {
    mockFetch(async (req) => {
      if (String(req.url) === "https://pypi.org/pypi/click/8.1.7/json") {
        return jsonResponse(CLICK_8_1_7);
      }
      return new Response("not mocked", { status: 404 });
    });

    const resp = await callTool("get_package_info", {
      package: "click",
      ecosystem: "python",
      version: "8.1.7",
    });
    const parsed = JSON.parse(resultText(resp));
    expect(parsed).toMatchObject({
      version_source: "exact",
      requested_version: "8.1.7",
      resolved_version: "8.1.7",
      license: "BSD-3-Clause",
    });
    expect(parsed.latest_stable).toBeUndefined();
  });

  it("refuses a missing version without touching the latest endpoint", async () => {
    const spy = mockFetch(async () => new Response("not found", { status: 404 }));

    const resp = await callTool("get_package_info", {
      package: "click",
      ecosystem: "python",
      version: "99.0.0",
    });

    expect(resultIsError(resp)).toBe(true);
    expect(resultText(resp)).toContain("Version '99.0.0' not found");
    expect(resultText(resp)).toContain("No other version's metadata was substituted.");
    const urls = spy.mock.calls.map((call) => String(call[0]));
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/pypi/click/99.0.0/json");
  });

  it("rejects a tag alias before any fetch", async () => {
    const spy = mockFetch(async () => new Response("not found", { status: 404 }));

    const resp = await callTool("get_package_info", { package: "click", version: "latest" });

    expect(resultIsError(resp)).toBe(true);
    expect(resultText(resp)).toContain("not an exact version");
    expect(spy.mock.calls).toHaveLength(0);
  });
});

describe("get_package_docs with an exact version", () => {
  it("serves the exact version with provenance in the header", async () => {
    mockFetch(async (req) => {
      if (String(req.url) === "https://pypi.org/pypi/click/8.1.7/json") {
        return jsonResponse(CLICK_8_1_7);
      }
      return new Response("not mocked", { status: 404 });
    });

    const resp = await callTool("get_package_docs", {
      package: "click",
      ecosystem: "python",
      version: "8.1.7",
    });
    const text = resultText(resp);
    expect(text).toContain("# click v8.1.7 (python)");
    expect(text).toContain("Version: exact (8.1.7)");
    expect(text).toContain(
      "Source: pypi_description (https://pypi.org/pypi/click/8.1.7/json)",
    );
    expect(text).toContain("Click 8.1.7 long description");
  });

  it("refuses an unknown version instead of substituting", async () => {
    mockFetch(async () => new Response("not found", { status: 404 }));

    const resp = await callTool("get_package_docs", {
      package: "click",
      ecosystem: "python",
      version: "99.9.9",
    });
    const text = resultText(resp);
    expect(text).toContain("Version '99.9.9' not found");
    expect(text).toContain("No other version's documentation was substituted.");
  });

  it("reads the GitHub README at the release ref, retrying the v-prefixed tag", async () => {
    mockFetch(async (req) => {
      const url = String(req.url);
      if (url === "https://pypi.org/pypi/mylib/1.0.0/json") {
        return jsonResponse({
          info: {
            name: "mylib",
            version: "1.0.0",
            summary: "",
            description: "",
            home_page: null,
            docs_url: null,
            license: null,
            project_urls: { Source: "https://github.com/o/r" },
          },
        });
      }
      if (url === "https://api.github.com/repos/o/r/readme?ref=1.0.0") {
        return new Response("not found", { status: 404 });
      }
      if (url === "https://api.github.com/repos/o/r/readme?ref=v1.0.0") {
        return new Response("# mylib at v1.0.0");
      }
      return new Response("not mocked", { status: 404 });
    });

    const resp = await callTool("get_package_docs", {
      package: "mylib",
      ecosystem: "python",
      version: "1.0.0",
    });
    const text = resultText(resp);
    expect(text).toContain(
      "Source: github_readme (https://api.github.com/repos/o/r/readme?ref=v1.0.0)",
    );
    expect(text).toContain("# mylib at v1.0.0");
  });
});

describe("cache separation", () => {
  it("keeps exact and latest entries in distinct keys", async () => {
    mockFetch(async (req) => {
      const url = String(req.url);
      if (url.startsWith("https://pypi.org/pypi/click")) return jsonResponse(CLICK_8_1_7);
      return new Response("not mocked", { status: 404 });
    });

    await callTool("get_package_info", { package: "click", ecosystem: "python" });
    await callTool("get_package_info", {
      package: "click",
      ecosystem: "python",
      version: "8.1.7",
    });

    const keys = (await testEnv.CACHE.list()).keys.map((k) => k.name).sort();
    expect(keys).toContain("info:python:click@latest");
    expect(keys).toContain("info:python:click@8.1.7");
  });

  it("does not serve the latest request from an exact-version entry", async () => {
    mockFetch(async () => jsonResponse(CLICK_8_1_7));

    await callTool("get_package_info", {
      package: "click",
      ecosystem: "python",
      version: "8.1.7",
    });
    expect(await testEnv.CACHE.get("info:python:click@latest")).toBeNull();

    const resp = await callTool("get_package_info", { package: "click", ecosystem: "python" });
    expect(JSON.parse(resultText(resp)).version_source).toBe("latest_stable");
  });
});
