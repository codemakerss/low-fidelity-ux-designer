#!/usr/bin/env python3
"""Authenticated loopback HTTP bridge for low-fidelity review packages.

The bridge stores every accepted package before optional dispatch. Host,
session, working directory, and executable are trusted startup configuration;
none can be supplied by a webpage request.
"""

from __future__ import annotations

import argparse
import hmac
import ipaddress
import json
import os
import socket
import tempfile
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Mapping, Sequence
from urllib.parse import urlsplit

from review_host_adapter import (
    AdapterConfigurationError,
    ReviewPackageError,
    SUPPORTED_HOSTS,
    build_adapter_command,
    canonical_package_bytes,
    execute_review_package,
    package_sha256,
    validate_review_package,
)


DEFAULT_MAX_BYTES = 2 * 1024 * 1024


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _validate_loopback(value: str) -> str:
    try:
        address = ipaddress.ip_address(value)
    except ValueError as error:
        raise AdapterConfigurationError(
            "bind must be a numeric loopback address such as 127.0.0.1 or ::1"
        ) from error
    if not address.is_loopback:
        raise AdapterConfigurationError("bridge may bind only to a loopback address")
    return str(address)


def _origin_allowed(origin: str | None) -> bool:
    if origin is None:
        return True
    if origin == "null":
        return True
    try:
        parsed = urlsplit(origin)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            return False
        # Accessing .port rejects malformed or non-numeric port syntax.
        _ = parsed.port
        if parsed.username or parsed.password or parsed.path not in {"", "/"}:
            return False
        if parsed.query or parsed.fragment:
            return False
        if parsed.hostname.lower() == "localhost":
            return True
        return ipaddress.ip_address(parsed.hostname).is_loopback
    except (ValueError, TypeError):
        return False


def _atomic_json(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        dir=path.parent,
        prefix=f".{path.name}.",
        suffix=".tmp",
        delete=False,
    )
    temp_path = Path(handle.name)
    try:
        with handle:
            json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
    finally:
        if temp_path.exists():
            temp_path.unlink()


@dataclass(frozen=True)
class DispatchConfig:
    host: str
    session_id: str
    cwd: Path
    cli: str
    claude_prompt_stdin: bool = False
    timeout: float = 120.0


@dataclass(frozen=True)
class BridgeConfig:
    root: Path
    token: str
    host: str
    bind: str = "127.0.0.1"
    port: int = 8768
    max_bytes: int = DEFAULT_MAX_BYTES
    dispatch: DispatchConfig | None = None

    def validated(self) -> "BridgeConfig":
        root = self.root.expanduser().resolve()
        if not self.token or "\x00" in self.token or len(self.token) < 16:
            raise AdapterConfigurationError("token must contain at least 16 characters and no NUL")
        if self.host not in SUPPORTED_HOSTS:
            raise AdapterConfigurationError(f"unsupported host: {self.host}")
        bind = _validate_loopback(self.bind)
        if not 0 <= self.port <= 65535:
            raise AdapterConfigurationError("port must be between 0 and 65535")
        if self.max_bytes <= 0:
            raise AdapterConfigurationError("max_bytes must be greater than zero")
        if self.dispatch:
            if self.dispatch.host != self.host:
                raise AdapterConfigurationError("dispatch host must match bridge host")
            cwd = self.dispatch.cwd.expanduser().resolve()
            if not cwd.is_dir():
                raise AdapterConfigurationError(f"dispatch cwd is not a directory: {cwd}")
            if not self.dispatch.cli or "\x00" in self.dispatch.cli:
                raise AdapterConfigurationError("dispatch cli must be explicitly configured")
            if self.dispatch.timeout <= 0:
                raise AdapterConfigurationError("dispatch timeout must be greater than zero")
            # Validate all command metadata at startup. The placeholder is not
            # executed and no package has to arrive before a bad session/CLI
            # configuration is reported.
            build_adapter_command(
                self.dispatch.host,
                self.dispatch.session_id,
                "configuration-check",
                cli=self.dispatch.cli,
                claude_prompt_stdin=self.dispatch.claude_prompt_stdin,
            )
            dispatch = DispatchConfig(
                host=self.dispatch.host,
                session_id=self.dispatch.session_id,
                cwd=cwd,
                cli=self.dispatch.cli,
                claude_prompt_stdin=self.dispatch.claude_prompt_stdin,
                timeout=self.dispatch.timeout,
            )
        else:
            dispatch = None
        return BridgeConfig(
            root=root,
            token=self.token,
            host=self.host,
            bind=bind,
            port=self.port,
            max_bytes=self.max_bytes,
            dispatch=dispatch,
        )


class ReviewBridgeService:
    def __init__(self, config: BridgeConfig):
        self.config = config.validated()
        self.inbox = self.config.root / "inbox"
        self.receipts = self.config.root / "receipts"
        self.inbox.mkdir(parents=True, exist_ok=True)
        self.receipts.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def health(self) -> dict[str, Any]:
        return {
            "status": "ok",
            "host": self.config.host,
            "dispatch": self.config.dispatch is not None,
        }

    def _response_from_receipt(
        self, receipt: Mapping[str, Any], *, idempotent: bool
    ) -> dict[str, Any]:
        state = receipt["status"]
        if state == "dispatched":
            public_status = "submitted"
            message = "Review package delivered to the configured host."
        elif state == "dispatch_failed":
            public_status = "failed"
            message = "Package was preserved, but host dispatch failed."
        else:
            public_status = "stored"
            message = "Review package stored in the bridge inbox."
        if idempotent:
            message = f"Already received; no duplicate dispatch. {message}"
        return {
            "status": public_status,
            "submission_id": receipt["submission_id"],
            "host": receipt["host"],
            "message": message,
            "idempotent": idempotent,
            "receipt_status": state,
        }

    def submit(self, package: Any) -> tuple[int, dict[str, Any]]:
        validated = validate_review_package(package)
        submission_id = validated["submission_id"]
        digest = package_sha256(validated)
        inbox_path = self.inbox / f"{submission_id}.json"
        receipt_path = self.receipts / f"{submission_id}.json"

        # The lock covers storage and optional dispatch so concurrent retries
        # cannot deliver the same submission twice.
        with self._lock:
            if inbox_path.exists():
                try:
                    existing = json.loads(inbox_path.read_text(encoding="utf-8"))
                    existing_digest = package_sha256(existing)
                except (OSError, json.JSONDecodeError, ReviewPackageError) as error:
                    return 500, {
                        "status": "failed",
                        "submission_id": submission_id,
                        "host": self.config.host,
                        "message": f"Stored package is unreadable: {error}",
                    }
                if not hmac.compare_digest(existing_digest, digest):
                    return 409, {
                        "status": "conflict",
                        "submission_id": submission_id,
                        "host": self.config.host,
                        "message": "submission_id already belongs to a different package.",
                    }
                if receipt_path.exists():
                    try:
                        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
                    except (OSError, json.JSONDecodeError) as error:
                        return 500, {
                            "status": "failed",
                            "submission_id": submission_id,
                            "host": self.config.host,
                            "message": f"Stored receipt is unreadable: {error}",
                        }
                else:
                    receipt = {
                        "schema_version": "1.0",
                        "submission_id": submission_id,
                        "host": self.config.host,
                        "package_sha256": digest,
                        "status": "stored",
                        "received_at": _utc_now(),
                        "updated_at": _utc_now(),
                    }
                    _atomic_json(receipt_path, receipt)
                return 200, self._response_from_receipt(receipt, idempotent=True)

            # Write the package before any process is started. A failed process
            # therefore cannot destroy the user's only copy.
            _atomic_json(inbox_path, validated)
            receipt: dict[str, Any] = {
                "schema_version": "1.0",
                "submission_id": submission_id,
                "host": self.config.host,
                "package_sha256": digest,
                "status": "stored",
                "received_at": _utc_now(),
                "updated_at": _utc_now(),
            }
            _atomic_json(receipt_path, receipt)

            if self.config.dispatch:
                dispatch = self.config.dispatch
                result = execute_review_package(
                    validated,
                    host=dispatch.host,
                    session_id=dispatch.session_id,
                    cli=dispatch.cli,
                    cwd=dispatch.cwd,
                    claude_prompt_stdin=dispatch.claude_prompt_stdin,
                    timeout=dispatch.timeout,
                )
                receipt["status"] = (
                    "dispatched" if result["status"] == "submitted" else "dispatch_failed"
                )
                receipt["dispatch"] = result
                receipt["updated_at"] = _utc_now()
                _atomic_json(receipt_path, receipt)

            return 201, self._response_from_receipt(receipt, idempotent=False)


class ReviewBridgeHTTPServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], handler: type[BaseHTTPRequestHandler], service: ReviewBridgeService):
        self.service = service
        super().__init__(address, handler)


class ReviewBridgeHandler(BaseHTTPRequestHandler):
    server: ReviewBridgeHTTPServer

    def log_message(self, format: str, *args: Any) -> None:
        # Keep CLI output machine-readable; deployments can wrap the process if
        # access logging is desired.
        return

    def _cors_origin(self) -> str | None:
        origin = self.headers.get("Origin")
        return origin if origin is not None and _origin_allowed(origin) else None

    def _send(
        self,
        status: int,
        body: Mapping[str, Any] | None = None,
        *,
        extra_headers: Mapping[str, str] | None = None,
    ) -> None:
        payload = (
            json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            if body is not None
            else b""
        )
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        origin = self._cors_origin()
        if origin is not None:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        if extra_headers:
            for key, value in extra_headers.items():
                self.send_header(key, value)
        self.end_headers()
        if payload:
            self.wfile.write(payload)

    def _origin_ok(self) -> bool:
        origin = self.headers.get("Origin")
        if _origin_allowed(origin):
            return True
        self._send(
            403,
            {
                "status": "forbidden",
                "host": self.server.service.config.host,
                "message": "Origin is not null or loopback.",
            },
        )
        return False

    def _authorized(self) -> bool:
        supplied = self.headers.get("Authorization", "")
        expected = f"Bearer {self.server.service.config.token}"
        if hmac.compare_digest(supplied, expected):
            return True
        self._send(
            401,
            {
                "status": "unauthorized",
                "host": self.server.service.config.host,
                "message": "A valid bearer token is required.",
            },
            extra_headers={"WWW-Authenticate": "Bearer"},
        )
        return False

    def do_OPTIONS(self) -> None:
        if not self._origin_ok():
            return
        if urlsplit(self.path).path not in {"/v1/health", "/v1/reviews"}:
            self._send(404, {"status": "not-found", "message": "Unknown endpoint."})
            return
        headers = {
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Authorization, Content-Type",
            "Access-Control-Max-Age": "600",
        }
        # Chromium may issue a Private Network Access preflight before a
        # file:// or loopback board contacts the bridge. It is safe to opt in
        # only after the origin has passed the null/loopback restriction.
        if self.headers.get("Access-Control-Request-Private-Network", "").lower() == "true":
            headers["Access-Control-Allow-Private-Network"] = "true"
        self._send(204, extra_headers=headers)

    def do_GET(self) -> None:
        if not self._origin_ok() or not self._authorized():
            return
        if urlsplit(self.path).path != "/v1/health":
            self._send(404, {"status": "not-found", "message": "Unknown endpoint."})
            return
        self._send(200, self.server.service.health())

    def do_POST(self) -> None:
        if not self._origin_ok() or not self._authorized():
            return
        if urlsplit(self.path).path != "/v1/reviews":
            self._send(404, {"status": "not-found", "message": "Unknown endpoint."})
            return
        content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        if content_type != "application/json":
            self._send(
                415,
                {
                    "status": "invalid",
                    "host": self.server.service.config.host,
                    "message": "Content-Type must be application/json.",
                },
            )
            return
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            self._send(411, {"status": "invalid", "message": "Content-Length is required."})
            return
        try:
            length = int(raw_length)
        except ValueError:
            self._send(400, {"status": "invalid", "message": "Invalid Content-Length."})
            return
        if length < 0 or length > self.server.service.config.max_bytes:
            self._send(
                413,
                {
                    "status": "too-large",
                    "host": self.server.service.config.host,
                    "message": "Review package exceeds the configured size limit.",
                },
            )
            return
        raw = self.rfile.read(length)
        try:
            package = json.loads(raw.decode("utf-8"))
            status, response = self.server.service.submit(package)
        except (UnicodeDecodeError, json.JSONDecodeError, ReviewPackageError) as error:
            self._send(
                400,
                {
                    "status": "invalid",
                    "host": self.server.service.config.host,
                    "message": str(error),
                },
            )
            return
        except OSError as error:
            self._send(
                500,
                {
                    "status": "failed",
                    "host": self.server.service.config.host,
                    "message": f"Could not preserve review package: {error}",
                },
            )
            return
        self._send(status, response)


def create_server(config: BridgeConfig) -> ReviewBridgeHTTPServer:
    service = ReviewBridgeService(config)
    if ipaddress.ip_address(service.config.bind).version == 6:
        class IPv6ReviewBridgeHTTPServer(ReviewBridgeHTTPServer):
            address_family = socket.AF_INET6

        server_class = IPv6ReviewBridgeHTTPServer
    else:
        server_class = ReviewBridgeHTTPServer
    return server_class(
        (service.config.bind, service.config.port),
        ReviewBridgeHandler,
        service,
    )


def _read_token(args: argparse.Namespace) -> str:
    if args.token:
        return args.token
    if args.token_file:
        return Path(args.token_file).expanduser().read_text(encoding="utf-8").strip()
    token = os.environ.get("REVIEW_BRIDGE_TOKEN", "")
    if not token:
        raise AdapterConfigurationError(
            "provide --token, --token-file, or REVIEW_BRIDGE_TOKEN"
        )
    return token


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path, help="Explicit bridge storage root")
    parser.add_argument("--host", required=True, choices=SUPPORTED_HOSTS)
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8768)
    parser.add_argument("--max-bytes", type=int, default=DEFAULT_MAX_BYTES)
    token = parser.add_mutually_exclusive_group()
    token.add_argument("--token")
    token.add_argument("--token-file")
    parser.add_argument("--dispatch", action="store_true", help="Explicitly enable host dispatch")
    parser.add_argument("--session-id")
    parser.add_argument("--cwd", type=Path)
    parser.add_argument("--cli")
    parser.add_argument("--claude-prompt-stdin", action="store_true")
    parser.add_argument("--timeout", type=float, default=120.0)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        token = _read_token(args)
        if args.dispatch:
            missing = [
                name
                for name, value in (
                    ("--session-id", args.session_id),
                    ("--cwd", args.cwd),
                    ("--cli", args.cli),
                )
                if value is None
            ]
            if missing:
                raise AdapterConfigurationError(
                    f"--dispatch requires explicit {', '.join(missing)}"
                )
            dispatch = DispatchConfig(
                host=args.host,
                session_id=args.session_id,
                cwd=args.cwd,
                cli=args.cli,
                claude_prompt_stdin=args.claude_prompt_stdin,
                timeout=args.timeout,
            )
        else:
            dispatch = None
        server = create_server(
            BridgeConfig(
                root=args.root,
                token=token,
                host=args.host,
                bind=args.bind,
                port=args.port,
                max_bytes=args.max_bytes,
                dispatch=dispatch,
            )
        )
        address = server.server_address
        print(
            json.dumps(
                {
                    "status": "listening",
                    "url": (
                        f"http://[{address[0]}]:{address[1]}"
                        if ":" in address[0]
                        else f"http://{address[0]}:{address[1]}"
                    ),
                    "host": args.host,
                    "dispatch": dispatch is not None,
                    "root": str(args.root.expanduser().resolve()),
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
        server.serve_forever()
    except KeyboardInterrupt:
        return 0
    except (OSError, AdapterConfigurationError) as error:
        print(json.dumps({"status": "error", "message": str(error)}, ensure_ascii=False))
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
