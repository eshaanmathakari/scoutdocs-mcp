/** Exact-version validation and registry URL builders.
 *
 * An exact version is served exactly as requested or refused outright: it is
 * never silently replaced with the latest stable release, and the version
 * string is validated before it is interpolated into a registry URL.
 * Mirrors src/scoutdocs_mcp/versions.py (the local server) so both surfaces
 * behave identically.
 */

/** Canonical ecosystem name for every alias the tool surface accepts. */
export const CANONICAL_ECOSYSTEMS: Record<string, string> = {
  python: "python",
  pypi: "python",
  pip: "python",
  javascript: "javascript",
  typescript: "javascript",
  npm: "javascript",
  js: "javascript",
  ts: "javascript",
  rust: "rust",
  cargo: "rust",
  crate: "rust",
};

/** Letters, digits, dots, dashes, underscores and plus signs, starting with a
 * letter or digit, at most 64 characters (PEP 440 and semver both fit). */
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

/** Registry tag aliases are not exact versions: they resolve to whatever the
 * registry currently points at, which is the substitution these tools refuse
 * to make on the caller's behalf. */
const TAG_ALIASES = new Set([
  "latest",
  "next",
  "stable",
  "beta",
  "alpha",
  "canary",
  "edge",
  "nightly",
  "head",
]);

/** Raised when the caller asked for something that is not an exact version. */
export class InvalidExactVersion extends Error {}

/** Return `value` when it is a plausible exact version, otherwise throw. */
export function validateVersion(value: unknown): string {
  if (typeof value !== "string") throw new InvalidExactVersion("invalid_version");
  if (value !== value.trim()) throw new InvalidExactVersion("invalid_version");
  if (!VERSION_PATTERN.test(value)) throw new InvalidExactVersion("invalid_version");
  if (!/[0-9]/.test(value)) throw new InvalidExactVersion("invalid_version");
  if (TAG_ALIASES.has(value.toLowerCase())) throw new InvalidExactVersion("invalid_version");
  return value;
}

/** Build a registry document URL, pinned to `version` when given.
 *
 * Without a version this is the latest-document endpoint the tools already
 * used; with one it is the version-specific document, so an unknown version
 * is a 404 instead of a quiet fall back to the latest release.
 */
export function registryUrl(
  name: string,
  ecosystem: string,
  version?: string | null,
): string {
  const canonical = CANONICAL_ECOSYSTEMS[ecosystem.toLowerCase()];
  if (!canonical) throw new Error("unsupported_ecosystem");
  const pkg = encodeURIComponent(name);
  const suffix = version ? `/${encodeURIComponent(version)}` : "";
  if (canonical === "python") return `https://pypi.org/pypi/${pkg}${suffix}/json`;
  if (canonical === "javascript") return `https://registry.npmjs.org/${pkg}${suffix}`;
  return `https://crates.io/api/v1/crates/${pkg}${suffix}`;
}
