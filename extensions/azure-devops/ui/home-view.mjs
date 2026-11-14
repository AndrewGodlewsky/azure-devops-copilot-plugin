const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const OCTICONS = {
    "device-desktop": {
        viewBox: "0 0 16 16",
        paths: ["M14.25 1c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 14.25 12h-3.727c.099 1.041.52 1.872 1.292 2.757A.75.75 0 0 1 11.25 16h-6.5a.75.75 0 0 1-.565-1.243c.772-.885 1.192-1.716 1.292-2.757H1.75A1.75 1.75 0 0 1 0 10.25v-7.5C0 1.784.784 1 1.75 1Zm-.25 1.5H1.75a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"],
    },
    project: {
        viewBox: "0 0 16 16",
        paths: ["M1.75 0h12.5C15.216 0 16 .784 16 1.75v12.5A1.75 1.75 0 0 1 14.25 16H1.75A1.75 1.75 0 0 1 0 14.25V1.75C0 .784.784 0 1.75 0ZM1.5 1.75v12.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25V1.75a.25.25 0 0 0-.25-.25H1.75a.25.25 0 0 0-.25.25ZM11.75 3a.75.75 0 0 1 .75.75v7.5a.75.75 0 0 1-1.5 0v-7.5a.75.75 0 0 1 .75-.75Zm-8.25.75a.75.75 0 0 1 1.5 0v5.5a.75.75 0 0 1-1.5 0ZM8 3a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 8 3Z"],
    },
};

function element(tagName, className, text) {
    const node = document.createElement(tagName);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
}

function octicon(name, size = 16) {
    const definition = OCTICONS[name];
    const svg = document.createElementNS(SVG_NAMESPACE, "svg");
    svg.setAttribute("data-icon-source", "octicon");
    svg.setAttribute("data-icon-name", name);
    svg.setAttribute("viewBox", definition.viewBox);
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.setAttribute("fill", "currentColor");
    svg.setAttribute("aria-hidden", "true");
    for (const pathData of definition.paths) {
        const path = document.createElementNS(SVG_NAMESPACE, "path");
        path.setAttribute("d", pathData);
        svg.append(path);
    }
    return svg;
}

function relativeTime(value) {
    const elapsed = Date.now() - Date.parse(value);
    if (!Number.isFinite(elapsed) || elapsed < 0) return "";
    const minutes = Math.floor(elapsed / 60000);
    if (minutes < 60) return `${minutes}m ago`;
    if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
    return `${Math.floor(minutes / 1440)}d ago`;
}

function section(title, scope) {
    const card = element("section", "home-section");
    const header = element("div", "home-section-header");
    header.append(element("h3", "home-section-title", title));
    if (scope) {
        header.append(element("span", "home-section-scope", `in ${scope}`));
    }
    card.append(header);
    return card;
}

function group(title, className = "") {
    const wrapper = element("section", `home-group ${className}`.trim());
    wrapper.append(element("h2", "home-group-title", title));
    const cards = element("div", "home-card-grid");
    wrapper.append(cards);
    return { wrapper, cards };
}

function statusCard(message, error = "") {
    const card = element("div", error ? "home-section-error" : "status", message);
    if (error) card.setAttribute("role", "alert");
    return card;
}

function actionRow(...actions) {
    const row = element("div", "home-section-actions");
    row.append(...actions);
    return row;
}

function makeRowInteractive(row, { href, label, onClick } = {}) {
    if (!href && !onClick) return row;
    const activate = () => {
        if (onClick) {
            onClick();
        } else {
            window.open(href, "_blank", "noopener,noreferrer");
        }
    };
    const hitbox = element(onClick ? "button" : "a", "home-row-hitbox");
    if (onClick) {
        hitbox.type = "button";
        hitbox.addEventListener("click", onClick);
    } else {
        Object.assign(hitbox, { href, target: "_blank", rel: "noopener noreferrer" });
    }
    if (label) hitbox.setAttribute("aria-label", label);
    row.classList.add("home-row-interactive");
    row.append(hitbox);
    row.addEventListener("click", (event) => {
        if (event.target?.closest?.("button, a")) return;
        activate();
    });
    return row;
}

// Azure DevOps titles are plain text and display literally, so they are not
// rendered as Markdown; only bodies, comments, and system messages are.
function rowLabel(prefix, title, leadingIcon = null) {
    const node = element("span", "home-row-label");
    if (leadingIcon) {
        node.classList.add("has-leading-icon");
        const icon = element("span", "home-row-leading");
        icon.append(leadingIcon);
        node.append(icon);
    }
    node.append(element("span", "home-row-id", prefix), element("span", "home-row-title", title));
    return node;
}

function delegateWorkItemAction(item, onDelegateWorkItem) {
    const action = element("div", "home-row-delegation");
    const button = element("button", "primer-button secondary home-row-delegate");
    button.type = "button";
    button.setAttribute("aria-label", `Delegate work item ${item.id}`);
    button.title = "Delegate to a local session";
    button.append(octicon("device-desktop", 14));
    const status = element("span", "home-row-action-status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    button.addEventListener("click", async () => {
        button.disabled = true;
        button.classList.remove("is-complete", "is-error");
        button.setAttribute("aria-label", `Delegate work item ${item.id}`);
        button.title = "Delegate to a local session";
        status.setAttribute("role", "status");
        status.setAttribute("aria-live", "polite");
        status.textContent = "";
        try {
            const result = await onDelegateWorkItem(item);
            if (result?.cancelled) {
                button.disabled = false;
                return;
            }
            if (result && !result.ok) {
                throw new Error(result.error || "Could not delegate work item.");
            }
            button.classList.add("is-complete");
            button.disabled = false;
            button.setAttribute("aria-label", `Delegation requested for work item ${item.id}`);
            button.title = "Delegation requested";
            status.textContent = "Delegation requested";
        } catch (error) {
            const message = error?.message || "Could not delegate work item.";
            button.disabled = false;
            button.classList.add("is-error");
            button.setAttribute("aria-label", `Delegate work item ${item.id}. ${message}`);
            button.title = message;
            status.setAttribute("role", "alert");
            status.setAttribute("aria-live", "assertive");
            status.textContent = message;
        }
    });
    action.append(button, status);
    return action;
}

function workItemRow(item, onOpenWorkItem, onDelegateWorkItem) {
    const row = makeRowInteractive(element("article", "home-row home-work-item-row"), {
        href: onOpenWorkItem ? "" : item.webUrl,
        label: `Open ${item.type || "work item"} ${item.id}: ${item.title}`,
        onClick: onOpenWorkItem ? () => onOpenWorkItem(item) : null,
    });
    // Project is shown only when the section spans more than one, which is what
    // an organization-scope connection produces.
    const meta = [item.type, item.state, item.project, item.assignedTo, relativeTime(item.changedDate)]
        .filter(Boolean).join(" · ");
    let typeIcon = null;
    if (item.typeIcon) {
        typeIcon = element("img", "home-work-item-type-icon");
        typeIcon.src = item.typeIcon;
        typeIcon.alt = "";
        typeIcon.setAttribute("data-icon-source", "azure-devops");
        typeIcon.setAttribute("data-icon-name", item.type || "work-item");
    }
    const content = element("div", "home-row-content");
    content.append(
        rowLabel(item.id, item.title, typeIcon),
        element("div", "home-row-meta", meta),
    );
    row.append(content);
    if (onDelegateWorkItem) {
        const side = element("div", "home-row-side");
        side.append(delegateWorkItemAction(item, onDelegateWorkItem));
        row.append(side);
    }
    return row;
}

function boardRow(board, onOpenBoard) {
    const row = makeRowInteractive(element("article", "home-row"), {
        href: onOpenBoard ? "" : board.url,
        label: `Open board ${board.name}`,
        onClick: onOpenBoard ? () => onOpenBoard(board) : null,
    });
    const label = rowLabel("", board.name, octicon("project"));
    label.querySelector(".home-row-leading")?.classList.add("home-row-icon");
    row.append(label);
    return row;
}

function connectionHeading(connection, { showHeading }) {
    if (!showHeading) {
        return null;
    }
    const heading = element("div", "home-connection-heading");
    heading.append(element(
        "span",
        "home-connection-name",
        [connection.organization, connection.project].filter(Boolean).join(" / "),
    ));
    if (connection.isDefault) {
        heading.append(element("span", "connection-pill", "default"));
    }
    return heading;
}

function connectionSections(connection, {
    onOpenBoard,
    onDelegateWorkItem,
    onOpenWorkItem,
    onChooseProject,
    showHeading,
}) {
    const wrapper = element("div", "home-connection");
    const heading = connectionHeading(connection, { showHeading });
    if (heading) {
        wrapper.append(heading);
    }

    const myBoards = connection.myBoards || {};
    const boardScope = myBoards.scope || connection.project || "";
    const boards = section("My boards", boardScope);
    if (connection.requiresProject) {
        boards.append(statusCard("Choose a project to see your favorite boards."));
        if (onChooseProject) {
            const choose = element("button", "secondary", "Choose a project");
            choose.type = "button";
            choose.addEventListener("click", () => onChooseProject(connection));
            boards.append(actionRow(choose));
        }
    } else if (myBoards.error) {
        boards.append(statusCard(myBoards.error, true));
    } else if (!(myBoards.boards || []).length) {
        const otherProjectBoardCount = Number(myBoards.otherProjectBoardCount || 0);
        const otherProjects = otherProjectBoardCount
            ? ` ${otherProjectBoardCount} favorite ${otherProjectBoardCount === 1 ? "board is" : "boards are"} in other projects.`
            : "";
        boards.append(statusCard(`No favorite boards in ${boardScope || "this project"}.${otherProjects}`));
        if (otherProjectBoardCount && onChooseProject) {
            const choose = element("button", "secondary", "Choose another project");
            choose.type = "button";
            choose.addEventListener("click", () => onChooseProject(connection));
            boards.append(actionRow(choose));
        }
    } else {
        for (const board of myBoards.boards) {
            boards.append(boardRow(
                board,
                onOpenBoard ? (selected) => onOpenBoard(selected, connection) : null,
            ));
        }
    }

    const myWorkItems = connection.myWorkItems || {};
    const workItemScope = myWorkItems.scope || connection.project || connection.organization || "";
    const workItems = section("Open work items", workItemScope);
    if (myWorkItems.error) {
        workItems.append(statusCard(myWorkItems.error, true));
    } else if (!(myWorkItems.workItems || []).length) {
        workItems.append(statusCard(`No open work items assigned to you in ${workItemScope || "this project"}.`));
    } else {
        for (const item of myWorkItems.workItems) {
            workItems.append(workItemRow(
                item,
                (workItem) => onOpenWorkItem(workItem, connection),
                onDelegateWorkItem ? (workItem) => onDelegateWorkItem(workItem, connection) : null,
            ));
        }
    }

    wrapper.append(...(onOpenBoard ? [boards] : []), workItems);
    return wrapper;
}

function renderActiveWork(container, data, options) {
    const active = group("My active work", "home-active-work");
    const connections = data.connections || [];
    const showHeading = connections.length > 1;
    for (const connection of connections) {
        active.cards.append(connectionSections(connection, { ...options, showHeading }));
    }
    container.append(active.wrapper);
}

export function renderHome(container, data, options) {
    container.replaceChildren();
    renderActiveWork(container, data, options);
}
