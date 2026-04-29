// Public exports for downstream Quipo deliverables (RED-99 event handlers,
// RED-101 plugin tools, RED-102 settings UI, RED-103 backfill action).
//
// The bundled worker entry (`src/worker.ts`) does NOT import this barrel —
// the `src/agent-templates/memory-worker/template.ts` module reads its
// AGENTS.md from disk at module load and is meant for host-side consumption,
// not the bundled worker.

export {
  ABOUT_PEER_VALUES,
  EXTRACT_FACTS_SYSTEM_PROMPT,
  buildExtractFactsUserPrompt,
  extractedFactSchema,
  extractedFactsJsonSchema,
  extractedFactsResponseSchema,
  parseExtractedFactsResponse,
} from "./prompts/extract-facts.js";

export type {
  AboutPeer,
  ExtractFactsContext,
  ExtractedFact,
  ExtractedFactsResponse,
} from "./prompts/extract-facts.js";

export { MEMORY_WORKER_AGENT_TEMPLATE } from "./agent-templates/memory-worker/template.js";

export type { MemoryWorkerAgentTemplate } from "./agent-templates/memory-worker/template.js";

export {
  QUIPO_TOOL_NAMES,
  QUIPO_TOOL_DECLARATIONS,
  registerQuipoTools,
  runMemorySearch,
  runMemorySearchConclusions,
  runMemoryGetIssueContext,
  runMemoryGetPeerContext,
  runMemoryAskPeer,
} from "./tools/index.js";

export type {
  MemoryDb,
  AgentInvoker,
  ToolRun,
  ToolReturn,
} from "./tools/index.js";

export {
  QUIPO_BACKFILL_ACTION_KEY,
  registerQuipoBackfillAction,
  runBackfill,
} from "./backfill.js";

export type { BackfillParams, BackfillSummary } from "./backfill.js";

export { default as manifest } from "./manifest.js";
