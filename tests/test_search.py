"""Tests for bounded docs discovery and search."""

import pytest

from scoutdocs_mcp import search as search_mod
from scoutdocs_mcp.search import (
    Page,
    _extract_links,
    _html_to_text,
    _parse_sitemap,
    _scheme_host,
    _score,
    _tokenize_query,
    search_package_docs,
)


# ---------- pure helpers ----------


def test_html_to_text_strips_script_and_style():
    html = """<html><head><title>Docs Home</title>
        <style>body{color:red}</style>
        <script>var x=1;</script></head>
        <body><h1>Hello</h1><p>World</p></body></html>"""

    text, title = _html_to_text(html)
    assert title == "Docs Home"
    assert "Hello" in text and "World" in text
    assert "color:red" not in text
    assert "var x" not in text


def test_extract_links_returns_hrefs():
    html = '<a href="/a">A</a><a href="https://x/b">B</a><a>no href</a>'
    assert _extract_links(html) == ["/a", "https://x/b"]


def test_parse_sitemap_handles_namespace():
    xml = """<?xml version="1.0" encoding="UTF-8"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://example.com/a</loc></url>
      <url><loc>https://example.com/b</loc></url>
    </urlset>"""
    assert _parse_sitemap(xml) == ["https://example.com/a", "https://example.com/b"]


def test_parse_sitemap_handles_invalid_xml():
    assert _parse_sitemap("not xml") == []


def test_scheme_host_https_only():
    assert _scheme_host("https://docs.example.com/page") == "https://docs.example.com"
    assert _scheme_host("http://docs.example.com/page") is None
    assert _scheme_host("not-a-url") is None


def test_tokenize_and_score():
    tokens = _tokenize_query("Async Generator")
    assert tokens == ["async", "generator"]
    assert _score("async generators are great", tokens) == 2
    assert _score("synchronous only", tokens) == 0


# ---------- end-to-end search ----------


PYPI_PAYLOAD = {
    "info": {
        "name": "demo",
        "version": "1.0.0",
        "summary": "demo lib",
        "description": "# demo\n\nUse the async generator API for streaming.",
        "home_page": None,
        "docs_url": "https://docs.example.com/",
        "license": "MIT",
        "project_urls": {"Source": "https://github.com/example/demo"},
    },
    "releases": {"1.0.0": [{"filename": "demo-1.0.0.tar.gz"}]},
}


def _seed_pypi(httpx_mock):
    # PyPI gets hit twice per search (info + README). Mark reusable.
    httpx_mock.add_response(
        url="https://pypi.org/pypi/demo/json", json=PYPI_PAYLOAD, is_reusable=True
    )


async def test_search_uses_llms_txt_when_present(httpx_mock):
    """If llms-full.txt is present we ingest it as a page."""
    _seed_pypi(httpx_mock)

    httpx_mock.add_response(
        url="https://docs.example.com/llms-full.txt",
        text="async generator: detailed reference manual",
        headers={"content-type": "text/plain"},
    )
    httpx_mock.add_response(
        url="https://docs.example.com/llms.txt", status_code=404
    )
    httpx_mock.add_response(
        url="https://docs.example.com/sitemap.xml", status_code=404
    )
    httpx_mock.add_response(
        url="https://docs.example.com/",
        text="<html><head><title>Demo</title></head><body><a href='/api'>API</a></body></html>",
        headers={"content-type": "text/html"},
    )
    httpx_mock.add_response(
        url="https://docs.example.com/api",
        text="<html><body><h1>API</h1><p>async generator details</p></body></html>",
        headers={"content-type": "text/html"},
    )

    result = await search_package_docs("demo", "async generator", ecosystem="python")

    assert result is not None
    assert result.package.name == "demo"
    urls = [p.url for p in result.pages]
    assert "https://docs.example.com/llms-full.txt" in urls
    # README is always first-included
    assert any(p.title == "demo README" for p in result.pages)
    # Pages are sorted by score descending
    scores = [p.score for p in result.pages]
    assert scores == sorted(scores, reverse=True)


async def test_search_discovers_sitemap_entries(httpx_mock):
    _seed_pypi(httpx_mock)

    httpx_mock.add_response(
        url="https://docs.example.com/llms-full.txt", status_code=404
    )
    httpx_mock.add_response(
        url="https://docs.example.com/llms.txt", status_code=404
    )
    httpx_mock.add_response(
        url="https://docs.example.com/sitemap.xml",
        text=(
            '<?xml version="1.0"?>'
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
            "<url><loc>https://docs.example.com/guide</loc></url>"
            "<url><loc>https://other-host.com/leak</loc></url>"  # filtered: different host
            "</urlset>"
        ),
        headers={"content-type": "application/xml"},
    )
    httpx_mock.add_response(
        url="https://docs.example.com/",
        text="<html><body>seed</body></html>",
        headers={"content-type": "text/html"},
    )
    httpx_mock.add_response(
        url="https://docs.example.com/guide",
        text="<html><body>guide content with async generator</body></html>",
        headers={"content-type": "text/html"},
    )

    result = await search_package_docs("demo", "async generator", ecosystem="python")
    assert result is not None
    urls = [p.url for p in result.pages]
    assert "https://docs.example.com/guide" in urls
    assert not any("other-host.com" in u for u in urls)


@pytest.mark.httpx_mock(assert_all_responses_were_requested=False)
async def test_search_enforces_max_pages(httpx_mock):
    _seed_pypi(httpx_mock)

    httpx_mock.add_response(
        url="https://docs.example.com/llms-full.txt",
        text="page1",
        headers={"content-type": "text/plain"},
    )
    httpx_mock.add_response(
        url="https://docs.example.com/llms.txt",
        text="page2",
        headers={"content-type": "text/plain"},
    )
    httpx_mock.add_response(
        url="https://docs.example.com/sitemap.xml", status_code=404
    )
    httpx_mock.add_response(
        url="https://docs.example.com/",
        text="<html><body><a href='/x'>x</a><a href='/y'>y</a></body></html>",
        headers={"content-type": "text/html"},
    )
    httpx_mock.add_response(
        url="https://docs.example.com/x",
        text="<html><body>x</body></html>",
        headers={"content-type": "text/html"},
    )
    httpx_mock.add_response(
        url="https://docs.example.com/y",
        text="<html><body>y</body></html>",
        headers={"content-type": "text/html"},
    )

    result = await search_package_docs(
        "demo", "anything", ecosystem="python", max_pages=2
    )
    assert result is not None
    # README is always free; cap applies to discovered pages only.
    readme_count = sum(1 for p in result.pages if p.title == "demo README")
    discovered_count = len(result.pages) - readme_count
    assert discovered_count <= 2


async def test_search_enforces_total_char_cap(httpx_mock):
    _seed_pypi(httpx_mock)

    big = "x" * 10_000
    httpx_mock.add_response(
        url="https://docs.example.com/llms-full.txt",
        text=big,
        headers={"content-type": "text/plain"},
    )
    httpx_mock.add_response(
        url="https://docs.example.com/llms.txt", status_code=404
    )
    httpx_mock.add_response(
        url="https://docs.example.com/sitemap.xml", status_code=404
    )
    httpx_mock.add_response(
        url="https://docs.example.com/",
        text="<html><body>seed</body></html>",
        headers={"content-type": "text/html"},
    )

    result = await search_package_docs(
        "demo",
        "x",
        ecosystem="python",
        max_chars_per_page=5_000,
        max_total_chars=6_000,
    )
    assert result is not None
    total = sum(len(p.text) for p in result.pages)
    assert total <= 6_000 + 100  # allow trailing "[truncated]" marker
    assert result.truncated is True


async def test_search_rejects_http_only_seeds(httpx_mock):
    """If docs_url is http://, we should not even attempt to crawl."""
    payload = {
        "info": {
            "name": "demo",
            "version": "1.0.0",
            "summary": "demo lib",
            "description": "readme",
            "home_page": None,
            "docs_url": "http://insecure.example.com/",
            "license": "MIT",
            "project_urls": {},
        },
        "releases": {"1.0.0": [{"filename": "x.tar.gz"}]},
    }
    httpx_mock.add_response(
        url="https://pypi.org/pypi/demo/json", json=payload, is_reusable=True
    )

    result = await search_package_docs("demo", "anything", ecosystem="python")
    assert result is not None
    # No crawled pages; README only.
    assert all(not p.url.startswith("http://") for p in result.pages)


async def test_search_skips_github_ui_pages(httpx_mock):
    """GitHub repo/readme URLs should not be crawled as HTML docs pages."""
    payload = {
        "info": {
            "name": "demo",
            "version": "1.0.0",
            "summary": "demo lib",
            "description": "README content with search term",
            "home_page": "https://github.com/example/demo",
            "docs_url": "https://github.com/example/demo#readme",
            "license": "MIT",
            "project_urls": {"Source": "https://github.com/example/demo"},
        },
        "releases": {"1.0.0": [{"filename": "x.tar.gz"}]},
    }
    httpx_mock.add_response(
        url="https://pypi.org/pypi/demo/json", json=payload, is_reusable=True
    )

    result = await search_package_docs("demo", "search term", ecosystem="python")

    assert result is not None
    assert [p.title for p in result.pages] == ["demo README"]
    assert "README content" in result.pages[0].text


async def test_search_uses_larger_readme_cap(httpx_mock):
    """Search should not inherit the short get_package_docs README cap."""
    payload = {
        "info": {
            "name": "bigreadme",
            "version": "1.0.0",
            "summary": "demo lib",
            "description": "x" * 10_000,
            "home_page": None,
            "docs_url": None,
            "license": "MIT",
            "project_urls": {},
        },
        "releases": {"1.0.0": [{"filename": "x.tar.gz"}]},
    }
    httpx_mock.add_response(
        url="https://pypi.org/pypi/bigreadme/json", json=payload, is_reusable=True
    )

    result = await search_package_docs(
        "bigreadme",
        "x",
        ecosystem="python",
        max_chars_per_page=5_000,
        max_total_chars=10_000,
    )

    assert result is not None
    assert len(result.pages[0].text) > 3_000
    assert "[truncated]" in result.pages[0].text


async def test_search_returns_none_for_missing_package(httpx_mock):
    httpx_mock.add_response(
        url="https://pypi.org/pypi/ghost/json", status_code=404
    )
    httpx_mock.add_response(
        url="https://registry.npmjs.org/ghost", status_code=404
    )
    httpx_mock.add_response(
        url="https://crates.io/api/v1/crates/ghost", status_code=404
    )

    result = await search_package_docs("ghost", "anything")
    assert result is None
