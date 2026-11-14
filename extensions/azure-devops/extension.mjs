import { createCanvas, joinSession } from "@github/copilot-sdk/extension";
import {
    canvasTitle,
    serializeCanvasInput,
    setCopilotSession,
    startServer,
} from "./canvas-server.mjs";
import { hasWorkItemReference } from "./work-item.mjs";

const servers = new Map();


const canvasInputSchema = {
    type: "object",
    additionalProperties: false,
    anyOf: [
        { maxProperties: 0 },
        { required: ["workItemUrl"] },
        { required: ["organization", "project", "workItemId"] },
        { required: ["org", "project", "workItemId"] },
    ],
    properties: {
        workItemUrl: { type: "string", minLength: 1 },
        organization: { type: "string", minLength: 1 },
        org: { type: "string", minLength: 1 },
        project: { type: "string", minLength: 1 },
        workItemId: { type: "number", minimum: 1 },
    },
};

const showReferenceSchema = {
    type: "object",
    additionalProperties: false,
    anyOf: [
        { required: ["url"] },
        { required: ["organization", "project", "id"] },
        { required: ["org", "project", "id"] },
    ],
    properties: {
        url: { type: "string", minLength: 1 },
        organization: { type: "string", minLength: 1 },
        org: { type: "string", minLength: 1 },
        project: { type: "string", minLength: 1 },
        id: { type: "number", minimum: 1 },
    },
};

function referenceInput(input) {
    if (input.url) {
        return { workItemUrl: input.url };
    }
    return {
        organization: input.organization || input.org,
        project: input.project,
        workItemId: input.id,
    };
}

let session;

async function showReference(ctx) {
    return session.rpc.canvas.open({
        extensionId: ctx.extensionId,
        canvasId: ctx.canvasId,
        instanceId: ctx.instanceId,
        input: referenceInput(ctx.input || {}),
    });
}

session = await joinSession({
    canvases: [
        createCanvas({
            id: "azure-devops",
            displayName: "Azure DevOps",
            description: "Browse and manage Azure Boards work items from a canvas.",
            inputSchema: canvasInputSchema,
            actions: [
                {
                    name: "show_ado_work_item",
                    description: "Show an Azure DevOps work item from its URL or organization, project, and ID.",
                    inputSchema: showReferenceSchema,
                    handler: showReference,
                },
            ],
            open: async (ctx) => {
                let entry = servers.get(ctx.instanceId);
                if (!entry) {
                    entry = await startServer(ctx.instanceId, ctx.input || {});
                    servers.set(ctx.instanceId, entry);
                } else {
                    const input = ctx.input || {};
                    if (serializeCanvasInput(entry.input) !== serializeCanvasInput(input)) {
                        await new Promise((resolve, reject) => entry.server.close((error) => error ? reject(error) : resolve()));
                        entry = await startServer(ctx.instanceId, input);
                        servers.set(ctx.instanceId, entry);
                    }
                }
                return {
                    title: canvasTitle(entry.input),
                    status: hasWorkItemReference(entry.input)
                        ? "Work Item"
                        : "My work",
                    url: entry.url,
                };
            },
            onClose: async (ctx) => {
                const entry = servers.get(ctx.instanceId);
                if (entry) {
                    servers.delete(ctx.instanceId);
                    await new Promise((resolve, reject) => entry.server.close((error) => error ? reject(error) : resolve()));
                }
            },
        }),
    ],
});

setCopilotSession(session);
