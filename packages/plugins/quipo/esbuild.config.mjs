import esbuild from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const presets = createPluginBundlerPresets({
  uiEntry: "src/ui/index.tsx",
});
const watch = process.argv.includes("--watch");

const workerCtx = await esbuild.context(presets.esbuild.worker);
const manifestCtx = await esbuild.context(presets.esbuild.manifest);
const uiCtx = presets.esbuild.ui ? await esbuild.context(presets.esbuild.ui) : null;

if (watch) {
  await Promise.all([
    workerCtx.watch(),
    manifestCtx.watch(),
    ...(uiCtx ? [uiCtx.watch()] : []),
  ]);
  console.log("esbuild watch mode enabled for worker, manifest, and UI");
} else {
  await Promise.all([
    workerCtx.rebuild(),
    manifestCtx.rebuild(),
    ...(uiCtx ? [uiCtx.rebuild()] : []),
  ]);
  await Promise.all([
    workerCtx.dispose(),
    manifestCtx.dispose(),
    ...(uiCtx ? [uiCtx.dispose()] : []),
  ]);
}
