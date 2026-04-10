#!/usr/bin/env tsx
/**
 * backfill-mempalace — Replay historical agent runs into mempalace.
 *
 * Usage (from repo root):
 *   pnpm --filter @paperclipai/server exec tsx scripts/backfill-mempalace.ts [options]
 *   — or —
 *   pnpm -w run backfill:mempalace -- [options]
 *
 * Inside a container:
 *   pnpm --filter @paperclipai/server exec tsx scripts/backfill-mempalace.ts [options]
 *
 * Options:
 *   --company-id <id>   Filter by company (default: all companies)
 *   --agent-id <id>     Filter by agent (default: all agents)
 *   --since <date>      Only runs after this ISO date (default: all time)
 *   --until <date>      Only runs before this ISO date (default: now)
 *   --dry-run           Preview what would be written without writing
 *   --batch-size <n>    Runs per batch (default: 100)
 *   --capture-depth <d> "summary" or "full" (default: full)
 *
 * Requires:
 *   DATABASE_URL        Postgres connection string
 *   MEMPALACE_URL       Remote mempalace MCP server URL
 *     — or —
 *   MEMPALACE_ENABLED=true (+ optional MEMPALACE_PALACE_DIR, MEMPALACE_PYTHON_COMMAND)
 */

import { and, eq, gte, lte, desc, sql } from "drizzle-orm";
import { createDb } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createMempalaceMemoryAdapter } from "../src/services/memory-adapters/mempalace.js";
import { createMempalaceSidecar } from "../src/services/memory-adapters/mempalace-sidecar.js";
import type { MemoryAdapter, MemoryScope } from "@paperclipai/plugin-sdk";

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined;
}

const flag = (name: string) => process.argv.includes(name);

const companyIdFilter = arg("--company-id");
const agentIdFilter = arg("--agent-id");
const sinceFilter = arg("--since");
const untilFilter = arg("--until");
const dryRun = flag("--dry-run");
const batchSize = parseInt(arg("--batch-size") ?? "100", 10);
const captureDepth = (arg("--capture-depth") ?? "full") as "summary" | "full";

// ---------------------------------------------------------------------------
// Capture content builder (mirrors memory-hooks.ts buildCaptureContent)
// ---------------------------------------------------------------------------

function buildCaptureContent(params: {
  outcome: string;
  agentName?: string;
  taskSummary?: string;
  runId: string;
  issueId?: string;
  resultJson?: Record<string, unknown> | null;
  startedAt?: string;
}, depth: "summary" | "full"): string {
  const lines: string[] = [];

  lines.push(`## Run ${params.outcome}`);
  if (params.agentName) lines.push(`Agent: ${params.agentName}`);
  if (params.taskSummary) lines.push(`Task: ${params.taskSummary}`);
  lines.push(`Run: ${params.runId}`);
  if (params.issueId) lines.push(`Issue: ${params.issueId}`);
  lines.push(`Outcome: ${params.outcome}`);
  lines.push(`Captured: ${params.startedAt ?? new Date().toISOString()} (backfill)`);

  if (depth === "full" && params.resultJson) {
    lines.push("");
    lines.push("### Result");
    const resultStr = JSON.stringify(params.resultJson, null, 2);
    const maxLen = 4000;
    lines.push(resultStr.length > maxLen ? resultStr.slice(0, maxLen) + "\n..." : resultStr);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const mempalaceUrl = process.env.MEMPALACE_URL;
  const mempalaceEnabled = process.env.MEMPALACE_ENABLED === "true";

  if (!mempalaceUrl && !mempalaceEnabled && !dryRun) {
    console.error("Either MEMPALACE_URL or MEMPALACE_ENABLED=true is required (or use --dry-run)");
    process.exit(1);
  }

  const db = createDb(dbUrl);

  // ── Connect to mempalace ───────────────────────────────────────────

  let adapter: MemoryAdapter | null = null;
  let sidecar: ReturnType<typeof createMempalaceSidecar> | null = null;

  if (!dryRun) {
    if (mempalaceUrl) {
      const mcpAdapter = createMempalaceMemoryAdapter({
        url: mempalaceUrl,
        connectTimeoutMs: 15_000,
        callTimeoutMs: 30_000,
      });
      await mcpAdapter.connect();
      adapter = mcpAdapter;
      console.log(`Connected to mempalace at ${mempalaceUrl}`);
    } else {
      const palaceDir = process.env.MEMPALACE_PALACE_DIR ?? process.cwd() + "/.mempalace";
      const pythonCommand = process.env.MEMPALACE_PYTHON_COMMAND ?? "python";
      sidecar = createMempalaceSidecar({ palaceDir, pythonCommand });
      await sidecar.start();
      adapter = sidecar.adapter;
      console.log(`Started local mempalace sidecar at ${palaceDir}`);
    }
  }

  // ── Build agent lookup ─────────────────────────────────────────────

  const allAgents = await db.select({ id: agents.id, name: agents.name, companyId: agents.companyId }).from(agents);
  const agentMap = new Map(allAgents.map((a) => [a.id, a]));

  // ── Load checkpoint (tracks already-backfilled run IDs) ─────────────

  const checkpointPath = join(process.cwd(), ".backfill-mempalace-checkpoint.json");
  const alreadyBackfilled = new Set<string>();
  if (existsSync(checkpointPath)) {
    try {
      const data = JSON.parse(readFileSync(checkpointPath, "utf-8"));
      if (Array.isArray(data.runIds)) {
        for (const id of data.runIds) alreadyBackfilled.add(id);
      }
      console.log(`Loaded checkpoint: ${alreadyBackfilled.size} previously backfilled runs (will skip)`);
    } catch {
      console.warn("Could not parse checkpoint file — starting fresh");
    }
  }

  function saveCheckpoint() {
    writeFileSync(checkpointPath, JSON.stringify({ runIds: [...alreadyBackfilled] }), "utf-8");
  }

  // ── Query runs ─────────────────────────────────────────────────────

  const terminalStatuses = ["succeeded", "failed", "cancelled", "timed_out"];
  const conditions = [sql`${heartbeatRuns.status} IN (${sql.join(terminalStatuses.map(s => sql`${s}`), sql`, `)})`];
  if (companyIdFilter) conditions.push(eq(heartbeatRuns.companyId, companyIdFilter));
  if (agentIdFilter) conditions.push(eq(heartbeatRuns.agentId, agentIdFilter));
  if (sinceFilter) conditions.push(gte(heartbeatRuns.startedAt, new Date(sinceFilter)));
  if (untilFilter) conditions.push(lte(heartbeatRuns.startedAt, new Date(untilFilter)));

  // Count first
  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(heartbeatRuns)
    .where(and(...conditions));
  const totalRuns = Number(countResult[0]?.count ?? 0);

  console.log(`\nFound ${totalRuns} completed runs to backfill${dryRun ? " (dry run)" : ""}`);
  let processed = 0;
  let written = 0;
  let skipped = 0;
  let errors = 0;
  let offset = 0;

  if (totalRuns === 0) {
    console.log("Nothing to do.");
    await cleanup();
    return;
  }

  // ── Process in batches ─────────────────────────────────────────────

  while (offset < totalRuns) {
    const runs = await db
      .select({
        id: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        resultJson: heartbeatRuns.resultJson,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        startedAt: heartbeatRuns.startedAt,
        finishedAt: heartbeatRuns.finishedAt,
        exitCode: heartbeatRuns.exitCode,
      })
      .from(heartbeatRuns)
      .where(and(...conditions))
      .orderBy(desc(heartbeatRuns.startedAt))
      .limit(batchSize)
      .offset(offset);

    for (const run of runs) {
      processed++;

      // Dedup: skip runs already backfilled in a previous invocation
      if (alreadyBackfilled.has(run.id)) {
        skipped++;
        continue;
      }

      const agent = agentMap.get(run.agentId);
      const ctx = (run.contextSnapshot ?? {}) as Record<string, unknown>;
      const issueId = (ctx.issueId as string) ?? (ctx.taskId as string) ?? undefined;
      const taskKey = (ctx.taskKey as string) ?? undefined;

      // Use the actual run status as the outcome
      const outcome = run.status;

      // Try to get task summary from issue title
      let taskSummary = taskKey;
      if (issueId && !taskSummary) {
        try {
          const issue = await db
            .select({ title: issues.title })
            .from(issues)
            .where(eq(issues.id, issueId))
            .then((rows) => rows[0]);
          if (issue) taskSummary = issue.title;
        } catch {
          // issue may have been deleted
        }
      }

      const content = buildCaptureContent({
        outcome,
        agentName: agent?.name,
        taskSummary,
        runId: run.id,
        issueId,
        resultJson: captureDepth === "full" ? run.resultJson : null,
        startedAt: run.startedAt?.toISOString(),
      }, captureDepth);

      if (dryRun) {
        console.log(`[${processed}/${totalRuns}] would write run ${run.id} (${outcome}, agent=${agent?.name ?? run.agentId}, task=${taskSummary ?? "unknown"})`);
        written++;
        continue;
      }

      // Skip runs with no meaningful content
      if (!run.resultJson && captureDepth === "full") {
        skipped++;
        continue;
      }

      const scope: MemoryScope = {
        companyId: run.companyId,
        agentId: run.agentId,
        issueId,
        runId: run.id,
      };

      try {
        await adapter!.write({
          bindingKey: "backfill",
          scope,
          source: {
            kind: "run",
            companyId: run.companyId,
            runId: run.id,
            issueId,
          },
          content,
          mode: "append",
        });

        alreadyBackfilled.add(run.id);
        written++;

        // Save checkpoint every 10 writes so progress survives interruption
        if (written % 10 === 0) {
          saveCheckpoint();
          console.log(`[${processed}/${totalRuns}] ${written} written, ${skipped} skipped, ${errors} errors`);
        }
      } catch (err) {
        errors++;
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[${processed}/${totalRuns}] error writing run ${run.id}: ${msg}`);
      }
    }

    offset += batchSize;
  }

  // Final checkpoint save
  if (written > 0 && !dryRun) {
    saveCheckpoint();
  }

  console.log(`\nBackfill complete:`);
  console.log(`  Processed: ${processed}`);
  console.log(`  Written:   ${written}`);
  console.log(`  Skipped:   ${skipped}`);
  console.log(`  Errors:    ${errors}`);
  if (!dryRun) {
    console.log(`  Checkpoint: ${checkpointPath}`);
  }

  await cleanup();

  async function cleanup() {
    if (sidecar) {
      await sidecar.stop();
    }
    process.exit(errors > 0 ? 1 : 0);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
