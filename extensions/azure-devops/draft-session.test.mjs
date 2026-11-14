import test from "node:test";
import assert from "node:assert/strict";
import { createDraftWriter, hasDraft, fieldValues, fieldsAfterSave } from "./ui/draft-session.mjs";

test("draft writes serialize with discard, including an autosave already in flight", async () => {
    const calls = [];
    let release;
    const writer = createDraftWriter({ delay: 10000, write: async value => {
        calls.push(value);
        if (value) await new Promise(resolve => { release = resolve; });
    } });
    writer.set({ fields: [{ name: "System.Title", value: "My title" }] });
    const saved = writer.flush();
    await Promise.resolve(); await Promise.resolve();
    writer.set(null);
    const discarded = writer.flush();
    assert.equal(calls.length, 1);
    release(); await saved; await discarded;
    assert.equal(calls[1], null);
});

test("failed writes retain the latest draft for retry without clobbering newer text", async () => {
    let fail = true;
    const values = [], statuses = [];
    const writer = createDraftWriter({ delay: 10000, onStatus: status => statuses.push(status), write: async value => {
        if (fail) throw new Error("offline");
        values.push(value);
    } });
    writer.set({ comment: { content: "A note", mentions: [] } });
    await assert.rejects(writer.flush(), /offline/);
    assert.match(statuses.at(-1), /not saved/);
    assert.ok(writer.pending());
    fail = false;
    await writer.flush();
    assert.equal(values[0].comment.content, "A note");
});

test("draft detection and original values cover comment-only and custom-field edits", () => {
    assert.equal(hasDraft({ fields: [], comment: { content: " hello " } }), true);
    assert.equal(hasDraft({ fields: [], comment: " " }), false);
    assert.deepEqual(fieldValues({ tags: ["blocked"], assignedTo: "Unassigned", templateSections: [
        { fields: [{ field: "Custom.Notes", value: "Original" }] },
    ] })["Custom.Notes"], "Original");
});

test("typing and reverting while a save is in flight retain the newer local value", () => {
    const submitted = [{ name: "System.Title", value: "Submitted", isHtml: false }];
    assert.deepEqual(fieldsAfterSave(submitted, [{ ...submitted[0], value: "New typing" }], { "System.Title": "Original" }, new Set(["System.Title"]))[0].value, "New typing");
    assert.equal(fieldsAfterSave(submitted, [], { "System.Title": "Original" }, new Set(["System.Title"]))[0].value, "Original");
    assert.deepEqual(fieldsAfterSave(submitted, submitted, { "System.Title": "Original" }, new Set(["System.Title"])), []);
});
