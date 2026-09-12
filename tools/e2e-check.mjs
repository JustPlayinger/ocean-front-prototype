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
await sleep(900);

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
// 在地图上按"地图宽高的比例"模拟鼠标移动（走真实 mousemove 事件）
const hoverMap = async (fx, fy) => {
  await evalJS(`var m=document.getElementById("map"), r=m.getBoundingClientRect();
    m.dispatchEvent(new MouseEvent("mousemove",{clientX:r.left+r.width*${fx}, clientY:r.top+r.height*${fy}, bubbles:true})); return 1;`);
  await sleep(140);
};
const clickMap = async (fx, fy) => {
  await evalJS(`var m=document.getElementById("map"), r=m.getBoundingClientRect();
    m.dispatchEvent(new MouseEvent("click",{clientX:r.left+r.width*${fx}, clientY:r.top+r.height*${fy}, bubbles:true})); return 1;`);
  await sleep(140);
};
const PROBE = `var b=document.getElementById("mapProbe"), m=document.getElementById("map");
  var rb=b.getBoundingClientRect(), rm=m.getBoundingClientRect();
  return { hidden:b.hidden, text:b.textContent,
    inBounds: rb.left>=rm.left-1 && rb.top>=rm.top-1 && rb.right<=rm.right+1 && rb.bottom<=rm.bottom+1 };`;
const results = [];
const check = (label, cond, detail) => { results.push(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? "  → " + detail : ""}`); };

// ===== 1) L0 顶栏：顺序看得见、时间只有一个入口 =====
const top = await evalJS(`return {
  nums: document.querySelectorAll(".topbar .ctx .num").length,
  labels: [].map.call(document.querySelectorAll(".topbar .ctx .ctx-lab"), function(n){ return n.textContent; }),
  dateInputs: document.querySelectorAll(".topbar input[type=date]").length,
  otherInputs: document.querySelectorAll(".topbar input[type=month], .topbar input[type=number]").length,
  hasFamily: !!document.getElementById("familySeg"),
  topText: (document.querySelector(".topbar") || {}).textContent || "",
  rangeBtns: document.querySelectorAll("#rangeSeg button").length
};`);
check("顶栏按使用顺序分成 4 组（从哪出发/找多远/找什么鱼/出海日）",
  top.nums === 4 && top.labels.join("|") === "从哪出发|找多远|找什么鱼|出海日", top.nums + " 组 · " + top.labels.join("/"));
check("顶栏已删掉「观测/预报/气候」三档（时间入口唯一）",
  top.hasFamily === false && !/观测|预报|气候/.test(top.topText), "familySeg 不存在");
check("顶栏只有 1 个日期控件，无 month/number",
  top.dateInputs === 1 && top.otherInputs === 0, JSON.stringify({ date: top.dateInputs, other: top.otherInputs }));
check("找鱼范围仍是 3 档并可直接点", top.rangeBtns === 3, "rangeBtns=" + top.rangeBtns);

// ===== 2) 页签分层与默认态 =====
const tabs = await evalJS(`var bs = [].slice.call(document.querySelectorAll("#tabs button"));
  return { n: bs.length,
    primary: bs.filter(function(b){ return b.classList.contains("primary"); }).map(function(b){ return b.dataset.pane; }),
    secondary: bs.filter(function(b){ return b.classList.contains("secondary"); }).map(function(b){ return b.textContent.trim(); }),
    active: document.querySelector("#tabs button.active").dataset.pane,
    paneNow: document.getElementById("pane-now").classList.contains("active") };`);
check("页签 = 现在/未来（主任务）+ 往年同期/依据（支撑）",
  tabs.n === 4 && tabs.primary.join(",") === "now,future" && tabs.secondary.join("/") === "往年同期/依据", JSON.stringify(tabs));
check("默认落在「现在」页", tabs.active === "now" && tabs.paneNow === true, tabs.active);

// ===== 3) L1 结论层（常驻，不随页签消失） =====
const hero = await evalJS(`return {
  verdict: document.getElementById("heroVerdict").textContent,
  line: document.getElementById("heroLine").textContent,
  when: document.getElementById("heroWhen").textContent,
  picks: document.querySelectorAll("#heroPoints .pt").length,
  why: document.getElementById("heroWhyBody").textContent
};`);
check("结论卡给出三档结论之一", ["可以出海", "谨慎出海", "别出海"].indexOf(hero.verdict) >= 0, hero.verdict);
check("结论行含把握 / 方位 / 距离 / 开船时间",
  /把握 \d+%/.test(hero.line) && /(正北|东北|正东|东南|正南|西南|正西|西北)/.test(hero.line) &&
  /km/.test(hero.line) && /小时/.test(hero.line), hero.line.slice(0, 64));
check("结论卡写明看的是哪一天、用的观测还是预报",
  /(今天|天后|天前)/.test(hero.when) && /(观测|预报)/.test(hero.when), hero.when);
check("结论卡给出首选点位（可点击）", hero.picks >= 1, "picks=" + hero.picks);
check("「为什么这么判断」列出分项与合计",
  /起评分/.test(hero.why) && /合计把握/.test(hero.why), hero.why.slice(0, 44));
await shot("shot-1-now.png");

// ===== 4) 现在页（观测数据） =====
const now = await evalJS(`var ms = [].slice.call(document.querySelectorAll("#nowMetrics .m")).map(function(n){ return n.textContent; });
  return { ms: ms, scope: document.getElementById("nowScopeTag").textContent,
    sea: document.getElementById("seaList").textContent, seaTag: document.getElementById("seaTag").textContent,
    fronts: document.querySelectorAll("#nowFronts .row").length, frontTag: document.getElementById("nowFrontTag").textContent };`);
check("现在页 4 个指标格（水温 / 最近锋面 / 你在哪侧 / 把握）",
  now.ms.length === 4 && /水温/.test(now.ms[0]) && /把握/.test(now.ms[3]), now.ms.length + " 格");
check("现在页的范围标签跟着「找多远」走", /20 km/.test(now.scope) && /带鱼/.test(now.scope), now.scope);
check("天气与海况写清风力/浪高与出海标准",
  /风力 \d 级/.test(now.sea) && /浪高/.test(now.sea) && /≤1.5 m/.test(now.sea), now.seaTag);
check("现在页列出 3 条锋面", now.fronts === 3, now.frontTag);
await shot("shot-2-now-detail.png");

// ===== 5) 未来页（预报数据） =====
await click('#tabs button[data-pane="future"]');
const fut = await evalJS(`return {
  bars: document.querySelectorAll("#futureBars i").length,
  rows: document.querySelectorAll("#futureDays .row").length,
  best: document.getElementById("futureBestTag").textContent,
  list: document.getElementById("futureList").textContent,
  activeRow: (document.querySelector("#futureDays .row.active") || {}).textContent || ""
};`);
check("未来页 7 根柱 + 7 行逐日", fut.bars === 7 && fut.rows === 7, fut.bars + " 柱 / " + fut.rows + " 行");
check("未来页给出「最好的一天」", /最好的一天：\d+ 月 \d+ 日 · \d+%/.test(fut.best), fut.best);
check("未来页保留 1/3/7 天三行说明", /1 天后/.test(fut.list) && /3 天后/.test(fut.list) && /7 天后/.test(fut.list), "ok");
check("当前出海日那一行标成选中态", /今天/.test(fut.activeRow), fut.activeRow.slice(0, 22));
await shot("shot-3-future.png");

// 点未来某一天 → 顶栏「出海日」跟着变（全站只有一个时间真源）
const pickDay = await evalJS(`var rows = document.querySelectorAll("#futureDays .row.clickable");
  var d = rows[2].dataset.date; rows[2].click();
  return { d: d, top: document.getElementById("timeDate").value };`);
await sleep(150);
check("点未来某一天 → 顶栏「出海日」同步", pickDay.d === pickDay.top, pickDay.d + " = " + pickDay.top);
const back = await evalJS(`document.getElementById("datePrev").click(); document.getElementById("datePrev").click();
  return document.getElementById("timeDate").value;`);
check("「出海日」◀ 按天回退", back === "2024-08-05", back);

// ===== 6) 往年同期（页内不再有日期控件） =====
await click('#tabs button[data-pane="clim"]');
const clim = await evalJS(`return {
  inputs: document.querySelectorAll("#pane-clim input").length,
  btns: [].map.call(document.querySelectorAll("#climPeriod button"), function(b){ return b.textContent.trim(); }),
  bars: document.querySelectorAll("#climBars i").length,
  hint: document.getElementById("climHint").textContent,
  stat: document.getElementById("climStat").textContent,
  years: document.getElementById("climYears").textContent,
  note: (document.querySelector("#pane-clim .hint") || {}).textContent || ""
};`);
check("往年同期页没有任何日期输入框（锚点跟着顶栏出海日）",
  clim.inputs === 0 && /出海日/.test(clim.note), "inputs=" + clim.inputs);
check("时段只有 3 个按钮：这一天 / 这个月 / 这一年",
  clim.btns.join("/") === "这一天/这个月/这一年", clim.btns.join("/"));
check("「这个月」给出当月逐日柱（31 根）", clim.bars === 31, "bars=" + clim.bars);
check("写清说法（有锋面的把握 + 同类平均）",
  /有锋面的把握/.test(clim.stat) && /平均/.test(clim.stat), clim.stat.slice(0, 40));
check("「和往年比」给出对你的意义", /对你的意义/.test(clim.years), "ok");
await shot("shot-4-clim.png");

const climYear = await evalJS(`document.querySelector('#climPeriod button[data-period="year"]').click();
  return { bars: document.querySelectorAll("#climBars i").length, hint: document.getElementById("climHint").textContent };`);
check("切到「这一年」→ 12 个月柱", climYear.bars === 12 && /这一年/.test(climYear.hint), climYear.bars + " 柱");
const climDay = await evalJS(`document.querySelector('#climPeriod button[data-period="day"]').click();
  return document.querySelectorAll("#climBars i").length;`);
check("切到「这一天」→ 7 年柱", climDay === 7, climDay + " 柱");
await evalJS(`document.querySelector('#climPeriod button[data-period="month"]').click(); return 1;`);

// ===== 7) 依据页 =====
await click('#tabs button[data-pane="basis"]');
const basis = await evalJS(`return {
  data: document.querySelectorAll("#basisData .tr").length,
  rules: document.querySelectorAll("#basisRules .row").length,
  limits: document.querySelectorAll("#basisLimits .row").length,
  text: document.getElementById("basisRules").textContent
};`);
check("依据页：数据来源 7 行 / 算法 6 条 / 局限 4 条",
  basis.data === 7 && basis.rules === 6 && basis.limits === 4, JSON.stringify({ data: basis.data, rules: basis.rules, limits: basis.limits }));
check("算法说明换成大白话（起评分 / 天数占多少）",
  /起评分/.test(basis.text) && /天数占多少/.test(basis.text), "ok");
await shot("shot-5-basis.png");
await click('#tabs button[data-pane="now"]');

// ===== 8) 鼠标指到地图任意点 → 看那里的数据 =====
await hoverMap(0.72, 0.62);
const p1 = await evalJS(PROBE);
check("鼠标移到海区 → 浮层出现并给出坐标",
  p1.hidden === false && /\d+\.\d+°E, \d+\.\d+°N/.test(p1.text), p1.text.slice(0, 26));
check("浮层含海表温度 / 离你多远 / 最近锋面",
  /海表温度/.test(p1.text) && /离你/.test(p1.text) && /最近锋面/.test(p1.text), "ok");
check("浮层含适温判断与是否在找鱼范围内",
  /合适 \d+~/.test(p1.text) && /找鱼范围/.test(p1.text), "ok");
check("浮层不会跑出地图边界", p1.inBounds === true, String(p1.inBounds));
await shot("shot-6-probe.png");

await hoverMap(0.12, 0.2);
const p2 = await evalJS(PROBE);
check("鼠标移到陆地 → 直说这里是陆地、不给海温",
  /陆地/.test(p2.text) && !/海表温度/.test(p2.text), p2.text.slice(0, 22));

await hoverMap(0.72, 0.62);
await clickMap(0.72, 0.62);
const pin1 = await evalJS(PROBE);
const pinTxt = pin1.text;
check("点一下就钉住（浮层留在原地）", pin1.hidden === false && /钉住/.test(pin1.text), pinTxt.slice(0, 20));
await hoverMap(0.4, 0.3);
const pin2 = await evalJS(PROBE);
check("钉住后鼠标乱动不会改掉浮层", pin2.text === pinTxt, pin2.text === pinTxt ? "内容保持不变" : "被改掉了");
await shot("shot-7-pinned.png");
await clickMap(0.72, 0.62);
const unpin = await evalJS(PROBE);
check("再点同一个点 → 取消钉住", unpin.hidden === true, String(unpin.hidden));

await clickMap(0.7, 0.66);
await evalJS(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return 1;`);
const esc = await evalJS(PROBE);
check("Esc 取消钉住", esc.hidden === true, String(esc.hidden));

// ===== 9) 选中回执：点了谁、怎么取消 =====
const pick = await evalJS(`document.querySelector("#heroPoints .pt").click();
  return { hidden: document.getElementById("mapPick").hidden,
    name: document.getElementById("pickName").textContent,
    body: document.getElementById("pickBody").textContent,
    x: document.getElementById("pickClose").textContent.trim(),
    dimmed: [].slice.call(document.querySelectorAll("#mapSvg *")).filter(function(n){ return n.getAttribute("opacity") === "0.14"; }).length };`);
await sleep(150);
check("点结论卡点位 → 地图上出现「选中回执」卡", pick.hidden === false && pick.body.length > 6, pick.name + " · " + pick.body.slice(0, 26));
check("选中后地图上其它对象被压暗", pick.dimmed > 0, "dimmed=" + pick.dimmed);
check("回执卡带 ✕ 可以取消", pick.x === "✕", pick.x);
await shot("shot-8-pick.png");
await click("#pickClose");
const pickOff = await evalJS(`return { hidden: document.getElementById("mapPick").hidden,
  dimmed: [].slice.call(document.querySelectorAll("#mapSvg *")).filter(function(n){ return n.getAttribute("opacity") === "0.14"; }).length };`);
check("点 ✕ → 取消选中并恢复地图", pickOff.hidden === true && pickOff.dimmed === 0, JSON.stringify(pickOff));

// ===== 10) 图层开关真实重绘 =====
const layer = await evalJS(`var r = document.querySelector('.legend-row[data-layer="sst"]');
  r.click(); var off = document.querySelectorAll("#mapSvg rect").length;
  r.click(); var on = document.querySelectorAll("#mapSvg rect").length;
  return { off: off, on: on };`);
check("图层开关真实重绘", layer.off === 0 && layer.on === 1, JSON.stringify(layer));

// ===== 11) 鱼种切换改变把握与结论 =====
const sp = await evalJS(`var s = document.getElementById("speciesSel"), out = [];
  for (var i = 0; i < s.options.length; i++) { s.value = s.options[i].value; s.dispatchEvent(new Event("change", { bubbles: true }));
    out.push(s.value + ":" + document.getElementById("heroVerdict").textContent + "/" + document.querySelectorAll("#nowMetrics .m")[3].textContent.replace(/[^0-9]/g, "")); }
  return out;`);
check("切换鱼种改变把握与结论", new Set(sp.map((x) => x.split(":")[1])).size > 1, sp.join(" | "));
await setVal("#speciesSel", "hairtail");

// ===== 12) 找鱼范围 =====
const r10 = await evalJS(`document.querySelector('#rangeSeg button[data-range="10"]').click();
  return { scope: document.getElementById("nowScopeTag").textContent, line: document.getElementById("heroLine").textContent };`);
check("找鱼范围 10 km 生效（真源驱动）", /10 km/.test(r10.scope) && /10 km/.test(r10.line), r10.scope);
await shot("shot-9-range10.png");
await evalJS(`document.querySelector('#rangeSeg button[data-range="20"]').click(); return 1;`);

// ===== 13) 空态：出海日选到未来，观测还没有 =====
await setVal("#timeDate", "2024-08-08");
const f8 = await evalJS(`return { nowEmpty: !document.getElementById("nowEmpty").hidden,
  text: document.getElementById("nowEmpty").textContent, jump: !!document.getElementById("jumpFuture"),
  verdict: document.getElementById("heroVerdict").textContent,
  when: document.getElementById("heroWhen").textContent,
  mapOk: document.getElementById("mapEmpty").hidden };`);
check("出海日选到未来 →「现在」页直说还没观测到", f8.nowEmpty && /还没观测到/.test(f8.text), f8.text.slice(0, 20));
check("同一时刻结论卡改用预报，而不是不给结论",
  f8.mapOk === true && /预报/.test(f8.when) && f8.verdict !== "先看数据", f8.when + " / " + f8.verdict);
check("空态给出「去看未来」的直达按钮", f8.jump === true, String(f8.jump));
await shot("shot-10-empty.png");
const jumped = await evalJS(`document.getElementById("jumpFuture").click();
  return document.getElementById("pane-future").classList.contains("active");`);
check("点「去看未来」→ 切到未来页", jumped === true, String(jumped));

// ===== 14) 日期越界被钳制 =====
const clampHi = await evalJS(`var n = document.getElementById("timeDate"); n.value = "2024-12-01";
  n.dispatchEvent(new Event("change", { bubbles: true })); return n.value;`);
check("日期超出预报范围 → 收敛到上限", clampHi === "2024-08-11", clampHi);
const clampLo = await evalJS(`var n = document.getElementById("timeDate"); n.value = "2024-01-01";
  n.dispatchEvent(new Event("change", { bubbles: true })); return n.value;`);
check("日期早于观测起点 → 收敛到下限", clampLo === "2024-06-01", clampLo);
await setVal("#timeDate", "2024-08-05");

// ===== 15) 键盘可达性 =====
const kb = await evalJS(`var b = document.querySelector('#tabs button[data-pane="now"]'); b.focus();
  b.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  return document.getElementById("pane-future").classList.contains("active");`);
check("方向键可切换页签（可访问性）", kb === true, String(kb));
await click('#tabs button[data-pane="now"]');

// ===== 16) 运行期异常 =====
check("无运行期 JS 异常", errors.length === 0, errors.slice(0, 3).join(" || ") || "none");

console.log(results.join("\n"));
console.log("\nFAIL 总数 = " + results.filter((r) => r.indexOf("FAIL") === 0).length);
ws.close();
child.kill();
process.exit(0);




