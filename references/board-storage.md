# Board Storage and Registry

## Path resolution

The Skill manages the package shape, not the user's filesystem. Resolve the
storage root in this order:

1. an explicit path supplied in the current request;
2. an established project convention such as `design/`, `docs/ux/`,
   `product/design/`, or `.design/`;
3. an existing Board Registry in the project;
4. ask the user when no safe location can be inferred.

Never silently create a fixed `boards/` directory. Never store user artifacts
inside the Skill's `assets/` directory. A temporary path is allowed only when
the user accepts that it may not persist.

## Package shape

After the user-selected root is known, use one folder per board:

```text
<selected-root>/
├── board-registry.json
└── <board-id>/
    ├── source.json
    ├── board.html
    ├── manifest.json
    ├── sources/
    ├── versions/
    │   ├── v1/
    │   │   ├── specification.md
    │   │   └── review.html
    │   └── v2/
    └── feedback/
```

The selected root is already the user-approved collection location; do not add
another implicit `boards/` layer. If the user explicitly selected
`docs/ux/reviews/boards/`, preserve it exactly.

Create the package with:

```bash
python3 scripts/board_package.py create \
  --root <selected-root> \
  --board-id <board-id> \
  --source <url-or-local-path> \
  --design-goal "<goal>"
```

## Registry record

```json
{
  "board_id": "sample-project-overview",
  "source_url": "https://example.com/projects/sample",
  "normalized_url": "https://example.com/projects/sample",
  "design_goal": "evaluate the sample project's information architecture",
  "storage_path": "docs/ux/reviews/sample-project-overview",
  "latest_version": "v2",
  "related_board_ids": []
}
```

Before creating a board, query the registry. If a normalized URL matches,
offer reuse, a new version, or an explicitly independent board. Do not replace
an existing board merely because its title or slug matches.

## Version rules

- A reviewed design is immutable; changes create `v2`, `v3`, and so on.
- Keep a `component_id` when product meaning is continuous.
- Mint a new ID when the component's meaning changes and retain the removed ID
  in the version history.
- Resolve old comments by `component_id` first. If the ID is gone, mark the
  comment `needs-clarification`; never guess from coordinates alone.
- Use the `board_package.py version` command with `--board-dir` and
  `--review-package` to archive the reviewed HTML, merge the feedback record,
  update the Registry, and create the next version atomically.
