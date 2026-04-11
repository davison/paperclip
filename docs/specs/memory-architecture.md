# Memory Architecture

This document describes the memory adapter framework, its security model, and lifecycle integration. It covers the upstream control plane (server + Postgres), the local adapter layer (storage providers), and the hook system that drives automatic memory operations.

## Overview

Paperclip's memory system is a two-layer architecture:

1. **Upstream (control plane)** — the Paperclip server owns bindings, scope construction, provenance, lifecycle hooks, and operation logging. All memory requests are mediated by the server; agents never interact with adapters directly.
2. **Local (adapter layer)** — storage providers implement the `MemoryAdapter` interface (`write`, `query`, `get`, `forget`) and declare optional capabilities via `MemoryAdapterCapabilities`. Adapters own indexing, retrieval, and persistence in their own storage backend.

The built-in PARA adapter uses the local filesystem. The mempalace adapter demonstrates integration with an external MCP-based service. Third-party adapters can implement the same interface to provide alternative storage backends.

## Lifecycle Hooks

Memory operations are driven by **lifecycle hooks** attached to **memory bindings**. Two hooks exist:

| Hook | Trigger | Purpose |
|------|---------|---------|
| `preRunHydrate` | Before an agent run | Query memory for relevant context and inject it into the run |
| `postRunCapture` | After an agent run completes | Write a summary of the run into memory for future recall |

### Hook activation

Hooks are **system-initiated when configured and enabled**, not universally mandatory. Each hook has an `enabled: boolean` field in the binding config. When a binding exists but a hook is disabled or absent, the system skips it with no side effects:

- `preRunHydrate` — bindings are filtered to those with `hooks.preRunHydrate?.enabled === true`; if none match, hydration returns zero snippets and the run proceeds without injected memory context (`memory-hooks.ts:177-183`).
- `postRunCapture` — bindings are filtered to those with `hooks.postRunCapture?.enabled === true`; if none match, capture is a no-op (`memory-hooks.ts:297-303`).

This means a company can register a memory adapter without any hooks firing until a binding explicitly enables them.

## Security Model

Security is split between the upstream control plane and local adapters.

### Upstream scope validation

The server validates `scope.companyId` on every direct memory API call (write, query, forget). It checks that the caller-provided `scope.companyId` matches the binding's `companyId` (`memory-operations.ts:115-117`, `:157-159`, `:195-197`). If they do not match, the request is rejected with 403.

**Scope fields below company level (`agentId`, `projectId`, `issueId`, `runId`, `subjectId`) are caller-provided and are not bound to the authenticated actor's identity.** The server does not verify that an agent calling the write endpoint is the same agent as `scope.agentId`. This means company-level isolation is enforced upstream, but sub-company scope fields are trusted from the caller within that company boundary.

For hook-initiated operations (hydration and capture), the server constructs scope from the run context (`memory-hooks.ts:185-191`, `:305-311`), so these scope values are server-controlled and not caller-injectable.

### Adapter-level isolation

Each adapter is responsible for its own storage-level isolation. There is no single universal isolation mechanism across all adapters.

**PARA adapter (filesystem-based):**

- All file operations are scoped to `basePath/<companyId>/` directories.
- `companyId` is validated as a UUID (`/^[0-9a-f]{8}-…$/i`) before any path resolution, preventing directory traversal via malformed scope values (`para.ts:217-222`).
- Resolved paths are checked to ensure they remain within the company base directory — any path that escapes triggers a traversal error (`para.ts:231-236`).

**Mempalace adapter (MCP-based):**

Mempalace relies on **deployment-level separation** for company isolation, not on path validation or in-adapter scoping:

- The adapter does not encode `companyId` into wing or room names — company identity is implicit in which mempalace instance the adapter connects to (`mempalace.ts:56-60`).
- **Local mode** (`MEMPALACE_ENABLED=true`): the server spawns a **single** mempalace sidecar process with one palace data directory per server process (`app.ts:201-206`). This mode does **not** provide per-company isolation out of the box. For multi-company deployments, each company must be served by a separate server process (each with its own sidecar), or operators must use remote mode with per-company instances.
- **Remote mode** (`MEMPALACE_URL`): the server connects to a single endpoint (`app.ts:183-190`). Cross-company isolation requires running separate mempalace instances per company or equivalent network-level separation.
- Within a mempalace instance, `projectId` maps to wings and `issueId` maps to rooms for finer-grained scoping (`mempalace.ts:70-78`).

### Summary

| Concern | Upstream (server) | PARA adapter | Mempalace adapter |
|---------|-------------------|--------------|-------------------|
| Company isolation | `companyId` match enforced on direct API calls | Filesystem path scoping with UUID validation | Deployment-level separation (one instance per company) |
| Sub-company scope | Caller-provided; not validated against actor identity | Directory structure (PARA hierarchy) | Wings (project) and rooms (issue) |
| Traversal prevention | N/A | Path-resolution check against company base dir | N/A (no filesystem paths in adapter) |
| Hook-path scope | Server-constructed from run context (not caller-injectable) | N/A | N/A |

## Adapter Interface

Both built-in adapters implement the `MemoryAdapter` interface from `@paperclipai/plugin-sdk`:

```typescript
interface MemoryAdapter {
  key: string;
  capabilities: MemoryAdapterCapabilities;
  write(req: MemoryWriteRequest): Promise<{ records?: MemoryRecordHandle[]; usage?: MemoryUsage[] }>;
  query(req: MemoryQueryRequest): Promise<MemoryContextBundle>;
  get(handle: MemoryRecordHandle, scope: MemoryScope): Promise<MemorySnippet | null>;
  forget(handles: MemoryRecordHandle[], scope: MemoryScope): Promise<{ usage?: MemoryUsage[] }>;
}
```

Scope is carried via `MemoryScope` on every request:

```typescript
interface MemoryScope {
  companyId: string;
  agentId?: string;
  projectId?: string;
  issueId?: string;
  runId?: string;
  subjectId?: string;
}
```

## Operation Logging

Memory operations are logged to the `memory_operations` Postgres table on a **best-effort** basis — all log inserts swallow failures via `.catch()`, so a failed insert never causes the parent operation to fail. However, the blocking behaviour differs by call path:

- **Direct API success paths** (`memory-operations.ts:122-131`, `:181-189`, `:226-234`): the `logOperation()` call is **not** awaited — truly fire-and-forget and non-blocking.
- **Direct API failure paths** (`memory-operations.ts:138-148`, `:196-205`, `:241-250`): the `logOperation()` call **is** awaited before the error is re-thrown, so the log insert is on the critical path for error-response latency.
- **Hook paths — both success and failure** (`memory-hooks.ts:220-229`, `:244-253`, `:339-348`, `:363-372`): `logHookOperation()` is always awaited, so the insert adds to hook completion latency even though failures are swallowed.

**Persisted scope fields:** `agent_id`, `project_id`, `issue_id`, `run_id`. The `subjectId` field present in `MemoryScope` is **not** persisted in the `memory_operations` table (`0055_memory_bindings_and_operations.sql:23-38`). Operators should not rely on the operation log for `subjectId` traceability.

Because all logging inserts are best-effort, log rows may be dropped if the Postgres insert fails (e.g. transient connection issues). The operation log provides **operational visibility** into memory usage patterns, not a guaranteed audit trail of every operation.

## Memory Bindings

Bindings connect adapters to companies/agents and configure which hooks are active. They are stored in the `memory_bindings` and `memory_binding_targets` database tables.

A binding specifies:
- **Provider key** — which registered adapter to use (e.g. `para`, `mempalace`)
- **Hook config** — which lifecycle hooks are enabled and their parameters
- **Targets** — which company or agent(s) the binding applies to

Without a binding targeting a given agent's company, no memory operations fire for that agent's runs — even if the adapter is registered.

## Error Handling

Memory failures never block agent runs. The system has four layers of defense:

1. **Adapter level** — auto-reconnect on call failure (handles container restarts)
2. **Sidecar level** (local mode only) — health checks every 30s, auto-restart with exponential backoff
3. **Hook level** — each binding operation is individually try/caught, failures logged to `memory_operations`
4. **Heartbeat level** — entire memory hydration and capture blocks are try/caught; runs proceed without memory context on failure
