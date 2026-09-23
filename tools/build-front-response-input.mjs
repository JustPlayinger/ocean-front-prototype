/**
 * 用真实 GFW apparent fishing effort + 本地锋面对象，计算 P1 Front Response 输入表。
 *
 * 为什么需要本脚本：`tools/build-front-response.mjs` 只做「格式转换 + 校验」，
 * 它要求输入里已经带好 pre7_hours / post1_3_hours / non_front_control_hours。
 * 这三个数值需要真实的地理计算（点到锋面线距离、缓冲区求和、非锋面对照采样），
 * 本脚本负责这一步。
 *
 * 数据边界（见 docs/data-governance-gfw-ais.md）：
 *   - 原始 GFW effort 文件**不进入 Git**，用 `--effort-dir` 指向仓库外目录；
 *   - 只提交聚合后的输入表与 events.js；
 *   - 缺测一律输出 unavailable/not_in_sample，绝不写 0 冒充。
 *
 * 口径（与 docs/ocean-fishery-operation-roadmap.md、ADR-0001 一致）：
 *   - buffer_km        ：锋面线周围 10 / 20 / 30 km
 *   - pre7_hours       ：[d-7, d-1] 落在「d 日该锋面线缓冲区」内的 fishing hours 之和
 *   - post1_3_hours    ：[d+1, d+3] 同上
 *   - non_front_control：d 日「离当日任何锋面线 ≥ 50 km」的像元，按其 hours 密度
 *                        折算到与缓冲区等面积上的小时数（等面积对照）
 *   - enhanced         ：post1_3_hours >= pre7_hours * 1.2 且 post1_3_hours > control
 *
 * 用法：
 *   node tools/build-front-response-input.mjs ^
 *     --effort-dir ..\gfw-sample ^
 *     --start 2024-07-01 --end 2024-08-31 ^
 *     --output frontend/prototype/data/front_response/real-effort-input.json
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const EFFORT_DIR = argValue("--effort-dir", null);
const FRONT_DIR = resolve(ROOT, argValue("--front-dir", "frontend/prototype/data/day"));
const START = argValue("--start", "2024-07-01");
const END = argValue("--end", "2024-08-31");
const OUTPUT = resolve(ROOT, argValue("--output", "frontend/prototype/data/front_response/real-effort-input.json"));
const BUFFERS = argValue("--buffer-km", "10,20,30").split(",").map((v) => Number(v.trim()));
const CONTROL_MIN_KM = Number(argValue("--control-min-km", "50"));
const PRE_DAYS = 7;
const POST_DAYS = [1, 3];
const EXPLORATORY_DAYS = [-7, 7];

if (!EFFORT_DIR) {
  console.error("缺少 --effort-dir <GFW effort JSON 目录>（原始数据不得放入仓库）");
  process.exit(2);
}
const effortRoot = resolve(EFFORT_DIR);

// ---------- 地理计算（局部等距投影，缓冲区只有数十 km，误差可忽略）----------
const KM_PER_DEG_LAT = 111.195;
const kmPerDegLon = (lat) => KM_PER_DEG_LAT * Math.max(Math.cos((lat * Math.PI) / 180), 0.01);

function pointToSegmentKm(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function pointToPolylineKm(p, projected) {
  if (projected.length === 1) return Math.hypot(p.x - projected[0].x, p.y - projected[0].y);
  let best = Infinity;
  for (let i = 0; i < projected.length - 1; i += 1) {
    const d = pointToSegmentKm(p, projected[i], projected[i + 1]);
    if (d < best) best = d;
  }
  return best;
}

function addDays(iso, days) {
  return new Date(Date.parse(iso + "T00:00:00Z") + days * 86400000).toISOString().slice(0, 10);
}

function eachDay(start, end) {
  const days = [];
  let cursor = start;
  while (cursor <= end) {
    days.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return days;
}

// ---------- 数据加载 ----------
function loadFrontDay(iso) {
  const path = join(FRONT_DIR, iso + ".js");
  if (!existsSync(path)) return null;
  const win = {};
  // 数据文件是 window.OF_DATA_DAYS[iso] = {...} 形式，与 data-check.mjs 同样方式求值
  new Function("window", readFileSync(path, "utf8"))(win);
  return win.OF_DATA_DAYS ? win.OF_DATA_DAYS[iso] : null;
}

function loadEffort(iso) {
  const path = join(effortRoot, "effort-" + iso.replaceAll("-", "") + ".json");
  if (!existsSync(path)) return null;
  const payload = JSON.parse(readFileSync(path, "utf8"));
  const cells = Array.isArray(payload.cells) ? payload.cells : [];
  return { date: iso, cells, source: payload.source || null };
}

function cellAreaKm2(lat, sizeDeg) {
  return (sizeDeg * KM_PER_DEG_LAT) * (sizeDeg * kmPerDegLon(lat));
}

// ---------- 统一局部投影（bbox 中心），保证不同锋面线可互相比较距离 ----------
const PROJ_LON0 = 124.0;
const PROJ_LAT0 = 30.5;
const proj = (lon, lat) => ({
  x: (lon - PROJ_LON0) * kmPerDegLon(PROJ_LAT0),
  y: (lat - PROJ_LAT0) * KM_PER_DEG_LAT,
});

const cellKey = (lon, lat) => lon.toFixed(3) + "," + lat.toFixed(3);

function indexCells(effort) {
  const map = new Map();
  for (const cell of effort.cells) {
    map.set(cellKey(cell.lon, cell.lat), Number.isFinite(cell.hours) ? cell.hours : null);
  }
  return map;
}

/** 在指定日期的索引里取某格 hours；该日期文件存在但格不在其中 → 0（当天无捕捞活动，非缺测）。 */
function hoursAt(index, lon, lat) {
  const value = index.get(cellKey(lon, lat));
  return value == null ? 0 : value;
}

// ---------- 主流程 ----------
const days = eachDay(START, END);
const effortCache = new Map();
function getEffort(iso) {
  if (!effortCache.has(iso)) effortCache.set(iso, loadEffort(iso));
  return effortCache.get(iso);
}

// 各天像元的投影缓存（缓冲区内求和要逐天判断，不能只看事件当天）
const projectedCache = new Map();
function projectedCells(iso) {
  if (!projectedCache.has(iso)) {
    const effort = getEffort(iso);
    projectedCache.set(iso, effort ? effort.cells.map((cell) => ({ cell, point: proj(cell.lon, cell.lat) })) : []);
  }
  return projectedCache.get(iso);
}

const preOffsets = Array.from({ length: PRE_DAYS }, (_, i) => -(PRE_DAYS - i));
const postOffsets = [];
for (let k = POST_DAYS[0]; k <= POST_DAYS[1]; k += 1) postOffsets.push(k);

const events = [];
let processedDays = 0;
let skippedDays = 0;
let missingCoverageRows = 0;

for (const date of days) {
  const frontDay = loadFrontDay(date);
  const objects = frontDay && Array.isArray(frontDay.objects) ? frontDay.objects : [];
  if (objects.length === 0) {
    skippedDays += 1;
    continue;
  }

  const preDates = preOffsets.map((k) => addDays(date, k));
  const postDates = postOffsets.map((k) => addDays(date, k));
  const windowDates = [...preDates, ...postDates];

  const preIndexes = preDates.map((iso) => getEffort(iso)).map((e) => (e ? indexCells(e) : null));
  const postIndexes = postDates.map((iso) => getEffort(iso)).map((e) => (e ? indexCells(e) : null));
  const dayEffort = getEffort(date);
  const coverageComplete = preIndexes.every(Boolean) && postIndexes.every(Boolean) && !!dayEffort;

  const polylines = objects.map((obj) => (obj.line || []).map(([lon, lat]) => proj(lon, lat)));

  // 同日 cell 投影一次，供缓冲区分桶与非锋面对照池共用
  const dayCellsProjected = dayEffort
    ? dayEffort.cells.map((cell) => ({ cell, point: proj(cell.lon, cell.lat) }))
    : [];

  // 非锋面对照池：同日离「所有」锋面线 ≥ control_min_km
  const controlPool = coverageComplete
    ? dayCellsProjected.filter(({ point }) =>
        polylines.every((line) => line.length === 0 || pointToPolylineKm(point, line) >= CONTROL_MIN_KM))
    : [];
  const controlArea = controlPool.reduce(
    (sum, { cell }) => sum + cellAreaKm2(cell.lat, dayEffort.spatial_resolution_deg || 0.1), 0);
  const controlHours = controlPool.reduce((sum, { cell }) => sum + (Number.isFinite(cell.hours) ? cell.hours : 0), 0);
  const controlDensity = controlArea > 0 ? controlHours / controlArea : null;

  const dayCandidates = [];
  objects.forEach((obj, index) => {
    const line = polylines[index];
    if (!line || line.length === 0) return;

    const sizeDeg = dayEffort ? dayEffort.spatial_resolution_deg || 0.1 : 0.1;
    const box = Array.isArray(obj.bbox) && obj.bbox.length === 4
      ? obj.bbox
      : [PROJ_LON0 - 2, PROJ_LAT0 - 2, PROJ_LON0 + 2, PROJ_LAT0 + 2];
    const [minLon, minLat, maxLon, maxLat] = box;
    const lineLengthKm = Number.isFinite(obj.length_km) ? obj.length_km : 0;
    const buffers = {};

    BUFFERS.forEach((bufferKm) => {
      const key = String(bufferKm);

      if (!coverageComplete) {
        buffers[key] = {
          status: "missing_coverage",
          coverage_status: "missing_coverage",
          reason: "作业窗口内缺少 GFW effort 覆盖文件",
        };
        missingCoverageRows += 1;
        return;
      }

      // 用「锋面 bbox + 半径」预筛，避免对全部像元算折线距离
      const padLon = bufferKm / kmPerDegLon(PROJ_LAT0) + 0.25;
      const padLat = bufferKm / KM_PER_DEG_LAT + 0.25;
      const near = (cell) =>
        cell.lon >= minLon - padLon && cell.lon <= maxLon + padLon &&
        cell.lat >= minLat - padLat && cell.lat <= maxLat + padLat;

      // 空间范围由缓冲区几何决定：逐天取「那一天自己的像元」判断是否落入半径内。
      // 这样即使事件当天该处没有作业像元，也不会把前 7 天的活动误判成不可用。
      const sumWindow = (dates) => {
        let total = 0;
        let cellCount = 0;
        for (const iso of dates) {
          for (const { cell, point } of projectedCells(iso)) {
            if (!near(cell)) continue;
            if (pointToPolylineKm(point, line) <= bufferKm) {
              total += Number.isFinite(cell.hours) ? cell.hours : 0;
              cellCount += 1;
            }
          }
        }
        return { total, cellCount };
      };

      const pre = sumWindow(preDates);
      const post = sumWindow(postDates);

      // 面积优先取「事件当天」落入缓冲区的像元面积；当天该处无像元时退回几何近似（线长 × 2 × 半径）
      let bufferArea = 0;
      for (const { cell, point } of projectedCells(date)) {
        if (!near(cell)) continue;
        if (pointToPolylineKm(point, line) <= bufferKm) bufferArea += cellAreaKm2(cell.lat, sizeDeg);
      }
      if (bufferArea <= 0) bufferArea = lineLengthKm * 2 * bufferKm;

      // 前 7 天该缓冲区完全没有作业活动、而后 1-3 天有：提升率无定义（除零）。
      // 按治理边界不给 0、不给假 lift，标记为不可用并说明原因。
      if (pre.total === 0 && post.total > 0) {
        buffers[key] = {
          status: "no_pre_window_baseline",
          reason: "前 7 天该缓冲区没有捕捞活动，提升率无定义；不按 0 处理，也不给增强结论",
        };
        missingCoverageRows += 1;
        return;
      }

      const controlHoursForBuffer = controlDensity == null ? null : controlDensity * bufferArea;
      if (controlHoursForBuffer == null) {
        buffers[key] = {
          status: "control_unavailable",
          coverage_status: "available",
          reason: "同日非锋面对照池为空，无法给出等面积对照值",
        };
        missingCoverageRows += 1;
        return;
      }

      buffers[key] = {
        pre7_hours: Math.round(pre.total * 100) / 100,
        post1_3_hours: Math.round(post.total * 100) / 100,
        non_front_control_hours: Math.round(controlHoursForBuffer * 100) / 100,
        cell_count: pre.cellCount + post.cellCount,
      };
    });

    dayCandidates.push({ date, front_id: obj.front_id, buffers });
  });

  // 数据契约约束（tools/build-front-response.mjs 的 by_date.by_range 与 data-check 的
  // 「每个事件都要能按日期+半径索引到」）要求「每天每半径只有一条响应」，
  // 而真实数据一天有多个锋面。因此每天选一个代表性锋面入表：
  //   优先 20 km（产品默认半径）后 1-3 天可用响应小时数最大者，并列时取 front_id 最小。
  // 未被选中的锋面响应不进入 events.js —— 这是契约取舍，选择规则在此显式记录以便追溯。
  if (dayCandidates.length > 0) {
    const scoreOf = (item) => {
      const entry = item.buffers["20"];
      if (!entry || entry.status) return -1;
      return Number.isFinite(entry.post1_3_hours) ? entry.post1_3_hours : -1;
    };
    dayCandidates.sort((a, b) => scoreOf(b) - scoreOf(a) || a.front_id.localeCompare(b.front_id));
    events.push(dayCandidates[0]);
  }

  processedDays += 1;
}

// ---------- 输出 front-response-input/v1 ----------
const today = new Date().toISOString().slice(0, 10);
const payload = {
  schema_version: "front-response-input/v1",
  status: "real",
  is_synthetic: false,
  generated_at: today,
  source: {
    kind: "gfw_apparent_fishing_effort",
    attribution:
      "Global Fishing Watch — AIS apparent fishing effort (4Wings report v3, public-global-fishing-effort:latest)",
    license: "CC BY-NC 4.0 (non-commercial)",
    accessed_at: today,
  },
  time_window: {
    sample_start: START,
    sample_end: END,
    pre_window_days: PRE_DAYS,
    post_window_days: POST_DAYS,
    exploratory_window_days: EXPLORATORY_DAYS,
  },
  spatial_window: {
    region: "East China Sea prototype window",
    bbox: [120, 27, 128, 34],
    buffer_km: BUFFERS,
    control: "same-day non-front control area",
    control_min_distance_km: CONTROL_MIN_KM,
    control_area_ratio: 1,
    control_sampling:
      "same-day cells at least " + CONTROL_MIN_KM +
      " km away from every front line, scaled to the front-buffer area by that day's hours density",
  },
  processing: {
    metric: "apparent_fishing_effort",
    unit: "fishing_hours",
    enhancement_rule: "post1_3_hours >= pre7_hours * 1.2 and post1_3_hours > non_front_control_hours",
    control_validation:
      "control pool excludes every " + CONTROL_MIN_KM +
      " km front buffer on the same day; buffer area counted from GFW cells inside the radius",
    front_id_scope: "local_day",
  },
  public_boundary: {
    commit_policy: "aggregate_only",
    raw_or_fine_grained_data_committed: false,
    note:
      "Aggregated front-response evidence derived from GFW apparent fishing effort. " +
      "Not catch, production, revenue, or biomass. Raw GFW files stay outside the repository.",
  },
  front_events: events,
};

const json = JSON.stringify(payload, null, 2);
const dirty = json.match(/NaN|Infinity/);
if (dirty) {
  console.error("输出含脏值（" + dirty[0] + "），已中止，未写文件。请检查上游数据。");
  process.exit(1);
}

writeFileSync(OUTPUT, json + "\n", "utf8");

let available = 0;
let unavailable = 0;
for (const event of events) {
  for (const key of Object.keys(event.buffers)) {
    if (event.buffers[key].status && event.buffers[key].status !== "available") unavailable += 1;
    else available += 1;
  }
}

console.log("处理日期: " + processedDays + " 天（无锋面跳过 " + skippedDays + " 天）");
console.log("锋面事件: " + events.length + " 个 · 响应行: " + (available + unavailable) +
  "（可用 " + available + " / 不可用 " + unavailable + "）");
console.log("已写出: " + OUTPUT);
