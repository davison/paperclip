/**
 * Tool-side types for the Quipo plugin tools (RED-101).
 *
 * Tools are unit-tested against a tiny `MemoryDb` interface that mirrors the
 * subset of `ctx.db` they actually use. The worker wires the SDK's
 * `PluginDatabaseClient` into this interface in `src/tools/index.ts`.
 */

export interface MemoryDb {
  /** Host-derived plugin namespace (e.g. `plugin_quipo_d14f4ce0c0`). */
  readonly namespace: string;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

/** Subset of `ctx.agents` the `memory_ask_peer` tool needs. */
export interface AgentInvoker {
  invoke(
    agentId: string,
    companyId: string,
    opts: { prompt: string; reason?: string },
  ): Promise<{ runId: string }>;
}

/** Run context the host hands a plugin tool — only the fields the tools use. */
export interface ToolRun {
  agentId: string;
  runId: string;
  companyId: string;
  projectId: string;
}

/** Mirrors the SDK's `ToolResult` so this module does not need a hard SDK
 *  import (keeps the unit-tests fast and avoids a build-order coupling). */
export interface ToolReturn {
  content?: string;
  data?: unknown;
  error?: string;
}

export interface FactRow {
  id: string;
  content: string;
  about_peer: "agent" | "user" | null;
  confidence: number | string;
  level: string;
  issue_id: string | null;
  agent_id: string | null;
  metadata: unknown;
  created_at: string;
  /** Trigram similarity vs. query, populated by ranked search queries. */
  sim?: number | string;
}

export interface SessionRow {
  id: string;
  issue_id: string;
  summary: string | null;
  fact_count: number | string;
  updated_at: string;
  sim?: number | string;
}

export interface PeerModelRow {
  id: string;
  agent_id: string;
  model: string | null;
  fact_count: number | string;
  updated_at: string;
}
