// Azure Boards connections come from explicit canvas input or saved selections.
// The last-used connection is shown before a separately pinned default.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { normalizeString } from "./common.mjs";

const CONNECTION_FILE_VERSION = 1;

export const CONNECTION_SOURCE_INPUT = "input";
export const CONNECTION_SOURCE_DEFAULT = "default";
export const CONNECTION_SOURCE_LAST_USED = "last-used";

export function connectionPreferencePath() {
    return join(homedir(), ".copilot", "azure-devops-canvas", "connection.json");
}

// An organization is required. Project remains optional because work items can
// be queried across the organization.
export function normalizeConnection(value) {
    const organization = normalizeString(value?.organization || value?.org);
    if (!organization) {
        return null;
    }
    return {
        organization,
        project: normalizeString(value?.project),
    };
}

// Connections are identified by organization and project.
export function connectionKey(connection) {
    const normalized = normalizeConnection(connection);
    if (!normalized) {
        return "";
    }
    return `${normalized.organization.toLowerCase()}/${normalized.project.toLowerCase()}`;
}

export function sameConnection(left, right) {
    const leftKey = connectionKey(left);
    return Boolean(leftKey) && leftKey === connectionKey(right);
}

function normalizeRecord(value) {
    return {
        version: CONNECTION_FILE_VERSION,
        default: normalizeConnection(value?.default),
        lastUsed: normalizeConnection(value?.lastUsed),
        updatedAt: normalizeString(value?.updatedAt),
    };
}

export function readConnectionPreference() {
    try {
        return normalizeRecord(JSON.parse(readFileSync(connectionPreferencePath(), "utf8")));
    } catch {
        // A missing or unreadable file means no saved connection, which is the
        // first-run state rather than an error: the canvas asks the user to pick.
        return normalizeRecord(null);
    }
}

export const CONNECTION_WRITE_FAILED = "azure_devops_connection_write_failed";

function persist(record) {
    const next = { ...normalizeRecord(record), updatedAt: new Date().toISOString() };
    const path = connectionPreferencePath();
    mkdirSync(dirname(path), { recursive: true });
    // writeFileSync only applies mode when it creates the file, so a record
    // written before this was restricted would keep its old permissions.
    rmSync(path, { force: true });
    writeFileSync(path, JSON.stringify(next, null, 2), { mode: 0o600 });
    return next;
}

// Every manual selection updates lastUsed, so a user who never pins a default
// still returns to the organization they were last looking at. Pinning also
// writes the default; unpinning clears it without disturbing lastUsed.
//
// A write failure is raised rather than swallowed. The record is the only place
// a connection lives, so a canvas that reported success on an unwritable home
// would send the user back to an empty picker on the next load with nothing to
// explain it, and no way out of that loop.
export function writeConnectionPreference(connection, { isDefault = false } = {}) {
    const normalized = normalizeConnection(connection);
    if (!normalized) {
        return readConnectionPreference();
    }
    const record = readConnectionPreference();
    return persistOrFail({
        default: isDefault ? normalized : record.default,
        lastUsed: normalized,
    });
}

function persistOrFail(record) {
    try {
        return persist(record);
    } catch (error) {
        const failure = new Error(`Could not save the Azure DevOps connection: ${error?.message || "write failed"}`);
        failure.code = CONNECTION_WRITE_FAILED;
        throw failure;
    }
}

export function clearConnectionDefault() {
    const record = readConnectionPreference();
    return persistOrFail({ default: null, lastUsed: record.lastUsed });
}

export function clearConnectionPreference() {
    const path = connectionPreferencePath();
    const existed = existsSync(path);
    try {
        rmSync(path, { force: true });
        return existed;
    } catch (error) {
        const failure = new Error(`Could not clear the Azure DevOps connection: ${error?.message || "delete failed"}`);
        failure.code = CONNECTION_WRITE_FAILED;
        throw failure;
    }
}

// The saved connections, most recently chosen first. Both are returned rather
// than only the default, because an explicit selection has to be visible: with
// only the default returned, saving a different organization without pinning it
// updated the record but changed nothing on screen, which reads as the setting
// not sticking.
export function savedConnections(record = readConnectionPreference()) {
    const saved = [];
    if (record.lastUsed) {
        saved.push({ connection: record.lastUsed, source: CONNECTION_SOURCE_LAST_USED });
    }
    if (record.default) {
        saved.push({ connection: record.default, source: CONNECTION_SOURCE_DEFAULT });
    }
    return saved;
}

// Explicit work item links select their own organization. Otherwise show the
// saved selections, most recently chosen first, without duplicate projects.
export function resolveConnections({ input, record } = {}) {
    const inputConnection = normalizeConnection(input);
    if (inputConnection) {
        return [{
            ...inputConnection,
            source: CONNECTION_SOURCE_INPUT,
            isDefault: false,
        }];
    }

    const connections = [];
    const seen = new Set();
    const resolvedRecord = record || readConnectionPreference();
    for (const entry of savedConnections(resolvedRecord)) {
        const connection = normalizeConnection(entry.connection);
        const key = connectionKey(connection);
        if (!connection || seen.has(key)) {
            continue;
        }
        seen.add(key);
        const isDefault = Boolean(resolvedRecord.default && sameConnection(resolvedRecord.default, connection));
        connections.push({
            ...connection,
            source: isDefault ? CONNECTION_SOURCE_DEFAULT : entry.source,
            isDefault,
        });
    }
    return connections;
}

// Requests name the connection they are for, and that name is checked against
// the resolved set rather than trusted. Without this a request could reach any
// organization it liked, which would also defeat validateAvatarUrl: that check
// only proves an avatar belongs to the organization the request claimed.
export function selectConnection(connections, selector) {
    const requested = normalizeConnection(selector);
    if (!requested) {
        return connections[0] || null;
    }
    const match = connections.find((connection) => sameConnection(connection, requested));
    return match || null;
}
