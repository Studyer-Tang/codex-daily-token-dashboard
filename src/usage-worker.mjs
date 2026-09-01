import { parentPort } from "node:worker_threads";

import { collectUsage } from "./usage.mjs";

if (!parentPort) throw new Error("usage-worker must run inside a Worker");

parentPort.on("message", async ({ id, days }) => {
  try {
    parentPort.postMessage({ id, usage: await collectUsage({ days }) });
  } catch (error) {
    parentPort.postMessage({
      id,
      error: {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : "",
      },
    });
  }
});
