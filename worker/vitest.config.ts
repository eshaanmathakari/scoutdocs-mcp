import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          // Provide deterministic env for tests; rate-limiters are mocked via SELF.
          bindings: {
            SCOUTDOCS_VERSION: "0.2.0-beta.1-test",
            CACHE_TTL_SECONDS: "60",
            SEARCH_MAX_PAGES: "8",
            SEARCH_MAX_CHARS_PER_PAGE: "18000",
            SEARCH_MAX_TOTAL_CHARS: "200000",
          },
        },
      },
    },
  },
});
