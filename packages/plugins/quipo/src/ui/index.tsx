import { useCallback, useEffect, useMemo, useState, type CSSProperties, type FormEvent } from "react";
import {
  useHostContext,
  usePluginAction,
  type PluginSettingsPageProps,
} from "@paperclipai/plugin-sdk/ui";

import { QUIPO_PLUGIN_ID } from "../config.js";

// Action key registered by the worker (see src/backfill.ts). Inlined here to
// keep the browser bundle from pulling worker-only modules.
const QUIPO_BACKFILL_ACTION_KEY = "backfill";

const QUIPO_DEFAULTS = {
  enabled: false,
  memoryAgentId: "",
  extractionScope: "comments_and_updates" as ExtractionScope,
};

type ExtractionScope = "comments_and_updates" | "comments_only";

interface QuipoConfigForm {
  enabled: boolean;
  memoryAgentId: string;
  extractionScope: ExtractionScope;
}

interface AgentSummary {
  id: string;
  name: string;
  displayName?: string | null;
  role?: string | null;
  status?: string | null;
}

const layoutStack: CSSProperties = { display: "grid", gap: "18px" };
const cardStyle: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: "12px",
  padding: "16px",
  background: "var(--card, transparent)",
  display: "grid",
  gap: "12px",
};
const fieldStyle: CSSProperties = { display: "grid", gap: "6px" };
const inputStyle: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: "8px",
  background: "transparent",
  color: "inherit",
  padding: "8px 10px",
  fontSize: "13px",
  fontFamily: "inherit",
};
const rowStyle: CSSProperties = { display: "flex", gap: "8px", alignItems: "center" };
const helpTextStyle: CSSProperties = { fontSize: "12px", opacity: 0.7, lineHeight: 1.5 };
const labelStyle: CSSProperties = { fontSize: "13px", fontWeight: 500 };
const errorStyle: CSSProperties = { color: "var(--destructive, #c00)", fontSize: "12px" };
const successStyle: CSSProperties = { color: "var(--success, #16a34a)", fontSize: "12px" };
const buttonStyle: CSSProperties = {
  appearance: "none",
  border: "1px solid var(--border)",
  borderRadius: "999px",
  background: "transparent",
  color: "inherit",
  padding: "8px 16px",
  fontSize: "13px",
  fontWeight: 500,
  cursor: "pointer",
};
const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "var(--foreground)",
  color: "var(--background)",
  borderColor: "var(--foreground)",
};

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed: ${response.status}`);
  }
  return (await response.json()) as T;
}

function normaliseConfig(raw: Record<string, unknown> | null | undefined): QuipoConfigForm {
  if (!raw) return { ...QUIPO_DEFAULTS };
  const enabled = typeof raw.enabled === "boolean" ? raw.enabled : QUIPO_DEFAULTS.enabled;
  const memoryAgentId = typeof raw.memoryAgentId === "string" ? raw.memoryAgentId : "";
  const extractionScope: ExtractionScope =
    raw.extractionScope === "comments_only" ? "comments_only" : "comments_and_updates";
  return { enabled, memoryAgentId, extractionScope };
}

function useQuipoConfig() {
  const [form, setForm] = useState<QuipoConfigForm>({ ...QUIPO_DEFAULTS });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchJson<{ configJson?: Record<string, unknown> | null } | null>(
      `/api/plugins/${QUIPO_PLUGIN_ID}/config`,
    )
      .then((result) => {
        if (cancelled) return;
        setForm(normaliseConfig(result?.configJson ?? null));
        setError(null);
      })
      .catch((nextError) => {
        if (cancelled) return;
        setError(nextError instanceof Error ? nextError.message : String(nextError));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(async (next: QuipoConfigForm) => {
    setSaving(true);
    try {
      // Only send memoryAgentId when set; an empty string would be normalised
      // back to "not configured" by the worker, but we strip it here to keep
      // the stored config tidy and aligned with the JSON Schema.
      const payload: Record<string, unknown> = {
        enabled: next.enabled,
        extractionScope: next.extractionScope,
      };
      if (next.memoryAgentId.trim().length > 0) {
        payload.memoryAgentId = next.memoryAgentId.trim();
      }
      await fetchJson(`/api/plugins/${QUIPO_PLUGIN_ID}/config`, {
        method: "POST",
        body: JSON.stringify({ configJson: payload }),
      });
      setForm(next);
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
      throw nextError;
    } finally {
      setSaving(false);
    }
  }, []);

  return { form, setForm, loading, saving, error, save };
}

function useCompanyAgents(companyId: string | null) {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!companyId) {
      setAgents([]);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchJson<unknown>(`/api/companies/${companyId}/agents`)
      .then((result) => {
        if (cancelled) return;
        const list = Array.isArray(result)
          ? result
          : Array.isArray((result as { agents?: unknown })?.agents)
            ? (result as { agents: unknown[] }).agents
            : Array.isArray((result as { items?: unknown })?.items)
              ? (result as { items: unknown[] }).items
              : [];
        const parsed: AgentSummary[] = list
          .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
          .map((item) => ({
            id: String(item.id ?? ""),
            name: String(item.name ?? item.nameKey ?? item.displayName ?? "Unknown"),
            displayName:
              typeof item.displayName === "string"
                ? item.displayName
                : typeof item.name === "string"
                  ? item.name
                  : null,
            role: typeof item.role === "string" ? item.role : null,
            status: typeof item.status === "string" ? item.status : null,
          }))
          .filter((a) => a.id.length > 0);
        setAgents(parsed);
        setError(null);
      })
      .catch((nextError) => {
        if (cancelled) return;
        setError(nextError instanceof Error ? nextError.message : String(nextError));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  return { agents, loading, error };
}

function setField<K extends keyof QuipoConfigForm>(
  setter: (updater: (prev: QuipoConfigForm) => QuipoConfigForm) => void,
  key: K,
  value: QuipoConfigForm[K],
) {
  setter((prev) => ({ ...prev, [key]: value }));
}

export function QuipoSettingsPage(_props: PluginSettingsPageProps) {
  const context = useHostContext();
  const companyId = context.companyId;
  const { form, setForm, loading, saving, error, save } = useQuipoConfig();
  const agentsQuery = useCompanyAgents(companyId);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const memoryAgentInList = useMemo(
    () => agentsQuery.agents.some((a) => a.id === form.memoryAgentId),
    [agentsQuery.agents, form.memoryAgentId],
  );

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (form.enabled && form.memoryAgentId.trim().length === 0) {
      setSubmitError("Pick a Memory Agent before enabling Quipo, or save with Enabled off.");
      return;
    }
    setSubmitError(null);
    try {
      await save(form);
      setSavedAt(Date.now());
    } catch {
      // surfaced via the hook's error
    }
  }

  if (!companyId) {
    return (
      <div style={{ ...layoutStack, padding: "16px" }}>
        <div style={cardStyle}>
          <strong>Quipo settings</strong>
          <p style={helpTextStyle}>
            Quipo settings are scoped per company. Pick a company from the workspace switcher to
            configure ingestion.
          </p>
        </div>
      </div>
    );
  }

  if (loading) {
    return <div style={{ padding: "16px", fontSize: "12px", opacity: 0.7 }}>Loading Quipo settings…</div>;
  }

  return (
    <form onSubmit={onSubmit} style={{ ...layoutStack, padding: "16px" }}>
      <div style={cardStyle}>
        <div style={{ display: "grid", gap: "4px" }}>
          <strong>Quipo memory plugin</strong>
          <span style={helpTextStyle}>
            Per-company switch, memory agent selection, and event-source scope. Quipo extracts
            atomic facts from comments (and optionally fact-bearing issue updates) into a
            plugin-owned ctx.db schema. The configured Memory Agent does the LLM extraction;
            without one, Quipo logs and skips events.
          </span>
        </div>
      </div>

      <div style={cardStyle}>
        <div style={fieldStyle}>
          <label style={rowStyle}>
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(event) => setField(setForm, "enabled", event.target.checked)}
              data-testid="quipo-enabled-toggle"
            />
            <span style={labelStyle}>Enable Quipo for this company</span>
          </label>
          <span style={helpTextStyle}>
            When off, Quipo subscribes to events but ignores them. Toggle on once a Memory Agent is
            picked and you're ready to start ingesting.
          </span>
        </div>
      </div>

      <div style={cardStyle}>
        <div style={fieldStyle}>
          <label style={labelStyle} htmlFor="quipo-memory-agent">
            Memory Agent
          </label>
          {agentsQuery.loading ? (
            <div style={helpTextStyle}>Loading agents…</div>
          ) : agentsQuery.error ? (
            <div style={errorStyle}>Failed to load agents: {agentsQuery.error}</div>
          ) : (
            <select
              id="quipo-memory-agent"
              data-testid="quipo-memory-agent-select"
              style={inputStyle}
              value={form.memoryAgentId}
              onChange={(event) => setField(setForm, "memoryAgentId", event.target.value)}
            >
              <option value="">— None selected —</option>
              {agentsQuery.agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.displayName ?? agent.name}
                  {agent.role ? ` · ${agent.role}` : ""}
                </option>
              ))}
              {!memoryAgentInList && form.memoryAgentId ? (
                <option value={form.memoryAgentId}>{form.memoryAgentId} (not in this company)</option>
              ) : null}
            </select>
          )}
          <span style={helpTextStyle}>
            Pick the agent that wakes for fact extraction (typically a "memory-worker" template
            agent). Quipo never extracts comments authored by this agent, to prevent feedback loops.
          </span>
        </div>
      </div>

      <div style={cardStyle}>
        <div style={fieldStyle}>
          <span style={labelStyle}>Extraction scope</span>
          <label style={rowStyle}>
            <input
              type="radio"
              name="quipo-extraction-scope"
              value="comments_and_updates"
              checked={form.extractionScope === "comments_and_updates"}
              onChange={() => setField(setForm, "extractionScope", "comments_and_updates")}
              data-testid="quipo-scope-comments-and-updates"
            />
            <span>
              <strong>Comments &amp; issue updates</strong>
              <div style={helpTextStyle}>
                Default. React to new comments and to fact-bearing patches on issue title or
                description.
              </div>
            </span>
          </label>
          <label style={rowStyle}>
            <input
              type="radio"
              name="quipo-extraction-scope"
              value="comments_only"
              checked={form.extractionScope === "comments_only"}
              onChange={() => setField(setForm, "extractionScope", "comments_only")}
              data-testid="quipo-scope-comments-only"
            />
            <span>
              <strong>Comments only</strong>
              <div style={helpTextStyle}>
                Skip <code>issue.updated</code> events. Useful for noisy projects where titles and
                descriptions churn without adding new facts.
              </div>
            </span>
          </label>
        </div>
      </div>

      {error ? <div style={errorStyle}>{error}</div> : null}
      {submitError ? <div style={errorStyle}>{submitError}</div> : null}

      <div style={rowStyle}>
        <button type="submit" style={primaryButtonStyle} disabled={saving} data-testid="quipo-save">
          {saving ? "Saving…" : "Save settings"}
        </button>
        {savedAt ? <span style={successStyle}>Saved · {new Date(savedAt).toLocaleTimeString()}</span> : null}
      </div>

      <BackfillCard companyId={companyId} memoryAgentConfigured={form.memoryAgentId.trim().length > 0} />
    </form>
  );
}

interface BackfillSummaryView {
  ok?: boolean;
  reason?: string;
  issuesScanned?: number;
  commentsScanned?: number;
  queued?: number;
  alreadyExtracted?: number;
  memoryAgentAuthoredSkipped?: number;
  pluginOwnedIssuesSkipped?: number;
  truncated?: boolean;
  dryRun?: boolean;
}

function BackfillCard({
  companyId,
  memoryAgentConfigured,
}: {
  companyId: string | null | undefined;
  memoryAgentConfigured: boolean;
}) {
  const runBackfillAction = usePluginAction(QUIPO_BACKFILL_ACTION_KEY);
  const [running, setRunning] = useState<"dry" | "real" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BackfillSummaryView | null>(null);

  async function trigger(dryRun: boolean) {
    if (!companyId) {
      setError("No active company. Pick a company before running backfill.");
      return;
    }
    setError(null);
    setRunning(dryRun ? "dry" : "real");
    try {
      const summary = (await runBackfillAction({ companyId, dryRun })) as BackfillSummaryView;
      setResult(summary);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(null);
    }
  }

  return (
    <div style={cardStyle}>
      <div style={fieldStyle}>
        <strong>One-shot backfill</strong>
        <span style={helpTextStyle}>
          Walks every existing issue in this company and queues the configured Memory Agent to
          extract facts from each comment. Idempotent — already-processed comments are skipped via
          their <code>source_comment_id</code>. The action does <em>not</em> require the master
          switch to be on, so you can seed memory before flipping ingestion live.
        </span>
        <div style={rowStyle}>
          <button
            type="button"
            style={buttonStyle}
            disabled={!memoryAgentConfigured || running !== null}
            onClick={() => trigger(true)}
            data-testid="quipo-backfill-dryrun"
          >
            {running === "dry" ? "Scanning…" : "Dry run (scan only)"}
          </button>
          <button
            type="button"
            style={primaryButtonStyle}
            disabled={!memoryAgentConfigured || running !== null}
            onClick={() => trigger(false)}
            data-testid="quipo-backfill-run"
          >
            {running === "real" ? "Running…" : "Run backfill now"}
          </button>
          {!memoryAgentConfigured ? (
            <span style={helpTextStyle}>Configure a Memory Agent above to enable backfill.</span>
          ) : null}
        </div>
        {error ? <div style={errorStyle}>{error}</div> : null}
        {result ? (
          <div style={helpTextStyle}>
            {result.dryRun ? "Dry run · " : "Backfill · "}
            queued {result.queued ?? 0}, already-extracted {result.alreadyExtracted ?? 0}, scanned{" "}
            {result.commentsScanned ?? 0} comments across {result.issuesScanned ?? 0} issues
            {result.truncated ? " (truncated; raise the cap to scan more)" : ""}.
            {result.reason ? ` Reason: ${result.reason}.` : ""}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default QuipoSettingsPage;
