---
name: low-fidelity-ux-designer
description: Guide ambiguous product ideas through focused UX discovery, task-flow definition, information architecture, iterative low-fidelity wireframing, review-board annotation, host feedback submission, and revision validation. Use when an AI coding agent needs to ask step-by-step design questions, turn a URL, local HTML, or requirements into web/mobile wireframes, collect position-aware feedback, revise designs from comments, or inspect exported HTML without image understanding. Support Codex, Claude Code, OpenCode, multimodal, browser-capable, source-only, and text-only environments.
---

# Low-Fidelity UX Designer

Turn uncertain ideas into testable structure. Optimize for task clarity and cheap decisions, not visual polish.

## Operating contract

- Work in the user's language. Use plain product language.
- Ask only questions whose answers change the design. Prefer one focused question per turn; group at most three tightly related questions when progress would otherwise stall.
- Explain why a question matters in one short sentence when the tradeoff is not obvious.
- Offer 2-3 concrete choices with a recommendation when users lack design vocabulary. Always allow a free-form answer.
- Reuse facts already given. Never restart discovery or present a long questionnaire.
- Make a reversible assumption and label it when the user says “you decide,” is unsure, or omits a low-risk detail.
- Pause for confirmation only at decision gates. Do not ask permission for routine drafting or rendering.
- Keep wireframes grayscale and intentionally rough. Do not spend time on branding, final copy, imagery, animation, shadows, gradients, or pixel polish.
- Treat generated images as disposable visual hypotheses, never as the source of truth. Maintain a textual screen specification alongside them.

## Route by starting state

Identify the nearest state and enter there:

1. **Idea only**: begin with Outcome framing.
2. **Requirements or user stories exist**: summarize them into an assumption ledger, then define the critical task.
3. **Flow exists**: validate entry, success, recovery, and edge cases, then map screens.
4. **Wireframe exists**: ask for or inspect the artifact, establish the intended task, then run the critique loop.
5. **Explicit build request**: confirm the minimum structural unknowns, then create the requested artifact. Do not force the full interview.

For detailed question patterns and gate criteria, read [references/discovery-playbook.md](references/discovery-playbook.md).

When the input includes a URL, local HTML path, or existing page, first read [references/link-intake.md](references/link-intake.md). Treat it as a source snapshot, then resolve the design scope before creating a screen or board.

For deterministic intake and board checks, use `scripts/normalize_source.py`,
`scripts/board_registry.py`, `scripts/board_package.py`, and
`scripts/validate_review_board.py` instead of reimplementing source, package,
version, or Manifest handling ad hoc.

Use [references/implementation-checklist.md](references/implementation-checklist.md)
as the execution and regression checklist; it includes storage-path priority,
new-link Board creation, immutable versions, and Codex/Claude Code/OpenCode
adapter fallbacks.

## Run the decision funnel

Maintain a compact working brief after every meaningful answer:

```markdown
Working brief
- Product / surface:
- Primary user:
- Situation / trigger:
- Critical task:
- Success signal:
- Scope now / later:
- Constraints:
- Confirmed decisions:
- Assumptions to test:
- Open decision: only the next blocking decision
```

Do not repeat the entire brief every turn. Show only changed decisions and the next question. Provide the full brief at gates or when requested.

### Gate 1: Outcome framing

Establish the primary user, triggering situation, one critical task, and observable success. If the user lists many audiences or goals, ask which one must succeed first.

Exit when this sentence is credible:

> When [situation], [primary user] can [critical task], evidenced by [success signal].

### Gate 2: Scope and constraints

Separate must-have from later. Capture platform, device, responsive needs, accessibility risks, content/data availability, technical limits, and required states. Challenge features that do not support the critical task.

Exit with a small in-scope set and an explicit out-of-scope set.

### Gate 3: Task flow

Write the happy path as verb-led steps. Add entry points, decision branches, cancellation/back behavior, empty/loading/error states, permission or authentication boundaries, and the final confirmation.

Use Mermaid only when branching or dependencies are materially easier to understand visually. Otherwise use a numbered flow.

Exit when every step has a user intent and a system response.

### Gate 4: Screen map and hierarchy

Map each necessary screen or state to one job. For every screen define:

- user question answered;
- primary action;
- essential information;
- secondary actions;
- next, back, error, empty, and success behavior.

Merge screens that do not earn a distinct user decision. Split screens that contain competing primary actions.

Exit when the screen set covers the task flow without orphan screens.

### Gate 5: Wireframe options

Create one recommended direction. Create a second option only when a real structural tradeoff exists, such as guided wizard versus single page or browse-first versus search-first. State the tradeoff before showing options.

Use realistic short labels, not lorem ipsum. Annotate interaction and behavior outside the frame. Apply the conventions in [references/wireframe-standards.md](references/wireframe-standards.md).

### Gate 6: Critique and convergence

Walk through one realistic scenario from entry to success. Review in this order:

1. task completion and missing states;
2. information hierarchy and primary-action clarity;
3. navigation, feedback, recovery, and accessibility;
4. consistency and only then layout neatness.

Separate findings into **blocking**, **important**, and **later**. Ask the user to decide only unresolved product tradeoffs. Apply straightforward fixes directly, update the brief, and rerender the affected screens.

Exit when there are no blocking findings and the user can explain what happens next on every critical screen.

### Gate 7: Review board and revision

When the user wants asynchronous or position-specific feedback, package the current wireframes in a review board. Preserve stable screen, component, annotation, and version IDs. Collect comments, normalize coordinates, classify impact, and map each accepted comment back to the canonical specification before changing the rendering.

Apply low-risk copy and local-layout changes directly. Summarize and confirm comments that alter the critical flow, scope, core navigation, destructive behavior, or conflict with another comment. Create a new version instead of overwriting the reviewed version. Record a disposition for every comment.

Read [references/review-board.md](references/review-board.md) before creating, importing, or revising a review board. Reuse [assets/review-board/index.html](assets/review-board/index.html) for a zero-dependency local board.

Resolve the user-selected storage root and Board Registry before writing artifacts. Read [references/board-storage.md](references/board-storage.md) for path priority, one-link-per-board defaults, related-board links, and immutable version rules. Read [references/host-adapters.md](references/host-adapters.md) when the board should submit comments back to an AI coding host.

Create and version packages with `scripts/board_package.py`. Install
host-native command assets with `scripts/install_host_adapters.py`. For
one-click submission from a standalone local board, explicitly start
`scripts/review_bridge.py`, connect it from the board with its per-launch token,
and dispatch through `scripts/review_host_adapter.py`. Queue-only mode returns
`stored`; only a successful configured CLI continuation returns `submitted`.

Exit when all blocking comments are resolved or explicitly deferred, the revised critical flow passes validation, and old versions remain inspectable.

## Select the rendering lane

Detect image, browser, filesystem/code, and text capabilities before promising a format. Never claim visual or runtime inspection occurred when the required tool is unavailable.

Use this priority for inspection and revision:

1. **Multimodal + browser**: inspect pixels when useful, then verify DOM, accessibility structure, computed layout, and interactions.
2. **No multimodal + browser**: treat semantic HTML and the Design Manifest as authoritative; inspect DOM, accessibility structure, computed styles, element bounds, and interactions without claiming to understand image pixels.
3. **No browser + source access**: statically parse HTML, CSS, scripts, and the Design Manifest; explicitly mark runtime behavior unverified.
4. **Text only**: use the canonical specification, structured comments, Mermaid, and ASCII; explicitly mark visual and runtime behavior unverified.

### Lane A: image generation is available

Use it when a visual frame materially accelerates comparison or feedback. First write the canonical screen specification. Then generate grayscale low-fidelity frames with clear boundaries, legible short labels, and no decorative styling. Use one image per flow segment or a clearly ordered contact sheet. Inspect the result when tools permit.

Reject and regenerate frames with unreadable text, missing states, contradictory navigation, polished visual styling, or layouts that diverge from the canonical specification. Preserve annotations and interaction rules in text because generated pixels are not authoritative.

Read [references/rendering-lanes.md](references/rendering-lanes.md) before composing image prompts.

### Lane B: no image generation, but files/code are supported

Prefer an accessible standalone HTML/CSS or SVG wireframe when the user wants a visual artifact. Use grayscale tokens, visible screen labels, responsive frames where relevant, semantic controls, and annotation IDs. Keep dependencies at zero unless the existing project requires otherwise. Render or preview the artifact when tooling permits.

Do not turn a low-fidelity request into production UI. Code exists to communicate layout and interaction only.

### Lane C: browser inspection

When a browser is available, open the exported HTML and inspect the running page. Prefer a local static server when modules, routing, or relative assets do not work over `file://`. Read the DOM or accessibility tree, computed styles, bounding boxes, viewport, and relevant console/runtime failures. Execute the critical flow at required viewports.

Map feedback through `data-screen-id`, `data-component-id`, and manifest records, not through guessed pixel meaning. Update the canonical specification and Design Manifest before changing HTML/CSS/behavior. Reload and re-run affected scenarios. If inspection fails, fall back to source inspection and state exactly what remains unverified.

Do not inspect cookies, credentials, browser profiles, or unrelated browsing state. Do not execute untrusted remote scripts merely to make an export render.

## Link, board, and host lifecycle

- A normalized URL creates or updates a **Source**, not automatically a Board.
- By default, a new normalized URL gets a new Board folder under the user's selected storage root. Related URLs are linked in the Registry; they are not silently merged.
- A same-scope design change creates a new immutable Version in the existing Board. A changed user, task, success signal, or product boundary creates a new Board even when the URL is unchanged.
- A Board is reused only when its design scope matches. A new screen is added only when the new page is an independent decision in the same explicitly shared task.
- The board emits one framework-neutral Review Package. Use the host adapter order and fallbacks in [references/host-adapters.md](references/host-adapters.md); never execute arbitrary host commands from a browser.
- “Current host” means the configured Codex, Claude Code, or OpenCode session.
  A standalone `file://` board cannot infer that session; require an injected
  host API or the authenticated loopback bridge, otherwise copy/export.

### Lane D: text-only environment

Use box-drawing ASCII for individual screens and Mermaid for branching flows. Keep frames narrow enough to read in chat. Follow every frame with numbered annotations and unresolved questions. For complex products, deliver the screen specification first and render only the critical flow.

## Deliver a durable handoff

Use [references/handoff-template.md](references/handoff-template.md). The final package must remain useful without the original conversation and include:

- problem statement and primary scenario;
- confirmed scope, constraints, and assumptions;
- task flow and screen inventory;
- canonical per-screen specification;
- wireframe artifact or text fallback;
- interaction rules and system states;
- accessibility notes relevant at low fidelity;
- validation scenarios and unresolved decisions;
- revision summary when iterating.

If the user asks only for an intermediate artifact, deliver that artifact plus the minimum context needed to interpret it.

## Guardrails

- Do not invent research findings, metrics, user quotes, or stakeholder approval.
- Do not confuse a stakeholder preference with a user need; label the source of each constraint.
- Do not hide uncertainty behind polished images.
- Do not generate every possible screen before validating the critical flow.
- Do not ask about colors, fonts, illustration style, or animation during low-fidelity work unless they affect comprehension or accessibility.
- Do not use ambiguous placeholders such as “Card 1” when realistic labels can expose hierarchy problems.
- Do not omit loading, empty, error, destructive-action confirmation, permission, and success states when relevant.
- Do not declare completion merely because a wireframe exists. Completion requires a scenario walkthrough and no blocking findings.
- Do not silently drop review comments. Give each comment an accepted, needs-clarification, rejected, deferred, or resolved disposition.
- Do not claim a non-multimodal model understood photos, illustrations, canvas pixels, or image-only text. Use asset metadata or request visual review.
- Do not overwrite a reviewed version. Produce a new immutable version and retain the comment-resolution record.
