"""Package registry clients for fetching documentation metadata.

Supports: PyPI (Python), npm (JavaScript/TypeScript), crates.io (Rust).

Every fetcher accepts an optional exact *version*. A pinned lookup fetches the
version-specific registry document and nothing else: when the version does not
exist the fetcher returns None instead of falling back to the latest release.
"""

import httpx
from dataclasses import dataclass
from typing import Optional
from packaging.version import Version, InvalidVersion

from . import __version__
from .versions import registry_url

_UA = f"scoutdocs-mcp/{__version__} (+https://github.com/eshaanmathakari/scoutdocs-mcp)"


@dataclass
class PackageInfo:
    """Metadata about a package from its registry."""

    name: str
    ecosystem: str
    latest_stable: Optional[str]
    description: str
    homepage: Optional[str] = None
    docs_url: Optional[str] = None
    repository: Optional[str] = None
    license: Optional[str] = None
    #: The exact version this record describes, when the lookup was pinned.
    version: Optional[str] = None


def _npm_repository(repository: object) -> Optional[str]:
    """Normalise an npm repository field into a browsable URL."""
    if isinstance(repository, dict):
        repository = repository.get("url")
    if not isinstance(repository, str) or not repository:
        return None
    url = repository
    if url.startswith("git+"):
        url = url[4:]
    if url.startswith("git://"):
        url = "https://" + url[6:]
    return url.removesuffix(".git") or None


async def fetch_pypi(package: str, version: Optional[str] = None) -> Optional[PackageInfo]:
    """Fetch package info from PyPI: latest stable, or the exact *version*."""
    async with httpx.AsyncClient(timeout=15, headers={"User-Agent": _UA}) as client:
        resp = await client.get(registry_url(package, "python", version))
        if resp.status_code != 200:
            return None
        data = resp.json()
        info = data["info"]

        docs_url = info.get("docs_url") or info.get("project_urls", {}).get("Documentation")
        homepage = info.get("home_page") or info.get("project_urls", {}).get("Homepage")
        repo = info.get("project_urls", {}).get("Source") or info.get("project_urls", {}).get("Repository")

        if version is not None:
            return PackageInfo(
                name=package,
                ecosystem="python",
                latest_stable=None,
                description=info.get("summary", ""),
                homepage=homepage,
                docs_url=docs_url,
                repository=repo,
                license=info.get("license", ""),
                version=info.get("version") or version,
            )

        # Find latest stable version (skip pre-releases)
        stable = info["version"]
        releases = data.get("releases", {})
        # Parse and sort by actual version semantics, not lexicographic order
        parsed = []
        for ver in releases:
            try:
                parsed.append((Version(ver), ver))
            except InvalidVersion:
                continue
        for v, ver in sorted(parsed, reverse=True):
            if v.is_prerelease:
                continue
            if releases[ver]:  # has actual files
                stable = ver
                break

        return PackageInfo(
            name=package,
            ecosystem="python",
            latest_stable=stable,
            description=info.get("summary", ""),
            homepage=homepage,
            docs_url=docs_url,
            repository=repo,
            license=info.get("license", ""),
        )


async def fetch_npm(package: str, version: Optional[str] = None) -> Optional[PackageInfo]:
    """Fetch package info from npm: latest stable, or the exact *version*."""
    async with httpx.AsyncClient(timeout=15, headers={"User-Agent": _UA}) as client:
        resp = await client.get(registry_url(package, "javascript", version))
        if resp.status_code != 200:
            return None
        data = resp.json()

        if version is not None:
            return PackageInfo(
                name=package,
                ecosystem="javascript",
                latest_stable=None,
                description=data.get("description", ""),
                homepage=data.get("homepage"),
                docs_url=data.get("homepage"),
                repository=_npm_repository(data.get("repository")),
                license=data.get("license", ""),
                version=data.get("version") or version,
            )

        # Get latest stable (dist-tags.latest)
        latest = data.get("dist-tags", {}).get("latest", "")
        latest_info = data.get("versions", {}).get(latest, {})

        homepage = latest_info.get("homepage") or data.get("homepage")

        return PackageInfo(
            name=package,
            ecosystem="javascript",
            latest_stable=latest,
            description=data.get("description", ""),
            homepage=homepage,
            docs_url=homepage,  # npm packages usually use homepage for docs
            repository=_npm_repository(data.get("repository")),
            license=latest_info.get("license", ""),
        )


async def fetch_crates(package: str, version: Optional[str] = None) -> Optional[PackageInfo]:
    """Fetch package info from crates.io: latest stable, or the exact *version*."""
    async with httpx.AsyncClient(timeout=15, headers={"User-Agent": _UA}) as client:
        resp = await client.get(registry_url(package, "rust", version))
        if resp.status_code != 200:
            return None
        data = resp.json()

        if version is not None:
            # The version-specific document carries a single version record.
            record = data.get("version", {})
            resolved = record.get("num") or version
            # docs.rs hosts every published version, so the versioned URL is
            # the binding we promise; the record's documentation field is
            # crate-level and would point readers at latest.
            return PackageInfo(
                name=package,
                ecosystem="rust",
                latest_stable=None,
                description=record.get("description", ""),
                homepage=record.get("homepage"),
                docs_url=f"https://docs.rs/{package}/{resolved}",
                repository=record.get("repository"),
                license=record.get("license", ""),
                version=resolved,
            )

        crate = data.get("crate", {})
        versions = data.get("versions", [])

        # Find latest stable (non-yanked, non-pre)
        stable = crate.get("newest_version", "")
        for v in versions:
            if not v.get("yanked") and "-" not in v.get("num", "-"):
                stable = v["num"]
                break

        return PackageInfo(
            name=package,
            ecosystem="rust",
            latest_stable=stable,
            description=crate.get("description", ""),
            homepage=crate.get("homepage"),
            docs_url=f"https://docs.rs/{package}/{stable}",
            repository=crate.get("repository"),
            license=versions[0].get("license", "") if versions else "",
        )


REGISTRY_MAP = {
    "python": fetch_pypi,
    "pypi": fetch_pypi,
    "pip": fetch_pypi,
    "javascript": fetch_npm,
    "typescript": fetch_npm,
    "npm": fetch_npm,
    "js": fetch_npm,
    "ts": fetch_npm,
    "rust": fetch_crates,
    "cargo": fetch_crates,
    "crate": fetch_crates,
}


async def fetch_package(
    package: str,
    ecosystem: Optional[str] = None,
    version: Optional[str] = None,
) -> Optional[PackageInfo]:
    """Fetch package info, auto-detecting ecosystem if not specified.

    With *version*, auto-detection finds the ecosystem whose registry holds
    that exact version. Nothing falls back to latest stable: an unknown
    version returns None.
    """
    if ecosystem:
        fetcher = REGISTRY_MAP.get(ecosystem.lower())
        if fetcher:
            return await fetcher(package, version)
        return None

    # Try all registries in order of likelihood
    for fetcher in [fetch_pypi, fetch_npm, fetch_crates]:
        try:
            result = await fetcher(package, version)
            if result:
                return result
        except Exception:
            continue
    return None
