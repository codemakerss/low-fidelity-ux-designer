#!/usr/bin/env python3
"""Read and safely update a user-selected Board Registry."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from normalize_source import normalize_source


def registry_path(root: Path) -> Path:
    return root / "board-registry.json"


def read_registry(root: Path) -> dict:
    path = registry_path(root)
    if not path.exists():
        return {"schema_version": "1.0", "boards": []}
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or not isinstance(data.get("boards"), list):
        raise ValueError(f"invalid registry: {path}")
    return data


def write_registry(root: Path, data: dict) -> None:
    """Atomically replace the registry while retaining one last-known-good backup."""

    path = registry_path(root)
    root.mkdir(parents=True, exist_ok=True)
    if path.exists():
        shutil.copyfile(path, path.with_suffix(".json.bak"))
    fd, temporary_name = tempfile.mkstemp(prefix=".board-registry-", suffix=".json.tmp", dir=root)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(data, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_name, path)
    except Exception:
        try:
            Path(temporary_name).unlink()
        except FileNotFoundError:
            pass
        raise


def validate_new_board(data: dict, *, board_id: str, source_record: dict, design_goal: str) -> None:
    normalized = source_record["normalized_url"]
    for board in data["boards"]:
        if board.get("normalized_url") == normalized and board.get("design_goal") == design_goal:
            raise ValueError("matching board already exists; choose reuse/version or a different board-id")
        if board.get("board_id") == board_id:
            raise ValueError("board_id already exists")


def make_board_record(
    *,
    board_id: str,
    source_record: dict,
    design_goal: str,
    storage_path: str,
    related_board_ids: list[str] | None = None,
    latest_version: str = "v1",
    created_at: str | None = None,
) -> dict:
    return {
        "board_id": board_id,
        "source_id": source_record["source_id"],
        "source_url": source_record["source_url"],
        "normalized_url": source_record["normalized_url"],
        "source_type": source_record.get("source_type", "web-page"),
        "content_fingerprint": source_record.get("content_fingerprint"),
        "design_goal": design_goal,
        "storage_path": storage_path,
        "latest_version": latest_version,
        "related_board_ids": list(related_board_ids or []),
        "created_at": created_at or datetime.now(timezone.utc).isoformat(),
    }


def add_board(
    root: Path,
    *,
    board_id: str,
    source_record: dict,
    design_goal: str,
    storage_path: str,
    related_board_ids: list[str] | None = None,
    latest_version: str = "v1",
) -> dict:
    data = read_registry(root)
    validate_new_board(data, board_id=board_id, source_record=source_record, design_goal=design_goal)
    record = make_board_record(
        board_id=board_id,
        source_record=source_record,
        design_goal=design_goal,
        storage_path=storage_path,
        related_board_ids=related_board_ids,
        latest_version=latest_version,
    )
    data["boards"].append(record)
    write_registry(root, data)
    return record


def update_latest_version(root: Path, *, board_id: str, latest_version: str) -> dict:
    data = read_registry(root)
    matches = [board for board in data["boards"] if board.get("board_id") == board_id]
    if not matches:
        raise ValueError(f"board_id not found in registry: {board_id}")
    if len(matches) != 1:
        raise ValueError(f"duplicate board_id in registry: {board_id}")
    matches[0]["latest_version"] = latest_version
    matches[0]["updated_at"] = datetime.now(timezone.utc).isoformat()
    write_registry(root, data)
    return matches[0]


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    show = sub.add_parser("show")
    show.add_argument("--root", type=Path, required=True)
    add = sub.add_parser("add")
    add.add_argument("--root", type=Path, required=True)
    add.add_argument("--board-id", required=True)
    source_group = add.add_mutually_exclusive_group(required=True)
    source_group.add_argument("--source")
    source_group.add_argument("--url", help="Backward-compatible alias for --source")
    add.add_argument(
        "--canonical-url",
        help="Browser-confirmed absolute HTTP(S) canonical URL used for normalized identity",
    )
    add.add_argument("--lane", default="undetected")
    add.add_argument("--design-goal", required=True)
    add.add_argument("--storage-path", required=True)
    add.add_argument("--related-board-id", action="append", default=[])
    update = sub.add_parser("set-version")
    update.add_argument("--root", type=Path, required=True)
    update.add_argument("--board-id", required=True)
    update.add_argument("--version", required=True)
    args = parser.parse_args()

    try:
        if args.command == "show":
            print(json.dumps(read_registry(args.root), ensure_ascii=False, indent=2))
            return
        if args.command == "set-version":
            record = update_latest_version(args.root, board_id=args.board_id, latest_version=args.version)
            print(json.dumps(record, ensure_ascii=False, indent=2))
            return

        record = normalize_source(
            args.source or args.url,
            lane=args.lane,
            canonical_url=args.canonical_url,
        )
        added = add_board(
            args.root,
            board_id=args.board_id,
            source_record=record,
            design_goal=args.design_goal,
            storage_path=args.storage_path,
            related_board_ids=args.related_board_id,
        )
        print(json.dumps(added, ensure_ascii=False, indent=2))
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
