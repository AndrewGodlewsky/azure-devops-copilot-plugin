# Andrew's Azure DevOps Copilot Plugin [Preview]

This is [Andrew Godlewsky's Azure DevOps Copilot Plugin](https://github.com/AndrewGodlewsky/azure-devops-copilot-plugin). It brings your Azure Boards work into the [GitHub Copilot App](https://github.com/apps/desktop) so you can review and act on it without leaving your Copilot session. Follow the installation steps below to install this fork and receive its updates.

> [!WARNING]
> This is a preview release. It is not supported for production workloads and may change without notice.

## Features

- Customize **Home** with your current work, blocked items, parents with unfinished tasks, and recently completed work.
- Start **Work items** with work assigned to you, search by title or ID, and filter by state, type and tags. Choose **Anyone**, **Unassigned**, or **Specific person** when you want a wider search.
- Create stories, issues, bugs and tasks using the project's actual work item types. **Add task** links a child and inherits its parent's assignment, area and iteration.
- Use **Board** to see your assigned work in a selected project, team and board, and move cards by dragging or keyboard controls. Open an item and choose **Edit** to change its assignment.
- Edit work items, post comments, attach files, and paste screenshots into descriptions or discussions.
- Recover local drafts and open views after reopening the canvas. Background refresh preserves edits and offers a comparison when Azure DevOps values have changed.
- Navigate open stories and their child tasks in an expandable vertical sidebar.
- See linked child tasks in a work item's **Tasks and child work items** section, and click a task to open its details.
- Work through an interactive Azure DevOps canvas in the GitHub Copilot App.

## Installation

### Install Andrew's fork

1. Add this repository as a marketplace in the GitHub Copilot App. Copy this URL into the marketplace source field:

   ```text
   https://github.com/AndrewGodlewsky/azure-devops-copilot-plugin
   ```

2. Select **andrewgodlewsky-azure-devops** from the **andrewgodlewsky-plugins** catalog. If using the **Install plugin** dialog, enter this exact value in **Name**, then choose **Install**:

   ```text
   andrewgodlewsky-azure-devops@andrewgodlewsky-plugins
   ```

The repository URL registers the marketplace; the `plugin@marketplace` value installs the plugin from that marketplace. Both steps use Andrew's fork.

### If you already installed the original plugin

Install **andrewgodlewsky-azure-devops** using the steps above. Updating Microsoft's original plugin does not switch it to this fork. The distinct plugin and marketplace names allow both to be registered; select Andrew's plugin when installing or updating this version.

## Usage

Open the **Azure DevOps** canvas in the GitHub Copilot App to view My Work, stories, issues, and tasks for your Azure DevOps projects. Choose an organization and optionally a project in **connections**. No Azure Repos repository or Git remote is needed.

The sidebar keeps each opened item's details and edits available as you switch. Expand a story to choose its tasks, or use the close button to close an item's view. Closing a story keeps any independently opened tasks available. Use the navigation toggle to make more room for details; narrow canvases start with navigation collapsed.

This fork focuses on Azure Boards. Azure Repos pull requests, reviews, branch actions, linked commits, and pipeline summaries are not included.

Home and Board show work assigned to the signed-in Azure DevOps user. Work items also starts with **Assigned to me**, and **Clear** returns to that default. To find other work, choose **Anyone** in the Assignee filter and search by title or ID. Linked items and items you explicitly open remain accessible regardless of assignment. Assignment changes are available inside an item's **Edit** form; clear **Assigned to** to unassign it, then **Save**.

Choose a project for Home, Board and creation. An organization connection can search across projects in Work items. Board columns and states come from Azure DevOps, including split columns; your cards are filtered from that team's backlog, so its type and visibility settings still apply. Home sections sample up to 100 items each, show sampling notices, and use the last 14 days for recently completed work. Use Work items for complete paged searches.

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

Set `SMOKE_OUTPUT` to choose a screenshot folder; the default `.workspace-smoke` folder is ignored by Git. This test covers personal defaults, explicit wider search and reset, creation and retry, draft recovery, conflict review, screenshot uploads, board moves and assignment inside item editing. It does not sign in to Azure DevOps or modify live work items.

## Upstream attribution

This project is a fork of the [Microsoft Azure DevOps Copilot Plugin](https://github.com/microsoft/azure-devops-copilot-plugin). That link is provided for attribution; the installation source for this fork is Andrew's repository listed above.
