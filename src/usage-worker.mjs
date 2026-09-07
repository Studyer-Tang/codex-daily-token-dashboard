import { parentPort } from "node:worker_threads";

import { collectUsage } from "./usage.mjs";

import { selectUsageDetails } from "./usage-query.mjs";

if (!parentPort) throw new Error("usage-worker must run inside a Worker");

let queue = Promise.resolve();
parentPort.on("message", ({ id, days, options = {} }) => {
  queue = queue.then(async () => {
  try {
    parentPort.postMessage({ id, usage: selectUsageDetails(await collectUsage({ days, forceRefresh: options.forceRefresh }), options) });
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
});
