# Host Adapters

## Boundary

The review board collects comments and builds a `ReviewPackage`. A host adapter
delivers that package to one explicitly configured AI session. The board
remains framework-agnostic and never receives a shell command, executable path,
working directory, or session ID from page data.

```ts
interface ReviewHostAdapter {
  id: "codex" | "claude-code" | "opencode" | "standalone";
  detect(): Promise<boolean>;
  capabilities(): {
    direct_submit: boolean;
    file_submit: boolean;
    channel_submit: boolean;
    clipboard_fallback: boolean;
    export_fallback: boolean;
  };
  submitReviewPackage(pkg: ReviewPackage): Promise<{
    status: "stored" | "submitted" | "failed" | "conflict";
    submission_id: string;
    message?: string;
  }>;
}
```

## ReviewPackage

Every adapter receives the same package. Do not put tokens, cookies, browser
profiles, or credentials in it.

```json
{
  "submission_id": "SUB-20000101-001",
  "board_id": "sample-project-review",
  "design_version": "v1",
  "source_ids": ["SRC-001"],
  "comments": [],
  "processing_policy": {
    "low_risk": "apply",
    "high_impact": "ask_confirmation",
    "preserve_old_versions": true
  }
}
```

Track `draft`, `ready_to_submit`, `submitted`, `processing`, and final
dispositions separately. A submitted comment is not resolved until the model's
revision is validated.

## Delivery order

1. Use `window.openai.sendFollowUpMessage` only when the trusted host injects it.
2. Use `window.reviewBoardHost.submit(package)` only when a trusted integration
   injects that interface.
3. Use the authenticated loopback bridge configured through **Connect host**.
4. Otherwise copy the package or export JSON. JSON remains the durable fallback.

A standalone `file://` page cannot discover which terminal or conversation the
user means by “current host.” The bridge must be started with an explicit host
and session ID. Queue-only mode proves receipt but does not claim model delivery.

## Host-native discovery assets

Install project-local entry points without calling any host CLI:

```bash
python3 scripts/install_host_adapters.py \
  --project-root <project-root> \
  --host codex|claude-code|opencode|all
```

This creates:

```text
Codex        .agents/skills/review-board/SKILL.md
Claude Code  .claude/skills/review-board/SKILL.md
OpenCode     .opencode/commands/review-board.md
```

Existing files are never overwritten unless `--force` is explicit. These
assets process a ReviewPackage path, apply the risk policy, update the
canonical specification and Manifest, then call `board_package.py version`.

## Direct CLI adapter

`review_host_adapter.py` is a host-neutral dispatcher. It validates the package
and prints a safe command description by default; it runs a process only when
`--execute` is present:

```bash
python3 scripts/review_host_adapter.py \
  --package <review-package.json> \
  --host codex|claude-code|opencode \
  --session-id <session-id> \
  --cli <trusted-cli-path> \
  --cwd <project-root> \
  --execute
```

The implemented resume forms are:

```text
Codex        codex exec resume <session-id> -
Claude Code  claude -p --resume <session-id> <prompt>
OpenCode     opencode run --session <session-id> <prompt>
```

Codex receives the prompt over stdin. Claude can also receive it over stdin
with `--claude-prompt-stdin`. Commands are argument vectors with `shell=False`;
package fields cannot add arguments.

## Authenticated loopback bridge

The bridge lets the board submit without manual export. Prefer a token file or
the `REVIEW_BRIDGE_TOKEN` environment variable so the token is not exposed in a
process argument:

```bash
python3 scripts/review_bridge.py \
  --root <bridge-state-root> \
  --host codex \
  --token-file <token-file>
```

This is queue-only mode. It stores packages under `inbox/` and receipts under
`receipts/`, then returns `stored`. To dispatch to the configured session:

```bash
python3 scripts/review_bridge.py \
  --root <bridge-state-root> \
  --host codex \
  --token-file <token-file> \
  --dispatch \
  --session-id <session-id> \
  --cwd <project-root> \
  --cli <trusted-cli-path>
```

The server defaults to `http://127.0.0.1:8768`. Enter that URL and the token in
the board's **Connect host** dialog. The token is kept only in page memory: it
must not enter the Manifest, HTML export, ReviewPackage, or local draft.

The bridge exposes only authenticated `GET /v1/health` and
`POST /v1/reviews`, accepts `null` or loopback origins, limits payload size,
stores before dispatch, and sanitizes its browser response. Full CLI output is
available only in the local receipt.

## Failure and retry

- Generate an idempotent `submission_id` before sending.
- Reuse the same ID when retrying the same board/version/comment payload.
- Mark `stored` when the bridge preserved the package without model dispatch.
- Mark `submitted` only after the host CLI exits successfully.
- On bridge failure, keep the local draft and fall back without deleting it.
- A repeated ID plus identical payload is idempotent; the same ID plus different
  content is a conflict.
- Show the active host and fallback reason in the board UI.
