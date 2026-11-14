export function hasDraft(draft) {
    return Boolean(draft?.fields?.length || (typeof draft?.comment === "string"
        ? draft.comment : draft?.comment?.content)?.trim());
}

export function fieldValues(item) {
    return {
        "System.Title": item.title || "",
        "System.State": item.state || "",
        "System.AssignedTo": item.assignedTo === "Unassigned" ? "" : item.assignedTo || "",
        "System.Tags": (item.tags || []).join("; "),
        "System.AreaPath": item.area || "",
        "System.IterationPath": item.iteration || "",
        ...Object.fromEntries((item.templateSections || []).flatMap(section =>
            section.fields.map(field => [field.field, field.value ?? ""]))),
    };
}

// An edit can change again while its previous value is being saved, including
// reverting to the original value (which is absent from a changed-fields list).
export function fieldsAfterSave(submitted, current, original, savedNames) {
    const before = new Map((submitted || []).map(field => [field.name, field]));
    const now = new Map((current || []).map(field => [field.name, field]));
    const pending = [];
    for (const name of new Set([...before.keys(), ...now.keys()])) {
        const value = now.get(name) || { ...before.get(name), value: String(original[name] ?? "") };
        if (savedNames.has(name) && value.value === before.get(name)?.value) continue;
        if (!savedNames.has(name) && !now.has(name)) continue;
        pending.push(value);
    }
    return pending;
}

// Serialize writes so a slow autosave can never resurrect a discarded draft.
export function createDraftWriter({ write, onStatus = () => {}, delay = 400, schedule = setTimeout, cancel = clearTimeout }) {
    let timer, pending, version = 0, chain = Promise.resolve();
    function flush() {
        cancel(timer);
        if (!pending) return chain;
        const job = pending;
        pending = null;
        chain = chain.catch(() => {}).then(async () => {
            try {
                await write(job.value);
                if (job.version === version) onStatus(job.value ? "Draft saved on this device" : "");
            } catch (error) {
                if (job.version === version) {
                    pending = job;
                    onStatus(`Draft not saved: ${error.message}`);
                }
                throw error;
            }
        });
        return chain;
    }
    return {
        set(value) {
            pending = { value: value ? structuredClone(value) : null, version: ++version };
            onStatus(value ? "Saving draft..." : "Clearing draft...");
            cancel(timer);
            timer = schedule(() => { flush().catch(() => {}); }, delay);
        },
        flush,
        pending: () => pending,
        stop() { cancel(timer); pending = null; },
    };
}
