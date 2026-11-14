import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createTaskSuggestionPanel } from "./ui/task-suggestions-view.mjs";

const draft = (version = 1) => ({ requestId: "draft-one", version, parentId: 42, parentRev: 3, assignedTo: "Alex Morgan", status: "ready", questions: [], tasks: ["Search API", "Search form"].map((title, index) => ({ id: `${version}:${index}`, title, description: "Saved proposal", doneWhen: "Works", state: "proposed" })) });
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
function setup(t) {
    const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
    globalThis.window = dom.window; globalThis.document = dom.window.document;
    let latest = draft(); const calls = []; let refreshed = 0; let loseResponse = false;
    const panel = createTaskSuggestionPanel({ url: action => "/" + action, confirm: () => true, onCreated: async () => { refreshed++; },
        request: async (url, options = {}) => {
            calls.push({ url, ...options });
            if (url === "/create-suggested-tasks") {
                const input = JSON.parse(options.body);
                latest = { ...latest, tasks: latest.tasks.map(task => input.tasks.some(selected => selected.id === task.id) ? { ...task, state: "created", createdId: 101 } : task) };
                if (loseResponse) { loseResponse = false; throw new Error("Response lost"); }
            }
            return { draft: structuredClone(latest) };
        },
    });
    document.body.append(panel.host);
    t.after(() => { panel.dispose(); dom.window.close(); });
    return { panel, calls, setLatest: value => { latest = value; }, refreshed: () => refreshed, loseResponse: () => { loseResponse = true; } };
}

test("task review edits and selects drafts before explicit creation and preserves unchecked edits", async t => {
    const { panel, calls, refreshed } = setup(t);
    await panel.open();
    assert.equal(calls.filter(call => call.method === "POST").length, 0);
    const title = panel.host.querySelector('[aria-label="Title for task 1"]');
    title.value = "Reviewed API"; title.dispatchEvent(new window.Event("input"));
    const second = panel.host.querySelector('[aria-label="Description for task 2"]');
    second.value = "Keep this edit"; second.dispatchEvent(new window.Event("input"));
    panel.host.querySelector('[aria-label="Select task 2"]').click();
    const select = panel.host.querySelector("select"); select.value = "person"; select.dispatchEvent(new window.Event("change"));
    const assignee = panel.host.querySelector('[aria-label="Task assignee"]'); assignee.value = "sam@example.com"; assignee.dispatchEvent(new window.Event("input"));
    [...panel.host.querySelectorAll("button")].find(button => button.textContent === "Create selected tasks").click(); await settle();
    const body = JSON.parse(calls.find(call => call.url === "/create-suggested-tasks").body);
    assert.equal(body.tasks.length, 1); assert.equal(body.tasks[0].title, "Reviewed API");
    assert.equal(body.assigneeMode, "person"); assert.equal(body.assignedTo, "sam@example.com");
    assert.match(panel.host.textContent, /Created #101/);
    assert.equal(panel.host.querySelector('[aria-label="Description for task 2"]').value, "Keep this edit");
    assert.equal(refreshed(), 1);
});

test("revised agent proposals never overwrite local edits without an explicit replace", async t => {
    const { panel, setLatest } = setup(t); await panel.open();
    const input = panel.host.querySelector('[aria-label="Title for task 1"]');
    input.value = "My draft"; input.dispatchEvent(new window.Event("input"));
    setLatest(draft(2)); await panel.refresh();
    assert.equal(panel.host.querySelector('[aria-label="Title for task 1"]'), input);
    assert.equal(input.value, "My draft");
    assert.match(panel.host.textContent, /revised suggestions/);
    [...panel.host.querySelectorAll("button")].find(button => button.textContent === "Replace with revised suggestions").click();
    assert.equal(panel.host.querySelector('[aria-label="Title for task 1"]').value, "Search API");
});

test("clarification questions and untrusted proposal text render as text with no implicit creation", async t => {
    const { panel, setLatest, calls } = setup(t);
    setLatest({ ...draft(), questions: ['<img src=x onerror="alert(1)"> Which records?'], tasks: [] });
    await panel.open();
    assert.equal(panel.host.querySelector("img"), null);
    assert.match(panel.host.textContent, /Which records/);
    assert.equal([...panel.host.querySelectorAll("button")].some(button => button.textContent === "Create selected tasks"), false);
    assert.equal(calls.length, 1);
});

test("review recovers creation receipts after a lost POST response without losing unselected edits", async t => {
    const { panel, loseResponse } = setup(t); await panel.open();
    const second = panel.host.querySelector('[aria-label="Description for task 2"]');
    second.value = "Keep my notes"; second.dispatchEvent(new window.Event("input"));
    panel.host.querySelector('[aria-label="Select task 2"]').click();
    loseResponse();
    [...panel.host.querySelectorAll("button")].find(button => button.textContent === "Create selected tasks").click(); await settle();
    assert.match(panel.host.textContent, /Response lost/);
    await panel.refresh();
    assert.match(panel.host.textContent, /Created #101/);
    assert.equal(panel.host.querySelector('[aria-label="Title for task 1"]'), null);
    assert.equal(panel.host.querySelector('[aria-label="Description for task 2"]').value, "Keep my notes");
});
