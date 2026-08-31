import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectUsage } from "./src/usage.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(here, "public");
const host = "127.0.0.1";
const port = Number(process.env.CODEX_TOKEN_PORT || 4817);
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

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${host}:${port}`);
  try {
    if (url.pathname === "/api/health") {
      return sendJson(response, 200, { ok: true, service: "codex-daily-token-dashboard" });
    }
    if (url.pathname === "/api/usage") {
      const days = Math.max(7, Math.min(365, Number(url.searchParams.get("days")) || 30));
      const usage = await collectUsage({ days });
      return sendJson(response, 200, usage);
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
    console.error(error);
    sendJson(response, 500, { error: "读取本地 Codex 用量失败", detail: error.message });
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.log(`仪表盘已经运行：http://${host}:${port}`);
    process.exit(0);
  }
  throw error;
});

server.listen(port, host, () => {
  console.log(`Codex 每日 Token 仪表盘：http://${host}:${port}`);
  console.log("数据只从本机 .codex 会话日志读取，不会上传。按 Ctrl+C 停止。 ");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
