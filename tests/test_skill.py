from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from normalize_source import normalize_url, source_id  # noqa: E402
from validate_review_board import validate  # noqa: E402


class SkillContractTests(unittest.TestCase):
    def test_normalize_source_removes_tracking_and_fragment(self) -> None:
        normalized = normalize_url("https://Example.com/profile/?utm_source=x&b=2&a=1#about")
        self.assertEqual(normalized, "https://example.com/profile?a=1&b=2")
        self.assertTrue(source_id(normalized).startswith("SRC-"))

    def test_board_template_manifest_matches_dom(self) -> None:
        result = validate(ROOT / "assets/review-board/index.html")
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["components"], result["dom_components"])

    def test_registry_rejects_duplicate_scope(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            command = [
                sys.executable,
                str(ROOT / "scripts/board_registry.py"),
                "add",
                "--root",
                str(root),
                "--board-id",
                "board-one",
                "--url",
                "https://example.com/profile?utm_campaign=x",
                "--design-goal",
                "review capability",
                "--storage-path",
                "docs/ux/board-one",
            ]
            first = subprocess.run(command, check=False, capture_output=True, text=True)
            self.assertEqual(first.returncode, 0, first.stderr)
            second = subprocess.run(command, check=False, capture_output=True, text=True)
            self.assertNotEqual(second.returncode, 0)
            registry = json.loads((root / "board-registry.json").read_text())
            self.assertEqual(len(registry["boards"]), 1)

    def test_registry_allows_new_normalized_url_as_new_board(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            base = [
                sys.executable,
                str(ROOT / "scripts/board_registry.py"),
                "add",
                "--root",
                str(root),
                "--design-goal",
                "review capability",
            ]
            first = subprocess.run(
                base
                + [
                    "--board-id",
                    "board-one",
                    "--url",
                    "https://example.com/profile",
                    "--storage-path",
                    "docs/ux/board-one",
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            second = subprocess.run(
                base
                + [
                    "--board-id",
                    "board-two",
                    "--url",
                    "https://example.com/settings",
                    "--storage-path",
                    "docs/ux/board-two",
                    "--related-board-id",
                    "board-one",
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(first.returncode, 0, first.stderr)
            self.assertEqual(second.returncode, 0, second.stderr)
            registry = json.loads((root / "board-registry.json").read_text())
            self.assertEqual([item["board_id"] for item in registry["boards"]], ["board-one", "board-two"])
            self.assertEqual(registry["boards"][1]["related_board_ids"], ["board-one"])

    def test_board_contains_host_adapter_fallback_contract(self) -> None:
        html = (ROOT / "assets/review-board/index.html").read_text()
        for expected in (
            "sendFollowUpMessage",
            "reviewBoardHost",
            "Submit to current host",
            "Copy review package",
            "http://127.0.0.1:8768",
            "/v1/health",
            "/v1/reviews",
            "visiblePins",
            "on ${state.version}",
            "submissions",
            "needs-clarification",
        ):
            self.assertIn(expected, html)
        self.assertIn("connect-src http://127.0.0.1:*", html)
        self.assertNotIn("localStorage.setItem(storageKey, JSON.stringify({ token:", html)

    def test_skill_declares_all_capability_lanes_and_storage_policy(self) -> None:
        skill = (ROOT / "SKILL.md").read_text()
        for expected in (
            "Multimodal + browser",
            "No multimodal + browser",
            "No browser + source access",
            "Text only",
            "new normalized URL gets a new Board folder",
        ):
            self.assertIn(expected, skill)

        checklist = (ROOT / "references/implementation-checklist.md").read_text()
        for expected in ("new normalized URL gets a new Board folder", "Codex", "Claude Code", "OpenCode", "idempotent"):
            self.assertIn(expected, checklist)

        adapters = (ROOT / "references/host-adapters.md").read_text()
        for expected in (
            "Codex",
            "Claude Code",
            "OpenCode",
            "sendFollowUpMessage",
            "reviewBoardHost.submit",
            "codex exec resume <session-id> -",
            "claude -p --resume <session-id> <prompt>",
            "opencode run --session <session-id> <prompt>",
            "http://127.0.0.1:8768",
            "idempotent",
        ):
            self.assertIn(expected, adapters)


if __name__ == "__main__":
    unittest.main()
