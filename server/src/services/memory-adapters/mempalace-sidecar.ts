import { createMempalaceMemoryAdapter, type MempalaceAdapterConfig } from "./mempalace.js";
import type { MemoryAdapter } from "@paperclipai/plugin-sdk";

// ---------------------------------------------------------------------------
// Mempalace Sidecar Lifecycle Manager
//
// Wraps the mempalace MCP adapter with production lifecycle concerns:
// - Health checking via MCP ping
// - Crash detection and restart with exponential backoff
// - Per-company palace directory isolation
// - Structured logging for stdout/stderr
// - Clean shutdown
// ---------------------------------------------------------------------------

export type SidecarStatus = "stopped" | "starting" | "running" | "unhealthy" | "failed";

export interface MempalaceSidecarConfig {
  /** Palace data directory — each company should have its own directory. */
  palaceDir: string;
  /** Python command (default: "python"). */
  pythonCommand?: string;
  /** Additional environment variables for the mempalace process. */
  env?: Record<string, string>;
  /** Health check interval in ms (default: 30_000). */
  healthCheckIntervalMs?: number;
  /** Max consecutive restart attempts before marking as failed (default: 5). */
  maxRestartAttempts?: number;
  /** Base delay for restart backoff in ms (default: 1_000). Doubles each attempt. */
  restartBaseDelayMs?: number;
  /** Max restart delay cap in ms (default: 60_000). */
  restartMaxDelayMs?: number;
  /** MCP connection timeout in ms (default: 15_000). */
  connectTimeoutMs?: number;
  /** Per-tool-call timeout in ms (default: 30_000). */
  callTimeoutMs?: number;
  /** Callback for log output from the sidecar process. */
  onLog?: (stream: "stdout" | "stderr", data: string) => void;
  /** Callback when sidecar status changes. */
  onStatusChange?: (status: SidecarStatus, error?: string) => void;
}

export interface MempalaceSidecar {
  /** Start the sidecar and connect the adapter. */
  start(): Promise<void>;
  /** Stop the sidecar gracefully. */
  stop(): Promise<void>;
  /** Current sidecar status. */
  readonly status: SidecarStatus;
  /** Number of times the sidecar has been restarted since last successful start. */
  readonly restartCount: number;
  /** The underlying MemoryAdapter — only usable when status is "running". */
  readonly adapter: MemoryAdapter;
}

export function createMempalaceSidecar(config: MempalaceSidecarConfig): MempalaceSidecar {
  const pythonCommand = config.pythonCommand ?? "python";
  const healthCheckIntervalMs = config.healthCheckIntervalMs ?? 30_000;
  const maxRestartAttempts = config.maxRestartAttempts ?? 5;
  const restartBaseDelayMs = config.restartBaseDelayMs ?? 1_000;
  const restartMaxDelayMs = config.restartMaxDelayMs ?? 60_000;
  const onLog = config.onLog;
  const onStatusChange = config.onStatusChange;

  let _status: SidecarStatus = "stopped";
  let _restartCount = 0;
  let _healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  let _restartTimer: ReturnType<typeof setTimeout> | null = null;
  let _stopping = false;

  // Build adapter config with per-company palace directory
  const adapterConfig: MempalaceAdapterConfig = {
    command: pythonCommand,
    args: ["-m", "mempalace.mcp_server"],
    cwd: config.palaceDir,
    env: {
      ...config.env,
      MEMPALACE_PALACE_PATH: config.palaceDir,
    },
    connectTimeoutMs: config.connectTimeoutMs,
    callTimeoutMs: config.callTimeoutMs,
  };

  const mcpAdapter = createMempalaceMemoryAdapter(adapterConfig);

  function setStatus(status: SidecarStatus, error?: string) {
    if (_status === status) return;
    _status = status;
    onStatusChange?.(status, error);
    if (onLog) {
      onLog("stdout", `[mempalace-sidecar] status → ${status}${error ? `: ${error}` : ""}`);
    }
  }

  // ── Health checking ─────────────────────────────────────────────────

  function startHealthChecks() {
    stopHealthChecks();
    _healthCheckTimer = setInterval(async () => {
      if (_status !== "running" || _stopping) return;
      try {
        // Lightweight MCP protocol-level liveness probe.
        await mcpAdapter.ping();
      } catch {
        if (_stopping) return;
        setStatus("unhealthy");
        scheduleRestart();
      }
    }, healthCheckIntervalMs);
  }

  function stopHealthChecks() {
    if (_healthCheckTimer) {
      clearInterval(_healthCheckTimer);
      _healthCheckTimer = null;
    }
  }

  // ── Restart with exponential backoff ────────────────────────────────

  function scheduleRestart() {
    if (_stopping) return;
    if (_restartCount >= maxRestartAttempts) {
      setStatus("failed", `max restart attempts (${maxRestartAttempts}) exceeded`);
      stopHealthChecks();
      return;
    }

    const delay = Math.min(
      restartBaseDelayMs * Math.pow(2, _restartCount),
      restartMaxDelayMs,
    );
    _restartCount++;

    if (onLog) {
      onLog("stdout", `[mempalace-sidecar] scheduling restart #${_restartCount} in ${delay}ms`);
    }

    _restartTimer = setTimeout(async () => {
      _restartTimer = null;
      if (_stopping) return;

      try {
        // Disconnect existing connection (best-effort)
        try {
          await mcpAdapter.disconnect();
        } catch {
          // ignore
        }

        setStatus("starting");
        await mcpAdapter.connect();
        setStatus("running");
        // Reset restart count on successful reconnection
        _restartCount = 0;
        startHealthChecks();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (onLog) {
          onLog("stderr", `[mempalace-sidecar] restart failed: ${message}`);
        }
        scheduleRestart();
      }
    }, delay);
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  async function start(): Promise<void> {
    if (_status === "running" && mcpAdapter.connected) return;

    _stopping = false;
    _restartCount = 0;
    setStatus("starting");

    try {
      await mcpAdapter.connect();
      setStatus("running");
      startHealthChecks();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus("failed", message);
      throw err;
    }
  }

  async function stop(): Promise<void> {
    _stopping = true;
    stopHealthChecks();

    if (_restartTimer) {
      clearTimeout(_restartTimer);
      _restartTimer = null;
    }

    try {
      await mcpAdapter.disconnect();
    } catch {
      // best-effort
    }

    _restartCount = 0;
    setStatus("stopped");
  }

  return {
    start,
    stop,
    get status() {
      return _status;
    },
    get restartCount() {
      return _restartCount;
    },
    adapter: mcpAdapter,
  };
}
