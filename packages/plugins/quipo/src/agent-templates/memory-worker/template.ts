import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import type { AgentRole } from "@paperclipai/shared";

export interface MemoryWorkerAgentTemplate {
  /** Stable plugin-scoped identifier. Settings UI (RED-102) uses this as the
   *  default name slug when creating the agent for a company. */
  readonly nameKey: string;
  /** Human-readable display name shown in agent pickers. */
  readonly displayName: string;
  /** Role from the host's `AGENT_ROLES` enum. The deliverable description
   *  calls this a "worker" agent operationally; the host enum doesn't have a
   *  `worker` value, so we map it to `general` (non-leader, no department). */
  readonly role: AgentRole;
  /** Short description shown in onboarding / settings UI. */
  readonly summary: string;
  /** Markdown body of the agent's AGENTS.md file. The plugin SDK does not yet
   *  expose an `agents.create` API, so RED-100 ships the template as data;
   *  RED-102 (settings UI) and RED-103 (backfill action) will install it via
   *  the host's onboarding/agent-create routes. */
  readonly instructionsMarkdown: string;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

function loadInstructions(): string {
  // The compiled bundle inlines this file as a sibling of the worker entry
  // (esbuild copies the markdown via the loader-text rule), but for ts-node
  // / vitest we read it from disk relative to this module's URL.
  const candidate = path.resolve(HERE, "AGENTS.md");
  return readFileSync(candidate, "utf8");
}

export const MEMORY_WORKER_AGENT_TEMPLATE: MemoryWorkerAgentTemplate = {
  nameKey: "memory-worker",
  displayName: "Memory Worker",
  role: "general",
  summary:
    "Extracts atomic facts from new comments and updates so other agents can recall them across issues. Owned by the Quipo memory plugin.",
  get instructionsMarkdown() {
    return loadInstructions();
  },
};
