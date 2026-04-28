import { describe, expect, it, vi } from "vitest";

import { runMemorySearchConclusions } from "../src/tools/memory-search-conclusions.js";
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
  return { db: { namespace: NS, query: query as MemoryDb["query"] }, query };
}

describe("memory_search_conclusions tool", () => {
  it("requires query", async () => {
    const { db } = makeDb([]);
    const result = await runMemorySearchConclusions({ db }, {}, RUN);
    expect(result.error).toMatch(/query/);
  });

  it("clamps limit to 25 and rejects out-of-range", async () => {
    const { db } = makeDb([]);
    const tooLarge = await runMemorySearchConclusions(
      { db },
      { query: "x", limit: 30 },
      RUN,
    );
    expect(tooLarge.error).toMatch(/limit/);
    const tooSmall = await runMemorySearchConclusions(
      { db },
      { query: "x", limit: 0 },
      RUN,
    );
    expect(tooSmall.error).toMatch(/limit/);
  });

  it("queries the namespaced sessions table and skips empty summaries", async () => {
    const { db, query } = makeDb([]);
    await runMemorySearchConclusions(
      { db },
      { query: "release decisions" },
      RUN,
    );
    const sql: string = query.mock.calls[0][0];
    expect(sql).toContain(`${NS}.sessions`);
    expect(sql).toMatch(/summary IS NOT NULL/);
    expect(sql).toMatch(/length\(summary\) > 0/);
    expect(sql).toMatch(/similarity\(coalesce\(summary, ''\), \$2\)/);
    const params: unknown[] = query.mock.calls[0][1];
    expect(params[0]).toBe(RUN.companyId);
    expect(params[1]).toBe("release decisions");
    expect(params[2]).toBe(0.1);
    expect(params[3]).toBe(10);
  });

  it("returns empty-list message when no sessions match", async () => {
    const { db } = makeDb([]);
    const result = await runMemorySearchConclusions(
      { db },
      { query: "no match" },
      RUN,
    );
    expect(result.content).toMatch(/No conclusion summaries/);
    expect((result.data as { conclusions: unknown[] }).conclusions).toHaveLength(0);
  });

  it("normalises and sorts conclusions by similarity desc, truncates long summaries in markdown", async () => {
    const { db } = makeDb([
      {
        id: "s1",
        issue_id: "i1",
        summary: "short summary",
        fact_count: "3",
        updated_at: "2026-04-28T00:00:00Z",
        sim: "0.4",
      },
      {
        id: "s2",
        issue_id: "i2",
        summary: "x".repeat(400),
        fact_count: 9,
        updated_at: "2026-04-27T00:00:00Z",
        sim: 0.9,
      },
    ]);
    const result = await runMemorySearchConclusions({ db }, { query: "y" }, RUN);
    const data = result.data as {
      conclusions: Array<{ session_id: string; similarity: number; fact_count: number }>;
    };
    expect(data.conclusions.map((c) => c.session_id)).toEqual(["s2", "s1"]);
    expect(data.conclusions[0].similarity).toBeCloseTo(0.9);
    expect(data.conclusions[0].fact_count).toBe(9);
    expect(data.conclusions[1].fact_count).toBe(3);
    expect(result.content).toMatch(/…/);
  });
});
