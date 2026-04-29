# Changelog

This file tracks notable changes to the Paperclip monorepo. Per-package release notes for plugins live alongside the top-level entry — link out from the package README rather than duplicating.

## `@paperclipai/plugin-quipo` 0.1.0-rc.1 — 2026-04-29

First publishable release candidate of the Quipo cross-issue memory plugin.

### Added

- Plugin manifest, worker, and per-company settings UI.
- ctx.db schema and migrations for facts, sessions, and peer models.
- Memory Agent template (`@paperclipai/plugin-quipo/agent-templates/memory-worker`) covering memory-worker storage responsibility, extraction prompts, and tool surface (RED-138).
- Agent tools: `memory_search`, `memory_get`, `memory_record`, and friends — registered via `agent.tools.register` (RED-101).
- Event handlers for `issue.comment.created` and `issue.updated` that wake the configured Memory Agent (RED-103).
- Persistence harvest loop: extracted facts now actually land in `ctx.db` after the Memory Agent comments (RED-130).
- `issues.wakeup` capability so the memory-worker can request follow-up runs (RED-133).
- Backfill action: extract facts from existing issues without replaying every event (RED-103).
- Publish metadata: `repository`, `homepage`, `bugs`, `publishConfig.access: public`, package-local `README.md` (RED-145).
- Plugin upgrade hygiene: bundled `dist/manifest.js` (no broken `./tools/index.js` import), dev-watcher manifest reload, capability-drift warning during `activatePlugin` (RED-187 / RED-197). Resolves the original RED-129 manifest-load defect.

### Publishing

Publish only via `pnpm publish` from the monorepo root. `npm pack` / `npm publish` will not rewrite `workspace:*` ranges in the tarball — the resulting artefact will fail to install on consumers.

### Known gaps before `0.1.0` final

- Soak time on `local-integration` for RED-130/138/187 has not yet completed.

### Out of scope for rc.1

- `npm publish` itself (requires npm scope owner sign-off).
- Multi-tenant validation, billing config.

[Unreleased link]: https://github.com/paperclipai/paperclip/commits/master
