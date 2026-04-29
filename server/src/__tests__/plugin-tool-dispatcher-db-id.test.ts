import { describe, expect, it } from "vitest";

import {
  createPluginToolDispatcher,
  type PluginToolDispatcher,
} from "../services/plugin-tool-dispatcher.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

// RED-132: regression test for the "tool dispatch worker not running" 502.
//
// Root cause: `pluginLoader.activate()` was calling
// `toolDispatcher.registerPluginTools(pluginKey, manifest)` — passing the
// plugin's namespace key as the only identifier. The registry's optional-arg
// fallback (`pluginDbId ?? pluginId`) then stored the *plugin key* in
// `tool.pluginDbId`. But the worker manager keys workers by the plugin's
// **database UUID** — so `workerManager.isRunning(tool.pluginDbId)` always
// returned `false` and every `executeTool` call hit the "worker not running"
// error.
//
// The fix threads `pluginDbId` through the dispatcher's public API so the
// loader can pass `plugin.id` (the DB UUID) at the call site.

const PLUGIN_KEY = "quipo";
const PLUGIN_DB_ID = "11111111-2222-3333-4444-555555555555";
const TOOL_NAME = "memory_search";
const NAMESPACED_NAME = `${PLUGIN_KEY}:${TOOL_NAME}`;

const MANIFEST = {
  pluginId: PLUGIN_KEY,
  version: "0.1.0",
  apiVersion: "1.0",
  tools: [
    {
      name: TOOL_NAME,
      displayName: "Memory search",
      description: "Search stored facts",
      parametersSchema: { type: "object", properties: {} },
    },
  ],
} as unknown as Parameters<PluginToolDispatcher["registerPluginTools"]>[1];

interface FakeWorkerManager extends Pick<PluginWorkerManager, "isRunning" | "call"> {
  readonly runningKeys: Set<string>;
  readonly calls: Array<{ workerKey: string; method: string }>;
}

function createFakeWorkerManager(runningKeys: string[]): FakeWorkerManager {
  const running = new Set(runningKeys);
  const calls: FakeWorkerManager["calls"] = [];
  return {
    runningKeys: running,
    calls,
    isRunning: (workerKey: string) => running.has(workerKey),
    call: async (workerKey: string, method: string) => {
      calls.push({ workerKey, method });
      return { content: [{ type: "text", text: "ok" }] };
    },
  } as unknown as FakeWorkerManager;
}

describe("PluginToolDispatcher — pluginDbId routing (RED-132)", () => {
  const runContext = {
    agentId: "agent-1",
    runId: "run-1",
    companyId: "co-1",
    projectId: "proj-1",
  };

  it("dispatches executeTool to the worker keyed by the DB UUID when pluginDbId is provided", async () => {
    const workerManager = createFakeWorkerManager([PLUGIN_DB_ID]);
    const dispatcher = createPluginToolDispatcher({
      workerManager: workerManager as unknown as PluginWorkerManager,
    });

    dispatcher.registerPluginTools(PLUGIN_KEY, MANIFEST, PLUGIN_DB_ID);

    const result = await dispatcher.executeTool(NAMESPACED_NAME, {}, runContext);

    expect(result.pluginId).toBe(PLUGIN_KEY);
    expect(result.toolName).toBe(TOOL_NAME);
    expect(workerManager.calls).toHaveLength(1);
    expect(workerManager.calls[0]!.workerKey).toBe(PLUGIN_DB_ID);
    expect(workerManager.calls[0]!.method).toBe("executeTool");
  });

  it("reproduces the prior bug: when pluginDbId is omitted, dispatch fails because the worker is keyed by UUID, not pluginKey", async () => {
    // Simulate the production state where the worker manager only knows
    // about the DB UUID — not the plugin key.
    const workerManager = createFakeWorkerManager([PLUGIN_DB_ID]);
    const dispatcher = createPluginToolDispatcher({
      workerManager: workerManager as unknown as PluginWorkerManager,
    });

    // Bug-shape call: register without the DB UUID. The registry's fallback
    // would use pluginKey as the dispatch identifier — which is exactly what
    // RED-132 was about.
    dispatcher.registerPluginTools(PLUGIN_KEY, MANIFEST);

    await expect(
      dispatcher.executeTool(NAMESPACED_NAME, {}, runContext),
    ).rejects.toThrow(/worker for plugin "quipo" is not running/);

    // Confirm no RPC call was attempted — the early `isRunning` check
    // short-circuits before reaching `workerManager.call`.
    expect(workerManager.calls).toHaveLength(0);
  });

  it("accepts a worker that is registered under the plugin key — backwards-compat path used by tests", async () => {
    // When pluginDbId is omitted (legacy / in-memory test path), the
    // registry falls back to pluginId. This keeps tests that pre-date the
    // RED-132 split working without changes.
    const workerManager = createFakeWorkerManager([PLUGIN_KEY]);
    const dispatcher = createPluginToolDispatcher({
      workerManager: workerManager as unknown as PluginWorkerManager,
    });

    dispatcher.registerPluginTools(PLUGIN_KEY, MANIFEST);

    const result = await dispatcher.executeTool(NAMESPACED_NAME, {}, runContext);

    expect(result.toolName).toBe(TOOL_NAME);
    expect(workerManager.calls[0]!.workerKey).toBe(PLUGIN_KEY);
  });
});
