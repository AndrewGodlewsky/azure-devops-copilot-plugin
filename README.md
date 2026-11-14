# Andrew's Azure DevOps Copilot Plugin [Preview]

This is Andrew Godlewsky's fork of the [Microsoft Azure DevOps Copilot Plugin](https://github.com/microsoft/azure-devops-copilot-plugin). It brings your Azure Boards work into the [GitHub Copilot App](https://github.com/apps/desktop) so you can review and act on it without leaving your Copilot session.

> [!WARNING]
> This is a preview release. It is not supported for production workloads and may change without notice.

## Features

- Customize **Home** with your current work, blocked items, parents with unfinished tasks, and recently completed work.
- Search **Work items** by title or ID, filter by person, state, type and tags, and page through all results, including completed and unassigned work.
- Create stories, issues, bugs and tasks using the project's actual work item types. **Add task** links a child and inherits its parent's assignment, area and iteration.
- Use **Board** to select a project, team and board, move cards by dragging or keyboard controls, and change assignments.
- Edit work items, post comments, attach files, and paste screenshots into descriptions or discussions.
- Recover local drafts and open views after reopening the canvas. Background refresh preserves edits and offers a comparison when Azure DevOps values have changed.
- Navigate open stories and their child tasks in an expandable vertical sidebar.
- See linked child tasks in a work item's **Tasks and child work items** section, and click a task to open its details.
- Work through an interactive Azure DevOps canvas in the GitHub Copilot App.

## Installation

### Marketplace

Add `https://github.com/AndrewGodlewsky/azure-devops-copilot-plugin` as a Copilot marketplace, then select **andrewgodlewsky-azure-devops** from the **andrewgodlewsky-plugins** catalog.

For the **Install plugin** dialog, enter:

```text
andrewgodlewsky-azure-devops@andrewgodlewsky-plugins
```

This fork uses distinct plugin and marketplace names so it can be registered alongside Microsoft's marketplace.

## Usage

Open the **Azure DevOps** canvas in the GitHub Copilot App to view My Work, stories, issues, and tasks for your Azure DevOps projects. Choose an organization and optionally a project in **connections**. No Azure Repos repository or Git remote is needed.

The sidebar keeps each opened item's details and edits available as you switch. Expand a story to choose its tasks, or use the close button to close an item's view. Closing a story keeps any independently opened tasks available. Use the navigation toggle to make more room for details; narrow canvases start with navigation collapsed.

This fork focuses on Azure Boards. Azure Repos pull requests, reviews, branch actions, linked commits, and pipeline summaries are not included.

Choose a project for Home, Board and creation. An organization connection can search across projects in Work items. Board columns and states come from Azure DevOps, including split columns; board visibility follows that team's backlog settings. Home sections sample up to 100 items each, show sampling notices, and use the last 14 days for recently completed work. Use Work items for complete paged searches.

Drafts and preferences are saved on this device under `~/.copilot/azure-devops-canvas/workspace`, separated by signed-in account. A saved draft is offered for restoration before editing or commenting; it does not update Azure DevOps until you save or post. Files attach immediately and have a 60 MiB per-file limit. While the canvas is visible, it checks for updates every 30 seconds and when you return to it.

Reusable templates and Copilot-assisted planning are tracked in issues #7 and #8 and remain deferred.

## Development checks

From `extensions/azure-devops`, run `npm test` for unit and DOM integration coverage. The repeatable browser smoke test runs the real UI against fictional local API fixtures and saves desktop and narrow screenshots:

```powershell
# Use an existing Playwright installation, or install playwright-core in a tools directory.
$env:PLAYWRIGHT_MODULE = 'C:\tools\node_modules\playwright-core\index.mjs'
$env:BRAVE_PATH = 'C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe'
node scripts/workspace-smoke.mjs
```

Set `SMOKE_OUTPUT` to choose a screenshot folder; the default `.workspace-smoke` folder is ignored by Git. This test covers creation and retry, search, draft recovery, conflict review, screenshot uploads, board moves and assignment. It does not sign in to Azure DevOps or modify live work items.
