# Review Board

## Contents

- Board contract
- Comment schema
- Review workflow
- Revision policy
- Versioning
- Browser and source inspection
- Failure handling

## Board contract

Use a review board when feedback depends on location, several screens must be compared, or an asynchronous revision record is useful. Reuse `assets/review-board/index.html` rather than rebuilding board mechanics.

The board must:

- display image, inline SVG, semantic HTML, and preformatted ASCII frames;
- expose stable `screen_id`, `component_id`, `design_version`, and comment pins;
- store draft comments locally without a server;
- export JSON as the authoritative feedback package;
- export Markdown for human review;
- export a self-contained HTML snapshot with the current manifest;
- preserve old design versions and comment dispositions;
- submit a framework-neutral Review Package to a detected host adapter when
  available, with copy/export fallback when it is not;
- connect a standalone `file://` or localhost board only to an authenticated
  loopback bridge explicitly configured by the user;
- remain usable without image understanding.

Replace the template's sample manifest and screen markup with the project data. Keep the template behavior and required IDs intact.

## Comment schema

Use this shape:

```json
{
  "comment_id": "C001",
  "screen_id": "W01",
  "component_id": "W01.search",
  "screen_version": "v1",
  "anchor": { "x_ratio": 0.62, "y_ratio": 0.35 },
  "category": "problem",
  "priority": "important",
  "content": "Allow users to search by symptom.",
  "status": "open",
  "created_at": "2000-01-01T00:00:00.000Z",
  "resolution": null
}
```

Allowed values:

- `category`: `problem`, `suggestion`, `question`, `approval`;
- `priority`: `blocking`, `important`, `later`;
- `status`: `open`, `accepted`, `needs-clarification`, `rejected`, `deferred`, `resolved`.

Prefer a semantic component target. Use the normalized coordinate as a durable visual fallback. Clamp ratios to 0 through 1. Do not store viewport pixels as the only anchor.

## Review workflow

1. Freeze the current canonical specification and render as an immutable design version.
2. Place each screen on the board and verify its manifest record and DOM identifier.
3. Let the reviewer select a screen or component, place a pin, choose category/priority, and write a comment.
4. Build a Review Package and submit it to the active host when supported;
   treat JSON as the authoritative fallback input and Markdown as a readable
   derivative.
5. Group comments by screen and component. Merge duplicates without losing comment IDs.
6. Detect contradictions, stale-version targets, unknown IDs, and comments that affect adjacent screens.
7. Assign a disposition and rationale to every comment.
8. Update the canonical specification and manifest, then rerender only affected screens plus dependent states.
9. Validate the critical flow and responsive behavior.
10. Publish a new version and link each resolved comment to the resulting version.

## Revision policy

Apply low-risk changes without confirmation when they preserve product meaning:

- correcting copy or labels;
- clarifying helper/error text;
- adjusting local order, spacing, or grouping;
- exposing a state already required by the canonical specification.

Confirm before applying changes that:

- alter the critical task, scope, permissions, navigation, or data requirements;
- add or remove a screen or irreversible action;
- conflict with another open comment or confirmed decision;
- depend on unsupported research claims;
- replace the meaning of a stable component ID.

Never interpret comment volume as user-research evidence.

## Versioning

Use immutable, monotonically increasing design versions such as `v1`, `v2`, and `v3`. Do not overwrite a version that has received comments. Keep stable IDs for semantically continuous screens/components and record removed IDs. Associate each resolution with `resolved_in_version`.

When importing comments from an older version, map by component ID first. If the target no longer exists, mark `needs-clarification`; do not guess from coordinates alone.
Keep historical comments visible in the current board's review-history list,
including their original `screen_version`; render a position pin only while
viewing the version the comment actually targets.

## Board folder and URL policy

Create one Board folder per new normalized URL or local source by default,
under the user- or project-selected storage root. A same-scope change uses a
new version in the existing folder. Related sources get separate folders and
`related_board_ids` unless the user explicitly requests one multi-screen Board. Read
[board-storage.md](board-storage.md) for path resolution and the registry.

## Host submission

The board should detect a host adapter in this order: an injected host API, an
explicitly configured authenticated loopback bridge, then standalone
copy/export. The loopback bridge dispatches to Codex, Claude Code, or OpenCode;
the browser never invokes a CLI itself.

Start and configure the bridge only through `scripts/review_bridge.py`. It must
bind to loopback, require a bearer token, validate and size-limit the Review
Package, store it idempotently, and use argv-based subprocess calls without a
shell. Enter the printed URL and the startup-configured token through the
board's **Connect host** dialog; never embed the token in HTML, the Manifest,
exports, or local draft storage.

Submission state is separate from comment disposition: `submitted` is not
`resolved` until the revision is validated. A `stored` response means the
package was safely preserved in the bridge inbox but was not sent to a model
session.

## Browser and source inspection

Use browser inspection to validate runtime truth without image understanding. Inspect semantic elements, accessibility structure, computed styles, bounding boxes, viewport, focus movement, and interaction results. Use the asset manifest rather than pixel inference for images, Canvas, video, and WebGL.

When browser inspection is unavailable, statically validate the HTML and manifest. State that computed layout, responsive rendering, focus, and interactions remain unverified.

## Failure handling

- **Missing or invalid manifest**: stop automated revision, report the parse error, and reconstruct only from trustworthy semantic HTML when possible.
- **Unknown screen/component ID**: retain the comment and mark it `needs-clarification`.
- **External dependency failure**: record the dependency; do not download or execute an untrusted replacement.
- **Opaque iframe**: require a local/source-accessible representation or treat it as an asset needing visual review.
- **Canvas/image-only UI**: preserve the artifact, require descriptive asset metadata, and avoid semantic modification claims.
- **Conflicting comments**: summarize the conflict and request a decision before rendering.
- **Local storage unavailable**: keep the in-memory session and prompt the reviewer to export before closing.
- **Bridge unavailable or unauthorized**: keep the draft, show the exact
  fallback reason, and offer copy/export; never retry with arbitrary endpoints.
