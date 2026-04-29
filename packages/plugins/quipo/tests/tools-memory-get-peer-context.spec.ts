import { describe, expect, it, vi } from "vitest";

import { runMemoryGetPeerContext } from "../src/tools/memory-get-peer-context.js";
import type { MemoryDb, ToolRun } from "../src/tools/types.js";

const NS = "plugin_quipo_d14f4ce0c0";

const RUN: ToolRun = {
  agentId: "11111111-1111-1111-1111-111111111111",
  runId: "22222222-2222-2222-2222-222222222222",
  companyId: "33333333-3333-3333-3333-333333333333",
  projectId: "44444444-4444-4444-4444-444444444444",
};

const AGENT_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const USER_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";

function makeDb(specs: Record<string, unknown>[][]): {
  db: MemoryDb;
  query: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn();
  for (const rows of specs) query.mockResolvedValueOnce(rows);
  return { db: { namespace: NS, query: query as MemoryDb["query"] }, query };
}

describe("memory_get_peer_context tool", () => {
  it("requires exactly one of agent_id / user_id", async () => {
    const { db } = makeDb([]);
    expect((await runMemoryGetPeerContext({ db }, {}, RUN)).error).toMatch(/exactly one/);
    expect(
      (
        await runMemoryGetPeerContext(
          { db },
          { agent_id: AGENT_ID, user_id: USER_ID },
          RUN,
        )
      ).error,
    ).toMatch(/exactly one/);
  });

  it("rejects non-uuid agent_id and user_id", async () => {
    const { db } = makeDb([]);
    expect(
      (await runMemoryGetPeerContext({ db }, { agent_id: "x" }, RUN)).error,
    ).toMatch(/UUID/);
    expect(
      (await runMemoryGetPeerContext({ db }, { user_id: "x" }, RUN)).error,
    ).toMatch(/UUID/);
  });

  it("for agent peer: queries facts and peer_models scoped to company + agent", async () => {
    const { db, query } = makeDb([
      [
        {
          id: "f1",
          content: "fact",
          about_peer: "agent",
          confidence: 0.8,
          level: "explicit",
          issue_id: null,
          agent_id: AGENT_ID,
          metadata: {},
          created_at: "2026-04-28T00:00:00Z",
        },
      ],
      [
        {
          id: "p1",
          agent_id: AGENT_ID,
          model: "model body",
          fact_count: 7,
          updated_at: "2026-04-28T00:00:00Z",
        },
      ],
    ]);
    const result = await runMemoryGetPeerContext(
      { db },
      { agent_id: AGENT_ID },
      RUN,
    );
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][0]).toContain(`${NS}.facts`);
    expect(query.mock.calls[0][1]).toEqual([RUN.companyId, AGENT_ID, 50]);
    expect(query.mock.calls[1][0]).toContain(`${NS}.peer_models`);
    expect(query.mock.calls[1][1]).toEqual([RUN.companyId, AGENT_ID]);

    const data = result.data as {
      peer_model: { agent_id: string; fact_count: number } | null;
      facts: unknown[];
    };
    expect(data.peer_model?.agent_id).toBe(AGENT_ID);
    expect(data.peer_model?.fact_count).toBe(7);
    expect(data.facts).toHaveLength(1);
    expect(result.content).toMatch(new RegExp(`agent ${AGENT_ID}`));
    expect(result.content).toMatch(/Peer model/);
  });

  it("for user peer: queries facts by metadata user_id and skips peer_models", async () => {
    const { db, query } = makeDb([[]]);
    const result = await runMemoryGetPeerContext(
      { db },
      { user_id: USER_ID },
      RUN,
    );
    expect(query).toHaveBeenCalledTimes(1);
    const sql: string = query.mock.calls[0][0];
    expect(sql).toContain("about_peer = 'user'");
    expect(sql).toContain("metadata ->> 'user_id'");
    const args: unknown[] = query.mock.calls[0][1];
    expect(args).toEqual([RUN.companyId, USER_ID, 50]);

    const data = result.data as { peer_model: unknown; facts: unknown[] };
    expect(data.peer_model).toBeNull();
    expect(data.facts).toEqual([]);
    expect(result.content).toMatch(/User peers do not have a peer_models row/);
  });

  it("returns null peer_model when agent has no row yet", async () => {
    const { db } = makeDb([[], []]);
    const result = await runMemoryGetPeerContext(
      { db },
      { agent_id: AGENT_ID },
      RUN,
    );
    expect(result.content).toMatch(/No peer model recorded/);
    const data = result.data as { peer_model: unknown };
    expect(data.peer_model).toBeNull();
  });
});
