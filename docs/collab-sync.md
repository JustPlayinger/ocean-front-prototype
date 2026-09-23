# 与协作者仓（NingRuo-code/Ocean）的同步记录与规范

> 本文件说明**本仓与协作者仓的关系、怎么同步、必须做的路径适配**。换机器接手时先读它 + `deploy/HANDOVER.md`。

## 1. 远端一览

| 名字 | 地址 | 说明 |
|---|---|---|
| `origin` | https://github.com/JustPlayinger/ocean-front-prototype.git | **本仓主远端**（产品仓，新电脑拉这个） |
| `collab` | https://github.com/NingRuo-code/Ocean.git | **协作者的仓**（扁平布局：原型页与 `data/` 都在仓库根目录） |
| `friend` | https://github.com/NingRuo-code/Ocean-front-prototype-f.git | 早期协作仓（历史遗留，别推错） |
| `demo` | https://github.com/JustPlayinger/ocean-front-demo.git | 早期演示仓（历史遗留） |

## 2. 为什么不直接 merge（踩过的坑）

两条历史**没有共同祖先**（`git merge-base HEAD collab/codex-sync-current-ocean` 返回空），
而且目录布局不同：

- 协作者：`prototype-fishing.html` / `prototype-fishing.js` / `prototype-data.js` + `data/{day,sst,clim,base,front_response}` 全在**仓库根**
- 本仓：`frontend/prototype/`（页面 + 离线数据同目录，页面用相对路径引数据）、`backend/`、`deploy/`、`tools/{pipeline,ops}`

实测 `data/day/*.js` 与本仓 `frontend/prototype/data/day/*.js` 内容 **100% 相同**（git 识别为 `R100` 改名），
所以正确做法是**按文件同步 + 路径适配**，而不是 merge（merge 会产生双根历史与大量假冲突）。

## 3. 2026-09-23 那次同步同步了什么

来源：`collab` 的 `codex-sync-current-ocean`（`242a2d5`），共 5 个提交：

| 提交 | 内容 |
|---|---|
| `3af370d` | 纯新增 47 项：`server_data/`（服务端工件与作业记录契约示例）、`docs/` 的 P1 GFW AIS 响应闭环（spec + 8 张 ticket + wayfinder 7 张决策票 + ADR + agents 三件套 + 数据治理 + 真实样本入库 + 服务器集成计划 + 答辩简报/验证包）、`demand/`、`AGENTS.md`、`CONTEXT.md`、`.env.example`、`tools/{build-front-response,server-pull-job,server-process-artifact}.mjs`、`frontend/prototype/data/front_response/*` |
| `2325954` | 前端三件套（AIS 响应卡片 +143 行、HTML 容器 +9、`prototype-data.js` +77）+ `tools/{data-check,e2e-check,layout-check,build-basemap}.mjs` 新版，含 3 处路径适配 |
| `fe85bf3` | `docs/data-schema.md`（新 §3.6 `front_response/events.js` 契约）、`docs/requirements-fishing-ground.md`（§5.2–5.5）、`docs/ux-spec.md` |
| `3d4f2c6`、`dbcc91c` | 修正合并后 3 处失效引用；`.gitignore` 吸收协作者通用忽略项 |

**未采用（保留本仓版本）**：`README.md`（本仓是产品版，含后端/部署/交接入口）、
`data/README.md`（语义不同：协作者 `data/` 是原型导出物，本仓 `data/` 是原始 NetCDF 运行目录）、
`docs/handover.md`（本仓已做布局适配且含服务器内容）。

## 4. 路径适配规则（取协作者文件时**必须**做）

| 协作者路径 | 本仓路径 |
|---|---|
| `prototype-fishing.html` / `prototype-fishing.js` / `prototype-data.js` | `frontend/prototype/…` |
| `data/{day,sst,clim,base,front_response}`、`data/meta.js`、`data/days.js` | `frontend/prototype/data/…` |
| `cd Ocean\backend` + `.\\.venv\\Scripts\\python.exe scripts\\…` | `backend\\.venv\\Scripts\\python.exe backend\\scripts\\…` |
| 工具里的 `ROOT/"data"`、`ROOT/"prototype-fishing.html"` | `ROOT/"frontend/prototype/data"`、`ROOT/"frontend/prototype/prototype-fishing.html"` |
| `Ocean/backend/...`（文档里的引用） | 本仓 `backend/...` |

> 协作者文档里的 Windows 路径常写成**双反斜杠**（`.\\.venv\\Scripts`），做替换时用字面替换、别只写单反斜杠正则。

## 5. 以后再拉（标准流程）

```bash
git fetch collab
git diff --stat HEAD collab/codex-sync-current-ocean          # 先看差异
git checkout collab/codex-sync-current-ocean -- <需要的路径>    # 只取需要的（新文件最安全）
# 按 §4 做路径适配（只改路径，不动内容）
node tools/data-check.mjs && node tools/layout-check.mjs && node tools/e2e-check.mjs
git add -A && git commit -m 'chore(collab): 同步协作者 <分支> 的 <范围>'
```

## 6. 每次同步后必跑的三项检查

| 脚本 | 断言数 | 2026-09-23 结果 |
|---|---|---|
| `node tools/data-check.mjs` | 907 | **0 FAIL** |
| `node tools/layout-check.mjs` | 25 | **0 FAIL** |
| `node tools/e2e-check.mjs` | 108 | **0 FAIL**（需 Edge；`EDGE=` 可指定浏览器路径） |

> 注意：`e2e-check.mjs` / `layout-check.mjs` 默认按 `ROOT/frontend/prototype/prototype-fishing.html` 打开页面；
> 若页面路径变了，用环境变量 `PAGE=` 覆盖。
