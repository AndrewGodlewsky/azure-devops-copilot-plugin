import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceStore, normalizeDraft } from "./workspace-store.mjs";

const scope = { organization: "fabrikam", project: "widgets" };
const draft = { rev: 3, fields: [{ name: "System.Title", value: "Unsaved title" }], baseValues: { "System.Title": "Original title" },
    comment: { content: "Hello @person", mentions: [{ id: "fictional-person", displayName: "Person" }] } };

test("workspace drafts persist across stores and isolate identities, projects and item ids", (t) => {
    const root = mkdtempSync(join(tmpdir(), "boards-store-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const store = createWorkspaceStore(root);
    const saved = store.saveDraft("account-a", scope, 42, draft);
    assert.equal(saved.fields[0].value, "Unsaved title");
    assert.ok(saved.updatedAt);
    assert.deepEqual(createWorkspaceStore(root).draft("account-a", scope, 42), saved);
    assert.equal(store.draft("account-b", scope, 42), null);
    assert.equal(store.draft("account-a", { ...scope, project: "other" }, 42), null);
    assert.equal(store.draft("account-a", scope, 43), null);
    assert.deepEqual(store.draft("account-a", { organization: "FABRIKAM", project: "Widgets" }, 42), saved);
    const accountDir = join(root, readdirSync(root)[0]);
    assert.match(readdirSync(root)[0], /^[a-f0-9]{64}$/);
    assert.equal(readdirSync(accountDir).filter((file) => file.startsWith(".pending")).length, 0);
    if (process.platform !== "win32") {
        assert.equal(statSync(accountDir).mode & 0o777, 0o700);
        assert.equal(statSync(join(accountDir, readdirSync(accountDir)[0])).mode & 0o777, 0o600);
    }
    store.deleteDraft("account-a", scope, 42);
    assert.equal(store.draft("account-a", scope, 42), null);
});

test("workspace preferences shallow merge only known keys and keep prior state on invalid writes", (t) => {
    const root = mkdtempSync(join(tmpdir(), "boards-prefs-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const store = createWorkspaceStore(root);
    store.updatePreferences("account", { dashboardSections: ["current", "blocked"], workspace: { view: "items" } });
    const value = store.updatePreferences("account", { openItems: [{ id: 42, connection: scope }] });
    assert.deepEqual(value.dashboardSections, ["current", "blocked"]);
    assert.equal(value.workspace.view, "items");
    assert.throws(() => store.updatePreferences("account", { accessToken: "must-not-persist" }), /Unsupported/);
    assert.throws(() => store.updatePreferences("account", { workspace: "x".repeat(300 * 1024) }), /too large/);
    assert.deepEqual(store.preferences("account"), value);
    assert.deepEqual(store.preferences("someone-else"), {});
});

test("invalid drafts cannot replace an existing draft", (t) => {
    const root = mkdtempSync(join(tmpdir(), "boards-invalid-draft-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const store = createWorkspaceStore(root);
    const original = store.saveDraft("account", scope, 42, draft);
    for (const invalid of [
        { ...draft, rev: 0 }, { ...draft, fields: {} }, { ...draft, fields: [{ name: "bad/path", value: "no" }] },
        { ...draft, baseValues: [] }, { ...draft, comment: "x".repeat(129 * 1024) },
        { ...draft, fields: [{ name: "System.Description", value: "x".repeat(513 * 1024) }] },
    ]) assert.throws(() => store.saveDraft("account", scope, 42, invalid));
    assert.deepEqual(store.draft("account", scope, 42), original);
    assert.throws(() => normalizeDraft(JSON.parse('{"rev":1,"fields":[],"baseValues":{"__proto__":"bad"}}')));
    assert.throws(() => store.saveDraft("", scope, 42, draft), /Sign in/);
});

test("an unreadable preferences record is preserved rather than silently overwritten", (t) => {
    const root = mkdtempSync(join(tmpdir(), "boards-corrupt-prefs-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const store = createWorkspaceStore(root);
    store.updatePreferences("account", { activeItem: 42 });
    const path = join(root, readdirSync(root)[0], "preferences.json");
    writeFileSync(path, "broken-json");
    assert.throws(() => store.updatePreferences("account", { activeItem: 43 }), /could not be read/);
    assert.equal(readFileSync(path, "utf8"), "broken-json");
});
