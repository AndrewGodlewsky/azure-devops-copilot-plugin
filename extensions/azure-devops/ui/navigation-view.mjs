function entryKey(entry) {
    return JSON.stringify([entry.view, String(entry.organization || "").toLowerCase(),
        String(entry.workItemProject || entry.project || "").toLowerCase(), String(entry.id)]);
}

const icons = {
    home: "M2 7 8 2l6 5v7H9v-4H7v4H2Z",
    task: "M5 3H3v11h10V3h-2M6 2h4v3H6ZM5 9l2 2 4-4",
    story: "M8 4C6 2 3 2 1 3v10c2-1 5-1 7 1 2-2 5-2 7-1V3c-2-1-5-1-7 1Zm0 0v10",
    bug: "M5 7h6v4a3 3 0 0 1-6 0Zm1-3h4v3H6ZM3 8h2m6 0h2M3 11h2m6 0h2M4 14l2-2m4 0 2 2",
    board: "M2 2h12v12H2Zm4 0v12m4-12v12",
    close: "m4 4 8 8M12 4l-8 8",
};

export function renderNavigation(container, options) {
    const { tabs, activeTabId, collapsed, sameEntry, tabTitle,
        onActivate, onOpenChild, onClose, revealActive = false } = options;
    const doc = container.ownerDocument;
    const focusedKey = container.contains(doc.activeElement) ? doc.activeElement.dataset.focusKey : null;
    const scrollTop = container.scrollTop;
    const element = (tag, className, text) => {
        const node = doc.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };
    const icon = (name) => {
        const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 16 16");
        svg.setAttribute("aria-hidden", "true");
        svg.setAttribute("fill", "none");
        svg.setAttribute("stroke", "currentColor");
        svg.setAttribute("stroke-width", "1.5");
        if (name === "close") {
            svg.setAttribute("data-icon-source", "octicon");
            svg.setAttribute("data-icon-name", "x");
        }
        const path = doc.createElementNS(svg.namespaceURI, "path");
        path.setAttribute("d", icons[name] || icons.story);
        svg.append(path);
        return svg;
    };
    const nodes = tabs.map(tab => ({ tab, entry: tab.entry, children: [] }));
    const parents = new Map();
    for (const node of nodes) {
        if (node.entry.view !== "work-item") continue;
        const links = node.tab.data?.relations?.find(group => group.name === "Children")?.links || [];
        const seen = new Set([entryKey(node.entry)]);
        for (const link of links) {
            if (!Number.isInteger(Number(link.id)) || Number(link.id) <= 0 || (link.kind && link.kind !== "work-item")) continue;
            const entry = { ...node.entry, view: "work-item", id: Number(link.id), current: false,
                workItemProject: link.project || node.tab.data?.project || node.entry.workItemProject || node.entry.project || "" };
            const key = entryKey(entry);
            if (seen.has(key)) continue;
            seen.add(key);
            const open = nodes.find(candidate => sameEntry(candidate.entry, entry));
            if (open) {
                if (open === node || parents.has(open.tab.id)) continue;
                parents.set(open.tab.id, node.tab.id);
                node.children.push(open);
            } else {
                node.children.push({ entry, link, parentEntry: node.entry, children: [] });
            }
        }
    }
    // Revealing an item from its details also reveals its ancestors in the list.
    if (revealActive) {
        const visited = new Set();
        let id = parents.get(activeTabId);
        while (id && !visited.has(id)) {
            visited.add(id);
            collapsed.delete(id);
            id = parents.get(id);
        }
    }
    for (const id of collapsed) {
        if (!tabs.some(tab => tab.id === id)) collapsed.delete(id);
    }
    const rendered = new Set();
    const renderNode = (node) => {
        const { tab, entry, link } = node;
        if (tab && rendered.has(tab.id)) return null;
        if (tab) rendered.add(tab.id);
        const key = entryKey(entry);
        const shortTitle = tab ? tabTitle(tab) : link.label || `${link.kindLabel || "Work item"} ${entry.id}`;
        const title = tab?.data?.title || link?.title || shortTitle;
        const state = tab?.data?.state || link?.state || "";
        const active = tab?.id === activeTabId && (entry.view !== "home" || !options.workspace || options.workspace.view === "home");
        const li = element("li", "navigation-item");
        const row = element("div", `view-tab${active ? " active" : ""}`);
        if (tab) row.dataset.tabId = tab.id;
        row.dataset.entryKey = key;
        const children = element("ul", "navigation-children");
        children.id = `${tab?.id || "child"}-children`;
        for (const child of node.children) {
            const renderedChild = renderNode(child);
            if (renderedChild) children.append(renderedChild);
        }
        if (children.childElementCount) {
            const toggle = element("button", "navigation-disclosure", "›");
            toggle.type = "button";
            toggle.dataset.focusKey = `${key}:toggle`;
            children.hidden = collapsed.has(tab.id);
            toggle.setAttribute("aria-expanded", String(!children.hidden));
            toggle.setAttribute("aria-controls", children.id);
            toggle.setAttribute("aria-label", `${children.hidden ? "Expand" : "Collapse"} children of ${shortTitle}`);
            toggle.addEventListener("click", () => {
                if (collapsed.has(tab.id)) collapsed.delete(tab.id);
                else collapsed.add(tab.id);
                renderNavigation(container, { ...options, revealActive: false });
            });
            row.append(toggle);
        } else {
            row.append(element("span", "navigation-disclosure-space"));
        }
        const label = element("button", "view-tab-label");
        label.type = "button";
        label.dataset.focusKey = `${key}:open`;
        label.title = `${shortTitle}: ${title}`;
        label.setAttribute("aria-label", [title === shortTitle ? shortTitle : `${shortTitle}: ${title}`, state].filter(Boolean).join(", "));
        if (active) label.setAttribute("aria-current", "page");
        if (tab) {
            label.id = `${tab.id}-tab`;
            label.setAttribute("aria-controls", tab.panel.id);
            tab.panel.setAttribute("aria-labelledby", label.id);
        }
        label.addEventListener("click", () => tab ? onActivate(tab.id) : onOpenChild({ ...link, project: entry.workItemProject }, node.parentEntry));
        const type = String(tab?.data?.type || link?.kindLabel || "").toLowerCase();
        const iconName = entry.view === "work-item" ? (type === "task" ? "task" : type === "bug" ? "bug" : "story") : entry.view;
        const leading = element("span", `navigation-icon navigation-icon-${iconName}`);
        leading.append(icon(iconName));
        const copy = element("span", "navigation-copy");
        copy.append(element("span", "navigation-title", title));
        if (entry.view !== "home") copy.append(element("span", "navigation-meta", [shortTitle, state].filter(Boolean).join(" · ")));
        label.append(leading, copy);
        row.append(label);
        if (tab?.closable) {
            const close = element("button", "view-tab-close");
            close.type = "button";
            close.dataset.focusKey = `${key}:close`;
            close.setAttribute("aria-label", `Close ${shortTitle}`);
            close.title = `Close ${shortTitle}`;
            close.append(icon("close"));
            close.addEventListener("click", () => onClose(tab.id));
            row.append(close);
        }
        li.append(row);
        if (children.childElementCount) li.append(children);
        return li;
    };
    container.replaceChildren();
    for (const [name, views] of [["", ["home"]], ["Open work", ["work-item"]], ["Boards", ["board"]]]) {
        const items = nodes.filter(node => views.includes(node.entry.view));
        if (!items.length) continue;
        const group = element("div", "navigation-group");
        if (name) group.append(element("h2", "navigation-heading", name));
        const list = element("ul", "navigation-list");
        for (const node of items.filter(node => !parents.has(node.tab.id))) {
            const li = renderNode(node);
            if (li) list.append(li);
        }
        // Malformed cyclic relations must not make every node unreachable.
        for (const node of items.filter(node => !rendered.has(node.tab.id))) {
            const li = renderNode(node);
            if (li) list.append(li);
        }
        group.append(list);
        if (!name && options.workspace) {
            for (const [view, label] of [["items", "Work items"], ["board", "Board"]]) {
                const button = element("button", "workspace-nav-button");
                const leading = element("span", "navigation-icon");
                leading.append(icon(view === "items" ? "task" : "board"));
                button.append(leading, element("span", "", label));
                button.type = "button";
                button.dataset.workspaceView = view;
                if (options.workspace.view === view) button.setAttribute("aria-current", "page");
                button.addEventListener("click", () => options.workspace.onShow(view));
                group.append(button);
            }
            const create = element("button", "workspace-create-button", "+ New work item");
            create.type = "button";
            create.addEventListener("click", options.workspace.onCreate);
            group.append(create);
        }
        container.append(group);
    }
    container.hidden = tabs.length === 0;
    container.scrollTop = scrollTop;
    if (focusedKey) {
        const buttons = [...container.querySelectorAll("button")];
        const focus = buttons.find(button => button.dataset.focusKey === focusedKey) ||
            container.querySelector('[aria-current="page"]');
        focus?.focus({ preventScroll: true });
    }
}
