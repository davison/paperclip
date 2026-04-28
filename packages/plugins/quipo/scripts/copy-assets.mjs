// Copies non-TS assets the library entrypoints depend on at runtime.
// Currently: the canonical AGENTS.md for the memory-worker template, which
// `template.ts` reads via fs.readFileSync at module load.

import { mkdir, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");

const assets = [
  {
    from: path.join(pkgRoot, "src/agent-templates/memory-worker/AGENTS.md"),
    to: path.join(pkgRoot, "dist/lib/agent-templates/memory-worker/AGENTS.md"),
  },
];

for (const a of assets) {
  await mkdir(path.dirname(a.to), { recursive: true });
  await copyFile(a.from, a.to);
  console.log(`copied ${path.relative(pkgRoot, a.from)} -> ${path.relative(pkgRoot, a.to)}`);
}
