from __future__ import annotations

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SKIP_DIRECTORIES = {
    ".git",
    ".nested-git-backups",
    ".next",
    ".vinext",
    ".wrangler",
    "__pycache__",
    "dist",
    "node_modules",
}
RESERVED_EMAIL_DOMAINS = {
    "example.com",
    "example.invalid",
    "example.net",
    "example.org",
}


def repository_text_files() -> list[Path]:
    paths: list[Path] = []
    for path in ROOT.rglob("*"):
        if not path.is_file():
            continue
        if any(part in SKIP_DIRECTORIES for part in path.relative_to(ROOT).parts):
            continue
        try:
            path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        paths.append(path)
    return paths


class RepositoryPrivacyTests(unittest.TestCase):
    def test_repository_has_no_known_owner_or_environment_markers(self) -> None:
        forbidden_markers = [
            "".join(["code", "makerss"]),
            "".join(["Je", "ff"]),
            "".join(["513", "49563"]),
            "".join(["app", "gprj_"]),
        ]

        findings: list[str] = []
        for path in repository_text_files():
            relative = path.relative_to(ROOT).as_posix()
            content = path.read_text(encoding="utf-8")
            searchable = f"{relative}\n{content}".casefold()
            for marker in forbidden_markers:
                if marker.casefold() in searchable:
                    findings.append(f"{relative}: contains a forbidden identity marker")

        self.assertEqual(findings, [], "\n".join(findings))

    def test_repository_has_no_machine_paths_or_non_example_emails(self) -> None:
        machine_path = re.compile(
            r"(?:file://)?/(?:Users|home)/[A-Za-z0-9._-]+/",
            re.IGNORECASE,
        )
        email = re.compile(
            r"(?<![A-Za-z0-9._%+-])"
            r"[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})"
        )

        findings: list[str] = []
        for path in repository_text_files():
            relative = path.relative_to(ROOT).as_posix()
            content = path.read_text(encoding="utf-8")
            if machine_path.search(content):
                findings.append(f"{relative}: contains a local machine path")
            for match in email.finditer(content):
                if match.group(1).casefold() not in RESERVED_EMAIL_DOMAINS:
                    findings.append(f"{relative}: contains a non-example email address")

        self.assertEqual(findings, [], "\n".join(findings))


if __name__ == "__main__":
    unittest.main()
