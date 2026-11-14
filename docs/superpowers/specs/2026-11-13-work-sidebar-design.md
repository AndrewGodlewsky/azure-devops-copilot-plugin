# Work sidebar design

The user approved mockup B: replace the horizontal item tabs with a vertical sidebar that groups child tasks beneath their story. The selected item's details stay on the right.

## Approaches

- A flat vertical list is simpler but separates tasks from their parent.
- The approved expandable hierarchy keeps the parent and children together. Pull requests have their own section; Home remains the first entry.

## Behavior

- Reuse the existing open-item state, cached detail panels, draft protection, refresh, and connection routing.
- Show titles, item types/IDs, and child states. Populate children from the existing Children relations, fetching details only when selected.
- Opening a child selects its nested row without adding a duplicate root. Expand its ancestors when opened from the detail pane.
- Closing a parent closes only that view. Independently opened children remain available. Closing a child releases its view but keeps the relation available to reopen.
- Keep close controls, branch markers, and independent scrolling of a long sidebar. Use accessible navigation, nested lists, disclosure buttons, and labeled detail regions.
- The sidebar can collapse. On narrow canvases, navigation becomes a collapsible vertical list above the details rather than squeezing the reading area.
- No new dependencies or backend calls. Use fictional names in tests and documentation.

## Verification

Exercise expansion, selection, closing, draft retention, cross-project and cross-organization identity, cycles, refresh, keyboard focus, and narrow layouts. Compare the full test suite with its pre-change baseline. Verify in Brave using fictional data, then publish a versioned update to the fork.
