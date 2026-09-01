import http from "node:http";
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

export class UsageWorkerClient {
  constructor({
    timeoutMilliseconds = 45_000,
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
    worker.on("error", (error) => this.failWorker(error));
    worker.on("exit", (code) => {
      if (this.worker !== worker) return;
      this.worker = null;
      if (code !== 0) this.rejectAll(new Error(`用量 Worker 意外退出，代码 ${code}`));
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

  request(days) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`本地日志统计超过 ${this.timeoutMilliseconds / 1000} 秒`));
        this.failWorker(new Error("用量 Worker 已因超时重置"));
      }, this.timeoutMilliseconds);
      this.pending.set(id, { resolve, reject, timer });
      this.ensureWorker().postMessage({ id, days });
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
} = {}) {
  const server = http.createServer(async (request, response) => {
    try {
      const address = server.address();
      const localPort = typeof address === "object" && address ? address.port : 4817;
      const url = new URL(request.url || "/", `http://${host}:${localPort}`);
      if (url.pathname === "/api/health") {
        return sendJson(response, 200, {
          ok: true,
          service: "codex-daily-token-dashboard",
          worker: usageClient.worker ? "ready" : "idle",
        });
      }
      if (url.pathname === "/api/usage") {
        const days = Math.max(7, Math.min(365, Number(url.searchParams.get("days")) || 30));
        return sendJson(response, 200, await usageClient.request(days));
      }
      const asset = staticFiles.get(url.pathname);
      if (!asset) return sendJson(response, 404, { error: "Not found" });
      const [fileName, contentType] = asset;
      const content = await readFile(path.join(publicRoot, fileName));
      response.writeHead(200, {
        "content-type": contentType,
        "cache-control": fileName === "index.html" ? "no-cache" : "public, max-age=3600",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      });
      response.end(content);
    } catch (error) {
      logger.error(error);
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
  const requestedPort = Number(process.env.CODEX_TOKEN_PORT || 4817);
  const port = Number.isInteger(requestedPort) && requestedPort >= 0 ? requestedPort : 4817;
  const server = createDashboardServer();
  let parentTimer = null;

  server.on("error", (error) => {
    console.error(error.code === "EADDRINUSE" ? `端口 ${port} 已被其他程序占用` : error);
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    console.log(`Codex 每日 Token 仪表盘：http://${host}:${actualPort}`);
    console.log("数据只从本机 .codex 会话日志读取，不会上传。按 Ctrl+C 停止。 ");
  });

  const parentPid = Number(process.env.CODEX_TOKEN_PARENT_PID);
  if (Number.isInteger(parentPid) && parentPid > 0) {
    parentTimer = setInterval(() => {
      try {
        process.kill(parentPid, 0);
      } catch {
        console.error(`父进程 ${parentPid} 已退出，本地统计服务同步关闭`);
        server.close(() => process.exit(0));
      }
    }, 2_000);
    parentTimer.unref();
  }

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      if (parentTimer) clearInterval(parentTimer);
      server.close(() => process.exit(0));
    });
  }
}
