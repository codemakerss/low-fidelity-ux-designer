# npx CLI Contract

This document fixes the public CLI behavior for `low-fidelity-ux-designer`
version `0.1.0`. Implementation and tests must conform to this contract.

## Commands

```text
low-fidelity-ux-designer install --host <host> [options]
low-fidelity-ux-designer doctor --host <host> [options]
low-fidelity-ux-designer uninstall --host <host> [options]
low-fidelity-ux-designer --help
low-fidelity-ux-designer --version
```

Running without a command prints help and makes no changes.

Supported host values are `codex`, `claude-code`, and `opencode`. The host is
always explicit; the CLI must not guess from installed executables.

## Options

```text
--scope <project|user>   Installation scope; default: project
--project-root <path>    Existing project root; default: current directory
--no-review-adapter      Install only the core Skill
--dry-run                Print the complete action plan without writing
--json                   Emit stable machine-readable output
--force                  Back up and replace modified or conflicting targets
```

`--project-root` is valid only for project scope. User scope resolves from the
operating-system home directory. Custom discovery roots are out of scope for
`0.1.0`.

`--dry-run` applies to `install` and `uninstall`. `doctor` is always read-only.
`--force` applies only to `install` and `uninstall`.
`--no-review-adapter` applies only to `install`. `--scope`, `--project-root`,
and `--json` apply to all three commands.

## Discovery targets

The Skill directory name is always `low-fidelity-ux-designer`.

| Host | Project core Skill | User core Skill |
| --- | --- | --- |
| Codex | `.agents/skills/low-fidelity-ux-designer/` | `~/.agents/skills/low-fidelity-ux-designer/` |
| Claude Code | `.claude/skills/low-fidelity-ux-designer/` | `~/.claude/skills/low-fidelity-ux-designer/` |
| OpenCode | `.opencode/skills/low-fidelity-ux-designer/` | `~/.config/opencode/skills/low-fidelity-ux-designer/` |

Unless `--no-review-adapter` is passed, also install:

| Host | Project review adapter | User review adapter |
| --- | --- | --- |
| Codex | `.agents/skills/review-board/SKILL.md` | `~/.agents/skills/review-board/SKILL.md` |
| Claude Code | `.claude/skills/review-board/SKILL.md` | `~/.claude/skills/review-board/SKILL.md` |
| OpenCode | `.opencode/commands/review-board.md` | `~/.config/opencode/commands/review-board.md` |

Version `0.1.0` installs one host per invocation. Users may run separate
commands for separate project roots or scopes. Within one scope, the CLI must
refuse when the same Skill name exists in another supported discovery location;
`--force` does not bypass this refusal. It must not offer `--host all`:
OpenCode scans its native, Claude-compatible, and agent-compatible Skill
locations, so installing all native copies would create ambiguous duplicate
discovery.

## Published payload

The package owns this source layout:

```text
bin/                                  npm executable
lib/                                  dependency-free Node.js implementation
skill/low-fidelity-ux-designer/
  SKILL.md
  LICENSE
  agents/
  assets/
  references/
  scripts/
```

The package excludes repository tests, example sites, build output, caches,
credentials, deployment metadata, and local paths. The npm README stays at the
package root and is not copied into the Skill directory.

## Install behavior

1. Validate arguments, package payload integrity, destination containment, and
   every requested host before writing.
2. Require an existing project root for project scope.
3. Canonicalize the selected project or home root, refuse an existing target
   that is itself a symlink, and reject any resolved target outside that root.
4. Stage the core Skill and optional review adapter before committing changes.
5. Treat the core Skill and adapter as one operation: roll back both if either
   target fails.
6. Write a hidden ownership record inside each installed core Skill:
   `.low-fidelity-ux-designer-install.json`.
7. Store only package identity, version, host, scope, relative owned paths, and
   SHA-256 hashes in that record. Do not store credentials, absolute paths,
   usernames, hostnames, telemetry identifiers, or timestamps.
8. Accept the ownership record only as a regular file no larger than 1 MiB.
   Symlinks, directories, FIFOs, other special files, and oversized records
   are invalid ownership and must never authorize removal.

An absent destination is installed. An owned installation with identical
content is a successful no-op. An older owned installation is upgraded without
`--force` only when all recorded files still match their hashes.
An installed version newer than the running package is never silently
downgraded. A newer version or same-version payload drift requires `--force`;
the complete existing installation is permanently backed up first.
On an existing managed installation, `--no-review-adapter` declares the desired
state and removes an unchanged owned adapter in the same transaction. A
modified owned adapter remains a conflict and requires `--force`, which backs
it up before removal.

An adapter that is present but not listed in the ownership record is outside
the package's ownership. Core-only install or uninstall preserves it and emits
an `unmanaged_adapter_preserved` warning.

Rendered adapters must remain safe to commit: use `<project-root>` for project
scope or `<user-home>` for user scope plus the host-relative discovery path.
Never persist the resolved absolute Skill path in an adapter. The host resolves
the placeholder through its trusted filesystem context and passes each path as
an argument rather than executing placeholder or ReviewPackage text.

Any requested target that is unowned or locally modified is a replaceable
conflict. Without `--force`, report every conflict and write nothing. With
`--force`, move each conflicting target into a backup root that host discovery
does not scan:
`<project-root>/.low-fidelity-ux-designer/backups/<random-id>/` for project
scope or `~/.low-fidelity-ux-designer/backups/<random-id>/` for user scope.
Install the new content and report every backup path. Never upload or delete a
backup automatically.

The installer must not run a host CLI, start a server, connect to the network,
read credentials, or use `postinstall`.

Immediately after moving managed content into transaction storage, the CLI
revalidates the ownership snapshot, exact inventory, and hashes before any
temporary copy is deleted. A concurrent change aborts and rolls back the
operation. If rollback is incomplete, transaction cleanup stops and the
`rollback_failed` error reports the preserved recovery directory.
If rollback succeeds but later transaction cleanup fails, `cleanup_failed`
reports the same recovery details instead of silently leaving blocking state.
Later install or uninstall commands refuse to mutate that root until the
incomplete transaction is recovered. `doctor` reports the recovery state as a
failed readiness check. Intentional permanent backups do not block later
operations.

Every portable filesystem mutation is surrounded by root-containment,
ancestor-identity, endpoint, and postcondition checks. If an ancestor changes
or a mutation result cannot be verified, the CLI stops without attempting
further rollback or cleanup, reports `path_identity_changed`, and preserves
available transaction state for recovery.

This is a best-effort concurrency boundary, not protection against a hostile
same-user process that can rewrite the selected root during the final interval
between a check and the operating-system call. Node.js 18 has no portable
descriptor-relative rename, copy, or removal API. Do not run the installer in
a project or home tree that is concurrently writable by an untrusted process.

## Doctor behavior

`doctor` checks:

- Node.js satisfies the package engine;
- Python 3.10 or newer is available through a platform-appropriate executable;
- requested discovery paths are valid and not unsafe symlinks;
- duplicate Skill names are not present in other supported discovery paths;
- the ownership record, installed file hashes, `SKILL.md` frontmatter, and
  rendered review adapter are valid;
- optional Codex, Claude Code, or OpenCode executables are discoverable.

Missing Python, corrupt payload, invalid discovery state, or hash mismatch makes
the installation not ready. A missing host executable is a warning because
Skill discovery and file-based ReviewPackage handoff can still work.

`doctor` never edits files, starts a host, reads authentication state, or sends
network requests.

## Uninstall behavior

Uninstall only paths listed in a valid ownership record. Without a valid
record, refuse to remove the core Skill even with `--force`.
If neither the core Skill nor the review adapter exists, report a successful
no-op. If an adapter exists without the core ownership record, refuse removal.

If owned files are unchanged, remove the rendered adapter and core Skill as one
transaction with rollback. This is not a claim of crash-level filesystem
atomicity. If owned files were modified, refuse without `--force`; with
`--force`, use the same non-discoverable backup roots as installation before
removal. Never remove parent host configuration directories or unrelated
files.

## Output and failures

Human-readable output is the default. With `--json`, stdout contains one JSON
object with:

```json
{
  "ok": true,
  "command": "install",
  "package": "low-fidelity-ux-designer",
  "version": "0.1.0",
  "host": "codex",
  "scope": "project",
  "dry_run": false,
  "actions": [],
  "warnings": []
}
```

Diagnostics go to stderr. Exit codes are:

- `0`: success, safe no-op, or ready `doctor` result;
- `1`: runtime, integrity, rollback, or readiness failure;
- `2`: invalid CLI usage;
- `3`: conflict or safety refusal.

With `--json`, failures use the same envelope with `"ok": false` and add:

```json
{
  "error": {
    "code": "conflict",
    "message": "Safe, non-sensitive summary",
    "details": {}
  }
}
```

Never include file contents, credentials, tokens, or environment variables in
output. Paths may be reported locally because the user explicitly selected the
installation destination.

## Compatibility and non-goals

Use only Node.js built-ins in the CLI. Run child processes with argument arrays
and `shell: false`. Support macOS, Linux, and Windows path semantics.

Python remains a runtime requirement for deterministic board tooling, but the
npx installer itself must not require Python to copy or remove files.

Version `0.1.0` does not provide cloud sync, automatic host-session discovery,
automatic review dispatch, package telemetry, a JavaScript API, or implicit
global installation.

## Authoritative host references

- Codex Skills: <https://developers.openai.com/codex/skills>
- Claude Code Skills: <https://code.claude.com/docs/en/skills>
- OpenCode Agent Skills: <https://opencode.ai/docs/skills>
- OpenCode Commands: <https://opencode.ai/docs/commands>
