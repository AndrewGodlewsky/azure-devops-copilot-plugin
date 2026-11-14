import assert from "node:assert/strict";
import test from "node:test";
let JSDOM;
try { ({ JSDOM } = await import("jsdom")); } catch { JSDOM = null; }
const needsDom = { skip: JSDOM ? false : "jsdom is not installed" };
const dom = JSDOM ? new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" }) : null;
if (dom) globalThis.document = dom.window.document;
const { captureAttachmentInsertion, createAttachmentUpload } = await import("./ui/attachment-upload.mjs");
const url = "https://dev.azure.com/example/project/_apis/wit/attachments/abc";

test("multiple files keep their selected order at the same HTML caret", needsDom, async () => {
    const body = document.createElement("div");
    body.textContent = "Before after";
    document.body.append(body);
    const range = document.createRange();
    range.setStart(body.firstChild, 7);
    range.collapse(true);
    document.getSelection().removeAllRanges();
    document.getSelection().addRange(range);
    const upload = createAttachmentUpload({
        onUploadAttachment: async file => ({ attachment: { url, fileName: file.name } }),
        captureInsertion: () => captureAttachmentInsertion(body, { format: "html" }),
    });
    await upload.uploadFiles([{ name: "first.png", type: "image/png", size: 1 }, { name: "second.png", type: "image/png", size: 1 }]);
    assert.deepEqual([...body.querySelectorAll("img")].map(image => image.alt), ["first.png", "second.png"]);
    assert.equal(body.textContent, "Before after");
    body.remove();
});

test("attachments enforce the 60 MiB boundary while allowing empty files", needsDom, async () => {
    const sent = [];
    const upload = createAttachmentUpload({ onUploadAttachment: async file => {
        sent.push(file.name);
        return { attachment: { url, fileName: file.name } };
    } });
    await upload.uploadFiles([
        { name: "empty.txt", size: 0 },
        { name: "limit.dat", size: 60 * 1024 * 1024 },
        { name: "large.dat", size: 60 * 1024 * 1024 + 1 },
    ]);
    assert.deepEqual(sent, ["empty.txt", "limit.dat"]);
    assert.match(upload.host.querySelector('[role="alert"]').textContent, /larger than 60 MiB/);
    assert.equal(upload.host.querySelectorAll("a").length, 2);
});

test("upload errors stay visible and unsafe response URLs never become links", needsDom, async () => {
    for (const result of [() => { throw new Error("Connection lost; retry upload."); }, () => ({ attachment: { url: "javascript:alert(1)" } })]) {
        const upload = createAttachmentUpload({ onUploadAttachment: result });
        await upload.uploadFiles([{ name: "notes.txt", size: 12 }]);
        assert.ok(upload.host.querySelector('[role="alert"]'));
        assert.equal(upload.host.querySelector("a"), null);
        assert.equal(upload.isUploading(), false);
        assert.equal(upload.host.querySelector("progress"), null);
    }
});

test("drop and keyboard-accessible file picker upload without replacing their host", needsDom, async () => {
    let uploaded = 0;
    const upload = createAttachmentUpload({ onUploadAttachment: async () => {
        uploaded += 1;
        return { attachment: { url, fileName: "notes.txt" } };
    } });
    document.body.append(upload.host);
    const input = upload.host.querySelector('input[type="file"]');
    let pickerOpened = false;
    input.click = () => { pickerOpened = true; };
    upload.host.querySelector("button").click();
    assert.equal(pickerOpened, true);
    const drop = new dom.window.Event("drop", { cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: { files: [new dom.window.File(["notes"], "notes.txt")] } });
    upload.host.dispatchEvent(drop);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(drop.defaultPrevented, true);
    assert.equal(uploaded, 1);
    assert.ok(upload.host.isConnected);
    assert.equal(upload.host.querySelector("a").textContent, "notes.txt");
    upload.host.remove();
});
