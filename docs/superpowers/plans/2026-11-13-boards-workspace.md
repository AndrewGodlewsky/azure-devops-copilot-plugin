# Everyday Azure Boards workspace

Approved scope: implement feature ideas 1, 2, 3, 9, 10 and 14. GitHub issues #1 through #6 track them respectively. Templates (#7, idea 12) and Copilot planning (#8, idea 13) are deferred and must not be implemented.

## Product shape

Keep the vertical hierarchy and item details. Add permanent Home, Work items and Board navigation, plus New work item. The Work items screen supports all work (including unassigned and completed), search and filters, and pagination. Board selects project/team/board and uses actual Azure columns and work-item state mappings, with drag/drop and keyboard movement. Creation uses project-specific types; Add task inherits and links its parent. Home gains selectable current, blocked, unfinished-parent and recently completed sections. Uploads support files and pasted screenshots. Drafts and workspace preferences survive the canvas's changing localhost port; background refresh preserves all active edits.

## Contracts between implementation workstreams

All API requests use the existing nonce/authentication protections and connection selector (`organization`, `project`), with `workItemProject` for a selected project within an organization connection. Never trust an arbitrary organization from a request. No Azure Repos functionality returns.

- `GET /api/workspace/metadata`: `{ projects: [{ id, name }], types: [{ name, states }], teams: [{ id, name }] }`. Types and teams are for the selected project. States are objects with name/category/color, or documented by the backend before UI integration.
- `GET /api/workspace/items`: query, assignee (`all`, `mine`, `unassigned`, or identity), state, type, tags, cursor, pageSize. Returns `{ workItems, nextCursor, count }`. Item summaries include id/rev/type/title/state/assignedTo/project/tags/changedDate. Empty filters include completed items. Cursor pagination must not silently omit old items.
- `POST /api/workspace/items`: `{ type, title, description, parentId?, assignedTo?, area?, iteration? }`; returns `{ workItem }`. Resolve/inherit parent context on the server and atomically create the parent relation.
- `GET /api/workspace/boards?team=...`: `{ boards: [{ id, name }] }`.
- `GET /api/workspace/board?team=...&boardId=...`: `{ id, name, columns: [{ id, name, isSplit, stateMappings }], workItems }`; cards include `columnId`, `columnDone`, and `rev`.
- `PATCH /api/workspace/board/move?team=...&boardId=...`: `{ id, rev, columnId, done }`. Resolve actual board fields/state mappings on the server, test revision, and return `{ workItem }`. Existing field update endpoint handles assignment.
- `GET /api/workspace/dashboard`: `{ current, blocked, unfinished, completed }`, each `{ workItems, count, error, ... }`. Current/blocked/completed are current-user views; unfinished parents include incomplete-child counts. Explicitly report truncation/sample limits if applicable. Prefer process state metadata; blocked recognizes an available Blocked field or blocked tag without inventing unsupported field queries.
- `GET /api/workspace/preferences`: `{ preferences }`; `PATCH` shallow-merges allowed preference properties (`dashboardSections`, `openItems`, `activeItem`, `workspace`). Persist per authenticated identity locally, not browser-origin storage.
- `GET /api/work-items/:id/draft`: `{ draft: null | { rev, fields, baseValues, comment, updatedAt } }`; `PUT` saves that bounded payload; `DELETE` discards it. Same connection checks and account scope. Store locally with restrictive permissions and atomic writes. Do not store credentials in drafts.
- `POST /api/work-items/:id/attachments?fileName=...`: raw bytes with Content-Type application/octet-stream; returns `{ attachment: { url, fileName, ... }, rev }`. Limit 60 MiB; attach the upload to the item; validate names/connection, retain existing image proxy protections. Return actionable errors on upload/link failure.

## Ownership and integration

Backend agent: canvas-server.mjs, its tests, new server helper modules/tests as needed, work-item.mjs mapping if necessary. Workspace UI agent: new ui/workspace-view.mjs, ui/workspace.css and focused workspace-view.test.mjs. Attachment/editor agent: ui/work-item-view.mjs, ui/editor.mjs, ui/comment-composer.mjs, new upload UI modules/CSS and their tests. Root: ui/app.mjs integration, ui/index.html, ui/navigation-view.mjs, home integration, draft coordination, integration tests, documentation/version/publishing. Agents do not edit each other's files or commit independently.

Workspace UI exports `createWorkspaceView(container, { request, connections, onOpenWorkItem, onCreated, onChange, onViewChange })`, returning `{ show(view), openCreate({ connection, parent } = {}), refresh(), destroy() }`. Views are `home`, `items`, `board`. It owns connection/project/team selection, all three content screens, create modal, dashboard preferences, and its scoped requests. `onOpenWorkItem(item, connection)` preserves project context. `onCreated(item, connection, parent)` lets the app refresh/open hierarchy. `onChange()` invalidates cached item details after board mutations. `onViewChange(view)` lets the app synchronize its navigation.

Work-item view additions: `onAddTask`, `onUploadAttachment(file)`, `draft` (fields/comment restored by caller), `onDraftChange({ fields, comment })`; view returns a handle `{ getDraft() }`. Preserve unchanged legacy behavior when callbacks are absent. Uploads must not rerender and discard dirty editors. Editable descriptions and comments insert the returned attachment reference and emit draft/dirty callbacks. The app owns persistent storage and draft/conflict notices.

## Verification and release

Use fictional test data. Keep boundaries, pagination, revision tests, upload limits, draft round trips, field preservation and keyboard paths covered. Add a repeatable browser smoke harness for these workflows using sample APIs and explicit Brave selection. Inspect desktop and narrow screenshots. Baseline is 430 tests: 404 pass, 25 known failures, one TODO. Compare retained failures rather than hiding them. Review each workstream and the integrated behavior, then commit/push a versioned release to the fork's main branch. Live authenticated Azure DevOps/Copilot testing remains separately reported.

## Delivered and verified

Version 0.2.0 implements issues #1-#6. Issues #7 (templates) and #8 (Copilot planning) remain deferred, with no implementation of those ideas.

The native Home, Work items and Board views use the existing vertical navigation. Draft writes are serialized, account scoped and persistent across changing localhost ports. Restore/discard gates editing until the saved draft decision. Refresh and save preserve typing, including edits made during a pending request. Conflict resolution compares the displayed revision and keeps newly added fields; pending uploads cannot be discarded by a conflict action. Work-item saves and comments never recreate drafts after a view is explicitly discarded.

Independent review found and verified fixes for mutation/draft races, upload revision handling, project GUID/name aliases, and completion categories for disabled work-item types. Board state updates use real board fields and revision checks. Dashboard sampling limits remain visible in the UI.

Final full suite: **506 tests, 483 pass, 22 fail, one TODO, no skips/cancellations**. All 22 failure names match the pre-change baseline; these remain in the older backend authentication/preview-dependent tests. The three previous UI failures were updated to reflect deliberately removed preview controls. Superseded favorite-board/drawer scenarios now exercise native board routing, project selection, keyboard controls, draft preservation and error recovery. Focused integration/workspace tests pass 92/92; editor/upload tests pass 113/113; all 25 new backend tests pass.

The committed `extensions/azure-devops/scripts/workspace-smoke.mjs` runs the real UI in Brave against fictional local APIs. It passed search (including completed items), linked child creation, failed-create retry, draft recovery after reload, conflict review, screenshot pasting, keyboard and drag board moves, failed-move rollback and assignment. Desktop, 900px and 390px screenshots were inspected; there was no page overflow or JavaScript error. This is repeatable local validation, not a claim of authenticated Azure DevOps or Copilot host testing.
