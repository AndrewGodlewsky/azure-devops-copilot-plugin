import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MAX_DRAFT_BYTES = 512 * 1024;
export const MAX_PREFERENCES_BYTES = 256 * 1024;
const preferenceKeys = new Set(["dashboardSections", "openItems", "activeItem", "workspace"]);
const hash = (value) => createHash("sha256").update(value).digest("hex");

function invalid(message) {
    throw Object.assign(new Error(message), { code: "azure_devops_invalid_workspace_state" });
}

function boundedJson(value, limit) {
    const json = JSON.stringify(value);
    if (!json || Buffer.byteLength(json) > limit) invalid("The workspace state is too large to save.");
    return JSON.parse(json, (key, entry) => {
        if (["__proto__", "prototype", "constructor"].includes(key)) invalid("Invalid workspace state property.");
        return entry;
    });
}

export function normalizeDraft(value) {
    const draft = boundedJson(value, MAX_DRAFT_BYTES);
    if (!draft || !Number.isInteger(draft.rev) || draft.rev <= 0 || !Array.isArray(draft.fields) || draft.fields.length > 100) {
        invalid("A draft needs its original revision and up to 100 edited fields.");
    }
    const fields = draft.fields.map((field) => {
        if (!field || typeof field.name !== "string" || !/^[A-Za-z][A-Za-z0-9_.]{0,127}$/.test(field.name)
            || typeof field.value !== "string") invalid("A draft contains an invalid field.");
        return { name: field.name, value: field.value, isHtml: field.isHtml === true,
            ...(field.format === "html" || field.format === "markdown" ? { format: field.format } : {}) };
    });
    const baseValues = draft.baseValues || {};
    if (typeof baseValues !== "object" || Array.isArray(baseValues)
        || Object.entries(baseValues).some(([name, entry]) => !/^[A-Za-z][A-Za-z0-9_.]{0,127}$/.test(name) || typeof entry !== "string")) {
        invalid("Draft base values must map field names to their original text.");
    }
    const comment = draft.comment ?? "";
    if (typeof comment !== "string" && (!comment || typeof comment !== "object" || Array.isArray(comment)
        || typeof comment.content !== "string" || !Array.isArray(comment.mentions || []))) {
        invalid("A draft comment must contain text and optional mentions.");
    }
    if (Buffer.byteLength(JSON.stringify(comment)) > 128 * 1024) invalid("The draft comment is too large to save.");
    return { rev: draft.rev, fields, baseValues, comment, updatedAt: new Date().toISOString() };
}

export function createWorkspaceStore(root) {
    function accountDirectory(account) {
        if (typeof account !== "string" || !account.trim()) invalid("Sign in before saving workspace state.");
        return join(root, hash(account));
    }
    function draftPath(account, connection, id) {
        if (!Number.isInteger(id) || id <= 0) invalid("A draft needs a positive work item id.");
        const scope = [connection.organization, connection.project || "", String(id)]
            .map((entry) => String(entry).toLowerCase()).join("/");
        return join(accountDirectory(account), `draft-${hash(scope)}.json`);
    }
    function read(path, fallback) {
        try { return JSON.parse(readFileSync(path, "utf8")); }
        catch (error) {
            if (error.code === "ENOENT") return fallback;
            throw Object.assign(new Error("The saved workspace state could not be read. Your existing file was kept."), {
                code: "azure_devops_workspace_read_failed",
            });
        }
    }
    function write(account, path, value) {
        const directory = accountDirectory(account);
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        chmodSync(directory, 0o700);
        const temporary = join(directory, `.pending-${randomBytes(12).toString("hex")}.json`);
        try {
            writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
            renameSync(temporary, path);
        } catch (error) {
            throw Object.assign(new Error("Could not save workspace state. Your previous saved state was kept."), {
                code: "azure_devops_workspace_write_failed", cause: error,
            });
        } finally { rmSync(temporary, { force: true }); }
    }
    return {
        preferences(account) { return read(join(accountDirectory(account), "preferences.json"), {}); },
        updatePreferences(account, value) {
            const patch = boundedJson(value, MAX_PREFERENCES_BYTES);
            if (!patch || typeof patch !== "object" || Array.isArray(patch)
                || Object.keys(patch).some((key) => !preferenceKeys.has(key))) invalid("Unsupported workspace preference.");
            const preferences = boundedJson({ ...this.preferences(account), ...patch }, MAX_PREFERENCES_BYTES);
            write(account, join(accountDirectory(account), "preferences.json"), preferences);
            return preferences;
        },
        draft(account, connection, id) { return read(draftPath(account, connection, id), null); },
        saveDraft(account, connection, id, value) {
            const draft = normalizeDraft(value);
            write(account, draftPath(account, connection, id), draft);
            return draft;
        },
        deleteDraft(account, connection, id) { rmSync(draftPath(account, connection, id), { force: true }); },
    };
}
