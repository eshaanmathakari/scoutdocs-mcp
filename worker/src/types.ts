/** Cloudflare bindings declared in wrangler.toml. */
export interface Env {
  CACHE: KVNamespace;
  RATE_LIMIT_MCP: RateLimit;
  RATE_LIMIT_SEARCH: RateLimit;
  SCOUTDOCS_VERSION: string;
  CACHE_TTL_SECONDS: string;
  SEARCH_MAX_PAGES: string;
  SEARCH_MAX_CHARS_PER_PAGE: string;
  SEARCH_MAX_TOTAL_CHARS: string;
  ALLOWED_ORIGINS?: string;
}

export interface RateLimit {
  limit(args: { key: string }): Promise<{ success: boolean }>;
}

export interface PackageInfo {
  name: string;
  ecosystem: "python" | "javascript" | "rust";
  latest_stable: string;
  description: string;
  homepage: string | null;
  docs_url: string | null;
  repository: string | null;
  license: string | null;
}

export interface SearchPage {
  url: string;
  title: string | null;
  text: string;
  score: number;
}

export interface SearchResult {
  package: PackageInfo;
  query: string;
  pages: SearchPage[];
  truncated: boolean;
  sources_checked: string[];
}
