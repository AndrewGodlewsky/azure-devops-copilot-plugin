// Runs the real canvas in Brave against a local, fictional Azure DevOps fixture.
// Install playwright-core in a separate tools directory and set PLAYWRIGHT_MODULE
// to its index.mjs, or install it locally without changing the package lock.
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright-core");
const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const output = path.resolve(process.env.SMOKE_OUTPUT || path.join(root, "../../..", ".workspace-smoke"));
mkdirSync(output, { recursive: true });
const connection = { organization: "contoso", project: "Northwind", source: "default", isDefault: true };
const states = [{ name: "New", category: "Proposed" }, { name: "Active", category: "InProgress" }, { name: "Done", category: "Completed" }];
const columns = ["New", "Active", "Done"].map((name, index) => ({ id: `column-${index}`, name, isSplit: false, stateMappings: { "User Story": name, Task: name, Bug: name } }));
const items = new Map();
const drafts = new Map();
let preferences = {}, nextId = 200;
let failNextCreate = false, failNextMove = false;
let chatGate, failChatSend = false;
const chatSends = [];
function item(id, title, type = "User Story", state = "Active") {
    return { id, rev: 1, title, type, state, project: "Northwind", assignedTo: "Alex Morgan", states: states.map(s => s.name),
        area: "Northwind", iteration: "Northwind\\Sprint 6", tags: [], discussion: [], commentCount: 0, relations: [],
        columnId: columns.find(c => c.name === state).id, columnDone: false,
        templateSections: [{ title: "Description", column: 1, fields: [{ name: "Description", field: "System.Description", isRichText: true, isHtml: true, format: "html", value: "<p>Make account setup clear and accessible.</p>" }] }],
    };
}
items.set(142, item(142, "Improve account setup"));
items.set(143, item(143, "Build setup form", "Task", "New"));
items.set(150, item(150, "Improve profile editing", "User Story", "Done"));
items.set(160, { ...item(160, "Review another person's feature", "User Story"), assignedTo: "Jamie Rivera" });
items.set(161, { ...item(161, "Triage an unassigned task", "Task"), assignedTo: "Unassigned" });
const myItems = () => [...items.values()].filter(item => item.assignedTo === "Alex Morgan");
items.get(142).relations = [{ name: "Children", links: [{ id: 143, kind: "work-item", kindLabel: "Task", label: "Task 143", title: "Build setup form", state: "New", project: "Northwind" }] }];
const theme = '<style>:root{color-scheme:dark;--background-color-default:#0d1117;--background-color-muted:#161b22;--text-color-default:#e6edf3;--text-color-muted:#9198a1;--text-color-link:#58a6ff;--text-color-accent:#58a6ff;--border-color-default:#30363d;--border-color-muted:#30363d;--background-color-neutral-muted:#21262d;--background-color-accent-muted:#1f2d41;--background-color-accent-emphasis:#0969da}</style>';
const requests = [];
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aSUYAAAAASUVORK5CYII=", "base64");
const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, "http://localhost");
        const pathname = url.pathname;
        requests.push(`${req.method} ${pathname}`);
        const json = (body, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const bytes = Buffer.concat(chunks);
        const body = req.headers["content-type"]?.includes("application/json") && bytes.length ? JSON.parse(bytes) : {};
        if (pathname === "/api/config") return json({ apiNonce: "sample-nonce", config: { auth: { isAuthenticated: true, authType: "microsoft" }, connections: [connection], extensionVersion: "workspace-preview", featureFlags: {} } });
        if (pathname === "/api/workspace/preferences") { if (req.method === "PATCH") preferences = { ...preferences, ...body }; return json({ preferences }); }
        if (pathname === "/api/workspace/metadata") return json({ projects: [{ id: "northwind", name: "Northwind" }], teams: [{ id: "team", name: "Northwind Team" }], types: ["User Story", "Task", "Bug"].map(name => ({ name, states })) });
        if (pathname === "/api/workspace/dashboard") return json({ current: { workItems: myItems().filter(i => i.state !== "Done"), count: 2 }, blocked: { workItems: [], count: 0 }, unfinished: { workItems: [{ ...items.get(142), incompleteChildCount: 1 }], count: 1 }, completed: { workItems: [items.get(150)], count: 1 } });
        if (pathname === "/api/workspace/items") {
            if (req.method === "POST") {
                if (failNextCreate) { failNextCreate = false; return json({ message: "Sample network failure; retry safely." }, 503); }
                const created = item(++nextId, body.title, body.type, "New");
                if (body.description) created.templateSections[0].fields[0].value = body.description;
                items.set(created.id, created);
                if (body.parentId) { const parent = items.get(body.parentId); parent.rev++; parent.relations[0].links.push({ id: created.id, kind: "work-item", kindLabel: created.type, label: `${created.type} ${created.id}`, title: created.title, state: created.state, project: created.project }); }
                return json({ workItem: created });
            }
            const query = (url.searchParams.get("query") || "").toLowerCase();
            const assignee = url.searchParams.get("assignee") || "mine";
            const workItems = [...items.values()].filter(i =>
                (assignee === "all" || (assignee === "mine" ? i.assignedTo === "Alex Morgan" : i.assignedTo === (assignee === "unassigned" ? "Unassigned" : assignee)))
                && (i.title.toLowerCase().includes(query) || String(i.id) === query));
            return json({ workItems, count: workItems.length, nextCursor: null });
        }
        if (pathname === "/api/workspace/boards") return json({ boards: [{ id: "stories", name: "Stories" }] });
        if (pathname === "/api/workspace/board") return json({ id: "stories", name: "Stories", columns, workItems: myItems(), scopeNote: "Your assigned work in this team's backlog." });
        if (pathname === "/api/workspace/board/move") {
            if (failNextMove) { failNextMove = false; return json({ message: "Sample revision conflict. Refresh and retry." }, 409); }
            const target = items.get(body.id); assert.equal(body.rev, target.rev);
            target.columnId = body.columnId; target.state = columns.find(c => c.id === body.columnId).name; target.rev++;
            return json({ workItem: target });
        }
        const match = pathname.match(/^\/api\/work-items\/(\d+)(?:\/(details|draft|comments|attachments|send-to-chat))?$/);
        if (match) {
            const target = items.get(Number(match[1]));
            if (match[2] === "send-to-chat") {
                assert.equal(req.method, "POST");
                assert.equal(req.headers["x-canvas-nonce"], "sample-nonce");
                assert.equal(url.searchParams.get("workItemProject"), target.project);
                chatSends.push(target.id);
                await chatGate;
                return failChatSend ? json({ message: "Could not confirm delivery. Check the chat before trying again." }, 503) : json({ ok: true });
            }
            if (match[2] === "draft") { if (req.method === "PUT") drafts.set(target.id, body); if (req.method === "DELETE") drafts.delete(target.id); return json({ draft: drafts.get(target.id) || null }); }
            if (match[2] === "attachments") { target.rev++; return json({ attachment: { fileName: url.searchParams.get("fileName"), url: "https://dev.azure.com/contoso/11111111-1111-4111-8111-111111111111/_apis/wit/attachments/22222222-2222-4222-8222-222222222222" }, rev: target.rev }); }
            if (match[2] === "comments") { target.discussion.push({ id: 1, author: "Alex Morgan", text: body.content, format: "markdown" }); target.commentCount++; target.rev++; }
            if (req.method === "PATCH") {
                if (body.rev !== target.rev) return json({ error: "azure_devops_work_item_out_of_date", message: "Revision changed" }, 409);
                for (const field of body.fields) {
                    if (field.name === "System.Title") target.title = field.value;
                    else if (field.name === "System.AssignedTo") target.assignedTo = field.value || "Unassigned";
                    else for (const section of target.templateSections) for (const saved of section.fields) if (saved.field === field.name) saved.value = field.value;
                }
                target.rev++;
            }
            return json({ workItem: target });
        }
        if (pathname === "/api/identities") return json({ identities: [] });
        if (pathname === "/api/attachment") { res.writeHead(200, { "Content-Type": "image/png" }); return res.end(png); }
        if (pathname === "/favicon.ico") { res.writeHead(204); return res.end(); }
        if (pathname === "/") { res.setHeader("Content-Type", "text/html"); return res.end(readFileSync(path.join(root, "ui/index.html"), "utf8").replace("</head>", theme + "</head>")); }
        const file = path.resolve(root, "." + pathname);
        if (!file.startsWith(root + path.sep) || !existsSync(file)) return json({ message: "Unknown fixture endpoint" }, 404);
        res.setHeader("Content-Type", file.endsWith(".css") ? "text/css" : "text/javascript"); res.end(readFileSync(file));
    } catch (error) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ message: error.message })); }
});

let browser, page;
try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    browser = await chromium.launch({ executablePath: process.env.BRAVE_PATH || "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe", headless: true });
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.goto(origin);
    await page.getByRole("heading", { name: "My current work", exact: false }).waitFor();
    assert.doesNotMatch(await page.locator(".workspace-dashboard").innerText(), /another person's|unassigned task/);
    await page.screenshot({ path: path.join(output, "home-desktop.png"), fullPage: true });
    await page.locator('[data-workspace-view="items"]').click();
    await page.locator(".workspace-table tbody tr").first().waitFor();
    assert.equal(await page.getByRole("combobox", { name: "Assignee", exact: true }).inputValue(), "mine");
    assert.equal(await page.locator(".workspace-table tbody tr").count(), 3);
    assert.doesNotMatch(await page.locator(".workspace-table").innerText(), /Jamie Rivera|Unassigned/);
    await page.getByRole("combobox", { name: "Assignee", exact: true }).selectOption("all");
    await page.getByRole("searchbox", { name: "Search work items" }).fill("160");
    await page.getByRole("button", { name: "Apply filters", exact: true }).click();
    await page.getByRole("button", { name: "Open User Story 160: Review another person's feature", exact: true }).click();
    await page.locator(".tab-panel:not([hidden]) .work-item-title").filter({ hasText: "Review another person's feature" }).waitFor();
    await page.locator('[data-workspace-view="items"]').click();
    await page.getByRole("button", { name: "Clear", exact: true }).click();
    await page.getByRole("button", { name: "Open User Story 142: Improve account setup", exact: true }).waitFor();
    assert.equal(await page.getByRole("combobox", { name: "Assignee", exact: true }).inputValue(), "mine");
    assert.doesNotMatch(await page.locator(".workspace-table").innerText(), /Jamie Rivera|Unassigned/);
    await page.getByRole("searchbox", { name: "Search work items" }).fill("profile");
    await page.getByRole("button", { name: "Apply filters", exact: true }).click();
    await page.getByRole("button", { name: "Open User Story 150: Improve profile editing", exact: true }).waitFor();
    assert.equal(await page.locator(".workspace-table tbody tr").count(), 1);
    await page.getByRole("button", { name: "Clear", exact: true }).click();
    await page.getByRole("button", { name: "Open User Story 142: Improve account setup", exact: true }).click();
    const story = page.locator(".tab-panel:not([hidden])");
    await story.getByRole("button", { name: "Send to chat", exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, "send-chat-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 900 });
    await page.screenshot({ path: path.join(output, "send-chat-390.png"), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "No Send to chat overflow at 390px");
    await page.setViewportSize({ width: 1440, height: 1000 });
    let finishChat;
    chatGate = new Promise(resolve => { finishChat = resolve; });
    await story.getByRole("button", { name: "Send to chat", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.tab-panel:not([hidden]) .work-item-send-chat')?.disabled);
    await story.getByRole("button", { name: "Edit this work item", exact: true }).click();
    assert.equal(await story.locator(".work-item-send-chat").isDisabled(), true);
    finishChat();
    await story.locator(".work-item-chat-status").filter({ hasText: "Sent to chat" }).waitFor();
    assert.deepEqual(chatSends, [142]);
    await story.locator(".editor-cancel").click();
    await page.getByRole("button", { name: "Add task", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox", { name: "Title", exact: true }).fill("Review setup accessibility");
    failNextCreate = true;
    await dialog.getByRole("button", { name: "Create work item", exact: true }).click();
    await dialog.getByRole("alert").filter({ hasText: "Sample network failure" }).waitFor();
    assert.equal(await dialog.getByRole("textbox", { name: "Title", exact: true }).inputValue(), "Review setup accessibility");
    await dialog.getByRole("button", { name: "Create work item", exact: true }).click();
    await page.locator(".tab-panel:not([hidden]) .work-item-title").filter({ hasText: "Review setup accessibility" }).waitFor();
    assert.equal(items.get(142).relations[0].links.at(-1).id, 201);
    await page.locator(".tab-panel:not([hidden]) .work-item-title-row .inline-edit").click();
    const titleInput = page.locator(".tab-panel:not([hidden]) .work-item-title-edit input");
    await titleInput.fill("A recoverable draft");
    await page.waitForFunction(() => document.querySelector('.tab-panel:not([hidden]) .draft-notice')?.textContent.includes('Draft saved on this device'));
    await page.reload();
    await page.getByRole("button", { name: "Restore draft", exact: true }).click();
    assert.equal(await titleInput.inputValue(), "A recoverable draft");
    items.get(201).title = "Changed in Azure DevOps"; items.get(201).rev++;
    await page.getByRole("button", { name: "refresh", exact: true }).click();
    await page.getByRole("button", { name: "Apply choices", exact: true }).waitFor();
    assert.equal(await titleInput.inputValue(), "A recoverable draft");
    await page.getByRole("button", { name: "Apply choices", exact: true }).click();
    await page.locator(".tab-panel:not([hidden]) .editor-save").click();
    await page.locator(".tab-panel:not([hidden]) .work-item-title").filter({ hasText: "A recoverable draft" }).waitFor();
    const comment = page.locator(".tab-panel:not([hidden]) .comment-composer-body");
    await comment.fill("Screenshot for review: ");
    await comment.evaluate((node, data) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([Uint8Array.from(atob(data), c => c.charCodeAt(0))], "screen.png", { type: "image/png" }));
        node.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
    }, png.toString("base64"));
    await page.locator(".tab-panel:not([hidden]) .comment-attachment img").waitFor();
    assert.match(await comment.innerText(), /Screenshot for review/);
    await page.waitForFunction(() => document.querySelector('.tab-panel:not([hidden]) .draft-notice')?.textContent.includes('Draft saved on this device'));
    assert.match(drafts.get(201).comment.content, /!\[screen.png\]/);
    await page.locator('[data-workspace-view="board"]').click();
    await page.locator(".workspace-board-card").first().waitFor();
    assert.equal(await page.locator('.workspace-board [data-item-id="160"], .workspace-board [data-item-id="161"]').count(), 0);
    assert.equal(await page.locator(".workspace-card-assignment, .workspace-assignee").count(), 0);
    let card = page.locator('[data-item-id="143"]');
    await card.getByRole("combobox", { name: "Move 143 to" }).selectOption({ label: "Active" });
    await card.getByRole("button", { name: "Move", exact: true }).focus();
    await page.keyboard.press("Enter");
    await page.locator('[data-column-id="column-1"] [data-item-id="143"][aria-busy="false"]').waitFor();
    assert.equal(items.get(143).state, "Active");
    failNextMove = true;
    await card.getByRole("combobox", { name: "Move 143 to" }).selectOption({ label: "Done" });
    await card.getByRole("button", { name: "Move", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Move was not saved" }).waitFor();
    assert.equal(items.get(143).state, "Active");
    await card.dragTo(page.locator('[data-column-id="column-2"]'));
    await page.locator('[data-column-id="column-2"] [data-item-id="143"][aria-busy="false"]').waitFor();
    assert.equal(items.get(143).state, "Done");
    await card.getByRole("button", { name: "Open Task 143: Build setup form", exact: true }).click();
    const detail = page.locator(".tab-panel:not([hidden])");
    await detail.getByRole("button", { name: "Edit this work item", exact: true }).click();
    await detail.getByRole("textbox", { name: "Assigned to", exact: true }).fill("jamie@example.com");
    failChatSend = true;
    await detail.getByRole("button", { name: "Send to chat", exact: true }).click();
    await detail.locator('.work-item-chat-status[role="alert"]').filter({ hasText: "Check the chat" }).waitFor();
    assert.equal(await detail.getByRole("textbox", { name: "Assigned to", exact: true }).inputValue(), "jamie@example.com");
    failChatSend = false;
    await detail.getByRole("button", { name: "Send to chat", exact: true }).click();
    await detail.locator(".work-item-chat-status").filter({ hasText: "Sent to chat" }).waitFor();
    assert.equal(items.get(143).assignedTo, "Alex Morgan", "Sending does not save the draft");
    await page.screenshot({ path: path.join(output, "assignment-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 900 });
    await page.screenshot({ path: path.join(output, "assignment-390.png"), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "No assignment edit overflow at 390px");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await detail.locator(".editor-save").click();
    await detail.locator(".work-item-meta-badge strong").filter({ hasText: "jamie@example.com" }).waitFor();
    assert.equal(items.get(143).assignedTo, "jamie@example.com");
    await page.locator('[data-workspace-view="board"]').click();
    await page.locator(".workspace-board-card").first().waitFor();
    assert.equal(await page.locator('[data-item-id="143"]').count(), 0, "Reassigned items leave the personal board");
    await page.screenshot({ path: path.join(output, "board-desktop.png"), fullPage: true });
    for (const width of [900, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await page.screenshot({ path: path.join(output, `board-${width}.png`), fullPage: true });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `No page overflow at ${width}px`);
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(requests.filter(request => /pull-request|repositories|pipeline|new-session-branch/.test(request)), []);
    console.log(`PASS: Brave personal defaults, explicit wider search and reset, completed items, linked child creation, failed-create retry, persistent drafts, conflict review, screenshot paste, keyboard/drag board moves, failed-move rollback, assignment inside item editing, Send to chat pending/error/retry/draft preservation, desktop/900px/390px layouts. Screenshots: ${output}`);
} catch (error) {
    if (page) { await page.screenshot({ path: path.join(output, "failure.png"), fullPage: true }); console.error(await page.locator("body").innerText()); }
    throw error;
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
