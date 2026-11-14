const VIEW_NAMES = { home: "Home", items: "Work items", board: "Board" };
const SECTIONS = { current: "My current work", blocked: "Blocked work", unfinished: "Parents with unfinished work", completed: "Recently completed" };
let workspaceSequence = 0;

const identityText = value => typeof value === "object" && value ? value.displayName || value.uniqueName || value.name || "Unassigned" : value || "Unassigned";
const htmlText = value => String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

export function createWorkspaceView(container, { request, connections = [], onOpenWorkItem, onCreated, onChange, onViewChange } = {}) {
    const doc = container.ownerDocument;
    const prefix = `workspace-${++workspaceSequence}`;
    let destroyed = false;
    let epoch = 0;
    let view = "home";
    let connection = connections[0] || null;
    let project = connection?.workItemProject || connection?.project || "";
    let team = "";
    let boardId = "";
    let metadata = { projects: [], types: [], teams: [] };
    let metadataKey = "";
    let boards = [];
    let board = null;
    let dashboard = null;
    let dashboardSections = Object.keys(SECTIONS);
    let filters = { query: "", assignee: "mine", state: "", type: "", tags: "" };
    let cursors = [""];
    let page = 0;
    let result = null;
    let preferencesPromise;
    let preferenceQueue = Promise.resolve();
    let failedPreferencePatch = null;
    let modal = null;
    let draggedId = null;
    let queuedBoardRefresh = false;
    const pending = new Set();
    const moveChoices = new Map();

    function element(tag, className, text) {
        const node = doc.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = String(text);
        return node;
    }
    function button(text, action, className = "workspace-button") {
        const node = element("button", className, text);
        node.type = "button";
        if (action) node.addEventListener("click", action);
        return node;
    }
    function input(label, value = "", type = "text") {
        const node = element("input", "workspace-input");
        node.type = type;
        node.value = value;
        node.setAttribute("aria-label", label);
        return node;
    }
    function field(label, control) {
        const wrapper = element("label", "workspace-field");
        wrapper.append(element("span", "workspace-field-label", label), control);
        return wrapper;
    }
    function select(label, values, value) {
        const node = element("select", "workspace-select");
        node.setAttribute("aria-label", label);
        for (const entry of values) {
            const option = element("option", "", entry.label);
            option.value = String(entry.value);
            node.append(option);
        }
        node.value = String(value ?? "");
        return node;
    }
    const scope = () => connection ? { ...connection, workItemProject: project } : null;
    const keyFor = (selected = scope()) => JSON.stringify([selected?.organization || "", selected?.project || "", selected?.workItemProject || ""]);
    function url(path, extra = {}, selected = scope()) {
        const params = new URLSearchParams();
        for (const [name, value] of Object.entries({ organization: selected?.organization, project: selected?.project, workItemProject: selected?.workItemProject, ...extra })) {
            if (value !== undefined && value !== null && value !== "") params.set(name, String(value));
        }
        return `${path}${params.size ? `?${params}` : ""}`;
    }
    const json = (method, body) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const current = token => !destroyed && token === epoch;
    const errorText = error => error?.message || "The request could not complete. Try again.";
    const root = element("div", "workspace-view");
    const header = element("header", "workspace-header");
    const heading = element("h1", "workspace-heading", "Home");
    const newButton = button("New work item", () => void openCreate(), "workspace-button workspace-primary");
    header.append(heading, newButton);
    const scopeBar = element("div", "workspace-scope");
    const preferenceNotice = element("div", "workspace-notice");
    preferenceNotice.hidden = true;
    preferenceNotice.setAttribute("role", "status");
    const announcement = element("div", "workspace-announcement");
    announcement.setAttribute("role", "status");
    const content = element("div", "workspace-screen");
    root.append(header, scopeBar, preferenceNotice, announcement, content);
    container.replaceChildren(root);

    function announce(message, error = false) {
        announcement.textContent = message;
        announcement.classList.toggle("is-error", error);
        announcement.setAttribute("role", error ? "alert" : "status");
    }
    function savePreferences(patch) {
        const snapshot = JSON.parse(JSON.stringify(patch));
        preferenceQueue = preferenceQueue.catch(() => {}).then(async () => {
            if (destroyed) return;
            try {
                await request("/api/workspace/preferences", json("PATCH", { ...failedPreferencePatch, ...snapshot }));
                if (destroyed) return;
                failedPreferencePatch = null;
                preferenceNotice.hidden = true;
            } catch (error) {
                if (destroyed) return;
                failedPreferencePatch = { ...failedPreferencePatch, ...snapshot };
                preferenceNotice.replaceChildren(element("span", "", `Preferences were not saved: ${errorText(error)}`), button("Retry saving", () => void savePreferences(failedPreferencePatch)));
                preferenceNotice.hidden = false;
            }
        });
        return preferenceQueue;
    }
    function saveWorkspace() {
        return savePreferences({ workspace: { organization: connection?.organization || "", project: connection?.project || "", workItemProject: project, team, boardId, view } });
    }
    function resetBoardDrafts() {
        draggedId = null;
        moveChoices.clear();
    }
    function ensurePreferences() {
        preferencesPromise ||= (async () => {
            try {
                const data = await request("/api/workspace/preferences");
                if (destroyed) return;
                const preferences = data.preferences || {};
                if (Array.isArray(preferences.dashboardSections)) dashboardSections = preferences.dashboardSections.filter(name => Object.hasOwn(SECTIONS, name));
                const workspace = preferences.workspace || {};
                const matching = connections.find(item => item.organization === workspace.organization && (item.project || "") === (workspace.project || ""));
                if (matching) {
                    connection = matching;
                    project = workspace.workItemProject || matching.workItemProject || matching.project || "";
                    team = workspace.team || "";
                    boardId = workspace.boardId || "";
                }
            } catch (error) {
                if (!destroyed) {
                    preferenceNotice.textContent = `Saved preferences could not load: ${errorText(error)}`;
                    preferenceNotice.hidden = false;
                }
            }
        })();
        return preferencesPromise;
    }
    function renderScope() {
        scopeBar.replaceChildren();
        newButton.disabled = !connection;
        if (!connection) return;
        const connectionSelect = select("Organization connection", connections.map((item, index) => ({ value: index, label: [item.organization, item.project].filter(Boolean).join(" / ") })), connections.indexOf(connection));
        connectionSelect.addEventListener("change", () => {
            connection = connections[Number(connectionSelect.value)];
            project = connection?.workItemProject || connection?.project || "";
            team = "";
            boardId = "";
            metadataKey = "";
            resetBoardDrafts();
            metadata = { projects: [], types: [], teams: [] };
            cursors = [""];
            page = 0;
            content.replaceChildren();
            void saveWorkspace();
            void refresh();
        });
        const projects = (connection.project ? [{ name: connection.project }] : metadata.projects).map(item => ({ value: item.name || item.id, label: item.name || item.id }));
        if (project && !projects.some(item => item.value === project)) projects.unshift({ value: project, label: project });
        const projectSelect = select("Project", [...(connection.project ? [] : [{ value: "", label: "All projects" }]), ...projects], project);
        projectSelect.addEventListener("change", () => {
            project = projectSelect.value;
            team = "";
            boardId = "";
            metadataKey = "";
            resetBoardDrafts();
            metadata = { ...metadata, types: [], teams: [] };
            filters = { ...filters, type: "", state: "" };
            cursors = [""];
            page = 0;
            content.replaceChildren();
            void saveWorkspace();
            void refresh();
        });
        scopeBar.append(field("Organization", connectionSelect), field("Project", projectSelect));
        if (view === "board" && project) {
            const teamSelect = select("Team", metadata.teams.map(item => ({ value: item.id, label: item.name })), team);
            teamSelect.disabled = !metadata.teams.length;
            teamSelect.addEventListener("change", () => {
                team = teamSelect.value;
                boardId = "";
                resetBoardDrafts();
                void saveWorkspace();
                void refresh();
            });
            const boardSelect = select("Board", boards.map(item => ({ value: item.id, label: item.name })), boardId);
            boardSelect.disabled = !boards.length;
            boardSelect.addEventListener("change", () => {
                boardId = boardSelect.value;
                resetBoardDrafts();
                void saveWorkspace();
                void refresh();
            });
            scopeBar.append(field("Team", teamSelect), field("Board", boardSelect));
        }
    }
    async function loadMetadata(token) {
        const selected = scope();
        const key = keyFor(selected);
        if (key === metadataKey) return true;
        const data = await request(url("/api/workspace/metadata", {}, selected));
        if (!current(token)) return false;
        metadata = { projects: data.projects || [], types: data.types || [], teams: data.teams || [] };
        metadataKey = key;
        if (!metadata.teams.some(item => item.id === team)) team = metadata.teams[0]?.id || "";
        renderScope();
        return true;
    }
    function loading(message) {
        const status = element("p", "workspace-empty", message);
        status.setAttribute("role", "status");
        content.replaceChildren(status);
        content.setAttribute("aria-busy", "true");
    }
    function failure(error) {
        const message = element("div", "workspace-empty is-error", errorText(error));
        message.setAttribute("role", "alert");
        message.append(button("Try again", () => void refresh()));
        content.replaceChildren(message);
    }
    async function show(nextView = "home") {
        if (!Object.hasOwn(VIEW_NAMES, nextView)) throw new Error(`Unknown workspace view: ${nextView}`);
        if (destroyed) return;
        const changed = view !== nextView;
        if (changed) resetBoardDrafts();
        view = nextView;
        heading.textContent = VIEW_NAMES[view];
        if (changed) onViewChange?.(view);
        return refresh();
    }
    async function refresh({ background = false } = {}) {
        if (destroyed) return;
        if (modal) return;
        if (view === "board" && [...pending].some(key => key.startsWith(`${keyFor()}:${team}:${boardId}:`))) { queuedBoardRefresh = true; return; }
        if (background && scopeBar.contains(doc.activeElement)) return;
        if (background && content.contains(doc.activeElement) && !doc.activeElement.closest(".workspace-filters")) return;
        if (background && content.querySelector(".workspace-customize[open]")) return;
        const token = ++epoch;
        if (!background) announce("");
        await ensurePreferences();
        if (!current(token)) return;
        if (!background) renderScope();
        if (!connection) {
            content.replaceChildren(element("p", "workspace-empty", "Choose an organization in Connections to start working."));
            return;
        }
        const preserveForm = view === "items" && Boolean(content.querySelector(".workspace-filters"));
        if (!background && !preserveForm) loading(`Loading ${VIEW_NAMES[view].toLowerCase()}...`);
        else content.setAttribute("aria-busy", "true");
        try {
            if (!await loadMetadata(token)) return;
            if (view === "items") {
                if (!background) renderItems(null, true, preserveForm);
                const data = await request(url("/api/workspace/items", { ...filters, cursor: cursors[page], pageSize: 50 }));
                if (!current(token)) return;
                result = data;
                renderItems(result, false, true);
            } else if (view === "home") {
                if (!project) {
                    content.replaceChildren(element("p", "workspace-empty", "Choose a project to see your personal work dashboard."));
                    return;
                }
                const data = await request(url("/api/workspace/dashboard"));
                if (!current(token)) return;
                dashboard = data;
                renderDashboard();
            } else {
                if (!project || !team) {
                    content.replaceChildren(element("p", "workspace-empty", !project ? "Choose a project to open its team boards." : "No teams are available for this project."));
                    return;
                }
                const available = await request(url("/api/workspace/boards", { team }));
                if (!current(token)) return;
                boards = available.boards || [];
                if (!boards.some(item => item.id === boardId)) boardId = boards[0]?.id || "";
                if (!background) renderScope();
                if (!boardId) {
                    content.replaceChildren(element("p", "workspace-empty", "No boards are available for this team."));
                    return;
                }
                const data = await request(url("/api/workspace/board", { team, boardId }));
                if (!current(token)) return;
                board = data;
                if (!background) {
                    moveChoices.clear();
                }
                renderBoard();
            }
            void saveWorkspace();
        } catch (error) {
            if (current(token)) {
                if (view === "items" && content.querySelector(".workspace-filters")) {
                    content.querySelector(".workspace-load-error")?.remove();
                    const notice = element("div", "workspace-load-error workspace-empty is-error", errorText(error));
                    notice.setAttribute("role", "alert");
                    notice.append(button("Try again", () => void refresh()));
                    content.append(notice);
                } else if (background) announce(`Refresh could not finish: ${errorText(error)}`, true);
                else failure(error);
            }
        } finally {
            if (current(token)) content.removeAttribute("aria-busy");
        }
    }
    function openItem(item, selected = scope()) {
        onOpenWorkItem?.(item, { ...selected, workItemProject: item.project || selected?.workItemProject || selected?.project || "" });
    }
    function itemButton(item, selected) {
        const node = button(item.title || `Work item ${item.id}`, () => openItem(item, selected), "workspace-item-link");
        node.setAttribute("aria-label", `Open ${item.type || "work item"} ${item.id}: ${item.title || "Untitled"}`);
        return node;
    }
    function stateBadge(item) {
        const badge = element("span", "workspace-state", item.state || "Unknown state");
        const definition = metadata.types.find(type => type.name === item.type)?.states?.find(state => (state.name || state) === item.state);
        const color = definition?.color || item.stateColor;
        if (/^#?[a-f0-9]{6}$/i.test(color || "")) badge.style.setProperty("--state-color", `#${color.replace(/^#/, "")}`);
        return badge;
    }
    function renderItems(data, busy = false, preserveForm = false) {
        const form = element("form", "workspace-filters");
        form.setAttribute("aria-label", "Filter work items");
        const search = input("Search work items", filters.query, "search");
        search.placeholder = "Search title or ID";
        const assignee = select("Assignee", [
            { value: "mine", label: "Assigned to me" }, { value: "all", label: "Anyone" }, { value: "unassigned", label: "Unassigned" }, { value: "identity", label: "Specific person" },
        ], ["all", "mine", "unassigned"].includes(filters.assignee) ? filters.assignee : "identity");
        const person = input("Assignee email or identity", assignee.value === "identity" ? filters.assignee : "");
        person.placeholder = "name@example.com";
        person.hidden = assignee.value !== "identity";
        assignee.addEventListener("change", () => { person.hidden = assignee.value !== "identity"; person.setCustomValidity(""); if (!person.hidden) person.focus(); });
        person.addEventListener("input", () => person.setCustomValidity(""));
        const types = metadata.types.map(type => ({ value: type.name, label: type.name }));
        const type = select("Work item type", [{ value: "", label: "All types" }, ...types], filters.type);
        const states = [...new Set(metadata.types.flatMap(type => type.states || []).map(state => state.name || state))];
        const state = select("State", [{ value: "", label: "All states, including completed" }, ...states.map(name => ({ value: name, label: name }))], filters.state);
        const tags = input("Tags", filters.tags);
        tags.placeholder = "Tags, separated by semicolons";
        const apply = button("Apply filters");
        apply.type = "submit";
        const reset = button("Clear", () => { filters = { query: "", assignee: "mine", state: "", type: "", tags: "" }; cursors = [""]; page = 0; content.replaceChildren(); void refresh(); });
        const personField = field("Person", person);
        personField.classList.add("workspace-person-filter");
        const filterActions = element("div", "workspace-filter-actions");
        filterActions.append(apply, reset);
        form.append(field("Search", search), field("Assignee", assignee), personField, field("Type", type), field("State", state), field("Tags", tags), filterActions);
        form.addEventListener("submit", event => {
            event.preventDefault();
            if (assignee.value === "identity" && !person.value.trim()) { person.focus(); person.setCustomValidity("Enter a person's email or identity."); person.reportValidity(); return; }
            person.setCustomValidity("");
            filters = { query: search.value.trim(), assignee: assignee.value === "identity" ? person.value.trim() : assignee.value, type: type.value, state: state.value, tags: tags.value.trim() };
            cursors = [""];
            page = 0;
            void refresh();
        });
        const existingForm = preserveForm && content.querySelector(".workspace-filters");
        const oldScroll = content.querySelector(".workspace-table-wrap")?.scrollLeft || 0;
        if (existingForm) {
            for (const node of [...content.children]) if (node !== existingForm) node.remove();
        } else content.replaceChildren(form);
        if (busy) {
            content.append(element("p", "workspace-empty", "Loading work items..."));
            return;
        }
        const items = data?.workItems || [];
        const summary = element("div", "workspace-results-header");
        summary.append(element("p", "workspace-result-count", `${items.length} work item${items.length === 1 ? "" : "s"} on page ${page + 1}`));
        const pager = element("div", "workspace-pager");
        const previous = button("Previous", () => { if (page > 0) { page -= 1; void refresh(); } });
        previous.disabled = page === 0;
        const next = button("Next", () => { if (data.nextCursor) { cursors = [...cursors.slice(0, page + 1), data.nextCursor]; page += 1; void refresh(); } });
        next.disabled = !data?.nextCursor;
        pager.append(previous, next);
        summary.append(pager);
        content.append(summary);
        if (!items.length) {
            content.append(element("p", "workspace-empty", filters.assignee === "mine"
                ? "No assigned work matches these filters. Choose Anyone to search other items, or create a work item."
                : "No work items match these filters. Change the filters or create a work item."));
            return;
        }
        const tableWrap = element("div", "workspace-table-wrap");
        const table = element("table", "workspace-table");
        const caption = element("caption", "workspace-visually-hidden", "Work items matching your filters");
        const head = element("thead");
        const headings = element("tr");
        for (const title of ["Work item", "State", "Assigned to", "Project", "Tags"]) {
            const cell = element("th", "", title); cell.scope = "col"; headings.append(cell);
        }
        head.append(headings);
        const body = element("tbody");
        const selected = scope();
        for (const item of items) {
            const row = element("tr");
            const title = element("td", "workspace-table-title");
            title.append(element("span", "workspace-item-id", `${item.type || "Work item"} #${item.id}`), itemButton(item, selected));
            const state = element("td"); state.append(stateBadge(item));
            row.append(title, state, element("td", "", identityText(item.assignedTo)), element("td", "", item.project || project), element("td", "workspace-tags", Array.isArray(item.tags) ? item.tags.join(", ") : item.tags || ""));
            body.append(row);
        }
        table.append(caption, head, body);
        tableWrap.append(table);
        content.append(tableWrap);
        tableWrap.scrollLeft = oldScroll;
    }
    function renderDashboard() {
        const controls = element("details", "workspace-customize");
        controls.append(element("summary", "", "Customize Home"));
        const choices = element("div", "workspace-dashboard-choices");
        for (const [key, title] of Object.entries(SECTIONS)) {
            const toggle = input(title, "", "checkbox");
            toggle.checked = dashboardSections.includes(key);
            toggle.addEventListener("change", () => {
                dashboardSections = Object.keys(SECTIONS).filter(name => name === key ? toggle.checked : dashboardSections.includes(name));
                void savePreferences({ dashboardSections });
                renderDashboardCards();
            });
            const label = element("label"); label.append(toggle, doc.createTextNode(title)); choices.append(label);
        }
        controls.append(choices);
        const cards = element("div", "workspace-dashboard");
        content.replaceChildren(controls, cards);
        renderDashboardCards();
    }
    function renderDashboardCards() {
        const cards = content.querySelector(".workspace-dashboard");
        if (!cards) return;
        cards.replaceChildren();
        if (!dashboardSections.length) cards.append(element("p", "workspace-empty", "Choose sections in Customize Home to make this space yours."));
        const selected = scope();
        for (const name of dashboardSections) {
            const data = dashboard?.[name] || { workItems: [], count: 0 };
            const section = element("section", `workspace-dashboard-section workspace-dashboard-${name}`);
            const header = element("header", "workspace-section-header");
            header.append(element("h2", "", SECTIONS[name]), element("span", "workspace-count", data.count ?? data.workItems?.length ?? 0));
            section.append(header);
            if (data.error) {
                const error = element("p", "workspace-section-error", typeof data.error === "string" ? data.error : data.error.message || "This section could not load.");
                error.setAttribute("role", "alert");
                section.append(error);
            }
            const list = element("ul", "workspace-dashboard-list");
            for (const item of data.workItems || []) {
                const li = element("li");
                const meta = element("div", "workspace-item-meta");
                meta.append(element("span", "workspace-item-id", `${item.type || "Work item"} #${item.id}`), stateBadge(item));
                li.append(meta, itemButton(item, selected));
                if (name === "unfinished" && Number.isFinite(Number(item.incompleteChildCount))) li.append(element("span", "workspace-child-count", `${item.incompleteChildCount} unfinished child item${Number(item.incompleteChildCount) === 1 ? "" : "s"}`));
                if (name === "unfinished" && Number(item.unknownChildCount) > 0) li.append(element("span", "workspace-child-count", `${item.unknownChildCount} child state${Number(item.unknownChildCount) === 1 ? " is" : "s are"} unavailable.`));
                list.append(li);
            }
            section.append(list);
            if (!data.workItems?.length && !data.error) section.append(element("p", "workspace-section-empty", "No work items in this section."));
            if (data.truncated) section.append(element("p", "workspace-sample-note", `Showing a sample${data.sampleLimit ? ` of up to ${data.sampleLimit} items` : ""}. Open Work items to search all work.`));
            cards.append(section);
        }
    }
    function lanes() {
        return (board?.columns || []).flatMap(column => column.isSplit
            ? [{ column, done: false, label: `${column.name} / In progress` }, { column, done: true, label: `${column.name} / Done` }]
            : [{ column, done: false, label: column.name }]);
    }
    const laneValue = lane => JSON.stringify([lane.column.id, lane.done]);
    function renderBoard() {
        const previous = content.querySelector(".workspace-board");
        const scrollLeft = previous?.scrollLeft || 0;
        const openMoves = new Set([...content.querySelectorAll(".workspace-card-actions[open]")].map(node => node.closest("[data-item-id]").dataset.itemId));
        const focus = content.contains(doc.activeElement) ? doc.activeElement.dataset.focusKey : null;
        const boardView = element("div", "workspace-board");
        boardView.setAttribute("aria-label", board?.name || "Team board");
        const boardLanes = lanes();
        const displayed = new Set();
        for (const lane of boardLanes) {
            const column = element("section", "workspace-board-column");
            column.dataset.columnId = lane.column.id;
            column.dataset.done = String(lane.done);
            column.setAttribute("aria-label", lane.label);
            const items = (board.workItems || []).filter(item => item.columnId === lane.column.id && (!lane.column.isSplit || Boolean(item.columnDone) === lane.done));
            const title = element("header", "workspace-column-heading");
            title.append(element("h2", "", lane.label), element("span", "workspace-count", items.length));
            column.append(title);
            for (const item of items) { displayed.add(item.id); column.append(boardCard(item, boardLanes)); }
            if (!items.length) column.append(element("p", "workspace-lane-empty", "Drop a work item here"));
            column.addEventListener("dragover", event => { if (draggedId !== null) { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = "move"; column.classList.add("is-drag-over"); } });
            column.addEventListener("dragleave", () => column.classList.remove("is-drag-over"));
            column.addEventListener("drop", event => {
                event.preventDefault();
                column.classList.remove("is-drag-over");
                const item = board.workItems.find(item => item.id === draggedId);
                draggedId = null;
                if (item) void mutateCard(item, { lane });
            });
            boardView.append(column);
        }
        const unplaced = (board?.workItems || []).filter(item => !displayed.has(item.id));
        if (unplaced.length) {
            const section = element("section", "workspace-board-column");
            section.append(element("h2", "workspace-column-heading", "Items outside current columns"));
            for (const item of unplaced) section.append(boardCard(item, boardLanes));
            boardView.append(section);
        }
        for (const node of boardView.querySelectorAll(".workspace-card-actions")) node.open = openMoves.has(node.closest("[data-item-id]").dataset.itemId);
        content.replaceChildren(element("p", "workspace-board-help", "Drag a card between columns, or choose Move"), boardView);
        if (board.scopeNote) content.append(element("p", "workspace-sample-note", board.scopeNote));
        if (board.truncated) content.append(element("p", "workspace-sample-note", `This board is a sample${board.sampleLimit ? ` of up to ${board.sampleLimit} items` : ""}. Open Work items to search all work.`));
        if (!boardLanes.length) content.append(element("p", "workspace-empty", "This board has no configured columns."));
        boardView.scrollLeft = scrollLeft;
        if (focus) {
            const target = [...content.querySelectorAll("[data-focus-key]")].find(node => node.dataset.focusKey === focus);
            const fallback = [...content.querySelectorAll("[data-focus-key]")].find(node => node.dataset.focusKey === `${focus.split(":")[0]}:open`);
            (target?.disabled ? fallback : target)?.focus({ preventScroll: true });
        }
    }
    function boardCard(item, boardLanes) {
        const card = element("article", "workspace-board-card");
        card.dataset.itemId = String(item.id);
        const busy = pending.has(`${keyFor()}:${team}:${boardId}:${item.id}`);
        const canMutate = Number.isInteger(Number(item.rev)) && Number(item.rev) > 0;
        card.draggable = !busy && canMutate;
        card.setAttribute("aria-busy", String(busy));
        card.addEventListener("dragstart", event => {
            if (busy || !canMutate) { event.preventDefault(); return; }
            draggedId = item.id;
            event.dataTransfer?.setData("text/plain", String(item.id));
            if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
        });
        card.addEventListener("dragend", () => { draggedId = null; for (const node of content.querySelectorAll(".is-drag-over")) node.classList.remove("is-drag-over"); });
        const link = itemButton(item, scope());
        link.dataset.focusKey = `${item.id}:open`;
        card.append(element("span", "workspace-item-id", `${item.type || "Work item"} #${item.id}`), link, stateBadge(item));
        const moveForm = element("form", "workspace-card-move");
        const selectedLane = boardLanes.find(lane => lane.column.id === item.columnId && (!lane.column.isSplit || lane.done === Boolean(item.columnDone)));
        const move = select(`Move ${item.id} to`, boardLanes.map(lane => ({ value: laneValue(lane), label: lane.label })), moveChoices.get(item.id) || (selectedLane && laneValue(selectedLane)));
        move.dataset.focusKey = `${item.id}:move-select`;
        move.disabled = busy || !canMutate || !boardLanes.length;
        move.addEventListener("change", () => moveChoices.set(item.id, move.value));
        const moveButton = button("Move"); moveButton.type = "submit"; moveButton.disabled = move.disabled; moveButton.dataset.focusKey = `${item.id}:move`;
        moveForm.append(field("Move to", move), moveButton);
        moveForm.addEventListener("submit", event => { event.preventDefault(); const lane = boardLanes.find(lane => laneValue(lane) === move.value); if (lane) void mutateCard(item, { lane }); });
        const actions = element("details", "workspace-card-actions");
        const summary = element("summary", "", "Move");
        summary.dataset.focusKey = `${item.id}:move-toggle`;
        summary.setAttribute("aria-label", `Move work item ${item.id}`);
        actions.append(summary, moveForm);
        card.append(actions);
        if (!canMutate) card.append(element("p", "workspace-section-error", "Refresh the board before changing this item."));
        return card;
    }
    async function mutateCard(item, { lane }) {
        const selected = scope();
        const selectedTeam = team;
        const selectedBoard = boardId;
        const data = board;
        const sameBoard = () => !destroyed && board === data && view === "board" && keyFor() === keyFor(selected) && team === selectedTeam && boardId === selectedBoard;
        const mutationKey = `${keyFor(selected)}:${selectedTeam}:${selectedBoard}:${item.id}`;
        if (destroyed || pending.has(mutationKey)) return;
        if (item.columnId === lane.column.id && Boolean(item.columnDone) === lane.done) return;
        const index = data.workItems.indexOf(item);
        if (index < 0) return;
        const originalFocus = content.contains(doc.activeElement) ? doc.activeElement.dataset.focusKey : null;
        pending.add(mutationKey);
        const optimistic = { ...item, columnId: lane.column.id, columnDone: lane.done };
        data.workItems[index] = optimistic;
        moveChoices.delete(item.id);
        renderBoard();
        const pendingFocus = doc.activeElement;
        try {
            const response = await request(url("/api/workspace/board/move", { team: selectedTeam, boardId: selectedBoard }, selected),
                json("PATCH", { id: item.id, rev: item.rev, columnId: lane.column.id, done: lane.done }));
            data.workItems[index] = { ...optimistic, ...response.workItem };
            if (!destroyed) {
                if (sameBoard()) {
                    announce(`${item.type || "Work item"} ${item.id} moved to ${lane.label}.`);
                }
                onChange?.();
            }
        } catch (error) {
            data.workItems[index] = item;
            if (sameBoard()) announce(`Move was not saved. ${errorText(error)}`, true);
        } finally {
            pending.delete(mutationKey);
            if (sameBoard()) {
                const restore = originalFocus && doc.activeElement === pendingFocus;
                renderBoard();
                if (restore) [...content.querySelectorAll("[data-focus-key]")].find(node => node.dataset.focusKey === originalFocus)?.focus({ preventScroll: true });
            }
            if (!destroyed && queuedBoardRefresh && !pending.size) { queuedBoardRefresh = false; void refresh({ background: true }); }
        }
    }
    async function openCreate({ connection: selectedConnection, parent = null } = {}) {
        if (destroyed) return;
        if (modal) { modal.title.focus(); return; }
        await ensurePreferences();
        if (destroyed) return;
        if (modal) { modal.title.focus(); return; }
        let selected = selectedConnection || scope();
        if (!selected) { announce("Choose an organization in Connections before creating a work item.", true); return; }
        let selectedProject = parent?.project || selected.workItemProject || selected.project || "";
        const restoreFocus = doc.activeElement;
        const dialog = element("dialog", "workspace-create-dialog");
        dialog.setAttribute("aria-labelledby", `${prefix}-create-title`);
        dialog.setAttribute("aria-modal", "true");
        const title = element("h2", "", parent ? `Add child to #${parent.id}` : "New work item");
        title.id = `${prefix}-create-title`;
        const form = element("form", "workspace-create-form");
        const error = element("div", "workspace-create-error"); error.setAttribute("role", "alert"); error.hidden = true;
        const scopeFields = element("div", "workspace-create-scope");
        const typeSelect = select("Work item type", [], ""); typeSelect.required = true;
        const titleInput = input("Title"); titleInput.required = true; titleInput.maxLength = 255;
        titleInput.addEventListener("input", () => titleInput.setCustomValidity(""));
        const description = element("textarea", "workspace-input"); description.rows = 5; description.setAttribute("aria-label", "Description");
        const assignee = input("Assigned to"); assignee.placeholder = parent ? "Inherit from parent" : "Email or identity; leave blank for unassigned";
        const area = input("Area path"); area.placeholder = parent ? "Inherit from parent" : "Project default";
        const iteration = input("Iteration path"); iteration.placeholder = parent ? "Inherit from parent" : "Project default";
        const advanced = element("details", "workspace-create-details"); advanced.append(element("summary", "", "Assignment and planning"), field("Assigned to", assignee), field("Area path", area), field("Iteration path", iteration));
        const actions = element("div", "workspace-create-actions");
        const cancel = button("Cancel", () => closeCreate());
        const save = button("Create work item", null, "workspace-button workspace-primary"); save.type = "submit"; save.disabled = true;
        actions.append(cancel, save);
        form.append(scopeFields);
        if (parent) form.append(element("p", "workspace-parent-context", `${parent.type || "Work item"} #${parent.id}: ${parent.title || ""}. The child inherits its parent's assignment, area, and iteration unless you enter another value.`));
        form.append(field("Type", typeSelect), field("Title", titleInput), field("Description", description), advanced, error, actions);
        dialog.append(title, form);
        doc.body.append(dialog);
        const state = { dialog, title: titleInput, busy: false, restoreFocus, metadataEpoch: 0 };
        modal = state;
        function closeCreate() {
            if (state.busy) return;
            state.metadataEpoch += 1;
            dialog.remove();
            if (modal === state) modal = null;
            if (restoreFocus?.isConnected) restoreFocus.focus({ preventScroll: true });
        }
        dialog.addEventListener("cancel", event => { event.preventDefault(); closeCreate(); });
        dialog.addEventListener("keydown", event => {
            if (event.key === "Escape") { event.preventDefault(); closeCreate(); }
            if (event.key !== "Tab") return;
            const nodes = [...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary')].filter(node => !node.hidden && !node.closest("details:not([open])") || node.tagName === "SUMMARY");
            const first = nodes[0]; const last = nodes.at(-1);
            if (event.shiftKey && doc.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first?.focus(); }
        });
        try { if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", ""); } catch { dialog.setAttribute("open", ""); }
        async function loadCreateMetadata() {
            const token = ++state.metadataEpoch;
            save.disabled = true;
            typeSelect.disabled = true;
            error.hidden = true;
            const context = { ...selected, workItemProject: selectedProject };
            try {
                const data = await request(url("/api/workspace/metadata", {}, context));
                if (destroyed || modal !== state || token !== state.metadataEpoch) return;
                scopeFields.replaceChildren();
                const connectionSelect = select("Creation organization", connections.map((item, index) => ({ value: index, label: [item.organization, item.project].filter(Boolean).join(" / ") })), connections.findIndex(item => item.organization === selected.organization && (item.project || "") === (selected.project || "")));
                connectionSelect.disabled = Boolean(parent);
                connectionSelect.addEventListener("change", () => { selected = connections[Number(connectionSelect.value)]; selectedProject = selected.workItemProject || selected.project || ""; void loadCreateMetadata(); });
                const projectOptions = (selected.project ? [{ name: selected.project }] : data.projects || []).map(item => ({ value: item.name || item.id, label: item.name || item.id }));
                if (selectedProject && !projectOptions.some(item => item.value === selectedProject)) projectOptions.unshift({ value: selectedProject, label: selectedProject });
                const projectSelect = select("Creation project", [...(selected.project ? [] : [{ value: "", label: "Choose a project" }]), ...projectOptions], selectedProject);
                projectSelect.required = true;
                projectSelect.disabled = Boolean(parent);
                projectSelect.addEventListener("change", () => { selectedProject = projectSelect.value; void loadCreateMetadata(); });
                scopeFields.append(field("Organization", connectionSelect), field("Project", projectSelect));
                const previousType = typeSelect.value;
                typeSelect.replaceChildren();
                for (const type of data.types || []) { const option = element("option", "", type.name); option.value = type.name; typeSelect.append(option); }
                typeSelect.value = (data.types || []).some(type => type.name === previousType) ? previousType : parent && (data.types || []).some(type => type.name === "Task") ? "Task" : data.types?.[0]?.name || "";
                typeSelect.disabled = !selectedProject || !data.types?.length;
                save.disabled = typeSelect.disabled;
                if (selectedProject && !data.types?.length) { error.textContent = "No work item types are available in this project."; error.hidden = false; }
            } catch (failure) {
                if (destroyed || modal !== state || token !== state.metadataEpoch) return;
                error.replaceChildren(element("span", "", `Work item types could not load: ${errorText(failure)}`), button("Retry loading types", () => void loadCreateMetadata()));
                error.hidden = false;
            }
        }
        form.addEventListener("submit", async event => {
            event.preventDefault();
            if (state.busy || save.disabled || !selectedProject || !typeSelect.value) return;
            if (!titleInput.value.trim()) { titleInput.setCustomValidity("Enter a title."); titleInput.reportValidity(); titleInput.focus(); return; }
            const submittedConnection = { ...selected, workItemProject: selectedProject };
            const body = { type: typeSelect.value, title: titleInput.value.trim(), description: description.value ? `<p>${htmlText(description.value).replace(/\r?\n/g, "<br>")}</p>` : "" };
            if (parent) body.parentId = parent.id;
            for (const [key, control] of [["assignedTo", assignee], ["area", area], ["iteration", iteration]]) if (control.value.trim()) body[key] = control.value.trim();
            state.busy = true;
            error.hidden = true;
            for (const control of form.querySelectorAll("input, textarea, select, button")) control.disabled = true;
            save.textContent = "Creating...";
            try {
                const response = await request(url("/api/workspace/items", {}, submittedConnection), json("POST", body));
                if (destroyed || modal !== state) return;
                state.busy = false;
                closeCreate();
                announce(`${response.workItem.type || body.type} ${response.workItem.id} created.`);
                onCreated?.(response.workItem, submittedConnection, parent);
            } catch (failure) {
                if (destroyed || modal !== state) return;
                state.busy = false;
                for (const control of form.querySelectorAll("input, textarea, select, button")) control.disabled = false;
                if (parent) for (const control of scopeFields.querySelectorAll("select")) control.disabled = true;
                save.textContent = "Create work item";
                error.textContent = `Work item was not created: ${errorText(failure)}`;
                error.hidden = false;
                titleInput.focus();
            }
        });
        titleInput.focus();
        await loadCreateMetadata();
    }
    function destroy() {
        destroyed = true;
        epoch += 1;
        modal?.dialog.remove();
        modal = null;
        root.remove();
    }
    return { show, openCreate, refresh, destroy };
}
