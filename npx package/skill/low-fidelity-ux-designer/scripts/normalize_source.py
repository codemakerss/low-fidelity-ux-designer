#!/usr/bin/env python3
"""Normalize web and local-file sources into stable intake records."""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qsl, unquote, urlencode, urlsplit, urlunsplit

TRACKING_KEYS = {"fbclid", "gclid", "dclid", "msclkid", "mc_cid", "mc_eid"}


def normalize_url(raw: str) -> str:
    """Normalize an absolute HTTP(S) URL.

    This public function intentionally retains its original URL-only contract for
    callers that already use it directly.
    """

    parsed = urlsplit(raw.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("source URL must be an absolute http(s) URL")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("source URL must not contain credentials")

    hostname = (parsed.hostname or "").lower()
    if not hostname:
        raise ValueError("source URL must contain a hostname")
    if ":" in hostname:
        hostname = f"[{hostname}]"
    port = parsed.port
    if port and not ((parsed.scheme == "http" and port == 80) or (parsed.scheme == "https" and port == 443)):
        hostname = f"{hostname}:{port}"

    query = []
    for key, value in parse_qsl(parsed.query, keep_blank_values=True):
        lowered = key.lower()
        if lowered.startswith("utm_") or lowered in TRACKING_KEYS:
            continue
        query.append((key, value))
    query.sort()
    path = parsed.path or "/"
    if path != "/":
        path = path.rstrip("/") or "/"
    return urlunsplit((parsed.scheme.lower(), hostname, path, urlencode(query), ""))


def source_id(normalized: str) -> str:
    digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:12]
    return f"SRC-{digest}"


def fingerprint_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def local_path(raw: str, *, base_dir: Path | None = None) -> Path:
    """Resolve a local path or localhost-only file URI to an existing source."""

    value = raw.strip()
    parsed = urlsplit(value)
    if parsed.scheme == "file":
        if parsed.username or parsed.password or parsed.port:
            raise ValueError("file URI must not contain credentials or a port")
        if parsed.hostname and parsed.hostname.lower() != "localhost":
            raise ValueError("file URI host must be empty or localhost")
        if parsed.query or parsed.fragment:
            raise ValueError("file URI must not contain a query or fragment")
        candidate = Path(unquote(parsed.path))
    else:
        if parsed.scheme:
            raise ValueError("source must be http(s), a local path, or a localhost file URI")
        candidate = Path(value).expanduser()
        if not candidate.is_absolute():
            candidate = (base_dir or Path.cwd()) / candidate

    try:
        resolved = candidate.resolve(strict=True)
    except OSError as error:
        raise ValueError(f"local source does not exist: {candidate}") from error
    if not (resolved.is_file() or resolved.is_dir()):
        raise ValueError(f"local source must be a regular file or directory: {resolved}")
    return resolved


def normalize_source(
    raw: str,
    *,
    lane: str = "undetected",
    captured_at: str | None = None,
    base_dir: Path | None = None,
    canonical_url: str | None = None,
) -> dict:
    """Return the canonical source record used by board packages and registries."""

    value = raw.strip()
    parsed = urlsplit(value)
    timestamp = captured_at or datetime.now(timezone.utc).isoformat()
    if canonical_url is not None and parsed.scheme not in {"http", "https"}:
        raise ValueError("canonical URL can only override an HTTP(S) source")
    if parsed.scheme in {"http", "https"}:
        requested = normalize_url(value)
        normalized = normalize_url(canonical_url) if canonical_url is not None else requested
        return {
            "source_id": source_id(normalized),
            "source_url": raw,
            "normalized_url": normalized,
            "captured_at": timestamp,
            "source_type": "web-page",
            "inspection_lane": lane,
            "content_fingerprint": None,
        }

    path = local_path(value, base_dir=base_dir)
    normalized = path.as_uri()
    is_file = path.is_file()
    return {
        "source_id": source_id(normalized),
        "source_url": raw,
        "normalized_url": normalized,
        "captured_at": timestamp,
        "source_type": "local-file" if is_file else "local-directory",
        "inspection_lane": lane,
        "content_fingerprint": fingerprint_file(path) if is_file else None,
        "local_path": str(path),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", help="HTTP(S) URL, local file path, or localhost file URI")
    parser.add_argument(
        "--canonical-url",
        help="Browser-confirmed absolute HTTP(S) canonical URL used for normalized identity",
    )
    parser.add_argument("--lane", default="undetected")
    parser.add_argument("--captured-at")
    args = parser.parse_args()
    try:
        record = normalize_source(
            args.source,
            lane=args.lane,
            captured_at=args.captured_at,
            canonical_url=args.canonical_url,
        )
    except ValueError as error:
        parser.error(str(error))
    print(json.dumps(record, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
