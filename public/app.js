const state = { days: 30, data: null, timer: null };
const formatter = new Intl.NumberFormat("zh-CN");
const compactFormatter = new Intl.NumberFormat("zh-CN", {
  notation: "compact",
  maximumFractionDigits: 1,
});

const $ = (selector) => document.querySelector(selector);
const format = (value) => formatter.format(Math.round(value || 0));
const compact = (value) => compactFormatter.format(Math.round(value || 0));
const prettyDate = (day) => new Intl.DateTimeFormat("zh-CN", {
  month: "short",
  day: "numeric",
  weekday: "short",
}).format(new Date(`${day}T12:00:00`));

function renderSparkline(days) {
  const values = days.slice(-7).map((day) => day.totalTokens);
  const max = Math.max(...values, 1);
  const points = values.map((value, index) => `${index * 20},${48 - (value / max) * 38}`).join(" ");
  $("#sparkline").innerHTML = `<svg viewBox="0 0 120 55" preserveAspectRatio="none"><polyline points="${points}" fill="none" stroke="#6ee7a5" stroke-width="2" vector-effect="non-scaling-stroke"/><polyline points="0,52 ${points} 120,52" fill="rgba(110,231,165,.08)" stroke="none"/></svg>`;
}

function renderTrend(days) {
  const width = 900;
  const height = 250;
  const padding = { left: 48, right: 16, top: 12, bottom: 30 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const max = Math.max(...days.map((day) => day.totalTokens), 1);
  const niceMax = Math.ceil(max / 1000) * 1000 || 1;
  const x = (index) => padding.left + (index / Math.max(days.length - 1, 1)) * innerWidth;
  const y = (value) => padding.top + innerHeight - (value / niceMax) * innerHeight;
  const points = days.map((day, index) => `${x(index).toFixed(1)},${y(day.totalTokens).toFixed(1)}`).join(" ");
  const area = `${padding.left},${padding.top + innerHeight} ${points} ${padding.left + innerWidth},${padding.top + innerHeight}`;
  const grid = [0, .25, .5, .75, 1].map((ratio) => {
    const yy = padding.top + innerHeight * (1 - ratio);
    return `<line class="grid-line" x1="${padding.left}" x2="${width - padding.right}" y1="${yy}" y2="${yy}"/><text class="axis-label" x="0" y="${yy + 3}">${compact(niceMax * ratio)}</text>`;
  }).join("");
  const step = Math.max(1, Math.ceil(days.length / 6));
  const labels = days.map((day, index) => index % step === 0 || index === days.length - 1
    ? `<text class="axis-label" x="${x(index)}" y="${height - 7}" text-anchor="middle">${day.day.slice(5).replace("-", "/")}</text>` : "").join("");
  const dots = days.map((day, index) => `<circle class="trend-point" cx="${x(index)}" cy="${y(day.totalTokens)}" r="3"><title>${day.day} · ${format(day.totalTokens)} Token</title></circle>`).join("");
  $("#trend-chart").innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"><defs><linearGradient id="trend-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6ee7a5" stop-opacity=".22"/><stop offset="1" stop-color="#6ee7a5" stop-opacity="0"/></linearGradient></defs>${grid}<polygon class="trend-area" points="${area}"/><polyline class="trend-line" points="${points}"/>${dots}${labels}</svg>`;
}

function renderDonut(today) {
  const uncached = today.uncachedInputTokens;
  const cached = today.cachedInputTokens;
  const output = today.outputTokens;
  const total = Math.max(uncached + cached + output, 1);
  const first = (uncached / total) * 100;
  const second = first + (cached / total) * 100;
  $("#donut").style.background = `conic-gradient(#6ee7a5 0 ${first}%, #9487ff ${first}% ${second}%, #77d7e8 ${second}% 100%)`;
  $("#donut strong").textContent = compact(today.totalTokens);
  $("#uncached-value").textContent = format(uncached);
  $("#cached-value").textContent = format(cached);
  $("#output-value").textContent = format(output);
}

function levelFor(value, max) {
  if (!value) return 0;
  const ratio = value / Math.max(max, 1);
  if (ratio < .15) return 1;
  if (ratio < .4) return 2;
  if (ratio < .7) return 3;
  return 4;
}

function renderHeatmap(days) {
  const values = days.slice(-91);
  const max = Math.max(...values.map((day) => day.totalTokens), 1);
  $("#heatmap").innerHTML = values.map((day) => `<span class="heat-cell" data-level="${levelFor(day.totalTokens, max)}" title="${day.day} · ${format(day.totalTokens)} Token"></span>`).join("");
  let streak = 0;
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (values[index].totalTokens <= 0) break;
    streak += 1;
  }
  $("#streak").textContent = `连续 ${streak} 天`;
}

function renderRecent(days) {
  const recent = days.slice(-7).reverse();
  const max = Math.max(...recent.map((day) => day.totalTokens), 1);
  $("#recent-list").innerHTML = recent.map((day) => `<div class="recent-row"><time>${day.day.slice(5).replace("-", "/")}</time><span class="recent-bar"><i style="width:${(day.totalTokens / max) * 100}%"></i></span><strong>${compact(day.totalTokens)}</strong></div>`).join("");
}

function render(data) {
  state.data = data;
  const { today, yesterday, last7, last30, days } = data;
  $("#today-value").textContent = format(today.totalTokens);
  $("#today-date").textContent = `${prettyDate(today.day)} · ${today.events} 次用量事件`;
  $("#week-value").textContent = compact(last7.totalTokens);
  $("#week-average").textContent = `日均 ${compact(last7.totalTokens / 7)} Token`;
  $("#month-value").textContent = compact(last30.totalTokens);
  $("#active-days").textContent = `活跃 ${days.slice(-30).filter((day) => day.totalTokens > 0).length} 天`;

  const change = $("#today-change");
  if (!yesterday.totalTokens) {
    change.textContent = today.totalTokens ? "今日首笔" : "暂无使用";
    change.className = "change neutral";
  } else {
    const percent = ((today.totalTokens - yesterday.totalTokens) / yesterday.totalTokens) * 100;
    change.textContent = `${percent >= 0 ? "↑" : "↓"} ${Math.abs(percent).toFixed(0)}% 较昨日`;
    change.className = `change ${percent > 0 ? "up" : percent < 0 ? "down" : "neutral"}`;
  }

  renderSparkline(days);
  renderTrend(days);
  renderDonut(today);
  renderHeatmap(days);
  renderRecent(days);
  const time = new Date(data.generatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  $("#status").className = "";
  $("#status").innerHTML = `<i></i>已同步 · ${time}`;
  $("#diagnostics").textContent = `${data.diagnostics.candidateFiles} 个会话文件 · ${data.timezone}`;
}

async function load() {
  const refresh = $("#refresh");
  refresh.classList.add("loading");
  $("#status").innerHTML = "<i></i>正在读取本地日志…";
  try {
    const response = await fetch(`/api/usage?days=${state.days}`, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.detail || payload.error || `HTTP ${response.status}`);
    render(payload);
  } catch (error) {
    const status = $("#status");
    status.className = "error";
    status.replaceChildren(document.createElement("i"), document.createTextNode(`读取失败：${error.message}`));
  } finally {
    refresh.classList.remove("loading");
  }
}

document.querySelectorAll("[data-days]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-days]").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    state.days = Number(button.dataset.days);
    load();
  });
});
$("#refresh").addEventListener("click", load);
load();
state.timer = window.setInterval(load, 5 * 60_000);
