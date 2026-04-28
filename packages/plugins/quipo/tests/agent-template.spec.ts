import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { MEMORY_WORKER_AGENT_TEMPLATE } from "../src/agent-templates/memory-worker/template.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const agentsMdPath = path.resolve(here, "../src/agent-templates/memory-worker/AGENTS.md");

describe("MEMORY_WORKER_AGENT_TEMPLATE", () => {
  it("declares the expected name, role, and display name", () => {
    expect(MEMORY_WORKER_AGENT_TEMPLATE.nameKey).toBe("memory-worker");
    expect(MEMORY_WORKER_AGENT_TEMPLATE.displayName).toBe("Memory Worker");
    // The host AGENT_ROLES enum doesn't have "worker" — RED-100 maps the
    // operational role to "general" (non-leader, no department).
    expect(MEMORY_WORKER_AGENT_TEMPLATE.role).toBe("general");
  });

  it("loads instructions from the canonical AGENTS.md file", async () => {
    const fromDisk = await readFile(agentsMdPath, "utf8");
    expect(MEMORY_WORKER_AGENT_TEMPLATE.instructionsMarkdown).toBe(fromDisk);
  });

  it("instructions describe the structured-output contract the prompts module enforces", () => {
    const md = MEMORY_WORKER_AGENT_TEMPLATE.instructionsMarkdown;
    expect(md).toContain("memory-worker");
    expect(md).toMatch(/about_peer/);
    expect(md).toMatch(/confidence/);
    expect(md).toMatch(/JSON/);
    expect(md).toMatch(/Quipo/);
  });

  it("reminds the agent it is a worker (no chat, no delegation)", () => {
    const md = MEMORY_WORKER_AGENT_TEMPLATE.instructionsMarkdown;
    expect(md).toMatch(/worker/i);
    expect(md).toMatch(/do not chat|does not (own|delegate)|stateless/i);
  });
});
