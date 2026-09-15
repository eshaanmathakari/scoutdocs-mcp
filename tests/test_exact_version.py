"""Exact-version behaviour: served exactly as asked, or refused — never substituted.

Covers the version argument (validation and plumbing), version-specific registry
documents, provenance binding, and cache separation between an exact version and
the latest stable release.
"""

import json

import pytest

from scoutdocs_mcp import server
from scoutdocs_mcp.cache import DocsCache
from scoutdocs_mcp.docs_fetcher import (
    fetch_docs_content_with_provenance,
    fetch_npm_readme,
    fetch_pypi_description,
    fetch_readme_from_github,
)
from scoutdocs_mcp.registries import fetch_package
from scoutdocs_mcp.versions import (
    InvalidExactVersion,
    registry_url,
    validate_version,
)


@pytest.fixture
def server_cache(tmp_path, monkeypatch):
    """Point the server's module-level cache at a tmp dir."""
    cache = DocsCache(cache_dir=tmp_path / "cache")
    monkeypatch.setattr(server, "cache", cache)
    return cache


# --- version validation ---------------------------------------------------


@pytest.mark.parametrize(
    "value",
    ["8.1.7", "1.0.0-rc.1", "2.31.0", "2024.1.1", "0.2.0b4", "1.0.0+build.7", "10.0.0"],
)
def test_exact_versions_are_accepted(value):
    assert validate_version(value) == value


@pytest.mark.parametrize(
    "value",
    [
        "",
        " latest",
        "latest",
        "stable",
        "next",
        "8.1.7 ",
        "8.1.7/../evil",
        "8.1.7?x=1",
        "8.1.7%2F",
        "8.1.7\nX",
        "no-digit",
        "a" * 65,
        None,
        81,
    ],
)
def test_non_exact_versions_are_refused(value):
    with pytest.raises(InvalidExactVersion):
        validate_version(value)


# --- registry URLs --------------------------------------------------------


def test_registry_url_latest_and_exact_per_ecosystem():
    assert registry_url("click", "python") == "https://pypi.org/pypi/click/json"
    assert registry_url("click", "python", "8.1.7") == "https://pypi.org/pypi/click/8.1.7/json"
    assert registry_url("express", "npm") == "https://registry.npmjs.org/express"
    assert registry_url("express", "javascript", "4.18.2") == (
        "https://registry.npmjs.org/express/4.18.2"
    )
    assert registry_url("serde", "cargo") == "https://crates.io/api/v1/crates/serde"
    assert registry_url("serde", "rust", "1.0.200") == (
        "https://crates.io/api/v1/crates/serde/1.0.200"
    )


def test_registry_url_keeps_scoped_npm_names():
    assert registry_url("@types/node", "npm") == "https://registry.npmjs.org/@types/node"


def test_registry_url_rejects_unknown_ecosystem():
    with pytest.raises(ValueError):
        registry_url("click", "cobol")


# --- version-specific documents -------------------------------------------


async def test_pypi_description_pinned_to_version(httpx_mock):
    httpx_mock.add_response(
        url="https://pypi.org/pypi/click/8.1.7/json",
        json={"info": {"description": "Click 8.1.7 docs"}},
    )
    assert await fetch_pypi_description("click", "8.1.7") == "Click 8.1.7 docs"


async def test_pypi_missing_version_is_a_miss_without_fallback(httpx_mock):
    httpx_mock.add_response(url="https://pypi.org/pypi/click/9.9.9/json", status_code=404)

    assert await fetch_pypi_description("click", "9.9.9") is None

    requests = httpx_mock.get_requests()
    assert len(requests) == 1
    assert "9.9.9" in str(requests[0].url)


async def test_npm_readme_pinned_to_version(httpx_mock):
    httpx_mock.add_response(
        url="https://registry.npmjs.org/left-pad/1.3.0",
        json={"readme": "# left-pad 1.3.0"},
    )
    assert await fetch_npm_readme("left-pad", "1.3.0") == "# left-pad 1.3.0"


async def test_github_readme_pinned_uses_ref(httpx_mock):
    httpx_mock.add_response(
        url="https://api.github.com/repos/psf/requests/readme?ref=2.31.0",
        text="# requests 2.31.0",
    )

    out = await fetch_readme_from_github("https://github.com/psf/requests", "2.31.0")

    assert out == "# requests 2.31.0"
    assert httpx_mock.get_request().url.params["ref"] == "2.31.0"


@pytest.mark.parametrize(
    "repo_url",
    [
        "https://gitlab.com/psf/requests",
        "https://github.com.evil.com/psf/requests",
        "https://github.com/psf/requests/extra",
        "https://user:pass@github.com/psf/requests",
        "https://github.com:8443/psf/requests",
        "https://github.com/psf/requests?x=1",
    ],
)
async def test_github_readme_url_validation(repo_url):
    assert await fetch_readme_from_github(repo_url, "2.31.0") is None


# --- provenance -----------------------------------------------------------


async def test_provenance_exact_registry_binding(httpx_mock):
    httpx_mock.add_response(
        url="https://pypi.org/pypi/click/8.1.7/json",
        json={"info": {"description": "docs"}},
    )

    doc = await fetch_docs_content_with_provenance("click", "python", version="8.1.7")

    assert doc is not None
    assert doc.binding == "exact_version"
    assert doc.source == "pypi_description"
    assert doc.source_url == "https://pypi.org/pypi/click/8.1.7/json"


async def test_provenance_exact_reads_github_at_the_ref_only(httpx_mock):
    httpx_mock.add_response(
        url="https://pypi.org/pypi/lib/1.0.0/json",
        json={"info": {"description": ""}},
    )
    httpx_mock.add_response(
        url="https://api.github.com/repos/o/r/readme?ref=1.0.0",
        text="# at 1.0.0",
    )

    doc = await fetch_docs_content_with_provenance(
        "lib", "python", repo_url="https://github.com/o/r", version="1.0.0"
    )

    assert doc is not None
    assert doc.binding == "exact_version_git_ref"
    assert doc.source_url.endswith("?ref=1.0.0")
    # No request was made for the default branch.
    assert all("ref=1.0.0" in str(r.url) or "/1.0.0/" in str(r.url) for r in httpx_mock.get_requests())


async def test_provenance_latest_binding(httpx_mock):
    httpx_mock.add_response(
        url="https://pypi.org/pypi/click/json",
        json={"info": {"description": "docs"}},
    )

    doc = await fetch_docs_content_with_provenance("click", "python")

    assert doc is not None
    assert doc.binding == "latest_stable"


# --- registry metadata pinned to a version --------------------------------


async def test_fetch_package_exact_version_pypi(httpx_mock):
    httpx_mock.add_response(
        url="https://pypi.org/pypi/click/8.1.7/json",
        json={"info": {"version": "8.1.7", "summary": "s", "license": "BSD-3-Clause"}},
    )

    info = await fetch_package("click", "python", "8.1.7")

    assert info is not None
    assert info.version == "8.1.7"
    assert info.latest_stable is None


async def test_fetch_package_unknown_exact_version_is_none(httpx_mock):
    httpx_mock.add_response(url="https://pypi.org/pypi/click/9.9.9/json", status_code=404)

    assert await fetch_package("click", "python", "9.9.9") is None


async def test_fetch_package_exact_crates_uses_version_document(httpx_mock):
    httpx_mock.add_response(
        url="https://crates.io/api/v1/crates/serde/1.0.200",
        json={
            "version": {
                "num": "1.0.200",
                "description": "d",
                "license": "MIT OR Apache-2.0",
                "repository": "https://github.com/serde-rs/serde",
                # Crate-level and unversioned: the versioned docs.rs URL wins.
                "documentation": "https://docs.rs/serde",
            }
        },
    )

    info = await fetch_package("serde", "rust", "1.0.200")

    assert info is not None
    assert info.version == "1.0.200"
    assert info.docs_url == "https://docs.rs/serde/1.0.200"


async def test_github_readme_retries_v_prefixed_tag(httpx_mock):
    """Tags are spelled both ways; both are refs of the same release."""
    httpx_mock.add_response(
        url="https://api.github.com/repos/psf/requests/readme?ref=2.31.0",
        status_code=404,
    )
    httpx_mock.add_response(
        url="https://api.github.com/repos/psf/requests/readme?ref=v2.31.0",
        text="# requests 2.31.0",
    )

    out = await fetch_readme_from_github("https://github.com/psf/requests", "2.31.0")

    assert out == "# requests 2.31.0"
    assert [str(r.url) for r in httpx_mock.get_requests()] == [
        "https://api.github.com/repos/psf/requests/readme?ref=2.31.0",
        "https://api.github.com/repos/psf/requests/readme?ref=v2.31.0",
    ]


async def test_provenance_records_the_ref_that_resolved(httpx_mock):
    httpx_mock.add_response(
        url="https://pypi.org/pypi/lib/1.0.0/json",
        json={"info": {"description": ""}},
    )
    httpx_mock.add_response(
        url="https://api.github.com/repos/o/r/readme?ref=1.0.0",
        status_code=404,
    )
    httpx_mock.add_response(
        url="https://api.github.com/repos/o/r/readme?ref=v1.0.0",
        text="# at v1.0.0",
    )

    doc = await fetch_docs_content_with_provenance(
        "lib", "python", repo_url="https://github.com/o/r", version="1.0.0"
    )

    assert doc is not None
    assert doc.binding == "exact_version_git_ref"
    assert doc.source_url.endswith("?ref=v1.0.0")


async def test_fetch_package_autodetect_finds_ecosystem_holding_that_version(httpx_mock):
    httpx_mock.add_response(url="https://pypi.org/pypi/nope/1.0.0/json", status_code=404)
    httpx_mock.add_response(
        url="https://registry.npmjs.org/nope/1.0.0",
        json={"version": "1.0.0", "description": "d"},
    )

    info = await fetch_package("nope", None, "1.0.0")

    assert info is not None
    assert info.ecosystem == "javascript"


async def test_npm_repository_suffix_keeps_name_characters(httpx_mock):
    """Drive-by: rstrip('.git') stripped real trailing characters of names."""
    httpx_mock.add_response(
        url="https://registry.npmjs.org/legit",
        json={
            "dist-tags": {"latest": "1.0.0"},
            "versions": {"1.0.0": {"license": "MIT"}},
            "description": "d",
            "repository": {"url": "git+https://github.com/o/legit.git"},
        },
    )

    info = await fetch_package("legit", "npm")

    assert info is not None
    assert info.repository == "https://github.com/o/legit"


# --- tool surface and handlers --------------------------------------------


async def test_tool_schemas_expose_exact_version():
    tools = {tool.name: tool for tool in await server.list_tools()}

    for name in ("get_package_info", "get_package_docs"):
        properties = dict(getattr(tools[name], "inputSchema"))["properties"]
        assert "version" in properties


async def test_get_info_exact_version_shape(httpx_mock, server_cache):
    httpx_mock.add_response(
        url="https://pypi.org/pypi/click/8.1.7/json",
        json={"info": {"version": "8.1.7", "summary": "s", "license": "BSD-3-Clause"}},
    )

    out = json.loads(
        (
            await server._handle_get_info(
                {"package": "click", "ecosystem": "python", "version": "8.1.7"}
            )
        )[0].text
    )

    assert out["version_source"] == "exact"
    assert out["requested_version"] == "8.1.7"
    assert out["resolved_version"] == "8.1.7"
    assert "latest_stable" not in out


async def test_get_info_rejects_non_exact_version_without_fetching(httpx_mock, server_cache):
    out = (await server._handle_get_info({"package": "click", "version": "latest"}))[0].text

    assert "not an exact version" in out
    assert httpx_mock.get_requests() == []


async def test_get_docs_exact_unknown_version_refuses_instead_of_substituting(
    httpx_mock, server_cache
):
    httpx_mock.add_response(url="https://pypi.org/pypi/click/9.9.9/json", status_code=404)

    out = (
        await server._handle_get_docs(
            {"package": "click", "ecosystem": "python", "version": "9.9.9"}
        )
    )[0].text

    assert "Version '9.9.9' not found" in out
    assert "No other version's documentation was substituted." in out


async def test_get_docs_exact_header_carries_version_and_source(httpx_mock, server_cache):
    payload = {
        "info": {
            "version": "8.1.7",
            "description": "Click 8.1.7 body",
            "summary": "s",
            "license": "BSD-3-Clause",
        }
    }
    # The metadata probe and the description fetch both read the same document.
    httpx_mock.add_response(url="https://pypi.org/pypi/click/8.1.7/json", json=payload)
    httpx_mock.add_response(url="https://pypi.org/pypi/click/8.1.7/json", json=payload)

    out = (
        await server._handle_get_docs(
            {"package": "click", "ecosystem": "python", "version": "8.1.7"}
        )
    )[0].text

    assert out.startswith("# click v8.1.7 (python)")
    assert "Version: exact (8.1.7)" in out
    assert "Source: pypi_description (https://pypi.org/pypi/click/8.1.7/json)" in out
    assert "Click 8.1.7 body" in out


async def test_exact_and_latest_are_cached_separately(httpx_mock, server_cache):
    httpx_mock.add_response(
        url="https://pypi.org/pypi/click/json",
        json={
            "info": {"version": "8.1.7", "summary": "s", "license": "x"},
            "releases": {"8.1.7": [{"filename": "click-8.1.7.tar.gz"}]},
        },
    )
    latest = json.loads(
        (await server._handle_get_info({"package": "click", "ecosystem": "python"}))[0].text
    )
    assert latest["version_source"] == "latest_stable"

    httpx_mock.add_response(
        url="https://pypi.org/pypi/click/8.1.0/json",
        json={"info": {"version": "8.1.0", "summary": "s", "license": "x"}},
    )
    exact = json.loads(
        (
            await server._handle_get_info(
                {"package": "click", "ecosystem": "python", "version": "8.1.0"}
            )
        )[0].text
    )
    assert exact["version_source"] == "exact"

    assert server_cache.get("info:python:click@latest")["latest_stable"] == "8.1.7"
    assert server_cache.get("info:python:click@8.1.0")["resolved_version"] == "8.1.0"


async def test_latest_is_not_served_from_an_exact_cache_entry(httpx_mock, server_cache):
    httpx_mock.add_response(
        url="https://pypi.org/pypi/click/8.1.7/json",
        json={"info": {"version": "8.1.7", "summary": "s", "license": "x"}},
    )
    await server._handle_get_info({"package": "click", "ecosystem": "python", "version": "8.1.7"})

    httpx_mock.add_response(
        url="https://pypi.org/pypi/click/json",
        json={
            "info": {"version": "8.1.7", "summary": "s", "license": "x"},
            "releases": {"8.1.7": [{"filename": "f"}]},
        },
    )
    out = json.loads(
        (await server._handle_get_info({"package": "click", "ecosystem": "python"}))[0].text
    )

    assert out["version_source"] == "latest_stable"


async def test_cached_exact_answer_keeps_its_binding(httpx_mock, server_cache):
    httpx_mock.add_response(
        url="https://pypi.org/pypi/click/8.1.7/json",
        json={"info": {"version": "8.1.7", "summary": "s", "license": "x"}},
    )

    first = json.loads(
        (
            await server._handle_get_info(
                {"package": "click", "ecosystem": "python", "version": "8.1.7"}
            )
        )[0].text
    )
    second = json.loads(
        (
            await server._handle_get_info(
                {"package": "click", "ecosystem": "python", "version": "8.1.7"}
            )
        )[0].text
    )

    assert first.get("_cached") is None
    assert second["_cached"] is True
    assert second["version_source"] == "exact"
    assert second["resolved_version"] == "8.1.7"
