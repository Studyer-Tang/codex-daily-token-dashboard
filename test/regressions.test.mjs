import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, appendFile, rm, rename, utimes, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import http from "node:http";
import { createUsageCollector, localDayKey } from "../src/usage.mjs";
import { createDashboardServer, selectUsageDetails, UsageWorkerClient } from "../server.mjs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const row = (date, total, { turn = "t", cumulative, last = true } = {}) => JSON.stringify({
  timestamp: date.toISOString(), type: "event_msg",
  payload: { type: "token_count", turn_id: turn, info: {
    ...(last ? { last_token_usage: { input_tokens: total, total_tokens: total } } : {}),
    ...(cumulative == null ? {} : { total_token_usage: { input_tokens: cumulative, total_tokens: cumulative } }),
  }},
});
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dashboard-regression-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessions = path.join(root, "sessions");
  await mkdir(sessions);
  return { root, sessions, file: path.join(sessions, "rollout-test.jsonl"), collect: createUsageCollector({ cacheDirectory: path.join(root, "cache") }) };
}
test("multiple calls per turn survive; identical and unchanged cumulative notifications do not", async t => {
  const { sessions, file, collect } = await fixture(t);
  const now = new Date();
  await writeFile(file, [
    row(now, 100, { cumulative: 100 }),
    row(new Date(+now + 1000), 200, { cumulative: 300 }),
    row(new Date(+now + 1000), 200, { cumulative: 300 }),
    row(new Date(+now + 2000), 200, { cumulative: 300 }),
    row(new Date(+now + 3000), 50, { cumulative: 50 }),
  ].join("\n"));
  const data = await collect({ roots: [sessions], now });
  assert.equal(data.total.totalTokens, 350);
  assert.equal(data.total.events, 3);
  assert.equal(data.tasks[0].turnCount, 1);
});
test("cross-midnight turns and range clipping reconcile exactly with daily buckets", async t => {
  const { sessions, file, collect } = await fixture(t);
  const now = new Date(2026, 8, 7, 12);
  const boundary = new Date(2026, 8, 1, 0);
  await writeFile(file, [row(new Date(+boundary - 1000), 100), row(boundary, 200), row(now, 300)].join("\n"));
  const data = await collect({ days: 7, roots: [sessions], now });
  assert.equal(data.total.totalTokens, 500);
  assert.equal(data.tasks[0].totalTokens, 500);
  assert.equal(data.tasks[0].turnCount, 2);
  for (const day of data.days) assert.equal(day.totalTokens, data.tasks.flatMap(x => x.turns).filter(x => x.day === day.day).reduce((s, x) => s + x.totalTokens, 0));
  assert.equal(data.last30.totalTokens, 600);
  assert.equal(data.activeDays30, 3);
});
test("incremental parser resumes split UTF-8 and partial JSON without rescanning unchanged files", async t => {
  const { sessions, file, collect } = await fixture(t);
  const now = new Date();
  await writeFile(file, row(now, 100) + "\n");
  const a = await collect({ roots: [sessions], now });
  const b = await collect({ roots: [sessions], now });
  assert.equal(b.diagnostics.bytesRead, 0);
  const message = Buffer.from(JSON.stringify({ type: "response_item", payload: { type: "message", role: "user",
    content: [{ type: "input_text", text: "中文研究" }], internal_chat_message_metadata_passthrough: { turn_id: "t" } } }) + "\n");
  const split = message.indexOf(Buffer.from("中")) + 1;
  await appendFile(file, message.subarray(0, 9)); // No recognized type yet.
  await collect({ roots: [sessions], now });
  await appendFile(file, message.subarray(9, split)); // Mid UTF-8 codepoint.
  await collect({ roots: [sessions], now });
  await appendFile(file, message.subarray(split));
  await appendFile(file, row(new Date(+now + 1000), 200) + "\n");
  const c = await collect({ roots: [sessions], now });
  assert.equal(c.total.totalTokens, 300);
  assert.equal(c.tasks[0].turns[0].prompt, "中文研究");
  assert.notEqual(c.tasks[0].revision, a.tasks[0].revision);
  assert.equal(c.diagnostics.parsedFiles, 1);
});
test("same-size rewrite, truncation, archive moves and deletion invalidate file state", async t => {
  const { sessions, file, collect, root } = await fixture(t);
  const now = new Date();
  await writeFile(file, row(now, 100));
  await collect({ roots: [sessions], now });
  await writeFile(file, row(now, 200));
  await utimes(file, new Date(+now + 1000), new Date(+now + 1000));
  assert.equal((await collect({ roots: [sessions], now })).total.totalTokens, 200);
  await writeFile(file, row(now, 50));
  assert.equal((await collect({ roots: [sessions], now })).total.totalTokens, 50);
  const archive = path.join(root, "archive");
  await mkdir(archive);
  const archived = path.join(archive, "rollout-test.jsonl");
  await rename(file, archived);
  assert.equal((await collect({ roots: [sessions, archive], now })).total.totalTokens, 50);
  await rm(archived);
  assert.equal((await collect({ roots: [sessions, archive], now })).total.totalTokens, 0);
});
test("disk snapshots preserve actual age and cannot cross CODEX_HOME or timezone", async t => {
  const { root, sessions, file } = await fixture(t);
  const previousHome = process.env.CODEX_HOME;
  const previousTz = process.env.TZ;
  t.after(() => { if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    if (previousTz === undefined) delete process.env.TZ; else process.env.TZ = previousTz; });
  process.env.CODEX_HOME = root;
  process.env.TZ = "Asia/Shanghai";
  let time = Date.now();
  const cacheDirectory = path.join(root, "cache");
  const make = () => createUsageCollector({ cacheDirectory, clock: () => time });
  await writeFile(file, row(new Date(time), 123));
  const fresh = await make()();
  const restart = await make()({ forceRefresh: true });
  assert.equal(restart.total.totalTokens, 123);
  assert.equal(restart.diagnostics.bytesRead, 0);
  assert.equal(restart.diagnostics.cacheHits, 1);
  await rename(sessions, path.join(root, "offline"));
  time += 24 * 60 * 60 * 1000;
  const stale = await make()();
  assert.equal(stale.generatedAt, fresh.generatedAt);
  assert.equal(stale.stale, true);
  assert.match(stale.refreshError, /刷新失败/);
  process.env.CODEX_HOME = path.join(root, "different");
  await assert.rejects(make()(), /尚无/);
  process.env.CODEX_HOME = root;
  process.env.TZ = "UTC";
  await assert.rejects(make()(), /尚无/);
  assert.equal((await readdir(cacheDirectory)).filter(x => x.endsWith(".json.gz")).length, 1);
  process.env.TZ = "Asia/Shanghai";
  await rename(path.join(root, "offline"), sessions);
  const cacheFile = (await readdir(cacheDirectory)).find(x => x.endsWith(".json.gz"));
  await writeFile(path.join(cacheDirectory, cacheFile), "corrupt compressed snapshot");
  const rebuilt = await make()();
  assert.equal(rebuilt.total.totalTokens, 123);
  assert.equal(rebuilt.stale, false);
});
test("summary paging and revision guards do not mutate source", async t => {
  const usage = { tasks: Array.from({ length: 3 }, (_, i) => ({ id: "" + i, revision: "v1", turns: [{ prompt: "数学", totalTokens: 10 }, { totalTokens: 20 }] })) };
  const summary = selectUsageDetails(usage, { taskDetail: "summary", taskOffset: 1, taskLimit: 1, query: "数学" });
  assert.equal(summary.taskTotal, 3);
  assert.equal(summary.tasks[0].id, "1");
  assert.equal("turns" in summary.tasks[0], false);
  const detail = selectUsageDetails(usage, { taskId: "1", revision: "v1", turnOffset: 1, turnLimit: 1 });
  assert.equal(detail.tasks[0].turns.length, 1);
  assert.equal(detail.tasks[0].turnCount, 2);
  assert.equal(selectUsageDetails(usage, { taskId: "1", revision: "old" }).revisionMismatch, true);
  assert.equal(usage.tasks[1].turns.length, 2);
});
test("HTTP rejects hostile hosts, origins, fetch metadata, methods and unauthenticated API", async t => {
  const token = "b".repeat(64);
  let shutdowns = 0;
  const server = createDashboardServer({ authToken: token, onShutdown: () => shutdowns++,
    usageClient: { request: async (days, opts) => ({ days, opts }), close: async () => {} } });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = "http://127.0.0.1:" + server.address().port;
  const valid = { "X-Codex-Token": token };
  assert.equal((await fetch(origin + "/api/usage")).status, 401);
  for (const headers of [{ Host: "evil.test" }, { Origin: "https://evil.test" }, { "Sec-Fetch-Site": "cross-site" }]) {
    const status = await new Promise((resolve, reject) => {
      http.get(origin + "/api/usage", { headers: { ...valid, ...headers } }, response => { response.resume(); resolve(response.statusCode); }).on("error", reject);
    });
    assert.equal(status, 403, JSON.stringify(headers));
  }
  assert.equal((await fetch(origin + "/api/usage", { headers: valid, method: "POST" })).status, 405);
  assert.equal((await fetch(origin + "/api/usage", { headers: valid })).status, 200);
  const html = await fetch(origin);
  assert.equal(html.headers.get("cache-control"), "no-store");
  assert.match(await html.text(), new RegExp(token));
  assert.equal((await fetch(origin + "/api/shutdown", { method: "POST" })).status, 401);
  assert.equal(shutdowns, 0);
  assert.equal((await fetch(origin + "/api/shutdown", { method: "POST", headers: valid })).status, 200);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(shutdowns, 1);
});
test("worker queue rejects excessive concurrency and filters before posting results", async t => {
  const client = new UsageWorkerClient({ timeoutMilliseconds: 10000, workerUrl: new URL("../test-support/stalled-worker.mjs", import.meta.url) });
  const pending = Array.from({ length: 32 }, () => client.request(30).catch(() => {}));
  await assert.rejects(client.request(30), /过多/);
  await client.close(); await Promise.all(pending);
});
test("stop script leaves an unverified listener alive", async t => {
  const { root } = await fixture(t);
  const token = "c".repeat(64);
  const server = createDashboardServer({ authToken: token, instanceId: "real", usageClient: { close: async () => {} } });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const registry = path.join(root, "servers");
  await mkdir(registry);
  await writeFile(path.join(registry, "123.json"), JSON.stringify({ serverPath: fileURLToPath(new URL("../server.mjs", import.meta.url)), port: server.address().port, token, instanceId: "wrong" }));
  const child = spawn(process.execPath, [fileURLToPath(new URL("../scripts/stop-dashboard.mjs", import.meta.url))], { env: { ...process.env, CODEX_TOKEN_CACHE_DIR: root }, stdio: "ignore" });
  const [code] = await once(child, "exit");
  assert.equal(code, 1);
  assert.equal((await fetch("http://127.0.0.1:" + server.address().port + "/api/health")).status, 200);
});

test("real worker returns summaries without cloning turn details", async t => {
  const { root, file } = await fixture(t);
  const previousHome = process.env.CODEX_HOME, previousCache = process.env.CODEX_TOKEN_CACHE_DIR;
  t.after(() => {
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    if (previousCache === undefined) delete process.env.CODEX_TOKEN_CACHE_DIR; else process.env.CODEX_TOKEN_CACHE_DIR = previousCache;
  });
  process.env.CODEX_HOME = root; process.env.CODEX_TOKEN_CACHE_DIR = path.join(root, "cache");
  await writeFile(file, row(new Date(), 42));
  const client = new UsageWorkerClient();
  try {
    const summary = await client.request(30, { taskDetail: "summary" });
    assert.equal(summary.tasks.length, 1);
    assert.equal("turns" in summary.tasks[0], false);
    const detail = await client.request(30, { taskId: summary.tasks[0].id });
    assert.equal(detail.tasks[0].turns[0].totalTokens, 42);
  } finally { await client.close(); }
});

test("stop script gracefully shuts down a verified random-port instance", async t => {
  const { root } = await fixture(t);
  const child = spawn(process.execPath, [fileURLToPath(new URL("../server.mjs", import.meta.url))], {
    env: { ...process.env, CODEX_TOKEN_PORT: "0", CODEX_TOKEN_CACHE_DIR: root, CODEX_TOKEN_PARENT_PID: "", CODEX_TOKEN_AUTH_TOKEN: "d".repeat(64) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const exit = once(child, "exit");
  await once(child.stdout, "data");
  const registry = path.join(root, "servers");
  let entries = [];
  for (let i=0; i<50; i++) {
    entries = await readdir(registry).catch(() => []);
    if (entries.length) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(entries.length, 1);
  const stopper = spawn(process.execPath, [fileURLToPath(new URL("../scripts/stop-dashboard.mjs", import.meta.url))], {
    env: { ...process.env, CODEX_TOKEN_CACHE_DIR: root }, stdio: "ignore",
  });
  assert.equal((await once(stopper, "exit"))[0], 0);
  const timeout = setTimeout(() => child.kill(), 3000);
  try { assert.equal((await exit)[0], 0); } finally { clearTimeout(timeout); }
});
