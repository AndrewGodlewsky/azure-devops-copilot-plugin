import { createServer } from "node:http";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CanvasError } from "@github/copilot-sdk/extension";
import {
    AGENCY_AUTH_ENABLED,
    DEFAULT_FEATURE_FLAGS,
    encodePathPart,
    hasRenderableContent,
    normalizeMultilineFieldFormat,
    normalizeRichText,
    normalizeFeatureFlags,
    normalizeString,
} from "./common.mjs";
// The write policy lives under ui/ because the browser editor enforces it too, and
// only files under that directory are served to the canvas. It is DOM-free so the
// same module loads here.
import { validateEditableHtml, validateWriteHtml } from "./ui/rich-text-policy.mjs";
import {
    CONNECTION_WRITE_FAILED,
    clearConnectionDefault,
    clearConnectionPreference,
    normalizeConnection,
    readConnectionPreference,
    resolveConnections,
    selectConnection,
    writeConnectionPreference,
} from "./connection.mjs";
import {
    hasWorkItemReference,
    mapWorkItem,
    mapWorkItemDetail,
    parseWorkItemTemplate,
    relatedWorkItemIds,
    resolveWorkItemReference,
} from "./work-item.mjs";

const DEFAULT_API_VERSION = "7.1";
const HOME_LIST_LIMIT = 10;
const WORK_ITEM_TYPE_ICON_CACHE_LIMIT = 500;
const WORK_ITEM_TYPE_ICON_CONCURRENCY = 4;
const FAVORITE_BOARD_ARTIFACT_TYPE = "Microsoft.TeamFoundation.Work.TeamBoardSets";
const BOARD_BACKLOG_CATEGORY_IDS = [
    "Microsoft.EpicCategory",
    "Microsoft.FeatureCategory",
    "Microsoft.RequirementCategory",
    "Microsoft.TaskCategory",
];
const BOARD_CARD_FIELDS = [
    "System.Id",
    "System.Title",
    "System.State",
    "System.WorkItemType",
    "System.Parent",
    "System.AssignedTo",
    "System.Tags",
    "Microsoft.VSTS.Common.Priority",
];
// How many recently-changed work items the organization-scope query pulls back
// before filtering out the closed ones. Capped by the 200-id limit of the work
// item batch-get endpoint.
const ORG_WORK_ITEM_CANDIDATE_LIMIT = 200;
// Organizations and profiles are served by VS SaaS Platform Services, a
// different host from the per-organization dev.azure.com URLs.
const VSSPS_BASE_URL = "https://app.vssps.visualstudio.com";
const PROJECT_LIST_LIMIT = 500;
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const TERMINAL_WORK_ITEM_STATE_CATEGORIES = new Set(["completed", "removed"]);
const AZUREAUTH_TIMEOUT_MINUTES = "15";
// A silent attempt must never hold /api/config open waiting on a person. A warm
// AzureAuth cache returns in well under a second, so anything past this budget
// means the acquisition escalated to a prompt and should be abandoned. AzureAuth
// is told the same budget so it does not believe it may prompt for 15 minutes
// while this side kills it after ten seconds.
const AZUREAUTH_SILENT_TIMEOUT_MINUTES = "1";
const AZUREAUTH_SILENT_TIMEOUT_MS = 10 * 1000;
const AZURE_DEVOPS_RESOURCE_ID = "499b84ac-1321-427f-aa17-267ca6975798";
const AZURE_AUTHORITY = "https://login.microsoftonline.com/common/oauth2/v2.0";
const AZURE_PUBLIC_CLIENT_ID = "04b07795-8ddb-461a-bbee-02f9e1bf7b46";
const AZURE_DEVOPS_SCOPE = `${AZURE_DEVOPS_RESOURCE_ID}/.default offline_access openid profile`;
const AZURE_OAUTH_LOOPBACK_HOST = "localhost";
const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_EXTENSION_REPO_ROOT = resolve(EXTENSION_DIR, "..", "..");
const UI_DIR = resolve(EXTENSION_DIR, "ui");
const BROWSER_COMMON_MODULE_PATH = join(EXTENSION_DIR, "common.mjs");
const EXTENSION_VERSION = loadExtensionVersion();
const execFileAsync = promisify(execFile);
const staticAssetCache = new Map();
const workItemStateFilterCache = new Map();
const workItemTypeDefinitionCache = new Map();
const workItemTypeAppearanceCache = new Map();
const workItemTypeIconCache = new Map();
const workItemTypeIconQueue = [];
let activeWorkItemTypeIconRequests = 0;
let azureAuthTokenCache = null;
let browserTokenCache = null;
let silentAgencyAuthAttempt = null;
// Bumped on sign-out so a sign-in still in flight cannot write its result
// afterwards. Sign-in work outlives the request that started it.
let authGeneration = 0;
let copilotSession;

function loadExtensionVersion() {
    try {
        const manifest = JSON.parse(
            readFileSync(join(PROJECT_EXTENSION_REPO_ROOT, ".claude-plugin", "plugin.json"), "utf8"),
        );
        const version = normalizeString(manifest?.version);
        return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version) ? version : "unknown";
    } catch {
        return "unknown";
    }
}

function base64Url(buffer) {
    return Buffer.from(buffer)
        .toString("base64")
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replaceAll("=", "");
}

function createPkcePair() {
    const verifier = base64Url(randomBytes(32));
    return {
        verifier,
        challenge: base64Url(createHash("sha256").update(verifier).digest()),
    };
}

async function readAzureAuthTokenCache() {
    return azureAuthTokenCache;
}

function parseJwtPayload(accessToken) {
    const [, payload] = normalizeString(accessToken).split(".");
    if (!payload) {
        return null;
    }
    try {
        const normalized = payload.replaceAll("-", "+").replaceAll("_", "/");
        const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
        return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    } catch {
        return null;
    }
}

function parseJwtExpiry(accessToken) {
    const exp = Number(parseJwtPayload(accessToken)?.exp);
    return Number.isFinite(exp) && exp > 0 ? exp * 1000 : null;
}

async function writeAzureAuthTokenCache(tokenResult) {
    const accessToken = normalizeString(tokenResult.accessToken ?? tokenResult.access_token);
    const cache = {
        accessToken,
        expiresAt: parseJwtExpiry(accessToken),
        source: normalizeString(tokenResult.source) || "azureauth",
        updatedAt: new Date().toISOString(),
    };
    if (!cache.accessToken) {
        throw new CanvasError("azure_devops_azureauth_token_empty", "AzureAuth returned an empty Azure DevOps token.");
    }
    azureAuthTokenCache = cache;
    return cache;
}

async function clearAzureAuthTokenCache() {
    const hadTokenCache = Boolean(azureAuthTokenCache);
    azureAuthTokenCache = null;
    return hadTokenCache;
}

async function writeBrowserTokenCache(tokenResult) {
    const cache = {
        accessToken: normalizeString(tokenResult.access_token),
        refreshToken: normalizeString(tokenResult.refresh_token),
        expiresAt: Date.now() + Math.max(0, Number(tokenResult.expires_in || 0) - 60) * 1000,
        source: "browser-oauth",
        updatedAt: new Date().toISOString(),
    };
    if (!cache.accessToken) {
        throw new CanvasError("azure_devops_oauth_token_empty", "Microsoft identity platform returned an empty access token.");
    }
    browserTokenCache = cache;
    return cache;
}

async function clearBrowserTokenCache() {
    const hadTokenCache = Boolean(browserTokenCache);
    browserTokenCache = null;
    return hadTokenCache;
}

function azureAuthTokenArgs(timeoutMinutes = AZUREAUTH_TIMEOUT_MINUTES) {
    return ["ado", "token", "--output", "token", "--timeout", timeoutMinutes, "--prompt-hint", "azure-devops-canvas"];
}

function managedAzureAuthDiscovery() {
    const roots = [];
    if (process.platform === "win32") {
        const localAppData = normalizeString(process.env.LOCALAPPDATA) || join(homedir(), "AppData", "Local");
        roots.push(join(localAppData, "Programs", "AzureAuth"));
    } else {
        roots.push(join(homedir(), ".azureauth"));
    }
    const executableName = process.platform === "win32" ? "azureauth.exe" : "azureauth";
    const candidates = [];
    const rootDetails = [];

    for (const root of roots) {
        const rootDetail = { path: root, exists: existsSync(root), error: "" };
        rootDetails.push(rootDetail);
        if (!rootDetail.exists) {
            continue;
        }
        try {
            if (existsSync(join(root, executableName))) {
                candidates.push({ path: join(root, executableName), version: null });
            }
            for (const entry of readdirSync(root, { withFileTypes: true })) {
                if (entry.isDirectory()) {
                    const candidate = join(root, entry.name, executableName);
                    if (existsSync(candidate)) {
                        candidates.push({ path: candidate, version: entry.name });
                    }
                }
            }
        } catch (error) {
            const errorCode = normalizeString(error?.code);
            rootDetail.error = errorCode
                ? `Unable to inspect the Agency-managed AzureAuth directory (${errorCode}).`
                : "Unable to inspect the Agency-managed AzureAuth directory.";
        }
    }

    const sortedCandidates = candidates
        .sort((left, right) => {
            const versionOrder = (right.version || "").localeCompare(left.version || "", undefined, {
                numeric: true,
                sensitivity: "base",
            });
            return versionOrder || left.path.localeCompare(right.path, undefined, { sensitivity: "base" });
        })
        .map(({ path }) => path);
    return {
        roots: rootDetails,
        candidates: sortedCandidates,
        selected: sortedCandidates[0] || "",
    };
}

function azureAuthDiscoveryTrace(discovery = managedAzureAuthDiscovery()) {
    const managedRoot =
        process.platform === "win32"
            ? normalizeString(process.env.LOCALAPPDATA) || join(homedir(), "AppData", "Local")
            : homedir();
    return {
        roots: discovery.roots.map(({ path, ...detail }) => ({
            ...detail,
            path: relative(managedRoot, path),
        })),
        candidates: discovery.candidates.map((path) => relative(managedRoot, path)),
        selected: discovery.selected ? relative(managedRoot, discovery.selected) : "",
    };
}

function effectiveAgencyAuthDiscovery() {
    return AGENCY_AUTH_ENABLED
        ? azureAuthDiscoveryTrace()
        : { roots: [], candidates: [], selected: "" };
}

function azureAuthExecutable(discovery = managedAzureAuthDiscovery()) {
    const managedExecutable = discovery.selected;
    if (!managedExecutable) {
        throw new CanvasError(
            "azure_devops_azureauth_not_found",
            "Agency-managed AzureAuth executable was not found.",
        );
    }
    return managedExecutable;
}

async function acquireAzureAuthToken(
    executable = azureAuthExecutable(),
    timeoutMs = (Number(AZUREAUTH_TIMEOUT_MINUTES) + 1) * 60 * 1000,
    { timeoutMinutes = AZUREAUTH_TIMEOUT_MINUTES } = {},
) {
    const args = azureAuthTokenArgs(timeoutMinutes);
    try {
        const { stdout } = await execFileAsync(executable, args, {
            timeout: timeoutMs,
            windowsHide: true,
            maxBuffer: 1024 * 1024,
        });
        return normalizeString(stdout);
    } catch (error) {
        const detail =
            normalizeString(error?.stderr) ||
            normalizeString(error?.stdout) ||
            normalizeString(error?.code) ||
            "AzureAuth token acquisition failed.";
        throw new CanvasError(
            "azure_devops_azureauth_failed",
            `${detail} Verify the Agency-managed AzureAuth installation is available.`,
        );
    }
}

async function getAzureAuthAccessToken() {
    const cache = await readAzureAuthTokenCache();
    if (cache?.accessToken && (!cache.expiresAt || Number(cache.expiresAt) > Date.now())) {
        return {
            accessToken: cache.accessToken,
            source: cache.source || "azureauth",
            expiresAt: cache.expiresAt,
        };
    }
    throw new CanvasError("azure_devops_authentication_required", "Select an Azure DevOps sign-in option.");
}

// Records only that AzureAuth previously worked for this user -- never a token or
// any other secret. AzureAuth keeps the credential itself in its own MSAL cache.
// The marker exists so a silent acquisition is only ever attempted on a machine
// that has already completed one interactively, which is what keeps an unprompted
// browser window from appearing during a passive canvas load.
function agencyAuthMarkerPath() {
    return join(homedir(), ".copilot", "azure-devops-canvas", "auth-preference.json");
}

function hasAgencyAuthMarker() {
    try {
        const marker = JSON.parse(readFileSync(agencyAuthMarkerPath(), "utf8"));
        return normalizeString(marker?.provider) === "azureauth";
    } catch {
        return false;
    }
}

function writeAgencyAuthMarker() {
    try {
        const path = agencyAuthMarkerPath();
        mkdirSync(dirname(path), { recursive: true });
        // writeFileSync only applies mode when it creates the file, so a marker
        // written before this was restricted would keep its old permissions.
        rmSync(path, { force: true });
        writeFileSync(path, JSON.stringify({ provider: "azureauth", lastSuccessAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    } catch {
        // The marker is an optimization. Failing to record it only costs the user
        // the sign-in splash on the next load, so it must not fail the sign-in.
    }
}

function clearAgencyAuthMarker() {
    try {
        rmSync(agencyAuthMarkerPath(), { force: true });
    } catch {
        // Same rationale as writeAgencyAuthMarker.
    }
}

// Starts the previously successful AzureAuth path without holding /api/config
// open. The client keeps its startup surface visible and polls the same status
// endpoint used by interactive sign-in, so it can describe this real work without
// flashing the sign-in chooser first.
function startSilentAgencyAuth(entry) {
    if (!AGENCY_AUTH_ENABLED) {
        return null;
    }
    const cache = azureAuthTokenCache;
    if (cache?.accessToken && (!cache.expiresAt || Number(cache.expiresAt) > Date.now())) {
        return null;
    }
    if (!hasAgencyAuthMarker()) {
        return null;
    }
    const discovery = managedAzureAuthDiscovery();
    if (!discovery.selected) {
        return null;
    }
    if (silentAgencyAuthAttempt) {
        entry.authProcess = silentAgencyAuthAttempt.process;
        return entry.authProcess;
    }

    const authProcess = {
        provider: "azureauth",
        mode: "silent",
        status: "running",
        output: "Signing in.",
        startedAt: new Date().toISOString(),
        completedAt: "",
    };
    entry.authProcess = authProcess;
    const generation = authGeneration;
    const complete = (status, output) => {
        authProcess.status = status;
        authProcess.output = output;
        authProcess.completedAt = new Date().toISOString();
    };
    const promise = (async () => {
        try {
            const accessToken = await acquireAzureAuthToken(discovery.selected, AZUREAUTH_SILENT_TIMEOUT_MS, {
                timeoutMinutes: AZUREAUTH_SILENT_TIMEOUT_MINUTES,
            });
            if (generation !== authGeneration) {
                complete("failed", "Automatic AzureAuth sign-in was cancelled.");
                return;
            }
            await writeAzureAuthTokenCache({ accessToken, source: "azureauth" });
            complete("succeeded", "Authenticated with AzureAuth.");
        } catch (error) {
            // Falling through to the sign-in chooser is the intended outcome. The
            // user-facing process stays generic while the diagnostic log retains
            // the actionable failure detail.
            complete("failed", "Automatic AzureAuth sign-in was unavailable.");
            void copilotSession?.log?.(
                `Azure DevOps canvas: silent AzureAuth sign-in did not succeed (${normalizeString(error?.message) || "unknown error"}).`,
            ).catch(() => {});
        } finally {
            if (silentAgencyAuthAttempt?.process === authProcess) {
                silentAgencyAuthAttempt = null;
            }
        }
    })();
    silentAgencyAuthAttempt = { process: authProcess, promise };
    return authProcess;
}

async function requestMicrosoftToken(params) {
    const body = new URLSearchParams({
        client_id: AZURE_PUBLIC_CLIENT_ID,
        scope: AZURE_DEVOPS_SCOPE,
        ...params,
    });
    const response = await fetch(`${AZURE_AUTHORITY}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
    });
    const text = await response.text();
    let data = {};
    if (text) {
        try {
            data = JSON.parse(text);
        } catch {
            data = { error_description: text };
        }
    }
    if (!response.ok) {
        throw new CanvasError(
            "azure_devops_oauth_token_failed",
            data.error_description || data.error || response.statusText || "Microsoft token request failed.",
        );
    }
    return data;
}

async function getBrowserOAuthAccessToken() {
    const cache = browserTokenCache;
    if (!cache) {
        throw new CanvasError("azure_devops_oauth_login_required", "Select an Azure DevOps sign-in option.");
    }
    if (cache.accessToken && Number(cache.expiresAt || 0) > Date.now()) {
        return {
            accessToken: cache.accessToken,
            source: cache.source,
            expiresAt: cache.expiresAt,
        };
    }
    if (!cache.refreshToken) {
        throw new CanvasError("azure_devops_oauth_login_required", "Microsoft sign-in expired. Sign in again.");
    }
    const refreshed = await requestMicrosoftToken({
        grant_type: "refresh_token",
        refresh_token: cache.refreshToken,
    });
    const refreshedCache = await writeBrowserTokenCache({
        ...refreshed,
        refresh_token: refreshed.refresh_token || cache.refreshToken,
    });
    return {
        accessToken: refreshedCache.accessToken,
        source: refreshedCache.source,
        expiresAt: refreshedCache.expiresAt,
    };
}

function openBrowser(url) {
    const command = process.platform === "win32" ? "rundll32.exe" : process.platform === "darwin" ? "open" : "xdg-open";
    const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
}

async function getAuthState() {
    try {
        const token = await getBrowserOAuthAccessToken();
        return {
            isAuthenticated: true,
            authType: "microsoft",
            source: token.source,
            expiresAt: token.expiresAt,
            azureAuthDiscovery: effectiveAgencyAuthDiscovery(),
        };
    } catch {
        // Fall through to an explicitly acquired AzureAuth token.
    }
    if (!AGENCY_AUTH_ENABLED) {
        return {
            isAuthenticated: false,
            authType: "none",
            source: "",
            azureAuthDiscovery: effectiveAgencyAuthDiscovery(),
        };
    }
    const cache = await readAzureAuthTokenCache();
    if (cache?.accessToken && (!cache.expiresAt || Number(cache.expiresAt) > Date.now())) {
        return {
            isAuthenticated: true,
            authType: "azureauth",
            source: cache.source || "azureauth",
            expiresAt: cache.expiresAt,
            azureAuthDiscovery: effectiveAgencyAuthDiscovery(),
        };
    }
    return {
        isAuthenticated: false,
        authType: "none",
        source: "",
        azureAuthDiscovery: effectiveAgencyAuthDiscovery(),
    };
}

async function startMicrosoftAuth(entry) {
    if (entry.authProcess?.status === "running") {
        return entry.authProcess;
    }

    const pkce = createPkcePair();
    const generation = authGeneration;
    const state = base64Url(randomBytes(24));
    const callbackServer = createServer();
    await new Promise((resolve, reject) => {
        callbackServer.once("error", reject);
        callbackServer.listen(0, AZURE_OAUTH_LOOPBACK_HOST, resolve);
    });
    const address = callbackServer.address();
    const redirectUri = `http://${AZURE_OAUTH_LOOPBACK_HOST}:${address.port}`;
    const authProcess = {
        provider: "microsoft",
        status: "running",
        output: "Complete sign-in in the browser, then return here.",
        startedAt: new Date().toISOString(),
        completedAt: "",
        redirectUri,
    };
    entry.authProcess = authProcess;

    const complete = (status, output, extra = {}) => {
        authProcess.status = status;
        authProcess.output = output;
        authProcess.completedAt = new Date().toISOString();
        Object.assign(authProcess, extra);
        callbackServer.close(() => {});
    };
    const timeout = setTimeout(() => {
        if (authProcess.status === "running") {
            complete("failed", "Microsoft sign-in timed out. Try again.");
        }
    }, 5 * 60 * 1000);

    callbackServer.on("request", async (req, res) => {
        try {
            const url = new URL(req.url || "/", `http://${AZURE_OAUTH_LOOPBACK_HOST}`);
            if (url.pathname !== "/" && url.pathname !== "/callback") {
                res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
                res.end("Not found");
                return;
            }
            if (url.searchParams.get("state") !== state) {
                throw new CanvasError("azure_devops_oauth_state_mismatch", "Microsoft sign-in returned an unexpected state value.");
            }
            const error = url.searchParams.get("error");
            if (error) {
                throw new CanvasError("azure_devops_oauth_denied", url.searchParams.get("error_description") || error);
            }
            const code = url.searchParams.get("code");
            if (!code) {
                throw new CanvasError("azure_devops_oauth_code_missing", "Microsoft sign-in did not return an authorization code.");
            }
            const tokenResult = await requestMicrosoftToken({
                grant_type: "authorization_code",
                code,
                redirect_uri: redirectUri,
                code_verifier: pkce.verifier,
            });
            // The browser sign-in outlives its request too, so a sign-out during
            // it must not be undone when the user finally completes the flow.
            if (generation !== authGeneration) {
                clearTimeout(timeout);
                res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                res.end("<!doctype html><title>Signed out</title><p>This sign-in was abandoned because the canvas was signed out. This window can be closed.</p>");
                complete("failed", "Sign-in was abandoned because the canvas was signed out.");
                return;
            }
            const cache = await writeBrowserTokenCache(tokenResult);
            clearTimeout(timeout);
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end("<!doctype html><title>Signed in</title><p>Sign-in to Azure DevOps is complete. This window can be closed.</p>");
            complete("succeeded", "Signed in to Azure DevOps with Microsoft.", { expiresAt: cache.expiresAt });
        } catch (error) {
            clearTimeout(timeout);
            const originalMessage = error instanceof CanvasError ? error.message : error?.message || "Microsoft sign-in failed.";
            // Fetch's nested message can contain connection details; expose only a bounded error identifier.
            const causeCode = error?.cause?.code;
            const message = typeof causeCode === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(causeCode)
                ? `${originalMessage} (${causeCode})`
                : originalMessage;
            complete("failed", message, { error: { ...errorPayload(error), message } });
            res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
            res.end("<!doctype html><title>Sign-in failed</title><p>Sign-in failed. Return to the Azure DevOps canvas for details.</p>");
        }
    });

    const authorizeUrl = new URL(`${AZURE_AUTHORITY}/authorize`);
    authorizeUrl.searchParams.set("client_id", AZURE_PUBLIC_CLIENT_ID);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("response_mode", "query");
    authorizeUrl.searchParams.set("scope", AZURE_DEVOPS_SCOPE);
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("code_challenge", pkce.challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("prompt", "select_account");
    authProcess.authorizationUrl = authorizeUrl.toString();
    openBrowser(authProcess.authorizationUrl);
    return authProcess;
}

async function startAgencyAuth(entry) {
    if (!AGENCY_AUTH_ENABLED) {
        throw new CanvasError(
            "azure_devops_auth_provider_unavailable",
            "The selected sign-in provider is unavailable.",
        );
    }
    if (entry.authProcess?.status === "running") {
        return entry.authProcess;
    }

    const azureAuthDiscovery = managedAzureAuthDiscovery();
    const authProcess = {
        provider: "azureauth",
        status: "running",
        output: "Complete sign-in when prompted.",
        startedAt: new Date().toISOString(),
        completedAt: "",
        azureAuthDiscovery: azureAuthDiscoveryTrace(azureAuthDiscovery),
    };
    entry.authProcess = authProcess;

    const complete = (status, output, extra = {}) => {
        authProcess.status = status;
        authProcess.output = output;
        authProcess.completedAt = new Date().toISOString();
        Object.assign(authProcess, extra);
    };

    // AzureAuth can prompt interactively when its own token cache is cold, which
    // takes as long as the user takes. Resolve before that work finishes so the
    // client sees "running" and polls /api/auth/status, matching the Microsoft
    // provider instead of holding the request open for the whole sign-in.
    const generation = authGeneration;
    void (async () => {
        try {
            const azureAuthPath = azureAuthExecutable(azureAuthDiscovery);
            const accessToken = await acquireAzureAuthToken(azureAuthPath);
            // Sign-out is reachable throughout the prompt, and this work outlives
            // the request that started it. Writing a token or the marker after the
            // user signed out would silently sign them back in, and the marker
            // would keep doing so on every later load.
            if (generation !== authGeneration) {
                complete("failed", "Sign-in was abandoned because the canvas was signed out.");
                return;
            }
            const cache = await writeAzureAuthTokenCache({ accessToken, source: "azureauth" });
            complete("succeeded", "AzureAuth acquired an Azure DevOps token.", {
                expiresAt: cache.expiresAt,
            });
            writeAgencyAuthMarker();
        } catch (error) {
            const message = error instanceof CanvasError ? error.message : error?.message || "AzureAuth sign-in failed.";
            complete("failed", message, { error: errorPayload(error) });
        }
    })();

    return authProcess;
}

async function signOutAuth(entry) {
    // Invalidates any sign-in still in flight, so its result cannot land after
    // this point. Without it an abandoned sign-in repopulates the token cache and
    // recreates the marker, undoing the sign-out with no signal to the user.
    authGeneration += 1;
    // Clearing the marker is what makes sign-out stick. Leaving it would let the
    // next canvas load silently re-acquire a token and sign the user straight
    // back in, which reads as the sign-out button not working.
    clearAgencyAuthMarker();
    const [clearedBrowserTokenCache, clearedAzureAuthTokenCache] = await Promise.all([
        clearBrowserTokenCache(),
        clearAzureAuthTokenCache(),
    ]);
    const clearedConnectionPreference = savePreference(() => clearConnectionPreference());
    const authProcess = {
        provider: "canvas",
        status: "succeeded",
        output: "Signed out.",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        clearedBrowserTokenCache,
        clearedAzureAuthTokenCache,
        clearedConnectionPreference,
    };
    entry.authProcess = authProcess;

    return authProcess;
}

// Explicit work item links take precedence over saved organization selections.
async function getEffectiveConfig(overrides = {}) {
    const { connections } = await getConnectionState(overrides);
    const connection = connections[0] || null;
    return {
        organization: connection?.organization || "",
        project: normalizeString(overrides.project) || connection?.project || "",
        apiVersion: DEFAULT_API_VERSION,
        connection,
    };
}

async function getConnectionState(input = {}) {
    const record = readConnectionPreference();
    return {
        connections: resolveConnections({ input: resolveWorkItemReference(input) || input, record }),
        record,
    };
}

// A request names the connection it is for and that name is verified here, so a
// crafted request cannot reach an organization the canvas never resolved.
async function requireConnection(input, selector) {
    const { connections } = await getConnectionState(input);
    const connection = selectConnection(connections, selector);
    if (!connection) {
        throw new CanvasError(
            "azure_devops_unknown_connection",
            "The request named an Azure DevOps organization this canvas is not connected to.",
        );
    }
    return connection;
}

// Overrides that pin a request to one connection. Project is stated explicitly
// even when empty so a connection without one cannot silently inherit a project
// from the canvas input.
function connectionOverrides(connection) {
    return {
        organization: connection.organization,
        project: connection.project,
    };
}


function parseOrganization(value) {
    const organization = normalizeString(value);
    if (!organization) {
        throw new CanvasError(
            "azure_devops_missing_organization",
            "Choose an Azure DevOps organization.",
        );
    }

    if (/^https?:\/\//i.test(organization)) {
        const url = new URL(organization);
        const hostname = url.hostname.toLowerCase();
        if (hostname === "dev.azure.com") {
            const [org] = url.pathname.split("/").filter(Boolean);
            if (!org) {
                throw new CanvasError("azure_devops_invalid_organization", "Organization URL must include the organization name.");
            }
            return { org, baseUrl: `${url.protocol}//${url.hostname}/${encodeURIComponent(org)}` };
        }
        if (hostname.endsWith(".visualstudio.com")) {
            const org = url.hostname.slice(0, -".visualstudio.com".length);
            return { org, baseUrl: `https://${org}.visualstudio.com` };
        }
        throw new CanvasError("azure_devops_invalid_organization", "Organization URL must use dev.azure.com or *.visualstudio.com.");
    }

    return { org: organization, baseUrl: `https://dev.azure.com/${encodeURIComponent(organization)}` };
}

function requireProject(config) {
    const project = normalizeString(config.project);
    if (!project) {
        throw new CanvasError(
            "azure_devops_missing_project",
            "Choose an Azure DevOps project.",
        );
    }
    return project;
}

// `cache` names the cache that supplied the token, so a token Azure DevOps
// rejects can be dropped from the place it came from.
async function getRequestToken() {
    try {
        return { ...(await getBrowserOAuthAccessToken()), cache: "browser-oauth" };
    } catch (error) {
        if (!AGENCY_AUTH_ENABLED) {
            throw error;
        }
        return { ...(await getAzureAuthAccessToken()), cache: "azureauth" };
    }
}

function authHeaders(token, extraHeaders = {}) {
    return {
        Accept: "application/json",
        Authorization: `Bearer ${token.accessToken}`,
        // Without this, Azure DevOps answers a token it cannot validate by
        // redirecting to the sign-in page, which ends in a 2xx HTML response that
        // looks like success. With it, the same request fails with a 401.
        "X-TFS-FedAuthRedirect": "Suppress",
        ...extraHeaders,
    };
}

async function makeAuthHeaders(extraHeaders = {}) {
    return authHeaders(await getRequestToken(), extraHeaders);
}

function landedOnSignInPage(response) {
    if (!response.redirected) {
        return false;
    }
    try {
        return new URL(response.url).pathname.toLowerCase() === "/_signin";
    } catch {
        return false;
    }
}

// Drops the token Azure DevOps refused, unless a newer one has replaced it since,
// so the auth state reports signed out and the UI offers sign-in again. Only the
// token is dropped: the AzureAuth marker and connection preference are kept.
function rejectAuthentication(response, token) {
    const claims = parseJwtPayload(token.accessToken) || {};
    const resourceTenant = normalizeString(response.headers?.get?.("x-vss-resourcetenant"));
    void copilotSession?.log?.(
        `Azure DevOps canvas: Azure DevOps rejected the ${token.cache} token `
        + `(status ${response.status}; tid=${normalizeString(claims.tid)}; iss=${normalizeString(claims.iss)}; `
        + `idtyp=${normalizeString(claims.idtyp)}; x-vss-resourcetenant=${resourceTenant}).`,
    ).catch(() => {});
    if (token.cache === "browser-oauth" && browserTokenCache?.accessToken === token.accessToken) {
        browserTokenCache = null;
    }
    if (token.cache === "azureauth" && azureAuthTokenCache?.accessToken === token.accessToken) {
        azureAuthTokenCache = null;
    }
    return new CanvasError("azure_devops_authentication_rejected", "Azure DevOps did not accept the sign-in. Sign in again.");
}

async function readAzureDevOpsJson(response, token) {
    // A valid sign-in outside the organization also gets a 401, but Azure DevOps
    // names that caller in x-vss-userdata. Only an unidentified 401 is a refused token.
    const anonymous = response.status === 401 && !response.headers?.get?.("x-vss-userdata");
    if (anonymous || landedOnSignInPage(response)) {
        throw rejectAuthentication(response, token);
    }
    const text = await response.text();
    let data = {};
    if (text) {
        try {
            data = JSON.parse(text);
        } catch {
            // A successful status with a non-JSON body is the anonymous sign-in
            // page, not data.
            if (response.ok) {
                throw rejectAuthentication(response, token);
            }
            data = { message: text };
        }
    }
    if (!response.ok) {
        const message = data?.message || data?.error?.message || response.statusText || "Azure DevOps request failed.";
        throw new CanvasError("azure_devops_request_failed", `${response.status} ${message}`);
    }
    return data;
}

function buildApiUrl(config, path, params = {}, apiVersion = config.apiVersion || DEFAULT_API_VERSION) {
    const { baseUrl } = parseOrganization(config.organization);
    const url = new URL(path, `${baseUrl}/`);
    url.searchParams.set("api-version", apiVersion);
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== "") {
            url.searchParams.set(key, String(value));
        }
    }
    return url;
}

async function fetchJson(config, path, options = {}) {
    const url = buildApiUrl(config, path, options.params, options.apiVersion);
    const token = await getRequestToken();
    const response = await fetch(url, {
        method: options.method || "GET",
        headers: authHeaders(token, options.headers),
        body: options.body,
    });
    return readAzureDevOpsJson(response, token);
}

async function fetchImageDataUri(config, path, options = {}) {
    const url = buildApiUrl(config, path, options.params, options.apiVersion);
    const response = await fetch(url, {
        headers: await makeAuthHeaders({
            Accept: "image/svg+xml,image/png",
            ...options.headers,
        }),
    });
    if (!response.ok) {
        throw new CanvasError(
            "azure_devops_request_failed",
            `${response.status} ${response.statusText || "Azure DevOps icon request failed."}`,
        );
    }
    const contentType = normalizeString(response.headers.get("content-type")).split(";")[0].toLowerCase();
    if (!["image/svg+xml", "image/png"].includes(contentType)) {
        throw new CanvasError("azure_devops_invalid_icon", "Azure DevOps returned an unsupported work item icon.");
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > 128 * 1024) {
        throw new CanvasError("azure_devops_invalid_icon", "Azure DevOps returned an empty or oversized work item icon.");
    }
    return `data:${contentType};base64,${bytes.toString("base64")}`;
}

// Query parameters the Azure DevOps profile image endpoints actually use. The
// rebuilt URL carries these and nothing else, so a caller cannot append its own.
const AVATAR_QUERY_PARAMETERS = ["id", "size"];

// The two profile image endpoints, spelled canonically. The rebuilt URL uses
// these literals rather than the caller's path, so the casing and shape of what
// is requested come from here rather than from the value being validated.
const COMMON_IDENTITY_SEGMENTS = "/_api/_common/identityImage";
const GRAPH_PROFILE_SEGMENTS = "/_apis/GraphProfile/MemberAvatars/";

// Azure DevOps member descriptors are an identifier plus a base64url payload.
const AVATAR_DESCRIPTOR = /^[A-Za-z0-9._~-]+$/;
const ATTACHMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validates an avatar or work-item attachment URL and rebuilds it from trusted parts.
 *
 * The value arrives from a query parameter on the local canvas server, so
 * everything about it is caller-controlled. Checking it and then fetching the
 * URL that was checked would still send the caller's own origin, port, userinfo,
 * query, and fragment -- the check proves the origin and path are ours, not that
 * the rest of the URL is. So nothing from the parsed value is forwarded: the
 * organization's own origin and a literal endpoint path are used instead, and
 * the only caller-supplied pieces that survive are validated identifiers and a
 * fixed list of query parameters, each URL-encoded on the way in.
 *
 * @param {object} config effective canvas configuration
 * @param {string} value candidate image URL
 * @param {"avatar" | "attachment"} kind permitted endpoint and response bounds
 * @returns {URL}
 */
function validateImageUrl(config, value, kind) {
    const attachment = kind === "attachment";
    const label = attachment ? "Attachment" : "Profile image";
    const invalid = (message) => new CanvasError(`azure_devops_invalid_${kind}_url`, message);
    let candidate;
    try {
        candidate = new URL(normalizeString(value));
    } catch {
        throw invalid(`Azure DevOps returned an invalid ${label.toLowerCase()} URL.`);
    }
    const organizationUrl = new URL(`${parseOrganization(config.organization).baseUrl}/`);
    const organizationPath = organizationUrl.pathname.replace(/\/$/, "");
    const candidatePath = candidate.pathname.toLowerCase();
    const commonIdentityPath = `${organizationPath}${COMMON_IDENTITY_SEGMENTS}`.toLowerCase();
    const graphProfilePath = `${organizationPath}${GRAPH_PROFILE_SEGMENTS}`.toLowerCase();
    if (candidate.protocol !== "https:" || candidate.origin !== organizationUrl.origin) {
        throw invalid(`${label} URL must belong to the configured Azure DevOps organization.`);
    }

    let path;
    let queryParameters = AVATAR_QUERY_PARAMETERS;
    if (attachment) {
        const segments = candidate.pathname.slice(organizationPath.length + 1).split("/");
        const [projectId, api, area, resource, attachmentId] = segments;
        if (
            !candidatePath.startsWith(`${organizationPath}/`.toLowerCase()) ||
            segments.length !== 5 ||
            !ATTACHMENT_ID.test(projectId) ||
            api.toLowerCase() !== "_apis" ||
            area.toLowerCase() !== "wit" ||
            resource.toLowerCase() !== "attachments" ||
            !ATTACHMENT_ID.test(attachmentId)
        ) {
            throw invalid("Attachment URL must point at a project attachment in the configured Azure DevOps organization.");
        }
        path = `${organizationPath}/${projectId}/_apis/wit/attachments/${attachmentId}`;
        queryParameters = ["fileName"];
    } else if (candidatePath === commonIdentityPath) {
        path = `${organizationPath}${COMMON_IDENTITY_SEGMENTS}`;
    } else if (candidatePath.startsWith(graphProfilePath)) {
        // The prefixes are the same length, so slicing the original pathname at
        // the prefix length keeps the descriptor's casing, which is significant.
        const descriptor = candidate.pathname.slice(graphProfilePath.length);
        if (!AVATAR_DESCRIPTOR.test(descriptor)) {
            throw invalid("Azure DevOps returned an invalid profile image identifier.");
        }
        path = `${organizationPath}${GRAPH_PROFILE_SEGMENTS}${encodeURIComponent(descriptor)}`;
    } else {
        throw invalid("Profile image URL must belong to the configured Azure DevOps organization.");
    }

    const query = queryParameters
        .map((name) => {
            const parameter = normalizeString(candidate.searchParams.get(name));
            return parameter ? `${name}=${encodeURIComponent(parameter)}` : "";
        })
        .filter(Boolean)
        .join("&");
    return new URL(`${organizationUrl.origin}${path}${query ? `?${query}` : ""}`);
}

function validateAvatarUrl(config, value) {
    return validateImageUrl(config, value, "avatar");
}

function validateAttachmentUrl(config, value) {
    return validateImageUrl(config, value, "attachment");
}

async function fetchImage(config, value, kind) {
    const imageUrl = validateImageUrl(config, value, kind);
    const label = kind === "attachment" ? "attachment" : "profile image";
    const maxBytes = kind === "attachment" ? 8 * 1024 * 1024 : MAX_AVATAR_BYTES;
    const imageTypes = ["image/png", "image/jpeg", "image/gif", "image/webp"];
    if (kind === "attachment") imageTypes.push("image/bmp");
    const failure = (suffix, message) => new CanvasError(`azure_devops_${kind}_${suffix}`, message);
    const headers = await makeAuthHeaders({ Accept: imageTypes.join(",") });
    let response = await fetch(imageUrl, { headers, redirect: "manual" });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = normalizeString(response.headers.get("location"));
        if (!location) {
            throw failure("failed", `Azure DevOps ${label} redirect was missing a destination.`);
        }
        const redirectUrl = validateImageUrl(config, new URL(location, imageUrl).href, kind);
        response = await fetch(redirectUrl, { headers, redirect: "manual" });
    }
    if (!response.ok) {
        throw failure("failed", `Azure DevOps ${label} request failed with ${response.status}.`);
    }
    const contentType = normalizeString(response.headers.get("content-type")).split(";")[0].toLowerCase();
    if (!imageTypes.includes(contentType)) {
        throw failure("invalid_type", `Azure DevOps returned an unsupported ${label} type.`);
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        await response.body?.cancel();
        throw failure("too_large", `Azure DevOps ${label} exceeded the size limit.`);
    }
    const chunks = [];
    let receivedBytes = 0;
    if (response.body) {
        const reader = response.body.getReader();
        while (true) {
            const { done, value: chunk } = await reader.read();
            if (done) {
                break;
            }
            receivedBytes += chunk.byteLength;
            if (receivedBytes > maxBytes) {
                await reader.cancel();
                throw failure("too_large", `Azure DevOps ${label} exceeded the size limit.`);
            }
            chunks.push(Buffer.from(chunk));
        }
    }
    const content = Buffer.concat(chunks, receivedBytes);
    return { content, contentType };
}

async function fetchAvatar(config, value) {
    return fetchImage(config, value, "avatar");
}

async function fetchAttachment(config, value) {
    return fetchImage(config, value, "attachment");
}

function canvasTitle(input = {}) {
    try {
        const workItemReference = hasWorkItemReference(input) ? resolveWorkItemReference(input) : null;
        if (workItemReference) {
            return `ADO Work Item ${workItemReference.id}`;
        }
        return "Azure DevOps";
    } catch {
        return "Azure DevOps";
    }
}

function wiqlString(value) {
    return `'${normalizeString(value).replaceAll("'", "''")}'`;
}

// Terminal states are per work item type and per project, because a project's
// process decides both. Extracted into data rather than straight into a WIQL
// clause because the organization-scope query cannot express this filter in
// WIQL at all: with no project in the route there is no single process to read
// types from, so those results are filtered after they come back instead.
function terminalWorkItemStates(workItemTypes) {
    const types = [];
    for (const workItemType of workItemTypes || []) {
        const typeName = normalizeString(workItemType?.name);
        if (!typeName) {
            continue;
        }
        const terminalStates = [...new Set((workItemType?.states || [])
            .filter((state) => TERMINAL_WORK_ITEM_STATE_CATEGORIES.has(normalizeString(state?.category).toLowerCase()))
            .map((state) => normalizeString(state?.name))
            .filter(Boolean))];
        // A type with no terminal states makes the whole filter unsound: it would
        // silently keep every item of that type regardless of state.
        if (!terminalStates.length) {
            return { types: [], complete: false };
        }
        types.push({ name: typeName, terminalStates });
    }
    return { types, complete: true };
}

function isTerminalWorkItem(states, workItem) {
    const type = normalizeString(workItem?.type).toLowerCase();
    const state = normalizeString(workItem?.state).toLowerCase();
    const match = (states?.types || []).find((entry) => entry.name.toLowerCase() === type);
    return Boolean(match?.terminalStates.some((terminal) => terminal.toLowerCase() === state));
}

function terminalWorkItemStateFilter(workItemTypes) {
    const { types, complete } = terminalWorkItemStates(workItemTypes);
    if (!complete) {
        return "";
    }
    const clauses = types.map((entry) =>
        `([System.WorkItemType] <> ${wiqlString(entry.name)} OR [System.State] NOT IN (${entry.terminalStates.map(wiqlString).join(", ")}))`);
    return clauses.length ? `AND (${clauses.join(" AND ")})` : "";
}

async function getWorkItemTypeList(config, project) {
    const { baseUrl } = parseOrganization(config.organization);
    const cacheKey = `${baseUrl.toLowerCase()}\n${normalizeString(project).toLowerCase()}`;
    let definitionsPromise = workItemTypeDefinitionCache.get(cacheKey);
    if (!definitionsPromise) {
        definitionsPromise = fetchJson(
            config,
            `${encodeURIComponent(project)}/_apis/wit/workitemtypes`,
        ).then((result) => result.value || []);
        workItemTypeDefinitionCache.set(cacheKey, definitionsPromise);
    }
    try {
        return await definitionsPromise;
    } catch (error) {
        if (workItemTypeDefinitionCache.get(cacheKey) === definitionsPromise) {
            workItemTypeDefinitionCache.delete(cacheKey);
        }
        throw error;
    }
}

async function getWorkItemTypeDefinitions(config, project) {
    const workItemTypes = await getWorkItemTypeList(config, project);
    return Promise.all(workItemTypes.map(async (workItemType) => {
        if (Array.isArray(workItemType?.states) && workItemType.states.length) {
            return workItemType;
        }

        const typeName = normalizeString(workItemType?.name);
        return typeName
            ? fetchJson(
                config,
                `${encodeURIComponent(project)}/_apis/wit/workitemtypes/${encodeURIComponent(typeName)}`,
            )
            : workItemType;
    }));
}

async function getWorkItemTypeAppearances(config, project) {
    const { baseUrl } = parseOrganization(config.organization);
    const cacheKey = `${baseUrl.toLowerCase()}\n${normalizeString(project).toLowerCase()}`;
    let appearancesPromise = workItemTypeAppearanceCache.get(cacheKey);
    if (!appearancesPromise) {
        appearancesPromise = getWorkItemTypeList(config, project)
            .then((definitions) => new Map(definitions
            .map((definition) => [normalizeString(definition?.name).toLowerCase(), definition])
            .filter(([name]) => name)));
        workItemTypeAppearanceCache.set(cacheKey, appearancesPromise);
    }
    try {
        return await appearancesPromise;
    } catch (error) {
        workItemTypeAppearanceCache.delete(cacheKey);
        throw error;
    }
}

function drainWorkItemTypeIconQueue() {
    while (
        activeWorkItemTypeIconRequests < WORK_ITEM_TYPE_ICON_CONCURRENCY
        && workItemTypeIconQueue.length
    ) {
        const { run, resolve, reject } = workItemTypeIconQueue.shift();
        activeWorkItemTypeIconRequests += 1;
        Promise.resolve()
            .then(run)
            .then(resolve, reject)
            .finally(() => {
                activeWorkItemTypeIconRequests -= 1;
                drainWorkItemTypeIconQueue();
            });
    }
}

function scheduleWorkItemTypeIcon(run) {
    return new Promise((resolve, reject) => {
        workItemTypeIconQueue.push({ run, resolve, reject });
        drainWorkItemTypeIconQueue();
    });
}

async function getWorkItemTypeIconData(config, appearances, typeNames) {
    const requested = [...new Set(typeNames.map((name) => normalizeString(name).toLowerCase()).filter(Boolean))];
    const entries = await Promise.all(requested.map(async (name) => {
        const definition = appearances.get(name);
        const iconId = normalizeString(definition?.icon?.id);
        const color = normalizeString(definition?.color).replace(/^#/, "");
        if (!/^icon_[a-z0-9_]+$/i.test(iconId) || !/^[0-9a-f]{6}$/i.test(color)) {
            return null;
        }
        const cacheKey = [
            parseOrganization(config.organization).baseUrl.toLowerCase(),
            iconId.toLowerCase(),
            color.toLowerCase(),
        ].join("|");
        let iconPromise = workItemTypeIconCache.get(cacheKey);
        if (!iconPromise) {
            iconPromise = scheduleWorkItemTypeIcon(() => fetchImageDataUri(
                config,
                `_apis/wit/workItemIcons/${encodeURIComponent(iconId)}`,
                { params: { color, v: 2 } },
            ));
            if (workItemTypeIconCache.size >= WORK_ITEM_TYPE_ICON_CACHE_LIMIT) {
                workItemTypeIconCache.delete(workItemTypeIconCache.keys().next().value);
            }
            workItemTypeIconCache.set(cacheKey, iconPromise);
        }
        try {
            return [name, await iconPromise];
        } catch (error) {
            if (workItemTypeIconCache.get(cacheKey) === iconPromise) {
                workItemTypeIconCache.delete(cacheKey);
            }
            void copilotSession?.log?.(
                `Could not load the ${normalizeString(definition?.name) || name} work-item type icon: ${error?.message || "unknown error"}`,
            ).catch(() => {});
            return null;
        }
    }));
    return new Map(entries.filter(Boolean));
}

async function mapWorkItemSummaries(config, project, workItems) {
    let appearances = new Map();
    try {
        appearances = await getWorkItemTypeAppearances(config, project);
    } catch (error) {
        if (error?.code === "azure_devops_authentication_rejected") {
            throw error;
        }
        void copilotSession?.log?.(
            `Could not load Azure DevOps work-item type colors: ${error?.message || "unknown error"}`,
        ).catch(() => {});
    }
    const types = workItems.map((workItem) => workItem?.fields?.["System.WorkItemType"]);
    const icons = await getWorkItemTypeIconData(config, appearances, types);
    return workItems.map((workItem) => {
        const type = normalizeString(workItem?.fields?.["System.WorkItemType"]).toLowerCase();
        return {
            ...mapWorkItem(workItem, appearances.get(type)),
            typeIcon: icons.get(type) || "",
        };
    });
}

async function mapWorkItemSummariesByProject(config, workItems) {
    const groups = new Map();
    for (const workItem of workItems) {
        const project = normalizeString(workItem?.fields?.["System.TeamProject"]);
        if (!project) continue;
        groups.set(project, [...(groups.get(project) || []), workItem]);
    }
    const mappedGroups = await Promise.all([...groups].map(async ([project, items]) =>
        mapWorkItemSummaries(config, project, items)));
    const byId = new Map(mappedGroups.flat().map((item) => [Number(item.id), item]));
    return workItems.map((item) => byId.get(Number(item.id)) || mapWorkItem(item));
}

async function getTerminalWorkItemStates(config, project) {
    const { baseUrl } = parseOrganization(config.organization);
    const cacheKey = `${baseUrl.toLowerCase()}\n${normalizeString(project).toLowerCase()}`;
    let statesPromise = workItemStateFilterCache.get(cacheKey);
    if (!statesPromise) {
        statesPromise = getWorkItemTypeDefinitions(config, project).then((workItemTypes) => {
            const states = terminalWorkItemStates(workItemTypes);
            if (!states.complete || !states.types.length) {
                throw new CanvasError(
                    "azure_devops_work_item_states_unavailable",
                    "Azure DevOps returned no completed or removed work item states for this project.",
                );
            }
            return states;
        });
        workItemStateFilterCache.set(cacheKey, statesPromise);
    }
    try {
        return await statesPromise;
    } catch (error) {
        if (workItemStateFilterCache.get(cacheKey) === statesPromise) {
            workItemStateFilterCache.delete(cacheKey);
        }
        throw error;
    }
}

async function getTerminalWorkItemStateFilter(config, project) {
    const states = await getTerminalWorkItemStates(config, project);
    const clauses = states.types.map((entry) =>
        `([System.WorkItemType] <> ${wiqlString(entry.name)} OR [System.State] NOT IN (${entry.terminalStates.map(wiqlString).join(", ")}))`);
    return `AND (${clauses.join(" AND ")})`;
}

// The batch endpoint that hydrates work item ids is a set fetch with no ordering
// contract, so the WIQL ORDER BY does not survive it. Both query paths sort here
// instead: the organization-scope one because it truncates a wide candidate
// window and would otherwise keep the wrong items, and the project-scoped one
// because Home renders the list in order and shows each row's age.
function byMostRecentlyChanged(workItems) {
    const changedAt = (item) => {
        const parsed = Date.parse(normalizeString(item?.changedDate));
        return Number.isFinite(parsed) ? parsed : 0;
    };
    return [...workItems].sort((left, right) => changedAt(right) - changedAt(left));
}

// Organization-scope work items cannot be filtered in the query itself: the
// terminal-state filter needs work item type definitions, and those are only
// available per project. So the query asks for a wider window ordered by most
// recently changed, and the open items are picked out of it afterwards using
// the definitions of just the projects that actually appear in the results —
// usually a handful, and each one cached after the first look.
//
// The window is a real limit: a user with more than ORG_WORK_ITEM_CANDIDATE_LIMIT
// recently-changed closed items could see fewer than `top` open ones. Selecting a
// project turns this back into the exact project-scoped query.
async function filterOpenWorkItems(config, workItems, top) {
    const projects = [...new Set(workItems.map((item) => normalizeString(item.project)).filter(Boolean))];
    const states = new Map();
    await Promise.all(projects.map(async (project) => {
        try {
            states.set(project.toLowerCase(), await getTerminalWorkItemStates(config, project));
        } catch (error) {
            if (error?.code === "azure_devops_authentication_rejected") {
                throw error;
            }
            // A project whose definitions cannot be read is left unfiltered rather
            // than dropped: showing a closed item is a smaller failure than hiding
            // an open one.
        }
    }));
    const open = workItems.filter((item) => {
        const projectStates = states.get(normalizeString(item.project).toLowerCase());
        return !projectStates || !isTerminalWorkItem(projectStates, item);
    });
    return byMostRecentlyChanged(open).slice(0, top);
}

async function queryMyOpenWorkItems(overrides = {}) {
    const config = await getEffectiveConfig(overrides);
    const top = Math.max(1, Math.min(Number(overrides.top || HOME_LIST_LIMIT), 50));
    const project = normalizeString(config.project);
    return project
        ? queryMyOpenProjectWorkItems(config, project, top)
        : queryMyOpenOrganizationWorkItems(config, top);
}

async function queryMyOpenOrganizationWorkItems(config, top) {
    const candidateLimit = Math.min(ORG_WORK_ITEM_CANDIDATE_LIMIT, Math.max(top * 5, top));
    const query = [
        "SELECT [System.Id], [System.Title], [System.State], [System.WorkItemType], [System.AssignedTo], [System.ChangedDate]",
        "FROM WorkItems",
        "WHERE [System.AssignedTo] = @Me",
        "ORDER BY [System.ChangedDate] DESC",
    ].join(" ");
    const queryResult = await fetchJson(config, "_apis/wit/wiql", {
        method: "POST",
        params: { $top: candidateLimit },
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
    });
    const ids = (queryResult.workItems || []).map((item) => item.id).slice(0, candidateLimit);
    if (!ids.length) {
        return { workItems: [], count: 0 };
    }
    const details = await fetchJson(config, "_apis/wit/workitems", {
        params: {
            ids: ids.join(","),
            fields: [
                "System.Id",
                "System.WorkItemType",
                "System.Title",
                "System.State",
                "System.AssignedTo",
                "System.ChangedDate",
                "System.TeamProject",
            ].join(","),
        },
    });
    const detailsById = new Map((details.value || []).map((item) => [Number(item.id), item]));
    const open = await filterOpenWorkItems(config, (details.value || []).map(mapWorkItem), top);
    const selected = open.map((item) => detailsById.get(Number(item.id))).filter(Boolean);
    const workItems = await mapWorkItemSummariesByProject(config, selected);
    return { workItems, count: workItems.length };
}

async function queryMyOpenProjectWorkItems(config, project, top) {
    const stateFilter = await getTerminalWorkItemStateFilter(config, project);
    const query = [
        "SELECT [System.Id], [System.Title], [System.State], [System.WorkItemType], [System.AssignedTo], [System.ChangedDate]",
        "FROM WorkItems",
        // Azure DevOps does not reliably constrain WIQL WorkItems queries to the
        // project named in the route, so include the project in the predicate.
        `WHERE [System.AssignedTo] = @Me AND [System.TeamProject] = ${wiqlString(project)} ${stateFilter}`,
        "ORDER BY [System.ChangedDate] DESC",
    ].join(" ");
    const queryResult = await fetchJson(config, `${encodeURIComponent(project)}/_apis/wit/wiql`, {
        method: "POST",
        params: { $top: top },
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
    });
    const ids = (queryResult.workItems || []).map((item) => item.id).slice(0, top);
    if (!ids.length) {
        return { workItems: [], count: 0 };
    }
    const details = await fetchJson(config, `${encodeURIComponent(project)}/_apis/wit/workitems`, {
        params: {
            ids: ids.join(","),
            // No System.TeamProject: every row here is from the one project the
            // connection is scoped to, and Home only shows a project when the
            // section spans more than one.
            fields: [
                "System.Id",
                "System.WorkItemType",
                "System.Title",
                "System.State",
                "System.AssignedTo",
                "System.ChangedDate",
            ].join(","),
        },
    });
    const workItems = byMostRecentlyChanged(await mapWorkItemSummaries(config, project, details.value || []));
    return { workItems, count: workItems.length };
}

function favoriteBoardLink(favorite) {
    return normalizeString(
        favorite?._links?.page?.href
        || favorite?._links?.web?.href
        || favorite?.artifactProperties?.url
        || favorite?.url,
    );
}

function mapFavoriteBoard(favorite, config) {
    const href = favoriteBoardLink(favorite);
    if (!href) {
        return null;
    }
    const parsedOrganization = parseOrganization(config.organization);
    let url;
    try {
        url = new URL(href, `${parsedOrganization.baseUrl}/`);
    } catch {
        return null;
    }
    const expected = new URL(`${parsedOrganization.baseUrl}/`);
    if (url.origin.toLowerCase() !== expected.origin.toLowerCase()) {
        return null;
    }
    let parts;
    let expectedPrefix;
    try {
        parts = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
        expectedPrefix = expected.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
    } catch {
        return null;
    }
    if (!expectedPrefix.every((part, index) => part.toLowerCase() === parts[index]?.toLowerCase())) {
        return null;
    }
    const projectIndex = expectedPrefix.length;
    const boardIndex = parts.findIndex((part) => part.toLowerCase() === "_boards");
    const teamIndex = parts.findIndex((part) => part.toLowerCase() === "t");
    if (boardIndex !== projectIndex + 1 || teamIndex < 0 || teamIndex + 1 >= parts.length) {
        return null;
    }
    const project = parts[projectIndex] || "";
    if (!project || project.toLowerCase() !== normalizeString(config.project).toLowerCase()) {
        return null;
    }
    const team = parts[teamIndex + 1] || "";
    const boardId = parts[teamIndex + 2] || "";
    if (!team) {
        return null;
    }
    return {
        id: normalizeString(favorite?.id) || normalizeString(favorite?.artifactId) || href,
        artifactId: normalizeString(favorite?.artifactId),
        name: normalizeString(favorite?.artifactName) || boardId || team,
        organization: config.organization,
        project: config.project,
        team,
        boardId,
        backlogLevel: boardId,
        url: url.toString(),
    };
}

async function listFavoriteBoards(overrides = {}) {
    const config = await getEffectiveConfig(overrides);
    const project = normalizeString(config.project);
    if (!project) {
        return { boards: [], count: 0, requiresProject: true };
    }
    const loadFavorites = (artifactType = "") => fetchJson(config, "_apis/favorite/favorites", {
        apiVersion: "7.1-preview.1",
        params: {
            artifactType,
            artifactScopeType: "Project",
            includeExtendedDetails: true,
        },
    });
    const mapBoards = (favorites) => (favorites || [])
        .filter((favorite) => !favorite?.artifactIsDeleted)
        .filter((favorite) => {
            const scope = favorite?.artifactScope || {};
            return !scope.name || normalizeString(scope.name).toLowerCase() === project.toLowerCase();
        })
        .map((favorite) => mapFavoriteBoard(favorite, config))
        .filter(Boolean)
        .sort((left, right) => left.name.localeCompare(right.name));
    const typed = await loadFavorites(FAVORITE_BOARD_ARTIFACT_TYPE);
    let boards = mapBoards(typed.value);
    let otherProjectBoardCount = 0;
    if (!boards.length) {
        const allProjectFavorites = await loadFavorites();
        boards = mapBoards(allProjectFavorites.value);
        const boardLinkFavorites = (allProjectFavorites.value || []).filter((favorite) =>
            favoriteBoardLink(favorite).toLowerCase().includes("/_boards/"));
        const boardLinkCount = boardLinkFavorites.length;
        otherProjectBoardCount = Math.max(0, boardLinkCount - boards.length);
    }
    return { boards, count: boards.length, otherProjectBoardCount, requiresProject: false };
}

function boardApiPath(target, suffix) {
    return `${encodeURIComponent(target.project)}/${encodeURIComponent(target.team)}/_apis/work/${suffix}`;
}

function boardWorkItemPath(target, id = "") {
    const suffix = id ? `/${encodeURIComponent(id)}` : "";
    return `${encodeURIComponent(target.project)}/_apis/wit/workitems${suffix}`;
}

function boardReferencePriority(board) {
    const name = normalizeString(board?.name).toLowerCase();
    const tokens = new Set(name.split(/[^a-z0-9]+/).filter(Boolean));
    const hasToken = (...values) => values.some((value) => tokens.has(value));
    if (["stories", "backlog items", "requirements"].includes(name)) {
        return 0;
    }
    if (hasToken("story", "stories", "backlog", "requirement", "requirements")) {
        return 1;
    }
    if (!hasToken("epic", "epics", "feature", "features", "task", "tasks")) {
        return 2;
    }
    if (hasToken("task", "tasks")) {
        return 3;
    }
    if (hasToken("feature", "features")) {
        return 4;
    }
    return 5;
}

async function fetchBoardMetadata(config, target) {
    let boardId = normalizeString(target.boardId);
    if (!boardId) {
        const data = await fetchJson(config, boardApiPath(target, "boards"));
        const references = [...(data.value || [])].filter((board) => board?.id || board?.name);
        references.sort((left, right) =>
            boardReferencePriority(left) - boardReferencePriority(right)
            || normalizeString(left?.name).localeCompare(normalizeString(right?.name)));
        boardId = normalizeString(references[0]?.id) || normalizeString(references[0]?.name);
    }
    if (!boardId) {
        throw new CanvasError("azure_devops_board_unavailable", "Azure DevOps returned no boards for this team.");
    }
    return fetchJson(config, boardApiPath(target, `boards/${encodeURIComponent(boardId)}`));
}

async function fetchBoardWorkItems(config, target) {
    const backlogResults = await Promise.allSettled(
        BOARD_BACKLOG_CATEGORY_IDS.map((backlogId) => fetchJson(
            config,
            boardApiPath(target, `backlogs/${encodeURIComponent(backlogId)}/workItems`),
        )),
    );
    const fulfilled = backlogResults.filter((result) => result.status === "fulfilled");
    if (!fulfilled.length) {
        throw backlogResults[0]?.reason || new Error("Azure DevOps could not read this board's backlog.");
    }
    const ids = [...new Set(fulfilled.flatMap((result) =>
        (result.value?.workItems || [])
            .map((item) => item?.target?.id ?? item?.id)
            .filter((id) => Number.isInteger(Number(id)))
            .map(Number),
    ))];
    if (!ids.length) {
        return [];
    }
    const items = [];
    for (let index = 0; index < ids.length; index += 200) {
        const data = await fetchJson(config, `${encodeURIComponent(target.project)}/_apis/wit/workitemsbatch`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                ids: ids.slice(index, index + 200),
                fields: BOARD_CARD_FIELDS,
            }),
        });
        items.push(...(data.value || []));
    }
    return items;
}

async function createBoardDataProvider(overrides, target) {
    const config = await getEffectiveConfig({
        ...overrides,
        organization: target.organization,
        project: target.project,
    });
    const scopedTarget = {
        ...target,
        org: config.organization,
        project: config.project,
    };
    return {
        name: "canvas-rest",
        label: "Azure DevOps canvas",
        async fetchAllItems() {
            const [board, items] = await Promise.all([
                fetchBoardMetadata(config, scopedTarget),
                fetchBoardWorkItems(config, scopedTarget),
            ]);
            return {
                items,
                columns: (board.columns || []).map((column) => ({
                    name: normalizeString(column?.name),
                    mappings: column?.stateMappings || {},
                    columnType: column?.columnType || null,
                })).filter((column) => column.name),
            };
        },
        async fetchItemDetail(id, { includeComments = true } = {}) {
            const itemPromise = fetchJson(config, boardWorkItemPath(scopedTarget, id), {
                params: includeComments ? { $expand: "All" } : { fields: BOARD_CARD_FIELDS.join(",") },
            });
            const commentsPromise = includeComments
                ? fetchJson(
                    config,
                    `${encodeURIComponent(scopedTarget.project)}/_apis/wit/workItems/${encodeURIComponent(id)}/comments`,
                    { apiVersion: "7.1-preview.4", params: { $top: 50 } },
                ).catch(() => ({ comments: [] }))
                : Promise.resolve({ comments: [] });
            const [item, comments] = await Promise.all([itemPromise, commentsPromise]);
            return {
                ok: true,
                item,
                comments: comments.comments || comments.value || [],
                browseUrl: item?._links?.html?.href || `${target.url.split("/_boards/")[0]}/_workitems/edit/${id}`,
            };
        },
        async getWorkItem(id) {
            return fetchJson(config, boardWorkItemPath(scopedTarget, id), {
                params: { fields: BOARD_CARD_FIELDS.join(",") },
            });
        },
        async getWorkItemType(workItemType) {
            return fetchJson(
                config,
                `${encodeURIComponent(scopedTarget.project)}/_apis/wit/workitemtypes/${encodeURIComponent(workItemType)}`,
            );
        },
        async fetchWorkItemTypeIcons(typeNames = []) {
            const appearances = await getWorkItemTypeAppearances(config, scopedTarget.project);
            const icons = await getWorkItemTypeIconData(config, appearances, typeNames);
            return Object.fromEntries(typeNames
                .map((name) => [normalizeString(name), icons.get(normalizeString(name).toLowerCase())])
                .filter(([, icon]) => icon));
        },
        async updateItemState(id, state) {
            const item = await fetchJson(config, boardWorkItemPath(scopedTarget, id), {
                method: "PATCH",
                headers: { "Content-Type": "application/json-patch+json" },
                body: JSON.stringify([{ op: "replace", path: "/fields/System.State", value: state }]),
            });
            return { ok: true, state: item?.fields?.["System.State"] || state };
        },
        async addItemComment(id, text) {
            const comment = await fetchJson(
                config,
                `${encodeURIComponent(scopedTarget.project)}/_apis/wit/workItems/${encodeURIComponent(id)}/comments`,
                {
                    method: "POST",
                    apiVersion: "7.1-preview.4",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ text }),
                },
            );
            return { ok: true, comment };
        },
        async createWorkItem(type, title, state) {
            const patch = [{ op: "add", path: "/fields/System.Title", value: title }];
            if (state) {
                patch.push({ op: "add", path: "/fields/System.State", value: state });
            }
            const item = await fetchJson(
                config,
                `${encodeURIComponent(scopedTarget.project)}/_apis/wit/workitems/$${encodeURIComponent(type)}`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json-patch+json" },
                    body: JSON.stringify(patch),
                },
            );
            return { ok: true, item };
        },
    };
}

function homeSection(result, fallback) {
    if (result.status === "fulfilled") {
        return { ...fallback, ...result.value, error: "" };
    }
    if (result.reason?.code === "azure_devops_authentication_rejected") {
        throw result.reason;
    }
    return {
        ...fallback,
        error: normalizeString(result.reason?.message) || "Azure DevOps request failed.",
    };
}

// Each connection loads independently so one unavailable organization can retain
// the other connection's Boards and work item results.
async function getConnectionOverview(connection, overrides = {}) {
    const scoped = { ...overrides, ...connectionOverrides(connection) };
    const config = await getEffectiveConfig(scoped);
    const project = normalizeString(config.project);
    const top = Math.max(1, Math.min(Number(overrides.top || HOME_LIST_LIMIT), 50));
    const [boardResult, workItemResult] = await Promise.allSettled([
        overrides.featureFlags?.boards && project
            ? listFavoriteBoards(scoped)
            : Promise.resolve({ boards: [], count: 0, requiresProject: true }),
        queryMyOpenWorkItems({ ...scoped, top }),
    ]);
    return {
        source: connection.source,
        isDefault: Boolean(connection.isDefault),
        requiresProject: !project,
        organization: config.organization,
        project,
        myBoards: {
            ...homeSection(boardResult, { boards: [], count: 0 }),
            scope: project,
        },
        myWorkItems: {
            ...homeSection(workItemResult, { workItems: [], count: 0 }),
            scope: project || config.organization,
        },
    };
}

async function getHomeOverview(overrides = {}) {
    const { connections } = await getConnectionState(overrides);
    if (!connections.length) {
        throw new CanvasError(
            "azure_devops_missing_organization",
            "Choose an Azure DevOps organization.",
        );
    }
    const overviews = await Promise.all(
        connections.map((connection) => getConnectionOverview(connection, overrides)),
    );
    return {
        connections: overviews,
        // The first connection's identity, kept flat for callers that only ever
        // dealt with one: the extension actions and the canvas title.
        organization: overviews[0].organization,
        project: overviews[0].project,
    };
}

async function getWorkItem(overrides = {}) {
    const config = await getEffectiveConfig(overrides);
    const id = Number(overrides.id);
    if (!Number.isInteger(id) || id <= 0) {
        throw new CanvasError("azure_devops_invalid_work_item_id", "Work item id must be a positive integer.");
    }
    // Azure DevOps answers a single work item at organization scope, so a
    // connection without a project can still open one.
    const project = normalizeString(config.project);
    const item = await fetchJson(config, project
        ? `${encodeURIComponent(project)}/_apis/wit/workitems/${id}`
        : `_apis/wit/workitems/${id}`, {
        // Azure DevOps rejects a fields projection together with $expand. This
        // read needs relations, so accept its full field set.
        params: { $expand: "Relations" },
    });
    return { workItem: mapWorkItem(item), raw: item };
}

const WORK_ITEM_SUMMARY_FIELDS = [
    "System.Id",
    "System.WorkItemType",
    "System.Title",
    "System.State",
    "System.AssignedTo",
    "System.ChangedDate",
    "System.TeamProject",
];

async function fetchWorkItemsByIds(
    config,
    project,
    ids,
    { expand = "", tolerateFailure = true } = {},
) {
    if (!ids.length) {
        return [];
    }
    const normalizedExpand = normalizeString(expand);
    const items = [];
    for (let index = 0; index < ids.length; index += 200) {
        const batch = ids.slice(index, index + 200);
        const params = {
            ids: batch.join(","),
        };
        if (tolerateFailure) {
            params.errorPolicy = "omit";
        }
        // Azure DevOps rejects fields and $expand in the same request. Summary
        // reads select fields; relation reads expand and accept the full field set.
        if (normalizedExpand && normalizedExpand.toLowerCase() !== "none") {
            params.$expand = normalizedExpand;
        } else {
            params.fields = WORK_ITEM_SUMMARY_FIELDS.join(",");
        }
        try {
            const details = await fetchJson(config, `${encodeURIComponent(project)}/_apis/wit/workitems`, {
                params,
            });
            items.push(...(details.value || []).filter(Boolean));
        } catch (error) {
            if (!tolerateFailure) {
                throw error;
            }
            // Related titles are decoration; retain successful batches when one
            // group cannot be hydrated.
        }
    }
    return items;
}

async function fetchRelatedWorkItems(config, project, ids, { tolerateFailure = true } = {}) {
    const items = await fetchWorkItemsByIds(config, project, ids, { tolerateFailure });
    const mapped = await mapWorkItemSummaries(config, project, items);
    return new Map(mapped.map((item) => [Number(item.id), item]));
}

// A work item reached from an organization-scope list has no project in the
// connection, but its detail view needs one: comments, the type definition, and
// related items are all project-scoped routes. Azure DevOps will return the item
// itself at organization scope, so the project is read off the item and used
// from there.
async function resolveWorkItemProject(config, id) {
    const project = normalizeString(config.project);
    if (project) {
        return project;
    }
    parseOrganization(config.organization);
    const item = await fetchJson(config, `_apis/wit/workitems/${id}`, {
        params: { fields: "System.TeamProject" },
    });
    const resolved = normalizeString(item?.fields?.["System.TeamProject"]);
    if (!resolved) {
        throw new CanvasError(
            "azure_devops_missing_project",
            "Choose an Azure DevOps project.",
        );
    }
    return resolved;
}

async function getWorkItemDetails(overrides = {}) {
    const reference = resolveWorkItemReference(overrides);
    if (!reference) {
        throw new CanvasError(
            "azure_devops_invalid_work_item_reference",
            "Provide a work item URL or an organization, project, and positive work item ID.",
        );
    }
    const config = await getEffectiveConfig({
        ...overrides,
        organization: reference.organization,
        project: reference.project,
    });
    const project = await resolveWorkItemProject(config, reference.id);
    const [item, commentResult] = await Promise.all([
        fetchJson(config, `${encodeURIComponent(project)}/_apis/wit/workitems/${reference.id}`, {
            params: { $expand: "All" },
        }),
        fetchJson(config, `${encodeURIComponent(project)}/_apis/wit/workItems/${reference.id}/comments`, {
            apiVersion: "7.1-preview.4",
            params: { $expand: "renderedText" },
        }),
    ]);
    const workItemType = normalizeString(item.fields?.["System.WorkItemType"]);
    const [typeDefinition, relatedById] = await Promise.all([
        fetchJson(
            config,
            `${encodeURIComponent(project)}/_apis/wit/workitemtypes/${encodeURIComponent(workItemType)}`,
        ),
        fetchRelatedWorkItems(config, project, relatedWorkItemIds(item)),
    ]);
    return mapWorkItemDetail(
        item,
        commentResult.comments || commentResult.value || [],
        parseWorkItemTemplate(typeDefinition.xmlForm),
        {
            typeDefinition,
            relatedById,
        },
    );
}

async function createWorkItem(overrides = {}) {
    const config = await getEffectiveConfig(overrides);
    const project = requireProject(config);
    const title = normalizeString(overrides.title);
    const type = normalizeString(overrides.type) || "Task";
    if (!title) {
        throw new CanvasError("azure_devops_missing_title", "Work item title is required.");
    }
    const patch = [{ op: "add", path: "/fields/System.Title", value: title }];
    if (normalizeString(overrides.description)) {
        patch.push({ op: "add", path: "/fields/System.Description", value: normalizeString(overrides.description) });
    }
    const item = await fetchJson(config, `${encodeURIComponent(project)}/_apis/wit/workitems/$${encodeURIComponent(type)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json-patch+json" },
        body: JSON.stringify(patch),
    });
    return { workItem: mapWorkItem(item), raw: item };
}

// Anything an HTML parser would read as a tag. Whitespace after "<" is not
// allowed because a parser does not allow it either, so prose such as "a < b" or
// "if (x < y && y > z)" is not mistaken for markup.
const MARKUP_LIKE = /<\/?[a-zA-Z]|<!--/;

// Fields Azure DevOps always stores as HTML, whatever the work item type. Kept
// as a floor under the type lookup so the common cases stay correct even when
// the field list is unavailable.
const KNOWN_HTML_FIELDS = new Set([
    "System.Description",
    "Microsoft.VSTS.TCM.ReproSteps",
    "Microsoft.VSTS.TCM.SystemInfo",
    "Microsoft.VSTS.Common.AcceptanceCriteria",
]);

// Field data types Azure DevOps stores as markup. Everything else - string,
// plainText, integer, identity - is prose, and holding it to an HTML policy
// would reject an ordinary title such as "Support List<string>".
const HTML_FIELD_TYPES = new Set(["html", "history"]);

// System fields Azure DevOps never stores as HTML. These are the exception to
// the fail-closed default: without them, a lookup outage would apply the HTML
// policy to a title, and an ordinary one such as "Support List<string>" would
// be refused for markup the user never wrote.
const KNOWN_PLAIN_TEXT_FIELDS = new Set([
    "System.Title",
    "System.State",
    "System.Reason",
    "System.AssignedTo",
    "System.Tags",
    "System.AreaPath",
    "System.IterationPath",
]);

// Resolves how each work-item field is stored, from Azure DevOps rather than
// from anything the caller said.
//
// Returns a predicate rather than a map because the safe default is HTML. A
// field the lookup cannot account for must still be validated: an outage must
// not become a way past the HTML write policy.
async function workItemFieldFormat(config, project, workItemId) {
    let selectedFormats = new Map();
    const selectedFormat = (name) => selectedFormats.get(normalizeString(name).toLowerCase()) || "";
    const fallbackFormat = (name) =>
        selectedFormat(name) || (KNOWN_PLAIN_TEXT_FIELDS.has(name) ? "plain" : "html");
    try {
        // Azure DevOps returns an empty multilineFieldsFormat map whenever a fields
        // projection is present, even when that projection includes the rich field.
        // Read the full field set so the per-item format choice remains authoritative
        // for writes.
        const item = await fetchJson(
            config,
            `${encodeURIComponent(project)}/_apis/wit/workitems/${workItemId}`,
        );
        selectedFormats = new Map(
            Object.entries(item?.multilineFieldsFormat || {})
                .map(([name, value]) => [
                    normalizeString(name).toLowerCase(),
                    normalizeMultilineFieldFormat(value),
                ])
                .filter(([name, format]) => name && format),
        );
        const workItemType = normalizeString(item.fields?.["System.WorkItemType"]);
        if (!workItemType) {
            return fallbackFormat;
        }
        const typePath = `${encodeURIComponent(project)}/_apis/wit/workitemtypes/${encodeURIComponent(workItemType)}`;
        const [definition, fieldList] = await Promise.all([
            fetchJson(config, typePath),
            fetchJson(config, `${typePath}/fields`, { params: { $expand: "none" } }),
        ]);
        // The only fields exempted from validation are the ones the type
        // definition positively reports as a non-markup data type.
        const plainText = new Set(
            (Array.isArray(fieldList?.value) ? fieldList.value : [])
                .filter((field) => {
                    const name = normalizeString(field?.referenceName);
                    const type = normalizeString(field?.type).toLowerCase();
                    return name && type && !HTML_FIELD_TYPES.has(type);
                })
                .map((field) => normalizeString(field.referenceName)),
        );
        if (!plainText.size) {
            return fallbackFormat;
        }
        const html = new Set([
            ...KNOWN_HTML_FIELDS,
            ...parseWorkItemTemplate(definition.xmlForm)
                .flatMap((section) => section.fields)
                .filter((field) => field.isHtml)
                .map((field) => field.name),
        ]);
        return (name) => {
            const selected = selectedFormat(name);
            if (selected) {
                return selected;
            }
            return html.has(name) || !plainText.has(name) ? "html" : "plain";
        };
    } catch {
        return fallbackFormat;
    }
}

// Azure DevOps reports a failed json-patch test operation by naming the operation
// and the path it tested. Matching both keeps an unrelated failure that merely
// mentions a revision from being reported as a concurrent edit.
function isRevisionConflict(message) {
    const text = normalizeString(message);
    return /\/rev\b/i.test(text) && /\btest\b|precondition|VS403351/i.test(text);
}

async function updateWorkItemFields(overrides = {}) {
    const reference = resolveWorkItemReference(overrides);
    if (!reference) {
        throw new CanvasError(
            "azure_devops_invalid_work_item_reference",
            "Provide a work item URL or an organization, project, and positive work item ID.",
        );
    }
    const config = await getEffectiveConfig({
        ...overrides,
        organization: reference.organization,
        project: reference.project,
    });
    const project = await resolveWorkItemProject(config, reference.id);
    const fields = Array.isArray(overrides.fields) ? overrides.fields : [];
    const updates = fields
        .map((field) => ({
            name: normalizeString(field?.name),
            value: typeof field?.value === "string" ? field.value : "",
            isHtml: Boolean(field?.isHtml),
        }))
        .filter((field) => field.name);
    if (!updates.length) {
        throw new CanvasError("azure_devops_missing_fields", "At least one field must be provided.");
    }

    // The caller's isHtml flag cannot decide whether a value is checked: an action
    // call that omits it would otherwise write unvalidated markup. Nor can the
    // value alone decide, because a plain text or Markdown field legitimately
    // holds things like "Support List<string>". Resolve the current per-item
    // multiline format before applying the HTML policy.
    // Which policy applies is decided by where the write came from, never by the
    // request: the canvas editor hands back a document Azure DevOps mostly already
    // had, so holding it to the "could this editor have authored it" allow-list
    // would reject the very content it was careful to preserve. An action call is
    // authoring markup, so it stays on the strict policy.
    const preserving = overrides.preservesStoredMarkup === true;
    const suspect = updates.filter((entry) => entry.value && (entry.isHtml || MARKUP_LIKE.test(entry.value)));
    if (suspect.length) {
        const fieldFormat = await workItemFieldFormat(config, project, reference.id);
        for (const field of suspect) {
            if (fieldFormat(field.name) !== "html") {
                continue;
            }
            const { ok, violations } = preserving
                ? validateEditableHtml(field.value)
                : validateWriteHtml(field.value);
            if (!ok) {
                throw new CanvasError(
                    "azure_devops_unsupported_markup",
                    `${field.name} contains markup the canvas cannot save: ${violations[0]}`,
                );
            }
        }
    }

    const rev = Number(overrides.rev);
    if (!Number.isInteger(rev) || rev <= 0) {
        // Falling back to an unguarded write would silently drop the concurrency
        // check exactly when the caller was least careful about it.
        throw new CanvasError(
            "azure_devops_missing_rev",
            "A work item revision is required so a concurrent edit cannot be overwritten. Read the work item first and send its rev.",
        );
    }
    const patch = [
        // Optimistic concurrency: Azure DevOps rejects the whole patch when the
        // revision has moved on, so a canvas left open cannot clobber someone
        // else's edit.
        { op: "test", path: "/rev", value: rev },
        ...updates.map((field) => ({ op: "add", path: `/fields/${field.name}`, value: field.value })),
    ];
    try {
        await fetchJson(config, `${encodeURIComponent(project)}/_apis/wit/workitems/${reference.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json-patch+json" },
            body: JSON.stringify(patch),
        });
    } catch (error) {
        // Only a failure of the rev test operation means the item moved on. Any
        // other failure that happens to mention a field named "rev" is a different
        // problem, and telling the user to refresh would send them in a loop.
        if (isRevisionConflict(error?.message)) {
            throw new CanvasError(
                "azure_devops_work_item_out_of_date",
                "This work item changed in Azure DevOps since the canvas loaded it. Refresh and reapply the edit.",
            );
        }
        throw error;
    }
    return {
        workItem: await getWorkItemDetails({
            ...overrides,
            id: reference.id,
            workItemId: reference.id,
            workItemUrl: "",
            organization: reference.organization,
            project: reference.project,
        }),
    };
}

function requireCommentContent(value) {
    const content = String(value ?? "").replace(/\r\n?/g, "\n");
    if (!content.trim()) {
        throw new CanvasError("azure_devops_missing_comment", "Comment text cannot be empty.");
    }
    return content;
}

async function addWorkItemComment(overrides = {}) {
    const content = requireCommentContent(overrides.content);
    const reference = resolveWorkItemReference(overrides);
    if (!reference) {
        throw new CanvasError(
            "azure_devops_invalid_work_item_reference",
            "Provide a work item URL or an organization and positive work item ID.",
        );
    }
    const config = await getEffectiveConfig({
        ...overrides,
        organization: reference.organization,
        project: reference.project,
    });
    const project = await resolveWorkItemProject(config, reference.id);
    await fetchJson(
        config,
        `${encodeURIComponent(project)}/_apis/wit/workItems/${reference.id}/comments`,
        {
            method: "POST",
            apiVersion: "7.1-preview.4",
            // CommentFormat.Markdown is 0. The Azure DevOps client libraries use
            // the numeric enum on this query parameter.
            params: { format: 0 },
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: content }),
        },
    );
    return {
        workItem: await getWorkItemDetails({
            ...overrides,
            organization: reference.organization,
            project,
            workItemId: reference.id,
            workItemUrl: "",
        }),
    };
}

const IDENTITY_SEARCH_LIMIT = 20;
const AZURE_DEVOPS_IDENTITY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The identity picker the Azure DevOps web UI uses. It is a preview endpoint, so
// a tenant that refuses it reports an error alongside an empty list rather than
// preventing the user from continuing to write a work item comment.
async function searchIdentities(overrides = {}) {
    const query = normalizeString(overrides.query);
    if (query.length < 2) {
        return { identities: [], error: "" };
    }
    const config = await getEffectiveConfig(overrides);
    try {
        const data = await fetchJson(config, "_apis/IdentityPicker/Identities", {
            method: "POST",
            apiVersion: "5.1-preview.1",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                query,
                identityTypes: ["user", "group"],
                operationScopes: ["ims", "source"],
                properties: ["DisplayName", "Mail", "SignInAddress", "SubjectDescriptor", "Active", "Image"],
                options: { MinResults: 1, MaxResults: IDENTITY_SEARCH_LIMIT },
            }),
        });
        const results = (data.results || []).flatMap((result) => result.identities || []);
        const identities = results
            .map((identity) => {
                const id = normalizeString(identity.localId || identity.originId || identity.entityId);
                const localId = normalizeString(identity.localId);
                return {
                    id,
                    // Azure DevOps' Markdown mention token takes the organization
                    // identity id, not the Entra origin id or graph descriptor.
                    mentionId: AZURE_DEVOPS_IDENTITY_ID.test(localId) ? localId : "",
                    subjectDescriptor: normalizeString(identity.subjectDescriptor),
                    displayName: normalizeString(identity.displayName) || normalizeString(identity.signInAddress) || "Unknown",
                    uniqueName: normalizeString(identity.signInAddress || identity.mail),
                    imageUrl: normalizeString(identity.image),
                    isContainer: normalizeString(identity.entityType).toLowerCase() === "group",
                };
            })
            .filter((identity) => identity.id);
        return { identities: identities.slice(0, IDENTITY_SEARCH_LIMIT), error: "" };
    } catch (error) {
        return {
            identities: [],
            error: normalizeString(error?.message) || "Could not search Azure DevOps identities.",
        };
    }
}

const WORK_ITEM_PICKER_LIMIT = 5;
const WORK_ITEM_SEARCH_LIMIT = 20;

// With no query, search suggests the user's open work items. A query searches
// the project by title or resolves an id directly.
async function searchWorkItems(overrides = {}) {
    const query = normalizeString(overrides.query);
    const config = await getEffectiveConfig(overrides);
    const project = requireProject(config);
    const top = query ? WORK_ITEM_SEARCH_LIMIT : WORK_ITEM_PICKER_LIMIT;

    try {
        if (/^\d+$/.test(query)) {
            const id = Number(query);
            const [workItem] = await fetchWorkItemsByIds(config, project, [id], { tolerateFailure: true });
            const belongsToProject = normalizeString(workItem?.fields?.["System.TeamProject"]).toLowerCase()
                === project.toLowerCase();
            const [mapped] = belongsToProject
                ? await mapWorkItemSummaries(config, project, [workItem])
                : [];
            return {
                workItems: mapped ? [mapped] : [],
                count: mapped ? 1 : 0,
                error: mapped ? "" : `Work item ${id} was not found in ${project}.`,
            };
        }

        const stateFilter = await getTerminalWorkItemStateFilter(config, project);
        const projectFilter = `[System.TeamProject] = ${wiqlString(project)}`;
        const where = query
            ? `[System.Title] CONTAINS ${wiqlString(query)} AND ${projectFilter} ${stateFilter}`
            : `[System.AssignedTo] = @Me AND ${projectFilter} ${stateFilter}`;
        const wiql = [
            "SELECT [System.Id], [System.Title], [System.State], [System.WorkItemType], [System.ChangedDate]",
            "FROM WorkItems",
            `WHERE ${where}`,
            "ORDER BY [System.ChangedDate] DESC",
        ].join(" ");
        const queryResult = await fetchJson(config, `${encodeURIComponent(project)}/_apis/wit/wiql`, {
            method: "POST",
            params: { $top: top },
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: wiql }),
        });
        const ids = (queryResult.workItems || []).map((item) => Number(item.id)).slice(0, top);
        if (!ids.length) {
            return { workItems: [], count: 0, error: "" };
        }
        const details = await fetchWorkItemsByIds(config, project, ids, { tolerateFailure: false });
        const mapped = await mapWorkItemSummaries(config, project, details);
        const byId = new Map(mapped.map((item) => [Number(item.id), item]));
        const workItems = ids.map((id) => byId.get(id)).filter(Boolean);
        return { workItems, count: workItems.length, error: "" };
    } catch (error) {
        // A failed search leaves the rest of the work item view available.
        return {
            workItems: [],
            count: 0,
            error: normalizeString(error?.message) || "Could not search work items.",
        };
    }
}

// Organizations live on the VSSPS host rather than dev.azure.com/{org}, so they
// cannot go through buildApiUrl: there is no organization yet to build a base
// URL from. That is the whole point of this call — it is what the picker uses
// when the canvas has no connection at all.
async function fetchVsspsJson(path, params = {}) {
    const url = new URL(path, `${VSSPS_BASE_URL}/`);
    url.searchParams.set("api-version", DEFAULT_API_VERSION);
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== "") {
            url.searchParams.set(key, String(value));
        }
    }
    const token = await getRequestToken();
    const response = await fetch(url, { headers: authHeaders(token) });
    return readAzureDevOpsJson(response, token);
}

// Two calls: the profile resolves the member id that the accounts call filters
// on. Listing accounts is a convenience, not a requirement — a tenant that
// refuses it leaves the picker on free-text organization entry, which still
// works — so the failure is reported alongside an empty list rather than thrown.
async function listOrganizations() {
    try {
        const profile = await fetchVsspsJson("_apis/profile/profiles/me");
        const memberId = normalizeString(profile?.id || profile?.publicAlias);
        if (!memberId) {
            return { organizations: [], error: "Azure DevOps did not return a profile id." };
        }
        const data = await fetchVsspsJson("_apis/accounts", { memberId });
        const organizations = (data.value || [])
            .map((account) => ({
                name: normalizeString(account?.accountName),
                id: normalizeString(account?.accountId),
            }))
            .filter((account) => account.name)
            .sort((left, right) => left.name.localeCompare(right.name));
        return { organizations, error: "" };
    } catch (error) {
        // A refused sign-in is not a refused accounts call: the token has been
        // dropped, so the canvas has to go back to sign-in rather than free text.
        if (error?.code === "azure_devops_authentication_rejected") {
            throw error;
        }
        return { organizations: [], error: normalizeString(error?.message) || "Could not list Azure DevOps organizations." };
    }
}

async function listProjects(overrides = {}) {
    const config = await getEffectiveConfig(overrides);
    // Asserted before the request so a missing organization reads as "choose one"
    // rather than as a malformed URL.
    parseOrganization(config.organization);
    const data = await fetchJson(config, "_apis/projects", { params: { $top: PROJECT_LIST_LIMIT } });
    const projects = (data.value || [])
        .map((project) => ({ id: normalizeString(project?.id), name: normalizeString(project?.name) }))
        .filter((project) => project.name)
        .sort((left, right) => left.name.localeCompare(right.name));
    return { projects };
}

function connectionSummary(connection) {
    return {
        source: connection.source,
        organization: connection.organization,
        project: connection.project,
        isDefault: Boolean(connection.isDefault),
        // Boards need a project, while work items can span the organization.
        requiresProject: !connection.project,
    };
}

async function getConnections(input = {}) {
    const { connections, record } = await getConnectionState(input);
    return {
        connections: connections.map(connectionSummary),
        defaultConnection: record.default,
        lastUsedConnection: record.lastUsed,
    };
}

async function setConnection(input, selection = {}) {
    const connection = normalizeConnection(selection);
    if (!connection) {
        throw new CanvasError("azure_devops_missing_organization", "Choose an Azure DevOps organization.");
    }
    // Rejected here rather than at first use so the picker reports a bad
    // organization while the user is still looking at it.
    parseOrganization(connection.organization);
    savePreference(() => writeConnectionPreference(connection, { isDefault: Boolean(selection.isDefault) }));
    return getConnections(input);
}

async function clearDefaultConnection(input) {
    savePreference(() => clearConnectionDefault());
    return getConnections(input);
}

// A connection that could not be written is reported as a failure rather than
// answered with a success the canvas cannot honour: the record is the only place
// the connection lives, so pretending otherwise sends the user back to an empty
// picker on the next load with nothing to explain it.
function savePreference(write) {
    try {
        return write();
    } catch (error) {
        if (error?.code === CONNECTION_WRITE_FAILED) {
            throw new CanvasError(CONNECTION_WRITE_FAILED, error.message);
        }
        throw error;
    }
}

function jsonResponse(res, statusCode, payload) {
    res.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(payload));
}

function imageResponse(res, { content, contentType }) {
    res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": content.length,
        "Cache-Control": "private, max-age=300",
        "X-Content-Type-Options": "nosniff",
    });
    res.end(content);
}

function notFound(res) {
    jsonResponse(res, 404, { error: "Not found" });
}

const staticContentTypes = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
};

function staticAssetPath(pathname) {
    // The UI imports this DOM-free shared module. Keep it explicit so static
    // routing does not expose the rest of the extension directory.
    if (pathname === "/common.mjs") {
        return BROWSER_COMMON_MODULE_PATH;
    }

    const requestedPath = pathname === "/" ? "index.html" : pathname.replace(/^\/ui\//, "");
    if (pathname !== "/" && !pathname.startsWith("/ui/")) {
        return null;
    }

    try {
        const assetPath = resolve(UI_DIR, decodeURIComponent(requestedPath));
        const assetRelativePath = relative(UI_DIR, assetPath);
        return assetRelativePath && !assetRelativePath.startsWith("..") && !isAbsolute(assetRelativePath)
            ? assetPath
            : null;
    } catch {
        return null;
    }
}

function staticAsset(res, pathname) {
    const assetPath = staticAssetPath(pathname);
    const contentType = assetPath ? staticContentTypes[extname(assetPath).toLowerCase()] : "";
    if (!assetPath || !contentType) {
        notFound(res);
        return;
    }

    try {
        let content = staticAssetCache.get(assetPath);
        if (!content) {
            content = readFileSync(assetPath);
            staticAssetCache.set(assetPath, content);
        }
        res.writeHead(200, {
            "Content-Type": contentType,
            "Cache-Control": "no-store",
        });
        res.end(content);
    } catch {
        notFound(res);
    }
}

function hasPathTraversal(pathname) {
    try {
        return decodeURIComponent(pathname)
            .split("/")
            .some((segment) => segment === "." || segment === "..");
    } catch {
        return true;
    }
}

function localBoardUrl(value) {
    try {
        const url = new URL(value);
        if (
            url.protocol !== "http:" ||
            url.hostname !== "127.0.0.1" ||
            !/^\d+$/.test(url.port) ||
            /^http:\/\/[^/?#]*@/i.test(url.href) ||
            url.pathname !== "/"
        ) {
            return null;
        }
        return url;
    } catch {
        return null;
    }
}

function staticBoardProxyPath(pathname) {
    switch (pathname) {
    case "/auth-probe": return "/auth-probe";
    case "/azdo-config": return "/azdo-config";
    case "/azdo-projects": return "/azdo-projects";
    case "/cloud-config": return "/cloud-config";
    case "/comment": return "/comment";
    case "/complete-run": return "/complete-run";
    case "/connection-check": return "/connection-check";
    case "/copy-to-clipboard": return "/copy-to-clipboard";
    case "/create": return "/create";
    case "/data.json": return "/data.json";
    case "/debug-log": return "/debug-log";
    case "/delegate": return "/delegate";
    case "/delegate-local": return "/delegate-local";
    case "/local-config": return "/local-config";
    case "/diagnostics": return "/diagnostics";
    case "/refresh": return "/refresh";
    case "/run-status": return "/run-status";
    case "/state": return "/state";
    case "/type-icons.json": return "/type-icons.json";
    default: return null;
    }
}

function boardProxyRoute(entry, pathname, rawPathname = pathname) {
    if (hasPathTraversal(rawPathname)) {
        return null;
    }
    const match = pathname.match(/^\/boards\/([A-Za-z0-9_-]+)(\/.*)?$/);
    if (!match) {
        return null;
    }
    const board = entry.boards.get(match[1]);
    const targetPath = match[2] || "/";
    const boardUrl = localBoardUrl(board?.url);
    if (!board || !boardUrl) {
        return null;
    }
    const itemMatch = /^\/item\/([1-9]\d*)\/?$/.exec(targetPath);
    if (itemMatch) {
        return { board, boardUrl, targetPath: `/item/${encodeURIComponent(itemMatch[1])}` };
    }
    if (targetPath === "/") {
        return { board, boardUrl, targetPath: "/" };
    }
    const staticPath = staticBoardProxyPath(targetPath);
    return staticPath ? { board, boardUrl, targetPath: staticPath } : null;
}

function validateBoardProxyRequest(route, req) {
    if (req.method === "GET" && route.targetPath === "/") {
        return;
    }
    const actualNonce = headerValue(req.headers["x-canvas-nonce"]);
    if (!route.board.apiNonce || actualNonce !== route.board.apiNonce) {
        throw new CanvasError("azure_devops_invalid_nonce", "Rejected board request with invalid API nonce.");
    }
}

async function proxyBoardRequest(entry, req, res, url) {
    validateApiRequest(entry, req, { requireNonce: false });
    const rawPathname = (req.url || "").split("?", 1)[0];
    const route = boardProxyRoute(entry, url.pathname, rawPathname);
    if (!route) {
        notFound(res);
        return;
    }
    if (url.search) {
        notFound(res);
        return;
    }
    validateBoardProxyRequest(route, req);
    const target = new URL(route.targetPath, route.boardUrl);
    const headers = {};
    for (const name of ["accept", "content-type", "x-canvas-nonce"]) {
        const value = headerValue(req.headers[name]);
        if (value) headers[name] = value;
    }
    const method = req.method || "GET";
    const parsedBody = method === "GET" || method === "HEAD"
        ? undefined
        : await readRequestBody(req, { allowEmpty: true });
    const body = parsedBody === undefined ? undefined : JSON.stringify(parsedBody);
    const response = await fetch(target, {
        method,
        headers,
        body,
        redirect: "manual",
    });
    const content = Buffer.from(await response.arrayBuffer());
    res.writeHead(response.status, {
        "Content-Type": response.headers.get("content-type") || "application/octet-stream",
        "Content-Length": content.length,
        "Cache-Control": "no-store",
    });
    res.end(content);
}

async function readRequestBody(req, { allowEmpty = false } = {}) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw) {
        return allowEmpty ? undefined : {};
    }
    try {
        return JSON.parse(raw);
    } catch {
        throw new CanvasError("azure_devops_invalid_json", "Request body is not valid JSON.");
    }
}

function errorPayload(error) {
    return {
        error: error instanceof CanvasError ? error.code : "azure_devops_unexpected_error",
        message: error?.message || "Unexpected Azure DevOps canvas error.",
    };
}

function headerValue(value) {
    if (Array.isArray(value)) {
        return normalizeString(value[0]);
    }
    return typeof value === "string" ? value.trim() : "";
}

function validateApiRequest(entry, req, { requireNonce = true } = {}) {
    const expectedHost = entry.url ? new URL(entry.url).host : "";
    const actualHost = headerValue(req.headers.host);
    if (!expectedHost || actualHost !== expectedHost) {
        throw new CanvasError("azure_devops_invalid_host", "Rejected request with unexpected Host header.");
    }
    if (!requireNonce) {
        return;
    }
    const actualNonce = headerValue(req.headers["x-canvas-nonce"]);
    if (!entry.apiNonce || actualNonce !== entry.apiNonce) {
        throw new CanvasError("azure_devops_invalid_nonce", "Rejected request with invalid API nonce.");
    }
}

// Every data route names the connection it reads from, and the name is checked
// against the resolved set before it reaches Azure DevOps.
function connectionSelector(url) {
    return {
        organization: normalizeString(url.searchParams.get("organization")),
        project: normalizeString(url.searchParams.get("project")),
    };
}

async function handleApi(entry, req, res, url) {
    try {
        if (req.method === "GET" && url.pathname === "/api/config") {
            validateApiRequest(entry, req, { requireNonce: false });
            const config = await getEffectiveConfig(entry.input);
            // Snapshot the just-started process before reading the rest of the
            // configuration. A fast AzureAuth cache may finish during those reads;
            // returning the running snapshot still makes the client poll once and
            // obtain an auth state that is consistent with the terminal process.
            const silentAuthProcess = startSilentAgencyAuth(entry);
            const authProcess = silentAuthProcess ? { ...silentAuthProcess } : null;
            const auth = await getAuthState();
            const { connections, record } = await getConnectionState(entry.input);
            jsonResponse(res, 200, {
                apiNonce: entry.apiNonce,
                authProcess,
                config: {
                    organization: config.organization,
                    project: config.project,
                    apiVersion: config.apiVersion,
                    auth,
                    connections: connections.map(connectionSummary),
                    hasDefaultConnection: Boolean(record.default),
                    workItemReference: hasWorkItemReference(entry.input),
                    extensionVersion: EXTENSION_VERSION,
                    featureFlags: entry.featureFlags,
                },
            });
            return;
        }
        if (req.method === "POST" && url.pathname === "/api/feature-flags") {
            validateApiRequest(entry, req);
            const body = await readRequestBody(req);
            const featureFlags = normalizeFeatureFlags(body);
            if (entry.featureFlags.boards && !featureFlags.boards) {
                await entry.closeBoards();
            }
            entry.featureFlags = featureFlags;
            jsonResponse(res, 200, { featureFlags: entry.featureFlags });
            return;
        }
        if (req.method === "GET" && ["/api/avatar", "/api/attachment"].includes(url.pathname)) {
            const kind = url.pathname === "/api/attachment" ? "attachment" : "avatar";
            const label = kind === "attachment" ? "Attachment" : "Profile image";
            validateApiRequest(entry, req, { requireNonce: false });
            if (url.searchParams.get("nonce") !== entry.apiNonce) {
                throw new CanvasError("azure_devops_invalid_nonce", `Rejected ${label.toLowerCase()} request with invalid API nonce.`);
            }
            const imageUrl = normalizeString(url.searchParams.get("url"));
            if (!imageUrl) {
                throw new CanvasError(`azure_devops_invalid_${kind}_request`, `${label} request is missing the Azure DevOps image URL.`);
            }
            const connection = await requireConnection(entry.input, connectionSelector(url));
            const config = await getEffectiveConfig({ ...entry.input, ...connectionOverrides(connection) });
            imageResponse(res, await fetchImage(config, imageUrl, kind));
            return;
        }
        validateApiRequest(entry, req);
        if (req.method === "POST" && url.pathname === "/api/auth/start") {
            const body = await readRequestBody(req);
            const provider = normalizeString(body.provider).toLowerCase();
            if (provider !== "microsoft" && (provider !== "agency" || !AGENCY_AUTH_ENABLED)) {
                throw new CanvasError(
                    "azure_devops_invalid_auth_provider",
                    AGENCY_AUTH_ENABLED
                        ? "Select Microsoft or Agency sign-in."
                        : "Select Microsoft sign-in.",
                );
            }
            jsonResponse(res, 200, {
                authProcess: provider === "microsoft"
                    ? await startMicrosoftAuth(entry)
                    : await startAgencyAuth(entry),
            });
            return;
        }
        if (req.method === "POST" && url.pathname === "/api/auth/sign-out") {
            await readRequestBody(req);
            jsonResponse(res, 200, { authProcess: await signOutAuth(entry), auth: await getAuthState() });
            return;
        }
        if (req.method === "GET" && url.pathname === "/api/auth/status") {
            const authProcess = entry.authProcess || null;
            jsonResponse(res, 200, {
                authProcess,
                auth: authProcess?.status === "running" ? null : await getAuthState(),
            });
            return;
        }
        if (req.method === "POST" && url.pathname === "/api/test-error") {
            await readRequestBody(req);
            throw new CanvasError("azure_devops_test_error", "<b>Test error</b> & check escaping.");
        }
        if (req.method === "GET" && url.pathname === "/api/connections") {
            jsonResponse(res, 200, await getConnections(entry.input));
            return;
        }
        if (req.method === "PUT" && url.pathname === "/api/connection") {
            const body = await readRequestBody(req);
            jsonResponse(res, 200, await setConnection(entry.input, body));
            return;
        }
        if (req.method === "DELETE" && url.pathname === "/api/connection") {
            jsonResponse(res, 200, await clearDefaultConnection(entry.input));
            return;
        }
        if (req.method === "GET" && url.pathname === "/api/organizations") {
            jsonResponse(res, 200, await listOrganizations());
            return;
        }
        if (req.method === "GET" && url.pathname === "/api/projects") {
            // The picker asks about an organization the user is considering, which
            // is not yet a resolved connection, so this route takes it directly.
            jsonResponse(res, 200, await listProjects({
                organization: normalizeString(url.searchParams.get("organization")) || undefined,
            }));
            return;
        }
        if (req.method === "GET" && url.pathname === "/api/home") {
            jsonResponse(res, 200, await getHomeOverview({
                ...entry.input,
                top: url.searchParams.get("top") || undefined,
                featureFlags: entry.featureFlags,
            }));
            return;
        }
        if (req.method === "POST" && url.pathname === "/api/boards/open") {
            if (!entry.featureFlags.boards) {
                throw new CanvasError("azure_devops_boards_disabled", "Azure Boards is disabled.");
            }
            if (!entry.openBoard) {
                throw new CanvasError("azure_devops_board_unavailable", "Board views are not available in this canvas.");
            }
            const body = await readRequestBody(req);
            const connection = await requireConnection(entry.input, {
                organization: normalizeString(body.organization),
                project: normalizeString(body.project),
            });
            if (!connection.project) {
                throw new CanvasError("azure_devops_missing_project", "Choose an Azure DevOps project before opening a board.");
            }
            const favorites = await listFavoriteBoards({
                ...entry.input,
                ...connectionOverrides(connection),
            });
            const board = favorites.boards.find((candidate) => candidate.id === normalizeString(body.id));
            if (!board) {
                throw new CanvasError("azure_devops_unknown_board", "The selected board is no longer a favorite in this project.");
            }
            const key = [
                connection.organization.toLowerCase(),
                connection.project.toLowerCase(),
                board.id,
            ].join("/");
            const existing = [...entry.boards.entries()].find(([, value]) => value.key === key);
            if (existing) {
                jsonResponse(res, 200, {
                    board,
                    token: existing[0],
                    path: `/boards/${existing[0]}/`,
                });
                return;
            }
            const token = base64Url(randomBytes(12));
            const pathPrefix = `/boards/${token}`;
            const provider = await createBoardDataProvider(entry.input, board);
            const opened = await entry.openBoard({
                board,
                connection,
                dataProvider: provider,
                pathPrefix,
            });
            entry.boards.set(token, {
                ...opened,
                key,
                url: normalizeString(opened?.url),
            });
            if (!entry.boards.get(token)?.url) {
                entry.boards.delete(token);
                throw new CanvasError("azure_devops_board_unavailable", "The selected board did not provide a view.");
            }
            jsonResponse(res, 200, { board, token, path: `${pathPrefix}/` });
            return;
        }
        if (req.method === "DELETE" && /^\/api\/boards\/[A-Za-z0-9_-]+$/.test(url.pathname)) {
            const token = url.pathname.split("/").pop();
            const board = entry.boards.get(token);
            if (board) {
                entry.boards.delete(token);
                await entry.closeBoard?.(board);
            }
            jsonResponse(res, 200, { closed: Boolean(board) });
            return;
        }
        if (req.method === "GET" && url.pathname === "/api/work-item-search") {
            const connection = await requireConnection(entry.input, connectionSelector(url));
            jsonResponse(res, 200, await searchWorkItems({
                ...entry.input,
                ...connectionOverrides(connection),
                query: normalizeString(url.searchParams.get("query")),
            }));
            return;
        }
        if (req.method === "GET" && url.pathname === "/api/identities") {
            const connection = await requireConnection(entry.input, connectionSelector(url));
            jsonResponse(res, 200, await searchIdentities({
                ...entry.input,
                ...connectionOverrides(connection),
                query: normalizeString(url.searchParams.get("query")),
            }));
            return;
        }
        if (req.method === "PATCH" && /^\/api\/work-items\/\d+$/.test(url.pathname)) {
            const id = Number(url.pathname.split("/").pop());
            const body = await readRequestBody(req);
            const connection = await requireConnection(entry.input, connectionSelector(url));
            jsonResponse(res, 200, await updateWorkItemFields({
                ...entry.input,
                ...body,
                id,
                workItemId: id,
                // The canvas may have been opened on a different work item.
                workItemUrl: "",
                // Set here, after the body spread, so a request cannot ask for the
                // preserve policy: it is granted by the route, not the caller.
                preservesStoredMarkup: true,
                ...connectionOverrides(connection),
                // A work item from an organization-scope list carries its own
                // project, which the connection does not have.
                project: normalizeString(url.searchParams.get("workItemProject")) || connection.project,
            }));
            return;
        }
        if (req.method === "POST" && /^\/api\/work-items\/\d+\/comments$/.test(url.pathname)) {
            const id = Number(url.pathname.split("/").at(-2));
            const body = await readRequestBody(req);
            const connection = await requireConnection(entry.input, connectionSelector(url));
            jsonResponse(res, 200, await addWorkItemComment({
                ...entry.input,
                ...body,
                id,
                workItemId: id,
                workItemUrl: "",
                ...connectionOverrides(connection),
                project: normalizeString(url.searchParams.get("workItemProject")) || connection.project,
            }));
            return;
        }
        if (req.method === "POST" && /^\/api\/work-items\/\d+\/delegate$/.test(url.pathname)) {
            if (!entry.featureFlags.delegation) {
                throw new CanvasError("azure_devops_delegation_disabled", "Work item delegation is disabled.");
            }
            if (!entry.delegateWorkItem) {
                throw new CanvasError("azure_devops_delegation_unavailable", "Work item delegation is not available in this canvas.");
            }
            const id = Number(url.pathname.split("/").at(-2));
            const body = await readRequestBody(req);
            const mode = normalizeString(body.mode).toLowerCase();
            if (mode !== "local" && mode !== "cloud") {
                throw new CanvasError("azure_devops_invalid_delegation_mode", "Choose local or cloud delegation.");
            }
            const connection = await requireConnection(entry.input, connectionSelector(url));
            const project = normalizeString(url.searchParams.get("workItemProject")) || connection.project;
            if (!project) {
                throw new CanvasError("azure_devops_missing_project", "The work item's Azure DevOps project is required for delegation.");
            }
            const scopedConnection = { ...connection, project };
            const workItem = await getWorkItemDetails({
                ...entry.input,
                id,
                workItemId: id,
                workItemUrl: "",
                ...connectionOverrides(scopedConnection),
            });
            const target = {
                organization: scopedConnection.organization,
                org: scopedConnection.organization,
                project,
                team: `${project} Team`,
                backlogLevel: "",
                url: `${parseOrganization(scopedConnection.organization).baseUrl}/${encodePathPart(project)}`,
            };
            const dataProvider = await createBoardDataProvider(entry.input, target);
            jsonResponse(res, 200, await entry.delegateWorkItem({
                connection: scopedConnection,
                dataProvider,
                force: body.force === true,
                item: workItem,
                mode,
            }));
            return;
        }
        if (req.method === "GET" && /^\/api\/work-items\/\d+\/details$/.test(url.pathname)) {
            const connection = await requireConnection(entry.input, connectionSelector(url));
            const id = Number(url.pathname.split("/").at(-2));
            jsonResponse(res, 200, {
                workItem: await getWorkItemDetails({
                    ...entry.input,
                    id,
                    workItemId: id,
                    // The canvas may have been opened on a different work item.
                    workItemUrl: "",
                    ...connectionOverrides(connection),
                    project: normalizeString(url.searchParams.get("workItemProject")) || connection.project,
                }),
            });
            return;
        }
        if (req.method === "GET" && url.pathname.startsWith("/api/work-items/")) {
            const id = url.pathname.split("/").pop();
            const connection = await requireConnection(entry.input, connectionSelector(url));
            jsonResponse(res, 200, await getWorkItem({
                ...entry.input,
                id,
                ...connectionOverrides(connection),
                project: normalizeString(url.searchParams.get("workItemProject")) || connection.project,
            }));
            return;
        }
        if (req.method === "GET" && url.pathname === "/api/current-work-item") {
            jsonResponse(res, 200, { workItem: await getWorkItemDetails(entry.input) });
            return;
        }
        notFound(res);
    } catch (error) {
        jsonResponse(res, error instanceof CanvasError ? 400 : 500, errorPayload(error));
    }
}


export async function startServer(instanceId, input, { openBoard, closeBoard, delegateWorkItem } = {}) {
    const entry = {
        input: input || {},
        apiNonce: base64Url(randomBytes(24)),
        boards: new Map(),
        openBoard,
        closeBoard,
        delegateWorkItem,
        featureFlags: { ...DEFAULT_FEATURE_FLAGS },
    };
    const server = createServer(async (req, res) => {
        const url = new URL(req.url || "/", entry.url || "http://127.0.0.1/");
        if (url.pathname.startsWith("/api/")) {
            await handleApi(entry, req, res, url);
            return;
        }
        if (url.pathname.startsWith("/boards/")) {
            try {
                await proxyBoardRequest(entry, req, res, url);
            } catch (error) {
                jsonResponse(
                    res,
                    error instanceof CanvasError ? 400 : 502,
                    error instanceof CanvasError
                        ? errorPayload(error)
                        : {
                            error: "azure_devops_board_unavailable",
                            message: error?.message || "The Azure DevOps board is unavailable.",
                        },
                );
            }
            return;
        }
        staticAsset(res, url.pathname);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    entry.server = server;
    entry.url = `http://127.0.0.1:${port}/`;
    entry.closeBoards = async () => {
        const boards = [...entry.boards.values()];
        entry.boards.clear();
        await Promise.allSettled(boards.map((board) => entry.closeBoard?.(board)));
    };
    return entry;
}

export function serializeCanvasInput(input) {
    return JSON.stringify(input, Object.keys(input).sort());
}

export function setCopilotSession(session) {
    copilotSession = session;
}

export {
    addWorkItemComment,
    canvasTitle,
    clearDefaultConnection,
    getAuthState,
    getConnections,
    getEffectiveConfig,
    getWorkItem,
    listFavoriteBoards,
    listOrganizations,
    listProjects,
    searchIdentities,
    searchWorkItems,
    setConnection,
    updateWorkItemFields,
    fetchAttachment,
    fetchAvatar,
    queryMyOpenWorkItems,
    terminalWorkItemStateFilter,
    validateAttachmentUrl,
    validateAvatarUrl,
};
