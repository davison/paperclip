import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Regression for QA finding #1 (RED-108): the `@paperclipai/plugin-quipo`
// public barrel must be resolvable as a package. The `tsc -p
// tsconfig.build.json && copy-assets` build step emits `dist/lib/` and
// package.json declares the matching `exports` map. This test inspects the
// declared package contract from package.json so the contract is asserted
// regardless of whether `dist/lib/` happens to be built in the current
// invocation (the build itself is a separate verification step).

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const pkgJson = JSON.parse(readFileSync(path.join(pkgRoot, "package.json"), "utf8")) as {
  main?: string;
  types?: string;
  exports?: Record<string, unknown>;
  files?: string[];
  scripts?: Record<string, string>;
};

describe("@paperclipai/plugin-quipo package wiring", () => {
  it("declares main + types pointing at the lib bundle", () => {
    expect(pkgJson.main).toBe("./dist/lib/index.js");
    expect(pkgJson.types).toBe("./dist/lib/index.d.ts");
  });

  it("declares an `exports` map covering the public API surface", () => {
    expect(pkgJson.exports).toBeDefined();
    const exp = pkgJson.exports!;

    // Root entrypoint — what RED-99/RED-101/RED-103 import as
    // `@paperclipai/plugin-quipo`.
    expect(exp["."]).toEqual({
      types: "./dist/lib/index.d.ts",
      import: "./dist/lib/index.js",
    });

    // Sub-paths so callers can grab just the prompts module / agent template
    // without dragging in the rest.
    expect(exp["./prompts"]).toEqual({
      types: "./dist/lib/prompts/extract-facts.d.ts",
      import: "./dist/lib/prompts/extract-facts.js",
    });
    expect(exp["./agent-templates/memory-worker"]).toEqual({
      types: "./dist/lib/agent-templates/memory-worker/template.d.ts",
      import: "./dist/lib/agent-templates/memory-worker/template.js",
    });
  });

  it("ships the lib bundle (and the canonical AGENTS.md) in the published `files` list", () => {
    expect(pkgJson.files).toContain("dist");
    // AGENTS.md lives in src/agent-templates and is also copied into
    // dist/lib via scripts/copy-assets.mjs at build time, so shipping
    // either is acceptable. We assert at least one of the two paths.
    const filesList = pkgJson.files ?? [];
    const hasMarkdown =
      filesList.includes("src/agent-templates") ||
      filesList.includes("dist/lib/agent-templates");
    expect(hasMarkdown).toBe(true);
  });

  it("build script emits the lib bundle and copies non-TS assets", () => {
    const build = pkgJson.scripts?.build ?? "";
    expect(build).toMatch(/tsc\s+-p\s+tsconfig\.build\.json/);
    expect(build).toMatch(/copy-assets/);
  });
});
