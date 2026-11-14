# Andrew's Azure DevOps Copilot Plugin [Preview]

This is Andrew Godlewsky's fork of the [Microsoft Azure DevOps Copilot Plugin](https://github.com/microsoft/azure-devops-copilot-plugin). It brings your Azure Boards work into the [GitHub Copilot App](https://github.com/apps/desktop) so you can review and act on it without leaving your Copilot session.

> [!WARNING]
> This is a preview release. It is not supported for production workloads and may change without notice.

## Features

- See **My Work** across Azure Boards.
- Browse and update work items.
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
