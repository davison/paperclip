import { describe, expect, it, vi } from "vitest";

import { runMemorySearch } from "../src/tools/memory-search.js";
import type { MemoryDb, ToolRun } from "../src/tools/types.js";

const NS = "plugin_quipo_d14f4ce0c0";

const RUN: ToolRun = {
  agentId: "11111111-1111-1111-1111-111111111111",
  runId: "22222222-2222-2222-2222-222222222222",
  companyId: "33333333-3333-3333-3333-333333333333",
  projectId: "44444444-4444-4444-4444-444444444444",
};

function makeDb(rows: Record<string, unknown>[]): {
  db: MemoryDb;
  query: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn().mockResolvedValue(rows);
  return {
    db: { namespace: NS, query: query as MemoryDb["query"] },
    query,
  };
}

describe("memory_search tool", () => {
  it("rejects when query is missing", async () => {
    const { db } = makeDb([]);
    const result = await runMemorySearch({ db }, {}, RUN);
    expect(result.error).toMatch(/query/);
    expect(result.data).toBeUndefined();
  });

  it("rejects oversize query", async () => {
    const { db } = makeDb([]);
    const result = await runMemorySearch(
      { db },
      { query: "x".repeat(501) },
      RUN,
    );
    expect(result.error).toMatch(/<= 500/);
  });

  it("rejects non-uuid issue_id", async () => {
    const { db } = makeDb([]);
    const result = await runMemorySearch(
      { db },
      { query: "x", issue_id: "not-a-uuid" },
      RUN,
    );
    expect(result.error).toMatch(/issue_id/);
  });

  it("rejects malformed namespace", async () => {
    const db: MemoryDb = {
      namespace: "evil; DROP TABLE",
      query: vi.fn(),
    };
    await expect(runMemorySearch({ db }, { query: "x" }, RUN)).rejects.toThrow(
      /not a safe SQL identifier/,
    );
  });

  it("queries the namespaced facts table with company filter and trigram threshold", async () => {
    const { db, query } = makeDb([]);
    await runMemorySearch({ db }, { query: "auth flow" }, RUN);
    expect(query).toHaveBeenCalledTimes(1);
    const sql: string = query.mock.calls[0][0];
    expect(sql).toContain(`${NS}.facts`);
    expect(sql).toMatch(/similarity\(content, \$\d+\)/);
    expect(sql).toMatch(/ORDER BY sim DESC/);
    expect(sql).toMatch(/LIMIT \$\d+/);

    const params: unknown[] = query.mock.calls[0][1];
    expect(params[0]).toBe(RUN.companyId);
    expect(params).toContain("auth flow");
    expect(params).toContain(0.1); // default min similarity
    expect(params).toContain(20); // default limit
  });

  it("applies optional about_peer / issue_id / agent_id filters", async () => {
    const { db, query } = makeDb([]);
    const issueId = "55555555-5555-5555-5555-555555555555";
    const agentId = "66666666-6666-6666-6666-666666666666";
    await runMemorySearch(
      { db },
      {
        query: "auth",
        about_peer: "agent",
        issue_id: issueId,
        agent_id: agentId,
        limit: 5,
        min_similarity: 0.3,
      },
      RUN,
    );
    const sql: string = query.mock.calls[0][0];
    expect(sql).toContain("about_peer = $");
    expect(sql).toContain("issue_id = $");
    expect(sql).toContain("agent_id = $");

    const params: unknown[] = query.mock.calls[0][1];
    expect(params).toContain("agent");
    expect(params).toContain(issueId);
    expect(params).toContain(agentId);
    expect(params).toContain(5);
    expect(params).toContain(0.3);
  });

  it("treats about_peer = null as a separate IS NULL clause", async () => {
    const { db, query } = makeDb([]);
    await runMemorySearch(
      { db },
      { query: "decisions", about_peer: null },
      RUN,
    );
    const sql: string = query.mock.calls[0][0];
    expect(sql).toContain("about_peer IS NULL");
    const params: unknown[] = query.mock.calls[0][1];
    expect(params).not.toContain(null);
  });

  it("normalises numeric similarity / confidence returned as strings (PG numeric)", async () => {
    const { db } = makeDb([
      {
        id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        content: "Darren prefers TypeScript",
        about_peer: "user",
        confidence: "0.91",
        level: "explicit",
        issue_id: null,
        agent_id: null,
        metadata: {},
        created_at: "2026-04-28T00:00:00Z",
        sim: "0.74",
      },
    ]);
    const result = await runMemorySearch({ db }, { query: "Darren" }, RUN);
    const data = result.data as { facts: Array<{ similarity: number; confidence: number }> };
    expect(data.facts[0].similarity).toBeCloseTo(0.74);
    expect(data.facts[0].confidence).toBeCloseTo(0.91);
    expect(result.content).toMatch(/sim=0\.74/);
  });

  it("renders an explicit no-match message with hints when there are no rows", async () => {
    const { db } = makeDb([]);
    const result = await runMemorySearch({ db }, { query: "obscure topic" }, RUN);
    expect(result.error).toBeUndefined();
    expect(result.content).toMatch(/No facts matched/);
    expect((result.data as { facts: unknown[] }).facts).toHaveLength(0);
  });

  it("sorts ranked facts by similarity descending in the structured payload", async () => {
    const { db } = makeDb([
      {
        id: "1",
        content: "less",
        about_peer: null,
        confidence: 0.5,
        level: "explicit",
        issue_id: null,
        agent_id: null,
        metadata: {},
        created_at: "2026-04-28T00:00:00Z",
        sim: 0.2,
      },
      {
        id: "2",
        content: "more",
        about_peer: null,
        confidence: 0.5,
        level: "explicit",
        issue_id: null,
        agent_id: null,
        metadata: {},
        created_at: "2026-04-28T00:00:00Z",
        sim: 0.9,
      },
    ]);
    const result = await runMemorySearch({ db }, { query: "x" }, RUN);
    const facts = (result.data as { facts: Array<{ id: string; similarity: number }> })
      .facts;
    expect(facts.map((f) => f.id)).toEqual(["2", "1"]);
  });
});
