import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveManifestPath } from "../services/plugin-loader.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempPluginDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-plugin-loader-"));
  tempDirs.push(dir);
  return dir;
}

describe("resolveManifestPath — package-root containment", () => {
  it("resolves a manifest path inside the package root", () => {
    const pluginDir = makeTempPluginDir();
    mkdirSync(path.join(pluginDir, "dist"), { recursive: true });
    writeFileSync(path.join(pluginDir, "dist", "manifest.js"), "");
    const pkgJson = { paperclipPlugin: { manifest: "dist/manifest.js" } };
    const resolved = resolveManifestPath(pluginDir, pkgJson);
    expect(resolved).toBe(path.resolve(pluginDir, "dist", "manifest.js"));
  });

  it("refuses a manifest path that escapes the package root with ..", () => {
    const parent = makeTempPluginDir();
    const pluginDir = path.join(parent, "pkg");
    mkdirSync(pluginDir, { recursive: true });
    const pkgJson = {
      paperclipPlugin: { manifest: "../sibling/manifest.js" },
    };
    const resolved = resolveManifestPath(pluginDir, pkgJson);
    expect(resolved).toBeNull();
  });

  it("refuses an absolute manifest path that does not live under the package root", () => {
    const pluginDir = makeTempPluginDir();
    const elsewhere = makeTempPluginDir();
    const pkgJson = {
      paperclipPlugin: {
        manifest: path.join(elsewhere, "manifest.js"),
      },
    };
    const resolved = resolveManifestPath(pluginDir, pkgJson);
    expect(resolved).toBeNull();
  });

  it("falls back to dist/manifest.js when paperclipPlugin.manifest is absent", () => {
    const pluginDir = makeTempPluginDir();
    mkdirSync(path.join(pluginDir, "dist"), { recursive: true });
    writeFileSync(path.join(pluginDir, "dist", "manifest.js"), "");
    const pkgJson = {};
    const resolved = resolveManifestPath(pluginDir, pkgJson);
    expect(resolved).toBe(path.join(pluginDir, "dist", "manifest.js"));
  });

  it("returns null when no manifest pointer or fallback exists", () => {
    const pluginDir = makeTempPluginDir();
    const pkgJson = {};
    expect(resolveManifestPath(pluginDir, pkgJson)).toBeNull();
  });
});
