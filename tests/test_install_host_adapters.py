from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
INSTALLER = ROOT / "scripts" / "install_host_adapters.py"

EXPECTED_PATHS = {
    "codex": Path(".agents/skills/review-board/SKILL.md"),
    "claude-code": Path(".claude/skills/review-board/SKILL.md"),
    "opencode": Path(".opencode/commands/review-board.md"),
}


def run_installer(project_root: Path, host: str, *extra: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            sys.executable,
            str(INSTALLER),
            "--project-root",
            str(project_root),
            "--host",
            host,
            *extra,
        ],
        check=False,
        capture_output=True,
        text=True,
    )


class HostAdapterInstallerTests(unittest.TestCase):
    def test_each_host_uses_its_discovery_path(self) -> None:
        for host, relative_path in EXPECTED_PATHS.items():
            with self.subTest(host=host), tempfile.TemporaryDirectory() as temp:
                project_root = Path(temp)
                result = run_installer(project_root, host)
                self.assertEqual(result.returncode, 0, result.stderr)
                destination = project_root / relative_path
                self.assertTrue(destination.is_file())

                text = destination.read_text(encoding="utf-8")
                self.assertIn("ReviewPackage", text)
                self.assertIn("board_package.py", text)
                self.assertNotIn("<skill-root>", text)
                self.assertIn(str(ROOT / "scripts" / "board_package.py"), text)
                if host in {"claude-code", "opencode"}:
                    self.assertIn("$ARGUMENTS", text)

    def test_existing_file_is_not_overwritten_without_force(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            project_root = Path(temp)
            destination = project_root / EXPECTED_PATHS["codex"]
            destination.parent.mkdir(parents=True)
            destination.write_text("user-owned\n", encoding="utf-8")

            result = run_installer(project_root, "codex")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("refusing to overwrite", result.stderr)
            self.assertEqual(destination.read_text(encoding="utf-8"), "user-owned\n")

    def test_all_preflights_conflicts_without_partial_install(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            project_root = Path(temp)
            conflict = project_root / EXPECTED_PATHS["claude-code"]
            conflict.parent.mkdir(parents=True)
            conflict.write_text("existing\n", encoding="utf-8")

            result = run_installer(project_root, "all")
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(conflict.read_text(encoding="utf-8"), "existing\n")
            self.assertFalse((project_root / EXPECTED_PATHS["codex"]).exists())
            self.assertFalse((project_root / EXPECTED_PATHS["opencode"]).exists())

    def test_all_installs_all_three_and_force_replaces(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            project_root = Path(temp)
            first = run_installer(project_root, "all")
            self.assertEqual(first.returncode, 0, first.stderr)
            for path in EXPECTED_PATHS.values():
                self.assertTrue((project_root / path).is_file())

            codex = project_root / EXPECTED_PATHS["codex"]
            codex.write_text("changed\n", encoding="utf-8")
            forced = run_installer(project_root, "all", "--force")
            self.assertEqual(forced.returncode, 0, forced.stderr)
            self.assertNotEqual(codex.read_text(encoding="utf-8"), "changed\n")


if __name__ == "__main__":
    unittest.main()
