// Optional developer smoke test: requires Playwright in this or a parent workspace.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createDashboardServer, selectUsageDetails } from "../server.mjs";
const day = { day: "2026-09-07", inputTokens: 200, cachedInputTokens: 100, uncachedInputTokens: 100, outputTokens: 50, totalTokens: 250, events: 2 };
const tasks = Array.from({ length: 25 }, (_, i) => ({ id: "task-" + i, label: "任务 " + i, title: "Synthetic research " + i,
  revision: "rev1", lastActivity: "2026-09-07T10:00:00Z", inputTokens: 200, outputTokens: 50, totalTokens: 250, turnCount: 55,
  turns: Array.from({ length: 55 }, (_, j) => ({ ...day, number: j + 1, identified: true, timestamp: "2026-09-07T10:00:00Z", prompt: "Synthetic prompt" })) }));
const requests = [];
const server = createDashboardServer({ usageClient: { close: async () => {}, request: async (days, options) => {
  requests.push({ days, ...options });
  await new Promise(resolve => setTimeout(resolve, days === 14 ? 300 : 10));
  return selectUsageDetails({ today: day, yesterday: day, last7: day, last30: day, activeDays30: 1,
    generatedAt: "2026-09-07T10:00:00Z", stale: false, days: Array.from({length:7}, (_, i) => ({...day, day: "2026-09-0" + (i+1)})),
    tasks, diagnostics: {candidateFiles:days}, timezone: "Asia/Shanghai" }, options);
} } });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto("http://127.0.0.1:" + server.address().port);
  await page.waitForSelector(".task-item");
  assert.equal(await page.locator(".task-item").count(), 20);
  await page.locator(".task-item summary").first().click();
  await page.waitForSelector(".turn-row");
  assert.equal(await page.locator(".turn-row").count(), 50);
  await page.locator(".load-more-turns").click();
  await page.waitForFunction(() => document.querySelectorAll(".turn-row").length === 55);
  await page.locator(".load-more-tasks").click();
  await page.waitForFunction(() => document.querySelectorAll(".task-item").length === 25);
  await page.locator('[data-days="14"]').click();
  await page.locator('[data-days="90"]').click();
  await page.waitForFunction(() => document.querySelector("#diagnostics").textContent.startsWith("90 "));
  await page.waitForTimeout(400);
  assert.match(await page.locator("#diagnostics").innerText(), /^90 /);
  assert.ok(requests.some(r => r.taskDetail === "summary" && r.taskLimit === 20));
  assert.ok(requests.some(r => r.turnOffset === 50));
  assert.ok(requests.some(r => r.taskOffset === 20));
  await mkdir(".package-smoke", {recursive:true});
  await page.screenshot({ path: ".package-smoke/web.png", fullPage:true });
  assert.deepEqual(errors, []);
  console.log("Web smoke passed: auth, CSP, task/turn paging, range race, no console errors.");
} finally {
  await browser?.close();
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
}
