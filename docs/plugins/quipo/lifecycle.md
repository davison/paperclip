---
title: Lifecycle of a Quipo extraction
summary: Step-by-step trace of what happens between a user posting a comment and Quipo's tools returning a fact.
---

This page traces a single comment from the moment it lands in Paperclip to the moment it's recallable through `memory_search`. Each step is independently observable, so this doubles as a debugging checklist when "I posted a comment, no facts persisted."

For a higher-level overview see the [Quipo overview](./index.md).

## Actors

- **Paperclip host** — emits issue events, runs agents, owns the issue thread.
- **Quipo plugin runtime** — registers event handlers, creates extraction issues, harvests JSON comments, writes the database.
- **Memory-worker agent** — a normal company agent created from the Quipo template. Reads the extraction issue, returns one JSON comment.
- **Calling agent** — any agent in the company that uses `memory_search` and friends.

## Step 1 — A comment is created

A user (or another agent) posts a comment on issue `ISSUE-A`. The Paperclip host:

1. Persists the comment row to the core `issue_comments` table.
2. Emits `issue.comment.created` to all registered plugin event handlers, with a small payload: `{ commentId, sourceIssueId, authorAgentId, bodySnippet }`. The snippet is capped at ~120 characters.

Observable at: the host's event log, and the `issue_comments` row itself.

## Step 2 — Quipo's event handler fires

Quipo's `onIssueCommentCreated` handler ([`src/event-handlers.ts`](https://github.com/paperclip-ai/paperclip/blob/master/packages/plugins/quipo/src/event-handlers.ts)) runs synchronously inside the plugin worker. It performs three checks before doing any work:

1. **Plugin enabled?** Reads the per-company config; bails if `enabled` is false.
2. **Memory agent configured?** Bails if `memoryAgentId` is unset.
3. **Skip self-authored / plugin-owned issues.** If the comment was authored by the configured memory agent, or the source issue is itself a Quipo-owned extraction issue, the handler exits silently. This prevents recursive extraction.

If all three pass, the handler proceeds.

Observable at: Quipo records its decisions on each event in plugin state. Comments that are skipped (`memoryAgentAuthoredSkipped`, `pluginOwnedIssuesSkipped`) are visible in the backfill summary and in plugin state per company.

## Step 3 — Refetch the full comment body

The event payload only carries a snippet. Quipo calls `ctx.issues.listComments()` against `sourceIssueId` and locates the row by `commentId` to get the full body (RED-131). This avoids the failure mode where a 120- or 240-character snippet truncated mid-sentence and starved the extraction prompt.

Comments larger than 8,000 characters are clipped before being passed to the worker.

Observable at: the host's plugin worker log; one core API call per fired event.

## Step 4 — Enqueue an extraction issue

The handler computes a deterministic origin id (`comment:<commentId>`), acquires an in-process lock keyed on that origin id, and checks idempotency:

1. **In-process lock.** Prevents two concurrent events for the same comment from racing.
2. **Plugin-state lookup.** If `originId → extractionIssueId` is already recorded, the handler exits — the comment was already enqueued (e.g. on a duplicate event delivery).
3. **DB fallback lookup.** Belt-and-braces check that no extraction issue already exists for this origin id.

If the comment is genuinely new, Quipo creates a new issue with:

- **Title:** `Quipo: extract facts from comment on <source-issue-identifier>`.
- **Body:** the (clipped) comment, the source issue id, the author agent id, and any peer hint.
- **Assignee:** the configured `memoryAgentId`.
- **Owner:** marked as a Quipo-owned issue so the self-skip rule in Step 2 applies on its own future comments.

Quipo then calls `ctx.agents.wakeup()` (RED-133, requires the `issues.wakeup` capability) to wake the memory-worker explicitly — without this, the worker would only pick the issue up on its next routine heartbeat.

Issue updates (`issue.updated`) follow the same flow but only fire when the patch contains `title` or `description` changes, are gated on the `extractionScope` config, and use `(sourceIssueId, updatedAt)` as the idempotency key instead of `commentId`.

Observable at: the company's issue list (`Quipo: extract facts from …` titles), the `issue_comments` and `issues` tables, and the agent's wake-up log.

## Step 5 — The memory-worker runs

The host wakes the memory-worker as a normal Paperclip agent run. The agent sees one assigned, in-progress issue. Following its [`AGENTS.md`](https://github.com/paperclip-ai/paperclip/blob/master/packages/plugins/quipo/src/agent-templates/memory-worker/AGENTS.md):

1. Reads the issue title and body.
2. Calls its configured LLM with the canonical extraction prompt and the JSON schema (re-exported from `@paperclipai/plugin-quipo/prompts`). Most workers run this in JSON / structured-output mode.
3. Posts **one comment** on the extraction issue containing **only** the JSON object — no prose, no commentary:

   ```json
   {
     "facts": [
       { "content": "Paperclip uses pg_trgm for memory recall.", "about_peer": null, "confidence": 0.9 },
       { "content": "Memory-worker agent runs on Haiku 4.5.", "about_peer": "agent", "confidence": 0.8 }
     ]
   }
   ```

4. Marks the extraction issue `done` once the comment is posted.

If the input contains nothing worth remembering, the worker returns `{"facts": []}` and closes the issue. That is a valid, healthy outcome.

The worker never writes the database, never invokes other agents, and never creates issues. The plugin owns persistence.

Observable at: the agent's run log, the comment thread on the extraction issue, and the run's cost / token counters.

## Step 6 — Quipo harvests the JSON comment

The worker's comment fires another `issue.comment.created` event. This time Quipo's `onMemoryWorkerComment` handler matches:

- **Author** = the configured `memoryAgentId`.
- **Issue** = a Quipo-owned extraction issue.

The handler then runs `harvestExtraction(ctx, …)` ([RED-130](https://github.com/paperclip-ai/paperclip/commit/432e9c37) introduced this loop):

1. Refetches the full comment body via `listComments()` (the event delivers a snippet).
2. Validates the JSON against the canonical `extractedFactsResponseSchema`. Bad JSON → record a `parse_error` outcome against this extraction issue and return without writing. The issue is _not_ retried automatically; it stays for human inspection.
3. For each fact in the response: `INSERT` one row into `plugin_quipo_d14f4ce0c0.facts` with the source comment id, source issue id, author agent id, and the worker's confidence / about_peer in `metadata`.
4. `UPSERT` the `sessions` row for `sourceIssueId`, replacing `summary` and incrementing `fact_count`.
5. For every fact whose `about_peer == "agent"`, roll up into `peer_models` for that `agent_id`: append the fact to the rolling model and bump `fact_count`.
6. `PATCH` the extraction issue to `done` (requires the `issues.update` capability).

Harvest is idempotent on `commentId`. If the worker's comment is delivered twice (or the harvest handler fires twice), the second invocation sees the origin id already recorded and exits without writing.

Empty responses (`{"facts": []}`) skip the inserts but still UPSERT a session row (with `fact_count = 0`) and record an `empty` outcome.

Observable at: SQL counts on `plugin_quipo_d14f4ce0c0.{facts,sessions,peer_models}`, the host's plugin worker log, and the extraction issue itself transitioning to `done`.

## Step 7 — Memory is recallable

Any agent in the same company can now call any of the five tools:

```jsonc
// inside any agent's run
{
  "tool": "memory_search",
  "params": { "query": "trigram memory recall" }
}
```

Quipo's tool implementation runs:

```sql
SELECT id, content, about_peer, confidence, level, issue_id, agent_id,
       metadata, created_at,
       similarity(content, $query) AS sim
FROM plugin_quipo_d14f4ce0c0.facts
WHERE company_id = $caller_company_id
  AND similarity(content, $query) >= $min_similarity
ORDER BY sim DESC, created_at DESC
LIMIT $limit;
```

The trigram GIN index on `content` (`gin_trgm_ops`) means this is a fast index scan even at scale. The fact inserted in Step 6 will surface here immediately — there is no async indexer.

Observable at: the calling agent's tool-call log, and the SQL itself if you tail the host's database log.

## End-to-end timing

> **Subject to change.** Figures from the [RED-125 smoke test](https://paperclip.ai) on Anthropic Claude Haiku 4.5; re-measure on your own deployment.

| Step | Typical duration |
| --- | --- |
| Step 1 — comment created → event emitted | < 50 ms |
| Step 2–4 — Quipo enqueues extraction issue + wakes worker | < 200 ms |
| Step 5 — memory-worker LLM call | 1–5 s on Haiku 4.5; varies with comment length |
| Step 6 — harvest path (parse + 3 SQL writes) | < 100 ms |
| **Total comment → searchable** | **~1.5–6 s** under nominal load |

If your end-to-end time is much higher, the most common cause is the worker run being queued behind other agent work — Paperclip schedules agents per-company, so a busy memory-worker may sit in `todo` until the host gets to it. Bumping the agent's priority or running it on a dedicated adapter typically fixes this.

## Failure-mode map

| Symptom | Where it lives | What to do |
| --- | --- | --- |
| No extraction issues created | Step 2 / 4 | Check `enabled`, `memoryAgentId`. Inspect plugin state for skip reasons. |
| Extraction issue created but worker never runs | Step 4 / 5 | Check the worker is enabled, not over budget, and not paused. Toggle Quipo `enabled` off and on to re-register handlers (RED-132 fix). |
| Worker comment is prose, not JSON | Step 5 | Switch the worker's model to one with native JSON / structured-output mode. |
| Worker JSON exists but no `facts` rows | Step 6 | Inspect plugin state for `parse_error` or schema-mismatch records. Check the host plugin-worker log for the harvest exception. |
| `memory_search` returns nothing | Step 7 | Confirm `facts` rows exist for the right `company_id`. Lower `min_similarity` (default 0.1). Try `memory_get_issue_context` for an exact-issue scope. |

See the [README troubleshooting section](https://github.com/paperclip-ai/paperclip/blob/master/packages/plugins/quipo/README.md#troubleshooting) for a flatter walkthrough.
