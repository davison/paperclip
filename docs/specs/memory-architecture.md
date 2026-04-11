# Memory Architecture

This document describes the memory adapter framework, its security model, and lifecycle integration. It covers the two built-in adapters (PARA and mempalace) and the hook system that drives automatic memory operations.

## Overview

Paperclip's memory system is a two-layer architecture:

1. **Control plane** (Paperclip server) — owns bindings, scope mapping, provenance, lifecycle hooks, and operation logging.
2. **Provider adapters** — own storage, indexing, and retrieval. Adapters implement the `MemoryAdapter` interface (`write`, `query`, `get`, `forget`) and declare optional capabilities via `MemoryAdapterCapabilities`.

Agents never interact with memory providers directly. The server mediates all memory operations and injects results into agent context.

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

Company isolation is enforced **differently by each adapter**, reflecting their distinct storage architectures. There is no single universal isolation mechanism across all adapters.

### PARA adapter (filesystem-based)

PARA enforces company isolation at the filesystem path level:

- All file operations are scoped to `basePath/<companyId>/` directories.
- `companyId` is validated as a UUID (`/^[0-9a-f]{8}-…$/i`) before any path resolution, preventing directory traversal via malformed scope values (`para.ts:217-222`).
- Resolved paths are checked to ensure they remain within the company base directory — any path that escapes triggers a traversal error (`para.ts:231-236`).

### Mempalace adapter (MCP-based)

Mempalace enforces company isolation at the **process/deployment level**, not via path validation in the adapter layer:

- Each company gets its own mempalace sidecar process with a separate palace data directory. Isolation is enforced by which sidecar instance the adapter connects to (`mempalace.ts:56-60`).
- The adapter does not encode `companyId` into wing or room names — company identity is implicit in the connection target.
- In remote mode, the server connects to a single `MEMPALACE_URL` endpoint (`app.ts:183-190`). Cross-company isolation in multi-company deployments requires running separate mempalace instances per company or equivalent network-level separation.
- Within a company's mempalace instance, `projectId` maps to wings and `issueId` maps to rooms for finer-grained scoping (`mempalace.ts:70-78`).

### Summary

| Concern | PARA | Mempalace |
|---------|------|-----------|
| Company isolation | Filesystem path scoping with UUID validation | Process/deployment-level separation |
| Traversal prevention | Path-resolution check against company base dir | N/A (no filesystem paths in adapter) |
| Sub-company scoping | Directory structure (PARA hierarchy) | Wings (project) and rooms (issue) |

## Adapter Interface

Both adapters implement the `MemoryAdapter` interface from `@paperclipai/plugin-sdk`:

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
