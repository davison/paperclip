-- RED-98 Phase 1 MVP: facts, sessions, peer_models tables for the Quipo
-- memory plugin. Schema name resolves to plugin_quipo_d14f4ce0c0 per
-- derivePluginDatabaseNamespace("paperclipai.plugin-quipo", "quipo").
--
-- pg_trgm is enabled in core (db migration 0051_young_korg.sql), so the
-- gin_trgm_ops operator class is available without a per-plugin extension
-- (which the migration validator forbids anyway).

CREATE TABLE plugin_quipo_d14f4ce0c0.facts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  issue_id    uuid REFERENCES public.issues(id) ON DELETE SET NULL,
  agent_id    uuid REFERENCES public.agents(id) ON DELETE SET NULL,
  content     text NOT NULL,
  level       text NOT NULL DEFAULT 'explicit',
  source_ids  uuid[] NOT NULL DEFAULT '{}',
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plugin_quipo_d14f4ce0c0.sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  issue_id    uuid NOT NULL REFERENCES public.issues(id) ON DELETE CASCADE,
  summary     text,
  fact_count  integer NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_sessions_issue_unique ON plugin_quipo_d14f4ce0c0.sessions (issue_id);

CREATE TABLE plugin_quipo_d14f4ce0c0.peer_models (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  agent_id    uuid NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  model       text,
  fact_count  integer NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_peer_models_company_agent ON plugin_quipo_d14f4ce0c0.peer_models (company_id, agent_id);

CREATE INDEX idx_facts_company ON plugin_quipo_d14f4ce0c0.facts (company_id);

CREATE INDEX idx_facts_issue ON plugin_quipo_d14f4ce0c0.facts (company_id, issue_id);

CREATE INDEX idx_facts_agent ON plugin_quipo_d14f4ce0c0.facts (company_id, agent_id);

CREATE INDEX idx_facts_content_trgm ON plugin_quipo_d14f4ce0c0.facts USING gin (content gin_trgm_ops);
