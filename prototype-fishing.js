/* 渔场向导 · 交互原型（纯前端演示，无真实数据）
 *
 * 信息架构（三层）：
 *   L0 顶栏      ① 从哪出发 ② 找多远 ③ 找什么鱼 ④ 出海日 —— 全局唯一真源
 *   L1 结论层    hero 常驻：能不能出海 + 去哪个点 + 为什么
 *   L2 页签      现在（观测）/ 未来（预报） ｜ 往年同期 / 依据
 *
 * 数据流：state（唯一真源） --渲染--> DOM；所有 render* 只读 state，不写 state。
 */
"use strict";

// ==================== 常量与算法说明（「依据」页展示同一套） ====================
const KM_PER_DEG = 111;
const TODAY = "2024-08-05";                                   // 演示用的"今天"
const OBS_WINDOW = { from: "2024-06-01", to: "2024-09-30" };  // 观测资料覆盖期
const FCST_SPAN = 7;                                          // 预报覆盖未来 7 天
const DATE_MIN = OBS_WINDOW.from;                             // 出海日可选范围
const DATE_MAX = addDays(TODAY, FCST_SPAN - 1);
const CRUISE_KMH = 14.8;                                      // 按 8 节航速换算
const FUEL_L_PER_KM = 1.6;                                    // 小型渔船量级，仅用于比较
const SST_RANGE = { north: 31.65, south: 28.75, min: 22, max: 33 };

// 地图投影：东西向与南北向 1 km 一样长，半径圈才是正圆
const ANCHOR = { lon: 124.5, lat: 30.2 };
const PX_LON = 180;
const KM2PX = PX_LON / (KM_PER_DEG * Math.cos((ANCHOR.lat * Math.PI) / 180));
const PX_LAT = KM2PX * KM_PER_DEG;
const SUB = { cold: 0.13, warm: 0.08 };   // 冷侧 / 暖侧带相对锋面线的纬度偏移

const SPECIES = {
  hairtail:      { label: "带鱼",       sst: [16, 28], prefer: "any" },
  yellowcroaker: { label: "小黄鱼",     sst: [14, 22], prefer: "cold" },
  chubmackerel:  { label: "鲐鱼",       sst: [17, 25], prefer: "warm" },
  squid:         { label: "剑尖枪乌贼", sst: [19, 27], prefer: "warm" },
};

// ==================== 状态（唯一真源） ====================
const state = {
  lon: 124.5, lat: 30.2,                   // ① 从哪出发
  range: 20,                               // ② 找多远（km）
  species: "hairtail",                     // ③ 找什么鱼
  date: TODAY,                             // ④ 出海日（唯一时间控件）
  layers: { sst: true, front: true, coldwarm: true, fishing: true },
  select: null,                            // 被选中的对象 {type, id}
  probe: null,                             // 钉住的地图点 {lon, lat}
  tab: "now",
  climMode: "month",                       // 往年同期页：day | month | year
  zoom: 1,
};

const $ = (id) => document.getElementById(id);
const SELECT_LABEL = { front: "锋面线", coldwarm: "冷侧 / 暖侧", sst: "海表温度", fishing: "值得去的水域" };
const SELECT_LAYERS = { front: ["front"], coldwarm: ["coldwarm"], sst: ["sst"], fishing: ["fishing"] };
const LAYER_META = [["sst", "海表温度"], ["front", "锋面线"], ["coldwarm", "冷侧 / 暖侧"], ["fishing", "值得去的水域"]];
const DIRS16 = ["正北", "东北偏北", "东北", "东北偏东", "正东", "东南偏东", "东南", "东南偏南",
  "正南", "西南偏南", "西南", "西南偏西", "正西", "西北偏西", "西北", "西北偏北"];

// ==================== 小工具 ====================
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
function xy(lon, lat) { return [500 + (lon - ANCHOR.lon) * PX_LON, 320 - (lat - ANCHOR.lat) * PX_LAT]; }
function geoOfXY(x, y) { return [ANCHOR.lon + (x - 500) / PX_LON, ANCHOR.lat - (y - 320) / PX_LAT]; }

// 点到线段的最短距离（km）与最近的落点
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
// 海表温度：与地图色带同源（北冷南暖，随纬度线性变化）
function sstAt(lat) { return SST_RANGE.min + ((SST_RANGE.north - lat) / (SST_RANGE.north - SST_RANGE.south)) * (SST_RANGE.max - SST_RANGE.min); }
function fmtCoord(lon, lat) { return lon.toFixed(2) + "°E, " + lat.toFixed(2) + "°N"; }

// ==================== 演示数据（确定性，刷新结果一致） ====================
// 锋面用同一个形状函数采样：地图画出来的线和卡片里的距离是同一来源
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
// 值得去的水域：椭圆半轴直接用公里写，画图时再乘比例（避免地图与卡片两套说法）
const FISHING_SPOTS = [
  { id: "S1", lon: 124.62, lat: 30.31, rxKm: 22, ryKm: 16, grade: "高" },
  { id: "S2", lon: 123.90, lat: 29.90, rxKm: 16, ryKm: 12, grade: "中" },
];

// ==================== 数据有没有、是哪一类 ====================
function obsStatus() {
  if (state.date > TODAY)
    return { ok: false, title: "这天还没观测到", desc: "观测资料只到今天（" + mdText(TODAY) + "）；要看这天的情况，请切到「未来」" };
  if (state.date < OBS_WINDOW.from || state.date > OBS_WINDOW.to)
    return { ok: false, title: "超出观测范围", desc: "观测资料从 " + OBS_WINDOW.from + " 到 " + OBS_WINDOW.to };
  return { ok: true, title: "", desc: "" };
}
function fcstStatus() {
  if (state.date < TODAY)
    return { ok: false, title: "这天已经过去", desc: "预报只往后算 " + FCST_SPAN + " 天；想看过去的情况，请切到「现在」", jump: "today" };
  if (state.date > DATE_MAX)
    return { ok: false, title: "超出预报范围", desc: "预报只到 " + mdText(DATE_MAX) + "（今天往后 " + FCST_SPAN + " 天）", jump: "max" };
  return { ok: true, title: "", desc: "" };
}
// 结论卡用哪一套：出海日 <= 今天看观测，之后看预报
function activeStatus() { return state.date > TODAY ? fcstStatus() : obsStatus(); }
function dataSourceText() { return state.date > TODAY ? "预报" : "观测"; }

// 一句话说明"现在看的是哪一天"
function timeLabel() {
  const n = Math.round((Date.parse(state.date) - Date.parse(TODAY)) / 86400000);
  const src = dataSourceText();
  if (n === 0) return mdText(state.date) + "（今天）· " + src;
  if (n > 0) return mdText(state.date) + "（" + n + " 天后）· " + src;
  return mdText(state.date) + "（" + Math.abs(n) + " 天前）· " + src;
}

// ==================== 几何同源的距离 / 方位 / 你在哪一侧 ====================
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
    return { id: s.id, lon: s.lon, lat: s.lat, rxKm: s.rxKm, ryKm: s.ryKm, grade: s.grade,
      km, bearing: bearing16([state.lon, state.lat], [s.lon, s.lat]), inRange: km <= state.range };
  }).sort((a, b) => a.km - b.km);
}

// 海况（演示数据）
function seaState(date) {
  const wind = 3 + (hash("wind" + date) % 4);                        // 3~6 级
  const wave = +(0.6 + (hash("wave" + date) % 10) / 10).toFixed(1);  // 0.6~1.5 m
  const swell = +(0.5 + (hash("swell" + date) % 9) / 10).toFixed(1); // 0.5~1.3 m
  const seaworthy = wind <= 5 && wave <= 1.5;
  const marginal = !seaworthy && wind <= 6 && wave <= 1.8;
  return { wind, wave, swell, level: seaworthy ? "seaworthy" : marginal ? "marginal" : "unsafe" };
}

// ==================== "去这里的把握"怎么加出来的（分项进「为什么这么判断」） ====================
function scoreBreakdown(sea) {
  const fronts = frontInfo();
  const inRange = fronts.filter((f) => f.inRange);
  const nearest = fronts[0] || null;
  const spots = spotInfo();
  const spotIn = spots.filter((s) => s.inRange);
  const sst = sstAt(state.lat);
  const sp = SPECIES[state.species];
  const gradHigh = rnd("grad" + state.date) > 0.42;
  const items = [];
  let s = 30;
  items.push(["起评分", 30]);
  const addF = Math.min(inRange.length, 3) * 12;
  s += addF;
  items.push(["找鱼范围内有 " + inRange.length + " 条锋面", addF]);
  const preferText = sp.prefer === "cold" ? "冷侧" : sp.prefer === "warm" ? "暖侧" : "冷暖交汇";
  const sideOk = sp.prefer === "any" ? 0 : (nearest && nearest.side === (sp.prefer === "cold" ? "冷侧" : "暖侧") ? 15 : -5);
  s += sideOk;
  items.push(["你在" + (nearest ? nearest.side : "—") + "（" + sp.label + "喜欢" + preferText + "）", sideOk]);
  const gradScore = gradHigh ? 8 : -8;
  s += gradScore;
  items.push(["水温变化比往年" + (gradHigh ? "明显" : "不明显"), gradScore]);
  const spotScore = spotIn.length ? 15 : 0;
  s += spotScore;
  items.push(["范围内有 " + spotIn.length + " 处值得去的水域", spotScore]);
  const fit = sst >= sp.sst[0] && sst <= sp.sst[1];
  const fitScore = fit ? 12 : -6;
  s += fitScore;
  items.push(["你这里水温 " + sst.toFixed(1) + "°C（" + sp.label + "合适 " + sp.sst[0] + "~" + sp.sst[1] + "°C）", fitScore]);
  return { score: clamp(Math.round(s), 5, 95), items, fronts, inRange, nearest, spots, spotIn, sst, gradHigh, sea };
}

// 三档结论：先看安全，再看把握
function verdictOf(score, sea) {
  if (sea.level === "unsafe") return { key: "stop", text: "别出海", cls: "stop" };
  if (sea.level === "marginal" || score < 60) return { key: "caution", text: "谨慎出海", cls: "caution" };
  return { key: "go", text: "可以出海", cls: "ok" };
}

// 一次快照（多个 render 复用；state 一变就作废）
let _snap = null;
function snapshot() {
  if (_snap) return _snap;
  const status = activeStatus();
  const sea = seaState(state.date);
  const core = status.ok
    ? scoreBreakdown(sea)
    : { score: 0, items: [], fronts: [], inRange: [], nearest: null, spots: [], spotIn: [], sst: null, gradHigh: false };
  _snap = Object.assign({ status, sea }, core);
  return _snap;
}
function invalidate() { _snap = null; }

// 未来逐日把握（演示算法：当天把握 × 每天衰减 6% × 上下 9% 的浮动）
function futureSeries(n) {
  const base = snapshot().score || 45;
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = addDays(state.date, i);
    const score = clamp(Math.round(base * (1 - i * 0.06) * (1 + (rnd("fcst" + d) - 0.5) * 0.18)), 5, 95);
    out.push({ date: d, score, sea: seaState(d) });
  }
  return out;
}

// ==================== 地图（SVG） ====================
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

// 钉住的那个点，画个十字
function drawProbeMark(svg) {
  if (!state.probe) return;
  const p = xy(state.probe.lon, state.probe.lat);
  el("line", { x1: p[0] - 11, y1: p[1], x2: p[0] + 11, y2: p[1], stroke: "#ffd9a0", "stroke-width": 1.4 }, svg);
  el("line", { x1: p[0], y1: p[1] - 11, x2: p[0], y2: p[1] + 11, stroke: "#ffd9a0", "stroke-width": 1.4 }, svg);
  el("circle", { cx: p[0], cy: p[1], r: 3.2, fill: "#ffd9a0" }, svg);
}

function drawMap() {
  const svg = $("mapSvg");
  svg.innerHTML = "";
  const defs = el("defs", {}, svg);
  const snap = snapshot();
  const ok = snap.status.ok;
  const sel = state.select;
  const dim = (k) => (sel && sel.type !== k ? 0.14 : 1);

  // 没数据就盖一层说明，不让地图假装有东西
  $("mapEmpty").hidden = ok;
  if (!ok) {
    $("mapEmptyTitle").textContent = snap.status.title;
    $("mapEmptyDesc").textContent = snap.status.desc + "（现在选的是 " + timeLabel() + "）";
  }

  // 经纬网格
  for (let i = 0; i <= 20; i++) el("line", { x1: (i / 20) * 1000, y1: 0, x2: (i / 20) * 1000, y2: 640, stroke: "rgba(150,200,230,0.07)" }, svg);
  for (let i = 0; i <= 12; i++) el("line", { x1: 0, y1: (i / 12) * 640, x2: 1000, y2: (i / 12) * 640, stroke: "rgba(150,200,230,0.07)" }, svg);

  // 海表温度：与 sstAt() 同一来源（北冷南暖）
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
    // 冷侧 / 暖侧带
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

    // 值得去的水域（半轴按公里折算，和卡片里的距离同一口径）
    if (state.layers.fishing) {
      (snap.spots || []).forEach((s) => {
        const p = xy(s.lon, s.lat);
        const rx = s.rxKm * KM2PX, ry = s.ryKm * KM2PX;
        const isSel = !!sel && sel.type === "fishing" && (!sel.id || sel.id === s.id);
        el("ellipse", { cx: p[0], cy: p[1], rx: rx, ry: ry, fill: "rgba(255,180,84,0.26)", stroke: "rgba(255,200,120,0.5)", "stroke-dasharray": "4 3", opacity: dim("fishing") }, svg);
        el("text", { x: p[0] - rx, y: p[1] - ry - 5, fill: "#ffc46b", "font-size": 11.5, "paint-order": "stroke", stroke: "rgba(11,20,32,0.9)", "stroke-width": 3, opacity: 0.45 + 0.55 * dim("fishing") }, svg)
          .textContent = "值得去的水域 " + s.id + "（把握" + s.grade + "）";
        if (isSel) {
          const q = xy(state.lon, state.lat);
          el("line", { x1: q[0], y1: q[1], x2: p[0], y2: p[1], stroke: "#ffb454", "stroke-width": 1.2, "stroke-dasharray": "5 4", opacity: 0.8 }, svg);
          el("ellipse", { cx: p[0], cy: p[1], rx: rx + 5, ry: ry + 5, fill: "none", stroke: "#ffb454", "stroke-width": 2, opacity: 0.95 }, svg);
        }
      });
    }
  }

  // 定位点 + 找鱼范围圈（没数据时也保留，作为参照）
  const q = xy(state.lon, state.lat);
  [10, 20, 30].forEach((km) => {
    const r = km * KM2PX;
    const isRange = km === state.range;
    el("circle", { cx: q[0], cy: q[1], r: r, fill: isRange ? "rgba(77,212,198,0.05)" : "none",
      stroke: isRange ? "rgba(77,212,198,0.55)" : "rgba(140,225,212,0.26)", "stroke-width": isRange ? 1.2 : 1,
      "stroke-dasharray": isRange ? "5 4" : "3 5" }, svg);
    el("text", { x: q[0], y: q[1] - r - 4, "text-anchor": "middle",
      fill: isRange ? "rgba(165,242,230,0.9)" : "rgba(140,225,212,0.4)", "font-size": isRange ? 10 : 8.5 }, svg).textContent = km + " km";
  });
  el("circle", { cx: q[0], cy: q[1], r: 8, fill: "none", stroke: "#4dd4c6", "stroke-width": 2, class: "pulse" }, svg);
  el("circle", { cx: q[0], cy: q[1], r: 5, fill: "#fff" }, svg);
  el("text", { x: q[0] + 14, y: q[1] - 12, fill: "#fff", "font-size": 13, "font-weight": "bold",
    "paint-order": "stroke", stroke: "rgba(11,20,32,0.85)", "stroke-width": 3 }, svg).textContent = fmtCoord(state.lon, state.lat);
  el("text", { x: 966, y: 40, fill: "rgba(200,225,240,0.6)", "font-size": 13 }, svg).textContent = "N ↑";

  drawProbeMark(svg);
  el("style", {}, defs).textContent = "@keyframes pulseAnim{0%{r:8;opacity:.9}100%{r:32;opacity:0}}.pulse{animation:pulseAnim 1.6s ease-out infinite}";
}

// ==================== 鼠标放到地图上：看那个点的数据 ====================
let hoverPt = null;   // {lon, lat, x, y}，x/y 是相对地图的像素

// 两块陆地的近似边界（和地图上画的海岸线是同一套形状）
const COAST = [[-20, 330], [0, 322], [80, 285], [120, 250], [190, 210], [260, 178], [300, 135], [360, 95], [420, 60]];
function isLandXY(x, y) {
  if (y >= -20 && y <= 420) {
    let cx = -1e9;
    for (let i = 0; i < COAST.length - 1; i++) {
      const a = COAST[i], b = COAST[i + 1];
      if (y >= a[0] && y <= b[0]) { cx = a[1] + ((b[1] - a[1]) * (y - a[0])) / (b[0] - a[0]); break; }
    }
    if (x <= cx) return true;
  }
  if (y >= -20 && y <= 40 && x >= 960 + (y + 20) / 1.5) return true;
  return false;
}

// 经纬度 <-> 屏幕像素（用 SVG 的变换矩阵，缩放后也不会错位）
function screenOf(lon, lat) {
  const svg = $("mapSvg");
  const p = svg.createSVGPoint();
  const q = xy(lon, lat);
  p.x = q[0]; p.y = q[1];
  const s = p.matrixTransform(svg.getScreenCTM());
  const r = $("map").getBoundingClientRect();
  return { x: s.x - r.left, y: s.y - r.top };
}
function geoOfScreen(clientX, clientY) {
  const svg = $("mapSvg");
  const p = svg.createSVGPoint();
  p.x = clientX; p.y = clientY;
  const loc = p.matrixTransform(svg.getScreenCTM().inverse());
  return geoOfXY(loc.x, loc.y);
}

function nearestFrontFrom(lon, lat) {
  let best = null;
  FRONTS.forEach((f) => {
    for (let i = 0; i < f.points.length - 1; i++) {
      const r = nearestOnSegment([lon, lat], f.points[i], f.points[i + 1]);
      if (!best || r.km < best.km) best = { id: f.id, name: f.name, km: r.km, point: r.point };
    }
  });
  if (best) {
    best.bearing = bearing16([lon, lat], best.point);
    best.side = lat > best.point[1] ? "冷侧" : "暖侧";
  }
  return best;
}
function nearestSpotFrom(lon, lat) {
  const list = FISHING_SPOTS.map((s) => {
    const dx = (lon - s.lon) * kmPerLon(s.lat);
    const dy = (lat - s.lat) * KM_PER_DEG;
    return { id: s.id, grade: s.grade, km: Math.hypot(dx, dy), bearing: bearing16([lon, lat], [s.lon, s.lat]),
      inside: (dx * dx) / (s.rxKm * s.rxKm) + (dy * dy) / (s.ryKm * s.ryKm) <= 1 };
  }).sort((a, b) => a.km - b.km);
  return list.find((s) => s.inside) || list[0] || null;
}

function probeHTML(lon, lat) {
  const q = xy(lon, lat);
  const head = '<div class="mp-coord">' + fmtCoord(lon, lat) + "</div>";
  const foot = '<div class="mp-foot">' + timeLabel() + " · 示例数据<br/>点一下钉住，Esc 取消</div>";
  if (isLandXY(q[0], q[1])) return head + '<div class="mp-note">这里是陆地（岸上），没有海温数据</div>' + foot;
  const st = activeStatus();
  if (!st.ok) return head + '<div class="mp-note">' + st.title + "，这个时段没有数据，不估数</div>" + foot;

  const sp = SPECIES[state.species];
  const sst = sstAt(lat);
  const inTemp = sst >= sp.sst[0] && sst <= sp.sst[1];
  const km = distKm([state.lon, state.lat], [lon, lat]);
  const bearing = bearing16([state.lon, state.lat], [lon, lat]);
  const nf = nearestFrontFrom(lon, lat);
  const spot = nearestSpotFrom(lon, lat);

  let h = head;
  h += '<div class="mp-row"><span class="mp-k">海表温度</span><span class="mp-v">' + sst.toFixed(1) + " °C</span></div>";
  h += '<div class="mp-note">' + sp.label + "合适 " + sp.sst[0] + "~" + sp.sst[1] + "°C → " +
    (inTemp ? "在这范围里" : sst > sp.sst[1] ? "偏暖" : "偏冷") + "</div>";
  h += '<div class="mp-row"><span class="mp-k">离你</span><span class="mp-v">' + km.toFixed(1) + " km · " + bearing + "</span></div>";
  h += '<div class="mp-note' + (km > state.range ? " mp-warn" : "") + '">' +
    (km <= state.range ? "在你选的 " + state.range + " km 找鱼范围内" : "超出 " + state.range + " km 找鱼范围") + "</div>";
  if (nf) {
    h += '<div class="mp-row"><span class="mp-k">最近锋面</span><span class="mp-v">' + nf.km.toFixed(1) + " km · " + nf.bearing + "</span></div>";
    h += '<div class="mp-note">' + nf.id + " " + nf.name + " · 这里在" + nf.side + "</div>";
  }
  if (spot) {
    h += '<div class="mp-row"><span class="mp-k">值得去的水域</span><span class="mp-v">' +
      (spot.inside ? "就在 " + spot.id + " 里" : "距 " + spot.id + " " + spot.km.toFixed(1) + " km") + "</span></div>";
    if (!spot.inside) h += '<div class="mp-note">往' + spot.bearing + "走可以进水区（" + spot.grade + "）</div>";
  }
  return h + foot;
}

function renderProbe() {
  const box = $("mapProbe");
  let lon = 0, lat = 0, pos = null;
  if (state.probe) {
    lon = state.probe.lon; lat = state.probe.lat;
    const p = screenOf(lon, lat);
    pos = { x: p.x + 14, y: p.y + 14 };
  } else if (hoverPt) {
    lon = hoverPt.lon; lat = hoverPt.lat;
    pos = { x: hoverPt.x + 16, y: hoverPt.y + 16 };
  }
  if (!pos) { box.hidden = true; return; }
  box.innerHTML = probeHTML(lon, lat);
  box.hidden = false;
  const r = $("map").getBoundingClientRect();
  box.style.transform = "translate(" + Math.round(clamp(pos.x, 8, Math.max(8, r.width - box.offsetWidth - 8))) +
    "px," + Math.round(clamp(pos.y, 8, Math.max(8, r.height - box.offsetHeight - 8))) + "px)";
}

// ==================== 选中回执：点了谁、怎么取消 ====================
function pickInfo() {
  const s = state.select;
  if (!s) return null;
  const snap = snapshot();
  if (s.type === "front") {
    const f = (snap.fronts || []).find((x) => x.id === s.id) || snap.fronts[0];
    if (!f) return null;
    return { name: "锋面线 " + f.id + " " + f.name,
      body: "离你 <b>" + f.km.toFixed(1) + " km</b> · " + f.bearing + " · 你在" + f.side + "<br/>" +
        (f.inRange ? "在你的找鱼范围内" : "超出你的找鱼范围") };
  }
  if (s.type === "fishing") {
    const p = (snap.spots || []).find((x) => x.id === s.id) || snap.spots[0];
    if (!p) return null;
    return { name: "值得去的水域 " + p.id,
      body: "离你 <b>" + p.km.toFixed(1) + " km</b> · " + p.bearing + " · 把握" + p.grade +
        "<br/>大小约 " + (p.rxKm * 2) + " × " + (p.ryKm * 2) + " km" };
  }
  if (s.type === "sst") return { name: "海表温度", body: "地图上的等温线已加亮：颜色越暖，水温越高" };
  return { name: "冷侧 / 暖侧", body: "蓝色是冷侧、橙色是暖侧，锋面就在两者中间" };
}
function renderPick() {
  const box = $("mapPick");
  const info = pickInfo();
  if (!info) { box.hidden = true; return; }
  $("pickName").innerHTML = info.name;
  $("pickBody").innerHTML = info.body;
  box.hidden = false;
}

// ==================== 选中（全站只有一套语义） ====================
function toggleSelect(type, id) {
  const same = !!(state.select && state.select.type === type && (!id || !state.select.id || state.select.id === id));
  state.select = same ? null : { type: type, id: id || null };
  if (!same) {
    SELECT_LAYERS[type].forEach((k) => { state.layers[k] = true; });
    state.probe = null;   // 选中对象与钉住的点只留一个，免得两个框抢同一块位置
  }
  renderLegend(); drawMap(); syncSelect(); renderPick(); renderProbe();
  showToast(same ? "已取消选中" : "已选中「" + SELECT_LABEL[type] + (id ? " " + id : "") + "」");
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

// ==================== L1 结论层（常驻，不随页签消失） ====================
function heroTarget() {
  const snap = snapshot();
  const spot = snap.spotIn[0];
  if (spot) return { type: "fishing", id: spot.id, label: "值得去的水域 " + spot.id, km: spot.km, bearing: spot.bearing, fallback: false };
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
    v.textContent = "先看数据";
    v.className = "verdict caution";
    l.innerHTML = "<b>" + snap.status.title + "</b> — " + snap.status.desc;
    pts.innerHTML = "";
    body.innerHTML = '<div class="line"><span class="k">现在选的日期</span> → ' + timeLabel() + "</div>" +
      '<div class="line"><span class="k">说明</span> → 没数据就不给把握、不给建议，免得编数</div>';
    syncSelect(); renderPick();
    return;
  }

  const verdict = verdictOf(snap.score, snap.sea);
  v.textContent = verdict.text;
  v.className = "verdict " + verdict.cls;

  const t = heroTarget();
  let line = "找 <b>" + sp.label + "</b> · <b>" + state.range + " km</b> 内 · 去这里的把握 <b>" + snap.score + "%</b>。";
  if (t) line += "先去 <b>" + t.bearing + " " + t.km.toFixed(1) + " km</b> 的" + t.label + "（开船约 " + fmtHours(t.km) + " 小时）。";
  else line += "这个范围里没找到像样的线索，可以把找鱼范围放大，或者换个日期。";
  if (snap.sea.level !== "seaworthy") line += " ⚠ 海况" + (snap.sea.level === "unsafe" ? "不适合出海" : "接近临界") + "，安全第一。";
  l.innerHTML = line;

  const picks = [];
  if (t) picks.push({ rank: 1, type: t.type, id: t.id, label: t.label, km: t.km, bearing: t.bearing,
    note: t.fallback ? "范围里没有，先给最近的" : "范围里最值得去的" });
  snap.inRange.filter((f) => !t || f.id !== t.id).slice(0, 2).forEach((f) => {
    picks.push({ rank: picks.length + 1, type: "front", id: f.id, label: "锋面 " + f.id + " " + f.name, km: f.km, bearing: f.bearing, note: "备选 · 在范围内" });
  });
  pts.innerHTML = picks.map((p) =>
    '<div class="pt" data-type="' + p.type + '" data-id="' + p.id + '"><span class="rk">' + p.rank + "</span>" +
    '<span class="grow"><b>' + p.bearing + " " + p.km.toFixed(1) + " km</b> · " + p.label +
    "<small>" + p.note + " · 开船约 " + fmtHours(p.km) + " 小时 · 油约 " + fmtFuel(p.km) + " L（怎么算的见「依据」）</small></span></div>"
  ).join("");
  pts.querySelectorAll(".pt").forEach((node) => node.addEventListener("click", () => toggleSelect(node.dataset.type, node.dataset.id)));

  body.innerHTML =
    snap.items.map((it) => '<div class="line"><span class="k">' + it[0] + "</span> → <b>" + (it[1] > 0 ? "+" : "") + it[1] + "</b></div>").join("") +
    '<div class="line"><span class="k">合计把握</span> → <b>' + snap.score + "%</b></div>" +
    '<div class="line"><span class="k">能不能出海</span> → 风力 ≤5 级 且 浪高 ≤1.5 m 就算能；现在是 ' + snap.sea.wind + " 级 / " + snap.sea.wave + " m</div>" +
    '<div class="line"><span class="k">三档怎么分</span> → 不能出海就是「别出海」；能出海且把握 ≥60% 是「可以出海」，其余「谨慎出海」</div>';
  syncSelect();
  renderPick();
}

// ==================== L2-现在（观测数据） ====================
function metricCell(label, value, unit, type, id) {
  return "<div class=\"m\"" + (type ? ' data-type="' + type + '" data-id="' + (id || "") + '" style="cursor:pointer"' : "") + ">" +
    '<div class="k">' + label + '</div><div class="v">' + value + "<small>" + (unit || "") + "</small></div></div>";
}

function renderNow() {
  const snap = snapshot();
  const sp = SPECIES[state.species];
  const st = obsStatus();

  if (!st.ok) {
    $("nowScopeTag").textContent = state.range + " km 内 · " + sp.label;
    $("nowMetrics").innerHTML = "";
    $("seaTag").textContent = "没数据"; $("seaTag").className = "tag warn";
    $("seaList").innerHTML = "";
    $("nowFronts").innerHTML = "";
    $("nowFrontTag").textContent = "没数据";
    const e0 = $("nowEmpty");
    e0.hidden = false;
    e0.innerHTML = "<b>" + st.title + "</b><br/>" + st.desc +
      (state.date > TODAY ? '<br/><button class="go" id="jumpFuture" style="margin-top:8px">去看「未来」</button>' : "");
    const b = $("jumpFuture");
    if (b) b.addEventListener("click", () => switchTab("future"));
    return;
  }

  const sst = snap.sst, nf = snap.nearest;
  const fit = sst >= sp.sst[0] && sst <= sp.sst[1];
  $("nowScopeTag").textContent = state.range + " km 内 · " + sp.label + " · 水温 " + sst.toFixed(1) + "°C" +
    (fit ? "合适" : sst > sp.sst[1] ? "偏暖" : "偏冷");
  $("nowMetrics").innerHTML =
    metricCell("你这里的水温", sst.toFixed(1), "°C", "sst") +
    metricCell("最近的锋面", nf.km.toFixed(1), "km", "front", nf.id) +
    metricCell("你在", nf.side, "", "coldwarm") +
    metricCell("去这里的把握", String(snap.score), "%", "fishing");

  const sea = snap.sea;
  $("seaTag").textContent = sea.level === "seaworthy" ? "能出海" : sea.level === "marginal" ? "看情况" : "别出海";
  $("seaTag").className = "tag " + (sea.level === "seaworthy" ? "ok" : "warn");
  $("seaList").innerHTML =
    '<div class="row"><span class="i">≈</span><span class="grow"><b>风力 ' + sea.wind + " 级</b> · 浪高 " + sea.wave +
    " m · 涌浪 " + sea.swell + ' m<small>能出海的标准：风力 ≤5 级 且 浪高 ≤1.5 m</small></span></div>' +
    '<div class="row"><span class="i">' + (sea.level === "seaworthy" ? "✓" : "!") + '</span><span class="grow"><b>' +
    (sea.level === "seaworthy" ? "符合出海条件" : sea.level === "marginal" ? "接近临界，建议缩短航次" : "超出出海条件，建议改天") +
    "</b><small>海况是示例数据；实船作业请以官方海洋预报为准</small></span></div>";

  $("nowFrontTag").textContent = "共 " + snap.fronts.length + " 条 · 范围内 " + snap.inRange.length + " 条";
  $("nowFronts").innerHTML = snap.fronts.map((f) =>
    '<div class="row clickable" data-type="front" data-id="' + f.id + '"><span class="i">' + (f.inRange ? "✓" : "·") + "</span>" +
    '<span class="grow"><b>' + f.id + " " + f.name + "</b> " + f.bearing + " " + f.km.toFixed(1) + " km" +
    "<small>" + (f.inRange ? "在找鱼范围内" : "超出找鱼范围，只作参考") + " · 你在它的" + f.side + " · 点一下在地图上高亮" + "</small></span>" +
    '<span class="tag ' + (f.side === "暖侧" ? "warm" : "cold") + ' side-tag">' + f.side + "</span></div>"
  ).join("");
  $("nowFronts").querySelectorAll(".clickable").forEach((node) =>
    node.addEventListener("click", () => toggleSelect(node.dataset.type, node.dataset.id)));

  const e = $("nowEmpty");
  if (snap.inRange.length === 0) {
    e.hidden = false;
    const near = snap.nearest;
    e.innerHTML = "<b>" + state.range + " km 内没有锋面</b><br/>先给你最近的一处参考：" +
      (near ? near.id + " " + near.name + "（" + near.bearing + " " + near.km.toFixed(1) + " km）" : "无") +
      "；可以把找鱼范围放大，或者换个日期。";
  } else {
    e.hidden = true;
  }
  $("nowMetrics").querySelectorAll(".m[data-type]").forEach((node) =>
    node.addEventListener("click", () => toggleSelect(node.dataset.type, node.dataset.id)));
  syncSelect();
}

// ==================== L2-未来（预报数据） ====================
function seaTagOf(sea) {
  if (sea.level === "seaworthy") return { text: "能出海", cls: "ok" };
  if (sea.level === "marginal") return { text: "看情况", cls: "warn" };
  return { text: "别出海", cls: "warn" };
}

function renderFuture() {
  const st = fcstStatus();
  if (!st.ok) {
    $("futureTag").textContent = "没数据";
    $("futureList").innerHTML = "";
    $("futureBars").innerHTML = "";
    $("futureBestTag").textContent = "—";
    const btn = st.jump === "today" ? '<button class="go" id="jumpToday">回到今天</button>'
      : st.jump === "max" ? '<button class="go" id="jumpMax">调到 ' + mdText(DATE_MAX) + "</button>" : "";
    $("futureDays").innerHTML = '<div class="row"><span class="i">i</span><span class="grow"><b>' + st.title +
      "</b><small>" + st.desc + "</small></span></div>" + (btn ? '<div style="margin-top:8px">' + btn + "</div>" : "");
    const b1 = $("jumpToday"), b2 = $("jumpMax");
    if (b1) b1.addEventListener("click", () => { state.date = TODAY; refresh(); });
    if (b2) b2.addEventListener("click", () => { state.date = DATE_MAX; refresh(); });
    return;
  }

  const days = futureSeries(FCST_SPAN);
  const best = days.reduce((a, b) => (b.score > a.score ? b : a), days[0]);
  $("futureTag").textContent = state.date === TODAY ? "从今天起 " + FCST_SPAN + " 天" : "从 " + mdText(state.date) + " 起 " + FCST_SPAN + " 天";
  $("futureBestTag").textContent = "最好的一天：" + mdText(best.date) + " · " + best.score + "%";

  // 柱子点一下就换"出海日"——全局只有一个日期
  $("futureBars").innerHTML = days.map((d) =>
    '<i class="future' + (d.date === best.date ? " active" : "") + '" data-date="' + d.date + '" title="' +
    mdText(d.date) + " · 把握 " + d.score + '%" style="height:' + Math.max(6, d.score) + '%"></i>').join("");
  $("futureBars").querySelectorAll("i").forEach((n) => n.addEventListener("click", () => setDate(n.dataset.date)));

  $("futureDays").innerHTML = days.map((d, i) => {
    const tag = seaTagOf(d.sea);
    const label = d.date === TODAY ? "（今天）" : "（" + (i + 1) + " 天后）";
    return '<div class="row clickable' + (d.date === state.date ? " active" : "") + '" data-date="' + d.date + '"><span class="i">' + (i + 1) + "</span>" +
      '<span class="grow"><b>' + mdText(d.date) + label + " · 把握 " + d.score + "%</b>" +
      "<small>风力 " + d.sea.wind + " 级 · 浪高 " + d.sea.wave + " m · 点一下就把「出海日」设成这天</small></span>" +
      '<span class="tag ' + tag.cls + ' side-tag">' + tag.text + "</span></div>";
  }).join("");
  $("futureDays").querySelectorAll(".clickable").forEach((n) => n.addEventListener("click", () => setDate(n.dataset.date)));

  const d1 = days[0], d3 = days[Math.min(2, days.length - 1)], d7 = days[days.length - 1];
  $("futureList").innerHTML =
    '<div class="row"><span class="i">→</span><span class="grow"><b>1 天后 把握 ' + d1.score + "%</b>（" + mdText(d1.date) + "）" +
    "<small>主要看现在这条锋面还能稳多久</small></span></div>" +
    '<div class="row"><span class="i">→</span><span class="grow"><b>3 天后 把握 ' + d3.score + "%</b>（" + mdText(d3.date) + "）" +
    "<small>再叠加往年这个时段的规律</small></span></div>" +
    '<div class="row"><span class="i">→</span><span class="grow"><b>7 天后 把握 ' + d7.score + "%</b>（" + mdText(d7.date) + "）" +
    "<small>只看趋势，别当作业依据</small></span></div>" +
    '<div class="hint">越往后越不准：这里是按"现在的把握 × 每天衰减"推的，出远海前请看官方海洋预报。</div>';
}

// ==================== L2-往年同期（锚点全部来自顶栏的出海日） ====================
const CLIM_YEARS = [2019, 2020, 2021, 2022, 2023, 2024, 2025];
const CUR_YEAR = 2024;
const CLIM_MONTH = 8;   // 这几年的数据按月对齐，月份取 8 月

function climSeries() {
  const date = state.date;
  const mo = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  if (state.climMode === "day") {
    const vals = CLIM_YEARS.map((y) => clamp(Math.round(50 + (rnd("cd" + y + date) - 0.5) * 70), 5, 95));
    return { vals, active: CLIM_YEARS.indexOf(CUR_YEAR), labels: CLIM_YEARS.map((y) => y + " 年"), what: "年" };
  }
  if (state.climMode === "month") {
    const days = new Date(Date.UTC(CUR_YEAR, mo, 0)).getUTCDate();
    const vals = [];
    for (let i = 1; i <= days; i++) vals.push(clamp(Math.round(45 + (rnd("cm" + mo + i) - 0.5) * 70), 5, 95));
    return { vals, active: day - 1, labels: vals.map((_, i) => i + 1 + " 日"), what: "天" };
  }
  const vals = [];
  for (let i = 1; i <= 12; i++) vals.push(clamp(Math.round(48 + (rnd("cy" + i) - 0.5) * 66), 5, 95));
  return { vals, active: mo - 1, labels: vals.map((_, i) => i + 1 + " 月"), what: "月" };
}

function renderClim() {
  const m = state.climMode;
  const date = state.date;
  document.querySelectorAll("#climPeriod button").forEach((b) => b.classList.toggle("active", b.dataset.period === m));

  const s = climSeries();
  const rate = s.vals[s.active];
  const unitText = m === "day" ? "这一天 · " + mdText(date) : m === "month" ? "这个月 · " + CLIM_MONTH + " 月" : "这一年 · " + CUR_YEAR + " 年";
  $("climHint").textContent = unitText;
  $("climBars").innerHTML = s.vals.map((v, i) =>
    '<i class="' + (i === s.active ? "active" : "") + '" title="' + s.labels[i] + " · " + v + '%" style="height:' + Math.max(4, v) + '%"></i>').join("");

  const others = s.vals.filter((_, i) => i !== s.active);
  const mean = Math.round(others.reduce((a, b) => a + b, 0) / Math.max(1, others.length));
  const diff = rate - mean;
  const anomaly = Math.abs(diff) >= 8 ? (diff > 0 ? "偏高" : "偏低") : "正常";
  const same = m === "day" ? "这 7 年里的其他年份" : m === "month" ? "这个月的其他日子" : "这一年的其他月份";

  const headText = m === "day" ? mdText(date) : m === "month" ? CLIM_MONTH + " 月" : CUR_YEAR + " 年";
  $("climStat").innerHTML = "<b>" + headText + "</b> 有锋面的把握 <b>" + rate +
    "%</b>（" + same + "平均 " + mean + "%）";
  $("climHint").className = "tag " + (anomaly === "正常" ? "ok" : "warm");

  $("climYears").innerHTML =
    '<div class="line"><span class="k">' + same + "平均</span> → <b>" + mean + "%</b></div>" +
    '<div class="line"><span class="k">这次比它</span> → <b>' + (diff > 0 ? "+" : "") + diff + "</b> 个点 · " + anomaly + "</div>" +
    '<div class="line"><span class="k">对你的意义</span> → ' + (anomaly === "偏高" ? "锋面比常年活跃，线索更集中，值得按推荐点位走一趟" :
      anomaly === "偏低" ? "锋面比常年弱，建议跟着眼下的实时锋面走，别只靠往年经验" : "和常年差不多，往年这时候的作业经验可以照用") + "</div>" +
    (s.vals.length <= 12 ? s.vals.map((v, i) =>
      '<div class="line"><span class="k">' + s.labels[i] + "</span> → <b>" + v + "%</b></div>").join("") : "");
}

// ==================== L2-依据（数据从哪来 / 怎么算的 / 还做不到什么） ====================
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
    ["水深 / 岸线", "GEBCO 底图与海陆掩码 <em>待接入</em>"],
    ["渔业数据", "AIS 船位 / 渔获 <em>待接入，另建渔场视图</em>"],
    ["现在看的日期", timeLabel() + " <em>示例数据</em>"],
    ["更新速度", "观测 ≤24 小时 · 预报逐日 <em>示例</em>"],
  ]);
  $("basisRules").innerHTML = listRows([
    ["1", "<b>找鱼范围</b>：以你的定位点为圆心，半径内命中才算数；半径内没有命中时，先给最近的一处，并写明「先给最近的」"],
    ["2", "<b>有锋面的把握</b>：只有一个说法 —— 一段时间里有锋面的天数占多少；不再出现多个可信度标签"],
    ["3", "<b>去这里的把握</b>：起评分 30；半径内每多一条锋面 +12（最多算 3 条）；你在鱼喜欢的那一侧 +15（不对 −5）；水温变化比往年明显 +8（不明显 −8）；范围内有值得去的水域 +15；水温合适 +12（不合适 −6）"],
    ["4", "<b>三档结论</b>：不能出海 → 别出海；能出海且把握 ≥60% → 可以出海；其余 → 谨慎出海（先保安全）"],
    ["5", "<b>开船时间和油</b>：按 8 节航速（14.8 km/h）、1.6 L/km 估，只看量级"],
    ["6", "<b>未来几天</b>：今天的把握 × 每天衰减 6% × 上下 9% 的随机浮动（示例算法，要用真实数据回测校准）"],
  ]);
  $("basisLimits").innerHTML = listRows([
    ["!", "所有数值都是示例数据，还没接入真实的海温、锋面强度、海况"],
    ["!", "海况是模拟的，实船作业请以官方海洋预报为准；本系统不承担航行安全责任"],
    ["!", "「值得去的水域」只是示意，还没用船位或渔获数据验证过"],
    ["!", "三维地球、离线包、手机端不在这一期里（见需求文档）"],
  ]);
}

// ==================== 提示条（只用于确认操作，不播报结论） ====================
let toastTimer;
function showToast(text) {
  $("toastLoc").textContent = text;
  const t = $("toast");
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 1600);
}

// ==================== 统一刷新（state → 全部渲染） ====================
function clampDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  if (iso < DATE_MIN) return DATE_MIN;
  if (iso > DATE_MAX) return DATE_MAX;
  return iso;
}
function setDate(iso) {
  const d = clampDate(iso);
  if (!d) return;
  if (d !== iso) showToast("日期只能选 " + mdText(DATE_MIN) + " ~ " + mdText(DATE_MAX));
  if (d === state.date) return;
  state.date = d;
  refresh();
}

function refresh() {
  invalidate();
  renderLegend();
  drawMap();
  renderHero();
  renderNow();
  renderFuture();
  renderClim();
  renderBasis();
  renderProbe();
  renderPick();
  $("dataStamp").textContent = timeLabel() + " · 示例数据";
  document.querySelectorAll("#rangeSeg button").forEach((b) => b.classList.toggle("active", Number(b.dataset.range) === state.range));
  $("speciesSel").value = state.species;
  $("timeDate").value = state.date;
  $("timeDate").min = DATE_MIN;
  $("timeDate").max = DATE_MAX;
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
  // ③ 找什么鱼
  $("speciesSel").innerHTML = Object.keys(SPECIES).map((k) => '<option value="' + k + '">' + SPECIES[k].label + "</option>").join("");
  $("speciesSel").addEventListener("change", (e) => {
    state.species = e.target.value;
    refresh();
    showToast("目标鱼种：" + SPECIES[state.species].label);
  });

  // ② 找多远
  document.querySelectorAll("#rangeSeg button").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.range = Number(btn.dataset.range);
      state.select = null;
      refresh();
      showToast("找鱼范围：" + state.range + " km");
    });
  });

  // ④ 出海日（全站唯一的时间控件）
  $("timeDate").addEventListener("change", (e) => setDate(e.target.value));
  $("datePrev").addEventListener("click", () => setDate(addDays(state.date, -1)));
  $("dateNext").addEventListener("click", () => setDate(addDays(state.date, 1)));

  // ① 从哪出发
  const doLocate = () => {
    const raw = $("locInput").value.trim();
    const m = raw.match(/(\d+(?:\.\d+)?)\s*°?\s*[eE]?\s*,\s*(\d+(?:\.\d+)?)/);
    if (!m) { showToast("没看懂坐标，示例：124.50°E, 30.20°N"); return; }
    state.lon = parseFloat(m[1]);
    state.lat = parseFloat(m[2]);
    state.select = null;
    state.probe = null;
    refresh();
    showToast("已定位到 " + fmtCoord(state.lon, state.lat));
  };
  $("locateBtn").addEventListener("click", doLocate);
  $("locInput").addEventListener("keydown", (e) => { if (e.key === "Enter") doLocate(); });

  // ===== 地图：鼠标指到哪，就显示哪里的数据 =====
  const map = $("map");
  let pending = null, raf = 0;
  map.addEventListener("mousemove", (e) => {
    const r = map.getBoundingClientRect();
    pending = { x: e.clientX - r.left, y: e.clientY - r.top, cx: e.clientX, cy: e.clientY };
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const p = pending;
      pending = null;
      if (!p || state.probe) return;   // 已经钉住时，鼠标不再抢浮层
      const g = geoOfScreen(p.cx, p.cy);
      hoverPt = { lon: g[0], lat: g[1], x: p.x, y: p.y };
      renderProbe();
    });
  });
  map.addEventListener("mouseleave", () => { hoverPt = null; renderProbe(); });
  map.addEventListener("click", (e) => {
    if (e.target.closest && e.target.closest(".map-legend, .map-controls, .map-pick, .map-probe, .map-empty")) return;
    const g = geoOfScreen(e.clientX, e.clientY);
    const q = xy(g[0], g[1]);
    if (isLandXY(q[0], q[1])) { showToast("这里是陆地，不看海里的数据"); return; }
    const onPinned = state.probe && distKm([state.probe.lon, state.probe.lat], g) < 5;
    hoverPt = null;
    if (onPinned) {
      state.probe = null;
      showToast("已取消钉住");
    } else {
      state.probe = { lon: g[0], lat: g[1] };
      state.select = null;
      showToast("已钉住 " + fmtCoord(g[0], g[1]));
    }
    renderLegend(); drawMap(); syncSelect(); renderPick(); renderProbe();
  });
  $("pickClose").addEventListener("click", () => {
    state.select = null;
    renderLegend(); drawMap(); syncSelect(); renderPick(); renderProbe();
    showToast("已取消选中");
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || (!state.probe && !state.select)) return;
    state.probe = null;
    state.select = null;
    hoverPt = null;
    renderLegend(); drawMap(); syncSelect(); renderPick(); renderProbe();
    showToast("已取消选中");
  });

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
      renderLegend(); drawMap(); syncSelect(); renderPick();
      const meta = LAYER_META.find((m) => m[0] === k) || [k, k];
      showToast("图层「" + meta[1] + "」已" + (state.layers[k] ? "打开" : "关掉"));
    });
  });

  // 页签（主任务 / 支撑；←→ 可切换）
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

  // 往年同期：只看哪一段（日期锚点跟着顶栏走，页内没有第二个日期控件）
  document.querySelectorAll("#climPeriod button").forEach((btn) => {
    btn.addEventListener("click", () => { state.climMode = btn.dataset.period; renderClim(); });
  });
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











