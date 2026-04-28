import { describe, expect, it } from "vitest";

import {
  EXTRACT_FACTS_SYSTEM_PROMPT,
  buildExtractFactsUserPrompt,
  extractedFactsJsonSchema,
  extractedFactsResponseSchema,
  parseExtractedFactsResponse,
} from "../src/prompts/extract-facts.js";

describe("EXTRACT_FACTS_SYSTEM_PROMPT", () => {
  it("documents the required output schema and the 'return JSON only' rule", () => {
    expect(EXTRACT_FACTS_SYSTEM_PROMPT).toContain('"facts"');
    expect(EXTRACT_FACTS_SYSTEM_PROMPT).toContain("about_peer");
    expect(EXTRACT_FACTS_SYSTEM_PROMPT).toContain("confidence");
    expect(EXTRACT_FACTS_SYSTEM_PROMPT).toMatch(/JSON ONLY|JSON only/);
    expect(EXTRACT_FACTS_SYSTEM_PROMPT).toMatch(/empty.*valid|"facts": \[\]/i);
  });

  it("explicitly forbids leaking secrets / private user data", () => {
    expect(EXTRACT_FACTS_SYSTEM_PROMPT).toMatch(/secrets|credentials|private/i);
  });
});

describe("buildExtractFactsUserPrompt", () => {
  it("requires a non-empty content body", () => {
    expect(() => buildExtractFactsUserPrompt({ content: "" })).toThrow(/content/);
    expect(() => buildExtractFactsUserPrompt({ content: "   " })).toThrow(/content/);
  });

  it("emits a SOURCE block wrapping the comment body verbatim", () => {
    const out = buildExtractFactsUserPrompt({
      content: "I prefer TypeScript over Java for new services.",
    });
    expect(out).toContain("SOURCE:");
    expect(out).toContain("I prefer TypeScript over Java for new services.");
    expect(out).toContain("```");
  });

  it("includes context lines for issue identifier, author, and peer hint when supplied", () => {
    const out = buildExtractFactsUserPrompt({
      content: "Same as before — let's use vitest.",
      sourceKind: "comment",
      issueIdentifier: "RED-100",
      issueId: "4445ad1b-eac6-4d90-92db-99151bba5657",
      authorDisplayName: "Darren",
      peerHint: { kind: "user", displayName: "Darren" },
    });
    expect(out).toContain("CONTEXT:");
    expect(out).toContain("source_kind: comment");
    expect(out).toContain("issue: RED-100");
    expect(out).toContain("issue_id: 4445ad1b-eac6-4d90-92db-99151bba5657");
    expect(out).toContain("author: Darren");
    expect(out).toContain("peer_hint: user=Darren");
  });

  it("omits the CONTEXT block entirely when no context fields are supplied", () => {
    const out = buildExtractFactsUserPrompt({ content: "hi" });
    expect(out).not.toContain("CONTEXT:");
    expect(out).toContain("SOURCE:");
  });

  it("instructs the model to return the {facts: [...]} shape on every call", () => {
    const out = buildExtractFactsUserPrompt({ content: "hi" });
    expect(out).toMatch(/Return JSON only.*facts/);
  });
});

describe("extractedFactsResponseSchema", () => {
  it("accepts a well-formed response with mixed about_peer values", () => {
    const result = extractedFactsResponseSchema.safeParse({
      facts: [
        { content: "Darren prefers TypeScript", about_peer: "user", confidence: 0.9 },
        { content: "QA agent rejects mocked DB tests", about_peer: "agent", confidence: 0.85 },
        { content: "Project uses pnpm workspaces", about_peer: null, confidence: 0.7 },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty facts array", () => {
    const result = extractedFactsResponseSchema.safeParse({ facts: [] });
    expect(result.success).toBe(true);
  });

  it("rejects unknown about_peer values", () => {
    const result = extractedFactsResponseSchema.safeParse({
      facts: [{ content: "x", about_peer: "human", confidence: 0.5 }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects confidence outside [0, 1]", () => {
    const high = extractedFactsResponseSchema.safeParse({
      facts: [{ content: "x", about_peer: null, confidence: 1.5 }],
    });
    const low = extractedFactsResponseSchema.safeParse({
      facts: [{ content: "x", about_peer: null, confidence: -0.1 }],
    });
    expect(high.success).toBe(false);
    expect(low.success).toBe(false);
  });

  it("rejects empty content and content > 1000 chars", () => {
    const empty = extractedFactsResponseSchema.safeParse({
      facts: [{ content: "", about_peer: null, confidence: 0.5 }],
    });
    const tooLong = extractedFactsResponseSchema.safeParse({
      facts: [{ content: "a".repeat(1001), about_peer: null, confidence: 0.5 }],
    });
    expect(empty.success).toBe(false);
    expect(tooLong.success).toBe(false);
  });

  it("rejects extra properties on the fact object (additionalProperties false)", () => {
    const result = extractedFactsResponseSchema.safeParse({
      facts: [
        {
          content: "x",
          about_peer: null,
          confidence: 0.5,
          source: "comment-1",
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects > 50 facts in a single response", () => {
    const facts = Array.from({ length: 51 }, () => ({
      content: "x",
      about_peer: null,
      confidence: 0.5,
    }));
    const result = extractedFactsResponseSchema.safeParse({ facts });
    expect(result.success).toBe(false);
  });
});

describe("parseExtractedFactsResponse", () => {
  it("parses a plain JSON response", () => {
    const raw = '{"facts":[{"content":"Darren likes TS","about_peer":"user","confidence":0.9}]}';
    const out = parseExtractedFactsResponse(raw);
    expect(out.facts).toHaveLength(1);
    expect(out.facts[0]?.content).toBe("Darren likes TS");
  });

  it("strips ```json ... ``` code fences", () => {
    const raw = '```json\n{"facts":[]}\n```';
    expect(parseExtractedFactsResponse(raw).facts).toEqual([]);
  });

  it("strips bare ``` ... ``` code fences", () => {
    const raw = '```\n{"facts":[]}\n```';
    expect(parseExtractedFactsResponse(raw).facts).toEqual([]);
  });

  it("isolates the JSON block when the model adds prose around it", () => {
    const raw = 'Sure, here is the JSON:\n{"facts":[{"content":"x","about_peer":null,"confidence":0.5}]}\nLet me know if you need more.';
    const out = parseExtractedFactsResponse(raw);
    expect(out.facts).toHaveLength(1);
  });

  it("throws on empty input", () => {
    expect(() => parseExtractedFactsResponse("")).toThrow(/empty/);
    expect(() => parseExtractedFactsResponse("   ")).toThrow(/empty/);
  });

  it("throws when the response is not parseable JSON", () => {
    expect(() => parseExtractedFactsResponse("not json at all")).toThrow(
      /not valid JSON|did not match schema/,
    );
  });

  it("throws when the schema doesn't match (missing required field)", () => {
    const raw = '{"facts":[{"content":"x","confidence":0.5}]}';
    expect(() => parseExtractedFactsResponse(raw)).toThrow(/did not match schema/);
  });

  it("throws on non-string input", () => {
    expect(() => parseExtractedFactsResponse(null as unknown as string)).toThrow(
      /expected string/,
    );
  });
});

describe("extractedFactsJsonSchema", () => {
  it("matches the zod schema's shape (required fields + about_peer enum)", () => {
    expect(extractedFactsJsonSchema.required).toEqual(["facts"]);
    const item = extractedFactsJsonSchema.properties.facts.items;
    expect(item.required).toEqual(["content", "about_peer", "confidence"]);
    expect(item.additionalProperties).toBe(false);
    expect(item.properties.about_peer.enum).toEqual(["agent", "user", null]);
    expect(item.properties.confidence.minimum).toBe(0);
    expect(item.properties.confidence.maximum).toBe(1);
    expect(item.properties.content.minLength).toBe(1);
    expect(item.properties.content.maxLength).toBe(1000);
  });

  it("declares additionalProperties: false on the response object too", () => {
    expect(extractedFactsJsonSchema.additionalProperties).toBe(false);
  });
});
