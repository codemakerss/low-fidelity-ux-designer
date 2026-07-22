#!/usr/bin/env python3
"""Validate a zero-dependency review board's HTML/Manifest contract."""

from __future__ import annotations

import argparse
import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path


class BoardParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.component_ids: list[str] = []
        self.screen_ids: list[str] = []
        self.templates: set[str] = set()
        self.manifest_text: list[str] = []
        self.in_manifest = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        if values.get("data-component-id"):
            self.component_ids.append(values["data-component-id"] or "")
        if values.get("data-screen-id"):
            self.screen_ids.append(values["data-screen-id"] or "")
        if tag == "template" and values.get("id"):
            self.templates.add(values["id"] or "")
        if tag == "script" and values.get("id") == "design-manifest":
            self.in_manifest = True

    def handle_endtag(self, tag: str) -> None:
        if tag == "script" and self.in_manifest:
            self.in_manifest = False

    def handle_data(self, data: str) -> None:
        if self.in_manifest:
            self.manifest_text.append(data)


def fail(message: str) -> None:
    raise ValueError(message)


def validate(path: Path) -> dict[str, object]:
    parser = BoardParser()
    parser.feed(path.read_text(encoding="utf-8"))
    if not parser.manifest_text:
        fail("missing design-manifest script")
    try:
        manifest = json.loads("".join(parser.manifest_text))
    except json.JSONDecodeError as error:
        fail(f"invalid design manifest JSON: {error}")

    required = {
        "schema_version",
        "board_id",
        "design_version",
        "versions",
        "sources",
        "tokens",
        "screens",
        "components",
        "interactions",
        "states",
        "assets",
        "submissions",
        "comments",
    }
    missing = sorted(required - set(manifest))
    if missing:
        fail(f"manifest missing keys: {', '.join(missing)}")
    if manifest["schema_version"] != "1.0":
        fail("unsupported schema_version")
    if not isinstance(manifest["board_id"], str) or not manifest["board_id"].strip():
        fail("board_id must be a non-empty string")
    if not isinstance(manifest["versions"], list) or not manifest["versions"]:
        fail("versions must be a non-empty array")
    version_ids = [item.get("version") for item in manifest["versions"] if isinstance(item, dict)]
    if len(version_ids) != len(manifest["versions"]) or len(version_ids) != len(set(version_ids)):
        fail("versions contain an invalid or duplicate version")
    if manifest["design_version"] not in version_ids:
        fail("design_version is missing from versions")
    for item in manifest["versions"]:
        href = item.get("href")
        if href and not re.fullmatch(r"versions/v[1-9]\d*/review\.html", href):
            fail(f"unsafe version href: {href}")
    if not isinstance(manifest["sources"], list):
        fail("sources must be an array")
    if not isinstance(manifest["submissions"], list):
        fail("submissions must be an array")
    if len(parser.component_ids) != len(set(parser.component_ids)):
        fail("duplicate data-component-id in DOM")
    if len(parser.screen_ids) != len(set(parser.screen_ids)):
        fail("duplicate data-screen-id in DOM")

    screens = manifest["screens"]
    components = manifest["components"]
    screen_ids = {item["screen_id"] for item in screens}
    component_ids = {item["component_id"] for item in components}
    if not screen_ids:
        fail("manifest has no screens")
    if len(screen_ids) != len(screens):
        fail("duplicate screen_id in manifest")
    if len(component_ids) != len(components):
        fail("duplicate component_id in manifest")
    missing_components = sorted(component_ids - set(parser.component_ids))
    if missing_components:
        fail(f"manifest components missing in DOM: {', '.join(missing_components)}")
    for screen in screens:
        render_type = screen.get("render_type")
        if render_type in {"html", "svg"} and screen.get("template_id") not in parser.templates:
            fail(f"missing template for {screen['screen_id']}: {screen.get('template_id')}")
        if screen.get("screen_id") not in screen_ids:
            fail("unreachable screen")
    for component in components:
        if component.get("screen_id") not in screen_ids:
            fail(f"component points to unknown screen: {component.get('component_id')}")
        if "source_locator" in component and not isinstance(component["source_locator"], dict):
            fail(f"source_locator must be an object: {component.get('component_id')}")
    for asset in manifest["assets"]:
        for key in ("asset_id", "purpose", "alt", "needs_visual_review"):
            if key not in asset:
                fail(f"asset missing {key}: {asset.get('asset_id')}")
    for comment in manifest["comments"]:
        if comment.get("screen_id") not in screen_ids:
            fail(f"comment points to unknown screen: {comment.get('comment_id')}")
        target = comment.get("component_id")
        if target and target not in component_ids:
            fail(f"comment points to unknown component: {comment.get('comment_id')}")

    return {
        "path": str(path),
        "board_id": manifest.get("board_id"),
        "design_version": manifest["design_version"],
        "screens": len(screens),
        "components": len(components),
        "dom_components": len(parser.component_ids),
        "comments": len(manifest["comments"]),
        "status": "ok",
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("board", type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(validate(args.board), ensure_ascii=False, indent=2))
    except (OSError, ValueError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
