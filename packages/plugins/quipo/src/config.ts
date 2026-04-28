export const QUIPO_PLUGIN_ID = "paperclipai.plugin-quipo" as const;

export interface QuipoConfig {
  memoryAgentId: string | null;
}

export function readQuipoConfig(raw: Record<string, unknown> | null | undefined): QuipoConfig {
  if (!raw) return { memoryAgentId: null };
  const candidate = raw.memoryAgentId;
  const memoryAgentId =
    typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : null;
  return { memoryAgentId };
}
