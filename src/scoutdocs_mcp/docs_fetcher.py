"""Fetch actual documentation content from package doc sites.

After getting package metadata from registries.py, this module fetches the
actual documentation content. Every fetcher accepts an optional exact
*version*; when one is given, content from another version is never
substituted — in particular not from the default branch or the latest release.
"""

import os
import re
from dataclasses import dataclass
from typing import Optional
from urllib.parse import quote, urlparse, urlsplit
import httpx

from . import __version__
from .versions import registry_url

_UA = f"scoutdocs-mcp/{__version__} (+https://github.com/eshaanmathakari/scoutdocs-mcp)"
_README_TRUNCATE = 3000


@dataclass(frozen=True)
class FetchedDocument:
    """Documentation content together with its provenance."""

    content: str
    #: pypi_description | npm_readme | github_readme
    source: str
    source_url: str
    #: exact_version | exact_version_git_ref | latest_stable | default_branch
    binding: str


def is_github_repo_url(url: Optional[str]) -> bool:
    """Return True when *url* identifies a GitHub repository page."""
    if not url:
        return False
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.netloc != "github.com":
        return False
    return len([part for part in parsed.path.split("/") if part]) >= 2


def _github_readme_url(repo_url: Optional[str], version: Optional[str] = None) -> Optional[str]:
    """Return the GitHub readme API URL for *repo_url*, or None.

    Registry metadata is untrusted input, so anything that is not a plain
    ``https://github.com/<owner>/<repo>`` URL is refused rather than adapted.
    With *version* the readme is read at that Git ref — an unverified ref that
    proves tree content, not published-artifact identity.
    """
    try:
        parsed = urlsplit(repo_url or "")
        if (
            parsed.scheme != "https"
            or parsed.hostname != "github.com"
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
            or parsed.port not in (None, 443)
        ):
            return None
    except ValueError:
        return None
    parts = parsed.path.strip("/").split("/")
    if len(parts) != 2:
        return None
    owner, repo = parts
    repo = repo.removesuffix(".git")
    if not re.fullmatch(r"[A-Za-z0-9_-]+", owner) or not re.fullmatch(r"[A-Za-z0-9_.-]+", repo):
        return None
    if repo in (".", ".."):
        return None
    api_url = f"https://api.github.com/repos/{owner}/{repo}/readme"
    if version:
        api_url += "?ref=" + quote(version, safe="")
    return api_url


async def _fetch_github_readme_with_url(
    repo_url: str,
    version: Optional[str] = None,
    truncate_at: int = _README_TRUNCATE,
) -> Optional[tuple[str, str]]:
    """Return (content, source_url) for the first GitHub ref that resolves.

    Git tags vary between ``1.2.3`` and ``v1.2.3``; both are refs of the same
    release, so the ``v``-prefixed spelling is tried when the plain one 404s.
    A different ref is never tried: a miss for the version stays a miss.
    """
    base_url = _github_readme_url(repo_url)
    if not base_url:
        return None

    refs: list[Optional[str]] = [version]
    if version and not version.startswith("v"):
        refs.append("v" + version)

    headers = {
        "Accept": "application/vnd.github.raw",
        "User-Agent": _UA,
        "X-GitHub-Api-Version": "2022-11-28",
    }
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"

    async with httpx.AsyncClient(timeout=15) as client:
        for ref in refs:
            url = base_url + (f"?ref={quote(ref, safe='')}" if ref else "")
            resp = await client.get(url, headers=headers)
            if resp.status_code == 200:
                content = resp.text
                if len(content) > truncate_at:
                    content = content[:truncate_at] + "\n\n... [truncated — see full docs]"
                return content, url
    return None


async def fetch_readme_from_github(
    repo_url: str,
    version: Optional[str] = None,
    truncate_at: int = _README_TRUNCATE,
) -> Optional[str]:
    """Fetch README content from a GitHub repository, optionally at a ref."""
    result = await _fetch_github_readme_with_url(repo_url, version, truncate_at)
    return result[0] if result else None


async def fetch_pypi_description(
    package: str,
    version: Optional[str] = None,
    truncate_at: int = _README_TRUNCATE,
) -> Optional[str]:
    """Fetch the long description from PyPI, pinned to *version* when given."""
    async with httpx.AsyncClient(timeout=15, headers={"User-Agent": _UA}) as client:
        resp = await client.get(registry_url(package, "python", version))
        if resp.status_code != 200:
            return None
        data = resp.json()
        desc = data["info"].get("description", "")
        if len(desc) > truncate_at:
            desc = desc[:truncate_at] + "\n\n... [truncated]"
        return desc if desc else None


async def fetch_npm_readme(
    package: str,
    version: Optional[str] = None,
    truncate_at: int = _README_TRUNCATE,
) -> Optional[str]:
    """Fetch README from the npm registry, pinned to *version* when given.

    npm version manifests usually omit the readme field. When they do, there
    is simply no registry-side readme for that version; callers must not
    substitute the packument's latest readme in its place.
    """
    async with httpx.AsyncClient(timeout=15, headers={"User-Agent": _UA}) as client:
        resp = await client.get(registry_url(package, "javascript", version))
        if resp.status_code != 200:
            return None
        data = resp.json()
        readme = data.get("readme", "")
        if len(readme) > truncate_at:
            readme = readme[:truncate_at] + "\n\n... [truncated]"
        return readme if readme and readme != "ERROR: No README data found!" else None


async def fetch_docs_content_with_provenance(
    package: str,
    ecosystem: str,
    docs_url: Optional[str] = None,
    repo_url: Optional[str] = None,
    version: Optional[str] = None,
) -> Optional[FetchedDocument]:
    """Fetch documentation content and report exactly where it came from.

    With *version*, only that version's registry document or the README at
    that Git ref is accepted: an unavailable version is reported as missing
    rather than replaced with default-branch or latest-release content.
    """
    if ecosystem == "python":
        content = await fetch_pypi_description(package, version)
        if content:
            return FetchedDocument(
                content=content,
                source="pypi_description",
                source_url=registry_url(package, "python", version),
                binding="exact_version" if version else "latest_stable",
            )

    if ecosystem in ("javascript", "typescript"):
        content = await fetch_npm_readme(package, version)
        if content:
            return FetchedDocument(
                content=content,
                source="npm_readme",
                source_url=registry_url(package, "javascript", version),
                binding="exact_version" if version else "latest_stable",
            )

    # GitHub README fallback. With a version this reads that release's ref
    # explicitly, so a missing tag is a miss — not a silent default-branch
    # substitution. Provenance records the ref that actually resolved.
    for url in (repo_url, docs_url):
        if url:
            fetched = await _fetch_github_readme_with_url(url, version)
            if fetched:
                content, source_url = fetched
                return FetchedDocument(
                    content=content,
                    source="github_readme",
                    source_url=source_url,
                    binding="exact_version_git_ref" if version else "default_branch",
                )

    return None


async def fetch_docs_content(
    package: str,
    ecosystem: str,
    docs_url: Optional[str] = None,
    repo_url: Optional[str] = None,
    version: Optional[str] = None,
) -> Optional[str]:
    """Return documentation content only, discarding provenance."""
    result = await fetch_docs_content_with_provenance(
        package, ecosystem, docs_url, repo_url, version
    )
    return result.content if result else None
