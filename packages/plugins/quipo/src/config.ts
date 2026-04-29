export const QUIPO_PLUGIN_ID = "paperclipai.plugin-quipo" as const;

export const QUIPO_EXTRACTION_SCOPES = [
  "comments_and_updates",
  "comments_only",
] as const;

export type QuipoExtractionScope = (typeof QUIPO_EXTRACTION_SCOPES)[number];

export const QUIPO_DEFAULTS = {
  enabled: false,
  memoryAgentId: null as string | null,
  extractionScope: "comments_and_updates" as QuipoExtractionScope,
};

export interface QuipoConfig {
  enabled: boolean;
  memoryAgentId: string | null;
  extractionScope: QuipoExtractionScope;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  return fallback;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readExtractionScope(value: unknown): QuipoExtractionScope {
  if (typeof value !== "string") return QUIPO_DEFAULTS.extractionScope;
  const trimmed = value.trim();
  return (QUIPO_EXTRACTION_SCOPES as readonly string[]).includes(trimmed)
    ? (trimmed as QuipoExtractionScope)
    : QUIPO_DEFAULTS.extractionScope;
}

export function readQuipoConfig(raw: Record<string, unknown> | null | undefined): QuipoConfig {
  if (!raw) {
    return { ...QUIPO_DEFAULTS };
  }
  return {
    enabled: readBoolean(raw.enabled, QUIPO_DEFAULTS.enabled),
    memoryAgentId: readNonEmptyString(raw.memoryAgentId),
    extractionScope: readExtractionScope(raw.extractionScope),
  };
}
