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

  it("inserts one row per fact, plus a session upsert", async () => {
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

    const factInserts = harness.dbExecutes.filter((e) => /INSERT INTO .*\.facts/.test(e.sql));
    expect(factInserts).toHaveLength(2);
    expect(factInserts[0].params?.[3]).toBe("Darren prefers TypeScript.");
    expect(factInserts[0].params?.[4]).toBe("explicit");
    expect(factInserts[1].params?.[4]).toBe("inferred");

    const sessionUpserts = harness.dbExecutes.filter((e) => /INSERT INTO .*\.sessions/.test(e.sql));
    expect(sessionUpserts).toHaveLength(1);
    expect(sessionUpserts[0].params).toEqual([COMPANY_ID, SOURCE_ISSUE_ID, 2]);
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

    // Facts persisted.
    const factInserts = harness.dbExecutes.filter((e) => /INSERT INTO .*\.facts/.test(e.sql));
    expect(factInserts).toHaveLength(2);

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
});
