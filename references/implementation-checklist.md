# Implementation Checklist

Use this checklist when turning a URL or product idea into a reviewable
low-fidelity board and when revising it from feedback.

## Intake and scope

- [ ] Normalize the HTTP(S) URL or canonicalize a local path/`file://` source;
  remove fragments/tracking parameters and fingerprint local file bytes.
- [ ] Record a Source with original URL, normalized URL, capture time, lane,
  and optional content fingerprint.
- [ ] Confirm the design goal, primary task, user, success signal, and page
  scope before deciding whether a board can be reused.
- [ ] Compress the page into task-relevant landmarks, semantic components,
  states, actions, and recovery paths; mark opaque visual content as
  `needs_visual_review`.

## Board path and identity

- [ ] Resolve the storage root in this order: explicit user path, project
  convention, existing Board Registry, then ask the user.
- [ ] Never silently create a fixed `boards/` directory or write user output
  into the Skill's `assets/` directory.
- [ ] Query the Registry before writing. Same normalized URL + same scope may
  reuse a Board; a new normalized URL gets a new Board folder by default.
- [ ] Keep related URLs as separate Boards linked by `related_board_ids`,
  unless the user explicitly chooses a shared scope.
- [ ] Store `source.json`, `board.html`, `manifest.json`, `versions/`, and
  `feedback/` under the selected Board path.
- [ ] Use `board_package.py create` for the initial package and
  `board_package.py version` for immutable revisions and Registry updates.
- [ ] Treat reviewed versions as immutable; create `v2`, `v3`, etc. and keep
  old comments/history inspectable.

## Rendering and inspection

- [ ] Use semantic HTML/SVG/ASCII with stable `screen_id` and
  `component_id` attributes.
- [ ] Embed the Design Manifest with tokens, screens, components,
  interactions, states, assets, sources, comments, and submissions.
- [ ] Select the capability lane explicitly:
  - [ ] multimodal + browser: visual, DOM, accessibility, style, and flow
    checks;
  - [ ] no multimodal + browser: DOM, accessibility, computed style, bounds,
    and interaction checks;
  - [ ] no browser: static HTML/CSS/Manifest parsing with runtime marked
    unverified;
  - [ ] text only: canonical specification, structured comments, Mermaid, and
    ASCII with visual/runtime limitations stated.
- [ ] Do not put critical content only on Canvas or in an unparseable image.

## Comment and revision loop

- [ ] Bind each comment to `comment_id`, `screen_id`, `component_id`, relative
  coordinates, page version, category, priority, content, status, and
  resolution.
- [ ] Preserve local drafts and merge imported feedback by `comment_id`.
- [ ] Mark comments targeting unknown IDs or old versions as
  `needs-clarification`; never guess from coordinates alone.
- [ ] Apply low-risk local changes directly; confirm high-impact flow,
  navigation, destructive, scope, or conflicting changes first.
- [ ] Update the canonical specification and manifest before HTML/CSS/behavior,
  then reload and re-run the affected task flow.

## Host adapter and fallback

- [ ] Build one framework-neutral Review Package with board/version/source IDs,
  comments, manifest snapshot, and processing policy.
- [ ] Install host-native assets with `install_host_adapters.py` when the
  project should expose a Codex `review-board` Skill, Claude Code
  `/review-board` Skill, or OpenCode `/review-board` command.
- [ ] Detect and use adapters in this order: injected host API, authenticated
  loopback bridge, then standalone copy/export.
- [ ] For one-click standalone-board submission, start `review_bridge.py` with
  an explicit root, host, and token; dispatch mode additionally requires an
  explicit session ID, working directory, and CLI path. Verify `/v1/health`
  before submitting.
- [ ] Dispatch through the documented CLI form: `codex exec resume`,
  `claude -p --resume`, or `opencode run --session`; never use `shell=True`.
- [ ] Keep submission state separate from comment disposition; generate an
  idempotent `submission_id` and preserve drafts on failure.
- [ ] Never let a browser page execute arbitrary shell commands. Bridges must
  be explicitly enabled, loopback-bound, path-validated, authenticated, and
  structured.
- [ ] After host processing, record every comment as accepted, resolved,
  needs-clarification, rejected, or deferred and create a new version.

## Regression gates

- [ ] Run `python3 -m unittest discover -s tests -v`.
- [ ] Run `python3 scripts/validate_review_board.py <board.html>`.
- [ ] Run `python3 scripts/normalize_source.py <url>` for URL intake checks.
- [ ] Run bridge tests in queue-only and fake-CLI dispatch modes; never send a
  regression package into a real user session.
- [ ] Open the board in a local browser when available; verify DOM/ARIA,
  comment placement, local draft persistence, host status, and fallback.
- [ ] If browser validation fails, report the exact unverified runtime checks
  and retain the static validation result.
