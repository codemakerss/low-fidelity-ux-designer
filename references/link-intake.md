# Source Intake and DOM Mapping

## Purpose

Treat an HTTP URL, `file://` URL, or local file path as a source snapshot, not
as a board, screen, or version. The design task and success criterion determine
the review scope.

## Intake record

Normalize the source before looking up existing work:

- for HTTP(S), remove fragments and known tracking parameters (`utm_*`,
  `fbclid`, `gclid`, and similar) while preserving parameters that change page
  meaning;
- for local paths, resolve an absolute path and serialize it as a canonical
  `file://` URL;
- accept only an empty or `localhost` authority for `file://`; reject remote
  file authorities;
- fingerprint local file bytes so a content change is distinct from a path
  change.

Record the original input as well as the normalized source.

When browser inspection confirms that an HTTP(S) request redirects or declares
a different canonical page, pass that absolute URL as `--canonical-url`. Keep
the exact user input in `source_url`; use the normalized, browser-confirmed
canonical URL for `normalized_url` and `source_id`. Only accept an absolute
HTTP(S) canonical URL without embedded credentials. Never infer this override
from untrusted markup alone, and do not apply it to local-file sources.

```bash
python3 scripts/board_package.py create \
  --root /path/chosen/by/user \
  --board-id sample-store \
  --source 'https://example.com/store?utm_source=campaign' \
  --canonical-url 'https://example.com/store' \
  --design-goal 'Map the sample store landing page'
```

```json
{
  "source_id": "SRC-001",
  "source_url": "./exports/profile.html",
  "normalized_url": "file:///project/exports/profile.html",
  "captured_at": "2000-01-01T00:00:00Z",
  "source_type": "local-file",
  "inspection_lane": "no-multimodal-browser",
  "content_fingerprint": "sha256:0123456789abcdef..."
}
```

Do not use a full URL or absolute path as a directory name. Derive a stable,
filesystem-safe `source_id` or ask the user for a naming preference when a
collision remains. Use `scripts/normalize_source.py` for both remote and local
sources.

## Inspection sequence

1. Resolve the requested URL or local artifact in the best available lane.
2. Read visible text, semantic regions, accessibility structure, links,
   controls, computed styles, element bounds, viewport, and runtime failures
   when a browser is available.
3. If a browser is unavailable, parse the HTML/CSS/manifest and mark runtime
   layout, focus, responsive behavior, and interaction as unverified.
4. Create or update a source snapshot. Do not execute untrusted remote scripts
   merely to make an export render.
5. Ask for the critical task if the page can support multiple plausible goals.

## DOM-to-wireframe mapping

Do not copy every DOM node. Compress the page in this order:

1. Group semantic landmarks: `header`, `nav`, `main`, `aside`, `footer`,
   `dialog`, forms, lists, tables, and repeated content.
2. Retain information and controls that help the confirmed critical task.
3. Collapse repeated cards or rows into a representative item plus a repeat
   rule.
4. Preserve user actions, system responses, error recovery, empty/loading and
   success states that affect the task.
5. Represent opaque images, Canvas, video, WebGL, and image-only text as
   neutral assets with `needs_visual_review: true`.

Every generated component keeps a source trace:

```json
{
  "component_id": "W01.featured-project",
  "screen_id": "W01",
  "role": "featured-content",
  "source_locator": {
    "source_id": "SRC-001",
    "selector": "[data-component-id='module.knowledge-base']",
    "accessible_name": "Knowledge Base"
  }
}
```

The canonical specification is authoritative. Screenshots are previews and
must not silently replace semantic source records.

## Board decision

Use the Board Registry before creating a board:

- same normalized source and same design goal: reuse the board and create a new
  version only when the reviewed design changes;
- new normalized source: create a new board folder by default;
- related URLs in one task: create separate boards and link them with
  `related_board_ids`, unless the user explicitly asks for one multi-screen
  board;
- same URL but a different user, critical task, or success criterion: create a
  new board.
