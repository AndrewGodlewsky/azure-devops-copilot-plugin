# Child Work Items Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this small change in the existing isolated workspace.

**Goal:** Show an issue's child tasks prominently when the issue is opened, with navigation to each task's details.

**Architecture:** Reuse the already loaded `Children` relation group and existing relation cards and work-item navigation. Move child links to the main column; keep other relations in the sidebar.

**Tech Stack:** Native JavaScript modules, CSS, Node test runner, jsdom.

**Spec:** The design below.

## Design

Add a “Tasks and child work items” card after the work-item description/template sections and before Discussion. Show the child count, type/ID, title, and state. Retain the existing six-row preview and expandable overflow. Clicking a row opens the child's existing detail view and preserves its project context. Unresolved children remain visible by ID. Omit the card when there are no children.

This uses the existing relation data rather than introducing another Azure DevOps query or a new task model. The user authorized adding the feature; the presentation above is the implementation choice.

## Constraints and review focus

- Use fictional fixture data; never include the user's organization or project URL.
- Preserve parent/related/development links and the existing edit flow.
- Show all child types, including unresolved links; do not silently filter custom types.
- Keep overflow links clickable and long titles readable at narrow widths.
- Preserve project identity when opening a child in another project.
- Update the fork's release version so installed clients can discover the change.

## Task: Display and navigate child work items

- [x] Add failing rendering tests in `extensions/azure-devops/work-item-view.test.mjs` and strengthen the existing navigation test in `tabs.test.mjs`.
- [x] Update `relationsSection` and `renderWorkItem` in `ui/work-item-view.mjs`; adjust existing relation styles in `ui/styles.css`.
- [x] Run targeted tests, compare the full suite to the baseline, and inspect the rendered layout in Brave.
- [x] Update the two plugin manifests to version `0.1.72` and document the feature in `README.md`.
- [x] Obtain an independent code review; no actionable findings were reported.

Release by committing and publishing to the fork's default branch, then verifying the remote manifests.

## Baseline

The unmodified suite reports 450 passed, 67 failed, 2 skipped, and 1 todo. Work-item mapping and view tests pass (53/53). Preserve the baseline failure list and ensure this change introduces no additional failures.

## Verification results

- All five feature-focused tests pass; four were observed failing before implementation, and the empty-state test already passed.
- Work-item mapping and view tests: 57 passed, no failures.
- Full suite: 454 passed, 67 failed, 2 skipped, 1 todo. The failure names exactly match the unmodified baseline.
- Brave at 1000px and 390px: readable wrapping, no horizontal overflow or page errors, working expansion and child navigation with project context.
- The authenticated user issue could not be read through the web tool; verification used fictional fixtures and the existing Azure DevOps child-relation mapping.
