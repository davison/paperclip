import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.ts";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.ts";

async function closeDbClient(db: ReturnType<typeof createDb> | undefined) {
  await db?.$client?.end?.({ timeout: 0 });
}

describe("heartbeat paused-agent guard (RED-164)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-paused-guard-");
    db = createDb(started.connectionString);
    tempDb = started;
  }, 120_000);

  afterAll(async () => {
    await closeDbClient(db);
    await tempDb?.cleanup();
  });

  async function setupCompanyAndAgent(opts: {
    status: "idle" | "paused" | "terminated" | "pending_approval";
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Worker",
      role: "engineer",
      status: opts.status,
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    return { companyId, agentId, issuePrefix };
  }

  it("scheduler tick does not enqueue a run for a paused agent", async () => {
    const { agentId } = await setupCompanyAndAgent({ status: "paused" });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.tickTimers(new Date());

    expect(result.enqueued).toBe(0);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(0);

    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    // tickTimers short-circuits before calling enqueueWakeup for paused agents,
    // so we expect no wakeup-request rows at all when nothing else has run.
    expect(wakeups).toHaveLength(0);
  });

  it("plugin requestWakeup (source=automation) on a paused agent is suppressed and recorded", async () => {
    const { companyId, agentId, issuePrefix } = await setupCompanyAndAgent({ status: "paused" });
    const heartbeat = heartbeatService(db);

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Plugin wake target",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "plugin_issue_wakeup_requested",
      payload: { issueId, mutation: "plugin_wakeup" },
      requestedByActorType: "system",
      requestedByActorId: "plugin-test",
      contextSnapshot: { issueId, taskId: issueId, source: "plugin.test" },
    });

    expect(run).toBeNull();

    const skipped = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, agentId),
          eq(agentWakeupRequests.status, "skipped"),
        ),
      );
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.reason).toBe("agent_paused");
    expect(skipped[0]?.source).toBe("automation");
    expect(skipped[0]?.requestedByActorId).toBe("plugin-test");

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(0);

    const metrics = heartbeat.getPausedSuppressionMetrics();
    const entry = metrics.find((m) => m.agentId === agentId);
    expect(entry).toBeDefined();
    expect(entry?.count).toBe(1);
    expect(entry?.lastSource).toBe("automation");
    expect(entry?.lastStatus).toBe("paused");
  });

  it("comment-mention wake on a paused agent is suppressed", async () => {
    const { companyId, agentId, issuePrefix } = await setupCompanyAndAgent({ status: "paused" });
    const heartbeat = heartbeatService(db);

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Mention target",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: null,
      issueNumber: 1,
      identifier: `${issuePrefix}-2`,
    });

    const fakeCommentId = randomUUID();
    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_comment_mentioned",
      payload: { issueId, commentId: fakeCommentId },
      requestedByActorType: "user",
      requestedByActorId: "user-1",
      contextSnapshot: {
        issueId,
        taskId: issueId,
        commentId: fakeCommentId,
        wakeCommentId: fakeCommentId,
        wakeReason: "issue_comment_mentioned",
        source: "comment.mention",
      },
    });

    expect(run).toBeNull();

    const skipped = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, agentId),
          eq(agentWakeupRequests.status, "skipped"),
        ),
      );
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.reason).toBe("agent_paused");

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(0);
  });

  it("repeat suppressions accumulate the in-process counter without throwing", async () => {
    const { agentId } = await setupCompanyAndAgent({ status: "paused" });
    const heartbeat = heartbeatService(db);

    for (let i = 0; i < 3; i += 1) {
      const run = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "stress_test",
        requestedByActorType: "system",
        requestedByActorId: "test",
      });
      expect(run).toBeNull();
    }

    const metrics = heartbeat.getPausedSuppressionMetrics();
    const entry = metrics.find((m) => m.agentId === agentId);
    expect(entry?.count).toBe(3);

    const skipped = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, agentId),
          eq(agentWakeupRequests.status, "skipped"),
          eq(agentWakeupRequests.reason, "agent_paused"),
        ),
      );
    expect(skipped).toHaveLength(3);
  });

  it("terminated and pending_approval are also suppressed with reason=agent_paused", async () => {
    for (const status of ["terminated", "pending_approval"] as const) {
      const { agentId } = await setupCompanyAndAgent({ status });
      const heartbeat = heartbeatService(db);

      const run = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "test",
        requestedByActorType: "system",
        requestedByActorId: "test",
      });

      expect(run).toBeNull();

      const skipped = await db
        .select()
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.agentId, agentId),
            eq(agentWakeupRequests.status, "skipped"),
          ),
        );
      expect(skipped).toHaveLength(1);
      expect(skipped[0]?.reason).toBe("agent_paused");
    }
  });
});
