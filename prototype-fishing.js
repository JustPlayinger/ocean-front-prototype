/* 渔场向导 · 交互原型
 *
 * 数据：真实锋面数据（Zenodo 20356239，CC BY 4.0，0.05° 逐日）+ 真实海温（NOAA GHRSST 0.05° 逐日，与锋面不同源）
 *       + 公有领域底图（Natural Earth 1:10m）。
 *       生成脚本：Ocean/backend/scripts/export_prototype_data.py、tools/build-basemap.mjs。
 *       页面只通过 prototype-data.js（window.OFData）取数，不直接读原始文件。
 *
 * 没有真实数据的地方（锋面强度 / 海况 / 预报 / 渔场）一律显式标成「待接入」或「示例」，
 * 不插值、不哈希、不用示例值冒充实测值（需求 FR-7「无数据不编造」）。
 *
 * 信息架构（三层）：
 *   L0 顶栏      ① 从哪出发 ② 找多远 ③ 出海日 —— 全局唯一真源（目标鱼种本期不做，见需求 FR-10）
 *   L1 结论层    hero 常驻：这天值不值得去 + 去哪个锋面对象 + 为什么
 *   L2 页签      现在（观测）/ 未来（预报未接入） ｜ 往年同期 / 依据
 *
 * 数据流：state（唯一真源） --渲染--> DOM；所有 render* 只读 state，不写 state。
 */
"use strict";

// ==================== 常量 ====================
const KM_PER_DEG = 111.195;
const CRUISE_KMH = 14.8;          // 8 节航速
const FUEL_L_PER_KM = 1.6;        // 小型渔船量级，仅用于比较

// 地图投影：东西向与南北向 1 km 一样长，半径圈才是正圆
const ANCHOR = { lon: 124.5, lat: 30.2 };
const PX_LON = 180;
const KM2PX = PX_LON / (KM_PER_DEG * Math.cos((ANCHOR.lat * Math.PI) / 180));
const PX_LAT = KM2PX * KM_PER_DEG;

// 时间范围直接来自数据（有几天就只让选几天）
const AVAILABLE_DATES = OFData.availableDates();
const DEMO_TODAY = "2024-08-05";      // 项目演示用的「今天」（与需求文档、样例数据一致）
const TODAY = AVAILABLE_DATES.indexOf(DEMO_TODAY) >= 0 ? DEMO_TODAY : OFData.firstDate();
const DATE_MIN = OFData.firstDate();
const DATE_MAX = OFData.lastDate();
const DEFAULT_ZOOM = 0.8;              // 默认视野：略微拉远，海岸线/陆地能进画面

// ==================== 状态（唯一真源） ====================
const state = {
  lon: 124.5, lat: 30.2,                   // ① 从哪出发
  range: 20,                               // ② 找多远（km）
  date: TODAY,                             // ③ 出海日（唯一时间控件）
  layers: { sst: true, band: true, front: true, coldwarm: true, nodata: true, fishing: true },
  select: null,                            // 被选中的对象 {type, id}
  probe: null,                             // 钉住的地图点 {lon, lat}
  tab: "now",
  climMode: "day",                         // 往年同期页：day（这一天）
  zoom: DEFAULT_ZOOM,                      // 默认略微拉远，让海岸线/陆地进画面
  view: { cx: 500, cy: 320 },              // 视窗中心（SVG 坐标）：滚轮缩放/拖拽平移用
};

const $ = (id) => document.getElementById(id);
const SELECT_LABEL = { front: "锋面对象", coldwarm: "冷侧 / 暖侧", fishing: "值得去的水域（示例）" };
const SELECT_LAYERS = { front: ["band", "front"], coldwarm: ["coldwarm"], fishing: ["fishing"] };
const LAYER_META = [["sst", "海表温度（真实 · 0.5 °C 分档）"], ["band", "锋面带"], ["front", "锋面线"],
  ["coldwarm", "冷侧 / 暖侧"], ["nodata", "没有观测"], ["fishing", "值得去的水域（示例）"]];
const DIRS16 = ["正北", "东北偏北", "东北", "东北偏东", "正东", "东南偏东", "东南", "东南偏南",
  "正南", "西南偏南", "西南", "西南偏西", "正西", "西北偏西", "西北", "西北偏北"];

// ==================== 小工具 ====================
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function hash(str) {          // 只用于「海况示例」这类明确标注的演示值，不参与真实结论
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function addDays(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function mdText(iso) { const p = iso.split("-"); return Number(p[1]) + " 月 " + Number(p[2]) + " 日"; }
function kmPerLon(lat) { return KM_PER_DEG * Math.cos((lat * Math.PI) / 180); }
function xy(lon, lat) { return [500 + (lon - ANCHOR.lon) * PX_LON, 320 - (lat - ANCHOR.lat) * PX_LAT]; }
function geoOfXY(x, y) { return [ANCHOR.lon + (x - 500) / PX_LON, ANCHOR.lat - (y - 320) / PX_LAT]; }
function fmtCoord(lon, lat) { return lon.toFixed(2) + "°E, " + lat.toFixed(2) + "°N"; }
const fmtHours = (km) => (km / CRUISE_KMH).toFixed(1);
const fmtFuel = (km) => Math.round(km * FUEL_L_PER_KM);

// 点到线段的最短距离（km）与最近的落点
function nearestOnSegment(p, a, b) {
  const kx = kmPerLon(p[1]);
  const ax = a[0] * kx, ay = a[1] * KM_PER_DEG;
  const px = p[0] * kx, py = p[1] * KM_PER_DEG;
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

// ==================== 数据入口（一律走 OFData） ====================
function dataStatus() { return OFData.dateInfo(state.date); }
function timeLabel() {
  const base = mdText(state.date);
  if (!TODAY) return base + " · 观测";
  const n = Math.round((Date.parse(state.date) - Date.parse(TODAY)) / 86400000);
  if (n === 0) return base + "（今天）· 观测";
  const tail = state.date === DATE_MAX ? "（数据里最新的一天）" : "";
  return base + (n > 0 ? "（+" + n + " 天）" : "（" + n + " 天）") + "· 观测" + tail;
}
function dayObjects() { return OFData.objects(state.date); }
function originCell() { return OFData.cellInfo(state.date, state.lon, state.lat); }
function qualityOf() { return OFData.quality(state.date); }

// 地图上要画的线：有编号的锋面对象 + 太短没编号的线段（都是同一天的真实数据）
function frontEntries() {
  const objects = OFData.objects(state.date);
  const lines = OFData.frontLines(state.date);
  const objectLineCount = OFData.objectLineCount(state.date);
  const entries = objects.map((o) => ({
    id: o.id, points: o.points, lengthKm: o.lengthKm, pixelCount: o.pixelCount, isObject: true, key: o.id,
  }));
  lines.slice(objectLineCount).forEach((points, i) =>
    entries.push({ id: null, points, lengthKm: null, pixelCount: null, isObject: false, key: "短段 " + (i + 1) }));
  return entries;
}

function nearestOnEntry(entry, lon, lat) {
  const pts = entry.points;
  let best = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const r = nearestOnSegment([lon, lat], pts[i], pts[i + 1]);
    if (!best || r.km < best.km) best = r;
  }
  if (!best && pts.length === 1) best = { km: distKm([lon, lat], pts[0]), point: pts[0] };
  return best;
}

// 每个锋面对象：离定位点多远、哪个方位（几何和地图上画的是同一条线，不会有第二套说法）
function frontInfo() {
  const origin = [state.lon, state.lat];
  return frontEntries().map((entry) => {
    const near = nearestOnEntry(entry, state.lon, state.lat);
    if (!near) return null;
    return {
      id: entry.id, key: entry.key, isObject: entry.isObject, points: entry.points,
      lengthKm: entry.lengthKm, pixelCount: entry.pixelCount,
      km: near.km, point: near.point, bearing: bearing16(origin, near.point),
      inRange: near.km <= state.range,
    };
  }).filter(Boolean).sort((a, b) => a.km - b.km);
}

// 「值得去的水域」：真实渔场数据还没到，这里是示例占位（见「依据」），不参与把握评分
const DEMO_SPOTS = [
  { id: "S1", lon: 124.62, lat: 30.31, rxKm: 22, ryKm: 16, grade: "高" },
  { id: "S2", lon: 123.90, lat: 29.90, rxKm: 16, ryKm: 12, grade: "中" },
];
function spotInfo() {
  return DEMO_SPOTS.map((s) => {
    const km = distKm([state.lon, state.lat], [s.lon, s.lat]);
    return { id: s.id, lon: s.lon, lat: s.lat, rxKm: s.rxKm, ryKm: s.ryKm, grade: s.grade,
      km, bearing: bearing16([state.lon, state.lat], [s.lon, s.lat]), inRange: km <= state.range, demo: true };
  }).sort((a, b) => a.km - b.km);
}

// 海况：示例数据（没有真实风浪数据源），只在「现在」页展示，不参与结论
function seaState(date) {
  const wind = 3 + (hash("wind" + date) % 4);
  const wave = +(0.6 + (hash("wave" + date) % 10) / 10).toFixed(1);
  const swell = +(0.5 + (hash("swell" + date) % 9) / 10).toFixed(1);
  return { wind, wave, swell, level: wind <= 5 && wave <= 1.5 ? "seaworthy" : wind <= 6 && wave <= 1.8 ? "marginal" : "unsafe" };
}

// ==================== 把握怎么加出来的（每一项都来自真实数据） ====================
function scoreBreakdown(fronts, inRange, cell, quality) {
  const objects = fronts.filter((f) => f.isObject);
  const inRangeObjects = objects.filter((f) => f.inRange);
  const items = [];
  let s = 30;
  items.push(["起评分", 30]);

  const objScore = Math.min(inRangeObjects.length, 3) * 12;
  s += objScore;
  items.push(["范围内锋面对象 " + inRangeObjects.length + " 个", objScore]);

  // 冷暖侧照实展示（数据里的 -20 / 20 编码原样用），但本期没有目标鱼种，侧别不参与评分
  const side = cell ? cell.side : null;

  const nearest = fronts[0] || null;
  const nearScore = !nearest ? 0 : nearest.km <= 10 ? 8 : nearest.km <= 20 ? 4 : 0;
  s += nearScore;
  items.push(["最近锋面 " + (nearest ? nearest.km.toFixed(1) + " km" : "—"), nearScore]);

  const longestInRange = inRangeObjects.reduce((m, f) => Math.max(m, f.lengthKm || 0), 0);
  const lenScore = longestInRange >= 100 ? 8 : longestInRange >= 50 ? 4 : 0;
  s += lenScore;
  items.push(["范围内最长对象 " + (longestInRange ? Math.round(longestInRange) + " km" : "—"), lenScore]);

  const coverage = quality ? 100 - quality.nodata_percent : null;
  const covScore = coverage === null ? 0 : coverage >= 85 ? 4 : coverage >= 70 ? 0 : -4;
  s += covScore;
  items.push(["观测覆盖 " + (coverage === null ? "未知" : coverage.toFixed(1) + "%"), covScore]);

  return { score: clamp(Math.round(s), 5, 95), items, coverage, side, longestInRange };
}

// 三档结论：只说「这一天值不值得去」；海况没有真实数据，就不拿它下结论
function verdictOf(score) {
  if (score >= 70) return { key: "go", text: "值得去", cls: "ok" };
  if (score >= 50) return { key: "some", text: "可以看看", cls: "caution" };
  return { key: "low", text: "线索不足", cls: "stop" };
}

// 一次快照（多个 render 复用；state 一变就作废）
let _snap = null;
function snapshot() {
  if (_snap) return _snap;
  const status = dataStatus();
  const ok = status.ok;
  const fronts = ok ? frontInfo() : [];
  const inRange = fronts.filter((f) => f.inRange);
  const cell = ok ? originCell() : null;
  const quality = ok ? qualityOf() : null;
  const core = ok
    ? scoreBreakdown(fronts, inRange, cell, quality)
    : { score: 0, items: [], coverage: null, side: null, longestInRange: 0 };
  _snap = Object.assign({
    status, ok, fronts, inRange, nearest: fronts[0] || null, cell, quality,
    objects: ok ? dayObjects() : [], spots: ok ? spotInfo() : [],
  }, core);
  return _snap;
}
function invalidate() { _snap = null; }

// ==================== 地图（SVG） ====================
const NS = "http://www.w3.org/2000/svg";
function el(name, attrs, parent) {
  const node = document.createElementNS(NS, name);
  for (const k in attrs) node.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(node);
  return node;
}
// 经纬度折线 → SVG path
function pathOf(pts) { return pts.map((p, i) => (i ? "L " : "M ") + xy(p[0], p[1]).join(",")).join(" "); }
// 显示层平滑（Catmull-Rom → 三次贝塞尔）：只影响画线，数据点、距离、命中判定仍用原始点
function smoothPathOf(pts) {
  if (pts.length < 3) return pathOf(pts);
  const p = pts.map((q) => xy(q[0], q[1]));
  let d = "M" + p[0][0].toFixed(1) + "," + p[0][1].toFixed(1);
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[i - 1] || p[i], p1 = p[i], p2 = p[i + 1], p3 = p[i + 2] || p[i + 1];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += " C" + c1x.toFixed(1) + "," + c1y.toFixed(1) + " " + c2x.toFixed(1) + "," + c2y.toFixed(1) +
      " " + p2[0].toFixed(1) + "," + p2[1].toFixed(1);
  }
  return d;
}
// 多条折线合成一个 path（一个 DOM 节点，几千段也不卡）
function chainsPath(chains) { return chains.map((pts) => pathOf(pts) + " Z").join(" "); }
function chainLinesPath(chains) { return chains.map((pts) => pathOf(pts)).join(" "); }

// 逐行 RLE 还原成矩形（每格一个矩形，合成一个 path；不插值、不放大）
// 相邻行里起止相同的 run 会合并成一个矩形，避免 0.05° 格子拼出"马赛克 + 缝"
function rlePath(runs, grid) {
  const w = grid.dlon * PX_LON;
  const h = grid.dlat * PX_LAT;
  let d = "";
  let open = null;   // { x, row, count, rows }
  const flush = () => {
    if (!open) return;
    const x = 500 + (grid.lon0 + open.col * grid.dlon - ANCHOR.lon) * PX_LON;
    const yTop = 320 - (grid.lat0 + (open.row + open.rows) * grid.dlat - ANCHOR.lat) * PX_LAT;
    d += "M" + x.toFixed(1) + "," + yTop.toFixed(1) + "h" + (open.count * w).toFixed(1) +
      "v" + (open.rows * h).toFixed(1) + "h" + (-open.count * w).toFixed(1) + "z";
    open = null;
  };
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    if (open && run[0] === open.row + open.rows && run[1] === open.col && run[2] === open.count) {
      open.rows += 1;
    } else {
      flush();
      open = { row: run[0], col: run[1], count: run[2], rows: 1 };
    }
  }
  flush();
  return d;
}

function drawProbeMark(svg) {
  if (!state.probe) return;
  const p = xy(state.probe.lon, state.probe.lat);
  el("line", { x1: p[0] - 11, y1: p[1], x2: p[0] + 11, y2: p[1], stroke: "#ffd9a0", "stroke-width": 1.4 }, svg);
  el("line", { x1: p[0], y1: p[1] - 11, x2: p[0], y2: p[1] + 11, stroke: "#ffd9a0", "stroke-width": 1.4 }, svg);
  el("circle", { cx: p[0], cy: p[1], r: 3.2, fill: "#ffd9a0" }, svg);
}

// 底图：真实陆地 / 海岸线 / 等深线（Natural Earth 1:10m，公有领域）
function drawBackground(svg) {
  const base = OFData.basemap;
  el("rect", { x: -400, y: -400, width: 1800, height: 1440, fill: "#0d2135", "data-layer": "ocean" }, svg);
  if (!base) return;
  el("path", { d: chainLinesPath(base.layers.isobath200.chains), fill: "none",
    stroke: "rgba(120,190,215,0.42)", "stroke-width": 1, "stroke-dasharray": "7 5" }, svg);
  el("path", { d: chainLinesPath(base.layers.isobath1000.chains), fill: "none",
    stroke: "rgba(90,150,205,0.34)", "stroke-width": 1, "stroke-dasharray": "3 6" }, svg);
}

// 当前视窗（SVG 坐标），缩放后也能把经纬网标到可见边上
function currentView() {
  const raw = ($("mapSvg").getAttribute("viewBox") || "0 0 1000 640").trim().split(/\s+/).map(Number);
  return { x: raw[0], y: raw[1], w: raw[2] || 1000, h: raw[3] || 640 };
}

// 真实经纬网：按整数度画线并标度数（原来是无标签的等分格网，看不出这是哪儿）
function drawGraticule(host) {
  const g = host;
  const box = currentView();
  const lonMin = geoOfXY(box.x, 0)[0], lonMax = geoOfXY(box.x + box.w, 0)[0];
  const latMax = geoOfXY(0, box.y)[1], latMin = geoOfXY(0, box.y + box.h)[1];
  const tag = (text, x, y) => {
    const t = el("text", { x, y, fill: "rgba(186,214,235,0.6)", "font-size": 10.5,
      "paint-order": "stroke", stroke: "rgba(6,14,24,0.85)", "stroke-width": 3 }, g);
    t.textContent = text;
  };
  for (let lon = Math.ceil(lonMin); lon <= Math.floor(lonMax); lon++) {
    const x = xy(lon, 0)[0];
    el("line", { x1: x, y1: box.y, x2: x, y2: box.y + box.h, stroke: "rgba(150,200,230,0.10)" }, g);
    if (lon % 2 === 0) tag(lon + "°E", x + 3, box.y + 12);
  }
  for (let lat = Math.ceil(latMin); lat <= Math.floor(latMax); lat++) {
    const y = xy(0, lat)[1];
    el("line", { x1: box.x, y1: y, x2: box.x + box.w, y2: y, stroke: "rgba(150,200,230,0.10)" }, g);
    if (lat % 2 === 0) tag(lat + "°N", box.x + 4, y - 3);
  }
}

// 海温色带：按数据里的 0.5 °C 档位取色（不插值，只是给档位配颜色）
const SST_RAMP = [[16, "#2b3f8f"], [20, "#2f7fc1"], [23, "#37b3b8"], [25, "#7ecb6a"],
  [27, "#e8d75a"], [29, "#f0a341"], [31, "#e2694a"], [33, "#b52f3f"]];
function mixHex(a, b, t) {
  const pa = [1, 3, 5].map((i) => parseInt(a.substr(i, 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.substr(i, 2), 16));
  return "rgb(" + pa.map((v, i) => Math.round(v + (pb[i] - v) * t)).join(",") + ")";
}
function sstColor(c) {
  if (c <= SST_RAMP[0][0]) return SST_RAMP[0][1];
  for (let i = 1; i < SST_RAMP.length; i++) {
    if (c <= SST_RAMP[i][0]) {
      const t = (c - SST_RAMP[i - 1][0]) / (SST_RAMP[i][0] - SST_RAMP[i - 1][0]);
      return mixHex(SST_RAMP[i - 1][1], SST_RAMP[i][1], t);
    }
  }
  return SST_RAMP[SST_RAMP.length - 1][1];
}

// 真实海表温度场（NOAA GHRSST）：按档位分组后画，档位内相邻行会合并，看起来是连续温度场
function drawSst(svg, iso) {
  if (!state.layers.sst) return;
  const day = OFData.sst(iso);
  if (!day) return;
  const binC = day.bin_c;
  const byBin = new Map();
  (day.runs || []).forEach((run) => {
    if (!byBin.has(run[3])) byBin.set(run[3], []);
    byBin.get(run[3]).push(run);
  });
  byBin.forEach((runs, bin) => {
    el("path", { d: rlePath(runs, day.grid), "data-layer": "sst", fill: sstColor(bin * binC),
      stroke: "none", "shape-rendering": "crispEdges",
      opacity: 0.52 * (state.select && state.select.type !== "sst" ? 0.35 : 1) }, svg);
  });
}

// 陆地画在数据层之上：海上的"没有观测"用斜线纹理，陆地是实色块 + 亮海岸线
// （数据里的 -128 同时包含陆地与云；陆地填充要明显浅于海面，否则等于看不见）
function drawLand(svg) {
  const base = OFData.basemap;
  if (!base) return;
  el("path", { d: chainsPath(base.layers.land.chains), "data-layer": "land",
    fill: "#3a5068", stroke: "none" }, svg);
  el("path", { d: chainLinesPath(base.layers.coastline.chains), "data-layer": "coast",
    fill: "none", stroke: "rgba(196,229,252,0.9)", "stroke-width": 1.4 }, svg);
}

// 海上没有观测的像元（云 / 未观测；数据里 -128 与陆地共用编码）
function drawNodata(svg, iso, grid) {
  const day = OFData.day(iso);
  if (!day || !state.layers.nodata) return;
  el("path", { d: rlePath(day.nodata_rle || [], grid), "data-layer": "nodata",
    fill: "url(#nodataHatch)", stroke: "none", "shape-rendering": "crispEdges", opacity: 0.5 }, svg);
}


// 数据图层：一切按数据原样画，不做外推（锋面线只在显示层平滑，几何与距离仍用原始点）
function drawDataLayers(svg, snap, iso, grid, sel) {
  const dim = (k) => (sel && sel.type !== k ? 0.16 : 1);
  const entries = frontEntries();
  const selected = sel && sel.type === "front" && sel.id ? entries.find((e) => e.id === sel.id) : null;

  // 冷侧 / 暖侧：数据里的 -20 / 20 编码，一格不改
  if (state.layers.coldwarm) {
    const on = !!sel && sel.type === "coldwarm";
    el("path", { d: rlePath(OFData.bandRuns(iso, "cold"), grid), "data-layer": "cold",
      fill: "rgba(38,104,178,0.42)", stroke: "none", "shape-rendering": "crispEdges",
      opacity: dim("coldwarm") }, svg);
    el("path", { d: rlePath(OFData.bandRuns(iso, "warm"), grid), "data-layer": "warm",
      fill: "rgba(198,88,58,0.40)", stroke: "none", "shape-rendering": "crispEdges",
      opacity: dim("coldwarm") }, svg);
    if (on) {
      el("path", { d: rlePath(OFData.bandRuns(iso, "cold"), grid), fill: "none",
        stroke: "#5cb4ff", "stroke-width": 1.6 }, svg);
      el("path", { d: rlePath(OFData.bandRuns(iso, "warm"), grid), fill: "none",
        stroke: "#ffab5c", "stroke-width": 1.6 }, svg);
    }
  }

  // 锋面带：数据里的 -10 / 10 / 30 像元原样画；编码含义有歧义，图上不解释
  if (state.layers.band) {
    el("path", { d: rlePath(OFData.bandRuns(iso, "front"), grid), "data-layer": "band",
      fill: "rgba(255,236,170,0.5)", stroke: "none", "shape-rendering": "crispEdges",
      opacity: 0.9 * dim("front") }, svg);
  }

  // 锋面线：对象中心线 + 未编号短段
  if (state.layers.front) {
    entries.forEach((entry) => {
      const isSel = !!(selected && entry.isObject && entry.id === selected.id);
      const stroke = isSel ? "#4dd4c6" : entry.isObject ? "#ffffff" : "rgba(255,255,255,0.55)";
      const width = isSel ? 3.4 : entry.isObject ? 2.3 : 1.3;
      const d = smoothPathOf(entry.points);
      el("path", { d, fill: "none", stroke: "rgba(6,14,24,0.6)", "stroke-width": width + 2.4,
        opacity: (entry.isObject ? 0.85 : 0.55) * dim("front"), "stroke-linecap": "round" }, svg);
      if (isSel) {
        el("path", { d, fill: "none", stroke: "#4dd4c6", "stroke-width": 9,
          opacity: 0.28, "stroke-linecap": "round" }, svg);
      }
      el("path", { d, "data-layer": "front-line", fill: "none", stroke, "stroke-width": width,
        opacity: (entry.isObject ? 0.95 : 0.7) * dim("front"), "stroke-linecap": "round" }, svg);
    });
    // 编号只给对象；放不下就跳过，不再互相压字
    const placed = [];
    entries.filter((e) => e.isObject).forEach((entry) => {
      const mid = entry.points[Math.floor(entry.points.length / 2)];
      const p = xy(mid[0], mid[1]);
      const isSel = !!(selected && entry.id === selected.id);
      const text = entry.id + " · " + Math.round(entry.lengthKm) + " km";
      const box = { x: p[0] + 5, y: p[1] - 20, w: text.length * 6.4, h: 14 };
      const clash = placed.some((q) => !(box.x + box.w < q.x || q.x + q.w < box.x ||
        box.y + box.h < q.y || q.y + q.h < box.y));
      if (clash && !isSel) return;
      if (!clash) placed.push(box);
      el("text", { x: p[0] + 6, y: p[1] - 8, "data-layer": "front-label",
        fill: isSel ? "#8ff2e4" : "rgba(255,255,255,0.78)", "font-size": 10.5,
        "paint-order": "stroke", stroke: "rgba(8,16,26,0.9)", "stroke-width": 3,
        opacity: isSel ? 1 : dim("front") }, svg).textContent = text;
    });
  }

  // 值得去的水域（示例，未接入真实渔场数据）
  if (state.layers.fishing) {
    (snap.spots || []).forEach((s) => {
      const p = xy(s.lon, s.lat);
      const rx = s.rxKm * KM2PX, ry = s.ryKm * KM2PX;
      const isSel = !!sel && sel.type === "fishing" && (!sel.id || sel.id === s.id);
      el("ellipse", { cx: p[0], cy: p[1], rx, ry, fill: "rgba(255,180,84,0.20)",
        stroke: "rgba(255,200,120,0.45)", "stroke-dasharray": "4 3", opacity: dim("fishing") }, svg);
      el("text", { x: p[0] - rx, y: p[1] - ry - 5, fill: "#ffc46b", "font-size": 11,
        "paint-order": "stroke", stroke: "rgba(8,16,26,0.9)", "stroke-width": 3,
        opacity: 0.45 + 0.55 * dim("fishing") }, svg).textContent = "值得去的水域 " + s.id + "（示例）";
      if (isSel) {
        const q = xy(state.lon, state.lat);
        el("line", { x1: q[0], y1: q[1], x2: p[0], y2: p[1], stroke: "#ffb454", "stroke-width": 1.2,
          "stroke-dasharray": "5 4", opacity: 0.8 }, svg);
      }
    });
  }
}

// 定位点与找鱼范围（没数据时也保留，作为参照）
function drawOriginLayer(svg) {
  const q = xy(state.lon, state.lat);
  [10, 20, 30].forEach((km) => {
    const r = km * KM2PX;
    const isRange = km === state.range;
    el("circle", { cx: q[0], cy: q[1], r, fill: isRange ? "rgba(77,212,198,0.05)" : "none",
      stroke: isRange ? "rgba(77,212,198,0.55)" : "rgba(140,225,212,0.26)", "stroke-width": isRange ? 1.2 : 1,
      "stroke-dasharray": isRange ? "5 4" : "3 5" }, svg);
    el("text", { x: q[0], y: q[1] - r - 4, "text-anchor": "middle",
      fill: isRange ? "rgba(165,242,230,0.9)" : "rgba(140,225,212,0.4)",
      "font-size": isRange ? 10 : 8.5 }, svg).textContent = km + " km";
  });
  el("circle", { cx: q[0], cy: q[1], r: 8, fill: "none", stroke: "#4dd4c6", "stroke-width": 2, class: "pulse" }, svg);
  el("circle", { cx: q[0], cy: q[1], r: 5, fill: "#fff" }, svg);
  el("text", { x: q[0] + 14, y: q[1] - 12, fill: "#fff", "font-size": 13, "font-weight": "bold",
    "paint-order": "stroke", stroke: "rgba(8,16,26,0.85)", "stroke-width": 3 }, svg)
    .textContent = fmtCoord(state.lon, state.lat);
  el("text", { x: 956, y: 40, fill: "rgba(200,225,240,0.6)", "font-size": 13 }, svg).textContent = "N ↑";
}

function drawMap() {
  const svg = $("mapSvg");
  svg.innerHTML = "";
  const defs = el("defs", {}, svg);
  const snap = snapshot();
  const ok = snap.ok;
  const iso = state.date;
  const grid = ok ? OFData.grid(iso) : null;

  // 没数据就盖一层说明，不让地图假装有东西
  $("mapEmpty").hidden = ok;
  if (!ok) {
    $("mapEmptyTitle").textContent = snap.status.title;
    $("mapEmptyDesc").textContent = snap.status.desc + "（现在选的是 " + timeLabel() + "）";
  }

  // 缺测（-128）的斜线纹理：陆地与云在数据里同码，靠底图把两者分开画
  const hatch = el("pattern", { id: "nodataHatch", width: 6, height: 6,
    patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" }, defs);
  el("rect", { width: 6, height: 6, fill: "rgba(150,166,182,0.30)" }, hatch);
  el("line", { x1: 0, y1: 0, x2: 0, y2: 6, stroke: "rgba(206,222,238,0.5)", "stroke-width": 1.6 }, hatch);

  drawBackground(svg);
  const gratHost = el("g", { id: "gratHost" }, svg);
  drawGraticule(gratHost);
  if (ok) {
    drawSst(svg, iso);
    drawNodata(svg, iso, grid);
    drawDataLayers(svg, snap, iso, grid, state.select);
  }
  drawLand(svg);                       // 陆地压在数据层之上：海上缺测用纹理，陆地保持实色
  drawOriginLayer(svg);
  drawProbeMark(svg);
  el("style", {}, defs).textContent =
    "@keyframes pulseAnim{0%{r:8;opacity:.9}100%{r:32;opacity:0}}.pulse{animation:pulseAnim 1.6s ease-out infinite}";
  updateScaleBar();
}

// ==================== 鼠标放到地图上：看那个点的数据 ====================
let hoverPt = null;   // {lon, lat, x, y}，x/y 是相对地图的像素

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

// 某个点的真实像元：缺测（陆地/云/未观测）还是锋面线、冷侧、暖侧
function cellAt(lon, lat) { return OFData.cellInfo(state.date, lon, lat); }

// 从任意点看最近的锋面（对象或短段），几何与地图同源
function nearestFrontFrom(lon, lat) {
  let best = null;
  frontEntries().forEach((entry) => {
    const near = nearestOnEntry(entry, lon, lat);
    if (!near) return;
    if (!best || near.km < best.km) {
      best = { id: entry.id, isObject: entry.isObject, lengthKm: entry.lengthKm, km: near.km, point: near.point };
    }
  });
  if (best) best.bearing = bearing16([lon, lat], best.point);
  return best;
}

// ==================== 指针查询：鼠标指到哪，就显示那里的真实数据 ====================
function frontTitle(entry) {
  return entry.id ? "锋面对象 " + entry.id : "未编号短段";
}

function probeHTML(lon, lat) {
  const head = '<div class="mp-coord">' + fmtCoord(lon, lat) + "</div>";
  const foot = '<div class="mp-foot">' + timeLabel() + " · 锋面 Zenodo / 海温 NOAA<br/>点一下钉住，Esc 取消</div>";
  const st = dataStatus();
  if (!st.ok) return head + '<div class="mp-note">' + st.title + "，这个时段没有数据，不估数</div>" + foot;

  const cell = cellAt(lon, lat);
  const bbox = OFData.attribution() ? OFData.attribution().region.bbox : null;
  if (!cell || !cell.inGrid) {
    return head + '<div class="mp-note">这里在导出范围之外' +
      (bbox ? "（只导出了 " + bbox[0] + "~" + bbox[2] + "°E，" + bbox[1] + "~" + bbox[3] + "°N）" : "") + "</div>" + foot;
  }
  if (cell.nodata) {
    return head + '<div class="mp-note">这里没有观测数据（陆地、云或未观测，数据里统一用 -128 表示）</div>' + foot;
  }

  const quality = qualityOf();
  const shortMin = quality ? quality.object_min_length_km : 20;
  let h = head;
  const kind = cell.line ? "锋面线（编码 " + cell.code + "）" : cell.side ? cell.side : "无锋面";
  h += '<div class="mp-row"><span class="mp-k">数据里这一类</span><span class="mp-v">' + kind + "</span></div>";
  h += '<div class="mp-note">' + (cell.line
    ? "编码 " + cell.code + "，数据集自带的锋面线编码"
    : cell.side ? "冷暖侧来自数据里的 −20 / 20 编码"
      : "有观测，但没有锋面线，也不在冷暖侧") + "</div>";

  const km = distKm([state.lon, state.lat], [lon, lat]);
  const bearing = bearing16([state.lon, state.lat], [lon, lat]);
  h += '<div class="mp-row"><span class="mp-k">离你</span><span class="mp-v">' + km.toFixed(1) + " km · " + bearing + "</span></div>";
  h += '<div class="mp-note' + (km > state.range ? " mp-warn" : "") + '">' +
    (km <= state.range ? "在 " + state.range + " km 范围内" : "超出 " + state.range + " km 范围") + "</div>";

  const nf = nearestFrontFrom(lon, lat);
  if (nf) {
    h += '<div class="mp-row"><span class="mp-k">最近的锋面</span><span class="mp-v">' + nf.km.toFixed(1) + " km · " + nf.bearing + "</span></div>";
    h += '<div class="mp-note">' + (nf.isObject
      ? "锋面对象 " + nf.id + " · 长 " + Math.round(nf.lengthKm) + " km"
      : "未编号短段（< " + shortMin + " km）") + "</div>";
  }

  h += '<div class="mp-row"><span class="mp-k">你所在的侧别</span><span class="mp-v">' + (cell.side || "锋区外") + "</span></div>";
  // 海表温度：有真实数据就给数值（NOAA GHRSST，与锋面不同源），没有就直说
  const sstHere = OFData.sstCell(state.date, lon, lat);
  if (sstHere && sstHere.valueC !== null) {
    h += '<div class="mp-row"><span class="mp-k">海表温度</span><span class="mp-v">' +
      sstHere.valueC.toFixed(1) + " °C</span></div>";
    h += '<div class="mp-note">NOAA GHRSST · 0.5 °C 分档，与锋面不是同一产品</div>';
  } else if (sstHere && sstHere.inGrid) {
    h += '<div class="mp-row"><span class="mp-k">海表温度</span><span class="mp-v">这一格没有海温</span></div>';
    h += '<div class="mp-note">该格不是有效海温（陆地 / 冰 / 缺测）</div>';
  } else {
    h += '<div class="mp-row"><span class="mp-k">海表温度</span><span class="mp-v">这一天没导出</span></div>';
    h += '<div class="mp-note">海温只导出了部分日期</div>';
  }
  const spot = nearestSpotFrom(lon, lat);
  if (spot) {
    h += '<div class="mp-row"><span class="mp-k">值得去的水域</span><span class="mp-v">' +
      (spot.inside ? "就在 " + spot.id + " 里" : "距 " + spot.id + " " + spot.km.toFixed(1) + " km") + "</span></div>";
    h += '<div class="mp-note">示例占位，没有真实渔场数据</div>';
  }
  return h + foot;
}

function nearestSpotFrom(lon, lat) {
  const list = DEMO_SPOTS.map((s) => {
    const dx = (lon - s.lon) * kmPerLon(s.lat);
    const dy = (lat - s.lat) * KM_PER_DEG;
    return { id: s.id, grade: s.grade, km: Math.hypot(dx, dy),
      bearing: bearing16([lon, lat], [s.lon, s.lat]),
      inside: (dx * dx) / (s.rxKm * s.rxKm) + (dy * dy) / (s.ryKm * s.ryKm) <= 1 };
  }).sort((a, b) => a.km - b.km);
  return list.find((s) => s.inside) || list[0] || null;
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
    const f = (snap.fronts || []).find((x) => x.isObject && x.id === s.id);
    if (!f) return null;
    return { name: "锋面对象 " + f.id,
      body: "长 <b>" + Math.round(f.lengthKm) + " km</b>（" + f.pixelCount + " 个像元）· 离你 <b>" + f.km.toFixed(1) +
        " km</b> · " + f.bearing + "<br/>" + (f.inRange ? "在你的找鱼范围内" : "超出你的找鱼范围") +
        " · 你在" + (snap.cell && snap.cell.side ? snap.cell.side : "锋区外") };
  }
  if (s.type === "fishing") {
    const p = (snap.spots || []).find((x) => x.id === s.id);
    if (!p) return null;
    return { name: "值得去的水域 " + p.id + "（示例）",
      body: "离你 <b>" + p.km.toFixed(1) + " km</b> · " + p.bearing + " · 大小约 " + (p.rxKm * 2) + " × " + (p.ryKm * 2) +
        " km<br/>这一层是示例占位，还没有真实渔场数据" };
  }
  return { name: "冷侧 / 暖侧",
    body: "蓝色是冷侧、橙色是暖侧，直接来自数据里的 -20 / 20 编码；锋面线就在两者中间" };
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
    (SELECT_LAYERS[type] || []).forEach((k) => { state.layers[k] = true; });
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
  const objectsInRange = snap.inRange.filter((f) => f.isObject);
  if (objectsInRange.length) {
    const f = objectsInRange[0];
    return { type: "front", id: f.id, label: "锋面对象 " + f.id, km: f.km, bearing: f.bearing, fallback: false };
  }
  const anyObject = snap.fronts.find((f) => f.isObject);
  if (anyObject) {
    return { type: "front", id: anyObject.id, label: "锋面对象 " + anyObject.id, km: anyObject.km,
      bearing: anyObject.bearing, fallback: true, note: "范围里没有编号对象，先给最近的一个" };
  }
  const anyLine = snap.fronts[0];
  if (anyLine) {
    return { type: null, id: null, label: "未编号短段", km: anyLine.km, bearing: anyLine.bearing, fallback: true,
      note: "只找到不足 " + (snap.quality ? snap.quality.object_min_length_km : 20) + " km 的短段" };
  }
  return null;
}

function renderHero() {
  const snap = snapshot();
  const v = $("heroVerdict"), l = $("heroLine"), pts = $("heroPoints"), body = $("heroWhyBody");
  $("heroWhen").textContent = timeLabel();

  if (!snap.ok) {
    v.textContent = "先看数据";
    v.className = "verdict caution";
    l.innerHTML = "<b>" + snap.status.title + "</b> — " + snap.status.desc;
    pts.innerHTML = "";
    body.innerHTML = '<div class="line"><span class="k">现在选的日期</span> → ' + timeLabel() + "</div>" +
      '<div class="line"><span class="k">说明</span> → 没数据就不给把握、不给建议，免得编数</div>';
    syncSelect(); renderPick();
    return;
  }

  const verdict = verdictOf(snap.score);
  v.textContent = verdict.text;
  v.className = "verdict " + verdict.cls;

  const t = heroTarget();
  let line = state.range + " km 内 · 把握 <b>" + snap.score + "%</b>。";
  if (t) line += "首选 <b>" + t.bearing + " " + t.km.toFixed(1) + " km</b> 的" + t.label +
    "（约 " + fmtHours(t.km) + " 小时）。";
  else line += "范围内没有线索，可以放大范围或换一天。";
  l.innerHTML = line;

  const picks = [];
  if (t) {
    picks.push({ rank: 1, type: t.type, id: t.id, label: t.label, km: t.km, bearing: t.bearing,
      note: t.fallback ? (t.note || "范围里没有，先给最近的") : "范围里最值得去的" });
  }
  snap.inRange.filter((f) => f.isObject && (!t || f.id !== t.id)).slice(0, 2).forEach((f) => {
    picks.push({ rank: picks.length + 1, type: "front", id: f.id, label: "锋面对象 " + f.id,
      km: f.km, bearing: f.bearing, note: "备选 · 长 " + Math.round(f.lengthKm) + " km" });
  });
  pts.innerHTML = picks.map((p) =>
    '<div class="pt"' + (p.type ? ' data-type="' + p.type + '" data-id="' + (p.id || "") + '"' : "") +
    '><span class="rk">' + p.rank + "</span>" +
    '<span class="grow"><b>' + p.bearing + " " + p.km.toFixed(1) + " km</b> · " + p.label +
    "<small>" + p.note + " · 约 " + fmtHours(p.km) + " 小时 · 油 " + fmtFuel(p.km) +
    " L</small></span></div>").join("");
  pts.querySelectorAll(".pt[data-type]").forEach((node) =>
    node.addEventListener("click", () => toggleSelect(node.dataset.type, node.dataset.id)));

  body.innerHTML =
    snap.items.map((it) => '<div class="line"><span class="k">' + it[0] + "</span> → <b>" +
      (it[1] > 0 ? "+" : "") + it[1] + "</b></div>").join("") +
    '<div class="line"><span class="k">合计把握</span> → <b>' + snap.score + "%</b></div>" +
    '<div class="line"><span class="k">数据来源</span> → 锋面 Zenodo 20356239 · 海温 NOAA GHRSST</div>' +
    '<div class="line"><span class="k">没算进去的</span> → 海温、强度、海况、预报、渔场都不打分</div>' +
    '<div class="line"><span class="k">三档</span> → ≥70% 值得去 · 50–69% 可以看看 · <50% 线索不足</div>';
  syncSelect();
  renderPick();
}

// ==================== L2-现在（真实观测数据） ====================
function metricCell(label, value, unit, type, id) {
  return "<div class=\"m\"" + (type ? ' data-type="' + type + '" data-id="' + (id || "") + '" style="cursor:pointer"' : "") + ">" +
    '<div class="k">' + label + '</div><div class="v">' + value + "<small>" + (unit || "") + "</small></div></div>";
}

function renderNow() {
  const snap = snapshot();
  const st = snap.status;
  $("nowScopeTag").textContent = state.range + " km 内";

  if (!st.ok) {
    $("nowMetrics").innerHTML = "";
    $("seaTag").textContent = "没数据"; $("seaTag").className = "tag warn";
    $("seaList").innerHTML = "";
    $("nowFronts").innerHTML = "";
    $("nowFrontTag").textContent = "没数据";
    const e0 = $("nowEmpty");
    e0.hidden = false;
    e0.innerHTML = "<b>" + st.title + "</b><br/>" + st.desc;
    return;
  }

  const objects = snap.objects;
  const coverage = snap.coverage;
  const nearest = snap.nearest;
  const anchorSst = OFData.sstCell(state.date, state.lon, state.lat);
  $("nowScopeTag").textContent = state.range + " km 内" +
    (coverage === null ? "" : " · 观测覆盖 " + coverage.toFixed(1) + "%") +
    (anchorSst && anchorSst.valueC !== null ? " · 定位点海温 " + anchorSst.valueC.toFixed(1) + " °C" : "");
  $("nowMetrics").innerHTML =
    metricCell("锋面对象", String(objects.length), "条") +
    metricCell("最近锋面", nearest ? nearest.km.toFixed(1) : "—", "km", "front",
      nearest && nearest.isObject ? nearest.id : "") +
    metricCell("你落在", snap.side || "锋区外", "", "coldwarm") +
    metricCell("把握", String(snap.score), "%");

  // 海况：示例数据，不参与结论
  const sea = seaState(state.date);
  $("seaTag").textContent = "示例数据 · 不参与结论";
  $("seaTag").className = "tag warn";
  $("seaList").innerHTML =
    '<div class="row"><span class="i">≈</span><span class="grow"><b>风力 ' + sea.wind + " 级 · 浪 " + sea.wave +
    " m · 涌 " + sea.swell + ' m</b><small>示例值，没有风浪数据源</small></span></div>' +
    '<div class="row"><span class="i">!</span><span class="grow"><b>出海安全以官方海洋预报为准</b>' +
    "<small>本期结论不含海况判断</small></span></div>";

  const objectLines = snap.fronts.filter((f) => f.isObject);
  const inRangeObjects = objectLines.filter((f) => f.inRange);
  const shortCount = snap.fronts.length - objectLines.length;
  $("nowFrontTag").textContent = "编号 " + objectLines.length + " · 范围内 " + inRangeObjects.length +
    (shortCount ? " · 短段 " + shortCount : "");
  $("nowFronts").innerHTML = objectLines.map((f) =>
    '<div class="row clickable" data-type="front" data-id="' + f.id + '"><span class="i">' + (f.inRange ? "✓" : "·") + "</span>" +
    '<span class="grow"><b>' + f.id + " · 长 " + Math.round(f.lengthKm) + " km</b> " + f.bearing + " " + f.km.toFixed(1) + " km" +
    "<small>" + (f.inRange ? "范围内" : "范围外") + " · " + f.pixelCount + " 像元 · 点一下高亮</small></span>" +
    '<span class="tag ' + (f.inRange ? "ok" : "plain") + ' side-tag">' + (f.inRange ? "范围内" : "范围外") + "</span></div>"
  ).join("");
  $("nowFronts").querySelectorAll(".clickable").forEach((node) =>
    node.addEventListener("click", () => toggleSelect(node.dataset.type, node.dataset.id)));

  const e = $("nowEmpty");
  if (!inRangeObjects.length) {
    e.hidden = false;
    e.innerHTML = "<b>" + state.range + " km 内没有编号的锋面对象</b><br/>" +
      (nearest ? "最近的参考：" + (nearest.isObject ? nearest.id : "未编号短段") +
        "（" + nearest.bearing + " " + nearest.km.toFixed(1) + " km）" : "这天没找到锋面线") +
      "；可以放大范围或换一天。";
  } else {
    e.hidden = true;
  }
  $("nowMetrics").querySelectorAll(".m[data-type]").forEach((node) =>
    node.addEventListener("click", () => {
      if (node.dataset.type === "front" && !node.dataset.id) return;
      toggleSelect(node.dataset.type, node.dataset.id);
    }));
  syncSelect();
}

// ==================== L2-未来（预报还没接入，说清楚为什么） ====================
function renderFuture() {
  $("futureTag").textContent = "预报未接入";
  $("futureBestTag").textContent = "—";
  $("futureBars").innerHTML = "";
  $("futureList").innerHTML =
    '<div class="row"><span class="i">1</span><span class="grow"><b>没有可用的锋面预报数据</b>' +
    "<small>手上是 1982—2024 的观测回算，回答「那天实际什么样」，不是「明天会怎样」</small></span></div>" +
    '<div class="row"><span class="i">2</span><span class="grow"><b>所以这里不给未来把握</b>' +
    "<small>以前按「每天衰减 6%」推过数字，那是编的，已经撤掉</small></span></div>" +
    '<div class="row"><span class="i">3</span><span class="grow"><b>要接预报，先补两样</b>' +
    "<small>更多日期的样本（做持续性基线）和预报输入场（海温 / 流场）</small></span></div>";
  // 已导出的观测日期：默认给「当前出海日之后」的 14 天，其余用汇总行说明（62 天一股脑列出来没法看）
  const upcoming = AVAILABLE_DATES.filter((d) => d > state.date);
  const shown = upcoming.slice(0, 14);
  const rest = upcoming.length - shown.length;
  const last = AVAILABLE_DATES[AVAILABLE_DATES.length - 1];
  $("futureDays").innerHTML =
    '<div class="row"><span class="i">·</span><span class="grow"><b>已导出观测日期共 ' + AVAILABLE_DATES.length +
    " 天（" + AVAILABLE_DATES[0] + " ~ " + last + "）</b><small>当前出海日之后还有 " + upcoming.length +
    " 天；点某天即把「出海日」设成那天</small></span></div>" +
    shown.map((d) =>
      '<div class="row clickable" data-date="' + d + '"><span class="i">·</span><span class="grow"><b>' + mdText(d) +
      "</b><small>已导出的观测日期 · 点一下把「出海日」设成这天</small></span></div>").join("") +
    (rest > 0 ? '<div class="row"><span class="i">…</span><span class="grow"><b>后面还有 ' + rest +
      " 天</b><small>用顶栏「出海日」的 ◀ ▶ 一天天走，或直接改日期</small></span></div>" : "");
  $("futureDays").querySelectorAll(".clickable").forEach((node) =>
    node.addEventListener("click", () => setDate(node.dataset.date)));
}

// ==================== L2-往年同期（真实多年度统计，口径见需求 §5.2） ====================
function climBarsHTML(labels, heights, actives, titles) {
  return labels.map((label, i) =>
    '<i class="' + (actives[i] ? "active" : "") + '" title="' + titles[i] + '" style="height:' +
    Math.max(5, Math.round(heights[i])) + '%"></i>').join("");
}

function renderClim() {
  const mode = state.climMode;
  document.querySelectorAll("#climPeriod button").forEach((b) => b.classList.toggle("active", b.dataset.period === mode));
  const bars = $("climBars"), stat = $("climStat"), years = $("climYears"), hint = $("climHint");
  const clim = OFData.clim;

  if (!clim) {
    hint.textContent = "统计未导出"; hint.className = "tag warn";
    bars.innerHTML = ""; years.innerHTML = "";
    stat.innerHTML = "<b>统计还没生成</b><br/>跑一次 <code>export_prototype_data.py --mode clim</code>。";
    return;
  }

  if (mode === "month") {
    hint.textContent = "样本不足"; hint.className = "tag warn";
    bars.innerHTML = ""; years.innerHTML = "";
    stat.innerHTML = "<b>整月算不了</b><br/>样本只有每年 8 月 5—7 日，算不出「整月」；按月补日期后才有。";
    return;
  }

  const key = String(state.range);
  const yearRows = Object.keys(clim.by_year).sort();
  const widestKey = Object.keys(clim.by_day[Object.keys(clim.by_day)[0]].by_range)
    .map(Number).sort((a, b) => b - a)[0];

  if (mode === "period") {
    const wideKey = String(widestKey);
    const probs = yearRows.map((y) => {
      const bucket = clim.by_year[y].by_range[wideKey] || clim.by_year[y].by_range[key];
      return bucket ? bucket.probability || 0 : 0;
    });
    const labels = yearRows.map((y) => y + " 年");
    bars.innerHTML = climBarsHTML(labels, probs.map((p) => p * 100), yearRows.map(() => false),
      yearRows.map((y, i) => y + " 年 · " + widestKey + " km 内 " + Math.round(probs[i] * 100) + "% 的日子有锋面"));
    stat.innerHTML = "<b>这几天</b> · " + widestKey + " km 内出现锋面的天数占比：" +
      yearRows.map((y, i) => y + " " + Math.round(probs[i] * 100) + "%").join(" · ");
    hint.textContent = widestKey + " km 内 · 每月取样"; hint.className = "tag";
    years.innerHTML =
      '<div class="line"><span class="k">为什么看 ' + widestKey + " km</span> → 锋面在海上很散，只盯 " + state.range +
      " km 常是 0%</div>" +
      '<div class="line"><span class="k">口径</span> → ' + clim.method + "</div>" +
      '<div class="line"><span class="k">样本</span> → ' + clim.sample_note + "</div>" +
      yearRows.map((y) => {
        const bucket = clim.by_year[y].by_range[wideKey];
        const narrow = clim.by_year[y].by_range[key];
        return '<div class="line"><span class="k">' + y + " 年（" + (bucket ? bucket.days : 0) + " 天）</span> → <b>" +
          (bucket ? bucket.present_days + "/" + bucket.days : "—") + "</b> 天有锋面 · 线像元合计 " +
          (bucket ? bucket.line_cells : "—") + "（" + state.range + " km 内：" +
          (narrow ? narrow.present_days + "/" + narrow.days : "—") + "）</div>";
      }).join("");
    return;
  }

  // mode === "day"：往年「这一天」的对比
  const md = state.date.slice(5);
  const entry = clim.by_day[md];
  if (!entry) {
    hint.textContent = "没有这一天"; hint.className = "tag warn";
    bars.innerHTML = ""; years.innerHTML = "";
    stat.innerHTML = "<b>" + mdText(state.date) + " 不在取样范围里</b><br/>往年同期只取了 " +
      Object.keys(clim.by_day).join("、") + " 这几天。";
    return;
  }
  const item = entry.by_range[key];
  const cells = yearRows.map((y) => entry.years[y] && entry.years[y][key] ? entry.years[y][key] : null);
  const maxLine = Math.max(1, ...cells.map((c) => (c ? c.line_cells : 0)));
  const thisYear = state.date.slice(0, 4);
  bars.innerHTML = climBarsHTML(yearRows.map((y) => y), cells.map((c) => (c ? c.line_cells / maxLine * 100 : 0)),
    yearRows.map((y) => y === thisYear),
    yearRows.map((y, i) => y + " 年 " + md + " · " + (cells[i] && cells[i].front_present ? "有锋面" :
      cells[i] ? "无锋面" : "缺测") + " · 线像元 " + (cells[i] ? cells[i].line_cells : "—")));

  const others = yearRows.filter((y) => y !== thisYear);
  const otherPresent = others.filter((y, i) => {
    const c = entry.years[y] && entry.years[y][key];
    return c && c.front_present;
  }).length;
  const otherValid = others.filter((y) => entry.years[y] && entry.years[y][key] &&
    entry.years[y][key].status === "ok").length;
  const climRate = otherValid ? otherPresent / otherValid : null;
  const mine = entry.years[thisYear] && entry.years[thisYear][key] ? entry.years[thisYear][key] : null;
  stat.innerHTML = "<b>" + mdText(state.date) + "</b> · 往年 " + item.days + " 个年份样本里，" + state.range +
    " km 内出现锋面的比例 <b>" + Math.round((item.probability || 0) * 100) + "%</b>（" + item.present_days + "/" + item.days +
    " 天）";
  const diff = mine && mine.status === "ok" && climRate !== null ? (mine.front_present ? 1 : 0) - climRate : null;
  const level = diff === null ? "没有样本" : diff > 0.2 ? "比常年活跃" : diff < -0.2 ? "比常年弱" : "和常年差不多";
  hint.textContent = "这一天 · " + item.days + " 年样本"; hint.className = "tag " + (diff === null ? "" : diff > 0.2 ? "ok" : diff < -0.2 ? "warm" : "ok");

  const wide = entry.by_range[String(widestKey)];
  years.innerHTML =
    '<div class="line"><span class="k">' + widestKey + " km 内</span> → <b>" +
    Math.round((wide ? wide.probability || 0 : 0) * 100) + "%</b> 的日子有锋面（" +
    (wide ? wide.present_days + "/" + wide.days : "—") + " 天）</div>" +
    '<div class="line"><span class="k">其他年份（' + otherValid + " 年有数据）</span> → <b>" +
    (climRate === null ? "—" : Math.round(climRate * 100) + "%") + "</b> 的日子有锋面</div>" +
    '<div class="line"><span class="k">' + thisYear + " 年这一天</span> → <b>" +
    (mine ? (mine.front_present ? "有锋面" : "无锋面") + "（线像元 " + mine.line_cells + "）" : "缺测") + "</b></div>" +
    '<div class="line"><span class="k">和常年比</span> → ' + level + "，" + (level === "比常年活跃"
      ? "往年这时候也常出锋面" : level === "比常年弱"
      ? "往年会更多，别只看往年" : "往年经验可以照用") + "</div>" +
    '<div class="line"><span class="k">口径</span> → ' + clim.method + "（" + clim.sample_note + "）</div>";
}

// ==================== L2-依据（数据从哪来 / 怎么算的 / 还做不到什么） ====================
function tableRows(rows) {
  return rows.map((r) => '<div class="tr"><span class="th">' + r[0] + '</span><span class="td">' + r[1] + "</span></div>").join("");
}
function listRows(rows) {
  return rows.map((r) => '<div class="row"><span class="i">' + r[0] + '</span><span class="grow">' + r[1] + "</span></div>").join("");
}

function renderBasis() {
  const a = OFData.attribution();
  if (!a) {
    $("basisData").innerHTML = tableRows([["数据文件", "data/ 目录里没有生成好的数据"]]);
    $("basisRules").innerHTML = "";
    $("basisLimits").innerHTML = listRows([["!", "先跑 Ocean/backend/scripts/export_prototype_data.py 与 tools/build-basemap.mjs"]]);
    return;
  }
  const st = a.status;
  const statusText = (key, real, missing) => (st[key] === "real" ? real : missing);
  $("basisData").innerHTML = tableRows([
    ["锋面位置", "Zenodo " + a.doi + " · " + a.resolutionDeg + "° 逐日 · " + a.license],
    ["海表温度", a.sst && a.sst.ready
      ? "NOAA GHRSST · " + a.sst.product.resolution_deg + "° 逐日 · 按 " + a.sst.bin_c +
        " °C 分档（" + a.sst.days.length + " 天）"
      : "未接入"],
    ["冷暖侧", statusText("cold_side", "−20 / 20 编码，原样用", "未接入")],
    ["对象编号", "本系统内编号（连通域 → 中心线 → 抽稀），不是数据集自带编号"],
    ["底图", "Natural Earth 1:10m 陆地 / 海岸线 / 等深线"],
    ["观测日期", a.days[0] + " ~ " + a.days[a.days.length - 1] + "（" + a.days.length + " 天）"],
    ["往年同期", a.clim.ready ? a.clim.years.join("、") + " 年 · " + a.clim.sample_note : "未导出"],
    ["锋面强度", "未接入"],
    ["海况", "示例值，不参与结论"],
    ["预报", "未接入"],
    ["渔场", "示例占位，没有船位数据"],
    ["数据生成", a.generatedAt],
  ]);
  $("basisRules").innerHTML = listRows([
    ["1", "<b>范围</b>：以定位点为圆心，" + a.region.ranges_km.join(" / ") + " km 内命中才算；范围内没有编号对象时给最近的一个并注明"],
    ["2", "<b>把握</b>：起评分 30；范围内对象 +12（最多 3 个）；最近锋面 ≤10 km +8、≤20 km +4；最长对象 ≥100 km +8、≥50 km +4；观测覆盖 ≥85% +4、<70% −4；冷暖侧只展示、不加分"],
    ["3", "<b>三档</b>：≥70% 值得去 · 50–69% 可以看看 · <50% 线索不足（海况没数据，不参与）"],
    ["4", "<b>往年同期</b>：半径内锋面线像元数 > 0 记 front_present = true；比例 = 有锋面的天数 ÷ 有效天数"],
    ["5", "<b>航时 / 油耗</b>：按 8 节（" + CRUISE_KMH + " km/h）、" + FUEL_L_PER_KM + " L/km 估，只看量级"],
    ["6", "<b>中心线</b>：连通域直径路径 + 抽稀（6 km），对象 ≥ " +
      (OFData.quality(a.days[a.days.length - 1]) ? OFData.quality(a.days[a.days.length - 1]).object_min_length_km : 20) + " km 才编号"],
  ]);
  $("basisLimits").innerHTML = listRows(
    a.knownIssues.map((text) => ["!", text]).concat([
      ["!", "海表温度是 NOAA GHRSST，与锋面数据集（ESA CCI/C3S）不是同一产品；按 0.5 °C 分档，不参与评分"],
      ["!", "海况、预报没有真实数据，本页结论只由锋面数据算出"],
      ["!", "底图 Natural Earth 1:10m（公有领域），公里级精度；国内正式发布要换带审图号的合规底图"],
    ]));
}

// ==================== 提示条（只用于确认操作，不播报结论） ====================
let toastTimer;
function showToast(text) {
  $("toastLoc").textContent = text;
  const t = $("toast");
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 1800);
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
  if (d !== iso) showToast("日期只能选 " + mdText(DATE_MIN) + " ~ " + mdText(DATE_MAX) + "（已导出的观测日期）");
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
  $("dataStamp").textContent = timeLabel() + " · 真实锋面数据";
  document.querySelectorAll("#rangeSeg button").forEach((b) => b.classList.toggle("active", Number(b.dataset.range) === state.range));
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

// 视窗：中心 + 缩放；中心被夹在数据窗口内，拖动不会把图拖没
const VIEW_BOX = { x0: -310, y0: -470, x1: 1130, y1: 986 };
function applyZoom(smooth) {
  const w = 1000 / state.zoom, h = 640 / state.zoom;
  state.view.cx = clamp(state.view.cx, VIEW_BOX.x0 + w / 2, VIEW_BOX.x1 - w / 2);
  state.view.cy = clamp(state.view.cy, VIEW_BOX.y0 + h / 2, VIEW_BOX.y1 - h / 2);
  const svg = $("mapSvg");
  svg.style.transition = smooth === false ? "none" : "all .25s ease";
  svg.setAttribute("viewBox", (state.view.cx - w / 2) + " " + (state.view.cy - h / 2) + " " + w + " " + h);
  refreshGraticule();
  updateScaleBar();
}
function refreshGraticule() {
  const host = $("gratHost");
  if (!host) return;
  host.innerHTML = "";
  drawGraticule(host);
}
// 比例尺：把"图上 50 km"换算成屏幕像素（纯几何换算，不涉及数据）
function updateScaleBar() {
  const bar = $("mapScale");
  if (!bar) return;
  const rect = $("mapSvg").getBoundingClientRect();
  const box = currentView();
  if (!rect.width || !box.w) return;
  const s = Math.max(rect.width / box.w, rect.height / box.h);
  const km = 50;
  bar.style.width = (km * KM2PX * s).toFixed(0) + "px";
  $("mapScaleText").textContent = km + " km";
}
// 以光标为中心缩放：把光标底下的地点钉在原位
function zoomAt(clientX, clientY, factor) {
  const svg = $("mapSvg"), rect = svg.getBoundingClientRect();
  const target = geoOfScreen(clientX, clientY);
  const next = clamp(state.zoom * factor, 0.6, 8);
  if (next === state.zoom) return;
  state.zoom = next;
  applyZoom(false);
  const box = currentView();
  const s = Math.max(rect.width / box.w, rect.height / box.h);
  const p = screenOf(target[0], target[1]);
  state.view.cx += (p.x - (clientX - rect.left)) / s;
  state.view.cy += (p.y - (clientY - rect.top)) / s;
  applyZoom(false);
}
function centerOn(lon, lat, zoom) {
  const p = xy(lon, lat);
  state.view.cx = p[0];
  state.view.cy = p[1];
  if (zoom) state.zoom = zoom;
  applyZoom();
}

// ==================== 事件绑定 ====================
function bind() {
  // ② 找多远
  document.querySelectorAll("#rangeSeg button").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.range = Number(btn.dataset.range);
      state.select = null;
      refresh();
      showToast("找鱼范围：" + state.range + " km");
    });
  });

  // ③ 出海日（全站唯一的时间控件）
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
    centerOn(state.lon, state.lat);       // 定位后视窗跟着走，不用手动找
    showToast("已定位到 " + fmtCoord(state.lon, state.lat));
  };
  $("locateBtn").addEventListener("click", doLocate);
  $("locInput").addEventListener("keydown", (e) => { if (e.key === "Enter") doLocate(); });

  // ===== 地图：拖拽平移 / 滚轮以光标为中心缩放 =====
  let drag = null, suppressClick = false;
  const interactive = (t) => !!(t && t.closest && t.closest(".map-legend, .map-controls, .map-pick, .map-probe"));
  $("map").addEventListener("mousedown", (e) => {
    if (e.button !== 0 || interactive(e.target)) return;
    drag = { x: e.clientX, y: e.clientY, moved: 0 };
    hoverPt = null;
    renderProbe();
  });
  window.addEventListener("mouseup", () => {
    if (drag && drag.moved > 4) suppressClick = true;   // 拖动结束那一下不算点击
    drag = null;
  });
  $("map").addEventListener("wheel", (e) => {
    if (interactive(e.target)) return;
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.2 : 1 / 1.2);
  }, { passive: false });
  window.addEventListener("resize", updateScaleBar);

  // ===== 地图：鼠标指到哪，就显示哪里的数据 =====
  const map = $("map");
  let pending = null, raf = 0;
  map.addEventListener("mousemove", (e) => {
    if (drag) {
      const rect = $("mapSvg").getBoundingClientRect();
      const box = currentView();
      const s = Math.max(rect.width / box.w, rect.height / box.h);
      state.view.cx -= (e.clientX - drag.x) / s;
      state.view.cy -= (e.clientY - drag.y) / s;
      drag.moved += Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y);
      drag.x = e.clientX;
      drag.y = e.clientY;
      applyZoom(false);
      return;
    }
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
    if (suppressClick) { suppressClick = false; return; }   // 拖动之后的那一下不算点击
    if (e.target.closest && e.target.closest(".map-legend, .map-controls, .map-pick, .map-probe, .map-empty")) return;
    const g = geoOfScreen(e.clientX, e.clientY);
    const onPinned = state.probe && distKm([state.probe.lon, state.probe.lat], g) < 5;
    hoverPt = null;
    if (onPinned) {
      state.probe = null;
      showToast("已取消钉住");
    } else {
      const cell = cellAt(g[0], g[1]);
      state.probe = { lon: g[0], lat: g[1] };
      state.select = null;
      showToast(!cell || !cell.inGrid ? "已钉住：这一点在导出范围外"
        : cell.nodata ? "已钉住：这一点没有观测数据" : "已钉住 " + fmtCoord(g[0], g[1]));
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

  // 地图缩放按钮（焦点在地图中心；滚轮与拖动见上）
  const mapCenter = () => { const r = $("map").getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
  $("zoomIn").addEventListener("click", () => { const c = mapCenter(); zoomAt(c[0], c[1], 1.25); });
  $("zoomOut").addEventListener("click", () => { const c = mapCenter(); zoomAt(c[0], c[1], 1 / 1.25); });
  $("recenter").addEventListener("click", () => centerOn(state.lon, state.lat, DEFAULT_ZOOM));

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

// ==================== 启动 ====================
bind();
refresh();
applyZoom(false);      // 按 state.zoom 设定初始视野（默认略微拉远，海岸线在画面内）
switchTab("now");
