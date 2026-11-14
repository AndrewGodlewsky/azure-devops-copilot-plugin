# Work Sidebar Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the approved vertical story/task navigation.

**Architecture:** Keep app.mjs's open-item lifecycle. A small sidebar view builds nested navigation from open items and their existing child relations, invoking the current open/activate/close callbacks.

**Tech Stack:** Native JavaScript modules, CSS, Node tests, jsdom; Brave for layout checks.

**Spec:** ../specs/2026-11-13-work-sidebar-design.md

## Global constraints

- No new dependencies or backend calls.
- Preserve independent views and unsaved-edit protection.
- Fictional names in tests and documentation.

## Review focus

- Identical IDs in different organizations must remain separate.
- Cross-project children must use their own project when opened.
- Closing a parent must retain a child's open view and draft.
- Refreshes, cycles, and out-of-order loads must not duplicate or hide open views.
- Collapsing and rerendering must preserve usable keyboard focus and narrow-screen access.

## Task 1: Sidebar and lifecycle integration

Files: ui/navigation-view.mjs (new), ui/app.mjs, ui/index.html, tabs.test.mjs, navigation-view.test.mjs (new), under extensions/azure-devops.

Interface: renderNavigation(container, { tabs, activeTabId, collapsed, sameEntry, tabTitle, isBranchPullRequestTab, onActivate, onOpenChild, onClose }). Reuse callbacks from app.mjs; collapsed is a Set of stable row keys.

- [x] Add failing integration/unit coverage for nested children, selection and deduplication, separate PRs, close/reopen, connection identity, cycles, refresh, and focus.
- [x] Implement navigation and replace the tab-strip renderer while retaining view caching and draft guards.
- [x] Run navigation-view.test.mjs and tabs.test.mjs; compare known baseline failures.

## Task 2: Layout and release

Files: ui/styles.css, README.md, .claude-plugin/plugin.json, .claude-plugin/marketplace.json.

- [x] Implement the sidebar, collapse button, readable title rows, and narrow-screen layout.
- [x] Verify desktop/narrow layouts, collapse/expand, child selection, and keyboard focus in Brave.
- [x] Run the full suite against baseline and review the final diff.
- [x] Bump plugin/marketplace to 0.1.74, document the navigation, commit and push to fork main; verify published SHA.

## Verification results

- Baseline: 524 tests, 454 passed, 67 failed, 2 skipped, 1 todo.
- Final: 534 tests, 464 passed, 67 failed, 2 skipped, 1 todo. Failure names match the baseline exactly.
- All 10 new tests passed, including reference-opened items and out-of-order parent loads.
- Brave verified desktop (1440px), medium (900px), and narrow (390px) layouts; disclosure keyboard/focus, collapse, child navigation, independent long-list scrolling, and no horizontal overflow or JavaScript errors.
- Independent review found no remaining blockers; optional jsdom handling matches the existing tests.
- Browser checks used fictional data. Live Azure DevOps authentication/data was not exercised.
