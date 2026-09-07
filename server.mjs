import http from "node:http";
import { randomBytes, timingSafeEqual, randomUUID } from "node:crypto";
import { applicationCacheDirectory } from "./src/usage.mjs";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultPublicRoot = path.join(here, "public");
const host = "127.0.0.1";
const staticFiles = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/icon.svg", ["icon.svg", "image/svg+xml"]],
]);

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

function safeErrorDetail(error) {
  let message = error instanceof Error ? error.message : String(error);
  message = message.replaceAll(here, "%APPDIR%").replaceAll(os.homedir(), "%USERPROFILE%");
  message = message.replace(/[\r\n]+/g, " ").trim();
  return message.length > 240 ? `${message.slice(0, 239)}…` : message;
}

export { selectUsageDetails } from "./src/usage-query.mjs";

export class UsageWorkerClient {
  constructor({
    timeoutMilliseconds = 180_000,
    workerUrl = new URL("./src/usage-worker.mjs", import.meta.url),
  } = {}) {
    this.timeoutMilliseconds = timeoutMilliseconds;
    this.workerUrl = workerUrl;
    this.worker = null;
    this.pending = new Map();
    this.nextId = 1;
  }

  ensureWorker() {
    if (this.worker) return this.worker;
    const worker = new Worker(this.workerUrl);
    this.worker = worker;
    worker.on("message", (message) => this.onMessage(message));
    worker.on("error", (error) => { if (this.worker === worker) this.failWorker(error); });
    worker.on("exit", (code) => {
      if (this.worker !== worker) return;
      this.worker = null;
      this.rejectAll(new Error(`用量 Worker 意外退出，代码 ${code}`));
    });
    return worker;
  }

  onMessage({ id, usage, error }) {
    const request = this.pending.get(id);
    if (!request) return;
    this.pending.delete(id);
    clearTimeout(request.timer);
    if (error) {
      const failure = new Error(error.message || "Worker 读取失败");
      failure.stack = error.stack || failure.stack;
      request.reject(failure);
    } else {
      request.resolve(usage);
    }
  }

  rejectAll(error) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  failWorker(error) {
    const worker = this.worker;
    this.worker = null;
    this.rejectAll(error);
    worker?.terminate().catch(() => {});
  }

  request(days, options = {}) {
    if (this.pending.size >= 32) return Promise.reject(new Error("统计请求过多，请稍后重试"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`本地日志统计超过 ${this.timeoutMilliseconds / 1000} 秒`));
        this.failWorker(new Error("用量 Worker 已因超时重置"));
      }, this.timeoutMilliseconds);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ensureWorker().postMessage({ id, days, options }); }
      catch (error) { this.failWorker(error); }
    });
  }

  async close() {
    const worker = this.worker;
    this.worker = null;
    this.rejectAll(new Error("统计服务正在关闭"));
    if (worker) await worker.terminate();
  }
}

export function createDashboardServer({
  publicRoot = defaultPublicRoot,
  usageClient = new UsageWorkerClient(),
  logger = console,
  authToken = process.env.CODEX_TOKEN_AUTH_TOKEN || randomBytes(32).toString("hex"),
  instanceId = randomUUID(),
  onShutdown = null,
} = {}) {
  if (!/^[a-f0-9]{64}$/i.test(authToken)) throw new Error("Invalid service token");
  const authenticated = (request) => {
    const token = String(request.headers["x-codex-token"] || "");
    return /^[a-f0-9]{64}$/i.test(token) && timingSafeEqual(Buffer.from(token), Buffer.from(authToken));
  };
  const server = http.createServer(async (request, response) => {
    try {
      const address = server.address();
      const localPort = typeof address === "object" && address ? address.port : 4817;
      const authority = request.headers.host;
      if (![host + ":" + localPort, "localhost:" + localPort].includes(authority) ||
          (request.headers.origin && request.headers.origin !== "http://" + authority) ||
          (request.headers["sec-fetch-site"] && !["same-origin", "none"].includes(request.headers["sec-fetch-site"])) ||
          !request.url?.startsWith("/") || request.url.startsWith("//")) {
        return sendJson(response, 403, { error: "Forbidden origin or host" });
      }
      const url = new URL(request.url, "http://" + authority);
      if (url.pathname === "/api/shutdown") {
        if (request.method !== "POST") return sendJson(response, 405, { error: "POST required" });
        if (!authenticated(request)) return sendJson(response, 401, { error: "Authentication required" });
        if (!onShutdown) return sendJson(response, 409, { error: "请从悬浮窗托盘退出此服务" });
        sendJson(response, 200, { ok: true });
        setImmediate(onShutdown);
        return;
      }
      if (request.method !== "GET") return sendJson(response, 405, { error: "GET required" });
      if (url.pathname === "/api/health") {
        return sendJson(response, 200, {
          ok: true,
          authorized: authenticated(request),
          instanceId,
          service: "codex-daily-token-dashboard",
          worker: usageClient.worker ? "ready" : "idle",
        });
      }
      if (url.pathname === "/api/usage") {
        if (!authenticated(request)) return sendJson(response, 401, { error: "Authentication required" });
        const days = Math.max(7, Math.min(365, Math.floor(Number(url.searchParams.get("days"))) || 30));
        const options = {
          taskDetail: url.searchParams.get("taskDetail") || "summary",
          taskId: url.searchParams.get("task") || "",
          query: (url.searchParams.get("query") || "").slice(0, 80),
          revision: url.searchParams.get("revision") || "",
          forceRefresh: url.searchParams.get("forceRefresh") === "1",
        };
        for (const key of ["taskOffset", "taskLimit", "turnOffset", "turnLimit"]) options[key] = Number(url.searchParams.get(key)) || 0;
        return sendJson(response, 200, await usageClient.request(days, options));
      }
      const asset = staticFiles.get(url.pathname);
      if (!asset) return sendJson(response, 404, { error: "Not found" });
      const [fileName, contentType] = asset;
      let content = await readFile(path.join(publicRoot, fileName));
      if (fileName === "index.html") content = content.toString("utf8").replace("</head>", '<meta name="dashboard-token" content="' + authToken + '"></head>');
      response.writeHead(200, {
        "content-type": contentType,
        "cache-control": fileName === "index.html" ? "no-store" : "public, max-age=3600",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      });
      response.end(content);
    } catch (error) {
      logger.error(safeErrorDetail(error));
      if (!response.headersSent) {
        sendJson(response, 500, {
          error: "读取本地 Codex 用量失败",
          detail: safeErrorDetail(error),
        });
      } else {
        response.destroy();
      }
    }
  });

  server.on("close", () => usageClient.close().catch(() => {}));
  return server;
}

function isDirectRun() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 13)) throw new Error("Node.js 22.13 or newer is required");
  const requestedPort = Number(process.env.CODEX_TOKEN_PORT || 4817);
  const port = Number.isInteger(requestedPort) && requestedPort >= 0 && requestedPort <= 65535 ? requestedPort : 4817;
  const authToken = process.env.CODEX_TOKEN_AUTH_TOKEN || randomBytes(32).toString("hex");
  const instanceId = randomUUID();
  const parentPid = Number(process.env.CODEX_TOKEN_PARENT_PID) || 0;
  const registryFile = path.join(applicationCacheDirectory(), "servers", process.pid + ".json");
  let parentTimer, closing = false;
  let registration = Promise.resolve();
  const shutdown = () => {
    if (closing) return;
    closing = true;
    clearInterval(parentTimer);
    const deadline = setTimeout(() => process.exit(0), 2500);
    deadline.unref();
    server.close(async () => {
      await registration;
      await unlink(registryFile).catch(() => {});
      process.exit(0);
    });
    server.closeAllConnections();
  };
  const server = createDashboardServer({ authToken, instanceId, onShutdown: parentPid ? null : shutdown });
  server.on("error", error => {
    console.error(error.code === "EADDRINUSE" ? `端口 ${port} 已被其他程序占用` : safeErrorDetail(error));
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    const actualPort = server.address().port;
    registration = (async () => {
      await mkdir(path.dirname(registryFile), { recursive: true });
      await writeFile(registryFile, JSON.stringify({ pid: process.pid, port: actualPort, token: authToken,
        instanceId, serverPath: fileURLToPath(import.meta.url), parentPid }), { mode: 0o600 });
    })().catch(() => console.error("无法写入服务登记文件，请在启动终端停止服务"));
    console.log(`Codex 每日 Token 仪表盘：http://${host}:${actualPort}`);
    console.log("数据仅在本机处理，不会上传。按 Ctrl+C 停止。");
  });
  if (Number.isInteger(parentPid) && parentPid > 0) {
    parentTimer = setInterval(() => {
      try { process.kill(parentPid, 0); } catch { shutdown(); }
    }, 2000);
    parentTimer.unref();
  }
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, shutdown);
}
