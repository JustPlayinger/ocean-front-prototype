import { spawn } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 用法：node tools/e2e-check.mjs   （可用环境变量 EDGE / PAGE 覆盖）
const EDGE = process.env.EDGE || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PAGE = process.env.PAGE || pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "prototype-fishing.html")).href;
const PORT = 9337;
const PROFILE = join(process.env.TEMP || "C:\\temp", "_edge_profile_e2e");
const OUT = process.env.TEMP || "C:\\temp";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}

const child = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, "--window-size=1680,900", PAGE], { stdio: "ignore" });

let wsUrl = null;
for (let i = 0; i < 50 && !wsUrl; i++) {
  await sleep(300);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const t = list.find((x) => x.type === "page" && /prototype-fishing/.test(x.url));
    if (t) wsUrl = t.webSocketDebuggerUrl;
  } catch (e) {}
}
if (!wsUrl) { console.log("FAIL: 未能连接 Edge 调试端口"); child.kill(); process.exit(1); }

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });

let msgId = 0;
const pending = new Map();
const errors = [];
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
  } else if (m.method === "Runtime.exceptionThrown") {
    errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  } else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
    errors.push(m.params.args.map((a) => a.value).join(" "));
  }
});
const send = (method, params = {}) => {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => pending.set(id, { res, rej }));
};

await send("Runtime.enable");
await send("Page.enable");
await sleep(1100);

const evalJS = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: `(function(){ ${expr} })()`, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error("eval 异常: " + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails));
  return r.result.value;
};
const click = (sel) => evalJS(`var n=document.querySelector(${JSON.stringify(sel)}); if(!n) return "NOT_FOUND"; n.click(); return "OK";`);
const setVal = (sel, val) => evalJS(`var n=document.querySelector(${JSON.stringify(sel)}); if(!n) return "NOT_FOUND"; n.value=${JSON.stringify(val)}; n.dispatchEvent(new Event("change",{bubbles:true})); return "OK";`);
const shot = async (name) => {
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT, name), Buffer.from(r.data, "base64"));
};
// 按经纬度把鼠标移到地图上（走真实 mousemove）
const hoverGeo = async (lon, lat) => {
  await evalJS(`var m=document.getElementById("map"), r=m.getBoundingClientRect(), p=screenOf(${lon}, ${lat});
    m.dispatchEvent(new MouseEvent("mousemove",{clientX:r.left+p.x, clientY:r.top+p.y, bubbles:true})); return 1;`);
  await sleep(150);
};
const clickGeo = async (lon, lat) => {
  await evalJS(`var m=document.getElementById("map"), r=m.getBoundingClientRect(), p=screenOf(${lon}, ${lat});
    m.dispatchEvent(new MouseEvent("click",{clientX:r.left+p.x, clientY:r.top+p.y, bubbles:true})); return 1;`);
  await sleep(150);
};
const PROBE = `var b=document.getElementById("mapProbe"), m=document.getElementById("map");
  var rb=b.getBoundingClientRect(), rm=m.getBoundingClientRect();
  return { hidden:b.hidden, text:b.textContent,
    inBounds: rb.left>=rm.left-1 && rb.top>=rm.top-1 && rb.right<=rm.right+1 && rb.bottom<=rm.bottom+1 };`;
const results = [];
const check = (label, cond, detail) => { results.push(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? "  → " + detail : ""}`); };

// ===== 1) 真实数据接进来了 =====
const boot = await evalJS(`var m = OFData.meta, days = OFData.availableDates();
  return { hasAdapter: typeof OFData === "object", doi: m.product.doi, license: m.product.license,
    days: days, status: m.status, grid: OFData.grid(days[0]),
    input: { value: document.getElementById("timeDate").value, min: document.getElementById("timeDate").min, max: document.getElementById("timeDate").max },
    paths: { coast: document.querySelectorAll('#mapSvg path[stroke*="150,200,235"]').length,
      cold: document.querySelectorAll('#mapSvg path[fill="rgba(38,104,178,0.42)"]').length,
      warm: document.querySelectorAll('#mapSvg path[fill="rgba(198,88,58,0.40)"]').length,
      band: document.querySelectorAll('#mapSvg path[fill="rgba(255,236,170,0.5)"]').length,
      nodata: document.querySelectorAll('#mapSvg path[fill="rgba(150,166,182,0.34)"]').length,
      objectLines: document.querySelectorAll('#mapSvg path[stroke="#ffffff"]').length },
    dataObjects: OFData.objects("2024-08-05").length };`);
check("适配层 OFData 已加载且能读到真实数据文件", boot.hasAdapter === true && boot.days.length >= 3, boot.days.join(" / "));
check("数据产品与许可写在页面上（Zenodo 20356239 · CC BY 4.0）",
  boot.doi === "10.5281/zenodo.20356239" && boot.license === "CC BY 4.0", boot.doi + " / " + boot.license);
check("真实图层标成 real，没接的（海温/强度/海况/预报/渔场）标成 not_available",
  boot.status.front_line === "real" && boot.status.sst === "not_available" && boot.status.forecast === "not_available",
  JSON.stringify(boot.status));
check("日期控件范围 = 已导出观测日期，默认落在 2024-08-05",
  boot.input.min === "2024-08-05" && boot.input.max === "2024-08-07" && boot.input.value === "2024-08-05",
  JSON.stringify(boot.input));
check("地图用的是真实底图（海岸线 / 冷暖侧 / 锋面带 / 缺测掩码都画出来了）",
  boot.paths.coast === 1 && boot.paths.cold === 1 && boot.paths.warm === 1 && boot.paths.band === 1 && boot.paths.nodata === 1,
  JSON.stringify(boot.paths));
check("地图上的锋面对象线与数据文件一致（没有手写几何）",
  boot.paths.objectLines === boot.dataObjects, boot.paths.objectLines + " = " + boot.dataObjects);
await shot("shot-1-now.png");

// ===== 2) L0 顶栏：顺序看得见、时间只有一个入口 =====
const top = await evalJS(`return {
  nums: document.querySelectorAll(".topbar .ctx .num").length,
  labels: [].map.call(document.querySelectorAll(".topbar .ctx .ctx-lab"), function(n){ return n.textContent; }),
  dateInputs: document.querySelectorAll(".topbar input[type=date]").length,
  otherInputs: document.querySelectorAll(".topbar input[type=month], .topbar input[type=number]").length,
  hasFamily: !!document.getElementById("familySeg"),
  topText: (document.querySelector(".topbar") || {}).textContent || "",
  rangeBtns: document.querySelectorAll("#rangeSeg button").length };`);
check("顶栏按使用顺序分成 4 组（从哪出发/找多远/找什么鱼/出海日）",
  top.nums === 4 && top.labels.join("|") === "从哪出发|找多远|找什么鱼|出海日", top.nums + " 组 · " + top.labels.join("/"));
check("顶栏没有第二套数据来源开关（观测/预报/气候 已删）",
  top.hasFamily === false && !/观测来源|预报|气候/.test(top.topText), "familySeg 不存在");
check("顶栏只有 1 个日期控件，无 month/number",
  top.dateInputs === 1 && top.otherInputs === 0, JSON.stringify({ date: top.dateInputs, other: top.otherInputs }));
check("找鱼范围 3 档可直接点", top.rangeBtns === 3, "rangeBtns=" + top.rangeBtns);

// ===== 3) 页签分层与默认态 =====
const tabs = await evalJS(`var bs = [].slice.call(document.querySelectorAll("#tabs button"));
  return { n: bs.length,
    primary: bs.filter(function(b){ return b.classList.contains("primary"); }).map(function(b){ return b.dataset.pane; }),
    secondary: bs.filter(function(b){ return b.classList.contains("secondary"); }).map(function(b){ return b.textContent.trim(); }),
    active: document.querySelector("#tabs button.active").dataset.pane,
    paneNow: document.getElementById("pane-now").classList.contains("active") };`);
check("页签 = 现在/未来（主任务）+ 往年同期/依据（支撑）",
  tabs.n === 4 && tabs.primary.join(",") === "now,future" && tabs.secondary.join("/") === "往年同期/依据", JSON.stringify(tabs));
check("默认落在「现在」页", tabs.active === "now" && tabs.paneNow === true, tabs.active);

// ===== 4) L1 结论层（常驻，不随页签消失） =====
const hero = await evalJS(`return {
  verdict: document.getElementById("heroVerdict").textContent,
  line: document.getElementById("heroLine").textContent,
  when: document.getElementById("heroWhen").textContent,
  picks: document.querySelectorAll("#heroPoints .pt").length,
  firstPick: (document.querySelector("#heroPoints .pt") || {}).textContent || "",
  why: document.getElementById("heroWhyBody").textContent };`);
check("结论卡给出三档结论之一（值得去 / 可以看看 / 线索不足）",
  ["值得去", "可以看看", "线索不足"].indexOf(hero.verdict) >= 0, hero.verdict);
check("结论行含把握 / 方位 / 距离 / 开船时间",
  /把握 \d+%/.test(hero.line) && /(正北|东北|正东|东南|正南|西南|正西|西北)/.test(hero.line) &&
  /km/.test(hero.line) && /小时/.test(hero.line), hero.line.slice(0, 70));
check("结论卡写明看的是哪一天、数据是观测",
  /（今天）|（\+\d 天）|（-\d 天）/.test(hero.when) && /观测/.test(hero.when), hero.when);
check("结论卡首选点位指向数据里的真实锋面对象编号",
  hero.picks >= 1 && /F\d{3}/.test(hero.firstPick) && boot.dataObjects > 0, hero.firstPick.replace(/\s+/g, " ").slice(0, 48));
check("「为什么这么判断」列出分项与合计，并说清没算进去的东西",
  /起评分/.test(hero.why) && /合计把握/.test(hero.why) &&
  /数据来源/.test(hero.why) && /没算进去的/.test(hero.why), hero.why.slice(0, 40));

// ===== 5) 现在页（真实观测数据） =====
const now = await evalJS(`var ms = [].slice.call(document.querySelectorAll("#nowMetrics .m")).map(function(n){ return n.textContent; });
  return { ms: ms, scope: document.getElementById("nowScopeTag").textContent,
    sea: document.getElementById("seaList").textContent, seaTag: document.getElementById("seaTag").textContent,
    fronts: document.querySelectorAll("#nowFronts .row").length, frontTag: document.getElementById("nowFrontTag").textContent,
    dataObjects: OFData.objects(document.getElementById("timeDate").value).length,
    coverage: 100 - OFData.quality(document.getElementById("timeDate").value).nodata_percent,
    bodyText: document.body.innerText };`);
check("现在页 4 个指标格（锋面对象 / 最近的锋面 / 你落在 / 数据把握）",
  now.ms.length === 4 && /锋面对象/.test(now.ms[0]) && /把握/.test(now.ms[3]), now.ms.length + " 格");
check("现在页的范围标签跟着「找多远」走，并标出观测覆盖",
  /20 km/.test(now.scope) && /带鱼/.test(now.scope) && new RegExp(now.coverage.toFixed(1) + "%").test(now.scope), now.scope);
check("海况整卡标成「示例数据 · 不参与结论」，并提示以官方预报为准",
  /示例数据/.test(now.seaTag) && /不参与结论/.test(now.seaTag) && /官方海洋预报/.test(now.sea), now.seaTag);
check("现在页的锋面清单行数 = 数据文件里的对象数", now.fronts === now.dataObjects, now.fronts + " = " + now.dataObjects);
const shownCoverage = now.scope.match(/(\d+\.\d)%/);
check("观测覆盖数与数据文件一致（缺测率来自真实掩码）",
  !!shownCoverage && Math.abs(parseFloat(shownCoverage[1]) - now.coverage) < 0.05,
  (shownCoverage ? shownCoverage[1] : "—") + "% vs 数据 " + now.coverage.toFixed(1) + "%");
check("页面不再出现编造的海温数值（只出现「待接入」）",
  !/水温 \d/.test(now.bodyText) && !/海表温度[^。；]{0,8}\d+\.\d/.test(now.bodyText) && !/\d+\.\d °C/.test(now.bodyText),
  "无编造温度");
await shot("shot-2-now-detail.png");

// ===== 6) 未来页：预报没接入就说清楚 =====
await click('#tabs button[data-pane="future"]');
const fut = await evalJS(`return {
  bars: document.querySelectorAll("#futureBars i").length,
  rows: document.querySelectorAll("#futureDays .row").length,
  tag: document.getElementById("futureTag").textContent,
  list: document.getElementById("futureList").textContent,
  days: OFData.availableDates() };`);
check("未来页不再造未来天数（没有柱状图）", fut.bars === 0, "bars=" + fut.bars);
check("未来页写明预报未接入的原因与补数据方向",
  /预报未接入/.test(fut.tag) && /没有可用的锋面预报数据/.test(fut.list) && /持续性基线/.test(fut.list),
  fut.tag + " · " + fut.list.slice(0, 30));
check("未来页改为列出已导出的观测日期（可点）", fut.rows === fut.days.length, fut.rows + " = " + fut.days.length);
const pickDay = await evalJS(`var rows = document.querySelectorAll("#futureDays .row.clickable");
  var d = rows[2].dataset.date; rows[2].click();
  return { d: d, top: document.getElementById("timeDate").value };`);
await sleep(150);
check("点某天 → 顶栏「出海日」同步（全站仍只有一个时间真源）", pickDay.d === pickDay.top, pickDay.d + " = " + pickDay.top);
await shot("shot-3-future.png");
await evalJS(`document.getElementById("datePrev").click(); document.getElementById("datePrev").click(); return 1;`);
check("「出海日」◀ 按天回退", (await evalJS(`return document.getElementById("timeDate").value;`)) === "2024-08-05", "回到 2024-08-05");

// ===== 7) 往年同期（真实多年度统计，页内没有日期控件） =====
await click('#tabs button[data-pane="clim"]');
const clim = await evalJS(`var data = OFData.clim;
  return { inputs: document.querySelectorAll("#pane-clim input").length,
    btns: [].map.call(document.querySelectorAll("#climPeriod button"), function(b){ return b.textContent.trim(); }),
    bars: document.querySelectorAll("#climBars i").length,
    hint: document.getElementById("climHint").textContent,
    stat: document.getElementById("climStat").textContent,
    years: document.getElementById("climYears").textContent,
    method: data.method, sample: data.sample_note,
    daySamples: data.by_day["08-05"].by_range["20"].days,
    yearCount: Object.keys(data.by_year).length,
    missingMarked: [].slice.call(document.querySelectorAll("#climBars i")).some(function(b){ return /缺测/.test(b.getAttribute("title") || ""); }),
    note: (document.querySelector("#pane-clim .hint") || {}).textContent || "" };`);
check("往年同期页没有任何日期输入框（锚点跟着顶栏出海日）",
  clim.inputs === 0 && /出海日/.test(clim.note), "inputs=" + clim.inputs);
check("时段只有 3 个按钮：这一天 / 这三天 / 这个月",
  clim.btns.join("/") === "这一天/这三天/这个月", clim.btns.join("/"));
check("「这一天」柱数 = 数据里覆盖的全部年份（缺样本的那年也留着并标「缺测」）",
  clim.bars === clim.yearCount && clim.missingMarked === true,
  clim.bars + " 柱 / " + clim.yearCount + " 年 · 缺测标注=" + clim.missingMarked);
check("写明口径（比例 + 样本数）与唯一算法口径",
  /比例/.test(clim.stat) && /%/.test(clim.stat) && /年份样本/.test(clim.stat) && /front_present/.test(clim.years),
  clim.stat.slice(0, 46));
check("写明抽样口径（实际取样天数）", /实际取样 \d+ 天/.test(clim.sample), clim.sample.slice(-30));
await shot("shot-4-clim.png");

const climPeriod = await evalJS(`document.querySelector('#climPeriod button[data-period="period"]').click();
  return { bars: document.querySelectorAll("#climBars i").length,
    stat: document.getElementById("climStat").textContent, years: document.getElementById("climYears").textContent };`);
check("「这三天」按年份给占比，并说明为什么要看大半径",
  climPeriod.bars === clim.yearCount && /100 km/.test(climPeriod.stat) && /为什么看 100 km/.test(climPeriod.years),
  climPeriod.stat.slice(0, 40));
const climMonth = await evalJS(`document.querySelector('#climPeriod button[data-period="month"]').click();
  return { bars: document.querySelectorAll("#climBars i").length,
    stat: document.getElementById("climStat").textContent, hint: document.getElementById("climHint").textContent };`);
check("「这个月」样本不够就直说，不编整月数字",
  climMonth.bars === 0 && /算不出「整月」/.test(climMonth.stat) && /样本不足/.test(climMonth.hint), climMonth.hint);
await evalJS(`document.querySelector('#climPeriod button[data-period="day"]').click(); return 1;`);

// ===== 8) 依据页 =====
await click('#tabs button[data-pane="basis"]');
const basis = await evalJS(`return {
  data: document.querySelectorAll("#basisData .tr").length,
  rules: document.querySelectorAll("#basisRules .row").length,
  limits: document.querySelectorAll("#basisLimits .row").length,
  dataText: document.getElementById("basisData").textContent,
  rulesText: document.getElementById("basisRules").textContent,
  limitsText: document.getElementById("basisLimits").textContent };`);
check("依据页：数据来源至少 12 行 / 算法 6 条 / 局限不少于 6 条",
  basis.data >= 12 && basis.rules === 6 && basis.limits >= 6,
  JSON.stringify({ data: basis.data, rules: basis.rules, limits: basis.limits }));
check("数据来源写清产品、许可与底图出处",
  /zenodo\.20356239/.test(basis.dataText) && /CC BY 4\.0/.test(basis.dataText) &&
  /Natural Earth/.test(basis.dataText), "DOI / 许可 / 底图都有了");
check("算法说明给出口径（起评分 / 观测覆盖 / front_present）",
  /起评分/.test(basis.rulesText) && /观测覆盖/.test(basis.rulesText) && /front_present/.test(basis.rulesText), "ok");
check("局限里逐条写明没接入的东西（海温 / 强度 / 海况 / 预报 / 渔场 / -128 语义）",
  /-128/.test(basis.limitsText) && /海表温度/.test(basis.limitsText) && /海况/.test(basis.limitsText) &&
  /预报/.test(basis.limitsText), basis.limitsText.slice(0, 40));
check("局限里提示底图精度与国内发布的审图号要求",
  /Natural Earth/.test(basis.limitsText) && /审图号/.test(basis.limitsText), "ok");
await shot("shot-5-basis.png");
await click('#tabs button[data-pane="now"]');

// ===== 9) 指针查询：指到哪，就显示那里的真实数据 =====
// 找一个真实存在锋面线的像元（从数据里取，不猜坐标）
const bandPoint = await evalJS(`var day = OFData.day("2024-08-05"), g = day.grid, run = day.front_band_rle[0];
  return { lon: g.lon0 + (run[1] + Math.floor(run[2] / 2)) * g.dlon, lat: g.lat0 + run[0] * g.dlat,
    code: run[3] };`);
await hoverGeo(bandPoint.lon, bandPoint.lat);
const p1 = await evalJS(PROBE);
check("鼠标移到锋面线像元 → 浮层给出坐标与「锋面线（编码 x）」",
  p1.hidden === false && /\d+\.\d+°E, \d+\.\d+°N/.test(p1.text) && /锋面线（编码/.test(p1.text), p1.text.slice(0, 30));
check("浮层里的编码与数据文件里的编码一致", p1.text.indexOf("编码 " + bandPoint.code) >= 0,
  "数据 " + bandPoint.code + " / 浮层 " + (p1.text.match(/编码 (-?\d+)/) || [])[1]);
check("浮层含离你多远 / 最近锋面 / 侧别 / 待接入的海温",
  /离你/.test(p1.text) && /最近的锋面/.test(p1.text) && /侧别/.test(p1.text) && /海表温度/.test(p1.text) && /待接入/.test(p1.text),
  "四项齐全");
check("浮层不会跑出地图边界", p1.inBounds === true, String(p1.inBounds));
await shot("shot-6-probe.png");

// 缺测像元（陆地 / 云）：必须只说没观测，不给数值
const noDataPoint = await evalJS(`var day = OFData.day("2024-08-05"), g = day.grid, best = null;
  day.nodata_rle.forEach(function(r){ var d = Math.pow(r[0]-g.ny/2,2) + Math.pow(r[1]-g.nx/2,2);
    if (!best || d < best.d) best = { d: d, row: r[0], col: r[1] }; });
  return { lon: g.lon0 + best.col * g.dlon, lat: g.lat0 + best.row * g.dlat };`);
await hoverGeo(noDataPoint.lon, noDataPoint.lat);
const p2 = await evalJS(PROBE);
check("鼠标移到没有观测的像元 → 直说没有观测数据，不给任何数值",
  /没有观测数据/.test(p2.text) && !/离你/.test(p2.text) && !/待接入/.test(p2.text), p2.text.slice(0, 30));

// 钉住 / 取消 / Esc
await hoverGeo(bandPoint.lon, bandPoint.lat);
await clickGeo(bandPoint.lon, bandPoint.lat);
const pin1 = await evalJS(PROBE);
const pinTxt = pin1.text;
check("点一下就钉住（浮层留在原地）", pin1.hidden === false && /钉住/.test(pin1.text), pinTxt.slice(0, 22));
await hoverGeo(noDataPoint.lon, noDataPoint.lat);
const pin2 = await evalJS(PROBE);
check("钉住后鼠标乱动不会改掉浮层", pin2.text === pinTxt, pin2.text === pinTxt ? "内容保持不变" : "被改掉了");
await shot("shot-7-pinned.png");
await clickGeo(bandPoint.lon, bandPoint.lat);
check("再点同一个点 → 取消钉住", (await evalJS(PROBE)).hidden === true, "已取消");
await clickGeo(noDataPoint.lon, noDataPoint.lat);
await evalJS(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return 1;`);
check("Esc 取消钉住", (await evalJS(PROBE)).hidden === true, "已取消");

// ===== 10) 选中回执：点了谁、怎么取消 =====
const pick = await evalJS(`var pt = document.querySelector("#heroPoints .pt"); var id = pt.dataset.id; pt.click();
  return { id: id, hidden: document.getElementById("mapPick").hidden,
    name: document.getElementById("pickName").textContent,
    body: document.getElementById("pickBody").textContent,
    x: document.getElementById("pickClose").textContent.trim(),
    dimmed: [].slice.call(document.querySelectorAll("#mapSvg *")).filter(function(n){ return n.getAttribute("opacity") === "0.16"; }).length };`);
await sleep(150);
check("点结论卡点位 → 地图上出现「选中回执」卡（标题是真实对象编号）",
  pick.hidden === false && pick.name.indexOf(pick.id) >= 0, pick.name + " · " + pick.body.slice(0, 24));
check("回执卡给出长度 / 距离 / 侧别（都来自数据）",
  /长 \d+ km/.test(pick.body) && /离你/.test(pick.body) && /你在/.test(pick.body), pick.body.slice(0, 36));
check("选中后地图上其它对象被压暗", pick.dimmed > 0, "dimmed=" + pick.dimmed);
check("回执卡带 ✕ 可以取消", pick.x === "✕", pick.x);
await shot("shot-8-pick.png");
await click("#pickClose");
const pickOff = await evalJS(`return { hidden: document.getElementById("mapPick").hidden,
  dimmed: [].slice.call(document.querySelectorAll("#mapSvg *")).filter(function(n){ return n.getAttribute("opacity") === "0.16"; }).length };`);
check("点 ✕ → 取消选中并恢复地图", pickOff.hidden === true && pickOff.dimmed === 0, JSON.stringify(pickOff));

// ===== 11) 图层开关真实重绘 =====
const layer = await evalJS(`function cnt(sel){ return document.querySelectorAll(sel).length; }
  var band = document.querySelector('.legend-row[data-layer="band"]');
  band.click(); var bandOff = cnt('#mapSvg path[fill="rgba(255,236,170,0.5)"]');
  band.click(); var bandOn = cnt('#mapSvg path[fill="rgba(255,236,170,0.5)"]');
  var nod = document.querySelector('.legend-row[data-layer="nodata"]');
  nod.click(); var nodOff = cnt('#mapSvg path[fill="rgba(150,166,182,0.34)"]');
  nod.click(); var nodOn = cnt('#mapSvg path[fill="rgba(150,166,182,0.34)"]');
  return { bandOff: bandOff, bandOn: bandOn, nodOff: nodOff, nodOn: nodOn };`);
check("锋面带 / 缺测图层开关都真实重绘",
  layer.bandOff === 0 && layer.bandOn === 1 && layer.nodOff === 0 && layer.nodOn === 1, JSON.stringify(layer));

// ===== 12) 鱼种切换：侧别评分真的用数据里的冷暖侧掩码 =====
const species = await evalJS(`var s = document.getElementById("speciesSel"), out = [];
  for (var i = 0; i < s.options.length; i++) {
    s.value = s.options[i].value; s.dispatchEvent(new Event("change", { bubbles: true }));
    out.push(s.value + ":" + document.querySelectorAll("#nowMetrics .m")[3].textContent.replace(/[^0-9]/g, ""));
  }
  var cell = OFData.cellInfo(document.getElementById("timeDate").value, 124.5, 30.2);
  return { out: out, side: cell ? cell.side : null };`);
const scores = new Set(species.out.map((x) => x.split(":")[1]));
check(species.side ? "切换鱼种会改变把握（侧别评分用了数据里的冷暖侧）"
  : "定位点不在冷暖侧时各鱼种把握一致（侧别项如实为 0，没有编造偏好）",
  species.side ? scores.size > 1 : scores.size === 1, (species.side || "锋区外") + " · " + species.out.join(" | "));
await setVal("#speciesSel", "hairtail");

// ===== 13) 找鱼范围 =====
const r10 = await evalJS(`document.querySelector('#rangeSeg button[data-range="10"]').click();
  return { scope: document.getElementById("nowScopeTag").textContent, line: document.getElementById("heroLine").textContent,
    tag: document.getElementById("nowFrontTag").textContent };`);
check("找鱼范围 10 km 生效（真源驱动，清单也跟着变）",
  /10 km/.test(r10.scope) && /10 km/.test(r10.line) && /范围内/.test(r10.tag), r10.tag.slice(0, 30));
await shot("shot-9-range10.png");
await evalJS(`document.querySelector('#rangeSeg button[data-range="30"]').click(); return 1;`);
const r30 = await evalJS(`return document.getElementById("nowScopeTag").textContent;`);
check("找鱼范围 30 km 生效", /30 km/.test(r30), r30.slice(0, 30));
await evalJS(`document.querySelector('#rangeSeg button[data-range="20"]').click(); return 1;`);

// ===== 14) 日期越界被钳制（范围就是已导出的观测日期） =====
const clampHi = await evalJS(`var n = document.getElementById("timeDate"); n.value = "2024-12-01";
  n.dispatchEvent(new Event("change", { bubbles: true })); return n.value;`);
check("日期超出已导出范围 → 收敛到上限 2024-08-07", clampHi === "2024-08-07", clampHi);
const clampLo = await evalJS(`var n = document.getElementById("timeDate"); n.value = "2019-01-01";
  n.dispatchEvent(new Event("change", { bubbles: true })); return n.value;`);
check("日期早于导出起点 → 收敛到下限 2024-08-05", clampLo === "2024-08-05", clampLo);
const noData = await evalJS(`return OFData.dateInfo("2024-08-04");`);
check("没导出的日期给出明确原因与可选范围（不是空图）",
  noData.ok === false && /这天没有数据/.test(noData.title) && /2024-08-05/.test(noData.desc), noData.desc.slice(0, 40));

// ===== 15) 键盘可达性 =====
const kb = await evalJS(`var b = document.querySelector('#tabs button[data-pane="now"]'); b.focus();
  b.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  return document.getElementById("pane-future").classList.contains("active");`);
check("方向键可切换页签（可访问性）", kb === true, String(kb));
await click('#tabs button[data-pane="now"]');

// ===== 16) 运行期异常 =====
check("无运行期 JS 异常（含资源加载失败）", errors.length === 0, errors.slice(0, 3).join(" || ") || "none");

console.log(results.join("\n"));
console.log("\nFAIL 总数 = " + results.filter((r) => r.startsWith("FAIL")).length + " / " + results.length);
ws.close();
child.kill();
process.exit(0);
