import { describe, expect, it } from "vitest";

import {
  QUIPO_DEFAULTS,
  QUIPO_EXTRACTION_SCOPES,
  readQuipoConfig,
} from "../src/config.js";

describe("readQuipoConfig", () => {
  it("returns defaults for null/undefined input", () => {
    expect(readQuipoConfig(null)).toEqual(QUIPO_DEFAULTS);
    expect(readQuipoConfig(undefined)).toEqual(QUIPO_DEFAULTS);
  });

  it("returns defaults for empty object", () => {
    expect(readQuipoConfig({})).toEqual(QUIPO_DEFAULTS);
  });

  it("reads enabled as a strict boolean (no truthy coercion)", () => {
    expect(readQuipoConfig({ enabled: true }).enabled).toBe(true);
    expect(readQuipoConfig({ enabled: false }).enabled).toBe(false);
    // Non-booleans must NOT silently flip the master switch on.
    expect(readQuipoConfig({ enabled: "true" }).enabled).toBe(false);
    expect(readQuipoConfig({ enabled: 1 }).enabled).toBe(false);
    expect(readQuipoConfig({ enabled: "yes" }).enabled).toBe(false);
  });

  it("trims and rejects empty memoryAgentId", () => {
    expect(readQuipoConfig({ memoryAgentId: "  " }).memoryAgentId).toBeNull();
    expect(readQuipoConfig({ memoryAgentId: "" }).memoryAgentId).toBeNull();
    expect(readQuipoConfig({ memoryAgentId: "  abc-123  " }).memoryAgentId).toBe("abc-123");
  });

  it("falls back to default extractionScope on unknown values", () => {
    expect(readQuipoConfig({ extractionScope: "comments_only" }).extractionScope).toBe(
      "comments_only",
    );
    expect(readQuipoConfig({ extractionScope: "comments_and_updates" }).extractionScope).toBe(
      "comments_and_updates",
    );
    expect(readQuipoConfig({ extractionScope: "garbage" }).extractionScope).toBe(
      QUIPO_DEFAULTS.extractionScope,
    );
    expect(readQuipoConfig({ extractionScope: 42 as unknown }).extractionScope).toBe(
      QUIPO_DEFAULTS.extractionScope,
    );
  });

  it("ignores unrelated fields without throwing", () => {
    const cfg = readQuipoConfig({
      enabled: true,
      memoryAgentId: "agent-uuid",
      extractionScope: "comments_only",
      futureFlag: "ignored",
    } as unknown as Record<string, unknown>);
    expect(cfg).toEqual({
      enabled: true,
      memoryAgentId: "agent-uuid",
      extractionScope: "comments_only",
    });
  });

  it("exposes the canonical extraction scope list (frozen contract)", () => {
    expect(QUIPO_EXTRACTION_SCOPES).toEqual(["comments_and_updates", "comments_only"]);
  });
});
