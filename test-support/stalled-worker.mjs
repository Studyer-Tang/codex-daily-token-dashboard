import { parentPort } from "node:worker_threads";

parentPort.on("message", () => {
  // Deliberately never reply so timeout and worker-reset behavior can be tested.
});
