#!/usr/bin/env python3
"""Create and version self-contained low-fidelity review board packages."""

from __future__ import annotations

import argparse
import copy
import hashlib
import html
import json
import os
import re
import shutil
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from board_registry import add_board, read_registry, update_latest_version, validate_new_board
from normalize_source import normalize_source

SCRIPT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_TEMPLATE = SCRIPT_ROOT / "assets" / "review-board" / "index.html"
BOARD_ID_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*\Z")
VERSION_PATTERN = re.compile(r"v([1-9][0-9]*)\Z")
MANIFEST_PATTERN = re.compile(
    r"(<script\b(?=[^>]*\bid=[\"']design-manifest[\"'])[^>]*>)(.*?)(</script\s*>)",
    re.IGNORECASE | re.DOTALL,
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def validate_board_id(board_id: str) -> str:
    if not BOARD_ID_PATTERN.fullmatch(board_id) or board_id in {".", ".."}:
        raise ValueError("board-id must contain only letters, digits, dot, underscore, or hyphen")
    return board_id


def version_number(version: str) -> int:
    match = VERSION_PATTERN.fullmatch(version)
    if not match:
        raise ValueError(f"invalid design version: {version}; expected vN")
    return int(match.group(1))


def read_json(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"expected a JSON object: {path}")
    return data


def atomic_write(path: Path, content: str | bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = "wb" if isinstance(content, bytes) else "w"
    kwargs = {} if isinstance(content, bytes) else {"encoding": "utf-8"}
    fd, temporary_name = tempfile.mkstemp(prefix=f".{path.name}-", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, mode, **kwargs) as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_name, path)
    except Exception:
        try:
            Path(temporary_name).unlink()
        except FileNotFoundError:
            pass
        raise


def manifest_from_html(source: str | Path) -> dict:
    text = source.read_text(encoding="utf-8") if isinstance(source, Path) else source
    match = MANIFEST_PATTERN.search(text)
    if not match:
        raise ValueError("HTML does not contain #design-manifest")
    data = json.loads(match.group(2))
    if not isinstance(data, dict):
        raise ValueError("design-manifest must be a JSON object")
    return data


def embed_manifest(document: str, manifest: dict, *, title: str | None = None) -> str:
    # Escaped slashes keep user-authored text such as ``</script>`` from
    # terminating the inert JSON script element early.
    serialized = json.dumps(manifest, ensure_ascii=False, indent=2).replace("</", "<\\/")
    if not MANIFEST_PATTERN.search(document):
        raise ValueError("HTML does not contain #design-manifest")
    document = MANIFEST_PATTERN.sub(lambda match: f"{match.group(1)}\n{serialized}\n  {match.group(3)}", document, count=1)
    if title:
        safe_title = html.escape(title, quote=False)
        document = re.sub(r"<title>.*?</title>", f"<title>{safe_title}</title>", document, count=1, flags=re.I | re.S)
    return document


def merge_by_id(existing: list, incoming: list, key: str) -> list:
    merged: dict[str, dict] = {}
    order: list[str] = []
    anonymous: list = []
    for item in [*existing, *incoming]:
        if not isinstance(item, dict) or not item.get(key):
            anonymous.append(copy.deepcopy(item))
            continue
        identifier = str(item[key])
        if identifier not in merged:
            order.append(identifier)
        merged[identifier] = copy.deepcopy(item)
    return [merged[identifier] for identifier in order] + anonymous


def current_version_manifest(manifest: dict, version: str) -> dict:
    archived = copy.deepcopy(manifest)
    entry = next((copy.deepcopy(item) for item in archived.get("versions", []) if item.get("version") == version), None)
    if entry is None:
        entry = {"version": version, "label": version, "created_at": utc_now()}
    entry.pop("href", None)
    archived["design_version"] = version
    archived["versions"] = [entry]
    archived["screens"] = [
        copy.deepcopy(screen)
        for screen in archived.get("screens", [])
        if screen.get("version", version) == version
    ]
    return archived


def version_entries(manifest: dict, target: str, created_at: str) -> list[dict]:
    entries: dict[str, dict] = {}
    for item in manifest.get("versions", []):
        version = item.get("version")
        if isinstance(version, str) and VERSION_PATTERN.fullmatch(version):
            entries[version] = copy.deepcopy(item)
    entries[target] = {
        "version": target,
        "label": f"{target} Draft",
        "created_at": created_at,
    }
    result = []
    for version in sorted(entries, key=version_number):
        entry = entries[version]
        if version == target:
            entry.pop("href", None)
        else:
            entry["href"] = f"versions/{version}/review.html"
        result.append(entry)
    return result


def retag_active_screens(manifest: dict, current: str, target: str) -> list[dict]:
    screens = manifest.get("screens", [])
    active = [screen for screen in screens if screen.get("version", current) == current]
    if not active:
        active = list(screens)
    result = copy.deepcopy(active)
    for screen in result:
        screen["version"] = target
    return result


def specification_text(manifest: dict, design_goal: str, source_record: dict, *, previous: str | None = None) -> str:
    lines = [
        f"# {manifest['board_name']} — {manifest['design_version']} canonical specification",
        "",
        f"- Board ID: `{manifest['board_id']}`",
        f"- Design version: `{manifest['design_version']}`",
        f"- Design goal: {design_goal}",
        f"- Source: `{source_record['normalized_url']}`",
    ]
    if previous:
        lines.append(f"- Previous immutable version: `{previous}`")
    lines.extend(["", "## Screens", ""])
    for screen in manifest.get("screens", []):
        lines.append(f"- `{screen.get('screen_id', 'unknown')}` — {screen.get('name', 'Unnamed screen')}")
    comments = manifest.get("comments", [])
    lines.extend(["", "## Review history", "", f"{len(comments)} comment record(s) are retained in the Design Manifest.", ""])
    return "\n".join(lines)


def create_package(args: argparse.Namespace) -> dict:
    root = args.root.expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    board_id = validate_board_id(args.board_id)
    board_dir = root / board_id
    if board_dir.exists():
        raise ValueError(f"board directory already exists: {board_dir}")

    source_record = normalize_source(
        args.source,
        lane=args.lane,
        canonical_url=args.canonical_url,
    )
    registry = read_registry(root)
    validate_new_board(registry, board_id=board_id, source_record=source_record, design_goal=args.design_goal)

    template = args.template.expanduser().resolve(strict=True)
    template_html = template.read_text(encoding="utf-8")
    manifest = manifest_from_html(template_html)
    board_name = args.board_name or board_id.replace("-", " ").replace("_", " ").strip().title()
    created_at = utc_now()

    staging = Path(tempfile.mkdtemp(prefix=f".{board_id}-", dir=root))
    moved = False
    try:
        (staging / "sources").mkdir()
        (staging / "feedback").mkdir()
        source_record = copy.deepcopy(source_record)
        if source_record["source_type"] == "local-file":
            local_source = Path(source_record["local_path"])
            snapshot = staging / "sources" / local_source.name
            shutil.copy2(local_source, snapshot)
            source_record["snapshot_path"] = f"sources/{local_source.name}"

        manifest.update({
            "board_id": board_id,
            "board_name": board_name,
            "design_version": "v1",
            "sources": [copy.deepcopy(source_record)],
            "storage": {
                "root": str(root),
                "path": str(board_dir),
                "path_resolution": "explicit-user-selected",
            },
            "versions": [{"version": "v1", "label": "v1 Draft", "created_at": created_at}],
            "submissions": [],
            "comments": [],
        })
        manifest["screens"] = retag_active_screens(manifest, manifest.get("design_version", "v1"), "v1")
        board_html = embed_manifest(template_html, manifest, title=f"{board_name} — Review Board")
        archived_html = embed_manifest(board_html, current_version_manifest(manifest, "v1"))

        atomic_write(staging / "source.json", json.dumps(source_record, ensure_ascii=False, indent=2) + "\n")
        atomic_write(staging / "manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
        atomic_write(staging / "board.html", board_html)
        atomic_write(staging / "versions" / "v1" / "review.html", archived_html)
        atomic_write(
            staging / "versions" / "v1" / "specification.md",
            specification_text(manifest, args.design_goal, source_record),
        )
        os.replace(staging, board_dir)
        moved = True
        try:
            registry_record = add_board(
                root,
                board_id=board_id,
                source_record=source_record,
                design_goal=args.design_goal,
                storage_path=str(board_dir),
                related_board_ids=args.related_board_id,
            )
        except Exception:
            shutil.rmtree(board_dir)
            raise
    finally:
        if not moved and staging.exists():
            shutil.rmtree(staging)

    return {
        "status": "created",
        "board_id": board_id,
        "board_dir": str(board_dir),
        "design_version": "v1",
        "source_id": source_record["source_id"],
        "registry_record": registry_record,
    }


def review_comments(package: dict) -> list:
    comments = package.get("comments")
    if comments is None and isinstance(package.get("manifest"), dict):
        comments = package["manifest"].get("comments")
    if comments is None:
        return []
    if not isinstance(comments, list):
        raise ValueError("review package comments must be an array")
    return comments


def feedback_destination(feedback_dir: Path, source: Path, package: dict) -> Path:
    identifier = str(package.get("submission_id") or source.stem)
    safe = re.sub(r"[^A-Za-z0-9._-]+", "-", identifier).strip("-.") or "review-package"
    content = source.read_bytes()
    destination = feedback_dir / f"{safe}.json"
    if destination.exists() and destination.read_bytes() != content:
        digest = hashlib.sha256(content).hexdigest()[:10]
        destination = feedback_dir / f"{safe}-{digest}.json"
    atomic_write(destination, content)
    return destination


def version_package(args: argparse.Namespace) -> dict:
    board_dir = args.board_dir.expanduser().resolve(strict=True)
    if not board_dir.is_dir():
        raise ValueError(f"board-dir must be a directory: {board_dir}")
    root = board_dir.parent
    canonical_path = board_dir / "manifest.json"
    board_path = board_dir / "board.html"
    source_path = board_dir / "source.json"
    for required in (canonical_path, board_path, source_path, root / "board-registry.json"):
        if not required.exists():
            raise ValueError(f"missing required board package file: {required}")

    canonical = read_json(canonical_path)
    source_record = read_json(source_path)
    board_html = board_path.read_text(encoding="utf-8")
    candidate = manifest_from_html(board_html)
    board_id = canonical.get("board_id")
    if not board_id or candidate.get("board_id") != board_id:
        raise ValueError("board.html and manifest.json board_id values do not match")
    registry = read_registry(root)
    registry_record = next((item for item in registry["boards"] if item.get("board_id") == board_id), None)
    if registry_record is None:
        raise ValueError(f"board_id not found in registry: {board_id}")

    current = canonical.get("design_version")
    current_number = version_number(current)
    known_numbers = [version_number(item["version"]) for item in canonical.get("versions", []) if VERSION_PATTERN.fullmatch(str(item.get("version", "")))]
    next_number = max([current_number, *known_numbers]) + 1
    target = args.version or f"v{next_number}"
    target_number = version_number(target)
    if target_number <= max([current_number, *known_numbers]):
        raise ValueError(f"new version must be greater than the latest version: {current}")
    target_dir = board_dir / "versions" / target
    if target_dir.exists():
        raise ValueError(f"version already exists: {target}")

    package = None
    resolved_review_package = None
    incoming_comments: list = []
    if args.review_package:
        resolved_review_package = args.review_package.expanduser().resolve(strict=True)
        package = read_json(resolved_review_package)
        if package.get("board_id") not in {None, board_id}:
            raise ValueError("review package board_id does not match board-dir")
        incoming_comments = review_comments(package)

    updated = copy.deepcopy(candidate)
    updated["board_id"] = board_id
    updated["board_name"] = canonical.get("board_name", candidate.get("board_name", board_id))
    updated["sources"] = copy.deepcopy(canonical.get("sources", [source_record]))
    updated["storage"] = copy.deepcopy(canonical.get("storage", candidate.get("storage", {})))
    # The incoming package supplies comments that may exist only in the
    # browser's local draft. The edited board is applied last so an adapter's
    # accepted/rejected/resolved disposition is not overwritten by the
    # original package's still-open copy of the same comment.
    updated["comments"] = merge_by_id(
        merge_by_id(canonical.get("comments", []), incoming_comments, "comment_id"),
        candidate.get("comments", []),
        "comment_id",
    )
    updated["submissions"] = merge_by_id(
        canonical.get("submissions", []), candidate.get("submissions", []), "submission_id"
    )
    created_at = utc_now()
    updated["design_version"] = target
    updated["screens"] = retag_active_screens(candidate, current, target)
    updated["versions"] = version_entries(canonical, target, created_at)

    prior_archive = board_dir / "versions" / current / "review.html"
    if not prior_archive.exists():
        prior_manifest = current_version_manifest(canonical, current)
        atomic_write(prior_archive, embed_manifest(board_html, prior_manifest))

    current_html = embed_manifest(board_html, updated, title=f"{updated['board_name']} — Review Board")
    archived_manifest = current_version_manifest(updated, target)
    archived_html = embed_manifest(current_html, archived_manifest)
    design_goal = registry_record.get("design_goal", "Not recorded")

    staging = Path(tempfile.mkdtemp(prefix=f".{target}-", dir=board_dir / "versions"))
    moved = False
    try:
        atomic_write(staging / "review.html", archived_html)
        atomic_write(
            staging / "specification.md",
            specification_text(updated, design_goal, source_record, previous=current),
        )
        os.replace(staging, target_dir)
        moved = True
    finally:
        if not moved and staging.exists():
            shutil.rmtree(staging)

    atomic_write(canonical_path, json.dumps(updated, ensure_ascii=False, indent=2) + "\n")
    atomic_write(board_path, current_html)
    feedback_path = None
    if resolved_review_package is not None and package is not None:
        feedback_path = feedback_destination(board_dir / "feedback", resolved_review_package, package)
    registry_record = update_latest_version(root, board_id=board_id, latest_version=target)

    return {
        "status": "versioned",
        "board_id": board_id,
        "board_dir": str(board_dir),
        "previous_version": current,
        "design_version": target,
        "comments_retained": len(updated["comments"]),
        "feedback_path": str(feedback_path) if feedback_path else None,
        "registry_record": registry_record,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    create = sub.add_parser("create")
    create.add_argument("--root", type=Path, required=True, help="Explicit user-selected Board Registry root")
    create.add_argument("--board-id", required=True)
    create.add_argument("--source", required=True, help="HTTP(S) URL, local file path, or localhost file URI")
    create.add_argument(
        "--canonical-url",
        help="Browser-confirmed absolute HTTP(S) canonical URL used for normalized identity",
    )
    create.add_argument("--design-goal", required=True)
    create.add_argument("--board-name")
    create.add_argument("--lane", default="undetected")
    create.add_argument("--related-board-id", action="append", default=[])
    create.add_argument("--template", type=Path, default=DEFAULT_TEMPLATE)

    version = sub.add_parser("version")
    version.add_argument("--board-dir", type=Path, required=True)
    version.add_argument("--review-package", type=Path)
    version.add_argument("--version")
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    try:
        result = create_package(args) if args.command == "create" else version_package(args)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
