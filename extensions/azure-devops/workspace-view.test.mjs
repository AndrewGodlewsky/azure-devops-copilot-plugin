import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspaceView } from "./ui/workspace-view.mjs";

let JSDOM;
try { ({ JSDOM } = await import("jsdom")); } catch { JSDOM = null; }
const needsDom = { skip: JSDOM ? false : "jsdom is not installed" };
const settle = () => new Promise(resolve => setTimeout(resolve, 10));
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const item = (id, extra = {}) => ({ id, rev: 4, type: "Task", title: `Build widget ${id}`, state: "Active", assignedTo: "Ada Lovelace", project: "Widgets", tags: [], ...extra });
const metadata = {
    projects: [{ id: "widgets", name: "Widgets" }, { id: "boxes", name: "Boxes" }],
    types: [{ name: "User Story", states: [{ name: "New", category: "Proposed" }, { name: "Closed", category: "Completed" }] }, { name: "Task", states: [{ name: "Active", category: "InProgress", color: "007acc" }, { name: "Done", category: "Completed" }] }],
    teams: [{ id: "web", name: "Web team" }, { id: "platform", name: "Platform team" }],
};
const boardData = () => ({ id: "stories", name: "Stories", columns: [
    { id: "ready", name: "Ready", isSplit: false, stateMappings: { Task: "New" } },
    { id: "working", name: "Working", isSplit: true, stateMappings: { Task: "Active" } },
    { id: "closed", name: "Complete", isSplit: false, stateMappings: { Task: "Done" } },
], workItems: [item(11, { columnId: "ready", columnDone: false })] });

function setup(t, options = {}) {
    const dom = new JSDOM('<button id="outside">Outside</button><div id="workspace"></div>', { url: "http://localhost:4000/", pretendToBeVisual: true });
    const { document } = dom.window;
    const container = document.getElementById("workspace");
    const calls = [];
    const opened = [];
    const created = [];
    const changes = [];
    const views = [];
    const state = { preferences: {}, items: { workItems: [item(11), item(12, { state: "Done" })], nextCursor: "", count: 2 }, board: boardData(), ...options.state };
    const request = async (path, requestOptions = {}) => {
        const url = new URL(path, "http://localhost");
        const method = requestOptions.method || "GET";
        const body = requestOptions.body ? JSON.parse(requestOptions.body) : null;
        const call = { path: url.pathname, params: url.searchParams, method, body };
        calls.push(call);
        if (options.handle) { const handled = options.handle(call, state); if (handled !== undefined) return await handled; }
        if (url.pathname === "/api/workspace/preferences") {
            if (method === "PATCH") Object.assign(state.preferences, body);
            return { preferences: structuredClone(state.preferences) };
        }
        if (url.pathname === "/api/workspace/metadata") return structuredClone(metadata);
        if (url.pathname === "/api/workspace/items") {
            if (method === "POST") return { workItem: item(99, { title: body.title, type: body.type }) };
            return structuredClone(state.items);
        }
        if (url.pathname === "/api/workspace/boards") return { boards: [{ id: "stories", name: "Stories" }, { id: "features", name: "Features" }] };
        if (url.pathname === "/api/workspace/board") return structuredClone(state.board);
        if (url.pathname === "/api/workspace/board/move") {
            state.board.workItems[0] = { ...state.board.workItems[0], columnId: body.columnId, columnDone: body.done, rev: body.rev + 1 };
            return { workItem: structuredClone(state.board.workItems[0]) };
        }
        if (url.pathname === "/api/workspace/dashboard") return state.dashboard || Object.fromEntries(["current", "blocked", "unfinished", "completed"].map(name => [name, { workItems: [item(11, { incompleteChildCount: 2 })], count: 1 }]));
        throw new Error(`Unexpected request ${method} ${path}`);
    };
    const controller = createWorkspaceView(container, {
        request, connections: options.connections || [{ organization: "contoso", project: "Widgets" }],
        onOpenWorkItem: (...args) => opened.push(args), onCreated: (...args) => created.push(args), onChange: () => changes.push(true), onViewChange: value => views.push(value),
    });
    t.after(() => { controller.destroy(); dom.window.close(); });
    const control = label => document.querySelector(`[aria-label="${label}"]`);
    const click = text => { const node = [...document.querySelectorAll("button")].find(node => node.textContent === text); assert.ok(node, `Button ${text} exists`); node.click(); return node; };
    const submit = node => node.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    const change = (node, value) => { node.value = value; node.dispatchEvent(new dom.window.Event("change", { bubbles: true })); };
    return { controller, window: dom.window, document, container, calls, state, opened, created, changes, views, control, click, submit, change };
}

test("work-item list defaults to my assignments, includes completed work and preserves scope when opening", needsDom, async t => {
    const ui = setup(t, { connections: [{ organization: "contoso", project: "" }] });
    await ui.controller.show("items");
    const request = ui.calls.find(call => call.path === "/api/workspace/items");
    assert.equal(request.params.get("assignee"), "mine");
    assert.equal(ui.control("Assignee").value, "mine");
    assert.equal(request.params.has("state"), false);
    assert.equal(request.params.has("project"), false);
    assert.match(ui.container.textContent, /Done/);
    assert.equal(ui.container.querySelector(".workspace-table").textContent.includes("Unassigned"), false);
    ui.control("Open Task 12: Build widget 12").click();
    assert.equal(ui.opened[0][0].id, 12);
    assert.equal(ui.opened[0][1].organization, "contoso");
    assert.equal(ui.opened[0][1].project, "");
    assert.equal(ui.opened[0][1].workItemProject, "Widgets");
    assert.deepEqual(ui.views, ["items"]);
});

test("wider searches are explicit and Clear returns to my work without restoring a broad default", needsDom, async t => {
    const ui = setup(t, { state: { preferences: { workspace: { view: "items", assignee: "all" } } }, handle(call) {
        if (call.path === "/api/workspace/items") return { workItems: call.params.get("assignee") === "all"
            ? [item(13, { assignedTo: "Unassigned" }), item(14, { assignedTo: "Other Person" })] : [item(11)] };
    } });
    await ui.controller.show("items");
    assert.equal(ui.calls.filter(call => call.path.endsWith("/items")).at(-1).params.get("assignee"), "mine");
    ui.change(ui.control("Assignee"), "all");
    ui.control("Search work items").value = "widget";
    ui.submit(ui.control("Filter work items")); await settle();
    assert.match(ui.container.querySelector(".workspace-table").textContent, /Unassigned/);
    ui.control("Open Task 13: Build widget 13").click();
    assert.equal(ui.opened[0][0].id, 13);
    ui.click("Clear"); await settle();
    assert.equal(ui.control("Assignee").value, "mine");
    assert.equal(ui.control("Search work items").value, "");
    assert.equal(ui.calls.filter(call => call.path.endsWith("/items")).at(-1).params.get("assignee"), "mine");
    assert.doesNotMatch(ui.container.querySelector(".workspace-table").textContent, /Unassigned|Other Person/);
});

test("filters encode query, assignment, state, type and tags; opaque pagination can go back", needsDom, async t => {
    const ui = setup(t, { handle(call) {
        if (call.path === "/api/workspace/items") return { workItems: [item(call.params.has("cursor") ? 21 : 11)], count: 1, nextCursor: call.params.has("cursor") ? "" : "opaque+/=?cursor" };
    } });
    await ui.controller.show("items");
    ui.control("Search work items").value = "widget & boxes";
    ui.change(ui.control("Assignee"), "unassigned");
    ui.change(ui.control("Work item type"), "Task");
    ui.change(ui.control("State"), "Done");
    ui.control("Tags").value = "urgent; UX";
    ui.submit(ui.control("Filter work items")); await settle();
    const filtered = ui.calls.filter(call => call.path === "/api/workspace/items").at(-1);
    assert.deepEqual(Object.fromEntries(["query", "assignee", "state", "type", "tags"].map(name => [name, filtered.params.get(name)])), { query: "widget & boxes", assignee: "unassigned", state: "Done", type: "Task", tags: "urgent; UX" });
    ui.click("Next"); await settle();
    assert.equal(ui.calls.filter(call => call.path === "/api/workspace/items").at(-1).params.get("cursor"), "opaque+/=?cursor");
    assert.match(ui.container.textContent, /page 2/);
    assert.equal(ui.click("Next").disabled, true);
    ui.click("Previous"); await settle();
    assert.equal(ui.calls.filter(call => call.path === "/api/workspace/items").at(-1).params.has("cursor"), false);
    assert.match(ui.container.textContent, /page 1/);
});

test("later searches win over stale responses and background refresh retains filter DOM and drafts", needsDom, async t => {
    const slow = deferred();
    const ui = setup(t, { handle(call) {
        if (call.path === "/api/workspace/items" && call.params.get("query") === "slow") return slow.promise;
    } });
    await ui.controller.show("items");
    const search = ui.control("Search work items");
    search.value = "slow";
    ui.submit(ui.control("Filter work items")); await settle();
    search.value = "latest";
    ui.submit(ui.control("Filter work items")); await settle();
    slow.resolve({ workItems: [item(77, { title: "Stale result" })], count: 1 }); await settle();
    assert.doesNotMatch(ui.container.textContent, /Stale result/);
    search.value = "Unsaved search text";
    search.focus();
    search.setSelectionRange(3, 8);
    await ui.controller.refresh({ background: true });
    assert.equal(ui.control("Search work items"), search);
    assert.equal(search.value, "Unsaved search text");
    assert.equal(ui.document.activeElement, search);
    assert.equal(search.selectionStart, 3);
});

test("project selection is restricted for project connections and metadata races cannot replace a newer scope", needsDom, async t => {
    const slow = deferred();
    const ui = setup(t, { connections: [{ organization: "contoso", project: "Widgets" }, { organization: "fabrikam", project: "" }], handle(call) {
        if (call.path === "/api/workspace/metadata" && call.params.get("organization") === "fabrikam") return slow.promise;
    } });
    await ui.controller.show("items");
    assert.deepEqual([...ui.control("Project").options].map(option => option.value), ["Widgets"]);
    ui.change(ui.control("Organization connection"), "1"); await settle();
    ui.change(ui.control("Organization connection"), "0"); await settle();
    slow.resolve({ projects: [{ name: "Wrong project" }], types: [], teams: [] }); await settle();
    assert.equal(ui.control("Organization connection").value, "0");
    assert.doesNotMatch(ui.container.textContent, /Wrong project/);
});

test("initial list load and refresh errors keep in-progress filter fields", needsDom, async t => {
    const held = deferred();
    let fail = false;
    const ui = setup(t, { handle(call) {
        if (call.path === "/api/workspace/items") return fail ? Promise.reject(new Error("Connection interrupted")) : held.promise;
    } });
    const showing = ui.controller.show("items"); await settle();
    const search = ui.control("Search work items");
    search.value = "Unsubmitted query";
    search.focus();
    held.resolve({ workItems: [item(11)], count: 1 }); await showing;
    assert.equal(ui.control("Search work items"), search);
    assert.equal(search.value, "Unsubmitted query");
    fail = true;
    await ui.controller.refresh({ background: true });
    assert.equal(ui.control("Search work items"), search);
    assert.equal(ui.document.activeElement, search);
    assert.match(ui.container.textContent, /Connection interrupted/);
});

test("creation uses project types and parent context, escapes description, and retains values after failure", needsDom, async t => {
    let fail = true;
    const ui = setup(t, { handle(call) {
        if (call.path === "/api/workspace/items" && call.method === "POST" && fail) throw new Error("Permission denied in Widgets");
    } });
    await ui.controller.show("items");
    const parent = item(40, { type: "User Story", title: "Build accessible widgets", area: "Widgets\\Web", iteration: "Widgets\\Sprint 1" });
    await ui.controller.openCreate({ connection: { organization: "contoso", project: "Widgets" }, parent });
    const dialog = ui.document.querySelector("dialog");
    assert.deepEqual([...dialog.querySelector('[aria-label="Work item type"]').options].map(option => option.value), ["User Story", "Task"]);
    assert.equal(dialog.querySelector('[aria-label="Work item type"]').value, "Task");
    assert.equal(ui.control("Creation project").disabled, true);
    ui.control("Title").value = "Write widget tests";
    ui.control("Description").value = "<script>alert(1)</script>\nKeep details";
    ui.control("Assigned to").value = "ada@example.com";
    ui.submit(dialog.querySelector("form")); await settle();
    assert.match(dialog.textContent, /Permission denied/);
    assert.equal(ui.control("Title").value, "Write widget tests");
    assert.equal(ui.control("Description").value, "<script>alert(1)</script>\nKeep details");
    assert.equal(dialog.querySelector("script"), null);
    assert.equal(ui.created.length, 0);
    const call = ui.calls.find(call => call.method === "POST");
    assert.deepEqual(call.body, { type: "Task", title: "Write widget tests", description: "<p>&lt;script&gt;alert(1)&lt;/script&gt;<br>Keep details</p>", parentId: 40, assignedTo: "ada@example.com" });
    fail = false;
    ui.submit(dialog.querySelector("form")); await settle();
    assert.equal(ui.document.querySelector("dialog"), null);
    assert.equal(ui.created[0][0].id, 99);
    assert.equal(ui.created[0][1].workItemProject, "Widgets");
    assert.equal(ui.created[0][2], parent);
});

test("creation selects a project in an organization connection and ignores stale type metadata", needsDom, async t => {
    const slow = deferred();
    const ui = setup(t, { connections: [{ organization: "contoso", project: "" }], handle(call) {
        if (call.path === "/api/workspace/metadata" && call.params.get("workItemProject") === "Boxes") return slow.promise;
    } });
    await ui.controller.openCreate();
    assert.equal(ui.click("Create work item").disabled, true);
    ui.change(ui.control("Creation project"), "Boxes"); await settle();
    ui.change(ui.control("Creation project"), "Widgets"); await settle();
    slow.resolve({ ...metadata, types: [{ name: "Wrong type", states: [] }] }); await settle();
    assert.equal(ui.control("Creation project").value, "Widgets");
    assert.doesNotMatch(ui.document.querySelector("dialog").textContent, /Wrong type/);
    ui.control("Title").value = "Keep my title";
    const title = ui.control("Title");
    await ui.controller.refresh({ background: true });
    assert.equal(ui.control("Title"), title);
    assert.equal(title.value, "Keep my title");
});

test("native board renders actual split columns and keyboard moves use revision and actual column ID", needsDom, async t => {
    const held = deferred();
    const ui = setup(t, { handle(call) { if (call.path === "/api/workspace/board/move") return held.promise; } });
    await ui.controller.show("board");
    assert.deepEqual([...ui.container.querySelectorAll(".workspace-column-heading h2")].map(node => node.textContent), ["Ready", "Working / In progress", "Working / Done", "Complete"]);
    const move = ui.control("Move 11 to");
    ui.change(move, JSON.stringify(["working", true]));
    ui.submit(move.closest("form")); await settle();
    const call = ui.calls.find(call => call.path === "/api/workspace/board/move");
    assert.deepEqual(call.body, { id: 11, rev: 4, columnId: "working", done: true });
    assert.equal(call.params.get("team"), "web");
    assert.equal(call.params.get("boardId"), "stories");
    assert.equal(ui.container.querySelector('[data-item-id="11"]').closest(".workspace-board-column").dataset.done, "true");
    assert.equal(ui.control("Move 11 to").disabled, true);
    held.resolve({ workItem: item(11, { columnId: "working", columnDone: true, rev: 5 }) }); await settle();
    assert.equal(ui.changes.length, 1);
    assert.match(ui.container.textContent, /moved to Working \/ Done/);
});

test("failed board movement rolls back with a useful error and keyboard focus", needsDom, async t => {
    const ui = setup(t, { handle(call) { if (call.path === "/api/workspace/board/move") throw new Error("Revision conflict. Refresh and try again."); } });
    await ui.controller.show("board");
    const move = ui.control("Move 11 to");
    ui.change(move, JSON.stringify(["closed", false]));
    const submitButton = move.closest("form").querySelector("button");
    submitButton.focus();
    ui.submit(move.closest("form")); await settle();
    assert.equal(ui.container.querySelector('[data-item-id="11"]').closest(".workspace-board-column").dataset.columnId, "ready");
    assert.match(ui.container.querySelector('[role="alert"]').textContent, /Revision conflict/);
    assert.equal(ui.changes.length, 0);
    assert.equal(ui.document.activeElement.dataset.focusKey, "11:move");
});

test("board cards omit assignment controls and owner text while retaining navigation and drag-and-drop", needsDom, async t => {
    const ui = setup(t);
    await ui.controller.show("board");
    const card = ui.container.querySelector('[data-item-id="11"]');
    assert.equal(card.querySelector(".workspace-card-assignment"), null);
    assert.equal(card.querySelector(".workspace-assignee"), null);
    assert.equal(card.querySelector("input"), null);
    card.querySelector(".workspace-item-link").click();
    assert.equal(ui.opened[0][0].id, 11);
    const drag = new ui.window.Event("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperty(drag, "dataTransfer", { value: { setData() {} } });
    card.dispatchEvent(drag);
    ui.container.querySelector('[data-column-id="working"][data-done="false"]').dispatchEvent(new ui.window.Event("drop", { bubbles: true, cancelable: true }));
    await settle();
    assert.equal(ui.calls.find(call => call.path.endsWith("/move")).body.columnId, "working");
});

test("background board refresh waits for an optimistic mutation instead of overwriting it", needsDom, async t => {
    const held = deferred();
    const ui = setup(t, { handle(call, state) {
        if (call.path === "/api/workspace/board/move") return held.promise.then(() => {
            state.board.workItems[0] = item(11, { columnId: "closed", columnDone: false, rev: 5 });
            return { workItem: state.board.workItems[0] };
        });
    } });
    await ui.controller.show("board");
    ui.change(ui.control("Move 11 to"), JSON.stringify(["closed", false]));
    ui.submit(ui.control("Move 11 to").closest("form")); await settle();
    await ui.controller.refresh({ background: true });
    assert.equal(ui.calls.filter(call => call.path === "/api/workspace/board").length, 1);
    held.resolve(); await settle(); await settle();
    assert.equal(ui.container.querySelector('[data-item-id="11"]').closest(".workspace-board-column").dataset.columnId, "closed");
    assert.equal(ui.calls.filter(call => call.path === "/api/workspace/board").length, 2);
});

test("Home renders section errors, incomplete counts and sample limits; choices persist", needsDom, async t => {
    const ui = setup(t, { state: { preferences: { dashboardSections: ["unfinished", "completed"] }, dashboard: {
        unfinished: { workItems: [item(11, { incompleteChildCount: 3 })], count: 1, truncated: true, sampleLimit: 100 },
        completed: { workItems: [], count: 0, error: "Project temporarily unavailable" },
    } } });
    await ui.controller.show("home");
    assert.equal(ui.container.querySelectorAll(".workspace-dashboard-section").length, 2);
    assert.match(ui.container.textContent, /3 unfinished child items/);
    assert.match(ui.container.textContent, /sample of up to 100/);
    assert.match(ui.container.textContent, /Project temporarily unavailable/);
    const current = ui.control("My current work");
    current.checked = true;
    current.dispatchEvent(new ui.window.Event("change", { bubbles: true }));
    await settle();
    assert.deepEqual(ui.state.preferences.dashboardSections, ["current", "unfinished", "completed"]);
    assert.equal(ui.container.querySelectorAll(".workspace-dashboard-section").length, 3);
    assert.equal(ui.calls.filter(call => call.path === "/api/workspace/dashboard").length, 1);
});

test("failed dashboard preferences retain the selection and retry without losing unrelated preferences", needsDom, async t => {
    let fail = true;
    const ui = setup(t, { handle(call) {
        if (call.path === "/api/workspace/preferences" && call.method === "PATCH" && call.body.dashboardSections && fail) throw new Error("Disk is full");
    } });
    await ui.controller.show("home"); await settle();
    const blocked = ui.control("Blocked work"); blocked.checked = false; blocked.dispatchEvent(new ui.window.Event("change", { bubbles: true })); await settle();
    assert.match(ui.container.textContent, /Disk is full/);
    assert.equal(ui.container.querySelector(".workspace-dashboard-blocked"), null);
    fail = false;
    ui.click("Retry saving"); await settle();
    assert.deepEqual(ui.state.preferences.dashboardSections, ["current", "unfinished", "completed"]);
    assert.equal(ui.container.querySelector(".workspace-notice").hidden, true);
    assert.equal(ui.state.preferences.workspace.project, "Widgets");
});

test("destroy removes its dialog and ignores late responses; missing connection needs no workspace requests", needsDom, async t => {
    const held = deferred();
    const ui = setup(t, { handle(call) { if (call.path === "/api/workspace/metadata") return held.promise; } });
    const opening = ui.controller.openCreate(); await settle();
    assert.ok(ui.document.querySelector("dialog"));
    ui.controller.destroy();
    held.resolve(metadata); await opening;
    assert.equal(ui.document.querySelector("dialog"), null);
    assert.equal(ui.container.childElementCount, 0);
    const empty = setup(t, { connections: [] });
    await empty.controller.show("items");
    assert.match(empty.container.textContent, /Choose an organization/);
    assert.deepEqual(empty.calls.map(call => call.path), ["/api/workspace/preferences"]);
});

test("changing board scope ignores an older mutation and preserves the new board's move choice", needsDom, async t => {
    const mutation = deferred();
    const ui = setup(t, { handle(call) {
        if (call.path === "/api/workspace/board/move") return mutation.promise;
    } });
    await ui.controller.show("board");
    ui.change(ui.control("Board"), "features");
    await settle();
    assert.equal(ui.calls.filter(call => call.path === "/api/workspace/board").at(-1).params.get("boardId"), "features");

    ui.change(ui.control("Move 11 to"), JSON.stringify(["working", false]));
    ui.submit(ui.container.querySelector(".workspace-card-move"));
    ui.change(ui.control("Board"), "stories");
    await settle();
    const move = ui.control("Move 11 to");
    ui.change(move, JSON.stringify(["closed", false]));
    move.focus();
    mutation.resolve({ workItem: item(11, { rev: 5, columnId: "working", columnDone: false }) });
    await settle();
    await ui.controller.refresh({ background: true });
    assert.equal(ui.control("Move 11 to"), move);
    assert.equal(move.value, JSON.stringify(["closed", false]));
    assert.equal(ui.container.querySelector(".workspace-board-card").closest(".workspace-board-column").dataset.columnId, "ready");
});

test("background refresh preserves focused Home and list links until focus leaves the results", needsDom, async t => {
    const ui = setup(t);
    for (const view of ["home", "items"]) {
        await ui.controller.show(view);
        const link = ui.container.querySelector(".workspace-item-link");
        link.focus();
        await ui.controller.refresh({ background: true });
        assert.equal(ui.document.activeElement, link);
        assert.equal(link.isConnected, true);
        ui.document.getElementById("outside").focus();
        const before = ui.calls.length;
        await ui.controller.refresh({ background: true });
        assert.ok(ui.calls.length > before, "refresh resumes after keyboard focus leaves the results");
    }
});
