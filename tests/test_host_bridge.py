from __future__ import annotations

import http.client
import json
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from review_bridge import (  # noqa: E402
    BridgeConfig,
    DispatchConfig,
    ReviewBridgeService,
    create_server,
)
from review_host_adapter import (  # noqa: E402
    ReviewPackageError,
    build_adapter_command,
    build_review_prompt,
    execute_review_package,
    validate_review_package,
)


TOKEN = "test-token-123456789"


def review_package(
    *,
    submission_id: str = "SUB-20000101-001",
    content: str = "把搜索按钮移到输入框右侧",
) -> dict:
    return {
        "schema_version": "1.0",
        "submission_id": submission_id,
        "board_id": "example-board",
        "design_version": "v1",
        "source_ids": ["SRC-001"],
        "comments": [
            {
                "comment_id": "C001",
                "screen_id": "W01",
                "component_id": "W01.search",
                "screen_version": "v1",
                "anchor": {"x_ratio": 0.5, "y_ratio": 0.4},
                "category": "problem",
                "priority": "important",
                "content": content,
                "status": "open",
                "resolution": None,
            }
        ],
        "manifest": {
            "schema_version": "1.0",
            "board_id": "example-board",
            "design_version": "v1",
        },
        "processing_policy": {
            "low_risk": "apply",
            "high_impact": "ask_confirmation",
            "preserve_old_versions": True,
        },
    }


def fake_cli(directory: Path, *, exit_code: int = 0) -> Path:
    path = directory / f"fake-cli-{exit_code}"
    path.write_text(
        "#!/usr/bin/env python3\n"
        "import json, sys\n"
        "print(json.dumps({'argv': sys.argv[1:], 'stdin': sys.stdin.read()}))\n"
        f"raise SystemExit({exit_code})\n",
        encoding="utf-8",
    )
    path.chmod(0o755)
    return path


class ReviewPackageAndAdapterTests(unittest.TestCase):
    def test_package_validation_accepts_board_contract(self) -> None:
        package = validate_review_package(review_package())
        self.assertEqual(package["submission_id"], "SUB-20000101-001")
        self.assertEqual(package["comments"][0]["component_id"], "W01.search")

    def test_package_validation_rejects_mismatch_and_duplicate_comments(self) -> None:
        package = review_package()
        package["manifest"]["board_id"] = "other"
        with self.assertRaisesRegex(ReviewPackageError, "manifest.board_id"):
            validate_review_package(package)

        package = review_package()
        package["comments"].append(dict(package["comments"][0]))
        with self.assertRaisesRegex(ReviewPackageError, "duplicate comment_id"):
            validate_review_package(package)

    def test_package_validation_rejects_invalid_comment_contract(self) -> None:
        package = review_package()
        package["comments"][0]["anchor"]["x_ratio"] = 1.5
        with self.assertRaisesRegex(ReviewPackageError, "x_ratio"):
            validate_review_package(package)

        package = review_package()
        package["comments"][0]["category"] = "execute-shell"
        with self.assertRaisesRegex(ReviewPackageError, "category"):
            validate_review_package(package)

    def test_official_command_shapes_and_prompt_transport(self) -> None:
        prompt = build_review_prompt(review_package())
        codex = build_adapter_command("codex", "session-1", prompt, cli="/opt/codex")
        self.assertEqual(codex.argv, ("/opt/codex", "exec", "resume", "session-1", "-"))
        self.assertEqual(codex.stdin_text, prompt)

        claude = build_adapter_command("claude-code", "session-2", prompt, cli="/opt/claude")
        self.assertEqual(
            claude.argv[:4],
            ("/opt/claude", "-p", "--resume", "session-2"),
        )
        self.assertEqual(claude.argv[-1], prompt)
        self.assertIsNone(claude.stdin_text)

        claude_stdin = build_adapter_command(
            "claude-code",
            "session-2",
            prompt,
            cli="/opt/claude",
            claude_prompt_stdin=True,
        )
        self.assertEqual(
            claude_stdin.argv,
            ("/opt/claude", "-p", "--resume", "session-2"),
        )
        self.assertEqual(claude_stdin.stdin_text, prompt)

        opencode = build_adapter_command("opencode", "session-3", prompt, cli="/opt/opencode")
        self.assertEqual(
            opencode.argv[:4],
            ("/opt/opencode", "run", "--session", "session-3"),
        )
        self.assertEqual(opencode.argv[-1], prompt)
        for command in (codex, claude, claude_stdin, opencode):
            self.assertFalse(command.inspection()["shell"])

    def test_execute_uses_argv_and_expected_stdin(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            cli = fake_cli(root)
            result = execute_review_package(
                review_package(),
                host="codex",
                session_id="session-1",
                cli=str(cli),
                cwd=root,
            )
            self.assertEqual(result["status"], "submitted", result)
            observed = json.loads(result["stdout"])
            self.assertEqual(observed["argv"][:4], ["exec", "resume", "session-1", "-"])
            self.assertIn('"submission_id": "SUB-20000101-001"', observed["stdin"])
            self.assertFalse(result["command"]["shell"])

    def test_cli_is_dry_run_unless_execute_is_explicit(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            package_path = root / "package.json"
            package_path.write_text(json.dumps(review_package()), encoding="utf-8")
            marker_cli = root / "must-not-run"
            marker_cli.write_text(
                "#!/bin/sh\n"
                f"touch '{root / 'executed'}'\n",
                encoding="utf-8",
            )
            marker_cli.chmod(0o755)
            completed = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "scripts/review_host_adapter.py"),
                    "--package",
                    str(package_path),
                    "--host",
                    "codex",
                    "--session-id",
                    "session-1",
                    "--cli",
                    str(marker_cli),
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(json.loads(completed.stdout)["status"], "dry-run")
            self.assertFalse((root / "executed").exists())


class BridgeHTTPTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.server = create_server(
            BridgeConfig(
                root=self.root,
                token=TOKEN,
                host="codex",
                port=0,
            )
        )
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.host, self.port = self.server.server_address[:2]

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temp.cleanup()

    def request(
        self,
        method: str,
        path: str,
        *,
        body: bytes | None = None,
        token: str | None = TOKEN,
        origin: str | None = "null",
        content_type: str | None = None,
        extra_headers: dict[str, str] | None = None,
    ) -> tuple[int, dict, dict[str, str]]:
        connection = http.client.HTTPConnection(self.host, self.port, timeout=3)
        headers: dict[str, str] = {}
        if token is not None:
            headers["Authorization"] = f"Bearer {token}"
        if origin is not None:
            headers["Origin"] = origin
        if content_type:
            headers["Content-Type"] = content_type
        if extra_headers:
            headers.update(extra_headers)
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        raw = response.read()
        result = json.loads(raw) if raw else {}
        response_headers = {key.lower(): value for key, value in response.getheaders()}
        connection.close()
        return response.status, result, response_headers

    def test_health_requires_token_and_reports_host(self) -> None:
        status, body, headers = self.request("GET", "/v1/health")
        self.assertEqual(status, 200)
        self.assertEqual(body, {"status": "ok", "host": "codex", "dispatch": False})
        self.assertEqual(headers["access-control-allow-origin"], "null")

        status, body, _ = self.request("GET", "/v1/health", token=None)
        self.assertEqual(status, 401)
        self.assertEqual(body["status"], "unauthorized")

    def test_cors_rejects_non_loopback_origin(self) -> None:
        status, body, headers = self.request(
            "GET",
            "/v1/health",
            origin="https://attacker.example",
        )
        self.assertEqual(status, 403)
        self.assertEqual(body["status"], "forbidden")
        self.assertNotIn("access-control-allow-origin", headers)

    def test_loopback_private_network_preflight_is_narrowly_allowed(self) -> None:
        status, body, headers = self.request(
            "OPTIONS",
            "/v1/reviews",
            token=None,
            origin="http://127.0.0.1:4173",
            extra_headers={
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Private-Network": "true",
            },
        )
        self.assertEqual(status, 204, body)
        self.assertEqual(headers["access-control-allow-origin"], "http://127.0.0.1:4173")
        self.assertEqual(headers["access-control-allow-private-network"], "true")

    def test_post_is_idempotent_and_conflicting_payload_is_rejected(self) -> None:
        package = review_package()
        payload = json.dumps(package).encode()
        status, body, _ = self.request(
            "POST",
            "/v1/reviews",
            body=payload,
            content_type="application/json",
        )
        self.assertEqual(status, 201, body)
        self.assertEqual(body["status"], "stored")
        self.assertEqual(body["submission_id"], package["submission_id"])
        self.assertEqual(body["host"], "codex")
        self.assertTrue((self.root / "inbox/SUB-20000101-001.json").exists())
        self.assertTrue((self.root / "receipts/SUB-20000101-001.json").exists())

        status, body, _ = self.request(
            "POST",
            "/v1/reviews",
            body=payload,
            content_type="application/json",
        )
        self.assertEqual(status, 200, body)
        self.assertTrue(body["idempotent"])

        conflict = json.dumps(review_package(content="不同内容")).encode()
        status, body, _ = self.request(
            "POST",
            "/v1/reviews",
            body=conflict,
            content_type="application/json",
        )
        self.assertEqual(status, 409, body)
        self.assertEqual(body["status"], "conflict")

    def test_size_limit_and_content_type_are_enforced(self) -> None:
        status, body, _ = self.request(
            "POST",
            "/v1/reviews",
            body=b"{}",
            content_type="text/plain",
        )
        self.assertEqual(status, 415)
        self.assertEqual(body["status"], "invalid")

        self.server.service.config = BridgeConfig(
            root=self.root,
            token=TOKEN,
            host="codex",
            port=0,
            max_bytes=10,
        ).validated()
        status, body, _ = self.request(
            "POST",
            "/v1/reviews",
            body=b'{"more":"than-ten"}',
            content_type="application/json",
        )
        self.assertEqual(status, 413)
        self.assertEqual(body["status"], "too-large")


class BridgeDispatchTests(unittest.TestCase):
    def test_dispatch_success_uses_only_server_configuration(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            cli = fake_cli(root)
            service = ReviewBridgeService(
                BridgeConfig(
                    root=root / "bridge",
                    token=TOKEN,
                    host="codex",
                    dispatch=DispatchConfig(
                        host="codex",
                        session_id="trusted-session",
                        cwd=root,
                        cli=str(cli),
                    ),
                )
            )
            package = review_package()
            # These untrusted extra keys must not influence the configured
            # process. They are retained as data, never treated as commands.
            package["host"] = "opencode"
            package["session_id"] = "untrusted"
            package["cwd"] = "/"
            package["cli"] = "/bin/false"
            status, body = service.submit(package)
            self.assertEqual(status, 201, body)
            self.assertEqual(body["status"], "submitted")
            receipt = json.loads(
                (root / "bridge/receipts/SUB-20000101-001.json").read_text()
            )
            command = receipt["dispatch"]["command"]
            self.assertEqual(command["host"], "codex")
            self.assertEqual(command["argv"][-3:], ["resume", "trusted-session", "-"])

    def test_dispatch_failure_preserves_inbox_and_receipt(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            cli = fake_cli(root, exit_code=7)
            service = ReviewBridgeService(
                BridgeConfig(
                    root=root / "bridge",
                    token=TOKEN,
                    host="codex",
                    dispatch=DispatchConfig(
                        host="codex",
                        session_id="trusted-session",
                        cwd=root,
                        cli=str(cli),
                    ),
                )
            )
            package = review_package()
            status, body = service.submit(package)
            self.assertEqual(status, 201)
            self.assertEqual(body["status"], "failed")
            self.assertTrue((root / "bridge/inbox/SUB-20000101-001.json").exists())
            receipt = json.loads(
                (root / "bridge/receipts/SUB-20000101-001.json").read_text()
            )
            self.assertEqual(receipt["status"], "dispatch_failed")
            self.assertEqual(receipt["dispatch"]["returncode"], 7)

            # A retry with the same id is idempotent and does not dispatch a
            # second time.
            status, retried = service.submit(package)
            self.assertEqual(status, 200)
            self.assertTrue(retried["idempotent"])
            self.assertEqual(retried["status"], "failed")

    def test_non_loopback_bind_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaisesRegex(ValueError, "loopback"):
                ReviewBridgeService(
                    BridgeConfig(
                        root=Path(temp),
                        token=TOKEN,
                        host="codex",
                        bind="0.0.0.0",
                    )
                )

    def test_invalid_dispatch_metadata_is_rejected_at_startup(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with self.assertRaisesRegex(ValueError, "session_id"):
                ReviewBridgeService(
                    BridgeConfig(
                        root=root / "bridge",
                        token=TOKEN,
                        host="codex",
                        dispatch=DispatchConfig(
                            host="codex",
                            session_id="bad session",
                            cwd=root,
                            cli=str(fake_cli(root)),
                        ),
                    )
                )


if __name__ == "__main__":
    unittest.main()
