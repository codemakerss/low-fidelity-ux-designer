# Wireframe Standards

## Contents

- Fidelity contract
- Frame anatomy
- Common patterns
- Annotation grammar
- Accessibility at low fidelity
- Quality checks

## Fidelity contract

Use only grayscale plus an optional single annotation color. Use a small spacing scale and a simple system font. Represent images as crossed boxes or neutral blocks. Prefer content-shaped skeletons over decorative cards.

Low fidelity means enough detail to test hierarchy, sequence, comprehension, and behavior. It does not mean vague content, missing states, or careless alignment.

## Frame anatomy

Every frame needs:

- screen ID and descriptive name;
- viewport or device assumption;
- clear entry context;
- page or view title when appropriate;
- one visually dominant primary action;
- realistic short content;
- persistent navigation only when needed;
- state label if not the default state;
- numbered annotations outside the UI.

For responsive work, draw only the widths needed to expose structural changes. State reflow rules instead of duplicating identical frames.

## Common patterns

### Forms

- Group fields by user goal.
- Put labels outside fields; placeholders are examples, not labels.
- Mark optional fields, requirements, validation timing, and error recovery.
- Preserve entered data after recoverable errors.
- Use review/confirmation only when risk or complexity earns the extra step.

### Lists and search

- Distinguish initial, loading, results, no results, empty collection, and error states.
- State sorting/filtering defaults and whether they persist.
- Make row/card actions and selection behavior unambiguous.

### Dashboards

- Lead with decisions and exceptions, not equal-weight metric tiles.
- Define each metric's timeframe and comparison.
- Make drill-down destinations explicit.

### Onboarding and wizards

- Show progress only when it helps users estimate effort or navigate.
- Allow back without data loss.
- Explain why sensitive or unusual information is requested.
- Let optional setup be skipped when the critical task permits.

### Destructive or high-risk actions

- Distinguish prevention, confirmation, undo, and recovery.
- State consequences in concrete terms.
- Do not rely on color alone.

## Annotation grammar

Use stable IDs:

- `N#` navigation or route;
- `A#` user action;
- `S#` system response/state;
- `V#` validation rule;
- `C#` content/data rule;
- `R#` responsive behavior;
- `Q#` unresolved question.

Write annotations as behavior, not commentary:

`A2 Submit remains disabled until required fields are valid.`

`S3 On failure, keep entered data and place an error summary before the form.`

## Accessibility at low fidelity

Check structural decisions that are expensive to retrofit:

- logical heading and reading order;
- keyboard and focus sequence;
- explicit labels and instructions;
- error identification and recovery;
- adequate target separation for touch;
- alternatives for drag, hover, gesture, and color-only meaning;
- predictable navigation and focus after dialogs or route changes;
- space for zoom, text expansion, translation, and dynamic content.

Do not claim WCAG conformance from a wireframe. Record what later visual and implementation phases must verify.

## Quality checks

Before delivery, verify:

- The first frame makes the next action obvious.
- Every frame supports the critical task.
- Every action has a defined result.
- All branches rejoin, end, or intentionally exit.
- Empty, loading, error, permission, destructive, and success states exist where relevant.
- Labels are realistic enough to test comprehension.
- Annotations do not contradict the visible frame.
- No visual polish distracts from unresolved structure.
