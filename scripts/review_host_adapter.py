#!/usr/bin/env python3
"""Validate and deliver a review package to a supported local AI CLI.

The module is intentionally standard-library-only. Commands are always executed
as an argument vector with ``shell=False``. Merely invoking the CLI performs a
dry run; delivery requires the explicit ``--execute`` flag.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence


SUPPORTED_HOSTS = ("codex", "claude-code", "opencode")
DEFAULT_CLIS = {
    "codex": "codex",
    "claude-code": "claude",
    "opencode": "opencode",
}
_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:\-]{0,127}$")
_MAX_CAPTURE_CHARS = 64 * 1024
COMMENT_CATEGORIES = {"problem", "suggestion", "question", "approval"}
COMMENT_PRIORITIES = {"blocking", "important", "later"}
COMMENT_STATUSES = {
    "open",
    "accepted",
    "needs-clarification",
    "rejected",
    "deferred",
    "resolved",
}


class ReviewPackageError(ValueError):
    """Raised when a ReviewPackage does not satisfy the public contract."""


class AdapterConfigurationError(ValueError):
    """Raised when trusted adapter configuration is invalid."""


def _required_text(value: Any, field: str, *, identifier: bool = False) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ReviewPackageError(f"{field} must be a non-empty string")
    value = value.strip()
    if "\x00" in value:
        raise ReviewPackageError(f"{field} must not contain NUL")
    if identifier and not _IDENTIFIER.fullmatch(value):
        raise ReviewPackageError(
            f"{field} must match {_IDENTIFIER.pattern} and be at most 128 characters"
        )
    return value


def validate_review_package(package: Any) -> dict[str, Any]:
    """Return a JSON-safe copy of a valid framework-neutral ReviewPackage."""

    if not isinstance(package, Mapping):
        raise ReviewPackageError("review package must be a JSON object")

    required = {
        "submission_id",
        "board_id",
        "design_version",
        "source_ids",
        "comments",
        "processing_policy",
    }
    missing = sorted(required - set(package))
    if missing:
        raise ReviewPackageError(f"missing required fields: {', '.join(missing)}")

    submission_id = _required_text(package["submission_id"], "submission_id", identifier=True)
    board_id = _required_text(package["board_id"], "board_id", identifier=True)
    design_version = _required_text(package["design_version"], "design_version", identifier=True)

    schema_version = package.get("schema_version")
    if schema_version is not None and schema_version != "1.0":
        raise ReviewPackageError("schema_version must be '1.0' when present")

    source_ids = package["source_ids"]
    if not isinstance(source_ids, list):
        raise ReviewPackageError("source_ids must be an array")
    validated_source_ids = [
        _required_text(value, f"source_ids[{index}]", identifier=True)
        for index, value in enumerate(source_ids)
    ]
    if len(validated_source_ids) != len(set(validated_source_ids)):
        raise ReviewPackageError("source_ids must not contain duplicates")

    comments = package["comments"]
    if not isinstance(comments, list):
        raise ReviewPackageError("comments must be an array")
    comment_ids: set[str] = set()
    for index, comment in enumerate(comments):
        prefix = f"comments[{index}]"
        if not isinstance(comment, Mapping):
            raise ReviewPackageError(f"{prefix} must be an object")
        for key in (
            "comment_id",
            "screen_id",
            "screen_version",
            "anchor",
            "category",
            "priority",
            "content",
            "status",
        ):
            if key not in comment:
                raise ReviewPackageError(f"{prefix}.{key} is required")
        comment_id = _required_text(comment["comment_id"], f"{prefix}.comment_id", identifier=True)
        _required_text(comment["screen_id"], f"{prefix}.screen_id", identifier=True)
        _required_text(comment["screen_version"], f"{prefix}.screen_version", identifier=True)
        anchor = comment["anchor"]
        if not isinstance(anchor, Mapping):
            raise ReviewPackageError(f"{prefix}.anchor must be an object")
        for coordinate in ("x_ratio", "y_ratio"):
            value = anchor.get(coordinate)
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ReviewPackageError(f"{prefix}.anchor.{coordinate} must be a number")
            if not 0 <= value <= 1:
                raise ReviewPackageError(
                    f"{prefix}.anchor.{coordinate} must be between 0 and 1"
                )
        category = _required_text(comment["category"], f"{prefix}.category", identifier=True)
        if category not in COMMENT_CATEGORIES:
            raise ReviewPackageError(
                f"{prefix}.category must be one of {', '.join(sorted(COMMENT_CATEGORIES))}"
            )
        priority = _required_text(comment["priority"], f"{prefix}.priority", identifier=True)
        if priority not in COMMENT_PRIORITIES:
            raise ReviewPackageError(
                f"{prefix}.priority must be one of {', '.join(sorted(COMMENT_PRIORITIES))}"
            )
        _required_text(comment["content"], f"{prefix}.content")
        status = _required_text(comment["status"], f"{prefix}.status", identifier=True)
        if status not in COMMENT_STATUSES:
            raise ReviewPackageError(
                f"{prefix}.status must be one of {', '.join(sorted(COMMENT_STATUSES))}"
            )
        component_id = comment.get("component_id")
        if component_id is not None:
            _required_text(component_id, f"{prefix}.component_id", identifier=True)
        resolution = comment.get("resolution")
        if resolution is not None and not isinstance(resolution, str):
            raise ReviewPackageError(f"{prefix}.resolution must be a string or null")
        if comment_id in comment_ids:
            raise ReviewPackageError(f"duplicate comment_id: {comment_id}")
        comment_ids.add(comment_id)

    policy = package["processing_policy"]
    if not isinstance(policy, Mapping):
        raise ReviewPackageError("processing_policy must be an object")
    for key in ("low_risk", "high_impact", "preserve_old_versions"):
        if key not in policy:
            raise ReviewPackageError(f"processing_policy.{key} is required")
    _required_text(policy["low_risk"], "processing_policy.low_risk", identifier=True)
    _required_text(policy["high_impact"], "processing_policy.high_impact", identifier=True)
    if not isinstance(policy["preserve_old_versions"], bool):
        raise ReviewPackageError("processing_policy.preserve_old_versions must be a boolean")

    manifest = package.get("manifest")
    if manifest is not None:
        if not isinstance(manifest, Mapping):
            raise ReviewPackageError("manifest must be an object when present")
        manifest_board = manifest.get("board_id")
        if manifest_board is not None and manifest_board != board_id:
            raise ReviewPackageError("manifest.board_id must match board_id")
        manifest_version = manifest.get("design_version")
        if manifest_version is not None and manifest_version != design_version:
            raise ReviewPackageError("manifest.design_version must match design_version")

    # This also rejects unserializable values and NaN/Infinity.
    try:
        serialized = json.dumps(package, ensure_ascii=False, allow_nan=False)
        validated = json.loads(serialized)
    except (TypeError, ValueError) as error:
        raise ReviewPackageError(f"review package is not strict JSON: {error}") from error

    # Retain these assignments as explicit guarantees even for unusual Mapping
    # implementations.
    validated["submission_id"] = submission_id
    validated["board_id"] = board_id
    validated["design_version"] = design_version
    validated["source_ids"] = validated_source_ids
    return validated


def canonical_package_bytes(package: Any) -> bytes:
    validated = validate_review_package(package)
    return json.dumps(
        validated,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def package_sha256(package: Any) -> str:
    return hashlib.sha256(canonical_package_bytes(package)).hexdigest()


def build_review_prompt(package: Any) -> str:
    validated = validate_review_package(package)
    payload = json.dumps(validated, ensure_ascii=False, indent=2, sort_keys=True)
    return (
        "请处理以下低保真评审 ReviewPackage。逐条检查批注影响；低风险修改可以直接生成"
        "新版本，高影响、冲突或范围变化必须先确认。不得覆盖已评审的旧版本。完成后记录"
        "每条批注的处理结果，并验证受影响流程。\n\n"
        f"{payload}"
    )


def _trusted_text(value: str, field: str) -> str:
    if not isinstance(value, str) or not value or "\x00" in value:
        raise AdapterConfigurationError(f"{field} must be a non-empty string without NUL")
    return value


def _session_id(value: str) -> str:
    value = _trusted_text(value, "session_id")
    if not _IDENTIFIER.fullmatch(value):
        raise AdapterConfigurationError("session_id contains unsupported characters")
    return value


@dataclass(frozen=True)
class AdapterCommand:
    host: str
    argv: tuple[str, ...]
    stdin_text: str | None
    prompt_transport: str

    def inspection(self) -> dict[str, Any]:
        """Return a safe command description without duplicating comment text."""

        display_argv = list(self.argv)
        if self.prompt_transport == "argument":
            display_argv[-1] = "<REVIEW_PROMPT>"
        prompt = self.stdin_text if self.stdin_text is not None else self.argv[-1]
        return {
            "host": self.host,
            "argv": display_argv,
            "prompt_transport": self.prompt_transport,
            "prompt_bytes": len(prompt.encode("utf-8")),
            "prompt_sha256": hashlib.sha256(prompt.encode("utf-8")).hexdigest(),
            "shell": False,
        }


def build_adapter_command(
    host: str,
    session_id: str,
    prompt: str,
    *,
    cli: str | None = None,
    claude_prompt_stdin: bool = False,
) -> AdapterCommand:
    """Build the documented resume command for one supported host."""

    if host not in SUPPORTED_HOSTS:
        raise AdapterConfigurationError(f"unsupported host: {host}")
    session_id = _session_id(session_id)
    prompt = _trusted_text(prompt, "prompt")
    executable = _trusted_text(cli or DEFAULT_CLIS[host], "cli")

    if host == "codex":
        return AdapterCommand(
            host=host,
            argv=(executable, "exec", "resume", session_id, "-"),
            stdin_text=prompt,
            prompt_transport="stdin",
        )
    if host == "claude-code":
        if claude_prompt_stdin:
            return AdapterCommand(
                host=host,
                argv=(executable, "-p", "--resume", session_id),
                stdin_text=prompt,
                prompt_transport="stdin",
            )
        return AdapterCommand(
            host=host,
            argv=(executable, "-p", "--resume", session_id, prompt),
            stdin_text=None,
            prompt_transport="argument",
        )
    return AdapterCommand(
        host=host,
        argv=(executable, "run", "--session", session_id, prompt),
        stdin_text=None,
        prompt_transport="argument",
    )


def _validated_cwd(cwd: str | Path | None) -> str | None:
    if cwd is None:
        return None
    path = Path(cwd).expanduser().resolve()
    if not path.is_dir():
        raise AdapterConfigurationError(f"cwd is not an existing directory: {path}")
    return str(path)


def execute_review_package(
    package: Any,
    *,
    host: str,
    session_id: str,
    cli: str | None = None,
    cwd: str | Path | None = None,
    claude_prompt_stdin: bool = False,
    timeout: float = 120.0,
) -> dict[str, Any]:
    """Execute a trusted adapter configuration and return a structured result."""

    if timeout <= 0:
        raise AdapterConfigurationError("timeout must be greater than zero")
    validated = validate_review_package(package)
    command = build_adapter_command(
        host,
        session_id,
        build_review_prompt(validated),
        cli=cli,
        claude_prompt_stdin=claude_prompt_stdin,
    )
    validated_cwd = _validated_cwd(cwd)
    try:
        completed = subprocess.run(
            list(command.argv),
            input=command.stdin_text,
            cwd=validated_cwd,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
            shell=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        return {
            "status": "failed",
            "submission_id": validated["submission_id"],
            "host": host,
            "message": str(error),
            "command": command.inspection(),
            "cwd": validated_cwd,
            "returncode": None,
            "stdout": "",
            "stderr": "",
        }

    return {
        "status": "submitted" if completed.returncode == 0 else "failed",
        "submission_id": validated["submission_id"],
        "host": host,
        "message": (
            "Review package delivered to host."
            if completed.returncode == 0
            else f"Host CLI exited with code {completed.returncode}."
        ),
        "command": command.inspection(),
        "cwd": validated_cwd,
        "returncode": completed.returncode,
        "stdout": completed.stdout[-_MAX_CAPTURE_CHARS:],
        "stderr": completed.stderr[-_MAX_CAPTURE_CHARS:],
    }


def load_review_package(path: str) -> dict[str, Any]:
    if path == "-":
        raw = sys.stdin.read()
    else:
        raw = Path(path).expanduser().read_text(encoding="utf-8")
    try:
        return validate_review_package(json.loads(raw))
    except json.JSONDecodeError as error:
        raise ReviewPackageError(f"invalid JSON: {error}") from error


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", required=True, help="ReviewPackage JSON path, or - for stdin")
    parser.add_argument("--host", required=True, choices=SUPPORTED_HOSTS)
    parser.add_argument("--session-id", required=True)
    parser.add_argument("--cli", help="Trusted CLI executable name or path")
    parser.add_argument("--cwd", help="Trusted existing working directory")
    parser.add_argument(
        "--claude-prompt-stdin",
        action="store_true",
        help="Send Claude's prompt over stdin instead of as its final argument",
    )
    parser.add_argument("--timeout", type=float, default=120.0)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="Inspect only (the default)")
    mode.add_argument("--execute", action="store_true", help="Explicitly execute the host CLI")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        package = load_review_package(args.package)
        prompt = build_review_prompt(package)
        command = build_adapter_command(
            args.host,
            args.session_id,
            prompt,
            cli=args.cli,
            claude_prompt_stdin=args.claude_prompt_stdin,
        )
        configured_cwd = _validated_cwd(args.cwd)
        if not args.execute:
            result = {
                "status": "dry-run",
                "submission_id": package["submission_id"],
                "host": args.host,
                "message": "Command inspected only. Pass --execute to deliver.",
                "package_sha256": package_sha256(package),
                "command": command.inspection(),
                "cwd": configured_cwd,
            }
        else:
            result = execute_review_package(
                package,
                host=args.host,
                session_id=args.session_id,
                cli=args.cli,
                cwd=configured_cwd,
                claude_prompt_stdin=args.claude_prompt_stdin,
                timeout=args.timeout,
            )
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result["status"] in {"dry-run", "submitted"} else 1
    except (OSError, ReviewPackageError, AdapterConfigurationError) as error:
        print(json.dumps({"status": "error", "message": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
