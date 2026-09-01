import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import os from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createDashboardServer, UsageWorkerClient } from "../server.mjs";

const serverPath = fileURLToPath(new URL("../server.mjs", import.meta.url));

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

test("health stays responsive while a usage request is still running", async () => {
  let finishUsage;
  const usageClient = {
    worker: {},
    request: () => new Promise((resolve) => { finishUsage = resolve; }),
    close: async () => {},
  };
  const server = createDashboardServer({ usageClient, logger: { error() {} } });
  const origin = await listen(server);
  try {
    const usageRequest = fetch(`${origin}/api/usage?days=30`);
    await new Promise((resolve) => setImmediate(resolve));
    const startedAt = performance.now();
    const health = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1_000) });
    assert.equal(health.status, 200);
    assert.equal((await health.json()).service, "codex-daily-token-dashboard");
    assert.ok(performance.now() - startedAt < 500);
    finishUsage({ ok: true });
    assert.equal((await usageRequest).status, 200);
  } finally {
    await close(server);
  }
});

test("usage failures return a safe structured detail", async () => {
  const usageClient = {
    worker: null,
    request: async () => { throw new Error("synthetic scan failure"); },
    close: async () => {},
  };
  const server = createDashboardServer({ usageClient, logger: { error() {} } });
  const origin = await listen(server);
  try {
    const response = await fetch(`${origin}/api/usage?days=30`);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      error: "读取本地 Codex 用量失败",
      detail: "synthetic scan failure",
    });
  } finally {
    await close(server);
  }
});

test("API error details redact the user profile path", async () => {
  const usageClient = {
    worker: null,
    request: async () => { throw new Error(`${os.homedir()}\\private-rollout.jsonl failed`); },
    close: async () => {},
  };
  const server = createDashboardServer({ usageClient, logger: { error() {} } });
  const origin = await listen(server);
  try {
    const payload = await (await fetch(`${origin}/api/usage`)).json();
    assert.doesNotMatch(payload.detail, new RegExp(os.homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(payload.detail, /%USERPROFILE%/);
  } finally {
    await close(server);
  }
});

test("a stalled usage worker times out and is reset", async () => {
  const client = new UsageWorkerClient({
    timeoutMilliseconds: 30,
    workerUrl: new URL("../test-support/stalled-worker.mjs", import.meta.url),
  });
  await assert.rejects(client.request(30), /超过/);
  assert.equal(client.worker, null);
  await client.close();
});

test("a fixed-port conflict exits with an explicit failure", async () => {
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const port = blocker.address().port;
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, CODEX_TOKEN_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    const [code] = await once(child, "exit");
    assert.equal(code, 1);
    assert.match(stderr, /端口/);
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
});

test("the server exits when its declared parent process is gone", async () => {
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      CODEX_TOKEN_PORT: "0",
      CODEX_TOKEN_PARENT_PID: "2147483647",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let timeout;
  try {
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error("parent watchdog timed out")), 5_000);
      timeout.unref();
    });
    const [code] = await Promise.race([once(child, "exit"), timeoutPromise]);
    assert.equal(code, 0);
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill();
  }
});
