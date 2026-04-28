import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import type { Issue, IssueComment } from "@paperclipai/shared";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";

import manifest from "../src/manifest.js";
import {
  QUIPO_BACKFILL_ACTION_KEY,
  registerQuipoBackfillAction,
  runBackfill,
  type BackfillSummary,
} from "../src/backfill.js";

const COMPANY_ID = "00000000-0000-0000-0000-00000000c0c0";
const OTHER_COMPANY_ID = "00000000-0000-0000-0000-00000000d0d0";
const PROJECT_A = "00000000-0000-0000-0000-0000000000a1";
const PROJECT_B = "00000000-0000-0000-0000-0000000000a2";
const ISSUE_A = "00000000-0000-0000-0000-000000000111";
const ISSUE_B = "00000000-0000-0000-0000-000000000222";
const ISSUE_PLUGIN = "00000000-0000-0000-0000-000000000333";
const MEMORY_AGENT_ID = "00000000-0000-0000-0000-0000000000aa";
const HUMAN_AUTHORED_AGENT_ID = "00000000-0000-0000-0000-0000000000bb";

function makeIssue(overrides: Partial<Issue>): Issue {
  const now = new Date();
  const base: Issue = {
    id: ISSUE_A,
    companyId: COMPANY_ID,
    projectId: PROJECT_A,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Source issue",
    description: "An issue someone is talking about",
    status: "in_progress",
    priority: "medium",
    assigneeAgentId: HUMAN_AUTHORED_AGENT_ID,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 1,
    identifier: "RED-1",
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

function makeComment(overrides: Partial<IssueComment>): IssueComment {
  const now = new Date();
  const base: IssueComment = {
    id: randomUUID(),
    companyId: COMPANY_ID,
    issueId: ISSUE_A,
    authorAgentId: HUMAN_AUTHORED_AGENT_ID,
    authorUserId: null,
    body: "We agreed to use TypeScript everywhere.",
    createdAt: now,
    updatedAt: now,
  };
  return { ...base, ...overrides };
}

function makeHarness(
  config: Record<string, unknown> = { enabled: true, memoryAgentId: MEMORY_AGENT_ID },
  seed?: { issues?: Issue[]; issueComments?: IssueComment[] },
): TestHarness {
  const harness = createTestHarness({ manifest, config });
  registerQuipoBackfillAction(harness.ctx);
  harness.seed({
    issues:
      seed?.issues ??
      [
        makeIssue({}),
        makeIssue({
          id: ISSUE_B,
          identifier: "RED-2",
          title: "Second issue",
        }),
        makeIssue({
          id: ISSUE_PLUGIN,
          identifier: "RED-3",
          originKind: `plugin:${manifest.id}`,
        }),
      ],
    issueComments: seed?.issueComments,
  });
  return harness;
}

async function performBackfill(
  harness: TestHarness,
  params: Record<string, unknown> = { companyId: COMPANY_ID },
): Promise<BackfillSummary> {
  return harness.performAction<BackfillSummary>(QUIPO_BACKFILL_ACTION_KEY, params);
}

describe("Quipo backfill — registration", () => {
  it("registers under the canonical action key", async () => {
    const harness = makeHarness();
    // Smoke test: invoking the action via the harness must reach our handler.
    const result = await performBackfill(harness, { companyId: COMPANY_ID });
    expect(result.ok).toBe(true);
  });
});

describe("Quipo backfill — parameter validation", () => {
  it("returns ok=false when companyId is missing", async () => {
    const harness = makeHarness();
    const result = await runBackfill(harness.ctx, {});
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing_company");
    expect(result.queued).toBe(0);
  });

  it("returns ok=false with no_memory_agent when the plugin has no memory agent configured", async () => {
    const harness = makeHarness({ enabled: true });
    const result = await runBackfill(harness.ctx, { companyId: COMPANY_ID });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no_memory_agent");
  });

  it("does not require enabled=true (backfill is an explicit operator action)", async () => {
    const harness = makeHarness({ enabled: false, memoryAgentId: MEMORY_AGENT_ID });
    const issue = makeIssue({});
    const comment = makeComment({ id: randomUUID(), issueId: issue.id });
    harness.seed({ issues: [issue], issueComments: [comment] });
    const result = await runBackfill(harness.ctx, { companyId: COMPANY_ID });
    expect(result.ok).toBe(true);
    expect(result.queued).toBe(1);
  });
});

describe("Quipo backfill — happy path", () => {
  let harness: TestHarness;
  let issueAComments: IssueComment[];
  let issueBComment: IssueComment;

  beforeEach(() => {
    harness = makeHarness();
    issueAComments = [
      makeComment({ id: randomUUID(), issueId: ISSUE_A, body: "Fact one." }),
      makeComment({ id: randomUUID(), issueId: ISSUE_A, body: "Fact two." }),
    ];
    issueBComment = makeComment({ id: randomUUID(), issueId: ISSUE_B, body: "Other issue fact." });
    harness.seed({ issueComments: [...issueAComments, issueBComment] });
  });

  it("queues an extraction issue per existing comment with sourceKind=backfill in the description", async () => {
    const result = await performBackfill(harness);

    expect(result.ok).toBe(true);
    expect(result.queued).toBe(3);
    expect(result.alreadyExtracted).toBe(0);
    expect(result.commentsScanned).toBe(3);
    expect(result.issuesScanned).toBe(2);
    expect(result.pluginOwnedIssuesSkipped).toBe(1);

    const all = await harness.ctx.issues.list({ companyId: COMPANY_ID });
    const extractions = all.filter(
      (issue) =>
        issue.originKind === `plugin:${manifest.id}` &&
        typeof issue.originId === "string" &&
        issue.originId.startsWith("comment:"),
    );
    expect(extractions).toHaveLength(3);
    for (const ex of extractions) {
      expect(ex.assigneeAgentId).toBe(MEMORY_AGENT_ID);
      expect(ex.priority).toBe("low");
      expect(ex.title).toMatch(/^Quipo backfill: extract facts/);
      expect(ex.description).toContain("RED-103 backfill");
      expect(ex.description).toContain("source_comment_id:");
    }
  });

  it("records source_comment_id in plugin state for each queued extraction", async () => {
    await performBackfill(harness);
    for (const c of issueAComments) {
      const state = harness.getState({
        scopeKind: "instance",
        namespace: "extractions",
        stateKey: `comment:${c.id}`,
      }) as { source_comment_id?: string; sourceKind?: string };
      expect(state).toBeTruthy();
      expect(state.source_comment_id).toBe(c.id);
      expect(state.sourceKind).toBe("backfill");
    }
  });
});

describe("Quipo backfill — idempotency", () => {
  it("re-running does not double-queue extractions", async () => {
    const harness = makeHarness();
    const comment = makeComment({ id: randomUUID(), issueId: ISSUE_A });
    harness.seed({ issueComments: [comment] });

    const first = await performBackfill(harness);
    expect(first.queued).toBe(1);
    expect(first.alreadyExtracted).toBe(0);

    const second = await performBackfill(harness);
    expect(second.queued).toBe(0);
    expect(second.alreadyExtracted).toBe(1);

    const all = await harness.ctx.issues.list({ companyId: COMPANY_ID });
    const extractions = all.filter((issue) => issue.originId === `comment:${comment.id}`);
    expect(extractions).toHaveLength(1);
  });

  it("co-exists with the live event handler: backfill skips comments the live event already extracted (originId match)", async () => {
    const harness = makeHarness();
    const comment = makeComment({ id: randomUUID(), issueId: ISSUE_A });
    harness.seed({ issueComments: [comment] });
    // Seed a Quipo-originated extraction issue with the canonical originId,
    // simulating "the live event handler already processed this comment".
    await harness.ctx.issues.create({
      companyId: COMPANY_ID,
      title: "pre-existing extraction",
      description: "seeded by test",
      assigneeAgentId: MEMORY_AGENT_ID,
      originKind: `plugin:${manifest.id}`,
      originId: `comment:${comment.id}`,
    });

    const result = await performBackfill(harness);
    expect(result.queued).toBe(0);
    expect(result.alreadyExtracted).toBe(1);
  });
});

describe("Quipo backfill — author and origin filtering", () => {
  it("skips comments authored by the configured memory agent", async () => {
    const harness = makeHarness();
    const selfComment = makeComment({
      id: randomUUID(),
      issueId: ISSUE_A,
      authorAgentId: MEMORY_AGENT_ID,
    });
    const userComment = makeComment({
      id: randomUUID(),
      issueId: ISSUE_A,
      authorAgentId: null,
      body: "Human-written observation.",
    });
    harness.seed({ issueComments: [selfComment, userComment] });

    const result = await performBackfill(harness);
    expect(result.queued).toBe(1);
    expect(result.memoryAgentAuthoredSkipped).toBe(1);
    const all = await harness.ctx.issues.list({ companyId: COMPANY_ID });
    const extractions = all.filter(
      (issue) =>
        issue.originKind === `plugin:${manifest.id}` &&
        typeof issue.originId === "string" &&
        issue.originId.startsWith("comment:"),
    );
    expect(extractions).toHaveLength(1);
    expect(extractions[0].originId).toBe(`comment:${userComment.id}`);
  });

  it("skips issues that the plugin itself created", async () => {
    const harness = makeHarness();
    // Comment lives on the Quipo-owned issue (e.g. agent's response on a
    // Quipo extraction issue). Backfill must not snowball off plugin output.
    const pluginIssueComment = makeComment({
      id: randomUUID(),
      issueId: ISSUE_PLUGIN,
      body: "Memory worker self-output",
    });
    harness.seed({ issueComments: [pluginIssueComment] });

    const result = await performBackfill(harness);
    expect(result.queued).toBe(0);
    expect(result.pluginOwnedIssuesSkipped).toBe(1);
  });
});

describe("Quipo backfill — scoping", () => {
  it("respects projectId filter", async () => {
    const harness = createTestHarness({
      manifest,
      config: { enabled: true, memoryAgentId: MEMORY_AGENT_ID },
    });
    registerQuipoBackfillAction(harness.ctx);
    const issueA = makeIssue({ id: ISSUE_A, projectId: PROJECT_A });
    const issueB = makeIssue({ id: ISSUE_B, projectId: PROJECT_B, identifier: "RED-2" });
    const cA = makeComment({ id: randomUUID(), issueId: ISSUE_A });
    const cB = makeComment({ id: randomUUID(), issueId: ISSUE_B });
    harness.seed({ issues: [issueA, issueB], issueComments: [cA, cB] });

    const result = await runBackfill(harness.ctx, {
      companyId: COMPANY_ID,
      projectId: PROJECT_A,
    });
    expect(result.queued).toBe(1);
    const all = await harness.ctx.issues.list({ companyId: COMPANY_ID });
    const extractions = all.filter(
      (issue) =>
        issue.originKind === `plugin:${manifest.id}` &&
        typeof issue.originId === "string" &&
        issue.originId.startsWith("comment:"),
    );
    expect(extractions).toHaveLength(1);
    expect(extractions[0].originId).toBe(`comment:${cA.id}`);
  });

  it("respects issueId filter and rejects an issue from another company", async () => {
    const harness = createTestHarness({
      manifest,
      config: { enabled: true, memoryAgentId: MEMORY_AGENT_ID },
    });
    registerQuipoBackfillAction(harness.ctx);
    const ours = makeIssue({ id: ISSUE_A });
    const otherCompany = makeIssue({
      id: ISSUE_B,
      companyId: OTHER_COMPANY_ID,
      identifier: "OTH-1",
    });
    const cours = makeComment({ id: randomUUID(), issueId: ISSUE_A });
    const cother = makeComment({
      id: randomUUID(),
      issueId: ISSUE_B,
      companyId: OTHER_COMPANY_ID,
    });
    harness.seed({ issues: [ours, otherCompany], issueComments: [cours, cother] });

    const ok = await runBackfill(harness.ctx, { companyId: COMPANY_ID, issueId: ISSUE_A });
    expect(ok.ok).toBe(true);
    expect(ok.queued).toBe(1);

    const wrongCompany = await runBackfill(harness.ctx, {
      companyId: COMPANY_ID,
      issueId: ISSUE_B,
    });
    expect(wrongCompany.ok).toBe(true);
    // Foreign-company issue ids resolve to null via the company-isolated
    // host call, so backfill reports an empty scope rather than queueing
    // anything against the wrong tenant.
    expect(wrongCompany.reason).toBe("no_issues_in_scope");
    expect(wrongCompany.queued).toBe(0);
  });

  it("does not consume comments outside the supplied companyId", async () => {
    const harness = createTestHarness({
      manifest,
      config: { enabled: true, memoryAgentId: MEMORY_AGENT_ID },
    });
    registerQuipoBackfillAction(harness.ctx);
    const ours = makeIssue({});
    const other = makeIssue({
      id: ISSUE_B,
      companyId: OTHER_COMPANY_ID,
      identifier: "OTH-1",
    });
    const cours = makeComment({ id: randomUUID(), issueId: ISSUE_A });
    const cother = makeComment({
      id: randomUUID(),
      issueId: ISSUE_B,
      companyId: OTHER_COMPANY_ID,
    });
    harness.seed({ issues: [ours, other], issueComments: [cours, cother] });

    const result = await runBackfill(harness.ctx, { companyId: COMPANY_ID });
    expect(result.queued).toBe(1);
  });
});

describe("Quipo backfill — caps and dryRun", () => {
  it("caps comments per issue and reports truncation", async () => {
    const harness = makeHarness();
    const comments: IssueComment[] = [];
    for (let i = 0; i < 5; i++) {
      comments.push(
        makeComment({ id: randomUUID(), issueId: ISSUE_A, body: `Fact ${i + 1}` }),
      );
    }
    harness.seed({ issueComments: comments });

    const result = await runBackfill(harness.ctx, {
      companyId: COMPANY_ID,
      maxCommentsPerIssue: 2,
    });
    expect(result.queued).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it("maxIssues caps eligible source issues, not raw rows that include plugin-owned items", async () => {
    // Three eligible source issues + a leading plugin-owned issue. With a cap
    // of 2 raw rows the old code would have stopped after [pluginOwned, ISSUE_A]
    // and only scanned ISSUE_A. The cap must instead bind on eligible issues so
    // ISSUE_A and ISSUE_B are both scanned and the third one trips truncation.
    const harness = createTestHarness({
      manifest,
      config: { enabled: true, memoryAgentId: MEMORY_AGENT_ID },
    });
    registerQuipoBackfillAction(harness.ctx);
    const ISSUE_C = "00000000-0000-0000-0000-000000000444";
    const issuePlugin = makeIssue({
      id: ISSUE_PLUGIN,
      identifier: "RED-PL",
      originKind: `plugin:${manifest.id}`,
    });
    const issueA = makeIssue({ id: ISSUE_A, identifier: "RED-A" });
    const issueB = makeIssue({ id: ISSUE_B, identifier: "RED-B" });
    const issueC = makeIssue({ id: ISSUE_C, identifier: "RED-C" });
    const cA = makeComment({ id: randomUUID(), issueId: ISSUE_A });
    const cB = makeComment({ id: randomUUID(), issueId: ISSUE_B });
    const cC = makeComment({ id: randomUUID(), issueId: ISSUE_C });
    harness.seed({
      // Plugin-owned issue first so a raw-cap implementation would burn one
      // of the two cap slots on something we always skip.
      issues: [issuePlugin, issueA, issueB, issueC],
      issueComments: [cA, cB, cC],
    });

    const result = await runBackfill(harness.ctx, { companyId: COMPANY_ID, maxIssues: 2 });

    expect(result.ok).toBe(true);
    expect(result.issuesScanned).toBe(2);
    expect(result.pluginOwnedIssuesSkipped).toBe(1);
    expect(result.queued).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it("returns the computed summary even when ctx.metrics.write fails", async () => {
    // Telemetry failures must not invalidate already-completed extraction
    // work — the action should log and return ok=true with the real counts.
    const harness = makeHarness();
    const comment = makeComment({ id: randomUUID(), issueId: ISSUE_A });
    harness.seed({ issueComments: [comment] });

    const originalWrite = harness.ctx.metrics.write;
    let metricsCallCount = 0;
    harness.ctx.metrics.write = async (..._args: Parameters<typeof originalWrite>) => {
      metricsCallCount += 1;
      throw new Error("metrics backend unavailable");
    };

    try {
      const result = await runBackfill(harness.ctx, { companyId: COMPANY_ID });
      expect(result.ok).toBe(true);
      expect(result.queued).toBe(1);
      // Both metric calls must have been attempted and isolated; neither one
      // is allowed to short-circuit the other or the summary return.
      expect(metricsCallCount).toBe(2);

      const all = await harness.ctx.issues.list({ companyId: COMPANY_ID });
      const extractions = all.filter(
        (issue) =>
          issue.originKind === `plugin:${manifest.id}` &&
          typeof issue.originId === "string" &&
          issue.originId.startsWith("comment:"),
      );
      expect(extractions).toHaveLength(1);
    } finally {
      harness.ctx.metrics.write = originalWrite;
    }
  });

  it("dryRun does not create extraction issues but counts what would be queued", async () => {
    const harness = makeHarness();
    const comments = [
      makeComment({ id: randomUUID(), issueId: ISSUE_A }),
      makeComment({ id: randomUUID(), issueId: ISSUE_A }),
    ];
    harness.seed({ issueComments: comments });

    const result = await runBackfill(harness.ctx, { companyId: COMPANY_ID, dryRun: true });
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.queued).toBe(2);

    const all = await harness.ctx.issues.list({ companyId: COMPANY_ID });
    const extractions = all.filter(
      (issue) =>
        issue.originKind === `plugin:${manifest.id}` &&
        typeof issue.originId === "string" &&
        issue.originId.startsWith("comment:"),
    );
    expect(extractions).toHaveLength(0);
    // No state should have been written either.
    for (const c of comments) {
      const state = harness.getState({
        scopeKind: "instance",
        namespace: "extractions",
        stateKey: `comment:${c.id}`,
      });
      expect(state).toBeFalsy();
    }
  });
});
