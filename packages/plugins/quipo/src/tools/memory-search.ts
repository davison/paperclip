/**
 * `memory_search` — trigram fact retrieval, optionally LLM-reranked.
 *
 * The tool runs a `pg_trgm`-backed similarity query against
 * `<namespace>.facts`, returning the top-N matches by similarity. The
 * candidates are exposed both as a structured `data.facts` array and as a
 * compact markdown table in `content`, so the calling agent can rerank them
 * inside its own LLM context (the canonical Phase 1 MVP approach for "LLM
 * rerank") without an extra round-trip.
 *
 * The schema for `facts.content` is `gin (content gin_trgm_ops)` (see
 * `migrations/001_init_memory.sql`), so the host's query planner can satisfy
 * `similarity(...)` and `%`-operator filters with the existing index.
 */

import { qualify } from "./sql.js";
import type { FactRow, MemoryDb, ToolReturn, ToolRun } from "./types.js";

export interface MemorySearchParams {
  query: string;
  limit?: number;
  min_similarity?: number;
  about_peer?: "agent" | "user" | null;
  issue_id?: string;
  agent_id?: string;
}

export const MEMORY_SEARCH_PARAMETERS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["query"],
  properties: {
    query: {
      type: "string",
      minLength: 1,
      maxLength: 500,
      description:
        "Free-form text to find facts about. The host runs a trigram similarity scan over fact bodies.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 50,
      default: 20,
      description: "Maximum number of facts to return. Default 20, max 50.",
    },
    min_similarity: {
      type: "number",
      minimum: 0,
      maximum: 1,
      default: 0.1,
      description:
        "Minimum trigram similarity in [0, 1]. Lower returns more (noisier) candidates the agent can rerank.",
    },
    about_peer: {
      type: ["string", "null"],
      enum: ["agent", "user", null],
      description:
        "Optional filter: only return facts whose `about_peer` matches.",
    },
    issue_id: {
      type: "string",
      format: "uuid",
      description: "Optional filter: only return facts captured from this issue.",
    },
    agent_id: {
      type: "string",
      format: "uuid",
      description:
        "Optional filter: only return facts whose target peer is this agent.",
    },
  },
} as const;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const DEFAULT_MIN_SIM = 0.1;

interface ParsedParams {
  query: string;
  limit: number;
  minSimilarity: number;
  aboutPeer: "agent" | "user" | null | undefined;
  issueId: string | undefined;
  agentId: string | undefined;
}

function parseParams(raw: unknown): ParsedParams | { error: string } {
  if (raw === null || typeof raw !== "object") {
    return { error: "params must be an object" };
  }
  const params = raw as Record<string, unknown>;

  const query = params["query"];
  if (typeof query !== "string" || query.trim().length === 0) {
    return { error: "`query` is required and must be a non-empty string" };
  }
  if (query.length > 500) {
    return { error: "`query` must be <= 500 characters" };
  }

  const limit = clampInteger(params["limit"], DEFAULT_LIMIT, 1, MAX_LIMIT);
  if (typeof limit === "string") return { error: limit };

  const minSimilarity = clampNumber(
    params["min_similarity"],
    DEFAULT_MIN_SIM,
    0,
    1,
  );
  if (typeof minSimilarity === "string") return { error: minSimilarity };

  let aboutPeer: ParsedParams["aboutPeer"] = undefined;
  if ("about_peer" in params) {
    const v = params["about_peer"];
    if (v === null || v === "agent" || v === "user") {
      aboutPeer = v;
    } else if (v !== undefined) {
      return { error: "`about_peer` must be 'agent', 'user', or null" };
    }
  }

  const issueId = optionalUuid(params["issue_id"], "issue_id");
  if (typeof issueId === "object" && issueId !== null && "error" in issueId) {
    return { error: issueId.error };
  }

  const agentId = optionalUuid(params["agent_id"], "agent_id");
  if (typeof agentId === "object" && agentId !== null && "error" in agentId) {
    return { error: agentId.error };
  }

  return {
    query: query.trim(),
    limit,
    minSimilarity,
    aboutPeer,
    issueId: issueId as string | undefined,
    agentId: agentId as string | undefined,
  };
}

function clampInteger(
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
): number | string {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw)) {
    return "`limit` must be an integer";
  }
  if (raw < min || raw > max) {
    return `\`limit\` must be in [${min}, ${max}]`;
  }
  return raw;
}

function clampNumber(
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
): number | string {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return "`min_similarity` must be a finite number";
  }
  if (raw < min || raw > max) {
    return `\`min_similarity\` must be in [${min}, ${max}]`;
  }
  return raw;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function optionalUuid(
  raw: unknown,
  field: string,
): string | undefined | { error: string } {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string" || !UUID_RE.test(raw)) {
    return { error: `\`${field}\` must be a UUID` };
  }
  return raw;
}

export async function runMemorySearch(
  deps: { db: MemoryDb },
  params: unknown,
  runCtx: ToolRun,
): Promise<ToolReturn> {
  const parsed = parseParams(params);
  if ("error" in parsed) {
    return { error: parsed.error };
  }

  const ns = deps.db.namespace;
  const facts = qualify(ns, "facts");

  const where: string[] = ["company_id = $1"];
  const args: unknown[] = [runCtx.companyId];

  args.push(parsed.query);
  const queryIdx = args.length;
  args.push(parsed.minSimilarity);
  const minSimIdx = args.length;
  where.push(`similarity(content, $${queryIdx}) >= $${minSimIdx}`);

  if (parsed.aboutPeer === null) {
    where.push("about_peer IS NULL");
  } else if (parsed.aboutPeer === "agent" || parsed.aboutPeer === "user") {
    args.push(parsed.aboutPeer);
    where.push(`about_peer = $${args.length}`);
  }
  if (parsed.issueId) {
    args.push(parsed.issueId);
    where.push(`issue_id = $${args.length}`);
  }
  if (parsed.agentId) {
    args.push(parsed.agentId);
    where.push(`agent_id = $${args.length}`);
  }

  args.push(parsed.limit);
  const limitIdx = args.length;

  const sql = `
    SELECT id, content, about_peer, confidence, level, issue_id, agent_id,
           metadata, created_at,
           similarity(content, $${queryIdx}) AS sim
    FROM ${facts}
    WHERE ${where.join(" AND ")}
    ORDER BY sim DESC, created_at DESC
    LIMIT $${limitIdx}
  `;

  const rows = await deps.db.query<FactRow>(sql, args);

  const ranked = rows
    .map((row) => ({
      id: row.id,
      content: row.content,
      about_peer: row.about_peer,
      confidence: toNumber(row.confidence),
      level: row.level,
      issue_id: row.issue_id,
      agent_id: row.agent_id,
      metadata: row.metadata,
      created_at: row.created_at,
      similarity: toNumber(row.sim),
    }))
    .sort((a, b) => b.similarity - a.similarity);

  const summary = renderMarkdown(parsed.query, ranked);
  return {
    content: summary,
    data: {
      query: parsed.query,
      limit: parsed.limit,
      min_similarity: parsed.minSimilarity,
      facts: ranked,
    },
  };
}

function toNumber(value: number | string | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function renderMarkdown(
  query: string,
  facts: ReadonlyArray<{
    content: string;
    similarity: number;
    about_peer: "agent" | "user" | null;
    confidence: number;
  }>,
): string {
  if (facts.length === 0) {
    return `No facts matched ${JSON.stringify(query)}. Try a broader query or lower min_similarity.`;
  }
  const lines: string[] = [];
  lines.push(
    `Top ${facts.length} fact${facts.length === 1 ? "" : "s"} for ${JSON.stringify(query)} (ranked by trigram similarity; rerank in your own context as needed):`,
  );
  for (let i = 0; i < facts.length; i++) {
    const fact = facts[i];
    const peer = fact.about_peer === null ? "general" : fact.about_peer;
    lines.push(
      `${i + 1}. [sim=${fact.similarity.toFixed(2)} conf=${fact.confidence.toFixed(2)} ${peer}] ${fact.content}`,
    );
  }
  return lines.join("\n");
}
