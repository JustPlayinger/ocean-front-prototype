/* 数据适配层：页面唯一的数据入口
 *
 * 上游文件（都由脚本生成，不要手改）：
 *   data/meta.js               数据产品、许可、可用日期、缺什么        ← export_prototype_data.py
 *   data/day/<日期>.js          真实锋面：对象中心线 / 锋面线 / 冷暖侧 RLE ← export_prototype_data.py
 *   data/clim/same-period.js   往年同期统计（唯一口径）               ← export_prototype_data.py --mode clim
 *   data/front_response/events.js  锋面事件与 AIS 表观捕捞响应表       ← 后续 GFW/AIS 样例闭环生成
 *   data/base/basemap.js       陆地 / 海岸线 / 等深线（公有领域）      ← tools/build-basemap.mjs
 *
 * 原则：没有真实数据的地方一律返回 null / 空数组，由界面显式说明「待接入」；
 *       任何情况下都不用插值、哈希或示例值冒充实测数据。
 */
(function () {
  "use strict";

  const META = window.OF_DATA_META || null;
  const DAYS = window.OF_DATA_DAYS || {};
  const CLIM = window.OF_DATA_CLIM || null;
  const BASE = window.OF_DATA_BASE || null;
  const SST = window.OF_DATA_SST || {};
  const FRONT_RESPONSE = window.OF_FRONT_RESPONSE || null;
  const SORTED_DATES = Object.keys(DAYS).sort();
  const SST_DATES = Object.keys(SST).sort();

  // ---- 服务器增强模式（可选）----
  // 后端 /api/frontend/day/<date> 会按需产出与离线 data/day|sst/<date>.js 完全一致的结构，
  // 这里把它注入 DAYS/SST 缓存，下游渲染函数无需任何改动即可绘制服务器上的全量日期。
  // 重要：file:// 打开或未配置 API 时本模式整体关闭，离线行为与断言保持原样。
  const SERVER = {
    base: null,
    enabled: false,
    sortedDates: [],
    dateSet: {},
    inflight: {},
    failed: {},
  };

  function serverBase() {
    if (typeof window.OF_API_BASE === "string" && window.OF_API_BASE) {
      return window.OF_API_BASE.replace(/\/+$/, "");
    }
    // 同源部署（nginx 已把 /api 反代到后端）时用相对路径；file:// 下没有同源 API
    if (typeof location !== "undefined" && /^https?:$/.test(location.protocol)) return "/api";
    return null;
  }

  function mergedDates() {
    if (!SERVER.enabled || !SERVER.sortedDates.length) return SORTED_DATES;
    const merged = SORTED_DATES.slice().concat(SERVER.sortedDates).sort();
    return merged.filter(function (iso, index) { return index === 0 || merged[index - 1] !== iso; });
  }

  const BAND_KIND = { front: "front_band_rle", coldwarm: "cold_side_rle", cold: "cold_side_rle", warm: "warm_side_rle" };

  function toObject(raw) {
    return {
      id: raw.front_id,
      points: raw.line,          // [[lon, lat], ...] 真实中心线
      lengthKm: raw.length_km,
      pixelCount: raw.pixel_count,
      codes: raw.codes,          // 数据里出现的锋面线编码，原样保留
      centroid: raw.centroid,
      bbox: raw.bbox,
    };
  }

  function frontResponseStatusReady() {
    return !!(FRONT_RESPONSE && ["real", "synthetic_fixture"].indexOf(FRONT_RESPONSE.status) >= 0);
  }

  function normalizeFrontResponse(raw, iso, rangeKm) {
    if (!raw) return null;
    const base = {
      status: raw.status || "available",
      responseId: raw.response_id || null,
      frontEventId: raw.front_event_id || null,
      date: raw.date || iso || null,
      frontId: raw.front_id || null,
      frontIdScope: raw.front_id_scope || "local_day",
      bufferKm: raw.buffer_km == null ? rangeKm || null : raw.buffer_km,
      preWindow: raw.pre_window || null,
      postWindow: raw.post_window || null,
      exploratoryWindow: raw.exploratory_window || null,
      control: raw.control || null,
      coverageStatus: raw.coverage_status || raw.status || "available",
      reason: raw.reason || raw.status || "",
      evidenceLabel: raw.evidence_label || (raw.enhanced_flag ? "响应增强" : "未见明确增强"),
      isSynthetic: !!(FRONT_RESPONSE && FRONT_RESPONSE.is_synthetic),
      note: raw.note || "",
      raw: raw,
    };
    if (raw.status && raw.status !== "available") {
      return {
        ...base,
        available: false,
      };
    }
    return {
      ...base,
      available: true,
      pre7Hours: raw.pre7_hours,
      post13Hours: raw.post1_3_hours,
      controlHours: raw.non_front_control_hours,
      liftPercent: raw.lift_percent,
      enhanced: raw.enhanced_flag === true,
    };
  }

  // ---- 服务器增强模式：探测 / 按需加载（不改变离线行为）----

  /** 拉 /api/catalog 拿到服务器上的全量可用日期；任何失败都静默退回离线模式。 */
  function initServerMode() {
    const base = serverBase();
    if (!base || SERVER.enabled) return Promise.resolve(false);
    SERVER.base = base;
    return fetch(base + "/catalog", { cache: "no-store" })
      .then(function (response) {
        if (!response.ok) throw new Error("catalog HTTP " + response.status);
        return response.json();
      })
      .then(function (data) {
        const dates = Array.isArray(data.available_dates) ? data.available_dates.slice().sort() : [];
        if (!dates.length) return false;
        SERVER.sortedDates = dates;
        dates.forEach(function (iso) { SERVER.dateSet[iso] = true; });
        SERVER.enabled = true;
        return true;
      })
      .catch(function () { SERVER.enabled = false; return false; });
  }

  function serverEnabled() { return SERVER.enabled === true; }

  /** 服务器上是否存在该日期（不代表已加载）。 */
  function serverAvailable(iso) { return !!(SERVER.enabled && SERVER.dateSet[iso]); }

  /** 按需把服务器单日数据注入 DAYS/SST；并发同一天只发一次，失败记住不重试。
   *  force=true 时忽略本地已有数据（服务器窗口比离线兜底大，需要覆盖）。 */
  function ensureDay(iso, force) {
    if (!force && Object.prototype.hasOwnProperty.call(DAYS, iso)) return Promise.resolve(true);
    if (!serverAvailable(iso) || SERVER.failed[iso]) return Promise.resolve(false);
    if (SERVER.inflight[iso]) return SERVER.inflight[iso];
    const url = SERVER.base + "/frontend/day/" + iso;
    const task = fetch(url, { cache: "no-store" })
      .then(function (response) {
        if (!response.ok) throw new Error("frontend/day HTTP " + response.status);
        return response.json();
      })
      .then(function (payload) {
        if (!payload || !payload.front) throw new Error("payload 缺少 front");
        DAYS[iso] = payload.front;
        if (payload.sst) SST[iso] = payload.sst;
        return true;
      })
      .catch(function () { SERVER.failed[iso] = true; return false; })
      .then(function (ok) { delete SERVER.inflight[iso]; return ok; });
    SERVER.inflight[iso] = task;
    return task;
  }

  // ---- 渔场线索（GFW apparent fishing effort；目前只有服务器模式提供）----
  // 注意口径：这是基于 AIS 行为估计的「表观捕捞活动」（fishing hours），
  // 不是渔获量/产量/鱼群密度，界面必须照实标注（见 docs/data-governance-gfw-ais.md）。
  const FISHING = { days: {}, inflight: {}, failed: {} };

  function fishingAvailable() { return SERVER.enabled === true; }

  function fishingDay(iso) { return FISHING.days[iso] || null; }

  /** 按需取某天的渔场格点；未启用服务器或 404 时返回 false（调用方按「无数据」处理，不按 0）。 */
  function ensureFishing(iso) {
    if (FISHING.days[iso]) return Promise.resolve(true);
    if (!SERVER.enabled || FISHING.failed[iso]) return Promise.resolve(false);
    if (FISHING.inflight[iso]) return FISHING.inflight[iso];
    const task = fetch(SERVER.base + "/fishing/" + iso, { cache: "no-store" })
      .then(function (response) {
        if (!response.ok) throw new Error("fishing HTTP " + response.status);
        return response.json();
      })
      .then(function (data) {
        FISHING.days[iso] = data && Array.isArray(data.cells) ? data : null;
        return !!FISHING.days[iso];
      })
      .catch(function () { FISHING.failed[iso] = true; FISHING.days[iso] = null; return false; })
      .then(function (ok) { delete FISHING.inflight[iso]; return ok; });
    FISHING.inflight[iso] = task;
    return task;
  }

  // ---- 锋面强度（本项目口径：跨锋面 SST 温差 / 梯度）----
  // 数据集自带的 frontal_intensity 变量尚未下载（43 个分年包约 90 GB，盘不够）；
  // 需求文档 §6.2 把「frontal_intensity 与局地温度梯度」并列为强度因素，
  // 因此这里用「跨锋面温差」作为强度口径，并在界面上始终写明口径，不冒充数据集原变量。
  const KM_PER_DEG_LAT = 111.195;

  function kmPerDegLonAt(lat) {
    return KM_PER_DEG_LAT * Math.max(Math.cos((lat * Math.PI) / 180), 0.01);
  }

  /**
   * 沿锋面线两侧取样求温差。
   * 做法：把折线投影到以折线中点为原点的局部 km 平面 → 在平面里沿法向各偏移 halfKm →
   * 反投影回经纬度 → 用 sstCell 取真实档位温度（不插值）→ 统计温差与梯度。
   */
  function frontIntensity(iso, points, halfKm) {
    const day = SST[iso];
    if (!day || !Array.isArray(points) || points.length < 2) return null;
    const offsetKm = halfKm || 10;
    const mid = points[Math.floor(points.length / 2)];
    const lon0 = mid[0];
    const lat0 = mid[1];
    const kx = kmPerDegLonAt(lat0);
    const project = (p) => [(p[0] - lon0) * kx, (p[1] - lat0) * KM_PER_DEG_LAT];
    const unproject = (x, y) => [lon0 + x / kx, lat0 + y / KM_PER_DEG_LAT];

    const step = Math.max(1, Math.floor(points.length / 12));   // 最多 12 个采样点
    const diffs = [];
    for (let i = 0; i + 1 < points.length; i += step) {
      const a = project(points[i]);
      const b = project(points[i + 1]);
      const tx = b[0] - a[0];
      const ty = b[1] - a[1];
      const len = Math.hypot(tx, ty);
      if (!len) continue;
      const c = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const nx = -ty / len;
      const ny = tx / len;
      const left = unproject(c[0] + nx * offsetKm, c[1] + ny * offsetKm);
      const right = unproject(c[0] - nx * offsetKm, c[1] - ny * offsetKm);
      const tl = OFData.sstCell(iso, left[0], left[1]);
      const tr = OFData.sstCell(iso, right[0], right[1]);
      if (!tl || !tr) continue;
      if (tl.valueC == null || tr.valueC == null) continue;   // 缺测不参与，也不补 0
      diffs.push(Math.abs(tl.valueC - tr.valueC));
    }
    if (!diffs.length) return null;
    const mean = diffs.reduce(function (sum, v) { return sum + v; }, 0) / diffs.length;
    const max = Math.max.apply(null, diffs);
    return {
      available: true,
      metric: "cross_front_sst_difference",
      offsetKm: offsetKm,
      sampleCount: diffs.length,
      meanRangeC: Math.round(mean * 100) / 100,
      maxRangeC: Math.round(max * 100) / 100,
      gradientCPerKm: Math.round((mean / (offsetKm * 2)) * 1000) / 1000,
      note: "口径：锋面线两侧各 " + offsetKm + " km 的 SST 差（数据集 frontal_intensity 未接入）",
    };
  }

  /** 强度分档（展示用；阈值写在界面上，避免被读成官方强度等级）。 */
  function intensityLevel(meanRangeC) {
    if (meanRangeC == null) return { label: "未知", tone: "plain" };
    if (meanRangeC >= 2) return { label: "强", tone: "strong" };
    if (meanRangeC >= 1) return { label: "中", tone: "medium" };
    return { label: "弱", tone: "weak" };
  }

  const OFData = {
    meta: META,
    basemap: BASE,                                  // 1:10m 东海细节（离线兜底档）
    basemapAsia: window.OF_DATA_ASIA || null,       // 1:50m 西太平洋（区域档）
    basemapWorld: window.OF_DATA_WORLD || null,     // 1:110m 全球（球面档）
    clim: CLIM,

    // ---- 服务器增强模式（可选）----
    // 未启用时 serverEnabled() 恒为 false、serverAvailable() 恒为 false、ensureDay() 立即返回 false，
    // 因此离线（file://）行为与既有断言不受影响。
    serverEnabled: serverEnabled,
    serverAvailable: serverAvailable,
    initServerMode: initServerMode,
    ensureDay: ensureDay,

    // ---- 渔场线索（GFW 表观捕捞活动；仅服务器模式可用）----
    fishingAvailable: fishingAvailable,
    fishingDay: fishingDay,
    ensureFishing: ensureFishing,

    // ---- 锋面强度（口径：跨锋面 SST 温差 / 梯度）----
    frontIntensity: frontIntensity,
    intensityLevel: intensityLevel,

    // ---- 日期与可用性 ----
    availableDates: function () { return mergedDates(); },
    firstDate: function () { const all = mergedDates(); return all[0] || null; },
    lastDate: function () { const all = mergedDates(); return all[all.length - 1] || null; },
    // 注意：hasDay 的语义仍是「本地数据已就绪」，服务器上存在但未加载的日期不算 —— 渲染前必须先 ensureDay。
    hasDay: function (iso) { return Object.prototype.hasOwnProperty.call(DAYS, iso); },
    day: function (iso) { return DAYS[iso] || null; },

    // 页面用它决定「有数据 / 没数据」，没数据必须给原因，不给结论
    dateInfo: function (iso) {
      if (!META) {
        return { ok: false, title: "没有数据文件", desc: "data/ 目录里没有生成好的数据，先跑导出脚本（见 README）" };
      }
      if (!SORTED_DATES.length) {
        return { ok: false, title: "没有导出的日期", desc: "data/day/ 下没有文件，先跑 export_prototype_data.py" };
      }
      if (!DAYS[iso]) {
        if (serverAvailable(iso)) {
          return {
            ok: false,
            title: "正在从服务器取这一天",
            desc: "该日期在服务器上有数据，页面会按需加载（加载完成前不给结论）。",
          };
        }
        return {
          ok: false,
          title: "这天没有数据",
          desc: "演示数据只导出了 " + SORTED_DATES[0] + " ~ " + SORTED_DATES[SORTED_DATES.length - 1] +
            "，共 " + SORTED_DATES.length + " 天；数据集本身是逐日的，缺的日期可以按需补导",
        };
      }
      return { ok: true, title: "", desc: "" };
    },

    // ---- 单日真实图层 ----
    grid: function (iso) { return DAYS[iso] ? DAYS[iso].grid : null; },
    sourceFile: function (iso) { return DAYS[iso] ? DAYS[iso].source_file : null; },
    objects: function (iso) { return DAYS[iso] ? DAYS[iso].objects.map(toObject) : []; },
    objectById: function (iso, id) {
      const found = DAYS[iso] ? DAYS[iso].objects.find(function (item) { return item.front_id === id; }) : null;
      return found ? toObject(found) : null;
    },
    // 所有锋面线段（含太短、没进对象列表的），都来自同一天的真实数据
    frontLines: function (iso) { return DAYS[iso] ? DAYS[iso].front_line.slice() : []; },
    objectLineCount: function (iso) { return DAYS[iso] ? DAYS[iso].object_line_count : 0; },
    // 冷暖侧 / 锋面带 / 缺测：逐行 RLE [row, start, count(, code)]，渲染时按 grid 还原成矩形
    bandRuns: function (iso, kind) {
      if (!DAYS[iso]) return [];
      const key = BAND_KIND[kind];
      return key && DAYS[iso][key] ? DAYS[iso][key] : [];
    },
    quality: function (iso) { return DAYS[iso] ? DAYS[iso].quality : null; },

    // 某个经纬度落在哪一种像元里（真实掩码，原样返回，不做任何推测）
    cellInfo: function (iso, lon, lat) {
      const day = DAYS[iso];
      if (!day) return null;
      const grid = day.grid;
      const col = Math.round((lon - grid.lon0) / grid.dlon);
      const row = Math.round((lat - grid.lat0) / grid.dlat);
      if (col < 0 || col >= grid.nx || row < 0 || row >= grid.ny) {
        return { inGrid: false, row: row, col: col, cellLon: null, cellLat: null,
          nodata: false, line: false, code: null, side: null };
      }
      const hit = function (runs) {
        for (let i = 0; i < runs.length; i++) {
          const run = runs[i];
          if (run[0] === row && col >= run[1] && col < run[1] + run[2]) return run;
        }
        return null;
      };
      const band = hit(day.front_band_rle || []);
      const nodata = hit(day.nodata_rle || []);
      const cold = hit(day.cold_side_rle || []);
      const warm = hit(day.warm_side_rle || []);
      return {
        inGrid: true,
        row: row,
        col: col,
        cellLon: Math.round((grid.lon0 + col * grid.dlon) * 1000) / 1000,
        cellLat: Math.round((grid.lat0 + row * grid.dlat) * 1000) / 1000,
        nodata: !!nodata,
        line: !!band,
        code: band && band.length > 3 ? band[3] : null,
        cold: !!cold,
        warm: !!warm,
        side: cold ? "冷侧" : warm ? "暖侧" : null,
      };
    },

    // ---- 海表温度（NOAA GHRSST，0.5 °C 分箱游程；没有导出的日期返回 null） ----
    sstDates: function () { return SST_DATES.slice(); },
    hasSst: function (iso) { return Object.prototype.hasOwnProperty.call(SST, iso); },
    sst: function (iso) { return SST[iso] || null; },
    sstStats: function (iso) { return SST[iso] ? SST[iso].stats : null; },
    sstBinC: function () {
      return (META && META.availability && META.availability.sst && META.availability.sst.bin_c) || 0.5;
    },
    // 某个经纬度落在哪一档海温：直接在真实游程里查，不做插值
    sstCell: function (iso, lon, lat) {
      const day = SST[iso];
      if (!day) return null;
      const g = day.grid;
      const col = Math.round((lon - g.lon0) / g.dlon);
      const row = Math.round((lat - g.lat0) / g.dlat);
      if (col < 0 || col >= g.nx || row < 0 || row >= g.ny) return { inGrid: false, valueC: null, bin: null };
      const runs = day.runs || [];
      for (let i = 0; i < runs.length; i++) {
        const run = runs[i];
        if (run[0] === row && col >= run[1] && col < run[1] + run[2]) {
          return { inGrid: true, valueC: Math.round(run[3] * day.bin_c * 10) / 10, bin: run[3] };
        }
      }
      return { inGrid: true, valueC: null, bin: null };  // 这一格没有有效海温
    },

    // ---- 明确「还没有」的东西：一律返回 false，让界面说清楚 ----
    sstAvailable: function () { return !!(META && META.status && META.status.sst === "real"); },
    intensityAvailable: function () { return !!(META && META.status && META.status.intensity === "real"); },
    forecastAvailable: function () { return !!(META && META.status && META.status.forecast === "real"); },
    seaStateAvailable: function () { return !!(META && META.status && META.status.sea_state === "real"); },
    fishingAvailable: function () { return !!(META && META.status && META.status.fishing_grounds === "real"); },
    frontResponseAvailable: function () {
      return !!(frontResponseStatusReady() && (FRONT_RESPONSE.by_date || FRONT_RESPONSE.events));
    },
    frontResponse: function (iso, rangeKm) {
      if (!frontResponseStatusReady()) return null;
      const day = FRONT_RESPONSE.by_date && FRONT_RESPONSE.by_date[iso];
      if (!day) {
        return normalizeFrontResponse({ status: "not_in_sample", reason: "missing_date" }, iso, rangeKm);
      }
      if (rangeKm != null && day.by_range && day.by_range[String(rangeKm)]) {
        return normalizeFrontResponse(day.by_range[String(rangeKm)], iso, rangeKm);
      }
      if (rangeKm != null) {
        return normalizeFrontResponse({ status: "not_in_sample", reason: "missing_range" }, iso, rangeKm);
      }
      return normalizeFrontResponse(day, iso, rangeKm);
    },
    frontResponseMeta: function () {
      return FRONT_RESPONSE ? {
        schemaVersion: FRONT_RESPONSE.schema_version || null,
        status: FRONT_RESPONSE.status || "not_available",
        source: FRONT_RESPONSE.source || null,
        metric: FRONT_RESPONSE.metric || "apparent_fishing_effort",
        unit: FRONT_RESPONSE.unit || "fishing_hours",
        timeWindow: FRONT_RESPONSE.time_window || null,
        spatialWindow: FRONT_RESPONSE.spatial_window || null,
        method: FRONT_RESPONSE.method || null,
        publicBoundary: FRONT_RESPONSE.public_boundary || null,
        isSynthetic: !!FRONT_RESPONSE.is_synthetic,
        note: FRONT_RESPONSE.note || "",
        generatedAt: FRONT_RESPONSE.generated_at || null,
      } : null;
    },
    climReady: function () { return !!(META && META.availability && META.availability.clim && META.availability.clim.ready && CLIM); },

    // ---- 「依据」页要用的出处信息 ----
    attribution: function () {
      if (!META) return null;
      return {
        name: META.product.name,
        nameZh: META.product.name_zh,
        version: META.product.version,
        doi: META.product.doi,
        url: META.product.url,
        license: META.product.license,
        citation: META.product.citation,
        resolutionDeg: META.product.resolution_deg,
        region: META.region,
        grid: META.grid,
        days: META.availability.days,
        sst: META.availability.sst || null,
        clim: META.availability.clim,
        basemap: META.availability.basemap,
        status: META.status,
        generatedAt: META.generated_at,
        knownIssues: META.known_issues || [],
      };
    },
  };

  window.OFData = OFData;
})();
