import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import type { Issue, IssueComment } from "@paperclipai/shared";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";

import manifest from "../src/manifest.js";
import {
  commentOriginId,
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
  });

  it("is idempotent: repeat events for the same comment do not duplicate the extraction issue", async () => {
    const { commentId } = await emitCommentCreated(harness);
    await emitCommentCreated(harness, { commentId });
    const all = await harness.ctx.issues.list({ companyId: COMPANY_ID });
    const extractions = all.filter((issue) => issue.originId === `comment:${commentId}`);
    expect(extractions).toHaveLength(1);
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

  it("re-extracts when the source issue is genuinely updated again (new updatedAt)", async () => {
    // Sanity check the new key: a *new* logical update should produce a new
    // extraction even though the source issue id is the same.
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
});
