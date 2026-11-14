import assert from "node:assert/strict";
import test from "node:test";
import { createTaskSuggestionService } from "./task-suggestions.mjs";

const scope = { account: "person-a", organization: "contoso", project: "Northwind", id: 42 };
function harness() {
    const sent = [], created = [];
    const parent = { detail: { id: 42, rev: 3, title: "Improve search", type: "User Story", project: "Northwind", assignedTo: "Alex Morgan", relations: [], discussion: [], webUrl: "https://dev.azure.com/contoso/Northwind/_workitems/edit/42" }, raw: { fields: { "System.Title": "Improve search", "System.Description": "<p>Find records</p>" } } };
    let sequence = 0;
    const service = createTaskSuggestionService({ instanceId: "canvas-one", ErrorType: class extends Error { constructor(code, message) { super(message); this.code = code; } },
        newId: () => `request-${++sequence}`, loadParent: async () => parent,
        send: async options => { sent.push(options); },
        createTask: async (config, body) => { created.push({ config, body }); return { workItem: { id: 100 + created.length, title: body.title } }; },
    });
    return { service, sent, created, parent };
}
const proposal = (requestId, tasks = [{ title: "Build search", description: "Implement <search>", doneWhen: "Results appear" }]) => ({ requestId, tasks, questions: [] });

test("suggestions only enqueue context and accept proposals for their bound request/account", async () => {
    const { service, sent, created } = harness();
    const draft = await service.start(scope);
    assert.equal((await service.start(scope)).requestId, draft.requestId);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].mode, "enqueue");
    for (const text of ["propose_ado_tasks", draft.requestId, "canvas-one", "Find records", "existing child", "Do not create"]) assert.ok(sent[0].prompt.includes(text), text);
    assert.doesNotMatch(sent[0].prompt, /Briefly acknowledge it and wait/);
    assert.deepEqual(created, []);
    assert.equal(service.get({ ...scope, account: "person-b" }), null);
    assert.throws(() => service.receive(proposal(draft.requestId), "person-b"), /account|request/i);
    assert.throws(() => service.receive(proposal("unknown"), scope.account), /request/i);
    service.receive(proposal(draft.requestId), scope.account);
    assert.equal(service.get(scope).tasks[0].title, "Build search");
    assert.deepEqual(created, []);
});

test("reviewed creation escapes plain text, links the parent, inherits by default and is replay-safe", async () => {
    const { service, created } = harness();
    const draft = await service.start(scope);
    service.receive(proposal(draft.requestId), scope.account);
    const ready = service.get(scope);
    const input = { requestId: ready.requestId, version: ready.version, tasks: ready.tasks, assigneeMode: "parent" };
    const result = await service.create(scope, input);
    assert.equal(result.tasks[0].state, "created");
    assert.equal(created[0].body.parentId, 42);
    assert.equal(created[0].body.type, "Task");
    assert.equal(created[0].body.assignedTo, undefined);
    assert.match(created[0].body.description, /&lt;search&gt;/);
    assert.match(created[0].body.description, /Done when/);
    await service.create(scope, input);
    assert.equal(created.length, 1);
    assert.throws(() => service.receive(proposal(ready.requestId), scope.account), /creation|created/i);
});

test("stale proposals, changed requirements and duplicate child titles cannot create tasks", async () => {
    const { service, created, parent } = harness();
    const draft = await service.start(scope);
    service.receive(proposal(draft.requestId), scope.account);
    const ready = service.get(scope);
    const input = { requestId: ready.requestId, version: ready.version, tasks: ready.tasks };
    await assert.rejects(service.create(scope, { ...input, version: 0 }), /changed|refresh/i);
    parent.raw.fields["System.Description"] = "Changed requirements";
    await assert.rejects(service.create(scope, input), /story changed|parent changed/i);
    parent.raw.fields["System.Description"] = "<p>Find records</p>";
    parent.detail.relations = [{ name: "Children", links: [{ title: "  BUILD  SEARCH " }] }];
    await assert.rejects(service.create(scope, input), /already|duplicate/i);
    assert.deepEqual(created, []);
});

test("proposal validation bounds content and supports clarification without invented tasks", async () => {
    const { service } = harness();
    const draft = await service.start(scope);
    for (const tasks of [[{ title: "" }], Array.from({ length: 13 }, () => ({ title: "Task", description: "", doneWhen: "" })), [{ title: "T", description: "x".repeat(8001), doneWhen: "" }]])
        assert.throws(() => service.receive(proposal(draft.requestId, tasks), scope.account));
    service.receive({ requestId: draft.requestId, tasks: [], questions: ["Which records can be searched?"] }, scope.account);
    assert.equal(service.get(scope).questions.length, 1);
});

test("partial failure keeps created receipts and prevents retries of uncertain writes", async () => {
    let writes = 0;
    const failing = createTaskSuggestionService({ instanceId: "canvas", ErrorType: Error, newId: () => "partial", loadParent: async () => ({ detail: { id: 42, relations: [] }, raw: { fields: {} } }), send: async () => {},
        createTask: async () => { if (++writes === 2) throw new Error("Connection lost"); return { workItem: { id: 101 } }; },
    });
    const draft = await failing.start(scope);
    failing.receive(proposal(draft.requestId, ["First", "Second", "Third"].map(title => ({ title, description: "", doneWhen: "" }))), scope.account);
    const ready = failing.get(scope);
    const input = { requestId: ready.requestId, version: ready.version, tasks: ready.tasks };
    const result = await failing.create(scope, input);
    assert.deepEqual(result.tasks.map(task => task.state), ["created", "uncertain", "proposed"]);
    assert.match(result.tasks[1].error, /Check ADO/i);
    await failing.create(scope, { ...input, tasks: input.tasks.slice(0, 2) });
    assert.equal(writes, 2);
});

test("incomplete existing child summaries block generation and duplicate-sensitive creation", async () => {
    const { service, parent, sent, created } = harness();
    parent.detail.relations = [{ name: "Children", links: [{ id: 43, title: "" }] }];
    await assert.rejects(service.start(scope), /child.*read|child.*load/i);
    assert.equal(sent.length, 0);
    parent.detail.relations = [];
    const started = await service.start(scope); service.receive(proposal(started.requestId), scope.account);
    const ready = service.get(scope);
    parent.detail.relations = [{ name: "Children", links: [{ id: 43, title: "" }] }];
    await assert.rejects(service.create(scope, { requestId: ready.requestId, version: ready.version, tasks: ready.tasks }), /child.*read|child.*load/i);
    assert.equal(created.length, 0);
});
