import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

import manifest from "../src/manifest.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.resolve(here, "../migrations/001_init_memory.sql");
const expectedNamespace = "plugin_quipo_d14f4ce0c0";

function splitStatements(input: string): string[] {
  // Mirrors server/src/services/plugin-database.ts splitSqlStatements but
  // simplified to bare ;-separated statements with comment stripping. Good
  // enough for the migrations we author in this package.
  const noBlock = input.replace(/\/\*[\s\S]*?\*\//g, "");
  const noLine = noBlock.replace(/--.*$/gm, "");
  return noLine
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

describe("quipo plugin manifest", () => {
  it("declares the expected database namespace and core read tables", () => {
    expect(manifest.id).toBe("paperclipai.plugin-quipo");
    expect(manifest.database).toBeDefined();
    expect(manifest.database!.namespaceSlug).toBe("quipo");
    expect(manifest.database!.migrationsDir).toBe("migrations");
    expect(manifest.database!.coreReadTables).toEqual([
      "issues",
      "issue_comments",
      "agents",
      "companies",
    ]);
  });

  it("requests the database capabilities the worker needs", () => {
    expect(manifest.capabilities).toContain("database.namespace.migrate");
    expect(manifest.capabilities).toContain("database.namespace.read");
    expect(manifest.capabilities).toContain("database.namespace.write");
  });

  it("declares the per-company instanceConfigSchema for RED-102 settings", () => {
    expect(manifest.instanceConfigSchema).toBeDefined();
    const schema = manifest.instanceConfigSchema as {
      type: string;
      additionalProperties?: boolean;
      properties: Record<string, { type: string; enum?: unknown[]; default?: unknown }>;
    };
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties).sort()).toEqual([
      "enabled",
      "extractionScope",
      "memoryAgentId",
    ]);
    expect(schema.properties.enabled.type).toBe("boolean");
    expect(schema.properties.enabled.default).toBe(false);
    expect(schema.properties.memoryAgentId.type).toBe("string");
    expect(schema.properties.extractionScope.type).toBe("string");
    expect(schema.properties.extractionScope.enum).toEqual([
      "comments_and_updates",
      "comments_only",
    ]);
    expect(schema.properties.extractionScope.default).toBe("comments_and_updates");
  });

  it("registers the QuipoSettingsPage UI slot with instance.settings.register capability", () => {
    expect(manifest.capabilities).toContain("instance.settings.register");
    const slots = manifest.ui?.slots ?? [];
    const settingsSlot = slots.find((slot) => slot.type === "settingsPage");
    expect(settingsSlot).toBeDefined();
    expect(settingsSlot?.exportName).toBe("QuipoSettingsPage");
    expect(manifest.entrypoints?.ui).toBe("./dist/ui");
  });
});

describe("quipo plugin migration 001_init_memory.sql", () => {
  it("creates facts, sessions, and peer_models tables in the plugin namespace", async () => {
    const sql = await readFile(migrationPath, "utf8");
    const statements = splitStatements(sql);
    const tableLines = statements.filter((s) => /^create\s+table/i.test(s));
    const indexLines = statements.filter((s) => /^create(\s+unique)?\s+index/i.test(s));

    expect(tableLines).toHaveLength(3);
    expect(tableLines.some((s) => s.includes(`${expectedNamespace}.facts`))).toBe(true);
    expect(tableLines.some((s) => s.includes(`${expectedNamespace}.sessions`))).toBe(true);
    expect(tableLines.some((s) => s.includes(`${expectedNamespace}.peer_models`))).toBe(true);

    // 4 indexes on facts (company, issue, agent, gin_trgm) + 2 unique indexes
    // (sessions.issue_id, peer_models.company_agent).
    expect(indexLines).toHaveLength(6);
    expect(
      indexLines.some(
        (s) => /gin\s*\(\s*content\s+gin_trgm_ops\s*\)/i.test(s) && s.includes(`${expectedNamespace}.facts`),
      ),
    ).toBe(true);
  });
});
