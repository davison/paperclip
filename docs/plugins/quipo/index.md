---
title: Quipo (cross-issue memory)
summary: A Paperclip plugin that gives every agent in a company a shared, searchable memory across issues. Architecture, schema, tools, and operations.
---

Quipo gives every agent in a Paperclip company a shared memory that persists across issues, runs, and conversations. It listens to new comments and issue updates, hands them to a configurable Memory Agent for fact extraction, harvests the resulting JSON into a plugin-owned Postgres schema, and exposes five tools so other agents can recall what was learned.

This page is the long-form reference. For the operator quick-start (install, settings, troubleshooting) see the [plugin README](https://github.com/paperclip-ai/paperclip/blob/master/packages/plugins/quipo/README.md). For the per-tool API see the [tool reference](./tools/index.md). For the end-to-end timing of a single comment see the [lifecycle page](./lifecycle.md).

## Architecture

Quipo is a stock Paperclip plugin. It runs in the host plugin worker process, owns its own database namespace, subscribes to two events, and contributes tools and a settings page through the standard manifest.

```text
                ┌────────────────────────────────────────────────┐
                │                Paperclip host                  │
                │                                                │
   user/agent   │   ┌──────────────┐      ┌─────────────────┐   │
   posts ──────►│──►│ issue events │─────►│  Quipo plugin   │   │
   comment      │   │  (built-in)  │      │  (event handler)│   │
                │   └──────────────┘      └────────┬────────┘   │
                │                                  │             │
                │                  creates+assigns │             │
                │                                  ▼             │
                │   ┌──────────────────────────────────────┐    │
                │   │  Quipo-owned issue                   │    │
                │   │  "extract facts from comment on …"   │    │
                │   └──────────────┬───────────────────────┘    │
                │                  │ wake (issues.wakeup)        │
                │                  ▼                              │
                │   ┌──────────────────────────────────────┐    │
                │   │  memory-worker agent run             │    │
                │   │  (any company-configured LLM)        │    │
                │   │  posts ONE JSON comment, marks done  │    │
                │   └──────────────┬───────────────────────┘    │
                │                  │ issue.comment.created       │
                │                  ▼                              │
                │   ┌──────────────────────────────────────┐    │
                │   │  Quipo plugin (harvest path)         │    │
                │   │  parse JSON → INSERT facts           │    │
                │   │              UPSERT sessions.summary  │    │
                │   │              UPSERT peer_models       │    │
                │   └──────────────┬───────────────────────┘    │
                │                  ▼                              │
                │   ┌──────────────────────────────────────┐    │
                │   │  plugin_quipo_d14f4ce0c0.{facts,     │    │
                │   │     sessions, peer_models}           │    │
                │   └──────────────────────────────────────┘    │
                │                  ▲                              │
                │                  │ pg_trgm trigram search       │
                │   ┌──────────────┴───────────────────────┐    │
                │   │  any agent calls memory_search,      │    │
                │   │  memory_get_issue_context, …          │    │
                │   └──────────────────────────────────────┘    │
                └────────────────────────────────────────────────┘
```

Two design properties are worth calling out:

- **The memory-worker never writes the database.** It produces a single structured-JSON comment on the extraction issue. Quipo's event handler harvests that comment and performs all writes. This split keeps the agent surface tiny (a prompt + a JSON schema) and the persistence layer auditable. The agent template's [`AGENTS.md`](https://github.com/paperclip-ai/paperclip/blob/master/packages/plugins/quipo/src/agent-templates/memory-worker/AGENTS.md) reflects this: the worker extracts, the plugin persists.
- **Memory recall is just SQL.** Tools resolve to a `pg_trgm` trigram-similarity scan over `<namespace>.facts` and `<namespace>.sessions.summary`. There is no separate vector store, no embedding cost, and no extra round-trip per recall.

## Storage schema

Quipo derives its namespace from `derivePluginDatabaseNamespace("paperclipai.plugin-quipo", "quipo")`, which resolves to `plugin_quipo_d14f4ce0c0`. All three tables live there.

The DDL is in [`packages/plugins/quipo/migrations/001_init_memory.sql`](https://github.com/paperclip-ai/paperclip/blob/master/packages/plugins/quipo/migrations/001_init_memory.sql).

### `facts`

One row per atomic fact extracted from one source (comment or issue update).

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid | Primary key. |
| `company_id` | uuid | FK → `companies(id)`. Cascades on company delete. |
| `issue_id` | uuid (nullable) | FK → `issues(id)`. Cleared (`SET NULL`) when the source issue is deleted. |
| `agent_id` | uuid (nullable) | FK → `agents(id)`. Set when the fact is _about_ an agent peer (per `about_peer = "agent"`). |
| `content` | text | The atomic statement, rewritten to be self-contained. |
| `level` | text | Extraction level. Default `"explicit"`. |
| `source_ids` | uuid[] | Source comment / update IDs the fact derives from. |
| `metadata` | jsonb | Plugin-controlled fields: `confidence`, `about_peer` (`"agent"` / `"user"` / `null`), `source_kind`, `source_comment_id`, etc. |
| `created_at` | timestamptz | Insert timestamp. |

Indices: `(company_id)`, `(company_id, issue_id)`, `(company_id, agent_id)`, **GIN trigram on `content`** (`gin_trgm_ops`) for fast `similarity()` and `%` matching.

### `sessions`

One row per source issue. The `summary` column is the memory-worker's rolling distillation of the issue's conclusions; Quipo upserts on every harvest so the summary tracks the latest state.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid | Primary key. |
| `company_id` | uuid | FK → `companies(id)`. |
| `issue_id` | uuid | FK → `issues(id)`. **Unique** per issue (`idx_sessions_issue_unique`). |
| `summary` | text | Rolling memory-worker summary. |
| `fact_count` | integer | Cached count of facts on the issue. |
| `updated_at` | timestamptz | Last harvest timestamp. |

There is no GIN index on `summary` in Phase 1 — `memory_search_conclusions` runs `pg_trgm.similarity()` against the table directly. Adding `gin (summary gin_trgm_ops)` is a follow-up migration when corpus size justifies it.

### `peer_models`

One row per (company, agent) pair. Quipo rolls agent-targeted facts up into a textual peer model so callers can ask "what do we know about agent X?" in a single tool call.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid | Primary key. |
| `company_id` | uuid | FK → `companies(id)`. |
| `agent_id` | uuid | FK → `agents(id)`. **Unique** per (company, agent). |
| `model` | text | Rolling peer model summary. |
| `fact_count` | integer | Cached count of facts about the peer. |
| `updated_at` | timestamptz | Last rollup timestamp. |

User peer models are reserved for a future phase — facts may carry `metadata.about_peer = "user"` today, but there is no `peer_models` row for users in Phase 1.

## The five tools

Quipo registers five tools onto `ctx.tools` in [`src/tools/index.ts`](https://github.com/paperclip-ai/paperclip/blob/master/packages/plugins/quipo/src/tools/index.ts). Any agent in the company can call them during a normal run. See the [tool reference](./tools/index.md) for parameters, return shapes, and example payloads.

| Tool | Purpose | When to reach for it |
| --- | --- | --- |
| [`memory_search`](./tools/index.md#memory_search) | Trigram search over `facts.content`. | "What do we know about X?" — the default recall tool. |
| [`memory_search_conclusions`](./tools/index.md#memory_search_conclusions) | Trigram search over `sessions.summary`. | "Have we had this conversation before?" Find _past issues_ whose conclusions match. |
| [`memory_get_issue_context`](./tools/index.md#memory_get_issue_context) | Bundle every fact + session + peer model for one issue. | Resuming a long-lived ticket; pre-loading context for a teammate. |
| [`memory_get_peer_context`](./tools/index.md#memory_get_peer_context) | Peer model + recent facts for one agent. | "Remind me what I know about agent X" before a handoff. |
| [`memory_ask_peer`](./tools/index.md#memory_ask_peer) | Wake another agent with a question. | Active recall — when the answer isn't in memory yet and you need a peer to weigh in. |

`memory_ask_peer` is the only tool that incurs a downstream model cost (it invokes another agent). The other four are pure SQL reads.

## The memory-worker agent

The memory-worker is a stock Paperclip agent created from the template at `@paperclipai/plugin-quipo/agent-templates/memory-worker`. It ships with an `AGENTS.md` ([source](https://github.com/paperclip-ai/paperclip/blob/master/packages/plugins/quipo/src/agent-templates/memory-worker/AGENTS.md)) that defines the contract:

- **Input.** An extraction issue created by Quipo. The issue title and description tell the worker what unit of work to process — usually a single new comment, a single issue update, or a small batch from the backfill action.
- **Output.** A single comment on the extraction issue containing one JSON object matching the schema below — no prose, no commentary. The worker then marks the issue `done`. The plugin watches `issue.comment.created`, parses the JSON, and writes facts. The worker never touches the database.
- **JSON schema.**

  ```json
  {
    "facts": [
      { "content": "<atomic statement>", "about_peer": "agent" | "user" | null, "confidence": 0.0-1.0 }
    ]
  }
  ```

- **`{"facts": []}` is a valid answer.** When the input contains nothing worth remembering (greetings, status pings, "I'll do X next" intentions), an empty list is the correct response.
- **Any model.** The worker runs as a normal Paperclip agent, so the LLM is whatever the company has configured. Models that natively support structured outputs / JSON mode produce the most reliable extractions; Anthropic Claude Haiku 4.5 is the recommended default for cost.

The canonical extraction system prompt, zod schema, and JSON schema are re-exported from `@paperclipai/plugin-quipo/prompts`. The plugin assembles the per-task user prompt from this module and parses the worker's response with the same schema, so the worker template and the harvest path stay in sync.

## Backfill

Quipo's live event handlers only ingest content that arrives _after_ the plugin is enabled. To seed memory from issues that already exist, invoke the **backfill** action.

The action key is `backfill` (constant `QUIPO_BACKFILL_ACTION_KEY`). It is registered in [`src/worker.ts`](https://github.com/paperclip-ai/paperclip/blob/master/packages/plugins/quipo/src/worker.ts) and implemented in [`src/backfill.ts`](https://github.com/paperclip-ai/paperclip/blob/master/packages/plugins/quipo/src/backfill.ts).

```jsonc
// POST /api/companies/{companyId}/plugins/paperclipai.plugin-quipo/actions/backfill
{
  "companyId": "<company-uuid>",   // required
  "projectId": "<project-uuid>",    // optional: scope to one project
  "issueId":   "<issue-uuid>",      // optional: scope to one issue
  "maxIssues": 1000,                 // default 1000, hard cap 10000
  "maxCommentsPerIssue": 200,        // default 200, hard cap 2000
  "dryRun": false                    // default false; true = count only
}
```

The action returns a `BackfillSummary` with: `issuesScanned`, `commentsScanned`, `queued`, `alreadyExtracted`, `memoryAgentAuthoredSkipped`, `pluginOwnedIssuesSkipped`, a `truncated` flag (set when caps were hit), and a sample of created extraction issue IDs.

Backfill semantics:

- **Idempotent on `commentId`.** Each comment has a deterministic origin id (`comment:<commentId>`); re-running the action won't double-extract. Backfilled extraction issues are tagged `sourceKind = "backfill"` so they are visible in logs.
- **Does not require `enabled = true`.** Backfill only needs `memoryAgentId` set. This lets you stage memory before turning live ingestion on.
- **Respects normal skips.** Comments authored by the memory-worker itself, and comments on Quipo-owned issues, are skipped (`memoryAgentAuthoredSkipped` / `pluginOwnedIssuesSkipped` in the summary).

## Configuration & capabilities

The full manifest is in [`src/manifest.ts`](https://github.com/paperclip-ai/paperclip/blob/master/packages/plugins/quipo/src/manifest.ts). Highlights:

- **Plugin id:** `paperclipai.plugin-quipo`. **Display name:** `Quipo`. **API version:** 1.
- **Capabilities requested:** `database.namespace.{migrate,read,write}`, `issues.{read,create,update}`, `issue.comments.read`, `agents.{read,invoke}`, `agent.tools.register`, `events.subscribe`, `plugin.state.{read,write}`, `instance.settings.register`, `metrics.write`, plus `issues.wakeup` (RED-133) for explicitly waking the memory-worker after creating an extraction issue.
- **Database namespace:** slug `quipo`, migrations directory `migrations/`, core read tables `issues`, `issue_comments`, `agents`, `companies`.
- **Per-company config schema** (validated by the host):

  ```ts
  {
    enabled: boolean,            // default false
    memoryAgentId: string,       // UUID of the memory-worker agent
    extractionScope: "comments_and_updates" | "comments_only", // default "comments_and_updates"
  }
  ```

- **UI:** one settings slot, `quipo-settings`, exporting the `QuipoSettingsPage` React component.

## Operations

### Health checks

Quipo's behavior is observable through ordinary Paperclip surfaces. There is no separate dashboard.

- **Extraction issues.** Filter the issue list by issues created by the Quipo plugin and assigned to the memory-worker. A backlog of `todo` extraction issues that aren't transitioning to `done` indicates the worker is wedged or hitting a budget cap.
- **`facts` row count.** A query like `SELECT count(*) FROM plugin_quipo_d14f4ce0c0.facts WHERE company_id = $1` should grow steadily on a healthy company.
- **Plugin state.** Quipo records `parse_error` / `empty` outcomes against extraction issues in plugin state, so a malformed worker response does not silently re-loop. Inspect plugin state per company to see them.

### Cost

> **Subject to change.** Numbers below are from the [RED-125 smoke test](https://paperclip.ai) on Anthropic Claude Haiku 4.5 against a healthy comment stream. Re-measure on your own deployment.

Each new comment or in-scope issue update creates one extraction issue, which produces one Memory Agent run. On Haiku 4.5 a typical extraction is **~$0.02**. There is no embedding cost (recall is trigram-based) and tools incur only ordinary Paperclip token cost when their results are consumed in a calling agent's context.

### Limits and caps

- **Extraction body size:** Quipo refetches the full comment body before queueing extraction (RED-131). The host's plugin event payloads carry only a snippet (first ~120 chars), so the plugin calls `ctx.issues.listComments()` to get the full text. Very long comments are clipped at 8,000 characters before being sent to the worker.
- **Backfill:** hard cap `maxIssues = 10000`, `maxCommentsPerIssue = 2000`. The action returns `truncated: true` when a cap is hit.
- **Memory-worker output:** ≤ 50 facts per response (enforced in the JSON schema). Workers that return more are rejected at parse time.
- **Tool result sizes:**
  - `memory_search`: 1–50 facts per call (default 20).
  - `memory_search_conclusions`: 1–25 sessions per call (default 10).
  - `memory_get_issue_context`, `memory_get_peer_context`: 1–200 facts per call (default 50).

### Failure modes

- **Worker returns prose, not JSON.** The plugin rejects the response and records a `parse_error` outcome in plugin state; the extraction issue is left for inspection. Switch the worker's model to one with native JSON / structured-output mode.
- **Worker returns `{"facts": []}`.** This is a healthy outcome — the input contained nothing worth remembering. The harvest path records an `empty` outcome and closes the extraction issue.
- **Tool dispatch reports `worker is not running` after a disable/enable cycle.** Fixed in RED-132. If you see this on the latest version, restart the host process.
- **Memory-worker auto-wake.** Quipo explicitly wakes the configured memory agent on extraction-issue creation (RED-133). If the worker still doesn't pick up, confirm the agent is enabled and not at its budget cap; look in the agent's run log for `dispatched todo` heartbeats.

### Security

- **Cross-company isolation.** Every read and write enforces `company_id = $1`. Tools resolve `companyId` from the calling agent's run context (`runCtx.companyId`), never from caller-supplied parameters.
- **Cross-namespace isolation.** Quipo only writes its own namespace (`plugin_quipo_d14f4ce0c0`). Core tables (`issues`, `issue_comments`, `agents`, `companies`) are read-only for the plugin.
- **Memory-worker is not privileged.** The worker template explicitly forbids writing to the database, invoking other agents, or creating issues outside its assigned task. The plugin owns persistence; the worker just produces structured JSON.
- **Memory-worker self-skip.** Quipo's event handlers skip comments authored by the memory-worker itself, and comments on plugin-owned issues, so harvesting cannot recursively trigger more extractions.

## Out of scope (Phase 1)

- **Embeddings / vector search.** Recall is trigram-based. Adding an embedding column and an HNSW/IVFFlat index is a future enhancement, not a v0.1.0 feature.
- **User peer models.** `peer_models` is keyed by `agent_id`. Facts can carry `metadata.about_peer = "user"`, but there is no per-user rollup yet.
- **Forgetting / TTL.** There is no automatic decay of old facts. Operators can `DELETE` rows by hand if needed; an explicit retention policy is a future feature.

## See also

- [Plugin README (operator quick-start)](https://github.com/paperclip-ai/paperclip/blob/master/packages/plugins/quipo/README.md)
- [Lifecycle: what happens when a comment is posted](./lifecycle.md)
- [Tool reference](./tools/index.md)
- [Memory architecture (host-level memory adapters)](../../specs/memory-architecture.md) — Quipo is independent of this; the page is included for context on Paperclip's broader memory story.
