from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))

from board_package import embed_manifest, manifest_from_html  # noqa: E402
from normalize_source import normalize_source, normalize_url  # noqa: E402


class LocalSourceTests(unittest.TestCase):
    def test_local_path_and_localhost_file_uri_share_identity_and_fingerprint(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / "wire frame.html"
            source.write_text("<main>local source</main>", encoding="utf-8")
            expected = "sha256:" + hashlib.sha256(source.read_bytes()).hexdigest()

            path_record = normalize_source(str(source), captured_at="2000-01-01T00:00:00+00:00")
            uri_record = normalize_source(
                source.as_uri().replace("file://", "file://localhost"),
                captured_at="2000-01-01T00:00:00+00:00",
            )

            self.assertEqual(path_record["normalized_url"], source.resolve().as_uri())
            self.assertEqual(uri_record["normalized_url"], path_record["normalized_url"])
            self.assertEqual(uri_record["source_id"], path_record["source_id"])
            self.assertEqual(path_record["content_fingerprint"], expected)
            self.assertEqual(path_record["source_type"], "local-file")

            source.write_text("<main>changed</main>", encoding="utf-8")
            changed = normalize_source(str(source), captured_at="2000-01-01T00:00:01+00:00")
            self.assertEqual(changed["source_id"], path_record["source_id"])
            self.assertNotEqual(changed["content_fingerprint"], path_record["content_fingerprint"])

    def test_local_directory_has_stable_identity_without_file_snapshot_hash(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp).resolve()
            record = normalize_source(str(directory))
            self.assertEqual(record["source_type"], "local-directory")
            self.assertEqual(record["normalized_url"], directory.as_uri())
            self.assertIsNone(record["content_fingerprint"])

    def test_remote_file_uri_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "localhost"):
            normalize_source("file://example.com/tmp/source.html")

    def test_normalize_url_remains_url_only(self) -> None:
        self.assertEqual(normalize_url("https://Example.com/a/?utm_source=x"), "https://example.com/a")
        self.assertEqual(normalize_url("http://[::1]:8080/a"), "http://[::1]:8080/a")
        with self.assertRaisesRegex(ValueError, "credentials"):
            normalize_url("https://user:secret@example.com/a")
        with self.assertRaises(ValueError):
            normalize_url("./source.html")

    def test_browser_confirmed_canonical_controls_web_identity(self) -> None:
        raw = "https://example.com/store?afid=campaign&cid=brand"
        canonical = "HTTPS://EXAMPLE.COM:443/store/?utm_source=browser#products"
        record = normalize_source(
            raw,
            canonical_url=canonical,
            captured_at="2000-01-01T00:00:00+00:00",
        )

        self.assertEqual(record["source_url"], raw)
        self.assertEqual(record["normalized_url"], "https://example.com/store")
        self.assertEqual(
            record["source_id"],
            normalize_source("https://example.com/store")["source_id"],
        )

    def test_canonical_override_rejects_unsafe_or_inapplicable_values(self) -> None:
        for canonical in (
            "/relative/page",
            "file:///tmp/page.html",
            "javascript:alert(1)",
            "https://user:secret@example.com/page",
        ):
            with self.subTest(canonical=canonical):
                with self.assertRaises(ValueError):
                    normalize_source("https://example.com/page", canonical_url=canonical)

        with self.assertRaisesRegex(ValueError, "credentials"):
            normalize_source(
                "https://user:secret@example.com/page",
                canonical_url="https://example.com/page",
            )

        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / "page.html"
            source.write_text("<main>local</main>", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "HTTP"):
                normalize_source(str(source), canonical_url="https://example.com/page")


class BoardPackageCliTests(unittest.TestCase):
    def run_cli(self, *arguments: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(SCRIPTS / "board_package.py"), *arguments],
            check=False,
            capture_output=True,
            text=True,
            cwd=ROOT,
        )

    def create_local_board(self, temp: Path) -> tuple[Path, Path]:
        source = temp / "source.html"
        source.write_text("<!doctype html><title>Source snapshot</title>", encoding="utf-8")
        board_root = temp / "chosen-review-root"
        result = self.run_cli(
            "create",
            "--root",
            str(board_root),
            "--board-id",
            "local-source-review",
            "--source",
            str(source),
            "--design-goal",
            "Review the local page task flow",
            "--board-name",
            "Local source review",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return board_root, board_root / "local-source-review"

    def test_create_uses_explicit_root_and_writes_complete_package(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            temp = Path(temp_name)
            board_root, board_dir = self.create_local_board(temp)

            self.assertFalse((board_root / "boards").exists())
            for relative in (
                "source.json",
                "board.html",
                "manifest.json",
                "sources/source.html",
                "versions/v1/specification.md",
                "versions/v1/review.html",
                "feedback",
            ):
                self.assertTrue((board_dir / relative).exists(), relative)

            source_record = json.loads((board_dir / "source.json").read_text(encoding="utf-8"))
            manifest = json.loads((board_dir / "manifest.json").read_text(encoding="utf-8"))
            embedded = manifest_from_html(board_dir / "board.html")
            archived = manifest_from_html(board_dir / "versions/v1/review.html")
            registry = json.loads((board_root / "board-registry.json").read_text(encoding="utf-8"))

            self.assertEqual(source_record["snapshot_path"], "sources/source.html")
            self.assertRegex(source_record["content_fingerprint"], r"^sha256:[0-9a-f]{64}$")
            self.assertEqual(manifest["board_id"], "local-source-review")
            self.assertEqual(embedded, manifest)
            self.assertEqual(archived["versions"], [manifest["versions"][0]])
            self.assertEqual(registry["boards"][0]["storage_path"], str(board_dir.resolve()))
            self.assertEqual(registry["boards"][0]["latest_version"], "v1")

    def test_version_merges_review_comments_and_preserves_immutable_archives(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            temp = Path(temp_name)
            board_root, board_dir = self.create_local_board(temp)
            v1_path = board_dir / "versions/v1/review.html"
            v1_digest = hashlib.sha256(v1_path.read_bytes()).hexdigest()
            review_package = temp / "review-package.json"
            review_package.write_text(
                json.dumps({
                    "schema_version": "1.0",
                    "submission_id": "SUB-001",
                    "board_id": "local-source-review",
                    "design_version": "v1",
                    "comments": [{
                        "comment_id": "C001",
                        "screen_id": "W01",
                        "component_id": "W01.search",
                        "screen_version": "v1",
                        "anchor": {"x_ratio": 0.5, "y_ratio": 0.5},
                        "category": "suggestion",
                        "priority": "important",
                        "content": "Make the search intent clearer.",
                        "status": "open",
                        "resolution": None,
                    }],
                }, ensure_ascii=False),
                encoding="utf-8",
            )

            v2_result = self.run_cli(
                "version",
                "--board-dir",
                str(board_dir),
                "--review-package",
                str(review_package),
            )
            self.assertEqual(v2_result.returncode, 0, v2_result.stderr)
            self.assertEqual(hashlib.sha256(v1_path.read_bytes()).hexdigest(), v1_digest)

            current = json.loads((board_dir / "manifest.json").read_text(encoding="utf-8"))
            current_html = manifest_from_html(board_dir / "board.html")
            v2_path = board_dir / "versions/v2/review.html"
            archived_v2 = manifest_from_html(v2_path)
            v2_digest = hashlib.sha256(v2_path.read_bytes()).hexdigest()
            registry = json.loads((board_root / "board-registry.json").read_text(encoding="utf-8"))

            self.assertEqual(current["design_version"], "v2")
            self.assertEqual(current_html, current)
            self.assertEqual([comment["comment_id"] for comment in current["comments"]], ["C001"])
            self.assertEqual(current["versions"][0]["href"], "versions/v1/review.html")
            self.assertNotIn("href", current["versions"][1])
            self.assertEqual([item["version"] for item in archived_v2["versions"]], ["v2"])
            self.assertTrue((board_dir / "feedback/SUB-001.json").exists())
            self.assertEqual(registry["boards"][0]["latest_version"], "v2")

            v3_result = self.run_cli("version", "--board-dir", str(board_dir), "--version", "v3")
            self.assertEqual(v3_result.returncode, 0, v3_result.stderr)
            v3 = json.loads((board_dir / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(hashlib.sha256(v1_path.read_bytes()).hexdigest(), v1_digest)
            self.assertEqual(hashlib.sha256(v2_path.read_bytes()).hexdigest(), v2_digest)
            self.assertEqual([comment["comment_id"] for comment in v3["comments"]], ["C001"])
            self.assertEqual(v3["design_version"], "v3")

    def test_edited_board_disposition_wins_over_original_open_package(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            temp = Path(temp_name)
            _, board_dir = self.create_local_board(temp)
            review_package = temp / "review-package.json"
            comment = {
                "comment_id": "C001",
                "screen_id": "W01",
                "component_id": "W01.search",
                "screen_version": "v1",
                "anchor": {"x_ratio": 0.5, "y_ratio": 0.5},
                "category": "suggestion",
                "priority": "important",
                "content": "Clarify the search action.",
                "status": "open",
                "resolution": None,
            }
            review_package.write_text(
                json.dumps({
                    "submission_id": "SUB-001",
                    "board_id": "local-source-review",
                    "design_version": "v1",
                    "comments": [comment],
                }),
                encoding="utf-8",
            )

            board_path = board_dir / "board.html"
            board_html = board_path.read_text(encoding="utf-8")
            edited_manifest = manifest_from_html(board_html)
            edited_comment = dict(comment)
            edited_comment.update({
                "status": "accepted",
                "resolution": "Search action grouped with its input.",
                "resolved_in_version": "v2",
            })
            edited_manifest["comments"] = [edited_comment]
            board_path.write_text(embed_manifest(board_html, edited_manifest), encoding="utf-8")

            result = self.run_cli(
                "version",
                "--board-dir",
                str(board_dir),
                "--review-package",
                str(review_package),
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            current = json.loads((board_dir / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(current["comments"][0]["status"], "accepted")
            self.assertEqual(current["comments"][0]["resolved_in_version"], "v2")

    def test_create_requires_root_and_rejects_duplicate_scope(self) -> None:
        missing_root = self.run_cli(
            "create",
            "--board-id",
            "missing-root",
            "--source",
            "https://example.com",
            "--design-goal",
            "Test explicit paths",
        )
        self.assertNotEqual(missing_root.returncode, 0)
        self.assertIn("--root", missing_root.stderr)

        with tempfile.TemporaryDirectory() as temp_name:
            root = Path(temp_name) / "root"
            first = self.run_cli(
                "create", "--root", str(root), "--board-id", "one",
                "--source", "https://example.com/page?utm_source=x",
                "--design-goal", "same scope",
            )
            second = self.run_cli(
                "create", "--root", str(root), "--board-id", "two",
                "--source", "https://example.com/page",
                "--design-goal", "same scope",
            )
            self.assertEqual(first.returncode, 0, first.stderr)
            self.assertNotEqual(second.returncode, 0)
            self.assertFalse((root / "two").exists())

    def test_create_uses_canonical_identity_but_preserves_raw_source(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            root = Path(temp_name) / "root"
            raw = "https://example.com/store?afid=campaign&cid=brand"
            canonical = "https://example.com/store"
            first = self.run_cli(
                "create", "--root", str(root), "--board-id", "sample-store",
                "--source", raw,
                "--canonical-url", canonical,
                "--design-goal", "Map the complete store landing page",
            )
            self.assertEqual(first.returncode, 0, first.stderr)

            source = json.loads((root / "sample-store/source.json").read_text(encoding="utf-8"))
            manifest = json.loads((root / "sample-store/manifest.json").read_text(encoding="utf-8"))
            registry = json.loads((root / "board-registry.json").read_text(encoding="utf-8"))
            self.assertEqual(source["source_url"], raw)
            self.assertEqual(source["normalized_url"], canonical)
            self.assertEqual(source["source_id"], normalize_source(canonical)["source_id"])
            self.assertEqual(manifest["sources"][0], source)
            self.assertEqual(registry["boards"][0]["source_url"], raw)
            self.assertEqual(registry["boards"][0]["normalized_url"], canonical)

            duplicate = self.run_cli(
                "create", "--root", str(root), "--board-id", "same-canonical",
                "--source", "https://example.com/store?different=campaign",
                "--canonical-url", canonical,
                "--design-goal", "Map the complete store landing page",
            )
            self.assertNotEqual(duplicate.returncode, 0)
            self.assertIn("matching board already exists", duplicate.stderr)
            self.assertFalse((root / "same-canonical").exists())

    def test_create_rejects_invalid_canonical_without_writing_board(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            root = Path(temp_name) / "root"
            result = self.run_cli(
                "create", "--root", str(root), "--board-id", "unsafe-canonical",
                "--source", "https://example.com/page",
                "--canonical-url", "file:///tmp/page.html",
                "--design-goal", "Reject unsafe identity override",
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("absolute http(s)", result.stderr.lower())
            self.assertFalse((root / "unsafe-canonical").exists())

    def test_manifest_embedding_escapes_script_end_sequences(self) -> None:
        template = (ROOT / "assets/review-board/index.html").read_text(encoding="utf-8")
        manifest = manifest_from_html(template)
        manifest["comments"] = [{"comment_id": "C001", "content": "Do not emit </script> here"}]
        embedded = embed_manifest(template, manifest)
        self.assertIn(r"<\/script>", embedded)
        self.assertEqual(manifest_from_html(embedded)["comments"], manifest["comments"])


if __name__ == "__main__":
    unittest.main()
