/**
 * `memory_get_peer_context` — fetch the peer model + recent facts for one peer.
 *
 * Phase 1 MVP supports agent peers (the schema's `peer_models` table is keyed
 * by `agent_id`). User peers are not yet first-class: facts may carry
 * `about_peer = "user"` but there is no `peer_models` row for users in the
 * RED-98 schema. The tool surfaces facts with `about_peer = "user"` filtered
 * by metadata when a `user_id` is supplied, but returns `peer_model: null`
 * for user peers.
 */

import { qualify } from "./sql.js";
import type {
  FactRow,
  MemoryDb,
  PeerModelRow,
  ToolReturn,
  ToolRun,
} from "./types.js";

export interface MemoryGetPeerContextParams {
  agent_id?: string;
  user_id?: string;
  fact_limit?: number;
}

export const MEMORY_GET_PEER_CONTEXT_PARAMETERS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    agent_id: {
      type: "string",
      format: "uuid",
      description:
        "UUID of the agent peer to fetch context for. Exactly one of agent_id or user_id must be set.",
    },
    user_id: {
      type: "string",
      format: "uuid",
      description:
        "UUID of the user peer. Phase 1 MVP returns user-peer facts but not a peer model.",
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
  agentId: string | null;
  userId: string | null;
  factLimit: number;
}

function parseParams(raw: unknown): ParsedParams | { error: string } {
  if (raw === null || typeof raw !== "object") {
    return { error: "params must be an object" };
  }
  const params = raw as Record<string, unknown>;
  const rawAgent = params["agent_id"];
  const rawUser = params["user_id"];

  let agentId: string | null = null;
  let userId: string | null = null;

  if (rawAgent !== undefined && rawAgent !== null) {
    if (typeof rawAgent !== "string" || !UUID_RE.test(rawAgent)) {
      return { error: "`agent_id` must be a UUID" };
    }
    agentId = rawAgent;
  }
  if (rawUser !== undefined && rawUser !== null) {
    if (typeof rawUser !== "string" || !UUID_RE.test(rawUser)) {
      return { error: "`user_id` must be a UUID" };
    }
    userId = rawUser;
  }

  if (!agentId && !userId) {
    return { error: "exactly one of `agent_id` or `user_id` is required" };
  }
  if (agentId && userId) {
    return {
      error: "set exactly one of `agent_id` or `user_id`, not both",
    };
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

  return { agentId, userId, factLimit };
}

export async function runMemoryGetPeerContext(
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
  const peersTable = qualify(ns, "peer_models");

  let factRows: FactRow[] = [];
  let peerRows: PeerModelRow[] = [];

  if (parsed.agentId) {
    factRows = await deps.db.query<FactRow>(
      `SELECT id, content, about_peer, confidence, level, issue_id, agent_id,
              metadata, created_at
       FROM ${factsTable}
       WHERE company_id = $1 AND agent_id = $2
       ORDER BY created_at DESC
       LIMIT $3`,
      [runCtx.companyId, parsed.agentId, parsed.factLimit],
    );

    peerRows = await deps.db.query<PeerModelRow>(
      `SELECT id, agent_id, model, fact_count, updated_at
       FROM ${peersTable}
       WHERE company_id = $1 AND agent_id = $2
       LIMIT 1`,
      [runCtx.companyId, parsed.agentId],
    );
  } else if (parsed.userId) {
    // No first-class peer_models row for users in MVP. Filter facts by
    // `about_peer = 'user'` and a metadata `user_id` hint, which RED-99's
    // event handlers populate when the source author is a user.
    factRows = await deps.db.query<FactRow>(
      `SELECT id, content, about_peer, confidence, level, issue_id, agent_id,
              metadata, created_at
       FROM ${factsTable}
       WHERE company_id = $1
         AND about_peer = 'user'
         AND metadata ->> 'user_id' = $2
       ORDER BY created_at DESC
       LIMIT $3`,
      [runCtx.companyId, parsed.userId, parsed.factLimit],
    );
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

  const peerModel = peerRows[0]
    ? {
        id: peerRows[0].id,
        agent_id: peerRows[0].agent_id,
        model: peerRows[0].model,
        fact_count: toNumber(peerRows[0].fact_count),
        updated_at: peerRows[0].updated_at,
      }
    : null;

  return {
    content: renderMarkdown(parsed, facts, peerModel),
    data: {
      agent_id: parsed.agentId,
      user_id: parsed.userId,
      peer_model: peerModel,
      facts,
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
  parsed: ParsedParams,
  facts: ReadonlyArray<{
    content: string;
    confidence: number;
    about_peer: "agent" | "user" | null;
    issue_id: string | null;
  }>,
  peerModel: { model: string | null; fact_count: number; updated_at: string } | null,
): string {
  const peerLabel = parsed.agentId
    ? `agent ${parsed.agentId}`
    : `user ${parsed.userId}`;
  const lines: string[] = [];
  lines.push(`Peer context for ${peerLabel}:`);
  if (peerModel) {
    lines.push("");
    lines.push(
      `## Peer model (facts=${peerModel.fact_count}, updated ${peerModel.updated_at})`,
    );
    lines.push(peerModel.model ?? "(no model body recorded)");
  } else if (parsed.userId) {
    lines.push("");
    lines.push("(User peers do not have a peer_models row in the Phase 1 MVP schema.)");
  } else {
    lines.push("");
    lines.push("(No peer model recorded for this agent yet.)");
  }
  lines.push("");
  lines.push(`## Facts (${facts.length})`);
  if (facts.length === 0) {
    lines.push("(No facts captured about this peer.)");
  } else {
    for (let i = 0; i < facts.length; i++) {
      const f = facts[i];
      const issueRef = f.issue_id ? ` issue=${f.issue_id}` : "";
      lines.push(
        `${i + 1}. [conf=${f.confidence.toFixed(2)}${issueRef}] ${f.content}`,
      );
    }
  }
  return lines.join("\n");
}
