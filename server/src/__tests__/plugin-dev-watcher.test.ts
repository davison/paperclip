import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolvePluginManifestEntry,
  resolvePluginWatchTargets,
} from "../services/plugin-dev-watcher.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempPluginDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-plugin-watch-"));
  tempDirs.push(dir);
  return dir;
}

describe("resolvePluginWatchTargets", () => {
  it("watches package metadata plus concrete declared runtime files", () => {
    const pluginDir = makeTempPluginDir();
    mkdirSync(path.join(pluginDir, "dist", "ui"), { recursive: true });
    writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "@acme/example",
        paperclipPlugin: {
          manifest: "./dist/manifest.js",
          worker: "./dist/worker.js",
          ui: "./dist/ui",
        },
      }),
    );
    writeFileSync(path.join(pluginDir, "dist", "manifest.js"), "export default {};\n");
    writeFileSync(path.join(pluginDir, "dist", "worker.js"), "export default {};\n");
    writeFileSync(path.join(pluginDir, "dist", "ui", "index.js"), "export default {};\n");
    writeFileSync(path.join(pluginDir, "dist", "ui", "index.css"), "body {}\n");

    const targets = resolvePluginWatchTargets(pluginDir);

    expect(targets).toEqual([
      { path: path.join(pluginDir, "dist", "manifest.js"), recursive: false, kind: "file" },
      { path: path.join(pluginDir, "dist", "ui", "index.css"), recursive: false, kind: "file" },
      { path: path.join(pluginDir, "dist", "ui", "index.js"), recursive: false, kind: "file" },
      { path: path.join(pluginDir, "dist", "worker.js"), recursive: false, kind: "file" },
      { path: path.join(pluginDir, "package.json"), recursive: false, kind: "file" },
    ]);
  });

  it("resolves the manifest entrypoint to an absolute path", () => {
    const pluginDir = makeTempPluginDir();
    mkdirSync(path.join(pluginDir, "dist"), { recursive: true });
    writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "@acme/example",
        paperclipPlugin: { manifest: "./dist/manifest.js" },
      }),
    );
    writeFileSync(path.join(pluginDir, "dist", "manifest.js"), "export default {};\n");

    expect(resolvePluginManifestEntry(pluginDir)).toBe(
      path.join(pluginDir, "dist", "manifest.js"),
    );
  });

  it("returns null when package.json is missing", () => {
    const pluginDir = makeTempPluginDir();
    expect(resolvePluginManifestEntry(pluginDir)).toBeNull();
  });

  it("returns null when paperclipPlugin.manifest is missing", () => {
    const pluginDir = makeTempPluginDir();
    writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({ name: "@acme/example" }),
    );
    expect(resolvePluginManifestEntry(pluginDir)).toBeNull();
  });

  it("returns null when manifest entry does not exist on disk", () => {
    const pluginDir = makeTempPluginDir();
    writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "@acme/example",
        paperclipPlugin: { manifest: "./dist/manifest.js" },
      }),
    );
    expect(resolvePluginManifestEntry(pluginDir)).toBeNull();
  });

  it("falls back to dist when package metadata does not declare entrypoints", () => {
    const pluginDir = makeTempPluginDir();
    mkdirSync(path.join(pluginDir, "dist", "nested"), { recursive: true });
    writeFileSync(path.join(pluginDir, "package.json"), JSON.stringify({ name: "@acme/example" }));
    writeFileSync(path.join(pluginDir, "dist", "manifest.js"), "export default {};\n");
    writeFileSync(path.join(pluginDir, "dist", "nested", "chunk.js"), "export default {};\n");

    const targets = resolvePluginWatchTargets(pluginDir);

    expect(targets).toEqual([
      { path: path.join(pluginDir, "package.json"), recursive: false, kind: "file" },
      { path: path.join(pluginDir, "dist", "manifest.js"), recursive: false, kind: "file" },
      { path: path.join(pluginDir, "dist", "nested", "chunk.js"), recursive: false, kind: "file" },
    ]);
  });

  it("re-resolves the manifest entry when package.json points it elsewhere", () => {
    const pluginDir = makeTempPluginDir();
    mkdirSync(path.join(pluginDir, "dist"), { recursive: true });
    writeFileSync(path.join(pluginDir, "dist", "manifest.js"), "export default {};\n");
    writeFileSync(path.join(pluginDir, "dist", "manifest-v2.js"), "export default {};\n");
    writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "@acme/example",
        paperclipPlugin: { manifest: "./dist/manifest.js" },
      }),
    );

    expect(resolvePluginManifestEntry(pluginDir)).toBe(
      path.join(pluginDir, "dist", "manifest.js"),
    );

    // Author edits package.json to point manifest at a different file. The dev-watcher
    // relies on this resolver returning the new path so it can rebuild watch targets
    // and refresh the cached manifest pointer rather than continuing to track a stale
    // entrypoint.
    writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "@acme/example",
        paperclipPlugin: { manifest: "./dist/manifest-v2.js" },
      }),
    );

    expect(resolvePluginManifestEntry(pluginDir)).toBe(
      path.join(pluginDir, "dist", "manifest-v2.js"),
    );
  });

  it("re-resolves watch targets when package.json points entrypoints elsewhere", () => {
    const pluginDir = makeTempPluginDir();
    mkdirSync(path.join(pluginDir, "dist"), { recursive: true });
    writeFileSync(path.join(pluginDir, "dist", "manifest.js"), "export default {};\n");
    writeFileSync(path.join(pluginDir, "dist", "worker.js"), "export default {};\n");
    writeFileSync(path.join(pluginDir, "dist", "worker-v2.js"), "export default {};\n");
    writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "@acme/example",
        paperclipPlugin: { manifest: "./dist/manifest.js", worker: "./dist/worker.js" },
      }),
    );

    const initialTargets = resolvePluginWatchTargets(pluginDir).map((t) => t.path);
    expect(initialTargets).toContain(path.join(pluginDir, "dist", "worker.js"));
    expect(initialTargets).not.toContain(path.join(pluginDir, "dist", "worker-v2.js"));

    writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "@acme/example",
        paperclipPlugin: { manifest: "./dist/manifest.js", worker: "./dist/worker-v2.js" },
      }),
    );

    const updatedTargets = resolvePluginWatchTargets(pluginDir).map((t) => t.path);
    expect(updatedTargets).toContain(path.join(pluginDir, "dist", "worker-v2.js"));
    expect(updatedTargets).not.toContain(path.join(pluginDir, "dist", "worker.js"));
  });
});
