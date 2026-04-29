/** Tests for the bounded docs discovery / search. */

import { describe, expect, it, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";

import { searchPackageDocs } from "../src/search";
import type { Env } from "../src/types";

const testEnv = env as unknown as Env;

const PYPI_PAYLOAD = {
  info: {
    name: "demo",
    version: "1.0.0",
    summary: "demo lib",
    home_page: null,
    docs_url: "https://docs.example.com/",
    license: "MIT",
    description: "# demo\n\nUse the async generator API for streaming.",
    project_urls: { Source: "https://github.com/example/demo" },
  },
  releases: { "1.0.0": [{ filename: "demo-1.0.0.tar.gz" }] },
};

interface FetchHandler {
  (req: Request): Response | Promise<Response>;
}

function mockFetch(handler: FetchHandler) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    return handler(req);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("searchPackageDocs", () => {
  it("includes README, llms.txt, and discovers same-host links", async () => {
    mockFetch(async (req) => {
      const url = req.url;
      if (url === "https://pypi.org/pypi/demo/json") {
        return new Response(JSON.stringify(PYPI_PAYLOAD), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "https://docs.example.com/llms-full.txt") {
        return new Response("async generator: detailed reference", {
          headers: { "content-type": "text/plain" },
        });
      }
      if (url === "https://docs.example.com/llms.txt") {
        return new Response("not found", { status: 404 });
      }
      if (url === "https://docs.example.com/sitemap.xml") {
        return new Response("not found", { status: 404 });
      }
      if (url === "https://docs.example.com/") {
        return new Response(
          "<html><head><title>Demo</title></head><body><a href='/api'>API</a></body></html>",
          { headers: { "content-type": "text/html" } },
        );
      }
      if (url === "https://docs.example.com/api") {
        return new Response(
          "<html><body><h1>API</h1><p>async generator details</p></body></html>",
          { headers: { "content-type": "text/html" } },
        );
      }
      return new Response("not mocked", { status: 404 });
    });

    const result = await searchPackageDocs(
      "demo",
      "async generator",
      "python",
      testEnv,
      { maxPages: 5 },
    );

    expect(result).not.toBeNull();
    const urls = result!.pages.map((p) => p.url);
    expect(urls).toContain("https://docs.example.com/llms-full.txt");
    expect(urls).toContain("https://docs.example.com/api");
    // Pages sorted by score desc
    const scores = result!.pages.map((p) => p.score);
    expect([...scores]).toEqual([...scores].sort((a, b) => b - a));
  });

  it("respects maxPages cap", async () => {
    mockFetch(async (req) => {
      if (req.url === "https://pypi.org/pypi/demo/json") {
        return new Response(JSON.stringify(PYPI_PAYLOAD), {
          headers: { "content-type": "application/json" },
        });
      }
      // All discovery + body URLs return small text
      return new Response("body", {
        headers: { "content-type": "text/plain" },
      });
    });

    const result = await searchPackageDocs("demo", "x", "python", testEnv, {
      maxPages: 2,
    });
    // README is always free; cap applies to discovered pages only.
    const readmeCount = result!.pages.filter((p) => p.title === "demo README").length;
    const discovered = result!.pages.length - readmeCount;
    expect(discovered).toBeLessThanOrEqual(2);
  });

  it("filters cross-host sitemap entries", async () => {
    mockFetch(async (req) => {
      const url = req.url;
      if (url === "https://pypi.org/pypi/demo/json") {
        return new Response(JSON.stringify(PYPI_PAYLOAD), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "https://docs.example.com/sitemap.xml") {
        return new Response(
          `<?xml version="1.0"?>
           <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
             <url><loc>https://docs.example.com/guide</loc></url>
             <url><loc>https://other-host.com/leak</loc></url>
           </urlset>`,
          { headers: { "content-type": "application/xml" } },
        );
      }
      if (url === "https://docs.example.com/guide") {
        return new Response("<html><body>guide</body></html>", {
          headers: { "content-type": "text/html" },
        });
      }
      if (url.startsWith("https://docs.example.com/")) {
        return new Response("seed", { headers: { "content-type": "text/html" } });
      }
      return new Response("not mocked", { status: 404 });
    });

    const result = await searchPackageDocs("demo", "x", "python", testEnv);
    const urls = result!.pages.map((p) => p.url);
    expect(urls.some((u) => u.includes("other-host.com"))).toBe(false);
  });

  it("skips GitHub UI pages when registry URLs point at a repo", async () => {
    const payload = {
      info: {
        ...PYPI_PAYLOAD.info,
        home_page: "https://github.com/example/demo",
        docs_url: "https://github.com/example/demo#readme",
        description: "README content with search term",
        project_urls: { Source: "https://github.com/example/demo" },
      },
      releases: PYPI_PAYLOAD.releases,
    };

    mockFetch(async (req) => {
      if (req.url === "https://pypi.org/pypi/demo/json") {
        return new Response(JSON.stringify(payload), {
          headers: { "content-type": "application/json" },
        });
      }
      if (req.url.startsWith("https://github.com/")) {
        return new Response("GitHub UI should not be crawled", { status: 500 });
      }
      return new Response("not mocked", { status: 404 });
    });

    const result = await searchPackageDocs(
      "demo",
      "search term",
      "python",
      testEnv,
      { maxPages: 5 },
    );

    expect(result).not.toBeNull();
    expect(result!.pages.map((p) => p.title)).toEqual(["demo README"]);
    expect(result!.pages[0]!.text).toContain("README content");
  });

  it("uses the search page cap for README content", async () => {
    const payload = {
      info: {
        ...PYPI_PAYLOAD.info,
        docs_url: null,
        description: "x".repeat(10_000),
        project_urls: {},
      },
      releases: PYPI_PAYLOAD.releases,
    };

    mockFetch(async (req) => {
      if (req.url === "https://pypi.org/pypi/demo/json") {
        return new Response(JSON.stringify(payload), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not mocked", { status: 404 });
    });

    const result = await searchPackageDocs("demo", "x", "python", testEnv, {
      maxCharsPerPage: 5_000,
      maxTotalChars: 10_000,
    });

    expect(result).not.toBeNull();
    expect(result!.pages[0]!.text.length).toBeGreaterThan(3_000);
    expect(result!.pages[0]!.text).toContain("[truncated]");
  });
});
