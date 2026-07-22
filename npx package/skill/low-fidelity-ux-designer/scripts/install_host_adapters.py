#!/usr/bin/env python3
"""Install review-board discovery assets into an explicit project root."""

from __future__ import annotations

import argparse
import json
import shlex
import sys
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class AdapterAsset:
    host: str
    source: Path
    destination: Path


SCRIPT_ROOT = Path(__file__).resolve().parents[1]
ASSET_ROOT = SCRIPT_ROOT / "assets" / "host-adapters"
ADAPTERS = {
    "codex": AdapterAsset(
        host="codex",
        source=ASSET_ROOT / "codex" / "SKILL.md",
        destination=Path(".agents/skills/review-board/SKILL.md"),
    ),
    "claude-code": AdapterAsset(
        host="claude-code",
        source=ASSET_ROOT / "claude-code" / "SKILL.md",
        destination=Path(".claude/skills/review-board/SKILL.md"),
    ),
    "opencode": AdapterAsset(
        host="opencode",
        source=ASSET_ROOT / "opencode" / "review-board.md",
        destination=Path(".opencode/commands/review-board.md"),
    ),
}


def requested_assets(host: str) -> list[AdapterAsset]:
    if host == "all":
        return [ADAPTERS[name] for name in ("codex", "claude-code", "opencode")]
    return [ADAPTERS[host]]


def render_asset(source: Path) -> str:
    text = source.read_text(encoding="utf-8")
    portable_root = "<installed-skill-root>"
    script_path = f"{portable_root}/scripts/board_package.py"
    text = text.replace(
        "<skill-root>/scripts/board_package.py",
        shlex.quote(script_path),
    )
    return text.replace("<skill-root>", shlex.quote(portable_root))


def install(project_root: Path, host: str, force: bool = False) -> list[Path]:
    if not project_root.exists():
        raise ValueError(f"project root does not exist: {project_root}")
    if not project_root.is_dir():
        raise ValueError(f"project root is not a directory: {project_root}")

    assets = requested_assets(host)
    missing_sources = [asset.source for asset in assets if not asset.source.is_file()]
    if missing_sources:
        joined = ", ".join(str(path) for path in missing_sources)
        raise ValueError(f"adapter asset missing: {joined}")

    destinations = [project_root / asset.destination for asset in assets]
    conflicts = [path for path in destinations if path.exists()]
    if conflicts and not force:
        joined = ", ".join(str(path) for path in conflicts)
        raise FileExistsError(f"refusing to overwrite existing adapter(s): {joined}; pass --force to replace")

    installed: list[Path] = []
    for asset, destination in zip(assets, destinations):
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(render_asset(asset.source), encoding="utf-8")
        installed.append(destination)
    return installed


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Install review-board adapters without invoking host CLIs.",
    )
    parser.add_argument("--project-root", type=Path, required=True)
    parser.add_argument(
        "--host",
        choices=("codex", "claude-code", "opencode", "all"),
        required=True,
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Replace an existing adapter file. Without this flag, installation is atomic on conflicts.",
    )
    args = parser.parse_args()

    try:
        installed = install(args.project_root.resolve(), args.host, args.force)
    except (OSError, ValueError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)

    print(json.dumps(
        {
            "host": args.host,
            "installed": [
                path.relative_to(args.project_root.resolve()).as_posix()
                for path in installed
            ],
        },
        ensure_ascii=False,
        indent=2,
    ))


if __name__ == "__main__":
    main()
