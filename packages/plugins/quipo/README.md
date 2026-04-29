# Quipo

> Cross-issue memory for Paperclip companies.

Quipo is a [Paperclip](https://paperclip.ai) plugin that gives every agent in a company a shared, searchable memory across issues, conversations, and runs. It listens for new comments and issue edits, hands the content to a configurable Memory Agent for fact extraction, and persists the results into a plugin-owned Postgres schema. Other agents recall those facts during their own runs through five tools (`memory_search`, `memory_search_conclusions`, `memory_get_issue_context`, `memory_get_peer_context`, `memory_ask_peer`).

The full long-form documentation lives at [`docs/plugins/quipo/`](../../../docs/plugins/quipo/index.md):

- [Overview & architecture](../../../docs/plugins/quipo/index.md)
- [Lifecycle: what happens when a comment is posted](../../../docs/plugins/quipo/lifecycle.md)
- [Tool reference](../../../docs/plugins/quipo/tools/index.md)

This README is the operator quick-start.

## What you get

- **Cross-issue memory.** Facts extracted from issue X are recallable on issue Y.
- **Per-company, per-agent peer models.** Quipo maintains rolling profiles of each agent peer, plus issue-level "session" summaries.
- **Five tools any agent can use** to read memory during their runs (search, issue context, peer context, ask-a-peer).
- **A backfill action** to seed memory from existing issues without waiting for new traffic.
- **Per-company settings UI** to enable, pick the Memory Agent, and choose extraction scope. Off by default, opt-in per company.

Quipo is a normal Paperclip plugin — no special host build, no extra runtime. It registers a database namespace, subscribes to two events, ships a settings page, and exposes tools.

## 60-second install

The whole install is "install the plugin + create the memory-worker agent + flip the switch."

1. **Install Quipo into your Paperclip instance.** From the plugins directory:

   ```bash
   pnpm install @paperclipai/plugin-quipo
   pnpm --filter @paperclipai/plugin-quipo build
   ```

   Then register it with the host the same way you register any other plugin (the `paperclipPlugin` entry in `package.json` is the manifest pointer). On first load Quipo runs `migrations/001_init_memory.sql` against its private namespace `plugin_quipo_d14f4ce0c0` — the host needs `pg_trgm` enabled in core (Paperclip core migration `0051_young_korg.sql` already does this).

2. **Create the memory-worker agent.** In your company, create a new agent and choose the **Quipo / memory-worker** template (shipped at `@paperclipai/plugin-quipo/agent-templates/memory-worker`). The template includes the [`AGENTS.md`](./src/agent-templates/memory-worker/AGENTS.md) instructions that tell the agent how to extract atomic facts and hand them back as structured JSON. Note its agent ID.

   You can use any LLM you like for the memory-worker — the host runs it as a normal Paperclip agent. Anthropic Claude Haiku 4.5 is the recommended default for cost.

3. **Open the Quipo settings page** (Settings → Plugins → Quipo) and:
   - Tick **Enabled**.
   - Paste the memory-worker's agent ID into **Memory Agent**.
   - Leave **Extraction Scope** at `comments_and_updates` (the default), or switch to `comments_only` to ignore title/description edits.

4. **Post a comment** on any issue in the company. Within a few seconds you should see:
   - A new plugin-owned issue titled `Quipo: extract facts from comment on …` assigned to the memory-worker.
   - The memory-worker run completes, posts a JSON comment, and the issue closes itself.
   - Rows in `plugin_quipo_d14f4ce0c0.facts` for that company.

That's it. Any agent in the company can now call `memory_search` and friends.

> **Tip:** to seed memory from issues that already exist before you turned Quipo on, run the backfill action — see [`docs/plugins/quipo/index.md#backfill`](../../../docs/plugins/quipo/index.md#backfill).

## Configuration

Quipo's per-company config schema (declared in [`src/manifest.ts`](./src/manifest.ts)):

| Key | Type | Default | What it does |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | Master switch. When false, Quipo ignores all events and the memory-worker is never woken. Tools still serve whatever is already in the database. |
| `memoryAgentId` | UUID string | _none_ | The agent that performs fact extraction. **Required** for the plugin to act on any event. |
| `extractionScope` | enum | `"comments_and_updates"` | `comments_and_updates` ingests new comments **and** issue title/description edits. `comments_only` ignores issue updates entirely. |

Settings are managed through the per-company UI (`Quipo Settings`); changing them takes effect immediately on the next event.

## What it costs

> **Subject to change.** The figures below come from the [RED-125 smoke test](https://paperclip.ai) on Anthropic Claude Haiku 4.5 against a healthy comment stream. Real-world cost depends on your model choice, comment length, and extraction volume. Re-measure on your own deployment before publishing internal SLAs.

- **~$0.02 per extraction** on Haiku 4.5 for a typical issue comment (a few hundred tokens in, ≤50 facts out as JSON).
- **One extraction = one Memory Agent run.** Quipo creates one extraction issue per source comment or issue update, not per fact.
- **Tools are free at the model layer** — `memory_search` and friends run SQL against `plugin_quipo_<hash>.facts`. The cost of consuming tool results in the calling agent's context is ordinary Paperclip token cost.

For a rough monthly bound: `(# comments per day) × ~$0.02 × 30`. A team posting 200 comments a day spends about $120/month on Quipo extraction.

## Troubleshooting

### "I posted a comment, no facts persisted."

Walk the lifecycle in order — each step is independently observable.

1. **Plugin enabled?** Settings → Plugins → Quipo. Both `enabled = true` and `memoryAgentId` set.
2. **Extraction issue created?** Check the company's issue list for `Quipo: extract facts from comment on …` titles assigned to the memory-worker. If none appear, see "Worker stuck" below.
3. **Memory-worker ran?** Open the extraction issue. There should be one comment from the memory-worker containing a single JSON object `{"facts":[…]}`. If the run failed or produced prose, check the agent's run log — most often this is a model that doesn't honor JSON mode. Switch to a model that supports structured outputs and rerun.
4. **Harvest happened?** Quipo subscribes to `issue.comment.created` and harvests JSON comments authored by the configured memory agent on Quipo-owned issues. The plugin writes one row per fact into `plugin_quipo_d14f4ce0c0.facts`, upserts a session summary, and rolls up agent peer models. Verify with:

   ```sql
   SELECT count(*) FROM plugin_quipo_d14f4ce0c0.facts
   WHERE company_id = '<your-company-uuid>';
   ```

   If the count is still zero but the JSON comment exists, check the host run log for parse errors — Quipo records `parse_error` / `empty` outcomes in plugin state so a broken response does not loop forever.

### "The memory-worker agent never wakes up."

Quipo creates an extraction issue, assigns it to the memory-worker, and explicitly wakes the agent (RED-133's `issues.wakeup` capability). If the worker isn't waking:

- Confirm the agent ID in settings matches the memory-worker exactly (UUID typo is the most common cause).
- Confirm the agent is enabled and not at its budget cap. Quipo respects normal Paperclip pause/cancel and budget gates.
- Toggle the **Enabled** switch off and on again. After a disable/enable cycle Quipo re-registers its event handlers and rebuilds the in-process worker manager state (the fix in RED-132).

### "Tools 502 with `worker is not running`."

The plugin tool execution bridge can briefly report `worker is not running` after a disable/enable cycle. The fix shipped in RED-132. If you see it on the latest version, restart the host process — the worker manager rebuilds its state on next boot.

### "I want to seed memory from old issues."

Run the backfill action. It walks existing comments in the company (or a single project / issue), enqueues the same extraction issues as the live event handler, and is idempotent on `commentId` so re-running won't double-extract. See [`docs/plugins/quipo/index.md#backfill`](../../../docs/plugins/quipo/index.md#backfill).

## Compatibility

- **Paperclip plugin SDK:** `@paperclipai/plugin-sdk` v1 (`apiVersion: 1` in the manifest).
- **Postgres:** requires `pg_trgm` enabled in the core schema (already present in Paperclip from migration `0051_young_korg.sql`).
- **Memory-worker LLM:** any model the company has configured for the agent. Models with native JSON / structured-output mode produce the most reliable extractions.

## License

MIT. See repo root.
