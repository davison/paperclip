---
title: Quipo tool reference
summary: The five Quipo memory tools — parameters, return shape, when to use them, and runnable example payloads.
---

Quipo registers five tools onto every agent's tool surface in companies where the plugin is enabled. They are declared in [`src/manifest.ts`](https://github.com/paperclip-ai/paperclip/blob/master/packages/plugins/quipo/src/manifest.ts) and wired in [`src/tools/index.ts`](https://github.com/paperclip-ai/paperclip/blob/master/packages/plugins/quipo/src/tools/index.ts).

| Tool | Read or write | Calls another agent | Cost |
| --- | --- | --- | --- |
| [`memory_search`](#memory_search) | read (SQL) | no | free |
| [`memory_search_conclusions`](#memory_search_conclusions) | read (SQL) | no | free |
| [`memory_get_issue_context`](#memory_get_issue_context) | read (SQL) | no | free |
| [`memory_get_peer_context`](#memory_get_peer_context) | read (SQL) | no | free |
| [`memory_ask_peer`](#memory_ask_peer) | invoke | yes (any agent in the company) | one downstream agent run |

All tools resolve `companyId` from the calling agent's run context, never from caller-supplied parameters. There is no way for an agent in company A to read memory from company B.

Every tool returns the standard Paperclip `ToolResult` shape:

```ts
type ToolResult =
  | { content: string; data?: unknown }
  | { error: string };
```

The `content` field is a compact markdown string the calling agent can render directly. The `data` field is the structured payload (typed below).

---

## `memory_search`

Trigram-search the Quipo fact store for facts matching a free-form query. The host runs `pg_trgm.similarity()` over `facts.content` and returns ranked candidates; the calling agent reranks them in its own LLM context if needed.

**Source:** [`src/tools/memory-search.ts`](https://github.com/paperclip-ai/paperclip/blob/master/packages/plugins/quipo/src/tools/memory-search.ts).

### Parameters

| Field | Type | Required | Default | Range / notes |
| --- | --- | --- | --- | --- |
| `query` | string | ✅ | — | 1–500 chars. Free-form; the host runs trigram similarity over fact bodies. |
| `limit` | integer | | `20` | 1–50. |
| `min_similarity` | number | | `0.1` | 0.0–1.0. Lower returns more (noisier) candidates. |
| `about_peer` | `"agent"` \| `"user"` \| `null` | | _unset_ | Filter to facts about a specific peer kind, or `null` for general facts only. |
| `issue_id` | UUID | | _unset_ | Restrict to facts captured from one issue. |
| `agent_id` | UUID | | _unset_ | Restrict to facts whose target peer is this agent. |

### Returns

```ts
{
  content: string,      // markdown table, ranked
  data: {
    query: string,
    limit: number,
    min_similarity: number,
    facts: Array<{
      id: string,
      content: string,
      about_peer: "agent" | "user" | null,
      confidence: number,
      level: string,
      issue_id: string | null,
      agent_id: string | null,
      metadata: Record<string, unknown>,
      created_at: string,   // ISO timestamp
      similarity: number,    // 0..1, ranking score
    }>
  }
}
```

When no facts match, `content` is a short "no facts matched … try a broader query" hint and `data.facts` is `[]`.

### When to use

- "What do we know about X?" — the default recall tool.
- Pre-loading context at the top of a heartbeat before deciding what to do.
- Reranking: ask for `limit: 50, min_similarity: 0.05`, then let your own model pick the top-k by relevance to the current task.

### When _not_ to use

- You already know the issue id you care about — use [`memory_get_issue_context`](#memory_get_issue_context) for a complete bundle, not a similarity scan.
- You want decisions rather than facts — use [`memory_search_conclusions`](#memory_search_conclusions).
- The fact you need was created within this same heartbeat — Quipo writes synchronously, but if you posted the comment seconds ago the worker may not have run yet.

### Example

```jsonc
// request
{
  "tool": "memory_search",
  "params": {
    "query": "prompt injection in user-supplied content",
    "limit": 5,
    "min_similarity": 0.15
  }
}

// response
{
  "content": "Top 3 facts for \"prompt injection in user-supplied content\" (ranked by trigram similarity; rerank in your own context as needed):\n1. [sim=0.42 conf=0.90 general] The memory-worker extraction prompt instructs the model to skip text that looks like a secret or credential, but this is a best-effort instruction — there is no runtime filter enforcing it.\n2. [sim=0.31 conf=0.80 agent] Memory-worker rewrites pronouns into peer names before persisting.\n3. [sim=0.18 conf=0.70 general] Plugin-owned issues are excluded from extraction to avoid recursive harvesting.",
  "data": {
    "query": "prompt injection in user-supplied content",
    "limit": 5,
    "min_similarity": 0.15,
    "facts": [
      {
        "id": "8f2d3b1a-1234-4abc-9def-0123456789ab",
        "content": "The memory-worker extraction prompt instructs the model to skip text that looks like a secret or credential, but this is a best-effort instruction — there is no runtime filter enforcing it.",
        "about_peer": null,
        "confidence": 0.9,
        "level": "explicit",
        "issue_id": "11111111-2222-3333-4444-555555555555",
        "agent_id": null,
        "metadata": { "source_kind": "comment", "source_comment_id": "…" },
        "created_at": "2026-04-28T16:42:18.001Z",
        "similarity": 0.4234
      }
    ]
  }
}
```

---

## `memory_search_conclusions`

Search the rolling issue-level conclusion summaries (the `sessions.summary` column) for issues whose conclusions match a query. Useful when you want to find _past issues_, not individual facts.

**Source:** [`src/tools/memory-search-conclusions.ts`](https://github.com/paperclip-ai/paperclip/blob/master/packages/plugins/quipo/src/tools/memory-search-conclusions.ts).

### Parameters

| Field | Type | Required | Default | Range / notes |
| --- | --- | --- | --- | --- |
| `query` | string | ✅ | — | 1–500 chars. |
| `limit` | integer | | `10` | 1–25. |
| `min_similarity` | number | | `0.1` | 0.0–1.0. |

### Returns

```ts
{
  content: string,
  data: {
    query: string,
    limit: number,
    min_similarity: number,
    sessions: Array<{
      id: string,
      issue_id: string,
      summary: string,
      fact_count: number,
      updated_at: string,
      similarity: number,
    }>
  }
}
```

### When to use

- "Have we had this conversation before?" — find similar past issues by their conclusions.
- Designing a new issue — pull two or three sessions whose conclusions overlap with the new problem.

### When _not_ to use

- You want individual facts — use [`memory_search`](#memory_search) instead.
- You already know the issue id — use [`memory_get_issue_context`](#memory_get_issue_context).

### Example

```jsonc
// request
{
  "tool": "memory_search_conclusions",
  "params": { "query": "how we handled the worker not running 502", "limit": 3 }
}

// response
{
  "content": "Top 1 session for \"how we handled the worker not running 502\":\n1. [sim=0.36] RED-132 — root caused to workerManager.isRunning false-negative after disable/enable; rebuilt worker manager state on next register.",
  "data": {
    "query": "how we handled the worker not running 502",
    "limit": 3,
    "min_similarity": 0.1,
    "sessions": [
      {
        "id": "f00ba700-1111-2222-3333-444444444444",
        "issue_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        "summary": "RED-132 — root caused to workerManager.isRunning false-negative after disable/enable; rebuilt worker manager state on next register.",
        "fact_count": 4,
        "updated_at": "2026-04-29T08:14:11.501Z",
        "similarity": 0.3567
      }
    ]
  }
}
```

---

## `memory_get_issue_context`

Bundle every fact, the rolling session summary, and peer models for one issue. Useful for resuming a long-lived ticket — "remind me what was decided here."

**Source:** [`src/tools/memory-get-issue-context.ts`](https://github.com/paperclip-ai/paperclip/blob/master/packages/plugins/quipo/src/tools/memory-get-issue-context.ts).

### Parameters

| Field | Type | Required | Default | Range / notes |
| --- | --- | --- | --- | --- |
| `issue_id` | UUID | ✅ | — | The issue to fetch memory for. |
| `include_peer_models` | boolean | | `true` | Include peer-model summaries for every agent that has facts on this issue. |
| `fact_limit` | integer | | `50` | 1–200. Newest first. |

### Returns

```ts
{
  content: string,
  data: {
    issue_id: string,
    facts: Array<FactRow>,           // same shape as memory_search facts (no `similarity` field)
    session: {
      id: string,
      issue_id: string,
      summary: string | null,
      fact_count: number,
      updated_at: string,
    } | null,
    peer_models: Array<{
      id: string,
      agent_id: string,
      model: string | null,
      fact_count: number,
      updated_at: string,
    }>
  }
}
```

`session` is `null` if no session has been written for the issue yet. `peer_models` is `[]` when `include_peer_models: false` or when no agent peers have appeared on the issue.

### When to use

- Top of a heartbeat on a long-lived issue — pre-load every fact + the rolling summary in one call.
- Onboarding a new agent into an existing thread.
- Building "what we know about issue X" overview sections in a comment.

### When _not_ to use

- You don't have the issue id — use [`memory_search`](#memory_search) or [`memory_search_conclusions`](#memory_search_conclusions) first.
- You only care about facts about one peer — use [`memory_get_peer_context`](#memory_get_peer_context) for fewer rows.

### Example

```jsonc
// request
{
  "tool": "memory_get_issue_context",
  "params": {
    "issue_id": "11111111-2222-3333-4444-555555555555",
    "fact_limit": 20
  }
}

// response (truncated for brevity)
{
  "content": "Issue 11111111… — 12 facts, session: \"Pinned harvest path on issue.comment.created authored by memoryAgentId\". 1 agent peer.",
  "data": {
    "issue_id": "11111111-2222-3333-4444-555555555555",
    "facts": [
      {
        "id": "…",
        "content": "Quipo's onMemoryWorkerComment fires only on plugin-owned issues.",
        "about_peer": null,
        "confidence": 0.9,
        "issue_id": "11111111-2222-3333-4444-555555555555",
        "agent_id": null,
        "created_at": "2026-04-28T19:00:00.000Z"
      }
    ],
    "session": {
      "id": "…",
      "issue_id": "11111111-2222-3333-4444-555555555555",
      "summary": "Pinned harvest path on issue.comment.created authored by memoryAgentId.",
      "fact_count": 12,
      "updated_at": "2026-04-28T19:01:14.500Z"
    },
    "peer_models": [
      {
        "id": "…",
        "agent_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        "model": "Memory-worker — extracts atomic facts; never writes the database directly.",
        "fact_count": 27,
        "updated_at": "2026-04-28T19:01:14.500Z"
      }
    ]
  }
}
```

---

## `memory_get_peer_context`

Fetch the peer model + recent facts for one agent peer. Phase 1 supports agent peers; user peers return facts but no peer model.

**Source:** [`src/tools/memory-get-peer-context.ts`](https://github.com/paperclip-ai/paperclip/blob/master/packages/plugins/quipo/src/tools/memory-get-peer-context.ts).

### Parameters

| Field | Type | Required | Default | Range / notes |
| --- | --- | --- | --- | --- |
| `agent_id` | UUID | one of these | — | Set this for an agent peer. |
| `user_id` | UUID | one of these | — | Set this for a human user peer. Phase 1 returns facts but `peer_model: null`. |
| `fact_limit` | integer | | `50` | 1–200. |

Exactly one of `agent_id` or `user_id` must be set. The tool errors if both or neither are provided.

### Returns

```ts
{
  content: string,
  data: {
    agent_id: string | null,
    user_id: string | null,
    facts: Array<FactRow>,
    peer_model: {
      id: string,
      agent_id: string,
      model: string | null,
      fact_count: number,
      updated_at: string,
    } | null     // null for user peers in Phase 1
  }
}
```

### When to use

- Before delegating to another agent — pull their peer model and the most recent facts about them.
- "What do I know about agent X?" before a handoff or PR review.

### When _not_ to use

- The peer is a human user — Phase 1 has no user-side peer model, so the response will only include facts. Consider `memory_search` with `about_peer: "user"` instead, which surfaces user-targeted facts across the company.

### Example

```jsonc
// request
{
  "tool": "memory_get_peer_context",
  "params": {
    "agent_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    "fact_limit": 10
  }
}

// response
{
  "content": "Peer aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee — 27 facts. Model: \"Memory-worker — extracts atomic facts; never writes the database directly.\"",
  "data": {
    "agent_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    "user_id": null,
    "facts": [ /* up to 10 FactRow */ ],
    "peer_model": {
      "id": "…",
      "agent_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      "model": "Memory-worker — extracts atomic facts; never writes the database directly.",
      "fact_count": 27,
      "updated_at": "2026-04-28T19:01:14.500Z"
    }
  }
}
```

---

## `memory_ask_peer`

Wake another agent in the same company and ask them a question. Fire-and-forget — the tool returns the queued run id, and the peer answers asynchronously by posting comments / state changes on whatever issue you queued the run against.

**Source:** [`src/tools/memory-ask-peer.ts`](https://github.com/paperclip-ai/paperclip/blob/master/packages/plugins/quipo/src/tools/memory-ask-peer.ts).

### Parameters

| Field | Type | Required | Default | Range / notes |
| --- | --- | --- | --- | --- |
| `agent_id` | UUID | ✅ for Phase 1 | — | The agent peer to ask. |
| `user_id` | UUID | | — | **Reserved.** Phase 1 does not support asking human users; the schema reserves the field so adding it later doesn't change the contract. |
| `question` | string | ✅ | — | 1–4000 chars. Sent verbatim to the peer. |
| `context` | string | | _unset_ | ≤ 4000 chars. Optional supporting context appended before the question. |
| `reason` | string | | _unset_ | ≤ 200 chars. Recorded on the wake event for audit trails. |

### Returns

```ts
{
  content: string,    // "Asked agent <id>; run <runId> queued."
  data: {
    runId: string     // the new run id created against the destination agent
  }
}
```

### When to use

- The answer isn't in memory yet and you need a peer to weigh in.
- Active recall after a [`memory_search`](#memory_search) miss — "I couldn't find it; let me ask the person who'd know."
- Cross-agent escalations where you want a structured paper trail (every ask-peer creates a normal Paperclip run with full audit history).

### When _not_ to use

- The answer is already in memory — call `memory_search` or `memory_get_peer_context` first; ask-peer costs a downstream agent run.
- You need a synchronous reply within the current heartbeat — the peer answers async. Either await the run id externally or design the workflow around the peer posting back to the originating issue.
- The peer is a human user — not supported in Phase 1.

### Example

```jsonc
// request
{
  "tool": "memory_ask_peer",
  "params": {
    "agent_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    "question": "What's the safest way to disable the harvest path during a migration?",
    "context": "I'm rolling 0011_*.sql and want to be sure no harvest writes happen mid-flight.",
    "reason": "QA is cutting a migration window for RED-130 follow-up."
  }
}

// response
{
  "content": "Asked agent aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee; run 7c4b2f01-… queued.",
  "data": { "runId": "7c4b2f01-1234-5678-9abc-def012345678" }
}
```

---

## See also

- [Quipo overview](../index.md)
- [Lifecycle of a Quipo extraction](../lifecycle.md)
- [Plugin README](https://github.com/paperclip-ai/paperclip/blob/master/packages/plugins/quipo/README.md)
