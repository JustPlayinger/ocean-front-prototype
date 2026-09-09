/* 渔场向导 · 交互原型（纯前端演示，无真实数据） */
"use strict";

// ---------- 全局状态 ----------
const state = {
  scale: "day",            // day | days | month | year
  date: "2024-08-05",
  month: "2024-08",
  year: "2024",
  lon: 124.5,
  lat: 30.2,
  zoom: 1,
  layers: { sst: true, front: true, cold: true, warm: true, fishing: true },
  range: 20,            // 活动半径 km（“范围内”判定阈值）
  hl: null,             // 地图高亮：front | coldwarm | sst | fishing | null
  histPeriod: "month",  // 历史统计周期：day | month | year
  histDate: "2024-08-05", // 历史锚点：按日时选择的日期
  histMonth: "2024-08",   // 历史锚点：按月时选择的月份
  histYear: "2024",       // 历史锚点：按年时选择的年份
};

const $ = (id) => document.getElementById(id);

const legendMeta = [
  ["sst", "海表温度"],
  ["front", "锋面线"],
  ["cold", "冷侧"],
  ["warm", "暖侧"],
  ["fishing", "渔场高概率区"],
];

// ---------- SVG 地图 ----------
const NS = "http://www.w3.org/2000/svg";
function el(name, attrs, parent) {
  const node = document.createElementNS(NS, name);
  for (const k in attrs) node.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(node);
  return node;
}

function xy(lon, lat) {
  return [500 + (lon - 124.5) * 180, 320 - (lat - 30.2) * 220];
}

function drawMap() {
  const svg = $("mapSvg");
  svg.innerHTML = "";
  const defs = el("defs", {}, svg);

  // 经纬网格
  for (let i = 0; i <= 20; i++) {
    el("line", { x1: (i / 20) * 1000, y1: 0, x2: (i / 20) * 1000, y2: 640, stroke: "rgba(150,200,230,0.07)" }, svg);
  }
  for (let i = 0; i <= 12; i++) {
    el("line", { x1: 0, y1: (i / 12) * 640, x2: 1000, y2: (i / 12) * 640, stroke: "rgba(150,200,230,0.07)" }, svg);
  }

  const hl = state.hl;
  const vis = (k) => (hl && hl !== k) ? 0.16 : 1;

  // 海表温度场（图层：sst，覆盖整个海区）
  if (state.layers.sst) {
    const g = el("linearGradient", { id: "sstGrad", x1: 0, y1: 0, x2: 0, y2: 640, gradientUnits: "userSpaceOnUse" }, defs);
    el("stop", { offset: "0%", "stop-color": "#123560" }, g);
    el("stop", { offset: "20%", "stop-color": "#1d5c94" }, g);
    el("stop", { offset: "40%", "stop-color": "#2a86ae" }, g);
    el("stop", { offset: "58%", "stop-color": "#55a284" }, g);
    el("stop", { offset: "75%", "stop-color": "#bd9450" }, g);
    el("stop", { offset: "100%", "stop-color": "#e26241" }, g);
    el("rect", { x: 0, y: 0, width: 1000, height: 640, fill: "url(#sstGrad)", opacity: 0.5 * vis("sst") }, svg);
    // 等温线示意（横向：与南北冷暖梯度垂直）
    const iso = [
      "M -20,150 C 260,132 620,166 1020,142",
      "M -20,225 C 280,206 640,240 1020,216",
      "M -20,300 C 300,282 660,316 1020,290",
      "M -20,375 C 320,356 680,392 1020,366",
      "M -20,455 C 340,436 700,472 1020,444",
    ];
    iso.forEach((d, i) => {
      el("path", {
        d,
        fill: "none",
        stroke: hl === "sst" ? "rgba(255,190,90,0.55)" : "rgba(255,240,210,0.15)",
        "stroke-width": hl === "sst" ? 1.6 : 1,
      }, svg);
      if (hl === "sst" && i === 2) {
        el("path", { d, fill: "none", stroke: "#ffb454", "stroke-width": 2.5, opacity: 0.95, "stroke-dasharray": "7 5" }, svg);
      }
    });
  }

  // 大陆示意（压在温度场之上）
  el("path", {
    d: "M -20,-20 L 330,-20 C 300,80 240,120 210,190 C 180,260 120,300 60,420 L -20,420 Z",
    fill: "#17293a", stroke: "rgba(120,170,210,0.35)",
  }, svg);
  el("path", { d: "M 900,-20 L 960,-20 L 1000,40 L 1000,-20 Z", fill: "#17293a", stroke: "rgba(120,170,210,0.3)" }, svg);
  el("text", { x: 90, y: 90, fill: "rgba(200,225,240,0.5)", "font-size": 15 }, svg).textContent = "陆地";
  el("text", { x: 925, y: 64, fill: "rgba(200,225,240,0.45)", "font-size": 11 }, svg).textContent = "陆地";

  // 锋面结构（自洽的“上冷下暖”：北侧冷带 → 锋面线 → 南侧暖带）
  const COLD_D = "M 330,238 C 440,230 540,224 650,216 C 780,206 910,196 1010,192";
  const FRONT_D = "M 330,300 C 440,292 540,286 650,278 C 780,268 910,258 1010,254";
  const WARM_D = "M 330,328 C 440,320 540,316 650,308 C 780,300 910,294 1010,291";
  if (state.layers.cold) {
    el("path", { d: COLD_D, fill: "none", stroke: "rgba(40,90,150,0.5)", "stroke-width": 46, "stroke-linecap": "round", opacity: 0.5 * vis("coldwarm") }, svg);
    if (hl === "coldwarm") {
      el("path", { d: COLD_D, fill: "none", stroke: "#5cb4ff", "stroke-width": 3.5, opacity: 0.85 }, svg);
    }
  }
  if (state.layers.warm) {
    el("path", { d: WARM_D, fill: "none", stroke: "rgba(190,90,45,0.45)", "stroke-width": 36, "stroke-linecap": "round", opacity: 0.45 * vis("coldwarm") }, svg);
    if (hl === "coldwarm") {
      el("path", { d: WARM_D, fill: "none", stroke: "#ffab5c", "stroke-width": 3, opacity: 0.9 }, svg);
    }
  }
  if (state.layers.front) {
    el("path", { d: FRONT_D, fill: "none", stroke: "#fff", "stroke-width": 2.5, opacity: 0.9 * vis("front") }, svg);
    if (hl === "front") {
      el("path", { d: FRONT_D, fill: "none", stroke: "#4dd4c6", "stroke-width": 8, opacity: 0.35, "stroke-linecap": "round" }, svg);
    }
  }

  // 渔场高概率区（图层：fishing）
  if (state.layers.fishing) {
    const [f1x, f1y] = xy(124.72, 30.32);
    el("ellipse", { cx: f1x, cy: f1y, rx: 42, ry: 30, fill: "rgba(255,180,84,0.28)", stroke: "rgba(255,200,120,0.5)", "stroke-dasharray": "4 3", opacity: vis("fishing") }, svg);
    el("text", { x: f1x - 55, y: f1y - 26, fill: "#ffc46b", "font-size": 12, opacity: 0.35 + 0.65 * vis("fishing") }, svg).textContent = "渔场高概率";
    const [f2x, f2y] = xy(123.9, 29.75);
    el("ellipse", { cx: f2x, cy: f2y, rx: 30, ry: 22, fill: "rgba(255,180,84,0.18)", stroke: "rgba(255,200,120,0.35)", "stroke-dasharray": "4 3", opacity: vis("fishing") }, svg);
    if (hl === "fishing") {
      el("ellipse", { cx: f1x, cy: f1y, rx: 46, ry: 34, fill: "none", stroke: "#ffb454", "stroke-width": 2, opacity: 0.95 }, svg);
    }
  }

  // 定位点 + 距离环（10 / 20 / 30 km）
  const [px, py] = xy(state.lon, state.lat);
  const KM2PX = 1.87;
  [10, 20, 30].forEach((km) => {
    const r = km * KM2PX;
    const isRange = km === state.range;
    el("circle", {
      cx: px, cy: py, r,
      fill: isRange ? "rgba(77,212,198,0.05)" : "none",
      stroke: isRange ? "rgba(77,212,198,0.55)" : "rgba(140,225,212,0.28)",
      "stroke-width": isRange ? 1.2 : 1,
      "stroke-dasharray": isRange ? "5 4" : "3 5",
    }, svg);
    el("text", {
      x: px, y: py - r - 4, "text-anchor": "middle",
      fill: isRange ? "rgba(165,242,230,0.9)" : "rgba(140,225,212,0.45)",
      "font-size": isRange ? 10 : 8.5,
    }, svg).textContent = km + " km";
  });
  el("circle", { cx: px, cy: py, r: 8, fill: "none", stroke: "#4dd4c6", "stroke-width": 2, "class": "pulse" }, svg);
  el("circle", { cx: px, cy: py, r: 5, fill: "#fff" }, svg);
  el("text", {
    x: px + 14, y: py - 12, fill: "#fff", "font-size": 13, "font-weight": "bold",
    "paint-order": "stroke", stroke: "rgba(11,20,32,0.85)", "stroke-width": 3,
  }, svg).textContent = `${state.lon.toFixed(2)}°E, ${state.lat.toFixed(2)}°N`;

  el("text", { x: 966, y: 40, fill: "rgba(200,225,240,0.6)", "font-size": 13 }, svg).textContent = "N ↑";
  const st = el("style", {}, defs);
  st.textContent = "@keyframes pulseAnim{0%{r:8;opacity:.9}100%{r:32;opacity:0}}.pulse{animation:pulseAnim 1.6s ease-out infinite}";
}

// ---------- Mock 数据 ----------
const dayData = [
  { k: "锋面线", v: "58 像元 · 对象 F002", d: "范围内共 3 个锋面对象", hl: "front" },
  { k: "冷侧 / 暖侧", v: "314 / 281 像元", d: "暖侧占优，持续偏暖", hl: "coldwarm" },
  { k: "温度梯度", v: "0.15 °C/km", d: "高于近 30 日均值", hl: "sst" },
  { k: "历史参考", v: "8 月上旬出现率 63%", d: "统计口径见需求文档 §5.2", hl: "" },
];
const monthData = [
  { k: "当月出现天数", v: "19 / 31 天", d: "多数集中在 1-12 日", hl: "" },
  { k: "高频时段", v: "上旬", d: "1-12 日出现率约 83%", hl: "" },
  { k: "平均位置", v: "124.6°E / 30.4°N", d: "较 7 月整体东移约 15 km", hl: "" },
  { k: "强度趋势", v: "逐步增强", d: "下旬锋面强度高于上旬", hl: "" },
];
const yearData = [
  { k: "全年出现频率", v: "212 / 366 天", d: "占比约 58%，冬春偏高", hl: "" },
  { k: "季节差异", v: "冬强夏弱", d: "2 月最强，8 月最弱", hl: "" },
  { k: "异常月份", v: "2024-05", d: "出现率显著低于往年", hl: "" },
];

const scaleHints = { day: "8 月 5 日", days: "8/3 - 8/9", month: "2024 年 8 月", year: "2024 年度" };

function fillNowList() {
  const data = state.scale === "month" ? monthData : state.scale === "year" ? yearData : dayData;
  $("nowList").innerHTML = data
    .map(
      (d) =>
        `<div class="row clickable" data-hl="${d.hl || ""}"><span class="i">▪</span>` +
        `<span class="grow"><b>${d.k}</b> ${d.v}<small>${d.d}</small></span></div>`
    )
    .join("");
  $("nowList").querySelectorAll(".row").forEach((row) => {
    row.addEventListener("click", () => highlightKey(row.dataset.hl, row));
  });
  syncActiveRows();
}

// 信息条目 → 地图要素高亮
function highlightKey(key, el) {
  if (!key) { showToast("该条目暂无地图高亮"); return; }
  const label = { front: "锋面线", coldwarm: "冷侧 / 暖侧", sst: "温度场", fishing: "渔场高概率区" }[key] || key;
  if (state.hl === key) {
    state.hl = null;
    showToast("已取消高亮");
  } else {
    state.hl = key;
    ({ front: ["front"], coldwarm: ["cold", "warm"], sst: ["sst"], fishing: ["fishing"] }[key] || []).forEach((k) => {
      state.layers[k] = true;
    });
    showToast("已高亮「" + label + "」");
  }
  syncLegend();
  drawMap();
  syncActiveRows();
}

function syncLegend() {
  document.querySelectorAll(".legend-row").forEach((row, i) => {
    const meta = legendMeta[i];
    if (!meta) return;
    const on = state.layers[meta[0]];
    row.style.opacity = on ? "1" : "0.5";
    row.style.filter = on ? "none" : "grayscale(1)";
    row.style.textDecoration = on ? "none" : "line-through";
  });
}

function syncActiveRows() {
  document.querySelectorAll("#nowList .row, #predFront .row").forEach((r) => {
    r.classList.toggle("active", !!(state.hl && r.dataset.hl === state.hl));
  });
}

function barsHTML(values, activeIdx, futureN = 0) {
  return values
    .map((v, i) => {
      const cls = i >= values.length - futureN ? "future" : "";
      const act = i === activeIdx ? "active" : "";
      return `<i class="${cls} ${act}" style="height:${Math.max(4, v * 100)}%"></i>`;
    })
    .join("");
}

function fillHistory() {
  const p = state.histPeriod;
  // 按周期显示对应的时间锚点选择器
  $("histDate").style.display = p === "day" ? "" : "none";
  $("histMonth").style.display = p === "month" ? "" : "none";
  $("histYear").style.display = p === "year" ? "" : "none";
  let vals = [], active = -1, stat = "", years = "", hint = "";
  if (p === "month") {
    const m = Math.min(11, Math.max(0, (parseInt(state.histMonth.slice(-2), 10) || 8) - 1));
    const base = [62, 71, 78, 66, 41, 34, 29, 38, 47, 55, 63, 70];
    vals = base.map((v) => v / 100);
    active = m;
    hint = "按月 · " + state.histMonth;
    stat = `${state.histMonth} 出现率 ${base[m]}%（高亮柱）；全年峰值 3 月 78%。`;
    years = `<div class="row"><span class="grow"><b>多年同期</b> 近 5 年 ${state.histMonth.slice(5, 7)} 月均值 ${base[m] - 5}%</span><span class="tag ok">正常</span></div>` +
      `<div class="row"><span class="grow"><b>年份样本</b> 2022–2024 同期波动区间 ${base[m] - 12}%~${base[m] + 3}%</span><span class="tag warm">参考</span></div>`;
  } else if (p === "year") {
    const y = Math.min(2025, Math.max(2019, Number(state.histYear) || 2024));
    const yMap = { 2020: 44, 2021: 50, 2022: 46, 2023: 52, 2024: 58, 2025: 56 };
    const keys = Object.keys(yMap).map(Number).sort();
    vals = keys.map((k) => yMap[k] / 100);
    active = Math.max(0, Math.min(keys.length - 1, keys.indexOf(y)));
    hint = "按年 · " + y;
    stat = `${y} 年出现率 ${yMap[y] || yMap[keys[active]]}%（高亮柱）；近 6 年区间 44%~58%。`;
    years = keys.slice(-3).reverse().map((k) => {
      const tag = yMap[k] >= 56 ? "warm" : yMap[k] <= 47 ? "cold" : "ok";
      const lab = yMap[k] >= 56 ? "偏高" : yMap[k] <= 47 ? "偏低" : "正常";
      return `<div class="row"><span class="grow"><b>${k}</b> 出现率 ${yMap[k]}%${k === y ? " · 当前所选" : ""}</span><span class="tag ${tag}">${lab}</span></div>`;
    }).join("");
  } else {
    // 按日：以所选日期为末端的近 30 日窗口
    vals = Array.from({ length: 30 }, (_, i) => 0.35 + 0.5 * Math.abs(Math.sin((i + 1) / 3.1)));
    active = 29;
    hint = "按日 · " + state.histDate;
    stat = `${state.histDate}（窗口末高亮）：近 30 日出现锋面 22 天，出现率 73%，集中在前 15 日。`;
    years = `<div class="row"><span class="i">i</span><span class="grow">所选日期 ${state.histDate} 已纳入近 30 日统计窗口。</span></div>`;
  }
  $("histScaleHint").textContent = hint;
  $("histBars").innerHTML = barsHTML(vals, active);
  $("histStat").textContent = stat;
  $("histYears").innerHTML = years;
}

function fillPrediction() {
  $("predBars").innerHTML = barsHTML([0.72, 0.61, 0.48], 0, 3);
  const rng = state.range;
  const rangeTag = $("predRangeTag");
  if (rangeTag) rangeTag.textContent = `≤ ${rng} km`;
  $("predFront").innerHTML =
    `<div class="row clickable" data-hl="front"><span class="i">✓</span>` +
    `<span class="grow"><b>${rng} km 内命中</b> 锋面 F002 · 东北偏东 · 约 17 km<small>点击可在图中高亮该锋面</small></span></div>` +
    `<div class="row"><span class="i">↘</span>` +
    `<span class="grow"><b>若 ${rng} km 内未检出</b> 自动检索最近锋面 → 参考 F001 · 东北 · 约 25 km<small>回退规则示意</small></span></div>`;
  $("predFront").querySelectorAll(".clickable").forEach((row) => {
    row.addEventListener("click", () => highlightKey(row.dataset.hl, row));
  });
  syncActiveRows();
}

function fillAI() {
  $("aiActions").innerHTML =
    `<div class="row"><span class="i">→</span><span class="grow"><b>今明两日</b> 优先考虑东北约 25 km 高概率区</span></div>` +
    `<div class="row"><span class="i">→</span><span class="grow"><b>3 日后</b> 锋面可能减弱，建议收缩作业范围</span></div>` +
    `<div class="row"><span class="i">→</span><span class="grow"><b>若需扩大范围</b> 请拉远地图以加载更大区域</span></div>`;
}

function refreshAll() {
  const hint = scaleHints[state.scale] || "";
  $("nowScaleHint").textContent = hint;
  $("nowRangeTag").textContent = `半径 ${state.range} km`;
  fillNowList(); fillHistory(); fillPrediction(); fillAI();
  const isDay = state.scale === "day" || state.scale === "days";
  $("dateInput").style.display = isDay ? "" : "none";
  $("monthInput").style.display = state.scale === "month" ? "" : "none";
  $("yearInput").style.display = state.scale === "year" ? "" : "none";
  $("todayText").textContent = new Date().toISOString().slice(0, 10);
}

// ---------- Toast ----------
let toastTimer;
function showToast(text) {
  $("toastLoc").textContent = text;
  const t = $("toast");
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 1700);
}

function bind() {
  document.querySelectorAll("#timeScale button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#timeScale button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.scale = btn.dataset.scale;
      refreshAll();
      showToast("时间尺度：" + (btn.textContent || "").trim());
    });
  });
  $("histDate").addEventListener("change", (e) => { state.histDate = e.target.value; fillHistory(); showToast("历史日期：" + state.histDate); });
  $("histMonth").addEventListener("change", (e) => { state.histMonth = e.target.value; fillHistory(); showToast("历史月份：" + state.histMonth); });
  $("histYear").addEventListener("change", (e) => { state.histYear = e.target.value; fillHistory(); showToast("历史年份：" + state.histYear); });
  document.querySelectorAll("#histPeriod button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#histPeriod button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.histPeriod = btn.dataset.period;
      fillHistory();
      showToast("历史周期：" + (btn.textContent || "").trim());
    });
  });
  document.querySelectorAll("#tabs button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#tabs button").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".pane").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      $("pane-" + btn.dataset.pane).classList.add("active");
    });
  });
  $("dateInput").addEventListener("change", (e) => { state.date = e.target.value; showToast("日期：" + state.date); });
  $("monthInput").addEventListener("change", (e) => { state.month = e.target.value; showToast("月份：" + state.month); });
  $("yearInput").addEventListener("change", (e) => { state.year = e.target.value; showToast("年份：" + state.year); });
  const doLocate = () => {
    const raw = $("locInput").value.trim();
    const m = raw.match(/(\d+(?:\.\d+)?)\s*°?\s*[eE]?\s*,\s*(\d+(?:\.\d+)?)/);
    if (!m) { showToast("无法解析坐标"); return; }
    state.lon = parseFloat(m[1]);
    state.lat = parseFloat(m[2]);
    drawMap();
    showToast("已定位 " + state.lon.toFixed(2) + "°E, " + state.lat.toFixed(2) + "°N");
  };
  $("locateBtn").addEventListener("click", doLocate);
  $("locInput").addEventListener("keydown", (e) => { if (e.key === "Enter") doLocate(); });

  $("zoomIn").addEventListener("click", () => { state.zoom = Math.min(state.zoom * 1.25, 4); applyZoom(); });
  $("zoomOut").addEventListener("click", () => { state.zoom = Math.max(state.zoom / 1.25, 0.4); applyZoom(); });
  $("recenter").addEventListener("click", () => { state.zoom = 1; applyZoom(); });
  document.querySelectorAll(".legend-row").forEach((row, i) => {
    row.style.cursor = "pointer";
    row.addEventListener("click", () => {
      const meta = legendMeta[i];
      if (!meta) return;
      const key = meta[0];
      state.layers[key] = !state.layers[key];
      const on = state.layers[key];
      if (!on) {
        const hlKey = key === "cold" || key === "warm" ? "coldwarm" : key;
        if (state.hl === hlKey) state.hl = null;
      }
      syncLegend();
      drawMap();
      syncActiveRows();
      showToast(`图层「${meta[1]}」已${on ? "开启" : "关闭"}`);
    });
  });
}

function applyZoom() {
  const w = 1000 / state.zoom, h = 640 / state.zoom;
  const svg = $("mapSvg");
  svg.style.transition = "all .25s ease";
  svg.setAttribute("viewBox", `${(1000 - w) / 2} ${(640 - h) / 2} ${w} ${h}`);
}

// ---------- 启动 ----------
bind();
drawMap();
refreshAll();

