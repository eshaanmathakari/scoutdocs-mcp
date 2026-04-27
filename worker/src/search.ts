/** Bounded docs discovery and search for the hosted Worker.
 *
 * Mirrors the Python implementation but uses Cloudflare's HTMLRewriter for
 * text/link extraction and tighter caps suited to free-tier Worker limits.
 */

import { fetchReadmeFor } from "./docs.js";
import { fetchPackage } from "./registries.js";
import type { Env, SearchPage, SearchResult } from "./types.js";

const PAGE_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 256 * 1024;
const SITEMAP_LOC_RE = /<loc>\s*([^<\s][^<]*?)\s*<\/loc>/gi;

function ua(env: Env): string {
  return `scoutdocs-mcp-worker/${env.SCOUTDOCS_VERSION} (+https://github.com/eshaanmathakari/scoutdocs-mcp)`;
}

function intEnv(value: string, fallback: number, min = 1, max = 100_000): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return Math.floor(n);
}

function tokenizeQuery(q: string): string[] {
  return q
    .toLowerCase()
    .split(/\W+/g)
    .filter((t) => t.length >= 2);
}

function score(text: string, tokens: string[]): number {
  if (!text || tokens.length === 0) return 0;
  const haystack = text.toLowerCase();
  let total = 0;
  for (const t of tokens) {
    let idx = 0;
    while ((idx = haystack.indexOf(t, idx)) !== -1) {
      total += 1;
      idx += t.length;
    }
  }
  return total;
}

function schemeHost(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return null;
    return `https://${u.host}`;
  } catch {
    return null;
  }
}

function sameHost(url: string, base: string): boolean {
  try {
    return new URL(url).host === new URL(base).host;
  } catch {
    return false;
  }
}

async function safeGet(url: string, env: Env): Promise<{ body: string; ctype: string } | null> {
  if (!url.startsWith("https://")) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": ua(env) },
      redirect: "follow",
    });
    if (!resp.ok) return null;
    const reader = resp.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let received = 0;
    while (received < MAX_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      if (received >= MAX_BODY_BYTES) {
        await reader.cancel();
        break;
      }
    }
    const merged = new Uint8Array(received);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c.subarray(0, Math.min(c.byteLength, MAX_BODY_BYTES - offset)), offset);
      offset += c.byteLength;
      if (offset >= MAX_BODY_BYTES) break;
    }
    const body = new TextDecoder().decode(merged.subarray(0, Math.min(received, MAX_BODY_BYTES)));
    const ctype = (resp.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    return { body, ctype };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
};

const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const STRIP_BLOCKS = [
  /<script[\s\S]*?<\/script>/gi,
  /<style[\s\S]*?<\/style>/gi,
  /<noscript[\s\S]*?<\/noscript>/gi,
  /<svg[\s\S]*?<\/svg>/gi,
  /<head[\s\S]*?<\/head>/gi,
  /<nav[\s\S]*?<\/nav>/gi,
  /<footer[\s\S]*?<\/footer>/gi,
];
const LINK_RE = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;

function decodeEntities(s: string): string {
  return s.replace(/&[a-z#0-9]+;/gi, (m) => HTML_ENTITIES[m.toLowerCase()] ?? m);
}

function htmlToText(body: string): { text: string; title: string | null } {
  const titleMatch = TITLE_RE.exec(body);
  const title = titleMatch ? decodeEntities(titleMatch[1]!).trim() || null : null;

  let stripped = body;
  for (const re of STRIP_BLOCKS) {
    stripped = stripped.replace(re, " ");
  }
  stripped = stripped
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { text: decodeEntities(stripped), title };
}

function extractLinks(body: string, baseHost: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = LINK_RE.exec(body)) !== null) {
    const href = m[1] ?? m[2] ?? m[3];
    if (!href) continue;
    try {
      const abs = new URL(decodeEntities(href), baseHost).toString().split("#")[0]!;
      if (abs.startsWith("https://") && sameHost(abs, baseHost)) {
        out.push(abs);
      }
    } catch {
      // ignore malformed
    }
  }
  return out;
}

function parseSitemap(xml: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = SITEMAP_LOC_RE.exec(xml)) !== null) {
    out.push(m[1]!);
  }
  return out;
}

interface SearchOptions {
  maxPages?: number;
  maxCharsPerPage?: number;
  maxTotalChars?: number;
}

export async function searchPackageDocs(
  packageName: string,
  query: string,
  ecosystem: string | undefined,
  env: Env,
  options: SearchOptions = {},
): Promise<SearchResult | null> {
  const info = await fetchPackage(packageName, ecosystem, env);
  if (!info) return null;

  const maxPages = options.maxPages ?? intEnv(env.SEARCH_MAX_PAGES, 8, 1, 30);
  const maxCharsPerPage =
    options.maxCharsPerPage ?? intEnv(env.SEARCH_MAX_CHARS_PER_PAGE, 18_000, 500, 200_000);
  const maxTotalChars =
    options.maxTotalChars ?? intEnv(env.SEARCH_MAX_TOTAL_CHARS, 200_000, 1_000, 1_000_000);

  const tokens = tokenizeQuery(query);
  const sources: string[] = [];
  const pages: SearchPage[] = [];
  const seen = new Set<string>();
  const queue: string[] = [];
  let truncated = false;

  const enqueue = (url: string | null | undefined): void => {
    if (!url || !url.startsWith("https://") || seen.has(url)) return;
    seen.add(url);
    queue.push(url);
  };

  // README first
  const readme = await fetchReadmeFor(info, env);
  if (readme) {
    let text = readme;
    if (text.length > maxCharsPerPage) {
      text = text.slice(0, maxCharsPerPage) + "\n\n... [truncated]";
      truncated = true;
    }
    const attribution =
      [info.repository, info.docs_url, info.homepage].find(
        (u) => u && u.startsWith("https://"),
      ) ?? "registry://readme";
    pages.push({
      url: attribution,
      title: `${info.name} README`,
      text,
      score: score(text, tokens),
    });
  }

  const seeds = [info.docs_url, info.homepage].filter(
    (u): u is string => !!u && u.startsWith("https://"),
  );
  for (const seed of seeds) enqueue(seed);

  for (const seed of seeds) {
    const base = schemeHost(seed);
    if (!base) continue;
    for (const suffix of ["/llms-full.txt", "/llms.txt"]) {
      const url = base + suffix;
      sources.push(url);
      enqueue(url);
    }
    const sitemapUrl = base + "/sitemap.xml";
    sources.push(sitemapUrl);
    const sitemap = await safeGet(sitemapUrl, env);
    if (sitemap && (sitemap.ctype.includes("xml") || sitemapUrl.endsWith(".xml"))) {
      for (const loc of parseSitemap(sitemap.body)) {
        if (sameHost(loc, base)) enqueue(loc);
      }
    }
  }

  const firstSeed = seeds[0];
  let expanded = false;
  // README is always included and does not count toward maxPages — that cap
  // is for *discovered* pages so a generic README doesn't crowd out the docs
  // we actually went looking for.
  let discovered = 0;

  let i = 0;
  while (i < queue.length && discovered < maxPages) {
    const url = queue[i++]!;
    const got = await safeGet(url, env);
    if (!got) continue;
    const { body, ctype } = got;
    if (ctype.includes("xml")) continue;

    // Always do link expansion from the first seed, independent of whether
    // the seed itself produces searchable text.
    if (!expanded && firstSeed && url === firstSeed && ctype.includes("html")) {
      expanded = true;
      const base = schemeHost(url);
      if (base) {
        for (const link of extractLinks(body, base)) {
          enqueue(link);
        }
      }
    }

    let text: string;
    let title: string | null;
    if (ctype.includes("html")) {
      const out = htmlToText(body);
      text = out.text;
      title = out.title;
    } else {
      text = body;
      title = null;
    }
    text = text.trim();
    if (!text) continue;

    if (text.length > maxCharsPerPage) {
      text = text.slice(0, maxCharsPerPage) + "\n\n... [truncated]";
      truncated = true;
    }
    pages.push({ url, title, text, score: score(text, tokens) });
    discovered += 1;
  }

  pages.sort((a, b) => b.score - a.score);

  let total = 0;
  const kept: SearchPage[] = [];
  for (const page of pages) {
    const remaining = maxTotalChars - total;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    if (page.text.length > remaining) {
      kept.push({
        ...page,
        text: page.text.slice(0, remaining) + "\n\n... [truncated]",
      });
      truncated = true;
      total = maxTotalChars;
      break;
    }
    kept.push(page);
    total += page.text.length;
  }

  return { package: info, query, pages: kept, truncated, sources_checked: sources };
}

export function renderSearchResult(result: SearchResult): string {
  const lines = [
    `# ${result.package.name} v${result.package.latest_stable} (${result.package.ecosystem})`,
    `Query: ${result.query}`,
    `Pages: ${result.pages.length}${result.truncated ? " (truncated)" : ""}`,
    "",
  ];
  for (const page of result.pages) {
    lines.push("---");
    lines.push(`## ${page.title ?? page.url}`);
    lines.push(`Source: ${page.url}`);
    lines.push("");
    lines.push(page.text);
    lines.push("");
  }
  return lines.join("\n");
}
