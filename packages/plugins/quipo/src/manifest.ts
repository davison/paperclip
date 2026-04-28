import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

import { QUIPO_TOOL_DECLARATIONS } from "./tools/index.js";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclipai.plugin-quipo",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Quipo",
  description:
    "Cross-issue memory plugin. Stores extracted facts, session summaries, and peer models in a plugin-owned ctx.db schema. Event handlers route new comments and issue updates to a configured Memory Agent for fact extraction. Plugin-contributed tools (memory_search and friends) let agents recall stored memory during their runs.",
  author: "Paperclip",
  categories: ["automation", "workspace"],
  capabilities: [
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "issues.read",
    "issues.create",
    "issue.comments.read",
    "agents.read",
    "agents.invoke",
    "agent.tools.register",
    "events.subscribe",
    "plugin.state.read",
    "plugin.state.write",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      memoryAgentId: {
        type: "string",
        title: "Memory Agent",
        description:
          "UUID of the Paperclip agent that performs fact extraction. Required for the plugin to act on issue.comment.created and issue.updated events.",
      },
    },
  },
  database: {
    namespaceSlug: "quipo",
    migrationsDir: "migrations",
    coreReadTables: ["issues", "issue_comments", "agents", "companies"],
  },
  tools: QUIPO_TOOL_DECLARATIONS.map((decl) => ({
    name: decl.name,
    displayName: decl.displayName,
    description: decl.description,
    parametersSchema: decl.parametersSchema,
  })),
};

export default manifest;
