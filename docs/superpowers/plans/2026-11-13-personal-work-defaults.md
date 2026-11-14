# Personal work defaults

**Goal:** Keep the plugin focused on the signed-in user's work, with clean board cards and deliberate access to other items.

**Design:** Home already queries the current user's assignments. Make Work items default and reset to `mine` in both UI and service. Filter board membership through Azure DevOps `@Me` queries in bounded chunks before loading cards. Keep explicit Anyone/person/unassigned searches and linked-item navigation. Remove card assignment controls and owner text; expose assignment in the existing item Edit/Save form, including draft recovery and revision protection. Search filters are not persisted, so existing preferences need no migration.

**Approach:** Use the existing query and editor helpers. Filtering on the server uses the authenticated Azure DevOps identity and avoids comparing display names in the browser. Keep board moves and the existing navigation intact.

**Files:** `workspace-server.mjs`, `ui/workspace-view.mjs`, `ui/workspace.css`, `ui/work-item-view.mjs`, their tests, `scripts/workspace-smoke.mjs`, README and plugin version manifests.

## Checks and delivery

- [x] Add failing coverage for personal defaults, explicit wider search/reset, personal board membership, and assignment within item editing.
- [x] Implement the filters and simplify cards using existing helpers.
- [x] Run workspace, item-view, draft and navigation checks; retain existing Home assignment coverage.
- [x] Exercise the real UI in Brave with fictional personal, other-person and unassigned items; inspect desktop and narrow screenshots.
- [x] Update README and plugin version to 0.2.1 and review the diff. Publication is recorded in Git history.

No live Azure DevOps work items should be changed during verification.

Verification: 183 focused tests passed with no skips. Review identified a concurrent reassignment race during board loading; the queries and card reads now share one `asOf` timestamp. Its added regression test and all 20 workspace-service tests passed, bringing the focused coverage to 184 tests. Brave smoke checks passed at desktop, 900px and 390px widths, including assignment from inside the item and its removal from the personal board after saving. No live authenticated Copilot or Azure DevOps testing was performed.
