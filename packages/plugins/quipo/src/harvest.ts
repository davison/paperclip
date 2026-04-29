import type { PluginContext, ScopeKey } from "@paperclipai/plugin-sdk";

import {
  type ExtractedFact,
  parseExtractedFactsResponse,
} from "./prompts/extract-facts.js";

const HARVEST_STATE_NAMESPACE = "harvest";
const EXTRACTION_LINK_NAMESPACE = "extraction-link";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** Persisted alongside the extraction issue so the harvest path can recover
 *  the source context from just the extraction issue id. Written when the
 *  extraction issue is created; read when the memory-worker comments back. */
export interface ExtractionLink {
  /** Source issue the extraction was triggered from (the user-facing issue,
   *  not the plugin-owned extraction issue). */
  sourceIssueId: string;
  /** Source comment id, when the extraction was triggered by a comment. Null
   *  for issue-update extractions. */
  sourceCommentId: string | null;
  sourceKind: "comment" | "issue_update" | "backfill" | string;
  /** UUID of the agent who authored the source content. Used to anchor
   *  peer_models when about_peer == "agent". */
  peerAgentId: string | null;
  /** Origin id from the extraction issue, kept for cross-reference. */
  originId: string;
}

export function harvestStateKey(commentId: string): ScopeKey {
  return {
    scopeKind: "instance",
    namespace: HARVEST_STATE_NAMESPACE,
    stateKey: commentId,
  };
}

export function extractionLinkStateKey(extractionIssueId: string): ScopeKey {
  return {
    scopeKind: "instance",
    namespace: EXTRACTION_LINK_NAMESPACE,
    stateKey: extractionIssueId,
  };
}

/** Map a fact's confidence to one of the schema-permitted level buckets.
 *  The migration defaults to 'explicit'; we keep that for high-confidence
 *  facts and step down for weaker claims so downstream tools can filter. */
export function levelForConfidence(confidence: number): string {
  if (!Number.isFinite(confidence)) return "loose";
  if (confidence >= 0.9) return "explicit";
  if (confidence >= 0.6) return "inferred";
  return "loose";
}

export interface HarvestInput {
  companyId: string;
  /** The memory-worker's comment that contains the JSON facts payload. */
  commentBody: string;
  /** UUID of the comment carrying the facts. Used as the harvest idempotency key. */
  commentId: string;
  /** Plugin-owned extraction issue the memory-worker commented on. */
  extractionIssueId: string;
  /** Source context recovered from the extraction issue's stored link. */
  link: ExtractionLink;
  /** Optional run id of the memory-worker run that produced the comment.
   *  Stored in fact metadata for traceability. */
  extractionRunId?: string | null;
}

export interface HarvestResult {
  status: "harvested" | "already_harvested" | "empty" | "parse_error";
  factsInserted: number;
  totalFactsInResponse: number;
  parseError?: string;
}

/** Persist a memory-worker extraction response into the plugin's
 *  facts/sessions/peer_models tables. Idempotent on `commentId`.
 *
 *  Returns a status describing what happened so the caller can log accurately
 *  and decide whether to flip the extraction issue to `done`/`blocked`.
 */
export async function harvestExtraction(
  ctx: PluginContext,
  input: HarvestInput,
): Promise<HarvestResult> {
  const { companyId, commentBody, commentId, extractionIssueId, link } = input;

  const stateKey = harvestStateKey(commentId);
  const existing = (await ctx.state.get(stateKey)) as
    | { outcome?: string; detail?: string }
    | null
    | undefined;
  if (existing) {
    // Re-surface the original outcome on redelivery so callers can route
    // the same way as the first attempt. A prior `parse_error` must NOT be
    // reported as `already_harvested` — that would let the caller close the
    // extraction issue as `done` despite zero successful harvest (RED-166).
    if (existing.outcome === "parse_error") {
      ctx.logger.debug("Quipo: prior parse_error replayed for comment", { commentId });
      return {
        status: "parse_error",
        factsInserted: 0,
        totalFactsInResponse: 0,
        parseError: existing.detail,
      };
    }
    ctx.logger.debug("Quipo: harvest already recorded for comment", { commentId });
    return { status: "already_harvested", factsInserted: 0, totalFactsInResponse: 0 };
  }

  let parsed;
  try {
    parsed = parseExtractedFactsResponse(commentBody);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    ctx.logger.warn("Quipo: harvest parse error", {
      commentId,
      extractionIssueId,
      detail,
    });
    // Persist the parse-error state so we don't loop on the same broken comment.
    await ctx.state.set(stateKey, {
      outcome: "parse_error",
      detail,
      at: new Date().toISOString(),
    });
    return {
      status: "parse_error",
      factsInserted: 0,
      totalFactsInResponse: 0,
      parseError: detail,
    };
  }

  if (parsed.facts.length === 0) {
    await ctx.state.set(stateKey, {
      outcome: "empty",
      at: new Date().toISOString(),
    });
    return { status: "empty", factsInserted: 0, totalFactsInResponse: 0 };
  }

  const ns = ctx.db.namespace;
  let insertedCount = 0;

  for (const fact of parsed.facts) {
    const factAgentId = factAgentForRow(fact, link);
    const sourceIds = collectUuidSourceIds(link, extractionIssueId);
    const metadata = {
      about_peer: fact.about_peer,
      confidence: fact.confidence,
      source_kind: link.sourceKind,
      source_comment_id: link.sourceCommentId,
      extraction_issue_id: extractionIssueId,
      extraction_run_id: input.extractionRunId ?? null,
    };

    await ctx.db.execute(
      `INSERT INTO ${ns}.facts (company_id, issue_id, agent_id, content, level, source_ids, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::uuid[], $7::jsonb)`,
      [
        companyId,
        link.sourceIssueId,
        factAgentId,
        fact.content,
        levelForConfidence(fact.confidence),
        sourceIds,
        JSON.stringify(metadata),
      ],
    );
    insertedCount += 1;
  }

  // Sessions: upsert per source issue, summing fact_count.
  await ctx.db.execute(
    `INSERT INTO ${ns}.sessions (company_id, issue_id, fact_count)
     VALUES ($1, $2, $3)
     ON CONFLICT (issue_id) DO UPDATE
       SET fact_count = ${ns}.sessions.fact_count + EXCLUDED.fact_count,
           updated_at = now()`,
    [companyId, link.sourceIssueId, insertedCount],
  );

  // Peer models: only roll up agent-targeted facts when we know which peer.
  if (link.peerAgentId) {
    const agentFactCount = parsed.facts.filter(
      (f) => f.about_peer === "agent",
    ).length;
    if (agentFactCount > 0) {
      await ctx.db.execute(
        `INSERT INTO ${ns}.peer_models (company_id, agent_id, fact_count)
         VALUES ($1, $2, $3)
         ON CONFLICT (company_id, agent_id) DO UPDATE
           SET fact_count = ${ns}.peer_models.fact_count + EXCLUDED.fact_count,
               updated_at = now()`,
        [companyId, link.peerAgentId, agentFactCount],
      );
    }
  }

  await ctx.state.set(stateKey, {
    outcome: "harvested",
    factsInserted: insertedCount,
    totalFactsInResponse: parsed.facts.length,
    extractionIssueId,
    extractionRunId: input.extractionRunId ?? null,
    at: new Date().toISOString(),
  });

  ctx.logger.info("Quipo: harvested extraction", {
    commentId,
    extractionIssueId,
    sourceIssueId: link.sourceIssueId,
    factsInserted: insertedCount,
    totalFacts: parsed.facts.length,
  });

  return {
    status: "harvested",
    factsInserted: insertedCount,
    totalFactsInResponse: parsed.facts.length,
  };
}

function factAgentForRow(
  fact: ExtractedFact,
  link: ExtractionLink,
): string | null {
  if (fact.about_peer === "agent" && link.peerAgentId) return link.peerAgentId;
  return null;
}

function collectUuidSourceIds(link: ExtractionLink, extractionIssueId: string): string[] {
  const ids: string[] = [];
  if (isUuid(link.sourceCommentId)) ids.push(link.sourceCommentId);
  if (isUuid(extractionIssueId)) ids.push(extractionIssueId);
  return ids;
}
