# Azure Boards only

Remove Azure Repos from this fork while preserving the installed plugin identity and Azure Boards workflow.

- Remove PR actions, APIs, tabs, reviews, branch discovery, pipeline summaries, and repository connection settings.
- Keep organization/project connections, authentication, work-item details, child navigation, editing, comments, attachments, and existing Boards preview behavior.
- Read existing connection records without losing their organization/project; ignore obsolete repository fields.
- Remove Repos tests and convert shared navigation/lifecycle coverage to work items. Verify that startup and Home never request Git data.
- Run the remaining automated tests, compare failures with the previous baseline, and exercise the actual UI in Brave with sample API data at desktop and narrow widths.
- Publish a versioned commit to the fork's main branch after verification. Live Copilot host and authenticated Azure DevOps checks remain distinct from the local browser tests.

Verification: the full suite reports 430 tests, 404 passing, 25 failing, and one TODO. Every failing test name also occurs in the pre-change baseline; the retained failures concern existing authentication and preview controls. Direct work-item URLs now supply connection context for child navigation, edits, comments, and attachments. Automated Brave checks passed at 1440, 900, and 390 pixels, including hierarchy navigation, keyboard disclosure, collapse behavior, connection fields, overflow, and absence of Repos requests. JavaScript syntax, manifest versions, and whitespace checks passed. Version: 0.1.75.
