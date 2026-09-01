import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectUsage, groupTasksByRoot, normalizeUsage, parseSessionNames } from "../src/usage.mjs";

test("reads the same task names shown in the Codex project sidebar", () => {
  const names = parseSessionNames([
    JSON.stringify({ id: "thread-a", thread_name: "规划手写笔记转换项目" }),
    "partially-written-row",
    JSON.stringify({ id: "thread-b", thread_name: "检查断网重连五次" }),
  ].join("\n"));
  assert.equal(names.get("thread-a"), "规划手写笔记转换项目");
  assert.equal(names.get("thread-b"), "检查断网重连五次");
  assert.equal(names.size, 2);
});

test("groups subagent usage under its root user task", () => {
  const tasks = new Map([
    ["root.jsonl", { sessionKey: "root.jsonl", title: "", turns: [{ usage: { totalTokens: 10 } }] }],
    ["child.jsonl", { sessionKey: "child.jsonl", title: "child", turns: [{ usage: { totalTokens: 20 } }] }],
  ]);
  groupTasksByRoot(tasks, {
    titles: new Map([["root.jsonl", "用户任务"]]),
    roots: new Map([["root.jsonl", "root.jsonl"], ["child.jsonl", "root.jsonl"]]),
  });
  assert.equal(tasks.size, 1);
  assert.equal(tasks.get("root.jsonl").title, "用户任务");
  assert.equal(tasks.get("root.jsonl").turns.length, 2);
});

test("normalizes Codex usage without double-counting cached input", () => {
  assert.deepEqual(normalizeUsage({
    input_tokens: 100,
    cached_input_tokens: 60,
    output_tokens: 20,
    reasoning_output_tokens: 5,
    total_tokens: 120,
  }), {
    inputTokens: 100,
    cachedInputTokens: 60,
    uncachedInputTokens: 40,
    outputTokens: 20,
    reasoningOutputTokens: 5,
    totalTokens: 120,
    events: 1,
  });
});

test("aggregates last_token_usage by local day and deduplicates turn ids", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-token-dashboard-test-"));
  const sessions = path.join(root, "sessions");
  await mkdir(sessions, { recursive: true });
  const timestamp = new Date();
  timestamp.setHours(10, 0, 0, 0);
  const event = (turnId, total, offsetMinutes = 0) => JSON.stringify({
    timestamp: new Date(timestamp.getTime() + offsetMinutes * 60_000).toISOString(),
    type: "event_msg",
    payload: {
      type: "token_count",
      turn_id: turnId,
      info: {
        last_token_usage: {
          input_tokens: total - 10,
          cached_input_tokens: 20,
          output_tokens: 10,
          reasoning_output_tokens: 2,
          total_tokens: total,
        },
      },
    },
  });
  await writeFile(path.join(sessions, `rollout-${timestamp.toISOString().slice(0, 10)}T00-00-00-test.jsonl`), [
    event("turn-1", 100),
    event("turn-1", 100, 1),
    event("turn-2", 50, 2),
  ].join("\n"));
  try {
    const usage = await collectUsage({ days: 7, roots: [sessions], now: timestamp });
    assert.equal(usage.today.totalTokens, 150);
    assert.equal(usage.today.events, 2);
    assert.equal(usage.today.outputTokens, 20);
    assert.equal(usage.tasks.length, 1);
    assert.equal(usage.tasks[0].totalTokens, 150);
    assert.equal(usage.tasks[0].turns.length, 2);
    assert.deepEqual(usage.tasks[0].turns.map((turn) => turn.totalTokens), [100, 50]);
    assert.match(usage.tasks[0].label, /^任务 [A-F0-9]{4}$/);
    assert.doesNotMatch(JSON.stringify(usage.tasks), /turn-1|rollout-|\.jsonl/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("labels usage without a turn id as an unidentified round", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-token-dashboard-unidentified-"));
  const sessions = path.join(root, "sessions");
  await mkdir(sessions, { recursive: true });
  const now = new Date();
  now.setHours(13, 0, 0, 0);
  await writeFile(path.join(sessions, `rollout-${now.toISOString().slice(0, 10)}T00-system.jsonl`), JSON.stringify({
    timestamp: now.toISOString(),
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { last_token_usage: { input_tokens: 80, output_tokens: 20, total_tokens: 100 } },
    },
  }));
  try {
    const usage = await collectUsage({ days: 7, roots: [sessions], now });
    assert.equal(usage.tasks.length, 1);
    assert.equal(usage.tasks[0].turns[0].identified, false);
    assert.equal(usage.tasks[0].turns[0].totalTokens, 100);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("groups token events between task boundaries into one conversation turn", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-token-dashboard-turn-boundary-"));
  const sessions = path.join(root, "sessions");
  await mkdir(sessions, { recursive: true });
  const now = new Date();
  now.setHours(14, 0, 0, 0);
  const event = (type, minute, payload = {}) => JSON.stringify({
    timestamp: new Date(now.getTime() + minute * 60_000).toISOString(),
    type: "event_msg",
    payload: { type, ...payload },
  });
  const usage = (total) => ({
    info: { last_token_usage: { input_tokens: total - 10, output_tokens: 10, total_tokens: total } },
  });
  const userMessage = (text) => JSON.stringify({
    timestamp: new Date(now.getTime() + 30_000).toISOString(),
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
      internal_chat_message_metadata_passthrough: { turn_id: "private-turn-id" },
    },
  });
  await writeFile(path.join(sessions, `rollout-${now.toISOString().slice(0, 10)}T00-grouped.jsonl`), [
    event("task_started", 0, { turn_id: "private-turn-id" }),
    userMessage("<environment_context>injected details</environment_context>"),
    userMessage("<codex_internal_context>internal injected details</codex_internal_context>"),
    userMessage("# Files mentioned by the user:\nprivate.pdf\n\n## My request:\n请优化本地悬浮窗的任务统计"),
    userMessage("请优化本地悬浮窗的任务统计"),
    event("token_count", 1, usage(100)),
    event("token_count", 2, usage(50)),
    event("task_complete", 3, { turn_id: "private-turn-id" }),
  ].join("\n"));
  try {
    const result = await collectUsage({ days: 7, roots: [sessions], now: new Date(now.getTime() + 4 * 60_000) });
    assert.equal(result.today.totalTokens, 150);
    assert.equal(result.today.events, 2);
    assert.equal(result.tasks[0].turns.length, 1);
    assert.equal(result.tasks[0].turns[0].totalTokens, 150);
    assert.equal(result.tasks[0].turns[0].identified, true);
    assert.equal(result.tasks[0].turns[0].prompt, "请优化本地悬浮窗的任务统计");
    assert.equal(result.tasks[0].title, "请优化本地悬浮窗的任务统计");
    assert.doesNotMatch(JSON.stringify(result.tasks), /private-turn-id/);
    assert.doesNotMatch(JSON.stringify(result.tasks), /injected details/);
    assert.doesNotMatch(JSON.stringify(result.tasks), /internal injected details/);
    assert.doesNotMatch(JSON.stringify(result.tasks), /private\.pdf/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("derives deltas from cumulative-only legacy events", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-token-dashboard-cumulative-"));
  const sessions = path.join(root, "sessions");
  await mkdir(sessions, { recursive: true });
  const now = new Date();
  now.setHours(12, 0, 0, 0);
  const cumulative = (turnId, total, minute) => JSON.stringify({
    timestamp: new Date(now.getTime() + minute * 60_000).toISOString(),
    type: "event_msg",
    payload: {
      type: "token_count",
      turn_id: turnId,
      info: { total_token_usage: { input_tokens: total - 10, output_tokens: 10, total_tokens: total } },
    },
  });
  await writeFile(path.join(sessions, `rollout-${now.toISOString().slice(0, 10)}T00-legacy.jsonl`), [
    cumulative("a", 100, 0),
    cumulative("b", 160, 1),
  ].join("\n"));
  try {
    const usage = await collectUsage({ days: 7, roots: [sessions], now });
    assert.equal(usage.today.totalTokens, 160);
    assert.equal(usage.today.events, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps only the newest active or archived copy of one rollout", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-token-dashboard-duplicate-"));
  const active = path.join(root, "sessions");
  const archived = path.join(root, "archived_sessions");
  await mkdir(active, { recursive: true });
  await mkdir(archived, { recursive: true });
  const now = new Date();
  now.setHours(12, 0, 0, 0);
  const name = `rollout-${now.toISOString().slice(0, 10)}T00-duplicate.jsonl`;
  const event = (total) => JSON.stringify({
    timestamp: now.toISOString(),
    type: "event_msg",
    payload: {
      type: "token_count",
      turn_id: "same-turn",
      info: { last_token_usage: { input_tokens: total - 10, output_tokens: 10, total_tokens: total } },
    },
  });
  const activePath = path.join(active, name);
  const archivedPath = path.join(archived, name);
  await writeFile(activePath, event(100));
  await writeFile(archivedPath, event(150));
  await utimes(activePath, new Date(now.getTime() - 60_000), new Date(now.getTime() - 60_000));
  await utimes(archivedPath, now, now);
  try {
    const usage = await collectUsage({ days: 7, roots: [active, archived], now });
    assert.equal(usage.today.totalTokens, 150);
    assert.equal(usage.today.events, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
