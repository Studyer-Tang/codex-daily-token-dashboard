import { createReadStream } from "node:fs";
import { mkdir, opendir, readFile, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

const MAX_LINE_BYTES = 16 * 1024 * 1024;
const fileCache = new Map();
let ripgrepSnapshot = null;
let snapshotRefresh = null;
let snapshotLoaded = false;
function applicationCacheDirectory() {
  if (process.env.CODEX_TOKEN_CACHE_DIR) return path.resolve(process.env.CODEX_TOKEN_CACHE_DIR);
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, "CodexTokenWidget");
  }
  if (process.env.XDG_CACHE_HOME) return path.join(process.env.XDG_CACHE_HOME, "codex-token-widget");
  return path.join(os.homedir(), ".cache", "codex-token-widget");
}

const snapshotPath = path.join(applicationCacheDirectory(), "usage-summary.json");
const legacySnapshotPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".cache",
  "usage-summary.json",
);

function emptyUsage() {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    uncachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    events: 0,
  };
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeUsage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const inputTokens = number(raw.input_tokens);
  const cachedInputTokens = number(raw.cached_input_tokens);
  const outputTokens = number(raw.output_tokens);
  const reasoningOutputTokens = number(raw.reasoning_output_tokens);
  const reportedTotal = number(raw.total_tokens);
  const totalTokens = reportedTotal || inputTokens + outputTokens;
  if (!totalTokens && !inputTokens && !outputTokens) return null;
  return {
    inputTokens,
    cachedInputTokens,
    uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens),
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
    events: 1,
  };
}

function subtractUsage(current, previous) {
  if (!previous) return current;
  const reset = current.totalTokens < previous.totalTokens;
  if (reset) return current;
  const result = emptyUsage();
  for (const key of [
    "inputTokens",
    "cachedInputTokens",
    "uncachedInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
    "totalTokens",
  ]) {
    result[key] = Math.max(0, current[key] - previous[key]);
  }
  result.events = result.totalTokens > 0 ? 1 : 0;
  return result.totalTokens > 0 ? result : null;
}

function addUsage(target, source) {
  for (const key of Object.keys(emptyUsage())) target[key] += source[key] || 0;
  return target;
}

function eventUsage(row, previousBySession, sessionKey) {
  const info = row?.payload?.info;
  if (!info || typeof info !== "object") return null;
  let usage = normalizeUsage(info.last_token_usage);
  if (!usage) {
    const cumulative = normalizeUsage(info.total_token_usage);
    usage = cumulative ? subtractUsage(cumulative, previousBySession.get(sessionKey)) : null;
    if (cumulative) previousBySession.set(sessionKey, cumulative);
  } else if (info.total_token_usage) {
    const cumulative = normalizeUsage(info.total_token_usage);
    if (cumulative) previousBySession.set(sessionKey, cumulative);
  }
  return usage;
}

export function localDayKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateFromDayKey(dayKey) {
  const [year, month, day] = dayKey.split("-").map(Number);
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

function shiftDay(dayKey, amount) {
  const date = dateFromDayKey(dayKey);
  date.setDate(date.getDate() + amount);
  return localDayKey(date);
}

async function listJsonlFiles(root, output) {
  const stack = [root];
  while (stack.length) {
    const directory = stack.pop();
    let handle;
    try {
      handle = await opendir(directory);
    } catch {
      continue;
    }
    for await (const entry of handle) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) stack.push(absolute);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) output.push(absolute);
    }
  }
}

function rolloutStartDay(filePath) {
  const match = path.basename(filePath).match(/rollout-(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : "";
}

function isCandidate(filePath, metadata, cutoffDay) {
  const startDay = rolloutStartDay(filePath);
  if (!startDay || startDay >= shiftDay(cutoffDay, -1)) return true;
  return localDayKey(metadata.mtime) >= cutoffDay;
}

async function parseRollout(filePath) {
  const deltas = [];
  const seenTurns = new Set();
  let previousCumulative = null;
  const input = createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });

  try {
    for await (const line of lines) {
      if (!line.includes('"token_count"') || line.length > MAX_LINE_BYTES) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (row?.type !== "event_msg" || row?.payload?.type !== "token_count") continue;
      const turnId = typeof row.payload.turn_id === "string" ? row.payload.turn_id : "";
      const dedupKey = turnId || String(row.timestamp || "");
      if (dedupKey && seenTurns.has(dedupKey)) continue;
      const baselines = new Map([[filePath, previousCumulative]]);
      const usage = eventUsage(row, baselines, filePath);
      previousCumulative = baselines.get(filePath) || previousCumulative;
      if (!usage) continue;
      if (dedupKey) seenTurns.add(dedupKey);
      const day = localDayKey(row.timestamp);
      if (day) deltas.push({ day, usage });
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return deltas;
}

async function scanWithRipgrep(sourceRoots) {
  const buckets = new Map();
  const seenEvents = new Set();
  const filesWithUsage = new Set();
  const previousBySession = new Map();
  let matchedLines = 0;
  const args = [
    "--no-heading",
    "--with-filename",
    "--null",
    "--no-messages",
    '"type"\\s*:\\s*"token_count"',
    ...sourceRoots,
  ];

  await new Promise((resolve, reject) => {
    const child = spawn("rg", args, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    const decoder = new StringDecoder("utf8");
    let pending = "";
    let spawnError = null;

    const consume = (record) => {
      const separator = record.indexOf("\0");
      if (separator < 1) return;
      const filePath = record.slice(0, separator);
      const text = record.slice(separator + 1).trim();
      if (!text || text.length > MAX_LINE_BYTES) return;
      let row;
      try {
        row = JSON.parse(text);
      } catch {
        return;
      }
      if (row?.type !== "event_msg" || row?.payload?.type !== "token_count") return;
      const sessionKey = path.basename(filePath).toLowerCase();
      const turnId = typeof row.payload.turn_id === "string" ? row.payload.turn_id : "";
      const eventKey = `${sessionKey}:${turnId || row.timestamp || matchedLines}`;
      if (seenEvents.has(eventKey)) return;
      const usage = eventUsage(row, previousBySession, sessionKey);
      if (!usage) return;
      const day = localDayKey(row.timestamp);
      if (!day) return;
      seenEvents.add(eventKey);
      filesWithUsage.add(sessionKey);
      matchedLines += 1;
      const bucket = buckets.get(day) || { day, ...emptyUsage() };
      addUsage(bucket, usage);
      buckets.set(day, bucket);
    };

    child.once("error", (error) => {
      spawnError = error;
    });
    child.stdout.on("data", (chunk) => {
      pending += decoder.write(chunk);
      let newline;
      while ((newline = pending.indexOf("\n")) >= 0) {
        consume(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
    });
    child.once("close", (code) => {
      pending += decoder.end();
      if (pending) consume(pending);
      if (spawnError) return reject(spawnError);
      if (code !== 0 && code !== 1) return reject(new Error(`rg exited with code ${code}`));
      resolve();
    });
  });

  return {
    generatedAtMs: Date.now(),
    buckets,
    diagnostics: {
      discoveredFiles: filesWithUsage.size,
      uniqueFiles: filesWithUsage.size,
      candidateFiles: filesWithUsage.size,
      parsedFiles: filesWithUsage.size,
      cacheHits: 0,
      matchedEvents: matchedLines,
      scanner: "ripgrep",
    },
  };
}

async function loadPersistedSnapshot() {
  if (snapshotLoaded) return;
  snapshotLoaded = true;
  for (const candidate of [snapshotPath, legacySnapshotPath]) {
    try {
      const raw = JSON.parse(await readFile(candidate, "utf8"));
      if (!Number.isFinite(raw.generatedAtMs) || !Array.isArray(raw.days)) continue;
      ripgrepSnapshot = {
        generatedAtMs: raw.generatedAtMs,
        buckets: new Map(raw.days.map((day) => [day.day, day])),
        diagnostics: { ...raw.diagnostics, cacheSource: "disk" },
      };
      if (candidate === legacySnapshotPath) {
        try {
          await mkdir(path.dirname(snapshotPath), { recursive: true });
          await writeFile(snapshotPath, JSON.stringify(raw), "utf8");
        } catch { }
      }
      return;
    } catch {
      // Try the legacy location before falling back to a fresh scan.
    }
  }
}

async function refreshRipgrepSnapshot(sourceRoots) {
  if (snapshotRefresh) return snapshotRefresh;
  snapshotRefresh = (async () => {
    const fresh = await scanWithRipgrep(sourceRoots);
    ripgrepSnapshot = fresh;
    try {
      await mkdir(path.dirname(snapshotPath), { recursive: true });
      await writeFile(snapshotPath, JSON.stringify({
        generatedAtMs: fresh.generatedAtMs,
        days: [...fresh.buckets.values()],
        diagnostics: fresh.diagnostics,
      }), "utf8");
    } catch {
      // The in-memory result remains usable if the optional cache cannot be saved.
    }
    return fresh;
  })().finally(() => {
    snapshotRefresh = null;
  });
  return snapshotRefresh;
}

async function readFileWithCache(filePath, metadata) {
  const fingerprint = `${metadata.size}:${metadata.mtimeMs}`;
  const cached = fileCache.get(filePath);
  if (cached?.fingerprint === fingerprint) return { deltas: cached.deltas, hit: true };
  const deltas = await parseRollout(filePath);
  fileCache.set(filePath, { fingerprint, deltas });
  return { deltas, hit: false };
}

function summarize(days) {
  const total = emptyUsage();
  for (const day of days) addUsage(total, day);
  return total;
}

export async function collectUsage({ days = 30, roots, now = new Date() } = {}) {
  const range = Math.max(7, Math.min(365, Number(days) || 30));
  const today = localDayKey(now);
  const cutoffDay = shiftDay(today, -(range - 1));
  const codexRoot = path.join(os.homedir(), ".codex");
  const sourceRoots = roots || [
    path.join(codexRoot, "sessions"),
    path.join(codexRoot, "archived_sessions"),
  ];

  if (!roots) {
    await loadPersistedSnapshot();
    if (!ripgrepSnapshot) {
      try {
        await refreshRipgrepSnapshot(sourceRoots);
      } catch {
        ripgrepSnapshot = null;
      }
    } else if (Date.now() - ripgrepSnapshot.generatedAtMs > 4 * 60_000) {
      // Return the last good summary immediately and refresh in the background.
      refreshRipgrepSnapshot(sourceRoots).catch(() => {});
    }
    if (ripgrepSnapshot) {
      const timeline = [];
      for (let index = 0; index < range; index += 1) {
        const day = shiftDay(cutoffDay, index);
        timeline.push(ripgrepSnapshot.buckets.get(day) || { day, ...emptyUsage() });
      }
      const todayUsage = timeline.at(-1);
      const yesterdayUsage = timeline.at(-2) || { day: shiftDay(today, -1), ...emptyUsage() };
      return {
        generatedAt: new Date().toISOString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "local",
        range,
        today: todayUsage,
        yesterday: yesterdayUsage,
        last7: summarize(timeline.slice(-7)),
        last30: summarize(timeline.slice(-30)),
        total: summarize(timeline),
        days: timeline,
        diagnostics: { ...ripgrepSnapshot.diagnostics },
      };
    }
  }

  const discovered = [];
  for (const root of sourceRoots) await listJsonlFiles(root, discovered);

  // The same rollout can briefly exist in active and archived storage. Prefer
  // the newest copy, keyed by filename, so an archive operation never doubles usage.
  const unique = new Map();
  for (const filePath of discovered) {
    let metadata;
    try {
      metadata = await stat(filePath);
    } catch {
      continue;
    }
    const key = path.basename(filePath).toLowerCase();
    const existing = unique.get(key);
    if (!existing || metadata.mtimeMs > existing.metadata.mtimeMs) {
      unique.set(key, { filePath, metadata });
    }
  }

  const buckets = new Map();
  let parsedFiles = 0;
  let cacheHits = 0;
  let candidateFiles = 0;
  for (const { filePath, metadata } of unique.values()) {
    if (!isCandidate(filePath, metadata, cutoffDay)) continue;
    candidateFiles += 1;
    const result = await readFileWithCache(filePath, metadata);
    if (result.hit) cacheHits += 1;
    else parsedFiles += 1;
    for (const delta of result.deltas) {
      if (delta.day < cutoffDay || delta.day > today) continue;
      const bucket = buckets.get(delta.day) || { day: delta.day, ...emptyUsage() };
      addUsage(bucket, delta.usage);
      buckets.set(delta.day, bucket);
    }
  }

  const timeline = [];
  for (let index = 0; index < range; index += 1) {
    const day = shiftDay(cutoffDay, index);
    timeline.push(buckets.get(day) || { day, ...emptyUsage() });
  }
  const todayUsage = timeline.at(-1);
  const yesterdayUsage = timeline.at(-2) || { day: shiftDay(today, -1), ...emptyUsage() };
  const last7 = summarize(timeline.slice(-7));
  const last30 = summarize(timeline.slice(-30));
  const total = summarize(timeline);

  return {
    generatedAt: new Date().toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "local",
    range,
    today: todayUsage,
    yesterday: yesterdayUsage,
    last7,
    last30,
    total,
    days: timeline,
    diagnostics: {
      discoveredFiles: discovered.length,
      uniqueFiles: unique.size,
      candidateFiles,
      parsedFiles,
      cacheHits,
      scanner: "node",
    },
  };
}

export { emptyUsage, normalizeUsage };
