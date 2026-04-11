import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { createMempalaceMemoryAdapter } from "../services/memory-adapters/mempalace.js";
import type { MemoryScope, MemorySourceRef } from "@paperclipai/plugin-sdk";

// ---------------------------------------------------------------------------
// Mock the MCP SDK — we cannot spawn a real mempalace sidecar in unit tests.
// Integration tests with a live sidecar are in mempalace-integration.test.ts.
// ---------------------------------------------------------------------------

const mockCallTool = vi.fn();
const mockConnect = vi.fn();
const mockClose = vi.fn();

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    close: mockClose,
    callTool: mockCallTool,
  })),
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn().mockImplementation(() => ({})),
}));

const scope: MemoryScope = { companyId: "co-1", agentId: "agent-1", projectId: "proj-1" };
const source: MemorySourceRef = { kind: "manual_note", companyId: "co-1" };

function textResult(text: string) {
  return { content: [{ type: "text", text }] };
}

function jsonResult(data: unknown) {
  return textResult(JSON.stringify(data));
}

/** Builds a mempalace-style search response. */
function searchResult(results: Array<{ text: string; wing?: string; room?: string; similarity?: number; source_file?: string }>) {
  return jsonResult({ query: "test", filters: {}, results });
}

describe("MempalaceMemoryAdapter", () => {
  let adapter: ReturnType<typeof createMempalaceMemoryAdapter>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    adapter = createMempalaceMemoryAdapter({ command: "python", args: ["-m", "mempalace.mcp_server"] });
    await adapter.connect();
  });

  afterEach(async () => {
    mockClose.mockResolvedValue(undefined);
    await adapter.disconnect();
  });

  // ── Identity ────────────────────────────────────────────────────────

  it("has key 'mempalace' and declares browse/async/extraction capabilities", () => {
    expect(adapter.key).toBe("mempalace");
    expect(adapter.capabilities).toEqual({
      profile: false,
      browse: true,
      correction: false,
      asyncIngestion: true,
      multimodal: false,
      providerManagedExtraction: true,
    });
  });

  it("reports connected state correctly", async () => {
    expect(adapter.connected).toBe(true);
    mockClose.mockResolvedValue(undefined);
    await adapter.disconnect();
    expect(adapter.connected).toBe(false);
  });

  // ── Write ───────────────────────────────────────────────────────────

  it("write: calls mempalace_add_drawer with wing/room/source_file/added_by", async () => {
    mockCallTool.mockResolvedValue(
      jsonResult({ success: true, drawer_id: "d-001", wing: "project-proj-1", room: "default" }),
    );

    const result = await adapter.write({
      bindingKey: "default",
      scope,
      source,
      content: "Meeting notes about auth redesign",
    });

    expect(mockCallTool).toHaveBeenCalledTimes(1);
    const [callArgs] = mockCallTool.mock.calls[0];
    expect(callArgs.name).toBe("mempalace_add_drawer");
    expect(callArgs.arguments.content).toBe("Meeting notes about auth redesign");
    expect(callArgs.arguments.wing).toBe("project-proj-1");
    expect(callArgs.arguments.room).toBe("default"); // no issueId → default room
    expect(callArgs.arguments.source_file).toBeDefined();
    expect(callArgs.arguments.added_by).toBe("paperclip");

    expect(result.records).toHaveLength(1);
    expect(result.records![0].providerKey).toBe("mempalace");
    expect(result.records![0].providerRecordId).toContain("d-001");
    expect(result.usage).toHaveLength(1);
    expect(result.usage![0].provider).toBe("mempalace");
  });

  it("write: uses metadata.wing/room overrides when provided", async () => {
    mockCallTool.mockResolvedValue(
      jsonResult({ success: true, drawer_id: "d-002" }),
    );

    await adapter.write({
      bindingKey: "default",
      scope,
      source,
      content: "Custom wing content",
      metadata: { wing: "custom-wing", room: "custom-room" },
    });

    const [callArgs] = mockCallTool.mock.calls[0];
    expect(callArgs.arguments.wing).toBe("custom-wing");
    expect(callArgs.arguments.room).toBe("custom-room");
  });

  it("write: upsert adds first then deletes old drawer", async () => {
    mockCallTool
      .mockResolvedValueOnce(jsonResult({ success: true, drawer_id: "d-new" })) // add
      .mockResolvedValueOnce(jsonResult({ success: true, drawer_id: "d-existing" })); // delete

    await adapter.write({
      bindingKey: "default",
      scope,
      source,
      content: "Updated content",
      mode: "upsert",
      metadata: { drawerId: "d-existing" },
    });

    expect(mockCallTool).toHaveBeenCalledTimes(2);
    const [addCall] = mockCallTool.mock.calls[0];
    expect(addCall.name).toBe("mempalace_add_drawer");
    expect(addCall.arguments.content).toBe("Updated content");

    const [deleteCall] = mockCallTool.mock.calls[1];
    expect(deleteCall.name).toBe("mempalace_delete_drawer");
    expect(deleteCall.arguments.drawer_id).toBe("d-existing");
  });

  it("write: upsert succeeds even if old drawer delete fails", async () => {
    mockCallTool
      .mockResolvedValueOnce(jsonResult({ success: true, drawer_id: "d-new" })) // add succeeds
      .mockRejectedValueOnce(new Error("Drawer not found")); // delete fails (best-effort)

    const result = await adapter.write({
      bindingKey: "default",
      scope,
      source,
      content: "New content via upsert",
      mode: "upsert",
      metadata: { drawerId: "d-missing" },
    });

    expect(result.records).toHaveLength(1);
    expect(result.usage![0].details?.method).toBe("upsert_drawer");
  });

  it("write: includes source provenance as source_file", async () => {
    mockCallTool.mockResolvedValue(jsonResult({ success: true, drawer_id: "d-003" }));

    await adapter.write({
      bindingKey: "default",
      scope,
      source: { kind: "issue_comment", companyId: "co-1", issueId: "issue-99" },
      content: "Comment content",
    });

    const [callArgs] = mockCallTool.mock.calls[0];
    expect(callArgs.arguments.source_file).toContain("issue_comment");
    expect(callArgs.arguments.source_file).toContain("issue:issue-99");
  });

  it("write: defaults wing to 'general' and room to 'default' when scope has no project/agent/issue", async () => {
    mockCallTool.mockResolvedValue(jsonResult({ success: true, drawer_id: "d-004" }));

    await adapter.write({
      bindingKey: "default",
      scope: { companyId: "co-1" },
      source,
      content: "Global content",
    });

    const [callArgs] = mockCallTool.mock.calls[0];
    expect(callArgs.arguments.wing).toBe("general");
    expect(callArgs.arguments.room).toBe("default");
  });

  // ── Query ───────────────────────────────────────────────────────────

  it("query: uses mempalace_status for agent_preamble intent", async () => {
    mockCallTool.mockResolvedValue(
      textResult("Palace: 42 drawers, 3 wings, 7 rooms"),
    );

    const result = await adapter.query({
      bindingKey: "default",
      scope,
      query: "",
      intent: "agent_preamble",
    });

    const [callArgs] = mockCallTool.mock.calls[0];
    expect(callArgs.name).toBe("mempalace_status");

    expect(result.snippets).toHaveLength(1);
    expect(result.snippets[0].text).toContain("42 drawers");
    expect(result.profileSummary).toContain("42 drawers");
  });

  it("query: uses mempalace_search for global search", async () => {
    mockCallTool.mockResolvedValue(
      searchResult([
        { text: "Auth service deployment", similarity: 0.95, wing: "proj-a", room: "deploys" },
        { text: "Auth migration notes", similarity: 0.82, wing: "proj-a", room: "notes" },
      ]),
    );

    const result = await adapter.query({
      bindingKey: "default",
      scope: { companyId: "co-1" },
      query: "authentication deployment",
      topK: 5,
    });

    const [callArgs] = mockCallTool.mock.calls[0];
    expect(callArgs.name).toBe("mempalace_search");
    expect(callArgs.arguments.query).toBe("authentication deployment");
    expect(callArgs.arguments.limit).toBe(5);
    // No wing/room when scope only has companyId
    expect(callArgs.arguments.wing).toBeUndefined();

    expect(result.snippets).toHaveLength(2);
    expect(result.snippets[0].text).toBe("Auth service deployment");
    expect(result.snippets[0].score).toBe(0.95);
    expect(result.snippets[0].handle.providerKey).toBe("mempalace");
  });

  it("query: does not auto-derive wing/room filters from scope", async () => {
    mockCallTool.mockResolvedValue(searchResult([]));

    await adapter.query({
      bindingKey: "default",
      scope: { companyId: "co-1", projectId: "proj-1", issueId: "iss-1" },
      query: "test query",
    });

    const [callArgs] = mockCallTool.mock.calls[0];
    expect(callArgs.name).toBe("mempalace_search");
    expect(callArgs.arguments.wing).toBeUndefined();
    expect(callArgs.arguments.room).toBeUndefined();
  });

  it("query: falls back to single snippet for non-JSON response", async () => {
    mockCallTool.mockResolvedValue(textResult("Plain text search results here"));

    const result = await adapter.query({
      bindingKey: "default",
      scope: { companyId: "co-1" },
      query: "something",
    });

    expect(result.snippets).toHaveLength(1);
    expect(result.snippets[0].text).toBe("Plain text search results here");
  });

  it("query: respects metadataFilter overrides for wing/room", async () => {
    mockCallTool.mockResolvedValue(searchResult([]));

    await adapter.query({
      bindingKey: "default",
      scope: { companyId: "co-1" },
      query: "query",
      metadataFilter: { wing: "override-wing", room: "override-room" },
    });

    const [callArgs] = mockCallTool.mock.calls[0];
    expect(callArgs.name).toBe("mempalace_search");
    expect(callArgs.arguments.wing).toBe("override-wing");
    expect(callArgs.arguments.room).toBe("override-room");
  });

  // ── Get ─────────────────────────────────────────────────────────────

  it("get: retrieves a drawer via search with results wrapper", async () => {
    mockCallTool.mockResolvedValue(
      searchResult([{ text: "Drawer content here", wing: "w1", room: "r1", similarity: 0.99 }]),
    );

    const snippet = await adapter.get(
      { providerKey: "mempalace", providerRecordId: "w1/r1/d-10" },
      scope,
    );

    expect(snippet).not.toBeNull();
    expect(snippet!.text).toBe("Drawer content here");
    expect(snippet!.metadata?.drawer_id).toBe("d-10");

    const [callArgs] = mockCallTool.mock.calls[0];
    expect(callArgs.name).toBe("mempalace_search");
    expect(callArgs.arguments.wing).toBe("w1");
    expect(callArgs.arguments.room).toBe("r1");
  });

  it("get: returns null when search returns empty results", async () => {
    mockCallTool.mockResolvedValue(searchResult([]));

    const snippet = await adapter.get(
      { providerKey: "mempalace", providerRecordId: "nonexistent" },
      scope,
    );
    expect(snippet).toBeNull();
  });

  it("get: returns null on error", async () => {
    mockCallTool.mockRejectedValue(new Error("Connection lost"));

    const snippet = await adapter.get(
      { providerKey: "mempalace", providerRecordId: "d-bad" },
      scope,
    );
    expect(snippet).toBeNull();
  });

  // ── Forget ──────────────────────────────────────────────────────────

  it("forget: calls mempalace_delete_drawer with only drawer_id", async () => {
    mockCallTool.mockResolvedValue(jsonResult({ success: true }));

    const result = await adapter.forget(
      [
        { providerKey: "mempalace", providerRecordId: "w1/r1/d-10" },
        { providerKey: "mempalace", providerRecordId: "d-20" },
      ],
      scope,
    );

    expect(mockCallTool).toHaveBeenCalledTimes(2);

    const [call1] = mockCallTool.mock.calls[0];
    expect(call1.name).toBe("mempalace_delete_drawer");
    expect(call1.arguments.drawer_id).toBe("d-10");
    expect(call1.arguments.wing).toBeUndefined();
    expect(call1.arguments.room).toBeUndefined();

    const [call2] = mockCallTool.mock.calls[1];
    expect(call2.name).toBe("mempalace_delete_drawer");
    expect(call2.arguments.drawer_id).toBe("d-20");

    expect(result.usage![0].details?.drawersDeleted).toBe(2);
    expect(result.usage![0].details?.drawersRequested).toBe(2);
  });

  it("forget: continues on individual delete errors", async () => {
    mockCallTool
      .mockRejectedValueOnce(new Error("Not found"))
      .mockResolvedValueOnce(jsonResult({ success: true }));

    const result = await adapter.forget(
      [
        { providerKey: "mempalace", providerRecordId: "d-bad" },
        { providerKey: "mempalace", providerRecordId: "d-good" },
      ],
      scope,
    );

    expect(result.usage![0].details?.drawersDeleted).toBe(1);
    expect(result.usage![0].details?.drawersRequested).toBe(2);
  });

  // ── Connection lifecycle ────────────────────────────────────────────

  it("throws when calling operations before connect", async () => {
    const disconnected = createMempalaceMemoryAdapter({ command: "python" });

    await expect(
      disconnected.write({ bindingKey: "default", scope, source, content: "test" }),
    ).rejects.toThrow("not connected");
  });

  it("connect is idempotent", async () => {
    // adapter is already connected from beforeEach
    await adapter.connect();
    expect(mockConnect).toHaveBeenCalledTimes(1); // only the initial connect
  });

  it("disconnect is idempotent", async () => {
    mockClose.mockResolvedValue(undefined);
    await adapter.disconnect();
    await adapter.disconnect();
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  // ── Handle encoding ─────────────────────────────────────────────────

  it("encodes handles with wing/room/drawerId", async () => {
    mockCallTool.mockResolvedValue(jsonResult({ success: true, drawer_id: "abc" }));

    const result = await adapter.write({
      bindingKey: "default",
      scope: { companyId: "co-1", projectId: "proj-1", issueId: "iss-1" },
      source,
      content: "test",
    });

    const handle = result.records![0];
    expect(handle.providerRecordId).toBe("project-proj-1/issue-iss-1/abc");
  });

  // ── Scope mapping ──────────────────────────────────────────────────

  it("maps projectId to wing, issueId to room", async () => {
    mockCallTool.mockResolvedValue(jsonResult({ success: true, drawer_id: "d-1" }));

    await adapter.write({
      bindingKey: "default",
      scope: { companyId: "co-1", projectId: "proj-abc", issueId: "iss-xyz" },
      source,
      content: "test",
    });

    const [callArgs] = mockCallTool.mock.calls[0];
    expect(callArgs.arguments.wing).toBe("project-proj-abc");
    expect(callArgs.arguments.room).toBe("issue-iss-xyz");
  });

  it("maps agentId to wing when no projectId", async () => {
    mockCallTool.mockResolvedValue(jsonResult({ success: true, drawer_id: "d-1" }));

    await adapter.write({
      bindingKey: "default",
      scope: { companyId: "co-1", agentId: "agent-abc" },
      source,
      content: "test",
    });

    const [callArgs] = mockCallTool.mock.calls[0];
    expect(callArgs.arguments.wing).toBe("agent-agent-ab");
  });

  it("companyId alone defaults wing to 'general' (process-level isolation)", async () => {
    mockCallTool.mockResolvedValue(jsonResult({ success: true, drawer_id: "d-1" }));

    await adapter.write({
      bindingKey: "default",
      scope: { companyId: "co-1" },
      source,
      content: "test",
    });

    const [callArgs] = mockCallTool.mock.calls[0];
    expect(callArgs.arguments.wing).toBe("general");
  });

  it("runId is passed in source_file provenance, not as room", async () => {
    mockCallTool.mockResolvedValue(jsonResult({ success: true, drawer_id: "d-1" }));

    await adapter.write({
      bindingKey: "default",
      scope: { companyId: "co-1", projectId: "proj-1", runId: "run-abc123" },
      source: { kind: "manual_note", companyId: "co-1", runId: "run-abc123" },
      content: "test",
    });

    const [callArgs] = mockCallTool.mock.calls[0];
    // runId should not map to room
    expect(callArgs.arguments.room).toBe("default");
    // runId should appear in source_file provenance
    expect(callArgs.arguments.source_file).toContain("run:run-abc1");
  });

  it("builds source_file provenance from scope and source", async () => {
    mockCallTool.mockResolvedValue(jsonResult({ success: true, drawer_id: "d-1" }));

    await adapter.write({
      bindingKey: "default",
      scope: { companyId: "co-1", agentId: "agent-x" },
      source: { kind: "issue_comment", companyId: "co-1", issueId: "iss-1" },
      content: "test",
    });

    const [callArgs] = mockCallTool.mock.calls[0];
    const sourceFile = callArgs.arguments.source_file as string;
    expect(sourceFile).toContain("issue_comment");
    expect(sourceFile).toContain("issue:iss-1");
    expect(sourceFile).toContain("agent:agent-x");
  });
});
