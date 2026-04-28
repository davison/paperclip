/**
 * Tool registration for the Quipo memory plugin (RED-101).
 *
 * `registerQuipoTools(ctx)` is called from `setup()` in `src/worker.ts` and
 * wires the five Phase 1 MVP tools onto `ctx.tools`. The tool *logic* lives
 * in sibling files and is unit-tested against thin `MemoryDb` / `AgentInvoker`
 * shims; this module is the SDK-side glue and stays small.
 */

import type { PluginContext, ToolResult } from "@paperclipai/plugin-sdk";

import {
  MEMORY_SEARCH_PARAMETERS_SCHEMA,
  runMemorySearch,
} from "./memory-search.js";
import {
  MEMORY_SEARCH_CONCLUSIONS_PARAMETERS_SCHEMA,
  runMemorySearchConclusions,
} from "./memory-search-conclusions.js";
import {
  MEMORY_GET_ISSUE_CONTEXT_PARAMETERS_SCHEMA,
  runMemoryGetIssueContext,
} from "./memory-get-issue-context.js";
import {
  MEMORY_GET_PEER_CONTEXT_PARAMETERS_SCHEMA,
  runMemoryGetPeerContext,
} from "./memory-get-peer-context.js";
import {
  MEMORY_ASK_PEER_PARAMETERS_SCHEMA,
  runMemoryAskPeer,
} from "./memory-ask-peer.js";

export const QUIPO_TOOL_NAMES = {
  search: "memory_search",
  searchConclusions: "memory_search_conclusions",
  getIssueContext: "memory_get_issue_context",
  getPeerContext: "memory_get_peer_context",
  askPeer: "memory_ask_peer",
} as const;

export const QUIPO_TOOL_DECLARATIONS = [
  {
    name: QUIPO_TOOL_NAMES.search,
    displayName: "Memory: search facts",
    description:
      "Trigram-search the Quipo memory store for facts matching a free-form query. Returns ranked candidates the calling agent can rerank in its own LLM context.",
    parametersSchema: MEMORY_SEARCH_PARAMETERS_SCHEMA,
  },
  {
    name: QUIPO_TOOL_NAMES.searchConclusions,
    displayName: "Memory: search conclusions",
    description:
      "Search rolling issue-level conclusion summaries by trigram similarity. Useful for finding past issues whose decisions match a query.",
    parametersSchema: MEMORY_SEARCH_CONCLUSIONS_PARAMETERS_SCHEMA,
  },
  {
    name: QUIPO_TOOL_NAMES.getIssueContext,
    displayName: "Memory: issue context",
    description:
      "Fetch every fact, the rolling session summary, and peer models for one issue.",
    parametersSchema: MEMORY_GET_ISSUE_CONTEXT_PARAMETERS_SCHEMA,
  },
  {
    name: QUIPO_TOOL_NAMES.getPeerContext,
    displayName: "Memory: peer context",
    description:
      "Fetch the peer model and recent facts for one agent or user peer.",
    parametersSchema: MEMORY_GET_PEER_CONTEXT_PARAMETERS_SCHEMA,
  },
  {
    name: QUIPO_TOOL_NAMES.askPeer,
    displayName: "Memory: ask a peer",
    description:
      "Wake another agent and ask it a question. Returns the queued run id; the peer answers asynchronously.",
    parametersSchema: MEMORY_ASK_PEER_PARAMETERS_SCHEMA,
  },
] as const;

export function registerQuipoTools(ctx: PluginContext): void {
  ctx.tools.register(
    QUIPO_TOOL_NAMES.search,
    {
      displayName: "Memory: search facts",
      description:
        "Trigram-search the Quipo memory store for facts matching a free-form query.",
      parametersSchema: MEMORY_SEARCH_PARAMETERS_SCHEMA,
    },
    async (params, runCtx): Promise<ToolResult> => {
      return runMemorySearch({ db: ctx.db }, params, runCtx);
    },
  );

  ctx.tools.register(
    QUIPO_TOOL_NAMES.searchConclusions,
    {
      displayName: "Memory: search conclusions",
      description:
        "Search rolling issue-level conclusion summaries by trigram similarity.",
      parametersSchema: MEMORY_SEARCH_CONCLUSIONS_PARAMETERS_SCHEMA,
    },
    async (params, runCtx): Promise<ToolResult> => {
      return runMemorySearchConclusions({ db: ctx.db }, params, runCtx);
    },
  );

  ctx.tools.register(
    QUIPO_TOOL_NAMES.getIssueContext,
    {
      displayName: "Memory: issue context",
      description:
        "Fetch every fact, the rolling session summary, and peer models for one issue.",
      parametersSchema: MEMORY_GET_ISSUE_CONTEXT_PARAMETERS_SCHEMA,
    },
    async (params, runCtx): Promise<ToolResult> => {
      return runMemoryGetIssueContext({ db: ctx.db }, params, runCtx);
    },
  );

  ctx.tools.register(
    QUIPO_TOOL_NAMES.getPeerContext,
    {
      displayName: "Memory: peer context",
      description: "Fetch the peer model and recent facts for one peer.",
      parametersSchema: MEMORY_GET_PEER_CONTEXT_PARAMETERS_SCHEMA,
    },
    async (params, runCtx): Promise<ToolResult> => {
      return runMemoryGetPeerContext({ db: ctx.db }, params, runCtx);
    },
  );

  ctx.tools.register(
    QUIPO_TOOL_NAMES.askPeer,
    {
      displayName: "Memory: ask a peer",
      description:
        "Wake another agent and ask it a question. Returns the queued run id.",
      parametersSchema: MEMORY_ASK_PEER_PARAMETERS_SCHEMA,
    },
    async (params, runCtx): Promise<ToolResult> => {
      return runMemoryAskPeer({ agents: ctx.agents }, params, runCtx);
    },
  );
}

export {
  runMemorySearch,
  runMemorySearchConclusions,
  runMemoryGetIssueContext,
  runMemoryGetPeerContext,
  runMemoryAskPeer,
};

export type { MemoryDb, AgentInvoker, ToolRun, ToolReturn } from "./types.js";
