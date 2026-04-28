/**
 * `memory_ask_peer` — wake another agent and ask it a question.
 *
 * Uses `ctx.agents.invoke(agentId, ...)` which is fire-and-forget; the
 * answer arrives later as comments / state changes on the destination
 * agent's queue. The tool returns the new run id so the caller can wait,
 * poll, or correlate the answer with a follow-up tool call.
 *
 * Phase 1 MVP supports agent peers only — there is no host-side mechanism
 * for plugin tools to invoke a human user. The schema reserves the
 * `user_id` parameter so adding user-handoff later does not change the
 * tool contract.
 */

import type { AgentInvoker, ToolReturn, ToolRun } from "./types.js";

export interface MemoryAskPeerParams {
  agent_id?: string;
  user_id?: string;
  question: string;
  context?: string;
  reason?: string;
}

export const MEMORY_ASK_PEER_PARAMETERS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["question"],
  properties: {
    agent_id: {
      type: "string",
      format: "uuid",
      description:
        "UUID of the agent peer to ask. Required for Phase 1 MVP — user_id is reserved for future handoff support.",
    },
    user_id: {
      type: "string",
      format: "uuid",
      description:
        "Reserved. The Phase 1 MVP plugin tool surface does not yet support asking human users.",
    },
    question: {
      type: "string",
      minLength: 1,
      maxLength: 4000,
      description: "The question to ask the peer. Sent verbatim as the prompt.",
    },
    context: {
      type: "string",
      maxLength: 4000,
      description:
        "Optional supporting context appended to the prompt before the question.",
    },
    reason: {
      type: "string",
      maxLength: 200,
      description:
        "Short reason recorded on the destination agent's wake event for audit trails.",
    },
  },
} as const;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ParsedParams {
  agentId: string | null;
  userId: string | null;
  question: string;
  context: string | null;
  reason: string | null;
}

function parseParams(raw: unknown): ParsedParams | { error: string } {
  if (raw === null || typeof raw !== "object") {
    return { error: "params must be an object" };
  }
  const params = raw as Record<string, unknown>;

  let agentId: string | null = null;
  let userId: string | null = null;

  const rawAgent = params["agent_id"];
  if (rawAgent !== undefined && rawAgent !== null) {
    if (typeof rawAgent !== "string" || !UUID_RE.test(rawAgent)) {
      return { error: "`agent_id` must be a UUID" };
    }
    agentId = rawAgent;
  }
  const rawUser = params["user_id"];
  if (rawUser !== undefined && rawUser !== null) {
    if (typeof rawUser !== "string" || !UUID_RE.test(rawUser)) {
      return { error: "`user_id` must be a UUID" };
    }
    userId = rawUser;
  }

  const question = params["question"];
  if (typeof question !== "string" || question.trim().length === 0) {
    return { error: "`question` is required and must be a non-empty string" };
  }
  if (question.length > 4000) {
    return { error: "`question` must be <= 4000 characters" };
  }

  let context: string | null = null;
  if ("context" in params) {
    const v = params["context"];
    if (v !== undefined && v !== null) {
      if (typeof v !== "string") {
        return { error: "`context` must be a string" };
      }
      if (v.length > 4000) {
        return { error: "`context` must be <= 4000 characters" };
      }
      context = v;
    }
  }

  let reason: string | null = null;
  if ("reason" in params) {
    const v = params["reason"];
    if (v !== undefined && v !== null) {
      if (typeof v !== "string") {
        return { error: "`reason` must be a string" };
      }
      if (v.length > 200) {
        return { error: "`reason` must be <= 200 characters" };
      }
      reason = v;
    }
  }

  return {
    agentId,
    userId,
    question: question.trim(),
    context,
    reason,
  };
}

export async function runMemoryAskPeer(
  deps: { agents: AgentInvoker },
  params: unknown,
  runCtx: ToolRun,
): Promise<ToolReturn> {
  const parsed = parseParams(params);
  if ("error" in parsed) {
    return { error: parsed.error };
  }

  if (parsed.userId && !parsed.agentId) {
    return {
      error:
        "memory_ask_peer cannot wake human users in the Phase 1 MVP. Set `agent_id` to ask another agent instead.",
    };
  }
  if (!parsed.agentId) {
    return {
      error: "`agent_id` is required for the Phase 1 MVP memory_ask_peer tool",
    };
  }
  if (parsed.agentId === runCtx.agentId) {
    return {
      error: "memory_ask_peer cannot target the calling agent (would self-invoke).",
    };
  }

  const prompt = buildPrompt(parsed.question, parsed.context, runCtx);
  const reason =
    parsed.reason ??
    `memory_ask_peer from agent ${runCtx.agentId} run ${runCtx.runId}`;

  let result: { runId: string };
  try {
    result = await deps.agents.invoke(parsed.agentId, runCtx.companyId, {
      prompt,
      reason,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { error: `agents.invoke failed: ${detail}` };
  }

  return {
    content:
      `Sent question to agent ${parsed.agentId}. Run ${result.runId} is queued; ` +
      `the peer will respond asynchronously via its normal heartbeat.`,
    data: {
      target_agent_id: parsed.agentId,
      run_id: result.runId,
      reason,
    },
  };
}

function buildPrompt(
  question: string,
  context: string | null,
  runCtx: ToolRun,
): string {
  const lines: string[] = [];
  lines.push(
    `You have been asked a question by another agent (id ${runCtx.agentId}, run ${runCtx.runId}).`,
  );
  lines.push("Reply with your best answer; the asker will read your next comment / output.");
  if (context && context.trim().length > 0) {
    lines.push("");
    lines.push("Context:");
    lines.push(context.trim());
  }
  lines.push("");
  lines.push("Question:");
  lines.push(question);
  return lines.join("\n");
}
