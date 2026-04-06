/**
 * Plugin heartbeat context enrichment dispatcher.
 *
 * Iterates all running plugin workers that support the `enrichHeartbeatContext`
 * method, calls them in parallel with a timeout, and merges results into a
 * single record keyed by plugin ID.
 *
 * If no plugins support enrichment (the common case today), this is a no-op
 * that returns an empty object.
 */

import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import { logger } from "../middleware/logger.js";

const log = logger.child({ service: "plugin-heartbeat-enricher" });

/** Timeout per plugin enrichment call (ms). */
const ENRICHMENT_TIMEOUT_MS = 3_000;

export interface HeartbeatEnrichmentInput {
  issueId: string;
  companyId: string;
  projectId: string | null;
  assigneeAgentId: string | null;
}

/**
 * Collect heartbeat context enrichments from all ready plugins.
 *
 * Returns a record keyed by plugin ID, where each value is the plugin's
 * contributed data. Plugins that fail or time out are silently skipped
 * (logged at warn level) so one misbehaving plugin cannot block heartbeat
 * context assembly.
 */
export async function collectHeartbeatEnrichments(
  workerManager: PluginWorkerManager,
  input: HeartbeatEnrichmentInput,
): Promise<Record<string, Record<string, unknown>>> {
  const diags = workerManager.diagnostics();
  const enrichers: { pluginId: string }[] = [];

  for (const diag of diags) {
    if (diag.status !== "running") continue;
    const handle = workerManager.getWorker(diag.pluginId);
    if (!handle) continue;
    if (handle.supportedMethods.includes("enrichHeartbeatContext")) {
      enrichers.push({ pluginId: diag.pluginId });
    }
  }

  if (enrichers.length === 0) return {};

  const results: Record<string, Record<string, unknown>> = {};

  await Promise.all(
    enrichers.map(async ({ pluginId }) => {
      try {
        const result = await workerManager.call(
          pluginId,
          "enrichHeartbeatContext",
          {
            issueId: input.issueId,
            companyId: input.companyId,
            projectId: input.projectId,
            assigneeAgentId: input.assigneeAgentId,
          },
          ENRICHMENT_TIMEOUT_MS,
        );
        if (result.data && Object.keys(result.data).length > 0) {
          results[pluginId] = result.data;
        }
      } catch (err) {
        log.warn(
          { pluginId, err },
          "plugin heartbeat enrichment failed, skipping",
        );
      }
    }),
  );

  return results;
}
