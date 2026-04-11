import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createMempalaceMemoryAdapter } from "../services/memory-adapters/mempalace.js";
import { createMempalaceSidecar } from "../services/memory-adapters/mempalace-sidecar.js";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { MemoryScope, MemorySourceRef } from "@paperclipai/plugin-sdk";

// ---------------------------------------------------------------------------
// Integration tests — spawn a real mempalace MCP sidecar process.
//
// Requires: mempalace Python package installed.
// These tests are slower (real ChromaDB embeddings) and are skipped in CI
// unless MEMPALACE_INTEGRATION=1 is set.
// ---------------------------------------------------------------------------

const PYTHON_CMD = process.env.MEMPALACE_PYTHON ?? "/tmp/mempalace-venv/bin/python";
const RUN_INTEGRATION = process.env.MEMPALACE_INTEGRATION === "1" || process.env.CI === undefined;

const describeIntegration = RUN_INTEGRATION ? describe : describe.skip;

// Shared test fixtures
const scope: MemoryScope = { companyId: "test-co", agentId: "agent-a", projectId: "proj-1" };
const source: MemorySourceRef = { kind: "integration_test", companyId: "test-co" };

describeIntegration("Mempalace Integration", () => {
  let palaceDir: string;
  let adapter: ReturnType<typeof createMempalaceMemoryAdapter>;

  beforeAll(async () => {
    palaceDir = mkdtempSync(join(tmpdir(), "mempalace-test-"));

    adapter = createMempalaceMemoryAdapter({
      command: PYTHON_CMD,
      args: ["-m", "mempalace.mcp_server"],
      cwd: palaceDir,
      env: { MEMPALACE_PALACE_PATH: palaceDir },
      connectTimeoutMs: 30_000,
      callTimeoutMs: 30_000,
    });

    await adapter.connect();
  }, 60_000);

  afterAll(async () => {
    await adapter.disconnect();
    try {
      rmSync(palaceDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  // ── Write → Query round-trip ─────────────────────────────────────

  it("write then query retrieves the stored content", async () => {
    const writeResult = await adapter.write({
      bindingKey: "default",
      scope,
      source,
      content: "The auth service was migrated to OAuth2 on March 15th. All endpoints now require bearer tokens.",
    });

    expect(writeResult.records).toHaveLength(1);
    expect(writeResult.records![0].providerKey).toBe("mempalace");
    expect(writeResult.records![0].providerRecordId).toBeTruthy();
    expect(writeResult.usage).toHaveLength(1);
    expect(writeResult.usage![0].latencyMs).toBeGreaterThan(0);

    // Query for the content we just stored
    const queryResult = await adapter.query({
      bindingKey: "default",
      scope,
      query: "OAuth2 authentication migration",
      topK: 3,
    });

    expect(queryResult.snippets.length).toBeGreaterThanOrEqual(1);
    const match = queryResult.snippets[0];
    expect(match.text).toContain("auth service");
    expect(match.text).toContain("OAuth2");
    expect(match.score).toBeGreaterThan(0);
    expect(queryResult.usage).toHaveLength(1);
    expect(queryResult.usage![0].latencyMs).toBeGreaterThan(0);
  }, 30_000);

  it("write returns a valid drawer_id in the handle", async () => {
    const result = await adapter.write({
      bindingKey: "default",
      scope,
      source,
      content: "Database connection pool size increased from 10 to 50.",
    });

    const handle = result.records![0];
    expect(handle.providerRecordId).toMatch(/drawer_/);
  }, 15_000);

  // ── Scope isolation (wing separation) ────────────────────────────

  it("wing-scoped queries only return content from that wing", async () => {
    // Write to wing A (project-1)
    await adapter.write({
      bindingKey: "default",
      scope: { companyId: "test-co", projectId: "wing-aaa" },
      source,
      content: "Wing A exclusive: quantum computing research notes for project alpha.",
    });

    // Write to wing B (project-2)
    await adapter.write({
      bindingKey: "default",
      scope: { companyId: "test-co", projectId: "wing-bbb" },
      source,
      content: "Wing B exclusive: mobile app deployment checklist for project beta.",
    });

    // Query wing A — should find quantum computing, not mobile app
    const resultA = await adapter.query({
      bindingKey: "default",
      scope: { companyId: "test-co", projectId: "wing-aaa" },
      query: "research notes",
      topK: 5,
    });

    const textsA = resultA.snippets.map((s) => s.text).join(" ");
    expect(textsA).toContain("quantum computing");

    // Query wing B — should find mobile app, not quantum computing
    const resultB = await adapter.query({
      bindingKey: "default",
      scope: { companyId: "test-co", projectId: "wing-bbb" },
      query: "deployment checklist",
      topK: 5,
    });

    const textsB = resultB.snippets.map((s) => s.text).join(" ");
    expect(textsB).toContain("mobile app");
  }, 30_000);

  // ── Company isolation (separate palace directories) ──────────────

  it("separate palace dirs create isolated stores", async () => {
    const palaceDir2 = mkdtempSync(join(tmpdir(), "mempalace-test-co2-"));

    const adapter2 = createMempalaceMemoryAdapter({
      command: PYTHON_CMD,
      args: ["-m", "mempalace.mcp_server"],
      cwd: palaceDir2,
      env: { MEMPALACE_PALACE_PATH: palaceDir2 },
      connectTimeoutMs: 30_000,
      callTimeoutMs: 30_000,
    });

    try {
      await adapter2.connect();

      // Write to company 2's palace
      await adapter2.write({
        bindingKey: "default",
        scope: { companyId: "co-2", projectId: "proj-2" },
        source: { kind: "test", companyId: "co-2" },
        content: "Company 2 secret: launch date is July 4th.",
      });

      // Query company 1's palace for company 2's content — should not find it
      const result1 = await adapter.query({
        bindingKey: "default",
        scope: { companyId: "test-co" },
        query: "launch date July",
        topK: 5,
      });

      const texts1 = result1.snippets.map((s) => s.text).join(" ");
      expect(texts1).not.toContain("Company 2 secret");
    } finally {
      await adapter2.disconnect();
      try {
        rmSync(palaceDir2, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  }, 45_000);

  // ── Forget ───────────────────────────────────────────────────────

  it("forget deletes drawers so they are no longer returned", async () => {
    // Write a unique piece of content
    const writeResult = await adapter.write({
      bindingKey: "default",
      scope,
      source,
      content: "Ephemeral secret: the password is swordfish. Delete me immediately.",
    });

    const handle = writeResult.records![0];

    // Verify it exists via query
    const beforeForget = await adapter.query({
      bindingKey: "default",
      scope,
      query: "password swordfish",
      topK: 3,
    });
    expect(beforeForget.snippets.some((s) => s.text.includes("swordfish"))).toBe(true);

    // Forget it
    const forgetResult = await adapter.forget([handle], scope);
    expect(forgetResult.usage).toHaveLength(1);
    expect(forgetResult.usage![0].details?.drawersDeleted).toBe(1);

    // Verify it's gone
    const afterForget = await adapter.query({
      bindingKey: "default",
      scope,
      query: "password swordfish",
      topK: 3,
    });
    const stillHasSwordfish = afterForget.snippets.some((s) => s.text.includes("swordfish"));
    expect(stillHasSwordfish).toBe(false);
  }, 30_000);

  // ── Sidecar lifecycle ────────────────────────────────────────────

  it("sidecar start/stop/restart lifecycle", async () => {
    const sidecarDir = mkdtempSync(join(tmpdir(), "mempalace-sidecar-test-"));
    const statuses: string[] = [];

    const sidecar = createMempalaceSidecar({
      palaceDir: sidecarDir,
      pythonCommand: PYTHON_CMD,
      healthCheckIntervalMs: 60_000, // don't trigger during test
      onStatusChange: (s) => statuses.push(s),
    });

    try {
      expect(sidecar.status).toBe("stopped");

      // Start
      await sidecar.start();
      expect(sidecar.status).toBe("running");
      expect(statuses).toContain("starting");
      expect(statuses).toContain("running");

      // Adapter should be usable
      const writeResult = await sidecar.adapter.write({
        bindingKey: "default",
        scope: { companyId: "sidecar-co" },
        source: { kind: "test", companyId: "sidecar-co" },
        content: "Sidecar lifecycle test content.",
      });
      expect(writeResult.records).toHaveLength(1);

      // Stop
      await sidecar.stop();
      expect(sidecar.status).toBe("stopped");
      expect(statuses).toContain("stopped");
    } finally {
      await sidecar.stop();
      try {
        rmSync(sidecarDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  }, 60_000);

  // ── Error handling ───────────────────────────────────────────────

  it("adapter throws when not connected", async () => {
    const disconnected = createMempalaceMemoryAdapter({
      command: PYTHON_CMD,
    });

    await expect(
      disconnected.write({ bindingKey: "default", scope, source, content: "test" }),
    ).rejects.toThrow("not connected");
  });

  it("sidecar fails gracefully with bad python command", async () => {
    const badDir = mkdtempSync(join(tmpdir(), "mempalace-bad-"));
    const sidecar = createMempalaceSidecar({
      palaceDir: badDir,
      pythonCommand: "/nonexistent/python",
    });

    try {
      await expect(sidecar.start()).rejects.toThrow();
      expect(sidecar.status).toBe("failed");
    } finally {
      await sidecar.stop();
      try {
        rmSync(badDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  }, 30_000);

  // ── Usage tracking ───────────────────────────────────────────────

  it("write returns usage with latency and method details", async () => {
    const result = await adapter.write({
      bindingKey: "default",
      scope,
      source,
      content: "Usage tracking test: monitoring latency metrics.",
    });

    expect(result.usage).toHaveLength(1);
    const usage = result.usage![0];
    expect(usage.provider).toBe("mempalace");
    expect(usage.latencyMs).toBeGreaterThan(0);
    expect(usage.details?.method).toBe("add_drawer");
    expect(usage.details?.wing).toBeDefined();
    expect(usage.details?.room).toBeDefined();
  }, 15_000);

  it("query returns usage with latency, method, and result count", async () => {
    const result = await adapter.query({
      bindingKey: "default",
      scope,
      query: "monitoring",
      topK: 3,
    });

    expect(result.usage).toHaveLength(1);
    const usage = result.usage![0];
    expect(usage.provider).toBe("mempalace");
    expect(usage.latencyMs).toBeGreaterThan(0);
    expect(usage.details?.method).toBe("mempalace_search");
    expect(typeof usage.details?.resultCount).toBe("number");
  }, 15_000);

  it("forget returns usage with delete counts", async () => {
    const writeResult = await adapter.write({
      bindingKey: "default",
      scope,
      source,
      content: "Temporary content for usage tracking delete test.",
    });

    const result = await adapter.forget([writeResult.records![0]], scope);
    expect(result.usage).toHaveLength(1);
    const usage = result.usage![0];
    expect(usage.provider).toBe("mempalace");
    expect(usage.latencyMs).toBeGreaterThan(0);
    expect(usage.details?.drawersDeleted).toBe(1);
    expect(usage.details?.drawersRequested).toBe(1);
  }, 15_000);
});
