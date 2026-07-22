# Rendering Lanes

## Contents

- Canonical specification
- Image-generation lane
- Code-native lane
- Machine-readable HTML contract
- Browser inspection lane
- Source-only fallback
- Text lane
- Cross-lane consistency

## Canonical specification

Write this before rendering any frame:

```yaml
screen_id: W01
name: Descriptive screen name
viewport: mobile 390x844 | desktop 1440x900 | responsive
user_intent: What the user is trying to decide or do
entry: Where they came from
regions:
  - order: 1
    role: header | navigation | main | aside | footer | dialog
    content: Visible, realistic labels and values
primary_action: Label -> destination/system response
secondary_actions: []
states: [default, loading, empty, error, success]
annotations: [A1, S1, V1]
responsive_rules: []
```

The specification is authoritative. Update it before rerendering after a decision change.

## Image-generation lane

Compose prompts from the canonical specification. Include:

- “low-fidelity UX wireframe, grayscale, hand-sketched or clean schematic”;
- exact number and order of frames;
- platform and viewport;
- regions and short visible labels;
- primary action and important states;
- annotation markers placed at frame edges;
- prohibitions: no color palette, branding, photography, gradients, shadows, device mockup scenery, or high-fidelity decoration.

Example prompt skeleton:

```text
Create a grayscale low-fidelity UX wireframe contact sheet for [product/task].
Show exactly [N] frames left to right: [IDs and names].
Use simple boxes, system-type labels, strong hierarchy, and generous annotation margins.
[Paste concise region/action/state specifications.]
Keep all visible labels short and legible. Mark interactions with A1... and states with S1....
No branding, color, photos, gradients, shadows, textures, marketing polish, or decorative device scene.
```

Image generators often distort text. Keep copy short and provide an exact transcript below the image. If exact content is central to evaluation, use the code-native lane instead.

## Code-native lane

Prefer standalone HTML/CSS for multi-screen, responsive, or clickable artifacts. Prefer SVG for a fixed board or when a single portable image is desired.

Use these minimal tokens:

```css
:root {
  --paper: #fff;
  --ink: #222;
  --muted: #6b6b6b;
  --line: #9a9a9a;
  --fill: #ececec;
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 16px;
  --space-4: 24px;
  --space-5: 32px;
}
```

Include a legend, screen IDs, annotations, and non-default states. If adding click behavior, keep it limited to the critical flow and visibly label it as a prototype. Do not add libraries solely for aesthetics.

For reviewable HTML, start from `assets/review-board/index.html` and follow the machine-readable contract below.

## Machine-readable HTML contract

Treat semantic HTML, the canonical specification, and the embedded Design Manifest as the source of truth. A screenshot is a human preview, not the machine interface.

Use stable identifiers on visible design elements:

```html
<section data-screen-id="W01" data-screen-version="v1">
  <form data-component-id="W01.search" data-state="default">
    <label for="search">Search services</label>
    <input id="search" name="search">
  </form>
</section>
```

Keep an ID stable across revisions when the element keeps the same product meaning. Mint a new ID when meaning changes. Never reuse a removed ID for a different element.

Embed one JSON manifest:

```html
<script type="application/json" id="design-manifest">
{
  "schema_version": "1.0",
  "board_id": "example-flow",
  "design_version": "v1",
  "versions": [{ "version": "v1", "label": "v1" }],
  "sources": [],
  "tokens": {},
  "screens": [],
  "components": [],
  "interactions": [],
  "states": [],
  "assets": [],
  "submissions": [],
  "comments": []
}
</script>
```

Requirements:

- Keep a `sources` record with original and normalized URL, capture time,
  inspection lane, and a semantic content fingerprint.
- Use semantic controls and native labels. Do not flatten essential UI into Canvas, an unannotated image, or inaccessible SVG paths.
- Keep critical CSS and scripts local or inline for a self-contained export. Record unavoidable external dependencies.
- Apply a restrictive CSP. Permit `connect-src` only for explicit loopback
  bridge URLs; do not permit arbitrary network destinations.
- Historical version entries may use a relative
  `versions/vN/review.html` href. Reject absolute or non-version paths in the
  board UI.
- Describe every non-decorative image with `asset_id`, purpose, alternative text, crop/fit rule, and `needs_visual_review`. Set `needs_visual_review: true` when correctness depends on pixel content a non-multimodal model cannot inspect.
- Define default, loading, empty, error, success, permission, and destructive states when relevant. Connect triggers and outcomes through `interactions`.
- Keep manifest comments and DOM comment pins synchronized by `comment_id`.
- Store comment anchors as normalized `x_ratio` and `y_ratio` from 0 through 1, plus `component_id` when a semantic target exists.
- Record `source_locator` on generated components when a component came from an
  inspected page. Prefer stable selectors, accessible names, and source IDs;
  do not use a guessed pixel location as the only mapping.

## Browser inspection lane

Use browser inspection when available, even without multimodal image understanding:

1. Open the export with `file://` only when all resources and behavior work there. Otherwise serve the export from a temporary local static server.
2. Read the DOM or accessibility tree, visible text, computed styles, element bounding boxes, current viewport, and console/runtime failures.
3. Verify each manifest screen and component has a matching DOM identifier. Flag orphan DOM nodes and stale manifest records.
4. Execute the critical flow: navigation, input, submit, back/cancel, validation, error recovery, and success.
5. Repeat at the required responsive widths and check clipping, overflow, focus order, and target visibility.
6. Map comments to `screen_id` and `component_id`; use coordinates only as a fallback locator.
7. Update the canonical specification and manifest before modifying the rendering.
8. Reload and retest affected screens. Record the viewports and scenarios actually verified.

Do not claim to understand the content, quality, or crop of opaque image, Canvas, video, or WebGL pixels. Use the asset record and mark unresolved visual questions for human or multimodal review.

## Source-only fallback

When no browser is available, parse the HTML, CSS, scripts, and embedded manifest. Verify identifier uniqueness, manifest/DOM correspondence, asset metadata, internal routes, declared states, and comment targets. Do not claim computed layout, focus behavior, responsive rendering, or interaction execution was verified. Include these limitations in the handoff.

## Text lane

Use ASCII frames for up to roughly five critical screens. Example:

```text
W01 Search
+----------------------------------+
| Product                   [Help] |
|----------------------------------|
| Find a service                   |
| [ Search by name or need...    ] |
| [ Search ] A1                    |
|                                  |
| Recent searches                  |
| Delivery status              >   |
+----------------------------------+
A1 -> W02 Results; Enter also submits.
```

Keep nesting shallow. Use `[ ]` for fields, `[ Action ]` for buttons, `( )` for radio controls, `[x]` for selected checks, `>` for navigation, and `...` only for deliberate truncation.

## Cross-lane consistency

When switching lanes, preserve screen IDs, component IDs, action labels, annotation IDs, comment IDs, state names, version history, and flow order. A rendering limitation must not silently alter a product decision. Record any visual or runtime compromise in the handoff.
