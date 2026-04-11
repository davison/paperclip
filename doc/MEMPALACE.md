# Mempalace Integration

Mempalace provides semantic memory for Paperclip agents. Agents don't interact with mempalace directly — the Paperclip server queries and writes to mempalace automatically via lifecycle hooks on each agent run.

## How It Works

1. **Pre-run hydration** — before each agent run, the server queries mempalace for context relevant to the task and injects it into the agent's context window.
2. **Post-run capture** — after each run completes, the server writes a summary of what happened into mempalace for future recall.

Both hooks are controlled by **memory bindings** — database records that configure which memory provider to use, for which agents, and what hooks are enabled.

## Architecture

```
agent ← heartbeat context ← paperclip server ← MCP over HTTP ← mempalace container
                                              → MCP over HTTP → mempalace container
```

Agents never access mempalace data directly. The paperclip server handles all memory operations and injects the results into the agent's context.

## Setup

### Prerequisites

- A running Paperclip instance
- Docker or Podman (for remote mode) or Python 3.13+ (for local mode)

### Option A: Remote Mode (Docker / Podman) — Recommended

Run mempalace as a separate container. This is the recommended approach for production and multi-container deployments.

#### 1. Build the mempalace container

```bash
cd docker/mempalace
docker build -t mempalace .
```

#### 2. Run it

```bash
docker run -d \
  --name mempalace \
  --network paperclip \
  -v mempalace-data:/data/mempalace \
  mempalace
```

> **Security:** Do not publish the mempalace port with `-p 8080:8080` — the `/mcp` endpoint is unauthenticated. Use a shared Docker network so only the Paperclip container can reach it. If you need host access for debugging, bind to localhost only: `-p 127.0.0.1:8080:8080`.

Or with Docker Compose — see `docker/mempalace/docker-compose.mempalace.yml`:

```yaml
services:
  paperclip:
    image: your-paperclip-image
    environment:
      MEMPALACE_URL: http://mempalace:8080/mcp
    depends_on:
      mempalace:
        condition: service_healthy

  mempalace:
    build: docker/mempalace
    volumes:
      - mempalace-data:/data/mempalace
    environment:
      MEMPALACE_PALACE_PATH: /data/mempalace
      MEMPALACE_PORT: 8080

volumes:
  mempalace-data:
```

#### 3. Point Paperclip at it

Set the environment variable on the Paperclip server:

```
MEMPALACE_URL=http://mempalace:8080/mcp
```

If running outside compose (e.g. Podman pod), use `http://localhost:8080/mcp` or the appropriate network address.

#### 4. Verify connection

In the Paperclip server logs at startup, look for:

```
mempalace remote adapter connected and registered {"url":"http://mempalace:8080/mcp"}
```

### Option B: Local Sidecar Mode

Run mempalace as a child process of the Paperclip server. Suitable for single-host or development setups.

#### 1. Install mempalace

```bash
pip install mempalace
```

Ensure `python` is on the PATH and can import `mempalace`.

#### 2. Enable the sidecar

Set environment variables on the Paperclip server:

```
MEMPALACE_ENABLED=true
MEMPALACE_PALACE_DIR=/path/to/palace/data    # optional, defaults to $CWD/.mempalace
MEMPALACE_PYTHON_COMMAND=python               # optional, defaults to "python"
```

#### 3. Verify

In the Paperclip server logs at startup:

```
mempalace sidecar started and adapter registered {"palaceDir":"/path/to/palace/data"}
```

The sidecar includes health checks (every 30s) and auto-restart with exponential backoff (up to 5 attempts).

## Creating a Memory Binding

The adapter being registered is not enough — you need a **memory binding** to tell the system to use it. Without a binding, no memory operations will fire.

### Via the UI

Navigate to **Memory Settings** in the Paperclip sidebar. Create a new binding with:

- **Key**: a unique name, e.g. `mempalace-default`
- **Provider**: `mempalace`
- **Hooks**: enable pre-run hydration and/or post-run capture

Then add a **target** — either the whole company (all agents) or a specific agent.

### Via the API

#### 1. Create the binding

```bash
curl -X POST $PAPERCLIP_API_URL/api/companies/$COMPANY_ID/memory-bindings \
  -H 'Authorization: Bearer $TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{
    "key": "mempalace-default",
    "providerKey": "mempalace",
    "config": {
      "hooks": {
        "preRunHydrate": { "enabled": true, "topK": 5 },
        "postRunCapture": { "enabled": true, "captureDepth": "full" }
      }
    }
  }'
```

#### 2. Target it at the company (all agents)

```bash
curl -X POST $PAPERCLIP_API_URL/api/memory-bindings/$BINDING_ID/targets \
  -H 'Authorization: Bearer $TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{
    "targetType": "company",
    "targetId": "'$COMPANY_ID'"
  }'
```

Or target a specific agent:

```bash
curl -X POST $PAPERCLIP_API_URL/api/memory-bindings/$BINDING_ID/targets \
  -H 'Authorization: Bearer $TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{
    "targetType": "agent",
    "targetId": "'$AGENT_ID'"
  }'
```

### Hook Configuration

| Hook | Purpose | Config |
|------|---------|--------|
| `preRunHydrate` | Query mempalace before each run, inject relevant context | `enabled`: boolean, `topK`: max snippets (default 5) |
| `postRunCapture` | Write run summary to mempalace after each run | `enabled`: boolean, `captureDepth`: `"summary"` or `"full"` |

- **`summary`** — captures metadata only: agent name, task title, run ID, outcome, timestamp.
- **`full`** — captures metadata plus the adapter's result JSON (the agent's actual output), capped at 4000 chars. Recommended for building useful memory.

## Verifying It Works

After creating a binding and running an agent, you should see:

### Paperclip server logs

```
memory context hydrated for run {"bindingsQueried":1,"snippetCount":3}
memory capture completed {"bindingsCaptured":1}
```

### Mempalace container logs

```
POST /mcp HTTP/1.1 200 OK    # mempalace_search (pre-run hydration)
POST /mcp HTTP/1.1 200 OK    # mempalace_add_drawer (post-run capture)
```

### Memory Operations page

In the Paperclip UI, the Memory Operations page shows logged operations with latency, success status, and provider details.

### Mempalace data directory

ChromaDB files should appear in the configured palace directory (e.g. `/data/mempalace/`).

## Environment Variables Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMPALACE_URL` | — | Remote mempalace MCP server URL. Takes precedence over local mode. |
| `MEMPALACE_ENABLED` | — | Set to `true` to start local sidecar mode. Ignored when `MEMPALACE_URL` is set. |
| `MEMPALACE_PALACE_DIR` | `$CWD/.mempalace` | Palace data directory for local sidecar mode. |
| `MEMPALACE_PYTHON_COMMAND` | `python` | Python binary for local sidecar mode. |
| `MEMPALACE_PORT` | `8080` | HTTP port for the mempalace container. |
| `MEMPALACE_PALACE_PATH` | `/data/mempalace` | Palace data path inside the mempalace container. |

## Error Handling

Mempalace failures never block agent runs. The system has 4 layers of defense:

1. **Adapter level** — auto-reconnect on call failure (handles container restarts)
2. **Sidecar level** (local mode) — health checks every 30s, auto-restart with exponential backoff
3. **Memory hooks level** — each binding operation is individually try/caught, failures logged to the `memory_operations` table
4. **Heartbeat level** — entire memory hydration and capture blocks are try/caught; runs proceed without memory context on failure

## Security Considerations

The mempalace HTTP endpoint (`/mcp`) does not perform authentication. It is designed to run as an internal sidecar accessible only within the Docker network. **Do not publish the mempalace port to the host or external networks.** If you need host access for debugging, use a temporary port forward rather than a published port in your compose file.

## Backfilling Historical Runs

If mempalace was enabled after agents had already been running, you can backfill previous run data into mempalace using the CLI script.

### Usage

From the repo root:

```bash
pnpm -w run backfill:mempalace -- [options]
```

Or directly:

```bash
pnpm --filter @paperclipai/server exec tsx scripts/backfill-mempalace.ts [options]
```

Inside a running container:

```bash
pnpm --filter @paperclipai/server exec tsx scripts/backfill-mempalace.ts [options]
```

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `--company-id <id>` | all | Filter by company UUID |
| `--agent-id <id>` | all | Filter by agent UUID |
| `--since <date>` | all time | Only runs after this ISO date |
| `--until <date>` | now | Only runs before this ISO date |
| `--dry-run` | — | Preview what would be written without writing |
| `--batch-size <n>` | 100 | Runs per batch |
| `--capture-depth <d>` | full | `"summary"` or `"full"` |

### Environment

The script requires the same environment variables as the Paperclip server:

- `DATABASE_URL` — Postgres connection string (required)
- `MEMPALACE_URL` — remote mempalace URL, **or** `MEMPALACE_ENABLED=true` for local sidecar

### Examples

Preview all backfill-able runs:

```bash
pnpm -w run backfill:mempalace -- --dry-run
```

Backfill a specific company's runs from the last 30 days:

```bash
pnpm -w run backfill:mempalace -- --company-id <uuid> --since 2026-03-09
```

Backfill inside a container:

```bash
podman exec paperclip pnpm --filter @paperclipai/server exec tsx scripts/backfill-mempalace.ts --dry-run
```

## Troubleshooting

**Adapter registered but no memory operations during runs**
- Check that a memory binding exists with the correct `providerKey` (`mempalace`)
- Check that the binding has a target pointing to the company or agent
- Check that hooks are enabled in the binding config

**Mempalace container starts then dies after ~2 minutes**
- Ensure the container uses the HTTP wrapper (`serve_http.py`), not `python -m mempalace.mcp_server` directly. The native MCP server only supports stdio transport.

**Connection refused / adapter not registered**
- Verify the mempalace container is running and healthy: `curl http://localhost:8080/health`
- Check the `MEMPALACE_URL` matches the container's address and port
- In compose, ensure `depends_on` with `condition: service_healthy`

**Empty palace data directory**
- This is expected until the first post-run capture fires. Run an agent on a task with a binding configured, then check again.


## How does the work align with the doc `memory-landscape.md`?

The doc proposes a two-layer memory model. Here's how the implementation maps:

### Layer 1: Memory binding + control plane ✅ Strong alignment

The doc says Paperclip should own:

| Doc requirement | Implementation | Status |
|---|---|---|
| Binding provider to company, optionally per-agent | `memory_bindings` + `memory_binding_targets` tables, with target types `company` and `agent` | ✅ Done |
| Mapping Paperclip entities into provider scopes | `MemoryScope` type carries `companyId`, `agentId`, `projectId`, `issueId`, `runId` | ✅ Done |
| Provenance back to issues, comments, documents, runs | `sourceRef` jsonb on `memory_operations`, `buildSourceFile()` in adapter | ✅ Done |
| Cost / latency reporting | `memory_operations` table with `latency_ms`, `usage` jsonb, `success` flag | ✅ Done |
| Browse and inspect UI | `MemoryOperations.tsx` (operation log) + `MemorySettings.tsx` (binding management) | ✅ Done |
| Governance on destructive operations | Operation logging for all write/query/forget calls | ⚠️ Partial — logging exists but no approval gate on forget |

### Layer 2: Provider adapter ✅ Strong alignment

The doc says providers should own extraction, indexing, ranking, profile synthesis, and storage.

| Doc requirement | Implementation | Status |
|---|---|---|
| Required portable core (write, query, get, forget) | `MemoryAdapter` interface with `write()`, `query()`, `get()`, `forget()` | ✅ Done |
| Optional capability flags | `MemoryAdapterCapabilities` with `profile`, `browse`, `correction`, `asyncIngestion`, `multimodal`, `providerManagedExtraction` | ✅ Done |
| Provider-native IDs without flattening | `MemoryRecordHandle` with `providerKey` + `providerRecordId` | ✅ Done |
| Plugin-supplied adapters (not only built-ins) | Interface in `@paperclipai/plugin-sdk`, plugins can implement | ✅ Done |
| Built-in local-first baseline | PARA adapter (file-based, zero-config) | ✅ Done |
| Support for richer external systems | Mempalace adapter (MCP-based, stdio or remote HTTP) | ✅ Done |

### Common primitives coverage

The doc identifies 6 convergent primitives:

| Primitive | Coverage |
|---|---|
| `ingest` (write) | ✅ `MemoryAdapter.write()` + `postRunCapture` hook |
| `query` (search/recall) | ✅ `MemoryAdapter.query()` + `preRunHydrate` hook |
| `scope` (partition) | ✅ `MemoryScope` with entity hierarchy |
| `provenance` | ✅ `sourceRef` + operation logging |
| `maintenance` (forget/correct) | ⚠️ `forget()` exists, but no dedupe/compact/correct |
| `context assembly` | ✅ `MemoryContextBundle` with snippets + profileSummary |

### Gaps vs the doc

1. **Correction workflow** — the doc mentions correction as a capability flag; we have the flag (`correction: false` on both adapters) but no correction API endpoint.
2. **Governance on destructive ops** — the doc calls for governance on forget; we log everything but don't gate through approvals.
3. **Dedupe/compact/maintenance** — the doc mentions these under maintenance; not implemented.
4. **Profile synthesis** — the capability flag exists and the query response supports `profileSummary`, but neither built-in adapter synthesizes profiles.

These are all follow-up work and don't contradict the architecture — the capability flag system was designed exactly to handle providers that don't support these yet.

**Bottom line:** The implementation aligns well with the doc's architecture and covers the core contract it recommends. The gaps are in advanced capabilities that the doc explicitly calls optional.
