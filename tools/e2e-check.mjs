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
await sleep(800);

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
const results = [];
const check = (label, cond, detail) => { results.push(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? "  → " + detail : ""}`); };

// 1) 默认态：结论卡 + 现在页
const hero = await evalJS(`return {
  verdict: document.getElementById("heroVerdict").textContent,
  line: document.getElementById("heroLine").textContent,
  picks: document.querySelectorAll("#heroPoints .pt").length,
  firstPick: (document.querySelector("#heroPoints .pt small")||{}).textContent || "",
  metrics: document.querySelectorAll("#nowMetrics .m").length,
  fronts: document.querySelectorAll("#nowFronts .row").length,
  scope: document.getElementById("nowScopeTag").textContent,
  stamp: document.getElementById("dataStamp").textContent,
  emptyHidden: document.getElementById("nowEmpty").hidden,
  mapEmptyHidden: document.getElementById("mapEmpty").hidden
};`);
check("默认结论卡有结论", /可出海|谨慎出海|暂缓出海/.test(hero.verdict), hero.verdict);
check("结论行含方位/距离/航时", /km/.test(hero.line) && /航时/.test(hero.line), hero.line.slice(0, 70));
check("首选点位列表非空", hero.picks >= 1, "picks=" + hero.picks + " | " + String(hero.firstPick).slice(0, 50));
check("关键指标 4 格", hero.metrics === 4, "metrics=" + hero.metrics);
check("范围内锋面列表 3 条", hero.fronts === 3, "fronts=" + hero.fronts);
check("半径/鱼种标签与真源一致", hero.scope.indexOf("20 km") >= 0 && hero.scope.indexOf("带鱼") >= 0, hero.scope);
check("时次标识存在", /观测/.test(hero.stamp), hero.stamp);
check("无数据提示默认隐藏", hero.emptyHidden === true && hero.mapEmptyHidden === true);
await shot("shot-1-now.png");

// 2) 时间真源唯一性
const dupCtrl = await evalJS(`return {
  month: document.querySelectorAll("#topbar input[type=month]").length,
  number: document.querySelectorAll("#topbar input[type=number]").length,
  date: document.querySelectorAll("#topbar input[type=date]").length,
  segButtons: document.querySelectorAll("#topbar .seg button").length
};`);
check("顶栏无 month/number 时间控件（消除双轨）", dupCtrl.month === 0 && dupCtrl.number === 0, JSON.stringify(dupCtrl));
check("顶栏唯一日期控件 + 6 个分段按钮", dupCtrl.date === 1 && dupCtrl.segButtons === 6, JSON.stringify(dupCtrl));

// 3) 页签层级
const tabs = await evalJS(`var b=[].slice.call(document.querySelectorAll("#tabs button")); return {
  primary: b.filter(function(x){return x.classList.contains("primary");}).map(function(x){return x.textContent.trim();}),
  secondary: b.filter(function(x){return x.classList.contains("secondary");}).map(function(x){return x.textContent.trim();}),
  active: b.filter(function(x){return x.classList.contains("active");}).map(function(x){return x.textContent.trim();})
};`);
check("主任务页签为「现在/未来」", JSON.stringify(tabs.primary) === JSON.stringify(["现在", "未来"]), JSON.stringify(tabs.primary));
check("支撑页签为「规律/依据」", JSON.stringify(tabs.secondary) === JSON.stringify(["规律", "依据"]), JSON.stringify(tabs.secondary));
check("默认落在主任务「现在」", JSON.stringify(tabs.active) === JSON.stringify(["现在"]), JSON.stringify(tabs.active));

// 4) 未来页
await click('#tabs button[data-pane="future"]');
const fut = await evalJS(`return {
  active: document.getElementById("pane-future").classList.contains("active"),
  nowOff: !document.getElementById("pane-now").classList.contains("active"),
  days: document.querySelectorAll("#futureDays .row").length,
  bars: document.querySelectorAll("#futureBars i").length,
  tag: document.getElementById("futureTag").textContent,
  best: document.getElementById("futureBestTag").textContent
};`);
check("页签切换互斥显示", fut.active && fut.nowOff, JSON.stringify({ active: fut.active, nowOff: fut.nowOff }));
check("未来 1/3/7 天口径", /1 天 \d+% · 3 天 \d+% · 7 天 \d+%/.test(fut.tag), fut.tag);
check("逐日 7 天列表与柱图", fut.days === 7 && fut.bars === 7, "days=" + fut.days + " bars=" + fut.bars);
check("最佳窗口标签", /最佳窗口/.test(fut.best), fut.best);
await shot("shot-2-future.png");

// 5) 规律页
await click('#tabs button[data-pane="clim"]');
const clim = await evalJS(`return {
  bars: document.querySelectorAll("#climBars i").length,
  stat: document.getElementById("climStat").textContent,
  lines: document.querySelectorAll("#climYears .line").length,
  anchors: [].slice.call(document.querySelectorAll("#climAnchor input")).filter(function(n){return n.style.display!=="none";}).length,
  hasAnomaly: /偏离/.test(document.getElementById("climYears").textContent)
};`);
check("按月 12 柱", clim.bars === 12, "bars=" + clim.bars);
check("出现率统一口径文案", /统一口径/.test(clim.stat), clim.stat.slice(0, 46));
check("多年同期与异常提示", clim.hasAnomaly && clim.lines >= 6, "lines=" + clim.lines);
check("规律页仅 1 个时间锚点控件", clim.anchors === 1, "anchors=" + clim.anchors);
const climY = await evalJS(`document.querySelector('#climPeriod button[data-period="year"]').click();
  return { bars: document.querySelectorAll("#climBars i").length, hint: document.getElementById("climHint").textContent,
           anchors: [].slice.call(document.querySelectorAll("#climAnchor input")).filter(function(n){return n.style.display!=="none";}).length };`);
check("按年切换生效（柱数/锚点联动）", /按年/.test(climY.hint) && climY.bars === 7 && climY.anchors === 1, JSON.stringify(climY));
await shot("shot-3-clim.png");

// 6) 依据页
await click('#tabs button[data-pane="basis"]');
const basis = await evalJS(`return {
  data: document.querySelectorAll("#basisData .tr").length,
  rules: document.querySelectorAll("#basisRules .row").length,
  limits: document.querySelectorAll("#basisLimits .row").length
};`);
check("依据页：数据来源/规则/局限齐备", basis.data === 7 && basis.rules === 6 && basis.limits === 4, JSON.stringify(basis));
await shot("shot-4-basis.png");

// 7) 选择态：点击首选点位 → 地图高亮压暗
await click('#tabs button[data-pane="now"]');
const before = await evalJS(`return document.querySelectorAll("#mapSvg [opacity='0.14']").length;`);
await click("#heroPoints .pt");
const after = await evalJS(`return {
  dimmed: document.querySelectorAll("#mapSvg [opacity='0.14']").length,
  ptActive: document.querySelectorAll("#heroPoints .pt.active").length
};`);
check("点击点位触发地图高亮压暗", after.dimmed > before, "dimmed " + before + " → " + after.dimmed);
check("点位与地图共用同一选中态", after.ptActive >= 1, JSON.stringify(after));

// 8) 鱼种切换影响结论
const sp = await evalJS(`var s=document.getElementById("speciesSel"); var out=[];
  for (var i=0;i<s.options.length;i++){ s.value=s.options[i].value; s.dispatchEvent(new Event("change",{bubbles:true}));
    out.push(s.value+":"+document.getElementById("heroVerdict").textContent+"/"+document.querySelectorAll("#nowMetrics .m")[3].textContent.replace(/[^0-9]/g,"")); }
  return out;`);
check("切换鱼种改变可能度/结论", new Set(sp.map((x) => x.split(":")[1])).size > 1, sp.join(" | "));
await setVal("#speciesSel", "hairtail");

// 9) 半径切换
const r10 = await evalJS(`document.querySelector('#rangeSeg button[data-range="10"]').click();
  return { scope: document.getElementById("nowScopeTag").textContent, tag: document.getElementById("nowFrontTag").textContent, href: document.getElementById("heroLine").textContent };`);
check("半径 10 km 生效（真源驱动）", r10.scope.indexOf("10 km") >= 0, JSON.stringify({ scope: r10.scope, tag: r10.tag }));
await shot("shot-5-range10.png");
await evalJS(`document.querySelector('#rangeSeg button[data-range="20"]').click(); return 1;`);

// 10) 空态
await setVal("#timeDate", "2024-01-05");
const empty = await evalJS(`return {
  mapEmpty: !document.getElementById("mapEmpty").hidden,
  title: document.getElementById("mapEmptyTitle").textContent,
  desc: document.getElementById("mapEmptyDesc").textContent,
  nowEmpty: !document.getElementById("nowEmpty").hidden,
  verdict: document.getElementById("heroVerdict").textContent
};`);
check("超覆盖时次触发地图+面板空态", empty.mapEmpty && empty.nowEmpty, JSON.stringify({ mapEmpty: empty.mapEmpty, nowEmpty: empty.nowEmpty }));
check("空态说明原因且不编造结论", empty.verdict === "无数据" && /覆盖/.test(empty.desc), empty.title + " / " + empty.desc.slice(0, 46));
await shot("shot-6-empty.png");

// 11) 时间族：预报为滚动窗口，自动收敛到有效时次并恢复数据
await evalJS(`document.querySelector('#familySeg button[data-family="fcst"]').click(); return 1;`);
const fcstOk = await evalJS(`return { hidden: document.getElementById("mapEmpty").hidden,
  date: document.getElementById("timeDate").value, stamp: document.getElementById("dataStamp").textContent };`);
check("切到预报族自动收敛时次并恢复数据", fcstOk.hidden === true && fcstOk.date === "2024-08-05", JSON.stringify(fcstOk));
await evalJS(`document.querySelector('#familySeg button[data-family="obs"]').click(); return 1;`);

// 12) 日期步进
const step = await evalJS(`document.getElementById("dateNext").click();
  return { date: document.getElementById("timeDate").value, stamp: document.getElementById("dataStamp").textContent };`);
check("时间条 ▶ 步进生效", step.date === "2024-08-06", JSON.stringify(step));
await evalJS(`document.getElementById("datePrev").click(); return 1;`);

// 13) 图层开关真实重绘
const layer = await evalJS(`var r=document.querySelector('.legend-row[data-layer="sst"]'); r.click();
  var off = document.querySelectorAll("#mapSvg rect").length; r.click();
  var on = document.querySelectorAll("#mapSvg rect").length; return { off: off, on: on };`);
check("图层开关真实重绘", layer.off === 0 && layer.on === 1, JSON.stringify(layer));

// 14) 键盘可达性
const kb = await evalJS(`var b=document.querySelector('#tabs button[data-pane="now"]'); b.focus();
  b.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true}));
  return document.getElementById("pane-future").classList.contains("active");`);
check("方向键可切换页签（可访问性）", kb === true, String(kb));

// 15) 运行期异常
check("无运行期 JS 异常", errors.length === 0, errors.slice(0, 3).join(" || ") || "none");

console.log(results.join("\n"));
console.log("\nFAIL 总数 = " + results.filter((r) => r.indexOf("FAIL") === 0).length);
ws.close();
child.kill();
process.exit(0);


