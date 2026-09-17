/** Package-registry clients: PyPI, npm, crates.io.
 *
 * Every fetcher accepts an optional exact version. A pinned lookup fetches
 * the version-specific registry document and nothing else: when the version
 * does not exist the fetcher returns null instead of falling back to the
 * latest release.
 */

import type { Env, PackageInfo } from "./types.js";
import { registryUrl } from "./versions.js";

const REGISTRY_TIMEOUT_MS = 15_000;

function ua(env: Env): string {
  return `scoutdocs-mcp-worker/${env.SCOUTDOCS_VERSION} (+https://github.com/eshaanmathakari/scoutdocs-mcp)`;
}

async function fetchJson<T>(url: string, env: Env, init?: RequestInit): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REGISTRY_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { "User-Agent": ua(env), Accept: "application/json", ...(init?.headers || {}) },
    });
    if (!resp.ok) return null;
    return (await resp.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- PyPI ----------

interface PyPIRelease {
  filename: string;
}
interface PyPIData {
  info: {
    name: string;
    version: string;
    summary: string;
    docs_url: string | null;
    home_page: string | null;
    license: string | null;
    project_urls?: Record<string, string>;
    description?: string;
  };
  releases: Record<string, PyPIRelease[]>;
}

const PRE_RE = /(a|b|c|rc|dev|alpha|beta|pre)/i;

function pickPyPIStable(data: PyPIData): string {
  const versions = Object.keys(data.releases).filter((v) => {
    if (!data.releases[v] || data.releases[v].length === 0) return false;
    if (PRE_RE.test(v)) return false;
    return /^\d/.test(v);
  });
  versions.sort(semverDescending);
  return versions[0] ?? data.info.version;
}

function semverDescending(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((n) => Number(n) || 0);
  const pb = b.split(/[.-]/).map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return db - da;
  }
  return 0;
}

export async function fetchPyPI(
  name: string,
  version: string | null,
  env: Env,
): Promise<PackageInfo | null> {
  const data = await fetchJson<PyPIData>(registryUrl(name, "python", version), env);
  if (!data) return null;
  const projectUrls = data.info.project_urls ?? {};
  const homepage = data.info.home_page ?? projectUrls.Homepage ?? null;
  const docsUrl = data.info.docs_url ?? projectUrls.Documentation ?? null;
  const repository = projectUrls.Source ?? projectUrls.Repository ?? null;

  if (version) {
    return {
      name,
      ecosystem: "python",
      latest_stable: null,
      description: data.info.summary ?? "",
      homepage,
      docs_url: docsUrl,
      repository,
      license: data.info.license ?? null,
      version: data.info.version ?? version,
    };
  }

  const stable = pickPyPIStable(data);
  return {
    name,
    ecosystem: "python",
    latest_stable: stable,
    description: data.info.summary ?? "",
    homepage,
    docs_url: docsUrl,
    repository,
    license: data.info.license ?? null,
  };
}

// ---------- npm ----------

interface NpmData {
  name: string;
  description: string;
  "dist-tags": { latest: string };
  homepage?: string;
  repository?: string | { url?: string };
  versions: Record<string, { license?: string; homepage?: string }>;
  readme?: string;
}

interface NpmVersionData {
  version?: string;
  description?: string;
  homepage?: string;
  license?: string;
  repository?: string | { url?: string };
}

function normalizeNpmRepo(repo: string | { url?: string } | undefined): string | null {
  if (!repo) return null;
  const raw = typeof repo === "string" ? repo : repo.url ?? "";
  return raw.replace(/^git\+/, "").replace(/^git:\/\//, "https://").replace(/\.git$/, "") || null;
}

export async function fetchNpm(
  name: string,
  version: string | null,
  env: Env,
): Promise<PackageInfo | null> {
  if (version) {
    const data = await fetchJson<NpmVersionData>(
      registryUrl(name, "javascript", version),
      env,
    );
    if (!data) return null;
    return {
      name,
      ecosystem: "javascript",
      latest_stable: null,
      description: data.description ?? "",
      homepage: data.homepage ?? null,
      docs_url: data.homepage ?? null,
      repository: normalizeNpmRepo(data.repository),
      license: data.license ?? null,
      version: data.version ?? version,
    };
  }

  const data = await fetchJson<NpmData>(registryUrl(name, "javascript"), env);
  if (!data) return null;
  const latest = data["dist-tags"]?.latest ?? "";
  const meta = data.versions?.[latest] ?? {};
  return {
    name,
    ecosystem: "javascript",
    latest_stable: latest,
    description: data.description ?? "",
    homepage: meta.homepage ?? data.homepage ?? null,
    docs_url: meta.homepage ?? data.homepage ?? null,
    repository: normalizeNpmRepo(data.repository),
    license: meta.license ?? null,
  };
}

// ---------- crates.io ----------

interface CratesData {
  crate: {
    name: string;
    newest_version: string;
    description: string;
    homepage: string | null;
    repository: string | null;
  };
  versions: Array<{ num: string; yanked: boolean; license?: string }>;
}

interface CratesVersionDoc {
  version?: {
    num?: string;
    description?: string;
    homepage?: string | null;
    repository?: string | null;
    license?: string | null;
  };
}

export async function fetchCrates(
  name: string,
  version: string | null,
  env: Env,
): Promise<PackageInfo | null> {
  if (version) {
    const data = await fetchJson<CratesVersionDoc>(registryUrl(name, "rust", version), env);
    if (!data) return null;
    const record = data.version ?? {};
    const resolved = record.num ?? version;
    return {
      name,
      ecosystem: "rust",
      latest_stable: null,
      description: record.description ?? "",
      homepage: record.homepage ?? null,
      // docs.rs hosts every published version, so the versioned URL is the
      // binding we promise; the record's documentation field is crate-level.
      docs_url: `https://docs.rs/${name}/${resolved}`,
      repository: record.repository ?? null,
      license: record.license ?? null,
      version: resolved,
    };
  }

  const data = await fetchJson<CratesData>(registryUrl(name, "rust"), env);
  if (!data) return null;
  const stable =
    data.versions.find((v) => !v.yanked && !v.num.includes("-"))?.num ?? data.crate.newest_version;
  return {
    name,
    ecosystem: "rust",
    latest_stable: stable,
    description: data.crate.description ?? "",
    homepage: data.crate.homepage,
    docs_url: `https://docs.rs/${name}/${stable}`,
    repository: data.crate.repository,
    license: data.versions[0]?.license ?? null,
  };
}

// ---------- dispatch ----------

const FETCHERS: Record<
  string,
  (name: string, version: string | null, env: Env) => Promise<PackageInfo | null>
> = {
  python: fetchPyPI,
  pypi: fetchPyPI,
  pip: fetchPyPI,
  javascript: fetchNpm,
  typescript: fetchNpm,
  npm: fetchNpm,
  js: fetchNpm,
  ts: fetchNpm,
  rust: fetchCrates,
  cargo: fetchCrates,
  crate: fetchCrates,
};

export const ECOSYSTEMS = Array.from(new Set(Object.keys(FETCHERS)));

export async function fetchPackage(
  name: string,
  ecosystem: string | undefined,
  env: Env,
  version: string | null = null,
): Promise<PackageInfo | null> {
  if (ecosystem) {
    const fn = FETCHERS[ecosystem.toLowerCase()];
    return fn ? await fn(name, version, env) : null;
  }
  for (const fn of [fetchPyPI, fetchNpm, fetchCrates]) {
    const result = await fn(name, version, env);
    if (result) return result;
  }
  return null;
}
