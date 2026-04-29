import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import type { Issue, IssueComment } from "@paperclipai/shared";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";

import manifest from "../src/manifest.js";
import {
  registerQuipoEventHandlers,
  extractionIdempotencyStateKey,
  commentOriginId,
} from "../src/event-handlers.js";
import {
  extractionLinkStateKey,
  harvestExtraction,
  harvestStateKey,
  levelForConfidence,
  type ExtractionLink,
} from "../src/harvest.js";

const COMPANY_ID = "00000000-0000-0000-0000-00000000c0c0";
const PROJECT_ID = "00000000-0000-0000-0000-0000000000a1";
const SOURCE_ISSUE_ID = "00000000-0000-0000-0000-000000000111";
const MEMORY_AGENT_ID = "00000000-0000-0000-0000-0000000000aa";
const PEER_AGENT_ID = "00000000-0000-0000-0000-0000000000bb";

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
    assigneeAgentId: PEER_AGENT_ID,
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

function makeComment(overrides: Partial<IssueComment> = {}): IssueComment {
  const now = new Date();
  const base: IssueComment = {
    id: randomUUID(),
    companyId: COMPANY_ID,
    issueId: SOURCE_ISSUE_ID,
    authorAgentId: null,
    authorUserId: null,
    body: "",
    createdAt: now,
    updatedAt: now,
  };
  return { ...base, ...overrides };
}

function makeLink(overrides: Partial<ExtractionLink> = {}): ExtractionLink {
  return {
    sourceIssueId: SOURCE_ISSUE_ID,
    sourceCommentId: randomUUID(),
    sourceKind: "comment",
    peerAgentId: PEER_AGENT_ID,
    originId: "comment:" + randomUUID(),
    ...overrides,
  };
}

function makeHarness(
  config: Record<string, unknown> = { enabled: true, memoryAgentId: MEMORY_AGENT_ID },
): TestHarness {
  const harness = createTestHarness({ manifest, config });
  registerQuipoEventHandlers(harness.ctx);
  harness.seed({ issues: [makeIssue()] });
  return harness;
}

describe("harvestExtraction — fact persistence", () => {
  let harness: TestHarness;
  beforeEach(() => {
    harness = makeHarness();
  });

  it("writes facts in a single multi-row INSERT plus a session upsert", async () => {
    const link = makeLink();
    const extractionIssueId = randomUUID();
    const commentId = randomUUID();

    const result = await harvestExtraction(harness.ctx, {
      companyId: COMPANY_ID,
      commentBody: JSON.stringify({
        facts: [
          { content: "Darren prefers TypeScript.", about_peer: "user", confidence: 0.95 },
          { content: "The team uses pnpm workspaces.", about_peer: null, confidence: 0.7 },
        ],
      }),
      commentId,
      extractionIssueId,
      link,
    });

    expect(result.status).toBe("harvested");
    expect(result.factsInserted).toBe(2);
    expect(result.totalFactsInResponse).toBe(2);

    // RED-169: single atomic multi-row INSERT, not per-row execute calls.
    const factInserts = harness.dbExecutes.filter((e) => /INSERT INTO .*\.facts/.test(e.sql));
    expect(factInserts).toHaveLength(1);
    // 2 rows × 7 columns = 14 params.
    expect(factInserts[0].params).toHaveLength(14);
    // First row payload: companyId, sourceIssueId, factAgentId, content, level, sourceIds, metadata.
    expect(factInserts[0].params?.[3]).toBe("Darren prefers TypeScript.");
    expect(factInserts[0].params?.[4]).toBe("explicit");
    // Second row content+level (offset by 7).
    expect(factInserts[0].params?.[10]).toBe("The team uses pnpm workspaces.");
    expect(factInserts[0].params?.[11]).toBe("inferred");

    const sessionUpserts = harness.dbExecutes.filter((e) => /INSERT INTO .*\.sessions/.test(e.sql));
    expect(sessionUpserts).toHaveLength(1);
    expect(sessionUpserts[0].params).toEqual([COMPANY_ID, SOURCE_ISSUE_ID, 2]);
  });

  it("pre-claims state before any DB write so partial-failure retries cannot duplicate facts (RED-169)", async () => {
    const link = makeLink();
    const commentId = randomUUID();
    const extractionIssueId = randomUUID();
    const body = JSON.stringify({
      facts: [{ content: "A fact.", about_peer: null, confidence: 0.9 }],
    });

    // First pass: simulate a transient failure on the facts INSERT. The
    // pre-claim state must already be `in_progress` by then so the next
    // retry sees it and skips.
    let firstFactInsert = true;
    const originalExecute = harness.ctx.db.execute.bind(harness.ctx.db);
    harness.ctx.db.execute = async (sql: string, params?: unknown[]) => {
      if (firstFactInsert && /INSERT INTO .*\.facts/.test(sql)) {
        firstFactInsert = false;
        // Verify the pre-claim happened before the failed INSERT.
        const stateBefore = await harness.ctx.state.get(harvestStateKey(commentId));
        expect((stateBefore as { outcome: string }).outcome).toBe("in_progress");
        throw new Error("simulated transient db failure");
      }
      return originalExecute(sql, params);
    };

    await expect(
      harvestExtraction(harness.ctx, {
        companyId: COMPANY_ID,
        commentBody: body,
        commentId,
        extractionIssueId,
        link,
      }),
    ).rejects.toThrow("simulated transient db failure");

    // Pre-claim sticks across the failure. Retries see it and short-circuit
    // — facts CANNOT be re-inserted.
    const stateAfter = await harness.ctx.state.get(harvestStateKey(commentId));
    expect((stateAfter as { outcome: string }).outcome).toBe("in_progress");

    const retry = await harvestExtraction(harness.ctx, {
      companyId: COMPANY_ID,
      commentBody: body,
      commentId,
      extractionIssueId,
      link,
    });
    expect(retry.status).toBe("already_harvested");

    const factInsertsTotal = harness.dbExecutes.filter((e) =>
      /INSERT INTO .*\.facts/.test(e.sql),
    );
    expect(factInsertsTotal).toHaveLength(0);
  });

  it("finalizes state to harvested before running rollups so a rollup failure cannot trigger duplicate inserts", async () => {
    const link = makeLink();
    const commentId = randomUUID();
    const body = JSON.stringify({
      facts: [{ content: "A fact.", about_peer: null, confidence: 0.9 }],
    });

    // Make the sessions upsert fail.
    const originalExecute = harness.ctx.db.execute.bind(harness.ctx.db);
    harness.ctx.db.execute = async (sql: string, params?: unknown[]) => {
      if (/INSERT INTO .*\.sessions/.test(sql)) {
        // By the time the rollup runs, state must already be `harvested`.
        const stateMid = await harness.ctx.state.get(harvestStateKey(commentId));
        expect((stateMid as { outcome: string }).outcome).toBe("harvested");
        throw new Error("simulated rollup failure");
      }
      return originalExecute(sql, params);
    };

    await expect(
      harvestExtraction(harness.ctx, {
        companyId: COMPANY_ID,
        commentBody: body,
        commentId,
        extractionIssueId: randomUUID(),
        link,
      }),
    ).rejects.toThrow("simulated rollup failure");

    // State is harvested → retry short-circuits with no extra fact INSERT.
    const retry = await harvestExtraction(harness.ctx, {
      companyId: COMPANY_ID,
      commentBody: body,
      commentId,
      extractionIssueId: randomUUID(),
      link,
    });
    expect(retry.status).toBe("already_harvested");
    const factInsertsTotal = harness.dbExecutes.filter((e) =>
      /INSERT INTO .*\.facts/.test(e.sql),
    );
    expect(factInsertsTotal).toHaveLength(1);
  });

  it("records harvest state to make repeat harvests a no-op", async () => {
    const link = makeLink();
    const commentId = randomUUID();
    const extractionIssueId = randomUUID();
    const body = JSON.stringify({
      facts: [{ content: "A fact.", about_peer: null, confidence: 0.9 }],
    });

    await harvestExtraction(harness.ctx, {
      companyId: COMPANY_ID,
      commentBody: body,
      commentId,
      extractionIssueId,
      link,
    });

    const second = await harvestExtraction(harness.ctx, {
      companyId: COMPANY_ID,
      commentBody: body,
      commentId,
      extractionIssueId,
      link,
    });
    expect(second.status).toBe("already_harvested");

    const totalFactInserts = harness.dbExecutes.filter((e) =>
      /INSERT INTO .*\.facts/.test(e.sql),
    ).length;
    expect(totalFactInserts).toBe(1);

    const stored = await harness.ctx.state.get(harvestStateKey(commentId));
    expect(stored).toBeTruthy();
    expect((stored as { outcome: string }).outcome).toBe("harvested");
  });

  it("rolls up agent-targeted facts into a peer_models upsert", async () => {
    const link = makeLink({ peerAgentId: PEER_AGENT_ID });
    await harvestExtraction(harness.ctx, {
      companyId: COMPANY_ID,
      commentBody: JSON.stringify({
        facts: [
          { content: "PeerAgent prefers terse comments.", about_peer: "agent", confidence: 0.9 },
          { content: "PeerAgent owns billing.", about_peer: "agent", confidence: 0.8 },
          { content: "Project freeze starts Friday.", about_peer: null, confidence: 0.85 },
        ],
      }),
      commentId: randomUUID(),
      extractionIssueId: randomUUID(),
      link,
    });

    const peerUpserts = harness.dbExecutes.filter((e) =>
      /INSERT INTO .*\.peer_models/.test(e.sql),
    );
    expect(peerUpserts).toHaveLength(1);
    expect(peerUpserts[0].params).toEqual([COMPANY_ID, PEER_AGENT_ID, 2]);
  });

  it("does not write peer_models when the link has no peerAgentId", async () => {
    const link = makeLink({ peerAgentId: null });
    await harvestExtraction(harness.ctx, {
      companyId: COMPANY_ID,
      commentBody: JSON.stringify({
        facts: [{ content: "Fact.", about_peer: "agent", confidence: 0.9 }],
      }),
      commentId: randomUUID(),
      extractionIssueId: randomUUID(),
      link,
    });
    const peerUpserts = harness.dbExecutes.filter((e) =>
      /INSERT INTO .*\.peer_models/.test(e.sql),
    );
    expect(peerUpserts).toHaveLength(0);
  });

  it("treats {facts: []} as a valid empty result and short-circuits future harvests", async () => {
    const link = makeLink();
    const commentId = randomUUID();
    const result = await harvestExtraction(harness.ctx, {
      companyId: COMPANY_ID,
      commentBody: JSON.stringify({ facts: [] }),
      commentId,
      extractionIssueId: randomUUID(),
      link,
    });
    expect(result.status).toBe("empty");
    expect(harness.dbExecutes.filter((e) => /INSERT INTO .*\.facts/.test(e.sql))).toHaveLength(0);
    const stored = await harness.ctx.state.get(harvestStateKey(commentId));
    expect((stored as { outcome: string }).outcome).toBe("empty");
  });

  it("records a parse_error state on garbage input without throwing", async () => {
    const link = makeLink();
    const commentId = randomUUID();
    const result = await harvestExtraction(harness.ctx, {
      companyId: COMPANY_ID,
      commentBody: "I do not see a task to do.",
      commentId,
      extractionIssueId: randomUUID(),
      link,
    });
    expect(result.status).toBe("parse_error");
    expect(result.factsInserted).toBe(0);
    expect(harness.dbExecutes).toHaveLength(0);
    const stored = await harness.ctx.state.get(harvestStateKey(commentId));
    expect((stored as { outcome: string }).outcome).toBe("parse_error");
  });

  it("metadata captures about_peer, confidence, source kind, and IDs", async () => {
    const link = makeLink({ sourceKind: "issue_update" });
    await harvestExtraction(harness.ctx, {
      companyId: COMPANY_ID,
      commentBody: JSON.stringify({
        facts: [
          { content: "Decision was made.", about_peer: null, confidence: 0.85 },
        ],
      }),
      commentId: randomUUID(),
      extractionIssueId: "00000000-0000-0000-0000-000000000999",
      link,
      extractionRunId: "00000000-0000-0000-0000-0000000999aa",
    });
    const factInsert = harness.dbExecutes.find((e) => /INSERT INTO .*\.facts/.test(e.sql));
    expect(factInsert).toBeDefined();
    const metadata = JSON.parse(String(factInsert!.params?.[6]));
    expect(metadata.about_peer).toBe(null);
    expect(metadata.confidence).toBe(0.85);
    expect(metadata.source_kind).toBe("issue_update");
    expect(metadata.extraction_issue_id).toBe("00000000-0000-0000-0000-000000000999");
    expect(metadata.extraction_run_id).toBe("00000000-0000-0000-0000-0000000999aa");
    expect(metadata.source_comment_id).toBe(link.sourceCommentId);
  });
});

describe("levelForConfidence", () => {
  it("buckets high confidence as explicit", () => {
    expect(levelForConfidence(0.95)).toBe("explicit");
    expect(levelForConfidence(0.9)).toBe("explicit");
  });
  it("buckets moderate confidence as inferred", () => {
    expect(levelForConfidence(0.7)).toBe("inferred");
    expect(levelForConfidence(0.6)).toBe("inferred");
  });
  it("buckets weak confidence as loose", () => {
    expect(levelForConfidence(0.3)).toBe("loose");
    expect(levelForConfidence(0)).toBe("loose");
  });
});

describe("harvest path — issue.comment.created integration", () => {
  let harness: TestHarness;
  beforeEach(() => {
    harness = makeHarness();
  });

  it("end-to-end: extraction issue + memory-worker reply persists facts", async () => {
    // Step 1: a non-memory-worker comment arrives on the source issue. The
    // plugin's extraction handler creates a plugin-owned issue assigned to the
    // memory-worker and writes the link record.
    const sourceCommentId = randomUUID();
    await harness.emit(
      "issue.comment.created",
      {
        identifier: "RED-42",
        commentId: sourceCommentId,
        bodySnippet: "Darren wants to migrate to TypeScript.",
        agentId: null,
        runId: null,
      },
      { entityId: SOURCE_ISSUE_ID, entityType: "issue", companyId: COMPANY_ID },
    );

    const allIssues = await harness.ctx.issues.list({ companyId: COMPANY_ID });
    const extraction = allIssues.find((i) => i.originId === commentOriginId(sourceCommentId));
    expect(extraction).toBeDefined();

    // The extraction-state record links source → extraction.
    const extractionState = await harness.ctx.state.get(
      extractionIdempotencyStateKey(commentOriginId(sourceCommentId)),
    );
    expect(extractionState).toBeTruthy();

    // The harvest link record exists, keyed by extractionIssueId.
    const linkRecord = (await harness.ctx.state.get(
      extractionLinkStateKey(extraction!.id),
    )) as ExtractionLink | null;
    expect(linkRecord).toBeTruthy();
    expect(linkRecord!.sourceIssueId).toBe(SOURCE_ISSUE_ID);
    expect(linkRecord!.sourceCommentId).toBe(sourceCommentId);

    // Step 2: memory-worker posts its JSON reply as a comment on the
    // extraction issue. We seed the comment via createComment, then emit the
    // event so the harvest handler picks it up.
    const replyBody = JSON.stringify({
      facts: [
        { content: "Darren wants to migrate to TypeScript.", about_peer: "user", confidence: 0.95 },
        { content: "The migration target is the server package.", about_peer: null, confidence: 0.7 },
      ],
    });
    const reply = makeComment({
      id: randomUUID(),
      issueId: extraction!.id,
      body: replyBody,
      authorAgentId: MEMORY_AGENT_ID,
    });
    harness.seed({ issueComments: [reply] });

    await harness.emit(
      "issue.comment.created",
      {
        identifier: extraction!.identifier,
        commentId: reply.id,
        bodySnippet: replyBody.slice(0, 240),
        agentId: MEMORY_AGENT_ID,
        runId: null,
      },
      { entityId: extraction!.id, entityType: "issue", companyId: COMPANY_ID },
    );

    // Facts persisted (single multi-row INSERT, 2 rows × 7 columns = 14 params).
    const factInserts = harness.dbExecutes.filter((e) => /INSERT INTO .*\.facts/.test(e.sql));
    expect(factInserts).toHaveLength(1);
    expect(factInserts[0].params).toHaveLength(14);

    // Harvest state recorded.
    const harvestState = await harness.ctx.state.get(harvestStateKey(reply.id));
    expect((harvestState as { outcome: string }).outcome).toBe("harvested");

    // Extraction issue closed.
    const closed = await harness.ctx.issues.get(extraction!.id, COMPANY_ID);
    expect(closed!.status).toBe("done");
  });

  it("harvest handler ignores comments authored by non-memory-worker agents on plugin-owned issues", async () => {
    // First, create an extraction issue.
    const sourceCommentId = randomUUID();
    await harness.emit(
      "issue.comment.created",
      {
        identifier: "RED-42",
        commentId: sourceCommentId,
        bodySnippet: "Some content.",
        agentId: null,
        runId: null,
      },
      { entityId: SOURCE_ISSUE_ID, entityType: "issue", companyId: COMPANY_ID },
    );
    const extraction = (await harness.ctx.issues.list({ companyId: COMPANY_ID })).find(
      (i) => i.originId === commentOriginId(sourceCommentId),
    )!;

    // Now a different agent comments on the extraction issue.
    const replyBody = JSON.stringify({
      facts: [{ content: "Should not be harvested.", about_peer: null, confidence: 0.9 }],
    });
    const reply = makeComment({
      id: randomUUID(),
      issueId: extraction.id,
      body: replyBody,
      authorAgentId: PEER_AGENT_ID,
    });
    harness.seed({ issueComments: [reply] });
    await harness.emit(
      "issue.comment.created",
      {
        identifier: extraction.identifier,
        commentId: reply.id,
        bodySnippet: "irrelevant",
        agentId: PEER_AGENT_ID,
        runId: null,
      },
      { entityId: extraction.id, entityType: "issue", companyId: COMPANY_ID },
    );

    const factInserts = harness.dbExecutes.filter((e) => /INSERT INTO .*\.facts/.test(e.sql));
    expect(factInserts).toHaveLength(0);
  });

  it("defers harvest (no state write, no fact insert) when the full comment isn't yet visible (RED-169)", async () => {
    // Step 1: extraction issue exists.
    const sourceCommentId = randomUUID();
    await harness.emit(
      "issue.comment.created",
      {
        identifier: "RED-42",
        commentId: sourceCommentId,
        bodySnippet: "Some content.",
        agentId: null,
        runId: null,
      },
      { entityId: SOURCE_ISSUE_ID, entityType: "issue", companyId: COMPANY_ID },
    );
    const extraction = (await harness.ctx.issues.list({ companyId: COMPANY_ID })).find(
      (i) => i.originId === commentOriginId(sourceCommentId),
    )!;

    // Step 2: comment.created fires for the memory-worker's reply BEFORE the
    // comment row is visible (eventual-consistency window). We deliberately
    // do NOT seed the comment, only deliver the event with the snippet.
    const replyId = randomUUID();
    const replyBody = JSON.stringify({
      facts: [
        { content: "Darren wants to migrate to TypeScript.", about_peer: "user", confidence: 0.95 },
      ],
    });
    await harness.emit(
      "issue.comment.created",
      {
        identifier: extraction.identifier,
        commentId: replyId,
        // Snippet would parse OK in the bug-prone version and persist
        // parse_error / harvested early. The fix must ignore the snippet.
        bodySnippet: replyBody.slice(0, 60),
        agentId: MEMORY_AGENT_ID,
        runId: null,
      },
      { entityId: extraction.id, entityType: "issue", companyId: COMPANY_ID },
    );

    // No facts written, no harvest state persisted — the deferred retry
    // (issue.updated) is what closes the loop later.
    const factInserts = harness.dbExecutes.filter((e) => /INSERT INTO .*\.facts/.test(e.sql));
    expect(factInserts).toHaveLength(0);
    const harvestState = await harness.ctx.state.get(harvestStateKey(replyId));
    expect(harvestState).toBeFalsy();
  });

  it("issue.updated retry harvests memory-worker comments after a deferred first attempt (RED-169)", async () => {
    // Step 1: extraction issue exists.
    const sourceCommentId = randomUUID();
    await harness.emit(
      "issue.comment.created",
      {
        identifier: "RED-42",
        commentId: sourceCommentId,
        bodySnippet: "Some content.",
        agentId: null,
        runId: null,
      },
      { entityId: SOURCE_ISSUE_ID, entityType: "issue", companyId: COMPANY_ID },
    );
    const extraction = (await harness.ctx.issues.list({ companyId: COMPANY_ID })).find(
      (i) => i.originId === commentOriginId(sourceCommentId),
    )!;

    // Step 2: comment.created arrives before the row is visible — deferred.
    const replyId = randomUUID();
    const replyBody = JSON.stringify({
      facts: [
        { content: "Darren wants to migrate to TypeScript.", about_peer: "user", confidence: 0.95 },
      ],
    });
    await harness.emit(
      "issue.comment.created",
      {
        identifier: extraction.identifier,
        commentId: replyId,
        bodySnippet: replyBody.slice(0, 60),
        agentId: MEMORY_AGENT_ID,
        runId: null,
      },
      { entityId: extraction.id, entityType: "issue", companyId: COMPANY_ID },
    );
    expect(
      harness.dbExecutes.filter((e) => /INSERT INTO .*\.facts/.test(e.sql)),
    ).toHaveLength(0);

    // Step 3: by the time the memory-worker self-PATCHes to done, the
    // comment row has propagated. Seed it now and fire issue.updated.
    const reply = makeComment({
      id: replyId,
      issueId: extraction.id,
      body: replyBody,
      authorAgentId: MEMORY_AGENT_ID,
    });
    harness.seed({ issueComments: [reply] });

    await harness.emit(
      "issue.updated",
      {
        identifier: extraction.identifier,
        patch: { status: "done" },
        agentId: MEMORY_AGENT_ID,
        runId: null,
      },
      { entityId: extraction.id, entityType: "issue", companyId: COMPANY_ID },
    );

    // Retry path picked up the previously-deferred comment and harvested it.
    const factInserts = harness.dbExecutes.filter((e) => /INSERT INTO .*\.facts/.test(e.sql));
    expect(factInserts).toHaveLength(1);
    const harvestState = await harness.ctx.state.get(harvestStateKey(replyId));
    expect((harvestState as { outcome: string }).outcome).toBe("harvested");
  });

  it("RED-210: harvests + closes when payload.agentId is null but the comment row's authorAgentId is the memory agent", async () => {
    // The activity-log → plugin-event bridge can omit agentId in some
    // delivery paths (or it may be lost across a worker restart). The harvest
    // handler must not silently skip these — the comment row's authorAgentId
    // is the authoritative author signal.
    const sourceCommentId = randomUUID();
    await harness.emit(
      "issue.comment.created",
      {
        identifier: "RED-42",
        commentId: sourceCommentId,
        bodySnippet: "Some content.",
        agentId: null,
        runId: null,
      },
      { entityId: SOURCE_ISSUE_ID, entityType: "issue", companyId: COMPANY_ID },
    );
    const extraction = (await harness.ctx.issues.list({ companyId: COMPANY_ID })).find(
      (i) => i.originId === commentOriginId(sourceCommentId),
    )!;

    const replyBody = JSON.stringify({ facts: [] });
    const reply = makeComment({
      id: randomUUID(),
      issueId: extraction.id,
      body: replyBody,
      authorAgentId: MEMORY_AGENT_ID,
    });
    harness.seed({ issueComments: [reply] });

    await harness.emit(
      "issue.comment.created",
      {
        identifier: extraction.identifier,
        commentId: reply.id,
        bodySnippet: replyBody,
        // The defining bit: payload.agentId is missing/null even though
        // authorAgentId on the comment row is set correctly.
        agentId: null,
        runId: null,
      },
      { entityId: extraction.id, entityType: "issue", companyId: COMPANY_ID },
    );

    // Empty {facts: []} is a valid harvest result and must close the issue.
    const harvestState = await harness.ctx.state.get(harvestStateKey(reply.id));
    expect((harvestState as { outcome: string }).outcome).toBe("empty");
    const closed = await harness.ctx.issues.get(extraction.id, COMPANY_ID);
    expect(closed!.status).toBe("done");
  });

  it("RED-210: skips when payload.agentId is *explicitly* a non-memory agent (fast path, no comment lookup)", async () => {
    // When the bridge sets agentId to a peer agent, we can short-circuit
    // before touching the host. Verifies we did not regress the fast path.
    const sourceCommentId = randomUUID();
    await harness.emit(
      "issue.comment.created",
      {
        identifier: "RED-42",
        commentId: sourceCommentId,
        bodySnippet: "Some content.",
        agentId: null,
        runId: null,
      },
      { entityId: SOURCE_ISSUE_ID, entityType: "issue", companyId: COMPANY_ID },
    );
    const extraction = (await harness.ctx.issues.list({ companyId: COMPANY_ID })).find(
      (i) => i.originId === commentOriginId(sourceCommentId),
    )!;

    const before = harness.dbExecutes.length;
    await harness.emit(
      "issue.comment.created",
      {
        identifier: extraction.identifier,
        commentId: randomUUID(),
        bodySnippet: "irrelevant",
        agentId: PEER_AGENT_ID,
        runId: null,
      },
      { entityId: extraction.id, entityType: "issue", companyId: COMPANY_ID },
    );
    const factInserts = harness.dbExecutes.filter((e) => /INSERT INTO .*\.facts/.test(e.sql));
    expect(factInserts).toHaveLength(0);
    // No new DB executes triggered by the harvest path beyond what was there
    // before the irrelevant comment event.
    expect(harness.dbExecutes.length).toBe(before);
  });

  it("RED-210: issue.updated retry path closes the extraction issue after a successful harvest", async () => {
    // Defense in depth: even if `onMemoryWorkerComment` missed the live
    // event entirely (worker restart, dropped delivery), the retry path on
    // issue.updated must finish the job and flip the issue to `done`.
    const sourceCommentId = randomUUID();
    await harness.emit(
      "issue.comment.created",
      {
        identifier: "RED-42",
        commentId: sourceCommentId,
        bodySnippet: "Some content.",
        agentId: null,
        runId: null,
      },
      { entityId: SOURCE_ISSUE_ID, entityType: "issue", companyId: COMPANY_ID },
    );
    const extraction = (await harness.ctx.issues.list({ companyId: COMPANY_ID })).find(
      (i) => i.originId === commentOriginId(sourceCommentId),
    )!;

    // Memory-worker reply lands directly in the comments table. The live
    // `issue.comment.created` was lost (we never emit it).
    const replyBody = JSON.stringify({ facts: [] });
    const reply = makeComment({
      id: randomUUID(),
      issueId: extraction.id,
      body: replyBody,
      authorAgentId: MEMORY_AGENT_ID,
    });
    harness.seed({ issueComments: [reply] });

    // Some unrelated update fires (e.g. another agent edits a field). The
    // retry path scans memory-worker comments, harvests the empty reply, and
    // must close the still-open extraction issue.
    await harness.emit(
      "issue.updated",
      {
        identifier: extraction.identifier,
        patch: { description: "edited from elsewhere" },
        agentId: null,
        runId: null,
      },
      { entityId: extraction.id, entityType: "issue", companyId: COMPANY_ID },
    );

    const harvestState = await harness.ctx.state.get(harvestStateKey(reply.id));
    expect((harvestState as { outcome: string }).outcome).toBe("empty");
    const closed = await harness.ctx.issues.get(extraction.id, COMPANY_ID);
    expect(closed!.status).toBe("done");
  });
});
