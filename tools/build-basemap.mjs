/* 生成原型底图（三级 LOD）：世界 / 西太平洋 / 东海
 *
 * 一级 world    Natural Earth 1:110m  全球不裁剪      → window.OF_DATA_WORLD   球面 / 大陆尺度
 * 二级 asia     Natural Earth 1:50m   裁到 95E-155E / 10S-50N → window.OF_DATA_ASIA  区域尺度
 * 三级 donghai  Natural Earth 1:10m   裁到东海窗口（含 200 m / 1000 m 等深线）→ window.OF_DATA_BASE  细节尺度
 *
 * 用法：node tools/build-basemap.mjs [--set all|world,asia,donghai]
 *
 * 说明：
 * - Natural Earth 为公有领域（无需署名、可商用），此处仍保留来源与版本号便于追溯；
 * - 等深线取自 Natural Earth bathymetry 多边形的环坐标（200 m 即陆架边缘）；
 * - 抽稀用 RDP，容差按「公里」给（内部先换算成按纬度校正的平面坐标）；
 * - 全部离线提交进仓，双击打开 HTML 时不依赖任何在线底图服务（对应 BR-3）。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const NE_TAG = "5.1.2";
const NE_BASE = `https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@${NE_TAG}/geojson`;
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "frontend", "prototype", "data", "base");

// 三档底图。bbox 为 null 表示全球不裁剪（世界档要保住跨 180° 的环，不能按框切断）
const SETS = [
  {
    key: "world", out: "world.js", global: "OF_DATA_WORLD", scale: "1:110m", precision: 2,
    bbox: null, note: "全球（未裁剪）",
    layers: [
      { key: "land", file: "ne_110m_land.geojson", label: "陆地（面）", kind: "polygon", toleranceKm: 16, minChainKm: 0 },
      { key: "coastline", file: "ne_110m_coastline.geojson", label: "海岸线", kind: "chain", toleranceKm: 16, minChainKm: 110 },
    ],
  },
  {
    key: "asia", out: "asia.js", global: "OF_DATA_ASIA", scale: "1:50m", precision: 3,
    bbox: [95, -10, 155, 50], note: "已裁剪到 95, -10, 155, 50",
    layers: [
      { key: "land", file: "ne_50m_land.geojson", label: "陆地（面）", kind: "polygon", toleranceKm: 5, minChainKm: 0 },
      { key: "coastline", file: "ne_50m_coastline.geojson", label: "海岸线", kind: "chain", toleranceKm: 1.5, minChainKm: 20 },
    ],
  },
  {
    key: "donghai", out: "basemap.js", global: "OF_DATA_BASE", scale: "1:10m", precision: 3,
    // 视口最远能缩到 0.4 倍，这里比视口再留一圈，缩放/平移时不至于露出空白
    bbox: [117.5, 25.0, 131.5, 35.0], note: "已裁剪到 117.5, 25, 131.5, 35",
    layers: [
      { key: "land", file: "ne_10m_land.geojson", label: "陆地（面）", kind: "polygon", toleranceKm: 4.0, minChainKm: 0 },
      { key: "coastline", file: "ne_10m_coastline.geojson", label: "海岸线", kind: "chain", toleranceKm: 1.6, minChainKm: 10 },
      { key: "isobath200", file: "ne_10m_bathymetry_K_200.geojson", label: "200 m 等深线（陆架边缘）", kind: "chain", toleranceKm: 1.6, minChainKm: 10 },
      { key: "isobath1000", file: "ne_10m_bathymetry_J_1000.geojson", label: "1000 m 等深线", kind: "chain", toleranceKm: 1.6, minChainKm: 10 },
    ],
  },
];

const KM_PER_DEG = 111.195;
const roundTo = (v, digits) => Math.round(v * 10 ** digits) / 10 ** digits;
const kmPerLon = (lat) => KM_PER_DEG * Math.cos((lat * Math.PI) / 180);

function chainLengthKm(chain) {
  let total = 0;
  for (let i = 1; i < chain.length; i++) {
    const [lon0, lat0] = chain[i - 1];
    const [lon1, lat1] = chain[i];
    total += Math.hypot((lon1 - lon0) * kmPerLon((lat0 + lat1) / 2), (lat1 - lat0) * KM_PER_DEG);
  }
  return total;
}

function simplifyChain(chain, toleranceKm) {
  if (chain.length <= 3) return chain;
  const km = chain.map(([lon, lat]) => [lon * kmPerLon(lat), lat * KM_PER_DEG]);
  const keep = new Set([0, chain.length - 1]);
  const stack = [[0, chain.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop();
    if (end <= start + 1) continue;
    let worst = 0;
    let worstIndex = -1;
    const [ax, ay] = km[start];
    const [bx, by] = km[end];
    const dx = bx - ax;
    const dy = by - ay;
    const denom = dx * dx + dy * dy;
    for (let i = start + 1; i < end; i++) {
      const [px, py] = km[i];
      let dist;
      if (denom === 0) {
        dist = Math.hypot(px - ax, py - ay);
      } else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / denom));
        dist = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      }
      if (dist > worst) {
        worst = dist;
        worstIndex = i;
      }
    }
    if (worst > toleranceKm) {
      keep.add(worstIndex);
      stack.push([start, worstIndex], [worstIndex, end]);
    }
  }
  return [...keep].sort((a, b) => a - b).map((i) => chain[i]);
}

const inBox = (bbox, [lon, lat]) => lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];

// 反经线（±180°）拆分：全球档里跨 ±180 的环必须切开，
// 否则投影到球面会连出一条横穿整颗球的假线（±180 在球面上是同一条经线，拆开画不出缝）
function splitAtAntimeridian(chain) {
  const out = [];
  let current = [chain[0]];
  for (let i = 1; i < chain.length; i++) {
    const prev = chain[i - 1], cur = chain[i];
    if (Math.abs(cur[0] - prev[0]) > 180) {
      const sign = prev[0] > 0 ? 180 : -180;
      const t = (sign - prev[0]) / (cur[0] - prev[0]);
      const latAt = roundTo(prev[1] + (cur[1] - prev[1]) * t, 2);
      current.push([sign, latAt]);
      out.push(current);
      current = [cur];                                  // 下一段从真实点开始（界点不重复，球面上留 ~1° 缝，肉眼不可见）
    } else {
      current.push(cur);
    }
  }
  out.push(current);
  return out.filter((c) => c.length >= 2);
}

// 按点裁切：连续在框内的点合成一段，离开框就断链（够用且不引入几何库）
function clipChain(bbox, points) {
  const chains = [];
  let current = [];
  for (const point of points) {
    if (inBox(bbox, point)) {
      current.push(point);
    } else if (current.length) {
      chains.push(current);
      current = [];
    }
  }
  if (current.length) chains.push(current);
  return chains;
}

function ringsOf(geometry) {
  const { type, coordinates } = geometry;
  if (type === "LineString") return [coordinates];
  if (type === "MultiLineString") return coordinates;
  if (type === "Polygon") return coordinates;
  if (type === "MultiPolygon") return coordinates.flat();
  return [];
}

function exteriorRingsOf(geometry) {
  const { type, coordinates } = geometry;
  if (type === "Polygon") return [coordinates[0]].filter(Boolean);
  if (type === "MultiPolygon") return coordinates.map((polygon) => polygon[0]).filter(Boolean);
  return [];
}

// 矩形是凸窗口，直接用 Sutherland–Hodgman 裁面（内环/湖面丢弃，原型不需要）
function clipPolygon(box, points) {
  const [minLon, minLat, maxLon, maxLat] = box;
  const planes = [
    { axis: 0, value: minLon, keepGreater: true },
    { axis: 0, value: maxLon, keepGreater: false },
    { axis: 1, value: minLat, keepGreater: true },
    { axis: 1, value: maxLat, keepGreater: false },
  ];
  let output = points;
  for (const plane of planes) {
    const input = output;
    output = [];
    if (!input.length) break;
    for (let i = 0; i < input.length; i++) {
      const current = input[i];
      const previous = input[(i + input.length - 1) % input.length];
      const currentInside = plane.keepGreater ? current[plane.axis] >= plane.value : current[plane.axis] <= plane.value;
      const previousInside = plane.keepGreater ? previous[plane.axis] >= plane.value : previous[plane.axis] <= plane.value;
      if (currentInside !== previousInside) {
        const other = plane.axis === 0 ? 1 : 0;
        const delta = current[plane.axis] - previous[plane.axis];
        const ratio = delta === 0 ? 0 : (plane.value - previous[plane.axis]) / delta;
        const crossing = [0, 0];
        crossing[plane.axis] = plane.value;
        crossing[other] = previous[other] + (current[other] - previous[other]) * ratio;
        output.push(crossing);
      }
      if (currentInside) output.push(current);
    }
  }
  return output;
}

async function fetchLayer(set, layer) {
  const isLand = layer.kind === "polygon";
  const url = `${NE_BASE}/${layer.file}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${layer.file} 下载失败：HTTP ${response.status}`);
  const data = await response.json();
  const chains = [];
  for (const feature of data.features) {
    const rings = isLand ? exteriorRingsOf(feature.geometry) : ringsOf(feature.geometry);
    for (const ring of rings) {
      // 全球档不裁剪：按框切断会把跨 180° 经线的环拆坏，也会在球面外留下假直边
      let pieces;
      if (set.bbox) {
        if (!ring.some((point) => inBox(set.bbox, point))) continue;
        pieces = isLand ? [clipPolygon(set.bbox, ring)].filter((piece) => piece.length >= 3) : clipChain(set.bbox, ring);
      } else {
        pieces = isLand ? [ring].filter((piece) => piece.length >= 3) : [ring];
      }
      for (const piece of pieces) {
        const simplified = simplifyChain(piece, layer.toleranceKm);
        if (simplified.length < (isLand ? 3 : 2)) continue;
        if (!isLand && chainLengthKm(simplified) < layer.minChainKm) continue;
        const rounded = simplified.map(([lon, lat]) => [roundTo(lon, set.precision), roundTo(lat, set.precision)]);
        // 抽稀后再按反经线切开：跨 ±180 的环在球面上必须断开，否则连出横穿全球的假线
        splitAtAntimeridian(rounded).forEach((chain) => {
          if (chain.length >= (isLand ? 3 : 2)) chains.push(chain);
        });
      }
    }
  }
  if (!isLand) chains.sort((a, b) => chainLengthKm(b) - chainLengthKm(a));
  return chains;
}

// 组装一档底图产物（字段顺序与旧版 OF_DATA_BASE 保持一致，便于 diff 校验）
async function buildSet(set) {
  const payload = {
    source: "Natural Earth",
    license: "Public domain（公有领域，无需署名，可商用）",
    citation: "Made with Natural Earth. Free vector and raster map data @ naturalearthdata.com",
    version: NE_TAG,
    url: NE_BASE,
    bbox: set.bbox || [-180, -90, 180, 90],
    simplify_km: set.layers[set.layers.length - 1].toleranceKm,
    layers: {},
  };
  let totalPoints = 0;
  for (const layer of set.layers) {
    const chains = await fetchLayer(set, layer);
    const isLand = layer.kind === "polygon";
    payload.layers[layer.key] = {
      label: layer.label,
      kind: isLand ? "polygon" : "chain",
      file: layer.file,
      tolerance_km: layer.toleranceKm,
      holes_dropped: isLand,
      chains,
    };
    const points = chains.reduce((sum, chain) => sum + chain.length, 0);
    totalPoints += points;
    console.log(`  ${layer.key.padEnd(12)} 段=${String(chains.length).padStart(4)} 点=${String(points).padStart(6)}  ${layer.label}`);
  }
  payload.point_count = totalPoints;
  const text =
    "/* 本文件由 ocean-front-prototype/tools/build-basemap.mjs 生成，请勿手工修改。\n" +
    `   数据源：Natural Earth ${set.scale}（公有领域）@ ${NE_TAG}，${set.note} 并抽稀。*/\n` +
    `window.${set.global} = ` + JSON.stringify(payload) + ";\n";
  mkdirSync(OUT_DIR, { recursive: true });
  const out = join(OUT_DIR, set.out);
  writeFileSync(out, text, "utf8");
  console.log(`  → ${set.out}  ${(Buffer.byteLength(text, "utf8") / 1024).toFixed(1)} KB · 总点数 ${totalPoints}`);
}

// --set all|world,asia,donghai（默认 all）
const setArg = (process.argv.find((a) => a.startsWith("--set")) || "").split("=")[1] ||
  (process.argv.includes("--set") ? process.argv[process.argv.indexOf("--set") + 1] : "all");
const wanted = String(setArg || "all") === "all" ? SETS.map((s) => s.key) : String(setArg).split(",").map((s) => s.trim());
const chosen = SETS.filter((s) => wanted.includes(s.key));
if (!chosen.length) throw new Error("--set 只能是 all 或 world,asia,donghai 的组合");

for (const set of chosen) {
  console.log(`== ${set.key}（Natural Earth ${set.scale}）==`);
  await buildSet(set);
}

