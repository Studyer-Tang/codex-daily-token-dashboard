import { createReadStream } from "node:fs";
import { mkdir, opendir, readFile, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
let threadMetadataCache = { loadedAt: 0, titles: new Map(), roots: new Map() };
function applicationCacheDirectory() {
  if (process.env.CODEX_TOKEN_CACHE_DIR) return path.resolve(process.env.CODEX_TOKEN_CACHE_DIR);
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, "CodexTokenWidget");
  }
  if (process.env.XDG_CACHE_HOME) return path.join(process.env.XDG_CACHE_HOME, "codex-token-widget");
  return path.join(os.homedir(), ".cache", "codex-token-widget");
}

export function codexDataDirectory({ environment = process.env, home = os.homedir() } = {}) {
  const configured = String(environment.CODEX_HOME || "").trim();
  return configured ? path.resolve(configured) : path.join(home, ".codex");
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

function conciseText(value, maximum = 240) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
}

function userPrompt(row) {
  if (row?.type !== "response_item" || row?.payload?.type !== "message" || row?.payload?.role !== "user") return "";
  const parts = Array.isArray(row.payload.content) ? row.payload.content : [];
  return conciseText(parts.map((part) => {
    if (part?.type !== "input_text" || typeof part.text !== "string") return "";
    const text = part.text.trim();
    const requestMarker = "## My request:";
    if (text.includes(requestMarker)) {
      return text.slice(text.indexOf(requestMarker) + requestMarker.length).trim();
    }
    if (/^(?:#\s*)?Files mentioned by the user\b/i.test(text)) return "";
    if (/^<(recommended_plugins|environment_context|in-app-browser-context|app-context|codex_internal_context|skills_instructions|permissions|plugins_instructions|apps_instructions)\b/i.test(text)) return "";
    if (text.startsWith("Another language model started to solve this problem")) return "";
    return text;
  }).filter(Boolean).join(" "));
}

function taskTitle(value) {
  const title = conciseText(value, 80);
  if (/^(?:#\s*)?Files mentioned by the user\b/i.test(title)) return "";
  if (/^<(?:codex_internal_context|environment_context|app-context)\b/i.test(title)) return "";
  if (title.startsWith("Another language model started to solve this problem")) return "";
  return title;
}

function messageTurnId(row) {
  const metadata = row?.payload?.internal_chat_message_metadata_passthrough;
  return typeof metadata?.turn_id === "string" ? metadata.turn_id : "";
}

function mergePrompt(current, next) {
  if (!next || current === next || current?.includes(next)) return current || "";
  return conciseText([current, next].filter(Boolean).join(" "));
}

async function loadThreadMetadata() {
  if (Date.now() - threadMetadataCache.loadedAt < 60_000) return threadMetadataCache;
  const titles = new Map();
  const roots = new Map();
  const codexRoot = codexDataDirectory();
  try {
    let indexedNames = new Map();
    try {
      indexedNames = parseSessionNames(await readFile(path.join(codexRoot, "session_index.jsonl"), "utf8"));
    } catch {
      // Older Codex versions may not have a session index.
    }
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(path.join(codexRoot, "state_5.sqlite"), { readOnly: true });
    try {
      const rows = database.prepare("SELECT id, rollout_path, name, title, source, thread_source FROM threads WHERE rollout_path IS NOT NULL").all();
      const sessionById = new Map(rows.map((row) => [String(row.id || ""), path.basename(String(row.rollout_path || "")).toLowerCase()]));
      const parentBySession = new Map();
      for (const row of rows) {
        const sessionKey = path.basename(String(row.rollout_path || "")).toLowerCase();
        const title = taskTitle(indexedNames.get(String(row.id || "")) || row.name || row.title || "");
        if (sessionKey && title) titles.set(sessionKey, title);
        if (row.thread_source !== "subagent" || !sessionKey) continue;
        try {
          const source = JSON.parse(String(row.source || "{}"));
          const parentId = source?.subagent?.thread_spawn?.parent_thread_id;
          const parentSession = sessionById.get(String(parentId || ""));
          if (parentSession) parentBySession.set(sessionKey, parentSession);
        } catch {
          // Older records can use a non-JSON source label; leave them as standalone tasks.
        }
      }
      for (const sessionKey of sessionById.values()) {
        let root = sessionKey;
        const visited = new Set();
        while (parentBySession.has(root) && !visited.has(root)) {
          visited.add(root);
          root = parentBySession.get(root);
        }
        roots.set(sessionKey, root);
      }
    } finally {
      database.close();
    }
  } catch {
    // Node 20 and non-Codex environments may not expose node:sqlite or the state database.
  }
  threadMetadataCache = { loadedAt: Date.now(), titles, roots };
  return threadMetadataCache;
}

export function parseSessionNames(content) {
  const names = new Map();
  for (const line of String(content || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      const id = String(row?.id || "");
      const name = taskTitle(row?.thread_name || "");
      if (id && name) names.set(id, name);
    } catch {
      // Ignore a partially written or legacy index row.
    }
  }
  return names;
}

export function groupTasksByRoot(tasks, { titles = new Map(), roots = new Map() } = {}) {
  const grouped = new Map();
  for (const task of tasks.values()) {
    const rootKey = roots.get(task.sessionKey) || task.sessionKey;
    const existing = grouped.get(rootKey);
    if (existing) {
      existing.turns.push(...task.turns);
      continue;
    }
    grouped.set(rootKey, {
      ...task,
      sessionKey: rootKey,
      title: taskTitle(titles.get(rootKey) || task.title || ""),
      turns: [...task.turns],
    });
  }
  tasks.clear();
  for (const [sessionKey, task] of grouped) tasks.set(sessionKey, task);
  return tasks;
}

async function attachTaskMetadata(tasks) {
  const metadata = await loadThreadMetadata();
  groupTasksByRoot(tasks, metadata);
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
  const turns = [];
  const seenEvents = new Set();
  const unidentifiedByDay = new Map();
  const promptsByTurn = new Map();
  let previousCumulative = null;
  let activeTurn = null;
  const input = createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });

  const finishActiveTurn = (timestamp) => {
    if (!activeTurn || !activeTurn.usage.totalTokens) {
      activeTurn = null;
      return;
    }
    turns.push({
      day: localDayKey(timestamp || activeTurn.timestamp),
      timestamp: String(timestamp || activeTurn.timestamp || ""),
      identified: Boolean(activeTurn.turnId),
      prompt: activeTurn.prompt || "",
      usage: activeTurn.usage,
    });
    activeTurn = null;
  };

  try {
    for await (const line of lines) {
      if (line.length > MAX_LINE_BYTES) continue;
      const possibleEvent = line.includes('"event_msg"') && ["token_count", "task_started", "task_complete"].some((type) => line.includes(`"${type}"`));
      const possibleUser = line.includes('"response_item"') && (line.includes('"role":"user"') || line.includes('"role": "user"'));
      if (!possibleEvent && !possibleUser) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (row?.type === "response_item") {
        const prompt = userPrompt(row);
        const turnId = messageTurnId(row);
        if (prompt && turnId) promptsByTurn.set(turnId, mergePrompt(promptsByTurn.get(turnId), prompt));
        if (prompt && activeTurn && (!turnId || turnId === activeTurn.turnId)) activeTurn.prompt = mergePrompt(activeTurn.prompt, prompt);
        continue;
      }
      if (row?.type !== "event_msg") continue;
      const payloadType = row?.payload?.type;
      if (payloadType === "task_started") {
        finishActiveTurn(row.timestamp);
        activeTurn = {
          turnId: typeof row.payload.turn_id === "string" ? row.payload.turn_id : "",
          timestamp: String(row.timestamp || ""),
          prompt: promptsByTurn.get(row.payload.turn_id) || "",
          usage: emptyUsage(),
        };
        continue;
      }
      if (payloadType === "task_complete") {
        finishActiveTurn(row.timestamp);
        continue;
      }
      if (payloadType !== "token_count") continue;
      const turnId = typeof row.payload.turn_id === "string" ? row.payload.turn_id : "";
      const dedupKey = turnId || String(row.timestamp || "");
      if (dedupKey && seenEvents.has(dedupKey)) continue;
      const baselines = new Map([[filePath, previousCumulative]]);
      const usage = eventUsage(row, baselines, filePath);
      previousCumulative = baselines.get(filePath) || previousCumulative;
      if (!usage) continue;
      if (dedupKey) seenEvents.add(dedupKey);
      const day = localDayKey(row.timestamp);
      if (!day) continue;
      const timestamp = String(row.timestamp || "");
      deltas.push({ day, timestamp, usage });
      if (activeTurn) {
        addUsage(activeTurn.usage, usage);
        activeTurn.timestamp = timestamp || activeTurn.timestamp;
      } else if (turnId) {
        turns.push({ day, timestamp, identified: true, prompt: promptsByTurn.get(turnId) || "", usage });
      } else {
        const unattributed = unidentifiedByDay.get(day) || {
          day,
          timestamp,
          identified: false,
          prompt: "",
          usage: emptyUsage(),
        };
        unattributed.timestamp = timestamp || unattributed.timestamp;
        addUsage(unattributed.usage, usage);
        unidentifiedByDay.set(day, unattributed);
      }
    }
    finishActiveTurn(activeTurn?.timestamp);
  } finally {
    lines.close();
    input.destroy();
  }
  turns.push(...unidentifiedByDay.values());
  return { deltas, turns };
}

async function scanWithRipgrep(sourceRoots) {
  const buckets = new Map();
  const tasks = new Map();
  const seenEvents = new Set();
  const seenTaskTurns = new Set();
  const activeTurns = new Map();
  const unidentifiedTurns = new Map();
  const promptsByTurn = new Map();
  const filesWithUsage = new Set();
  const previousBySession = new Map();
  let matchedLines = 0;
  const args = [
    "--no-heading",
    "--with-filename",
    "--null",
    "--no-messages",
    '(?:"type"\\s*:\\s*"(?:token_count|task_started|task_complete)"|"role"\\s*:\\s*"user")',
    ...sourceRoots,
  ];

  await new Promise((resolve, reject) => {
    const child = spawn("rg", args, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    const decoder = new StringDecoder("utf8");
    let pending = "";
    let spawnError = null;

    const appendTurn = (sessionKey, turn, turnId = "") => {
      if (!turn?.usage?.totalTokens) return;
      const uniqueTurn = turnId ? `${sessionKey}:${turnId}` : "";
      if (uniqueTurn && seenTaskTurns.has(uniqueTurn)) return;
      if (uniqueTurn) seenTaskTurns.add(uniqueTurn);
      const task = tasks.get(sessionKey) || { sessionKey, turns: [] };
      task.turns.push(turn);
      tasks.set(sessionKey, task);
    };

    const finishActiveTurn = (sessionKey, timestamp) => {
      const active = activeTurns.get(sessionKey);
      if (!active) return;
      appendTurn(sessionKey, {
        day: localDayKey(timestamp || active.timestamp),
        timestamp: String(timestamp || active.timestamp || ""),
        identified: Boolean(active.turnId),
        prompt: active.prompt || "",
        usage: active.usage,
      }, active.turnId);
      activeTurns.delete(sessionKey);
    };

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
      const sessionKey = path.basename(filePath).toLowerCase();
      if (row?.type === "response_item") {
        const prompt = userPrompt(row);
        const turnId = messageTurnId(row);
        const promptKey = turnId ? `${sessionKey}:${turnId}` : "";
        if (promptKey && prompt) promptsByTurn.set(promptKey, mergePrompt(promptsByTurn.get(promptKey), prompt));
        const active = activeTurns.get(sessionKey);
        if (prompt && active && (!turnId || turnId === active.turnId)) active.prompt = mergePrompt(active.prompt, prompt);
        return;
      }
      if (row?.type !== "event_msg") return;
      const payloadType = row?.payload?.type;
      if (payloadType === "task_started") {
        finishActiveTurn(sessionKey, row.timestamp);
        const turnId = typeof row.payload.turn_id === "string" ? row.payload.turn_id : "";
        activeTurns.set(sessionKey, {
          turnId,
          timestamp: String(row.timestamp || ""),
          prompt: promptsByTurn.get(`${sessionKey}:${turnId}`) || "",
          usage: emptyUsage(),
        });
        return;
      }
      if (payloadType === "task_complete") {
        finishActiveTurn(sessionKey, row.timestamp);
        return;
      }
      if (payloadType !== "token_count") return;
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
      const timestamp = String(row.timestamp || "");
      const active = activeTurns.get(sessionKey);
      if (active) {
        addUsage(active.usage, usage);
        active.timestamp = timestamp || active.timestamp;
      } else if (turnId) {
        appendTurn(sessionKey, { day, timestamp, identified: true, prompt: promptsByTurn.get(`${sessionKey}:${turnId}`) || "", usage }, turnId);
      } else {
        const key = `${sessionKey}:${day}`;
        const unattributed = unidentifiedTurns.get(key) || {
          sessionKey,
          day,
          timestamp,
          identified: false,
          prompt: "",
          usage: emptyUsage(),
        };
        unattributed.timestamp = timestamp || unattributed.timestamp;
        addUsage(unattributed.usage, usage);
        unidentifiedTurns.set(key, unattributed);
      }
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
      for (const sessionKey of activeTurns.keys()) finishActiveTurn(sessionKey);
      for (const turn of unidentifiedTurns.values()) appendTurn(turn.sessionKey, turn);
      resolve();
    });
  });

  return {
    generatedAtMs: Date.now(),
    buckets,
    tasks,
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
      if (raw.version !== 7 || !Number.isFinite(raw.generatedAtMs) || !Array.isArray(raw.days) || !Array.isArray(raw.tasks)) continue;
      ripgrepSnapshot = {
        generatedAtMs: raw.generatedAtMs,
        buckets: new Map(raw.days.map((day) => [day.day, day])),
        tasks: new Map((raw.tasks || []).map((task) => [task.sessionKey, task])),
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
    await attachTaskMetadata(fresh.tasks);
    ripgrepSnapshot = fresh;
    try {
      await mkdir(path.dirname(snapshotPath), { recursive: true });
      await writeFile(snapshotPath, JSON.stringify({
        version: 7,
        generatedAtMs: fresh.generatedAtMs,
        days: [...fresh.buckets.values()],
        tasks: [...fresh.tasks.values()],
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
  if (cached?.fingerprint === fingerprint) return { ...cached.result, hit: true };
  const result = await parseRollout(filePath);
  fileCache.set(filePath, { fingerprint, result });
  return { ...result, hit: false };
}

function summarize(days) {
  const total = emptyUsage();
  for (const day of days) addUsage(total, day);
  return total;
}

function anonymousTaskId(sessionKey) {
  return createHash("sha256").update(sessionKey).digest("hex").slice(0, 12);
}

function taskBreakdown(tasks, cutoffDay, today) {
  const result = [];
  for (const task of tasks.values()) {
    const turns = task.turns
      .filter((turn) => turn.day >= cutoffDay && turn.day <= today)
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
    if (!turns.length) continue;
    const usage = summarize(turns.map((turn) => turn.usage));
    const id = anonymousTaskId(task.sessionKey);
    const fallbackTitle = turns.find((turn) => turn.prompt)?.prompt || "";
    result.push({
      id,
      label: `任务 ${id.slice(0, 4).toUpperCase()}`,
      title: taskTitle(task.title) || taskTitle(fallbackTitle),
      firstActivity: turns[0].timestamp,
      lastActivity: turns.at(-1).timestamp,
      ...usage,
      turns: turns.map((turn, index) => ({
        number: index + 1,
        timestamp: turn.timestamp,
        identified: turn.identified,
        prompt: conciseText(turn.prompt, 240),
        ...turn.usage,
      })),
    });
  }
  return result.sort((left, right) =>
    right.totalTokens - left.totalTokens || right.lastActivity.localeCompare(left.lastActivity));
}

export async function collectUsage({ days = 30, roots, now = new Date() } = {}) {
  const range = Math.max(7, Math.min(365, Number(days) || 30));
  const today = localDayKey(now);
  const cutoffDay = shiftDay(today, -(range - 1));
  const codexRoot = codexDataDirectory();
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
      await attachTaskMetadata(ripgrepSnapshot.tasks || new Map());
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
        tasks: taskBreakdown(ripgrepSnapshot.tasks || new Map(), cutoffDay, today),
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
  const tasks = new Map();
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
    const sessionKey = path.basename(filePath).toLowerCase();
    const task = tasks.get(sessionKey) || { sessionKey, turns: [] };
    task.turns.push(...result.turns);
    tasks.set(sessionKey, task);
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
  if (!roots) await attachTaskMetadata(tasks);

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
    tasks: taskBreakdown(tasks, cutoffDay, today),
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
