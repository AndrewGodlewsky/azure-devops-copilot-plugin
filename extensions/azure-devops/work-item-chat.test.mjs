import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkItemChatPrompt, MAX_CHAT_PROMPT_CHARS } from "./work-item-chat.mjs";

const detail = {
    id: 42, rev: 7, type: "User Story", title: "Improve search", state: "Active",
    assignedTo: "Alex Morgan", project: "Northwind", area: "Northwind", iteration: "Sprint 2",
    webUrl: "https://dev.azure.com/contoso/Northwind/_workitems/edit/42",
    relations: [{ name: "Children", links: [{ id: 43, label: "Task 43", title: "Add tests", state: "New" }] }],
    discussion: [{ author: "Sam Lee", createdDate: "2026-01-02", text: "<p>Include keyboard navigation.</p>", format: "html" }],
};

test("chat snapshot includes the link and saved context even without a form template", () => {
    const prompt = buildWorkItemChatPrompt(detail, { fields: {
        "System.Description": "<p>Search <strong>all results</strong>.</p>",
        "Microsoft.VSTS.Common.AcceptanceCriteria": "<ul><li>Results are accessible</li></ul>",
    } });
    for (const text of [detail.webUrl, "User Story #42", "Improve search", "revision 7", "Active", "Alex Morgan",
        "Search all results", "Acceptance criteria", "Results are accessible", "Task 43", "Add tests", "Sam Lee", "Include keyboard navigation"])
        assert.ok(prompt.includes(text), text);
    assert.doesNotMatch(prompt, /<p>|<strong>|<li>/);
    assert.match(prompt, /wait for my instructions/i);
    assert.match(prompt, /reference material/i);
});

test("chat snapshot preserves Markdown code and links and excludes attachment payloads", () => {
    const markdown = "Use List<string>. See [spec](https://example.com/spec).\n```ts\nconst a = 1;\n```";
    const prompt = buildWorkItemChatPrompt({ ...detail, relations: [
        ...detail.relations, { name: "Attachments", links: [{ title: "payload", webUrl: "data:image/png;base64,SECRET" }] },
    ] }, { fields: { "System.Description": markdown }, multilineFieldsFormat: { "system.description": "Markdown" } });
    assert.ok(prompt.includes(markdown));
    assert.doesNotMatch(prompt, /SECRET/);
});

test("chat snapshot recognizes ADO numeric HTML and Markdown formats", () => {
    for (const htmlFormat of [1, "1", "HTML"]) {
        const prompt = buildWorkItemChatPrompt(detail, {
            fields: { "System.Description": '<p>Saved <strong>description</strong><img src="data:image/png;base64,PAYLOAD"></p>' },
            multilineFieldsFormat: { "System.Description": htmlFormat },
        });
        assert.match(prompt, /Saved description/);
        assert.doesNotMatch(prompt, /<strong>|PAYLOAD/);
    }
    for (const markdownFormat of [0, "0", "Markdown"]) {
        const prompt = buildWorkItemChatPrompt(detail, { fields: { "System.Description": "Use List<string> here." }, multilineFieldsFormat: { "System.Description": markdownFormat } });
        assert.match(prompt, /List<string>/);
    }
});

test("large context stays bounded while retaining link, criteria, children and recent comments", () => {
    const prompt = buildWorkItemChatPrompt({ ...detail,
        relations: [{ name: "Children", links: Array.from({ length: 100 }, (_, i) => ({ id: i + 1, label: `Task ${i + 1}`, title: "T".repeat(1000), state: "New" })) }],
        discussion: Array.from({ length: 50 }, (_, i) => ({ author: "Sam Lee", text: `Comment ${i} ` + "C".repeat(9000), format: "markdown" })),
    }, { fields: { "System.Description": "D".repeat(50000), "Microsoft.VSTS.Common.AcceptanceCriteria": "Criteria " + "A".repeat(50000) } });
    assert.ok(prompt.length <= MAX_CHAT_PROMPT_CHARS, prompt.length);
    for (const text of [detail.webUrl, "Acceptance criteria", "Criteria", "Task 1", "Comment 0", "omitted", "truncated"])
        assert.ok(prompt.includes(text), text);
    assert.doesNotMatch(prompt, /Comment 3 /);
});
