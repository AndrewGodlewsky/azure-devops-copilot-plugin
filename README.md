# Andrew's Azure DevOps Copilot Plugin [Preview]

This is [Andrew Godlewsky's Azure DevOps Copilot Plugin](https://github.com/AndrewGodlewsky/azure-devops-copilot-plugin). It brings your Azure Boards work into the [GitHub Copilot App](https://github.com/apps/desktop) so you can review and act on it without leaving your Copilot session. Follow the installation steps below to install this fork and receive its updates.

Based on the [Microsoft Azure DevOps Copilot Plugin](https://github.com/microsoft/azure-devops-copilot-plugin), licensed under the [MIT License](LICENSE.txt). This fork is independently maintained by Andrew Godlewsky.

> [!WARNING]
> This is a preview release. It is not supported for production workloads and may change without notice.

## Features

- Customize **Home** with your current work, blocked items, parents with unfinished tasks, and recently completed work.
- Start **Work items** with work assigned to you, search by title or ID, and filter by state, type and tags. Choose **Anyone**, **Unassigned**, or **Specific person** when you want a wider search.
- Create stories, issues, bugs and tasks using the project's actual work item types. **Add task** links a child and inherits its parent's assignment, area and iteration.
- Use **Board** to see your assigned work in a selected project, team and board. Drag cards between columns, or expand **Move** on a card to use the keyboard controls. Open an item and choose **Edit** to change its assignment.
- Edit work items, post comments, attach files, and paste screenshots into descriptions or discussions.
- Recover local drafts and open views after reopening the canvas. Background refresh preserves edits and offers a comparison when Azure DevOps values have changed.
- Navigate open stories and their child tasks in an expandable vertical sidebar.
- See linked child tasks in a work item's **Tasks and child work items** section, and click a task to open its details.
- **Send to chat** from an open story, task, feature or other work item to share its link and saved context with your current Copilot conversation.
- **Suggest tasks** from a story or feature, discuss the proposals with Copilot, then edit and select the tasks to create beneath it.
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

Reusable templates and broader Copilot-assisted planning remain tracked in issues #7 and #8. The task-suggestion workflow below is available now.

### Send a work item to Copilot

Open a work item and select **Send to chat** beside **Add task**. The plugin reads
the latest saved ADO version and sends its link, title, state, assignment,
description, acceptance criteria, child-item summaries, and up to three recent
comments to the conversation that opened the canvas. Long content is shortened
to fit a 16,000-character message; the link provides access to the full item.
Unsaved edits and attachment contents are excluded, and your drafts stay intact.

Copilot is asked to acknowledge the context and wait for your instructions. You
can then ask it to plan or implement the story. If Copilot is already working,
the message queues for its next turn. Sending does not update ADO or open a new
conversation. If delivery cannot be confirmed, check the chat before retrying.

### Suggest child tasks with Copilot

Open a saved story, issue, product backlog item, requirement, feature or epic and
select **Suggest tasks**. Copilot receives its saved context and existing child
summaries in the current conversation. It can inspect the current repository
when relevant and returns up to 12 proposals to a review panel inside the item.
Missing requirements appear as questions; answer or discuss changes in chat to
revise the proposals. No separate AI API key is needed.

Review each task's title, description and **Done when** condition. Edit the text,
deselect anything you do not want, and choose the assignment. By default, tasks
inherit the parent's saved assignment, area and iteration. Select **Create
selected tasks** to create them in ADO with a parent link. Asking for suggestions
or receiving revisions does not create work items.

Local proposal edits stay intact when Copilot sends revisions; choose **Replace
with revised suggestions** to adopt the new proposals. Unsaved story edits are preserved but are not used to
generate or create tasks. If the saved requirements change, generate a new draft.
Existing child titles are checked before creation to catch exact duplicates.
Successful rows show their new task IDs; if creation cannot be confirmed, check
ADO before making a replacement. That row will not be retried automatically.

Suggestion drafts last only for the current canvas session. Closing the review
panel or switching between items keeps them. Local proposal edits are not saved
across a canvas reload, and all suggestion drafts are discarded when the canvas
session ends. This is separate from the saved work-item edit drafts described above.

## Development checks

From `extensions/azure-devops`, run `npm test` for unit and DOM integration coverage. The repeatable browser smoke test runs the real UI against fictional local API fixtures and saves desktop and narrow screenshots:

```powershell
# Use an existing Playwright installation, or install playwright-core in a tools directory.
$env:PLAYWRIGHT_MODULE = 'C:\tools\node_modules\playwright-core\index.mjs'
$env:BRAVE_PATH = 'C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe'
node scripts/workspace-smoke.mjs
```

Set `SMOKE_OUTPUT` to choose a screenshot folder; the default `.workspace-smoke` folder is ignored by Git. This test covers personal defaults, explicit wider search and reset, creation and retry, draft recovery, conflict review, screenshot uploads, board moves, assignment inside item editing, Send to chat feedback, and task suggestion review, editing, selection and creation while preserving unsaved story edits. It does not sign in to Azure DevOps or modify live work items. HTTP tests verify chat requests and proposal callbacks against a stub Copilot session; confirming the complete conversation and task-creation flow in the installed Copilot App requires a live host session.

## License and upstream attribution

Credit for the original project goes to Microsoft and the contributors to the [Microsoft Azure DevOps Copilot Plugin](https://github.com/microsoft/azure-devops-copilot-plugin). Andrew Godlewsky maintains the changes in this fork, which is distributed under the MIT License.

The original **Copyright (c) Microsoft Corporation.** notice and the complete MIT permission and warranty disclaimer are preserved unchanged in [LICENSE.txt](LICENSE.txt). When redistributing copies or substantial portions of this software, retain that license file and its notices.

The upstream link is provided for attribution. Use Andrew's repository in the installation instructions to install this independently maintained fork.
