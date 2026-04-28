import { describe, expect, it, vi } from "vitest";

import { runMemoryGetIssueContext } from "../src/tools/memory-get-issue-context.js";
import type { MemoryDb, ToolRun } from "../src/tools/types.js";

const NS = "plugin_quipo_d14f4ce0c0";

const RUN: ToolRun = {
  agentId: "11111111-1111-1111-1111-111111111111",
  runId: "22222222-2222-2222-2222-222222222222",
  companyId: "33333333-3333-3333-3333-333333333333",
  projectId: "44444444-4444-4444-4444-444444444444",
};

const ISSUE_ID = "55555555-5555-5555-5555-555555555555";
const AGENT_ID_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const AGENT_ID_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

interface QuerySpec {
  rows: Record<string, unknown>[];
}

function makeDb(specs: QuerySpec[]): {
  db: MemoryDb;
  query: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn();
  for (const spec of specs) query.mockResolvedValueOnce(spec.rows);
  return { db: { namespace: NS, query: query as MemoryDb["query"] }, query };
}

describe("memory_get_issue_context tool", () => {
  it("rejects missing or non-uuid issue_id", async () => {
    const { db } = makeDb([]);
    expect((await runMemoryGetIssueContext({ db }, {}, RUN)).error).toMatch(/issue_id/);
    expect(
      (await runMemoryGetIssueContext({ db }, { issue_id: "x" }, RUN)).error,
    ).toMatch(/UUID/);
  });

  it("rejects fact_limit out of range", async () => {
    const { db } = makeDb([]);
    const r = await runMemoryGetIssueContext(
      { db },
      { issue_id: ISSUE_ID, fact_limit: 999 },
      RUN,
    );
    expect(r.error).toMatch(/fact_limit/);
  });

  it("queries facts, sessions, and peer_models scoped to company + issue", async () => {
    const factRows = [
      {
        id: "f1",
        content: "decision A",
        about_peer: null,
        confidence: 0.8,
        level: "explicit",
        issue_id: ISSUE_ID,
        agent_id: AGENT_ID_A,
        metadata: {},
        created_at: "2026-04-28T01:00:00Z",
      },
      {
        id: "f2",
        content: "fact about agent",
        about_peer: "agent",
        confidence: 0.7,
        level: "explicit",
        issue_id: ISSUE_ID,
        agent_id: AGENT_ID_B,
        metadata: {},
        created_at: "2026-04-28T00:00:00Z",
      },
    ];
    const sessionRows = [
      {
        id: "s1",
        issue_id: ISSUE_ID,
        summary: "rolling summary",
        fact_count: 2,
        updated_at: "2026-04-28T01:00:00Z",
      },
    ];
    const peerRows = [
      {
        id: "p1",
        agent_id: AGENT_ID_A,
        model: "agent A model",
        fact_count: 5,
        updated_at: "2026-04-28T00:00:00Z",
      },
    ];
    const { db, query } = makeDb([
      { rows: factRows },
      { rows: sessionRows },
      { rows: peerRows },
    ]);

    const result = await runMemoryGetIssueContext(
      { db },
      { issue_id: ISSUE_ID },
      RUN,
    );
    expect(result.error).toBeUndefined();

    expect(query).toHaveBeenCalledTimes(3);

    const factSql: string = query.mock.calls[0][0];
    expect(factSql).toContain(`${NS}.facts`);
    expect(factSql).toMatch(/issue_id = \$2/);
    const factArgs: unknown[] = query.mock.calls[0][1];
    expect(factArgs).toEqual([RUN.companyId, ISSUE_ID, 50]);

    const sessSql: string = query.mock.calls[1][0];
    expect(sessSql).toContain(`${NS}.sessions`);
    expect(sessSql).toMatch(/LIMIT 1/);

    const peerSql: string = query.mock.calls[2][0];
    expect(peerSql).toContain(`${NS}.peer_models`);
    expect(peerSql).toMatch(/agent_id = ANY\(\$2::uuid\[\]\)/);
    const peerArgs: unknown[] = query.mock.calls[2][1];
    // Set ordering may differ; assert membership.
    expect(peerArgs[0]).toBe(RUN.companyId);
    const ids = peerArgs[1] as string[];
    expect(ids).toContain(AGENT_ID_A);
    expect(ids).toContain(AGENT_ID_B);

    const data = result.data as {
      facts: unknown[];
      session: { summary: string };
      peer_models: unknown[];
    };
    expect(data.facts).toHaveLength(2);
    expect(data.session?.summary).toBe("rolling summary");
    expect(data.peer_models).toHaveLength(1);

    expect(result.content).toMatch(/Memory context for issue/);
    expect(result.content).toMatch(/Session summary/);
    expect(result.content).toMatch(/Facts \(2\)/);
    expect(result.content).toMatch(/Peer models \(1\)/);
  });

  it("skips peer_models query when include_peer_models is false", async () => {
    const factRows = [
      {
        id: "f1",
        content: "x",
        about_peer: null,
        confidence: 0.5,
        level: "explicit",
        issue_id: ISSUE_ID,
        agent_id: AGENT_ID_A,
        metadata: {},
        created_at: "2026-04-28T00:00:00Z",
      },
    ];
    const { db, query } = makeDb([{ rows: factRows }, { rows: [] }]);
    const result = await runMemoryGetIssueContext(
      { db },
      { issue_id: ISSUE_ID, include_peer_models: false },
      RUN,
    );
    expect(query).toHaveBeenCalledTimes(2);
    const data = result.data as { peer_models: unknown[] };
    expect(data.peer_models).toEqual([]);
  });

  it("renders 'no session summary' guidance when sessions row is absent", async () => {
    const { db } = makeDb([
      { rows: [] }, // facts
      { rows: [] }, // session
    ]);
    const result = await runMemoryGetIssueContext(
      { db },
      { issue_id: ISSUE_ID, include_peer_models: false },
      RUN,
    );
    expect(result.content).toMatch(/No session summary/);
    expect(result.content).toMatch(/No facts captured/);
  });
});
