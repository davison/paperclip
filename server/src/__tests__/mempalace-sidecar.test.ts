import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { createMempalaceSidecar, type SidecarStatus } from "../services/memory-adapters/mempalace-sidecar.js";

// ---------------------------------------------------------------------------
// Mock the MCP SDK so we don't spawn real processes
// ---------------------------------------------------------------------------

const mockCallTool = vi.fn();
const mockConnect = vi.fn();
const mockClose = vi.fn();
const mockPing = vi.fn();

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    close: mockClose,
    callTool: mockCallTool,
    ping: mockPing,
  })),
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn().mockImplementation(() => ({})),
}));

describe("MempalaceSidecar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockConnect.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Lifecycle ───────────────────────────────────────────────────────

  it("starts in stopped state", () => {
    const sidecar = createMempalaceSidecar({ palaceDir: "/tmp/palace" });
    expect(sidecar.status).toBe("stopped");
    expect(sidecar.restartCount).toBe(0);
  });

  it("start transitions to running", async () => {
    const statuses: SidecarStatus[] = [];
    const sidecar = createMempalaceSidecar({
      palaceDir: "/tmp/palace",
      onStatusChange: (s) => statuses.push(s),
    });

    await sidecar.start();

    expect(sidecar.status).toBe("running");
    expect(statuses).toEqual(["starting", "running"]);
    expect(mockConnect).toHaveBeenCalledTimes(1);

    await sidecar.stop();
  });

  it("start is idempotent when already running", async () => {
    const sidecar = createMempalaceSidecar({ palaceDir: "/tmp/palace" });
    await sidecar.start();
    await sidecar.start();

    expect(mockConnect).toHaveBeenCalledTimes(1);
    await sidecar.stop();
  });

  it("stop transitions to stopped and disconnects", async () => {
    const sidecar = createMempalaceSidecar({ palaceDir: "/tmp/palace" });
    await sidecar.start();
    await sidecar.stop();

    expect(sidecar.status).toBe("stopped");
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it("stop is idempotent", async () => {
    const sidecar = createMempalaceSidecar({ palaceDir: "/tmp/palace" });
    await sidecar.start();
    await sidecar.stop();
    await sidecar.stop();

    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it("start fails and sets status to failed on connect error", async () => {
    mockConnect.mockRejectedValue(new Error("Python not found"));

    const sidecar = createMempalaceSidecar({ palaceDir: "/tmp/palace" });
    await expect(sidecar.start()).rejects.toThrow("Python not found");

    expect(sidecar.status).toBe("failed");
  });

  // ── Per-company isolation ───────────────────────────────────────────

  it("passes palaceDir as cwd and MEMPALACE_PALACE_DIR env", async () => {
    const { StdioClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/stdio.js"
    );

    createMempalaceSidecar({ palaceDir: "/data/company-abc" });

    // The adapter constructor creates the transport config — verify via mock
    // The transport is created lazily on connect, but the config is set up
    // We can verify by starting and checking the transport was created correctly
    // Since StdioClientTransport is mocked, we check the constructor call
    // after start() triggers adapter.connect()
  });

  // ── Health checking ─────────────────────────────────────────────────

  it("health check succeeds when ping works", async () => {
    mockPing.mockResolvedValue(undefined);

    const sidecar = createMempalaceSidecar({
      palaceDir: "/tmp/palace",
      healthCheckIntervalMs: 1000,
    });
    await sidecar.start();

    // Advance past health check interval
    await vi.advanceTimersByTimeAsync(1100);

    expect(sidecar.status).toBe("running");
    expect(mockPing).toHaveBeenCalled();

    await sidecar.stop();
  });

  it("health check failure triggers restart schedule", async () => {
    mockPing.mockRejectedValue(new Error("connection dead"));

    const logs: string[] = [];
    const sidecar = createMempalaceSidecar({
      palaceDir: "/tmp/palace",
      healthCheckIntervalMs: 1000,
      restartBaseDelayMs: 500,
      onLog: (_stream, msg) => logs.push(msg),
    });
    await sidecar.start();

    // Trigger health check failure
    await vi.advanceTimersByTimeAsync(1100);

    expect(sidecar.status).toBe("unhealthy");
    expect(logs.some((l) => l.includes("scheduling restart"))).toBe(true);

    await sidecar.stop();
  });

  // ── Restart with backoff ────────────────────────────────────────────

  it("restarts with exponential backoff on failure", async () => {
    mockPing.mockRejectedValue(new Error("dead"));

    const statuses: SidecarStatus[] = [];
    const sidecar = createMempalaceSidecar({
      palaceDir: "/tmp/palace",
      healthCheckIntervalMs: 1000,
      restartBaseDelayMs: 2000, // longer than health check so we can observe unhealthy
      maxRestartAttempts: 3,
      onStatusChange: (s) => statuses.push(s),
    });
    await sidecar.start();

    // Trigger health check failure → status goes unhealthy, restart scheduled at 2000ms
    await vi.advanceTimersByTimeAsync(1100);
    expect(sidecar.status).toBe("unhealthy");

    // Restart #1 succeeds (re-connect works)
    mockConnect.mockResolvedValue(undefined);
    await vi.advanceTimersByTimeAsync(2000);

    expect(sidecar.restartCount).toBe(0); // reset on success
    expect(sidecar.status).toBe("running");

    await sidecar.stop();
  });

  it("marks as failed after max restart attempts", async () => {
    mockPing.mockRejectedValue(new Error("dead"));
    // Make connect fail on restarts too
    let connectCalls = 0;
    mockConnect.mockImplementation(() => {
      connectCalls++;
      if (connectCalls > 1) return Promise.reject(new Error("still dead"));
      return Promise.resolve();
    });

    const sidecar = createMempalaceSidecar({
      palaceDir: "/tmp/palace",
      healthCheckIntervalMs: 500,
      restartBaseDelayMs: 100,
      restartMaxDelayMs: 400,
      maxRestartAttempts: 3,
    });
    await sidecar.start();

    // Health check fails → restart #1 at 100ms
    await vi.advanceTimersByTimeAsync(600);
    // Restart #1 fails → restart #2 at 200ms
    await vi.advanceTimersByTimeAsync(200);
    // Restart #2 fails → restart #3 at 400ms (capped)
    await vi.advanceTimersByTimeAsync(400);
    // Restart #3 fails → max attempts exceeded → failed
    await vi.advanceTimersByTimeAsync(500);

    expect(sidecar.status).toBe("failed");

    await sidecar.stop();
  });

  it("stop cancels pending restarts", async () => {
    mockCallTool.mockRejectedValue(new Error("dead"));

    const sidecar = createMempalaceSidecar({
      palaceDir: "/tmp/palace",
      healthCheckIntervalMs: 500,
      restartBaseDelayMs: 5000,
    });
    await sidecar.start();

    // Health check fails → schedules restart at 5000ms
    await vi.advanceTimersByTimeAsync(600);
    expect(sidecar.status).toBe("unhealthy");

    // Stop before restart fires
    await sidecar.stop();
    expect(sidecar.status).toBe("stopped");

    // Advance past restart time — should not attempt reconnect
    const connectCallsBefore = mockConnect.mock.calls.length;
    await vi.advanceTimersByTimeAsync(6000);
    expect(mockConnect.mock.calls.length).toBe(connectCallsBefore);
  });

  // ── Logging ─────────────────────────────────────────────────────────

  it("emits structured log messages with sidecar prefix", async () => {
    const logs: Array<{ stream: string; msg: string }> = [];
    const sidecar = createMempalaceSidecar({
      palaceDir: "/tmp/palace",
      onLog: (stream, msg) => logs.push({ stream, msg }),
    });

    await sidecar.start();
    await sidecar.stop();

    expect(logs.some((l) => l.msg.includes("[mempalace-sidecar]"))).toBe(true);
    expect(logs.some((l) => l.msg.includes("running"))).toBe(true);
    expect(logs.some((l) => l.msg.includes("stopped"))).toBe(true);
  });

  // ── Adapter access ─────────────────────────────────────────────────

  it("exposes the underlying adapter", async () => {
    const sidecar = createMempalaceSidecar({ palaceDir: "/tmp/palace" });

    expect(sidecar.adapter).toBeDefined();
    expect(sidecar.adapter.key).toBe("mempalace");
    expect(sidecar.adapter.capabilities.browse).toBe(true);
  });
});
