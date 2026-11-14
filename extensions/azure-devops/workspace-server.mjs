import { createHash } from "node:crypto";
import { normalizeString } from "./common.mjs";
import { mapWorkItem } from "./work-item.mjs";

export const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;
const SUMMARY_FIELDS = ["System.Id", "System.Title", "System.WorkItemType", "System.State", "System.TeamProject",
    "System.AssignedTo", "System.Tags", "System.ChangedDate", "System.AreaPath", "System.IterationPath"];
const TERMINAL = new Set(["completed", "removed"]);
const enc = encodeURIComponent;
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
const list = (value) => Array.isArray(value) ? value : value?.value || [];
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const itemPath = (config, id = "") => `${config.project ? `${enc(config.project)}/` : ""}_apis/wit/workitems${id ? `/${id}` : ""}`;

export async function readBoundedBody(req, limit, failure) {
    const advertised = Number(req.headers["content-length"]);
    if (Number.isFinite(advertised) && advertised > limit) {
        req.resume?.();
        throw failure();
    }
    const chunks = [];
    let length = 0;
    const stream = typeof req.iterator === "function" ? req.iterator({ destroyOnReturn: false }) : req;
    for await (const chunk of stream) {
        length += chunk.length;
        if (length > limit) {
            req.resume?.();
            throw failure();
        }
        chunks.push(chunk);
    }
    return Buffer.concat(chunks, length);
}

export function createWorkspaceService({ fetchJson, parseOrganization, validateWriteHtml, ErrorType }) {
    const fail = (code, message) => new ErrorType(`azure_devops_${code}`, message);
    function text(value, label, maximum = 512) {
        const result = normalizeString(value);
        if (result.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(result)) {
            throw fail("invalid_workspace_input", `${label} is too long or contains invalid characters.`);
        }
        return result;
    }
    function positive(value, label) {
        const number = Number(value);
        if (!Number.isSafeInteger(number) || number <= 0) throw fail("invalid_workspace_input", `${label} must be a positive integer.`);
        return number;
    }
    async function project(config) {
        if (!config.project) throw fail("missing_project", "Choose a project first.");
        const record = await fetchJson(config, `_apis/projects/${enc(config.project)}`);
        if (!record.id || !record.name) throw fail("invalid_project", "Azure DevOps did not return the selected project.");
        return { ...config, project: record.name, projectId: record.id };
    }
    async function types(config, { includeDisabled = false } = {}) {
        return list(await fetchJson(config, `${enc(config.project)}/_apis/wit/workitemtypes`))
            .filter((type) => type.name && (includeDisabled || !type.isDisabled))
            .map((type) => ({ name: type.name, color: type.color || "", states: (type.states || [])
                .map((state) => ({ name: state.name, category: state.category || "", color: state.color || "" })) }));
    }
    async function batch(config, ids, { fields = SUMMARY_FIELDS, expand, asOf } = {}) {
        const items = [];
        const unique = [...new Set(ids.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
        for (let index = 0; index < unique.length; index += 200) {
            const data = await fetchJson(config, itemPath(config), { params: {
                ids: unique.slice(index, index + 200).join(","),
                ...(expand ? { $expand: expand } : { fields: fields.filter(Boolean).join(",") }),
                asOf, errorPolicy: "omit",
            } });
            items.push(...list(data));
        }
        return items;
    }
    async function item(config, id, expand = "Relations") {
        const found = await fetchJson(config, itemPath(config, positive(id, "Work item id")), { params: { $expand: expand } });
        if (config.project && normalizeString(found.fields?.["System.TeamProject"]).toLowerCase() !== config.project.toLowerCase()) {
            throw fail("work_item_project_mismatch", "The work item does not belong to the selected project.");
        }
        return found;
    }
    async function query(config, where, top, { asOf = "", order = "[System.Id] DESC" } = {}) {
        const scope = config.project ? `[System.TeamProject] = ${literal(config.project)} AND ` : "";
        const wiql = `SELECT [System.Id] FROM WorkItems WHERE ${scope}${where} ORDER BY ${order}${asOf ? ` ASOF ${literal(asOf)}` : ""}`;
        return fetchJson(config, `${config.project ? `${enc(config.project)}/` : ""}_apis/wit/wiql`, {
            method: "POST", params: { $top: top, timePrecision: true },
            headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: wiql }),
        });
    }
    async function patch(config, id, rev, operations) {
        try {
            return await fetchJson(config, itemPath(config, positive(id, "Work item id")), {
                method: "PATCH", headers: { "Content-Type": "application/json-patch+json" },
                body: JSON.stringify([{ op: "test", path: "/rev", value: positive(rev, "Revision") }, ...operations]),
            });
        } catch (error) {
            if (/\/rev\b/i.test(error.message) && /test|precondition|VS403351/i.test(error.message)) {
                throw fail("work_item_out_of_date", "This work item changed. Refresh it and try again; your edits were not overwritten.");
            }
            throw error;
        }
    }
    async function metadata(config) {
        const projects = [];
        let continuationToken = "";
        do {
            const page = await fetchJson(config, "_apis/projects", {
                params: { $top: 500, continuationToken }, withContinuation: true,
            });
            projects.push(...list(page.data).map(({ id, name }) => ({ id, name })));
            continuationToken = page.continuationToken || "";
        } while (continuationToken);
        if (!config.project) return { projects, types: [], teams: [] };
        config = await project(config);
        const teams = [];
        for (let skip = 0; ; skip += 500) {
            const page = list(await fetchJson(config, `_apis/projects/${enc(config.projectId)}/teams`, { params: { $top: 500, $skip: skip } }));
            teams.push(...page.map(({ id, name }) => ({ id, name })));
            if (page.length < 500) break;
        }
        return { projects, types: await types(config), teams };
    }
    async function items(config, filters = {}) {
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(config.project)) config = await project(config);
        const pageSize = Math.floor(Math.max(1, Math.min(Number(filters.pageSize) || 50, 200)));
        const values = Object.fromEntries(["query", "assignee", "state", "type", "tags"].map((key) => [key, text(filters[key], key)]));
        values.assignee ||= "mine";
        const fingerprint = digest([config.organization.toLowerCase(), config.project.toLowerCase(), values]);
        let cursor = { after: null, asOf: new Date().toISOString(), filter: fingerprint };
        if (filters.cursor) {
            try { cursor = JSON.parse(Buffer.from(text(filters.cursor, "Cursor", 2048), "base64url").toString("utf8")); }
            catch { throw fail("invalid_cursor", "The results cursor is invalid. Refresh the search."); }
            if (cursor.filter !== fingerprint || !Number.isSafeInteger(cursor.after) || cursor.after <= 0
                || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(cursor.asOf) || !Number.isFinite(Date.parse(cursor.asOf))) {
                throw fail("invalid_cursor", "The results cursor belongs to another search. Refresh the search.");
            }
        }
        const where = ["[System.Id] > 0"];
        if (cursor.after) where.push(`[System.Id] < ${cursor.after}`);
        if (values.query) where.push(/^\d+$/.test(values.query)
            ? `[System.Id] = ${positive(values.query, "Work item id")}` : `[System.Title] CONTAINS ${literal(values.query)}`);
        if (values.assignee === "mine") where.push("[System.AssignedTo] = @Me");
        else if (values.assignee === "unassigned") where.push("[System.AssignedTo] = ''");
        else if (values.assignee && values.assignee !== "all") where.push(`[System.AssignedTo] = ${literal(values.assignee)}`);
        if (values.state) where.push(`[System.State] = ${literal(values.state)}`);
        if (values.type) where.push(`[System.WorkItemType] = ${literal(values.type)}`);
        for (const tag of values.tags.split(/[;,]/).map((entry) => entry.trim()).filter(Boolean)) where.push(`[System.Tags] CONTAINS ${literal(tag)}`);
        const result = await query(config, where.join(" AND "), pageSize + 1, { asOf: cursor.asOf });
        const ids = (result.workItems || []).map(({ id }) => Number(id));
        const pageIds = ids.slice(0, pageSize);
        const byId = new Map((await batch(config, pageIds, { asOf: cursor.asOf })).map((entry) => [Number(entry.id), entry]));
        const workItems = pageIds.map((id) => byId.get(id)).filter(Boolean).map((entry) => mapWorkItem(entry));
        return { workItems, count: workItems.length, nextCursor: ids.length > pageSize
            ? Buffer.from(JSON.stringify({ ...cursor, after: pageIds.at(-1) })).toString("base64url") : null };
    }
    async function createItem(config, body) {
        config = await project(config);
        const type = text(body.type, "Type", 128);
        const title = text(body.title, "Title", 255);
        if (!title) throw fail("missing_title", "Enter a title for the work item.");
        if (!(await types(config)).some((entry) => entry.name === type)) throw fail("invalid_work_item_type", "Choose a work item type offered by this project.");
        const description = typeof body.description === "string" ? body.description : "";
        if (Buffer.byteLength(description) > 256 * 1024) throw fail("invalid_description", "The description exceeds 256 KiB.");
        const policy = validateWriteHtml(description);
        if (!policy.ok) throw fail("unsupported_markup", `The description cannot be saved: ${policy.violations[0]}`);
        const parent = body.parentId === undefined || body.parentId === null ? null : await item(config, body.parentId);
        const operations = [{ op: "add", path: "/fields/System.Title", value: title }];
        if (description) operations.push({ op: "add", path: "/fields/System.Description", value: description });
        for (const [key, field] of [["assignedTo", "System.AssignedTo"], ["area", "System.AreaPath"], ["iteration", "System.IterationPath"]]) {
            const inherited = parent?.fields?.[field];
            const value = body[key] === undefined
                ? (typeof inherited === "object" ? inherited.uniqueName || inherited.id : inherited)
                : body[key];
            const normalized = text(value, key, 512);
            if (normalized) operations.push({ op: "add", path: `/fields/${field}`, value: normalized });
        }
        if (parent) operations.push({ op: "add", path: "/relations/-", value: {
            rel: "System.LinkTypes.Hierarchy-Reverse",
            url: `${parseOrganization(config.organization).baseUrl}/${enc(config.projectId)}/_apis/wit/workitems/${parent.id}`,
        } });
        const created = await fetchJson(config, `${itemPath(config)}/$${enc(type)}`, {
            method: "POST", headers: { "Content-Type": "application/json-patch+json" }, body: JSON.stringify(operations),
        });
        return { workItem: mapWorkItem(created) };
    }
    function teamPath(config, team) {
        team = text(team, "Team", 256);
        if (!team) throw fail("missing_team", "Choose a team first.");
        return `${enc(config.project)}/${enc(team)}/_apis/work`;
    }
    async function boards(config, team) {
        config = await project(config);
        return { boards: list(await fetchJson(config, `${teamPath(config, team)}/boards`)).map(({ id, name }) => ({ id, name })) };
    }
    async function boardContext(config, team, id) {
        config = await project(config);
        const path = teamPath(config, team);
        id = text(id, "Board", 256);
        if (!id) throw fail("missing_board", "Choose a board first.");
        const [board, backlogs] = await Promise.all([
            fetchJson(config, `${path}/boards/${enc(id)}`), fetchJson(config, `${path}/backlogs`),
        ]);
        const backlog = list(backlogs).find((entry) => entry.name.toLowerCase() === normalizeString(board.name).toLowerCase());
        if (!backlog) throw fail("board_backlog_missing", "Azure DevOps did not identify the backlog for this board. Refresh the board list.");
        const columnField = board.fields?.columnField?.referenceName;
        const doneField = board.fields?.doneField?.referenceName;
        if (!columnField || !/^[A-Za-z][A-Za-z0-9_.]+$/.test(columnField)
            || (doneField && !/^[A-Za-z][A-Za-z0-9_.]+$/.test(doneField))) throw fail("board_fields_missing", "This board did not expose its column fields.");
        const membership = await fetchJson(config, `${path}/backlogs/${enc(backlog.id)}/workItems`);
        const ids = [...new Set((membership.workItems || []).map((link) => Number(link.target?.id)).filter(id => Number.isSafeInteger(id) && id > 0))];
        return { config, board, backlog, columnField, doneField, ids };
    }
    function card(context, raw) {
        const value = raw.fields?.[context.columnField];
        let column = (context.board.columns || []).find((entry) => entry.name === value || entry.id === value);
        if (!column) {
            const matches = (context.board.columns || []).filter((entry) => entry.stateMappings?.[raw.fields?.["System.WorkItemType"]] === raw.fields?.["System.State"]);
            if (matches.length === 1) column = matches[0];
        }
        return { ...mapWorkItem(raw), columnId: column?.id || "", columnDone: Boolean(column?.isSplit && raw.fields?.[context.doneField]) };
    }
    async function board(config, team, id) {
        const context = await boardContext(config, team, id);
        const asOf = new Date().toISOString();
        const mine = new Set();
        for (let index = 0; index < context.ids.length; index += 200) {
            const ids = context.ids.slice(index, index + 200);
            const result = await query(context.config, `[System.AssignedTo] = @Me AND [System.Id] IN (${ids.join(",")})`, ids.length, { asOf });
            for (const entry of result.workItems || []) mine.add(Number(entry.id));
        }
        const raw = await batch(context.config, context.ids.filter(id => mine.has(id)), { fields: [...SUMMARY_FIELDS, context.columnField, context.doneField], asOf });
        const supported = new Set((context.backlog.workItemTypes || []).map(({ name }) => name));
        const workItems = raw.filter((entry) => !supported.size || supported.has(entry.fields?.["System.WorkItemType"]))
            .map((entry) => card(context, entry));
        const sampleLimit = Number(context.backlog.workItemCountLimit) || 1000;
        return { id: context.board.id, name: context.board.name, columns: context.board.columns || [], workItems,
            count: workItems.length, sampleLimit, truncated: context.ids.length >= sampleLimit,
            scopeNote: "Your assigned work in this team's backlog. Completed items follow the team's backlog visibility rules." };
    }
    async function move(config, team, id, body) {
        const rev = positive(body.rev, "Revision");
        const workItemId = positive(body.id, "Work item id");
        if (typeof body.done !== "boolean") throw fail("invalid_board_move", "Choose the Doing or Done side of the column.");
        const context = await boardContext(config, team, id);
        if (!context.ids.includes(workItemId)) throw fail("item_not_on_board", "This work item is not in the selected team's backlog. Refresh the board.");
        const column = (context.board.columns || []).find((entry) => entry.id === body.columnId);
        if (!column || (body.done && !column.isSplit)) throw fail("invalid_board_column", "Choose a valid column and side on this board.");
        const raw = await item(context.config, workItemId);
        const state = column.stateMappings?.[raw.fields?.["System.WorkItemType"]];
        if (!state) throw fail("invalid_board_mapping", "This column has no state mapping for the work item type.");
        const operations = [
            { op: "add", path: "/fields/System.State", value: state },
            { op: "add", path: `/fields/${context.columnField}`, value: column.name },
        ];
        if (context.doneField) operations.push({ op: "add", path: `/fields/${context.doneField}`, value: Boolean(column.isSplit && body.done) });
        else if (column.isSplit) throw fail("board_fields_missing", "This split column did not expose its Done field.");
        const changed = await patch(context.config, workItemId, rev, operations);
        return { workItem: card(context, changed) };
    }
    function terminalPredicate(definitions, categories = TERMINAL) {
        const parts = definitions.map((type) => {
            const states = type.states.filter((state) => categories.has(state.category.toLowerCase())).map(({ name }) => literal(name));
            return states.length ? `([System.WorkItemType] = ${literal(type.name)} AND [System.State] IN (${states.join(",")}))` : "";
        }).filter(Boolean);
        if (!parts.length) throw fail("work_item_states_missing", "Azure DevOps did not provide completed state categories for this project.");
        return `(${parts.join(" OR ")})`;
    }
    async function dashboard(config) {
        config = await project(config);
        const definitions = await types(config, { includeDisabled: true });
        const terminal = terminalPredicate(definitions);
        const completed = terminalPredicate(definitions, new Set(["completed"]));
        const fieldDefinitions = list(await fetchJson(config, `${enc(config.project)}/_apis/wit/fields`));
        const blockedField = fieldDefinitions.find((field) => /(^|\.)Blocked$/i.test(field.referenceName || "")
            && ["string", "boolean"].includes(normalizeString(field.type).toLowerCase()));
        const blocked = blockedField ? `([${blockedField.referenceName}] = ${blockedField.type.toLowerCase() === "boolean" ? "True" : "'Yes'"} OR [System.Tags] CONTAINS 'blocked')` : "[System.Tags] CONTAINS 'blocked'";
        const closedField = fieldDefinitions.some((field) => field.referenceName === "Microsoft.VSTS.Common.ClosedDate")
            ? "Microsoft.VSTS.Common.ClosedDate" : "System.ChangedDate";
        const sampleLimit = 100;
        async function section(where, expand = "") {
            const result = await query(config, where, sampleLimit + 1, { order: "[System.ChangedDate] DESC, [System.Id] DESC" });
            const ids = (result.workItems || []).map(({ id }) => id);
            const raw = await batch(config, ids.slice(0, sampleLimit), { expand });
            const byId = new Map(raw.map((entry) => [Number(entry.id), entry]));
            const ordered = ids.slice(0, sampleLimit).map((id) => byId.get(Number(id))).filter(Boolean);
            return { workItems: ordered.map((entry) => mapWorkItem(entry)), count: ordered.length, error: "",
                truncated: ids.length > sampleLimit, sampleLimit, raw: ordered };
        }
        const mineOpen = `[System.AssignedTo] = @Me AND NOT ${terminal}`;
        const runs = await Promise.allSettled([
            section(mineOpen), section(`${mineOpen} AND ${blocked}`), section(mineOpen, "Relations"),
            section(`[System.AssignedTo] = @Me AND ${completed} AND [${closedField}] >= @Today - 14`),
        ]);
        const results = {};
        for (const [index, name] of ["current", "blocked", "unfinished", "completed"].entries()) {
            const result = runs[index];
            if (result.status === "rejected") {
                if (/authentication_rejected|login_required/.test(result.reason?.code || "")) throw result.reason;
                results[name] = { workItems: [], count: 0, error: result.reason.message, truncated: false, sampleLimit };
            } else results[name] = result.value;
        }
        if (results.unfinished.raw) {
            const parents = results.unfinished.raw;
            const children = (entry) => (entry.relations || []).filter((link) => link.rel === "System.LinkTypes.Hierarchy-Forward")
                .map((link) => Number(/\/_apis\/wit\/workitems\/(\d+)/i.exec(link.url || "")?.[1])).filter(Boolean);
            const childIds = [...new Set(parents.flatMap(children))];
            try {
                const rawChildren = await batch(config, childIds.slice(0, 2000));
                const childById = new Map(rawChildren.map((entry) => [Number(entry.id), entry]));
                const terminalByType = new Map(definitions.map((type) => [type.name, new Set(type.states.filter((state) => TERMINAL.has(state.category.toLowerCase())).map(({ name }) => name))]));
                results.unfinished.workItems = parents.map((parent) => {
                    const ids = children(parent);
                    const known = ids.map((id) => childById.get(id)).filter(Boolean);
                    const incompleteChildCount = known.filter((child) => !terminalByType.get(child.fields?.["System.WorkItemType"])?.has(child.fields?.["System.State"])).length;
                    return { ...mapWorkItem(parent), incompleteChildCount, unknownChildCount: ids.length - known.length };
                }).filter((entry) => entry.incompleteChildCount || entry.unknownChildCount);
                results.unfinished.count = results.unfinished.workItems.length;
                results.unfinished.truncated ||= childIds.length > 2000;
                results.unfinished.childSampleLimit = 2000;
            } catch (error) {
                if (/authentication_rejected|login_required/.test(error.code || "")) throw error;
                results.unfinished.error = `Could not load child progress: ${error.message}`;
                results.unfinished.workItems = [];
                results.unfinished.count = 0;
            }
        }
        for (const value of Object.values(results)) delete value.raw;
        results.completed.dateBasis = closedField;
        results.completed.days = 14;
        return results;
    }
    async function upload(config, id, fileName, bytes) {
        if (bytes.length > MAX_UPLOAD_BYTES) throw fail("attachment_too_large", "Attachments must be 60 MiB or smaller.");
        fileName = text(fileName, "File name", 255);
        if (!fileName || /[\\/\u0000-\u001f\u007f]/.test(fileName) || [".", ".."].includes(fileName)) throw fail("invalid_file_name", "Choose a file with a valid name without path separators.");
        config = await project(config);
        const current = await item(config, id);
        let uploaded;
        try {
            uploaded = await fetchJson(config, `${enc(config.projectId)}/_apis/wit/attachments`, {
                method: "POST", params: { fileName, uploadType: "simple" },
                headers: { "Content-Type": "application/octet-stream" }, body: bytes,
            });
        } catch (error) {
            if (/authentication_rejected|login_required/.test(error.code || "")) throw error;
            throw fail("attachment_upload_failed", `The file was not uploaded: ${error.message}`);
        }
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uploaded.id || "")) throw fail("invalid_attachment", "Azure DevOps did not return a valid attachment id.");
        const url = new URL(`${parseOrganization(config.organization).baseUrl}/${enc(config.projectId)}/_apis/wit/attachments/${uploaded.id}`);
        url.searchParams.set("fileName", fileName);
        let updated;
        try {
            updated = await patch(config, id, current.rev, [{ op: "add", path: "/relations/-", value: {
                rel: "AttachedFile", url: url.href, attributes: { name: fileName },
            } }]);
        } catch (error) {
            if (/authentication_rejected|login_required/.test(error.code || "")) throw error;
            throw fail("attachment_link_failed", `The file uploaded but could not be attached to work item ${id}. Refresh the item and upload again. ${error.message}`);
        }
        return { attachment: { id: uploaded.id, url: url.href, fileName }, rev: Number(updated.rev) };
    }
    return { metadata, items, createItem, boards, board, move, dashboard, upload, project };
}
