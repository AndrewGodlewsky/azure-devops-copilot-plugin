const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
};

export function createTaskSuggestionPanel({ request, url, onCreated, confirm = message => window.confirm(message) }) {
    const host = element("section", "task-suggestions work-item-card");
    host.hidden = true;
    host.setAttribute("aria-label", "Suggested tasks");
    let draft, newer, dirty = false, busy = false, disposed = false, timer, error = "";
    let mode = "parent", assignee = "", notices;
    const button = (label, run, className = "secondary") => {
        const node = element("button", className, label);
        node.type = "button"; node.disabled = busy;
        node.addEventListener("click", run); return node;
    };
    const adopt = value => {
        draft = value ? { ...value, tasks: value.tasks.map(task => ({ ...task, selected: task.state === "proposed" })) } : null;
        dirty = false; newer = null;
    };
    function showNotices() {
        if (!notices) return;
        notices.replaceChildren();
        if (error || draft?.error) {
            const message = element("p", "error", error || draft.error); message.setAttribute("role", "alert"); notices.append(message);
        }
        if (newer) {
            notices.append(element("p", "", "Copilot sent revised suggestions. Your edits are still here."), button("Replace with revised suggestions", () => { adopt(newer); render(); }));
        }
    }
    function schedule() {
        window.clearTimeout(timer);
        if (!disposed && draft && !draft.tasks.some(task => task.state !== "proposed")) timer = window.setTimeout(refresh, 2000);
    }
    async function refresh() {
        if (disposed || busy) return;
        if (host.hidden || document.hidden || !host.isConnected) { schedule(); return; }
        try {
            const result = await request(url("task-suggestions"));
            if (disposed || busy) return;
            if (!result.draft) { error = "This suggestion request ended. Start over to ask Copilot again."; showNotices(); return; }
            if (!draft || result.draft.requestId !== draft.requestId || result.draft.version !== draft.version) {
                if (dirty) { newer = result.draft; showNotices(); }
                else { adopt(result.draft); render(); }
            } else if (result.draft.tasks.some(task => task.state !== "proposed" && draft.tasks.find(local => local.id === task.id)?.state !== task.state)) {
                const receipts = new Map(result.draft.tasks.filter(task => task.state !== "proposed").map(task => [task.id, task]));
                draft.tasks = draft.tasks.map(task => receipts.has(task.id) ? { ...receipts.get(task.id), selected: false } : task);
                error = ""; dirty = draft.tasks.some(task => task.state === "proposed"); render();
                if (draft.tasks.some(task => task.state === "created")) await onCreated?.();
            }
            schedule();
        } catch (err) { error = err.message; showNotices(); }
    }
    async function open() {
        if (disposed) return;
        host.hidden = false;
        if (draft || busy) { schedule(); return; }
        busy = true; error = ""; render();
        try {
            const saved = await request(url("task-suggestions"));
            const result = saved.draft ? saved : await request(url("task-suggestions"), { method: "POST" });
            adopt(result.draft);
        } catch (err) { error = err.message; }
        finally { busy = false; if (!disposed) { render(); schedule(); } }
    }
    async function restart() {
        if (busy || (draft && !confirm("Replace these task suggestions and ask Copilot for a new draft?"))) return;
        busy = true; error = ""; render();
        try { await request(url("task-suggestions"), { method: "DELETE" }); adopt(null); }
        catch (err) { error = err.message; }
        finally { busy = false; render(); }
        if (!draft) await open();
    }
    async function create() {
        if (busy || !draft) return;
        const selected = draft.tasks.filter(task => task.selected && task.state === "proposed");
        if (!selected.length) { error = "Select at least one task."; showNotices(); return; }
        busy = true; error = ""; render();
        try {
            const result = await request(url("create-suggested-tasks"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
                requestId: draft.requestId, version: draft.version, tasks: selected.map(({ id, title, description, doneWhen }) => ({ id, title, description, doneWhen })), assigneeMode: mode, assignedTo: assignee,
            }) });
            // Keep unchecked local edits as well as the server's creation receipts.
            const local = new Map(draft.tasks.map(task => [task.id, task]));
            draft = { ...result.draft, tasks: result.draft.tasks.map(task => task.state === "proposed" ? local.get(task.id) || { ...task, selected: true } : { ...task, selected: false }) };
            dirty = draft.tasks.some(task => task.state === "proposed");
            if (draft.tasks.some(task => task.state === "created")) await onCreated?.();
        } catch (err) {
            error = `${err.message} Check the story's child tasks before retrying if delivery was interrupted.`;
        } finally { busy = false; if (!disposed) { render(); schedule(); } }
    }
    function render() {
        host.replaceChildren();
        const header = element("div", "task-suggestions-header");
        header.append(element("h2", "work-item-card-title", "Suggested tasks"), button("Close review", () => { host.hidden = true; window.clearTimeout(timer); }));
        host.append(header);
        notices = element("div", "task-suggestions-notices"); host.append(notices); showNotices();
        if (!draft) {
            host.append(element("p", "", busy ? "Requesting suggestions from Copilot…" : "Generate a draft from the saved story, then review it here before creating tasks."));
            if (!busy) host.append(button("Try again", open));
            return;
        }
        host.append(element("p", "task-suggestions-hint", `For #${draft.parentId} · saved revision ${draft.parentRev}. Draft suggestions stay in this canvas session. Nothing is created until you choose Create selected tasks.`));
        if (draft.status === "waiting") host.append(element("p", "", "Waiting for Copilot. Follow the current chat for progress or clarification; results will appear here."));
        if (draft.questions.length) {
            host.append(element("h3", "", "Questions to discuss in chat"));
            const list = element("ul");
            for (const question of draft.questions) list.append(element("li", "", question));
            host.append(list);
        }
        if (draft.status === "ready" && !draft.tasks.length) host.append(element("p", "", "No tasks proposed yet. Answer the questions in chat and ask Copilot to revise the suggestions."));
        draft.tasks.forEach((task, index) => {
            const row = element("fieldset", "task-suggestion-row"); row.disabled = busy || task.state !== "proposed";
            row.append(element("legend", "", `Task ${index + 1}`));
            if (task.state === "proposed") {
                const label = element("label", "task-suggestion-select");
                const check = element("input"); check.type = "checkbox"; check.checked = task.selected; check.setAttribute("aria-label", `Select task ${index + 1}`);
                check.addEventListener("change", () => { task.selected = check.checked; dirty = true; });
                label.append(check, document.createTextNode("Create this task")); row.append(label);
                for (const [field, labelText, max] of [["title", "Title", 255], ["description", "Description", 8000], ["doneWhen", "Done when", 2000]]) {
                    const label = element("label", "", labelText);
                    const input = element(field === "title" ? "input" : "textarea", "editor-body");
                    input.value = task[field]; input.maxLength = max;
                    input.setAttribute("aria-label", `${labelText} for task ${index + 1}`);
                    input.addEventListener("input", () => { task[field] = input.value; dirty = true; });
                    label.append(input); row.append(label);
                }
            } else {
                const result = element("p", "", task.state === "created" ? `Created #${task.createdId}: ${task.title}` : `${task.title}: ${task.error}`);
                result.setAttribute("role", task.state === "created" ? "status" : "alert"); row.append(result);
            }
            host.append(row);
        });
        if (draft.tasks.some(task => task.state === "proposed")) {
            const label = element("label", "task-suggestions-assignment", "Assign new tasks to");
            const select = element("select", "editor-body"); select.disabled = busy;
            for (const [value, name] of [["parent", `Story assignee (${draft.assignedTo || "Unassigned"})`], ["unassigned", "Unassigned"], ["person", "Specific person"]]) {
                const option = element("option", "", name); option.value = value; select.append(option);
            }
            select.value = mode; select.addEventListener("change", () => { mode = select.value; dirty = true; render(); }); label.append(select); host.append(label);
            if (mode === "person") {
                const person = element("input", "editor-body"); person.value = assignee; person.placeholder = "Email or identity"; person.maxLength = 512; person.disabled = busy;
                person.setAttribute("aria-label", "Task assignee"); person.addEventListener("input", () => { assignee = person.value; dirty = true; }); host.append(person);
            }
        }
        const footer = element("div", "task-suggestions-actions");
        if (draft.tasks.some(task => task.state === "proposed")) footer.append(button(busy ? "Creating…" : "Create selected tasks", create, "primary"));
        footer.append(button("Check for suggestions", refresh), button("Start over", restart)); host.append(footer);
    }
    return { host, open, refresh, hasEdits: () => dirty, dispose: () => { disposed = true; window.clearTimeout(timer); } };
}
