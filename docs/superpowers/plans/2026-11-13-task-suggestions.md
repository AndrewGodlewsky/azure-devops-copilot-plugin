# Task Suggestions Implementation Plan

> Execute inline with the executing-plans skill; finish with an independent review.

**Goal:** Let a user ask Copilot for child-task proposals, review/edit/select them,
then explicitly create the selected tasks under the open story.

**Architecture:** Reuse the current conversation and saved-item context builder.
Register a draft-only `propose_ado_tasks` canvas action; proposals return through
that action into an in-memory, account/item-scoped review session. The browser
polls for proposals and preserves local edits. Only a nonce-protected browser
POST can create tasks, using the existing workspace creation service.

**Tech stack:** Existing Node ESM, vanilla DOM, Copilot SDK, node:test/JSDOM, Brave.

**Approved design:** The preceding conversation: Suggest tasks, discuss with
Copilot, review titles/descriptions/completion conditions, select and create;
inherit parent assignment with an editable override. Existing child tasks must
inform suggestions; ambiguity appears as questions. No separate model/API key.

## Constraints and review focus

- Keep board cards clean; actions and review live inside the item details.
- Support User Story and equivalent parent types (Issue, Product Backlog Item,
  Requirement, Feature, Epic); do not propose children automatically on tasks.
- Preserve work-item edits and reviewed proposals across rerenders/tab switches.
- Bind callbacks to their request, canvas, account, organization and parent.
- Validate bounded plain-text proposals; escape them when creating HTML fields.
- Recheck parent requirements and existing child titles before creation.
- Remember per-row results and block uncertain retries to avoid duplicate writes.
- Draft proposals last for the open canvas session; no new persistence subsystem.
- Use fictional fixtures. Existing publish authorization covers release 0.2.3.

## Tasks

1. Add `task-suggestions.mjs` service/schema and tests for draft-only generation,
   revisions, scope, validation, stale parents, duplicates, partial failures and
   repeat create requests. Reuse context formatting and workspace `createItem`.
2. Wire server routes and agent action; test the real HTTP/nonce/SDK boundary.
3. Add a small review-panel module and detail action. Poll pending drafts, allow
   edits, selection and assignee override, show questions/results, and refresh
   child links without discarding work-item drafts. Test with JSDOM and Brave.
4. Review, update README/manifests, verify, commit and push the fork.

## Execution record

- Start: clean linked worktree, HEAD 5604d1e (v0.2.2).
- SDK canvas actions return structured JSON and are scoped by instanceId.
- Existing createItem already handles parent links and inherited assignment,
  area and iteration. Reuse it rather than adding another ADO write path.
- Implemented the draft-only canvas action, bounded proposal validation,
  review/edit/select UI, explicit child creation, assignment options and receipts.
- Independent review caught account switching during awaited work, incomplete
  child hydration and lost-response receipt recovery. Added failing regressions,
  fixed each issue and received a clean follow-up review (17 focused checks).
- Account guards validate the exact token used for each task-flow API request;
  sign-out generations also separate drafts. Parent requirements and readable
  child titles are rechecked before any task creation.
- 137 focused prompt, service, DOM, action and app tests passed; both task-flow
  HTTP tests passed, including account switching during generation and creation.
- Brave smoke passed at desktop, 900px and 390px. Inspected review-panel screenshots
  at desktop and 390px. The flow preserves proposal edits across rerenders, creates
  only selected tasks and retains unsaved story fields.
- Full suite: 535 tests, 511 pass, 23 fail, one TODO. All 23 failure names match
  the prior release's recorded baseline; this feature introduced no new failures.
- Updated README and plugin/marketplace versions to 0.2.3. Advanced planning and
  template issues remain deferred. No live Copilot messages or ADO writes were
  performed; those require testing in the installed host with a signed-in account.
