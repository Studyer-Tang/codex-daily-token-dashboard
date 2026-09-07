import { mkdtemp, mkdir, writeFile, readdir, readFile, rm } from "node:fs/promises";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("../", import.meta.url));
const temp = await mkdtemp(path.join(os.tmpdir(), "dashboard-package-smoke-"));
let child;
try {
  execFileSync("powershell.exe", ["-NoProfile", "-Command", "Expand-Archive -LiteralPath $env:SMOKE_ZIP -DestinationPath $env:SMOKE_OUTPUT"], {
    env: { ...process.env, SMOKE_ZIP: path.join(project, "dist", "CodexTokenWidget-windows-x64.zip"), SMOKE_OUTPUT: temp },
  });
  const packaged = path.join(temp, "CodexTokenWidget");
  const bundledNode = path.join(packaged, "runtime", "node.exe");
  const codex = path.join(temp, "synthetic-codex");
  const cache = path.join(temp, "synthetic-cache");
  await mkdir(path.join(codex, "sessions"), {recursive:true});
  await writeFile(path.join(codex, "sessions", "rollout-smoke.jsonl"), JSON.stringify({
    type: "event_msg", timestamp: new Date().toISOString(),
    payload: {type:"token_count", turn_id:"test", info:{last_token_usage:{input_tokens:123,total_tokens:123}}},
  }));
  const env = { ...process.env, CODEX_HOME: codex, CODEX_TOKEN_CACHE_DIR: cache, CODEX_TOKEN_PORT: "0",
    CODEX_TOKEN_PARENT_PID: "", CODEX_TOKEN_AUTH_TOKEN: "e".repeat(64) };
  child = spawn(bundledNode, ["server.mjs"], {cwd:packaged, env, stdio:["ignore","pipe","pipe"]});
  let errors = "";
  child.stderr.on("data", chunk => { errors += chunk; });
  const exited = once(child, "exit");
  await Promise.race([once(child.stdout, "data"), exited.then(() => {throw Error(errors);})]);
  let entry;
  for (let i=0; i<100; i++) {
    try {
      const names = await readdir(path.join(cache,"servers"));
      if (names.length) { entry = JSON.parse(await readFile(path.join(cache,"servers",names[0]),"utf8")); break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve,20));
  }
  assert.ok(entry, "Server registry missing");
  const origin = "http://127.0.0.1:" + entry.port;
  const html = await (await fetch(origin)).text();
  const token = html.match(/name="dashboard-token" content="([a-f0-9]+)"/)?.[1];
  assert.equal(token, entry.token);
  const response = await fetch(origin + "/api/usage?taskDetail=summary", {headers:{"X-Codex-Token":token},signal:AbortSignal.timeout(10000)});
  const summary = await response.json();
  assert.equal(response.status,200,JSON.stringify(summary));
  assert.equal(summary.today.totalTokens,123);
  assert.equal("turns" in summary.tasks[0],false);
  const detail = await (await fetch(origin + "/api/usage?task=" + summary.tasks[0].id, {headers:{"X-Codex-Token":token}})).json();
  assert.equal(detail.tasks[0].turns[0].totalTokens,123);
  const stop = spawn(bundledNode, ["scripts/stop-dashboard.mjs"], {cwd:packaged,env,stdio:"ignore"});
  assert.equal((await once(stop,"exit"))[0],0);
  assert.equal((await exited)[0],0);
  console.log("Packaged bundled runtime smoke passed: launch, auth, real worker, totals, details, graceful stop.");
} finally {
  if (child && child.exitCode === null) { child.kill(); await once(child,"exit").catch(()=>{}); }
  await rm(temp,{recursive:true,force:true});
}
