import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclipai.plugin-quipo",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Quipo",
  description:
    "Cross-issue memory plugin. Stores extracted facts, session summaries, and peer models in a plugin-owned ctx.db schema. RED-98 delivers manifest, schema migrations, and base tables; agent tooling, event handlers, and UI ship in subsequent issues.",
  author: "Paperclip",
  categories: ["automation", "workspace"],
  capabilities: [
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "issues.read",
    "issue.comments.read",
    "agents.read",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  database: {
    namespaceSlug: "quipo",
    migrationsDir: "migrations",
    coreReadTables: ["issues", "issue_comments", "agents", "companies"],
  },
};

export default manifest;
