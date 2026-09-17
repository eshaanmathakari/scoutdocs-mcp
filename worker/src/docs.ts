/** Fetch README/long-description content from registries or GitHub.
 *
 * With an exact version, only that version's registry document or the README
 * at that Git ref is accepted: an unavailable version is reported as missing
 * rather than replaced with default-branch or latest-release content.
 * Mirrors src/scoutdocs_mcp/docs_fetcher.py (the local server).
 */

import type { Env, FetchedDoc, PackageInfo } from "./types.js";
import { registryUrl } from "./versions.js";

const README_TRUNCATE = 3000;
const FETCH_TIMEOUT_MS = 10_000;

function ua(env: Env): string {
  return `scoutdocs-mcp-worker/${env.SCOUTDOCS_VERSION} (+https://github.com/eshaanmathakari/scoutdocs-mcp)`;
}

function truncateText(text: string, maxChars: number, marker = "\n\n... [truncated]"): string {
  return text.length > maxChars ? text.slice(0, maxChars) + marker : text;
}

export function isGitHubRepoUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === "github.com" &&
      parsed.pathname.split("/").filter(Boolean).length >= 2
    );
  } catch {
    return false;
  }
}

/** GitHub readme API URLs for a repository, at a version ref when given.
 *
 * Registry metadata is untrusted input: anything that is not a plain
 * https://github.com/<owner>/<repo> URL is refused rather than adapted. Git
 * tags vary between `1.2.3` and `v1.2.3`; both are refs of the same release,
 * so the v-prefixed spelling is tried when the plain one misses. A different
 * ref is never tried.
 */
function githubReadmeUrls(repoUrl: string | null | undefined, version?: string | null): string[] {
  if (!repoUrl) return [];
  try {
    const parsed = new URL(repoUrl);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "github.com" ||
      parsed.search ||
      parsed.hash
    ) {
      return [];
    }
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length !== 2) return [];
    const owner = parts[0];
    const repo = parts[1].replace(/\.git$/, "");
    if (!/^[A-Za-z0-9_-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) return [];
    if (repo === "." || repo === "..") return [];
    const base = `https://api.github.com/repos/${owner}/${repo}/readme`;
    if (!version) return [base];
    const refs = [version];
    if (!version.startsWith("v")) refs.push("v" + version);
    return refs.map((ref) => `${base}?ref=${encodeURIComponent(ref)}`);
  } catch {
    return [];
  }
}

async function fetchGitHubReadmeWithUrl(
  repoUrl: string | null | undefined,
  env: Env,
  version: string | null | undefined,
  maxChars: number,
): Promise<{ text: string; url: string } | null> {
  for (const url of githubReadmeUrls(repoUrl, version)) {
    const resp = await safeFetch(url, env, {
      headers: {
        Accept: "application/vnd.github.raw",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (resp) {
      const text = await resp.text();
      if (text) {
        return { text: truncateText(text, maxChars, "\n\n... [truncated — see full docs]"), url };
      }
    }
  }
  return null;
}

export async function fetchGitHubReadme(
  repoUrl: string | null,
  env: Env,
  maxChars = README_TRUNCATE,
  version?: string | null,
): Promise<string | null> {
  const fetched = await fetchGitHubReadmeWithUrl(repoUrl, env, version, maxChars);
  return fetched ? fetched.text : null;
}

export async function fetchPyPIDescription(
  name: string,
  env: Env,
  maxChars = README_TRUNCATE,
  version?: string | null,
): Promise<string | null> {
  const resp = await safeFetch(registryUrl(name, "python", version), env);
  if (!resp) return null;
  const data = (await resp.json()) as { info?: { description?: string } };
  const desc = data.info?.description ?? "";
  if (!desc) return null;
  return truncateText(desc, maxChars);
}

export async function fetchNpmReadme(
  name: string,
  env: Env,
  maxChars = README_TRUNCATE,
  version?: string | null,
): Promise<string | null> {
  const resp = await safeFetch(registryUrl(name, "javascript", version), env);
  if (!resp) return null;
  const data = (await resp.json()) as { readme?: string };
  const readme = data.readme ?? "";
  if (!readme || readme === "ERROR: No README data found!") return null;
  return truncateText(readme, maxChars);
}

/** Fetch documentation content and report exactly where it came from.
 *
 * With a version, only that version's registry document or the README at that
 * Git ref is accepted: an unavailable version is reported as missing rather
 * than replaced with default-branch or latest-release content.
 */
export async function fetchReadmeForWithProvenance(
  info: PackageInfo,
  env: Env,
  version: string | null = null,
  maxChars = README_TRUNCATE,
): Promise<FetchedDoc | null> {
  if (info.ecosystem === "python") {
    const text = await fetchPyPIDescription(info.name, env, maxChars, version);
    if (text) {
      return {
        text,
        source: "pypi_description",
        source_url: registryUrl(info.name, "python", version),
        binding: version ? "exact_version" : "latest_stable",
      };
    }
  } else if (info.ecosystem === "javascript") {
    const text = await fetchNpmReadme(info.name, env, maxChars, version);
    if (text) {
      return {
        text,
        source: "npm_readme",
        source_url: registryUrl(info.name, "javascript", version),
        binding: version ? "exact_version" : "latest_stable",
      };
    }
  }
  for (const url of [info.repository, info.docs_url, info.homepage]) {
    const fetched = await fetchGitHubReadmeWithUrl(url, env, version, maxChars);
    if (fetched) {
      return {
        text: fetched.text,
        source: "github_readme",
        source_url: fetched.url,
        binding: version ? "exact_version_git_ref" : "default_branch",
      };
    }
  }
  return null;
}

export async function fetchReadmeFor(
  info: PackageInfo,
  env: Env,
  maxChars = README_TRUNCATE,
  version: string | null = null,
): Promise<string | null> {
  const doc = await fetchReadmeForWithProvenance(info, env, version, maxChars);
  return doc ? doc.text : null;
}

async function safeFetch(url: string, env: Env, init?: RequestInit): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { "User-Agent": ua(env), ...(init?.headers || {}) },
    });
    if (!resp.ok) return null;
    return resp;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
