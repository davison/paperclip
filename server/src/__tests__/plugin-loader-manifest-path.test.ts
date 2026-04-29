import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

  it("refuses an in-root symlink that dereferences outside the package root", () => {
    const pluginDir = makeTempPluginDir();
    const elsewhere = makeTempPluginDir();
    // Real manifest module sitting outside the plugin package.
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(path.join(elsewhere, "manifest.js"), "");
    // In-root symlink whose lexical path stays inside pluginDir but whose
    // realpath dereferences out to `elsewhere`. Lexical containment passes;
    // canonical containment must fail.
    symlinkSync(elsewhere, path.join(pluginDir, "escape-link"), "dir");
    const pkgJson = {
      paperclipPlugin: { manifest: "escape-link/manifest.js" },
    };
    const resolved = resolveManifestPath(pluginDir, pkgJson);
    expect(resolved).toBeNull();
  });

  it("refuses a direct in-root file symlink that points to a file outside the package root", () => {
    const pluginDir = makeTempPluginDir();
    const elsewhere = makeTempPluginDir();
    const outsideManifest = path.join(elsewhere, "manifest.js");
    writeFileSync(outsideManifest, "");
    // Single-file symlink rather than a directory symlink.
    symlinkSync(outsideManifest, path.join(pluginDir, "manifest.js"), "file");
    const pkgJson = { paperclipPlugin: { manifest: "manifest.js" } };
    const resolved = resolveManifestPath(pluginDir, pkgJson);
    expect(resolved).toBeNull();
  });

  it("accepts an in-root symlink that dereferences to another in-root location", () => {
    const pluginDir = makeTempPluginDir();
    // Real target also inside the plugin package: dist/ with a manifest.
    const realDist = path.join(pluginDir, "dist");
    mkdirSync(realDist, { recursive: true });
    writeFileSync(path.join(realDist, "manifest.js"), "");
    // Symlink at pluginDir/built -> pluginDir/dist (both inside package root).
    symlinkSync(realDist, path.join(pluginDir, "built"), "dir");
    const pkgJson = { paperclipPlugin: { manifest: "built/manifest.js" } };
    const resolved = resolveManifestPath(pluginDir, pkgJson);
    // Returned path is the lexical, caller-facing candidate (not canonicalized);
    // the trust-boundary check is what runs against canonical paths.
    expect(resolved).toBe(path.resolve(pluginDir, "built", "manifest.js"));
  });

  it("rejects an in-root symlink to outside even when used via the dist/manifest.js fallback", () => {
    // Operator builds the package and a hostile post-install step swaps
    // dist/manifest.js for a symlink that points outside the package.
    // Even with no paperclipPlugin.manifest pointer, the fallback must not
    // import through the symlink.
    const pluginDir = makeTempPluginDir();
    const elsewhere = makeTempPluginDir();
    const outsideManifest = path.join(elsewhere, "manifest.js");
    writeFileSync(outsideManifest, "");
    mkdirSync(path.join(pluginDir, "dist"), { recursive: true });
    symlinkSync(
      outsideManifest,
      path.join(pluginDir, "dist", "manifest.js"),
      "file",
    );
    const pkgJson = {}; // no paperclipPlugin → triggers dist/ fallback
    const resolved = resolveManifestPath(pluginDir, pkgJson);
    expect(resolved).toBeNull();
  });

  it("normalizes /tmp vs /private/tmp on macOS without breaking containment", () => {
    // Defensive cross-platform: on macOS, `os.tmpdir()` returns `/var/folders/...`
    // but historically `/tmp` is a symlink to `/private/tmp`. We don't rely on
    // that here — just make sure that whether or not the temp dir we create
    // is a symlink, an in-root manifest still resolves successfully.
    const pluginDir = makeTempPluginDir();
    const realPluginDir = realpathSync(pluginDir);
    mkdirSync(path.join(pluginDir, "dist"), { recursive: true });
    writeFileSync(path.join(pluginDir, "dist", "manifest.js"), "");
    const pkgJson = { paperclipPlugin: { manifest: "dist/manifest.js" } };
    const resolved = resolveManifestPath(pluginDir, pkgJson);
    expect(resolved).toBe(path.resolve(pluginDir, "dist", "manifest.js"));
    // And the canonicalized form must still be inside the canonical root —
    // the trust-boundary invariant the loader actually enforces.
    expect(realpathSync(resolved!).startsWith(realPluginDir)).toBe(true);
  });
});
