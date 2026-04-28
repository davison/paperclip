import { describe, expect, it } from "vitest";

import manifest from "../src/manifest.js";
import {
  QUIPO_TOOL_DECLARATIONS,
  QUIPO_TOOL_NAMES,
} from "../src/tools/index.js";

describe("Quipo plugin tool declarations", () => {
  it("declares the five RED-101 Phase 1 MVP tools", () => {
    expect(QUIPO_TOOL_DECLARATIONS).toHaveLength(5);
    const names = QUIPO_TOOL_DECLARATIONS.map((d) => d.name).sort();
    expect(names).toEqual(
      [
        "memory_ask_peer",
        "memory_get_issue_context",
        "memory_get_peer_context",
        "memory_search",
        "memory_search_conclusions",
      ].sort(),
    );
  });

  it("exposes the same tool names via QUIPO_TOOL_NAMES", () => {
    expect(QUIPO_TOOL_NAMES).toEqual({
      search: "memory_search",
      searchConclusions: "memory_search_conclusions",
      getIssueContext: "memory_get_issue_context",
      getPeerContext: "memory_get_peer_context",
      askPeer: "memory_ask_peer",
    });
  });

  it("each declaration has a non-empty displayName, description, and parametersSchema object", () => {
    for (const decl of QUIPO_TOOL_DECLARATIONS) {
      expect(decl.displayName.length).toBeGreaterThan(0);
      expect(decl.description.length).toBeGreaterThan(0);
      expect(decl.parametersSchema).toMatchObject({ type: "object" });
    }
  });

  it("manifest.tools mirrors the declarations and the manifest requests required capabilities", () => {
    expect(manifest.tools).toBeDefined();
    expect(manifest.tools).toHaveLength(5);
    const manifestNames = (manifest.tools ?? []).map((t) => t.name).sort();
    const declNames = QUIPO_TOOL_DECLARATIONS.map((d) => d.name).sort();
    expect(manifestNames).toEqual(declNames);

    expect(manifest.capabilities).toContain("agent.tools.register");
    expect(manifest.capabilities).toContain("agents.invoke");
    expect(manifest.capabilities).toContain("database.namespace.read");
  });

  it("memory_search advertises the trigram-friendly param surface", () => {
    const decl = QUIPO_TOOL_DECLARATIONS.find((d) => d.name === "memory_search")!;
    const schema = decl.parametersSchema as unknown as {
      properties: Record<string, unknown>;
      required: ReadonlyArray<string>;
    };
    expect([...schema.required]).toEqual(["query"]);
    expect(schema.properties).toHaveProperty("limit");
    expect(schema.properties).toHaveProperty("min_similarity");
    expect(schema.properties).toHaveProperty("about_peer");
  });
});
