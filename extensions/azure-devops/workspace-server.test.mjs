import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspaceService, MAX_UPLOAD_BYTES, readBoundedBody } from "./workspace-server.mjs";
import { validateWriteHtml } from "./ui/rich-text-policy.mjs";

class ApiError extends Error { constructor(code, message) { super(message); this.code = code; } }
const config = { organization: "fabrikam", project: "widgets" };
const projectId = "4e1c4e8f-0c57-4a25-9a4e-2e2c2f4d8a55";
const attachmentId = "06f5932c-aa2f-4545-9764-8546bec98914";
const definitions = [{ name: "Task", states: [{ name: "Open", category: "Proposed" }, { name: "Done", category: "Completed" }] }];
const raw = (id, fields = {}, relations = []) => ({ id, rev: 7, fields: {
    "System.Title": `Item ${id}`, "System.WorkItemType": "Task", "System.State": "Open", "System.TeamProject": "widgets",
    "System.Tags": "alpha; beta", ...fields,
}, relations });
function harness(handler = () => undefined) {
    const requests = [];
    const service = createWorkspaceService({
        ErrorType: ApiError, validateWriteHtml,
        parseOrganization: () => ({ baseUrl: "https://dev.azure.com/fabrikam" }),
        fetchJson: async (scope, path, options = {}) => {
            const request = { scope, path, ...options, json: typeof options.body === "string" ? JSON.parse(options.body) : null };
            requests.push(request);
            const response = await handler(request);
            if (response !== undefined) return response;
            if (path === "_apis/projects/widgets") return { id: projectId, name: "widgets" };
            if (path === "widgets/_apis/wit/workitemtypes") return { value: definitions };
            throw new Error(`Unexpected request: ${options.method || "GET"} ${path}`);
        },
    });
    return { service, requests };
}

test("workspace item pagination includes completed work and reaches older ids using a bound snapshot", async () => {
    let page = 0;
    const { service, requests } = harness((request) => {
        if (request.path.endsWith("/wiql")) return { workItems: (++page === 1 ? [12000, 11999, 1] : [1]).map((id) => ({ id })) };
        if (request.path.endsWith("/workitems")) return { value: request.params.ids.split(",").map(Number).reverse().map((id) => raw(id, { "System.State": "Done" })) };
    });
    const first = await service.items(config, { pageSize: 2 });
    assert.deepEqual(first.workItems.map(({ id }) => id), [12000, 11999]);
    assert.deepEqual(first.workItems[0].tags, ["alpha", "beta"]);
    assert.ok(first.nextCursor);
    const second = await service.items(config, { pageSize: 2, cursor: first.nextCursor });
    assert.deepEqual(second.workItems.map(({ id }) => id), [1]);
    assert.equal(second.nextCursor, null);
    const queries = requests.filter(({ json }) => json?.query).map(({ json }) => json.query);
    assert.doesNotMatch(queries[0], /AssignedTo|NOT IN|System.State/);
    assert.match(queries[1], /\[System.Id\] < 11999/);
    assert.equal(queries[0].split(" ASOF ")[1], queries[1].split(" ASOF ")[1]);
    assert.equal(requests.find(({ params }) => params?.ids).params.asOf,
        JSON.parse(Buffer.from(first.nextCursor, "base64url")).asOf);
    await assert.rejects(service.items(config, { cursor: first.nextCursor, query: "different" }), { code: "azure_devops_invalid_cursor" });
    await assert.rejects(service.items({ ...config, project: "other" }, { cursor: first.nextCursor }), { code: "azure_devops_invalid_cursor" });
});

test("all workspace filter literals are escaped and empty assignee remains all work", async () => {
    const { service, requests } = harness(({ path }) => path.endsWith("/wiql") ? { workItems: [] } : undefined);
    await service.items(config, { query: "it's useful", assignee: "unassigned", state: "Won't do", type: "Custom's Type", tags: "blocked; team's" });
    const wiql = requests[0].json.query;
    assert.match(wiql, /CONTAINS 'it''s useful'/);
    assert.match(wiql, /AssignedTo\] = ''/);
    assert.match(wiql, /State\] = 'Won''t do'/);
    assert.match(wiql, /Type\] = 'Custom''s Type'/);
    assert.match(wiql, /Tags\] CONTAINS 'team''s'/);
    await assert.rejects(service.items(config, { cursor: "malformed" }), { code: "azure_devops_invalid_cursor" });
});

test("workspace item queries resolve a project-id connection to its project name", async () => {
    const { service, requests } = harness(({ path }) => {
        if (path === `_apis/projects/${projectId}`) return { id: projectId, name: "widgets" };
        if (path.endsWith("/wiql")) return { workItems: [] };
    });
    await service.items({ ...config, project: projectId });
    assert.match(requests.find(({ json }) => json?.query).json.query, /\[System.TeamProject\] = 'widgets'/);
});

test("metadata follows project continuation and reports actual project types and teams", async () => {
    const { service, requests } = harness(({ path, params }) => {
        if (path === "_apis/projects") return params.continuationToken
            ? { data: { value: [{ id: "b", name: "other" }] }, continuationToken: "" }
            : { data: { value: [{ id: projectId, name: "widgets" }] }, continuationToken: "next" };
        if (path.endsWith("/teams")) return { value: [{ id: "team", name: "Delivery" }] };
    });
    const result = await service.metadata(config);
    assert.equal(result.projects.length, 2);
    assert.equal(result.teams[0].name, "Delivery");
    assert.deepEqual(result.types[0].states[1], { name: "Done", category: "Completed", color: "" });
    assert.ok(requests.some(({ params }) => params?.continuationToken === "next"));
});

test("creation inherits parent context and creates its relation in the same transaction", async () => {
    const { service, requests } = harness(({ path, method }) => {
        if (path.endsWith("/42")) return raw(42, { "System.AreaPath": "widgets\\Delivery", "System.IterationPath": "widgets\\Sprint 3",
            "System.AssignedTo": { uniqueName: "owner@example.com", displayName: "Owner" } });
        if (method === "POST") return raw(43);
    });
    const result = await service.createItem(config, { type: "Task", title: "Child task", description: "<p>Details</p>", parentId: 42 });
    assert.equal(result.workItem.id, 43);
    const writes = requests.filter(({ method }) => method === "POST");
    assert.equal(writes.length, 1);
    assert.equal(writes[0].path, "widgets/_apis/wit/workitems/$Task");
    assert.deepEqual(writes[0].json.slice(-4), [
        { op: "add", path: "/fields/System.AssignedTo", value: "owner@example.com" },
        { op: "add", path: "/fields/System.AreaPath", value: "widgets\\Delivery" },
        { op: "add", path: "/fields/System.IterationPath", value: "widgets\\Sprint 3" },
        { op: "add", path: "/relations/-", value: { rel: "System.LinkTypes.Hierarchy-Reverse", url: `https://dev.azure.com/fabrikam/${projectId}/_apis/wit/workitems/42` } },
    ]);
    await assert.rejects(service.createItem(config, { type: "Unknown", title: "no" }), { code: "azure_devops_invalid_work_item_type" });
    await assert.rejects(service.createItem(config, { type: "Task", title: "no", description: "<script>bad</script>" }), { code: "azure_devops_unsupported_markup" });
    await assert.rejects(service.createItem(config, { type: "Task", title: "no", parentId: 0 }), { code: "azure_devops_invalid_workspace_input" });
});

test("creation refuses a parent from a different project before any write", async () => {
    const { service, requests } = harness(({ path }) => path.endsWith("/42") ? raw(42, { "System.TeamProject": "elsewhere" }) : undefined);
    await assert.rejects(service.createItem(config, { type: "Task", title: "Child", parentId: 42 }), { code: "azure_devops_work_item_project_mismatch" });
    assert.equal(requests.some(({ method }) => method === "POST"), false);
});

const columns = [
    { id: "todo", name: "Ready", isSplit: false, stateMappings: { Task: "Open" } },
    { id: "doing", name: "In progress", isSplit: true, stateMappings: { Task: "Active" } },
    { id: "done", name: "Complete", isSplit: false, stateMappings: { Task: "Done" } },
];
const boardData = { id: "board-id", name: "Tasks", columns,
    fields: { columnField: { referenceName: "WEF_123_Kanban.Column" }, doneField: { referenceName: "WEF_123_Kanban.Column.Done" } } };
function boardHarness(change) {
    return harness((request) => {
        const { path, method, params } = request;
        const response = change?.(request);
        if (response !== undefined) return response;
        if (path.endsWith("/boards/board-id")) return boardData;
        if (path.endsWith("/backlogs")) return { value: [{ id: "Microsoft.TaskCategory", name: "Tasks", workItemCountLimit: 1000, workItemTypes: [{ name: "Task" }] }] };
        if (path.endsWith("/backlogs/Microsoft.TaskCategory/workItems")) return { workItems: [{ target: { id: 42 } }] };
        if (path.endsWith("/workitems")) return { value: [raw(42, { "WEF_123_Kanban.Column": "In progress", "WEF_123_Kanban.Column.Done": true })] };
        if (path.endsWith("/42")) return method === "PATCH"
            ? raw(42, Object.fromEntries(request.json.filter(({ op }) => op === "add").map(({ path, value }) => [path.slice(8), value])))
            : raw(42);
    });
}

test("native board reads team backlog membership and actual split-column fields", async () => {
    const { service, requests } = boardHarness();
    const result = await service.board(config, "Delivery", "board-id");
    assert.equal(result.workItems[0].columnId, "doing");
    assert.equal(result.workItems[0].columnDone, true);
    assert.equal(result.workItems[0].rev, 7);
    assert.equal(result.truncated, false);
    assert.ok(requests.some(({ path }) => path === "widgets/Delivery/_apis/work/backlogs/Microsoft.TaskCategory/workItems"));
    assert.match(requests.find(({ params }) => params?.ids).params.fields, /WEF_123_Kanban.Column.Done/);
});

test("native board moves test rev and patch board-specific column, done and mapped state", async () => {
    const { service, requests } = boardHarness();
    const result = await service.move(config, "Delivery", "board-id", { id: 42, rev: 7, columnId: "doing", done: true });
    assert.equal(result.workItem.columnDone, true);
    assert.deepEqual(requests.find(({ method }) => method === "PATCH").json, [
        { op: "test", path: "/rev", value: 7 },
        { op: "add", path: "/fields/System.State", value: "Active" },
        { op: "add", path: "/fields/WEF_123_Kanban.Column", value: "In progress" },
        { op: "add", path: "/fields/WEF_123_Kanban.Column.Done", value: true },
    ]);
    await assert.rejects(service.move(config, "Delivery", "board-id", { id: 99, rev: 7, columnId: "doing", done: false }), { code: "azure_devops_item_not_on_board" });
    await assert.rejects(service.move(config, "Delivery", "board-id", { id: 42, rev: 7, columnId: "todo", done: true }), { code: "azure_devops_invalid_board_column" });
});

test("a board revision conflict is actionable and never retried without the revision", async () => {
    const { service, requests } = boardHarness(({ method }) => {
        if (method === "PATCH") throw new Error("test operation failed at /rev (VS403351)");
    });
    await assert.rejects(service.move(config, "Delivery", "board-id", { id: 42, rev: 1, columnId: "doing", done: false }), { code: "azure_devops_work_item_out_of_date" });
    assert.equal(requests.filter(({ method }) => method === "PATCH").length, 1);
});

test("dashboard uses process categories and supported blocked fields and counts incomplete children", async () => {
    const { service, requests } = harness(({ path, params, json }) => {
        if (path.endsWith("/fields")) return { value: [{ referenceName: "Microsoft.VSTS.CMMI.Blocked", type: "string" }] };
        if (path.endsWith("/wiql")) return { workItems: [{ id: 42 }] };
        if (path.endsWith("/workitems")) {
            if (params.$expand) return { value: [raw(42, {}, [
                { rel: "System.LinkTypes.Hierarchy-Forward", url: "https://dev.azure.com/fabrikam/_apis/wit/workitems/43" },
                { rel: "System.LinkTypes.Hierarchy-Forward", url: "https://dev.azure.com/fabrikam/_apis/wit/workitems/44" },
            ])] };
            return { value: params.ids.split(",").map(Number).map((id) => raw(id, { "System.State": id === 44 ? "Done" : "Open" })) };
        }
    });
    const result = await service.dashboard(config);
    assert.equal(result.unfinished.workItems[0].incompleteChildCount, 1);
    assert.equal(result.unfinished.workItems[0].unknownChildCount, 0);
    assert.equal(result.current.sampleLimit, 100);
    assert.equal(result.completed.days, 14);
    const queries = requests.filter(({ json }) => json?.query).map(({ json }) => json.query);
    assert.ok(queries.every((query) => query.includes("[System.AssignedTo] = @Me")));
    assert.ok(queries.some((query) => query.includes("[Microsoft.VSTS.CMMI.Blocked] = 'Yes'")));
    assert.ok(queries.some((query) => query.includes("[System.WorkItemType] = 'Task' AND [System.State] IN ('Done')")));
});

test("dashboard classifies existing disabled types while creation still rejects them", async () => {
    const { service, requests } = harness(({ path, params }) => {
        if (path.endsWith("/workitemtypes")) return { value: [...definitions,
            { name: "Ticket", isDisabled: true, states: [{ name: "Done", category: "Completed" }] }] };
        if (path.endsWith("/fields")) return { value: [] };
        if (path.endsWith("/wiql")) return { workItems: [{ id: 42 }] };
        if (path.endsWith("/workitems")) {
            if (params.$expand) return { value: [raw(42, {}, [
                { rel: "System.LinkTypes.Hierarchy-Forward", url: "https://dev.azure.com/fabrikam/_apis/wit/workitems/43" },
            ])] };
            return { value: params.ids.split(",").map(Number).map((id) => raw(id,
                id === 43 ? { "System.WorkItemType": "Ticket", "System.State": "Done" } : {})) };
        }
    });
    const result = await service.dashboard(config);
    assert.equal(result.unfinished.count, 0, "completed children of disabled types do not leave a parent unfinished");
    const queries = requests.filter(({ json }) => json?.query).map(({ json }) => json.query);
    assert.equal(queries.length, 4);
    assert.ok(queries.every((query) => query.includes("[System.WorkItemType] = 'Ticket' AND [System.State] IN ('Done')")));
    await assert.rejects(service.createItem(config, { type: "Ticket", title: "No new disabled item" }),
        { code: "azure_devops_invalid_work_item_type" });
    assert.equal(requests.some(({ method, path }) => method === "POST" && path.includes("/$")), false);
});

test("dashboard reports partial failures and sample limits with tag-only blocking when no Blocked field exists", async () => {
    const { service, requests } = harness(({ path, params, json }) => {
        if (path.endsWith("/fields")) return { value: [] };
        if (path.endsWith("/wiql")) {
            if (json.query.includes("@Today")) throw new Error("Recent activity unavailable");
            return { workItems: Array.from({ length: 101 }, (_, index) => ({ id: index + 1 })) };
        }
        if (path.endsWith("/workitems")) return { value: params.ids.split(",").map(Number).map((id) => raw(id)) };
    });
    const result = await service.dashboard(config);
    assert.equal(result.current.count, 100);
    assert.equal(result.current.truncated, true);
    assert.equal(result.current.sampleLimit, 100);
    assert.equal(result.completed.count, 0);
    assert.equal(result.completed.error, "Recent activity unavailable");
    assert.equal(result.blocked.error, "");
    const blocked = requests.find(({ json }) => json?.query.includes("CONTAINS 'blocked'"));
    assert.ok(blocked);
    assert.doesNotMatch(blocked.json.query, /\.Blocked\]/);
});

test("attachment upload accepts empty bytes and links canonical selected-project URL with a revision test", async () => {
    const { service, requests } = harness(({ path, method }) => {
        if (path.endsWith("/attachments")) return { id: attachmentId, url: "https://attacker.example/ignored" };
        if (path.endsWith("/42")) return method === "PATCH" ? { ...raw(42), rev: 8 } : raw(42);
    });
    const result = await service.upload(config, 42, "empty.txt", Buffer.alloc(0));
    assert.equal(result.rev, 8);
    assert.equal(result.attachment.url, `https://dev.azure.com/fabrikam/${projectId}/_apis/wit/attachments/${attachmentId}?fileName=empty.txt`);
    const upload = requests.find(({ method }) => method === "POST");
    assert.equal(upload.path, `${projectId}/_apis/wit/attachments`);
    assert.equal(upload.headers["Content-Type"], "application/octet-stream");
    assert.equal(upload.body.length, 0);
    const link = requests.find(({ method }) => method === "PATCH");
    assert.deepEqual(link.json[0], { op: "test", path: "/rev", value: 7 });
    assert.equal(link.json[1].value.rel, "AttachedFile");
    await assert.rejects(service.upload(config, 42, "../secret.txt", Buffer.alloc(0)), { code: "azure_devops_invalid_file_name" });
});

test("attachment link failures tell the caller the upload happened and preserve revision protection", async () => {
    const { service } = harness(({ path, method }) => {
        if (path.endsWith("/attachments")) return { id: attachmentId };
        if (method === "PATCH") throw new Error("test failed /rev");
        if (path.endsWith("/42")) return raw(42);
    });
    await assert.rejects(service.upload(config, 42, "file.png", Buffer.from([1])), (error) => error.code === "azure_devops_attachment_link_failed" && /uploaded but could not be attached/.test(error.message));
});

test("raw upload reader enforces inclusive 60 MiB for advertised and chunked bodies", async () => {
    const failure = () => new Error("too large");
    let pulls = 0;
    const request = (chunks, length) => ({ headers: length === undefined ? {} : { "content-length": String(length) },
        async *[Symbol.asyncIterator]() { for (const chunk of chunks) { pulls++; yield chunk; } } });
    const exact = Buffer.alloc(MAX_UPLOAD_BYTES);
    assert.equal((await readBoundedBody(request([exact]), MAX_UPLOAD_BYTES, failure)).length, MAX_UPLOAD_BYTES);
    pulls = 0;
    await assert.rejects(readBoundedBody(request([Buffer.from([1])], MAX_UPLOAD_BYTES + 1), MAX_UPLOAD_BYTES, failure), /too large/);
    assert.equal(pulls, 0);
    await assert.rejects(readBoundedBody(request([exact, Buffer.from([1])]), MAX_UPLOAD_BYTES, failure), /too large/);
    assert.equal(pulls, 2);
});
