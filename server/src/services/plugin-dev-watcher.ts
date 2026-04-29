/**
 * PluginDevWatcher — watches local-path plugin directories for file changes
 * and triggers worker restarts so plugin authors get a fast rebuild-and-reload
 * cycle without manually restarting the server.
 *
 * Only plugins installed from a local path (i.e. those with a non-null
 * `packagePath` in the DB) are watched. File changes in the plugin's package
 * directory trigger a debounced worker restart via the lifecycle manager.
 *
 * Uses chokidar rather than raw fs.watch so we get a production-grade watcher
 * backend across platforms and avoid exhausting file descriptors as quickly in
 * large dev workspaces.
 *
 * @see PLUGIN_SPEC.md §27.2 — Local Development Workflow
 */
import chokidar, { type FSWatcher } from "chokidar";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { logger } from "../middleware/logger.js";
import type { PluginLifecycleManager } from "./plugin-lifecycle.js";

const log = logger.child({ service: "plugin-dev-watcher" });

/** Debounce interval for file changes (ms). */
const DEBOUNCE_MS = 500;

export interface PluginDevWatcher {
  /** Start watching a local-path plugin directory. */
  watch(pluginId: string, packagePath: string): void;
  /** Stop watching a specific plugin. */
  unwatch(pluginId: string): void;
  /** Stop all watchers and clean up. */
  close(): void;
}

export type ResolvePluginPackagePath = (
  pluginId: string,
) => Promise<string | null | undefined>;

export interface PluginDevWatcherFsDeps {
  existsSync?: typeof existsSync;
  readFileSync?: typeof readFileSync;
  readdirSync?: typeof readdirSync;
  statSync?: typeof statSync;
}

type PluginWatchTarget = {
  path: string;
  recursive: boolean;
  kind: "file" | "dir";
};

type PluginPackageJson = {
  paperclipPlugin?: {
    manifest?: string;
    worker?: string;
    ui?: string;
  };
};

function shouldIgnorePath(filename: string | null | undefined): boolean {
  if (!filename) return false;
  const normalized = filename.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  return segments.some(
    (segment) =>
      segment === "node_modules" ||
      segment === ".git" ||
      segment === ".vite" ||
      segment === ".paperclip-sdk" ||
      segment.startsWith("."),
  );
}

export function resolvePluginWatchTargets(
  packagePath: string,
  fsDeps?: Pick<PluginDevWatcherFsDeps, "existsSync" | "readFileSync" | "readdirSync" | "statSync">,
): PluginWatchTarget[] {
  const fileExists = fsDeps?.existsSync ?? existsSync;
  const readFile = fsDeps?.readFileSync ?? readFileSync;
  const readDir = fsDeps?.readdirSync ?? readdirSync;
  const statFile = fsDeps?.statSync ?? statSync;
  const absPath = path.resolve(packagePath);
  const targets = new Map<string, PluginWatchTarget>();

  function addWatchTarget(targetPath: string, recursive: boolean, kind?: "file" | "dir"): void {
    const resolved = path.resolve(targetPath);
    if (!fileExists(resolved)) return;
    const inferredKind = kind ?? (statFile(resolved).isDirectory() ? "dir" : "file");

    const existing = targets.get(resolved);
    if (existing) {
      existing.recursive = existing.recursive || recursive;
      return;
    }

    targets.set(resolved, { path: resolved, recursive, kind: inferredKind });
  }

  function addRuntimeFilesFromDir(dirPath: string): void {
    if (!fileExists(dirPath)) return;

    for (const entry of readDir(dirPath, { withFileTypes: true })) {
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        addRuntimeFilesFromDir(entryPath);
        continue;
      }

      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".js") && !entry.name.endsWith(".css")) continue;
      addWatchTarget(entryPath, false, "file");
    }
  }

  const packageJsonPath = path.join(absPath, "package.json");
  addWatchTarget(packageJsonPath, false, "file");
  if (!fileExists(packageJsonPath)) {
    return [...targets.values()];
  }

  let packageJson: PluginPackageJson | null = null;
  try {
    packageJson = JSON.parse(readFile(packageJsonPath, "utf8")) as PluginPackageJson;
  } catch {
    packageJson = null;
  }

  const entrypointPaths = [
    packageJson?.paperclipPlugin?.manifest,
    packageJson?.paperclipPlugin?.worker,
    packageJson?.paperclipPlugin?.ui,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  if (entrypointPaths.length === 0) {
    addRuntimeFilesFromDir(path.join(absPath, "dist"));
    return [...targets.values()];
  }

  for (const relativeEntrypoint of entrypointPaths) {
    const resolvedEntrypoint = path.resolve(absPath, relativeEntrypoint);
    if (!fileExists(resolvedEntrypoint)) continue;

    const stat = statFile(resolvedEntrypoint);
    if (stat.isDirectory()) {
      addRuntimeFilesFromDir(resolvedEntrypoint);
    } else {
      addWatchTarget(resolvedEntrypoint, false, "file");
    }
  }

  return [...targets.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Resolve the absolute path of a plugin's manifest entrypoint from its
 * package.json `paperclipPlugin.manifest` field. Returns null if the field is
 * missing, the file does not exist, or the entry resolves to a directory.
 *
 * Watchers use this to distinguish a manifest-file change (which requires a
 * full plugin re-activation so host-side capability validators, tool
 * registrations, event subscriptions, jobs, and webhooks are rebuilt) from a
 * worker/UI change (where a worker restart is sufficient).
 */
export function resolvePluginManifestEntry(
  packagePath: string,
  fsDeps?: Pick<PluginDevWatcherFsDeps, "existsSync" | "readFileSync" | "statSync">,
): string | null {
  const fileExists = fsDeps?.existsSync ?? existsSync;
  const readFile = fsDeps?.readFileSync ?? readFileSync;
  const statFile = fsDeps?.statSync ?? statSync;
  const absPath = path.resolve(packagePath);

  const packageJsonPath = path.join(absPath, "package.json");
  if (!fileExists(packageJsonPath)) return null;

  let packageJson: PluginPackageJson | null = null;
  try {
    packageJson = JSON.parse(readFile(packageJsonPath, "utf8")) as PluginPackageJson;
  } catch {
    return null;
  }

  const manifestRel = packageJson?.paperclipPlugin?.manifest;
  if (typeof manifestRel !== "string" || manifestRel.length === 0) return null;

  const resolved = path.resolve(absPath, manifestRel);
  if (!fileExists(resolved)) return null;
  if (statFile(resolved).isDirectory()) return null;
  return resolved;
}

/**
 * Create a PluginDevWatcher that monitors local plugin directories and
 * restarts workers on file changes.
 */
export function createPluginDevWatcher(
  lifecycle: PluginLifecycleManager,
  resolvePluginPackagePath?: ResolvePluginPackagePath,
  fsDeps?: PluginDevWatcherFsDeps,
): PluginDevWatcher {
  const watchers = new Map<string, FSWatcher>();
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const manifestPaths = new Map<string, string>();
  const pendingChangedPaths = new Map<string, Set<string>>();
  const fileExists = fsDeps?.existsSync ?? existsSync;

  /** Per-plugin: remember the absolute package path so we can re-resolve targets later. */
  const packagePaths = new Map<string, string>();
  /** Per-plugin: remember the resolved package.json absolute path so we can detect package.json edits. */
  const packageJsonPaths = new Map<string, string>();

  function startWatcher(pluginId: string, absPath: string): boolean {
    const watcherTargets = resolvePluginWatchTargets(absPath, fsDeps);
    if (watcherTargets.length === 0) {
      log.warn(
        { pluginId, packagePath: absPath },
        "plugin-dev-watcher: no valid watch targets found, skipping watch",
      );
      return false;
    }

    const manifestEntry = resolvePluginManifestEntry(absPath, fsDeps);
    if (manifestEntry) {
      manifestPaths.set(pluginId, manifestEntry);
    } else {
      manifestPaths.delete(pluginId);
    }
    packageJsonPaths.set(pluginId, path.resolve(path.join(absPath, "package.json")));

    const watcher = chokidar.watch(
      watcherTargets.map((target) => target.path),
      {
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: 200,
          pollInterval: 100,
        },
        ignored: (watchedPath) => {
          const relativePath = path.relative(absPath, watchedPath);
          return shouldIgnorePath(relativePath);
        },
      },
    );

    watcher.on("all", (_eventName, changedPath) => {
      const relativePath = path.relative(absPath, changedPath);
      if (shouldIgnorePath(relativePath)) return;

      const resolvedChangedPath = path.resolve(changedPath);
      let pending = pendingChangedPaths.get(pluginId);
      if (!pending) {
        pending = new Set<string>();
        pendingChangedPaths.set(pluginId, pending);
      }
      pending.add(resolvedChangedPath);

      const existing = debounceTimers.get(pluginId);
      if (existing) clearTimeout(existing);

      debounceTimers.set(
        pluginId,
        setTimeout(() => {
          debounceTimers.delete(pluginId);
          const changedPaths = pendingChangedPaths.get(pluginId) ?? new Set<string>();
          pendingChangedPaths.delete(pluginId);
          const changedFile = relativePath || path.basename(changedPath);

          // If package.json itself changed, the manifest pointer (or worker/ui pointers) may have moved.
          // Re-resolve the manifest entry and watch-targets, and if anything changed, rebuild the
          // watcher so subsequent edits to the new manifest path are observed.
          const packageJsonPath = packageJsonPaths.get(pluginId);
          const packageJsonChanged = packageJsonPath
            ? changedPaths.has(packageJsonPath)
            : false;

          let manifestPointerChanged = false;
          if (packageJsonChanged) {
            const previousManifestEntry = manifestPaths.get(pluginId) ?? null;
            const newManifestEntry = resolvePluginManifestEntry(absPath, fsDeps);

            const previousTargets = new Set(
              resolvePluginWatchTargetsFromCache(pluginId),
            );
            const newTargetsList = resolvePluginWatchTargets(absPath, fsDeps);
            const newTargets = new Set(newTargetsList.map((t) => t.path));
            const targetsDiffer =
              previousTargets.size !== newTargets.size ||
              ![...newTargets].every((p) => previousTargets.has(p));

            if (newManifestEntry !== previousManifestEntry || targetsDiffer) {
              manifestPointerChanged = true;
              log.info(
                {
                  pluginId,
                  previousManifestEntry,
                  newManifestEntry,
                  targetsDiffer,
                },
                "plugin-dev-watcher: package.json changed manifest/watch targets, rebuilding watcher",
              );
              cachedTargets.set(pluginId, [...newTargets]);
              if (newManifestEntry) {
                manifestPaths.set(pluginId, newManifestEntry);
              } else {
                manifestPaths.delete(pluginId);
              }
              const existingWatcher = watchers.get(pluginId);
              if (existingWatcher) {
                void existingWatcher.close();
                watchers.delete(pluginId);
              }
              const restarted = startWatcher(pluginId, absPath);
              if (!restarted) {
                log.warn(
                  { pluginId, packagePath: absPath },
                  "plugin-dev-watcher: rebuild yielded no targets; plugin no longer watched",
                );
              }
            }
          }

          const manifestPath = manifestPaths.get(pluginId);
          const manifestChanged =
            manifestPointerChanged ||
            (manifestPath ? changedPaths.has(manifestPath) : false);

          if (manifestChanged) {
            log.info(
              { pluginId, changedFile, manifestPath, manifestPointerChanged },
              "plugin-dev-watcher: manifest change detected, reactivating plugin",
            );
            reactivatePlugin(pluginId).catch((err) => {
              log.error(
                {
                  pluginId,
                  err: err instanceof Error ? err.message : String(err),
                  recoveryAction: "manual_enable_required",
                },
                "plugin-dev-watcher: reactivation failed; plugin may be left disabled — operator action required",
              );
            });
            return;
          }

          log.info(
            { pluginId, changedFile },
            "plugin-dev-watcher: file change detected, restarting worker",
          );

          lifecycle.restartWorker(pluginId).catch((err) => {
            log.warn(
              {
                pluginId,
                err: err instanceof Error ? err.message : String(err),
              },
              "plugin-dev-watcher: failed to restart worker after file change",
            );
          });
        }, DEBOUNCE_MS),
      );
    });

    watcher.on("error", (err) => {
      log.warn(
        {
          pluginId,
          packagePath: absPath,
          err: err instanceof Error ? err.message : String(err),
        },
        "plugin-dev-watcher: watcher error, stopping watch for this plugin",
      );
      unwatchPlugin(pluginId);
    });

    watchers.set(pluginId, watcher);
    cachedTargets.set(
      pluginId,
      watcherTargets.map((target) => target.path),
    );
    log.info(
      {
        pluginId,
        packagePath: absPath,
        watchTargets: watcherTargets.map((target) => ({
          path: target.path,
          kind: target.kind,
        })),
      },
      "plugin-dev-watcher: watching local plugin for changes",
    );
    return true;
  }

  /** Cache of last-resolved watch target paths per plugin (for diff on package.json change). */
  const cachedTargets = new Map<string, string[]>();

  function resolvePluginWatchTargetsFromCache(pluginId: string): string[] {
    return cachedTargets.get(pluginId) ?? [];
  }

  function watchPlugin(pluginId: string, packagePath: string): void {
    // Don't double-watch
    if (watchers.has(pluginId)) return;

    const absPath = path.resolve(packagePath);
    if (!fileExists(absPath)) {
      log.warn(
        { pluginId, packagePath: absPath },
        "plugin-dev-watcher: package path does not exist, skipping watch",
      );
      return;
    }

    packagePaths.set(pluginId, absPath);

    try {
      startWatcher(pluginId, absPath);
    } catch (err) {
      log.warn(
        {
          pluginId,
          packagePath: absPath,
          err: err instanceof Error ? err.message : String(err),
        },
        "plugin-dev-watcher: failed to start file watcher",
      );
    }
  }

  function unwatchPlugin(pluginId: string): void {
    const pluginWatcher = watchers.get(pluginId);
    if (pluginWatcher) {
      void pluginWatcher.close();
      watchers.delete(pluginId);
    }
    const timer = debounceTimers.get(pluginId);
    if (timer) {
      clearTimeout(timer);
      debounceTimers.delete(pluginId);
    }
    manifestPaths.delete(pluginId);
    pendingChangedPaths.delete(pluginId);
    packageJsonPaths.delete(pluginId);
    packagePaths.delete(pluginId);
    cachedTargets.delete(pluginId);
  }

  /**
   * Full plugin reactivation cycle: disable → enable.
   *
   * Used for manifest changes so the lifecycle re-runs activation, which
   * rebuilds host-side capability validators, re-registers tools/jobs/event
   * subscriptions/webhooks, and spawns a fresh worker. This is heavier than
   * `restartWorker` (worker process only) but is the right granularity when
   * the manifest itself has changed.
   *
   * Note: this does not re-read the manifest from disk into the DB — the
   * lifecycle activates from `plugin.manifestJson` (DB-cached). To pick up
   * manifest schema changes (new tools, capabilities, jobs), reinstall or
   * upgrade the plugin. The startup capability-drift warning surfaces this
   * mismatch when it happens.
   */
  async function reactivatePlugin(pluginId: string): Promise<void> {
    let disableSucceeded = false;
    try {
      await lifecycle.disable(pluginId, "dev-watcher: manifest reload");
      disableSucceeded = true;
    } catch (err) {
      log.warn(
        { pluginId, err: err instanceof Error ? err.message : String(err) },
        "plugin-dev-watcher: disable step of manifest reload failed; attempting enable anyway",
      );
    }

    try {
      await lifecycle.enable(pluginId);
    } catch (err) {
      // If enable fails after a successful disable, the plugin is left in a
      // disabled state with no live runtime. Surface this loudly so an operator
      // can intervene rather than letting it become a silent outage. Emitting
      // an explicit error log (not just a warn) keeps it visible in dashboards
      // and on-disk error tracking.
      log.error(
        {
          pluginId,
          err: err instanceof Error ? err.message : String(err),
          disableSucceeded,
          recoveryAction: "manual_enable_required",
        },
        "plugin-dev-watcher: enable step of manifest reload failed; plugin left disabled",
      );
      throw err;
    }
  }

  function close(): void {
    lifecycle.off("plugin.loaded", handlePluginLoaded);
    lifecycle.off("plugin.enabled", handlePluginEnabled);
    lifecycle.off("plugin.disabled", handlePluginDisabled);
    lifecycle.off("plugin.unloaded", handlePluginUnloaded);

    for (const [pluginId] of watchers) {
      unwatchPlugin(pluginId);
    }
  }

  async function watchLocalPluginById(pluginId: string): Promise<void> {
    if (!resolvePluginPackagePath) return;

    try {
      const packagePath = await resolvePluginPackagePath(pluginId);
      if (!packagePath) return;
      watchPlugin(pluginId, packagePath);
    } catch (err) {
      log.warn(
        {
          pluginId,
          err: err instanceof Error ? err.message : String(err),
        },
        "plugin-dev-watcher: failed to resolve plugin package path",
      );
    }
  }

  function handlePluginLoaded(payload: { pluginId: string }): void {
    void watchLocalPluginById(payload.pluginId);
  }

  function handlePluginEnabled(payload: { pluginId: string }): void {
    void watchLocalPluginById(payload.pluginId);
  }

  function handlePluginDisabled(payload: { pluginId: string }): void {
    unwatchPlugin(payload.pluginId);
  }

  function handlePluginUnloaded(payload: { pluginId: string }): void {
    unwatchPlugin(payload.pluginId);
  }

  lifecycle.on("plugin.loaded", handlePluginLoaded);
  lifecycle.on("plugin.enabled", handlePluginEnabled);
  lifecycle.on("plugin.disabled", handlePluginDisabled);
  lifecycle.on("plugin.unloaded", handlePluginUnloaded);

  return {
    watch: watchPlugin,
    unwatch: unwatchPlugin,
    close,
  };
}
