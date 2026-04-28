/**
 * Helpers shared by every Quipo plugin tool.
 *
 * The plugin worker receives a runtime PostgreSQL schema name from
 * `ctx.db.namespace` (host-derived per plugin install — for production
 * this resolves to `plugin_quipo_d14f4ce0c0`; the in-memory test harness
 * passes a different value). Schema names cannot be parameterised in PG,
 * so we validate against a strict identifier pattern before interpolating.
 *
 * If an attacker controlled the namespace they would already control the
 * plugin install, but the validation also serves as a self-test against
 * future SDK changes that pass an unexpected value.
 */

const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export function assertSafeNamespace(namespace: string): string {
  if (typeof namespace !== "string" || namespace.length === 0) {
    throw new Error("quipo-tools: ctx.db.namespace is empty");
  }
  if (namespace.length > 63) {
    throw new Error("quipo-tools: ctx.db.namespace exceeds PostgreSQL identifier length");
  }
  if (!SAFE_IDENTIFIER.test(namespace)) {
    throw new Error(
      `quipo-tools: ctx.db.namespace ${JSON.stringify(namespace)} is not a safe SQL identifier`,
    );
  }
  return namespace;
}

/** Validates the namespace and returns a `"<ns>"."<table>"` qualifier. */
export function qualify(namespace: string, table: string): string {
  assertSafeNamespace(namespace);
  if (!SAFE_IDENTIFIER.test(table)) {
    throw new Error(`quipo-tools: unsafe table name ${JSON.stringify(table)}`);
  }
  return `${namespace}.${table}`;
}
