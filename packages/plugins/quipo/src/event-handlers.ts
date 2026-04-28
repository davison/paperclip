import type { PluginContext, PluginEvent, ScopeKey } from "@paperclipai/plugin-sdk";

import { QUIPO_PLUGIN_ID, readQuipoConfig } from "./config.js";

const STATE_NAMESPACE = "extractions";
const QUIPO_ORIGIN_PREFIX = `plugin:${QUIPO_PLUGIN_ID}` as const;

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

function idempotencyKey(kind: "comment" | "update", id: string): ScopeKey {
  return {
    scopeKind: "instance",
    namespace: STATE_NAMESPACE,
    stateKey: `${kind}:${id}`,
  };
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

  const stateKey = idempotencyKey("comment", commentId);
  if (await ctx.state.get(stateKey)) {
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
    originId: commentId,
    inheritExecutionWorkspaceFromIssueId: sourceIssue.id,
    actor: {
      actorAgentId: payload.agentId ?? null,
      actorRunId: payload.runId ?? null,
    },
  });

  await ctx.state.set(stateKey, {
    extractionIssueId: extractionIssue.id,
    eventId: event.eventId,
  });

  ctx.logger.info("Quipo: queued comment fact extraction", {
    sourceIssueId: sourceIssue.id,
    commentId,
    extractionIssueId: extractionIssue.id,
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

  const stateKey = idempotencyKey("update", event.eventId);
  if (await ctx.state.get(stateKey)) {
    ctx.logger.debug("Quipo: extraction already queued for update", { eventId: event.eventId });
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

  const identifier = payload.identifier ?? sourceIssue.identifier ?? sourceIssue.id;
  const patchSummary = JSON.stringify(payload.patch ?? {});

  const description = [
    `Extract atomic facts from an update to ${identifier}.`,
    "",
    `- source issue: ${sourceIssue.id}`,
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
    originId: `update:${sourceIssue.id}:${event.eventId}`,
    inheritExecutionWorkspaceFromIssueId: sourceIssue.id,
    actor: {
      actorAgentId: payload.agentId ?? null,
      actorRunId: payload.runId ?? null,
    },
  });

  await ctx.state.set(stateKey, {
    extractionIssueId: extractionIssue.id,
    eventId: event.eventId,
  });

  ctx.logger.info("Quipo: queued issue-update fact extraction", {
    sourceIssueId: sourceIssue.id,
    extractionIssueId: extractionIssue.id,
  });
}

export function registerQuipoEventHandlers(ctx: PluginContext): void {
  ctx.events.on("issue.comment.created", (event) => onIssueCommentCreated(ctx, event));
  ctx.events.on("issue.updated", (event) => onIssueUpdated(ctx, event));
}
