import assert from "node:assert/strict";
import test from "node:test";
import { renderNavigation } from "./ui/navigation-view.mjs";

let JSDOM;
try {
    ({ JSDOM } = await import("jsdom"));
} catch {
    JSDOM = null;
}
const describeDom = { skip: JSDOM ? false : "jsdom is not installed" };

function tab(id, view, itemId, data = {}, organization = "contoso", project = "Widgets") {
    return { id, entry: { view, id: itemId, organization, project }, data, closable: view !== "home" };
}
const child = (id, project = "Widgets") => ({ id, project, kind: "work-item", kindLabel: "Task", label: `Task ${id}`, title: `Build widget ${id}`, state: "Active" });
const story = (id, links) => tab(`tab-${id}`, "work-item", id, { id, type: "User Story", title: `Story ${id}`, relations: [{ name: "Children", links }] });
const sameEntry = (a, b) => a.view === b.view && Number(a.id) === Number(b.id) && a.organization.toLowerCase() === b.organization.toLowerCase() && (a.workItemProject || a.project).toLowerCase() === (b.workItemProject || b.project).toLowerCase();

function setup(t, tabs, extra = {}) {
    const dom = new JSDOM('<nav aria-label="Azure DevOps views"></nav>');
    t.after(() => dom.window.close());
    const container = dom.window.document.querySelector("nav");
    for (const item of tabs) {
        item.panel = dom.window.document.createElement("section");
        item.panel.id = `${item.id}-panel`;
        dom.window.document.body.append(item.panel);
    }
    const calls = [];
    const options = { tabs, activeTabId: tabs[0]?.id, collapsed: new Set(), sameEntry,
        tabTitle: (item) => item.entry.view === "home" ? "Home" : `${item.data.type || "PR"} ${item.entry.id}`,
        isBranchPullRequestTab: () => false,
        onActivate: (id) => calls.push(["activate", id]),
        onOpenChild: (item, entry) => calls.push(["child", item, entry]),
        onClose: (id) => calls.push(["close", id]), ...extra };
    const render = () => renderNavigation(container, options);
    render();
    return { container, options, calls, render, window: dom.window };
}

test("sidebar shows nested child summaries without fetching their details and separates pull requests", describeDom, (t) => {
    const parent = story(10, [child(11, "Other Project"), child(12)]);
    const { container, calls } = setup(t, [tab("home", "home", 0), tab("pr", "pull-request", 28, { title: "Widget changes" }), parent]);
    const group = container.querySelector('[data-tab-id="tab-10"]').closest("li").querySelector("ul");
    assert.equal(group.querySelectorAll(".view-tab").length, 2);
    assert.match(group.textContent, /Build widget 11/);
    assert.match(group.textContent, /Active/);
    group.querySelector(".view-tab-label").click();
    assert.equal(calls[0][0], "child");
    assert.equal(calls[0][1].project, "Other Project");
    assert.equal(calls[0][2].organization, "contoso");
    assert.deepEqual([...container.querySelectorAll(".navigation-heading")].map(n => n.textContent), ["Open work", "Pull requests"]);
});

test("opened children appear once beneath their parent and closing only targets their view", describeDom, (t) => {
    const parent = story(10, [child(11)]);
    const task = tab("task", "work-item", 11, { type: "Task", title: "Loaded task", state: "Done" });
    const { container, calls, options, render } = setup(t, [parent, task], { activeTabId: "task" });
    assert.equal(container.querySelectorAll('[data-tab-id="task"]').length, 1);
    const row = container.querySelector('[data-tab-id="task"]');
    assert.ok(row.closest(".navigation-children"));
    assert.equal(row.querySelector(".view-tab-label").getAttribute("aria-current"), "page");
    assert.match(row.textContent, /Done/);
    assert.match(row.querySelector(".view-tab-label").getAttribute("aria-label"), /Done/);
    row.querySelector(".view-tab-close").click();
    assert.deepEqual(calls.at(-1), ["close", "task"]);
    options.tabs = [task];
    render();
    assert.equal(container.querySelector('[data-tab-id="task"]').closest(".navigation-children"), null, "child remains reachable after parent closes");
});

test("disclosure state survives rerenders and revealing a selected child expands its ancestors", describeDom, (t) => {
    const { container, options, render, window } = setup(t, [story(10, [child(11)]), tab("task", "work-item", 11, { type: "Task" })]);
    let toggle = container.querySelector(".navigation-disclosure");
    toggle.focus();
    toggle.click();
    toggle = container.querySelector(".navigation-disclosure");
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(window.document.activeElement, toggle, "keyboard focus survives rerender");
    assert.equal(container.querySelector(".navigation-children").hidden, true);
    render();
    assert.equal(container.querySelector(".navigation-children").hidden, true);
    options.activeTabId = "task";
    options.revealActive = true;
    render();
    assert.equal(container.querySelector(".navigation-children").hidden, false);
});

test("child matching respects organization and cross-project identity", describeDom, (t) => {
    const parent = story(10, [child(11, "Boxes")]);
    const matching = tab("matching", "work-item", 11, { type: "Task" }, "contoso", "Boxes");
    const otherOrg = tab("other", "work-item", 11, { type: "Task" }, "fabrikam", "Boxes");
    const { container } = setup(t, [parent, matching, otherOrg]);
    assert.ok(container.querySelector('[data-tab-id="matching"]').closest(".navigation-children"));
    assert.equal(container.querySelector('[data-tab-id="other"]').closest(".navigation-children"), null);
});

test("cycles, repeated child links, and unresolved links do not duplicate or hide open views", describeDom, (t) => {
    const a = story(10, [child(11), child(11), { id: 0, title: "Unavailable" }]);
    const b = story(11, [child(10)]);
    const { container } = setup(t, [a, b]);
    assert.equal(container.querySelectorAll('[data-tab-id="tab-10"]').length, 1);
    assert.equal(container.querySelectorAll('[data-tab-id="tab-11"]').length, 1);
    assert.equal(container.querySelectorAll(".view-tab").length, 2);
});

test("refresh replaces child links and titles are rendered as text", describeDom, (t) => {
    const parent = story(10, [child(11)]);
    parent.data.title = '<img src=x onerror="alert(1)">';
    const { container, render } = setup(t, [parent]);
    assert.equal(container.querySelector("img"), null);
    parent.data.relations[0].links = [child(12)];
    render();
    assert.doesNotMatch(container.textContent, /Build widget 11/);
    assert.match(container.textContent, /Build widget 12/);
});
