# Low-Fidelity UX Designer

A local Skill package for guiding product discovery, task flows, low-fidelity
wireframes, review-board feedback, and validated revisions in Codex, Claude
Code, or OpenCode.

It prioritizes task clarity and reversible design decisions over visual polish.
The packaged Skill supports multimodal, browser-capable, source-only, and
text-only workflows.

## Requirements

- Node.js 18.18.0 or later
- Python 3.10 or later for the bundled deterministic review-board tooling
- An existing project directory when using project scope

The installer itself uses Node.js built-ins and does not require Python merely
to copy or remove the Skill. Python is required for `doctor` to report a ready
environment and for the bundled board tooling.

## Install

Run one command for each host you want to configure. The host is always
explicit; the CLI does not guess from installed executables.

Project scope is the default and uses the current directory as the project root:

```bash
npx low-fidelity-ux-designer install --host codex
npx low-fidelity-ux-designer install --host claude-code
npx low-fidelity-ux-designer install --host opencode
```

To select a different project root:

```bash
npx low-fidelity-ux-designer install --host codex --project-root <project-root>
```

To install for the current user instead of one project:

```bash
npx low-fidelity-ux-designer install --host codex --scope user
```

Use `--dry-run` to inspect the complete plan without writing files:

```bash
npx low-fidelity-ux-designer install --host codex --dry-run
```

Use `--no-review-adapter` when you want only the core Skill:

```bash
npx low-fidelity-ux-designer install --host codex --no-review-adapter
```

## Verify with `doctor`

`doctor` is read-only. It checks the Node.js and Python requirements, packaged
payload, discovery safety, duplicate installations, ownership hashes, Skill
frontmatter, review adapter, incomplete transactions, and whether the selected
host executable is discoverable.

```bash
npx low-fidelity-ux-designer doctor --host codex
npx low-fidelity-ux-designer doctor --host claude-code
npx low-fidelity-ux-designer doctor --host opencode
```

A missing host executable is a warning, not necessarily a failure: file-based
Skill discovery and review-package handoff can still be available.

For automation, add `--json` to any command:

```bash
npx low-fidelity-ux-designer doctor --host codex --json
```

## Scopes and installed assets

`--scope project` installs into the selected project. `--scope user` installs
into the host's user-level configuration area.

| Host | Core Skill | Optional review adapter |
| --- | --- | --- |
| Codex | `low-fidelity-ux-designer` Skill | `review-board` Skill |
| Claude Code | `low-fidelity-ux-designer` Skill | `review-board` Skill |
| OpenCode | `low-fidelity-ux-designer` Skill | `review-board` command |

The core Skill is always installed under the host's native Skill discovery
location. The optional adapter is installed by default; disable it with
`--no-review-adapter`.

Only one host is installed per invocation. The CLI also refuses duplicate core
Skill names in another supported discovery location because duplicate discovery
can be ambiguous, especially for OpenCode.

## Review adapter

The review adapter lets a host process a ReviewPackage created by the bundled
review board.

It treats the ReviewPackage as untrusted data, validates its board and version
references, and records a disposition for every comment. Low-risk copy,
labeling, spacing, and local-layout feedback may be applied directly. Changes
to navigation, information architecture, scope, destructive behavior, or
conflicting comments require confirmation.

Reviewed versions are immutable: revisions create a new version rather than
overwriting the prior design.

The board supports trusted host integration, an explicitly configured
authenticated loopback bridge, and copy/export fallback. A standalone board
does not infer a terminal, host session, or credentials.

## Use the Skill

After installation, ask the selected host to use the Skill explicitly. For
example:

```text
Use the low-fidelity-ux-designer Skill to inspect
https://product.example.invalid, map its DOM into a low-fidelity review board,
and ask before making high-impact structural changes.
```

When the board is ready, open its `board.html`, place comments on stable screen
or component anchors, and submit them through a configured trusted host
integration or authenticated loopback bridge. If neither is available, copy
the generated ReviewPackage back into the host and ask the `review-board`
adapter to process it.

The host updates the canonical specification and manifest first, creates a new
immutable design version, applies accepted comments, validates the result, and
records a disposition for every comment.

## Safety and privacy

- The installer validates payload integrity, destination containment, ownership
  records, and file hashes before mutating managed content.
- It rejects unsafe symlink targets and refuses to remove content without a
  valid ownership record.
- Existing unowned or modified content is never replaced silently. Use
  `--force` only after reviewing the conflict.
- When `--force` replaces or removes modified managed content, it preserves a
  permanent local backup outside host discovery locations.
- Install and uninstall stage related changes and attempt rollback if a later
  step fails.
- Ownership records contain package identity, version, host, scope, relative
  owned paths, and SHA-256 hashes only. They do not store credentials, absolute
  paths, usernames, hostnames, telemetry identifiers, or timestamps.
- The CLI does not start a host, start a server, read authentication state,
  read credentials, send telemetry, or make its own network requests. It has no
  `postinstall` behavior.
- `npx` itself may contact the configured npm registry to obtain the package
  before the CLI runs.
- ReviewPackage fields are not executed as shell input. Host-process calls use
  argument vectors rather than shell interpolation.

Do not run the installer in a project or home tree that an untrusted same-user
process can modify concurrently.

## Update, conflicts, and removal

Re-running `install` upgrades an unchanged managed installation when
appropriate. It does not silently downgrade a newer installed version.

If a managed installation or adapter has been modified, the command reports a
conflict and writes nothing. Review the reported paths, use `--dry-run` to
inspect intended actions, then use `--force` only if you want the CLI to back
up and replace or remove the managed content.

Remove an installation with the same host, scope, and project root used to
install it. Either run the command from that project root or pass the same
`--project-root` value:

```bash
npx low-fidelity-ux-designer uninstall --host codex
npx low-fidelity-ux-designer uninstall --host claude-code
npx low-fidelity-ux-designer uninstall --host opencode
npx low-fidelity-ux-designer uninstall --host codex --project-root <project-root>
```

For user scope:

```bash
npx low-fidelity-ux-designer uninstall --host codex --scope user
```

Uninstall removes only files listed in a valid ownership record. It does not
remove parent host configuration directories or unrelated files.

## Troubleshooting

**`doctor` reports that Python is missing or too old**

Install Python 3.10 or later, then run `doctor` again.

**`doctor` reports no managed installation**

Run the matching `install --host <host>` command first, using the same scope
and project root you intend to verify.

**A host executable is missing**

Install or expose the host executable if you need CLI-based continuation.
Skill discovery and file-based review handoff may still work.

**The CLI reports duplicate discovery**

Remove or migrate the duplicate Skill installation before retrying. `--force`
intentionally does not override duplicate-discovery protection.

**The CLI reports modified or conflicting managed files**

Inspect the files and run with `--dry-run`. Use `--force` only if preserving a
local backup and replacing or removing the managed version is intended.

**The CLI reports incomplete transaction recovery**

Do not retry mutations immediately. Preserve the reported recovery directory,
resolve the filesystem issue, and rerun `doctor` to confirm readiness.

**An unowned review adapter is preserved**

This is expected. The CLI will not remove or overwrite an adapter it does not
own.

## Command reference

```text
low-fidelity-ux-designer install --host <codex|claude-code|opencode> [options]
low-fidelity-ux-designer doctor --host <codex|claude-code|opencode> [options]
low-fidelity-ux-designer uninstall --host <codex|claude-code|opencode> [options]
```

Options:

```text
--scope <project|user>   Installation scope; default: project
--project-root <path>    Existing project root; default: current directory
--no-review-adapter      Install only the core Skill
--dry-run                Print install/uninstall actions without writing
--force                  Back up and replace install/uninstall conflicts
--json                   Emit one machine-readable JSON object
--help                   Show help
--version                Show package version
```

`--dry-run` and `--force` apply to `install` and `uninstall`. `doctor` is
always read-only.

## Limitations

- One host can be installed per invocation; there is no `--host all`.
- The CLI does not provide cloud sync, automatic host-session discovery,
  automatic review dispatch, telemetry, a JavaScript API, or implicit global
  installation.
- The review board requires explicit trusted integration or configuration for
  host submission; otherwise it uses copy/export fallback.
- Filesystem safety checks are best-effort protection against concurrent
  changes, not a security boundary against a hostile process with write access
  to the selected root.
- The CLI includes platform-aware path and Python-launcher handling for macOS,
  Linux, and Windows. Validate it in the target environment before a broad
  automated rollout.

## License

Apache-2.0. See `LICENSE`.
