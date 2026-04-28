import type { PluginContext, PluginEvent, ScopeKey } from "@paperclipai/plugin-sdk";

import { QUIPO_PLUGIN_ID, readQuipoConfig } from "./config.js";

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

function idempotencyStateKey(originId: string): ScopeKey {
  return {
    scopeKind: "instance",
    namespace: STATE_NAMESPACE,
    stateKey: originId,
  };
}

function commentOriginId(commentId: string): string {
  return `comment:${commentId}`;
}

function updateOriginId(sourceIssueId: string, updatedAt: Date | string): string {
  const iso = typeof updatedAt === "string" ? updatedAt : updatedAt.toISOString();
  return `update:${sourceIssueId}:${iso}`;
}

async function getMemoryAgentId(ctx: PluginContext): Promise<string | null> {
  const raw = await ctx.config.get();
  return readQuipoConfig(raw).memoryAgentId;
}

function isQuipoOriginated(originKind: unknown): boolean {
  if (typeof originKind !== "string") return false;
  return originKind === QUIPO_ORIGIN_PREFIX || originKind.startsWith(`${QUIPO_ORIGIN_PREFIX}:`);
}

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

/**
 * In-process per-key serialization so two concurrent event deliveries handled by
 * the same worker process cannot both observe missing idempotency state and
 * both create extraction issues. Cross-process safety additionally relies on
 * the pre-create `ctx.issues.list({ originKind, originId })` check below.
 */
const claimLocks = new Map<string, Promise<unknown>>();

function withClaimLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = claimLocks.get(key) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  claimLocks.set(key, next);
  next.finally(() => {
    if (claimLocks.get(key) === next) claimLocks.delete(key);
  }).catch(() => {});
  return next;
}

async function alreadyExtracted(
  ctx: PluginContext,
  companyId: string,
  originId: string,
): Promise<boolean> {
  const stateKey = idempotencyStateKey(originId);
  if (await ctx.state.get(stateKey)) return true;
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
    return true;
  }
  return false;
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

  const memoryAgentId = await getMemoryAgentId(ctx);
  if (!memoryAgentId) {
    ctx.logger.warn("Quipo: memoryAgentId not configured — skipping comment extraction", {
      commentId,
    });
    return;
  }

  if (payload.agentId && payload.agentId === memoryAgentId) {
    ctx.logger.debug("Quipo: skipping comment authored by memory agent", {
      memoryAgentId,
      commentId,
    });
    return;
  }

  const sourceIssueId = event.entityId;
  if (!sourceIssueId) {
    ctx.logger.warn("Quipo: issue.comment.created missing entityId — skipping", { commentId });
    return;
  }

  const originId = commentOriginId(commentId);
  const lockKey = `${event.companyId}:${originId}`;

  await withClaimLock(lockKey, async () => {
    if (await alreadyExtracted(ctx, event.companyId, originId)) {
      ctx.logger.debug("Quipo: extraction already queued for comment", { commentId });
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

    if (isQuipoOriginated(sourceIssue.originKind)) {
      ctx.logger.debug("Quipo: skipping comment on plugin-owned issue", {
        sourceIssueId,
        commentId,
      });
      return;
    }

    const identifier = payload.identifier ?? sourceIssue.identifier ?? sourceIssue.id;
    const description = [
      `Extract atomic facts from a new comment on ${identifier}.`,
      "",
      `- source issue: ${sourceIssue.id}`,
      `- comment id: ${commentId}`,
      payload.agentId ? `- author agent: ${payload.agentId}` : "- author: board user",
      "",
      "Snippet:",
      quote((payload.bodySnippet ?? "").slice(0, 240)),
      "",
      "Return your response as a single JSON object matching the memory-worker output contract.",
    ].join("\n");

    const extractionIssue = await ctx.issues.create({
      companyId: event.companyId,
      projectId: sourceIssue.projectId ?? undefined,
      title: `Quipo: extract facts from comment on ${identifier}`,
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

    ctx.logger.info("Quipo: queued comment fact extraction", {
      sourceIssueId: sourceIssue.id,
      commentId,
      extractionIssueId: extractionIssue.id,
    });
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

  const memoryAgentId = await getMemoryAgentId(ctx);
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
    if (await alreadyExtracted(ctx, event.companyId, originId)) {
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

    ctx.logger.info("Quipo: queued issue-update fact extraction", {
      sourceIssueId: sourceIssue.id,
      extractionIssueId: extractionIssue.id,
      originId,
    });
  });
}

export function registerQuipoEventHandlers(ctx: PluginContext): void {
  ctx.events.on("issue.comment.created", (event) => onIssueCommentCreated(ctx, event));
  ctx.events.on("issue.updated", (event) => onIssueUpdated(ctx, event));
}
