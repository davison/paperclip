/**
 * `memory_search_conclusions` — search session-level conclusion summaries.
 *
 * Each issue gets a single `<namespace>.sessions` row whose `summary` is the
 * memory-worker's rolling distillation of the issue's conclusions. This tool
 * lets agents find past issues whose conclusions match a query, e.g. "how did
 * we handle prompt-injection in user-supplied content?".
 *
 * Trigram similarity is computed via `pg_trgm.similarity()` even though there
 * is no GIN index on `sessions.summary` yet — for Phase 1 MVP fact volumes
 * this is acceptable (sessions = #issues, far smaller than facts). A
 * follow-up migration can add `gin (summary gin_trgm_ops)` when corpus size
 * justifies it.
 */

import { qualify } from "./sql.js";
import type { MemoryDb, SessionRow, ToolReturn, ToolRun } from "./types.js";

export interface MemorySearchConclusionsParams {
  query: string;
  limit?: number;
  min_similarity?: number;
}

export const MEMORY_SEARCH_CONCLUSIONS_PARAMETERS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["query"],
  properties: {
    query: {
      type: "string",
      minLength: 1,
      maxLength: 500,
      description:
        "Free-form text to find issue-level conclusions about. Trigram similarity over the rolling memory-worker summary.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 25,
      default: 10,
      description: "Maximum number of session summaries to return. Default 10, max 25.",
    },
    min_similarity: {
      type: "number",
      minimum: 0,
      maximum: 1,
      default: 0.1,
      description: "Minimum trigram similarity in [0, 1].",
    },
  },
} as const;

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;
const DEFAULT_MIN_SIM = 0.1;

interface ParsedParams {
  query: string;
  limit: number;
  minSimilarity: number;
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

  const limitRaw = params["limit"];
  let limit = DEFAULT_LIMIT;
  if (limitRaw !== undefined && limitRaw !== null) {
    if (
      typeof limitRaw !== "number" ||
      !Number.isFinite(limitRaw) ||
      !Number.isInteger(limitRaw)
    ) {
      return { error: "`limit` must be an integer" };
    }
    if (limitRaw < 1 || limitRaw > MAX_LIMIT) {
      return { error: `\`limit\` must be in [1, ${MAX_LIMIT}]` };
    }
    limit = limitRaw;
  }

  const minSimRaw = params["min_similarity"];
  let minSimilarity = DEFAULT_MIN_SIM;
  if (minSimRaw !== undefined && minSimRaw !== null) {
    if (typeof minSimRaw !== "number" || !Number.isFinite(minSimRaw)) {
      return { error: "`min_similarity` must be a finite number" };
    }
    if (minSimRaw < 0 || minSimRaw > 1) {
      return { error: "`min_similarity` must be in [0, 1]" };
    }
    minSimilarity = minSimRaw;
  }

  return { query: query.trim(), limit, minSimilarity };
}

export async function runMemorySearchConclusions(
  deps: { db: MemoryDb },
  params: unknown,
  runCtx: ToolRun,
): Promise<ToolReturn> {
  const parsed = parseParams(params);
  if ("error" in parsed) {
    return { error: parsed.error };
  }

  const ns = deps.db.namespace;
  const sessions = qualify(ns, "sessions");

  const sql = `
    SELECT id, issue_id, summary, fact_count, updated_at,
           similarity(coalesce(summary, ''), $2) AS sim
    FROM ${sessions}
    WHERE company_id = $1
      AND summary IS NOT NULL
      AND length(summary) > 0
      AND similarity(coalesce(summary, ''), $2) >= $3
    ORDER BY sim DESC, updated_at DESC
    LIMIT $4
  `;

  const rows = await deps.db.query<SessionRow>(sql, [
    runCtx.companyId,
    parsed.query,
    parsed.minSimilarity,
    parsed.limit,
  ]);

  const conclusions = rows
    .map((row) => ({
      session_id: row.id,
      issue_id: row.issue_id,
      summary: row.summary ?? "",
      fact_count:
        typeof row.fact_count === "string"
          ? Number(row.fact_count) || 0
          : row.fact_count ?? 0,
      updated_at: row.updated_at,
      similarity:
        typeof row.sim === "string" ? Number(row.sim) || 0 : row.sim ?? 0,
    }))
    .sort((a, b) => b.similarity - a.similarity);

  return {
    content: renderMarkdown(parsed.query, conclusions),
    data: {
      query: parsed.query,
      limit: parsed.limit,
      min_similarity: parsed.minSimilarity,
      conclusions,
    },
  };
}

function renderMarkdown(
  query: string,
  conclusions: ReadonlyArray<{
    summary: string;
    similarity: number;
    issue_id: string;
    fact_count: number;
  }>,
): string {
  if (conclusions.length === 0) {
    return `No conclusion summaries matched ${JSON.stringify(query)}.`;
  }
  const lines: string[] = [];
  lines.push(
    `Top ${conclusions.length} conclusion${conclusions.length === 1 ? "" : "s"} for ${JSON.stringify(query)}:`,
  );
  for (let i = 0; i < conclusions.length; i++) {
    const c = conclusions[i];
    const snippet = c.summary.length > 280 ? c.summary.slice(0, 280) + "…" : c.summary;
    lines.push(
      `${i + 1}. [sim=${c.similarity.toFixed(2)} facts=${c.fact_count} issue=${c.issue_id}] ${snippet}`,
    );
  }
  return lines.join("\n");
}
