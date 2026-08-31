import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectUsage, normalizeUsage } from "../src/usage.mjs";

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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
