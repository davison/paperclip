import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import type { Issue, IssueComment } from "@paperclipai/shared";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";

import manifest from "../src/manifest.js";
import {
  MAX_BATCHED_DEDUPE_ENTRIES,
  commentOriginId,
  extractionSourceStateKey,
  parseErrorCountStateKey,
  registerQuipoEventHandlers,
} from "../src/event-handlers.js";

const COMPANY_ID = "00000000-0000-0000-0000-00000000c0c0";
const PROJECT_ID = "00000000-0000-0000-0000-0000000000a1";
const SOURCE_ISSUE_ID = "00000000-0000-0000-0000-000000000111";
const PLUGIN_ISSUE_ID = "00000000-0000-0000-0000-000000000222";
const MEMORY_AGENT_ID = "00000000-0000-0000-0000-0000000000aa";
const OTHER_AGENT_ID = "00000000-0000-0000-0000-0000000000bb";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  const now = new Date();
  const base: Issue = {
    id: SOURCE_ISSUE_ID,
    companyId: COMPANY_ID,
    projectId: PROJECT_ID,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Source issue",
    description: "An issue someone is talking about",
    status: "in_progress",
    priority: "medium",
    assigneeAgentId: OTHER_AGENT_ID,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 42,
    identifier: "RED-42",
    originKind: "manual",
    originId: null,
    originRunId: null,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: now,
    updatedAt: now,
  };
  return { ...base, ...overrides };
}

function makeHarness(
  config: Record<string, unknown> = { enabled: true, memoryAgentId: MEMORY_AGENT_ID },
): TestHarness {
  const harness = createTestHarness({ manifest, config });
  registerQuipoEventHandlers(harness.ctx);
  harness.seed({
    issues: [
      makeIssue(),
      makeIssue({
        id: PLUGIN_ISSUE_ID,
        identifier: "RED-77",
        originKind: `plugin:${manifest.id}`,
      }),
    ],
  });
  return harness;
}

async function emitCommentCreated(
  harness: TestHarness,
  overrides: { commentId?: string; agentId?: string | null; entityId?: string; eventId?: string } = {},
) {
  const commentId = overrides.commentId ?? randomUUID();
  const eventId = overrides.eventId ?? randomUUID();
  await harness.emit(
    "issue.comment.created",
    {
      identifier: "RED-42",
      commentId,
      bodySnippet: "We agreed to use TypeScript everywhere",
      agentId: overrides.agentId ?? null,
      runId: null,
    },
    {
      eventId,
      entityId: overrides.entityId ?? SOURCE_ISSUE_ID,
      entityType: "issue",
      companyId: COMPANY_ID,
    },
  );
  return { commentId, eventId };
}

async function emitIssueUpdated(
  harness: TestHarness,
  overrides: {
    eventId?: string;
    patch?: Record<string, unknown>;
    agentId?: string | null;
    entityId?: string;
  } = {},
) {
  const eventId = overrides.eventId ?? randomUUID();
  await harness.emit(
    "issue.updated",
    {
      identifier: "RED-42",
      patch: overrides.patch ?? { description: "New description body" },
      _previous: { status: "todo" },
      agentId: overrides.agentId ?? null,
      runId: null,
    },
    {
      eventId,
      entityId: overrides.entityId ?? SOURCE_ISSUE_ID,
      entityType: "issue",
      companyId: COMPANY_ID,
    },
  );
  return { eventId };
}

describe("Quipo event handlers — issue.comment.created", () => {
  let harness: TestHarness;
  beforeEach(() => {
    harness = makeHarness();
  });

  it("creates an extraction issue assigned to the memory agent", async () => {
    const { commentId } = await emitCommentCreated(harness);
    const all = await harness.ctx.issues.list({ companyId: COMPANY_ID });
    const extraction = all.find((issue) => issue.originId === `comment:${commentId}`);
    expect(extraction).toBeDefined();
    expect(extraction!.assigneeAgentId).toBe(MEMORY_AGENT_ID);
    expect(extraction!.projectId).toBe(PROJECT_ID);
    expect(extraction!.priority).toBe("low");
    expect(extraction!.title).toContain("RED-42");
    expect(extraction!.description).toContain(commentId);
    expect(extraction!.description).toContain("We agreed to use TypeScript");
    expect(extraction!.originKind).toBe(`plugin:${manifest.id}`);
    // RED-163: extraction issues are created hidden so they do not pollute
    // the human-facing default `/issues` list view. The server's
    // `?includeHidden=true` filter is the admin opt-in for diagnostics.
    expect(extraction!.hiddenAt).toBeInstanceOf(Date);
  });

  it("RED-163: batches a second comment on the same source into the open extraction (no second issue)", async () => {
    const { commentId: firstCommentId } = await emitCommentCreated(harness);
    const allAfterFirst = await harness.ctx.issues.list({ companyId: COMPANY_ID });
    const firstExtraction = allAfterFirst.find((issue) => issue.originId === `comment:${firstCommentId}`);
    expect(firstExtraction).toBeDefined();

    // Fresh comment on the same source — must NOT create a second extraction
    // issue; must append to the existing one as a batched comment.
    const { commentId: secondCommentId } = await emitCommentCreated(harness);
    expect(secondCommentId).not.toBe(firstCommentId);

    const allAfterSecond = await harness.ctx.issues.list({ companyId: COMPANY_ID });
    const extractions = allAfterSecond.filter(
      (issue) =>
        issue.originKind === `plugin:${manifest.id}` &&
        typeof issue.originId === "string" &&
        issue.originId.startsWith("comment:"),
    );
    expect(extractions).toHaveLength(1);
    expect(extractions[0].id).toBe(firstExtraction!.id);

    const comments = await harness.ctx.issues.listComments(firstExtraction!.id, COMPANY_ID);
    const batched = comments.find((c) => c.body.includes(`comment id: ${secondCommentId}`));
    expect(batched, "second comment must be appended as a batched comment").toBeDefined();
    expect(batched!.body).toContain("batched into the same extraction");
  });

  it("RED-163: dedupes per (sourceIssueId, commentId) — replayed second-comment events do not re-append", async () => {
    await emitCommentCreated(harness);
    const sharedSecondCommentId = randomUUID();
    await emitCommentCreated(harness, { commentId: sharedSecondCommentId });
    // Replay of the same second-comment event (at-least-once redelivery).
    await emitCommentCreated(harness, { commentId: sharedSecondCommentId });

    const all = await harness.ctx.issues.list({ companyId: COMPANY_ID });
    const extractions = all.filter(
      (issue) =>
        issue.originKind === `plugin:${manifest.id}` &&
        typeof issue.originId === "string" &&
        issue.originId.startsWith("comment:"),
    );
    expect(extractions).toHaveLength(1);
    const comments = await harness.ctx.issues.listComments(extractions[0].id, COMPANY_ID);
    const batchedForReplay = comments.filter((c) =>
      c.body.includes(`comment id: ${sharedSecondCommentId}`),
    );
    expect(batchedForReplay).toHaveLength(1);
  });

  it("RED-163: opens a fresh extraction after the previous one closes", async () => {
    const { commentId: firstCommentId } = await emitCommentCreated(harness);
    const allAfterFirst = await harness.ctx.issues.list({ companyId: COMPANY_ID });
    const firstExtraction = allAfterFirst.find((issue) => issue.originId === `comment:${firstCommentId}`);
    expect(firstExtraction).toBeDefined();

    // Simulate a successful harvest that closes the extraction issue and
    // clears the per-source state (the close path inside `closeExtractionIssue`
    // does this via the link record).
    await harness.ctx.issues.update(firstExtraction!.id, { status: "done" }, COMPANY_ID, {
      actorAgentId: MEMORY_AGENT_ID,
    });
    await harness.ctx.state.delete({
      scopeKind: "instance",
      namespace: "extractions",
      stateKey: `source:${SOURCE_ISSUE_ID}`,
    });

    // The next fact-bearing comment on the same source must open a fresh
    // extraction, not silently disappear.
    const { commentId: laterCommentId } = await emitCommentCreated(harness);
    const allAfterLater = await harness.ctx.issues.list({ companyId: COMPANY_ID });
    const laterExtraction = allAfterLater.find((issue) => issue.originId === `comment:${laterCommentId}`);
    expect(laterExtraction).toBeDefined();
    expect(laterExtraction!.id).not.toBe(firstExtraction!.id);
  });

  it("is idempotent: repeat events for the same comment do not duplicate the extraction issue", async () => {
    const { commentId } = await emitCommentCreated(harness);
    await emitCommentCreated(harness, { commentId });
    const all = await harness.ctx.issues.list({ companyId: COMPANY_ID });
    const extractions = all.filter((issue) => issue.originId === `comment:${commentId}`);
    expect(extractions).toHaveLength(1);
  });

  it("RED-173: caps per-source batchedCommentIds at MAX_BATCHED_DEDUPE_ENTRIES (no unbounded growth)", async () => {
    // Open an extraction issue for the source.
    const { commentId: firstCommentId } = await emitCommentCreated(harness);
    const allAfterFirst = await harness.ctx.issues.list({ companyId: COMPANY_ID });
    const extraction = allAfterFirst.find((issue) => issue.originId === `comment:${firstCommentId}`);
    expect(extraction).toBeDefined();

    // Pre-fill the per-source dedupe array with MAX_BATCHED_DEDUPE_ENTRIES
    // synthetic comment ids so we exercise the cap without emitting thousands
    // of events. This simulates a long-lived open extraction on a high-volume
    // source.
    const stateKey = extractionSourceStateKey(SOURCE_ISSUE_ID);
    const synthetic = Array.from({ length: MAX_BATCHED_DEDUPE_ENTRIES }, (_, i) => `synthetic-${i}`);
    await harness.ctx.state.set(stateKey, {
      openExtractionIssueId: extraction!.id,
      batchedCommentIds: [firstCommentId, ...synthetic],
      batchedUpdateOriginIds: [],
    });

    // Real fresh comment must batch and the dedupe array must stay bounded.
    const { commentId: nextCommentId } = await emitCommentCreated(harness);
    const stateAfter = (await harness.ctx.state.get(stateKey)) as
      | { batchedCommentIds: string[]; batchedUpdateOriginIds: string[]; openExtractionIssueId: string | null }
      | null;
    expect(stateAfter).not.toBeNull();
    expect(stateAfter!.openExtractionIssueId).toBe(extraction!.id);
    expect(stateAfter!.batchedCommentIds.length).toBeLessThanOrEqual(MAX_BATCHED_DEDUPE_ENTRIES);
    // The newest entry must be retained — it's the redelivery dedupe anchor.
    expect(stateAfter!.batchedCommentIds.at(-1)).toBe(nextCommentId);
    // The oldest entry (the original first comment) must have been evicted in
    // favour of the newer ones.
    expect(stateAfter!.batchedCommentIds).not.toContain(firstCommentId);
  });

  it("is idempotent under concurrent delivery of the same comment", async () => {
    // Two workers/processes can race the get→create→set sequence. Without an
    // in-process claim lock + pre-create dedupe, each concurrent delivery
    // would observe missing state and create its own extraction issue.
    const commentId = randomUUID();
    await Promise.all([
      emitCommentCreated(harness, { commentId }),
      emitCommentCreated(harness, { commentId }),
      emitCommentCreated(harness, { commentId }),
      emitCommentCreated(harness, { commentId }),
    ]);
    const all = await harness.ctx.issues.list({ companyId: COMPANY_ID });
    const extractions = all.filter((issue) => issue.originId === `comment:${commentId}`);
    expect(extractions).toHaveLength(1);
  });

  it("skips when memoryAgentId is not configured", async () => {
    const blankHarness = createTestHarness({ manifest, config: { enabled: true } });
    registerQuipoEventHandlers(blankHarness.ctx);
    blankHarness.seed({ issues: [makeIssue()] });
    const before = (await blankHarness.ctx.issues.list({ companyId: COMPANY_ID })).length;
    await emitCommentCreated(blankHarness);
    const after = (await blankHarness.ctx.issues.list({ companyId: COMPANY_ID })).length;
    expect(after).toBe(before);
    expect(blankHarness.logs.some((entry) => entry.message.includes("memoryAgentId not configured"))).toBe(true);
  });

  it("skips when the company has Quipo disabled (default)", async () => {
    const disabledHarness = createTestHarness({
      manifest,
      config: { memoryAgentId: MEMORY_AGENT_ID },
    });
    registerQuipoEventHandlers(disabledHarness.ctx);
    disabledHarness.seed({ issues: [makeIssue()] });
    const before = (await disabledHarness.ctx.issues.list({ companyId: COMPANY_ID })).length;
    await emitCommentCreated(disabledHarness);
    const after = (await disabledHarness.ctx.issues.list({ companyId: COMPANY_ID })).length;
    expect(after).toBe(before);
    expect(
      disabledHarness.logs.some((entry) => entry.message.includes("plugin disabled for this company")),
    ).toBe(true);
  });

  it("skips comments authored by the memory agent itself (no recursion)", async () => {
    const before = (await harness.ctx.issues.list({ companyId: COMPANY_ID })).length;
    await emitCommentCreated(harness, { agentId: MEMORY_AGENT_ID });
    const after = (await harness.ctx.issues.list({ companyId: COMPANY_ID })).length;
    expect(after).toBe(before);
  });

  it("skips comments on issues that the plugin itself created", async () => {
    const before = (await harness.ctx.issues.list({ companyId: COMPANY_ID })).length;
    await emitCommentCreated(harness, { entityId: PLUGIN_ISSUE_ID });
    const after = (await harness.ctx.issues.list({ companyId: COMPANY_ID })).length;
    expect(after).toBe(before);
  });

  it("skips when the source issue cannot be found", async () => {
    const before = (await harness.ctx.issues.list({ companyId: COMPANY_ID })).length;
    await emitCommentCreated(harness, { entityId: "00000000-0000-0000-0000-0000000ffeed" });
    const after = (await harness.ctx.issues.list({ companyId: COMPANY_ID })).length;
    expect(after).toBe(before);
  });

  it("ignores events with no commentId", async () => {
    const before = (await harness.ctx.issues.list({ companyId: COMPANY_ID })).length;
    await harness.emit(
      "issue.comment.created",
      { identifier: "RED-42" },
      { entityId: SOURCE_ISSUE_ID, companyId: COMPANY_ID },
    );
    const after = (await harness.ctx.issues.list({ companyId: COMPANY_ID })).length;
    expect(after).toBe(before);
  });
});

describe("Quipo event handlers — issue.updated", () => {
  let harness: TestHarness;
  beforeEach(() => {
    harness = makeHarness();
  });

  it("creates an extraction issue when description or title changes", async () => {
    await emitIssueUpdated(harness, { patch: { description: "New body" } });
    const all = await harness.ctx.issues.list({ companyId: COMPANY_ID });
    const extraction = all.find((issue) =>
      typeof issue.originId === "string" && issue.originId.startsWith(`update:${SOURCE_ISSUE_ID}:`),
    );
    expect(extraction).toBeDefined();
    expect(extraction!.assigneeAgentId).toBe(MEMORY_AGENT_ID);
    expect(extraction!.title).toContain("RED-42");
  });

  it("skips status-only / assignee-only churn (no fact-bearing fields)", async () => {
    const before = (await harness.ctx.issues.list({ companyId: COMPANY_ID })).length;
    await emitIssueUpdated(harness, { patch: { status: "in_progress" } });
    await emitIssueUpdated(harness, { patch: { assigneeAgentId: OTHER_AGENT_ID } });
    await emitIssueUpdated(harness, { patch: { priority: "high", billingCode: "X" } });
    const after = (await harness.ctx.issues.list({ companyId: COMPANY_ID })).length;
    expect(after).toBe(before);
  });

  it("is idempotent on duplicate event delivery (same eventId)", async () => {
    const { eventId } = await emitIssueUpdated(harness, { patch: { title: "Renamed" } });
    await emitIssueUpdated(harness, { eventId, patch: { title: "Renamed" } });
    const all = await harness.ctx.issues.list({ companyId: COMPANY_ID });
    const extractions = all.filter((issue) =>
      typeof issue.originId === "string" && issue.originId.startsWith(`update:${SOURCE_ISSUE_ID}:`),
    );
    expect(extractions).toHaveLength(1);
  });

  it("is idempotent on at-least-once redelivery with a NEW eventId for the same logical update", async () => {
    // Same source issue, same updatedAt, but the transport assigns different
    // eventIds on each delivery. Idempotency must be keyed by (issueId, updatedAt),
    // not by the transport eventId — otherwise we duplicate downstream work.
    await emitIssueUpdated(harness, { patch: { title: "Renamed" } });
    await emitIssueUpdated(harness, { patch: { title: "Renamed" } }); // fresh eventId
    await emitIssueUpdated(harness, { patch: { title: "Renamed" } }); // fresh eventId
    const all = await harness.ctx.issues.list({ companyId: COMPANY_ID });
    const extractions = all.filter((issue) =>
      typeof issue.originId === "string" && issue.originId.startsWith(`update:${SOURCE_ISSUE_ID}:`),
    );
    expect(extractions).toHaveLength(1);
  });

  it("batches a second genuine update into the same open extraction (RED-163)", async () => {
    // RED-163: while an extraction issue for this source is still open, a
    // *new* logical update on the same source must NOT spawn a second
    // extraction — it must be folded into the open one as an additional
    // comment. The memory-worker re-reads the issue body on its next wake
    // and harvests all batched patches together.
    await emitIssueUpdated(harness, { patch: { title: "First rename" } });

    // Re-seed the source issue with a later updatedAt to simulate a real
    // subsequent edit on the board side.
    const later = new Date(Date.now() + 60_000);
    harness.seed({
      issues: [makeIssue({ updatedAt: later, title: "Renamed again" })],
    });

    await emitIssueUpdated(harness, { patch: { title: "Renamed again" } });
    const all = await harness.ctx.issues.list({ companyId: COMPANY_ID });
    const extractions = all.filter((issue) =>
      typeof issue.originId === "string" && issue.originId.startsWith(`update:${SOURCE_ISSUE_ID}:`),
    );
    expect(extractions).toHaveLength(1);
    // The second update should appear as an appended comment on the open
    // extraction issue.
    const [openExtraction] = extractions;
    const comments = await harness.ctx.issues.listComments(openExtraction.id, COMPANY_ID);
    const appendedFromUpdate = comments.find((c) => c.body.includes("batched into the same extraction"));
    expect(appendedFromUpdate, "expected the second update to be appended as a batched comment").toBeDefined();
  });

  it("re-extracts after the previous extraction is closed (RED-163)", async () => {
    // Once the memory-worker harvests and the extraction issue flips to
    // `done`, the per-source batch state must clear so the next update on
    // the source opens a fresh extraction ticket.
    await emitIssueUpdated(harness, { patch: { title: "First rename" } });
    const all1 = await harness.ctx.issues.list({ companyId: COMPANY_ID });
    const first = all1.find(
      (issue) => typeof issue.originId === "string" && issue.originId.startsWith(`update:${SOURCE_ISSUE_ID}:`),
    );
    expect(first, "first extraction issue must exist").toBeDefined();

    // Simulate a successful harvest closing the issue.
    await harness.ctx.issues.update(first!.id, { status: "done" }, COMPANY_ID, {
      actorAgentId: MEMORY_AGENT_ID,
    });
    // Clear the per-source state via the public state API the way the close
    // path does — the harness's `update` does not run plugin event handlers.
    await harness.ctx.state.delete({
      scopeKind: "instance",
      namespace: "extractions",
      stateKey: `source:${SOURCE_ISSUE_ID}`,
    });

    // A genuinely new logical update on the (now-quiet) source should open a
    // fresh extraction.
    const later = new Date(Date.now() + 60_000);
    harness.seed({
      issues: [makeIssue({ updatedAt: later, title: "Renamed again" })],
    });
    await emitIssueUpdated(harness, { patch: { title: "Renamed again" } });
    const all2 = await harness.ctx.issues.list({ companyId: COMPANY_ID });
    const extractions = all2.filter(
      (issue) => typeof issue.originId === "string" && issue.originId.startsWith(`update:${SOURCE_ISSUE_ID}:`),
    );
    expect(extractions).toHaveLength(2);
  });

  it("is idempotent under concurrent delivery of the same logical update", async () => {
    // Fan-in: simulate the host delivering the same update concurrently to
    // this worker. Without an in-process claim lock + pre-create dedupe,
    // every concurrent delivery would observe missing state and create its
    // own extraction issue.
    const eventId = randomUUID();
    await Promise.all([
      emitIssueUpdated(harness, { eventId, patch: { description: "Bulk text" } }),
      emitIssueUpdated(harness, { patch: { description: "Bulk text" } }),
      emitIssueUpdated(harness, { patch: { description: "Bulk text" } }),
      emitIssueUpdated(harness, { patch: { description: "Bulk text" } }),
    ]);
    const all = await harness.ctx.issues.list({ companyId: COMPANY_ID });
    const extractions = all.filter((issue) =>
      typeof issue.originId === "string" && issue.originId.startsWith(`update:${SOURCE_ISSUE_ID}:`),
    );
    expect(extractions).toHaveLength(1);
  });

  it("skips updates authored by the memory agent itself", async () => {
    const before = (await harness.ctx.issues.list({ companyId: COMPANY_ID })).length;
    await emitIssueUpdated(harness, {
      patch: { description: "memory agent rewrote it" },
      agentId: MEMORY_AGENT_ID,
    });
    const after = (await harness.ctx.issues.list({ companyId: COMPANY_ID })).length;
    expect(after).toBe(before);
  });

  it("skips updates on plugin-owned issues", async () => {
    const before = (await harness.ctx.issues.list({ companyId: COMPANY_ID })).length;
    await emitIssueUpdated(harness, {
      entityId: PLUGIN_ISSUE_ID,
      patch: { description: "plugin issue self-edit" },
    });
    const after = (await harness.ctx.issues.list({ companyId: COMPANY_ID })).length;
    expect(after).toBe(before);
  });

  it("skips when memoryAgentId is not configured", async () => {
    const blankHarness = createTestHarness({ manifest, config: { enabled: true } });
    registerQuipoEventHandlers(blankHarness.ctx);
    blankHarness.seed({ issues: [makeIssue()] });
    const before = (await blankHarness.ctx.issues.list({ companyId: COMPANY_ID })).length;
    await emitIssueUpdated(blankHarness, { patch: { title: "Renamed" } });
    const after = (await blankHarness.ctx.issues.list({ companyId: COMPANY_ID })).length;
    expect(after).toBe(before);
  });

  it("skips when the company has Quipo disabled (default)", async () => {
    const disabledHarness = createTestHarness({
      manifest,
      config: { memoryAgentId: MEMORY_AGENT_ID },
    });
    registerQuipoEventHandlers(disabledHarness.ctx);
    disabledHarness.seed({ issues: [makeIssue()] });
    const before = (await disabledHarness.ctx.issues.list({ companyId: COMPANY_ID })).length;
    await emitIssueUpdated(disabledHarness, { patch: { title: "Renamed" } });
    const after = (await disabledHarness.ctx.issues.list({ companyId: COMPANY_ID })).length;
    expect(after).toBe(before);
    expect(
      disabledHarness.logs.some((entry) => entry.message.includes("plugin disabled for this company")),
    ).toBe(true);
  });

  it("skips when extractionScope is comments_only", async () => {
    const commentsOnlyHarness = createTestHarness({
      manifest,
      config: {
        enabled: true,
        memoryAgentId: MEMORY_AGENT_ID,
        extractionScope: "comments_only",
      },
    });
    registerQuipoEventHandlers(commentsOnlyHarness.ctx);
    commentsOnlyHarness.seed({ issues: [makeIssue()] });
    const before = (await commentsOnlyHarness.ctx.issues.list({ companyId: COMPANY_ID })).length;
    await emitIssueUpdated(commentsOnlyHarness, { patch: { title: "Renamed" } });
    const after = (await commentsOnlyHarness.ctx.issues.list({ companyId: COMPANY_ID })).length;
    expect(after).toBe(before);
    expect(
      commentsOnlyHarness.logs.some((entry) =>
        entry.message.includes("extractionScope=comments_only"),
      ),
    ).toBe(true);
  });
});

describe("Quipo memory-worker comment — extraction-issue closure (RED-162)", () => {
  let harness: TestHarness;
  let extractionIssueId: string;

  function makeReplyComment(overrides: Partial<IssueComment> = {}): IssueComment {
    const now = new Date();
    return {
      id: randomUUID(),
      companyId: COMPANY_ID,
      issueId: extractionIssueId,
      authorAgentId: MEMORY_AGENT_ID,
      authorUserId: null,
      body: "",
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  async function emitWorkerReply(reply: IssueComment) {
    await harness.emit(
      "issue.comment.created",
      {
        identifier: "RED-77",
        commentId: reply.id,
        bodySnippet: reply.body.slice(0, 240),
        agentId: MEMORY_AGENT_ID,
        runId: null,
      },
      {
        entityId: extractionIssueId,
        entityType: "issue",
        companyId: COMPANY_ID,
      },
    );
  }

  beforeEach(async () => {
    harness = makeHarness();
    // Create the extraction issue via the comment-created path so the link
    // record + idempotency state are set up identically to production.
    const sourceCommentId = randomUUID();
    await emitCommentCreated(harness, { commentId: sourceCommentId });
    const extraction = (await harness.ctx.issues.list({ companyId: COMPANY_ID })).find(
      (i) => i.originId === commentOriginId(sourceCommentId),
    );
    if (!extraction) throw new Error("extraction issue not created in beforeEach");
    extractionIssueId = extraction.id;
  });

  it("closes the extraction issue after a single empty {facts:[]} reply", async () => {
    const reply = makeReplyComment({ body: JSON.stringify({ facts: [] }) });
    harness.seed({ issueComments: [reply] });

    await emitWorkerReply(reply);

    const closed = await harness.ctx.issues.get(extractionIssueId, COMPANY_ID);
    expect(closed!.status).toBe("done");

    // No fact inserts (empty payload).
    const factInserts = harness.dbExecutes.filter((e) => /INSERT INTO .*\.facts/.test(e.sql));
    expect(factInserts).toHaveLength(0);
  });

  it("force-closes via the prior-comment guard on a second worker reply, without re-running harvest", async () => {
    // First valid reply: harvest runs, issue closes.
    const firstReply = makeReplyComment({
      body: JSON.stringify({
        facts: [{ content: "X", about_peer: null, confidence: 0.95 }],
      }),
    });
    harness.seed({ issueComments: [firstReply] });
    await emitWorkerReply(firstReply);

    const factInsertsAfterFirst = harness.dbExecutes.filter((e) =>
      /INSERT INTO .*\.facts/.test(e.sql),
    ).length;
    expect(factInsertsAfterFirst).toBe(1);

    // Simulate a heartbeat-driven stale state: the host re-marks the
    // extraction issue `in_progress` and the worker posts a second reply.
    // Without the loop-breaker guard, harvest would re-run (hit
    // `already_harvested`) — with the guard, it short-circuits before harvest.
    await harness.ctx.issues.update(
      extractionIssueId,
      { status: "in_progress" },
      COMPANY_ID,
    );
    const secondReply = makeReplyComment({
      body: JSON.stringify({
        facts: [{ content: "Y", about_peer: null, confidence: 0.9 }],
      }),
    });
    harness.seed({ issueComments: [firstReply, secondReply] });

    await emitWorkerReply(secondReply);

    // Issue is closed again.
    const closed = await harness.ctx.issues.get(extractionIssueId, COMPANY_ID);
    expect(closed!.status).toBe("done");

    // Crucially, no second harvest ran: fact inserts unchanged.
    const factInsertsAfterSecond = harness.dbExecutes.filter((e) =>
      /INSERT INTO .*\.facts/.test(e.sql),
    ).length;
    expect(factInsertsAfterSecond).toBe(factInsertsAfterFirst);
  });

  it("blocks the extraction issue with a reason comment after repeated parse errors", async () => {
    // First parse_error: issue stays open for retry, no block yet.
    const garbage1 = makeReplyComment({ body: "definitely not json" });
    harness.seed({ issueComments: [garbage1] });
    await emitWorkerReply(garbage1);

    let issue = await harness.ctx.issues.get(extractionIssueId, COMPANY_ID);
    expect(issue!.status).not.toBe("blocked");
    expect(issue!.status).not.toBe("done");

    // Second parse_error on the same extraction issue: handler must mark
    // blocked and post a reason comment naming the failure.
    const garbage2 = makeReplyComment({ body: "still not json {{" });
    harness.seed({ issueComments: [garbage1, garbage2] });
    await emitWorkerReply(garbage2);

    issue = await harness.ctx.issues.get(extractionIssueId, COMPANY_ID);
    expect(issue!.status).toBe("blocked");

    // Reason comment authored by the memory agent, body names the parse
    // failure.
    const allComments = await harness.ctx.issues.listComments(extractionIssueId, COMPANY_ID);
    const reason = allComments.find(
      (c) =>
        c.authorAgentId === MEMORY_AGENT_ID &&
        c.body.includes("Quipo: extraction blocked") &&
        c.id !== garbage1.id &&
        c.id !== garbage2.id,
    );
    expect(reason).toBeDefined();
    expect(reason!.body).toContain("could not be parsed");
  });

  it("does not close the extraction issue as done on redelivery of the same parse_error comment (RED-166)", async () => {
    // First delivery of malformed JSON: harvest stores parse_error state for
    // this commentId and leaves the issue open for retry.
    const garbage = makeReplyComment({ body: "definitely not json" });
    harness.seed({ issueComments: [garbage] });
    await emitWorkerReply(garbage);

    let issue = await harness.ctx.issues.get(extractionIssueId, COMPANY_ID);
    expect(issue!.status).not.toBe("done");

    // Redelivery of the exact same commentId. harvestExtraction's idempotency
    // key hits the prior parse_error state. This must NOT surface as
    // `already_harvested` (which would close the issue as `done` with zero
    // successful harvest); the redelivery still represents a parse failure.
    await emitWorkerReply(garbage);

    issue = await harness.ctx.issues.get(extractionIssueId, COMPANY_ID);
    expect(issue!.status).not.toBe("done");

    // No facts persisted by either delivery.
    const factInserts = harness.dbExecutes.filter((e) =>
      /INSERT INTO .*\.facts/.test(e.sql),
    );
    expect(factInserts).toHaveLength(0);
  });

  it("resets the parse-error counter on a successful parseable outcome so non-consecutive parse errors do not trigger blocked (RED-166)", async () => {
    // The MAX_PARSE_ERROR_ATTEMPTS contract counts *consecutive* parse
    // failures. A successful parseable outcome (harvested / empty /
    // already_harvested) must clear the persisted counter, otherwise a
    // sequence like `parse_error -> harvested -> parse_error` reaches
    // count=2 and wrongly marks the issue `blocked`.

    // 1. First parse_error: counter -> 1, issue stays open.
    const garbage1 = makeReplyComment({ body: "definitely not json" });
    harness.seed({ issueComments: [garbage1] });
    await emitWorkerReply(garbage1);

    const counterAfterFirstParseError = (await harness.ctx.state.get(
      parseErrorCountStateKey(extractionIssueId),
    )) as { count?: number } | null;
    expect(counterAfterFirstParseError?.count).toBe(1);

    // 2. Successful parseable reply: harvest closes the issue. The counter
    // must be cleared so the next parse_error starts a fresh streak. Re-open
    // first to mirror the "heartbeat re-marked it in_progress" path that
    // produced the original RED-162 loop and to keep the harvest path active.
    await harness.ctx.issues.update(
      extractionIssueId,
      { status: "in_progress" },
      COMPANY_ID,
    );
    const good = makeReplyComment({ body: JSON.stringify({ facts: [] }) });
    harness.seed({ issueComments: [garbage1, good] });
    await emitWorkerReply(good);

    const issue = await harness.ctx.issues.get(extractionIssueId, COMPANY_ID);
    expect(issue!.status).toBe("done");

    // 3. The persisted parse-error counter must now be cleared. This is the
    // direct contract: the streak resets on a successful parseable outcome.
    const counterAfterSuccess = await harness.ctx.state.get(
      parseErrorCountStateKey(extractionIssueId),
    );
    expect(counterAfterSuccess).toBeNull();
  });

  it("does not advance the parse-error retry counter when the same parse_error commentId is redelivered (RED-166 dedupe)", async () => {
    // First delivery of malformed JSON: counter goes to 1, issue stays open.
    const garbage = makeReplyComment({ body: "definitely not json" });
    harness.seed({ issueComments: [garbage] });
    await emitWorkerReply(garbage);

    let issue = await harness.ctx.issues.get(extractionIssueId, COMPANY_ID);
    expect(issue!.status).not.toBe("blocked");
    expect(issue!.status).not.toBe("done");

    // Redelivery of the same commentId (at-least-once event bus). Without
    // the per-commentId dedupe, this would push the counter to MAX (=2) and
    // wrongly mark the extraction issue `blocked` even though no new worker
    // attempt has happened.
    await emitWorkerReply(garbage);

    issue = await harness.ctx.issues.get(extractionIssueId, COMPANY_ID);
    expect(issue!.status).not.toBe("blocked");

    // No reason comment posted yet — the block path must not have fired.
    const allComments = await harness.ctx.issues.listComments(extractionIssueId, COMPANY_ID);
    const reason = allComments.find(
      (c) =>
        c.authorAgentId === MEMORY_AGENT_ID &&
        c.body.includes("Quipo: extraction blocked"),
    );
    expect(reason).toBeUndefined();

    // A *new* malformed comment must still advance the counter and trigger
    // the block path — confirming the dedupe is per-commentId, not a global
    // increment freeze.
    const garbage2 = makeReplyComment({ body: "still not json {{" });
    harness.seed({ issueComments: [garbage, garbage2] });
    await emitWorkerReply(garbage2);

    issue = await harness.ctx.issues.get(extractionIssueId, COMPANY_ID);
    expect(issue!.status).toBe("blocked");
  });
});
