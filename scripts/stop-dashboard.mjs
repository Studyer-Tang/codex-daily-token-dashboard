import { readFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applicationCacheDirectory } from "../src/usage.mjs";

const serverPath = fileURLToPath(new URL("../server.mjs", import.meta.url));
const registry = path.join(applicationCacheDirectory(), "servers");
let stopped = 0, managed = 0, failed = 0;
for (const name of await readdir(registry).catch(error => {
  if (error.code === "ENOENT") return [];
  throw error;
})) {
  if (!/^\d+\.json$/.test(name)) continue;
  const file = path.join(registry, name);
  try {
    const entry = JSON.parse(await readFile(file, "utf8"));
    if (path.resolve(entry.serverPath).toLowerCase() !== serverPath.toLowerCase()) continue;
    if (!Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535 || !/^[a-f0-9]{64}$/i.test(entry.token)) continue;
    const origin = "http://127.0.0.1:" + entry.port;
    const options = { headers: { "X-Codex-Token": entry.token }, signal: AbortSignal.timeout(2500) };
    const response = await fetch(origin + "/api/health", options);
    const health = await response.json();
    if (!response.ok || !health.authorized || health.service !== "codex-daily-token-dashboard" || health.instanceId !== entry.instanceId) {
      failed++; continue; // Never kill an unrelated listener or trust a recycled PID.
    }
    if (entry.parentPid) { managed++; continue; }
    const stop = await fetch(origin + "/api/shutdown", { ...options, method: "POST", signal: AbortSignal.timeout(2500) });
    if (!stop.ok) { failed++; continue; }
    stopped++;
    await unlink(file).catch(() => {});
  } catch { failed++; }
}
console.log("Stopped dashboards: " + stopped);
if (managed) console.log("Widget-managed services: " + managed + ". Exit the widget from its tray menu.");
if (failed) { console.error("Unreachable or unverified entries: " + failed + ". No process was forcibly killed."); process.exitCode = 1; }
