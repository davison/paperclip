import path from "node:path";
import { describe, expect, it } from "vitest";
import { isManifestWithinPackageRoot } from "../services/plugin-loader.js";

describe("isManifestWithinPackageRoot", () => {
  const root = "/srv/plugins/paperclip-plugin-foo";

  it("accepts a manifest at the package root", () => {
    expect(isManifestWithinPackageRoot(root, path.join(root, "manifest.js"))).toBe(true);
  });

  it("accepts a manifest in a subdirectory", () => {
    expect(
      isManifestWithinPackageRoot(root, path.join(root, "dist", "manifest.js")),
    ).toBe(true);
  });

  it("accepts the package root itself", () => {
    expect(isManifestWithinPackageRoot(root, root)).toBe(true);
  });

  it("normalises redundant segments inside the root", () => {
    expect(
      isManifestWithinPackageRoot(root, path.join(root, "dist", "..", "manifest.js")),
    ).toBe(true);
  });

  it("rejects a manifest that escapes via parent traversal", () => {
    expect(
      isManifestWithinPackageRoot(
        root,
        path.join(root, "..", "..", "etc", "evil.js"),
      ),
    ).toBe(false);
  });

  it("rejects an absolute path outside the package root", () => {
    expect(isManifestWithinPackageRoot(root, "/etc/evil.js")).toBe(false);
  });

  it("rejects sibling directories that share a prefix", () => {
    expect(
      isManifestWithinPackageRoot(root, "/srv/plugins/paperclip-plugin-foo-evil/manifest.js"),
    ).toBe(false);
  });
});
