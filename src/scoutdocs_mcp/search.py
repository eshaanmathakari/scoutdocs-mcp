"""Bounded docs discovery and search.

Discovery sources, in priority order:
    1. registry-derived docs URL / homepage / repository README
    2. ``<host>/llms-full.txt`` and ``<host>/llms.txt`` if present
    3. ``<host>/sitemap.xml`` (same-host entries only)
    4. ``<a href>`` links extracted from the seed docs page (same-host, depth 1)

Caps are hard limits and apply per call:
    * max_pages         — total pages returned (default 8)
    * max_chars_per_page — characters per page after extraction (default 20_000)
    * max_total_chars   — sum across all pages (default 120_000)
    * per-response body byte cap — 256 KiB before decoding

All fetches are HTTPS-only with a 10s per-request timeout. Each candidate URL
is fetched at most once across discovery and ingestion.
"""

from __future__ import annotations

import logging
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from html.parser import HTMLParser
from typing import Iterable, Optional
from urllib.parse import urljoin, urlparse

import httpx

from . import __version__
from .docs_fetcher import (
    fetch_npm_readme,
    fetch_pypi_description,
    fetch_readme_from_github,
    is_github_repo_url,
)
from .registries import PackageInfo, fetch_package


_UA = f"scoutdocs-mcp/{__version__} (+https://github.com/eshaanmathakari/scoutdocs-mcp)"

PAGE_TIMEOUT = 10.0
MAX_BODY_BYTES = 256 * 1024

DEFAULT_MAX_PAGES = 15
DEFAULT_CHARS_PER_PAGE = 24_000
DEFAULT_TOTAL_CHARS = 500_000

_SITEMAP_NS = "{http://www.sitemaps.org/schemas/sitemap/0.9}"

logger = logging.getLogger(__name__)


@dataclass
class Page:
    url: str
    title: Optional[str]
    text: str
    score: int = 0


@dataclass
class SearchResult:
    package: PackageInfo
    query: str
    pages: list[Page] = field(default_factory=list)
    truncated: bool = False
    sources_checked: list[str] = field(default_factory=list)

    def render(self) -> str:
        lines = [
            f"# {self.package.name} v{self.package.latest_stable} ({self.package.ecosystem})",
            f"Query: {self.query}",
            f"Pages: {len(self.pages)}"
            + (" (truncated)" if self.truncated else ""),
            "",
        ]
        for page in self.pages:
            lines.append("---")
            lines.append(f"## {page.title or page.url}")
            lines.append(f"Source: {page.url}")
            lines.append("")
            lines.append(page.text)
            lines.append("")
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# HTML / XML helpers (stdlib only)
# ---------------------------------------------------------------------------


class _TextExtractor(HTMLParser):
    """Best-effort visible-text extractor. Skips script/style/svg/head/nav/footer."""

    SKIP = frozenset({"script", "style", "noscript", "svg", "head", "nav", "footer"})

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._chunks: list[str] = []
        self._skip_depth = 0
        self.title: Optional[str] = None
        self._in_title = False
        self._title_buf: list[str] = []

    def handle_starttag(self, tag: str, attrs):  # type: ignore[override]
        tag_l = tag.lower()
        if tag_l in self.SKIP:
            self._skip_depth += 1
        elif tag_l == "title":
            self._in_title = True

    def handle_endtag(self, tag: str) -> None:  # type: ignore[override]
        tag_l = tag.lower()
        if tag_l in self.SKIP and self._skip_depth > 0:
            self._skip_depth -= 1
        elif tag_l == "title":
            self._in_title = False
            if self._title_buf and self.title is None:
                self.title = "".join(self._title_buf).strip()

    def handle_data(self, data: str) -> None:  # type: ignore[override]
        if self._in_title:
            self._title_buf.append(data)
            return
        if self._skip_depth:
            return
        cleaned = data.strip()
        if cleaned:
            self._chunks.append(cleaned)

    @property
    def text(self) -> str:
        return "\n".join(self._chunks)


class _LinkExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.links: list[str] = []

    def handle_starttag(self, tag: str, attrs) -> None:  # type: ignore[override]
        if tag.lower() != "a":
            return
        for k, v in attrs:
            if k.lower() == "href" and v:
                self.links.append(v)
                break


def _html_to_text(html: str) -> tuple[str, Optional[str]]:
    parser = _TextExtractor()
    try:
        parser.feed(html)
    except Exception:
        return html, None
    return parser.text, parser.title


def _extract_links(html: str) -> list[str]:
    parser = _LinkExtractor()
    try:
        parser.feed(html)
    except Exception:
        return []
    return parser.links


def _parse_sitemap(xml_text: str) -> list[str]:
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return []
    return [
        loc.text.strip()
        for loc in root.iter(f"{_SITEMAP_NS}loc")
        if loc.text and loc.text.strip()
    ]


def _scheme_host(url: str) -> Optional[str]:
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.netloc:
        return None
    return f"https://{parsed.netloc}"


def _same_host(url: str, base_host: str) -> bool:
    try:
        return urlparse(url).netloc == urlparse(base_host).netloc
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Fetching
# ---------------------------------------------------------------------------


async def _safe_get(
    client: httpx.AsyncClient, url: str
) -> Optional[tuple[str, str]]:
    """Fetch a URL and return (body, content_type). Enforces caps and HTTPS."""
    if not url.startswith("https://"):
        return None
    try:
        resp = await client.get(url)
    except (httpx.HTTPError, httpx.InvalidURL):
        return None
    if resp.status_code != 200:
        return None
    body = resp.content[:MAX_BODY_BYTES]
    ctype = resp.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    return body.decode("utf-8", errors="ignore"), ctype


def _body_to_page(
    url: str, body: str, ctype: str, char_cap: int
) -> Optional[tuple[Page, bool]]:
    if "html" in ctype:
        text, title = _html_to_text(body)
    elif "xml" in ctype:
        return None  # let sitemap path handle xml
    else:
        text, title = body, None
    text = text.strip()
    if not text:
        return None
    truncated = False
    if len(text) > char_cap:
        text = text[:char_cap] + "\n\n... [truncated]"
        truncated = True
    return Page(url=url, title=title, text=text), truncated


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------


def _tokenize_query(query: str) -> list[str]:
    return [t for t in re.split(r"\W+", query.lower()) if len(t) >= 2]


def _score(text: str, tokens: Iterable[str]) -> int:
    if not text:
        return 0
    haystack = text.lower()
    return sum(haystack.count(t) for t in tokens)


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


async def search_package_docs(
    package: str,
    query: str,
    ecosystem: Optional[str] = None,
    *,
    max_pages: int = DEFAULT_MAX_PAGES,
    max_chars_per_page: int = DEFAULT_CHARS_PER_PAGE,
    max_total_chars: int = DEFAULT_TOTAL_CHARS,
) -> Optional[SearchResult]:
    info = await fetch_package(package, ecosystem)
    if not info:
        return None

    sources_checked: list[str] = []
    pages: list[Page] = []
    seen_urls: set[str] = set()
    queue: list[str] = []
    tokens = _tokenize_query(query)
    any_truncation = False

    def enqueue(url: Optional[str]) -> None:
        if not url or not url.startswith("https://"):
            return
        if url in seen_urls:
            return
        seen_urls.add(url)
        queue.append(url)

    async with httpx.AsyncClient(
        timeout=PAGE_TIMEOUT,
        headers={"User-Agent": _UA},
        follow_redirects=True,
    ) as client:
        # Always include the README/long description as a first page.
        readme_text = await _readme_for(info, truncate_at=max_chars_per_page)
        if readme_text:
            if len(readme_text) > max_chars_per_page:
                readme_text = readme_text[:max_chars_per_page] + "\n\n... [truncated]"
                any_truncation = True
            attribution = next(
                (
                    u
                    for u in (info.repository, info.docs_url, info.homepage)
                    if u and u.startswith("https://")
                ),
                "registry://readme",
            )
            pages.append(
                Page(
                    url=attribution,
                    title=f"{info.name} README",
                    text=readme_text,
                    score=_score(readme_text, tokens),
                )
            )

        seeds: list[str] = [
            u
            for u in (info.docs_url, info.homepage)
            if u and u.startswith("https://") and not is_github_repo_url(u)
        ]

        for seed in seeds:
            enqueue(seed)

        for seed in seeds:
            base = _scheme_host(seed)
            if not base:
                continue
            for suffix in ("/llms-full.txt", "/llms.txt"):
                url = base + suffix
                sources_checked.append(url)
                enqueue(url)

            sitemap_url = base + "/sitemap.xml"
            sources_checked.append(sitemap_url)
            got = await _safe_get(client, sitemap_url)
            if got:
                body, ctype = got
                if "xml" in ctype or sitemap_url.endswith(".xml"):
                    for loc in _parse_sitemap(body):
                        if _same_host(loc, base):
                            enqueue(loc)

        # Walk the queue. Expand <a href> from the first seed exactly once.
        # README is always included and does not count toward max_pages — that
        # cap is for *discovered* pages so a generic README doesn't crowd out
        # the docs we actually went looking for.
        first_seed = seeds[0] if seeds else None
        expanded = False
        discovered = 0
        i = 0
        while i < len(queue) and discovered < max_pages:
            url = queue[i]
            i += 1
            got = await _safe_get(client, url)
            if not got:
                continue
            body, ctype = got
            built = _body_to_page(url, body, ctype, max_chars_per_page)
            if built is not None:
                page, was_trunc = built
                page.score = _score(page.text, tokens)
                pages.append(page)
                discovered += 1
                if was_trunc:
                    any_truncation = True

            if not expanded and url == first_seed and "html" in ctype:
                expanded = True
                base = _scheme_host(url)
                if base:
                    for link in _extract_links(body):
                        abs_url = urljoin(url, link).split("#", 1)[0]
                        if (
                            abs_url
                            and abs_url != url
                            and abs_url.startswith("https://")
                            and _same_host(abs_url, base)
                        ):
                            enqueue(abs_url)

    # Rank by score desc, preserving discovery order on ties.
    pages.sort(key=lambda p: -p.score)

    # Enforce total-chars cap: trim the page that overflows; drop the rest.
    total = 0
    kept: list[Page] = []
    for page in pages:
        remaining = max_total_chars - total
        if remaining <= 0:
            any_truncation = True
            break
        if len(page.text) > remaining:
            page = Page(
                url=page.url,
                title=page.title,
                text=page.text[:remaining] + "\n\n... [truncated]",
                score=page.score,
            )
            any_truncation = True
        kept.append(page)
        total += len(page.text)

    return SearchResult(
        package=info,
        query=query,
        pages=kept,
        truncated=any_truncation,
        sources_checked=sources_checked,
    )


async def _readme_for(
    info: PackageInfo, truncate_at: int = DEFAULT_CHARS_PER_PAGE
) -> Optional[str]:
    if info.ecosystem == "python":
        text = await fetch_pypi_description(info.name, truncate_at=truncate_at)
        if text:
            return text
    elif info.ecosystem in ("javascript", "typescript"):
        text = await fetch_npm_readme(info.name, truncate_at=truncate_at)
        if text:
            return text
    for url in (info.repository, info.docs_url, info.homepage):
        if is_github_repo_url(url):
            text = await fetch_readme_from_github(url or "", truncate_at=truncate_at)
            if text:
                return text
    return None
