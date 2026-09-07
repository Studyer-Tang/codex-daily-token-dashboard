import { createReadStream } from "node:fs";
import { mkdir, opendir, readFile, stat, writeFile, rename, open, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
const compress = promisify(gzip), decompress = promisify(gunzip);

const MAX_LINE_BYTES = 16 * 1024 * 1024;
const SNAPSHOT_VERSION = 10;
const TTL = 4 * 60_000;
let threadMetadataCache = { loadedAt: 0, titles: new Map(), roots: new Map() };

export function applicationCacheDirectory() {
  if (process.env.CODEX_TOKEN_CACHE_DIR) return path.resolve(process.env.CODEX_TOKEN_CACHE_DIR);
  if (process.platform === "win32" && process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, "CodexTokenWidget");
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "codex-token-widget");
}

export function codexDataDirectory({ environment = process.env, home = os.homedir() } = {}) {
  const configured = String(environment.CODEX_HOME || "").trim();
  return configured ? path.resolve(configured) : path.join(home, ".codex");
}

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
  const cumulativeNow = normalizeUsage(info.total_token_usage);
  const baseline = previousBySession.get(sessionKey);
  if (cumulativeNow && baseline && cumulativeNow.totalTokens === baseline.totalTokens) return null;
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
  if (threadMetadataCache.source === codexDataDirectory() && Date.now() - threadMetadataCache.loadedAt < 60_000) return threadMetadataCache;
  const titles = new Map();
  const roots = new Map();
  const codexRoot = codexDataDirectory();
  let indexedNames = new Map();
  try {
    try {
      indexedNames = parseSessionNames(await readFile(path.join(codexRoot, "session_index.jsonl"), "utf8"));
    } catch {
      // Older Codex versions may not have a session index.
    }
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(path.join(codexRoot, "state_5.sqlite"), { readOnly: true });
    try {
      const available = new Set(database.prepare("PRAGMA table_info(threads)").all().map((column) => column.name));
      const fields = ["id", "rollout_path", "name", "title", "source", "thread_source"];
      const rows = database.prepare("SELECT " + fields.map((field) => available.has(field) ? field : "NULL AS " + field).join(",") + " FROM threads WHERE rollout_path IS NOT NULL").all();
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
  threadMetadataCache = { source: codexRoot, loadedAt: Date.now(), titles, roots, indexedNames };
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
  for (const task of tasks.values()) {
    const id = task.sessionKey.match(/([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i)?.[1];
    const indexedTitle = metadata.indexedNames?.get(id);
    if (indexedTitle) metadata.titles.set(task.sessionKey, indexedTitle);
  }
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


async function listJsonlFiles(root, output, optional = false) {
  let handle;
  try { handle = await opendir(root); }
  catch (error) {
    if (optional && error.code === "ENOENT") return false;
    throw error;
  }
  for await (const entry of handle) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) await listJsonlFiles(absolute, output);
    else if (entry.isFile() && /^rollout-.*\.jsonl$/i.test(entry.name)) output.push(absolute);
  }
  return true;
}

function parserState() {
  return { offset: 0, previous: new Map(), seen: new Set(), turns: new Map(), prompts: new Map(), active: "", serial: 0 };
}

function consumeLine(state, line, eof = false) {
  if (eof) { try { JSON.parse(line); } catch { return false; } }
  if (!/"(?:token_count|task_started|task_complete|response_item)"/.test(line)) return true;
  if (/"type"\s*:\s*"response_item"/.test(line) && !/"role"\s*:\s*"user"/.test(line)) return true;
  let row;
  try { row = JSON.parse(line); } catch { return false; }
  if (row?.type === "response_item") {
    const prompt = userPrompt(row);
    const id = messageTurnId(row) || state.active;
    if (prompt && id) {
      state.prompts.set(id, mergePrompt(state.prompts.get(id), prompt));
    }
    return true;
  }
  if (row?.type !== "event_msg") return true;
  const type = row.payload?.type;
  if (type === "task_started") {
    state.active = row.payload.turn_id || "unidentified-" + (++state.serial);
    return true;
  }
  if (type === "task_complete") {
    if (!row.payload.turn_id || row.payload.turn_id === state.active) state.active = "";
    return true;
  }
  if (type !== "token_count") return true;
  const day = localDayKey(row.timestamp);
  if (!day) return true;
  // A turn may contain many calls. Only identical event content is a duplicate;
  // unchanged cumulative totals are handled by eventUsage.
  const key = createHash("sha256").update(JSON.stringify([row.timestamp, row.payload.turn_id, row.payload.info])).digest("base64url").slice(0, 22);
  if (state.seen.has(key)) return true;
  const usage = eventUsage(row, state.previous, "session");
  if (!usage) return true;
  state.seen.add(key);
  const turnId = row.payload.turn_id || state.active || "unidentified-day-" + day;
  const identified = !turnId.startsWith("unidentified-");
  // One row per turn/day: clipping a date range never imports another day's cost.
  const turnKey = turnId + ":" + day;
  const turn = state.turns.get(turnKey) || { turnId, day, timestamp: row.timestamp, identified, prompt: state.prompts.get(turnId) || "", usage: emptyUsage() };
  turn.timestamp = row.timestamp;
  addUsage(turn.usage, usage);
  state.turns.set(turnKey, turn);
  return true;
}

async function anchor(filePath, offset) {
  const file = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(Math.min(256, offset));
    await file.read(buffer, 0, buffer.length, Math.max(0, offset - buffer.length));
    return buffer.toString("base64");
  } finally { await file.close(); }
}

// Retain only bounded line buffers, including for giant tool-output records.
// A partial last line is reread on the next refresh; a complete JSON EOF record
// is supported for imported logs without a final newline.
async function readIncrement(filePath, metadata, previous) {
  let state = previous;
  let reused = false;
  if (state && state.ino === metadata.ino && state.birthtimeMs === metadata.birthtimeMs &&
      metadata.size >= state.size && await anchor(filePath, state.offset) === state.anchor) {
    reused = true;
  } else state = parserState();
  const initialOffset = state.offset;
  const stream = metadata.size > state.offset ? createReadStream(filePath, { start: state.offset, end: metadata.size - 1, highWaterMark: 1024 * 1024 }) : null;
  let parts = [], length = 0, skipping = false, position = state.offset;
  if (stream) for await (const chunk of stream) {
    let start = 0;
    for (;;) {
      const end = chunk.indexOf(10, start);
      const stop = end < 0 ? chunk.length : end;
      const part = chunk.subarray(start, stop);
      position += part.length;
      length += part.length;
      if (length > MAX_LINE_BYTES) { skipping = true; parts = []; }
      if (!skipping && part.length) parts.push(part);
      if (end < 0) break;
      if (!skipping) consumeLine(state, Buffer.concat(parts, length).toString("utf8"));
      position++;
      state.offset = position;
      parts = []; length = 0; skipping = false;
      start = end + 1;
    }
  }
  if (!skipping && length && consumeLine(state, Buffer.concat(parts, length).toString("utf8"), true)) state.offset = position;
  // A changed same-size file must always be reparsed, even if its final bytes match.
  state.anchor = await anchor(filePath, state.offset);
  state.size = metadata.size; state.mtimeMs = metadata.mtimeMs;
  state.ino = metadata.ino; state.birthtimeMs = metadata.birthtimeMs;
  return { state, bytesRead: metadata.size - initialOffset, reused };
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
    const turns = task.turns.filter((turn) => turn.day >= cutoffDay && turn.day <= today)
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    if (!turns.length) continue;
    const id = anonymousTaskId(task.sessionKey);
    const publicTurns = turns.map((turn, index) => ({
      number: index + 1, timestamp: turn.timestamp, day: turn.day, identified: turn.identified,
      prompt: conciseText(turn.prompt), ...turn.usage,
    }));
    result.push({
      id, label: "任务 " + id.slice(0, 4).toUpperCase(),
      title: taskTitle(task.title) || taskTitle(turns.find((turn) => turn.prompt)?.prompt || ""),
      firstActivity: turns[0].timestamp, lastActivity: turns.at(-1).timestamp,
      ...summarize(turns.map((turn) => turn.usage)), turnCount: turns.length,
      revision: createHash("sha256").update(JSON.stringify(publicTurns)).digest("hex").slice(0, 16),
      turns: publicTurns,
    });
  }
  return result.sort((a, b) => b.totalTokens - a.totalTokens || b.lastActivity.localeCompare(a.lastActivity));
}

export function createUsageCollector({ cacheDirectory = applicationCacheDirectory(), clock = Date.now } = {}) {
  const sources = new Map();
  async function refresh(source, roots, useMetadata) {
    if (source.refresh) return source.refresh;
    source.refresh = (async () => {
      const discovered = [];
      let found = false;
      for (const root of roots) found = await listJsonlFiles(root, discovered, true) || found;
      if (!found) throw new Error("会话目录不存在或不可读取");
      const unique = new Map();
      // Limit outstanding filesystem work, rather than opening every log at once.
      for (let i = 0; i < discovered.length; i += 32) {
        await Promise.all(discovered.slice(i, i + 32).map(async (filePath) => {
          const metadata = await stat(filePath);
          const key = path.basename(filePath).toLowerCase();
          const prior = unique.get(key);
          if (!prior || metadata.mtimeMs > prior.metadata.mtimeMs ||
              (metadata.mtimeMs === prior.metadata.mtimeMs && metadata.size > prior.metadata.size)) unique.set(key, { filePath, metadata });
        }));
      }
      let parsedFiles = 0, cacheHits = 0, bytesRead = 0;
      const tasks = new Map(), buckets = new Map(), livePaths = new Set();
      for (const [sessionKey, { filePath, metadata }] of unique) {
        livePaths.add(filePath);
        let state = source.files.get(filePath);
        if (state && state.size === metadata.size && state.mtimeMs === metadata.mtimeMs &&
            state.ino === metadata.ino && state.birthtimeMs === metadata.birthtimeMs) cacheHits++;
        else {
          const prior = state && metadata.size > state.size ? state : null;
          // Remove before mutating: a read failure must not leave a half-valid checkpoint.
          source.files.delete(filePath);
          const read = await readIncrement(filePath, metadata, prior);
          state = read.state; bytesRead += read.bytesRead; parsedFiles++;
          source.files.set(filePath, state);
        }
        const turns = [...state.turns.values()].map(({ turnId, ...turn }) => ({ ...turn, prompt: state.prompts.get(turnId) || turn.prompt, usage: { ...turn.usage } }));
        tasks.set(sessionKey, { sessionKey, turns });
        for (const turn of turns) {
          const bucket = buckets.get(turn.day) || { day: turn.day, ...emptyUsage() };
          addUsage(bucket, turn.usage); buckets.set(turn.day, bucket);
        }
      }
      for (const filePath of source.files.keys()) if (!livePaths.has(filePath)) source.files.delete(filePath);
      if (useMetadata) await attachTaskMetadata(tasks);
      const snapshot = { generatedAtMs: clock(), tasks, buckets, diagnostics: {
        discoveredFiles: discovered.length, uniqueFiles: unique.size, candidateFiles: unique.size,
        parsedFiles, cacheHits, bytesRead, scanner: "node-incremental",
      }};
      source.snapshot = snapshot;
      source.views.clear();
      source.error = "";
      if (source.persist) {
        try {
          await mkdir(cacheDirectory, { recursive: true });
          const target = path.join(cacheDirectory, "usage-" + source.key + ".json.gz");
          const temp = target + "." + randomUUID() + ".tmp";
          try {
          await writeFile(temp, await compress(JSON.stringify({ version: SNAPSHOT_VERSION, sourceKey: source.key,
            generatedAtMs: snapshot.generatedAtMs, days: [...buckets.values()], tasks: [...tasks.values()], diagnostics: snapshot.diagnostics,
            files: [...source.files].map(([filePath, state]) => [filePath, { ...state, previous: [...state.previous], seen: [...state.seen], turns: [...state.turns], prompts: [...state.prompts] }]) }), { level: 1 }), { mode: 0o600 });
          await rename(temp, target);
          } finally { await unlink(temp).catch(() => {}); }
        } catch { snapshot.diagnostics.cacheWriteFailed = true; }
      }
    })().finally(() => { source.refresh = null; });
    return source.refresh;
  }
  return async function collect({ days = 30, roots, now = new Date(), forceRefresh = false } = {}) {
    const range = Math.max(7, Math.min(365, Math.floor(Number(days) || 30)));
    const today = localDayKey(now);
    const cutoff = shiftDay(today, -(range - 1));
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
    const sourceRoots = (roots || [path.join(codexDataDirectory(), "sessions"), path.join(codexDataDirectory(), "archived_sessions")]).map((root) => path.resolve(root));
    const key = createHash("sha256").update(JSON.stringify([SNAPSHOT_VERSION, timezone, sourceRoots])).digest("hex").slice(0, 24);
    let source = sources.get(key);
    if (!source) {
      source = { key, files: new Map(), views: new Map(), snapshot: null, refresh: null, persist: !roots, error: "" };
      sources.set(key, source);
      if (sources.size > 4) for (const [oldKey, oldSource] of sources) if (oldKey !== key && !oldSource.refresh) { sources.delete(oldKey); break; }
      if (source.persist) try {
        const raw = JSON.parse(await decompress(await readFile(path.join(cacheDirectory, "usage-" + key + ".json.gz")), { maxOutputLength: 512 * 1024 * 1024 }));
        const validUsage = (u) => u && Object.keys(emptyUsage()).every((field) => Number.isFinite(u[field]) && u[field] >= 0);
        if (raw.version === SNAPSHOT_VERSION && raw.sourceKey === key && Number.isFinite(raw.generatedAtMs) &&
            raw.generatedAtMs <= clock() && Array.isArray(raw.days) && Array.isArray(raw.tasks) &&
            raw.days.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.day) && validUsage(d)) &&
            raw.tasks.every((t) => typeof t.sessionKey === "string" && Array.isArray(t.turns) &&
              t.turns.every((v) => validUsage(v.usage) && Number.isFinite(Date.parse(v.timestamp)) && typeof v.day === "string"))) {
          source.snapshot = { generatedAtMs: raw.generatedAtMs, buckets: new Map(raw.days.map((d) => [d.day, d])),
            tasks: new Map(raw.tasks.map((t) => [t.sessionKey, t])), diagnostics: { ...raw.diagnostics, cacheSource: "disk" } };
          if (Array.isArray(raw.files)) for (const [filePath, state] of raw.files) {
            if (typeof filePath !== "string" || !sourceRoots.some(root => {
              const relative = path.relative(root, filePath);
              return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
            })) continue;
            if (!Number.isSafeInteger(state.offset) || state.offset < 0 || state.offset > state.size ||
                !Number.isFinite(state.mtimeMs) || !Number.isFinite(state.birthtimeMs) || typeof state.anchor !== "string" ||
                !Array.isArray(state.previous) || !Array.isArray(state.seen) || !Array.isArray(state.turns) || !Array.isArray(state.prompts) ||
                !state.previous.every(pair => Array.isArray(pair) && validUsage(pair[1])) ||
                !state.turns.every(pair => Array.isArray(pair) && validUsage(pair[1]?.usage) && typeof pair[1]?.turnId === "string") ||
                !state.prompts.every(pair => Array.isArray(pair) && typeof pair[0] === "string" && typeof pair[1] === "string") ||
                !state.seen.every(key => typeof key === "string")) continue;
            source.files.set(filePath, { ...state, previous: new Map(state.previous), seen: new Set(state.seen), turns: new Map(state.turns), prompts: new Map(state.prompts) });
          }
        }
      } catch { /* Invalid or old caches are rebuilt from source. */ }
    }
    if (!source.snapshot || forceRefresh || roots || clock() - source.snapshot.generatedAtMs >= TTL) {
      try { await refresh(source, sourceRoots, !roots); }
      catch {
        source.error = "本地日志刷新失败，当前显示上次成功统计";
        if (!source.snapshot) throw new Error("无法读取本地会话目录，尚无可用统计缓存");
      }
    }
    const snapshot = source.snapshot;
    const viewKey = today + ":" + range;
    let view = source.views.get(viewKey);
    if (!view) {
      const timeline = Array.from({ length: range }, (_, index) => {
        const day = shiftDay(cutoff, index);
        return snapshot.buckets.get(day) || { day, ...emptyUsage() };
      });
      const month = Array.from({ length: 30 }, (_, index) => snapshot.buckets.get(shiftDay(today, index - 29)) || emptyUsage());
      view = {
        generatedAt: new Date(snapshot.generatedAtMs).toISOString(), timezone, range,
        today: timeline.at(-1), yesterday: timeline.at(-2), last7: summarize(month.slice(-7)),
        last30: summarize(month), activeDays30: month.filter((d) => d.totalTokens > 0).length,
        total: summarize(timeline), days: timeline, tasks: taskBreakdown(snapshot.tasks, cutoff, today),
        diagnostics: { ...snapshot.diagnostics },
      };
      if (source.views.size >= 8) source.views.delete(source.views.keys().next().value);
      source.views.set(viewKey, view);
    }
    return { ...view, stale: Boolean(source.error) || clock() - snapshot.generatedAtMs >= TTL, refreshError: source.error };
  };
}

export const collectUsage = createUsageCollector();
export { emptyUsage, normalizeUsage };
