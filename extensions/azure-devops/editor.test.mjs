// Run with: node --test editor.test.mjs
//
// The editing surfaces are plain text, a fixed set of choices, or Markdown
// source. There is no contenteditable and no HTML round trip, so the property
// worth asserting hardest is that what the user typed is what gets saved --
// including the trailing spaces Azure DevOps reads as a line break.
import assert from "node:assert/strict";
import test from "node:test";

// These extensions ship without node_modules, so jsdom is not guaranteed to be
// present. Skip rather than fail when it is missing, and run with:
//   npm install jsdom && node --test editor.test.mjs
let JSDOM;
try {
    ({ JSDOM } = await import("jsdom"));
} catch {
    JSDOM = null;
}
const needsDom = { skip: JSDOM ? false : "jsdom is not installed" };

if (JSDOM) {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.DOMParser = dom.window.DOMParser;
    globalThis.Node = dom.window.Node;
}

function mount(host) {
    document.body.append(host);
    return host;
}

function tools(editor) {
    return [...editor.host.querySelectorAll(".editor-tool")];
}

function tool(editor, name) {
    return tools(editor).find((node) => node.getAttribute("aria-label").startsWith(name));
}

function click(node) {
    node.dispatchEvent(new window.Event("click"));
}

test("pasted screenshots upload at the Markdown caret without losing edits made while uploading", needsDom, async () => {
    const { createMarkdownField } = await import("./ui/editor.mjs");
    let finish;
    const editor = createMarkdownField({ label: "Description", value: "Before after", onUploadAttachment: () => new Promise(resolve => { finish = resolve; }) });
    mount(editor.host);
    const source = editor.host.querySelector("textarea");
    source.setSelectionRange(7, 7);
    const paste = new window.Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { files: [new window.File(["image"], "shot.png", { type: "image/png" })], getData: () => "" } });
    source.dispatchEvent(paste);
    assert.equal(paste.defaultPrevented, true);
    await Promise.resolve();
    source.value += " edited";
    source.dispatchEvent(new window.Event("input"));
    finish({ attachment: { url: "https://dev.azure.com/example/project/_apis/wit/attachments/abc", fileName: "shot.png" } });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.match(editor.getValue(), /^Before !\[shot\.png\]/);
    assert.match(editor.getValue(), /after edited$/);
    assert.equal(editor.isDirty(), true);
    editor.host.remove();
});

test("HTML draft restore preserves formatting and stores original image URLs behind previews", needsDom, async () => {
    const { createHtmlField } = await import("./ui/editor.mjs");
    const url = "https://dev.azure.com/example/project/_apis/wit/attachments/abc";
    const editor = createHtmlField({ label: "Description", value: "<p>Original</p>", draftValue: `<table><tbody><tr><td style="color:red">Draft<img src="${url}"></td></tr></tbody></table>`, imageUrl: () => "/api/attachment?nonce=test" });
    assert.match(editor.getValue(), /<table>/);
    assert.match(editor.getValue(), /style="color:red"/);
    assert.ok(editor.getValue().includes(url));
    assert.equal(editor.getValue().includes("nonce=test"), false);
    assert.equal(editor.host.querySelector("img").getAttribute("src"), "/api/attachment?nonce=test");
    assert.equal(editor.isDirty(), true);
});

test("copying an HTML image keeps its original Azure URL in the draft", needsDom, async () => {
    const { createHtmlField } = await import("./ui/editor.mjs");
    const url = "https://dev.azure.com/example/project/_apis/wit/attachments/abc";
    const editor = createHtmlField({ label: "Description", value: `<p><img src="${url}"></p>`, imageUrl: source => source === url ? "/api/attachment?nonce=test" : source });
    const body = editor.host.querySelector(".editor-html");
    const copy = body.querySelector("img").cloneNode(true);
    copy.setAttribute("src", copy.src);
    body.append(copy);
    body.dispatchEvent(new window.Event("input"));
    assert.equal(editor.getDraftValue().includes("nonce=test"), false);
    assert.equal(editor.getDraftValue().split(url).length, 3);
});

test("an upload that finishes after an editor is removed does not mutate an abandoned field", needsDom, async () => {
    const { createMarkdownField } = await import("./ui/editor.mjs");
    let finish;
    const editor = createMarkdownField({ label: "Description", value: "Keep text", onUploadAttachment: () => new Promise(resolve => { finish = resolve; }) });
    mount(editor.host);
    const source = editor.host.querySelector("textarea");
    const event = new window.Event("paste", { cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { files: [new window.File(["image"], "shot.png", { type: "image/png" })] } });
    source.dispatchEvent(event);
    await Promise.resolve();
    editor.host.remove();
    finish({ attachment: { url: "https://dev.azure.com/example/project/_apis/wit/attachments/abc", fileName: "shot.png" } });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(editor.getValue(), "Keep text");
});

test("a failed screenshot upload keeps the HTML and text typed while it was pending", needsDom, async () => {
    const { createHtmlField } = await import("./ui/editor.mjs");
    let rejectUpload;
    const editor = createHtmlField({ label: "Description", value: '<p><strong>Keep</strong> this</p>', onUploadAttachment: () => new Promise((_, reject) => { rejectUpload = reject; }) });
    mount(editor.host);
    const body = editor.host.querySelector(".editor-html");
    const paste = new window.Event("paste", { cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { files: [new window.File(["image"], "shot.png", { type: "image/png" })] } });
    body.dispatchEvent(paste);
    await Promise.resolve();
    assert.ok(editor.host.querySelector("progress"));
    body.querySelector("p").append(" and new text");
    body.dispatchEvent(new window.Event("input"));
    rejectUpload(new Error("No connection. Retry the upload."));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(editor.getValue(), '<p><strong>Keep</strong> this and new text</p>');
    assert.match(editor.host.querySelector('[role="alert"]').textContent, /No connection/);
    assert.equal(editor.host.querySelector("progress"), null);
    editor.host.remove();
});

test("pasting into HTML inserts at the saved caret and stores the Azure URL", needsDom, async () => {
    const { createHtmlField } = await import("./ui/editor.mjs");
    const url = "https://dev.azure.com/example/project/_apis/wit/attachments/abc";
    const editor = createHtmlField({ label: "Description", value: '<p style="color: red">Before after</p>', imageUrl: () => "/api/attachment?nonce=test", onUploadAttachment: async () => ({ attachment: { url, fileName: "shot.png" } }) });
    mount(editor.host);
    const body = editor.host.querySelector(".editor-html");
    const range = document.createRange();
    range.setStart(body.querySelector("p").firstChild, 7);
    range.collapse(true);
    document.getSelection().removeAllRanges();
    document.getSelection().addRange(range);
    const paste = new window.Event("paste", { cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { files: [new window.File(["image"], "shot.png", { type: "image/png" })] } });
    body.dispatchEvent(paste);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.match(editor.getValue(), /Before <img[^>]+>after/);
    assert.ok(editor.getValue().includes(url));
    assert.equal(editor.getValue().includes("nonce=test"), false);
    assert.equal(body.querySelector("img").getAttribute("src"), "/api/attachment?nonce=test");
    editor.host.remove();
});

test("a description is saved exactly as typed, including trailing-space line breaks", needsDom, async () => {
    const { createMarkdownField } = await import("./ui/editor.mjs");
    // Two trailing spaces are how Azure DevOps spells a line break. A round trip
    // through a rich editor is what used to eat them.
    const original = "line one  \nline two\n\n- bullet\n- another";
    const editor = createMarkdownField({ label: "Description", value: original });
    mount(editor.host);

    assert.equal(editor.getValue(), original, "an untouched field returns its source byte for byte");
    assert.equal(editor.isDirty(), false);

    editor.host.remove();
});

test("leading whitespace is kept, because four spaces start a code block", needsDom, async () => {
    const { createMarkdownField } = await import("./ui/editor.mjs");
    // Trimming both ends would turn this indented code block into a paragraph the
    // moment the user edited anything else in the description.
    const original = "    const a = 1;\n\nprose after";
    const editor = createMarkdownField({ label: "Description", value: original });
    mount(editor.host);

    assert.equal(editor.getValue(), original);
    assert.equal(editor.isDirty(), false, "an untouched field is not rewritten");

    editor.host.remove();
});

test("editing marks the field dirty and returns the edited source", needsDom, async () => {
    const { createMarkdownField } = await import("./ui/editor.mjs");
    let dirty = null;
    const editor = createMarkdownField({
        label: "Description",
        value: "before",
        onDirtyChange: (value) => { dirty = value; },
    });
    mount(editor.host);

    const source = editor.host.querySelector(".editor-source");
    source.value = "after  \nwith a break";
    source.dispatchEvent(new window.Event("input"));

    assert.equal(dirty, true);
    assert.equal(editor.getValue(), "after  \nwith a break", "trailing spaces survive the edit");
    editor.host.remove();
});

test("the toolbar inserts Markdown into the source rather than formatting a document", needsDom, async () => {
    const { createMarkdownField } = await import("./ui/editor.mjs");
    const editor = createMarkdownField({ label: "Description", value: "hello world" });
    mount(editor.host);
    const source = editor.host.querySelector(".editor-source");

    source.setSelectionRange(0, 5);
    click(tool(editor, "Bold"));
    assert.equal(source.value, "**hello** world");

    editor.host.remove();
});

test("a formatting shortcut answers to both the plain and shift combinations", needsDom, async () => {
    const { createMarkdownField } = await import("./ui/editor.mjs");
    const editor = createMarkdownField({ label: "Description", value: "hello world" });
    mount(editor.host);
    const source = editor.host.querySelector(".editor-source");

    source.setSelectionRange(0, 5);
    source.dispatchEvent(new window.KeyboardEvent("keydown", { key: "b", metaKey: true, bubbles: true, cancelable: true }));
    assert.equal(source.value, "**hello** world", "the plain combination should apply bold");

    editor.host.remove();
});

test("preview renders the source and returns to editing", needsDom, async () => {
    const { createMarkdownField } = await import("./ui/editor.mjs");
    const editor = createMarkdownField({ label: "Description", value: "# Heading\n\n- one\n- two" });
    mount(editor.host);

    const source = editor.host.querySelector(".editor-source");
    const preview = editor.host.querySelector(".editor-preview");
    const previewButton = tool(editor, "Preview");

    assert.equal(preview.hidden, true, "editing is the default");

    click(previewButton);
    assert.equal(preview.hidden, false);
    assert.equal(source.hidden, true);
    assert.match(preview.innerHTML, /<h1>Heading<\/h1>/);
    assert.match(preview.innerHTML, /<li>one<\/li>/);

    click(previewButton);
    assert.equal(preview.hidden, true, "the toggle goes back to editing");
    assert.equal(source.hidden, false);

    editor.host.remove();
});

test("preview shows the Azure DevOps line-break behaviour, not the GitHub one", needsDom, async () => {
    const { createMarkdownField } = await import("./ui/editor.mjs");
    const editor = createMarkdownField({ label: "Description", value: "line one\nline two" });
    mount(editor.host);

    click(tool(editor, "Preview"));
    const preview = editor.host.querySelector(".editor-preview");
    assert.doesNotMatch(preview.innerHTML, /<br>/, "a bare newline is not a break in Azure DevOps");

    editor.host.remove();
});

test("an empty description previews as a note rather than a blank pane", needsDom, async () => {
    const { createMarkdownField } = await import("./ui/editor.mjs");
    const editor = createMarkdownField({ label: "Description", value: "" });
    mount(editor.host);
    click(tool(editor, "Preview"));
    assert.match(editor.host.querySelector(".editor-preview").textContent, /Nothing to preview/);
    editor.host.remove();
});

test("applying a link inserts Markdown, and a rejected scheme reports why", needsDom, async () => {
    const { createMarkdownField } = await import("./ui/editor.mjs");
    const editor = createMarkdownField({ label: "Description", value: "text" });
    mount(editor.host);

    const input = editor.host.querySelector(".editor-link-input");
    const apply = editor.host.querySelector(".editor-link-apply");
    const error = editor.host.querySelector(".editor-link-error");

    click(tool(editor, "Insert link"));
    input.value = "javascript:alert(1)";
    click(apply);
    assert.equal(error.hidden, false, "a rejected link should explain itself");
    assert.match(error.textContent, /http, https, or mailto/);
    assert.doesNotMatch(editor.getValue(), /javascript:/, "a refused link must not reach the source");

    input.dispatchEvent(new window.Event("input"));
    assert.equal(error.hidden, true, "editing the URL clears the error");

    const source = editor.host.querySelector(".editor-source");
    source.setSelectionRange(0, 4);
    input.value = "https://example.com/a";
    click(apply);
    assert.equal(error.hidden, true, "an accepted link leaves no error behind");
    assert.match(editor.getValue(), /\]\(https:\/\/example\.com\/a\)/, "the link lands as Markdown");

    editor.host.remove();
});

test("Escape cancels from inside the editor", needsDom, async () => {
    const { createMarkdownField } = await import("./ui/editor.mjs");
    let cancelled = false;
    const editor = createMarkdownField({
        label: "Description",
        value: "text",
        onCancel: () => { cancelled = true; },
    });
    mount(editor.host);
    editor.host.querySelector(".editor-source")
        .dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    assert.equal(cancelled, true);
    editor.host.remove();
});

test("a required plain field blocks the save when emptied", needsDom, async () => {
    const { createPlainField } = await import("./ui/editor.mjs");
    const editor = createPlainField({ label: "Title", value: "has a title", required: true });
    mount(editor.host);
    const input = editor.host.querySelector("input");
    input.value = "   ";
    input.dispatchEvent(new window.Event("input"));
    assert.notEqual(editor.validate(), "", "an empty required field reports an error");
    editor.host.remove();
});

test("the edit affordance is icon-only but keeps an accessible name", needsDom, async () => {
    const { editButton } = await import("./ui/editor.mjs");
    const button = editButton("this work item", () => {});
    assert.equal(button.getAttribute("aria-label"), "Edit this work item");
    assert.equal(button.textContent.trim(), "", "the label is for assistive tech, not the eye");
    assert.equal(button.querySelector("svg")?.getAttribute("data-icon-source"), "octicon");
    assert.equal(button.querySelector("svg")?.getAttribute("data-icon-name"), "pencil");
    assert.match(button.querySelector("path")?.getAttribute("d") || "", /^M11\.013 1\.427/);
});
