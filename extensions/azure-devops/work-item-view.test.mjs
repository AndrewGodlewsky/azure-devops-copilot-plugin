// Run with: node --test work-item-view.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

// These extensions ship without node_modules, so jsdom is not guaranteed to be
// present. Skip rather than fail when it is missing, and run with:
//   npm install jsdom && node --test work-item-view.test.mjs
let JSDOM;
try {
    ({ JSDOM } = await import("jsdom"));
} catch {
    JSDOM = null;
}
const needsDom = { skip: JSDOM ? false : "jsdom is not installed" };

let renderWorkItem;
if (JSDOM) {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.DOMParser = dom.window.DOMParser;
    globalThis.Node = dom.window.Node;
    // navigator is a getter-only global in newer Node, so it is redefined.
    Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
    ({ renderWorkItem } = await import("./ui/work-item-view.mjs"));
}

function workItem(overrides = {}) {
    return {
        id: 42,
        rev: 3,
        type: "Bug",
        title: "Something broke",
        state: "Active",
        states: ["New", "Active"],
        assignedTo: "Someone",
        commentCount: 0,
        tags: [],
        details: [],
        relations: [],
        discussion: [],
        webUrl: "https://dev.azure.com/o/p/_workitems/edit/42",
        templateSections: [],
        ...overrides,
    };
}

function render(item, options = {}) {
    const host = document.createElement("div");
    renderWorkItem(host, item, { canEdit: true, editMode: false, onEdit: () => {}, ...options });
    return host;
}

const editLabels = (host) => [...host.querySelectorAll(".inline-edit")].map((b) => b.getAttribute("aria-label"));
const descriptionSection = {
    title: "Description",
    column: 1,
    fields: [{ name: "Description", field: "System.Description", isHtml: true, value: "<p>Body</p>" }],
};

test("Add task is available before a parent has any children", needsDom, () => {
    let added = 0;
    const host = render(workItem(), { onAddTask: () => { added += 1; } });
    const button = [...host.querySelectorAll("button")].find(node => node.textContent === "Add task");
    assert.ok(button);
    button.click();
    assert.equal(added, 1);
});

test("restored field and comment drafts remain dirty and every edit updates the snapshot", needsDom, async () => {
    const host = document.createElement("div");
    const changes = [];
    let saved;
    const handle = renderWorkItem(host, workItem({ templateSections: [descriptionSection] }), {
        editMode: true, onAddComment() {}, onSave: fields => { saved = fields; },
        draft: { fields: [{ name: "System.Title", value: "Restored title" }, { name: "System.Description", value: '<p style="color: red">Draft <strong>format</strong></p>', isHtml: true }], comment: { content: "Pending comment", mentions: [] } },
        onDraftChange: draft => changes.push(draft),
    });
    assert.ok(handle?.getDraft);
    assert.equal(changes.length, 0, "rendering does not write a draft before the user changes anything");
    assert.equal(host.querySelector('[aria-label="Title"]').value, "Restored title");
    assert.match(host.querySelector(".editor-html").innerHTML, /<strong>format<\/strong>/);
    assert.equal(handle.getDraft().comment.content, "Pending comment");
    const title = host.querySelector('[aria-label="Title"]');
    for (const value of ["First edit", "Second edit  "]) {
        title.value = value;
        title.dispatchEvent(new window.Event("input"));
    }
    assert.equal(changes.at(-1).fields.find(field => field.name === "System.Title").value, "Second edit  ");
    host.querySelector(".editor-save").click();
    await Promise.resolve();
    assert.equal(saved.find(field => field.name === "System.Title").value, "Second edit");
    assert.match(saved.find(field => field.name === "System.Description").value, /style="color: red"/);
});

test("a partial Markdown draft keeps trailing spaces before the next line is typed", needsDom, () => {
    const host = document.createElement("div");
    let latest;
    const item = workItem({ templateSections: [{ title: "Description", fields: [{ name: "Description", field: "System.Description", value: "Line", format: "markdown" }] }] });
    const handle = renderWorkItem(host, item, { editMode: true, onDraftChange: draft => { latest = draft; } });
    const source = host.querySelector("textarea");
    source.value = "Line  ";
    source.dispatchEvent(new window.Event("input"));
    assert.equal(latest.fields[0]?.value, "Line  ");
    const restored = renderWorkItem(host, item, { editMode: true, draft: handle.getDraft() });
    assert.equal(host.querySelector("textarea").value, "Line  ");
    assert.equal(restored.getDraft().fields[0]?.value, "Line  ");
});

test("Save waits for a pending description attachment and then includes its original URL", needsDom, async () => {
    let finish;
    let saved;
    const url = "https://dev.azure.com/example/project/_apis/wit/attachments/abc";
    const host = render(workItem({ templateSections: [descriptionSection] }), {
        editMode: true,
        onUploadAttachment: () => new Promise(resolve => { finish = resolve; }),
        onSave: fields => { saved = fields; },
    });
    const paste = new window.Event("paste", { cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { files: [new window.File(["image"], "shot.png", { type: "image/png" })] } });
    host.querySelector(".editor-html").dispatchEvent(paste);
    await Promise.resolve();
    host.querySelector(".editor-save").click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(saved, undefined);
    assert.match(host.textContent, /Wait for the attachments/);
    finish({ attachment: { url, fileName: "shot.png" } });
    await new Promise(resolve => setTimeout(resolve, 0));
    host.querySelector(".editor-save").click();
    await Promise.resolve();
    assert.ok(saved.find(field => field.name === "System.Description").value.includes(url));
});

test("child tasks appear in the main column without duplicating sidebar relations", needsDom, () => {
    const children = [
        { id: 51, kind: "work-item", label: "Task 51", title: "Build the widget", state: "To Do" },
        { id: 52, kind: "work-item", label: "Task 52", title: "Check the widget", state: "Done" },
    ];
    const host = render(workItem({
        type: "Issue",
        templateSections: [descriptionSection],
        relations: [
            { name: "Children", links: children },
            { name: "Parent", links: [{ id: 10, label: "Epic 10", title: "Parent epic" }] },
            { name: "Related", links: [{ id: 20, label: "Issue 20", title: "Another issue" }] },
        ],
    }), { onOpenWorkItem() {} });

    const card = host.querySelector(".work-item-main-column .child-work-section");
    assert.ok(card, "child tasks should have a prominent main-column section");
    assert.equal(card.querySelector("h2").textContent, "Tasks and child work items");
    assert.equal(card.querySelector(".primer-counter").textContent, "2");
    assert.deepEqual([...card.querySelectorAll(".relation-title")].map((node) => node.textContent), children.map((child) => child.title));
    assert.match(card.textContent, /To Do/);
    assert.match(card.textContent, /Done/);
    assert.ok(card.previousElementSibling.classList.contains("template-section"));
    assert.ok(card.nextElementSibling.classList.contains("work-item-discussion"));
    assert.doesNotMatch(host.querySelector(".work-item-sidebar").textContent, /Build the widget|Check the widget/);
    assert.match(host.querySelector(".work-item-sidebar").textContent, /Parent epic/);
    assert.match(host.querySelector(".work-item-sidebar").textContent, /Another issue/);
});

test("child task overflow retains navigation and cross-project context", needsDom, () => {
    const children = Array.from({ length: 8 }, (_, index) => ({
        id: 100 + index, kind: "work-item", label: `Task ${100 + index}`,
        title: `Task title ${index}`, state: "Active", project: "Other Project",
    }));
    let opened;
    const host = render(workItem({ relations: [{ name: "Children", links: children }] }), {
        onOpenWorkItem(item) { opened = item; },
    });
    const card = host.querySelector(".child-work-section");
    assert.ok(card);
    assert.equal(card.querySelector(".primer-counter").textContent, "8");
    assert.equal(card.querySelector(":scope > .relation-list").children.length, 6);
    assert.equal(card.querySelector("summary").textContent, "Show 2 more");
    card.querySelector("details").open = true;
    card.querySelector(".relation-list-overflow button").click();
    assert.equal(opened, children[6]);
    assert.equal(opened.project, "Other Project");
    assert.equal(host.querySelector(".work-item-sidebar"), null);
});

test("child work items retain custom types and unresolved links", needsDom, () => {
    const host = render(workItem({ relations: [{ name: "Children", links: [
        { id: 61, label: "Checklist 61", title: "Custom child", kind: "work-item", webUrl: "https://dev.azure.com/example/Widgets/_workitems/edit/61" },
        { id: 62, label: "Work item 62", title: "", kind: "work-item", webUrl: "" },
    ] }] }));
    const card = host.querySelector(".child-work-section");
    assert.ok(card);
    assert.match(card.textContent, /Checklist 61 Custom child/);
    assert.equal(card.querySelector("a").href, "https://dev.azure.com/example/Widgets/_workitems/edit/61");
    assert.match(card.textContent, /Work item 62/);
    assert.equal(card.querySelectorAll(".relation-row").length, 2);
});

test("work items without children omit the child tasks section", needsDom, () => {
    const host = render(workItem({ type: "Issue", relations: [{ name: "Children", links: [] }] }));
    assert.equal(host.querySelector(".child-work-section"), null);
});

test("delegate menus have unique document ids across simultaneous work-item renders", needsDom, () => {
    const first = render(workItem(), { onDelegateLocal() {} });
    const second = render(workItem(), { onDelegateLocal() {} });
    const root = document.createElement("div");
    root.append(first, second);
    document.body.append(root);
    try {
        const menus = [...root.querySelectorAll(".primer-action-list")];
        const triggers = [...root.querySelectorAll(".primer-action-menu-trigger")];
        assert.equal(menus.length, 2);
        assert.notEqual(menus[0].id, menus[1].id);
        assert.deepEqual(triggers.map((trigger) => trigger.getAttribute("aria-controls")), menus.map((menu) => menu.id));
        assert.deepEqual(menus.map((menu) => document.getElementById(menu.id)), menus);
    } finally {
        root.remove();
    }
});

test("a lone field named after its section is labelled once", needsDom, () => {
    // Azure DevOps templates commonly put System.Description in a group also
    // called "Description", which used to render the word twice.
    const host = render(workItem({ templateSections: [descriptionSection] }));
    const section = host.querySelector(".template-section");
    assert.equal(section.querySelectorAll(".section-field-name").length, 0, "the repeated label should be gone");
    assert.equal(section.querySelector(".section-title").textContent, "Description");
});

test("renders a grouped overview and Primer-style content cards", needsDom, () => {
    const host = render(workItem({
        typeColor: "CC293D",
        stateColor: "007ACC",
        assignedToImageUrl: "https://dev.azure.com/example/avatar.png",
        reason: "Work started",
        area: "Widgets / Canvas",
        details: [
            { name: "Priority", value: "2" },
            { name: "Iteration", value: "Sprint 12" },
        ],
        relations: [
            {
                name: "Development",
                links: [{
                    id: 0,
                    kind: "pull-request",
                    kindLabel: "Pull request",
                    label: "Pull request 81",
                    title: "Polish the layout",
                    webUrl: "https://dev.azure.com/o/p/_git/r/pullrequest/81",
                }],
            },
            {
                name: "Related",
                links: [{ id: 9, kind: "work-item", label: "Bug 9", title: "Linked work", state: "Active" }],
            },
        ],
        templateSections: [
            descriptionSection,
            {
                title: "Planning",
                column: 2,
                fields: [{ name: "Priority", field: "Microsoft.VSTS.Common.Priority", isHtml: false, value: "2" }],
            },
        ],
    }), {
        avatarUrl(url) {
            return `/api/avatar?url=${encodeURIComponent(url)}`;
        },
        onOpenWorkItem() {},
    });

    const overview = host.querySelector(".work-item-overview");
    assert.ok(overview);
    assert.equal(overview.querySelector(".work-item-title").textContent, "Something broke");
    assert.equal(overview.querySelector(".work-item-title a"), null, "title is not the external action");
    assert.equal(overview.querySelector(".work-item-reference").textContent, "#42");
    assert.ok(overview.querySelector(".work-item-type"));
    assert.equal(overview.querySelector(".work-item-type").style.getPropertyValue("--type-color"), "#CC293D");
    assert.equal(overview.querySelector(".state-pill"), null, "state belongs in the details panel");
    assert.equal(overview.querySelector(".work-item-open-button"), null);

    assert.ok(host.querySelector(".work-item-title-row > .inline-edit"));
    assert.ok(host.querySelector(".work-item-meta-avatar .identity-avatar-image"));
    assert.equal(host.querySelectorAll(".work-item-card").length, 4);
    assert.deepEqual(
        [...host.querySelectorAll(".work-item-details dt")].map((node) => node.textContent),
        ["State", "Reason", "Area", "Iteration"],
        "the summary block contains only the four requested fields",
    );
    assert.doesNotMatch(host.querySelector(".work-item-details").textContent, /Priority/);
    assert.ok(host.querySelector(".work-item-details .state-pill"));
    assert.equal(host.querySelector(".state-pill").style.getPropertyValue("--state-color"), "#007ACC");
    assert.deepEqual(
        [...host.querySelectorAll(".work-item-details .detail-value")].map((node) => node.title),
        ["Active", "Work started", "Widgets / Canvas", "Sprint 12"],
        "every truncated summary value exposes its full text on hover",
    );
    assert.equal(host.querySelector(".state-pill-label")?.textContent, "Active");
    assert.ok(host.querySelector(".work-item-body.has-sidebar"));
    assert.equal(
        host.querySelector(".work-item-main-column .template-section .section-title").textContent,
        "Description",
    );
    assert.equal(host.querySelector(".development-section"), null);
    assert.doesNotMatch(host.textContent, /Pull request 81|Polish the layout/);
    assert.ok(host.querySelector(".work-item-sidebar .related-work-section"));
    assert.deepEqual(
        [...host.querySelectorAll(".work-item-sidebar > section .section-title")].map((node) => node.textContent),
        ["Related work", "Planning"],
        "second-column ADO sections stack below related work",
    );
    assert.ok(host.querySelector(".related-work-section .relation-link.primer-link"));
    assert.deepEqual(
        [...host.querySelector(".related-work-section .relation-row-content").children].map((node) => node.className),
        ["primer-link relation-link", "relation-meta"],
        "related-work rows stay within two text lines",
    );
});

test("external hyperlinks and attachments retain their destinations", needsDom, () => {
    let openedWorkItem = false;
    const host = render(workItem({
        relations: [
            {
                name: "Links",
                links: [{ id: 0, kind: "link", label: "Design notes", webUrl: "https://example.com/design" }],
            },
            {
                name: "Attachments",
                links: [{
                    id: 0, kind: "attachment", label: "diagram.png",
                    webUrl: "https://dev.azure.com/example/Widgets/_apis/wit/attachments/attachment-id",
                }],
            },
        ],
    }), { onOpenWorkItem() { openedWorkItem = true; } });

    const links = [...host.querySelectorAll(".related-work-section .relation-link")];
    assert.deepEqual(links.map((link) => link.href), [
        "https://example.com/design",
        "https://dev.azure.com/example/Widgets/_apis/wit/attachments/attachment-id",
    ]);
    assert.deepEqual(links.map((link) => link.tagName), ["A", "A"]);
    assert.ok(links.every((link) => link.target === "_blank" && link.rel === "noopener noreferrer"));
    assert.equal(openedWorkItem, false);
});

test("a legacy development group does not create a sidebar or fallback links", needsDom, () => {
    const host = render(workItem({
        relations: [{
            name: "Development",
            links: [{
                id: 0,
                kind: "pull-request",
                label: "Pull request 81",
                webUrl: "https://dev.azure.com/example/Widgets/_git/repo/pullrequest/81",
            }],
        }],
    }));

    assert.equal(host.querySelector(".work-item-sidebar"), null);
    assert.equal(host.querySelector('a[href*="_git"]'), null);
    assert.doesNotMatch(host.textContent, /Development|Pull request/);
});

test("omits the sidebar when a work item has no applicable links", needsDom, () => {
    const host = render(workItem({ templateSections: [descriptionSection], relations: [] }));
    assert.equal(host.querySelector(".work-item-sidebar"), null);
    assert.equal(host.querySelector(".work-item-body").classList.contains("has-sidebar"), false);
    assert.ok(host.querySelector(".work-item-main-column .work-item-discussion"));
});

test("a second-column template section creates the sidebar without relations", needsDom, () => {
    const host = render(workItem({
        templateSections: [{
            title: "Planning",
            column: 2,
            fields: [{ name: "Priority", field: "Microsoft.VSTS.Common.Priority", isHtml: false, value: "2" }],
        }],
    }));
    assert.ok(host.querySelector(".work-item-body.has-sidebar"));
    assert.equal(host.querySelector(".work-item-sidebar .section-title").textContent, "Planning");
    assert.ok(host.querySelector(".work-item-main-column .work-item-discussion"));
});

test("renders discussion with Copilot-style identity and avatar treatment", needsDom, () => {
    const source = "https://dev.azure.com/example/_api/_common/identityImage?id=ada";
    const createdDate = new Date(Date.now() - 60_000).toISOString();
    const host = render(workItem({
        commentCount: 1,
        discussion: [{
            id: 1,
            author: "Ada Lovelace",
            authorImageUrl: source,
            createdDate,
            text: "<p>Looks good.</p>",
        }],
    }), {
        avatarUrl(url) {
            return `/api/profile-image?source=${encodeURIComponent(url)}`;
        },
    });

    assert.equal(host.querySelector(".primer-counter").textContent, "1");
    const comment = host.querySelector(".work-item-comment.comment-thread");
    assert.ok(comment);
    assert.equal(comment.querySelector(".comment-header-author").textContent, "Ada Lovelace");
    assert.equal(
        comment.querySelector(".comment-avatar-image").getAttribute("src"),
        `/api/profile-image?source=${encodeURIComponent(source)}`,
    );
    assert.ok(comment.querySelector(".comment-header-age").title);
    assert.equal(comment.querySelector(".comment-post-content p").textContent, "Looks good.");
});

test("a section with several fields keeps a label per field", needsDom, () => {
    const host = render(workItem({
        templateSections: [{
            title: "Details",
            fields: [
                { name: "Description", field: "System.Description", isHtml: true, value: "<p>a</p>" },
                { name: "Repro steps", field: "Microsoft.VSTS.TCM.ReproSteps", isHtml: true, value: "<p>b</p>" },
            ],
        }],
    }));
    const section = host.querySelector(".template-section");
    assert.equal(section.querySelectorAll(".section-field-name").length, 2);
});

test("a known HTML field renders uppercase legacy markup", needsDom, () => {
    const host = render(workItem({
        templateSections: [{
            title: "Description",
            fields: [{
                name: "Description",
                field: "System.Description",
                isHtml: true,
                value: "<DIV><P>Hello <B>bold</B></P></DIV>",
            }],
        }],
    }));
    const value = host.querySelector(".section-field-value");
    assert.equal(value.textContent.trim(), "Hello bold");
    assert.match(value.innerHTML, /<div><p>Hello <b>bold<\/b><\/p><\/div>/);
});

test("a Repro Steps field converted to Markdown renders as Markdown", needsDom, () => {
    const host = render(workItem({
        templateSections: [{
            title: "Repro Steps",
            fields: [{
                name: "Repro Steps",
                field: "Microsoft.VSTS.TCM.ReproSteps",
                isRichText: true,
                isHtml: false,
                format: "markdown",
                value: "## Reproduce\n\n1. Open the canvas\n2. View **Repro Steps**",
            }],
        }],
    }));
    const value = host.querySelector(".section-field-value");
    assert.equal(value.querySelector("h2")?.textContent, "Reproduce");
    assert.deepEqual([...value.querySelectorAll("li")].map((node) => node.textContent), [
        "Open the canvas",
        "View Repro Steps",
    ]);
    assert.equal(value.querySelector("strong")?.textContent, "Repro Steps");
});

test("an HTML Repro Steps field remains HTML", needsDom, () => {
    const host = render(workItem({
        templateSections: [{
            title: "Repro Steps",
            fields: [{
                name: "Repro Steps",
                field: "Microsoft.VSTS.TCM.ReproSteps",
                isRichText: true,
                isHtml: true,
                format: "html",
                value: "<ol><li>Open the canvas</li><li><strong>Reproduce</strong></li></ol>",
            }],
        }],
    }));
    const value = host.querySelector(".section-field-value");
    assert.deepEqual([...value.querySelectorAll("li")].map((node) => node.textContent), [
        "Open the canvas",
        "Reproduce",
    ]);
    assert.equal(value.querySelector("strong")?.textContent, "Reproduce");
});

test("discussion uses Markdown rendering even when it contains raw HTML", needsDom, () => {
    const host = render(workItem({
        discussion: [{
            author: "Reviewer",
            createdDate: "2026-08-07T00:00:00Z",
            text: "<div>\nUse Vec<String> here\n</div>",
            format: "markdown",
        }],
    }));
    const comment = host.querySelector(".comment-text");
    assert.ok(comment.querySelector("div"), "the raw HTML wrapper should still render");
    assert.equal(comment.textContent.trim(), "Use Vec<String> here");
});

test("discussion Markdown links still render as links", needsDom, () => {
    const host = render(workItem({
        discussion: [{
            author: "Reviewer",
            createdDate: "2026-08-07T00:00:00Z",
            text: "See [the docs](https://www.contoso.com).",
            format: "markdown",
        }],
    }));
    assert.equal(host.querySelector(".comment-text a")?.href, "https://www.contoso.com/");
});

test("view mode offers one edit control for the whole item", needsDom, () => {
    const host = render(workItem({ templateSections: [descriptionSection] }));
    assert.deepEqual(editLabels(host), ["Edit this work item"]);
    assert.ok(host.querySelector(".work-item-title-row > .inline-edit"), "it is directly appended to the title");
    assert.equal(host.querySelector(".work-item-header-actions"), null);
    assert.equal(host.querySelectorAll(".editor").length, 0, "nothing should be editable yet");
});

test("edit mode turns the supported fields into controls at once", needsDom, () => {
    const host = render(workItem({ templateSections: [descriptionSection] }), { editMode: true });
    // Title, state, and the description.
    assert.equal(host.querySelectorAll(".editor").length, 3);
    assert.ok(host.querySelector(".editor-plain"), "title");
    assert.ok(host.querySelector(".work-item-details .editor-choice"), "state");
    // One save and one cancel for the whole view, not per field.
    assert.equal(host.querySelectorAll(".editor-save").length, 1);
    assert.equal(host.querySelectorAll(".editor-cancel").length, 1);
    assert.equal(host.querySelectorAll(".inline-edit").length, 0, "the edit control is replaced by the actions");
});

test("the HTML field surface carries no formatting toolbar", needsDom, () => {
    // The editing surface is a contenteditable, but a bare one. A toolbar is what
    // would need the hand-rolled command layer that got undo and IME wrong, so the
    // field offers editing the words and preserves the formatting rather than
    // offering to change it.
    const host = render(workItem({ templateSections: [descriptionSection] }), { editMode: true });
    assert.equal(host.querySelectorAll('[contenteditable="true"]').length, 1);
    assert.equal(host.querySelectorAll(".editor-toolbar").length, 0);
});

test("a Markdown rich field uses the source editor and preview", needsDom, () => {
    const host = render(workItem({
        templateSections: [{
            title: "Repro Steps",
            fields: [{
                name: "Repro Steps",
                field: "Microsoft.VSTS.TCM.ReproSteps",
                isRichText: true,
                isHtml: false,
                format: "markdown",
                value: "1. Open the canvas",
            }],
        }],
    }), { editMode: true });
    assert.ok(host.querySelector(".editor-source"));
    assert.ok(host.querySelector(".editor-toolbar"));
    assert.equal(host.querySelector(".editor-html"), null);
});

test("saving a Markdown rich field returns source without changing its format", needsDom, async () => {
    let saved = null;
    const host = render(workItem({
        templateSections: [{
            title: "Repro Steps",
            fields: [{
                name: "Repro Steps",
                field: "Microsoft.VSTS.TCM.ReproSteps",
                isRichText: true,
                isHtml: false,
                format: "markdown",
                value: "1. Open the canvas",
            }],
        }],
    }), {
        editMode: true,
        onSave: async (fields) => { saved = fields; },
    });
    const source = host.querySelector(".editor-source");
    source.value = "1. Open the canvas\n2. View **Repro Steps**";
    source.dispatchEvent(new window.Event("input"));
    host.querySelector(".editor-save").dispatchEvent(new window.Event("click"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(saved, [{
        name: "Microsoft.VSTS.TCM.ReproSteps",
        value: "1. Open the canvas\n2. View **Repro Steps**",
        isHtml: false,
    }]);
});

test("saving reports only the fields that changed", needsDom, async () => {
    let saved = null;
    const host = render(workItem({ templateSections: [descriptionSection] }), {
        editMode: true,
        onSave: async (fields) => { saved = fields; },
    });
    const title = host.querySelector(".editor-plain");
    title.value = "Renamed";
    title.dispatchEvent(new window.Event("input"));
    host.querySelector(".editor-save").dispatchEvent(new window.Event("click"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(saved, [{ name: "System.Title", value: "Renamed", isHtml: false }]);
});

test("saving an untouched view reports no changes", needsDom, async () => {
    let saved = null;
    const host = render(workItem({ templateSections: [descriptionSection] }), {
        editMode: true,
        onSave: async (fields) => { saved = fields; },
    });
    host.querySelector(".editor-save").dispatchEvent(new window.Event("click"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(saved, [], "an untouched view writes nothing");
});

test("an empty required title blocks the save", needsDom, async () => {
    let saved = null;
    const host = render(workItem(), { editMode: true, onSave: async (fields) => { saved = fields; } });
    const title = host.querySelector(".editor-plain");
    title.value = "   ";
    title.dispatchEvent(new window.Event("input"));
    host.querySelector(".editor-save").dispatchEvent(new window.Event("click"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(saved, null, "the request should not be made");
    const error = host.querySelector(".editor-error");
    assert.equal(error.hidden, false);
    assert.match(error.textContent, /cannot be empty/i);
});

test("an HTML field is editable in place, keeping the markup it already had", needsDom, () => {
    const stored = '<div><span style="color:#f00">Critical</span> <a href="#" data-vss-mention="version:2.0,g">@Dev</a></div>';
    const host = render(workItem({
        templateSections: [{
            title: "Description",
            fields: [{ name: "Description", field: "System.Description", isHtml: true, value: stored }],
        }],
    }), { editMode: true });
    const surface = host.querySelector(".template-section .editor-html");
    assert.ok(surface, "the field should be editable");
    // The formatting the canvas has no toolbar for is still there to be saved back.
    assert.equal(surface.querySelector("span").getAttribute("style"), "color:#f00");
    assert.equal(surface.querySelector("a").getAttribute("data-vss-mention"), "version:2.0,g");
});

// Mirrors how app.mjs wires the form: onSubmit clicks the save button, so a
// shortcut test exercises the same path a click does rather than a stub.
function renderEditing(item, options = {}) {
    let host = null;
    host = render(item, {
        editMode: true,
        onSubmit: () => host.querySelector(".editor-save")?.click(),
        ...options,
    });
    return host;
}

test("Cmd or Ctrl+Enter in an HTML field saves, the way it does for a description", needsDom, async () => {
    let saved = null;
    const host = renderEditing(workItem({ templateSections: [descriptionSection] }), {
        onSave: async (fields) => { saved = fields; },
    });
    const surface = host.querySelector(".editor-html");
    surface.append(document.createTextNode(" and more"));
    surface.dispatchEvent(new window.Event("input"));
    for (const modifier of ["metaKey", "ctrlKey"]) {
        saved = null;
        surface.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", [modifier]: true, bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.ok(saved, `${modifier} should save`);
        assert.equal(saved[0].name, "System.Description");
        assert.match(saved[0].value, /and more/);
        assert.equal(saved[0].isHtml, true);
    }
});

test("a bare Enter in an HTML field does not save, because the field is multi-line", needsDom, async () => {
    let saved = null;
    const host = renderEditing(workItem({ templateSections: [descriptionSection] }), {
        onSave: async (fields) => { saved = fields; },
    });
    const surface = host.querySelector(".editor-html");
    surface.append(document.createTextNode(" and more"));
    surface.dispatchEvent(new window.Event("input"));
    surface.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(saved, null);
});

test("Escape in an HTML field cancels", needsDom, () => {
    let cancelled = false;
    const host = render(workItem({ templateSections: [descriptionSection] }), {
        editMode: true,
        onCancelEdit: () => { cancelled = true; },
    });
    host.querySelector(".editor-html")
        .dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(cancelled, true);
});

test("a field holding executable markup stays read-only and says where to edit it", needsDom, () => {
    // Scrubbing it would drop the script on save, an edit the user never made.
    const host = render(workItem({
        templateSections: [{
            title: "Description",
            fields: [{ name: "Description", field: "System.Description", isHtml: true, value: "<p>hi<script>alert(1)</script></p>" }],
        }],
    }), { editMode: true });
    const section = host.querySelector(".template-section");
    assert.equal(section.querySelectorAll(".editor").length, 0, "no editor is offered");
    assert.ok(section.querySelector(".field-locked"), "it should explain why instead");
    assert.match(section.textContent, /Azure DevOps/);
});

test("a plain template field is still editable", needsDom, () => {
    const host = render(workItem({
        templateSections: [{
            title: "Details",
            fields: [{ name: "Notes", field: "Custom.Notes", isHtml: false, value: "plain" }],
        }],
    }), { editMode: true });
    assert.ok(host.querySelector(".template-section .editor-plain"), "plain text carries no markup risk");
});

test("a read-only render offers no edit controls at all", needsDom, () => {
    const host = render(workItem({ templateSections: [descriptionSection] }), { canEdit: false });
    assert.equal(host.querySelectorAll(".inline-edit").length, 0);
});
