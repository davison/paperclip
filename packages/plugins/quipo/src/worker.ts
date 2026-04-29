import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

import { registerQuipoBackfillAction } from "./backfill.js";
import { registerQuipoEventHandlers } from "./event-handlers.js";
import { registerQuipoTools } from "./tools/index.js";

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("Quipo memory plugin started", {
      namespace: ctx.db.namespace,
    });
    registerQuipoEventHandlers(ctx);
    registerQuipoTools(ctx);
    registerQuipoBackfillAction(ctx);
  },

  async onHealth() {
    return { status: "ok" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
