import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

import { QUIPO_TOOL_DECLARATIONS } from "./tools/index.js";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclipai.plugin-quipo",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Quipo",
  description:
    "Cross-issue memory plugin. Stores extracted facts, session summaries, and peer models in a plugin-owned ctx.db schema. Event handlers route new comments and issue updates to a configured Memory Agent for fact extraction. Plugin-contributed tools (memory_search and friends) let agents recall stored memory during their runs. Per-company settings page enables/disables ingestion, picks the Memory Agent, and toggles extraction scope.",
  author: "Paperclip",
  categories: ["automation", "workspace"],
  capabilities: [
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "issues.read",
    "issues.create",
    "issues.update",
    "issues.wakeup",
    "issue.comments.read",
    "issue.comments.create",
    "agents.read",
    "agents.invoke",
    "agent.tools.register",
    "events.subscribe",
    "plugin.state.read",
    "plugin.state.write",
    "instance.settings.register",
    "metrics.write",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: {
        type: "boolean",
        title: "Enabled",
        description:
          "Master switch for this company. When false, Quipo ignores comment/update events and the configured Memory Agent is not woken.",
        default: false,
      },
      memoryAgentId: {
        type: "string",
        title: "Memory Agent",
        description:
          "UUID of the Paperclip agent that performs fact extraction. Required for the plugin to act on issue.comment.created and issue.updated events.",
      },
      extractionScope: {
        type: "string",
        title: "Extraction Scope",
        description:
          "Which event surfaces feed Quipo. \"comments_and_updates\" extracts from both new comments and fact-bearing issue patches (title/description). \"comments_only\" ignores issue updates and limits ingestion to new comments.",
        enum: ["comments_and_updates", "comments_only"],
        default: "comments_and_updates",
      },
    },
  },
  ui: {
    slots: [
      {
        type: "settingsPage",
        id: "quipo-settings",
        displayName: "Quipo Settings",
        exportName: "QuipoSettingsPage",
      },
    ],
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
