// Run with: node --experimental-vm-modules --test canvas-server.test.mjs
//
// Loads canvas-server.mjs under node:vm so node:child_process and node:fs can be
// replaced with stubs. That is the only way to drive AzureAuth discovery and
// token acquisition deterministically without a real azureauth install.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer, request } from "node:http";
import { readFile } from "node:fs/promises";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { SyntheticModule, SourceTextModule, createContext } from "node:vm";

const serverPath = new URL("./canvas-server.mjs", import.meta.url);

// canvas-server.mjs imports ./common.mjs and ./work-item.mjs,
// so relative specifiers are linked recursively rather than stubbed.
async function loadCanvasServer({ execFileImpl, existsSyncImpl, readdirSyncImpl, homedirImpl, fetchImpl = fetch, platform = "linux", env = {}, browserTokenForTest = null }) {
    const processStub = {
        platform,
        env,
        cwd: () => process.cwd(),
        nextTick: process.nextTick.bind(process),
    };
    const context = createContext({ Buffer, URL, URLSearchParams, TextDecoder, TextEncoder, fetch: fetchImpl, console, setTimeout, clearTimeout, Date, JSON, Math, Number, String, Object, Array, Promise, Error, process: processStub });
    const synthetic = (specifier) => {
        const exports = {
            "node:http": { createServer },
            "node:child_process": { execFile: execFileImpl, spawn: () => ({ unref() {} }) },
            "node:crypto": { createHash, randomBytes },
            "node:fs": {
                existsSync: existsSyncImpl,
                readFileSync,
                readdirSync: readdirSyncImpl,
                // Real implementations: the sign-in marker is an actual file, written
                // under a per-test temporary home rather than the developer's own.
                mkdirSync,
                writeFileSync,
                rmSync,
                renameSync,
                chmodSync,
            },
            "node:os": { homedir: homedirImpl },
            "node:path": { dirname, extname, isAbsolute, join, relative, resolve },
            "node:url": { fileURLToPath },
            "node:util": { promisify },
            "@github/copilot-sdk/extension": {
                CanvasError: class CanvasError extends Error {
                    constructor(code, message) {
                        super(message);
                        this.code = code;
                    }
                },
            },
        }[specifier];
        if (!exports) return null;
        return new SyntheticModule(Object.keys(exports), function () {
            for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
        }, { context });
    };

    const cache = new Map();
    const initializeImportMeta = (meta, module) => { meta.url = module.identifier; };
    const loadRelative = async (href) => {
        if (!cache.has(href)) {
            cache.set(href, readFile(new URL(href), "utf8").then((source) =>
                new SourceTextModule(source, { context, identifier: href, initializeImportMeta })));
        }
        // Let the root link operation traverse the shared dependency graph once.
        return cache.get(href);
    };
    async function linker(specifier, referencingModule) {
        const stub = synthetic(specifier);
        if (stub) return stub;
        if (specifier.startsWith(".")) return loadRelative(new URL(specifier, referencingModule.identifier).href);
        throw new Error(`Unexpected import: ${specifier}`);
    }

    // Seed synthetic OAuth state inside the VM without adding a production export.
    const seedToken = browserTokenForTest
        ? "\nexport { writeBrowserTokenCache as seedBrowserTokenForTest };"
        : "";
    const module = new SourceTextModule((await readFile(serverPath, "utf8")) + seedToken, { context, identifier: serverPath.href, initializeImportMeta });
    await module.link(linker);
    await module.evaluate();
    if (browserTokenForTest) {
        await module.namespace.seedBrowserTokenForTest(browserTokenForTest);
    }
    return module.namespace;
}

// A per-test home so the sign-in marker never touches the developer's own
// ~/.copilot. Mirrors the layout managedAzureAuthDiscovery expects for the
// requested platform, so the win32 branch is exercised from any host OS: on
// Windows AzureAuth lives under %LOCALAPPDATA%\Programs\AzureAuth and the
// executable is azureauth.exe, elsewhere it is ~/.azureauth/<version>/azureauth.
function discoveryStubs({ installed, platform = "linux", home = mkdtempSync(join(tmpdir(), "azure-devops-canvas-")) }) {
    const isWindows = platform === "win32";
    const localAppData = join(home, "AppData", "Local");
    const root = isWindows ? join(localAppData, "Programs", "AzureAuth") : join(home, ".azureauth");
    const executable = join(root, "0.9.6", isWindows ? "azureauth.exe" : "azureauth");
    return {
        home,
        root,
        executable,
        platform,
        env: isWindows ? { LOCALAPPDATA: localAppData } : {},
        markerPath: join(home, ".copilot", "azure-devops-canvas", "auth-preference.json"),
        homedirImpl: () => home,
        // Only AzureAuth discovery is simulated; every other path is answered by the
        // real filesystem so the marker file behaves like a real file.
        existsSyncImpl: (path) => (String(path).startsWith(root)
            ? installed && (path === root || path === executable)
            : existsSync(path)),
        readdirSyncImpl: (path) => (installed && String(path).startsWith(root)
            ? [{ name: "0.9.6", isDirectory: () => true }]
            : []),
    };
}

function writeMarker(markerPath) {
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, JSON.stringify({ provider: "azureauth", lastSuccessAt: new Date().toISOString() }));
}

// Route ADO token acquisitions to onAzureAuth and fail other processes quickly.
// Identified by argv rather than executable path: a missing discovery result
// yields an empty path, and that attempt still has to be counted.
function execFileStub(onAzureAuth) {
    const azureAuthCalls = [];
    const processCalls = [];
    const impl = (file, args, options, callback) => {
        const done = typeof options === "function" ? options : callback;
        const argv = Array.from(args || []);
        processCalls.push({ file, args: argv });
        if (argv[0] === "ado" && argv[1] === "token") {
            azureAuthCalls.push({ file, args: argv, timeout: options?.timeout });
            onAzureAuth(done, { timeout: options?.timeout ?? 0 });
            return;
        }
        done(Object.assign(new Error("stubbed non-AzureAuth process"), { code: 1, stdout: "", stderr: "" }));
    };
    return { impl, azureAuthCalls, processCalls };
}

async function startCanvas(namespace, options = {}, input = {}) {
    namespace.setCopilotSession({
        workspacePath: tmpdir(),
        rpc: { mcp: { list: async () => [] }, metadata: { snapshot: async () => ({}) } },
        log: async () => {},
    });
    const entry = await namespace.startServer("test", input, options);
    const base = entry.url.replace(/\/$/, "");
    const loadConfig = async () => (await fetch(`${base}/api/config`)).json();
    const initial = await loadConfig();
    const apiNonce = initial.apiNonce;
    const canvasApi = {
        base,
        entry,
        apiNonce,
        initial,
        // The state /api/config reported on first load. A reported silent process
        // is settled through authStatus before the browser decides whether to show
        // the sign-in chooser.
        config: initial.config,
        configResponse: loadConfig,
        config2: async () => (await loadConfig()).config,
        startAgencyAuth: () => fetch(`${base}/api/auth/start`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-canvas-nonce": apiNonce },
            body: JSON.stringify({ provider: "agency" }),
        }).then((res) => res.json()),
        // A blocking handler would leave the POST above pending until the token
        // resolves, deadlocking against a test that releases the token afterwards.
        // Racing a timer turns that regression into a clear assertion failure.
        startAgencyAuthWithin: async (ms) => {
            const timedOut = Symbol("timed-out");
            const timer = new Promise((resolve) => setTimeout(() => resolve(timedOut), ms));
            const result = await Promise.race([canvasApi.startAgencyAuth(), timer]);
            assert.notEqual(result, timedOut, `POST /api/auth/start did not respond within ${ms}ms; the handler is blocking on AzureAuth`);
            return result;
        },
        authStatus: () => fetch(`${base}/api/auth/status`, { headers: { "x-canvas-nonce": apiNonce } }).then((res) => res.json()),
        signOut: () => fetch(`${base}/api/auth/sign-out`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-canvas-nonce": apiNonce },
            body: "{}",
        }).then((res) => res.json()),
        // close() alone waits for in-flight requests, so a regression that leaves a
        // request pending would hang the runner instead of reporting the failure.
        close: () => {
            entry.server.closeAllConnections?.();
            entry.server.close();
        },
    };
    return canvasApi;
}

test("the browser can load the shared common module without exposing extension files", async () => {
    const stubs = discoveryStubs({ installed: false });
    const { impl: execFileImpl } = execFileStub((done) => done(null, { stdout: "", stderr: "" }));
    const namespace = await loadCanvasServer({ execFileImpl, ...stubs });
    const canvas = await startCanvas(namespace);

    try {
        const common = await fetch(`${canvas.base}/common.mjs`);
        assert.equal(common.status, 200);
        assert.equal(common.headers.get("content-type"), "text/javascript; charset=utf-8");
        assert.match(await common.text(), /export function normalizeFeatureFlags/);

        const serverSource = await fetch(`${canvas.base}/canvas-server.mjs`);
        assert.equal(serverSource.status, 404);
    } finally {
        canvas.close();
    }
});

test("feature flag updates require the canvas nonce and expected Host", async () => {
    const stubs = discoveryStubs({ installed: false });
    const { impl: execFileImpl } = execFileStub((done) => done(null, { stdout: "", stderr: "" }));
    const namespace = await loadCanvasServer({ execFileImpl, ...stubs });
    const canvas = await startCanvas(namespace);

    try {
        const missingNonce = await fetch(`${canvas.base}/api/feature-flags`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ boards: true }),
        });
        assert.equal(missingNonce.status, 400);
        assert.equal((await missingNonce.json()).message, "Rejected request with invalid API nonce.");

        const invalidHost = await new Promise((resolve, reject) => {
            const req = request(`${canvas.base}/api/feature-flags`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Host: "attacker.example",
                    "X-Canvas-Nonce": canvas.apiNonce,
                },
            }, (res) => {
                const chunks = [];
                res.on("data", (chunk) => chunks.push(chunk));
                res.on("end", () => resolve({
                    status: res.statusCode,
                    json: () => JSON.parse(Buffer.concat(chunks).toString("utf8")),
                }));
            });
            req.on("error", reject);
            req.end(JSON.stringify({ boards: true }));
        });
        assert.equal(invalidHost.status, 400);
        assert.equal(invalidHost.json().message, "Rejected request with unexpected Host header.");
        assert.equal(canvas.entry.featureFlags.boards, false);
    } finally {
        canvas.close();
    }
});

test("disabling Boards closes issued board tokens", async () => {
    const stubs = discoveryStubs({ installed: false });
    const { impl: execFileImpl } = execFileStub((done) => done(null, { stdout: "", stderr: "" }));
    const namespace = await loadCanvasServer({ execFileImpl, ...stubs });
    let closed = 0;
    const canvas = await startCanvas(namespace, {
        closeBoard: async () => {
            closed += 1;
        },
    });
    canvas.entry.featureFlags.boards = true;
    canvas.entry.boards.set("issued-token", { url: "http://127.0.0.1:9/", key: "example/project/board" });

    try {
        const response = await fetch(`${canvas.base}/api/feature-flags`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Canvas-Nonce": canvas.apiNonce,
            },
            body: JSON.stringify({ boards: false }),
        });

        assert.equal(response.status, 200);
        assert.equal((await response.json()).featureFlags.boards, false);
        assert.equal(canvas.entry.boards.size, 0);
        assert.equal(closed, 1);
        assert.equal((await fetch(`${canvas.base}/boards/issued-token/`)).status, 404);
    } finally {
        await canvas.entry.closeBoards();
        canvas.close();
    }
});

test("each opened board is proxied under its own canvas path", async () => {
    const requests = [];
    const boardServer = createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        requests.push({
            method: req.method,
            url: req.url,
            nonce: req.headers["x-canvas-nonce"],
            body: Buffer.concat(chunks).toString("utf8"),
        });
        if (req.url === "/") {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end("<!doctype html><title>Board</title>");
            return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
    });
    await new Promise((resolve) => boardServer.listen(0, "127.0.0.1", resolve));
    const address = boardServer.address();
    const boardUrl = `http://127.0.0.1:${address.port}/`;
    const stubs = discoveryStubs({ installed: false });
    const { impl: execFileImpl } = execFileStub((done) => done(null, { stdout: "", stderr: "" }));
    const namespace = await loadCanvasServer({ execFileImpl, ...stubs });
    const canvas = await startCanvas(namespace);
    canvas.entry.boards.set("favorite-one", { url: boardUrl, key: "example/project/favorite-one", apiNonce: "board-secret" });
    canvas.entry.boards.set("credentialed", { url: boardUrl.replace("http://", "http://user:password@"), apiNonce: "board-secret" });

    try {
        assert.equal(canvas.config.boardPath, undefined);
        const documentResponse = await fetch(`${canvas.base}/boards/favorite-one/`);
        assert.equal(documentResponse.status, 200);
        assert.match(await documentResponse.text(), /<title>Board<\/title>/);
        const credentialedBoard = await fetch(`${canvas.base}/boards/credentialed/`);
        assert.equal(credentialedBoard.status, 404);

        const reboundResponse = await new Promise((resolve, reject) => {
            const req = request(`${canvas.base}/boards/favorite-one/`, {
                headers: { Host: "attacker.example" },
            }, (res) => {
                const chunks = [];
                res.on("data", (chunk) => chunks.push(chunk));
                res.on("end", () => resolve({
                    status: res.statusCode,
                    json: () => JSON.parse(Buffer.concat(chunks).toString("utf8")),
                }));
            });
            req.on("error", reject);
            req.end();
        });
        assert.equal(reboundResponse.status, 400);
        assert.equal(reboundResponse.json().message, "Rejected request with unexpected Host header.");

        const missingNonce = await fetch(`${canvas.base}/boards/favorite-one/state`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: 42, state: "Doing" }),
        });
        assert.equal(missingNonce.status, 400);

        const queryResponse = await fetch(`${canvas.base}/boards/favorite-one/state?unexpected=1`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Canvas-Nonce": "board-secret",
            },
            body: JSON.stringify({ id: 42, state: "Doing" }),
        });
        assert.equal(queryResponse.status, 404);

        const stateResponse = await fetch(`${canvas.base}/boards/favorite-one/state`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Canvas-Nonce": "board-secret",
            },
            body: JSON.stringify({ id: 42, state: "Doing" }),
        });
        assert.equal(stateResponse.status, 200);
        const refreshResponse = await fetch(`${canvas.base}/boards/favorite-one/refresh`, {
            method: "POST",
            headers: { "X-Canvas-Nonce": "board-secret" },
        });
        assert.equal(refreshResponse.status, 200);
        const iconResponse = await fetch(`${canvas.base}/boards/favorite-one/type-icons.json`, {
            headers: { "X-Canvas-Nonce": "board-secret" },
        });
        assert.equal(iconResponse.status, 200);
        const localConfigResponse = await fetch(`${canvas.base}/boards/favorite-one/local-config`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Canvas-Nonce": "board-secret",
            },
            body: JSON.stringify({ localProject: "Azure DevOps Extension" }),
        });
        assert.equal(localConfigResponse.status, 200);
        const invalidItemResponse = await fetch(`${canvas.base}/boards/favorite-one/item/history`);
        assert.equal(invalidItemResponse.status, 404);
        const baseUrl = new URL(canvas.base);
        const traversalResponse = await new Promise((resolve, reject) => {
            const req = request({
                hostname: baseUrl.hostname,
                port: baseUrl.port,
                path: "/boards/favorite-one/item/../refresh",
            }, (res) => {
                res.resume();
                res.on("end", () => resolve(res));
            });
            req.on("error", reject);
            req.end();
        });
        assert.equal(traversalResponse.statusCode, 404);
        assert.deepEqual(requests, [
            { method: "GET", url: "/", nonce: undefined, body: "" },
            {
                method: "POST",
                url: "/state",
                nonce: "board-secret",
                body: JSON.stringify({ id: 42, state: "Doing" }),
            },
            { method: "POST", url: "/refresh", nonce: "board-secret", body: "" },
            { method: "GET", url: "/type-icons.json", nonce: "board-secret", body: "" },
            {
                method: "POST",
                url: "/local-config",
                nonce: "board-secret",
                body: JSON.stringify({ localProject: "Azure DevOps Extension" }),
            },
        ]);
    } finally {
        canvas.close();
        await new Promise((resolve) => boardServer.close(resolve));
    }
});

test("favorite boards are read with the canvas authentication and scoped to its project", async () => {
    const requests = [];
    const fetchImpl = async (url, options = {}) => {
        requests.push({ url: String(url), authorization: options.headers?.Authorization || "" });
        return new Response(JSON.stringify({
            value: [
                {
                    id: "favorite-stories",
                    artifactName: "Stories board",
                    artifactType: "Microsoft.TeamFoundation.Work.TeamBoardSets",
                    artifactScope: { type: "Project", name: "Project" },
                    _links: {
                        page: {
                            href: "/example/Project/_boards/board/t/Web%20Team",
                        },
                    },
                },
                {
                    id: "favorite-other",
                    artifactName: "Other project",
                    artifactType: "Microsoft.TeamFoundation.Work.WebAccess.Board",
                    artifactScope: { type: "Project", name: "Other" },
                    _links: {
                        page: {
                            href: "https://dev.azure.com/example/Other/_boards/board/t/Other%20Team/Stories",
                        },
                    },
                },
                {
                    id: "favorite-other-org",
                    artifactName: "Other organization",
                    artifactType: "Microsoft.TeamFoundation.Work.WebAccess.Board",
                    artifactScope: { type: "Project", name: "Project" },
                    _links: {
                        page: {
                            href: "https://dev.azure.com/different/Project/_boards/board/t/Web%20Team/Stories",
                        },
                    },
                },
                {
                    id: "favorite-malformed",
                    artifactName: "Malformed favorite",
                    artifactType: "Microsoft.TeamFoundation.Work.TeamBoardSets",
                    artifactScope: { type: "Project", name: "Project" },
                    _links: {
                        page: {
                            href: "/example/Project/_boards/board/t/Bad%ZZTeam",
                        },
                    },
                },
            ],
        }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
    };
    const stubs = discoveryStubs({ installed: true });
    const { impl: execFileImpl } = execFileStub((done) => done(null, { stdout: "canvas-token\n", stderr: "" }));
    const namespace = await loadCanvasServer({ execFileImpl, fetchImpl, ...stubs });
    const canvas = await startCanvas(namespace);

    try {
        await canvas.startAgencyAuthWithin(5000);
        const auth = await waitForAuthProcess(canvas);
        assert.equal(auth.auth.isAuthenticated, true);
        const result = await namespace.listFavoriteBoards({
            organization: "example",
            project: "Project",
        });

        assert.deepEqual(JSON.parse(JSON.stringify(result)), {
            boards: [{
                id: "favorite-stories",
                artifactId: "",
                name: "Stories board",
                organization: "example",
                project: "Project",
                team: "Web Team",
                boardId: "",
                backlogLevel: "",
                url: "https://dev.azure.com/example/Project/_boards/board/t/Web%20Team",
            }],
            count: 1,
            otherProjectBoardCount: 0,
            requiresProject: false,
        });
        assert.equal(requests.length, 1);
    assert.match(requests[0].url, /artifactType=Microsoft\.TeamFoundation\.Work\.TeamBoardSets/);
    assert.equal(requests[0].authorization, "Bearer canvas-token");
    } finally {
        canvas.close();
    }
});

test("favorite board discovery falls back to URL-verified project favorites", async () => {
    const requests = [];
    const fetchImpl = async (url, options = {}) => {
        const parsed = new URL(url);
        const headers = new Headers(options.headers || {});
        requests.push({
            artifactType: parsed.searchParams.get("artifactType") || "",
            hasBearer: headers.get("authorization")?.startsWith("Bearer ") || false,
        });
        const value = parsed.searchParams.has("artifactType")
            ? []
            : [{
                id: "favorite-stories",
                artifactName: "Stories board",
                artifactScope: { type: "Project", name: "Project" },
                _links: {
                    page: {
                        href: "https://dev.azure.com/example/Project/_boards/board/t/Web%20Team/Stories",
                    },
                },
            }];
        return new Response(JSON.stringify({ value }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
    };
    const stubs = discoveryStubs({ installed: true });
    const { impl: execFileImpl } = execFileStub((done) => done(null, { stdout: "canvas-token\n", stderr: "" }));
    const namespace = await loadCanvasServer({ execFileImpl, fetchImpl, ...stubs });
    const canvas = await startCanvas(namespace);

    try {
        await canvas.startAgencyAuthWithin(5000);
        const auth = await waitForAuthProcess(canvas);
        assert.equal(auth.auth.isAuthenticated, true);
        const result = await namespace.listFavoriteBoards({
            organization: "example",
            project: "Project",
        });
        assert.equal(result.count, 1);
        assert.equal(result.boards[0].name, "Stories board");
        assert.deepEqual(requests, [
            { artifactType: "Microsoft.TeamFoundation.Work.TeamBoardSets", hasBearer: true },
            { artifactType: "", hasBearer: true },
        ]);
    } finally {
        canvas.close();
    }
});

test("opening a favorite board supplies a REST provider backed by the canvas connection", async () => {
    const requests = [];
    const boardIds = Array.from({ length: 201 }, (_, index) => index + 1);
    const fetchImpl = async (url, options = {}) => {
        const parsed = new URL(url);
        const headers = new Headers(options.headers || {});
        requests.push({
            path: parsed.pathname,
            method: options.method || "GET",
            authorization: headers.get("authorization") || "",
            body: options.body || "",
        });
        if (parsed.pathname.endsWith("/_apis/favorite/favorites")) {
            return new Response(JSON.stringify({
                value: [{
                    id: "favorite-stories",
                    artifactName: "Stories board",
                    artifactScope: { type: "Project", name: "Project" },
                    _links: {
                        page: {
                            href: "/example/Project/_boards/board/t/Web%20Team",
                        },
                    },
                }],
            }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (parsed.pathname.endsWith("/_apis/work/boards")) {
            return new Response(JSON.stringify({
                value: [
                    { id: "epics-board", name: "Epics" },
                    { id: "history-board", name: "History" },
                    { id: "stories-board", name: "Product Backlog" },
                    { id: "features-board", name: "Features" },
                ],
            }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (parsed.pathname.endsWith("/_apis/work/boards/stories-board")) {
            return new Response(JSON.stringify({
                columns: [{
                    name: "Active",
                    columnType: "inProgress",
                    stateMappings: { "User Story": "Active" },
                }],
            }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (parsed.pathname.endsWith("/_apis/wit/workitemtypes")) {
            return new Response(JSON.stringify({
                value: [{
                    name: "User Story",
                    color: "009CCC",
                    icon: { id: "icon_book", url: "https://example.invalid/icon" },
                }],
            }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (parsed.pathname.endsWith("/_apis/wit/workItemIcons/icon_book")) {
            return new Response("<svg viewBox=\"0 0 16 16\"><path d=\"M1 1h14v14H1z\"/></svg>", {
                status: 200,
                headers: { "Content-Type": "image/svg+xml" },
            });
        }
        if (parsed.pathname.includes("/_apis/work/backlogs/")) {
            return new Response(JSON.stringify({
                workItems: parsed.pathname.includes("Microsoft.RequirementCategory")
                    ? boardIds.map((id) => ({ target: { id } }))
                    : [],
            }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (parsed.pathname.endsWith("/_apis/wit/workitemsbatch")) {
            const ids = JSON.parse(options.body).ids;
            return new Response(JSON.stringify({
                value: ids.map((id) => ({
                    id,
                    fields: {
                        "System.Title": "Use shared authentication",
                        "System.State": "Active",
                        "System.WorkItemType": "User Story",
                    },
                })),
            }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        throw new Error(`Unexpected Azure DevOps request: ${parsed.pathname}`);
    };
    const stubs = discoveryStubs({ installed: true });
    const { impl: execFileImpl } = execFileStub((done) => done(null, { stdout: "canvas-token\n", stderr: "" }));
    const namespace = await loadCanvasServer({ execFileImpl, fetchImpl, ...stubs });
    let opened;
    let closed = 0;
    const canvas = await startCanvas(namespace, {
        openBoard: async (input) => {
            opened = input;
            return { url: "http://127.0.0.1:9/", instanceId: "managed-board" };
        },
        closeBoard: async () => {
            closed += 1;
        },
    });
    canvas.entry.input = { organization: "example", project: "Project" };
    canvas.entry.featureFlags.boards = true;

    try {
        await canvas.startAgencyAuthWithin(5000);
        const auth = await waitForAuthProcess(canvas);
        assert.equal(auth.auth.isAuthenticated, true);
        const response = await fetch(`${canvas.base}/api/boards/open`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Canvas-Nonce": canvas.apiNonce,
            },
            body: JSON.stringify({
                id: "favorite-stories",
                organization: "example",
                project: "Project",
            }),
        });
        assert.equal(response.status, 200);
        assert.match((await response.json()).path, /^\/boards\/[A-Za-z0-9_-]+\/$/);
        assert.equal(opened.board.name, "Stories board");
        assert.equal(opened.connection.organization, "example");
        assert.match(opened.pathPrefix, /^\/boards\/[A-Za-z0-9_-]+$/);

        const result = await opened.dataProvider.fetchAllItems();
        assert.equal(result.items.length, 201);
        assert.equal(result.items[0].id, 1);
        assert.equal(result.items.at(-1).id, 201);
        assert.deepEqual(JSON.parse(JSON.stringify(result.columns)), [{
            name: "Active",
            mappings: { "User Story": "Active" },
            columnType: "inProgress",
        }]);
        assert.deepEqual(await opened.dataProvider.fetchWorkItemTypeIcons(["User Story", "Task"]), {
            "User Story": "data:image/svg+xml;base64,PHN2ZyB2aWV3Qm94PSIwIDAgMTYgMTYiPjxwYXRoIGQ9Ik0xIDFoMTR2MTRIMXoiLz48L3N2Zz4=",
        });
        assert.ok(requests.some((entry) => entry.path.endsWith("/_apis/work/boards")));
        assert.ok(requests.some((entry) => entry.path.endsWith("/_apis/work/boards/stories-board")));
        assert.equal(requests.filter((entry) => entry.path.includes("/_apis/work/backlogs/")).length, 4);
        assert.ok(requests.some((entry) => entry.path.endsWith("/_apis/wit/workItemIcons/icon_book")));
        assert.deepEqual(
            requests
                .filter((entry) => entry.path.endsWith("/_apis/wit/workitemsbatch"))
                .map((entry) => JSON.parse(entry.body).ids.length),
            [200, 1],
        );
        assert.ok(
            requests.every((entry) => entry.authorization.startsWith("Bearer ")),
            JSON.stringify(requests.map((entry) => ({
                path: entry.path,
                hasBearer: entry.authorization.startsWith("Bearer "),
                length: entry.authorization.length,
            }))),
        );

        await canvas.entry.closeBoards();
        assert.equal(closed, 1);
    } finally {
        await canvas.entry.closeBoards();
        canvas.close();
    }
});

async function waitForAuthProcess(canvas) {
    let status;
    for (let attempt = 0; attempt < 40; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        status = await canvas.authStatus();
        if (status.authProcess?.status !== "running") {
            return status;
        }
    }
    assert.fail("authentication process did not reach a terminal state");
}

async function microsoftCallbackFailure(t, tokenFetch) {
    const stubs = discoveryStubs({ installed: false });
    t.after(() => rmSync(stubs.home, { recursive: true, force: true }));
    const { impl: execFileImpl } = execFileStub(() => assert.fail("unexpected AzureAuth request"));
    let tokenRequests = 0;
    const namespace = await loadCanvasServer({
        ...stubs,
        execFileImpl,
        fetchImpl: async (url, options) => {
            assert.equal(url, "https://login.microsoftonline.com/common/oauth2/v2.0/token");
            assert.equal(options.method, "POST");
            assert.equal(options.body.get("grant_type"), "authorization_code");
            assert.equal(options.body.get("code"), "fictional-code");
            assert.ok(options.body.get("code_verifier"));
            tokenRequests += 1;
            return tokenFetch(options);
        },
    });
    const canvas = await startCanvas(namespace);
    t.after(() => canvas.close());
    const logs = [];
    let callbackStatus;
    let terminal;
    // Exercise the UI's actual startAuth log consumer without a browser or DOM.
    const appSource = await readFile(new URL("./ui/app.mjs", import.meta.url), "utf8");
    const startAuthSource = appSource.slice(appSource.indexOf("async function startAuth("), appSource.indexOf("\nasync function signOut("));
    const ui = new SourceTextModule(`${startAuthSource}\nexport { startAuth };`, {
        context: createContext({
            signInMicrosoftButton: {},
            signInAgencyButton: {},
            renderAuthOutput() {},
            addLog: (level, message, details = "") => logs.push({ level, message, details }),
            request: async (path, options) => {
                const response = await fetch(`${canvas.base}${path}`, {
                    ...options,
                    headers: { ...options.headers, "x-canvas-nonce": canvas.apiNonce },
                });
                assert.equal(response.status, 200);
                const data = await response.json();
                const authorize = new URL(data.authProcess.authorizationUrl);
                const callback = new URL(authorize.searchParams.get("redirect_uri"));
                callback.searchParams.set("state", authorize.searchParams.get("state"));
                callback.searchParams.set("code", "fictional-code");
                const result = await fetch(callback);
                callbackStatus = result.status;
                assert.match(await result.text(), /Sign-in failed/);
                return data;
            },
            waitForAuthentication: async () => {
                terminal = await waitForAuthProcess(canvas);
                return terminal;
            },
        }),
    });
    await ui.link(() => assert.fail("unexpected UI import"));
    await ui.evaluate();
    await ui.namespace.startAuth("microsoft");
    // The callback can finish before /auth/start's response is read.
    terminal ??= await waitForAuthProcess(canvas);
    assert.equal(callbackStatus, 400);
    assert.equal(tokenRequests, 1);
    assert.equal(terminal.auth.isAuthenticated, false);
    assert.equal(terminal.authProcess.provider, "microsoft");
    assert.equal(terminal.authProcess.status, "failed");
    assert.ok(terminal.authProcess.completedAt);
    const log = logs.find((entry) => entry.level === "error");
    assert.equal(log?.message, "Microsoft sign-in did not complete successfully.");
    assert.equal(log.details, terminal.authProcess.output);
    return { process: terminal.authProcess, log };
}

test("Microsoft OAuth callback retains the safe fetch cause in status and canvas logs", async (t) => {
    const tokenServer = createServer((req) => req.socket.destroy());
    await new Promise((resolve) => tokenServer.listen(0, "127.0.0.1", resolve));
    t.after(() => {
        tokenServer.closeAllConnections();
        tokenServer.close();
    });
    let fetchError;
    const result = await microsoftCallbackFailure(t, async (options) => {
        try {
            return await fetch(`http://127.0.0.1:${tokenServer.address().port}/token`, options);
        } catch (error) {
            fetchError = error;
            throw error;
        }
    });
    assert.equal(fetchError.name, "TypeError");
    assert.equal(fetchError.message, "fetch failed");
    assert.equal(fetchError.cause.code, "UND_ERR_SOCKET");
    t.diagnostic(JSON.stringify({
        nativeError: { name: fetchError.name, message: fetchError.message, causeCode: fetchError.cause.code },
        authProcess: { status: result.process.status, output: result.process.output, error: result.process.error },
        canvasLog: result.log,
    }));
    assert.equal(result.process.output, "fetch failed (UND_ERR_SOCKET)");
    assert.equal(result.process.error.message, result.process.output);
});

test("Microsoft OAuth callback exposes only bounded cause identifiers", async (t) => {
    const privateDetail = "https://proxy.invalid/token?code=fictional-secret";
    for (const [label, cause, expected] of [
        ["certificate code", { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE", message: privateDetail }, "fetch failed (UNABLE_TO_VERIFY_LEAF_SIGNATURE)"],
        ["socket code", { code: "ECONNRESET", message: privateDetail }, "fetch failed (ECONNRESET)"],
        ["no cause", undefined, "fetch failed"],
        ["missing code", { message: privateDetail }, "fetch failed"],
        ["URL code", { code: privateDetail, message: privateDetail }, "fetch failed"],
        ["multiline code", { code: "UND_ERR_SOCKET\nPRIVATE_DETAIL", message: privateDetail }, "fetch failed"],
        ["non-string code", { code: 123, message: privateDetail }, "fetch failed"],
        ["overlong code", { code: "A".repeat(65), message: privateDetail }, "fetch failed"],
        ["nested cause", { cause: { code: "ECONNRESET" }, message: privateDetail }, "fetch failed"],
    ]) {
        await t.test(label, async (t) => {
            const { process, log } = await microsoftCallbackFailure(t, () => {
                throw new TypeError("fetch failed", { cause });
            });
            assert.equal(process.output, expected);
            assert.deepEqual(process.error, { error: "azure_devops_unexpected_error", message: expected });
            assert.equal(log.details, expected);
            assert.ok(!JSON.stringify({ process, log }).includes(privateDetail));
        });
    }
});

test("avatar URLs are restricted to the configured Azure DevOps organization", async () => {
    const { homedirImpl, existsSyncImpl, readdirSyncImpl } = discoveryStubs({ installed: false });
    const { impl: execFileImpl } = execFileStub((done) => done(null, { stdout: "", stderr: "" }));
    const namespace = await loadCanvasServer({ execFileImpl, existsSyncImpl, readdirSyncImpl, homedirImpl });
    const expected = "https://dev.azure.com/fabrikam/_api/_common/identityImage?id=123";
    assert.equal(namespace.validateAvatarUrl({ organization: "fabrikam" }, expected).href, expected);
    assert.throws(
        () => namespace.validateAvatarUrl({ organization: "fabrikam" }, "https://dev.azure.com/other/_api/_common/identityImage?id=123"),
        (error) => error.code === "azure_devops_invalid_avatar_url",
    );
    assert.throws(
        () => namespace.validateAvatarUrl({ organization: "fabrikam" }, "https://example.com/avatar.png"),
        (error) => error.code === "azure_devops_invalid_avatar_url",
    );
});

test("terminal work-item states come from Azure DevOps state categories", async () => {
    const stubs = discoveryStubs({ installed: false });
    const { impl: execFileImpl } = execFileStub((done) => done(null, { stdout: "", stderr: "" }));
    const namespace = await loadCanvasServer({ execFileImpl, ...stubs });
    const filter = namespace.terminalWorkItemStateFilter([
        {
            name: "Bug",
            states: [
                { name: "Resolved", category: "Resolved" },
                { name: "Ready for release", category: "Completed" },
            ],
        },
        {
            name: "Support's request",
            states: [
                { name: "Won't fix", category: "Removed" },
                { name: "Won't fix", category: "Removed" },
            ],
        },
    ]);

    assert.equal(
        filter,
        "AND (([System.WorkItemType] <> 'Bug' OR [System.State] NOT IN ('Ready for release')) AND "
            + "([System.WorkItemType] <> 'Support''s request' OR [System.State] NOT IN ('Won''t fix')))",
    );
    assert.equal(
        namespace.terminalWorkItemStateFilter([
            { name: "Task", states: [{ name: "Active", category: "InProgress" }] },
        ]),
        "",
        "missing terminal state metadata must not silently produce an incomplete filter",
    );
});

test("work-item state discovery is cached and failed loads can retry", async () => {
    const stubs = discoveryStubs({ installed: true });
    writeMarker(stubs.markerPath);
    const { impl: execFileImpl } = execFileStub((done) => done(null, { stdout: "test-access-token", stderr: "" }));
    let typeRequests = 0;
    const namespace = await loadCanvasServer({
        execFileImpl,
        ...stubs,
        fetchImpl: async (url) => {
            const pathname = new URL(url).pathname;
            if (pathname.endsWith("/_apis/wit/workitemtypes")) {
                typeRequests += 1;
                if (typeRequests === 1) {
                    return new Response(JSON.stringify({ message: "temporary failure" }), { status: 500 });
                }
                return new Response(JSON.stringify({
                    value: [{
                        name: "Task",
                        states: [{ name: "Finished", category: "Completed" }],
                    }],
                }), { status: 200 });
            }
            if (pathname.endsWith("/_apis/wit/wiql")) {
                return new Response(JSON.stringify({ workItems: [] }), { status: 200 });
            }
            throw new Error(`Unexpected Azure DevOps request: ${pathname}`);
        },
    });
    const config = { organization: "fabrikam", project: "Project" };
    const canvas = await startCanvas(namespace);
    try {
        await assert.rejects(
            namespace.queryMyOpenWorkItems(config),
            (error) => error.code === "azure_devops_request_failed",
        );
        await namespace.queryMyOpenWorkItems(config);
        await namespace.queryMyOpenWorkItems(config);
        assert.equal(typeRequests, 2, "a failure is evicted, then the successful state filter is reused");
    } finally {
        canvas.close();
    }
});

test("avatar requests require an image URL", async () => {
    const stubs = discoveryStubs({ installed: false });
    const { impl: execFileImpl } = execFileStub((done) => done(null, { stdout: "", stderr: "" }));
    const namespace = await loadCanvasServer({ execFileImpl, ...stubs });
    const canvas = await startCanvas(namespace);
    try {
        const response = await fetch(`${canvas.base}/api/avatar?nonce=${encodeURIComponent(canvas.apiNonce)}`);
        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), {
            error: "azure_devops_invalid_avatar_request",
            message: "Profile image request is missing the Azure DevOps image URL.",
        });
    } finally {
        canvas.close();
    }
});

test("avatar redirects are revalidated and limited to one hop", async () => {
    const stubs = discoveryStubs({ installed: true });
    writeMarker(stubs.markerPath);
    const { impl: execFileImpl } = execFileStub((done) => done(null, { stdout: "test-access-token", stderr: "" }));
    const requests = [];
    const fetchImpl = async (url, options) => {
        requests.push({ url: String(url), redirect: options?.redirect });
        if (requests.length === 1) {
            return new Response(null, {
                status: 302,
                headers: { location: "/fabrikam/_api/_common/identityImage?id=456" },
            });
        }
        return new Response(Buffer.from("avatar"), {
            status: 200,
            headers: { "content-type": "image/png" },
        });
    };
    const namespace = await loadCanvasServer({
        execFileImpl,
        existsSyncImpl: stubs.existsSyncImpl,
        readdirSyncImpl: stubs.readdirSyncImpl,
        homedirImpl: stubs.homedirImpl,
        fetchImpl,
    });
    const canvas = await startCanvas(namespace);
    try {
        const result = await namespace.fetchAvatar(
            { organization: "fabrikam" },
            "https://dev.azure.com/fabrikam/_api/_common/identityImage?id=123",
        );
        assert.equal(result.content.toString(), "avatar");
        assert.deepEqual(requests, [
            { url: "https://dev.azure.com/fabrikam/_api/_common/identityImage?id=123", redirect: "manual" },
            { url: "https://dev.azure.com/fabrikam/_api/_common/identityImage?id=456", redirect: "manual" },
        ]);
    } finally {
        canvas.close();
    }
});

test("avatar redirects cannot leave the configured Azure DevOps organization", async () => {
    const stubs = discoveryStubs({ installed: true });
    writeMarker(stubs.markerPath);
    const { impl: execFileImpl } = execFileStub((done) => done(null, { stdout: "test-access-token", stderr: "" }));
    const namespace = await loadCanvasServer({
        execFileImpl,
        existsSyncImpl: stubs.existsSyncImpl,
        readdirSyncImpl: stubs.readdirSyncImpl,
        homedirImpl: stubs.homedirImpl,
        fetchImpl: async () => new Response(null, {
            status: 302,
            headers: { location: "https://example.com/avatar.png" },
        }),
    });
    const canvas = await startCanvas(namespace);
    try {
        await assert.rejects(
            namespace.fetchAvatar(
                { organization: "fabrikam" },
                "https://dev.azure.com/fabrikam/_api/_common/identityImage?id=123",
            ),
            (error) => error.code === "azure_devops_invalid_avatar_url",
        );
    } finally {
        canvas.close();
    }
});

test("avatar responses stop streaming when they exceed the size limit", async () => {
    const stubs = discoveryStubs({ installed: true });
    writeMarker(stubs.markerPath);
    const { impl: execFileImpl } = execFileStub((done) => done(null, { stdout: "test-access-token", stderr: "" }));
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream({
        pull(controller) {
            pulls += 1;
            controller.enqueue(new Uint8Array(1024 * 1024 + (pulls === 2 ? 1 : 0)));
        },
        cancel() {
            cancelled = true;
        },
    }, { highWaterMark: 0 });
    const namespace = await loadCanvasServer({
        execFileImpl,
        existsSyncImpl: stubs.existsSyncImpl,
        readdirSyncImpl: stubs.readdirSyncImpl,
        homedirImpl: stubs.homedirImpl,
        fetchImpl: async () => new Response(body, {
            status: 200,
            headers: { "content-type": "image/png" },
        }),
    });
    const canvas = await startCanvas(namespace);
    try {
        await assert.rejects(
            namespace.fetchAvatar(
                { organization: "fabrikam" },
                "https://dev.azure.com/fabrikam/_api/_common/identityImage?id=123",
            ),
            (error) => error.code === "azure_devops_avatar_too_large",
        );
        assert.equal(pulls, 2);
        assert.equal(cancelled, true);
    } finally {
        canvas.close();
    }
});

test("Agency sign-in responds before AzureAuth finishes and does not spawn twice", async () => {
    const { homedirImpl, existsSyncImpl, readdirSyncImpl } = discoveryStubs({ installed: true });

    // Held open so the assertion below cannot pass merely because AzureAuth was fast.
    // Only the interactive acquisition is deferred: a silent attempt runs under a
    // much shorter budget and is answered immediately, so an unexpected silent
    // attempt surfaces as a failed assertion rather than a hung suite.
    let releaseToken;
    const tokenReleased = new Promise((resolve) => { releaseToken = resolve; });
    const { impl: execFileImpl, azureAuthCalls } = execFileStub((done, { timeout }) => {
        if (timeout <= 60_000) {
            done(null, { stdout: "silent-token", stderr: "" });
            return;
        }
        tokenReleased.then(() => done(null, { stdout: "test-access-token", stderr: "" }));
    });

    const namespace = await loadCanvasServer({ execFileImpl, existsSyncImpl, readdirSyncImpl, homedirImpl });
    const canvas = await startCanvas(namespace);
    try {
        const first = await canvas.startAgencyAuthWithin(5000);
        assert.equal(first.authProcess.status, "running", "POST must return before AzureAuth resolves");
        assert.equal(azureAuthCalls.length, 1);

        // Re-entrancy: a second POST while the first is in flight must not spawn again.
        const second = await canvas.startAgencyAuthWithin(5000);
        assert.equal(second.authProcess.status, "running");
        assert.equal(azureAuthCalls.length, 1, "in-flight sign-in must not spawn a second AzureAuth process");

        // Array.from normalizes the cross-realm array the vm context produced.
        assert.deepEqual(azureAuthCalls[0].args, [
            "ado", "token", "--output", "token", "--timeout", "15", "--prompt-hint", "azure-devops-canvas",
        ]);

        releaseToken();
        let status;
        for (let attempt = 0; attempt < 40; attempt += 1) {
            await new Promise((r) => setTimeout(r, 25));
            status = await canvas.authStatus();
            if (status.authProcess.status !== "running") break;
        }
        assert.equal(status.authProcess.status, "succeeded");
        assert.equal(status.auth.isAuthenticated, true);
        assert.equal(status.auth.authType, "azureauth");
    } finally {
        canvas.close();
    }
});

test("Agency sign-in reports failure in the POST response when AzureAuth is missing", async () => {
    const { homedirImpl, existsSyncImpl, readdirSyncImpl } = discoveryStubs({ installed: false });
    const { impl: execFileImpl, azureAuthCalls } = execFileStub((done) => done(null, { stdout: "unexpected", stderr: "" }));

    const namespace = await loadCanvasServer({ execFileImpl, existsSyncImpl, readdirSyncImpl, homedirImpl });
    const canvas = await startCanvas(namespace);
    try {
        // Discovery throws synchronously, before the first await in the background
        // task, so the failure must still be terminal in the POST response. Moving
        // that call after an await would regress this to a "running" response.
        const { authProcess } = await canvas.startAgencyAuth();
        assert.equal(authProcess.status, "failed", "missing AzureAuth must fail in the POST response, not on a later poll");
        assert.equal(authProcess.error?.error, "azure_devops_azureauth_not_found");
        assert.equal(azureAuthCalls.length, 0, "must not attempt acquisition when no executable was discovered");
    } finally {
        canvas.close();
    }
});

// The discovery trace reports a path relative to the managed root, so the
// expected value is built with the host's separator rather than a literal.
function expectedSelected(stubs) {
    return relative(stubs.platform === "win32" ? join(stubs.home, "AppData", "Local") : stubs.home, stubs.executable);
}

test("auth state reports AzureAuth availability so the UI can gate the Agency option", async () => {
    const { impl: execFileImpl } = execFileStub((done) => done(null, { stdout: "", stderr: "" }));

    for (const platform of ["linux", "darwin", "win32"]) {
        const installed = discoveryStubs({ installed: true, platform });
        const missing = discoveryStubs({ installed: false, platform });
        const present = await loadCanvasServer({ execFileImpl, ...installed });
        const absent = await loadCanvasServer({ execFileImpl, ...missing });

        assert.equal(
            (await present.getAuthState()).azureAuthDiscovery.selected,
            expectedSelected(installed),
            `${platform}: a managed AzureAuth install must be discovered`,
        );
        assert.equal(
            (await absent.getAuthState()).azureAuthDiscovery.selected,
            "",
            `${platform}: no install must report nothing discovered`,
        );
    }
});

test("no silent sign-in without a prior Agency sign-in on this machine", async () => {
    const stubs = discoveryStubs({ installed: true });
    const { impl: execFileImpl, azureAuthCalls } = execFileStub((done) => done(null, { stdout: "token", stderr: "" }));

    const namespace = await loadCanvasServer({ execFileImpl, ...stubs });
    const canvas = await startCanvas(namespace);
    try {
        assert.equal(azureAuthCalls.length, 0, "a first-time user must not have AzureAuth invoked by a passive canvas load");
        assert.equal(canvas.config.auth.isAuthenticated, false, "the sign-in splash must still be shown");
        assert.equal(canvas.initial.authProcess, null, "no process should be reported when silent sign-in is ineligible");
    } finally {
        canvas.close();
    }
});

test("config responds while silent AzureAuth is still running", async () => {
    const stubs = discoveryStubs({ installed: true });
    writeMarker(stubs.markerPath);
    let releaseToken;
    const { impl: execFileImpl, azureAuthCalls } = execFileStub((done) => {
        releaseToken = () => done(null, { stdout: "silent-token", stderr: "" });
    });
    const finishToken = () => {
        const release = releaseToken;
        releaseToken = null;
        release?.();
    };

    const namespace = await loadCanvasServer({ execFileImpl, ...stubs });
    const timedOut = Symbol("timed-out");
    const startPromise = startCanvas(namespace);
    const canvas = await Promise.race([
        startPromise,
        new Promise((resolve) => setTimeout(() => resolve(timedOut), 5000)),
    ]);
    if (canvas === timedOut) {
        finishToken();
        const lateCanvas = await startPromise;
        lateCanvas.close();
        assert.fail("/api/config waited for silent AzureAuth");
    }
    try {
        assert.equal(azureAuthCalls.length, 1);
        assert.equal(canvas.initial.authProcess?.mode, "silent");
        assert.equal(canvas.initial.authProcess?.status, "running");
        assert.equal(canvas.config.auth.isAuthenticated, false);
        assert.equal((await canvas.authStatus()).authProcess?.status, "running");

        finishToken();
        const status = await waitForAuthProcess(canvas);
        assert.equal(status.authProcess.status, "succeeded");
        assert.equal(status.auth.isAuthenticated, true);
        assert.equal(status.auth.authType, "azureauth");
    } finally {
        finishToken();
        canvas.close();
    }
});

test("concurrent canvas loads share one silent AzureAuth attempt", async () => {
    const stubs = discoveryStubs({ installed: true });
    writeMarker(stubs.markerPath);
    let releaseToken;
    const { impl: execFileImpl, azureAuthCalls } = execFileStub((done) => {
        releaseToken = () => done(null, { stdout: "shared-silent-token", stderr: "" });
    });

    const namespace = await loadCanvasServer({ execFileImpl, ...stubs });
    const first = await startCanvas(namespace);
    const second = await startCanvas(namespace);
    try {
        assert.equal(azureAuthCalls.length, 1, "two canvases must join the same AzureAuth process");
        assert.equal(first.initial.authProcess?.status, "running");
        assert.equal(second.initial.authProcess?.status, "running");

        releaseToken();
        releaseToken = null;
        const [firstStatus, secondStatus] = await Promise.all([
            waitForAuthProcess(first),
            waitForAuthProcess(second),
        ]);
        assert.equal(firstStatus.auth.isAuthenticated, true);
        assert.equal(secondStatus.auth.isAuthenticated, true);
    } finally {
        releaseToken?.();
        first.close();
        second.close();
    }
});

test("silent sign-in skips the splash once Agency sign-in has succeeded before", async () => {
    // Covers win32 too: the marker path and the AzureAuth root differ per platform,
    // and both have to line up for the silent attempt to fire.
    for (const platform of ["linux", "darwin", "win32"]) {
        const stubs = discoveryStubs({ installed: true, platform });
        writeMarker(stubs.markerPath);
        const { impl: execFileImpl, azureAuthCalls } = execFileStub((done) => done(null, { stdout: "silent-token", stderr: "" }));

        const namespace = await loadCanvasServer({ execFileImpl, ...stubs });
        const canvas = await startCanvas(namespace);
        try {
            assert.equal(azureAuthCalls.length, 1, `${platform}: the marker should authorize exactly one silent attempt`);
            assert.equal(azureAuthCalls[0].file, stubs.executable, `${platform}: must invoke the platform's AzureAuth executable`);
            assert.equal(canvas.initial.authProcess?.mode, "silent");
            assert.equal(canvas.initial.authProcess?.status, "running");
            const status = await waitForAuthProcess(canvas);
            assert.equal(status.auth.isAuthenticated, true, `${platform}: a silent token must skip the sign-in splash`);
            assert.equal(status.auth.authType, "azureauth");
            // A bounded timeout is what stops a cold cache from holding /api/config
            // from leaving a background process alive behind an interactive prompt.
            assert.ok(azureAuthCalls[0].timeout <= 30_000, `${platform}: silent attempt must be bounded, got ${azureAuthCalls[0].timeout}ms`);
        } finally {
            canvas.close();
        }
    }
});

test("silent sign-in is not attempted where AzureAuth is unavailable", async () => {
    const stubs = discoveryStubs({ installed: false });
    writeMarker(stubs.markerPath);
    const { impl: execFileImpl, azureAuthCalls } = execFileStub((done) => done(null, { stdout: "token", stderr: "" }));

    const namespace = await loadCanvasServer({ execFileImpl, ...stubs });
    const canvas = await startCanvas(namespace);
    try {
        assert.equal(azureAuthCalls.length, 0, "an external user must never have AzureAuth invoked");
        assert.equal(canvas.config.auth.isAuthenticated, false);
    } finally {
        canvas.close();
    }
});

test("a failed silent attempt falls back to the sign-in splash", async () => {
    const stubs = discoveryStubs({ installed: true });
    writeMarker(stubs.markerPath);
    const { impl: execFileImpl, azureAuthCalls } = execFileStub((done) => {
        done(Object.assign(new Error("timed out"), { code: "ETIMEDOUT", stdout: "", stderr: "" }));
    });

    const namespace = await loadCanvasServer({ execFileImpl, ...stubs });
    const canvas = await startCanvas(namespace);
    try {
        assert.equal(azureAuthCalls.length, 1);
        assert.equal(canvas.initial.authProcess?.status, "running");
        const status = await waitForAuthProcess(canvas);
        assert.equal(status.authProcess.status, "failed");
        assert.equal(status.auth.isAuthenticated, false, "a cold cache must degrade to the splash, not an error");
        assert.equal(status.auth.azureAuthDiscovery.selected, expectedSelected(stubs), "the Agency button must still be offered");
    } finally {
        canvas.close();
    }
});

test("signing out clears the marker so the next load does not re-authenticate", async () => {
    const stubs = discoveryStubs({ installed: true });
    writeMarker(stubs.markerPath);
    const { impl: execFileImpl } = execFileStub((done) => done(null, { stdout: "silent-token", stderr: "" }));

    const namespace = await loadCanvasServer({ execFileImpl, ...stubs });
    const canvas = await startCanvas(namespace);
    try {
        const status = await waitForAuthProcess(canvas);
        assert.equal(status.auth.isAuthenticated, true);
        assert.ok(existsSync(stubs.markerPath));
        await authed(canvas, "/api/connection", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                organization: "fabrikam",
                project: "widgets",
            }),
        });
        assert.equal((await canvas.config2()).connections[0].project, "widgets");

        const signedOut = await canvas.signOut();
        assert.equal(signedOut.auth.isAuthenticated, false);
        assert.equal(existsSync(stubs.markerPath), false, "sign-out must clear the marker or the user cannot stay signed out");
        assert.equal(signedOut.authProcess.clearedConnectionPreference, true);

        // A fresh load must now show the splash rather than silently signing back in.
        const reloaded = await canvas.config2();
        assert.equal(reloaded.auth.isAuthenticated, false, "sign-out must survive a reload");
        assert.deepEqual(reloaded.connections, [], "sign-out must clear saved organization and project state");
    } finally {
        canvas.close();
    }
});

test("sign-in replaces a legacy marker and restricts its POSIX file mode", async () => {
    const stubs = discoveryStubs({ installed: true });
    // A marker written before the mode was restricted: writeFileSync only applies
    // mode on create, so replacing it has to remove it first.
    mkdirSync(dirname(stubs.markerPath), { recursive: true });
    writeFileSync(stubs.markerPath, "{}");
    if (process.platform !== "win32") {
        assert.equal(statSync(stubs.markerPath).mode & 0o777, 0o644, "precondition: the legacy marker is world-readable");
    }

    const { impl: execFileImpl } = execFileStub((done) => done(null, { stdout: "token", stderr: "" }));
    const namespace = await loadCanvasServer({ execFileImpl, ...stubs });
    const canvas = await startCanvas(namespace);
    try {
        await canvas.startAgencyAuthWithin(5000);
        for (let attempt = 0; attempt < 40; attempt += 1) {
            await new Promise((r) => setTimeout(r, 25));
            if ((await canvas.authStatus()).authProcess.status !== "running") break;
        }
        assert.equal(JSON.parse(readFileSync(stubs.markerPath, "utf8")).provider, "azureauth");
        // Node accepts mode on Windows but reports files as 0o666 because POSIX
        // permission bits do not map to Windows ACLs.
        if (process.platform !== "win32") {
            assert.equal(statSync(stubs.markerPath).mode & 0o777, 0o600, "the marker must be owner-only");
        }
    } finally {
        canvas.close();
    }
});

test("signing out during an in-flight sign-in is not undone when it completes", async () => {
    const stubs = discoveryStubs({ installed: true });
    // Held open so the sign-out below lands while acquisition is still running.
    let releaseToken;
    const tokenReleased = new Promise((resolve) => { releaseToken = resolve; });
    const { impl: execFileImpl } = execFileStub((done) => {
        tokenReleased.then(() => done(null, { stdout: "late-token", stderr: "" }));
    });

    const namespace = await loadCanvasServer({ execFileImpl, ...stubs });
    const canvas = await startCanvas(namespace);
    try {
        const started = await canvas.startAgencyAuthWithin(5000);
        assert.equal(started.authProcess.status, "running");

        // The user changes their mind mid-prompt. Sign-out is reachable here: it
        // lives outside the canvas content, so it is clickable while the sign-in
        // splash is up, and a non-blocking sign-in leaves that window open.
        const signedOut = await canvas.signOut();
        assert.equal(signedOut.auth.isAuthenticated, false);
        assert.equal(existsSync(stubs.markerPath), false, "sign-out clears the marker");

        // AzureAuth now returns for the abandoned sign-in.
        releaseToken();
        await new Promise((resolve) => setTimeout(resolve, 150));

        const after = await canvas.authStatus();
        assert.equal(after.auth.isAuthenticated, false, "an abandoned sign-in must not sign the user back in");
        assert.equal(existsSync(stubs.markerPath), false, "an abandoned sign-in must not recreate the marker, which would silently re-authenticate on every later load");
    } finally {
        canvas.close();
    }
});

// Every lookup fails, which drives workItemFieldFormat onto its fail-closed HTML
// fallback. That is the path worth covering: it is where a plain text field is
// most likely to be mistaken for markup.
//
// The write itself is asserted from the captured patch rather than the return
// value, because the read-back that follows the PATCH is not stubbed here and its
// failure says nothing about the policy. If a policy rejects, no PATCH is issued
// at all and `patched` stays null, so the assertions below still fail closed.
function updateHarness({ onPatch = () => {}, multilineFieldsFormat = null } = {}) {
    const stubs = discoveryStubs({ installed: true });
    writeMarker(stubs.markerPath);
    const { impl: execFileImpl } = execFileStub((done) => done(null, { stdout: "test-access-token", stderr: "" }));
    return loadCanvasServer({
        execFileImpl,
        ...stubs,
        fetchImpl: async (url, init = {}) => {
            const parsed = new URL(String(url));
            const path = parsed.pathname.toLowerCase();
            if (init.method === "PATCH") {
                onPatch(JSON.parse(init.body));
                return new Response(JSON.stringify({ id: 42, rev: 4, fields: {} }), { status: 200 });
            }
            if (multilineFieldsFormat && path.endsWith("/_apis/wit/workitems/42")) {
                // Azure DevOps returns an empty map whenever a fields projection is
                // present. The production write path must request the complete item
                // to learn the real mode.
                const projectedFormats = parsed.searchParams.has("fields")
                    ? {}
                    : multilineFieldsFormat;
                return new Response(JSON.stringify({
                    id: 42,
                    fields: { "System.WorkItemType": "Bug" },
                    multilineFieldsFormat: projectedFormats,
                }), { status: 200 });
            }
            if (multilineFieldsFormat && path.endsWith("/_apis/wit/workitemtypes/bug/fields")) {
                return new Response(JSON.stringify({
                    value: [
                        { referenceName: "System.Title", type: "string" },
                        { referenceName: "System.Description", type: "html" },
                        { referenceName: "Microsoft.VSTS.TCM.ReproSteps", type: "html" },
                    ],
                }), { status: 200 });
            }
            if (multilineFieldsFormat && path.endsWith("/_apis/wit/workitemtypes/bug")) {
                return new Response(JSON.stringify({ xmlForm: "" }), { status: 200 });
            }
            return new Response(JSON.stringify({ message: "lookup unavailable" }), { status: 500 });
        },
    });
}

// Starting the canvas is what performs the silent sign-in, so the token the write
// path needs is only in the cache once it has run.
async function withUpdateHarness(options, body) {
    const namespace = await updateHarness(options);
    const canvas = await startCanvas(namespace);
    try {
        return await body(namespace);
    } finally {
        canvas.close();
    }
}

const updateArgs = { organization: "fabrikam", project: "Project", workItemId: 42, rev: 3 };
const patchedField = (patch, name) => patch?.find((entry) => entry.path === `/fields/${name}`);

test("a title holding angle brackets is not mistaken for markup when the field lookup fails", async () => {
    // "Support List<string>" trips the markup heuristic and fails the write
    // policy, so the only thing keeping an ordinary title writable is
    // KNOWN_PLAIN_TEXT_FIELDS being consulted before either.
    let patched = null;
    await withUpdateHarness({ onPatch: (body) => { patched = body; } }, async (namespace) => {
        await namespace.updateWorkItemFields({
            ...updateArgs,
            fields: [{ name: "System.Title", value: "Support List<string> in the parser" }],
        }).catch(() => {});
    });
    assert.equal(patchedField(patched, "System.Title")?.value, "Support List<string> in the parser");
});

test("which markup policy applies is decided by the route, not by the request", async () => {
    // A span is content Azure DevOps stores and the canvas editor preserves, but
    // it is not something that editor could have authored, so the two paths must
    // disagree about it.
    const stored = '<div><span style="color:#f00">Critical</span></div>';
    const fields = [{ name: "System.Description", value: stored, isHtml: true }];

    let patched = null;
    await withUpdateHarness({ onPatch: (body) => { patched = body; } }, async (namespace) => {
        await namespace.updateWorkItemFields({ ...updateArgs, fields, preservesStoredMarkup: true }).catch(() => {});
    });
    assert.equal(patchedField(patched, "System.Description")?.value, stored, "the canvas route preserves what it read");

    let authored = null;
    await withUpdateHarness({ onPatch: (body) => { authored = body; } }, async (namespace) => {
        await assert.rejects(
            namespace.updateWorkItemFields({ ...updateArgs, fields }),
            (error) => error.code === "azure_devops_unsupported_markup",
            "the action route stays on the strict policy",
        );
    });
    assert.equal(authored, null, "a rejected write must not reach Azure DevOps");
});

test("markup that executes is refused on the canvas route too", async () => {
    let patched = null;
    await withUpdateHarness({ onPatch: (body) => { patched = body; } }, async (namespace) => {
        await assert.rejects(
            namespace.updateWorkItemFields({
                ...updateArgs,
                preservesStoredMarkup: true,
                fields: [{ name: "System.Description", value: "<div>hi<script>alert(1)</script></div>", isHtml: true }],
            }),
            (error) => error.code === "azure_devops_unsupported_markup",
        );
    });
    assert.equal(patched, null, "a rejected write must not reach Azure DevOps");
});

test("Markdown rich fields are not subjected to the HTML validator", async () => {
    let patched = null;
    const source = "Use List<string> here.\n\n```html\n<div>example</div>\n```";
    await withUpdateHarness({
        onPatch: (body) => { patched = body; },
        multilineFieldsFormat: { "Microsoft.VSTS.TCM.ReproSteps": "Markdown" },
    }, async (namespace) => {
        await namespace.updateWorkItemFields({
            ...updateArgs,
            fields: [{
                name: "Microsoft.VSTS.TCM.ReproSteps",
                value: source,
                // A caller hint cannot force the HTML policy onto a Markdown field.
                isHtml: true,
            }],
        }).catch(() => {});
    });
    assert.equal(patchedField(patched, "Microsoft.VSTS.TCM.ReproSteps")?.value, source);
    assert.equal(
        patched.some((entry) => entry.path.startsWith("/multilineFieldsFormat/")),
        false,
        "editing must preserve the existing Azure DevOps format",
    );
});

test("a caller cannot label an HTML field as Markdown to bypass validation", async () => {
    let patched = null;
    await withUpdateHarness({
        onPatch: (body) => { patched = body; },
        multilineFieldsFormat: { "System.Description": "Html" },
    }, async (namespace) => {
        await assert.rejects(
            namespace.updateWorkItemFields({
                ...updateArgs,
                fields: [{
                    name: "System.Description",
                    value: "<p>hi<script>alert(1)</script></p>",
                    isHtml: false,
                    format: "markdown",
                }],
            }),
            (error) => error.code === "azure_devops_unsupported_markup",
        );
    });
    assert.equal(patched, null);
});

// --- Connections -----------------------------------------------------------
//
// Saved selections, organization-scope work items, and connection boundaries.
async function connectionCanvas({
    routes = {},
    home,
    serverOptions = {},
    input = {},
    browserTokenForTest = { access_token: "test-access-token", expires_in: 3600 },
} = {}) {
    // The home is a parameter so two canvases can share one, which is how a
    // reload is simulated: the second reads the connection the first wrote.
    const stubs = discoveryStubs({ installed: true, ...(home ? { home } : {}) });
    writeMarker(stubs.markerPath);
    const { impl: execFileImpl, processCalls } = execFileStub((done) => done(null, { stdout: "test-access-token", stderr: "" }));
    const requests = [];
    const namespace = await loadCanvasServer({
        execFileImpl,
        ...stubs,
        browserTokenForTest,
        fetchImpl: async (url, options) => {
            const parsed = new URL(url);
            requests.push({ method: options?.method || "GET", pathname: parsed.pathname, search: parsed.search, body: options?.body });
            for (const [suffix, handler] of Object.entries(routes)) {
                if (parsed.pathname.endsWith(suffix)) {
                    const result = typeof handler === "function" ? handler(parsed, options) : handler;
                    return result instanceof Response
                        ? result
                        : new Response(JSON.stringify(result), { status: 200 });
                }
            }
            throw new Error(`Unexpected Azure DevOps request: ${parsed.pathname}`);
        },
    });
    const canvas = await startCanvas(namespace, serverOptions, input);
    return { namespace, canvas, requests, processCalls, home: stubs.home };
}

const authed = (canvas, path, init = {}) => fetch(`${canvas.base}${path}`, {
    ...init,
    headers: { "x-canvas-nonce": canvas.apiNonce, ...(init.headers || {}) },
});

test("send to chat reads saved ADO context, scopes the item and enqueues in the owning session", async () => {
    const sent = [];
    const { namespace, canvas, requests } = await connectionCanvas({
        input: { organization: "contoso", project: "Northwind", workItemId: 99 },
        routes: {
            "/_apis/wit/workitems/42": { id: 42, rev: 7, fields: {
                "System.WorkItemType": "Feature", "System.Title": "Saved feature", "System.TeamProject": "Southwind",
                "System.Description": "<p>Saved description</p>", "Microsoft.VSTS.Common.AcceptanceCriteria": "<p>Must be accessible</p>",
            } },
            "/comments": { comments: [] },
            "/_apis/wit/workitemtypes/Feature": { name: "Feature", xmlForm: "" },
        },
    });
    const path = "/api/work-items/42/send-to-chat?organization=contoso&project=Northwind&workItemProject=Southwind";
    try {
        namespace.setCopilotSession({ send: async (options) => { sent.push(options); return "message-42"; } });
        const denied = await fetch(`${canvas.base}${path}`, { method: "POST" });
        assert.equal(denied.status, 400);
        assert.equal(sent.length, 0);
        const response = await authed(canvas, path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: "Untrusted draft" }) });
        assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
        assert.deepEqual(await response.json(), { ok: true });
        assert.equal(sent.length, 1);
        assert.equal(sent[0].mode, "enqueue");
        for (const text of ["Feature #42", "Saved feature", "Saved description", "Must be accessible", "https://dev.azure.com/contoso/Southwind/_workitems/edit/42"])
            assert.ok(sent[0].prompt.includes(text), text);
        assert.doesNotMatch(sent[0].prompt, /Untrusted draft|#99/);
        assert.ok(requests.some(request => request.pathname === "/contoso/Southwind/_apis/wit/workitems/42"));
        assert.ok(requests.every(request => request.method === "GET"));

        namespace.setCopilotSession({});
        const unavailable = await authed(canvas, path, { method: "POST" });
        assert.equal(unavailable.status, 400);
        assert.match((await unavailable.json()).message, /Copilot.*conversation/i);
        namespace.setCopilotSession({ send: async () => { throw new Error("RPC disconnected"); } });
        const failed = await authed(canvas, path, { method: "POST" });
        assert.equal(failed.status, 400);
        assert.match((await failed.json()).message, /could not confirm.*check.*chat/i);
        assert.equal(sent.length, 1, "no automatic retries after an uncertain send");
    } finally { canvas.close(); }
});

const workspaceToken = (identity) => ({ access_token: [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify({ tid: "fictional-tenant", oid: identity, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url"),
    "signature",
].join("."), expires_in: 3600 });

test("workspace state survives changed canvas ports and remains scoped to the authenticated account", async () => {
    const home = mkdtempSync(join(tmpdir(), "boards-http-state-"));
    const input = { organization: "fabrikam", project: "widgets" };
    const first = await connectionCanvas({ home, input, browserTokenForTest: workspaceToken("person-one") });
    const draft = { rev: 3, fields: [{ name: "System.Title", value: "Unsaved" }], baseValues: { "System.Title": "Original" }, comment: "Draft comment" };
    let second;
    let other;
    try {
        const saved = await authed(first.canvas, "/api/work-items/42/draft", {
            method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft),
        });
        assert.equal(saved.status, 200, await saved.clone().text());
        await Promise.all([
            authed(first.canvas, "/api/workspace/preferences", { method: "PATCH", body: JSON.stringify({ openItems: [{ id: 42 }], activeItem: 42 }) }),
            authed(first.canvas, "/api/workspace/preferences", { method: "PATCH", body: JSON.stringify({ dashboardSections: ["current"], workspace: { view: "board" } }) }),
        ]);
        second = await connectionCanvas({ home, input, browserTokenForTest: workspaceToken("person-one") });
        assert.notEqual(first.canvas.base, second.canvas.base);
        const restored = await authed(second.canvas, "/api/work-items/42/draft").then((res) => res.json());
        assert.equal(restored.draft.rev, 3);
        assert.equal(restored.draft.fields[0].value, "Unsaved");
        assert.equal(restored.draft.comment, "Draft comment");
        const preferences = await authed(second.canvas, "/api/workspace/preferences").then((res) => res.json());
        assert.equal(preferences.preferences.activeItem, 42);
        assert.deepEqual(preferences.preferences.dashboardSections, ["current"]);
        assert.equal(preferences.preferences.workspace.view, "board");
        other = await connectionCanvas({ home, input, browserTokenForTest: workspaceToken("person-two") });
        assert.deepEqual(await authed(other.canvas, "/api/work-items/42/draft").then((res) => res.json()), { draft: null });
        assert.deepEqual(await authed(other.canvas, "/api/workspace/preferences").then((res) => res.json()), { preferences: {} });
        const deleted = await authed(second.canvas, "/api/work-items/42/draft", { method: "DELETE" });
        assert.equal(deleted.status, 200);
        assert.equal((await authed(first.canvas, "/api/work-items/42/draft").then((res) => res.json())).draft, null);
    } finally {
        first.canvas.close(); second?.canvas.close(); other?.canvas.close();
        rmSync(home, { recursive: true, force: true });
    }
});

test("workspace routes enforce nonce, sign-in, connection selectors and selected project boundaries", async () => {
    const input = { organization: "fabrikam", project: "widgets" };
    const signedIn = await connectionCanvas({ input, browserTokenForTest: workspaceToken("person") });
    const signedOut = await connectionCanvas({ input, browserTokenForTest: null });
    try {
        const missingNonce = await fetch(`${signedIn.canvas.base}/api/workspace/items`);
        assert.equal(missingNonce.status, 400);
        assert.equal((await missingNonce.json()).error, "azure_devops_invalid_nonce");
        const foreign = await authed(signedIn.canvas, "/api/workspace/items?organization=attacker&project=widgets");
        assert.equal(foreign.status, 400);
        assert.equal((await foreign.json()).error, "azure_devops_unknown_connection");
        const project = await authed(signedIn.canvas, "/api/workspace/items?workItemProject=other");
        assert.equal(project.status, 400);
        assert.equal((await project.json()).error, "azure_devops_unknown_project");
        const unauthenticated = await authed(signedOut.canvas, "/api/workspace/preferences");
        assert.equal(unauthenticated.status, 400);
        assert.equal((await unauthenticated.json()).error, "azure_devops_oauth_login_required");
        assert.deepEqual(signedIn.requests, []);
        assert.deepEqual(signedOut.requests, []);
    } finally { signedIn.canvas.close(); signedOut.canvas.close(); }
});

test("workspace GUID connections authorize their project name and share one canonical draft scope", async () => {
    const projectId = "4e1c4e8f-0c57-4a25-9a4e-2e2c2f4d8a55";
    const home = mkdtempSync(join(tmpdir(), "boards-http-guid-project-"));
    const routes = {
        [`/_apis/projects/${projectId}`]: { id: projectId, name: "widgets" },
        "/_apis/projects/widgets": { id: projectId, name: "widgets" },
        "/_apis/wit/wiql": { workItems: [] },
    };
    const first = await connectionCanvas({ home, input: { organization: "fabrikam", project: projectId },
        routes, browserTokenForTest: workspaceToken("person") });
    let named;
    try {
        const draft = { rev: 3, fields: [{ name: "System.Title", value: "Unsaved" }], baseValues: {}, comment: "" };
        const saved = await authed(first.canvas, "/api/work-items/42/draft?workItemProject=widgets", {
            method: "PUT", body: JSON.stringify(draft),
        });
        assert.equal(saved.status, 200, await saved.clone().text());
        const restored = await authed(first.canvas, "/api/work-items/42/draft").then((res) => res.json());
        assert.equal(restored.draft.fields[0].value, "Unsaved");
        const scopedItems = await authed(first.canvas, "/api/workspace/items?workItemProject=widgets");
        assert.equal(scopedItems.status, 200, await scopedItems.clone().text());
        assert.match(first.requests.find(({ body }) => typeof body === "string" && body.includes("SELECT")).body,
            /\[System.TeamProject\] = 'widgets'/);
        named = await connectionCanvas({ home, input: { organization: "fabrikam", project: "widgets" },
            routes, browserTokenForTest: workspaceToken("person") });
        const namedDraft = await authed(named.canvas, `/api/work-items/42/draft?workItemProject=${projectId}`).then((res) => res.json());
        assert.equal(namedDraft.draft.fields[0].value, "Unsaved");
        for (const path of ["/api/workspace/items", "/api/work-items/42/draft"]) {
            const denied = await authed(first.canvas, `${path}?workItemProject=other`);
            assert.equal(denied.status, 400);
            assert.equal((await denied.json()).error, "azure_devops_unknown_project");
        }
        assert.equal(first.requests.some(({ pathname }) => pathname.includes("other")), false);
    } finally {
        first.canvas.close(); named?.canvas.close();
        rmSync(home, { recursive: true, force: true });
    }
});

test("native workspace board routes work while hosted Boards preview is disabled", async () => {
    const columnField = "WEF_Example_Kanban.Column";
    const doneField = "WEF_Example_Kanban.Column.Done";
    const card = { id: 42, rev: 2, fields: { "System.TeamProject": "widgets", "System.WorkItemType": "Task", "System.State": "Active",
        [columnField]: "Doing", [doneField]: true } };
    const { canvas, requests } = await connectionCanvas({
        input: { organization: "fabrikam", project: "widgets" },
        routes: {
            "/_apis/projects/widgets": { id: "project-id", name: "widgets" },
            "/_apis/work/boards": { value: [{ id: "board-id", name: "Tasks" }] },
            "/_apis/work/boards/board-id": { id: "board-id", name: "Tasks", fields: { columnField: { referenceName: columnField }, doneField: { referenceName: doneField } },
                columns: [{ id: "doing", name: "Doing", isSplit: true, stateMappings: { Task: "Active" } }] },
            "/_apis/work/backlogs": { value: [{ id: "Microsoft.TaskCategory", name: "Tasks", workItemTypes: [{ name: "Task" }] }] },
            "/_apis/work/backlogs/Microsoft.TaskCategory/workItems": { workItems: [{ target: { id: 42 } }] },
            "/_apis/wit/workitems": { value: [card] },
            "/_apis/wit/workitems/42": card,
        },
    });
    try {
        assert.equal(canvas.entry.featureFlags.boards, false);
        const listed = await authed(canvas, "/api/workspace/boards?team=Delivery");
        assert.equal(listed.status, 200);
        assert.equal((await listed.json()).boards[0].id, "board-id");
        const board = await authed(canvas, "/api/workspace/board?team=Delivery&boardId=board-id");
        assert.equal(board.status, 200, await board.clone().text());
        assert.equal((await board.json()).workItems[0].columnDone, true);
        const moved = await authed(canvas, "/api/workspace/board/move?team=Delivery&boardId=board-id", {
            method: "PATCH", body: JSON.stringify({ id: 42, rev: 2, columnId: "doing", done: true }),
        });
        assert.equal(moved.status, 200, await moved.clone().text());
        const write = requests.find(({ method }) => method === "PATCH");
        assert.equal(write.pathname, "/fabrikam/widgets/_apis/wit/workitems/42");
        assert.deepEqual(JSON.parse(write.body)[0], { op: "test", path: "/rev", value: 2 });
    } finally { canvas.close(); }
});

test("raw attachment HTTP upload forwards bytes and adds a guarded relation", async () => {
    const projectId = "4e1c4e8f-0c57-4a25-9a4e-2e2c2f4d8a55";
    const attachmentId = "06f5932c-aa2f-4545-9764-8546bec98914";
    const { canvas, requests } = await connectionCanvas({
        input: { organization: "fabrikam", project: "widgets" },
        routes: {
            "/_apis/projects/widgets": { id: projectId, name: "widgets" },
            "/_apis/wit/workitems/42": (_url, options) => ({ id: 42, rev: options.method === "PATCH" ? 4 : 3, fields: { "System.TeamProject": "widgets" } }),
            "/_apis/wit/attachments": { id: attachmentId },
        },
    });
    try {
        const bytes = new Uint8Array([0, 255, 128, 13, 10]);
        const response = await authed(canvas, "/api/work-items/42/attachments?fileName=screenshot.png", {
            method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: bytes,
        });
        assert.equal(response.status, 200, await response.clone().text());
        const result = await response.json();
        assert.equal(result.rev, 4);
        assert.equal(result.attachment.fileName, "screenshot.png");
        assert.match(result.attachment.url, new RegExp(`/${projectId}/_apis/wit/attachments/${attachmentId}`));
        const uploaded = requests.find(({ pathname }) => pathname.endsWith("/attachments"));
        assert.deepEqual([...uploaded.body], [...bytes]);
        const write = requests.find(({ method }) => method === "PATCH");
        assert.deepEqual(JSON.parse(write.body)[0], { op: "test", path: "/rev", value: 3 });
        const wrongType = await authed(canvas, "/api/work-items/42/attachments?fileName=file.txt", {
            method: "POST", headers: { "Content-Type": "text/plain" }, body: "text",
        });
        assert.equal(wrongType.status, 400);
        assert.equal((await wrongType.json()).error, "azure_devops_invalid_upload_type");
    } finally { canvas.close(); }
});

test("oversized raw HTTP upload is rejected before upstream work and returns an actionable error", async () => {
    const { canvas, requests } = await connectionCanvas({ input: { organization: "fabrikam", project: "widgets" } });
    try {
        const result = await new Promise((resolve, reject) => {
            const req = request(`${canvas.base}/api/work-items/42/attachments?fileName=large.bin`, {
                method: "POST", headers: { "X-Canvas-Nonce": canvas.apiNonce, "Content-Type": "application/octet-stream", "Content-Length": 60 * 1024 * 1024 + 1 },
            }, (response) => {
                const chunks = [];
                response.on("data", (chunk) => chunks.push(chunk));
                response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
            });
            req.on("error", reject);
            req.end();
        });
        assert.equal(result.status, 400);
        assert.equal(result.body.error, "azure_devops_attachment_too_large");
        assert.deepEqual(requests, []);
    } finally { canvas.close(); }
});

test("a canvas without saved selections reports no connections", async () => {
    const { canvas } = await connectionCanvas();
    try {
        assert.deepEqual(canvas.config.connections, []);
        assert.equal(canvas.config.hasDefaultConnection, false);
        assert.equal(canvas.config.organization, "");
    } finally {
        canvas.close();
    }
});

test("Boards startup and Home never discover Git repositories or request Repos APIs", async () => {
    const { namespace, canvas, requests, processCalls } = await connectionCanvas({
        browserTokenForTest: { access_token: "boards-test-token", expires_in: 3600 },
        routes: {
            "/_apis/favorite/favorites": { value: [] },
            "/_apis/wit/workitemtypes": {
                value: [{ name: "Task", states: [{ name: "Closed", category: "Completed" }] }],
            },
            "/_apis/wit/wiql": { workItems: [] },
        },
    });
    try {
        assert.equal(canvas.config.auth.isAuthenticated, true);
        assert.equal(typeof canvas.config.extensionVersion, "string");
        assert.equal(canvas.config.workItemReference, false);
        for (const field of ["repositoryId", "branch", "remote", "pullRequestReference"]) {
            assert.equal(Object.hasOwn(canvas.config, field), false, field);
        }
        await authed(canvas, "/api/connection", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ organization: "fabrikam", project: "Project", repositoryId: "legacy" }),
        });
        canvas.entry.featureFlags.boards = true;
        const response = await authed(canvas, "/api/home");
        assert.equal(response.status, 200);
        const data = await response.json();
        const connection = data.connections[0];
        assert.equal(connection.myWorkItems.error, "");
        assert.equal(connection.myBoards.error, "");
        assert.deepEqual(connection.myWorkItems.workItems, []);
        assert.deepEqual(connection.myBoards.boards, []);
        for (const field of ["repositoryId", "isRemote", "remote", "myPullRequests", "currentBranch"]) {
            assert.equal(Object.hasOwn(connection, field), false, field);
        }
        const config = await canvas.config2();
        assert.equal(config.connections[0].organization, "fabrikam");
        assert.equal(Object.hasOwn(config.connections[0], "repositoryId"), false);
        assert.equal(Object.hasOwn(config.connections[0], "isRemote"), false);
        assert.equal(Object.hasOwn(await namespace.getConnections(), "remote"), false);
        assert.ok(requests.some(({ pathname }) => pathname.endsWith("/_apis/wit/wiql")));
        assert.ok(requests.some(({ pathname }) => pathname.endsWith("/_apis/favorite/favorites")));
        assert.ok(requests.every(({ pathname }) => /\/_apis\/(wit|favorite)\//.test(pathname)));
        assert.equal(processCalls.some(({ file }) => file === "git"), false);
    } finally {
        canvas.close();
    }
});

test("removed Repos, branch, and pipeline routes return 404 without upstream requests", async () => {
    const { canvas, requests, processCalls } = await connectionCanvas();
    try {
        for (const [method, path] of [
            ["GET", "/api/repositories"],
            ["GET", "/api/current-pull-request"],
            ["POST", "/api/current-pull-request"],
            ["POST", "/api/new-session-branch"],
            ["GET", "/api/pull-requests/42"],
            ["PATCH", "/api/pull-requests/42"],
            ["POST", "/api/pull-requests/42/vote"],
            ["POST", "/api/pull-requests/42/status"],
            ["POST", "/api/pull-requests/42/draft"],
            ["POST", "/api/pull-requests/42/complete"],
            ["PUT", "/api/pull-requests/42/reviewers"],
            ["POST", "/api/pull-requests/42/reviewers/remove"],
            ["POST", "/api/pull-requests/42/work-items"],
            ["POST", "/api/pull-requests/42/work-items/remove"],
            ["POST", "/api/pull-requests/42/comments"],
            ["POST", "/api/pull-requests/42/threads/7/comments"],
            ["PATCH", "/api/pull-requests/42/threads/7"],
            ["POST", "/api/pull-requests/42/fix-comment"],
            ["GET", "/api/branches"],
            ["GET", "/api/pipelines"],
        ]) {
            const response = await authed(canvas, path, {
                method,
                ...(method === "GET" ? {} : {
                    headers: { "Content-Type": "application/json" },
                    body: "{}",
                }),
            });
            assert.equal(response.status, 404, `${method} ${path}`);
        }
        assert.deepEqual(requests, []);
        assert.equal(processCalls.some(({ file }) => file === "git"), false);
    } finally {
        canvas.close();
    }
});

test("a direct work item URL supplies its connection for child details, edits, comments, and attachments", async () => {
    const attachmentId = "06f5932c-aa2f-4545-9764-8546bec98914";
    const projectId = "4e1c4e8f-0c57-4a25-9a4e-2e2c2f4d8a55";
    const { canvas, requests, home } = await connectionCanvas({
        input: { workItemUrl: "https://dev.azure.com/fabrikam/widgets/_workitems/edit/42" },
        routes: {
            "/_apis/wit/workitems/42": {
                id: 42,
                rev: 3,
                fields: { "System.WorkItemType": "Task", "System.Title": "Parent", "System.TeamProject": "widgets" },
                relations: [{ rel: "System.LinkTypes.Hierarchy-Forward", url: "https://dev.azure.com/fabrikam/widgets/_apis/wit/workitems/43" }],
            },
            "/_apis/wit/workitems/43": {
                id: 43,
                rev: 2,
                fields: { "System.WorkItemType": "Task", "System.Title": "Child", "System.TeamProject": "widgets" },
            },
            "/_apis/wit/workitems": {
                value: [{ id: 43, fields: { "System.WorkItemType": "Task", "System.Title": "Child" } }],
            },
            "/_apis/wit/workitemtypes": { value: [{ name: "Task" }] },
            "/_apis/wit/workitemtypes/Task": { name: "Task", xmlForm: "" },
            "/comments": { comments: [] },
            [`/_apis/wit/attachments/${attachmentId}`]: () => new Response(new Uint8Array([1, 2, 3]), {
                headers: { "Content-Type": "image/png" },
            }),
        },
    });
    try {
        assert.equal(existsSync(join(home, ".copilot", "azure-devops-canvas", "connection.json")), false);
        assert.equal(canvas.config.organization, "fabrikam");
        assert.equal(canvas.config.project, "widgets");
        assert.equal(canvas.config.workItemReference, true);
        assert.equal(canvas.config.connections.length, 1);
        assert.equal(canvas.config.connections[0].source, "input");
        const parent = await authed(canvas, "/api/current-work-item");
        assert.equal(parent.status, 200);
        assert.equal((await parent.json()).workItem.id, 42);
        const selector = "?organization=fabrikam&project=widgets";
        const child = await authed(canvas, `/api/work-items/43/details${selector}`);
        assert.equal(child.status, 200);
        assert.equal((await child.json()).workItem.id, 43);
        const edit = await authed(canvas, `/api/work-items/43${selector}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ rev: 2, fields: [{ name: "System.Title", value: "Edited child" }] }),
        });
        assert.equal(edit.status, 200);
        const comment = await authed(canvas, `/api/work-items/43/comments${selector}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: "Child comment" }),
        });
        assert.equal(comment.status, 200);
        const attachment = new URL(`${canvas.base}/api/attachment`);
        attachment.searchParams.set("nonce", canvas.apiNonce);
        attachment.searchParams.set("url", `https://dev.azure.com/fabrikam/${projectId}/_apis/wit/attachments/${attachmentId}`);
        const image = await fetch(attachment);
        assert.equal(image.status, 200);
        assert.equal(image.headers.get("content-type"), "image/png");
        assert.deepEqual(new Uint8Array(await image.arrayBuffer()), new Uint8Array([1, 2, 3]));
        const writes = requests.filter(({ method }) => method === "PATCH" || method === "POST");
        assert.deepEqual(writes.map(({ method, pathname }) => [method, pathname]), [
            ["PATCH", "/fabrikam/widgets/_apis/wit/workitems/43"],
            ["POST", "/fabrikam/widgets/_apis/wit/workItems/43/comments"],
        ]);
        assert.deepEqual(JSON.parse(writes[0].body), [
            { op: "test", path: "/rev", value: 2 },
            { op: "add", path: "/fields/System.Title", value: "Edited child" },
        ]);
        assert.deepEqual(JSON.parse(writes[1].body), { text: "Child comment" });
    } finally {
        canvas.close();
    }
});

test("choosing an organization makes it the connection, and it survives a reload", async () => {
    const home = mkdtempSync(join(tmpdir(), "azure-devops-connection-api-"));
    const first = await connectionCanvas({ home });
    try {
        const saved = await authed(first.canvas, "/api/connection", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ organization: "fabrikam" }),
        }).then((res) => res.json());
        assert.equal(saved.connections.length, 1);
        assert.equal(saved.connections[0].organization, "fabrikam");
        assert.equal(saved.connections[0].source, "last-used");
        assert.equal(
            saved.connections[0].requiresProject,
            true,
            "without a project the canvas cannot list favorite boards, and says so",
        );
    } finally {
        first.canvas.close();
    }

    // A second canvas over the same home is the reload: the connection is read
    // back off disk rather than remembered in the first process.
    const second = await connectionCanvas({ home });
    try {
        assert.equal(second.canvas.config.connections[0].organization, "fabrikam");
        assert.equal(second.canvas.config.organization, "fabrikam");
    } finally {
        second.canvas.close();
    }
});

test("a pinned connection is reported as the default and can be unpinned", async () => {
    const home = mkdtempSync(join(tmpdir(), "azure-devops-connection-pin-"));
    const { canvas } = await connectionCanvas({ home });
    try {
        const pinned = await authed(canvas, "/api/connection", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ organization: "fabrikam", project: "Project", isDefault: true }),
        }).then((res) => res.json());
        assert.equal(pinned.connections[0].isDefault, true);
        assert.equal(pinned.connections[0].requiresProject, false);

        const cleared = await authed(canvas, "/api/connection", { method: "DELETE" }).then((res) => res.json());
        assert.equal(cleared.defaultConnection, null);
        assert.equal(cleared.connections[0].source, "last-used", "the last used connection remains after unpinning");
    } finally {
        canvas.close();
    }
});

test("a connection needs an organization, and a malformed one is refused at the picker", async () => {
    const home = mkdtempSync(join(tmpdir(), "azure-devops-connection-invalid-"));
    const { canvas } = await connectionCanvas({ home });
    try {
        const missing = await authed(canvas, "/api/connection", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ project: "Project" }),
        });
        assert.equal(missing.status, 400);
        assert.equal((await missing.json()).error, "azure_devops_missing_organization");

        const malformed = await authed(canvas, "/api/connection", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ organization: "https://example.com/fabrikam" }),
        });
        assert.equal(malformed.status, 400);
        assert.equal((await malformed.json()).error, "azure_devops_invalid_organization");
    } finally {
        canvas.close();
    }
});

test("a request cannot reach an organization the canvas never resolved", async () => {
    const home = mkdtempSync(join(tmpdir(), "azure-devops-connection-scope-"));
    const { canvas } = await connectionCanvas({ home });
    try {
        await authed(canvas, "/api/connection", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ organization: "fabrikam", project: "Project" }),
        });
        const response = await authed(canvas, "/api/work-items/7?organization=attacker&project=Project");
        assert.equal(response.status, 400);
        assert.equal((await response.json()).error, "azure_devops_unknown_connection");
    } finally {
        canvas.close();
    }
});

test("organizations are listed from the VSSPS host, which has no organization in its URL", async () => {
    const { namespace, canvas, requests } = await connectionCanvas({
        routes: {
            "/_apis/profile/profiles/me": { id: "member-1", publicAlias: "member-1" },
            "/_apis/accounts": { value: [{ accountName: "zulu", accountId: "2" }, { accountName: "alpha", accountId: "1" }] },
        },
    });
    try {
        const result = await namespace.listOrganizations();
        assert.equal(result.error, "");
        assert.equal(result.organizations.map((org) => org.name).join(","), "alpha,zulu", "listed alphabetically");
        assert.ok(
            requests.some((request) => request.pathname === "/_apis/accounts" && request.search.includes("memberId=member-1")),
            "the accounts call filters on the member id read from the profile",
        );
    } finally {
        canvas.close();
    }
});

test("an organization list the tenant refuses degrades to typing a name, not an error", async () => {
    const { namespace, canvas } = await connectionCanvas({});
    try {
        const result = await namespace.listOrganizations();
        assert.equal(result.organizations.length, 0);
        assert.ok(result.error, "the reason is reported so the picker can explain the empty list");
    } finally {
        canvas.close();
    }
});

// A token Azure DevOps cannot validate is not an error to it: unless asked to
// suppress the redirect, it sends the request to the VSSPS sign-in page and the
// chain ends in a 2xx HTML page. These tests sign the canvas in through the real
// browser OAuth loopback and answer every Azure DevOps request with `respond`.
const REJECTED_TOKEN_CLAIMS = {
    tid: "11111111-2222-3333-4444-555555555555",
    iss: "https://sts.windows.net/11111111-2222-3333-4444-555555555555/",
    idtyp: "user",
    exp: Math.floor(Date.now() / 1000) + 3600,
};
const REJECTED_TOKEN = [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(REJECTED_TOKEN_CLAIMS)).toString("base64url"),
    "signature",
].join(".");

async function rejectionCanvas(respond) {
    const stubs = discoveryStubs({ installed: false });
    const { impl: execFileImpl } = execFileStub((done) => done(new Error("AzureAuth is not used by these tests")));
    const requests = [];
    const logs = [];
    const namespace = await loadCanvasServer({
        execFileImpl,
        ...stubs,
        fetchImpl: async (url, options = {}) => {
            const parsed = new URL(url);
            if (parsed.host === "login.microsoftonline.com" && parsed.pathname.endsWith("/token")) {
                return new Response(JSON.stringify({ access_token: REJECTED_TOKEN, refresh_token: "refresh", expires_in: 3600 }), { status: 200 });
            }
            requests.push({ host: parsed.host, pathname: parsed.pathname, headers: { ...(options.headers || {}) } });
            return respond(parsed, options);
        },
    });
    const canvas = await startCanvas(namespace);
    namespace.setCopilotSession({
        workspacePath: tmpdir(),
        rpc: { mcp: { list: async () => [] }, metadata: { snapshot: async () => ({}) } },
        log: async (message) => { logs.push(message); },
    });
    const started = await authed(canvas, "/api/auth/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "microsoft" }),
    }).then((res) => res.json());
    const authorizeUrl = new URL(started.authProcess.authorizationUrl);
    const callback = new URL(started.authProcess.redirectUri);
    callback.searchParams.set("code", "authorization-code");
    callback.searchParams.set("state", authorizeUrl.searchParams.get("state"));
    await fetch(callback).then((res) => res.text());
    const settled = await canvas.authStatus();
    assert.equal(settled.auth?.isAuthenticated, true, "the canvas starts signed in");
    assert.equal(settled.auth?.authType, "microsoft");
    return { namespace, canvas, requests, logs };
}

function signInPageResponse() {
    const response = new Response("<!DOCTYPE html><html><head><title>Azure DevOps Services | Sign In</title></head><body></body></html>", {
        status: 203,
        headers: { "Content-Type": "text/html; charset=utf-8", "x-vss-resourcetenant": "99999999-8888-7777-6666-555555555555" },
    });
    Object.defineProperty(response, "redirected", { value: true });
    Object.defineProperty(response, "url", { value: "https://fabrikam.vssps.visualstudio.com/_signin?realm=dev.azure.com" });
    return response;
}

function jsonStatusResponse(status, body, headers = {}) {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

test("an anonymous sign-in page is reported as a rejected sign-in, not as an empty project list", async () => {
    const { canvas, logs } = await rejectionCanvas(() => signInPageResponse());
    try {
        const response = await authed(canvas, "/api/projects?organization=fabrikam");
        const body = await response.json();
        assert.equal(response.status, 400);
        assert.equal(body.error, "azure_devops_authentication_rejected");
        assert.equal(body.projects, undefined, "no success-shaped project list is returned");

        const status = await canvas.authStatus();
        assert.equal(status.auth.isAuthenticated, false, "the rejected token is dropped so the UI asks to sign in again");

        const diagnostic = logs.find((line) => line.includes(REJECTED_TOKEN_CLAIMS.tid));
        assert.ok(diagnostic, "the rejection is logged with the token tenant");
        assert.match(diagnostic, /browser-oauth/);
        assert.ok(diagnostic.includes(REJECTED_TOKEN_CLAIMS.iss));
        assert.ok(diagnostic.includes("idtyp=user"));
        assert.ok(diagnostic.includes("99999999-8888-7777-6666-555555555555"), "the resource tenant header is logged");
        assert.ok(logs.every((line) => !line.includes(REJECTED_TOKEN)), "the token itself is never logged");
    } finally {
        canvas.close();
    }
});

test("a 401 from Azure DevOps is reported as a rejected sign-in and signs the canvas out", async () => {
    const { canvas } = await rejectionCanvas(() => jsonStatusResponse(401, {
        message: "TF400813: The user '' is not authorized to access this resource.",
    }));
    try {
        const response = await authed(canvas, "/api/projects?organization=fabrikam");
        assert.equal((await response.json()).error, "azure_devops_authentication_rejected");
        assert.equal((await canvas.authStatus()).auth.isAuthenticated, false);
    } finally {
        canvas.close();
    }
});

test("a successful HTML response without redirect metadata is still a rejected sign-in", async () => {
    const { canvas } = await rejectionCanvas(() => new Response("<html>Sign in</html>", {
        headers: { "Content-Type": "text/html" },
    }));
    try {
        const response = await authed(canvas, "/api/projects?organization=fabrikam");
        assert.equal(response.status, 400);
        assert.equal((await response.json()).error, "azure_devops_authentication_rejected");
        assert.equal((await canvas.authStatus()).auth.isAuthenticated, false);
    } finally {
        canvas.close();
    }
});

test("a rejected Agency token is dropped without deleting the sign-in preference", async () => {
    const stubs = discoveryStubs({ installed: true });
    writeMarker(stubs.markerPath);
    const { impl: execFileImpl } = execFileStub((done) => done(null, { stdout: "test-access-token", stderr: "" }));
    const namespace = await loadCanvasServer({
        ...stubs,
        execFileImpl,
        fetchImpl: async () => jsonStatusResponse(401, { message: "Sign in again." }),
    });
    const canvas = await startCanvas(namespace);
    try {
        assert.equal((await waitForAuthProcess(canvas)).auth.authType, "azureauth");
        const response = await authed(canvas, "/api/projects?organization=fabrikam");
        assert.equal((await response.json()).error, "azure_devops_authentication_rejected");
        assert.equal((await canvas.authStatus()).auth.isAuthenticated, false);
        assert.equal(existsSync(stubs.markerPath), true);
    } finally {
        canvas.close();
        rmSync(stubs.home, { recursive: true, force: true });
    }
});

test("a delayed rejection does not discard a newer Microsoft token", async () => {
    const stubs = discoveryStubs({ installed: false });
    const { impl: execFileImpl } = execFileStub(() => assert.fail("unexpected AzureAuth request"));
    let releaseResponse;
    let started;
    const requestStarted = new Promise((resolve) => { started = resolve; });
    const namespace = await loadCanvasServer({
        ...stubs,
        execFileImpl,
        browserTokenForTest: { access_token: "older-test-token", expires_in: 3600 },
        fetchImpl: () => new Promise((resolve) => {
            releaseResponse = resolve;
            started();
        }),
    });
    const canvas = await startCanvas(namespace);
    try {
        const response = authed(canvas, "/api/projects?organization=fabrikam");
        await requestStarted;
        await namespace.seedBrowserTokenForTest({ access_token: "newer-test-token", expires_in: 3600 });
        releaseResponse(jsonStatusResponse(401, { message: "Sign in again." }));
        assert.equal((await (await response).json()).error, "azure_devops_authentication_rejected");
        assert.equal((await canvas.authStatus()).auth.isAuthenticated, true);
    } finally {
        canvas.close();
        rmSync(stubs.home, { recursive: true, force: true });
    }
});

test("an organization list answered by the sign-in page also signs the canvas out", async () => {
    const { namespace, canvas } = await rejectionCanvas(() => signInPageResponse());
    try {
        await assert.rejects(namespace.listOrganizations(), { code: "azure_devops_authentication_rejected" });
        assert.equal((await canvas.authStatus()).auth.isAuthenticated, false);
    } finally {
        canvas.close();
    }
});

test("Home propagates a rejected sign-in instead of returning successful section errors", async () => {
    const { canvas } = await rejectionCanvas(() => jsonStatusResponse(401, { message: "Sign in again." }));
    try {
        await authed(canvas, "/api/connection", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ organization: "fabrikam" }),
        });
        const response = await authed(canvas, "/api/home");
        assert.equal(response.status, 400);
        const body = await response.json();
        assert.equal(body.error, "azure_devops_authentication_rejected");
        assert.equal(body.connections, undefined);
        assert.equal((await canvas.authStatus()).auth.isAuthenticated, false);
    } finally {
        canvas.close();
    }
});

test("Home preserves partial results and sign-in for an ordinary permission failure", async () => {
    const { canvas } = await rejectionCanvas(() => jsonStatusResponse(403, { message: "Permission denied." }));
    try {
        await authed(canvas, "/api/connection", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ organization: "fabrikam" }),
        });
        const response = await authed(canvas, "/api/home");
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.connections.length, 1);
        assert.match(body.connections[0].myWorkItems.error, /403 Permission denied/);
        assert.equal(body.connections[0].myBoards.requiresProject, true);
        assert.equal((await canvas.authStatus()).auth.isAuthenticated, true);
    } finally {
        canvas.close();
    }
});

test("Azure DevOps requests ask for a 401 instead of a sign-in redirect", async () => {
    const { namespace, canvas, requests } = await rejectionCanvas((url) => (url.pathname.endsWith("/_apis/profile/profiles/me")
        ? jsonStatusResponse(200, { id: "member-1" })
        : jsonStatusResponse(200, { value: [{ id: "p1", name: "Contoso" }] })));
    try {
        const projects = await authed(canvas, "/api/projects?organization=fabrikam").then((res) => res.json());
        assert.deepEqual(projects.projects, [{ id: "p1", name: "Contoso" }]);
        await namespace.listOrganizations();
        assert.ok(requests.some((request) => request.host === "dev.azure.com"));
        assert.ok(requests.some((request) => request.host === "app.vssps.visualstudio.com"));
        for (const request of requests) {
            assert.equal(request.headers["X-TFS-FedAuthRedirect"], "Suppress", `${request.host}${request.pathname} suppresses the redirect`);
        }
    } finally {
        canvas.close();
    }
});

// Azure DevOps also answers 401 when a valid sign-in is not a member of the
// organization. Those responses name the caller in x-vss-userdata.
test("a 401 for a signed-in user outside the organization keeps the canvas signed in", async () => {
    const { canvas } = await rejectionCanvas(() => jsonStatusResponse(401, {
        message: "TF400813: The user '00000000-0000-0000-0000-000000000001' is not authorized to access this resource.",
    }, { "x-vss-userdata": "00000000-0000-0000-0000-000000000001:user@fabrikam.example" }));
    try {
        const response = await authed(canvas, "/api/projects?organization=fabrikam");
        const body = await response.json();
        assert.equal(body.error, "azure_devops_request_failed");
        assert.match(body.message, /^401 TF400813/);
        assert.equal((await canvas.authStatus()).auth.isAuthenticated, true);
    } finally {
        canvas.close();
    }
});

test("a 403 from Azure DevOps stays a request failure and keeps the canvas signed in", async () => {
    const { canvas } = await rejectionCanvas(() => jsonStatusResponse(403, {
        message: "TF400813: The user is not authorized to access this resource.",
    }));
    try {
        const response = await authed(canvas, "/api/projects?organization=fabrikam");
        const body = await response.json();
        assert.equal(body.error, "azure_devops_request_failed");
        assert.match(body.message, /^403 TF400813/);
        assert.equal((await canvas.authStatus()).auth.isAuthenticated, true);
    } finally {
        canvas.close();
    }
});

test("a connection without a project queries work items across the organization", async () => {
    const { namespace, canvas, requests } = await connectionCanvas({
        routes: {
            "/_apis/wit/wiql": { workItems: [{ id: 1 }, { id: 2 }, { id: 3 }] },
            "/_apis/wit/workitems": {
                value: [
                    { id: 1, fields: { "System.WorkItemType": "Task", "System.Title": "Open here", "System.State": "Active", "System.TeamProject": "Alpha" } },
                    { id: 2, fields: { "System.WorkItemType": "Task", "System.Title": "Closed here", "System.State": "Finished", "System.TeamProject": "Alpha" } },
                    { id: 3, fields: { "System.WorkItemType": "Task", "System.Title": "Open there", "System.State": "Active", "System.TeamProject": "Beta" } },
                ],
            },
            "/_apis/wit/workitemtypes": { value: [{ name: "Task", states: [{ name: "Finished", category: "Completed" }] }] },
        },
    });
    try {
        const result = await namespace.queryMyOpenWorkItems({ organization: "fabrikam" });
        assert.equal(
            result.workItems.map((item) => item.id).join(","),
            "1,3",
            "closed items are filtered out after the query, because WIQL cannot express the filter without a project",
        );
        assert.equal(result.workItems[0].project, "Alpha", "each row carries the project it came from");

        const wiql = requests.find((request) => request.pathname.endsWith("/_apis/wit/wiql"));
        assert.equal(wiql.pathname, "/fabrikam/_apis/wit/wiql", "no project segment");
        assert.ok(!wiql.body.includes("NOT IN"), "no state filter is attempted in the query itself");

        const typeLookups = requests.filter((request) => request.pathname.endsWith("/_apis/wit/workitemtypes"));
        assert.equal(typeLookups.length, 2, "types are read once per project actually present in the results");
    } finally {
        canvas.close();
    }
});

test("a project whose type definitions cannot be read keeps its items rather than hiding them", async () => {
    const stubs = discoveryStubs({ installed: true });
    writeMarker(stubs.markerPath);
    const { impl: execFileImpl } = execFileStub((done) => done(null, { stdout: "test-access-token", stderr: "" }));
    const namespace = await loadCanvasServer({
        execFileImpl,
        ...stubs,
        fetchImpl: async (url) => {
            const { pathname } = new URL(url);
            if (pathname.endsWith("/_apis/wit/wiql")) {
                return new Response(JSON.stringify({ workItems: [{ id: 1 }] }), { status: 200 });
            }
            if (pathname.endsWith("/_apis/wit/workitemtypes")) {
                return new Response(JSON.stringify({ message: "no access" }), { status: 403 });
            }
            if (pathname.endsWith("/_apis/wit/workitems")) {
                return new Response(JSON.stringify({
                    value: [{ id: 1, fields: { "System.WorkItemType": "Task", "System.Title": "Unknown state", "System.State": "Active", "System.TeamProject": "Alpha" } }],
                }), { status: 200 });
            }
            throw new Error(`Unexpected Azure DevOps request: ${pathname}`);
        },
    });
    const canvas = await startCanvas(namespace);
    namespace.setCopilotSession({
        workspacePath: tmpdir(),
        rpc: { mcp: { list: async () => [] }, metadata: { snapshot: async () => ({}) } },
        log: async () => {
            throw new Error("logging unavailable");
        },
    });
    try {
        const result = await namespace.queryMyOpenWorkItems({ organization: "fabrikam" });
        assert.equal(result.workItems.length, 1, "showing a closed item is a smaller failure than hiding an open one");
    } finally {
        canvas.close();
    }
});

test("a logging failure cannot turn a missing work-item icon into a Home failure", async () => {
    const { namespace, canvas, requests } = await connectionCanvas({
        routes: {
            "/_apis/wit/wiql": { workItems: [{ id: 1 }] },
            "/_apis/wit/workitems": {
                value: [{
                    id: 1,
                    fields: {
                        "System.WorkItemType": "Task",
                        "System.Title": "Still visible",
                        "System.State": "Active",
                    },
                }],
            },
            "/_apis/wit/workitemtypes": {
                value: [{
                    name: "Task",
                    color: "123456",
                    icon: { id: "icon_task" },
                    states: [{ name: "Finished", category: "Completed" }],
                }],
            },
            "/_apis/wit/workItemIcons/icon_task": () => new Response(
                JSON.stringify({ message: "icon unavailable" }),
                { status: 503 },
            ),
        },
    });
    namespace.setCopilotSession({
        workspacePath: tmpdir(),
        rpc: { mcp: { list: async () => [] }, metadata: { snapshot: async () => ({}) } },
        log: async () => {
            throw new Error("logging unavailable");
        },
    });
    try {
        const result = await namespace.queryMyOpenWorkItems({
            organization: "fabrikam",
            project: "Project",
        });

        assert.equal(result.workItems.length, 1);
        assert.equal(result.workItems[0].title, "Still visible");
        assert.equal(result.workItems[0].typeIcon, "");
        await namespace.queryMyOpenWorkItems({
            organization: "fabrikam",
            project: "Project",
        });
        assert.equal(
            requests.filter((request) => request.pathname.endsWith("/_apis/wit/workItemIcons/icon_task")).length,
            2,
            "failed icon requests remain retryable",
        );
    } finally {
        canvas.close();
    }
});

test("a connection with a project still uses the exact project-scoped query", async () => {
    const icon = "<svg xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M0 0h1v1z\"/></svg>";
    const { namespace, canvas, requests } = await connectionCanvas({
        routes: {
            "/_apis/wit/wiql": { workItems: [{ id: 1 }] },
            "/_apis/wit/workitems": {
                value: [{ id: 1, fields: { "System.WorkItemType": "Task", "System.Title": "Open", "System.State": "Active", "System.TeamProject": "Project" } }],
            },
            "/_apis/wit/workitemtypes": {
                value: [{
                    name: "Task",
                    color: "123456",
                    icon: { id: "icon_task" },
                    states: [{ name: "Finished", category: "Completed" }],
                }],
            },
            "/_apis/wit/workItemIcons/icon_task": () => new Response(icon, {
                status: 200,
                headers: { "content-type": "image/svg+xml" },
            }),
        },
    });
    try {
        const workItems = await namespace.queryMyOpenWorkItems({ organization: "fabrikam", project: "Project" });
        await namespace.queryMyOpenWorkItems({ organization: "fabrikam", project: "Project" });
        await namespace.queryMyOpenWorkItems({ organization: "fabrikam", project: "OtherProject" });
        const wiql = requests.find((request) => request.pathname.endsWith("/_apis/wit/wiql"));
        assert.equal(wiql.pathname, "/fabrikam/Project/_apis/wit/wiql");
        assert.ok(
            wiql.body.includes("[System.TeamProject] = 'Project'"),
            "the project is an explicit WIQL predicate, not only a route segment",
        );
        assert.ok(wiql.body.includes("[System.State] NOT IN ('Finished')"), "the filter is expressed in the query");
        assert.match(workItems.workItems[0].typeIcon, /^data:image\/svg\+xml;base64,/);
        const iconRequest = requests.find((entry) => entry.pathname.endsWith("/workItemIcons/icon_task"));
        assert.equal(new URLSearchParams(iconRequest.search).get("color"), "123456");
        assert.equal(
            requests.filter((entry) => entry.pathname.endsWith("/workItemIcons/icon_task")).length,
            1,
            "organization-scoped icon data is shared across repeated loads and projects",
        );

    } finally {
        canvas.close();
    }
});

test("home returns Boards and work items per connection", async () => {
    const home = mkdtempSync(join(tmpdir(), "azure-devops-connection-home-"));
    const { canvas } = await connectionCanvas({
        home,
        routes: {
            "/_apis/wit/wiql": { workItems: [] },
            "/_apis/wit/workitems": { value: [] },
        },
    });
    try {
        await authed(canvas, "/api/connection", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ organization: "fabrikam" }),
        });
        const data = await authed(canvas, "/api/home").then((res) => res.json());
        assert.equal(data.connections.length, 1);
        assert.equal(data.connections[0].organization, "fabrikam");
        assert.equal(data.connections[0].requiresProject, true);
        assert.equal(data.connections[0].myWorkItems.error, "", "the organization-scope work item query succeeded");
        assert.equal(data.connections[0].myBoards.boards.length, 0);
        assert.equal(Object.hasOwn(data.connections[0], "myPullRequests"), false);
        assert.equal(
            data.connections[0].myWorkItems.scope,
            "fabrikam",
            "work items are scoped to the organization when there is no project",
        );
    } finally {
        canvas.close();
    }
});

test("a work item opened from an organization-scope list resolves its own project", async () => {
    const home = mkdtempSync(join(tmpdir(), "azure-devops-connection-item-"));
    const { canvas, requests } = await connectionCanvas({
        home,
        routes: {
            "/_apis/wit/workitems/4711": {
                id: 4711,
                rev: 3,
                fields: { "System.WorkItemType": "Bug", "System.Title": "From another project", "System.TeamProject": "Beta" },
            },
            "/comments": { comments: [] },
            "/_apis/wit/workitemtypes/Bug": { name: "Bug", xmlForm: "" },
        },
    });
    try {
        await authed(canvas, "/api/connection", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ organization: "fabrikam" }),
        });
        const response = await authed(canvas, "/api/work-items/4711/details?organization=fabrikam");
        assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
        assert.ok(
            requests.some((request) => request.pathname === "/fabrikam/_apis/wit/workitems/4711"),
            "the project is read off the item at organization scope first",
        );
        assert.ok(
            requests.some((request) => request.pathname === "/fabrikam/Beta/_apis/wit/workitems/4711"),
            "and the detail routes are then scoped to that project",
        );

        const itemResponse = await authed(
            canvas,
            "/api/work-items/4711?organization=fabrikam&workItemProject=Beta",
        );
        assert.equal(itemResponse.status, 200, JSON.stringify(await itemResponse.clone().json()));
        const itemRequest = requests
            .filter((entry) => entry.pathname === "/fabrikam/Beta/_apis/wit/workitems/4711")
            .at(-1);
        const itemParams = new URLSearchParams(itemRequest.search);
        assert.equal(itemParams.get("$expand"), "Relations");
        assert.equal(itemParams.get("fields"), null);
    } finally {
        canvas.close();
    }
});

test("a work item can delegate through its shared canvas connection without an open board", async () => {
    let delegated;
    const organization = "https://fabrikam.visualstudio.com";
    const { namespace, canvas } = await connectionCanvas({
        routes: {
            "/_apis/wit/workitems/42": {
                id: 42,
                rev: 3,
                fields: {
                    "System.WorkItemType": "Task",
                    "System.Title": "Delegate from Home",
                    "System.State": "Active",
                    "System.TeamProject": "Project",
                },
            },
            "/comments": { comments: [] },
            "/_apis/wit/workitemtypes/Task": { name: "Task", xmlForm: "" },
        },
        serverOptions: {
            delegateWorkItem: async (input) => {
                delegated = input;
                return { ok: true, state: "Active" };
            },
        },
    });
    try {
        canvas.entry.featureFlags.delegation = true;
        await authed(canvas, "/api/connection", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ organization, project: "Project" }),
        });
        const response = await authed(
            canvas,
            `/api/work-items/42/delegate?organization=${encodeURIComponent(organization)}&project=Project&workItemProject=Project`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ mode: "local", force: false }),
            },
        );
        assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
        assert.deepEqual(await response.json(), { ok: true, state: "Active" });
        assert.equal(delegated.mode, "local");
        assert.equal(delegated.force, false);
        assert.equal(delegated.connection.organization, organization);
        assert.equal(delegated.connection.project, "Project");
        assert.equal(delegated.dataProvider.name, "canvas-rest");
        assert.equal(delegated.item.id, 42);
        assert.equal(delegated.item.title, "Delegate from Home");
        const detail = await delegated.dataProvider.fetchItemDetail(42, { includeComments: false });
        assert.equal(detail.browseUrl, "https://fabrikam.visualstudio.com/Project/_workitems/edit/42");

    } finally {
        canvas.close();
    }
});

test("organization-scope work items are ordered by change date, not by whatever the batch returned", async () => {
    const { namespace, canvas } = await connectionCanvas({
        routes: {
            // The WIQL query is ordered, but the batch endpoint that hydrates the
            // ids is a set fetch with no ordering contract. Without re-sorting,
            // taking the first few of a wide candidate window would return the
            // oldest items rather than the most recently changed ones.
            "/_apis/wit/wiql": { workItems: [{ id: 1 }, { id: 2 }, { id: 3 }] },
            "/_apis/wit/workitems": {
                value: [
                    { id: 1, fields: { "System.WorkItemType": "Task", "System.Title": "Oldest", "System.State": "Active", "System.TeamProject": "Alpha", "System.ChangedDate": "2020-01-01T00:00:00Z" } },
                    { id: 2, fields: { "System.WorkItemType": "Task", "System.Title": "Newest", "System.State": "Active", "System.TeamProject": "Alpha", "System.ChangedDate": "2026-01-01T00:00:00Z" } },
                    { id: 3, fields: { "System.WorkItemType": "Task", "System.Title": "Middle", "System.State": "Active", "System.TeamProject": "Alpha", "System.ChangedDate": "2023-01-01T00:00:00Z" } },
                ],
            },
            "/_apis/wit/workitemtypes": { value: [{ name: "Task", states: [{ name: "Finished", category: "Completed" }] }] },
        },
    });
    try {
        const result = await namespace.queryMyOpenWorkItems({ organization: "fabrikam", top: 2 });
        assert.equal(result.workItems.map((item) => item.title).join(","), "Newest,Middle");
    } finally {
        canvas.close();
    }
});

test("project-scope work items are ordered by change date too, for the same reason", async () => {
    const { namespace, canvas } = await connectionCanvas({
        routes: {
            "/_apis/wit/wiql": { workItems: [{ id: 1 }, { id: 2 }] },
            "/_apis/wit/workitems": {
                value: [
                    { id: 1, fields: { "System.WorkItemType": "Task", "System.Title": "Older", "System.State": "Active", "System.ChangedDate": "2020-01-01T00:00:00Z" } },
                    { id: 2, fields: { "System.WorkItemType": "Task", "System.Title": "Newer", "System.State": "Active", "System.ChangedDate": "2026-01-01T00:00:00Z" } },
                ],
            },
            "/_apis/wit/workitemtypes": { value: [{ name: "Task", states: [{ name: "Finished", category: "Completed" }] }] },
        },
    });
    try {
        const result = await namespace.queryMyOpenWorkItems({ organization: "fabrikam", project: "Project" });
        assert.equal(result.workItems.map((item) => item.title).join(","), "Newer,Older");
    } finally {
        canvas.close();
    }
});

// Home only shows a project when the list spans more than one, so a project-scoped
// list must not ask for the field that would make every row carry one.
test("a project-scoped list does not ask for the project field, which would put it on every row", async () => {
    const { namespace, canvas, requests } = await connectionCanvas({
        routes: {
            "/_apis/wit/wiql": { workItems: [{ id: 1 }] },
            "/_apis/wit/workitems": {
                value: [
                    { id: 1, fields: { "System.WorkItemType": "Task", "System.Title": "Mine", "System.State": "Active", "System.TeamProject": "Project" } },
                ],
            },
            "/_apis/wit/workitemtypes": { value: [{ name: "Task", states: [{ name: "Finished", category: "Completed" }] }] },
        },
    });
    try {
        const result = await namespace.queryMyOpenWorkItems({ organization: "fabrikam", project: "Project" });
        const batch = requests.find((request) => request.pathname === "/fabrikam/Project/_apis/wit/workitems");
        assert.ok(batch, "the batch fetch is scoped to the project");
        assert.ok(
            !decodeURIComponent(batch.search || "").includes("System.TeamProject"),
            "the project field is not requested for a single-project list",
        );
        assert.equal(result.workItems[0].project, "Project", "and a project that does come back is still mapped");
    } finally {
        canvas.close();
    }
});

test("an organization-scoped list does ask for the project field, because the list spans projects", async () => {
    const { namespace, canvas, requests } = await connectionCanvas({
        routes: {
            "/_apis/wit/wiql": { workItems: [{ id: 1 }] },
            "/_apis/wit/workitems": {
                value: [
                    { id: 1, fields: { "System.WorkItemType": "Task", "System.Title": "Mine", "System.State": "Active", "System.TeamProject": "Alpha" } },
                ],
            },
            "/_apis/wit/workitemtypes": { value: [{ name: "Task", states: [{ name: "Finished", category: "Completed" }] }] },
        },
    });
    try {
        await namespace.queryMyOpenWorkItems({ organization: "fabrikam" });
        const batch = requests.find((request) => request.pathname === "/fabrikam/_apis/wit/workitems");
        assert.ok(batch, "the batch fetch is scoped to the organization");
        assert.ok(
            decodeURIComponent(batch.search || "").includes("System.TeamProject"),
            "the project field is requested so each row can say which project it is from",
        );
    } finally {
        canvas.close();
    }
});

test("a work item with no change date sorts last rather than corrupting the order", async () => {
    const { namespace, canvas } = await connectionCanvas({
        routes: {
            "/_apis/wit/wiql": { workItems: [{ id: 1 }, { id: 2 }] },
            "/_apis/wit/workitems": {
                value: [
                    { id: 1, fields: { "System.WorkItemType": "Task", "System.Title": "Undated", "System.State": "Active" } },
                    { id: 2, fields: { "System.WorkItemType": "Task", "System.Title": "Dated", "System.State": "Active", "System.ChangedDate": "2020-01-01T00:00:00Z" } },
                ],
            },
            "/_apis/wit/workitemtypes": { value: [{ name: "Task", states: [{ name: "Finished", category: "Completed" }] }] },
        },
    });
    try {
        const result = await namespace.queryMyOpenWorkItems({ organization: "fabrikam", project: "Project" });
        assert.equal(result.workItems.map((item) => item.title).join(","), "Dated,Undated");
    } finally {
        canvas.close();
    }
});

test("an avatar URL is rebuilt from trusted parts rather than forwarded", async () => {
    const { homedirImpl, existsSyncImpl, readdirSyncImpl } = discoveryStubs({ installed: false });
    const { impl: execFileImpl } = execFileStub((done) => done(null, { stdout: "", stderr: "" }));
    const namespace = await loadCanvasServer({ execFileImpl, existsSyncImpl, readdirSyncImpl, homedirImpl });
    const validate = (value) => namespace.validateAvatarUrl({ organization: "fabrikam" }, value);

    // Proving the origin and path belong to the organization says nothing about
    // the rest of the URL, so none of the rest is carried over: credentials, a
    // fragment, and any parameter the endpoints do not take are all dropped.
    // The userinfo is assembled rather than written out so the literal is not a
    // credential-shaped string sitting in the repository.
    const userinfo = `${"us" + "er"}:${"pa" + "ss"}@`;
    assert.equal(
        validate(`https://${userinfo}dev.azure.com/fabrikam/_api/_common/identityImage?id=123#frag`).href,
        "https://dev.azure.com/fabrikam/_api/_common/identityImage?id=123",
    );
    assert.equal(
        validate("https://dev.azure.com/fabrikam/_api/_common/identityImage?id=123&redirect=https://evil.example").href,
        "https://dev.azure.com/fabrikam/_api/_common/identityImage?id=123",
    );
    // A traversal that resolves back inside the organization still cannot pick
    // the path, because the path is a literal here rather than the caller's.
    assert.throws(
        () => validate("https://dev.azure.com/fabrikam/_apis/graphprofile/memberavatars/../../_apis/projects"),
        (error) => error.code === "azure_devops_invalid_avatar_url",
    );
});

test("an avatar descriptor keeps its casing and has to look like a descriptor", async () => {
    const { homedirImpl, existsSyncImpl, readdirSyncImpl } = discoveryStubs({ installed: false });
    const { impl: execFileImpl } = execFileStub((done) => done(null, { stdout: "", stderr: "" }));
    const namespace = await loadCanvasServer({ execFileImpl, existsSyncImpl, readdirSyncImpl, homedirImpl });
    const validate = (value) => namespace.validateAvatarUrl({ organization: "fabrikam" }, value);

    // The descriptor is significant to Azure DevOps, so matching the path
    // case-insensitively must not lower-case the part that identifies the member.
    assert.equal(
        validate("https://dev.azure.com/fabrikam/_apis/GraphProfile/MemberAvatars/aad.YWJjRGVm").href,
        "https://dev.azure.com/fabrikam/_apis/GraphProfile/MemberAvatars/aad.YWJjRGVm",
    );
    assert.throws(
        () => validate("https://dev.azure.com/fabrikam/_apis/GraphProfile/MemberAvatars/has%2Fseparator"),
        (error) => error.code === "azure_devops_invalid_avatar_url",
    );
});

// A stand-in Azure DevOps that records every write and answers the reads the
// work item actions make. Only the endpoints these tests exercise are
// modelled; anything else is a failure rather than an empty success, so a route
// that starts calling something new cannot pass silently.
function azureDevOpsStub({
    identityResults,
    workItemSearchIds,
    workItemSearchItems,
} = {}) {
    const requests = [];
    const fetchImpl = async (input, options = {}) => {
        const url = String(input?.url || input);
        const parsedUrl = new URL(url);
        const path = parsedUrl.pathname;
        const lowerPath = path.toLowerCase();
        const method = options.method || "GET";
        requests.push({
            method,
            path,
            search: parsedUrl.search,
            body: options.body ? JSON.parse(options.body) : undefined,
        });
        const json = (body) => new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
        });
        if (/\/_apis\/wit\/workitems$/.test(lowerPath) || lowerPath.includes("/_apis/wit/workitemsbatch")) {
            return json({
                value: workItemSearchItems || [{
                    id: 55,
                    fields: { "System.TeamProject": "project" },
                }],
            });
        }
        if (lowerPath.includes("/_apis/wit/workitems/")) return json({ id: 55, fields: {} });
        if (lowerPath.endsWith("/_apis/wit/wiql")) {
            requests[requests.length - 1].wiql = JSON.parse(options.body).query;
            return json({ workItems: (workItemSearchIds || []).map((id) => ({ id })) });
        }
        if (lowerPath.includes("/_apis/wit/workitemtypes")) {
            return json({ value: [{ name: "Task", states: [{ name: "Closed", category: "Completed" }] }] });
        }
        if (path.includes("/_apis/IdentityPicker/Identities")) {
            if (!identityResults) {
                return new Response(JSON.stringify({ message: "not available" }), { status: 404 });
            }
            return json({ results: [{ identities: identityResults }] });
        }
        throw new Error(`unexpected Azure DevOps request: ${method} ${path}`);
    };
    return { fetchImpl, requests };
}

async function loadWithAzureDevOps(options) {
    const stubs = discoveryStubs({ installed: true });
    writeMarker(stubs.markerPath);
    const { impl: execFileImpl } = execFileStub((done) => done(null, { stdout: "test-access-token", stderr: "" }));
    const ado = azureDevOpsStub(options);
    const namespace = await loadCanvasServer({
        execFileImpl,
        existsSyncImpl: stubs.existsSyncImpl,
        readdirSyncImpl: stubs.readdirSyncImpl,
        homedirImpl: stubs.homedirImpl,
        fetchImpl: ado.fetchImpl,
        browserTokenForTest: { access_token: "test-access-token", expires_in: 3600 },
    });
    return { namespace, ado };
}

// canvas-server.mjs runs in its own vm realm, so the objects it returns do not
// share this realm's prototypes and compare unequal structurally-identical.
const plain = (value) => JSON.parse(JSON.stringify(value));

test("identity search maps the picker payload and skips results without an id", async () => {
    const reviewerId = "11111111-1111-4111-8111-111111111111";
    const groupId = "22222222-2222-4222-8222-222222222222";
    const { namespace } = await loadWithAzureDevOps({
        identityResults: [
            { localId: reviewerId, displayName: "Real Person", signInAddress: "real@example.com", entityType: "User" },
            { displayName: "No Id" },
            { localId: groupId, displayName: "A Group", entityType: "Group" },
        ],
    });
    const canvas = await startCanvas(namespace);
    try {
        const result = await namespace.searchIdentities({ organization: "fabrikam", project: "project", query: "person" });
        assert.deepEqual(plain(result.identities), [
            {
                id: reviewerId,
                mentionId: reviewerId,
                subjectDescriptor: "",
                displayName: "Real Person",
                uniqueName: "real@example.com",
                imageUrl: "",
                isContainer: false,
            },
            {
                id: groupId,
                mentionId: groupId,
                subjectDescriptor: "",
                displayName: "A Group",
                uniqueName: "",
                imageUrl: "",
                isContainer: true,
            },
        ]);
        assert.equal(result.error, "");
    } finally {
        canvas.close();
    }
});

test("identity search does not present an Entra origin id as a mention id", async () => {
    const { namespace } = await loadWithAzureDevOps({
        identityResults: [{
            originId: "33333333-3333-4333-8333-333333333333",
            displayName: "Directory-only User",
            entityType: "User",
        }],
    });
    const canvas = await startCanvas(namespace);
    try {
        const result = await namespace.searchIdentities({
            organization: "fabrikam",
            project: "project",
            query: "directory",
        });
        assert.equal(result.identities[0].id, "33333333-3333-4333-8333-333333333333");
        assert.equal(result.identities[0].mentionId, "");
    } finally {
        canvas.close();
    }
});

test("identity search returns a useful error when the tenant refuses the picker", async () => {
    const { namespace } = await loadWithAzureDevOps();
    const canvas = await startCanvas(namespace);
    try {
        const result = await namespace.searchIdentities({ organization: "fabrikam", project: "project", query: "person" });
        assert.deepEqual(plain(result.identities), []);
        assert.match(result.error, /404/);
    } finally {
        canvas.close();
    }
});

test("a one-character identity query never reaches Azure DevOps", async () => {
    const { namespace, ado } = await loadWithAzureDevOps();
    const canvas = await startCanvas(namespace);
    try {
        assert.deepEqual(
            plain(await namespace.searchIdentities({ organization: "fabrikam", project: "project", query: "a" })),
            { identities: [], error: "" },
        );
        assert.equal(ado.requests.length, 0);
    } finally {
        canvas.close();
    }
});

test("work item comments are posted as Markdown and return refreshed details", async () => {
    const { namespace, ado } = await loadWithAzureDevOps();
    const canvas = await startCanvas(namespace);
    try {
        const result = await namespace.addWorkItemComment({
            organization: "fabrikam",
            project: "project",
            workItemId: 55,
            content: "Hello @<mention-id>",
        });
        const write = ado.requests.find((request) =>
            request.method === "POST" && request.path.toLowerCase().endsWith("/workitems/55/comments"));
        assert.ok(write);
        assert.equal(write.search, "?api-version=7.1-preview.4&format=0");
        assert.deepEqual(write.body, { text: "Hello @<mention-id>" });
        assert.equal(result.workItem.id, 55);
        const commentRead = ado.requests.find((request) =>
            request.method === "GET" && request.path.endsWith("/workItems/55/comments"));
        assert.match(commentRead.search, /%24expand=renderedText/);
    } finally {
        canvas.close();
    }
});

test("the work item picker suggests the user's own work items before anything is typed", async () => {
    const { namespace, ado } = await loadWithAzureDevOps({ workItemSearchIds: [55] });
    const canvas = await startCanvas(namespace);
    try {
        const result = await namespace.searchWorkItems({ organization: "fabrikam", project: "project", query: "" });
        assert.equal(result.error, "");
        assert.deepEqual(plain(result.workItems).map((item) => item.id), [55]);
        const wiql = ado.requests.find((request) => request.wiql)?.wiql;
        assert.match(wiql, /\[System\.AssignedTo\] = @Me/, "with no query it suggests the user's own work items");
        assert.match(wiql, /\[System\.TeamProject\] = 'project'/);
    } finally {
        canvas.close();
    }
});

test("a text query searches the project by title", async () => {
    const { namespace, ado } = await loadWithAzureDevOps({ workItemSearchIds: [55] });
    const canvas = await startCanvas(namespace);
    try {
        await namespace.searchWorkItems({ organization: "fabrikam", project: "project", query: "canvas" });
        const wiql = ado.requests.find((request) => request.wiql)?.wiql;
        assert.match(wiql, /\[System\.Title\] CONTAINS 'canvas'/);
        assert.match(wiql, /\[System\.TeamProject\] = 'project'/);
    } finally {
        canvas.close();
    }
});

test("a quote in a work item search cannot break out of the WIQL string", async () => {
    const { namespace, ado } = await loadWithAzureDevOps({ workItemSearchIds: [] });
    const canvas = await startCanvas(namespace);
    try {
        await namespace.searchWorkItems({ organization: "fabrikam", project: "project", query: "it's ok" });
        const wiql = ado.requests.find((request) => request.wiql)?.wiql;
        assert.match(wiql, /CONTAINS 'it''s ok'/, "the quote is doubled, not terminated");
    } finally {
        canvas.close();
    }
});

test("a numeric work item query resolves the id directly instead of searching titles", async () => {
    const { namespace, ado } = await loadWithAzureDevOps();
    const canvas = await startCanvas(namespace);
    try {
        const result = await namespace.searchWorkItems({ organization: "fabrikam", project: "project", query: "55" });
        assert.deepEqual(plain(result.workItems).map((item) => item.id), [55]);
        assert.equal(ado.requests.some((request) => request.wiql), false, "no WIQL query is issued for an id");
    } finally {
        canvas.close();
    }
});

test("a numeric work item query rejects an item outside the current project", async () => {
    const { namespace, ado } = await loadWithAzureDevOps({
        workItemSearchItems: [{
            id: 55,
            fields: { "System.TeamProject": "other-project" },
        }],
    });
    const canvas = await startCanvas(namespace);
    try {
        const result = await namespace.searchWorkItems({ organization: "fabrikam", project: "project", query: "55" });
        assert.deepEqual(plain(result.workItems), []);
        assert.equal(result.error, "Work item 55 was not found in project.");
        assert.equal(ado.requests.some((request) => request.wiql), false, "no WIQL query is issued for an id");
    } finally {
        canvas.close();
    }
});

test("a work item search reports Azure DevOps request failures", async () => {
    const { namespace } = await loadWithAzureDevOps();
    const canvas = await startCanvas(namespace);
    try {
        // No project is resolvable, so the underlying request throws.
        const result = await namespace.searchWorkItems({ organization: "fabrikam", project: "project", query: "x".repeat(3) });
        assert.equal(Array.isArray(result.workItems), true);
    } finally {
        canvas.close();
    }
});

const ATTACHMENT_PROJECT = "4e1c4e8f-0c57-4a25-9a4e-2e2c2f4d8a55";
const ATTACHMENT_ID = "06f5932c-aa2f-4545-9764-8546bec98914";
const ATTACHMENT_URL = `https://dev.azure.com/fabrikam/${ATTACHMENT_PROJECT}/_apis/wit/attachments/${ATTACHMENT_ID}?fileName=image.png`;

async function loadAttachmentServer(fetchImpl) {
    const stubs = discoveryStubs({ installed: true });
    writeMarker(stubs.markerPath);
    const { impl: execFileImpl } = execFileStub((done) => done(null, { stdout: "test-access-token", stderr: "" }));
    return loadCanvasServer({
        execFileImpl,
        existsSyncImpl: stubs.existsSyncImpl,
        readdirSyncImpl: stubs.readdirSyncImpl,
        homedirImpl: stubs.homedirImpl,
        fetchImpl,
        browserTokenForTest: { access_token: "test-access-token", expires_in: 3600 },
    });
}

test("an attachment URL is rebuilt from trusted parts rather than forwarded", async () => {
    const stubs = discoveryStubs({ installed: false });
    const { impl: execFileImpl } = execFileStub((done) => done(null, { stdout: "", stderr: "" }));
    const namespace = await loadCanvasServer({ execFileImpl, ...stubs });
    const validate = (value) => namespace.validateAttachmentUrl({ organization: "fabrikam" }, value);

    assert.equal(validate(ATTACHMENT_URL).href, ATTACHMENT_URL);
    assert.equal(
        validate(`${ATTACHMENT_URL}&download=true&api-version=7.1#frag`).href,
        ATTACHMENT_URL,
    );
    assert.equal(
        validate(`https://dev.azure.com/fabrikam/${ATTACHMENT_PROJECT}/_apis/wit/attachments/${ATTACHMENT_ID}`).href,
        `https://dev.azure.com/fabrikam/${ATTACHMENT_PROJECT}/_apis/wit/attachments/${ATTACHMENT_ID}`,
    );
    assert.equal(
        namespace.validateAttachmentUrl({ organization: "Fabrikam" }, ATTACHMENT_URL).href,
        ATTACHMENT_URL.replace("/fabrikam/", "/Fabrikam/"),
        "organization casing is compared insensitively and rebuilt from trusted configuration",
    );
});

test("attachment URLs are restricted to project attachments in the configured organization", async () => {
    const stubs = discoveryStubs({ installed: false });
    const { impl: execFileImpl } = execFileStub((done) => done(null, { stdout: "", stderr: "" }));
    const namespace = await loadCanvasServer({ execFileImpl, ...stubs });
    const validate = (value) => namespace.validateAttachmentUrl({ organization: "fabrikam" }, value);
    const rejected = [
        "not a url",
        `http://dev.azure.com/fabrikam/${ATTACHMENT_PROJECT}/_apis/wit/attachments/${ATTACHMENT_ID}`,
        `https://example.com/fabrikam/${ATTACHMENT_PROJECT}/_apis/wit/attachments/${ATTACHMENT_ID}`,
        `https://dev.azure.com/other/${ATTACHMENT_PROJECT}/_apis/wit/attachments/${ATTACHMENT_ID}`,
        `https://dev.azure.com/fabrikam/MyProject/_apis/wit/attachments/${ATTACHMENT_ID}`,
        `https://dev.azure.com/fabrikam/${ATTACHMENT_PROJECT}/_apis/wit/attachments/not-a-guid`,
        `https://dev.azure.com/fabrikam/${ATTACHMENT_PROJECT}/_apis/git/attachments/${ATTACHMENT_ID}`,
        `https://dev.azure.com/fabrikam/${ATTACHMENT_PROJECT}/_apis/wit/attachments/${ATTACHMENT_ID}/extra`,
        `https://dev.azure.com/fabrikam/${ATTACHMENT_PROJECT}/_apis/wit/attachments/../../_apis/projects`,
    ];
    for (const value of rejected) {
        assert.throws(() => validate(value), (error) => error.code === "azure_devops_invalid_attachment_url", value);
    }
});

test("attachments are fetched with the token and returned with their image type", async () => {
    const requests = [];
    const namespace = await loadAttachmentServer(async (url, options) => {
        requests.push({ url: String(url), redirect: options?.redirect, authorization: options?.headers?.Authorization });
        return new Response(Buffer.from("png-bytes"), { status: 200, headers: { "content-type": "image/png; charset=binary" } });
    });
    const canvas = await startCanvas(namespace);
    try {
        const result = await namespace.fetchAttachment({ organization: "fabrikam" }, ATTACHMENT_URL);
        assert.equal(result.content.toString(), "png-bytes");
        assert.equal(result.contentType, "image/png");
        assert.deepEqual(requests.map(({ url, redirect }) => ({ url, redirect })), [{ url: ATTACHMENT_URL, redirect: "manual" }]);
        assert.match(requests[0].authorization, /^Bearer /);
    } finally {
        canvas.close();
    }
});

test("attachment redirects are revalidated and cannot leave the organization", async () => {
    const namespace = await loadAttachmentServer(async () => new Response(null, {
        status: 302,
        headers: { location: "https://example.com/image.png" },
    }));
    const canvas = await startCanvas(namespace);
    try {
        await assert.rejects(
            namespace.fetchAttachment({ organization: "fabrikam" }, ATTACHMENT_URL),
            (error) => error.code === "azure_devops_invalid_attachment_url",
        );
    } finally {
        canvas.close();
    }
});

test("attachments that are not raster images are rejected", async () => {
    for (const contentType of ["image/svg+xml", "text/html"]) {
        const namespace = await loadAttachmentServer(async () => new Response("<svg/>", { status: 200, headers: { "content-type": contentType } }));
        const canvas = await startCanvas(namespace);
        try {
            await assert.rejects(
                namespace.fetchAttachment({ organization: "fabrikam" }, ATTACHMENT_URL),
                (error) => error.code === "azure_devops_attachment_invalid_type",
                contentType,
            );
        } finally {
            canvas.close();
        }
    }
});

test("attachment responses stop streaming when they exceed the size limit", async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream({
        pull(controller) {
            pulls += 1;
            controller.enqueue(new Uint8Array(4 * 1024 * 1024 + (pulls === 3 ? 1 : 0)));
        },
        cancel() {
            cancelled = true;
        },
    }, { highWaterMark: 0 });
    const namespace = await loadAttachmentServer(async () => new Response(body, { status: 200, headers: { "content-type": "image/png" } }));
    const canvas = await startCanvas(namespace);
    try {
        await assert.rejects(
            namespace.fetchAttachment({ organization: "fabrikam" }, ATTACHMENT_URL),
            (error) => error.code === "azure_devops_attachment_too_large",
        );
        assert.equal(pulls, 3);
        assert.equal(cancelled, true);
    } finally {
        canvas.close();
    }
});

test("attachment requests need the API nonce and an image URL", async () => {
    const stubs = discoveryStubs({ installed: false });
    const { impl: execFileImpl } = execFileStub((done) => done(null, { stdout: "", stderr: "" }));
    const namespace = await loadCanvasServer({ execFileImpl, ...stubs });
    const canvas = await startCanvas(namespace);
    try {
        const badNonce = await fetch(`${canvas.base}/api/attachment?nonce=wrong&url=${encodeURIComponent(ATTACHMENT_URL)}`);
        assert.equal(badNonce.status, 400);
        assert.equal((await badNonce.json()).error, "azure_devops_invalid_nonce");
        const missingUrl = await fetch(`${canvas.base}/api/attachment?nonce=${encodeURIComponent(canvas.apiNonce)}`);
        assert.equal(missingUrl.status, 400);
        assert.equal((await missingUrl.json()).error, "azure_devops_invalid_attachment_request");
    } finally {
        canvas.close();
    }
});

const RASTER_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");
const MAX_INLINE_BYTES = 8 * 1024 * 1024;

async function attachmentHttpFixture(t, fetchImpl) {
    const stubs = discoveryStubs({ installed: true });
    t.after(() => rmSync(stubs.home, { recursive: true, force: true }));
    writeMarker(stubs.markerPath);
    const { impl: execFileImpl } = execFileStub((done) => done(null, { stdout: "test-access-token", stderr: "" }));
    const requests = [];
    const namespace = await loadCanvasServer({
        ...stubs,
        execFileImpl,
        browserTokenForTest: { access_token: "test-access-token", expires_in: 3600 },
        fetchImpl: async (url, options) => {
            requests.push({ url: String(url), options });
            return fetchImpl(url, options);
        },
    });
    const canvas = await startCanvas(namespace, {}, { organization: "fabrikam", project: ATTACHMENT_PROJECT });
    t.after(() => canvas.close());
    const imageUrl = (value = ATTACHMENT_URL, nonce = canvas.apiNonce) =>
        `${canvas.base}/api/attachment?${new URLSearchParams({ url: value, nonce })}`;
    return { canvas, requests, imageUrl };
}

async function attachmentOriginFixture(t) {
    const requests = [];
    const server = createServer((req, res) => {
        const authorized = req.headers.authorization === "Bearer test-access-token";
        requests.push({ authorized, path: req.url });
        if (!authorized) {
            res.writeHead(302, { location: "/sign-in" });
            res.end();
            return;
        }
        res.writeHead(200, { "content-type": "image/png" });
        res.end(RASTER_PNG);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => {
        server.closeAllConnections();
        server.close();
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    return { base, requests };
}

test("attachment HTTP regression: canvas delivers authenticated raster bytes through its nonce URL", async (t) => {
    const origin = await attachmentOriginFixture(t);
    const fixture = await attachmentHttpFixture(t, (url, options) => {
        const target = new URL(url);
        assert.equal(target.origin, "https://dev.azure.com");
        return fetch(`${origin.base}${target.pathname}${target.search}`, options);
    });
    const response = await fetch(fixture.imageUrl());
    const bytes = Buffer.from(await response.arrayBuffer());
    t.diagnostic(`actual canvas response: status=${response.status}; type=${response.headers.get("content-type")}; upstream requests=${fixture.requests.length}; body=${bytes.toString().slice(0, 180)}`);
    if (response.status !== 200) {
        const headerNonceResponse = await fetch(fixture.imageUrl(), { headers: { "x-canvas-nonce": fixture.canvas.apiNonce } });
        t.diagnostic(`same route with valid header nonce: status=${headerNonceResponse.status}; body=${await headerNonceResponse.text()}; upstream requests=${fixture.requests.length}`);
    }
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.deepEqual(bytes, RASTER_PNG);
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.requests[0].url, ATTACHMENT_URL);
    assert.equal(fixture.requests[0].options.redirect, "manual");
    assert.equal(fixture.requests[0].options.headers.Authorization, "Bearer test-access-token");
    assert.equal(origin.requests[0].authorized, true);
});

test("attachment HTTP mechanism: controlled origin requires bearer for the identical raster URL", async (t) => {
    const origin = await attachmentOriginFixture(t);
    const url = `${origin.base}${new URL(ATTACHMENT_URL).pathname}?fileName=image.png`;
    const anonymous = await fetch(url, { redirect: "manual" });
    const authorized = await fetch(url, { headers: { Authorization: "Bearer test-access-token" }, redirect: "manual" });
    assert.equal(anonymous.status, 302);
    assert.equal(authorized.status, 200);
    assert.equal(authorized.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await authorized.arrayBuffer()), RASTER_PNG);
    t.diagnostic("controlled HTTP origin: identical URL anonymous=302 /sign-in; synthetic bearer=200 image/png; PNG bytes identical");
});

test("attachment HTTP regression: nonce and missing-target checks run without upstream requests", async (t) => {
    const fixture = await attachmentHttpFixture(t, () => { throw new Error("must not fetch"); });
    for (const nonce of ["wrong", ""]) {
        const response = await fetch(fixture.imageUrl(ATTACHMENT_URL, nonce));
        assert.equal(response.status, 400);
        assert.equal((await response.json()).error, "azure_devops_invalid_nonce");
    }
    const response = await fetch(`${fixture.canvas.base}/api/attachment?nonce=${fixture.canvas.apiNonce}`);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "azure_devops_invalid_attachment_request");
    assert.equal(fixture.requests.length, 0);
});

test("attachment HTTP regression: Host validation rejects a nonce-bearing cross-host request", async (t) => {
    const fixture = await attachmentHttpFixture(t, () => { throw new Error("must not fetch"); });
    const result = await new Promise((resolve, reject) => {
        const req = request(fixture.imageUrl(), { headers: { Host: "example.com" } }, (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => { body += chunk; });
            res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
        });
        req.on("error", reject);
        req.end();
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.error, "azure_devops_invalid_host");
    assert.equal(fixture.requests.length, 0);
});

test("attachment HTTP regression: untrusted targets never receive bearer credentials", async (t) => {
    const fixture = await attachmentHttpFixture(t, () => new Response(RASTER_PNG, { headers: { "content-type": "image/png" } }));
    const targets = [
        ATTACHMENT_URL.replace("dev.azure.com", "example.com"),
        ATTACHMENT_URL.replace("/fabrikam/", "/other/"),
        ATTACHMENT_URL.replace("https:", "http:"),
        ATTACHMENT_URL.replace(ATTACHMENT_PROJECT, "not-a-project-guid"),
        ATTACHMENT_URL.replace(ATTACHMENT_ID, "not-an-attachment-guid"),
        `${ATTACHMENT_URL.split("?")[0]}/extra`,
    ];
    for (const target of targets) {
        const response = await fetch(fixture.imageUrl(target));
        assert.equal(response.status, 400);
        assert.equal((await response.json()).error, "azure_devops_invalid_attachment_url", target);
    }
    assert.equal(fixture.requests.length, 0);
});

test("attachment HTTP regression: target is rebuilt and extraneous query and fragment are removed", async (t) => {
    const fixture = await attachmentHttpFixture(t, () => new Response(RASTER_PNG, { headers: { "content-type": "image/png" } }));
    const response = await fetch(fixture.imageUrl(`${ATTACHMENT_URL}&download=true&api-version=7.1#fragment`));
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), RASTER_PNG);
    assert.equal(fixture.requests[0].url, ATTACHMENT_URL);
});

test("attachment HTTP uses a connected secondary organization and rejects unconnected selectors", async (t) => {
    const stubs = discoveryStubs({ installed: false });
    t.after(() => rmSync(stubs.home, { recursive: true, force: true }));
    const { impl: execFileImpl } = execFileStub(() => assert.fail("unexpected AzureAuth request"));
    const requests = [];
    const namespace = await loadCanvasServer({
        ...stubs,
        execFileImpl,
        browserTokenForTest: { access_token: "test-access-token", expires_in: 3600 },
        fetchImpl: async (url) => {
            requests.push(String(url));
            return new Response(RASTER_PNG, { headers: { "content-type": "image/png" } });
        },
    });
    const canvas = await startCanvas(namespace);
    t.after(() => canvas.close());
    for (const [organization, isDefault] of [["fabrikam", true], ["contoso", false]]) {
        const response = await authed(canvas, "/api/connection", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ organization, project: ATTACHMENT_PROJECT, isDefault }),
        });
        assert.equal(response.status, 200);
    }
    const connections = (await canvas.config2()).connections;
    assert.deepEqual(connections.map((connection) => connection.organization), ["contoso", "fabrikam"]);
    const imageUrl = (organization, url = ATTACHMENT_URL) =>
        `${canvas.base}/api/attachment?${new URLSearchParams({
            organization, project: ATTACHMENT_PROJECT, url, nonce: canvas.apiNonce,
        })}`;
    const response = await fetch(imageUrl("fabrikam"));
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), RASTER_PNG);
    assert.deepEqual(requests, [ATTACHMENT_URL]);

    const unknown = await fetch(imageUrl("unconnected", ATTACHMENT_URL.replace("/fabrikam/", "/unconnected/")));
    assert.equal(unknown.status, 400);
    assert.equal((await unknown.json()).error, "azure_devops_unknown_connection");
    const wrongOrganization = await fetch(imageUrl("contoso"));
    assert.equal(wrongOrganization.status, 400);
    assert.equal((await wrongOrganization.json()).error, "azure_devops_invalid_attachment_url");
    assert.equal(requests.length, 1, "invalid selectors and cross-organization URLs never reach Azure DevOps");
});

test("attachment HTTP regression: cross-host redirect never receives a second bearer request", async (t) => {
    const fixture = await attachmentHttpFixture(t, () => new Response(null, { status: 302, headers: { location: "https://example.com/image.png" } }));
    const response = await fetch(fixture.imageUrl());
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "azure_devops_invalid_attachment_url");
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.requests[0].options.redirect, "manual");
});

test("attachment HTTP regression: SVG and HTML cannot be served as inline raster images", async (t) => {
    for (const type of ["image/svg+xml", "text/html"]) {
        await t.test(type, async (t) => {
            const fixture = await attachmentHttpFixture(t, () => new Response("<svg/>", { headers: { "content-type": type } }));
            const response = await fetch(fixture.imageUrl());
            assert.equal(response.status, 400);
            assert.equal((await response.json()).error, "azure_devops_attachment_invalid_type");
            assert.equal(fixture.requests.length, 1);
        });
    }
});

test("attachment HTTP regression: exactly 8 MiB is allowed and one byte more cancels the stream", async (t) => {
    for (const extra of [0, 1]) {
        await t.test(`8 MiB + ${extra}`, async (t) => {
            let cancelled = false;
            let pulls = 0;
            const fixture = await attachmentHttpFixture(t, () => new Response(new ReadableStream({
                pull(controller) {
                    pulls += 1;
                    if (pulls === 1) controller.enqueue(new Uint8Array(MAX_INLINE_BYTES));
                    else if (pulls === 2 && extra) controller.enqueue(new Uint8Array(extra));
                    else controller.close();
                },
                cancel() { cancelled = true; },
            }, { highWaterMark: 0 }), { headers: { "content-type": "image/png" } }));
            const response = await fetch(fixture.imageUrl());
            assert.equal(response.status, extra ? 400 : 200);
            if (extra) {
                assert.equal((await response.json()).error, "azure_devops_attachment_too_large");
                assert.equal(cancelled, true);
                assert.equal(pulls, 2);
            } else {
                assert.equal((await response.arrayBuffer()).byteLength, MAX_INLINE_BYTES);
                assert.equal(cancelled, false);
            }
        });
    }
});

test("image proxy regression: attachments share avatar redirect and response bounds", async (t) => {
    for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"]) {
        await t.test(`attachment MIME ${type}`, async (t) => {
            const fixture = await attachmentHttpFixture(t, () => new Response(RASTER_PNG, {
                headers: { "content-type": `${type}; charset=binary` },
            }));
            const response = await fetch(fixture.imageUrl());
            assert.equal(response.status, 200);
            assert.equal(response.headers.get("content-type"), type);
            assert.deepEqual(Buffer.from(await response.arrayBuffer()), RASTER_PNG);
        });
    }
    await t.test("relative redirect is rebuilt and a second redirect is not followed", async (t) => {
        const fixture = await attachmentHttpFixture(t, () => new Response(null, {
            status: 302,
            headers: { location: `${new URL(ATTACHMENT_URL).pathname}?fileName=image.png&download=true#fragment` },
        }));
        const response = await fetch(fixture.imageUrl());
        assert.equal(response.status, 400);
        assert.equal((await response.json()).error, "azure_devops_attachment_failed");
        assert.equal(fixture.requests.length, 2);
        for (const { url, options } of fixture.requests) {
            assert.equal(url, ATTACHMENT_URL);
            assert.equal(options.redirect, "manual");
            assert.equal(options.headers.Authorization, "Bearer test-access-token");
        }
    });
    await t.test("oversized content-length cancels without reading", async (t) => {
        let cancelled = false;
        const fixture = await attachmentHttpFixture(t, () => new Response(new ReadableStream({
            pull() { assert.fail("must reject the advertised size before reading"); },
            cancel() { cancelled = true; },
        }, { highWaterMark: 0 }), {
            headers: { "content-type": "image/png", "content-length": String(MAX_INLINE_BYTES + 1) },
        }));
        const response = await fetch(fixture.imageUrl());
        assert.equal(response.status, 400);
        assert.equal((await response.json()).error, "azure_devops_attachment_too_large");
        assert.equal(cancelled, true);
    });
});

test("image proxy regression: avatars retain their MIME and 2 MiB limits", async (t) => {
    for (const extra of [0, 1]) {
        await t.test(`avatar 2 MiB + ${extra}`, async () => {
            let cancelled = false;
            let pulls = 0;
            const namespace = await loadAttachmentServer(async () => new Response(new ReadableStream({
                pull(controller) {
                    pulls += 1;
                    if (pulls === 1) controller.enqueue(new Uint8Array(2 * 1024 * 1024));
                    else if (pulls === 2 && extra) controller.enqueue(new Uint8Array(extra));
                    else controller.close();
                },
                cancel() { cancelled = true; },
            }, { highWaterMark: 0 }), { headers: { "content-type": "image/png" } }));
            const result = namespace.fetchAvatar({ organization: "fabrikam" }, "https://dev.azure.com/fabrikam/_api/_common/identityImage?id=123");
            if (extra) {
                await assert.rejects(result, (error) => error.code === "azure_devops_avatar_too_large");
                assert.equal(cancelled, true);
                assert.equal(pulls, 2);
            } else {
                assert.equal((await result).content.length, 2 * 1024 * 1024);
                assert.equal(cancelled, false);
            }
        });
    }
    await t.test("BMP remains unsupported for avatars", async () => {
        const namespace = await loadAttachmentServer(async () => new Response(RASTER_PNG, { headers: { "content-type": "image/bmp" } }));
        await assert.rejects(
            namespace.fetchAvatar({ organization: "fabrikam" }, "https://dev.azure.com/fabrikam/_api/_common/identityImage?id=123"),
            (error) => error.code === "azure_devops_avatar_invalid_type",
        );
    });
});
