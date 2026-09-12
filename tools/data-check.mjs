/* 数据完整性校验：确认 data/ 下生成的文件结构正确、数值自洽、没有编造字段
 *
 * 用法：node tools/data-check.mjs
 *
 * 这些断言的意义：原型里所有数字都必须能追溯到 data/ 文件，
 * 所以这里既查结构（字段/取值），也查自洽（RLE 还原出的像元数必须等于 quality 里的统计）。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data");
const results = [];
const check = (label, cond, detail) => results.push(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? "  → " + detail : ""}`);
const readJs = (rel) => {
  const text = readFileSync(join(DATA, rel), "utf8");
  return { text, run: () => { const win = {}; new Function("window", text)(win); return win; } };
};
const decoded = (runs) => runs.reduce((sum, r) => sum + r[2], 0);
const inBox = ([lon, lat], b) => lon >= b[0] - 0.01 && lon <= b[2] + 0.01 && lat >= b[1] - 0.01 && lat <= b[3] + 0.01;

// ===== meta =====
const metaFile = readJs("meta.js");
const META = metaFile.run().OF_DATA_META;
check("meta.js 存在且能解析", !!META);
const BBOX = META.region.bbox;
check("锋面产品与许可写明（Zenodo 20356239 · CC BY 4.0）",
  META.product.doi === "10.5281/zenodo.20356239" && META.product.license === "CC BY 4.0",
  META.product.doi + " / " + META.product.license);
check("已接入的图层标成 real，没接入的标成 not_available",
  ["front_line", "cold_side", "warm_side", "front_objects"].every((k) => META.status[k] === "real") &&
  ["sst", "intensity", "forecast", "sea_state", "fishing_grounds"].every((k) => META.status[k] === "not_available"),
  JSON.stringify(META.status));
check("窗口 / 锚点 / 找鱼范围写清楚",
  BBOX.length === 4 && META.region.anchor.length === 2 && META.region.ranges_km.join(",") === "10,20,30",
  JSON.stringify({ bbox: BBOX, anchor: META.region.anchor }));

// ===== 单日图层 =====
const dayFiles = readdirSync(join(DATA, "day")).filter((f) => f.endsWith(".js")).sort();
check("可用日期与 meta 声明一致",
  dayFiles.map((f) => f.replace(".js", "")).join(",") === META.availability.days.slice().sort().join(","),
  META.availability.days.join(" / "));

const CODETAGS = new Set([-10, 10, 30]);
for (const file of dayFiles) {
  const iso = file.replace(".js", "");
  const day = readJs(join("day", file)).run().OF_DATA_DAYS[iso];
  const tag = iso + ": ";
  check(tag + "文件名与内部日期一致", !!day && day.date === iso, day ? day.date : "缺失");
  check(tag + "来源文件名正确（日期以文件名为准）",
    /^front_location\d{8}\.nc$/.test(day.source_file) && day.source_file.slice(14, 22) === iso.replace(/-/g, ""),
    day.source_file);
  const g = day.grid;
  check(tag + "网格 0.05° 且落在导出窗口内",
    g.dlon === 0.05 && g.dlat === 0.05 && g.nx === 160 && g.ny === 140 &&
    g.lon0 >= BBOX[0] && g.lon0 + (g.nx - 1) * g.dlon <= BBOX[2] &&
    g.lat0 >= BBOX[1] && g.lat0 + (g.ny - 1) * g.dlat <= BBOX[3], JSON.stringify(g));

  const ids = day.objects.map((o) => o.front_id);
  check(tag + "锋面对象有编号且唯一", ids.length > 0 && ids.every((id) => /^F\d{3}$/.test(id)) &&
    new Set(ids).size === ids.length, ids.join(","));
  check(tag + "对象按长度从大到小排（编号稳定）",
    day.objects.every((o, i) => i === 0 || day.objects[i - 1].length_km >= o.length_km), "n=" + ids.length);

  const badLine = day.objects.filter((o) => o.line.length < 2 || !o.line.every((p) => inBox(p, BBOX)));
  check(tag + "对象中心线至少 2 点且都在窗口内", badLine.length === 0,
    badLine.length ? badLine[0].front_id : "全部通过");
  const badNumbers = day.objects.filter((o) => !(o.length_km > 0) || !(o.pixel_count > 0) ||
    !o.codes.every((c) => CODETAGS.has(c)));
  check(tag + "对象长度 / 像元数为正，编码只出现 -10/10/30", badNumbers.length === 0,
    badNumbers.length ? JSON.stringify(badNumbers[0]) : "全部通过");
  check(tag + "线段数 = 对象线 + 短段线",
    day.front_line.length === day.object_line_count + day.short_line_count,
    day.front_line.length + " = " + day.object_line_count + " + " + day.short_line_count);

  const rleKeys = [["nodata_rle", "nodata_cells"], ["cold_side_rle", "cold_side_cells"],
    ["warm_side_rle", "warm_side_cells"], ["front_band_rle", "front_line_cells"]];
  let rleBad = null;
  rleKeys.forEach(([key, stat]) => {
    const runs = day[key];
    if (!runs || runs.some((r) => r[0] < 0 || r[0] >= g.ny || r[1] < 0 || r[1] + r[2] > g.nx || r[2] < 1)) {
      rleBad = key + " 结构非法";
    } else if (decoded(runs) !== day.quality[stat]) {
      rleBad = key + " 还原 " + decoded(runs) + " ≠ quality." + stat + " " + day.quality[stat];
    }
  });
  check(tag + "RLE 结构合法且还原像元数与统计一致", rleBad === null, rleBad || "4 组全部一致");
  check(tag + "有效像元 + 缺测像元 = 总像元",
    day.quality.valid_cells + day.quality.nodata_cells === g.nx * g.ny,
    day.quality.valid_cells + " + " + day.quality.nodata_cells + " = " + g.nx * g.ny);
  const mixSum = Object.values(day.quality.line_code_mix).reduce((a, b) => a + b, 0);
  check(tag + "三种线码像元合计 = 锋面线像元", mixSum === day.quality.front_line_cells,
    mixSum + " vs " + day.quality.front_line_cells);
  const objPixels = day.objects.reduce((sum, o) => sum + o.pixel_count, 0);
  check(tag + "对象像元数不超过锋面线像元总数", objPixels <= day.quality.front_line_cells,
    objPixels + " ≤ " + day.quality.front_line_cells);
  check(tag + "没接入的变量不冒充真实值（has_sst / has_intensity = false）",
    day.has_sst === false && day.has_intensity === false, "sst=" + day.has_sst + " intensity=" + day.has_intensity);
  const kb = statSync(join(DATA, "day", file)).size / 1024;
  check(tag + "单日文件体积可控（< 300 KB）", kb < 300, kb.toFixed(1) + " KB");
}

// ===== 底图 =====
const baseWin = readJs(join("base", "basemap.js")).run();
const BASE = baseWin.OF_DATA_BASE;
check("底图层齐备（陆地 / 海岸线 / 200 m / 1000 m 等深线）",
  ["land", "coastline", "isobath200", "isobath1000"].every((k) => BASE.layers[k] && BASE.layers[k].chains.length > 0),
  Object.keys(BASE.layers).map((k) => k + ":" + BASE.layers[k].chains.length).join(" "));
const outOfBox = ["land", "coastline", "isobath200", "isobath1000"].flatMap((k) =>
  BASE.layers[k].chains.flat().filter((p) => !inBox(p, BASE.bbox)));
check("底图坐标都在裁剪窗口内", outOfBox.length === 0, outOfBox.length ? "越界 " + outOfBox.length + " 点" : "全部通过");
check("底图写明公有领域来源", /public domain|公有领域/i.test(BASE.license) && /Natural Earth/.test(BASE.source),
  BASE.source + " / " + BASE.license);
const baseKb = statSync(join(DATA, "base", "basemap.js")).size / 1024;
check("底图体积可控（< 400 KB）", baseKb < 400, baseKb.toFixed(1) + " KB");

// ===== 往年同期 =====
const climFile = readJs(join("clim", "same-period.js"));
const CLIM = climFile.run().OF_DATA_CLIM;
check("clim 文件存在且能解析", !!CLIM);
check("往年同期写明唯一口径（front_present = 线像元 > 0）",
  /front_present/.test(CLIM.method) && /probability/.test(CLIM.method), CLIM.method);
check("clim 抽样口径里写清实际取样天数", /实际取样 \d+ 天/.test(CLIM.sample_note), CLIM.sample_note);
const climDays = Object.keys(CLIM.by_day);
check("clim 只统计 8 月 5—7 日这几天", climDays.every((md) => ["08-05", "08-06", "08-07"].includes(md)), climDays.join(","));
check("clim 覆盖 5 个以上年份", Object.keys(CLIM.by_year).length >= 5, Object.keys(CLIM.by_year).join(","));
let climBad = null;
Object.entries(CLIM.by_day).forEach(([md, entry]) => {
  ["10", "20", "30"].forEach((key) => {
    const bucket = entry.by_range[key];
    if (!bucket) { climBad = md + " 缺 " + key + " km"; return; }
    if (bucket.present_days > bucket.days) climBad = md + " " + key + " present_days > days";
    if (bucket.probability !== null && (bucket.probability < 0 || bucket.probability > 1)) climBad = md + " " + key + " 概率越界";
  });
});
check("clim 聚合层每天每个找鱼范围都有结果，概率在 0~1 之间", climBad === null, climBad || "全部通过");
let rowBad = null;
CLIM.rows.forEach((row) => {
  ["10", "20", "30"].forEach((key) => {
    const b = row.by_range[key];
    if (!b) { rowBad = row.date + " 缺 " + key; return; }
    if (!["ok", "no_observation"].includes(b.status)) rowBad = row.date + " " + key + " status=" + b.status;
    if (b.line_cells < 0 || b.valid_cells < 0) rowBad = row.date + " " + key + " 负数";
    if (b.front_present && b.line_cells <= 0) rowBad = row.date + " " + key + " 判有锋面却没有线像元";
    if (!b.front_present && b.line_cells > 0) rowBad = row.date + " " + key + " 有线像元却判无锋面";
    if (b.status === "no_observation" && b.valid_cells !== 0) rowBad = row.date + " " + key + " 无观测却报了有效像元";
  });
});
check("clim 逐日明细：front_present 与线像元数一致，无观测的不报有效像元", rowBad === null, rowBad || "全部通过");
check("生成文件里没有 NaN / Infinity 之类的脏值",
  !/NaN|Infinity/.test(climFile.text) && !/NaN|Infinity/.test(metaFile.text) &&
  dayFiles.every((f) => !/NaN|Infinity/.test(readJs(join("day", f)).text)), "已扫描全部生成文件");

// ===== 汇总 =====
console.log(results.join("\n"));
console.log("\nFAIL 总数 = " + results.filter((r) => r.startsWith("FAIL")).length + " / " + results.length);
process.exit(0);
