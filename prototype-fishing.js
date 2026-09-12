/* 渔场向导 · 交互原型（纯前端演示，无真实数据）
 *
 * 信息架构（三层）：
 *   L0 全局上下文（顶栏）  定位 / 作业半径 / 目标鱼种 / 时间条 —— 全局唯一真源
 *   L1 结论层（hero 常驻） 一句话建议 + 首选点位 + 依据入口 —— 不随页签消失
 *   L2 分层细节（页签）    现在(主) 未来(主) | 规律(支撑) 依据(支撑)
 *
 * 数据流：state（唯一真源） --render()--> DOM。所有 render* 只读 state，不写 state。
 */
"use strict";

// ==================== 常量与口径（依据页展示同一口径） ====================
const KM_PER_DEG = 111;
const KM2PX = 1.87;              // 演示投影：地图像素 / 公里
const CRUISE_KMH = 14.8;         // 8 kn 巡航估算
const FUEL_L_PER_KM = 1.6;       // 油耗估算口径（小型渔船量级，仅演示）
const TODAY = "2024-08-05";      // 演示基准日（"今天"）
const OBS_WINDOW = { from: "2024-06-01", to: "2024-09-30" };   // 观测数据覆盖期
const FCST_SPAN = 7;             // 预报覆盖未来 7 天
const SST_RANGE = { north: 31.65, south: 28.75, min: 22, max: 33 };  // 与地图色带一致
const ANCHOR = { lon: 124.5, lat: 30.2 };   // 地图投影中心
const SUB = { cold: 0.13, warm: 0.08 };     // 冷侧/暖侧带相对锋面的纬度偏移（度）

const SPECIES = {
  hairtail:      { label: "带鱼",       sst: [16, 28], prefer: "any"  },
  yellowcroaker: { label: "小黄鱼",     sst: [14, 22], prefer: "cold" },
  chubmackerel:  { label: "鲐鱼",       sst: [17, 25], prefer: "warm" },
  squid:         { label: "剑尖枪乌贼", sst: [19, 27], prefer: "warm" },
};

// ==================== 状态（唯一真源） ====================
const state = {
  lon: 124.5, lat: 30.2,           // 定位点
  range: 20,                       // 作业半径 km
  species: "hairtail",             // 目标鱼种
  time: { family: "obs", date: TODAY },   // family: obs | fcst | clim
  layers: { sst: true, front: true, coldwarm: true, fishing: true },
  select: null,                    // { type: 'front'|'coldwarm'|'sst'|'fishing', id }
  tab: "now",
  clim: { mode: "month", date: TODAY, month: TODAY.slice(0, 7), year: TODAY.slice(0, 4) },
  zoom: 1,
};

const $ = (id) => document.getElementById(id);
const SELECT_LABEL = { front: "锋面线", coldwarm: "冷侧 / 暖侧", sst: "海表温度", fishing: "渔场高概率区" };
const SELECT_LAYERS = { front: ["front"], coldwarm: ["coldwarm"], sst: ["sst"], fishing: ["fishing"] };
const LAYER_META = [["sst", "海表温度"], ["front", "锋面线"], ["coldwarm", "冷侧 / 暖侧"], ["fishing", "渔场高概率区"]];
const DIRS16 = ["正北", "东北偏北", "东北", "东北偏东", "正东", "东南偏东", "东南", "东南偏南",
  "正南", "西南偏南", "西南", "西南偏西", "正西", "西北偏西", "西北", "西北偏北"];

// ==================== 工具 ====================
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
const rnd = (seed) => hash(String(seed)) / 4294967295;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function addDays(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function mdText(iso) { const p = iso.split("-"); return Number(p[1]) + " 月 " + Number(p[2]) + " 日"; }
function kmPerLon(lat) { return KM_PER_DEG * Math.cos((lat * Math.PI) / 180); }
function xy(lon, lat) { return [500 + (lon - ANCHOR.lon) * 180, 320 - (lat - ANCHOR.lat) * 220]; }

// 点到线段最短距离（km）
function nearestOnSegment(p, a, b) {
  const kx = kmPerLon(p[1]);
  const px = p[0] * kx, py = p[1] * KM_PER_DEG;
  const ax = a[0] * kx, ay = a[1] * KM_PER_DEG;
  const bx = b[0] * kx, by = b[1] * KM_PER_DEG;
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1) : 0;
  const cx = ax + t * dx, cy = ay + t * dy;
  return { km: Math.hypot(px - cx, py - cy), point: [cx / kx, cy / KM_PER_DEG] };
}

function bearing16(from, to) {
  const dx = (to[0] - from[0]) * kmPerLon(from[1]);
  const dy = (to[1] - from[1]) * KM_PER_DEG;
  const deg = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
  return DIRS16[Math.round(deg / 22.5) % 16];
}

function distKm(from, to) { return Math.hypot((to[0] - from[0]) * kmPerLon(from[1]), (to[1] - from[1]) * KM_PER_DEG); }
// 局地海表温度：与地图色带同源（纬度线性）
function sstAt(lat) { return SST_RANGE.min + ((SST_RANGE.north - lat) / (SST_RANGE.north - SST_RANGE.south)) * (SST_RANGE.max - SST_RANGE.min); }

// ==================== Mock 数据（确定性、可复现） ====================
// 锋面用同一形状函数采样：地图几何与卡片距离完全同源
function makeFront(id, name, base, amp, phase) {
  const pts = [];
  for (let i = 0; i <= 12; i++) {
    const lon = 121.8 + (i * (127.2 - 121.8)) / 12;
    pts.push([lon, base + amp * Math.sin((lon - 121.8) * 0.9 + phase)]);
  }
  return { id, name, points: pts };
}
const FRONTS = [
  makeFront("F001", "北部陆架锋", 30.92, 0.06, 0.4),
  makeFront("F002", "中央陆架锋", 30.32, 0.07, 2.1),
  makeFront("F003", "南部陆架锋", 29.72, 0.05, 3.4),
];
const FISHING_SPOTS = [
  { id: "S1", lon: 124.62, lat: 30.31, rx: 42, ry: 30, grade: "高" },
  { id: "S2", lon: 123.90, lat: 29.90, rx: 30, ry: 22, grade: "中" },
];

// 覆盖判定（FR-7：无数据必须明确提示，绝不编造数值）
function dataStatus() {
  const f = state.time.family, d = state.time.date;
  if (f === "obs" && (d < OBS_WINDOW.from || d > OBS_WINDOW.to))
    return { ok: false, title: "该时次无观测数据", desc: "观测产品覆盖 " + OBS_WINDOW.from + " ~ " + OBS_WINDOW.to + "；可切换「预报」或「气候」" };
  if (f === "fcst" && (d < TODAY || d > addDays(TODAY, FCST_SPAN - 1)))
    return { ok: false, title: "该时次无预报数据", desc: "预报产品覆盖未来 " + FCST_SPAN + " 天（" + TODAY + " ~ " + addDays(TODAY, FCST_SPAN - 1) + "）" };
  return { ok: true, title: "", desc: "" };
}

function timeLabel() {
  const f = state.time.family, d = state.time.date;
  const fam = { obs: "观测", fcst: "预报", clim: "气候态" }[f];
  if (f === "clim") return fam + " · " + mdText(d) + "同期";
  if (f === "fcst") {
    const n = Math.round((Date.parse(d) - Date.parse(TODAY)) / 86400000);
    if (n === 0) return fam + " · " + mdText(d) + "（今天）";
    if (n > 0) return fam + " · " + mdText(d) + "（+" + n + " 天）";
    return fam + " · " + mdText(d) + "（已过去 " + Math.abs(n) + " 天，超出预报窗口）";
  }
  return fam + " · " + mdText(d);
}

// 锋面：距离 / 方位 / 侧别（几何计算，与地图同源）
function frontInfo() {
  return FRONTS.map((f) => {
    let best = null;
    for (let i = 0; i < f.points.length - 1; i++) {
      const r = nearestOnSegment([state.lon, state.lat], f.points[i], f.points[i + 1]);
      if (!best || r.km < best.km) best = r;
    }
    return {
      id: f.id, name: f.name, km: best.km, point: best.point,
      bearing: bearing16([state.lon, state.lat], best.point),
      side: state.lat > best.point[1] ? "冷侧" : "暖侧",
      inRange: best.km <= state.range,
    };
  }).sort((a, b) => a.km - b.km);
}

function spotInfo() {
  return FISHING_SPOTS.map((s) => {
    const km = distKm([state.lon, state.lat], [s.lon, s.lat]);
    return { id: s.id, lon: s.lon, lat: s.lat, rx: s.rx, ry: s.ry, grade: s.grade, km, bearing: bearing16([state.lon, state.lat], [s.lon, s.lat]), inRange: km <= state.range };
  }).sort((a, b) => a.km - b.km);
}

// 海况（确定性 mock）
function seaState(date) {
  const wind = 3 + (hash("wind" + date) % 4);                        // 3~6 级
  const wave = +(0.6 + (hash("wave" + date) % 10) / 10).toFixed(1);  // 0.6~1.5 m
  const swell = +(0.5 + (hash("swell" + date) % 9) / 10).toFixed(1); // 0.5~1.3 m
  const seaworthy = wind <= 5 && wave <= 1.5;
  const marginal = !seaworthy && wind <= 6 && wave <= 1.8;
  return { wind, wave, swell, level: seaworthy ? "seaworthy" : marginal ? "marginal" : "unsafe" };
}

// 可能度（可解释加权；各分项进入 hero「依据」）
function scoreBreakdown(sea) {
  const fronts = frontInfo();
  const inRange = fronts.filter((f) => f.inRange);
  const nearest = fronts[0] || null;
  const spots = spotInfo();
  const spotIn = spots.filter((s) => s.inRange);
  const sst = sstAt(state.lat);
  const sp = SPECIES[state.species];
  const gradHigh = rnd("grad" + state.time.date) > 0.42;
  const items = [];
  let s = 30;
  items.push(["锋面基础分", 30]);
  const addF = Math.min(inRange.length, 3) * 12;
  s += addF;
  items.push(["范围内锋面 " + inRange.length + " 条", addF]);
  const preferText = sp.prefer === "cold" ? "冷侧" : sp.prefer === "warm" ? "暖侧" : "冷暖交汇区";
  const sideOk = sp.prefer === "any" ? 0 : (nearest && nearest.side === (sp.prefer === "cold" ? "冷侧" : "暖侧") ? 15 : -5);
  s += sideOk;
  items.push(["定位点位于" + (nearest ? nearest.side : "—") + "（" + sp.label + "偏好" + preferText + "）", sideOk]);
  const gradScore = gradHigh ? 8 : -8;
  s += gradScore;
  items.push(["温度梯度" + (gradHigh ? "高于" : "低于") + "多年同期", gradScore]);
  const spotScore = spotIn.length ? 15 : 0;
  s += spotScore;
  items.push(["范围内渔场高概率区 " + spotIn.length + " 个", spotScore]);
  const fit = sst >= sp.sst[0] && sst <= sp.sst[1];
  const fitScore = fit ? 12 : -6;
  s += fitScore;
  items.push(["中心海温 " + sst.toFixed(1) + "°C / " + sp.label + "适温 " + sp.sst[0] + "~" + sp.sst[1] + "°C", fitScore]);
  return { score: clamp(Math.round(s), 5, 95), items, fronts, inRange, nearest, spots, spotIn, sst, gradHigh, sea };
}

// 结论三档（安全优先：不适航一律"暂缓"）
function verdictOf(score, sea) {
  if (sea.level === "unsafe") return { key: "stop", text: "暂缓出海", cls: "stop" };
  if (sea.level === "marginal" || score < 60) return { key: "caution", text: "谨慎出海", cls: "caution" };
  return { key: "go", text: "可出海", cls: "ok" };
}

// 单次快照（各 render 复用；state 改变后由 invalidate() 失效）
let _snap = null;
function snapshot() {
  if (_snap) return _snap;
  const status = dataStatus();
  const sea = seaState(state.time.date);
  const core = status.ok ? scoreBreakdown(sea) : { score: 0, items: [], fronts: [], inRange: [], nearest: null, spots: [], spotIn: [], sst: null, gradHigh: false, sea };
  _snap = Object.assign({ status }, core);
  return _snap;
}
function invalidate() { _snap = null; }

// 未来逐日可能度（原型口径：当日可能度 × 持续性衰减 × 确定性扰动）
function futureSeries(n) {
  const base = snapshot().score || 45;
  const start = state.time.family === "fcst" ? TODAY : state.time.date;
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = addDays(start, i);
    const score = clamp(Math.round(base * (1 - i * 0.06) * (1 + (rnd("fcst" + d) - 0.5) * 0.18)), 5, 95);
    out.push({ date: d, score, sea: seaState(d) });
  }
  return out;
}

// ==================== 地图渲染（SVG） ====================
const NS = "http://www.w3.org/2000/svg";
function el(name, attrs, parent) {
  const node = document.createElementNS(NS, name);
  for (const k in attrs) node.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(node);
  return node;
}
function pathOf(pts) { return pts.map((p, i) => (i ? "L " : "M ") + xy(p[0], p[1]).join(",")).join(" "); }
function offsetPts(pts, dLat) { return pts.map((p) => [p[0], p[1] + dLat]); }
function yOfLat(lat) { return xy(ANCHOR.lon, lat)[1]; }

function drawMap() {
  const svg = $("mapSvg");
  svg.innerHTML = "";
  const defs = el("defs", {}, svg);
  const snap = snapshot();
  const ok = snap.status.ok;
  const sel = state.select;
  const dim = (k) => (sel && sel.type !== k ? 0.14 : 1);

  // 空态覆盖层（FR-7）
  $("mapEmpty").hidden = ok;
  if (!ok) {
    $("mapEmptyTitle").textContent = snap.status.title;
    $("mapEmptyDesc").textContent = snap.status.desc + "（当前 " + timeLabel() + "）";
  }

  // 经纬网格
  for (let i = 0; i <= 20; i++) el("line", { x1: (i / 20) * 1000, y1: 0, x2: (i / 20) * 1000, y2: 640, stroke: "rgba(150,200,230,0.07)" }, svg);
  for (let i = 0; i <= 12; i++) el("line", { x1: 0, y1: (i / 12) * 640, x2: 1000, y2: (i / 12) * 640, stroke: "rgba(150,200,230,0.07)" }, svg);

  // 海表温度场：与 sstAt() 同源（北冷南暖的纬向梯度）
  if (state.layers.sst) {
    const g = el("linearGradient", { id: "sstGrad", x1: 0, y1: 0, x2: 0, y2: 640, gradientUnits: "userSpaceOnUse" }, defs);
    [["0%", "#123560"], ["20%", "#1d5c94"], ["40%", "#2a86ae"], ["58%", "#55a284"], ["75%", "#bd9450"], ["100%", "#e26241"]]
      .forEach((s) => el("stop", { offset: s[0], "stop-color": s[1] }, g));
    el("rect", { x: 0, y: 0, width: 1000, height: 640, fill: "url(#sstGrad)", opacity: 0.5 * dim("sst") }, svg);
    for (let t = 24; t <= 32; t += 2) {
      const lat = SST_RANGE.north - ((t - SST_RANGE.min) / (SST_RANGE.max - SST_RANGE.min)) * (SST_RANGE.north - SST_RANGE.south);
      const y = yOfLat(lat);
      const on = !!sel && sel.type === "sst";
      el("path", { d: "M -20," + (y + 6) + " C 260," + (y - 8) + " 620," + (y + 14) + " 1020," + (y - 4), fill: "none",
        stroke: on ? "rgba(255,190,90,0.6)" : "rgba(255,240,210,0.16)", "stroke-width": on ? 1.6 : 1 }, svg);
      el("text", { x: 8, y: y - 5, fill: "rgba(255,240,210,0.42)", "font-size": 10 }, svg).textContent = t + "°C";
    }
  }

  // 陆地示意（压在海温之上）
  el("path", { d: "M -20,-20 L 330,-20 C 300,80 240,120 210,190 C 180,260 120,300 60,420 L -20,420 Z", fill: "#17293a", stroke: "rgba(120,170,210,0.35)" }, svg);
  el("path", { d: "M 900,-20 L 960,-20 L 1000,40 L 1000,-20 Z", fill: "#17293a", stroke: "rgba(120,170,210,0.3)" }, svg);
  el("text", { x: 90, y: 90, fill: "rgba(200,225,240,0.5)", "font-size": 15 }, svg).textContent = "陆地";
  el("text", { x: 925, y: 64, fill: "rgba(200,225,240,0.45)", "font-size": 11 }, svg).textContent = "陆地";

  if (ok) {
    // 冷侧 / 暖侧带（沿锋面法向平移）
    if (state.layers.coldwarm) {
      const on = !!sel && sel.type === "coldwarm";
      FRONTS.forEach((f) => {
        el("path", { d: pathOf(offsetPts(f.points, SUB.cold)), fill: "none", stroke: "rgba(40,90,150,0.5)", "stroke-width": 46, "stroke-linecap": "round", opacity: 0.5 * dim("coldwarm") }, svg);
        el("path", { d: pathOf(offsetPts(f.points, -SUB.warm)), fill: "none", stroke: "rgba(190,90,45,0.45)", "stroke-width": 36, "stroke-linecap": "round", opacity: 0.45 * dim("coldwarm") }, svg);
        if (on) {
          el("path", { d: pathOf(offsetPts(f.points, SUB.cold)), fill: "none", stroke: "#5cb4ff", "stroke-width": 3.5, opacity: 0.85 }, svg);
          el("path", { d: pathOf(offsetPts(f.points, -SUB.warm)), fill: "none", stroke: "#ffab5c", "stroke-width": 3, opacity: 0.9 }, svg);
        }
      });
    }

    // 锋面线
    if (state.layers.front) {
      FRONTS.forEach((f) => {
        const isSel = !!sel && sel.type === "front" && (!sel.id || sel.id === f.id);
        el("path", { d: pathOf(f.points), fill: "none", stroke: "#fff", "stroke-width": isSel ? 3.6 : 2.5, opacity: (isSel ? 1 : 0.9) * dim("front") }, svg);
        if (isSel) el("path", { d: pathOf(f.points), fill: "none", stroke: "#4dd4c6", "stroke-width": 9, opacity: 0.3, "stroke-linecap": "round" }, svg);
        const mid = xy(f.points[6][0], f.points[6][1]);
        el("text", { x: mid[0] + 6, y: mid[1] - 9, fill: isSel ? "#8ff2e4" : "rgba(255,255,255,0.66)", "font-size": 11,
          "paint-order": "stroke", stroke: "rgba(11,20,32,0.9)", "stroke-width": 3, opacity: isSel ? 1 : dim("front") }, svg)
          .textContent = f.id + " " + f.name;
      });
    }

    // 渔场高概率区
    if (state.layers.fishing) {
      (snap.spots || []).forEach((s) => {
        const p = xy(s.lon, s.lat);
        const isSel = !!sel && sel.type === "fishing";
        el("ellipse", { cx: p[0], cy: p[1], rx: s.rx, ry: s.ry, fill: "rgba(255,180,84,0.26)", stroke: "rgba(255,200,120,0.5)", "stroke-dasharray": "4 3", opacity: dim("fishing") }, svg);
        el("text", { x: p[0] - 34, y: p[1] - s.ry - 5, fill: "#ffc46b", "font-size": 11.5, "paint-order": "stroke", stroke: "rgba(11,20,32,0.9)", "stroke-width": 3, opacity: 0.45 + 0.55 * dim("fishing") }, svg)
          .textContent = "渔场" + s.grade + "概率 " + s.id;
        if (isSel) {
          const q = xy(state.lon, state.lat);
          el("line", { x1: q[0], y1: q[1], x2: p[0], y2: p[1], stroke: "#ffb454", "stroke-width": 1.2, "stroke-dasharray": "5 4", opacity: 0.8 }, svg);
          el("ellipse", { cx: p[0], cy: p[1], rx: s.rx + 5, ry: s.ry + 5, fill: "none", stroke: "#ffb454", "stroke-width": 2, opacity: 0.95 }, svg);
        }
      });
    }

  }

  // 定位点 + 作业半径环（无数据时也保留定位参照）
  const q = xy(state.lon, state.lat);
  [10, 20, 30].forEach((km) => {
    const r = km * KM2PX;
    const isRange = km === state.range;
    el("circle", { cx: q[0], cy: q[1], r, fill: isRange ? "rgba(77,212,198,0.05)" : "none",
      stroke: isRange ? "rgba(77,212,198,0.55)" : "rgba(140,225,212,0.26)", "stroke-width": isRange ? 1.2 : 1,
      "stroke-dasharray": isRange ? "5 4" : "3 5" }, svg);
    el("text", { x: q[0], y: q[1] - r - 4, "text-anchor": "middle",
      fill: isRange ? "rgba(165,242,230,0.9)" : "rgba(140,225,212,0.4)", "font-size": isRange ? 10 : 8.5 }, svg).textContent = km + " km";
  });
  el("circle", { cx: q[0], cy: q[1], r: 8, fill: "none", stroke: "#4dd4c6", "stroke-width": 2, class: "pulse" }, svg);
  el("circle", { cx: q[0], cy: q[1], r: 5, fill: "#fff" }, svg);
  el("text", { x: q[0] + 14, y: q[1] - 12, fill: "#fff", "font-size": 13, "font-weight": "bold",
    "paint-order": "stroke", stroke: "rgba(11,20,32,0.85)", "stroke-width": 3 }, svg)
    .textContent = state.lon.toFixed(2) + "°E, " + state.lat.toFixed(2) + "°N";
  el("text", { x: 966, y: 40, fill: "rgba(200,225,240,0.6)", "font-size": 13 }, svg).textContent = "N ↑";
  el("style", {}, defs).textContent = "@keyframes pulseAnim{0%{r:8;opacity:.9}100%{r:32;opacity:0}}.pulse{animation:pulseAnim 1.6s ease-out infinite}";
}

// ==================== 选择态（单一交互语义） ====================
function toggleSelect(type, id) {
  const same = !!(state.select && state.select.type === type && (!id || !state.select.id || state.select.id === id));
  state.select = same ? null : { type: type, id: id || null };
  if (!same) SELECT_LAYERS[type].forEach((k) => { state.layers[k] = true; });
  renderLegend(); drawMap(); syncSelect();
  showToast(same ? "已取消高亮" : "已高亮「" + SELECT_LABEL[type] + (id ? " " + id : "") + "」");
}
function syncSelect() {
  document.querySelectorAll("[data-type]").forEach((node) => {
    const t = node.dataset.type, i = node.dataset.id || "";
    const on = !!(state.select && state.select.type === t && (!state.select.id || !i || state.select.id === i));
    node.classList.toggle("active", on);
  });
}
function renderLegend() {
  document.querySelectorAll(".legend-row[data-layer]").forEach((row) => {
    const on = !!state.layers[row.dataset.layer];
    row.style.opacity = on ? "1" : "0.45";
    row.style.filter = on ? "none" : "grayscale(1)";
    row.style.textDecoration = on ? "none" : "line-through";
  });
}

// ==================== L1 结论层 ====================
function heroTarget() {
  const snap = snapshot();
  const spot = snap.spotIn[0];
  if (spot) return { type: "fishing", id: spot.id, label: "渔场" + spot.grade + "概率区 " + spot.id, km: spot.km, bearing: spot.bearing, fallback: false };
  const inF = snap.inRange[0];
  if (inF) return { type: "front", id: inF.id, label: "锋面 " + inF.id + " " + inF.name, km: inF.km, bearing: inF.bearing, fallback: false };
  const near = snap.nearest;
  if (near) return { type: "front", id: near.id, label: "锋面 " + near.id + " " + near.name, km: near.km, bearing: near.bearing, fallback: true };
  return null;
}
const fmtHours = (km) => (km / CRUISE_KMH).toFixed(1);
const fmtFuel = (km) => Math.round(km * FUEL_L_PER_KM);

function renderHero() {
  const snap = snapshot();
  const sp = SPECIES[state.species];
  const v = $("heroVerdict"), l = $("heroLine"), pts = $("heroPoints"), body = $("heroWhyBody");
  $("heroWhen").textContent = timeLabel();

  if (!snap.status.ok) {
    v.textContent = "无数据"; v.className = "verdict caution";
    l.innerHTML = "<b>" + snap.status.title + "</b> — " + snap.status.desc;
    pts.innerHTML = "";
    body.innerHTML = '<div class="line"><span class="k">当前时次</span> → ' + timeLabel() + "</div>" +
      '<div class="line"><span class="k">说明</span> → 无数据时不生成任何可能度与建议，避免编造数值</div>';
    return;
  }

  const verdict = verdictOf(snap.score, snap.sea);
  v.textContent = verdict.text;
  v.className = "verdict " + verdict.cls;

  const t = heroTarget();
  let line = "目标鱼种 <b>" + sp.label + "</b> · 作业半径 <b>" + state.range + " km</b> · 可能度 <b>" + snap.score + "%</b>。";
  if (t) line += "优先前往 <b>" + t.bearing + " " + t.km.toFixed(1) + " km</b> 的" + t.label + "（航时 ≈ " + fmtHours(t.km) + " h）。";
  else line += "该范围内未检出可用线索，建议扩大作业半径或切换时次。";
  if (snap.sea.level !== "seaworthy") line += " ⚠ 海况" + (snap.sea.level === "unsafe" ? "不适航" : "接近临界") + "，安全优先。";
  l.innerHTML = line;

  const picks = [];
  if (t) picks.push({ rank: 1, type: t.type, id: t.id, label: t.label, km: t.km, bearing: t.bearing, note: t.fallback ? "范围内无命中，已回退最近对象" : "范围内命中（首选）" });
  snap.inRange.filter((f) => !t || f.id !== t.id).slice(0, 2).forEach((f) => {
    picks.push({ rank: picks.length + 1, type: "front", id: f.id, label: "锋面 " + f.id + " " + f.name, km: f.km, bearing: f.bearing, note: "备选 · 范围内" });
  });
  pts.innerHTML = picks.map((p) =>
    '<div class="pt" data-type="' + p.type + '" data-id="' + p.id + '"><span class="rk">' + p.rank + "</span>" +
    '<span class="grow"><b>' + p.bearing + " " + p.km.toFixed(1) + " km</b> · " + p.label +
    "<small>" + p.note + " · 航时 ≈ " + fmtHours(p.km) + " h · 油耗 ≈ " + fmtFuel(p.km) + " L（口径见「依据」）</small></span></div>"
  ).join("");
  pts.querySelectorAll(".pt").forEach((node) => node.addEventListener("click", () => toggleSelect(node.dataset.type, node.dataset.id)));

  body.innerHTML =
    snap.items.map((it) => '<div class="line"><span class="k">' + it[0] + "</span> → <b>" + (it[1] > 0 ? "+" : "") + it[1] + "</b></div>").join("") +
    '<div class="line"><span class="k">合计可能度</span> → <b>' + snap.score + "%</b></div>" +
    '<div class="line"><span class="k">适航判据</span> → 风力 ≤5 级且浪高 ≤1.5 m；当前 ' + snap.sea.wind + " 级 / " + snap.sea.wave + " m</div>" +
    '<div class="line"><span class="k">结论口径</span> → 不适航一律「暂缓出海」；适航且可能度 ≥60% 为「可出海」，否则「谨慎出海」</div>';
  syncSelect();
}




// ==================== L2-现在 ====================
function metricCell(label, value, unit, type, id) {
  return "<div class=\"m\"" + (type ? ' data-type="' + type + '" data-id="' + (id || "") + '" style="cursor:pointer"' : "") + ">" +
    '<div class="k">' + label + '</div><div class="v">' + value + "<small>" + (unit || "") + "</small></div></div>";
}

function renderNow() {
  const snap = snapshot();
  const sp = SPECIES[state.species];
  $("nowScopeTag").textContent = state.range + " km 内 · " + sp.label;

  if (!snap.status.ok) {
    $("nowMetrics").innerHTML = "";
    $("seaTag").textContent = "无数据"; $("seaTag").className = "tag warn";
    $("seaList").innerHTML = "";
    $("nowFronts").innerHTML = "";
    $("nowFrontTag").textContent = "无数据";
    const e0 = $("nowEmpty"); e0.hidden = false;
    e0.innerHTML = "<b>" + snap.status.title + "</b><br/>" + snap.status.desc;
    return;
  }

  const sst = snap.sst, nf = snap.nearest, sp2 = SPECIES[state.species];
  const upper = sp2.sst[1];
  const fit = sst >= sp2.sst[0] && sst <= sp2.sst[1];
  $("nowMetrics").innerHTML =
    metricCell("中心海温", sst.toFixed(1), "°C", "sst") +
    metricCell("距最近锋面", nf.km.toFixed(1), "km", "front", nf.id) +
    metricCell("位于锋面", nf.side, "", "coldwarm") +
    metricCell("渔场可能度", String(snap.score), "%", "fishing");

  const sea = snap.sea;
  const seaCls = sea.level === "seaworthy" ? "ok" : "warn";
  $("seaTag").textContent = sea.level === "seaworthy" ? "适航" : sea.level === "marginal" ? "接近临界" : "不适航";
  $("seaTag").className = "tag " + seaCls;
  $("seaList").innerHTML =
    '<div class="row"><span class="i">≈</span><span class="grow"><b>风力 ' + sea.wind + " 级</b> · 浪高 " + sea.wave +
    " m · 涌浪 " + sea.swell + ' m<small>适航判据：风力 ≤5 级且浪高 ≤1.5 m</small></span></div>' +
    '<div class="row"><span class="i">' + (sea.level === "seaworthy" ? "✓" : "!") + '</span><span class="grow"><b>' +
    (sea.level === "seaworthy" ? "满足适航条件" : sea.level === "marginal" ? "接近临界，建议缩短航次" : "超出适航条件，建议择日") +
    "</b><small>海况为演示占位；实船作业请以官方海洋预报为准</small></span></div>";

  $("nowFrontTag").textContent = "共 " + snap.fronts.length + " 条 · 范围内 " + snap.inRange.length + " 条";
  $("nowFronts").innerHTML = snap.fronts.map((f) =>
    '<div class="row clickable" data-type="front" data-id="' + f.id + '"><span class="i">' + (f.inRange ? "✓" : "·") + "</span>" +
    '<span class="grow"><b>' + f.id + " " + f.name + "</b> " + f.bearing + " " + f.km.toFixed(1) + " km" +
    "<small>" + (f.inRange ? "在作业半径内" : "超出作业半径（参考）") + " · 定位点位于其" + f.side + " · 点击高亮地图" + "</small></span>" +
    '<span class="tag ' + (f.side === "暖侧" ? "warm" : "cold") + ' side-tag">' + f.side + "</span></div>"
  ).join("");
  $("nowFronts").querySelectorAll(".clickable").forEach((node) =>
    node.addEventListener("click", () => toggleSelect(node.dataset.type, node.dataset.id)));

  const e = $("nowEmpty");
  if (snap.inRange.length === 0) {
    e.hidden = false;
    const near = snap.nearest;
    e.innerHTML = "<b>作业半径 " + state.range + " km 内未检出锋面</b><br/>已回退参考最近对象：" +
      (near ? near.id + " " + near.name + "（" + near.bearing + " " + near.km.toFixed(1) + " km）" : "无") +
      "；可扩大作业半径或切换时次。";
  } else {
    e.hidden = true;
  }
  $("nowMetrics").querySelectorAll(".m[data-type]").forEach((node) =>
    node.addEventListener("click", () => toggleSelect(node.dataset.type, node.dataset.id)));
  syncSelect();
}

// ==================== L2-未来 ====================
function renderFuture() {
  const snap = snapshot();
  $("futureTag").innerHTML = "";

  if (!snap.status.ok) {
    $("futureTag").textContent = "无数据";
    $("futureList").innerHTML = "";
    $("futureBars").innerHTML = "";
    $("futureBestTag").textContent = "—";
    $("futureDays").innerHTML = '<div class="row"><span class="i">i</span><span class="grow">' + snap.status.title +
      "<small>" + snap.status.desc + "</small></span></div>";
    return;
  }

  const days = futureSeries(FCST_SPAN);
  const m1 = days[0].score, m3 = days[2].score, m7 = days[days.length - 1].score;
  $("futureTag").textContent = "1 天 " + m1 + "% · 3 天 " + m3 + "% · 7 天 " + m7 + "%";

  const best = days.reduce((a, b) => (b.score > a.score ? b : a), days[0]);
  const base = state.time.family === "fcst" ? TODAY : state.time.date;
  $("futureList").innerHTML =
    '<div class="row"><span class="i">→</span><span class="grow"><b>未来 1 天 可能度 ' + m1 + "%</b>（" + mdText(days[0].date) + "）" +
    "<small>持续性外推：以当前锋面稳定性为主</small></span></div>" +
    '<div class="row"><span class="i">→</span><span class="grow"><b>未来 3 天 可能度 ' + m3 + "%</b>（" + mdText(days[2].date) + "）" +
    "<small>叠加气候态频率衰减</small></span></div>" +
    '<div class="row"><span class="i">→</span><span class="grow"><b>未来 7 天 可能度 ' + m7 + "%</b>（" + mdText(days[days.length - 1].date) + "）" +
    "<small>趋势参考，不作作业依据</small></span></div>";

  $("futureBestTag").textContent = "最佳窗口 " + mdText(best.date) + " · " + best.score + "%";
  $("futureBars").innerHTML = days.map((d) =>
    '<i class="' + (d.date === best.date ? "active" : "") + '" style="height:' + Math.max(5, d.score) + '%"></i>').join("");
  $("futureDays").innerHTML = days.map((d) =>
    '<div class="row"><span class="i">' + (d.date === best.date ? "★" : "·") + '</span><span class="grow"><b>' + mdText(d.date) +
    " 可能度 " + d.score + "%</b> · 风 " + d.sea.wind + " 级 / 浪 " + d.sea.wave + " m" +
    "<small>" + (d.sea.level === "unsafe" ? "不适航，安全优先" : d.score >= 60 ? "可作业窗口" : "可能度偏低") +
    (d.date < base ? "（历史时次，仅演示）" : "") + "</small></span></div>").join("");
}

// ==================== L2-规律 ====================
function climSeries() {
  const m = state.clim;
  if (m.mode === "month") {
    const year = Number(m.month.slice(0, 4)) || 2024;
    const base = [62, 71, 78, 66, 41, 34, 29, 38, 47, 55, 63, 70];
    const vals = base.map((v, i) => clamp(Math.round(v + (rnd("mv" + year + "-" + (i + 1)) - 0.5) * 14), 5, 95));
    return { vals, active: clamp(Number(m.month.slice(5, 7)) - 1, 0, 11), title: year + " 年", totalDays: 31 };
  }
  if (m.mode === "year") {
    const years = [2019, 2020, 2021, 2022, 2023, 2024, 2025];
    const vals = years.map((y) => clamp(Math.round(46 + (rnd("yv" + y) - 0.5) * 26), 5, 95));
    const cur = Number(m.year) || 2024;
    return { vals, active: Math.max(0, years.indexOf(cur)), title: cur + " 年", years: years, totalDays: 366 };
  }
  const vals = [];
  for (let i = 29; i >= 0; i--) vals.push(clamp(Math.round(30 + rnd("dv" + addDays(m.date, -i)) * 65), 5, 95));
  return { vals, active: 29, title: m.date + " 近 30 日", totalDays: 30 };
}

function renderClim() {
  const m = state.clim;
  $("climDate").style.display = m.mode === "day" ? "" : "none";
  $("climMonth").style.display = m.mode === "month" ? "" : "none";
  $("climYear").style.display = m.mode === "year" ? "" : "none";
  document.querySelectorAll("#climPeriod button").forEach((b) => b.classList.toggle("active", b.dataset.period === m.mode));

  const s = climSeries();
  const rate = s.vals[s.active];
  const hit = Math.round((rate / 100) * s.totalDays);
  $("climHint").textContent = m.mode === "day" ? "按日 · " + m.date : m.mode === "month" ? "按月 · " + m.month : "按年 · " + m.year;
  $("climBars").innerHTML = s.vals.map((v, i) =>
    '<i class="' + (i === s.active ? "active" : "") + '" style="height:' + Math.max(4, v) + '%"></i>').join("");
  $("climStat").innerHTML = "<b>" + s.title + "</b> 锋面出现率 <b>" + rate + "%</b>（统一口径：窗口内有锋面天数 " +
    hit + " / 有效天数 " + s.totalDays + "）";

  // 多年同期与异常提示（直接给出作业含义）
  const multi = [2019, 2020, 2021, 2022, 2023].map((y) => ({
    y: y, v: clamp(Math.round(rate + (rnd("sy" + y + m.mode + m.date) - 0.5) * 22), 5, 95),
  }));
  const mean = Math.round(multi.reduce((a, b) => a + b.v, 0) / multi.length);
  const diff = rate - mean;
  const anomaly = Math.abs(diff) >= 8 ? (diff > 0 ? "偏高" : "偏低") : "正常";
  $("climYears").innerHTML =
    '<div class="line"><span class="k">多年同期均值</span> → <b>' + mean + "%</b>（2019–2023）</div>" +
    '<div class="line"><span class="k">今年同期偏离</span> → <b>' + (diff > 0 ? "+" : "") + diff + "%</b> · " + anomaly + "</div>" +
    '<div class="line"><span class="k">作业含义</span> → ' + (anomaly === "偏高" ? "锋面活动强于常年，线索更集中" :
      anomaly === "偏低" ? "锋面活动弱于常年，建议跟随实时锋面而非同期经验" : "与常年接近，可参考同期作业经验") + "</div>" +
    multi.map((x) => '<div class="line"><span class="k">' + x.y + " 年</span> → " + x.v + "%</div>").join("");
  $("climHint").className = "tag " + (anomaly === "正常" ? "ok" : "warm");
}

// ==================== L2-依据（原「AI 分析」的可解释层） ====================
function tableRows(rows) {
  return rows.map((r) => '<div class="tr"><span class="th">' + r[0] + '</span><span class="td">' + r[1] + "</span></div>").join("");
}
function listRows(rows) {
  return rows.map((r) => '<div class="row"><span class="i">' + r[0] + '</span><span class="grow">' + r[1] + "</span></div>").join("");
}

function renderBasis() {
  $("basisData").innerHTML = tableRows([
    ["锋面位置", "锋面产品 0.05°（冷暖侧 / 对象） <em>样例</em>"],
    ["海表温度", "analysed_sst 0.05° <em>待接入真实数据</em>"],
    ["锋面强度", "frontal_intensity <em>待接入</em>"],
    ["水深/海岸线", "GEBCO 底图与海陆掩码 <em>待接入</em>"],
    ["AIS 渔场", "合作方渔业数据 <em>待接入，另建渔场视图</em>"],
    ["当前时次", timeLabel() + " <em>演示占位</em>"],
    ["更新时效", "观测 ≤24 h · 预报逐日 <em>演示</em>"],
  ]);
  $("basisRules").innerHTML = listRows([
    ["1", "<b>作业半径</b>：以定位点为圆心，半径内锋面 / 渔场区计为「范围内命中」；半径内无命中时回退最近对象并明确标注"],
    ["2", "<b>出现率唯一口径</b>：窗口内有锋面天数 / 窗口内有效天数；不再使用多重概率或可信度标签"],
    ["3", "<b>可能度</b>：锋面基础分 + 范围内锋面条数 + 冷暖侧匹配 + 温度梯度 + 渔场区 + 适温匹配（分项在结论卡「依据」逐条列出）"],
    ["4", "<b>结论三档</b>：不适航 → 暂缓出海；适航且可能度 ≥60% → 可出海；其余 → 谨慎出海（安全优先）"],
    ["5", "<b>航时/油耗</b>：按 8 kn 巡航（14.8 km/h）、1.6 L/km 估算，仅用于量级比较"],
    ["6", "<b>未来可能度</b>：当日可能度 × 每日 6% 持续性衰减 × ±9% 确定性扰动（原型口径，需离线回测校准）"],
  ]);
  $("basisLimits").innerHTML = listRows([
    ["!", "全部数值为演示占位，未接入真实 SST / 锋面强度 / 海况数据"],
    ["!", "海况为 mock，实船作业请以官方海洋预报为准；本系统不承担航行安全责任"],
    ["!", "「渔场高概率区」为示意，尚未用 AIS 渔获或船位数据验证"],
    ["!", "三维球面视图、离线包、移动端不在本期范围（见需求文档 §8 Roadmap）"],
  ]);
}

// ==================== Toast（仅用于操作确认） ====================
let toastTimer;
function showToast(text) {
  $("toastLoc").textContent = text;
  const t = $("toast");
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 1600);
}

// ==================== 统一刷新（state → 全部渲染） ====================
function refresh() {
  invalidate();
  renderLegend();
  drawMap();
  renderHero();
  renderNow();
  renderFuture();
  renderClim();
  renderBasis();
  $("dataStamp").textContent = timeLabel() + " · 演示占位";
  document.querySelectorAll("#rangeSeg button").forEach((b) => b.classList.toggle("active", Number(b.dataset.range) === state.range));
  document.querySelectorAll("#familySeg button").forEach((b) => b.classList.toggle("active", b.dataset.family === state.time.family));
  $("speciesSel").value = state.species;
  $("timeDate").value = state.time.date;
  $("timeLab").textContent = state.time.family === "clim" ? "同期" : "时次";
  $("datePrev").title = state.time.family === "clim" ? "上一月同期" : "前一时刻";
  $("dateNext").title = state.time.family === "clim" ? "下一月同期" : "后一时刻";
}

function addMonths(iso, n) {
  const p = iso.split("-").map(Number);
  const tot = p[0] * 12 + (p[1] - 1) + n;
  const y = Math.floor(tot / 12), m = ((tot % 12) + 12) % 12;
  return y + "-" + String(m + 1).padStart(2, "0") + "-" + String(p[2]).padStart(2, "0");
}

function switchTab(name) {
  state.tab = name;
  document.querySelectorAll("#tabs button").forEach((b) => {
    const on = b.dataset.pane === name;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  });
  document.querySelectorAll(".pane").forEach((p) => p.classList.toggle("active", p.id === "pane-" + name));
}

// ==================== 事件绑定 ====================
function bind() {
  // 目标鱼种（L0）
  $("speciesSel").innerHTML = Object.keys(SPECIES).map((k) => '<option value="' + k + '">' + SPECIES[k].label + "</option>").join("");
  $("speciesSel").addEventListener("change", (e) => { state.species = e.target.value; refresh(); showToast("目标鱼种：" + SPECIES[state.species].label); });

  // 作业半径（L0，唯一范围真源）
  document.querySelectorAll("#rangeSeg button").forEach((btn) => {
    btn.addEventListener("click", () => { state.range = Number(btn.dataset.range); state.select = null; refresh(); showToast("作业半径：" + state.range + " km"); });
  });

  // 时间条（L0，唯一时间真源）
  $("timeDate").addEventListener("change", (e) => { state.time.date = e.target.value || TODAY; refresh(); });
  $("datePrev").addEventListener("click", () => {
    state.time.date = state.time.family === "clim" ? addMonths(state.time.date, -1) : addDays(state.time.date, -1);
    refresh();
  });
  $("dateNext").addEventListener("click", () => {
    state.time.date = state.time.family === "clim" ? addMonths(state.time.date, 1) : addDays(state.time.date, 1);
    refresh();
  });
  document.querySelectorAll("#familySeg button").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.time.family = btn.dataset.family;
      // 预报为滚动窗口：日期落在窗口外时收敛到"今天"，避免出现无意义的远期时次
      if (state.time.family === "fcst" && (state.time.date < TODAY || state.time.date > addDays(TODAY, FCST_SPAN - 1))) {
        state.time.date = TODAY;
      }
      refresh();
      showToast("时间族：" + btn.textContent.trim() + " · " + timeLabel());
    });
  });

  // 定位
  const doLocate = () => {
    const raw = $("locInput").value.trim();
    const m = raw.match(/(\d+(?:\.\d+)?)\s*°?\s*[eE]?\s*,\s*(\d+(?:\.\d+)?)/);
    if (!m) { showToast("无法解析坐标，示例：124.50°E, 30.20°N"); return; }
    state.lon = parseFloat(m[1]); state.lat = parseFloat(m[2]);
    state.select = null;
    refresh();
    showToast("已定位 " + state.lon.toFixed(2) + "°E, " + state.lat.toFixed(2) + "°N");
  };
  $("locateBtn").addEventListener("click", doLocate);
  $("locInput").addEventListener("keydown", (e) => { if (e.key === "Enter") doLocate(); });

  // 地图缩放
  $("zoomIn").addEventListener("click", () => { state.zoom = Math.min(state.zoom * 1.25, 4); applyZoom(); });
  $("zoomOut").addEventListener("click", () => { state.zoom = Math.max(state.zoom / 1.25, 0.4); applyZoom(); });
  $("recenter").addEventListener("click", () => { state.zoom = 1; applyZoom(); });

  // 图层开关（图例）
  document.querySelectorAll(".legend-row[data-layer]").forEach((row) => {
    row.addEventListener("click", () => {
      const k = row.dataset.layer;
      state.layers[k] = !state.layers[k];
      if (!state.layers[k] && state.select && state.select.type === k) state.select = null;
      renderLegend(); drawMap(); syncSelect();
      const meta = LAYER_META.find((m) => m[0] === k) || [k, k];
      showToast("图层「" + meta[1] + "」已" + (state.layers[k] ? "开启" : "关闭"));
    });
  });

  // 页签（主任务 / 支撑分层；方向键可切换）
  const tabBtns = Array.from(document.querySelectorAll("#tabs button"));
  tabBtns.forEach((btn, i) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.pane));
    btn.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const n = (i + (e.key === "ArrowRight" ? 1 : -1) + tabBtns.length) % tabBtns.length;
      tabBtns[n].focus();
      switchTab(tabBtns[n].dataset.pane);
    });
  });

  // 规律页：周期与锚点（时间控件仅存在于该页）
  document.querySelectorAll("#climPeriod button").forEach((btn) => {
    btn.addEventListener("click", () => { state.clim.mode = btn.dataset.period; renderClim(); });
  });
  $("climDate").addEventListener("change", (e) => { state.clim.date = e.target.value; state.clim.mode = "day"; renderClim(); });
  $("climMonth").addEventListener("change", (e) => { state.clim.month = e.target.value; state.clim.mode = "month"; renderClim(); });
  $("climYear").addEventListener("change", (e) => { state.clim.year = e.target.value; state.clim.mode = "year"; renderClim(); });
  $("toBasis").addEventListener("click", () => switchTab("basis"));
}

function applyZoom() {
  const w = 1000 / state.zoom, h = 640 / state.zoom;
  const svg = $("mapSvg");
  svg.style.transition = "all .25s ease";
  svg.setAttribute("viewBox", (1000 - w) / 2 + " " + (640 - h) / 2 + " " + w + " " + h);
}

// ==================== 启动 ====================
bind();
refresh();
switchTab("now");





