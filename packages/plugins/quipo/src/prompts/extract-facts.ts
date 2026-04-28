import { z } from "@paperclipai/plugin-sdk";

/**
 * Structured-output extraction prompt for the Quipo memory-worker agent.
 *
 * The plugin wakes the memory-worker with one comment / issue update / backfill
 * batch at a time. The agent's job is to return a JSON object matching
 * `extractedFactsResponseSchema` — nothing else. The plugin then writes the
 * facts into `plugin_quipo_d14f4ce0c0.facts` and updates session summaries and
 * peer models.
 *
 * RED-99 (event handlers) and RED-103 (backfill action) compose user prompts
 * via {@link buildExtractFactsUserPrompt} and parse responses via
 * {@link parseExtractedFactsResponse}.
 */

/** Whether a fact is about an agent peer, a human user peer, or general
 *  context (project, decision, codebase). */
export const ABOUT_PEER_VALUES = ["agent", "user", null] as const;
export type AboutPeer = (typeof ABOUT_PEER_VALUES)[number];

export const extractedFactSchema = z
  .object({
    content: z
      .string()
      .min(1, "fact content must be non-empty")
      .max(1000, "fact content must be <= 1000 chars"),
    about_peer: z.union([z.literal("agent"), z.literal("user"), z.null()]),
    confidence: z
      .number()
      .min(0, "confidence must be in [0, 1]")
      .max(1, "confidence must be in [0, 1]"),
  })
  .strict();

export type ExtractedFact = z.infer<typeof extractedFactSchema>;

export const extractedFactsResponseSchema = z
  .object({
    facts: z.array(extractedFactSchema).max(50, "too many facts in one response"),
  })
  .strict();

export type ExtractedFactsResponse = z.infer<typeof extractedFactsResponseSchema>;

/** JSON Schema (draft-07-ish) for LLM `response_format` / structured outputs.
 *  Hand-written so we don't pull a zod-to-json-schema dep just for this. The
 *  prompt-snapshot test verifies it matches the zod schema. */
export const extractedFactsJsonSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "ExtractedFactsResponse",
  type: "object",
  additionalProperties: false,
  required: ["facts"],
  properties: {
    facts: {
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["content", "about_peer", "confidence"],
        properties: {
          content: {
            type: "string",
            minLength: 1,
            maxLength: 1000,
            description:
              "Self-contained atomic statement. No pronouns that depend on surrounding context.",
          },
          about_peer: {
            type: ["string", "null"],
            enum: ["agent", "user", null],
            description:
              "'agent' if the fact is about another agent, 'user' if about a human user, null if general.",
          },
          confidence: {
            type: "number",
            minimum: 0,
            maximum: 1,
            description:
              "Honest 0..1 estimate that the fact is correct and worth recalling.",
          },
        },
      },
    },
  },
} as const;

export const EXTRACT_FACTS_SYSTEM_PROMPT = `You are the Quipo memory-worker. Your only job is to extract atomic facts from the input the plugin gives you and return them as a single JSON object matching this schema:

{
  "facts": [
    { "content": "<atomic statement>", "about_peer": "agent" | "user" | null, "confidence": 0.0-1.0 }
  ]
}

Rules:
- content: a short, self-contained sentence. No pronouns that depend on the surrounding conversation. Use the peer hint the plugin supplies to resolve names.
- about_peer: "agent" if the fact is about another agent, "user" if about a human user, null if general (project, decision, codebase).
- confidence: your honest 0..1 estimate. Use >=0.8 only for facts the source states explicitly.
- Skip greetings, status updates, "I'll do X next" intentions, and procedural chatter. Only extract things still useful months later.
- If nothing is worth remembering, return {"facts": []}. Empty is a valid, healthy answer.
- Return JSON ONLY. No prose, no markdown fences, no commentary. Use your provider's JSON / structured-output mode if available.
- Do not include secrets, credentials, or private user data.`;

/** Inputs the plugin's caller assembles per task. Most are optional — supply
 *  whatever context is available from the source event. */
export interface ExtractFactsContext {
  /** Free-form text the plugin wants the agent to extract from. Required. */
  readonly content: string;
  /** Source kind so the agent can adjust tone (e.g. an issue update reads
   *  differently from a comment). Optional. */
  readonly sourceKind?: "comment" | "issue_update" | "backfill" | string;
  /** Source issue identifier (e.g. RED-100) shown to the agent for context. */
  readonly issueIdentifier?: string;
  /** UUID of the source issue. The plugin uses this when persisting facts;
   *  the agent only needs it to disambiguate when the body references "this
   *  issue". */
  readonly issueId?: string;
  /** UUID of the comment author (agent or user). */
  readonly authorId?: string;
  /** Display name for the author so the agent can produce un-pronominalized
   *  facts (e.g. "Darren prefers TypeScript"). */
  readonly authorDisplayName?: string;
  /** Hint about which peer the facts in this content are most likely about.
   *  Forwarded into the prompt so the agent can resolve "they" / "we". */
  readonly peerHint?: {
    readonly kind: "agent" | "user";
    readonly id?: string;
    readonly displayName?: string;
  };
}

/** Build the user-message body for the extraction call. The system prompt
 *  is {@link EXTRACT_FACTS_SYSTEM_PROMPT}; the user message is everything
 *  per-task. Keeping these split lets RED-99 cache the system half. */
export function buildExtractFactsUserPrompt(input: ExtractFactsContext): string {
  if (!input.content || input.content.trim().length === 0) {
    throw new Error(
      "buildExtractFactsUserPrompt: `content` is required and must be non-empty",
    );
  }

  const lines: string[] = [];
  lines.push("Extract atomic facts from the SOURCE block below.");
  lines.push("");

  const ctx: string[] = [];
  if (input.sourceKind) ctx.push(`source_kind: ${input.sourceKind}`);
  if (input.issueIdentifier) ctx.push(`issue: ${input.issueIdentifier}`);
  if (input.issueId) ctx.push(`issue_id: ${input.issueId}`);
  if (input.authorDisplayName || input.authorId) {
    const author = input.authorDisplayName ?? input.authorId;
    ctx.push(`author: ${author}`);
  }
  if (input.peerHint) {
    const peer =
      input.peerHint.displayName ?? input.peerHint.id ?? "(unknown)";
    ctx.push(`peer_hint: ${input.peerHint.kind}=${peer}`);
  }

  if (ctx.length > 0) {
    lines.push("CONTEXT:");
    for (const c of ctx) lines.push(`- ${c}`);
    lines.push("");
  }

  lines.push("SOURCE:");
  lines.push("```");
  lines.push(input.content);
  lines.push("```");
  lines.push("");
  lines.push(
    'Return JSON only, matching {"facts":[{"content","about_peer","confidence"}]}.',
  );

  return lines.join("\n");
}

/** LLM responses sometimes arrive wrapped in code fences or with a leading
 *  "Here is the JSON:" preamble despite the system prompt. This strips the
 *  most common wrappers, then parses + validates with zod. Throws on garbage
 *  so the caller (RED-99 event handler) can record the failure and retry. */
export function parseExtractedFactsResponse(raw: string): ExtractedFactsResponse {
  if (typeof raw !== "string") {
    throw new TypeError(
      "parseExtractedFactsResponse: expected string, got " + typeof raw,
    );
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error("parseExtractedFactsResponse: empty response");
  }

  const candidate = stripJsonWrapper(trimmed);

  let json: unknown;
  try {
    json = JSON.parse(candidate);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `parseExtractedFactsResponse: response is not valid JSON: ${detail}`,
    );
  }

  const result = extractedFactsResponseSchema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    throw new Error(
      `parseExtractedFactsResponse: response did not match schema: ${issues}`,
    );
  }
  return result.data;
}

/** Strip optional ```json ... ``` fences, then trim a leading/trailing
 *  preamble like "Here is the JSON:" by isolating the first {...} block. */
function stripJsonWrapper(input: string): string {
  // Match a code fence with optional language tag.
  const fenceMatch = input.match(/^```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```$/);
  if (fenceMatch && typeof fenceMatch[1] === "string") {
    return fenceMatch[1].trim();
  }

  // If the model wrote prose around the JSON, isolate the first balanced
  // {...} block. JSON.parse will reject unbalanced or invalid input.
  const start = input.indexOf("{");
  const end = input.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return input.slice(start, end + 1).trim();
  }

  return input;
}
