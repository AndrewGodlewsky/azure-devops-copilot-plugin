import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

// These extensions ship without node_modules, so jsdom is not guaranteed to be
// present. Skip rather than fail when it is missing, and run with:
//   npm install jsdom && node --test tabs.test.mjs
let JSDOM;
try {
    ({ JSDOM } = await import("jsdom"));
} catch {
    JSDOM = null;
}
const describeDom = { skip: JSDOM ? false : "jsdom is not installed" };

const html = readFileSync(new URL("./ui/index.html", import.meta.url), "utf8");
const styles = readFileSync(new URL("./ui/styles.css", import.meta.url), "utf8");
const allPreviewFeatures = { boards: true, delegation: true };
const windows = [];
test.afterEach(() => { for (const window of windows.splice(0)) window.close(); });

// Drives the real app.mjs against a real DOM through the same controls a user
// clicks. Nothing is exported from the app for testing.
function makeFetch(state) {
    const connection = {
        source: "last-used",
        organization: state.organization || "example",
        project: state.project === undefined ? "project" : state.project,
        isDefault: false,
        requiresProject: state.project === "",
    };
    return async (url, options = {}) => {
        const path = String(url);
        state.requests = [...(state.requests || []), { path, method: options.method || "GET" }];
        const json = (body) => ({ ok: true, json: async () => body });
        if (path.includes("/api/config")) {
            state.configRequests = (state.configRequests || 0) + 1;
            const response = json({
                apiNonce: "n",
                authProcess: state.configAuthProcess || null,
                config: {
                    auth: state.configAuth || {
                        isAuthenticated: !state.configAuthProcess,
                        authType: state.configAuthProcess ? "none" : "azureauth",
                        azureAuthDiscovery: { selected: "x" },
                    },
                    connections: state.connections === undefined ? state.homeConnections || [connection] : state.connections,
                    hasDefaultConnection: Boolean(state.hasDefaultConnection),
                    project: "Project",
                    workItemReference: Boolean(state.workItemReference),
                    azureDevOpsMcpAvailable: Boolean(state.azureDevOpsMcpAvailable),
                    extensionVersion: "test",
                    featureFlags: state.featureFlags || {},
                },
            });
            return state.holdConfig ? state.holdConfig.then(() => response) : response;
        }
        if (path.includes("/api/auth/status")) {
            state.authStatusRequests = (state.authStatusRequests || 0) + 1;
            const response = json(state.authStatus || {
                authProcess: { provider: "azureauth", mode: "silent", status: "succeeded", output: "Authenticated with AzureAuth." },
                auth: { isAuthenticated: true, authType: "azureauth", azureAuthDiscovery: { selected: "x" } },
            });
            return state.holdAuthStatus ? state.holdAuthStatus.then(() => response) : response;
        }
        if (path.includes("/api/current-work-item")) {
            state.currentWorkItemCalls = (state.currentWorkItemCalls || 0) + 1;
            return json({ workItem: { id: 900, rev: 1, type: "Bug", title: "Referenced item", relations: state.relations || [] } });
        }
        if (path.includes("/api/workspace/preferences")) {
            if (options.method === "PATCH") state.preferences = { ...state.preferences, ...JSON.parse(options.body) };
            return json({ preferences: state.preferences || {} });
        }
        const params = new URL(path, "http://localhost").searchParams;
        const selected = (state.homeConnections || [connection]).find(entry => entry.organization === params.get("organization") && (entry.project || "") === (params.get("project") || "")) || connection;
        const workItems = () => (selected.workItems || state.homeWorkItems || []).map(entry => {
            const [id, project] = Array.isArray(entry) ? entry : [entry, selected.project || "project"];
            return { id, rev: 1, project, title: `WI ${id}`, type: "Task", state: "Active", ...state.workItemsById?.[id] };
        });
        if (path.includes("/api/workspace/metadata")) return json({ projects: (state.projects || ["project", "Alpha", "Beta"]).map(name => ({ id: name, name })), types: [{ name: "Task", states: [{ name: "Active" }, { name: "Closed" }] }], teams: [{ id: "team", name: "Project Team" }] });
        if (path.includes("/api/workspace/dashboard")) {
            state.homeRequests = (state.homeRequests || 0) + 1;
            if (state.homeError) return { ok: false, json: async () => ({ message: state.homeError }) };
            const response = json({ current: { workItems: workItems() }, blocked: { workItems: [] }, unfinished: { workItems: [] }, completed: { workItems: [] } });
            return state.holdHome ? state.holdHome.then(() => response) : response;
        }
        if (path.includes("/api/workspace/items")) return json({ workItems: workItems(), count: workItems().length });
        if (path.includes("/api/workspace/boards")) return json({ boards: state.boards || [{ id: "stories", name: "Stories" }, { id: "features", name: "Features" }] });
        if (path.includes("/api/workspace/board")) {
            state.boardRequests = [...(state.boardRequests || []), path];
            if (state.boardError) return { ok: false, json: async () => ({ message: state.boardError }) };
            const response = json({ columns: [{ id: "new", name: "New" }, { id: "active", name: "Active" }], workItems: workItems().map(item => ({ ...item, columnId: "active" })) });
            return state.holdBoard ? state.holdBoard.then(() => response) : response;
        }
        if (/\/api\/work-items\/\d+\/draft/.test(path)) {
            const id = path.match(/work-items\/(\d+)/)[1];
            state.drafts ||= {};
            if (options.method === "PUT") state.drafts[id] = JSON.parse(options.body);
            if (options.method === "DELETE") delete state.drafts[id];
            return json({ draft: state.drafts[id] || null });
        }
        if (path.includes("/api/organizations")) {
            return json({ organizations: (state.organizations || []).map((name) => ({ name, id: name })), error: "" });
        }
        if (path.includes("/api/projects")) {
            return json({ projects: (state.projects || []).map((name) => ({ name, id: name })) });
        }
        if (path.includes("/api/connection")) {
            state.savedConnections = [...(state.savedConnections || []), options.body ? JSON.parse(options.body) : { method: options.method }];
            if (state.connectionSaveError) {
                return { ok: false, json: async () => ({ error: "azure_devops_connection_write_failed", message: state.connectionSaveError }) };
            }
            state.connections = [{ ...connection, ...JSON.parse(options.body || "{}"), source: "last-used" }];
            return json({ connections: state.connections });
        }
        if (path.includes("/api/feature-flags")) {
            state.featureFlags = JSON.parse(options.body || "{}");
            return json({ featureFlags: state.featureFlags });
        }
        if (path.includes("/api/identities")) {
            state.identityQueries = [...(state.identityQueries || []), path];
            return json({ identities: state.identities || [], error: state.identityError || "" });
        }
        if (/\/api\/work-items\/\d+\/send-to-chat/.test(path)) {
            state.chatSends = [...(state.chatSends || []), { path, method: options.method }];
            await state.holdChatSend;
            return state.chatError ? { ok: false, json: async () => ({ message: state.chatError }) } : json({ ok: true });
        }
        const wiDelegation = path.match(/\/api\/work-items\/(\d+)\/delegate/);
        if (wiDelegation) {
            if (!state.featureFlags?.delegation) {
                return {
                    ok: false,
                    json: async () => ({
                        error: "azure_devops_delegation_disabled",
                        message: "Work item delegation is disabled.",
                    }),
                };
            }
            state.workItemDelegations = [...(state.workItemDelegations || []), {
                id: Number(wiDelegation[1]),
                path,
                body: JSON.parse(options.body || "{}"),
            }];
            return json(state.workItemDelegationResult || { ok: true, state: "Active" });
        }
        const wiUpdate = path.match(/\/api\/work-items\/(\d+)(?:\?|$)/);
        if (wiUpdate && options.method === "PATCH") {
            const id = Number(wiUpdate[1]);
            const body = JSON.parse(options.body);
            state.workItemUpdates = [...(state.workItemUpdates || []), { id, path, body }];
            if (state.workItemsById?.[id]?.rev && body.rev !== state.workItemsById[id].rev) return {
                ok: false, status: 400, json: async () => ({ error: "azure_devops_work_item_out_of_date", message: "Revision conflict" }),
            };
            const title = body.fields.find(field => field.name === "System.Title")?.value;
            state.workItemsById ||= {};
            state.workItemsById[id] = { ...state.workItemsById[id], rev: body.rev + 1, ...(title === undefined ? {} : { title }) };
            const response = json({ workItem: { id, rev: 2, type: "Task", title: `WI ${id}`, relations: [], ...state.workItemsById[id] } });
            return state.holdWorkItemUpdate ? state.holdWorkItemUpdate.then(() => response) : response;
        }
        const wiAttachment = path.match(/\/api\/work-items\/(\d+)\/attachments/);
        if (wiAttachment) {
            const id = Number(wiAttachment[1]);
            state.workItemsById ||= {};
            state.workItemsById[id] = { ...state.workItemsById[id], rev: (state.workItemsById[id]?.rev || 1) + 1 };
            state.attachments = [...(state.attachments || []), { id, path, file: options.body }];
            return json({ attachment: { url: "https://dev.azure.com/example/project/_apis/wit/attachments/fixture-file", fileName: options.body.name } });
        }
        const wiComment = path.match(/\/api\/work-items\/(\d+)\/comments/);
        if (wiComment) {
            state.workItemComments = [...(state.workItemComments || []), {
                id: Number(wiComment[1]),
                method: options.method,
                body: options.body ? JSON.parse(options.body) : {},
            }];
            if (state.workItemCommentError) {
                return { ok: false, json: async () => ({ error: "azure_devops_request_failed", message: state.workItemCommentError }) };
            }
            const response = json({
                workItem: {
                    id: Number(wiComment[1]),
                    rev: 2,
                    type: "Task",
                    title: `WI ${wiComment[1]}`,
                    ...state.workItemsById?.[Number(wiComment[1])],
                    commentCount: 1,
                    discussion: [{ id: 1, author: "Me", text: JSON.parse(options.body).content, format: "markdown" }],
                    relations: state.relations || [],
                },
            });
            return state.holdWorkItemComment ? state.holdWorkItemComment.then(() => response) : response;
        }
        const wi = path.match(/\/api\/work-items\/(\d+)\/details/);
        if (wi) {
            const id = Number(wi[1]);
            state.workItemRequests = [...(state.workItemRequests || []), path];
            if (state.workItemError) {
                return { ok: false, json: async () => ({
                    error: state.workItemErrorCode || "azure_devops_request_failed",
                    message: state.workItemError,
                }) };
            }
            const response = json({
                workItem: {
                    id,
                    rev: 1,
                    type: "Task",
                    title: `WI ${wi[1]}`,
                    commentCount: 0,
                    discussion: [],
                    templateSections: state.workItemSections || [],
                    relations: state.relations || [],
                    ...state.workItemsById?.[id],
                },
            });
            const gate = state.holdWorkItems?.[id];
            return gate ? gate.then(() => response) : response;
        }
        throw new Error(`unexpected fetch: ${path}`);
    };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 40));
function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

async function boot(state = {}) {
    const dom = new JSDOM(html, { url: "http://localhost/", pretendToBeVisual: true });
    const { window } = dom;
    windows.push(window);
    // app.mjs calls the bare global fetch, and Node's rejects relative URLs.
    const fetchImpl = makeFetch(state);
    window.fetch = fetchImpl;
    globalThis.fetch = fetchImpl;
    state.scrolls = [];
    window.scrollTo = (_x, y) => { state.scrolls.push(y); };
    globalThis.window = window;
    globalThis.document = window.document;
    globalThis.Headers = window.Headers;
    globalThis.Node = window.Node;
    globalThis.DOMParser = window.DOMParser;
    Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });

    await import(new URL(`./ui/app.mjs?v=${Math.random()}`, import.meta.url).href);
    await settle();
    return { window, state };
}

const bar = (w) => w.document.getElementById("viewTabs");
// Lifecycle assertions keep creation order; sidebar hierarchy/order has separate coverage.
const allTabEls = (w) => [...bar(w).querySelectorAll(".view-tab[data-tab-id]")]
    .sort((a, b) => Number(a.dataset.tabId.split("-")[1]) - Number(b.dataset.tabId.split("-")[1]));
const tabEls = allTabEls;
const shortTitle = (el) => el.querySelector(".view-tab-label").getAttribute("aria-label").split(":")[0];
const titles = (w) => tabEls(w).map(shortTitle);
const allTitles = titles;
const activeTitle = (w) => {
    const row = bar(w).querySelector(".view-tab.active");
    return row ? shortTitle(row) : undefined;
};
const visiblePanels = (w) => [...w.document.querySelectorAll("#homePanel, #tabPanels > .tab-panel")].filter((p) => !p.hidden);

test("send to chat preserves drafts, scopes the request and prevents pending duplicate sends", describeDom, async (t) => {
    const gate = deferred();
    const { window, state } = await boot({ homeWorkItems: [42], workItemsById: { 42: { project: "Southwind" } }, holdChatSend: gate.promise });
    t.after(() => window.close());
    assert.equal(window.document.querySelector(".work-item-send-chat"), null);
    await openFromHome(window, 42);
    let panel = visiblePanels(window)[0];
    panel.querySelector('[aria-label="Edit this work item"]').click();
    await settle();
    panel = visiblePanels(window)[0];
    const input = panel.querySelector('[aria-label="Assigned to"]');
    input.value = "alex@example.com";
    input.dispatchEvent(new window.Event("input"));
    const send = panel.querySelector(".work-item-send-chat");
    assert.ok(send);
    assert.match(send.title, /saved/i);
    send.click(); send.click();
    assert.equal(send.disabled, true);
    assert.equal(state.chatSends.length, 1);
    assert.deepEqual(state.chatSends[0], { path: "/api/work-items/42/send-to-chat?organization=example&project=project&workItemProject=Southwind", method: "POST" });
    gate.resolve(); await settle();
    assert.equal(send.disabled, false);
    assert.match(panel.querySelector(".work-item-chat-status").textContent, /sent.*saved/i);
    assert.equal(panel.querySelector('[aria-label="Assigned to"]'), input);
    assert.equal(input.value, "alex@example.com");
    assert.equal(state.workItemUpdates, undefined);
    state.chatError = "Could not confirm delivery. Check the chat before trying again.";
    send.click(); await settle();
    assert.equal(send.disabled, false);
    assert.match(panel.querySelector('.work-item-chat-status[role="alert"]').textContent, /Check the chat/);
    assert.equal(input.value, "alex@example.com");
});

test("send to chat pending and completion survive switching into edit mode", describeDom, async (t) => {
    const gate = deferred();
    const { window, state } = await boot({ homeWorkItems: [42], holdChatSend: gate.promise });
    t.after(() => window.close());
    await openFromHome(window, 42);
    const panel = visiblePanels(window)[0];
    panel.querySelector(".work-item-send-chat").click();
    panel.querySelector('[aria-label="Edit this work item"]').click();
    await settle();
    const send = panel.querySelector(".work-item-send-chat");
    assert.equal(send.disabled, true);
    send.click();
    assert.equal(state.chatSends.length, 1);
    gate.resolve(); await settle();
    assert.equal(send.disabled, false);
    assert.match(panel.querySelector(".work-item-chat-status").textContent, /Sent to chat/);
});

test("attachment app registration: work-item images use the nonce proxy after sanitization", describeDom, async (t) => {
    const source = "https://dev.azure.com/fabrikam/4e1c4e8f-0c57-4a25-9a4e-2e2c2f4d8a55/_apis/wit/attachments/06f5932c-aa2f-4545-9764-8546bec98914?fileName=image.png";
    const other = "https://example.com/image.png";
    const namedProject = source.replace("4e1c4e8f-0c57-4a25-9a4e-2e2c2f4d8a55", "Project");
    const { window } = await boot({
        homeWorkItems: [400],
        workItemSections: [{
            title: "Description",
            fields: [{
                name: "Description",
                field: "System.Description",
                isHtml: true,
                value: `<img src="${source}" onerror="alert(1)"><img src="${other}"><img src="${namedProject}">`,
            }],
        }],
    });
    t.after(() => window.close());
    await openFromHome(window, 400);
    const images = [...window.document.querySelectorAll(".section-field-value img")];
    assert.equal(images.length, 3);
    assert.equal(images[0].getAttribute("src"), `/api/attachment?${new URLSearchParams({ organization: "example", project: "project", url: source, nonce: "n" })}`);
    assert.equal(new URL(images[0].src).origin, window.location.origin);
    assert.equal(images[0].hasAttribute("onerror"), false);
    assert.equal(images[1].src, other);
    assert.equal(images[2].src, namedProject);
});

test("attachment URLs retain each rendering tab's connection across organizations and previews", describeDom, async (t) => {
    const source = "https://dev.azure.com/fabrikam/4e1c4e8f-0c57-4a25-9a4e-2e2c2f4d8a55/_apis/wit/attachments/06f5932c-aa2f-4545-9764-8546bec98914?fileName=image.png";
    const { window } = await boot({
        featureFlags: { boards: true },
        homeConnections: [
            { organization: "contoso", project: "Widgets", workItems: [300] },
            { organization: "fabrikam", project: "Boxes", workItems: [400] },
        ],
        workItemSections: [{
            title: "Description",
            fields: [{
                name: "Description",
                field: "System.Description",
                format: "markdown",
                value: `![attachment](${source})`,
            }],
        }],
    });
    t.after(() => window.close());
    const assertConnection = (image, organization, project) => {
        assert.ok(image);
        const url = new URL(image.src);
        assert.equal(url.pathname, "/api/attachment");
        assert.equal(url.searchParams.get("organization"), organization);
        assert.equal(url.searchParams.get("project"), project);
        assert.equal(url.searchParams.get("nonce"), "n");
        assert.equal(url.searchParams.get("url"), source);
    };
    await chooseWorkspaceConnection(window, "fabrikam");
    await openFromHome(window, 400);
    assertConnection(window.document.querySelector(".tab-panel:not([hidden]) .section-field-value img"), "fabrikam", "Boxes");
    await chooseWorkspaceConnection(window, "contoso");
    await openFromHome(window, 300);
    assertConnection(window.document.querySelector(".tab-panel:not([hidden]) .section-field-value img"), "contoso", "Widgets");
    await chooseWorkspaceConnection(window, "fabrikam");
    await openFromHome(window, 400);
    const edit = window.document.querySelector(".tab-panel:not([hidden]) .inline-edit");
    assert.ok(edit);
    edit.click();
    await settle();
    const preview = [...window.document.querySelectorAll(".tab-panel:not([hidden]) button")]
        .find((button) => button.textContent === "Preview");
    assert.ok(preview);
    preview.click();
    assertConnection(window.document.querySelector(".tab-panel:not([hidden]) .editor-preview img"), "fabrikam", "Boxes");
});

function findHomeLink(w, label) {
    return [...w.document.querySelectorAll("#homeContent .workspace-item-link")]
        .find(node => node.getAttribute("aria-label")?.includes(` ${label}:`));
}
async function openFromHome(w, label) {
    const link = findHomeLink(w, label);
    assert.ok(link, `no Home row for ${label}`);
    link.click();
    await settle();
}

async function showWorkspace(window, view) {
    if (view === "home") bar(window).querySelector('.view-tab[data-tab-id] .view-tab-label').click();
    else window.document.querySelector(`[data-workspace-view="${view}"]`).click();
    await settle();
}

async function chooseWorkspaceConnection(window, name) {
    await showWorkspace(window, "home");
    const select = window.document.querySelector('.workspace-scope [aria-label="Organization connection"]');
    const option = [...select.options].find(option => option.textContent.startsWith(name));
    assert.ok(option, `no connection for ${name}`);
    select.value = option.value;
    select.dispatchEvent(new window.Event("change"));
    await settle();
}

async function clickTab(w, index) {
    tabEls(w)[index].querySelector(".view-tab-label").click();
    await settle();
}

async function closeTab(w, index) {
    const close = tabEls(w)[index].querySelector(".view-tab-close");
    assert.ok(close, `tab ${index} has no close control`);
    close.click();
    await settle();
}

test("startup paints a smooth loading spinner before configuration resolves", describeDom, async () => {
    const config = deferred();
    const { window } = await boot({ holdConfig: config.promise });

    const startup = window.document.getElementById("startupSplash");
    assert.equal(startup.hidden, false);
    assert.equal(startup.getAttribute("aria-busy"), "true");
    assert.equal(window.document.getElementById("startupTitle").textContent, "Preparing Azure DevOps");
    assert.ok(startup.querySelector(".loading-spinner-large .loading-spinner-svg"));
    assert.ok(startup.querySelector(".loading-spinner-track"));
    assert.ok(startup.querySelector(".loading-spinner-arc"));
    assert.equal(window.document.getElementById("signInSplash").hidden, true);
    assert.equal(window.document.getElementById("canvasContent").hidden, true);
    assert.match(styles, /@keyframes loading-spinner-rotate/);
    assert.match(styles, /@keyframes loading-spinner-dash/);
    assert.match(styles, /prefers-reduced-motion:\s*reduce/);

    config.resolve();
    await settle();
});

test("silent AzureAuth has a truthful animated startup state without flashing sign-in", describeDom, async () => {
    const auth = deferred();
    const { window, state } = await boot({
        configAuthProcess: {
            provider: "azureauth",
            mode: "silent",
            status: "running",
            output: "Authenticating with AzureAuth.",
        },
        holdAuthStatus: auth.promise,
    });

    assert.equal(window.document.getElementById("startupTitle").textContent, "Signing in");
    assert.equal(window.document.getElementById("startupDetail").textContent, "Restoring the Azure DevOps session.");
    assert.ok(window.document.querySelector("#startupSplash .loading-spinner-svg"));
    assert.equal(window.document.getElementById("signInSplash").hidden, true);
    assert.equal(window.document.getElementById("canvasContent").hidden, true);
    assert.equal(state.authStatusRequests, 1);

    auth.resolve();
    await settle();
    assert.equal(window.document.getElementById("startupSplash").hidden, true);
    assert.equal(window.document.getElementById("signInSplash").hidden, true);
    assert.equal(window.document.getElementById("canvasContent").hidden, false);
    assert.deepEqual(titles(window), ["Home"]);
});

test("failed silent AzureAuth ends at the sign-in chooser", describeDom, async () => {
    const { window, state } = await boot({
        configAuthProcess: {
            provider: "azureauth",
            mode: "silent",
            status: "running",
            output: "Authenticating with AzureAuth.",
        },
        authStatus: {
            authProcess: {
                provider: "azureauth",
                mode: "silent",
                status: "failed",
                output: "Automatic AzureAuth sign-in was unavailable.",
            },
            auth: {
                isAuthenticated: false,
                authType: "none",
                azureAuthDiscovery: { selected: "x" },
            },
        },
    });

    assert.equal(window.document.getElementById("startupSplash").hidden, true);
    assert.equal(window.document.getElementById("signInSplash").hidden, false);
    assert.equal(window.document.getElementById("canvasContent").hidden, true);
    assert.equal(window.document.getElementById("signInAgencyButton").hidden, true);
    assert.equal(
        window.document.getElementById("signInAgencyButton").textContent,
        "Agency (AzureAuth)",
    );
    assert.doesNotMatch(
        window.document.getElementById("authOutput").textContent,
        /canvas|azureauth|saved connection state/i,
    );

    window.document.getElementById("signInMicrosoftButton").click();
    assert.equal(
        window.document.getElementById("authOutput").textContent,
        "Complete sign-in in the browser, then return here.",
    );
    assert.doesNotMatch(
        window.document.getElementById("authOutput").textContent,
        /provider|status|canvas|azureauth|saved connection state|\byou(?:r|'re)?\b/i,
    );
});

test("Home starts as the visible, stable first tab", describeDom, async () => {
    const { window } = await boot();
    assert.deepEqual(titles(window), ["Home"]);
    assert.deepEqual(allTitles(window), ["Home"]);
    assert.equal(bar(window).hidden, false);
    assert.equal(visiblePanels(window).length, 1);
});

test("Boards startup, connections, navigation, editing, and comments require no Repos UI or requests", describeDom, async (t) => {
    const { window, state } = await boot({
        featureFlags: { boards: true },
        homeWorkItems: [400],
        workItemsById: {
            400: { type: "User Story", title: "Prepare widgets", relations: [{ name: "Children", links: [
                { id: 501, kind: "work-item", label: "Task 501", title: "Build widget", state: "Active" },
            ] }] },
            501: { type: "Task", title: "Build widget", rev: 3 },
        },
    });
    t.after(() => window.close());
    const assertNoRepos = () => {
        assert.equal(window.document.querySelector(".home-current-session, .home-pr-row, .home-new-branch, .home-pipeline-row, .pr-summary, .view-tab-branch, #setupWarning"), null);
        assert.doesNotMatch(window.document.getElementById("homeContent").textContent, /pull requests?|pipelines?|repositories|current branch/i);
        assert.deepEqual(state.requests.filter(({ path }) => /pull-requests?|repositories|pipelines?|new-session-branch|\/_apis\/git\//i.test(path)), []);
    };
    assert.deepEqual(sectionTitles(window), ["My current work", "Blocked work", "Parents with unfinished work", "Recently completed"]);
    assertNoRepos();

    window.document.getElementById("connectionsButton").click();
    await settle();
    assert.deepEqual([...panel(window).querySelectorAll(".connection-field-label")].map(node => node.textContent), ["Organization", "Project"]);
    assert.doesNotMatch(panel(window).textContent, /repository|pull requests?|pipeline/i);
    [...panel(window).querySelectorAll("button")].find(button => button.textContent === "Cancel").click();
    await settle();

    await openFromHome(window, 400);
    bar(window).querySelector(".navigation-children .view-tab-label").click();
    await settle();
    assert.equal(activeTitle(window), "Task 501");
    visiblePanels(window)[0].querySelector(".work-item-title-row .inline-edit").click();
    const input = visiblePanels(window)[0].querySelector(".work-item-title-edit input");
    input.value = "Build accessible widget";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    visiblePanels(window)[0].querySelector(".editor-save").click();
    await settle();
    assert.deepEqual(state.workItemUpdates[0].body, {
        rev: 3,
        fields: [{ name: "System.Title", value: "Build accessible widget", isHtml: false }],
    });
    assert.equal(visiblePanels(window)[0].querySelector(".work-item-title").textContent, "Build accessible widget");

    const composer = visiblePanels(window)[0].querySelector(".work-item-discussion > .comment-composer");
    composer.querySelector(".comment-composer-body").textContent = "Widget is ready for review.";
    composer.querySelector(".comment-submit").click();
    await settle();
    assert.deepEqual(state.workItemComments[0], {
        id: 501, method: "POST", body: { content: "Widget is ready for review." },
    });
    assert.match(visiblePanels(window)[0].querySelector(".work-item-discussion").textContent, /Widget is ready for review/);
    assert.equal(bar(window).querySelectorAll(".navigation-children .view-tab[data-tab-id]").length, 1);
    assertNoRepos();
});

test("native board selection stays inside the workspace and preserves open item views", describeDom, async () => {
    const { window, state } = await boot({ homeWorkItems: [42] });
    await openFromHome(window, 42);
    const itemPanel = visiblePanels(window)[0];
    await showWorkspace(window, "board");
    assert.equal(window.document.querySelector(".workspace-heading").textContent, "Board");
    assert.deepEqual([...window.document.querySelectorAll('.workspace-scope [aria-label="Board"] option')].map(option => option.textContent), ["Stories", "Features"]);
    assert.deepEqual([...window.document.querySelectorAll(".workspace-board-column h2")].map(node => node.textContent), ["New", "Active"]);
    assert.equal(window.document.querySelector("iframe"), null);
    assert.match(state.boardRequests.at(-1), /organization=example&project=project&workItemProject=project&team=team&boardId=stories/);
    const board = window.document.querySelector('.workspace-scope [aria-label="Board"]');
    board.value = "features";
    board.dispatchEvent(new window.Event("change"));
    await settle();
    assert.match(state.boardRequests.at(-1), /boardId=features/);
    assert.deepEqual(titles(window), ["Home", "Task 42"]);
    await openFromHome(window, 42);
    assert.equal(visiblePanels(window)[0], itemPanel);
    assert.equal(titles(window).length, 2, "the native board reuses the open item");
    await closeTab(window, 1);
    assert.equal(window.document.querySelector(".workspace-heading").textContent, "Board");
    assert.equal(window.document.querySelector('[data-workspace-view="board"]').getAttribute("aria-current"), "page");
    assert.deepEqual(state.requests.filter(({ path }) => /api\/boards\/open|^\/boards\//.test(path)), []);
});

test("Home item links are keyboard accessible and delegation errors remain inside item details", describeDom, async () => {
    const { window, state } = await boot({ featureFlags: allPreviewFeatures, homeWorkItems: [[42, "Widgets"]] });
    const link = findHomeLink(window, 42);
    assert.equal(link.tagName, "BUTTON");
    assert.equal(link.getAttribute("aria-label"), "Open Task 42: WI 42");
    link.focus();
    assert.equal(window.document.activeElement, link);
    link.click();
    await settle();
    const runDelegation = async result => {
        state.workItemDelegationResult = result;
        const menu = visiblePanels(window)[0].querySelector(".work-item-delegate-menu");
        menu.querySelector(".primer-action-menu-trigger").click();
        menu.querySelector('[data-component="ActionList.Item"]').click();
        await settle();
        return visiblePanels(window)[0].querySelector(".work-item-delegation-status").textContent;
    };
    assert.match(await runDelegation({ ok: false, error: "Delegation unavailable" }), /Delegation unavailable/);
    assert.match(await runDelegation({ ok: true, state: "Active" }), /Delegated to a local Copilot session/);
    assert.equal(state.workItemDelegations.at(-1).id, 42);
    assert.match(state.workItemDelegations.at(-1).path, /workItemProject=Widgets/);
    assert.deepEqual(state.workItemDelegations.at(-1).body, { mode: "local", force: false });
    assert.match(await runDelegation({ ok: false, error: "Retry failed" }), /Retry failed/);
    assert.deepEqual(titles(window), ["Home", "Task 42"]);
});

test("Home hides work-item delegation when the preview feature is disabled", describeDom, async () => {
    const { window } = await boot({ homeWorkItems: [42] });
    assert.equal(window.document.querySelector(".home-work-item-row .home-row-delegate"), null);
});

test("native board cards open the shared details and retain edits across workspace navigation", describeDom, async () => {
    const { window, state } = await boot({ featureFlags: allPreviewFeatures, homeWorkItems: [42] });
    await showWorkspace(window, "board");
    const card = window.document.querySelector(".workspace-board-card");
    assert.ok(card);
    const link = card.querySelector(".workspace-item-link");
    link.focus();
    assert.equal(window.document.activeElement, link);
    link.click();
    await settle();
    assert.equal(activeTitle(window), "Task 42");
    assert.match(state.workItemRequests[0], /organization=example&project=project&workItemProject=project/);
    const itemPanel = visiblePanels(window)[0];
    assert.equal(itemPanel.querySelectorAll(".work-item-delegate-menu").length, 1);
    assert.ok(itemPanel.querySelector(".work-item-title-row > .inline-edit"));
    const input = editTitle(window, "Draft from the board");
    const composer = itemPanel.querySelector(".comment-composer-body");
    composer.textContent = "Unsent board note";
    composer.dispatchEvent(new window.Event("input", { bubbles: true }));
    await showWorkspace(window, "items");
    await showWorkspace(window, "board");
    await openFromHome(window, 42);
    assert.equal(visiblePanels(window)[0], itemPanel);
    assert.equal(itemPanel.querySelector(".work-item-title-edit input"), input);
    assert.equal(input.value, "Draft from the board");
    assert.equal(composer.textContent, "Unsent board note");
    assert.equal(state.workItemUpdates, undefined);
    window.confirm = () => false;
    await closeTab(window, 1);
    assert.equal(activeTitle(window), "Task 42");
    assert.equal(input.value, "Draft from the board");
});

test("creation dialog traps keyboard focus and Escape restores the launching control", describeDom, async () => {
    const { window, state } = await boot();
    const launch = window.document.querySelector(".workspace-header button");
    launch.focus();
    launch.click();
    await settle();
    const dialog = window.document.querySelector(".workspace-create-dialog");
    assert.equal(dialog.getAttribute("aria-modal"), "true");
    assert.ok(dialog.contains(window.document.activeElement));
    const first = dialog.querySelector('select:not(:disabled)');
    first.focus();
    first.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
    assert.equal(window.document.activeElement, dialog.querySelector('button[type="submit"]'));
    window.document.activeElement.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    assert.equal(window.document.activeElement, first);
    dialog.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    assert.equal(window.document.querySelector(".workspace-create-dialog"), null);
    assert.equal(window.document.activeElement, launch);
    assert.deepEqual(state.requests.filter(({ path, method }) => path.includes("/api/workspace/items") && method === "POST"), []);
});

test("work items opened directly from Home expose local delegation", describeDom, async () => {
    const { window, state } = await boot({
        featureFlags: allPreviewFeatures,
        homeWorkItems: [42],
    });
    await openFromHome(window, 42);

    assert.deepEqual(titles(window), ["Home", "Task 42"]);
    assert.equal(state.openedBoards, undefined, "delegation does not require opening a board");
    const menu = visiblePanels(window)[0].querySelector(".work-item-delegate-menu");
    assert.equal(menu?.querySelector(".primer-action-menu-trigger-label")?.textContent, "Delegate");
    menu.querySelector(".primer-action-menu-trigger").click();
    assert.deepEqual(
        [...menu.querySelectorAll(".primer-action-list-label")].map((node) => node.textContent),
        ["Delegate locally"],
    );
    menu.querySelector('[data-component="ActionList.Item"]').click();
    await settle();

    assert.deepEqual(state.workItemDelegations, [{
        id: 42,
        path: "/api/work-items/42/delegate?organization=example&project=project&workItemProject=project",
        body: { mode: "local", force: false },
    }]);
    assert.equal(
        visiblePanels(window)[0].querySelector(".work-item-delegation-status")?.textContent,
        "Delegated to a local Copilot session.",
    );
});

test("disabled delegation stays absent from work-item details and the removed preview controls stay absent", describeDom, async () => {
    const { window } = await boot({ featureFlags: { delegation: false }, homeWorkItems: [42] });
    await openFromHome(window, 42);
    assert.equal(visiblePanels(window)[0].querySelector(".work-item-delegate-menu"), null);
    assert.equal(window.document.getElementById("delegationFeatureFlag"), null);
    assert.equal(window.document.getElementById("boardsFeatureFlag"), null);
});

test("native board failure offers retry without losing the selected board", describeDom, async () => {
    const { window, state } = await boot({ boardError: "The board is temporarily unavailable." });
    await showWorkspace(window, "board");
    assert.match(window.document.querySelector('.workspace-screen [role="alert"]').textContent, /temporarily unavailable/);
    const board = window.document.querySelector('.workspace-scope [aria-label="Board"]');
    assert.equal(board.value, "stories");
    state.boardError = "";
    window.document.querySelector('.workspace-screen [role="alert"] button').click();
    await settle();
    assert.ok(window.document.querySelector(".workspace-board"));
    assert.equal(window.document.querySelector('.workspace-scope [aria-label="Board"]').value, "stories");
});

test("Home shows progress for exactly as long as its data is unresolved", describeDom, async () => {
    const home = deferred();
    const { window } = await boot({ holdHome: home.promise });

    const loading = window.document.querySelector(".workspace-screen");
    assert.ok(loading);
    assert.equal(loading.getAttribute("aria-busy"), "true");
    assert.match(loading.textContent, /Loading home/);

    home.resolve();
    await settle();
    assert.equal(loading.hasAttribute("aria-busy"), false);
    assert.match(loading.textContent, /My current work/);
});

test("Home always shows the dashboard and exposes retry after loading fails", describeDom, async () => {
    const { window, state } = await boot({ featureFlags: { boards: true }, homeError: "Dashboard unavailable" });
    assert.match(window.document.querySelector('.workspace-screen [role="alert"]').textContent, /Dashboard unavailable/);
    state.homeError = "";
    window.document.querySelector('.workspace-screen [role="alert"] button').click();
    await settle();
    assert.deepEqual(sectionTitles(window), ["My current work", "Blocked work", "Parents with unfinished work", "Recently completed"]);
    assert.equal(window.document.querySelector(".home-active-work, .board-frame"), null);
    assert.deepEqual(state.requests.filter(({ path }) => path.startsWith("/api/home")), []);
});

test("Home remains visible with a saved organization connection", describeDom, async () => {
    const { window } = await boot();
    assert.deepEqual(titles(window), ["Home"]);
    assert.equal(bar(window).hidden, false);
    assert.equal(window.document.querySelector(".home-current-session"), null);
    assert.equal(window.document.querySelector(".workspace-heading")?.textContent, "Home");
});

test("several work items open as separate tabs", describeDom, async () => {
    const { window } = await boot({ homeWorkItems: [101, 102, 103] });
    await openFromHome(window, "101");
    await clickTab(window, 0);
    await openFromHome(window, "102");
    await clickTab(window, 0);
    await openFromHome(window, "103");

    assert.deepEqual(titles(window), ["Home", "Task 101", "Task 102", "Task 103"], "each work item gets its own tab");
    assert.equal(activeTitle(window), "Task 103", "the newest tab takes focus");
    assert.equal(bar(window).hidden, false);
    assert.equal(visiblePanels(window).length, 1, "exactly one panel is visible at a time");
});

test("work item loading uses animated progress and a stable detail skeleton", describeDom, async () => {
    const workItem = deferred();
    const { window } = await boot({
        homeWorkItems: [401],
        holdWorkItems: { 401: workItem.promise },
    });

    await openFromHome(window, "401");
    const skeleton = window.document.querySelector(".work-item-skeleton");
    assert.ok(skeleton);
    assert.equal(skeleton.getAttribute("aria-busy"), "true");
    assert.equal(skeleton.querySelector(".loading-title")?.textContent, "Loading work item 401");
    assert.ok(skeleton.querySelector(".loading-spinner-compact .loading-spinner-svg"));
    assert.ok(skeleton.querySelector(".work-item-skeleton-layout"));
    assert.ok(skeleton.querySelectorAll(".loading-skeleton-card").length >= 6);

    workItem.resolve();
    await settle();
    assert.equal(window.document.querySelector(".work-item-skeleton"), null);
    assert.ok(window.document.querySelector(".work-item"));
});

test("work item load failures explain the problem and expose a retry", describeDom, async (t) => {
    const { window, state } = await boot({ homeWorkItems: [101], workItemError: "The project is temporarily unavailable." });
    t.after(() => window.close());
    await openFromHome(window, 101);
    const content = visiblePanels(window)[0];
    assert.equal(content.querySelector(".status")?.textContent, "The project is temporarily unavailable.");
    const retry = content.querySelector(".retry-button");
    assert.equal(retry?.textContent, "Retry");
    state.workItemError = "";
    retry.click();
    await settle();
    assert.equal(content.querySelector(".work-item-title")?.textContent, "WI 101");
    assert.equal(state.workItemRequests.length, 2);
});

test("a sign-in Azure DevOps rejects returns to the sign-in chooser", describeDom, async () => {
    const { window } = await boot({
        homeWorkItems: [101],
        workItemError: "Azure DevOps did not accept the sign-in. Sign in again.",
        workItemErrorCode: "azure_devops_authentication_rejected",
        authStatus: { auth: { isAuthenticated: false, authType: "none" } },
    });
    await openFromHome(window, "101");

    assert.equal(window.document.getElementById("signInSplash").hidden, false);
    assert.equal(window.document.getElementById("canvasContent").hidden, true);
});

test("a stale rejection keeps a newer authenticated session visible", describeDom, async (t) => {
    const { window, state } = await boot({
        homeWorkItems: [101],
        workItemError: "Azure DevOps did not accept the sign-in. Sign in again.",
        workItemErrorCode: "azure_devops_authentication_rejected",
        authStatus: { auth: { isAuthenticated: true, authType: "microsoft" } },
    });
    t.after(() => window.close());
    await openFromHome(window, "101");
    assert.equal(state.authStatusRequests, 1);
    assert.equal(window.document.getElementById("signInSplash").hidden, true);
    assert.equal(window.document.getElementById("canvasContent").hidden, false);
});

test("an older rejection does not replace an in-progress sign-in with the chooser", describeDom, async (t) => {
    const { window } = await boot({
        homeWorkItems: [101],
        workItemError: "Azure DevOps did not accept the sign-in. Sign in again.",
        workItemErrorCode: "azure_devops_authentication_rejected",
        authStatus: { auth: null, authProcess: { status: "running" } },
    });
    t.after(() => window.close());
    await openFromHome(window, "101");
    assert.equal(window.document.getElementById("signInSplash").hidden, true);
    assert.equal(window.document.getElementById("canvasContent").hidden, false);
});

test("work item discussions add a flat comment and refresh the count", describeDom, async () => {
        const { window, state } = await boot({ homeWorkItems: [42] });
        await openFromHome(window, "42");
        const composer = window.document.querySelector(".work-item-discussion > .comment-composer");
        composer.querySelector(".comment-composer-body").textContent = "Work item follow-up";
        composer.querySelector(".comment-submit").click();
        await settle();

        assert.deepEqual(state.workItemComments, [{
            id: 42,
            method: "POST",
            body: { content: "Work item follow-up" },
        }]);
        assert.equal(window.document.querySelector(".work-item-discussion .primer-counter").textContent, "1");
});

test("reopening an open work item focuses it rather than duplicating it", describeDom, async () => {
    const { window } = await boot({ homeWorkItems: [101, 102] });
    await openFromHome(window, "101");
    await clickTab(window, 0);
    await openFromHome(window, "102");
    await clickTab(window, 0);
    await openFromHome(window, "101");

    assert.deepEqual(titles(window), ["Home", "Task 101", "Task 102"], "no duplicate tab was created");
    assert.equal(activeTitle(window), "Task 101");
});

test("tabs close from the X, and Home has none", describeDom, async () => {
    const { window } = await boot({ homeWorkItems: [101, 102] });
    await openFromHome(window, "101");
    await clickTab(window, 0);
    await openFromHome(window, "102");

    assert.equal(tabEls(window)[0].querySelector(".view-tab-close"), null, "Home cannot be closed");
    await closeTab(window, 1);
    assert.deepEqual(titles(window), ["Home", "Task 102"]);
});

test("closing the focused tab focuses the tab that takes its place", describeDom, async () => {
    const { window } = await boot({ homeWorkItems: [101, 102, 103] });
    await openFromHome(window, "101");
    await clickTab(window, 0);
    await openFromHome(window, "102");
    await clickTab(window, 0);
    await openFromHome(window, "103");

    await clickTab(window, 2); // focus 102
    assert.equal(activeTitle(window), "Task 102");
    await closeTab(window, 2);

    assert.deepEqual(titles(window), ["Home", "Task 101", "Task 103"]);
    assert.equal(activeTitle(window), "Task 103", "focus moved to the neighbour");
    assert.equal(visiblePanels(window).length, 1, "the closed tab's panel is gone, one remains visible");
});

test("closing a background tab leaves focus alone", describeDom, async () => {
    const { window } = await boot({ homeWorkItems: [101, 102] });
    await openFromHome(window, "101");
    await clickTab(window, 0);
    await openFromHome(window, "102");
    assert.equal(activeTitle(window), "Task 102");

    await closeTab(window, 1); // close 101 while 102 is focused
    assert.deepEqual(titles(window), ["Home", "Task 102"]);
    assert.equal(activeTitle(window), "Task 102", "focus stayed on the tab the user was in");
});

test("switching tabs preserves what each tab already rendered", describeDom, async () => {
    const { window } = await boot({ homeWorkItems: [101, 102] });

    await openFromHome(window, "101");
    await clickTab(window, 0);
    await openFromHome(window, "102");

    await clickTab(window, 1);
    assert.equal(activeTitle(window), "Task 101");
    assert.deepEqual(titles(window), ["Home", "Task 101", "Task 102"], "switching tabs changed nothing else");
    assert.equal(visiblePanels(window).length, 1);

    await clickTab(window, 2);
    assert.equal(activeTitle(window), "Task 102");
    assert.equal(visiblePanels(window).length, 1, "each tab keeps its own panel across switches");
});

test("opening a child task from the main work-item section preserves the parent tab", describeDom, async () => {
    const relations = [{
        name: "Children",
        links: [{ id: 501, project: "Other Project", label: "Task 501", title: "Related", state: "Active" }],
    }];
    const { window, state } = await boot({ homeWorkItems: [400], relations });

    await openFromHome(window, "400");
    assert.equal(activeTitle(window), "Task 400");

    const related = [...window.document.querySelectorAll(".tab-panel .work-item-main-column .child-work-section button")]
        .find((node) => node.textContent.includes("501"));
    assert.ok(related, "the related work item should be clickable");
    related.click();
    await settle();

    assert.deepEqual(titles(window), ["Home", "Task 400", "Task 501"], "the link must not take over the tab it was followed from");
    assert.equal(activeTitle(window), "Task 501", "the newly opened item takes focus");
    assert.match(state.workItemRequests.at(-1), /workItemProject=Other\+Project/);
});

test("sidebar opens a child once, reveals it from details, and retains it when the parent closes", describeDom, async (t) => {
    const { window, state } = await boot({ homeWorkItems: [400], workItemsById: {
        400: { type: "User Story", title: "Prepare widgets", relations: [{ name: "Children", links: [
            { id: 501, project: "Other Project", kind: "work-item", label: "Task 501", title: "Build widget", state: "Active" },
        ] }] },
        501: { type: "Task", title: "Build widget", project: "Other Project" },
    } });
    t.after(() => window.close());
    await openFromHome(window, 400);
    assert.equal(state.workItemRequests.length, 1, "child summaries require no extra fetch");
    let childButton = bar(window).querySelector(".navigation-children .view-tab-label");
    childButton.click();
    await settle();
    assert.equal(activeTitle(window), "Task 501");
    assert.match(state.workItemRequests.at(-1), /workItemProject=Other\+Project/);
    assert.equal(bar(window).querySelectorAll('.view-tab-label[aria-label="Task 501: Build widget"]').length, 1);
    await clickTab(window, 1);
    bar(window).querySelector(".navigation-disclosure").click();
    assert.equal(bar(window).querySelector(".navigation-children").hidden, true);
    window.document.querySelector(".tab-panel:not([hidden]) .child-work-section .relation-link").click();
    await settle();
    assert.equal(bar(window).querySelector(".navigation-children").hidden, false);
    assert.equal(state.workItemRequests.length, 2, "reopening the child uses its existing view");
    await closeTab(window, 1);
    assert.deepEqual(titles(window), ["Home", "Task 501"]);
    assert.equal(activeTitle(window), "Task 501");
    assert.equal(bar(window).querySelector(".view-tab.active").closest(".navigation-children"), null);
    assert.equal(visiblePanels(window).length, 1);
});

test("closing a nested child preserves its link and protects unsaved edits", describeDom, async (t) => {
    const { window } = await boot({ homeWorkItems: [400], workItemsById: {
        400: { relations: [{ name: "Children", links: [{ id: 501, label: "Task 501", title: "Build widget" }] }] },
    } });
    t.after(() => window.close());
    await openFromHome(window, 400);
    bar(window).querySelector(".navigation-children .view-tab-label").click();
    await settle();
    const panel = visiblePanels(window)[0];
    panel.querySelector(".work-item-title-row .inline-edit").click();
    await settle();
    const input = panel.querySelector('input[type="text"], input:not([type])');
    assert.ok(input, "title editor is available");
    input.value = "Unsaved widget title";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    let confirmations = 0;
    window.confirm = () => { confirmations += 1; return false; };
    await closeTab(window, 2);
    assert.equal(confirmations, 1);
    assert.equal(input.value, "Unsaved widget title");
    await closeTab(window, 1);
    assert.equal(visiblePanels(window)[0], panel, "closing the parent retains the child's editor");
    assert.equal(input.value, "Unsaved widget title");
    window.confirm = () => true;
    await openFromHome(window, 400);
    await closeTab(window, 1);
    const childLink = bar(window).querySelector(".navigation-children .view-tab-label");
    assert.ok(childLink, "closing a child view keeps its relation available");
    childLink.click();
    await settle();
    assert.equal(activeTitle(window), "Task 501");
    assert.equal(visiblePanels(window)[0].querySelector(".editor-save"), null, "confirmed discarded edits do not return");
});

test("walking a chain of linked work items keeps every item open", describeDom, async () => {
    // Each item links onward, so following the chain is the case that previously
    // collapsed into a single tab.
    const relations = [{
        name: "Child",
        links: [
            { id: 501, label: "Task 501", title: "First", state: "Active" },
            { id: 502, label: "Task 502", title: "Second", state: "Active" },
        ],
    }];
    const { window } = await boot({ homeWorkItems: [400], relations });

    await openFromHome(window, "400");
    for (const id of [501, 502]) {
        const link = [...window.document.querySelectorAll(".tab-panel:not([hidden]) button")]
            .find((node) => node.textContent.includes(String(id)));
        assert.ok(link, `expected a link to ${id}`);
        link.click();
        await settle();
    }

    assert.deepEqual(titles(window), ["Home", "Task 400", "Task 501", "Task 502"]);
    assert.equal(visiblePanels(window).length, 1, "still exactly one panel visible");
});

test("a canvas opened on a work item keeps Home behind it", describeDom, async () => {
    const { window, state } = await boot({ workItemReference: true });
    assert.equal(state.currentWorkItemCalls, 1, "the id is not known client-side, so it is fetched by reference");
    assert.deepEqual(titles(window), ["Home", "Bug 900"]);
    assert.equal(activeTitle(window), "Bug 900");
    assert.equal(bar(window).hidden, false);
});

test("reference-opened work items route sidebar children and reuse the resolved item", describeDom, async (t) => {
    const { window, state } = await boot({ workItemReference: true, homeWorkItems: [900], relations: [{
        name: "Children", links: [{ id: 501, project: "Other Project", label: "Task 501", title: "Build widget" }],
    }] });
    t.after(() => window.close());
    bar(window).querySelector(".navigation-children .view-tab-label").click();
    await settle();
    assert.equal(activeTitle(window), "Task 501");
    const request = new URL(state.workItemRequests.at(-1), "http://localhost");
    assert.equal(request.searchParams.get("organization"), "example");
    assert.equal(request.searchParams.get("workItemProject"), "Other Project");
    await clickTab(window, 0);
    await openFromHome(window, 900);
    assert.equal(activeTitle(window), "Bug 900");
    assert.equal(state.currentWorkItemCalls, 1);
    assert.equal(state.workItemRequests.length, 1);
    assert.equal(tabEls(window).length, 3);
});

test("a late parent load nests an already opened child once", describeDom, async (t) => {
    const gate = deferred();
    const { window } = await boot({ homeWorkItems: [400, 501], holdWorkItems: { 400: gate.promise }, workItemsById: {
        400: { relations: [{ name: "Children", links: [{ id: 501, label: "Task 501", title: "Build widget" }] }] },
    } });
    t.after(() => window.close());
    await openFromHome(window, 400);
    await openFromHome(window, 501);
    assert.equal(bar(window).querySelector(".view-tab.active").closest(".navigation-children"), null);
    gate.resolve();
    await settle();
    assert.equal(activeTitle(window), "Task 501");
    assert.ok(bar(window).querySelector(".view-tab.active").closest(".navigation-children"));
    assert.equal(tabEls(window).length, 3);
    assert.equal(visiblePanels(window).length, 1);
});

test("a slow tab load does not scroll whichever tab the user switched to", describeDom, async () => {
    // 102 is held open so the user can switch away mid-load, which is a normal
    // interaction on a slow connection rather than a stress case.
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const state = { homeWorkItems: [101, 102], holdWorkItems: { 102: held } };
    const { window } = await boot(state);

    await openFromHome(window, "101");
    await clickTab(window, 0);

    // Start 102, then return to 101 before 102 resolves.
    const link = findHomeLink(window, 102);
    link.click();
    await settle();
    await clickTab(window, 1);
    assert.equal(activeTitle(window), "Task 101", "the user is looking at 101");

    state.scrolls.length = 0;
    release();
    await settle();

    assert.deepEqual(state.scrolls, [], "a load that finished for a tab the user left must not scroll the tab they are on");
    assert.equal(activeTitle(window), "Task 101", "focus is unchanged");
});

test("closing a tab mid-load discards its result", describeDom, async () => {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const state = { homeWorkItems: [101, 102], holdWorkItems: { 102: held } };
    const { window } = await boot(state);

    await openFromHome(window, "101");
    await clickTab(window, 0);
    const link = findHomeLink(window, 102);
    link.click();
    await settle();
    assert.deepEqual(titles(window), ["Home", "Task 101", "Work item 102"]);

    await closeTab(window, 2);
    assert.deepEqual(titles(window), ["Home", "Task 101"]);

    // The abandoned load now returns. It must not resurrect the tab or report success.
    release();
    await settle();
    assert.deepEqual(titles(window), ["Home", "Task 101"], "a closed tab stays closed when its load resolves");
    const entries = [...window.document.querySelectorAll("#logsList .log-entry")].map((n) => n.textContent);
    assert.ok(
        entries.some((line) => line.includes("Closed tab.")),
        "closing is expected to be logged",
    );
    assert.ok(
        !entries.some((line) => line.includes("Loaded work item details") && line.includes("102")),
        "a closed tab's load must not report success",
    );
});

test("middle-click closes a tab", describeDom, async () => {
    const { window } = await boot({ homeWorkItems: [101, 102] });
    await openFromHome(window, "101");
    await clickTab(window, 0);
    await openFromHome(window, "102");
    assert.deepEqual(titles(window), ["Home", "Task 101", "Task 102"]);

    const target = tabEls(window)[1];
    target.dispatchEvent(new window.MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }));
    await settle();
    assert.deepEqual(titles(window), ["Home", "Task 102"], "middle-click closed the tab under the pointer");

    // Home is not closable, so middle-clicking it must do nothing.
    tabEls(window)[0].dispatchEvent(new window.MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }));
    await settle();
    assert.deepEqual(titles(window), ["Home", "Task 102"], "middle-click cannot close Home");
});

test("the sidebar is wired up for assistive technology", describeDom, async () => {
    const { window } = await boot({ homeWorkItems: [101, 400] });
    await openFromHome(window, "101");
    await openFromHome(window, "400");
    assert.equal(bar(window).tagName, "NAV");
    assert.equal(bar(window).getAttribute("aria-label"), "Azure DevOps views");
    assert.equal(bar(window).querySelector('[role="tab"]'), null);
    for (const el of tabEls(window)) {
        const label = el.querySelector(".view-tab-label");
        const panel = window.document.getElementById(label.getAttribute("aria-controls"));
        assert.ok(panel);
        assert.equal(panel.getAttribute("role"), "region");
        assert.equal(panel.getAttribute("aria-labelledby"), label.id);
        assert.equal(label.getAttribute("aria-current"), el.classList.contains("active") ? "page" : null);
    }
    assert.match(tabEls(window)[1].querySelector(".view-tab-close").getAttribute("aria-label"), /Close Task 101/);
    const toggle = window.document.getElementById("navigationToggle");
    toggle.click();
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(window.document.getElementById("canvasContent").classList.contains("navigation-collapsed"), true);
    toggle.click();
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
});

test("switching to a slow tab and away again does not scroll the tab left behind", describeDom, async () => {
    // Exercises the switch path specifically: the first test covers opening a new
    // tab, this one covers returning to one whose content has not loaded yet.
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const state = { homeWorkItems: [101, 102], holdWorkItems: { 102: held } };
    const { window } = await boot(state);

    await openFromHome(window, "101");
    await clickTab(window, 0);
    const link = findHomeLink(window, 102);
    link.click();
    await settle();

    // 102 is still loading. Leave it, come back to it, then leave again, so a
    // switch-initiated load is in flight for a tab that is no longer on screen.
    await clickTab(window, 1);
    await clickTab(window, 2);
    await clickTab(window, 1);
    assert.equal(activeTitle(window), "Task 101");

    state.scrolls.length = 0;
    release();
    await settle();

    assert.deepEqual(state.scrolls, [], "a switch-initiated load must not scroll once the user has moved on");
    assert.equal(activeTitle(window), "Task 101");
});

// --- Connections -----------------------------------------------------------
//
// Organization and project selection preserve pending input and connection routing.

const panel = (w) => w.document.getElementById("connectionPanel");
const sectionTitles = (w) => [...w.document.querySelectorAll("#homeContent .workspace-dashboard-section h2")].map(el => el.textContent);

test("with no saved connection, the canvas asks for an organization", describeDom, async () => {
    const { window } = await boot({ connections: [] });
    assert.equal(panel(window).hidden, false, "the picker is the canvas when there is nothing to read from");
    assert.match(panel(window).textContent, /Choose an organization/);
    assert.equal(
        window.document.querySelector("#homeContent .status")?.textContent,
        undefined,
        "no dead-end message is left behind the picker",
    );
});

test("the picker only requires an organization, and says why a project still matters", describeDom, async () => {
    const { window } = await boot({ connections: [], organizations: ["contoso", "fabrikam"] });
    await settle();
    const labels = [...panel(window).querySelectorAll(".connection-field-label")].map((el) => el.textContent);
    assert.deepEqual(labels, ["Organization", "Project"]);
    assert.match(panel(window).textContent, /Required\./);
    assert.match(panel(window).textContent, /work items across the organization/);
    const organization = panel(window).querySelector('[role="combobox"]');
    organization.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    const options = [...panel(window).querySelectorAll('[role="option"]')].map((el) => el.textContent);
    assert.ok(options.includes("contoso") && options.includes("fabrikam"), "known organizations are offered");
});

test("choosing an organization saves it and rebuilds the canvas", describeDom, async () => {
    const state = { connections: [], organizations: ["fabrikam"] };
    const { window } = await boot(state);
    await settle();
    const input = panel(window).querySelector(".connection-input");
    input.value = "fabrikam";
    input.dispatchEvent(new window.Event("change"));
    await settle();
    panel(window).querySelector("button[type=submit]").click();
    await settle();

    assert.deepEqual(state.savedConnections[0], { organization: "fabrikam", project: "", isDefault: false });
    assert.equal(panel(window).hidden, true, "the picker closes once there is a connection");
    assert.deepEqual(titles(window), ["Home"]);
});

test("the default toggle is what pins a connection", describeDom, async () => {
    const state = { connections: [], organizations: ["fabrikam"] };
    const { window } = await boot(state);
    await settle();
    const input = panel(window).querySelector(".connection-input");
    input.value = "fabrikam";
    input.dispatchEvent(new window.Event("change"));
    await settle();
    const toggle = panel(window).querySelector(".connection-toggle input");
    toggle.checked = true;
    toggle.dispatchEvent(new window.Event("change"));
    await settle();
    panel(window).querySelector("button[type=submit]").click();
    await settle();

    assert.equal(state.savedConnections[0].isDefault, true);
});

test("the footer opens the picker over a working canvas, and cancel returns to it", describeDom, async () => {
    const { window } = await boot({ homeWorkItems: [101] });
    assert.equal(panel(window).hidden, true);
    window.document.getElementById("connectionsButton").click();
    await settle();
    assert.equal(panel(window).hidden, false);
    assert.match(panel(window).textContent, /Showing/, "the picker shows what the canvas is currently reading from");
    [...panel(window).querySelectorAll("button")].find((el) => el.textContent === "Cancel").click();
    await settle();
    assert.equal(panel(window).hidden, true);
    assert.ok(findHomeLink(window, 101), "the canvas underneath is untouched");
});

test("workspace connections keep their configured order and label organization and project", describeDom, async () => {
    const { window } = await boot({
        featureFlags: { boards: true },
        homeConnections: [
            { source: "last-used", organization: "contoso", project: "Widgets", isDefault: false, requiresProject: false, workItems: [11] },
            { source: "default", organization: "fabrikam", project: "Boxes", isDefault: true, requiresProject: false, workItems: [22] },
        ],
    });
    const select = window.document.querySelector('.workspace-scope [aria-label="Organization connection"]');
    assert.deepEqual([...select.options].map(option => option.textContent), ["contoso / Widgets", "fabrikam / Boxes"]);
    assert.equal(select.value, "0");
    assert.ok(findHomeLink(window, 11));
    assert.equal(findHomeLink(window, 22), undefined);
    await chooseWorkspaceConnection(window, "fabrikam");
    assert.ok(findHomeLink(window, 22));
    assert.equal(findHomeLink(window, 11), undefined);
});

test("a single connection shows its scope without a duplicate connection heading", describeDom, async () => {
    const { window } = await boot({ homeWorkItems: [101] });
    assert.equal(window.document.querySelectorAll(".home-connection-name").length, 0);
    const select = window.document.querySelector('.workspace-scope [aria-label="Organization connection"]');
    assert.equal(select.options.length, 1);
    assert.equal(select.selectedOptions[0].textContent, "example / project");
});

test("a row is fetched from the organization it was listed under", describeDom, async () => {
    const state = {
        featureFlags: { boards: true },
        homeConnections: [
            { source: "last-used", organization: "contoso", project: "Widgets", isDefault: false, requiresProject: false, workItems: [101] },
            { source: "default", organization: "fabrikam", project: "Boxes", isDefault: true, requiresProject: false, workItems: [202] },
        ],
    };
    const { window } = await boot(state);
    await chooseWorkspaceConnection(window, "fabrikam");
    await openFromHome(window, "202");
    assert.match(state.workItemRequests.at(-1), /organization=fabrikam/);
    assert.match(state.workItemRequests.at(-1), /project=Boxes/);
    assert.deepEqual(titles(window), ["Home", "Task 202"]);
});

test("the same id in two organizations opens as two tabs, because they are two items", describeDom, async () => {
    const { window } = await boot({
        featureFlags: { boards: true },
        homeConnections: [
            { source: "last-used", organization: "contoso", project: "Widgets", isDefault: false, requiresProject: false, workItems: [500] },
            { source: "default", organization: "fabrikam", project: "Boxes", isDefault: true, requiresProject: false, workItems: [500] },
        ],
    });
    await openFromHome(window, 500);
    await chooseWorkspaceConnection(window, "fabrikam");
    await openFromHome(window, 500);
    assert.equal(titles(window).length, 3, "one Home and one tab per organization");
});

test("an organization connection requires a selected project for the dashboard and native board", describeDom, async () => {
    const { window } = await boot({
        featureFlags: { boards: true },
        connections: [{ source: "default", organization: "fabrikam", project: "", isDefault: true, requiresProject: true }],
        homeConnections: [
            { source: "default", organization: "fabrikam", project: "", isDefault: true, requiresProject: true, workItems: [11] },
        ],
    });
    assert.match(window.document.querySelector("#homeContent").textContent, /Choose a project to see your personal work dashboard/);
    await showWorkspace(window, "board");
    assert.match(window.document.querySelector("#homeContent").textContent, /Choose a project to open its team boards/);
    const project = window.document.querySelector('.workspace-scope [aria-label="Project"]');
    project.value = "project";
    project.dispatchEvent(new window.Event("change"));
    await settle();
    assert.ok(window.document.querySelector(".workspace-board"));
    assert.equal(panel(window).hidden, true);
});

test("an organization-scope work item row carries its own project to the detail request", describeDom, async () => {
    const state = {
        featureFlags: { boards: true },
        connections: [{ source: "default", organization: "fabrikam", project: "", isDefault: true, requiresProject: true }],
        homeConnections: [
            { source: "default", organization: "fabrikam", project: "", isDefault: true, requiresProject: true, workItems: [[4711, "Beta"]] },
        ],
    };
    const { window } = await boot(state);
    await showWorkspace(window, "items");
    await openFromHome(window, "4711");
    const request = state.workItemRequests.at(-1);
    assert.match(request, /organization=fabrikam/);
    assert.match(request, /workItemProject=Beta/, "the connection has no project, so the row supplies one");
    assert.deepEqual(titles(window), ["Home", "Task 4711"]);
});

test("same-numbered organization-scope work items in different projects open separate tabs", describeDom, async () => {
    const state = {
        featureFlags: { boards: true },
        connections: [{ source: "default", organization: "fabrikam", project: "", isDefault: true, requiresProject: true }],
        homeConnections: [
            {
                source: "default",
                organization: "fabrikam",
                project: "",
                isDefault: true,
                requiresProject: true,
                workItems: [[4711, "Alpha"], [4711, "Beta"]],
            },
        ],
    };
    const { window } = await boot(state);
    await showWorkspace(window, "items");
    const links = [...window.document.querySelectorAll("#homeContent .workspace-item-link")]
        .filter(node => node.getAttribute("aria-label")?.includes(" 4711:"));
    assert.equal(links.length, 2);
    links[0].click();
    await settle();
    await showWorkspace(window, "items");
    const refreshed = [...window.document.querySelectorAll("#homeContent .workspace-item-link")]
        .filter(node => node.getAttribute("aria-label")?.includes(" 4711:"));
    refreshed[1].click();
    await settle();

    assert.deepEqual(titles(window), ["Home", "Task 4711", "Task 4711"]);
    assert.match(state.workItemRequests.at(-2), /workItemProject=Alpha/);
    assert.match(state.workItemRequests.at(-1), /workItemProject=Beta/);
});

test("unrelated non-numeric work-item ids never collapse into one tab", describeDom, async () => {
    const state = { homeWorkItems: ["not-a-number", "still-not-a-number"] };
    const { window } = await boot(state);

    await openFromHome(window, "not-a-number");
    await clickTab(window, 0);
    await openFromHome(window, "still-not-a-number");

    assert.deepEqual(titles(window), ["Home", "Task 0", "Task 0"]);
    assert.equal(state.workItemRequests.length, 2);
});

// Typing into a field commits on `input`, not on blur. Committing on blur would
// leave Save disabled until the user thought to blur, and clicking a disabled
// Save does not blur anything, so the picker would deadlock on first run.
function typeInto(window, index, value) {
    const input = [...panel(window).querySelectorAll(".connection-input")][index];
    input.value = value;
    input.dispatchEvent(new window.Event("input"));
    return input;
}

test("typing an organization enables Save without needing to leave the field", describeDom, async () => {
    const { window } = await boot({ connections: [] });
    await settle();
    const save = panel(window).querySelector("button[type=submit]");
    assert.equal(save.disabled, true, "there is nothing to save yet");
    typeInto(window, 0, "fabrikam");
    await settle();
    assert.equal(save.disabled, false, "the field has not been blurred, and Save is already usable");
});

test("patching the picker keeps the field the user is typing in alive", describeDom, async () => {
    const { window } = await boot({ connections: [], organizations: ["fabrikam"] });
    await settle();
    const before = panel(window).querySelector("button[type=submit]");
    const input = typeInto(window, 0, "fab");
    await settle();
    assert.equal(
        panel(window).querySelector(".connection-input"),
        input,
        "the organization field survives the update, so the caret and focus do not move",
    );
    assert.equal(
        panel(window).querySelector("button[type=submit]"),
        before,
        "and Save survives it too, so a click that starts on it can finish on it",
    );
});

test("a connection the canvas could not store is not treated as saved", describeDom, async () => {
    const state = {
        connections: [],
        connectionSaveError: "Could not save the Azure DevOps connection: EACCES",
    };
    const { window } = await boot(state);
    await settle();
    typeInto(window, 0, "fabrikam");
    await settle();
    panel(window).querySelector("button[type=submit]").click();
    await settle();

    assert.equal(panel(window).hidden, false, "the picker stays open rather than looping back to an empty one");
    assert.match(panel(window).querySelector(".connection-error").textContent, /EACCES/);
    assert.equal(
        panel(window).querySelector(".connection-input").value,
        "fabrikam",
        "and what the user typed is still there to retry with",
    );
});

test("changing the organization clears a project that belonged to the previous one", describeDom, async () => {
    const state = { connections: [], projects: ["Widgets"] };
    const { window } = await boot(state);
    await settle();
    const organization = typeInto(window, 0, "contoso");
    organization.dispatchEvent(new window.Event("change"));
    await settle();
    typeInto(window, 1, "Widgets");
    await settle();

    organization.value = "fabrikam";
    organization.dispatchEvent(new window.Event("input"));
    organization.dispatchEvent(new window.Event("change"));
    await settle();
    assert.equal([...panel(window).querySelectorAll(".connection-input")][1].value, "");
});

test("the project is saved even when the engine raises no input event for it", describeDom, async () => {
    // A value chosen from the datalist dropdown does not raise `input` in every
    // engine, and the field the user is looking at is the one that must win. The
    // draft is deliberately never told about this value.
    const state = {
        connections: [{ source: "last-used", organization: "fabrikam", project: "widgets", isDefault: false, requiresProject: false }],
        projects: ["Widgets", "Boxes"],
    };
    const { window } = await boot(state);
    window.document.getElementById("connectionsButton").click();
    await settle();
    const inputs = [...panel(window).querySelectorAll(".connection-input")];
    inputs[1].value = "Boxes";
    panel(window).querySelector("button[type=submit]").click();
    await settle();
    assert.equal(state.savedConnections.at(-1).project, "Boxes");
});

test("a changed field is saved when the engine raises change but not input", describeDom, async () => {
    const state = {
        connections: [{ source: "last-used", organization: "fabrikam", project: "widgets", isDefault: false, requiresProject: false }],
    };
    const { window } = await boot(state);
    window.document.getElementById("connectionsButton").click();
    await settle();
    const inputs = [...panel(window).querySelectorAll(".connection-input")];
    inputs[1].value = "Boxes";
    inputs[1].dispatchEvent(new window.Event("change"));
    await settle();
    panel(window).querySelector("button[type=submit]").click();
    await settle();
    assert.equal(state.savedConnections.at(-1).project, "Boxes");
});

test("footer refresh reloads the selected tab without returning to Home", describeDom, async () => {
    const { window, state } = await boot({ homeWorkItems: [101] });
    await openFromHome(window, "101");
    state.workItemsById = { 101: { title: "Updated task", state: "Done", rev: 2 } };

    window.document.getElementById("refreshButton").click();
    await settle();

    assert.equal(activeTitle(window), "Task 101");
    assert.equal(window.document.getElementById("homePanel").hidden, true);
    assert.equal(visiblePanels(window)[0].querySelector(".work-item-title")?.textContent, "Updated task");
    assert.equal(state.workItemRequests.length, 2);
});

test("footer refresh reloads the canvas when there is no active tab", describeDom, async () => {
    const { window, state } = await boot({ connections: [] });
    assert.equal(state.configRequests, 1);

    window.document.getElementById("refreshButton").click();
    await settle();

    assert.equal(state.configRequests, 2);
    assert.equal(window.document.getElementById("connectionPanel").hidden, false);
});

test("an action menu opens over its container instead of being clipped by it", describeDom, async () => {
    const { window } = await boot({
        homeWorkItems: [101],
        featureFlags: allPreviewFeatures,
    });
    await openFromHome(window, "101");

    // Fixed-position menus can escape the bordered card's clipping boundary.
    assert.match(styles, /\.primer-action-menu-overlay \{[^}]*position: fixed/);

    const overlay = window.document.querySelector(".work-item-delegate-menu .primer-action-menu-overlay");
    const trigger = window.document.querySelector(".work-item-delegate-menu .primer-action-menu-trigger");
    const size = (node, width, height) => {
        Object.defineProperty(node, "offsetWidth", { value: width, configurable: true });
        Object.defineProperty(node, "offsetHeight", { value: height, configurable: true });
    };
    const viewport = (width, height) => {
        Object.defineProperty(window.document.documentElement, "clientWidth", { value: width, configurable: true });
        Object.defineProperty(window.document.documentElement, "clientHeight", { value: height, configurable: true });
    };
    const at = (rect) => { trigger.getBoundingClientRect = () => rect; };

    size(overlay, 180, 100);
    viewport(800, 600);

    // Room below: the menu hangs off the bottom of the trigger, right-aligned.
    at({ top: 100, bottom: 126, left: 600, right: 628, width: 28, height: 26 });
    trigger.click();
    assert.equal(overlay.hidden, false);
    assert.equal(overlay.style.top, "130px", "4px under the trigger");
    assert.equal(overlay.style.left, "448px", "right edge aligned to the trigger");

    // Near the bottom: it flips above rather than running off screen.
    trigger.click();
    at({ top: 540, bottom: 566, left: 600, right: 628, width: 28, height: 26 });
    trigger.click();
    assert.equal(overlay.style.top, "436px", "flipped above the trigger");

    // Hard against the right edge: pulled back to stay on screen.
    trigger.click();
    at({ top: 100, bottom: 126, left: 780, right: 808, width: 28, height: 26 });
    trigger.click();
    assert.equal(overlay.style.left, "612px", "clamped to the viewport margin");
});


test("native workspace navigation keeps item details and returns to the requested screen", describeDom, async () => {
    const { window } = await boot({ homeWorkItems: [101] });
    await openFromHome(window, 101);
    window.document.querySelector('[data-workspace-view="items"]').click();
    await settle();
    assert.equal(window.document.querySelector('.workspace-heading').textContent, 'Work items');
    assert.equal(window.document.querySelector('[data-workspace-view="items"]').getAttribute('aria-current'), 'page');
    assert.deepEqual(titles(window), ['Home', 'Task 101']);
    await clickTab(window, 1);
    assert.equal(visiblePanels(window)[0].querySelector('.work-item-title').textContent, 'WI 101');
});

function editTitle(window, value) {
    visiblePanels(window)[0].querySelector('.work-item-title-row .inline-edit').click();
    const input = visiblePanels(window)[0].querySelector('.work-item-title-edit input');
    input.value = value;
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    return input;
}

test("refresh preserves unsaved text and offers explicit conflict choices", describeDom, async () => {
    const { window, state } = await boot({ homeWorkItems: [101] });
    await openFromHome(window, 101);
    const input = editTitle(window, 'My local title');
    state.workItemsById = { 101: { rev: 2, title: 'Changed elsewhere' } };
    window.document.getElementById('refreshButton').click();
    await settle();
    assert.equal(visiblePanels(window)[0].querySelector('.work-item-title-edit input'), input);
    assert.equal(input.value, 'My local title');
    assert.match(visiblePanels(window)[0].querySelector('.draft-notice').textContent, /Changed elsewhere/);
    assert.equal(state.workItemUpdates, undefined);
    [...visiblePanels(window)[0].querySelectorAll('.draft-notice button')].find(button => button.textContent === 'Apply choices').click();
    visiblePanels(window)[0].querySelector('.editor-save').click();
    await settle();
    assert.equal(state.workItemUpdates[0].body.rev, 2);
    assert.equal(visiblePanels(window)[0].querySelector('.work-item-title').textContent, 'My local title');
});

test("drafts and open views recover on a fresh browser origin without silently applying edits", describeDom, async () => {
    const state = { homeWorkItems: [101] };
    const first = await boot(state);
    await openFromHome(first.window, 101);
    editTitle(first.window, 'Recover this title');
    await new Promise(resolve => setTimeout(resolve, 480));
    assert.equal(state.drafts[101].fields[0].value, 'Recover this title');
    assert.equal(state.preferences.activeItem.id, 101);
    first.window.close();
    const { window } = await boot(state);
    assert.equal(activeTitle(window), 'Task 101');
    assert.equal(visiblePanels(window)[0].querySelector('.work-item-title').textContent, 'WI 101');
    const restore = [...visiblePanels(window)[0].querySelectorAll('button')].find(button => button.textContent === 'Restore draft');
    assert.ok(restore);
    restore.click();
    assert.equal(visiblePanels(window)[0].querySelector('.work-item-title-edit input').value, 'Recover this title');
    assert.equal(state.workItemUpdates, undefined);
});

test("saving fields preserves a separately composed discussion draft", describeDom, async () => {
    const { window, state } = await boot({ homeWorkItems: [101] });
    await openFromHome(window, 101);
    editTitle(window, 'Updated title');
    const composer = visiblePanels(window)[0].querySelector('.comment-composer-body');
    composer.textContent = 'My unsent discussion';
    composer.dispatchEvent(new window.Event('input', { bubbles: true }));
    visiblePanels(window)[0].querySelector('.editor-save').click();
    await settle();
    assert.equal(visiblePanels(window)[0].querySelector('.comment-composer-body').textContent, 'My unsent discussion');
    assert.equal(state.workItemComments, undefined);
    await new Promise(resolve => setTimeout(resolve, 480));
    assert.deepEqual(state.drafts[101].fields, []);
    assert.equal(state.drafts[101].comment.content, 'My unsent discussion');
});

for (const laterTitle of ["A newer edit", "WI 101"]) {
    test(`a held field save preserves text changed to ${laterTitle} after submission`, describeDom, async () => {
        const gate = deferred();
        const { window, state } = await boot({ homeWorkItems: [101], holdWorkItemUpdate: gate.promise });
        await openFromHome(window, 101);
        const input = editTitle(window, "Submitted title");
        visiblePanels(window)[0].querySelector(".editor-save").click();
        await settle();
        assert.equal(state.workItemUpdates.length, 1);
        input.value = laterTitle;
        input.dispatchEvent(new window.Event("input", { bubbles: true }));
        gate.resolve();
        await settle();
        assert.equal(visiblePanels(window)[0].querySelector(".work-item-title-edit input").value, laterTitle);
        await new Promise(resolve => setTimeout(resolve, 480));
        assert.equal(state.drafts[101].fields.find(field => field.name === "System.Title").value, laterTitle);
        assert.equal(state.drafts[101].rev, 2);
        state.holdWorkItemUpdate = null;
        visiblePanels(window)[0].querySelector(".editor-save").click();
        await settle();
        assert.equal(state.workItemUpdates[1].body.rev, 2);
        assert.equal(state.workItemUpdates[1].body.fields[0].value, laterTitle);
        assert.equal(visiblePanels(window)[0].querySelector(".work-item-title").textContent, laterTitle);
    });
}

test("a held comment submission preserves a field changed while the comment is posting", describeDom, async () => {
    const gate = deferred();
    const { window, state } = await boot({ homeWorkItems: [101], holdWorkItemComment: gate.promise });
    await openFromHome(window, 101);
    const input = editTitle(window, "First edit");
    const composer = visiblePanels(window)[0].querySelector(".comment-composer-body");
    composer.textContent = "Posted discussion";
    composer.dispatchEvent(new window.Event("input", { bubbles: true }));
    visiblePanels(window)[0].querySelector(".comment-submit").click();
    await settle();
    input.value = "Changed while posting";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    gate.resolve();
    await settle();
    assert.equal(visiblePanels(window)[0].querySelector(".work-item-title-edit input").value, "Changed while posting");
    assert.equal(visiblePanels(window)[0].querySelector(".comment-composer-body").textContent, "");
    assert.match(visiblePanels(window)[0].querySelector(".work-item-discussion").textContent, /Posted discussion/);
    await new Promise(resolve => setTimeout(resolve, 480));
    assert.equal(state.drafts[101].fields[0].value, "Changed while posting");
    assert.equal(state.drafts[101].comment.content, "");
    assert.equal(state.workItemUpdates, undefined);
});

for (const mutation of ["fields", "comment"]) {
    test(`closing and discarding during a pending ${mutation} mutation cannot resurrect its draft`, describeDom, async () => {
        const gate = deferred();
        const { window, state } = await boot({ homeWorkItems: [101], [mutation === "fields" ? "holdWorkItemUpdate" : "holdWorkItemComment"]: gate.promise });
        await openFromHome(window, 101);
        editTitle(window, "Discard this edit");
        if (mutation === "comment") {
            const composer = visiblePanels(window)[0].querySelector(".comment-composer-body");
            composer.textContent = "A pending comment";
            composer.dispatchEvent(new window.Event("input", { bubbles: true }));
        }
        await new Promise(resolve => setTimeout(resolve, 480));
        assert.ok(state.drafts[101]);
        visiblePanels(window)[0].querySelector(mutation === "fields" ? ".editor-save" : ".comment-submit").click();
        await settle();
        let confirmed = 0;
        window.confirm = () => { confirmed += 1; return true; };
        await closeTab(window, 1);
        assert.equal(confirmed, 1);
        assert.deepEqual(titles(window), ["Home"]);
        gate.resolve();
        await new Promise(resolve => setTimeout(resolve, 480));
        assert.equal(state.drafts[101], undefined);
        assert.deepEqual(titles(window), ["Home"]);
        await openFromHome(window, 101);
        assert.doesNotMatch(visiblePanels(window)[0].textContent, /saved draft is available/);
        assert.equal(visiblePanels(window)[0].querySelector(".work-item-title-edit"), null);
    });
}

for (const choice of ["Restore draft", "Discard draft"]) {
    test(`a pending saved draft blocks editing and comments until ${choice}`, describeDom, async () => {
        const { window, state } = await boot({ homeWorkItems: [101], drafts: { 101: {
            rev: 1, baseValues: { "System.Title": "WI 101" },
            fields: [{ name: "System.Title", value: "Stored title", isHtml: false }],
            comment: { content: "Stored comment", mentions: [] },
        } } });
        await openFromHome(window, 101);
        const itemPanel = visiblePanels(window)[0];
        assert.match(itemPanel.querySelector(".draft-notice").textContent, /Restore or discard it before editing or commenting/);
        assert.equal(itemPanel.querySelector(".inline-edit, .editor-save, .comment-composer, .attachment-upload"), null);
        [...itemPanel.querySelectorAll(".draft-notice button")].find(button => button.textContent === choice).click();
        if (choice === "Restore draft") {
            assert.equal(itemPanel.querySelector(".work-item-title-edit input").value, "Stored title");
            assert.equal(itemPanel.querySelector(".comment-composer-body").textContent, "Stored comment");
        } else {
            assert.ok(itemPanel.querySelector(".work-item-title-row .inline-edit"));
            assert.equal(itemPanel.querySelector(".comment-composer-body").textContent, "");
            await new Promise(resolve => setTimeout(resolve, 480));
            assert.equal(state.drafts[101], undefined);
        }
        assert.equal(state.workItemUpdates, undefined);
        assert.equal(state.workItemComments, undefined);
    });
}

test("an attachment-only revision change before editing advances the revision used by Save", describeDom, async () => {
    const { window, state } = await boot({ homeWorkItems: [101] });
    await openFromHome(window, 101);
    const upload = visiblePanels(window)[0].querySelector(".work-item-attachments input[type=file]");
    assert.ok(upload);
    const file = new window.File(["image data"], "widget.png", { type: "image/png" });
    Object.defineProperty(upload, "files", { value: [file] });
    upload.dispatchEvent(new window.Event("change", { bubbles: true }));
    await settle();
    assert.equal(state.attachments[0].file, file);
    assert.match(state.attachments[0].path, /fileName=widget.png/);
    assert.match(visiblePanels(window)[0].querySelector(".attachment-status").textContent, /Attached widget.png/);
    editTitle(window, "Edited after upload");
    visiblePanels(window)[0].querySelector(".editor-save").click();
    await settle();
    assert.equal(state.workItemUpdates[0].body.rev, 2);
    assert.equal(visiblePanels(window)[0].querySelector(".work-item-title").textContent, "Edited after upload");
    assert.doesNotMatch(visiblePanels(window)[0].querySelector(".draft-notice").textContent, /changed|conflict/i);
});
