/**
 * `memory_get_issue_context` — bundle every memory record tied to one issue.
 *
 * Pulls back: every fact extracted from the issue, the rolling session
 * summary (if any), and the peer models for each agent that has authored a
 * fact on the issue. The agent uses this to remind itself of what was
 * decided, learned, or agreed before resuming work on a long-lived ticket.
 */

import { qualify } from "./sql.js";
import type {
  FactRow,
  MemoryDb,
  PeerModelRow,
  SessionRow,
  ToolReturn,
  ToolRun,
} from "./types.js";

export interface MemoryGetIssueContextParams {
  issue_id: string;
  include_peer_models?: boolean;
  fact_limit?: number;
}

export const MEMORY_GET_ISSUE_CONTEXT_PARAMETERS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["issue_id"],
  properties: {
    issue_id: {
      type: "string",
      format: "uuid",
      description: "UUID of the issue to fetch memory for.",
    },
    include_peer_models: {
      type: "boolean",
      default: true,
      description:
        "When true, include peer-model summaries for every agent that has facts on this issue.",
    },
    fact_limit: {
      type: "integer",
      minimum: 1,
      maximum: 200,
      default: 50,
      description: "Maximum number of facts to return, newest first.",
    },
  },
} as const;

const DEFAULT_FACT_LIMIT = 50;
const MAX_FACT_LIMIT = 200;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ParsedParams {
  issueId: string;
  includePeerModels: boolean;
  factLimit: number;
}

function parseParams(raw: unknown): ParsedParams | { error: string } {
  if (raw === null || typeof raw !== "object") {
    return { error: "params must be an object" };
  }
  const params = raw as Record<string, unknown>;

  const issueId = params["issue_id"];
  if (typeof issueId !== "string" || !UUID_RE.test(issueId)) {
    return { error: "`issue_id` is required and must be a UUID" };
  }

  let includePeerModels = true;
  if ("include_peer_models" in params) {
    const v = params["include_peer_models"];
    if (typeof v !== "boolean" && v !== undefined && v !== null) {
      return { error: "`include_peer_models` must be a boolean" };
    }
    if (typeof v === "boolean") includePeerModels = v;
  }

  let factLimit = DEFAULT_FACT_LIMIT;
  if ("fact_limit" in params) {
    const v = params["fact_limit"];
    if (v !== undefined && v !== null) {
      if (typeof v !== "number" || !Number.isInteger(v) || !Number.isFinite(v)) {
        return { error: "`fact_limit` must be an integer" };
      }
      if (v < 1 || v > MAX_FACT_LIMIT) {
        return { error: `\`fact_limit\` must be in [1, ${MAX_FACT_LIMIT}]` };
      }
      factLimit = v;
    }
  }

  return { issueId, includePeerModels, factLimit };
}

export async function runMemoryGetIssueContext(
  deps: { db: MemoryDb },
  params: unknown,
  runCtx: ToolRun,
): Promise<ToolReturn> {
  const parsed = parseParams(params);
  if ("error" in parsed) {
    return { error: parsed.error };
  }

  const ns = deps.db.namespace;
  const factsTable = qualify(ns, "facts");
  const sessionsTable = qualify(ns, "sessions");
  const peersTable = qualify(ns, "peer_models");

  const factRows = await deps.db.query<FactRow>(
    `SELECT id, content, about_peer, confidence, level, issue_id, agent_id,
            metadata, created_at
     FROM ${factsTable}
     WHERE company_id = $1 AND issue_id = $2
     ORDER BY created_at DESC
     LIMIT $3`,
    [runCtx.companyId, parsed.issueId, parsed.factLimit],
  );

  const sessionRows = await deps.db.query<SessionRow>(
    `SELECT id, issue_id, summary, fact_count, updated_at
     FROM ${sessionsTable}
     WHERE company_id = $1 AND issue_id = $2
     LIMIT 1`,
    [runCtx.companyId, parsed.issueId],
  );

  let peerRows: PeerModelRow[] = [];
  if (parsed.includePeerModels) {
    const agentIds = new Set<string>();
    for (const row of factRows) {
      if (row.agent_id) agentIds.add(row.agent_id);
    }
    if (agentIds.size > 0) {
      peerRows = await deps.db.query<PeerModelRow>(
        `SELECT id, agent_id, model, fact_count, updated_at
         FROM ${peersTable}
         WHERE company_id = $1 AND agent_id = ANY($2::uuid[])`,
        [runCtx.companyId, Array.from(agentIds)],
      );
    }
  }

  const facts = factRows.map((row) => ({
    id: row.id,
    content: row.content,
    about_peer: row.about_peer,
    confidence: toNumber(row.confidence),
    level: row.level,
    issue_id: row.issue_id,
    agent_id: row.agent_id,
    metadata: row.metadata,
    created_at: row.created_at,
  }));

  const session = sessionRows[0]
    ? {
        id: sessionRows[0].id,
        issue_id: sessionRows[0].issue_id,
        summary: sessionRows[0].summary,
        fact_count: toNumber(sessionRows[0].fact_count),
        updated_at: sessionRows[0].updated_at,
      }
    : null;

  const peerModels = peerRows.map((row) => ({
    id: row.id,
    agent_id: row.agent_id,
    model: row.model,
    fact_count: toNumber(row.fact_count),
    updated_at: row.updated_at,
  }));

  return {
    content: renderMarkdown(parsed.issueId, facts, session, peerModels),
    data: {
      issue_id: parsed.issueId,
      facts,
      session,
      peer_models: peerModels,
    },
  };
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function renderMarkdown(
  issueId: string,
  facts: ReadonlyArray<{
    content: string;
    confidence: number;
    about_peer: "agent" | "user" | null;
  }>,
  session:
    | { summary: string | null; fact_count: number; updated_at: string }
    | null,
  peerModels: ReadonlyArray<{
    agent_id: string;
    model: string | null;
    fact_count: number;
  }>,
): string {
  const lines: string[] = [];
  lines.push(`Memory context for issue ${issueId}:`);
  if (session?.summary) {
    lines.push("");
    lines.push("## Session summary");
    lines.push(session.summary);
  } else {
    lines.push("");
    lines.push("(No session summary recorded yet.)");
  }
  lines.push("");
  lines.push(`## Facts (${facts.length})`);
  if (facts.length === 0) {
    lines.push("(No facts captured for this issue.)");
  } else {
    for (let i = 0; i < facts.length; i++) {
      const f = facts[i];
      const peer = f.about_peer === null ? "general" : f.about_peer;
      lines.push(`${i + 1}. [conf=${f.confidence.toFixed(2)} ${peer}] ${f.content}`);
    }
  }
  if (peerModels.length > 0) {
    lines.push("");
    lines.push(`## Peer models (${peerModels.length})`);
    for (const peer of peerModels) {
      const model = peer.model && peer.model.length > 0 ? peer.model : "(no model)";
      const snippet = model.length > 280 ? model.slice(0, 280) + "…" : model;
      lines.push(`- agent ${peer.agent_id} (facts=${peer.fact_count}): ${snippet}`);
    }
  }
  return lines.join("\n");
}
