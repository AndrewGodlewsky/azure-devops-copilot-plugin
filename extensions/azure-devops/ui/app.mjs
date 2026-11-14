import { renderWorkItem } from "./work-item-view.mjs";
import { renderHome } from "./home-view.mjs";
import { renderNavigation } from "./navigation-view.mjs";
import { renderConnectionPanel } from "./connection-view.mjs";
import { createWorkspaceView } from "./workspace-view.mjs";
import { createDraftWriter, hasDraft, fieldValues, fieldsAfterSave } from "./draft-session.mjs";
import { AGENCY_AUTH_ENABLED, normalizeFeatureFlags, canSuggestTasks } from "../common.mjs";
import { createTaskSuggestionPanel } from "./task-suggestions-view.mjs";

const startupSplash = document.getElementById("startupSplash");
const startupTitle = document.getElementById("startupTitle");
const startupDetail = document.getElementById("startupDetail");
const signInSplash = document.getElementById("signInSplash");
const canvasContent = document.getElementById("canvasContent");
const homePanel = document.getElementById("homePanel");
const homeContent = document.getElementById("homeContent");
const tabPanels = document.getElementById("tabPanels");
const viewTabs = document.getElementById("viewTabs");
const viewBar = document.querySelector(".view-bar");
const navigationToggle = document.getElementById("navigationToggle");
const collapsedNavigationItems = new Set();
let navigationCollapsed = window.matchMedia?.("(max-width: 760px)").matches || false;
const authOutput = document.getElementById("authOutput");
const logsPanel = document.getElementById("logsPanel");
const connectionPanel = document.getElementById("connectionPanel");
const workItemDrawerScrim = document.getElementById("workItemDrawerScrim");
const workItemDrawer = document.getElementById("workItemDrawer");
const workItemDrawerContent = document.getElementById("workItemDrawerContent");
const workItemDrawerClose = document.getElementById("workItemDrawerClose");
const workItemDrawerExpand = document.getElementById("workItemDrawerExpand");
const connectionsButton = document.getElementById("connectionsButton");
const refreshButton = document.getElementById("refreshButton");
const signInMicrosoftButton = document.getElementById("signInMicrosoftButton");
const signInAgencyButton = document.getElementById("signInAgencyButton");
const signOutButton = document.getElementById("signOutButton");
const showLogsButton = document.getElementById("showLogsButton");
const copyLogsButton = document.getElementById("copyLogsButton");
const logsList = document.getElementById("logsList");
const copyLogsStatus = document.getElementById("copyLogsStatus");
const boardsFeatureFlag = document.getElementById("boardsFeatureFlag");
const delegationFeatureFlag = document.getElementById("delegationFeatureFlag");
const versionLabel = document.getElementById("versionLabel");

let apiNonce = "";
let currentConfig;
let homeLoaded = false;
let logs = [];
let enabledFeatures = normalizeFeatureFlags();
let workspaceController, workspaceConnections = "", workspaceMode = "home";
let restoringWorkspace = true, preferencesTimer, preferencesWrite = Promise.resolve();
let backgroundRefreshPending = false;

// Each sidebar item keeps an independent detail view and can be closed
// independently. A tab is { id, entry, panel, content, data, rendered, token,
// scrollTop, closable, editMode, dirty }, where entry is the
// { view, id } it shows, editMode is whether the whole detail view is being
// edited, and dirty tracks whether anything in it has unsaved changes.
let tabs = [];
let activeTabId = "";
let tabSequence = 0;
let boardWorkItemDrawerState = null;
let boardDelegationSequence = 0;
const pendingBoardDelegations = new Map();
let workItemDrawerBackgroundState = null;

const focusableSelector = [
    "a[href]",
    "button:not([disabled])",
    "input:not([disabled])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    '[tabindex]:not([tabindex="-1"])',
].join(",");


function addLog(level, message, details = "") {
    logs.unshift({ time: new Date().toLocaleTimeString(), level, message, details });
    logs = logs.slice(0, 100);
    renderLogs();
}

function renderLogs() {
    logsList.replaceChildren();
    if (!logs.length) {
        logsList.append(element("div", "status", "No logs yet."));
        return;
    }
    for (const entry of logs) {
        const item = element("div", "log-entry");
        item.append(element("span", "status", `[${entry.time}] `), document.createTextNode(`${entry.level.toUpperCase()} ${entry.message}`));
        if (entry.details) item.append(document.createElement("br"), element("span", "status", entry.details));
        logsList.append(item);
    }
}

function element(tagName, className, text) {
    const node = document.createElement(tagName);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
}

function loadingSpinner(compact = false) {
    const host = element("span", `loading-spinner ${compact ? "loading-spinner-compact" : "loading-spinner-large"}`);
    host.setAttribute("aria-hidden", "true");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("loading-spinner-svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    for (const className of ["loading-spinner-track", "loading-spinner-arc"]) {
        const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        circle.classList.add(className);
        circle.setAttribute("cx", "12");
        circle.setAttribute("cy", "12");
        circle.setAttribute("r", "9");
        svg.append(circle);
    }
    host.append(svg);
    return host;
}

function createLoadingState(title, detail = "", { compact = false, className = "" } = {}) {
    const state = element(
        "div",
        ["loading-state", compact ? "loading-state-compact" : "", className].filter(Boolean).join(" "),
    );
    state.setAttribute("role", "status");
    state.setAttribute("aria-live", "polite");
    state.setAttribute("aria-busy", "true");
    const copy = element("span", "loading-copy");
    copy.append(element("strong", "loading-title", title));
    if (detail) {
        copy.append(element("span", "loading-detail", detail));
    }
    state.append(loadingSpinner(compact), copy);
    return state;
}

function showLoading(container, title, detail = "", options = {}) {
    container.replaceChildren(createLoadingState(title, detail, options));
}

function showStartupLoading(title, detail = "") {
    startupTitle.textContent = title;
    startupDetail.textContent = detail;
    startupDetail.hidden = !detail;
    startupSplash.hidden = false;
    startupSplash.setAttribute("aria-busy", "true");
    signInSplash.hidden = true;
    canvasContent.hidden = true;
}

async function request(path, options = {}, includeNonce = true) {
    const headers = new Headers(options.headers || {});
    if (includeNonce && apiNonce) headers.set("X-Canvas-Nonce", apiNonce);
    const response = await fetch(path, { ...options, headers });
    let data;
    try {
        data = await response.json();
    } catch {
        throw new Error("The canvas received an invalid response.");
    }
    if (!response.ok) {
        // A newer sign-in may have replaced the rejected token while this request
        // was in flight. Only show the chooser if the server is still signed out.
        if (data.error === "azure_devops_authentication_rejected") {
            const status = await request("/api/auth/status");
            if (currentConfig) {
                currentConfig.auth = status.auth || currentConfig.auth;
            }
            if (status.auth?.isAuthenticated === false) {
                showSignInSplash();
            }
        }
        const error = new Error(data.message || data.error || "Request failed.");
        error.code = data.error;
        error.status = response.status;
        throw error;
    }
    return data;
}

function showStatus(container, message, retry) {
    container.replaceChildren(element("div", "status", message));
    if (retry) {
        const button = element("button", "secondary retry-button", "Retry");
        button.addEventListener("click", retry);
        container.append(button);
    }
}

function skeletonLine(className = "") {
    return element("span", ["loading-skeleton-line", className].filter(Boolean).join(" "));
}

function skeletonCard(lineClasses = []) {
    const card = element("div", "loading-skeleton-card");
    lineClasses.forEach((className) => card.append(skeletonLine(className)));
    return card;
}

function showWorkItemLoading(container, id) {
    const shell = element("div", "work-item-skeleton");
    shell.setAttribute("aria-busy", "true");
    shell.append(createLoadingState(id ? `Loading work item ${id}` : "Loading work item", "", {
        compact: true,
    }));
    const visual = element("div", "work-item-skeleton-visual");
    visual.setAttribute("aria-hidden", "true");
    const header = element("div", "work-item-skeleton-header");
    header.append(
        skeletonLine("work-item-skeleton-title"),
        skeletonLine("work-item-skeleton-meta"),
    );
    const facts = element("div", "work-item-skeleton-facts");
    for (let index = 0; index < 4; index += 1) {
        facts.append(skeletonCard(["loading-skeleton-short", "loading-skeleton-medium"]));
    }
    const layout = element("div", "work-item-skeleton-layout");
    const main = element("div", "work-item-skeleton-main");
    main.append(
        skeletonCard(["loading-skeleton-short", "loading-skeleton-long", "loading-skeleton-medium"]),
        skeletonCard(["loading-skeleton-short", "loading-skeleton-long", "loading-skeleton-long"]),
    );
    const sidebar = element("div", "work-item-skeleton-sidebar");
    sidebar.append(
        skeletonCard(["loading-skeleton-short", "loading-skeleton-medium", "loading-skeleton-medium"]),
        skeletonCard(["loading-skeleton-short", "loading-skeleton-long"]),
    );
    layout.append(main, sidebar);
    visual.append(header, facts, layout);
    shell.append(visual);
    container.replaceChildren(shell);
}

// --- Tabs ------------------------------------------------------------------

function activeTab() {
    return tabs.find((tab) => tab.id === activeTabId) || null;
}

// Guards the two paths that throw away rendered tabs: closing one, and refreshing
// the whole canvas. An editor with unsaved text is the only state in the canvas
// that cannot be recovered by reloading.
function confirmDiscard(candidates) {
    if (!candidates.some((tab) => tab.dirty || tab.suggestions?.hasEdits())) {
        return true;
    }
    try {
        return window.confirm("Discard unsaved changes?");
    } catch {
        // A webview without a dialog implementation should not silently discard
        // the user's text, so the operation is refused instead.
        return false;
    }
}

function tabEntry(tab) {
    return tab?.entry || null;
}

// Ids are compared without coercing a missing or non-numeric id to 0, which is
// the id the reference-opened tab uses: collapsing onto it would focus that tab
// instead of opening the link that was clicked. The organization is part of the
// identity because two organizations can each have an item 4711.
// Organization-scope work-item rows carry their project
// separately because their connection itself has no project.
function sameEntry(left, right) {
    if (!left || !right || left.view !== right.view) {
        return false;
    }
    const leftId = Number(left.id);
    const rightId = Number(right.id);
    const sameId = left.view === "board"
        ? String(left.id || "") === String(right.id || "")
        : Number.isFinite(leftId) && Number.isFinite(rightId) && leftId === rightId;
    const sameOrganization = (left.organization || "").toLowerCase() ===
        (right.organization || "").toLowerCase();
    if (!sameId || !sameOrganization) {
        return false;
    }
    const leftProject = left.view === "work-item" ? left.workItemProject || left.project : left.project;
    const rightProject = right.view === "work-item" ? right.workItemProject || right.project : right.project;
    return (leftProject || "").toLowerCase() === (rightProject || "").toLowerCase();
}

// Every data request names the connection it belongs to, and the server checks
// the name against the connections it resolved.
function connectionQuery(entry, extra = {}) {
    const params = new URLSearchParams();
    if (entry?.organization) params.set("organization", entry.organization);
    if (entry?.project) params.set("project", entry.project);
    for (const [key, value] of Object.entries(extra)) {
        if (value) params.set(key, value);
    }
    const query = params.toString();
    return query ? `?${query}` : "";
}

function entryForConnection(view, id, connection, extra = {}) {
    return {
        view,
        id: view === "board" ? String(id || "") : Number(id),
        organization: connection?.organization || "",
        project: connection?.project || "",
        ...extra,
    };
}

function tabTitle(tab) {
    const entry = tabEntry(tab);
    if (entry.view === "home") {
        return "Home";
    }
    if (entry.view === "board") {
        return tab.data?.name || entry.name || "Board";
    }
    return tab.data ? `${tab.data.type} ${tab.data.id}` : `Work item ${entry.id}`;
}

function renderTabBar({ revealActive = false } = {}) {
    renderNavigation(viewTabs, {
        tabs, activeTabId, collapsed: collapsedNavigationItems, sameEntry, tabTitle,
        revealActive,
        workspace: { view: activeTab()?.entry.view === "home" ? workspaceMode : "", onShow: showWorkspace,
            onCreate: () => ensureWorkspace().openCreate() },
        onActivate: (id) => tabs.find(tab => tab.id === id)?.entry.view === "home" ? showWorkspace("home") : activateTab(id),
        onOpenChild: openWorkItem,
        onClose: closeTab,
    });
    saveOpenViews();
}

function setNavigationCollapsed(collapsed) {
    navigationCollapsed = collapsed;
    canvasContent.classList.toggle("navigation-collapsed", collapsed);
    navigationToggle.setAttribute("aria-expanded", String(!collapsed));
    navigationToggle.setAttribute("aria-label", collapsed ? "Expand navigation" : "Collapse navigation");
    navigationToggle.title = collapsed ? "Expand navigation" : "Collapse navigation";
    navigationToggle.textContent = collapsed ? "\u00bb" : "\u00ab";
    if (collapsed && viewTabs.contains(document.activeElement)) navigationToggle.focus();
}

navigationToggle.addEventListener("click", () => setNavigationCollapsed(!navigationCollapsed));
setNavigationCollapsed(navigationCollapsed);

function createTab(entry, { closable = true } = {}) {
    tabSequence += 1;
    const tab = {
        id: `tab-${tabSequence}`,
        entry,
        data: null,
        rendered: null,
        token: 0,
        scrollTop: 0,
        editMode: false,
        dirty: false,
        delegationPending: false,
        delegationStatus: "",
        delegationError: "",
        closable,
        panel: null,
        content: null,
    };
    if (entry.view === "home") {
        tab.panel = homePanel;
        tab.content = homeContent;
    } else {
        // Each item tab owns its DOM so switching tabs does not discard what was
        // already rendered, and so scroll position can be restored per tab.
        tab.panel = element("section", "tab-panel");
        tab.panel.id = `${tab.id}-panel`;
        tab.panel.setAttribute("role", "region");
        tab.panel.setAttribute("aria-live", "polite");
        tab.panel.hidden = true;
        tab.content = element("div", entry.view === "board" ? "board-tab-content" : "cards");
        if (entry.view === "board") {
            tab.panel.classList.add("board-panel");
        }
        tab.panel.append(tab.content);
        tabPanels.append(tab.panel);
    }
    tabs.push(tab);
    return tab;
}

function showActivePanel() {
    for (const tab of tabs) {
        tab.panel.hidden = tab.id !== activeTabId;
    }
}

async function activateTab(id) {
    if (id === activeTabId) {
        return;
    }
    if (boardWorkItemDrawerState?.tab?.id === activeTabId && !closeBoardWorkItemDrawer()) {
        return;
    }
    const outgoing = activeTab();
    if (outgoing) {
        outgoing.scrollTop = window.scrollY;
    }
    activeTabId = id;
    renderTabBar({ revealActive: true });
    showActivePanel();
    const tab = activeTab();
    if (!tab) {
        return;
    }
    await applyTab(tab);
    // The load may have outlived the switch, so only move the viewport if this
    // tab is still the one on screen.
    if (tab.id === activeTabId) {
        window.scrollTo(0, tab.scrollTop || 0);
    }
}

function closeTab(id) {
    const index = tabs.findIndex((tab) => tab.id === id);
    if (index === -1 || !tabs[index].closable) {
        return;
    }
    if (!confirmDiscard([tabs[index]])) {
        return;
    }
    const [closed] = tabs.splice(index, 1);
    closed.suggestions?.dispose();
    if (closed.dirty) discardDraft(closed);
    closed.draftWriter?.flush().catch(() => {});
    releaseBoardTab(closed);
    // Invalidates any load still in flight for this tab, so it cannot render into
    // a detached panel or report success for something the user closed.
    closed.token += 1;
    if (closed.panel !== homePanel) {
        closed.panel.remove();
    }
    addLog("trace", "Closed tab.", tabTitle(closed));
    if (activeTabId !== id) {
        renderTabBar();
        return;
    }
    // Focus the neighbour the closed tab occupied, falling back to its left.
    const next = tabs[index] || tabs[index - 1] || null;
    activeTabId = next?.id || "";
    renderTabBar({ revealActive: true });
    showActivePanel();
    if (next) {
        applyTab(next).then(() => {
            if (next.id === activeTabId) {
                window.scrollTo(0, next.scrollTop || 0);
            }
        });
    }
}

// Opening an item from Home or another tab gives it its own tab, matching the
// browser convention that an index opens results rather than replacing itself.
async function openEntry(entry) {
    const existing = tabs.find((tab) => sameEntry(tabEntry(tab), entry));
    if (existing) {
        if (entry.boardTabId && tabEntry(existing)?.boardTabId !== entry.boardTabId) {
            existing.entry = { ...tabEntry(existing), boardTabId: entry.boardTabId };
            if (existing.data && !existing.dirty) {
                renderWorkItemTab(existing);
            }
        }
        await activateTab(existing.id);
        return;
    }
    const outgoing = activeTab();
    if (outgoing) {
        outgoing.scrollTop = window.scrollY;
    }
    const tab = createTab(entry);
    activeTabId = tab.id;
    renderTabBar({ revealActive: true });
    showActivePanel();
    // Scrolled before the load so a slow fetch cannot yank the viewport of a tab
    // the user has since switched to.
    window.scrollTo(0, 0);
    await applyTab(tab);
}

async function applyTab(tab) {
    const entry = tabEntry(tab);
    if (!entry) {
        return;
    }
    if (entry.view === "home") {
        if (!homeLoaded) {
            await loadHome();
        }
        return;
    }
    if (sameEntry(tab.rendered, entry)) {
        return;
    }
    tab.token += 1;
    const token = tab.token;
    if (entry.view === "board") {
        await loadBoardIntoTab(tab, token);
    } else {
        await loadWorkItemIntoTab(tab, entry, token);
    }
    renderTabBar({ revealActive: true });
}

function releaseBoardToken(token) {
    if (!token) {
        return;
    }
    request(`/api/boards/${encodeURIComponent(token)}`, { method: "DELETE" })
        .catch((error) => addLog("error", "Failed to close board server.", error.message || ""));
}

function releaseBoardTab(tab) {
    if (tabEntry(tab)?.view === "board") {
        if (boardWorkItemDrawerState?.tab === tab) {
            closeBoardWorkItemDrawer(true);
        }
        for (const [requestId, pending] of pendingBoardDelegations) {
            if (pending.tab === tab) {
                clearTimeout(pending.timeout);
                pending.reject(new Error("The board was closed before delegation completed."));
                pendingBoardDelegations.delete(requestId);
            }
        }
        for (const workItemTab of tabs) {
            if (tabEntry(workItemTab)?.boardTabId !== tab.id) continue;
            workItemTab.entry = { ...tabEntry(workItemTab), boardTabId: "" };
            workItemTab.delegationPending = false;
            workItemTab.delegationStatus = "";
            workItemTab.delegationError = "";
            if (workItemTab.data && !workItemTab.dirty) {
                renderWorkItemTab(workItemTab);
            }
        }
        releaseBoardToken(tab.data?.token);
    }
}

async function loadBoardIntoTab(tab, token) {
    const entry = tabEntry(tab);
    showLoading(tab.content, `Opening ${entry.name || "board"}`, "Loading the favorited Azure DevOps board.");
    tab.rendered = null;
    try {
        const data = await request("/api/boards/open", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                id: entry.id,
                organization: entry.organization,
                project: entry.project,
            }),
        });
        if (token !== tab.token) {
            releaseBoardToken(data.token);
            return;
        }
        tab.data = { ...data.board, token: data.token, path: data.path };
        tab.rendered = { ...entry };
        const frame = element("iframe", "board-frame");
        frame.title = `${data.board?.name || entry.name || "Azure DevOps"} board`;
        frame.src = data.path;
        tab.frame = frame;
        tab.content.replaceChildren(frame);
        addLog(
            "trace",
            "Opened favorite board.",
            [data.board?.organization, data.board?.project, data.board?.name].filter(Boolean).join("/"),
        );
    } catch (error) {
        if (token !== tab.token) {
            return;
        }
        tab.data = null;
        showStatus(tab.content, error.message || "Failed to open the Azure DevOps board.", () => applyTab(tab));
        addLog("error", "Failed to open favorite board.", error.message || "");
    }
}

function boardTabForMessage(event) {
    if (event.origin !== window.location.origin) {
        return null;
    }
    return tabs.find((tab) => (
        tabEntry(tab)?.view === "board" &&
        tab.frame?.contentWindow === event.source
    )) || null;
}

window.addEventListener("message", (event) => {
    if (event.data?.source !== "azure-devops-board") {
        return;
    }
    const tab = boardTabForMessage(event);
    if (!tab) {
        return;
    }
    if (event.data.type === "open-work-item") {
        void openBoardWorkItemDrawer(tab, {
            id: event.data.id,
            project: event.data.project || tabEntry(tab)?.project || "",
        });
        return;
    }
    if (event.data.type === "delegation-result") {
        const pending = pendingBoardDelegations.get(event.data.requestId);
        if (!pending || pending.tab !== tab || pending.source !== event.source) {
            return;
        }
        clearTimeout(pending.timeout);
        pendingBoardDelegations.delete(event.data.requestId);
        pending.resolve(event.data.result || { ok: false, error: "Delegation failed." });
    }
});

workItemDrawerExpand.addEventListener("click", () => {
    const state = boardWorkItemDrawerState;
    if (!state || !closeBoardWorkItemDrawer()) {
        return;
    }
    void openWorkItem({
        id: state.id,
        project: state.workItemProject || tabEntry(state.tab)?.project || "",
        boardTabId: state.tab.id,
    }, tabEntry(state.tab));
});
workItemDrawerClose.addEventListener("click", () => closeBoardWorkItemDrawer());
workItemDrawerScrim.addEventListener("click", () => closeBoardWorkItemDrawer());
window.addEventListener("keydown", (event) => {
    if (!boardWorkItemDrawerState) return;
    if (event.key === "Tab") {
        trapWorkItemDrawerFocus(event);
    } else if (event.key === "Escape") {
        event.preventDefault();
        closeBoardWorkItemDrawer();
    }
});

async function loadConfig() {
    const data = await request("/api/config", {}, false);
    apiNonce = data.apiNonce || "";
    if (!apiNonce) throw new Error("The canvas did not provide an API nonce.");
    currentConfig = data.config;
    enabledFeatures = normalizeFeatureFlags(currentConfig.featureFlags);
    if (boardsFeatureFlag && delegationFeatureFlag) {
        boardsFeatureFlag.checked = enabledFeatures.boards;
        delegationFeatureFlag.checked = enabledFeatures.delegation;
    }
    versionLabel.textContent = currentConfig.extensionVersion ? `v${currentConfig.extensionVersion}` : "";
    return data;
}

function renderAuthOutput(process) {
    if (!process) {
        authOutput.hidden = true;
        authOutput.textContent = "";
        return;
    }
    let message = "Signing in...";
    if (process.provider === "canvas" && process.status === "succeeded") {
        message = "Signed out.";
    } else if (process.status === "succeeded") {
        message = "Signed in.";
    } else if (process.status === "failed") {
        message = "Sign-in didn't complete. Try again.";
    } else if (process.provider === "microsoft") {
        message = "Complete sign-in in the browser, then return here.";
    } else if (process.provider === "azureauth") {
        message = "Complete sign-in when prompted.";
    }
    authOutput.hidden = false;
    authOutput.textContent = message;
    authOutput.scrollTop = authOutput.scrollHeight;
}

function showSignInSplash() {
    // AzureAuth is an internal Microsoft tool, so the Agency option only works
    // where a managed install was discovered. Offering it elsewhere gives users
    // a button whose only outcome is azure_devops_azureauth_not_found. The
    // button starts hidden in the markup, so an unreachable config leaves it
    // hidden rather than briefly advertising an option that cannot work.
    signInAgencyButton.hidden =
        !AGENCY_AUTH_ENABLED || !currentConfig?.auth?.azureAuthDiscovery?.selected;
    startupSplash.hidden = true;
    startupSplash.setAttribute("aria-busy", "false");
    signInSplash.hidden = false;
    canvasContent.hidden = true;
    logsPanel.hidden = true;
}

function showCanvas() {
    startupSplash.hidden = true;
    startupSplash.setAttribute("aria-busy", "false");
    signInSplash.hidden = true;
    canvasContent.hidden = false;
}

// canvas-server.mjs gives AzureAuth 15 minutes plus a minute of process overhead,
// and the Microsoft flow self-fails after 5, so 16 minutes is the longest the
// server can report "running". The client polls past that ceiling so the server
// always reaches a terminal status first: a deadline at exactly the ceiling can
// expire in the same instant the server times out and report a false timeout for
// a sign-in that actually resolved.
const AUTH_SERVER_CEILING_MS = 16 * 60 * 1000;
const AUTH_POLL_LIMIT_MS = AUTH_SERVER_CEILING_MS + 60 * 1000;
const SILENT_AUTH_POLL_LIMIT_MS = 30 * 1000;
const AUTH_POLL_INTERVAL_MS = 750;

async function waitForAuthentication(onStatus = renderAuthOutput, pollLimitMs = AUTH_POLL_LIMIT_MS) {
    // Deadline-based rather than a fixed attempt count so request latency counts
    // against wall clock, and polled up front so an already-finished sign-in is
    // not held behind an interval that no longer has anything to wait for.
    const deadline = Date.now() + pollLimitMs;
    for (;;) {
        const data = await request("/api/auth/status");
        onStatus(data.authProcess);
        if (data.authProcess?.status !== "running") {
            return data;
        }
        if (Date.now() >= deadline) {
            throw new Error("Sign-in timed out. Try again.");
        }
        await new Promise((resolve) => setTimeout(resolve, AUTH_POLL_INTERVAL_MS));
    }
}

async function finishSilentAuthentication(authProcess) {
    if (authProcess?.mode !== "silent") {
        return;
    }
    showStartupLoading("Signing in", "Restoring the Azure DevOps session.");
    const data = authProcess.status === "running"
        ? await waitForAuthentication(() => {}, SILENT_AUTH_POLL_LIMIT_MS)
        : await request("/api/auth/status");
    if (data.auth) {
        currentConfig.auth = data.auth;
    }
    if (data.authProcess?.status === "succeeded") {
        addLog("trace", "Silent AzureAuth sign-in succeeded.");
    } else {
        addLog("trace", "Silent AzureAuth sign-in was unavailable; showing sign-in options.");
    }
}

async function startAuth(provider) {
    signInMicrosoftButton.disabled = true;
    signInAgencyButton.disabled = true;
    const providerLabel = provider === "microsoft" ? "Microsoft" : "Agency";
    renderAuthOutput({ provider, status: "running", output: `Starting ${providerLabel} sign-in...` });
    addLog("trace", `Starting ${providerLabel} sign-in.`);
    try {
        let data = await request("/api/auth/start", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ provider }),
        });
        renderAuthOutput(data.authProcess);
        if (data.authProcess?.status === "running") {
            data = await waitForAuthentication();
        }
        if (data.authProcess?.status === "succeeded") {
            addLog("trace", `${providerLabel} sign-in succeeded.`);
            renderAuthOutput(null);
            await refresh();
            return;
        }
        addLog("error", `${providerLabel} sign-in did not complete successfully.`, data.authProcess?.output || "");
    } catch (error) {
        addLog("error", `${providerLabel} sign-in failed.`, error.message || "");
        renderAuthOutput({ provider, status: "failed", output: error.message || `${providerLabel} sign-in failed.` });
    } finally {
        signInMicrosoftButton.disabled = false;
        signInAgencyButton.disabled = false;
    }
}

async function signOut() {
    if (!confirmDiscard(tabs)) {
        return;
    }
    signOutButton.disabled = true;
    try {
        window.clearTimeout(preferencesTimer);
        await preferencesWrite.catch(() => {});
        for (const tab of tabs) {
            if (tab.dirty) discardDraft(tab);
            await tab.draftWriter?.flush().catch(() => {});
            tab.draftWriter?.stop();
        }
        const data = await request("/api/auth/sign-out", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
        renderAuthOutput(data.authProcess);
        addLog("trace", "Signed out and cleared local preferences.");
        resetTabs();
        await refresh();
    } catch (error) {
        addLog("error", "Failed to sign out.", error.message || "");
    } finally {
        signOutButton.disabled = false;
    }
}

async function sendWorkItemToChat(state, entry) {
    if (state.chatStatus?.pending) return;
    const update = value => {
        state.chatStatus = value;
        state.view?.setChatStatus(value);
    };
    update({ pending: true });
    try {
        await request(`/api/work-items/${state.data.id}/send-to-chat${connectionQuery(entry, {
            workItemProject: state.data.project,
        })}`, { method: "POST" });
        update({ message: "Sent to chat · saved ADO details." });
    } catch (error) {
        update({ error: error.message || "Could not confirm delivery. Check the chat before trying again." });
    }
}

function renderWorkItemTab(tab) {
    if (canSuggestTasks(tab.data.type) && !tab.suggestions) {
        tab.suggestions = createTaskSuggestionPanel({ request,
            url: action => `/api/work-items/${tab.data.id}/${action}${connectionQuery(tabEntry(tab), { workItemProject: tab.data.project })}`,
            onCreated: () => checkWorkItemUpdates(tab),
        });
    }
    const generation = tab.viewGeneration = (tab.viewGeneration || 0) + 1;
    const currentView = () => tabs.includes(tab) && generation === tab.viewGeneration;
    tab.view = renderWorkItem(tab.content, tab.data, {
        avatarUrl: profileImageUrl,
        imageUrl: (url) => attachmentImageUrl(url, tabEntry(tab)),
        onOpenWorkItem: (item) => openWorkItem(item, tabEntry(tab)),
        canEdit: !tab.storedDraft,
        editMode: tab.editMode,
        draft: tab.localDraft,
        onDraftChange: (draft) => { if (currentView()) updateDraft(tab, draft); },
        onAddTask: () => ensureWorkspace().openCreate({ connection: tabEntry(tab), parent: tab.data }),
        onSendToChat: () => sendWorkItemToChat(tab, tabEntry(tab)),
        chatStatus: tab.chatStatus,
        onSuggestTasks: tab.suggestions ? () => tab.suggestions.open() : null,
        suggestionsHost: tab.suggestions?.host,
        onUploadAttachment: tab.storedDraft ? null : async (file) => {
            if (tab.busy) throw new Error("Wait for the current save to finish before uploading.");
            tab.pendingUploads = (tab.pendingUploads || 0) + 1;
            renderDraftNotice(tab);
            try {
                const result = await request(`/api/work-items/${tab.data.id}/attachments${connectionQuery(tabEntry(tab), {
                    workItemProject: tab.data.project, fileName: file.name,
                })}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file });
                // The attachment changes the revision; fetch details to detect any concurrent field edit.
                await checkWorkItemUpdates(tab).catch(error => addLog("error", "Attachment saved, but item details could not refresh.", error.message));
                return result;
            } finally { tab.pendingUploads -= 1; renderDraftNotice(tab); }
        },
        onDirtyChange: (dirty) => {
            if (!currentView()) return;
            tab.dirty = dirty || hasDraft({ comment: tab.commentDraft });
        },
        onEdit: () => setEditMode(tab, true, renderWorkItemTab),
        onCancelEdit: () => setEditMode(tab, false, renderWorkItemTab),
        // Keyboard submit from inside a field, so it goes through the same button
        // the user would otherwise click and inherits its busy and error handling.
        onSubmit: () => tab.content.querySelector(".editor-save")?.click(),
        onSave: (fields) => saveWorkItemFields(tab, fields),
        onAddComment: tab.storedDraft ? null : (content) => postWorkItemComment(tab, content),
        commentDraft: tab.commentDraft,
        onCommentDraftChange: (draft) => {
            if (!currentView()) return;
            tab.commentDraft = draft.content ? draft : null;
        },
        onSearchIdentities: (query) => request(
            `/api/identities${connectionQuery(tabEntry(tab), { query })}`,
        ),
        onDelegateLocal: enabledFeatures.delegation ? () => delegateWorkItemTab(tab, "local") : null,
        delegationPending: tab.delegationPending,
        delegationStatus: tab.delegationStatus,
        delegationError: tab.delegationError,
    });
    renderDraftNotice(tab);
}

function draftPath(tab) {
    return `/api/work-items/${tab.data.id}/draft${connectionQuery(tab.entry, { workItemProject: tab.data.project })}`;
}

function updateDraft(tab, draft) {
    tab.localDraft = draft;
    tab.commentDraft = draft.comment?.content ? draft.comment : null;
    tab.dirty = hasDraft(draft);
    if (!tab.baseRev || !draft.fields?.length) {
        tab.baseRev = tab.data.rev;
        tab.baseValues = fieldValues(tab.data);
    }
    if (!tab.draftWriter) {
        tab.draftWriter = createDraftWriter({
            schedule: window.setTimeout.bind(window), cancel: window.clearTimeout.bind(window),
            write: value => request(draftPath(tab), {
                method: value ? "PUT" : "DELETE",
                headers: { "Content-Type": "application/json" },
                ...(value ? { body: JSON.stringify(value) } : {}),
            }),
            onStatus: status => { tab.draftStatus = status; renderDraftNotice(tab); },
        });
    }
    tab.draftWriter.set(tab.dirty ? { ...draft, rev: tab.baseRev, baseValues: tab.baseValues } : null);
}

function discardDraft(tab) {
    if (!tab.data) return;
    tab.storedDraft = null;
    tab.latest = null;
    tab.baseRev = tab.data.rev;
    tab.baseValues = fieldValues(tab.data);
    updateDraft(tab, { fields: [], comment: { content: "", mentions: [] } });
}

function renderDraftNotice(tab) {
    if (!tabs.includes(tab)) return;
    if (!tab.draftNotice) {
        tab.draftNotice = element("div", "draft-notice");
        tab.draftNotice.setAttribute("aria-label", "Draft status");
        tab.panel.prepend(tab.draftNotice);
    }
    const notice = tab.draftNotice;
    for (const button of notice.querySelectorAll("button")) button.disabled = Boolean(tab.busy || tab.pendingUploads);
    // Do not replace a conflict selector the user is currently choosing.
    if (notice.contains(document.activeElement) && document.activeElement.matches(".draft-conflict select") && tab.latest) return;
    notice.replaceChildren();
    const action = (text, run) => {
        const button = element("button", "secondary", text);
        button.type = "button";
        button.disabled = Boolean(tab.busy || tab.pendingUploads);
        button.addEventListener("click", () => { if (!tab.busy && !tab.pendingUploads) run(); });
        return button;
    };
    if (tab.storedDraft) {
        notice.append(element("span", "", "A saved draft is available on this device. Restore or discard it before editing or commenting."));
        const actions = element("div", "draft-actions");
        actions.append(action("Restore draft", () => {
            const draft = tab.storedDraft;
            tab.storedDraft = null;
            tab.baseRev = draft.rev;
            tab.baseValues = draft.baseValues || {};
            tab.editMode = Boolean(draft.fields?.length);
            updateDraft(tab, { fields: draft.fields || [], comment: typeof draft.comment === "string"
                ? { content: draft.comment, mentions: [] } : draft.comment || { content: "", mentions: [] } });
            if (tab.baseRev !== tab.data.rev && draft.fields?.length) tab.latest = tab.data;
            renderWorkItemTab(tab);
        }), action("Discard draft", () => { discardDraft(tab); renderWorkItemTab(tab); }));
        notice.append(actions);
    }
    if (tab.latest && !tab.localDraft?.fields?.length) {
        notice.append(element("strong", "", "This item changed in Azure DevOps."), action("Load latest version", () => {
            tab.data = tab.latest; tab.latest = null;
            tab.baseRev = tab.data.rev; tab.baseValues = fieldValues(tab.data);
            renderWorkItemTab(tab);
        }));
    } else if (tab.latest && tab.localDraft?.fields?.length) {
        notice.append(element("strong", "", "This item changed in Azure DevOps. Review your edits before saving."));
        const current = fieldValues(tab.latest);
        const reviewedRevision = tab.latest.rev;
        const choices = [];
        for (const field of tab.localDraft.fields) {
            const row = element("label", "draft-conflict");
            row.append(element("strong", "", field.name),
                element("p", "", `Current: ${current[field.name] ?? ""}`),
                element("p", "", `Your edit: ${field.value ?? ""}`));
            const choice = element("select");
            choice.setAttribute("aria-label", `Resolve ${field.name}`);
            for (const [value, label] of [["mine", "Keep my edit"], ["current", "Use current value"]]) {
                const option = element("option", "", label); option.value = value; choice.append(option);
            }
            choices.push({ field, choice });
            row.append(choice); notice.append(row);
        }
        notice.append(action("Apply choices", () => {
            if (tab.latest.rev !== reviewedRevision) { renderDraftNotice(tab); return; }
            const decisions = new Map(choices.map(({ field, choice }) => [field.name, choice.value]));
            const currentValues = fieldValues(tab.latest);
            const fields = tab.localDraft.fields.filter(field => decisions.get(field.name) !== "current" &&
                String(field.value ?? "") !== String(currentValues[field.name] ?? ""));
            tab.data = tab.latest; tab.latest = null;
            tab.baseRev = tab.data.rev; tab.baseValues = currentValues;
            updateDraft(tab, { fields, comment: tab.localDraft.comment });
            renderWorkItemTab(tab);
        }));
    }
    if (tab.draftStatus) {
        const status = element("span", "status", tab.draftStatus);
        status.setAttribute("role", "status"); notice.append(status);
        if (tab.draftStatus.startsWith("Draft not saved")) notice.append(action("Retry draft save", () => tab.draftWriter.flush().catch(() => {})));
    }
}

async function checkWorkItemUpdates(tab) {
    if (!tab.data || !tabs.includes(tab)) return;
    const updateToken = tab.updateToken = (tab.updateToken || 0) + 1;
    const data = await request(`/api/work-items/${tab.data.id}/details${connectionQuery(tab.entry, { workItemProject: tab.data.project })}`);
    if (!tabs.includes(tab) || updateToken !== tab.updateToken || data.workItem.rev <= tab.data.rev) return;
    const draft = tab.view?.getDraft() || tab.localDraft;
    if (hasDraft(draft) || tab.editMode || tab.busy || tab.pendingUploads) {
        tab.localDraft = draft;
        const latestValues = fieldValues(data.workItem);
        const originalValues = tab.baseValues || fieldValues(tab.data);
        const changed = new Set([...Object.keys(latestValues), ...Object.keys(originalValues)]);
        const collision = tab.editMode && [...changed].some(name => String(latestValues[name] ?? "") !== String(originalValues[name] ?? ""));
        if (collision) tab.latest = data.workItem;
        else {
            tab.data = data.workItem;
            tab.baseRev = data.workItem.rev;
            tab.baseValues = latestValues;
            if (hasDraft(draft)) updateDraft(tab, draft);
        }
        renderDraftNotice(tab);
    } else if (!tab.content.contains(document.activeElement)) {
        tab.data = data.workItem;
        renderWorkItemTab(tab);
        renderTabBar();
    }
}

function ensureWorkspace() {
    const connections = currentConfig?.connections || [];
    const key = JSON.stringify(connections);
    if (!workspaceController || workspaceConnections !== key) {
        workspaceController?.destroy();
        workspaceConnections = key;
        workspaceController = createWorkspaceView(homeContent, {
            request, connections,
            onOpenWorkItem: openHomeWorkItem,
            onCreated: async (item, connection, parent) => {
                if (parent) {
                    const parentTab = tabs.find(tab => sameEntry(tab.entry, entryForConnection("work-item", parent.id, connection, { workItemProject: parent.project })));
                    if (parentTab) await checkWorkItemUpdates(parentTab).catch(error => addLog("error", "Could not refresh parent.", error.message));
                }
                homeLoaded = false;
                await openHomeWorkItem(item, connection);
            },
            onChange: () => { for (const tab of tabs) if (tab.data && tab.entry.view === "work-item") checkWorkItemUpdates(tab).catch(() => {}); },
            onViewChange: view => { workspaceMode = view; renderTabBar(); },
        });
    }
    return workspaceController;
}

async function showWorkspace(view) {
    workspaceMode = view;
    const home = tabs.find(tab => tab.entry.view === "home");
    if (!home) return;
    if (activeTab()) activeTab().scrollTop = window.scrollY;
    activeTabId = home.id;
    showActivePanel(); renderTabBar();
    await ensureWorkspace().show(view);
    homeLoaded = true;
    if (activeTabId === home.id) window.scrollTo(0, home.scrollTop || 0);
}

function saveOpenViews() {
    if (restoringWorkspace || !currentConfig?.auth?.isAuthenticated) return;
    window.clearTimeout(preferencesTimer);
    const preferences = {
        openItems: tabs.filter(tab => tab.entry.view === "work-item" && tab.entry.id > 0).map(tab => ({ ...tab.entry, current: false })),
        activeItem: activeTab()?.entry.view === "work-item" ? { ...activeTab().entry, current: false } : null,
    };
    preferencesTimer = window.setTimeout(() => {
        preferencesWrite = preferencesWrite.catch(() => {}).then(() => request("/api/workspace/preferences", {
            method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(preferences),
        })).catch(error => addLog("error", "Could not save open views.", error.message));
    }, 400);
}

async function restoreOpenViews() {
    try {
        const { preferences = {} } = await request("/api/workspace/preferences");
        workspaceMode = ["home", "items", "board"].includes(preferences.workspace?.view) ? preferences.workspace.view : "home";
        for (const entry of (preferences.openItems || []).slice(0, 50)) {
            if (entry.view !== "work-item" || !Number.isInteger(entry.id) || entry.id <= 0) continue;
            const connection = currentConfig.connections.find(c => (c.organization || "").toLowerCase() === (entry.organization || "").toLowerCase() &&
                (c.project || "").toLowerCase() === (entry.project || "").toLowerCase());
            if (!connection || tabs.some(tab => sameEntry(tab.entry, entry))) continue;
            const tab = createTab(entryForConnection("work-item", entry.id, connection, { workItemProject: entry.workItemProject || "" }));
            if (sameEntry(entry, preferences.activeItem)) activeTabId = tab.id;
        }
    } catch (error) { addLog("error", "Could not restore open views.", error.message); }
    finally { restoringWorkspace = false; }
}

function sourceBoardTab(tab) {
    const boardTabId = tabEntry(tab)?.boardTabId;
    if (!boardTabId) return null;
    return tabs.find((candidate) => candidate.id === boardTabId && tabEntry(candidate)?.view === "board") || null;
}

function renderBoardWorkItemDrawer() {
    const state = boardWorkItemDrawerState;
    if (!state?.data) {
        return;
    }
    const scrollTop = workItemDrawerContent.scrollTop;
    state.view = renderWorkItem(workItemDrawerContent, state.data, {
        avatarUrl: profileImageUrl,
        imageUrl: (url) => attachmentImageUrl(url, tabEntry(state.tab)),
        canEdit: true,
        editMode: state.editMode,
        onOpenWorkItem: (item) => openBoardWorkItemDrawer(state.tab, item),
        onSendToChat: () => sendWorkItemToChat(state, tabEntry(state.tab)),
        chatStatus: state.chatStatus,
        onDirtyChange: (dirty) => {
            if (boardWorkItemDrawerState !== state) return;
            state.dirty = dirty;
            state.tab.dirty = dirty;
        },
        onEdit: () => {
            if (boardWorkItemDrawerState !== state) return;
            state.editMode = true;
            state.dirty = false;
            state.tab.dirty = false;
            renderBoardWorkItemDrawer();
        },
        onCancelEdit: () => {
            if (boardWorkItemDrawerState !== state || (state.dirty && !confirmDiscard([state]))) return;
            state.editMode = false;
            state.dirty = false;
            state.tab.dirty = false;
            renderBoardWorkItemDrawer();
        },
        onSubmit: () => workItemDrawerContent.querySelector(".editor-save")?.click(),
        onSave: (fields) => saveBoardWorkItemDrawer(fields),
        onAddComment: (content) => postBoardWorkItemComment(content),
        commentDraft: state.commentDraft,
        onCommentDraftChange: (draft) => {
            if (boardWorkItemDrawerState === state) {
                state.commentDraft = draft.content ? draft : null;
            }
        },
        onSearchIdentities: (query) => request(
            `/api/identities${connectionQuery(tabEntry(state.tab), { query })}`,
        ),
        onDelegateLocal: enabledFeatures.delegation ? () => delegateBoardWorkItem("local") : null,
        delegationPending: state.delegationPending,
        delegationStatus: state.delegationStatus,
        delegationError: state.delegationError,
    });
    workItemDrawerContent.scrollTop = scrollTop;
}

async function loadBoardWorkItemDrawer(state) {
    const entry = tabEntry(state.tab);
    showWorkItemLoading(workItemDrawerContent, state.id);
    try {
        const data = await request(
            `/api/work-items/${encodeURIComponent(state.id)}/details${connectionQuery(entry, {
                workItemProject: state.workItemProject || entry?.project,
            })}`,
        );
        if (boardWorkItemDrawerState !== state) {
            return;
        }
        state.data = data.workItem;
        state.workItemProject = data.workItem?.project || state.workItemProject;
        renderBoardWorkItemDrawer();
        addLog("trace", "Loaded board work item details.", `${data.workItem.type} ${data.workItem.id}: ${data.workItem.title}`);
    } catch (error) {
        if (boardWorkItemDrawerState !== state) {
            return;
        }
        addLog("error", "Failed to load board work item details.", error.message || "");
        showStatus(
            workItemDrawerContent,
            error.message || "Unable to load the work item.",
            () => loadBoardWorkItemDrawer(state),
        );
    }
}

function workItemDrawerBackgroundElements() {
    return [
        startupSplash,
        signInSplash,
        ...[...canvasContent.children].filter((element) => (
            element !== workItemDrawerScrim && element !== workItemDrawer
        )),
        document.querySelector("footer"),
        logsPanel,
    ].filter(Boolean);
}

function setWorkItemDrawerBackgroundHidden(hidden) {
    if (hidden) {
        if (workItemDrawerBackgroundState) return;
        workItemDrawerBackgroundState = new Map();
        for (const element of workItemDrawerBackgroundElements()) {
            workItemDrawerBackgroundState.set(element, {
                inert: element.hasAttribute("inert"),
                ariaHidden: element.getAttribute("aria-hidden"),
            });
            element.setAttribute("inert", "");
            element.setAttribute("aria-hidden", "true");
        }
        return;
    }
    if (!workItemDrawerBackgroundState) return;
    for (const [element, state] of workItemDrawerBackgroundState) {
        if (!state.inert) element.removeAttribute("inert");
        if (state.ariaHidden === null) element.removeAttribute("aria-hidden");
        else element.setAttribute("aria-hidden", state.ariaHidden);
    }
    workItemDrawerBackgroundState = null;
}

function trapWorkItemDrawerFocus(event) {
    if (event.key !== "Tab" || !boardWorkItemDrawerState) return;
    const focusable = [...workItemDrawer.querySelectorAll(focusableSelector)]
        .filter((element) => !element.closest("[hidden]"));
    if (!focusable.length) {
        event.preventDefault();
        workItemDrawer.focus();
        return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    const target = !workItemDrawer.contains(active)
        ? (event.shiftKey ? last : first)
        : event.shiftKey && active === first
            ? last
            : !event.shiftKey && active === last
                ? first
                : null;
    if (target) {
        event.preventDefault();
        target.focus();
    }
}

async function openBoardWorkItemDrawer(tab, workItem) {
    const item = typeof workItem === "object" && workItem ? workItem : { id: workItem };
    const id = Number(item.id);
    if (!Number.isInteger(id) || id <= 0 || tabEntry(tab)?.view !== "board") {
        return;
    }
    const previous = boardWorkItemDrawerState;
    if (previous?.dirty && (previous.id !== id || previous.tab !== tab) && !confirmDiscard([previous])) {
        return;
    }
    if (previous?.tab && previous.tab !== tab) {
        previous.tab.dirty = false;
    }
    const state = {
        tab,
        id,
        workItemProject: item.project || tabEntry(tab)?.project || "",
        data: null,
        editMode: false,
        dirty: false,
        commentDraft: null,
        delegationPending: false,
        delegationStatus: "",
        delegationError: "",
        returnFocus: previous?.returnFocus || document.activeElement,
    };
    boardWorkItemDrawerState = state;
    setWorkItemDrawerBackgroundHidden(true);
    workItemDrawerScrim.hidden = false;
    workItemDrawer.hidden = false;
    window.requestAnimationFrame(() => {
        if (boardWorkItemDrawerState !== state) return;
        workItemDrawerScrim.classList.add("open");
        workItemDrawer.classList.add("open");
        workItemDrawerClose.focus();
    });
    await loadBoardWorkItemDrawer(state);
}

function closeBoardWorkItemDrawer(force = false) {
    const state = boardWorkItemDrawerState;
    if (!state) {
        return true;
    }
    if (!force && state.dirty && !confirmDiscard([state])) {
        return false;
    }
    state.tab.dirty = false;
    boardWorkItemDrawerState = null;
    workItemDrawerScrim.classList.remove("open");
    workItemDrawer.classList.remove("open");
    setWorkItemDrawerBackgroundHidden(false);
    setTimeout(() => {
        if (boardWorkItemDrawerState) return;
        workItemDrawerScrim.hidden = true;
        workItemDrawer.hidden = true;
        workItemDrawerContent.replaceChildren();
    }, 180);
    state.returnFocus?.focus?.();
    return true;
}

async function saveBoardWorkItemDrawer(fields) {
    const state = boardWorkItemDrawerState;
    if (!state?.data) return;
    if (!fields.length) {
        state.editMode = false;
        state.dirty = false;
        state.tab.dirty = false;
        renderBoardWorkItemDrawer();
        return;
    }
    const entry = tabEntry(state.tab);
    const data = await request(
        `/api/work-items/${encodeURIComponent(state.id)}${connectionQuery(entry, {
            workItemProject: state.workItemProject || entry?.project,
        })}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ rev: state.data.rev, fields }),
        },
    );
    if (boardWorkItemDrawerState !== state) return;
    state.data = data.workItem;
    state.editMode = false;
    state.dirty = false;
    state.tab.dirty = false;
    renderBoardWorkItemDrawer();
    addLog("trace", "Saved board work item changes.", `Work item #${state.id}`);
}

async function postBoardWorkItemComment(content) {
    const state = boardWorkItemDrawerState;
    if (!state?.data) return;
    const entry = tabEntry(state.tab);
    const data = await request(
        `/api/work-items/${encodeURIComponent(state.id)}/comments${connectionQuery(entry, {
            workItemProject: state.workItemProject || entry?.project,
        })}`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content }),
        },
    );
    if (boardWorkItemDrawerState !== state) return;
    state.data = data.workItem;
    state.commentDraft = null;
    renderBoardWorkItemDrawer();
    addLog("trace", "Added a board work item comment.", `Work item #${state.id}`);
}

function sendBoardDelegation(boardTab, id, mode) {
    const frameWindow = boardTab.frame?.contentWindow;
    if (!frameWindow) {
        return Promise.reject(new Error("The board is not ready."));
    }
    boardDelegationSequence += 1;
    const requestId = `delegate-${boardDelegationSequence}`;
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            pendingBoardDelegations.delete(requestId);
            reject(new Error("Delegation did not finish in time."));
        }, 120_000);
        timeout.unref?.();
        pendingBoardDelegations.set(requestId, {
            tab: boardTab,
            source: frameWindow,
            resolve,
            reject,
            timeout,
        });
        frameWindow.postMessage({
            source: "azure-devops-canvas",
            type: "delegate-work-item",
            requestId,
            mode,
            id,
        }, window.location.origin);
    });
}

async function delegateBoardWorkItem(mode) {
    const state = boardWorkItemDrawerState;
    if (!state || state.delegationPending) return;
    state.delegationPending = true;
    state.delegationStatus = mode === "local" ? "Starting local delegation…" : "Starting cloud delegation…";
    state.delegationError = "";
    renderBoardWorkItemDrawer();
    try {
        const result = await sendBoardDelegation(state.tab, state.id, mode);
        if (boardWorkItemDrawerState !== state) return;
        state.delegationPending = false;
        if (result?.cancelled) {
            state.delegationStatus = "";
        } else if (!result?.ok) {
            state.delegationStatus = "";
            state.delegationError = result?.error || "Delegation failed.";
        } else {
            state.delegationStatus = mode === "local"
                ? "Delegated to a local Copilot session."
                : "Delegated to a Copilot cloud agent.";
            if (result.state && state.data) state.data.state = result.state;
        }
        if (["cloud_repo_missing", "repo_unreachable"].includes(result?.code)) {
            closeBoardWorkItemDrawer(true);
            return;
        }
        renderBoardWorkItemDrawer();
    } catch (error) {
        if (boardWorkItemDrawerState !== state) return;
        state.delegationPending = false;
        state.delegationStatus = "";
        state.delegationError = error.message || "Delegation failed.";
        renderBoardWorkItemDrawer();
    }
}

async function delegateWorkItemTab(tab, mode) {
    if (tab.busy || tab.pendingUploads) return;
    const boardTab = sourceBoardTab(tab);
    if (tab.delegationPending) return;
    tab.delegationPending = true;
    tab.delegationStatus = mode === "local" ? "Starting local delegation…" : "Starting cloud delegation…";
    tab.delegationError = "";
    renderWorkItemTab(tab);
    try {
        let result = boardTab
            ? await sendBoardDelegation(boardTab, tab.data.id, mode)
            : await sendWorkItemDelegation(tab, mode);
        if (!boardTab && ["in_flight", "already_linked"].includes(result?.code) && window.confirm(
            `#${tab.data.id} already has work in flight.\n\nStart another session anyway? Two agents editing the same code at once can overwrite each other's work.`,
        )) {
            result = await sendWorkItemDelegation(tab, mode, true);
        }
        if (!tabs.includes(tab) || (boardTab && sourceBoardTab(tab) !== boardTab)) return;
        tab.delegationPending = false;
        if (result?.cancelled) {
            tab.delegationStatus = "";
        } else if (!result?.ok) {
            tab.delegationStatus = "";
            tab.delegationError = result?.error || "Delegation failed.";
        } else {
            tab.delegationStatus = mode === "local"
                ? "Delegated to a local Copilot session."
                : "Delegated to a Copilot cloud agent.";
            if (result.state && tab.data) tab.data.state = result.state;
        }
        if (["cloud_repo_missing", "repo_unreachable"].includes(result?.code)) {
            if (boardTab) {
                await activateTab(boardTab.id);
            } else {
                renderWorkItemTab(tab);
            }
            return;
        }
        renderWorkItemTab(tab);
    } catch (error) {
        if (!tabs.includes(tab) || (boardTab && sourceBoardTab(tab) !== boardTab)) return;
        tab.delegationPending = false;
        tab.delegationStatus = "";
        tab.delegationError = error.message || "Delegation failed.";
        renderWorkItemTab(tab);
    }
}

function sendWorkItemDelegation(tab, mode, force = false) {
    const entry = tabEntry(tab);
    return request(
        `/api/work-items/${encodeURIComponent(tab.data.id)}/delegate${connectionQuery(entry, {
            workItemProject: tab.data.project || entry?.workItemProject || entry?.project,
        })}`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mode, force }),
        },
    );
}

async function postWorkItemComment(tab, content) {
    if (tab.busy || tab.pendingUploads) throw new Error("Wait for the current save or upload to finish before posting.");
    const entry = tabEntry(tab);
    const submitted = tab.view?.getDraft() || tab.localDraft;
    const generation = tab.viewGeneration;
    tab.busy = true;
    try {
        const data = await request(
            `/api/work-items/${encodeURIComponent(tab.data.id)}/comments${connectionQuery(entry, { workItemProject: tab.data.project })}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ content }),
            },
        );
        if (!tabs.includes(tab) || generation !== tab.viewGeneration) return;
        const draft = tab.view?.getDraft() || tab.localDraft;
        tab.data = data.workItem;
        const comment = JSON.stringify(draft?.comment) === JSON.stringify(submitted?.comment)
            ? { content: "", mentions: [] } : draft?.comment || { content: "", mentions: [] };
        const latestValues = fieldValues(tab.data);
        const originalValues = tab.baseValues || {};
        const changed = [...new Set([...Object.keys(latestValues), ...Object.keys(originalValues)])]
            .some(name => String(latestValues[name] ?? "") !== String(originalValues[name] ?? ""));
        if (draft?.fields?.length && changed) tab.latest = tab.data;
        else { tab.baseRev = tab.data.rev; tab.baseValues = latestValues; }
        updateDraft(tab, { fields: draft?.fields || [], comment });
        renderWorkItemTab(tab);
        renderTabBar();
        addLog("trace", "Added a work item comment.", `Work item #${tab.data.id}`);
    } finally { tab.busy = false; renderDraftNotice(tab); }
}

// Entering or leaving edit mode re-renders the whole detail view, so unsaved work
// is confirmed first.
function setEditMode(tab, editMode, render) {
    if (tab.busy || tab.pendingUploads) return;
    if (editMode && tab.storedDraft) { renderDraftNotice(tab); return; }
    if (tab.editMode === editMode || (!editMode && !confirmDiscard([tab]))) {
        return;
    }
    const draft = tab.view?.getDraft() || tab.localDraft;
    if (!editMode) {
        if (tab.latest) tab.data = tab.latest;
        tab.latest = null;
        tab.baseRev = tab.data.rev;
        tab.baseValues = fieldValues(tab.data);
        updateDraft(tab, { fields: [], comment: draft?.comment || { content: "", mentions: [] } });
    } else {
        tab.baseRev = tab.data.rev;
        tab.baseValues = fieldValues(tab.data);
        tab.localDraft = draft;
    }
    tab.editMode = editMode;
    tab.dirty = hasDraft(tab.localDraft);
    render(tab);
}

async function saveWorkItemFields(tab, fields) {
    if (tab.busy || tab.pendingUploads) throw new Error("Wait for the current save or upload to finish before saving.");
    if (tab.latest) throw new Error("Review the changed values above and apply your choices before saving.");
    // Nothing was touched, so there is nothing to write; leaving edit mode is the
    // whole of the save.
    if (!fields.length) {
        tab.editMode = false;
        updateDraft(tab, { fields: [], comment: tab.localDraft?.comment || { content: "", mentions: [] } });
        renderWorkItemTab(tab);
        return;
    }
    const entry = tabEntry(tab);
    const generation = tab.viewGeneration;
    const submitted = tab.view?.getDraft() || tab.localDraft;
    const original = tab.baseValues || fieldValues(tab.data);
    tab.busy = true;
    try {
        const data = await request(`/api/work-items/${encodeURIComponent(tab.data.id)}${connectionQuery(entry, { workItemProject: tab.data.project })}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            // Every changed field goes in one patch, so the revision test covers the
            // whole edit rather than each field racing separately.
            body: JSON.stringify({ rev: tab.baseRev || tab.data.rev, fields }),
        });
        if (!tabs.includes(tab) || generation !== tab.viewGeneration) return;
        const current = tab.view?.getDraft() || tab.localDraft;
        const remaining = fieldsAfterSave(submitted?.fields, current?.fields, original, new Set(fields.map(field => field.name)));
        tab.data = data.workItem;
        tab.editMode = remaining.length > 0;
        tab.baseRev = tab.data.rev;
        tab.baseValues = fieldValues(tab.data);
        updateDraft(tab, { fields: remaining, comment: current?.comment || { content: "", mentions: [] } });
        // tab.rendered marks which entry the tab shows, which a save does not change;
        // the refreshed payload replaces the cached one in tab.data instead.
        renderWorkItemTab(tab);
        renderTabBar();
        addLog("trace", "Saved work item changes.", `${data.workItem.type} ${data.workItem.id}: ${fields.map((field) => field.name).join(", ")}`);
    } catch (error) {
        if (!tabs.includes(tab) || generation !== tab.viewGeneration) return;
        if (error.code === "azure_devops_work_item_out_of_date") {
            await checkWorkItemUpdates(tab);
            throw new Error("This item changed. Review the current values above, then save again.");
        }
        throw error;
    } finally { tab.busy = false; renderDraftNotice(tab); }
}

function loadedWorkItemTab(tab, workItem, entry) {
    tab.data = workItem;
    if (entry?.current) {
        tab.entry = { ...entry, id: Number(workItem.id), workItemProject: workItem.project || entry.workItemProject || "" };
        entry = tab.entry;
    }
    // A reference-opened tab has no id of its own, so the entry is adopted rather
    // than rebuilt; otherwise the rendered marker would never match the entry.
    tab.rendered = entry?.current
        ? entry
        : { ...entry, view: "work-item", id: Number(workItem.id) || 0 };
    tab.editMode = false;
    tab.dirty = false;
    tab.localDraft = null;
    tab.baseRev = workItem.rev;
    tab.baseValues = fieldValues(workItem);
    renderWorkItemTab(tab);
}

async function loadWorkItemIntoTab(tab, entry, token) {
    const id = Number(entry.id) || 0;
    showWorkItemLoading(tab.content, id);
    // The panel now shows a placeholder, so nothing is rendered until this resolves.
    tab.rendered = null;
    try {
        // A canvas opened on a work item carries the reference server-side, so the
        // id is not known here until the item itself has been fetched.
        const data = await request(entry.current
            ? "/api/current-work-item"
            : `/api/work-items/${encodeURIComponent(id)}/details${connectionQuery(entry, { workItemProject: entry.workItemProject })}`);
        if (token !== tab.token) {
            return;
        }
        if (!tab.draftLoaded) {
            const saved = await request(`/api/work-items/${data.workItem.id}/draft${connectionQuery(entry, { workItemProject: data.workItem.project })}`);
            if (token !== tab.token) return;
            tab.storedDraft = hasDraft(saved.draft) ? saved.draft : null;
            tab.draftLoaded = true;
        }
        loadedWorkItemTab(tab, data.workItem, entry);
        addLog("trace", "Loaded work item details.", `${data.workItem.type} ${data.workItem.id}: ${data.workItem.title}`);
    } catch (error) {
        if (token !== tab.token) {
            return;
        }
        tab.data = null;
        tab.rendered = null;
        addLog("error", "Failed to load work item details.", error.message || "");
        showStatus(tab.content, error.message || "Unable to load the work item.", () => loadWorkItemIntoTab(tab, entry, tab.token));
    }
}

// Every item opens in its own tab, including links followed from inside another
// item, so any number of work items can be open at once. A
// link followed from inside an item stays on that item's connection.
function openWorkItem(workItem, entry) {
    const item = typeof workItem === "object" && workItem
        ? workItem
        : { id: workItem };
    return openEntry(entryForConnection(
        "work-item",
        item.id,
        entry,
        {
            workItemProject: item.project || "",
            boardTabId: item.boardTabId || entry?.boardTabId || "",
        },
    ));
}

function profileImageUrl(imageUrl) {
    if (!imageUrl) {
        return "";
    }
    return `/api/avatar?${new URLSearchParams({ url: imageUrl, nonce: apiNonce })}`;
}

const ATTACHMENT_IMAGE_SOURCE =
    /^https:\/\/[^/]+\/(?:[^/]+\/)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/_apis\/wit\/attachments\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:[?#]|$)/i;

function attachmentImageUrl(imageUrl, entry) {
    if (!apiNonce || !ATTACHMENT_IMAGE_SOURCE.test(imageUrl)) return imageUrl;
    return `/api/attachment${connectionQuery(entry, { url: imageUrl, nonce: apiNonce })}`;
}

async function delegateHomeWorkItem(item, connection = null, force = false) {
    const entry = entryForConnection(
        "work-item",
        item.id,
        connection || defaultEntryConnection(),
        { workItemProject: item.project || "" },
    );
    let result = await request(
        `/api/work-items/${encodeURIComponent(item.id)}/delegate${connectionQuery(entry, {
            workItemProject: item.project || entry.project,
        })}`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mode: "local", force }),
        },
    );
    if (!force && ["in_flight", "already_linked"].includes(result?.code)) {
        if (!window.confirm(
            `#${item.id} already has work in flight.\n\nStart another session anyway? Two agents editing the same code at once can overwrite each other's work.`,
        )) {
            return { cancelled: true };
        }
        result = await delegateHomeWorkItem(item, connection, true);
    }
    if (result?.ok) {
        addLog("trace", "Sent a work item delegation request.", `Work item ${item.id}`);
    }
    return result;
}

async function loadHome() {
    await ensureWorkspace().show(workspaceMode);
    homeLoaded = true;
}

async function loadLegacyHome() {
    if (!homeContent.querySelector(".home-loading-state")) {
        showLoading(
            homeContent,
            "Loading your Azure DevOps work",
            enabledFeatures.boards
                ? "Fetching favorite boards and work items."
                : "Fetching work items.",
            { className: "home-loading-state" },
        );
    }
    try {
        const data = await request("/api/home");
        homeLoaded = true;
        renderHome(homeContent, data, {
            onOpenBoard: enabledFeatures.boards ? openHomeBoard : null,
            onDelegateWorkItem: enabledFeatures.delegation ? delegateHomeWorkItem : null,
            onOpenWorkItem: openHomeWorkItem,
            onChooseProject: openConnectionPanel,
        });
        addLog(
            "trace",
            "Loaded Azure DevOps home overview.",
            [
                ...(data.connections || []).map((connection) =>
                    `${[connection.organization, connection.project].filter(Boolean).join("/")}: ${connection.myBoards?.boards?.length || 0} boards, ${connection.myWorkItems?.workItems?.length || 0} work items`),
            ].filter(Boolean).join(", "),
        );
    } catch (error) {
        homeLoaded = false;
        addLog("error", "Failed to load the Azure DevOps home overview.", error.message || "");
        showStatus(homeContent, error.message || "Failed to load your Azure DevOps work.", loadHome);
    }
}

// Home is an index, so its rows open their own tabs rather than replacing Home.
// The row's connection travels with it: Home can list two organizations, and a
// row has to be fetched from the one it came from.
// An organization-scope work item list spans projects, so the row carries the
// project the item actually lives in; the connection alone does not know it.
function openHomeWorkItem(workItem, connection) {
    return openEntry(entryForConnection(
        "work-item",
        workItem.id,
        connection || defaultEntryConnection(),
        { workItemProject: workItem.project || "" },
    ));
}

function openHomeBoard(board, connection) {
    return openEntry({
        ...entryForConnection("board", board.id, connection || defaultEntryConnection()),
        name: board.name || "Board",
    });
}

// Entries opened from a reference use the primary connection.
function defaultEntryConnection() {
    return currentConfig?.connections?.[0] || null;
}

function resetTabs() {
    workspaceController?.destroy();
    workspaceController = null;
    for (const tab of tabs) {
        tab.suggestions?.dispose();
        tab.draftWriter?.flush().catch(() => {});
        releaseBoardTab(tab);
        if (tab.panel !== homePanel) {
            tab.panel.remove();
        }
    }
    tabs = [];
    collapsedNavigationItems.clear();
    activeTabId = "";
    homePanel.hidden = true;
    tabPanels.replaceChildren();
}

// Paints a canvas-level message into whichever panel is actually reachable.
// Writing it into a hidden panel leaves the user with a blank pane.
function showCanvasStatus(message, retry) {
    const tab = activeTab();
    if (tab && tab.panel !== homePanel) {
        showStatus(tab.content, message, retry);
        return;
    }
    resetTabs();
    homeLoaded = false;
    createTab({ view: "home" }, { closable: false });
    activeTabId = tabs[0].id;
    renderTabBar();
    showActivePanel();
    showStatus(homeContent, message, retry);
}

// --- Connections -----------------------------------------------------------

// The picker's own state, kept here rather than in the view so the view can be
// patched without owning what the user has typed. The view is built once per
// open and returns a handle that patches it; rebuilding it on every change
// would destroy the field being typed in and swallow clicks on Save.
let connectionState = null;
let connectionPanelView = null;

function renderConnections() {
    if (!connectionState || !connectionPanelView) {
        return;
    }
    connectionPanelView.update({
        ...connectionState,
        connections: currentConfig?.connections || [],
        hasDefault: Boolean(currentConfig?.hasDefaultConnection),
    });
}

// Organizations come from the accounts API, which some tenants refuse; the
// picker keeps working on typed names in that case, so the failure is shown as
// a hint next to the field rather than as an error.
async function loadConnectionOrganizations() {
    try {
        const data = await request("/api/organizations");
        // The picker may have been closed while this was in flight, and its state
        // is gone with it.
        if (!connectionState) {
            return;
        }
        connectionState.organizations = (data.organizations || []).map((entry) => entry.name);
        connectionState.organizationsError = data.error || "";
    } catch (error) {
        if (!connectionState) {
            return;
        }
        connectionState.organizations = [];
        connectionState.organizationsError = error.message || "";
    }
    renderConnections();
}

// Project is optional; a failed lookup still allows typing a project name.
async function loadConnectionOptions() {
    const organization = connectionState.draft.organization;
    if (!organization) {
        connectionState.projects = [];
        renderConnections();
        return;
    }
    connectionState.loading = "options";
    renderConnections();
    const query = new URLSearchParams({ organization });
    const [projectResult] = await Promise.allSettled([
        request(`/api/projects?${query}`),
    ]);
    // A slower request must not overwrite options for an organization the user
    // has since changed to, or for a picker they have since closed.
    if (!connectionState || connectionState.draft.organization !== organization) {
        return;
    }
    connectionState.projects = projectResult.status === "fulfilled"
        ? (projectResult.value.projects || []).map((project) => project.name)
        : [];
    connectionState.loading = "";
    renderConnections();
}

function openConnectionPanel(connection) {
    const current = connection || currentConfig?.connections?.[0] || null;
    connectionState = {
        draft: {
            organization: current?.organization || "",
            project: current?.project || "",
            isDefault: Boolean(current?.isDefault),
        },
        organizations: [],
        organizationsError: "",
        projects: [],
        loadedOptionsFor: "",
        loading: "",
        error: "",
        saving: false,
        firstRun: !(currentConfig?.connections || []).length,
    };
    connectionPanel.hidden = false;
    connectionsButton.setAttribute("aria-expanded", "true");
    connectionPanelView = renderConnectionPanel(connectionPanel, {
        ...connectionState,
        connections: currentConfig?.connections || [],
        hasDefault: Boolean(currentConfig?.hasDefaultConnection),
    }, {
        onDraftChange: (patch) => {
            // Typing only updates state and patches the panel: the dependent
            // lists wait for the organization field to settle.
            connectionState.draft = { ...connectionState.draft, ...patch };
            connectionState.error = "";
            renderConnections();
        },
        onOrganizationCommitted: (organization) => {
            if (connectionState.loadedOptionsFor === organization) {
                return;
            }
            connectionState.loadedOptionsFor = organization;
            // A project from the previous organization is not a
            // valid choice in this one.
            connectionState.draft = { ...connectionState.draft, organization, project: "" };
            renderConnections();
            loadConnectionOptions();
        },
        onSave: saveConnection,
        onClearDefault: clearDefaultConnection,
        onCancel: closeConnectionPanel,
    });
    loadConnectionOrganizations();
    if (connectionState.draft.organization) {
        connectionState.loadedOptionsFor = connectionState.draft.organization;
        loadConnectionOptions();
    }
    // The panel claims to be a modal dialog, so focus moves into it rather than
    // staying on the footer control behind the overlay.
    (connectionPanel.querySelector("input, button") || connectionPanel).focus();
}

function closeConnectionPanel() {
    connectionState = null;
    connectionPanelView = null;
    connectionPanel.replaceChildren();
    connectionPanel.hidden = true;
    connectionsButton.setAttribute("aria-expanded", "false");
    connectionsButton.focus();
}

async function saveConnection() {
    // Read from the fields rather than the draft, so what the user can see in the
    // form is what gets saved even if an engine did not raise the event the field
    // listens for.
    const draft = { ...connectionState.draft, ...connectionPanelView.read() };
    connectionState.draft = draft;
    connectionState.saving = true;
    connectionState.error = "";
    renderConnections();
    try {
        await request("/api/connection", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(draft),
        });
        addLog("trace", "Saved the Azure DevOps connection.", [draft.organization, draft.project].filter(Boolean).join("/"));
        closeConnectionPanel();
        // The connection decides what every other request resolves against, so
        // the canvas is rebuilt rather than patched in place.
        await refresh();
    } catch (error) {
        // The panel stays open with the draft intact: a connection that was not
        // stored must not look like one that was, or the canvas would send the
        // user back to an empty picker with nothing to explain it. Unless the
        // user closed the panel while the save was in flight, in which case the
        // failure only reaches the log.
        addLog("error", "Failed to save the Azure DevOps connection.", error.message || "");
        if (!connectionState) {
            return;
        }
        connectionState.saving = false;
        connectionState.error = error.message || "Could not save the connection.";
        renderConnections();
    }
}

async function clearDefaultConnection() {
    connectionState.saving = true;
    connectionState.error = "";
    renderConnections();
    try {
        await request("/api/connection", { method: "DELETE" });
        addLog("trace", "Cleared the default Azure DevOps connection.");
        closeConnectionPanel();
        await refresh();
    } catch (error) {
        addLog("error", "Failed to clear the default Azure DevOps connection.", error.message || "");
        if (!connectionState) {
            return;
        }
        connectionState.saving = false;
        connectionState.error = error.message || "Could not clear the default connection.";
        renderConnections();
    }
}

async function refresh() {
    // Refresh discards every open tab, so an editor with unsaved text is confirmed
    // before anything is torn down.
    if (!confirmDiscard(tabs)) {
        return;
    }
    for (const tab of tabs) {
        if (tab.dirty) discardDraft(tab);
        await tab.draftWriter?.flush().catch(() => {});
    }
    restoringWorkspace = true;
    window.clearTimeout(preferencesTimer);
    refreshButton.disabled = true;
    addLog("trace", "Refreshing canvas.");
    showStartupLoading("Preparing Azure DevOps", "Checking connection and sign-in.");
    try {
        const configResponse = await loadConfig();
        await finishSilentAuthentication(configResponse.authProcess);
        homeLoaded = false;
        if (!currentConfig.auth?.isAuthenticated) {
            showSignInSplash();
            return;
        }
        showCanvas();
        // Refresh deliberately starts over: every open tab is discarded and the
        // canvas is rebuilt from the current config. Tabs are user-managed state,
        // so this is a real cost, but "refresh" here means reset rather than the
        // browser's reload-this-tab, and the footer control is the way back to a
        // known-good canvas when something is stale or wrong.
        resetTabs();

        const isWorkItem = Boolean(currentConfig.workItemReference);
        if (!(currentConfig.connections || []).length && !isWorkItem) {
            viewBar.hidden = true;
            resetTabs();
            openConnectionPanel();
            return;
        }
        closeConnectionPanel();
        viewBar.hidden = false;

        const home = createTab({ view: "home" }, { closable: false });
        activeTabId = home.id;
        showLoading(
            homeContent,
            "Loading your Azure DevOps work",
            enabledFeatures.boards
                ? "Fetching favorite boards and work items."
                : "Fetching work items.",
            { className: "home-loading-state" },
        );
        renderTabBar();
        showActivePanel();

        if (isWorkItem) {
            // Keep Home behind a directly opened work item so linked items
            // have a stable place to return to.
            // The id lives in the canvas input, so the server resolves it.
            await openEntry({ ...entryForConnection("work-item", 0, defaultEntryConnection()), current: true });
            restoringWorkspace = false;
            renderTabBar();
            return;
        }
        await restoreOpenViews();
        renderTabBar(); showActivePanel();
        await applyTab(activeTab());
    } catch (error) {
        addLog("error", "Canvas refresh failed.", error.message || "");
        showCanvas();
        viewBar.hidden = false;
        showCanvasStatus(error.message || "Failed to load configuration.", refresh);
    } finally {
        refreshButton.disabled = false;
    }
}

async function refreshActiveTab() {
    const tab = activeTab();
    if (!tab) {
        return refresh();
    }
    if (tab.busy || tab.pendingUploads) return;
    refreshButton.disabled = true;
    addLog("trace", `Refreshing ${tabTitle(tab)}.`);
    try {
        const configResponse = await loadConfig();
        await finishSilentAuthentication(configResponse.authProcess);
        if (!currentConfig.auth?.isAuthenticated) {
            showSignInSplash();
            return;
        }
        showCanvas();
        const entry = tabEntry(tab);
        if (entry.view === "home") {
            if (workspaceController) await workspaceController.refresh();
            else await loadHome();
            return;
        }
        tab.token += 1;
        const token = tab.token;
        if (entry.view === "board") {
            if (!confirmDiscard([tab])) return;
            await loadBoardIntoTab(tab, token);
        } else {
            if (tab.data) await checkWorkItemUpdates(tab);
            else await loadWorkItemIntoTab(tab, entry, token);
        }
        renderTabBar();
        showActivePanel();
    } catch (error) {
        addLog("error", `Failed to refresh ${tabTitle(tab)}.`, error.message || "");
        if (tab.dirty || tab.editMode) {
            tab.draftStatus = `Refresh failed: ${error.message}`; renderDraftNotice(tab);
        } else showStatus(tab.content, error.message || `Failed to refresh ${tabTitle(tab)}.`, refreshActiveTab);
    } finally {
        refreshButton.disabled = false;
    }
}

async function backgroundRefresh() {
    if (backgroundRefreshPending || document.hidden || canvasContent.hidden || connectionState || !currentConfig?.auth?.isAuthenticated) return;
    const tab = activeTab();
    if (!tab || tab.busy || tab.pendingUploads) return;
    backgroundRefreshPending = true;
    try {
        if (tab.entry.view === "home" && workspaceController) await workspaceController.refresh({ background: true });
        else if (tab.entry.view === "work-item") await checkWorkItemUpdates(tab);
    } catch (error) { addLog("error", "Background refresh failed; existing work is preserved.", error.message); }
    finally { backgroundRefreshPending = false; }
}
window.setInterval(backgroundRefresh, 30000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) backgroundRefresh(); });
window.addEventListener("pagehide", () => { for (const tab of tabs) tab.draftWriter?.flush().catch(() => {}); });
window.addEventListener("beforeunload", event => {
    if (tabs.some(tab => tab.draftStatus?.startsWith("Saving") || tab.draftStatus?.startsWith("Draft not saved"))) {
        for (const tab of tabs) tab.draftWriter?.flush().catch(() => {});
        event.preventDefault(); event.returnValue = "";
    }
});

showLogsButton.addEventListener("click", () => {
    logsPanel.hidden = !logsPanel.hidden;
    showLogsButton.textContent = logsPanel.hidden ? "show logs" : "hide logs";
    showLogsButton.setAttribute("aria-expanded", String(!logsPanel.hidden));
    if (!logsPanel.hidden) renderLogs();
});
async function updateFeatureFlags() {
    enabledFeatures = normalizeFeatureFlags({
        boards: boardsFeatureFlag?.checked,
        delegation: delegationFeatureFlag?.checked,
    });
    const data = await request("/api/feature-flags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(enabledFeatures),
    });
    enabledFeatures = normalizeFeatureFlags(data.featureFlags);
    if (currentConfig) currentConfig.featureFlags = enabledFeatures;
    homeLoaded = false;
    await loadHome();
    const tab = activeTab();
    if (tab && tabEntry(tab)?.view === "work-item" && tab.data) {
        renderWorkItemTab(tab);
    }
    if (boardWorkItemDrawerState?.data) {
        renderBoardWorkItemDrawer();
    }
}
boardsFeatureFlag?.addEventListener("change", () => {
    updateFeatureFlags().catch((error) => addLog("error", "Failed to update preview features.", error.message || ""));
});
delegationFeatureFlag?.addEventListener("change", () => {
    updateFeatureFlags().catch((error) => addLog("error", "Failed to update preview features.", error.message || ""));
});
copyLogsButton.addEventListener("click", async () => {
    try {
        await navigator.clipboard.writeText(logs.map((entry) => `[${entry.time}] ${entry.level.toUpperCase()}: ${entry.message}${entry.details ? `\n${entry.details}` : ""}`).join("\n\n") || "No logs yet.");
        copyLogsStatus.textContent = "Copied.";
    } catch (error) {
        copyLogsStatus.textContent = "Copy failed.";
        addLog("error", "Failed to copy logs.", error.message || "");
    }
});
refreshButton.addEventListener("click", refreshActiveTab);
connectionsButton.addEventListener("click", () => {
    // With nothing configured the picker is the canvas, so the control focuses it
    // rather than closing it onto a blank pane.
    if (connectionState && !connectionState.firstRun) {
        closeConnectionPanel();
        return;
    }
    openConnectionPanel();
});
// Escape dismisses the dialog, except on first run where closing it would leave
// a blank canvas with nothing configured.
connectionPanel.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && connectionState && !connectionState.firstRun) {
        event.preventDefault();
        closeConnectionPanel();
    }
});
signInMicrosoftButton.addEventListener("click", () => startAuth("microsoft"));
if (AGENCY_AUTH_ENABLED) {
    signInAgencyButton.addEventListener("click", () => startAuth("agency"));
}
signOutButton.addEventListener("click", signOut);
// Open views can also be closed with the middle mouse button.
viewTabs.addEventListener("auxclick", (event) => {
    if (event.button !== 1) {
        return;
    }
    const item = event.target.closest(".view-tab");
    if (item?.dataset.tabId) {
        event.preventDefault();
        closeTab(item.dataset.tabId);
    }
});

addLog("trace", "Azure DevOps canvas loaded.");
refresh().catch((error) => addLog("error", "Canvas startup failed.", error.message || ""));
