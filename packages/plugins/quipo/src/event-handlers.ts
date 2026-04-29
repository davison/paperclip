import type { Issue, PluginContext, PluginEvent, ScopeKey } from "@paperclipai/plugin-sdk";

import { QUIPO_PLUGIN_ID, readQuipoConfig } from "./config.js";
import {
  type ExtractionLink,
  extractionLinkStateKey,
  harvestExtraction,
  harvestStateKey,
} from "./harvest.js";

const STATE_NAMESPACE = "extractions";
const QUIPO_ORIGIN_KIND = `plugin:${QUIPO_PLUGIN_ID}` as const;
const QUIPO_ORIGIN_PREFIX = QUIPO_ORIGIN_KIND;

const FACT_BEARING_PATCH_KEYS: ReadonlySet<string> = new Set(["title", "description"]);

interface CommentCreatedPayload {
  identifier?: string;
  commentId?: string;
  bodySnippet?: string;
  agentId?: string | null;
  runId?: string | null;
}

interface IssueUpdatedPayload {
  identifier?: string;
  patch?: Record<string, unknown>;
  _previous?: Record<string, unknown>;
  agentId?: string | null;
  runId?: string | null;
}

export const QUIPO_EXTRACTION_STATE_NAMESPACE = STATE_NAMESPACE;
export const QUIPO_EXTRACTION_ORIGIN_KIND = QUIPO_ORIGIN_KIND;

export type ExtractionSource = "comment" | "issue_update" | "backfill";

export function commentOriginId(commentId: string): string {
  return `comment:${commentId}`;
}

export function updateOriginId(sourceIssueId: string, updatedAt: Date | string): string {
  const iso = typeof updatedAt === "string" ? updatedAt : updatedAt.toISOString();
  return `update:${sourceIssueId}:${iso}`;
}

export function extractionIdempotencyStateKey(originId: string): ScopeKey {
  return {
    scopeKind: "instance",
    namespace: STATE_NAMESPACE,
    stateKey: originId,
  };
}

const idempotencyStateKey = extractionIdempotencyStateKey;

export function isQuipoOriginatedIssue(originKind: unknown): boolean {
  if (typeof originKind !== "string") return false;
  return originKind === QUIPO_ORIGIN_PREFIX || originKind.startsWith(`${QUIPO_ORIGIN_PREFIX}:`);
}

const isQuipoOriginated = isQuipoOriginatedIssue;

function hasFactBearingPatch(patch: Record<string, unknown> | undefined | null): boolean {
  if (!patch) return false;
  for (const key of Object.keys(patch)) {
    if (FACT_BEARING_PATCH_KEYS.has(key)) return true;
  }
  return false;
}

function quote(snippet: string): string {
  if (!snippet) return "(snippet unavailable — fetch the comment via ctx.issues.listComments)";
  return snippet
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

async function getQuipoRuntimeConfig(ctx: PluginContext) {
  const raw = await ctx.config.get();
  return readQuipoConfig(raw);
}

/**
 * Wake the memory agent on a freshly-created extraction issue so the wake
 * payload carries `issueId`. Without this, `claude_local` worker agents
 * receiving the assignment via the heartbeat scheduler do not get
 * `paperclipIssue` in their context snapshot and respond "I do not see a task"
 * (RED-133). Failures are logged but never propagated — the extraction issue
 * already exists and downstream retry paths can still pick it up.
 */
async function wakeExtractionAssignee(
  ctx: PluginContext,
  companyId: string,
  extractionIssueId: string,
  reason: string,
): Promise<void> {
  try {
    await ctx.issues.requestWakeup(extractionIssueId, companyId, {
      reason,
      contextSource: `plugin:${QUIPO_PLUGIN_ID}`,
      idempotencyKey: `quipo:wake:${extractionIssueId}`,
    });
  } catch (err) {
    ctx.logger.warn("Quipo: failed to wake memory agent for extraction issue", {
      extractionIssueId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * In-process per-key serialization so two concurrent event deliveries handled by
 * the same worker process cannot both observe missing idempotency state and
 * both create extraction issues. Cross-process safety additionally relies on
 * the pre-create `ctx.issues.list({ originKind, originId })` check below.
 */
const claimLocks = new Map<string, Promise<unknown>>();

export function withExtractionClaimLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = claimLocks.get(key) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  claimLocks.set(key, next);
  next.finally(() => {
    if (claimLocks.get(key) === next) claimLocks.delete(key);
  }).catch(() => {});
  return next;
}

const withClaimLock = withExtractionClaimLock;

export async function alreadyExtracted(
  ctx: PluginContext,
  companyId: string,
  originId: string,
): Promise<{ extracted: boolean; extractionIssueId?: string | null }> {
  const stateKey = idempotencyStateKey(originId);
  const existingState = (await ctx.state.get(stateKey)) as
    | { extractionIssueId?: string | null }
    | null
    | undefined;
  if (existingState) {
    return { extracted: true, extractionIssueId: existingState.extractionIssueId ?? null };
  }
  // Cross-restart / cross-process best-effort: if a prior worker created the
  // extraction issue but the state write was lost (crash between create and
  // state.set), the deterministic originId still lets us recover.
  const existing = await ctx.issues.list({
    companyId,
    originKind: QUIPO_ORIGIN_KIND,
    originId,
    limit: 1,
  });
  if (existing.length > 0) {
    // Backfill state so subsequent get() calls short-circuit.
    await ctx.state.set(stateKey, {
      extractionIssueId: existing[0].id,
      backfilled: true,
    });
    return { extracted: true, extractionIssueId: existing[0].id };
  }
  return { extracted: false };
}

export interface EnqueueCommentExtractionInput {
  companyId: string;
  /** Source issue the comment lives on. Caller is responsible for resolving it. */
  sourceIssue: Issue;
  commentId: string;
  /** Inline preview shown to the memory-worker. Optional. */
  bodySnippet?: string | null;
  /** Issue identifier shown in the prompt (e.g. `RED-42`). Falls back to the source issue's identifier/id. */
  identifierHint?: string | null;
  /** UUID of the agent who authored the source comment, if any. */
  authorAgentId?: string | null;
  /** Agent run that authored the comment, used as the actor on the extraction issue. */
  authorRunId?: string | null;
  /** Where this enqueue request came from; surfaces to logs and the prompt body. */
  sourceKind?: ExtractionSource;
  /** The originating event ID, for traceability in the persisted state record. */
  eventId?: string | null;
}

export type EnqueueCommentExtractionResult =
  | { status: "queued"; extractionIssueId: string; originId: string }
  | { status: "already_extracted"; extractionIssueId: string | null; originId: string }
  | { status: "skipped"; reason: "memory_agent_authored" | "plugin_origin"; originId: string };

/**
 * Shared comment-extraction enqueue path used by both the live
 * `issue.comment.created` handler and the RED-103 backfill action. The caller
 * is responsible for any feature-flag gating (e.g. `enabled`) and for
 * supplying a resolved memory-agent id; this function only owns the
 * per-comment idempotency + issue-creation flow so the backfill stays in lock
 * step with the live event behaviour.
 */
export async function enqueueCommentExtraction(
  ctx: PluginContext,
  memoryAgentId: string,
  input: EnqueueCommentExtractionInput,
): Promise<EnqueueCommentExtractionResult> {
  const {
    companyId,
    sourceIssue,
    commentId,
    bodySnippet,
    identifierHint,
    authorAgentId,
    authorRunId,
    sourceKind = "comment",
    eventId,
  } = input;

  const originId = commentOriginId(commentId);

  if (authorAgentId && authorAgentId === memoryAgentId) {
    ctx.logger.debug("Quipo: skipping comment authored by memory agent", {
      memoryAgentId,
      commentId,
      sourceKind,
    });
    return { status: "skipped", reason: "memory_agent_authored", originId };
  }

  if (isQuipoOriginated(sourceIssue.originKind)) {
    ctx.logger.debug("Quipo: skipping comment on plugin-owned issue", {
      sourceIssueId: sourceIssue.id,
      commentId,
      sourceKind,
    });
    return { status: "skipped", reason: "plugin_origin", originId };
  }

  const lockKey = `${companyId}:${originId}`;

  return withClaimLock(lockKey, async () => {
    const dedupe = await alreadyExtracted(ctx, companyId, originId);
    if (dedupe.extracted) {
      ctx.logger.debug("Quipo: extraction already queued for comment", {
        commentId,
        sourceKind,
      });
      return {
        status: "already_extracted",
        extractionIssueId: dedupe.extractionIssueId ?? null,
        originId,
      } as const;
    }

    const identifier = identifierHint ?? sourceIssue.identifier ?? sourceIssue.id;
    const titlePrefix = sourceKind === "backfill" ? "Quipo backfill" : "Quipo";
    const description = [
      sourceKind === "backfill"
        ? `Extract atomic facts from an existing comment on ${identifier} (queued by RED-103 backfill).`
        : `Extract atomic facts from a new comment on ${identifier}.`,
      "",
      `- source issue: ${sourceIssue.id}`,
      `- comment id: ${commentId}`,
      `- source_comment_id: ${commentId}`,
      authorAgentId ? `- author agent: ${authorAgentId}` : "- author: board user",
      `- source kind: ${sourceKind}`,
      "",
      "Snippet:",
      quote((bodySnippet ?? "").slice(0, 240)),
      "",
      "Return your response as a single JSON object matching the memory-worker output contract.",
    ].join("\n");

    const extractionIssue = await ctx.issues.create({
      companyId,
      projectId: sourceIssue.projectId ?? undefined,
      title: `${titlePrefix}: extract facts from comment on ${identifier}`,
      description,
      status: "todo",
      priority: "low",
      assigneeAgentId: memoryAgentId,
      originId,
      inheritExecutionWorkspaceFromIssueId: sourceIssue.id,
      actor: {
        actorAgentId: authorAgentId ?? null,
        actorRunId: authorRunId ?? null,
      },
    });

    await ctx.state.set(idempotencyStateKey(originId), {
      extractionIssueId: extractionIssue.id,
      eventId: eventId ?? null,
      sourceKind,
      // Anchor for fact-write idempotency: any future `facts` row created from
      // this extraction is expected to carry `metadata.source_comment_id`
      // matching this value, which lets backfill skip comments that already
      // produced facts.
      source_comment_id: commentId,
    });

    const link: ExtractionLink = {
      sourceIssueId: sourceIssue.id,
      sourceCommentId: commentId,
      sourceKind,
      peerAgentId: authorAgentId ?? null,
      originId,
    };
    await ctx.state.set(extractionLinkStateKey(extractionIssue.id), link);

    ctx.logger.info("Quipo: queued comment fact extraction", {
      sourceIssueId: sourceIssue.id,
      commentId,
      extractionIssueId: extractionIssue.id,
      sourceKind,
    });

    await wakeExtractionAssignee(
      ctx,
      companyId,
      extractionIssue.id,
      `quipo extraction for ${identifier} (${sourceKind})`,
    );

    return {
      status: "queued",
      extractionIssueId: extractionIssue.id,
      originId,
    } as const;
  });
}

export async function onIssueCommentCreated(
  ctx: PluginContext,
  event: PluginEvent,
): Promise<void> {
  const payload = (event.payload ?? {}) as CommentCreatedPayload;
  const commentId = payload.commentId;
  if (!commentId) {
    ctx.logger.warn("Quipo: issue.comment.created missing commentId — skipping", {
      eventId: event.eventId,
    });
    return;
  }

  const config = await getQuipoRuntimeConfig(ctx);
  if (!config.enabled) {
    ctx.logger.debug("Quipo: plugin disabled for this company — skipping comment extraction", {
      commentId,
    });
    return;
  }
  const memoryAgentId = config.memoryAgentId;
  if (!memoryAgentId) {
    ctx.logger.warn("Quipo: memoryAgentId not configured — skipping comment extraction", {
      commentId,
    });
    return;
  }

  const sourceIssueId = event.entityId;
  if (!sourceIssueId) {
    ctx.logger.warn("Quipo: issue.comment.created missing entityId — skipping", { commentId });
    return;
  }

  if (payload.agentId && payload.agentId === memoryAgentId) {
    ctx.logger.debug("Quipo: skipping comment authored by memory agent", {
      memoryAgentId,
      commentId,
    });
    return;
  }

  const sourceIssue = await ctx.issues.get(sourceIssueId, event.companyId);
  if (!sourceIssue) {
    ctx.logger.warn("Quipo: source issue not found for comment extraction", {
      sourceIssueId,
      commentId,
    });
    return;
  }

  await enqueueCommentExtraction(ctx, memoryAgentId, {
    companyId: event.companyId,
    sourceIssue,
    commentId,
    bodySnippet: payload.bodySnippet ?? null,
    identifierHint: payload.identifier ?? null,
    authorAgentId: payload.agentId ?? null,
    authorRunId: payload.runId ?? null,
    sourceKind: "comment",
    eventId: event.eventId,
  });
}

export async function onIssueUpdated(ctx: PluginContext, event: PluginEvent): Promise<void> {
  const sourceIssueId = event.entityId;
  if (!sourceIssueId) {
    ctx.logger.warn("Quipo: issue.updated missing entityId — skipping", { eventId: event.eventId });
    return;
  }

  const payload = (event.payload ?? {}) as IssueUpdatedPayload;

  if (!hasFactBearingPatch(payload.patch)) {
    ctx.logger.debug("Quipo: skipping non-fact-bearing issue update", {
      sourceIssueId,
      patchKeys: Object.keys(payload.patch ?? {}),
    });
    return;
  }

  const config = await getQuipoRuntimeConfig(ctx);
  if (!config.enabled) {
    ctx.logger.debug("Quipo: plugin disabled for this company — skipping update extraction", {
      sourceIssueId,
    });
    return;
  }
  if (config.extractionScope === "comments_only") {
    ctx.logger.debug("Quipo: extractionScope=comments_only — skipping issue update", {
      sourceIssueId,
    });
    return;
  }
  const memoryAgentId = config.memoryAgentId;
  if (!memoryAgentId) {
    ctx.logger.warn("Quipo: memoryAgentId not configured — skipping update extraction", {
      sourceIssueId,
    });
    return;
  }

  if (payload.agentId && payload.agentId === memoryAgentId) {
    ctx.logger.debug("Quipo: skipping update authored by memory agent", {
      memoryAgentId,
      sourceIssueId,
    });
    return;
  }

  const sourceIssue = await ctx.issues.get(sourceIssueId, event.companyId);
  if (!sourceIssue) {
    ctx.logger.warn("Quipo: source issue not found for update extraction", { sourceIssueId });
    return;
  }

  if (isQuipoOriginated(sourceIssue.originKind)) {
    ctx.logger.debug("Quipo: skipping update on plugin-owned issue", { sourceIssueId });
    return;
  }

  // Key the idempotency record by the source-issue (issueId, updatedAt) tuple
  // rather than the transport event id, so at-least-once redelivery with a new
  // eventId for the same logical patch does not enqueue duplicate work.
  const originId = updateOriginId(sourceIssue.id, sourceIssue.updatedAt);
  const lockKey = `${event.companyId}:${originId}`;

  await withClaimLock(lockKey, async () => {
    const dedupe = await alreadyExtracted(ctx, event.companyId, originId);
    if (dedupe.extracted) {
      ctx.logger.debug("Quipo: extraction already queued for update", {
        sourceIssueId,
        originId,
      });
      return;
    }

    const identifier = payload.identifier ?? sourceIssue.identifier ?? sourceIssue.id;
    const patchSummary = JSON.stringify(payload.patch ?? {});

    const description = [
      `Extract atomic facts from an update to ${identifier}.`,
      "",
      `- source issue: ${sourceIssue.id}`,
      `- source updatedAt: ${sourceIssue.updatedAt instanceof Date ? sourceIssue.updatedAt.toISOString() : sourceIssue.updatedAt}`,
      `- event id: ${event.eventId}`,
      payload.agentId ? `- updated by agent: ${payload.agentId}` : "- updated by: board user",
      "",
      "Patch:",
      "```json",
      patchSummary,
      "```",
      "",
      "Return your response as a single JSON object matching the memory-worker output contract.",
    ].join("\n");

    const extractionIssue = await ctx.issues.create({
      companyId: event.companyId,
      projectId: sourceIssue.projectId ?? undefined,
      title: `Quipo: extract facts from update on ${identifier}`,
      description,
      status: "todo",
      priority: "low",
      assigneeAgentId: memoryAgentId,
      originId,
      inheritExecutionWorkspaceFromIssueId: sourceIssue.id,
      actor: {
        actorAgentId: payload.agentId ?? null,
        actorRunId: payload.runId ?? null,
      },
    });

    await ctx.state.set(idempotencyStateKey(originId), {
      extractionIssueId: extractionIssue.id,
      eventId: event.eventId,
    });

    const updateLink: ExtractionLink = {
      sourceIssueId: sourceIssue.id,
      sourceCommentId: null,
      sourceKind: "issue_update",
      peerAgentId: payload.agentId ?? null,
      originId,
    };
    await ctx.state.set(extractionLinkStateKey(extractionIssue.id), updateLink);

    ctx.logger.info("Quipo: queued issue-update fact extraction", {
      sourceIssueId: sourceIssue.id,
      extractionIssueId: extractionIssue.id,
      originId,
    });

    await wakeExtractionAssignee(
      ctx,
      event.companyId,
      extractionIssue.id,
      `quipo extraction for ${identifier} (issue_update)`,
    );
  });
}

interface MemoryWorkerCommentPayload {
  commentId?: string;
  bodySnippet?: string;
  agentId?: string | null;
  runId?: string | null;
}

/** Handler for comments posted by the memory-worker on plugin-owned
 *  extraction issues. Parses the JSON body, persists facts/sessions/peer_models,
 *  and flips the extraction issue to `done` so it does not linger.
 *
 *  Listens to the same `issue.comment.created` channel as
 *  {@link onIssueCommentCreated}; the two paths are mutually exclusive
 *  because comments authored by the memory-worker on a plugin-origin issue
 *  are skipped by the source-extraction path. */
export async function onMemoryWorkerComment(
  ctx: PluginContext,
  event: PluginEvent,
): Promise<void> {
  const payload = (event.payload ?? {}) as MemoryWorkerCommentPayload;
  const commentId = payload.commentId;
  if (!commentId) return;

  const config = await getQuipoRuntimeConfig(ctx);
  if (!config.enabled) return;
  const memoryAgentId = config.memoryAgentId;
  if (!memoryAgentId) return;

  const sourceIssueId = event.entityId;
  if (!sourceIssueId) return;

  // Fast skip when payload.agentId is *explicitly* set to a non-memory agent
  // — saves the issue + comments lookup for the common case of board users
  // and peer agents commenting on extraction issues. We deliberately do NOT
  // bail when payload.agentId is null/undefined: the activity-log → plugin
  // event bridge can omit agentId in some delivery paths (RED-210), and the
  // comment row's authorAgentId is the authoritative source of truth for who
  // wrote the comment. Gating only on payload.agentId would silently skip
  // valid memory-worker harvests.
  if (payload.agentId && payload.agentId !== memoryAgentId) return;

  // Comments live on the extraction issue (plugin-owned); skip non-plugin
  // issues fast.
  const extractionIssue = await ctx.issues.get(sourceIssueId, event.companyId);
  if (!extractionIssue) return;
  if (!isQuipoOriginated(extractionIssue.originKind)) return;

  // Recover source-context from the link record we wrote at create-time.
  const link = (await ctx.state.get(extractionLinkStateKey(extractionIssue.id))) as
    | ExtractionLink
    | null
    | undefined;
  if (!link) {
    ctx.logger.warn(
      "Quipo: memory-worker comment on extraction issue with no stored link — skipping harvest",
      { extractionIssueId: extractionIssue.id, commentId },
    );
    return;
  }

  // The event delivers a snippet, not the full body. Pull the canonical
  // comment body via the host so a long fact list is not silently truncated.
  // RED-169: do NOT fall back to `payload.bodySnippet` if the comment row is
  // not yet visible — feeding a truncated snippet to the parser would persist
  // a permanent `parse_error` outcome, and because state is keyed by
  // commentId, the later retry with the full body would be skipped. Instead,
  // bail without persisting state; the retry on `issue.updated` (when the
  // memory-worker self-PATCHes the extraction issue to `done`) will pick it
  // up once the comment has propagated.
  const comments = await ctx.issues.listComments(extractionIssue.id, event.companyId);
  const target = comments.find((c) => c.id === commentId);
  if (!target) {
    ctx.logger.warn(
      "Quipo: memory-worker comment not yet visible — deferring harvest until issue.updated retry",
      { extractionIssueId: extractionIssue.id, commentId },
    );
    return;
  }

  // RED-210: authoritative author check. payload.agentId can be null in some
  // event delivery paths even though the comment row carries the correct
  // authorAgentId, so trust the row. Non-memory-worker comments on extraction
  // issues (e.g. a board user noting something) carry no JSON facts and must
  // not run through the harvest parser.
  if (target.authorAgentId !== memoryAgentId) return;

  const fullBody = target.body ?? "";
  if (!fullBody) {
    ctx.logger.warn("Quipo: empty memory-worker comment body — skipping harvest", {
      extractionIssueId: extractionIssue.id,
      commentId,
    });
    return;
  }

  const result = await harvestExtraction(ctx, {
    companyId: event.companyId,
    commentBody: fullBody,
    commentId,
    extractionIssueId: extractionIssue.id,
    link,
    extractionRunId: payload.runId ?? null,
  });

  // Close the extraction issue when the harvest completed (including empty
  // results — an empty {facts:[]} response is valid). Leave it open on
  // parse_error so a human or follow-up retry can investigate.
  if (
    (result.status === "harvested" || result.status === "empty") &&
    extractionIssue.status !== "done"
  ) {
    try {
      await ctx.issues.update(
        extractionIssue.id,
        { status: "done" },
        event.companyId,
        { actorAgentId: memoryAgentId, actorRunId: payload.runId ?? null },
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      ctx.logger.debug("Quipo: could not close extraction issue (non-fatal)", {
        extractionIssueId: extractionIssue.id,
        detail,
      });
    }
  }
}

/**
 * Retry the harvest path for plugin-owned extraction issues on `issue.updated`.
 *
 * Why this exists (RED-169 fix #2): the live `issue.comment.created` event can
 * fire before the comment row is visible to `ctx.issues.listComments`
 * (eventual-consistency window between the comment-write and read replica).
 * `onMemoryWorkerComment` deliberately bails without persisting state in that
 * case, so something else has to re-trigger the harvest. The memory-worker
 * self-PATCHes the extraction issue to `done` after posting its JSON comment,
 * so by the time the resulting `issue.updated` arrives the comment is reliably
 * visible. This handler scans memory-worker comments on the extraction issue
 * and runs `harvestExtraction` for any that don't already have a recorded
 * harvest state. `harvestExtraction` is idempotent on `commentId`, so any
 * comment already harvested via the live path is a cheap state-read no-op.
 */
export async function onExtractionIssueUpdated(
  ctx: PluginContext,
  event: PluginEvent,
): Promise<void> {
  const extractionIssueId = event.entityId;
  if (!extractionIssueId) return;

  const config = await getQuipoRuntimeConfig(ctx);
  if (!config.enabled) return;
  const memoryAgentId = config.memoryAgentId;
  if (!memoryAgentId) return;

  const issue = await ctx.issues.get(extractionIssueId, event.companyId);
  if (!issue) return;
  if (!isQuipoOriginated(issue.originKind)) return;

  // Only re-run harvest when we recognise the link record — filters out other
  // plugin-origin issues we don't own.
  const link = (await ctx.state.get(extractionLinkStateKey(issue.id))) as
    | ExtractionLink
    | null
    | undefined;
  if (!link) return;

  const comments = await ctx.issues.listComments(issue.id, event.companyId);
  let didHarvest = false;
  for (const c of comments) {
    if (c.authorAgentId !== memoryAgentId) continue;
    if (!c.body) continue;

    const existing = await ctx.state.get(harvestStateKey(c.id));
    if (existing) continue;

    const result = await harvestExtraction(ctx, {
      companyId: event.companyId,
      commentBody: c.body,
      commentId: c.id,
      extractionIssueId: issue.id,
      link,
      extractionRunId: null,
    });
    if (result.status === "harvested" || result.status === "empty") {
      didHarvest = true;
    }
  }

  // RED-210: defense in depth. If `onMemoryWorkerComment` missed the live
  // event (e.g. delivery dropped during a worker restart, payload.agentId
  // was null), the harvest issue can stay `in_progress` forever even after
  // the retry path successfully harvested the comment. Close it here whenever
  // we did harvest a fresh memory-worker comment and the issue is still open.
  if (didHarvest && issue.status !== "done") {
    try {
      await ctx.issues.update(
        issue.id,
        { status: "done" },
        event.companyId,
        { actorAgentId: memoryAgentId, actorRunId: null },
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      ctx.logger.debug("Quipo: could not close extraction issue from retry path (non-fatal)", {
        extractionIssueId: issue.id,
        detail,
      });
    }
  }
}

export function registerQuipoEventHandlers(ctx: PluginContext): void {
  ctx.events.on("issue.comment.created", (event) => onIssueCommentCreated(ctx, event));
  ctx.events.on("issue.updated", (event) => onIssueUpdated(ctx, event));
  // Harvest path: parse the memory-worker's JSON reply and persist facts.
  // Lives on the same event channel as the source-extraction path; the two
  // are mutually exclusive because comments authored by the memory-worker on
  // a plugin-owned issue are skipped by the source-extraction handler above.
  ctx.events.on("issue.comment.created", (event) => onMemoryWorkerComment(ctx, event));
  // Retry harvest when an extraction issue is updated (eg. the memory-worker
  // self-PATCHing to `done` after posting its JSON reply). Closes the
  // eventual-consistency gap where the comment isn't yet visible at
  // comment.created time.
  ctx.events.on("issue.updated", (event) => onExtractionIssueUpdated(ctx, event));
}
