import { describe, expect, it, vi } from "vitest";

import { runMemoryAskPeer } from "../src/tools/memory-ask-peer.js";
import type { AgentInvoker, ToolRun } from "../src/tools/types.js";

const RUN: ToolRun = {
  agentId: "11111111-1111-1111-1111-111111111111",
  runId: "22222222-2222-2222-2222-222222222222",
  companyId: "33333333-3333-3333-3333-333333333333",
  projectId: "44444444-4444-4444-4444-444444444444",
};

const PEER_AGENT_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function makeAgents(): {
  agents: AgentInvoker;
  invoke: ReturnType<typeof vi.fn>;
} {
  const invoke = vi.fn().mockResolvedValue({ runId: "newrun-id" });
  return { agents: { invoke } as unknown as AgentInvoker, invoke };
}

describe("memory_ask_peer tool", () => {
  it("requires question", async () => {
    const { agents } = makeAgents();
    const r = await runMemoryAskPeer({ agents }, { agent_id: PEER_AGENT_ID }, RUN);
    expect(r.error).toMatch(/question/);
  });

  it("requires agent_id and rejects user-only handoff in MVP", async () => {
    const { agents } = makeAgents();
    const noTarget = await runMemoryAskPeer(
      { agents },
      { question: "hi" },
      RUN,
    );
    expect(noTarget.error).toMatch(/agent_id/);

    const userOnly = await runMemoryAskPeer(
      { agents },
      { question: "hi", user_id: "cccccccc-cccc-cccc-cccc-cccccccccccc" },
      RUN,
    );
    expect(userOnly.error).toMatch(/cannot wake human users/);
  });

  it("rejects targeting the calling agent (self-invoke)", async () => {
    const { agents } = makeAgents();
    const r = await runMemoryAskPeer(
      { agents },
      { agent_id: RUN.agentId, question: "hi" },
      RUN,
    );
    expect(r.error).toMatch(/self-invoke/);
  });

  it("invokes the target agent with a structured prompt and returns the runId", async () => {
    const { agents, invoke } = makeAgents();
    const r = await runMemoryAskPeer(
      { agents },
      {
        agent_id: PEER_AGENT_ID,
        question: "What did you decide on auth?",
        context: "Caller has read facts F1, F2.",
        reason: "audit handoff",
      },
      RUN,
    );
    expect(r.error).toBeUndefined();
    expect(invoke).toHaveBeenCalledTimes(1);
    const [agentId, companyId, opts] = invoke.mock.calls[0];
    expect(agentId).toBe(PEER_AGENT_ID);
    expect(companyId).toBe(RUN.companyId);
    expect(opts.reason).toBe("audit handoff");
    expect(opts.prompt).toMatch(/Question:/);
    expect(opts.prompt).toContain("What did you decide on auth?");
    expect(opts.prompt).toContain("Context:");
    expect(opts.prompt).toContain("Caller has read facts F1, F2.");
    expect(opts.prompt).toContain(RUN.agentId);

    const data = r.data as { run_id: string; target_agent_id: string };
    expect(data.run_id).toBe("newrun-id");
    expect(data.target_agent_id).toBe(PEER_AGENT_ID);
    expect(r.content).toMatch(new RegExp(`Sent question to agent ${PEER_AGENT_ID}`));
  });

  it("falls back to a default reason when none provided", async () => {
    const { agents, invoke } = makeAgents();
    await runMemoryAskPeer(
      { agents },
      { agent_id: PEER_AGENT_ID, question: "ping" },
      RUN,
    );
    const opts = invoke.mock.calls[0][2];
    expect(opts.reason).toMatch(/memory_ask_peer/);
    expect(opts.reason).toContain(RUN.agentId);
  });

  it("propagates invoke failures as a tool error", async () => {
    const invoke = vi.fn().mockRejectedValue(new Error("agent paused"));
    const r = await runMemoryAskPeer(
      { agents: { invoke } as unknown as AgentInvoker },
      { agent_id: PEER_AGENT_ID, question: "ping" },
      RUN,
    );
    expect(r.error).toMatch(/agents.invoke failed: agent paused/);
  });

  it("rejects oversized question / context", async () => {
    const { agents } = makeAgents();
    expect(
      (
        await runMemoryAskPeer(
          { agents },
          { agent_id: PEER_AGENT_ID, question: "x".repeat(4001) },
          RUN,
        )
      ).error,
    ).toMatch(/question.*<= 4000/);
    expect(
      (
        await runMemoryAskPeer(
          { agents },
          {
            agent_id: PEER_AGENT_ID,
            question: "ok",
            context: "y".repeat(4001),
          },
          RUN,
        )
      ).error,
    ).toMatch(/context.*<= 4000/);
  });
});
