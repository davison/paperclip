/**
 * RED-103 — Quipo backfill action.
 *
 * One-shot action that walks existing issues in a company, lists their
 * comments, and queues the same extraction tasks that the live
 * `issue.comment.created` event handler would have queued. Idempotent via the
 * shared `comment:{commentId}` originId — re-running the action does not
 * duplicate extraction issues, and `metadata.source_comment_id` is recorded in
 * plugin state so future fact-write logic can correlate facts back to their
 * source comment.
 */

import type { Issue, IssueComment, PluginContext } from "@paperclipai/plugin-sdk";

import { readQuipoConfig } from "./config.js";
import {
  enqueueCommentExtraction,
  isQuipoOriginatedIssue,
  type EnqueueCommentExtractionResult,
} from "./event-handlers.js";

export const QUIPO_BACKFILL_ACTION_KEY = "backfill";

const DEFAULT_MAX_ISSUES = 1000;
const DEFAULT_MAX_COMMENTS_PER_ISSUE = 200;
const HARD_MAX_ISSUES = 10_000;
const HARD_MAX_COMMENTS_PER_ISSUE = 2_000;
const ISSUE_PAGE_SIZE = 200;

export interface BackfillParams {
  /** Company whose comment history should be backfilled. Required. */
  companyId: string;
  /** Restrict scan to a single project. Optional. */
  projectId?: string | null;
  /** Restrict scan to a single source issue (by UUID). Optional. */
  issueId?: string | null;
  /** Cap on issues scanned. Defaults to {@link DEFAULT_MAX_ISSUES}. */
  maxIssues?: number;
  /** Cap on comments scanned per issue. Defaults to {@link DEFAULT_MAX_COMMENTS_PER_ISSUE}. */
  maxCommentsPerIssue?: number;
  /** When true, count what would be enqueued without creating extraction issues. */
  dryRun?: boolean;
}

export interface BackfillSummary {
  ok: boolean;
  reason?:
    | "missing_company"
    | "no_memory_agent"
    | "no_issues_in_scope";
  /** Total source issues iterated over (after origin-kind filtering). */
  issuesScanned: number;
  /** Source issues skipped because they were created by Quipo itself. */
  pluginOwnedIssuesSkipped: number;
  /** Source issues that returned zero comments. */
  issuesWithNoComments: number;
  /** Comments observed across the scanned issues (before any filtering). */
  commentsScanned: number;
  /** Comments that produced a new extraction issue. */
  queued: number;
  /** Comments whose extraction was already recorded (idempotent skip). */
  alreadyExtracted: number;
  /** Comments authored by the configured memory agent and therefore skipped. */
  memoryAgentAuthoredSkipped: number;
  /** True when the per-issue or per-company cap was hit during the scan. */
  truncated: boolean;
  /** Returned only on dryRun runs. */
  dryRun: boolean;
  /** First few queued extraction issue ids, for UI confirmation. */
  sampleExtractionIssueIds: string[];
}

const SAMPLE_LIMIT = 10;

function clampPositiveInt(value: unknown, fallback: number, hardCap: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const rounded = Math.floor(value);
  if (rounded <= 0) return fallback;
  return Math.min(rounded, hardCap);
}

function isUuidLike(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 64;
}

function readBackfillParams(raw: Record<string, unknown> | undefined | null): BackfillParams {
  const params: BackfillParams = {
    companyId: typeof raw?.companyId === "string" ? raw.companyId.trim() : "",
    projectId:
      typeof raw?.projectId === "string" && raw.projectId.trim().length > 0
        ? raw.projectId.trim()
        : null,
    issueId:
      typeof raw?.issueId === "string" && raw.issueId.trim().length > 0
        ? raw.issueId.trim()
        : null,
    maxIssues: clampPositiveInt(raw?.maxIssues, DEFAULT_MAX_ISSUES, HARD_MAX_ISSUES),
    maxCommentsPerIssue: clampPositiveInt(
      raw?.maxCommentsPerIssue,
      DEFAULT_MAX_COMMENTS_PER_ISSUE,
      HARD_MAX_COMMENTS_PER_ISSUE,
    ),
    dryRun: Boolean(raw?.dryRun),
  };
  return params;
}

interface FetchIssuesResult {
  issues: Issue[];
  truncated: boolean;
  /** Plugin-owned issues observed during scope resolution and dropped client-side. */
  pluginOwnedSkipped: number;
  reason?: BackfillSummary["reason"];
}

async function fetchIssuesInScope(
  ctx: PluginContext,
  params: BackfillParams,
): Promise<FetchIssuesResult> {
  if (params.issueId) {
    // ctx.issues.get enforces company isolation host-side, so a foreign-company
    // issueId comes back as null and is reported as out-of-scope.
    const issue = await ctx.issues.get(params.issueId, params.companyId);
    if (!issue) {
      return { issues: [], truncated: false, pluginOwnedSkipped: 0, reason: "no_issues_in_scope" };
    }
    if (params.projectId && issue.projectId !== params.projectId) {
      return { issues: [], truncated: false, pluginOwnedSkipped: 0, reason: "no_issues_in_scope" };
    }
    if (isQuipoOriginatedIssue(issue.originKind)) {
      // Honour explicit single-issue requests but report the skip; backfill
      // never queues against plugin-owned issues.
      return {
        issues: [],
        truncated: false,
        pluginOwnedSkipped: 1,
        reason: "no_issues_in_scope",
      };
    }
    return { issues: [issue], truncated: false, pluginOwnedSkipped: 0 };
  }

  const collected: Issue[] = [];
  let pluginOwnedSkipped = 0;
  const cap = params.maxIssues ?? DEFAULT_MAX_ISSUES;
  let offset = 0;
  let truncated = false;
  // The cap models *eligible source issues* — not raw rows. Plugin-owned
  // issues from prior runs are filtered per page so dense plugin-issue
  // populations near the front of the listing cannot silently shrink the
  // operator's effective scan window.
  while (collected.length < cap) {
    const page = await ctx.issues.list({
      companyId: params.companyId,
      projectId: params.projectId ?? undefined,
      limit: ISSUE_PAGE_SIZE,
      offset,
    });
    if (page.length === 0) break;
    offset += page.length;

    let stopAtCap = false;
    for (const issue of page) {
      if (isQuipoOriginatedIssue(issue.originKind)) {
        pluginOwnedSkipped += 1;
        continue;
      }
      if (collected.length >= cap) {
        // We hit the eligible-issue cap mid-page — flag truncation and stop
        // collecting; we still let the loop count remaining plugin rows in
        // this page so pluginOwnedIssuesSkipped stays accurate.
        stopAtCap = true;
        truncated = true;
        break;
      }
      collected.push(issue);
    }

    if (stopAtCap) break;
    if (page.length < ISSUE_PAGE_SIZE) break;
  }
  // Probe one page beyond the last offset for any remaining *eligible* issue.
  // This lets us flag truncation when the cap exactly matches the total but
  // there is still more to scan, without defeating the cap's intent.
  if (collected.length === cap && !truncated) {
    const overflow = await ctx.issues.list({
      companyId: params.companyId,
      projectId: params.projectId ?? undefined,
      limit: ISSUE_PAGE_SIZE,
      offset,
    });
    const moreEligible = overflow.some(
      (candidate) => !isQuipoOriginatedIssue(candidate.originKind),
    );
    if (moreEligible) truncated = true;
  }
  return { issues: collected, truncated, pluginOwnedSkipped };
}

function getCommentBodySnippet(comment: IssueComment): string | null {
  return typeof comment.body === "string" && comment.body.length > 0 ? comment.body : null;
}

export async function runBackfill(
  ctx: PluginContext,
  rawParams: Record<string, unknown> | undefined,
): Promise<BackfillSummary> {
  const params = readBackfillParams(rawParams);

  const summary: BackfillSummary = {
    ok: false,
    issuesScanned: 0,
    pluginOwnedIssuesSkipped: 0,
    issuesWithNoComments: 0,
    commentsScanned: 0,
    queued: 0,
    alreadyExtracted: 0,
    memoryAgentAuthoredSkipped: 0,
    truncated: false,
    dryRun: Boolean(params.dryRun),
    sampleExtractionIssueIds: [],
  };

  if (!isUuidLike(params.companyId) || params.companyId.length === 0) {
    summary.reason = "missing_company";
    ctx.logger.warn("Quipo backfill: missing or invalid companyId", { params });
    return summary;
  }

  // The backfill action is an explicit user-initiated operation. We do NOT
  // gate on `enabled` (the live-event master switch) — operators may use
  // backfill to seed memory before flipping the switch. We still require a
  // memory agent because the extraction issues are useless without one.
  const config = readQuipoConfig(await ctx.config.get());
  const memoryAgentId = config.memoryAgentId;
  if (!memoryAgentId) {
    summary.reason = "no_memory_agent";
    ctx.logger.warn("Quipo backfill: memoryAgentId not configured — bailing", {
      companyId: params.companyId,
    });
    return summary;
  }

  const { issues, truncated, pluginOwnedSkipped, reason } = await fetchIssuesInScope(ctx, params);
  summary.pluginOwnedIssuesSkipped = pluginOwnedSkipped;
  if (issues.length === 0) {
    summary.reason = reason ?? "no_issues_in_scope";
    summary.ok = true;
    summary.truncated = truncated;
    ctx.logger.info("Quipo backfill: nothing to scan", {
      companyId: params.companyId,
      reason: summary.reason,
    });
    return summary;
  }
  summary.truncated = truncated;

  for (const issue of issues) {
    // Defence-in-depth: fetchIssuesInScope already filters plugin-owned issues
    // and counts them against pluginOwnedIssuesSkipped, so this branch is
    // unreachable in practice. We keep the guard so a future change to the
    // fetch path cannot accidentally start enqueueing extractions against the
    // plugin's own output.
    if (isQuipoOriginatedIssue(issue.originKind)) continue;
    summary.issuesScanned += 1;

    let comments: IssueComment[];
    try {
      comments = await ctx.issues.listComments(issue.id, params.companyId);
    } catch (err) {
      ctx.logger.error("Quipo backfill: failed to list comments — skipping issue", {
        issueId: issue.id,
        identifier: issue.identifier,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (comments.length === 0) {
      summary.issuesWithNoComments += 1;
      continue;
    }

    const cap = params.maxCommentsPerIssue ?? DEFAULT_MAX_COMMENTS_PER_ISSUE;
    const slice = comments.slice(0, cap);
    if (slice.length < comments.length) {
      summary.truncated = true;
    }

    for (const comment of slice) {
      summary.commentsScanned += 1;
      const commentId = comment.id;
      if (!isUuidLike(commentId)) {
        ctx.logger.warn("Quipo backfill: comment missing id — skipping", {
          issueId: issue.id,
        });
        continue;
      }

      const authorAgentId = comment.authorAgentId ?? null;
      if (authorAgentId && authorAgentId === memoryAgentId) {
        summary.memoryAgentAuthoredSkipped += 1;
        continue;
      }

      if (params.dryRun) {
        // Honour the same idempotency check during a dry-run so the count of
        // "queued" reflects what an actual run would do, not a naive comment
        // total. We don't write any state.
        const wouldDedupe = await peekAlreadyExtracted(ctx, params.companyId, commentId);
        if (wouldDedupe) {
          summary.alreadyExtracted += 1;
        } else {
          summary.queued += 1;
        }
        continue;
      }

      let result: EnqueueCommentExtractionResult;
      try {
        result = await enqueueCommentExtraction(ctx, memoryAgentId, {
          companyId: params.companyId,
          sourceIssue: issue,
          commentId,
          bodySnippet: getCommentBodySnippet(comment),
          identifierHint: issue.identifier ?? null,
          authorAgentId,
          authorRunId: null,
          sourceKind: "backfill",
          eventId: null,
        });
      } catch (err) {
        ctx.logger.error("Quipo backfill: enqueue failed — continuing", {
          issueId: issue.id,
          commentId,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      switch (result.status) {
        case "queued":
          summary.queued += 1;
          if (summary.sampleExtractionIssueIds.length < SAMPLE_LIMIT) {
            summary.sampleExtractionIssueIds.push(result.extractionIssueId);
          }
          break;
        case "already_extracted":
          summary.alreadyExtracted += 1;
          break;
        case "skipped":
          if (result.reason === "memory_agent_authored") {
            summary.memoryAgentAuthoredSkipped += 1;
          }
          // plugin_origin shouldn't fire here because we already filter the
          // outer issue list, but we let the inner check stand as a belt-and-
          // -braces guard.
          break;
      }
    }
  }

  summary.ok = true;
  ctx.logger.info("Quipo backfill: complete", {
    companyId: params.companyId,
    issuesScanned: summary.issuesScanned,
    commentsScanned: summary.commentsScanned,
    queued: summary.queued,
    alreadyExtracted: summary.alreadyExtracted,
    truncated: summary.truncated,
    dryRun: summary.dryRun,
  });
  // Telemetry must never invalidate already-completed extraction work. A
  // transient metrics-backend failure used to throw out of `runBackfill` here,
  // which made operators see a "failed" backfill even though every extraction
  // issue had been created successfully and would not be re-queued on retry.
  // Isolate metrics writes so the core summary is what we return.
  try {
    await ctx.metrics.write("backfill.completed", 1, {
      dry_run: summary.dryRun ? "true" : "false",
    });
  } catch (err) {
    ctx.logger.warn("Quipo backfill: metrics write 'backfill.completed' failed — continuing", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    await ctx.metrics.write("backfill.queued_extractions", summary.queued, {
      dry_run: summary.dryRun ? "true" : "false",
    });
  } catch (err) {
    ctx.logger.warn(
      "Quipo backfill: metrics write 'backfill.queued_extractions' failed — continuing",
      {
        error: err instanceof Error ? err.message : String(err),
      },
    );
  }
  return summary;
}

/** Read-only check used by the dry-run path so it doesn't mutate state. */
async function peekAlreadyExtracted(
  ctx: PluginContext,
  companyId: string,
  commentId: string,
): Promise<boolean> {
  const stateKey = {
    scopeKind: "instance" as const,
    namespace: "extractions",
    stateKey: `comment:${commentId}`,
  };
  if (await ctx.state.get(stateKey)) return true;
  const existing = await ctx.issues.list({
    companyId,
    originKind: `plugin:paperclipai.plugin-quipo` as `plugin:${string}`,
    originId: `comment:${commentId}`,
    limit: 1,
  });
  return existing.length > 0;
}

export function registerQuipoBackfillAction(ctx: PluginContext): void {
  ctx.actions.register(
    QUIPO_BACKFILL_ACTION_KEY,
    async (params): Promise<BackfillSummary> =>
      runBackfill(ctx, params as Record<string, unknown> | undefined),
  );
}
