"""Exact-version validation and registry URL builders.

An exact version is served exactly as requested or refused outright: it is
never silently replaced with the latest stable release, and the version string
is validated before it is interpolated into a registry URL.
"""

from __future__ import annotations

import re
from typing import Optional
from urllib.parse import quote

#: Canonical ecosystem name for every alias the tool surface accepts.
CANONICAL_ECOSYSTEMS = {
    "python": "python",
    "pypi": "python",
    "pip": "python",
    "javascript": "javascript",
    "typescript": "javascript",
    "npm": "javascript",
    "js": "javascript",
    "ts": "javascript",
    "rust": "rust",
    "cargo": "rust",
    "crate": "rust",
}

#: Letters, digits, dots, dashes, underscores and plus signs, starting with a
#: letter or digit, at most 64 characters (PEP 440 and semver both fit).
_VERSION_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._+-]{0,63}")

#: Registry tag aliases are not exact versions: they resolve to whatever the
#: registry currently points at, which is the substitution this server refuses
#: to make on the caller's behalf.
_TAG_ALIASES = frozenset(
    {"latest", "next", "stable", "beta", "alpha", "canary", "edge", "nightly", "head"}
)


class InvalidExactVersion(ValueError):
    """Raised when the caller asked for something that is not an exact version."""


def canonical_ecosystem(ecosystem: str) -> str:
    """Return the canonical ecosystem name for *ecosystem*."""
    canonical = CANONICAL_ECOSYSTEMS.get(ecosystem.lower())
    if canonical is None:
        raise ValueError("unsupported_ecosystem")
    return canonical


def validate_version(version: object) -> str:
    """Return *version* when it is a plausible exact version, otherwise raise."""
    if not isinstance(version, str):
        raise InvalidExactVersion("invalid_version")
    if version != version.strip():
        raise InvalidExactVersion("invalid_version")
    if _VERSION_PATTERN.fullmatch(version) is None:
        raise InvalidExactVersion("invalid_version")
    if not any(char.isdigit() for char in version):
        raise InvalidExactVersion("invalid_version")
    if version.lower() in _TAG_ALIASES:
        raise InvalidExactVersion("invalid_version")
    return version


def registry_url(package: str, ecosystem: str, version: Optional[str] = None) -> str:
    """Build a registry document URL, pinned to *version* when given.

    Without a version this is the latest-document endpoint the tools already
    used. With one it is the version-specific document, so an unknown version
    is a 404 instead of a quiet fall back to the latest release.
    """
    canonical = canonical_ecosystem(ecosystem)
    name = quote(package, safe="@/")
    suffix = f"/{quote(version, safe='')}" if version is not None else ""
    if canonical == "python":
        return f"https://pypi.org/pypi/{name}{suffix}/json"
    if canonical == "javascript":
        return f"https://registry.npmjs.org/{name}{suffix}"
    return f"https://crates.io/api/v1/crates/{name}{suffix}"
