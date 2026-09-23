# 部署实施手册（RUNBOOK）

> **换电脑接手 / 新人上手，先看 `deploy/HANDOVER.md`**（三十秒速览 + [A]拿代码 [B]配SSH [C]续队列 三步清单 + 排错手册）。
> 本文件是**细节手册**，很全很长，按需查即可，不必通读。

> 服务器资产（2026-09-21 控制台复核 + 端口实测）：
> 实例 `i-bp1hr21nr07vhujhsojy`（实例名 `iZr07vhujhsoywZ`）· **华东1（杭州）** · 公网 **`116.62.54.140`** · 私网 `172.25.177.210` ·
> 2 vCPU / 4 GiB（`ecs.e-c1m2.large`）· 系统盘 40 GiB ESSD Entry · 当前系统 **Windows Server 2022（未换）** ·
> 安全组**仅放行 3389**（22/80/443/3306 实测均不通）· 按量付费 + 100 Mbps 峰值按流量计费 ·
> 试用期 **2026-09-21 ~ 2026-12-21**。
>
> 一句话：**「准备」完成，服务器上还没装任何东西。**
> 注：根目录 `交接文档.md` 把地域记成「华北2（张家口）」，以控制台显示为准（华东1 杭州），其余资产信息一致。

## 目标形态

```text
公网 http://<IP>:80  →  Nginx（站点名 ocean，server_name = 真实 IP）
   ├── /            → /opt/ocean/frontend/prototype/     离线原型「渔场向导」
   └── /api/        → http://127.0.0.1:8000              FastAPI：服务器端渲染 PNG + GeoJSON + 点查询 + 历史统计
                                        ▲
                                        └── systemd: ocean-api.service（用户 ocean，2 worker）
代码 /opt/ocean                venv /opt/ocean/venv
数据 /srv/ocean/data/{raw,processed,cache,manifest}
MySQL 8 · db_prac              仅监听 127.0.0.1，远程走 SSH 隧道
```

---

## 阶段 A · 控制台操作（人工，脚本无法替代）

| # | 操作 | 说明 |
|---|---|---|
| A1 | 安全组放行入方向 `22`（源填你的公网 IP `/32`）+ `80`（源 `0.0.0.0/0`）<br>路径：实例 → **网络与安全组** → 安全组 → 配置规则 → 入方向 → 手动添加 | 2026-09-21 实测 22/80/443/3306 全部不通、仅 3389 通；不放行 22，后面全部无法执行 |
| A2 | 实例 → 更多 → 实例状态 → **停止** | ⚠️ **不要勾「节省停机模式」**，否则公网 IP 会被释放 |
| A3 | 实例 → 更多 → 磁盘和镜像 → **更换操作系统** → 公共镜像选 **`ubuntu_24_04_x64_20G_alibase_*.vhd`**，向导里把**密钥对选成刚导入的 `ocean-front-ecs`** | 会清空系统盘（当前无数据，代价为零）。<br>⚠️ **必须是 `x64`**：实例 `ecs.e-c1m2.large` 是 x86 规格，`arm64` 镜像起不来。<br>⚠️ **必须是 24.04**：后端 `pyproject.toml` 要求 `python>=3.11`，而 22.04 自带 3.10 → 服务器上 `pip install` 会硬失败；24.04 自带 3.12，与本机验证过的依赖版本一致。<br>⚠️ **别选 26.04**：Python 太新（3.14+），scipy/h5netcdf 等大概率没有现成 wheel，会在 2 vCPU/4 GiB 上尝试源码编译 |
| A4 | 网络与安全 → 密钥对 → **导入已有密钥对** → 粘贴下面这行公钥 | 本机公钥**已生成**：`C:\Users\崔家瑞\.ssh\id_ed25519_ocean`（私钥同目录，无口令）<br>`ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHD19i9zSlPPo/cxo84CJ1lYk1jsT98DnqUipMwjUTpU ocean-front-ecs`<br>导入后回到实例：更多 → 密码/密钥 → **绑定密钥对**（需重启实例生效） |
| A5 | 确认公网 IP | 若变化，后面所有命令、`deploy.ps1` 与 Nginx 配置都用新 IP |

> A1/A2/A3 之间**无先后强约束**，但 A3 需要实例处于「已停止」。控制台首页显示的「实例健康状态数据不足」是没装云助手导致的，不影响部署。

> **FAQ：选了 Ubuntu 镜像，为什么还提示收费？**
> `*_alibase_*` 是阿里云**官方基础镜像，镜像本身免费**。费用提示通常是这三种：
> ① 勾了「系统盘扩容」→ 明细会写 `系统盘容量变化`（保持 40 GiB 即可，当前数据 118 MB 绰绰有余）；
> ② 误选到「云市场镜像」（按镜像/License 计费）→ 退回「公共镜像 → Ubuntu」重选；
> ③ **系统盘本来就在按小时计费**（本套 40 GiB ESSD Entry 按量）→ 明细写的是「系统盘」，属于既有费用，换盘期间新盘计费、旧盘释放。
> 判读方法：看费用明细写的是「系统盘」（既有盘费，正常）还是「镜像 / 镜像 License」（选错镜像，退回重选）。
> 若实例是试用渠道，控制台还可能提示「更换操作系统后不再享受试用优惠」，那是试用规则提示，与镜像收费无关；300 元额度只覆盖实例 + 系统盘。

> **⚠️ 不要为了"换系统"去购买新实例。**
> 更换操作系统用的是**公共镜像**，**不收镜像费**；那个 ¥300+ 的下单页是"新买一台实例（包年包月）"，
> 而 300 元抵扣额度按规则**只抵扣按量付费的实例 + 系统盘，不抵扣包年包月**，等于净支出。
> 换系统的正确入口：**云服务器 ECS → 实例与镜像 → 实例 → 选中目标实例 → 更多 → 磁盘和镜像 → 更换操作系统**。
>
> 顺带两个容易选错的点：
> - 若列表里出现 `ubuntu_22_04_x64_...`，**不要选**：22.04 自带 Python 3.10，而后端要求 `>=3.11`，服务器上 `pip install` 会硬失败。要选 **`ubuntu_24_04_x64_...`**。
> - 镜像详情里的「系统盘容量 20 GiB」是该镜像的**模板容量**，不是对实例的要求；保持现有 **40 GiB ESSD Entry** 即可，**不要勾系统盘扩容**（勾了才会真产生新增费用）。

> **A3 备选：如果控制台明确不允许更换操作系统**（个别试用实例会限制），再考虑新购，按这张表配，别照默认值下单：
>
> | 项 | 该选什么 | 理由 |
> |---|---|---|
> | 付费类型 | 优先 **按量付费**（若确定长期用再考虑包年包月） | 只有按量实例 + 系统盘能吃到 300 元额度 |
> | 地域 / 可用区 | **华东1（杭州）**，且与现实例**同 VPC、同交换机** | 才能复用已放行 22/80 的安全组；跨地域内网不通 |
> | 规格 | `ecs.e-c1m2.large`（2 vCPU / 4 GiB） | 与现有机型同规格，已验证够跑后端 + 渲染 |
> | 镜像 | 公共镜像 **Ubuntu 24.04 64 位** | Python 3.12，满足后端 `>=3.11` |
> | 系统盘 | ESSD Entry **40 GiB** | 够用（OS ≈10 GiB + 数据 118 MB + 依赖 ≈3 GiB） |
> | 带宽 | 按使用流量 + 100 Mbps 峰值 | 与现实例一致，演示够用 |
> | 安全组 | 选已放行 `22`（你的 IP）+ `80` 的那个 | 没有就新建 |
> | 密钥对 | `ocean-front-ecs` | 本机私钥已就位 |
>
> ⚠️ 新购成功后**记得释放旧实例**（否则两台同时计费）；旧实例若是试用机，释放前确认没有需要保留的数据（当前只有 118 MB 原始数据，本机有完整副本）。

## 阶段 B · 一键部署

```powershell
cd "f:\project\海洋锋面\ocean-front-prototype"
# 有密钥（本机已生成，见阶段 A4）：
powershell -ExecutionPolicy Bypass -File .\deploy\deploy.ps1 -ServerIp 116.62.54.140 -KeyFile "$env:USERPROFILE\.ssh\id_ed25519_ocean"
# 没密钥（会提示输密码）：
powershell -ExecutionPolicy Bypass -File .\deploy\deploy.ps1 -ServerIp 116.62.54.140
# 先探一下端口（安全组是否放行 / 服务是否起来）：
powershell -ExecutionPolicy Bypass -File .\deploy\probe-ports.ps1 -ServerIp 116.62.54.140
# 先不上传数据（只跑通站点与接口）：
powershell -ExecutionPolicy Bypass -File .\deploy\deploy.ps1 -ServerIp 116.62.54.140 -SkipData
# 只重跑远程环境/权限/服务（代码与数据不动）：
powershell -ExecutionPolicy Bypass -File .\deploy\deploy.ps1 -ServerIp 116.62.54.140 -SkipUpload
```

脚本做的事：预检 22 端口 → robocopy 打包（排除 `.git`、`data\raw`、`data\cache`、`.venv`）→ scp 上传 →
远程 `remote-setup.sh`（装 Nginx / Python / MySQL / Node 20，建 `ocean` 用户，装 venv 依赖，装 systemd 与 Nginx 站点）→
上传 `data\raw` 到 `/srv/ocean/data/raw` → **重跑一次 setup 收权限**（幂等）→ 公网验收。

## 日常发布（改前端 / 改后端之后怎么上线）

一次性部署用上面的阶段 B；**后续每次改代码**按下表走，都不用重装环境。

| 改了什么 | 发布动作 |
|---|---|
| **只改前端**（`frontend/prototype/**`） | 传文件即可，**不用重启服务**（Nginx 直接读盘）：<br>`scp -i <key> frontend/prototype/*.js ocean:/opt/ocean/frontend/prototype/`<br>若改了 `data/**` 一并传目录；浏览器 `Ctrl+F5` 强刷。 |
| **改了后端**（`backend/app/**`） | `scp -i <key> backend/app/*.py ocean:/opt/ocean/backend/app/`，然后 `ssh ocean 'systemctl restart ocean-api'`。<br>重启约 2~8 秒，期间 `/api/*` 会短暂 502。 |
| **改了部署/服务配置**（`deploy/**`） | 重跑一次远程安装（幂等）：把 `deploy/remote-setup.sh` 传到 `/tmp/ocean-remote-setup.sh`，再 `ssh ocean 'bash /tmp/ocean-remote-setup.sh 116.62.54.140'`。 |
| **改了取数脚本**（`tools/pipeline/**`） | 传文件即可；队列是 `setsid nohup` 常驻进程，**下次启动**才用新脚本。 |

**推荐：整仓发布**（改动跨目录时最省事，幂等、且不会动数据）

```powershell
# 1) 本地打包（排除 .git / venv / 原始数据）
tar -czf "$env:TEMP\ocean-deploy.tar.gz" --exclude=./.git --exclude=./backend/.venv `
  --exclude=./data/raw --exclude=./data/cache --exclude=./data/processed `
  --exclude=./.vscode --exclude=node_modules --exclude=__pycache__ --exclude='*.pyc' .

# 2) 上传并解包（--overwrite；不会删除服务器上已有的额外文件）
scp -i "$env:USERPROFILE\.ssh\id_ed25519_ocean" "$env:TEMP\ocean-deploy.tar.gz" ocean:/tmp/
ssh ocean 'cd /opt/ocean && tar -xzf /tmp/ocean-deploy.tar.gz --overwrite'

# 3) 权限收口 + 重启后端（必须：解包后属主会变成 root，而服务以 ocean 用户运行）
ssh ocean 'chown -R ocean:ocean /opt/ocean && systemctl restart ocean-api'

# 4) 验收
curl.exe -sS "http://116.62.54.140/api/health"
```

> ⚠️ 解包**只覆盖同名文件、不删除**服务器上多出来的东西；反过来，**在服务器上直接改的内容会被仓库版本覆盖**。
> 所以任何临时改在服务器上的修复，都要**先回流到仓库**再发布，否则下次发布会丢。

**发布前先跑三项自检**（本仓库回归网）

```powershell
node tools/data-check.mjs       # 期望 0 失败 / 907 项
node tools/e2e-check.mjs        # 期望 0 失败 / 108 项（离线 file://）
node tools/layout-check.mjs     # 期望 0 失败 / 23 项
# 同一套断言也可以直接打线上（服务器增强模式会自动启用）：
$env:PAGE = 'http://116.62.54.140/prototype-fishing.html'
node tools/e2e-check.mjs; node tools/layout-check.mjs
Remove-Item Env:\PAGE
```

> 本机系统代理会让 `Invoke-WebRequest` 误报，一律用 `curl.exe`。
> e2e 依赖无头 Edge 的 9337 调试端口：**上一次实例没退干净**时报「未能连接 Edge 调试端口」，等几秒重试即可。

### 服务器增强模式（2026-09-23 上线）

前端默认是纯离线的（`file://` 双击即可用）；**同源部署时会自动探测 `/api` 并切换到服务器模式**：

- 启动时拉 `/api/catalog` → 拿到服务器上的全量日期（当前 **15,706 天**，1982-01-01 ~ 2024-12-31）；
- 日期控件范围随之扩展到全量（此前只到本地导出的 62 天）；
- 切到「服务器有、本地没有」的日期时，**按需**请求 `GET /api/frontend/day/<date>`，把结果注入 `OFData` 的 `DAYS`/`SST` 缓存后**沿用同一套渲染逻辑**，渲染层零改动；
- 加载中地图显示「正在从服务器取这一天」（不显示空图）；失败则提示并回退；**404 不重试**。

后端实现见 `backend/app/frontend_payload.py`：它**复用 `backend/scripts/export_prototype_data.py` 的构建函数**，
因此返回结构与离线 `data/day|sst/<date>.js` **逐字段一致** —— 将来改 RLE / 抽稀口径只需改那一处。

跨域部署（前后端不同源）时，在页面显式指定：`window.OF_API_BASE = "http://<IP>/api"`。

### 图层与锋面强度（2026-09-23 上线）

- **图层开关**在地图**左上角**「☰」呼出的抽屉里（默认收起）：鼠标靠近地图左边缘 28px 自动呼出、
  移开 0.6s 自动收起，点 ☰ 可固定展开、✕ 收起。共 7 个图层；机制仍是
  `data-layer` + `state.layers`，新增图层只要在 HTML 加一行并在 `drawDataLayers()` 里加一段绘制。
- **数据窗口**：离线兜底是东海（120–128°E / 27–34°N，62 天）；服务器模式的 `GET /api/frontend/day`
  用 **105–150°E / 3–45°N**（锋面对象 10 → 200 个）。实测单日开销：东海 23 KB / 0.16s、
  本窗口 391 KB / 0.67s、**全球 15.7 MB / 25s —— 不可行，故不取全球**。
  前端视野随之自适应：离线 `DEFAULT_ZOOM=0.8`、服务器模式 `SERVER_ZOOM=0.35`（约 16° 经度）；
  「回到定位点」按当前模式取默认视野，否则会把视野缩回东海。
  服务器模式下 `loadThenRefresh()` 会用 `ensureDay(iso, force=true)` **覆盖本地数据**（服务器窗口更大），
  先本地渲染保首屏、拉到后重渲染。
  ⚠️ **SST 目前仍是东海窗口**（`raw/sst/*.nc` 下载时就按东海裁剪）：要与大窗口一致需按新 bbox 重下 ——
  `fetch_sst_samples.py --output-root /srv/ocean/data/raw/sst --bbox 105,3,150,45 --force <62 天日期>`，
  下载是 `.part` 原子写入，失败不会破坏原文件。
- **渔场线索图层**（默认关）：数据来自 `GET /api/fishing/<date>`（GFW apparent fishing effort，0.1°）。
  渲染取当日 `hours` 的**前 40%（≥ P60）**画暖色圆点，半径与不透明度随 `hours` 递增，**上限 700 点**兜底；
  低于 P60 的格子不画 —— 这是「可写覆盖内无作业不渲染」，**不是**把缺失当 0。
  ⚠️ 边界：界面与图例必须写「表观捕捞活动（fishing hours），不等于渔获量 / 产量」（`docs/data-governance-gfw-ais.md`）。
  离线（`file://`）没有该数据源，图层开关可点但无渲染，属预期。
- **锋面强度**：口径＝**跨锋面 SST 温差 / 梯度**（数据集自带的 `frontal_intensity` 未下载，约 90 GB；
  需求文档 §6.2 把「`frontal_intensity` 与局地温度梯度」并列，故用温度差作口径，界面始终写明）。
  实现见 `frontend/prototype/prototype-data.js` 的 `frontIntensity()`：把锋面折线投影到局部 km 平面 →
  沿法向两侧各偏 10 km → 反投影回经纬度 → 用 `sstCell()` 取**真实档位温度（不插值）**，最多 12 个断面取均值；
  两侧任一为缺测则该断面不参与，**不用 0 顶替**。选中锋面时在回执卡显示强度，结论行的首选/最近锋面也带强度等级。

## 阶段 C · 验收

```powershell
# 必须用 curl.exe：本机系统代理（Clash 类，127.0.0.1:7897）会让 Invoke-WebRequest 误报 502
curl.exe -sS "http://116.62.54.140/api/health"      # 期望 {"status":"ok",...}
curl.exe -sS -o NUL -w "HTTP=%{http_code}`n" "http://116.62.54.140/"   # 期望 200
curl.exe -sS "http://116.62.54.140/api/catalog" | Select-Object -First 1   # 期望 available_dates 里是真实日期
curl.exe -sS -o "$env:TEMP\sst.png" "http://116.62.54.140/api/analysis/2024-08-05?longitude=124.5&latitude=30.2&radius_deg=1"
# ↑ 返回 JSON，其中 rasters.sst.url 就是服务器端渲染出的 PNG 地址；直接取那个 url 能下载到图片
```

服务器内部验收（ssh 上去执行）：

```bash
systemctl status ocean-api --no-pager -l        # active (running)
journalctl -u ocean-api -n 50 --no-pager        # 无异常栈
cd /opt/ocean && node tools/data-check.mjs      # 期望 0 失败 / 890 项（校验前端离线兜底数据）
node -v && /opt/ocean/venv/bin/python -V        # v20.x / Python 3.12.x
mysql -e "SHOW DATABASES;"                      # 应含 db_prac
```

## 数据同步（后续加日期时）

```powershell
# ① 本地拉数据（需要 Ocean 生环境；脚本已随本仓 vendor 进来）
cd "f:\project\海洋锋面\ocean-front-prototype"
.\backend\.venv\Scripts\python.exe backend\scripts\fetch_zenodo_front_samples.py 2024-09-01
.\backend\.venv\Scripts\python.exe backend\scripts\fetch_sst_samples.py 2024-09-01
# ② 重新导出前端离线兜底数据（写进 frontend\prototype\data）
.\backend\.venv\Scripts\python.exe backend\scripts\export_prototype_data.py
node tools\data-check.mjs
# ③ 同步到服务器（只传增量数据 + 重建索引）
powershell -ExecutionPolicy Bypass -File .\deploy\deploy.ps1 -ServerIp 116.62.54.140 -SkipUpload   # 会重传数据并收权限
ssh root@116.62.54.140 "curl -fsS -X POST http://127.0.0.1/api/data/index/rebuild >/dev/null && echo index-ok"
```

## 排错对照表（都是真踩过的坑）

| 现象 | 原因 | 处理 |
|---|---|---|
| 22 端口不通 | 安全组没放行，或实例还是 Windows | 回阶段 A1/A3 检查 |
| 访问 IP 跳到 Nginx 欢迎页 | `server_name` 没匹配上当前 IP | 改 `/etc/nginx/sites-available/ocean` 里的 IP 后 `systemctl reload nginx` |
| `nginx -t` 报 `duplicate default server` | 自己那份配置里写了 `default_server` | 本仓配置已经避让：只用真实 IP 作 `server_name` |
| 403 Forbidden | 目录权限或 SELinux 上下文 | `chown -R ocean:ocean /opt/ocean`；RHEL 系加 `chcon -R -t httpd_sys_content_t` |
| 浏览器接口 404 / 502 | `ocean-api` 没起来 | `journalctl -u ocean-api -n 50 --no-pager`，多半是 venv 依赖没装或数据目录不存在 |
| **服务器上** `curl http://127.0.0.1/api/...` 返回 nginx 404 | Host 头是 `127.0.0.1`，匹配不到 `server_name <公网IP>` 的站点，请求落到了发行版默认站点（**与后端无关**） | 加 Host 头：`curl -H 'Host: <公网IP>' http://127.0.0.1/api/health`；或直连后端 `curl http://127.0.0.1:8000/api/health` |
| 接口 200 但图是空白 | `/srv/ocean/data/raw` 里没有对应日期的 NetCDF | `find /srv/ocean/data/raw -name '*.nc' \| wc -l`，重跑数据同步 |
| 数据上传后接口报权限错误 | 上传文件属 root，服务以 ocean 运行 | 重跑 `bash /tmp/ocean-remote-setup.sh <IP>`（幂等，会收权限） |
| `remote-setup.sh` 报 `invalid option` / `bad interpreter` | 文件被存成 CRLF 或带 BOM | 保持 **LF + UTF-8 无 BOM**；git 里已按此约定提交 |
| `deploy.ps1` 报一堆假语法错误 | `.ps1` 缺 BOM，PowerShell 5.1 按 GBK 解码中文 | 保持 **CRLF + UTF-8 带 BOM** |
| 本机验证接口报 502 | `Invoke-WebRequest` 走了系统代理 | 一律用 `curl.exe` |
| `tools/e2e-check.mjs` 在服务器上起不来 | 默认探测的是 Edge，且 Chromium **不能以 root 跑** | `export TEMP=/tmp EDGE=/usr/bin/chromium`，并用非 root 用户执行（脚本已自动加 `--no-sandbox`） |

### 本机（Windows）侧三个坑（2026-09-21 实测）

| 现象 | 原因 | 处理 |
|---|---|---|
| `tar: could not chdir to 'F:\...\海洋锋面\...'` | Windows 自带的 bsdtar **打不开非 ASCII 路径**。应用打包没暴露是因为暂存目录恰好是 ASCII（`C:\tmp\ocean-stage`），只有数据打包时踩到 | 先用 robocopy（原生 Unicode）把数据暂存到 `C:\tmp\ocean-data-stage`，再在那里 `tar -C`；`deploy.ps1` 已内置 |
| 远程命令里的 `-H "Host: x"` 到服务器变成 `-H Host:` + IP 被当成主机名（curl 报 `Bad hostname`、nginx 返 400） | PowerShell 5.1 向原生程序（ssh.exe）传参时会**吞掉内层双引号** | 远程命令尽量不用引号：直连 `http://127.0.0.1:8000/...`，传 query 用 `curl --get -d k=v`；必须用 Host 头时写 `-H Host:1.2.3.4`（无空格） |
| 轮询部署进度永远是 `RUNNING` | `pgrep -f ocean-remote-setup.sh` **会匹配到轮询命令自己的命令行** | 改成看日志收尾标志：`grep -q curlexe /var/log/ocean-setup.log`；`deploy.ps1` 已修正 |

### GFW token（渔场数据取数用）

GFW API 需要 token，**只用于数据准备阶段**（不在常驻服务里），建议存服务器上：

```bash
sudo install -d -m 700 /etc/ocean
printf 'GFW_TOKEN=%s\n' '粘贴你的token' | sudo tee /etc/ocean/gfw.env >/dev/null
sudo chmod 600 /etc/ocean/gfw.env
```

取数（**已实测可用的跑法**，2026-09 在 116.62.54.140 上跑通 83 天）：

```bash
# 前台试跑，先确认 token 与路径都对
cd /opt/ocean
export OCEAN_RAW_DATA_DIR=/srv/ocean/data/raw
set -a; . /etc/ocean/gfw.env; set +a
/opt/ocean/venv/bin/python tools/pipeline/fetch_gfw_effort.py --from-front-data --split-days --dry-run

# 正式跑：后台 + 日志 + 断点续跑（推荐写成脚本 /tmp/start-gfw-fetch.sh 再 setsid nohup bash 它）
setsid nohup env OCEAN_RAW_DATA_DIR=/srv/ocean/data/raw \
  /opt/ocean/venv/bin/python tools/pipeline/fetch_gfw_effort.py \
  --from-front-data --split-days --skip-existing --timeout 240 --retries 5 \
  >> /var/log/ocean-gfw.log 2>&1 < /dev/null &

# 跑完（或中途看进度）：索引与文件对不上时重建 manifest，不用重新取数
OCEAN_RAW_DATA_DIR=/srv/ocean/data/raw /opt/ocean/venv/bin/python \
  tools/pipeline/fetch_gfw_effort.py --rebuild-manifest
```

> 取数脚本随代码部署在 `/opt/ocean/tools/pipeline/fetch_gfw_effort.py`；token 不要写进仓库、不要提交。
> 数据落在 `/srv/ocean/data/raw/fishing/`（`effort-YYYYMMDD.json` + `manifest.json`），接口见 `/api/fishing/*`。

### 锋面 / 海温取数（Zenodo + NOAA ERDDAP）

两条通路分工**不一样**（都是实测踩出来的）：

| 数据 | 在哪跑 | 命令 |
|---|---|---|
| **锋面**（Zenodo 20356239，`front_location.zip` 18.3 GB / 15,706 天 / 1982–2024，HTTP Range 按天取 1.28 MB） | **本地 Windows 取，再上传** —— 服务器直连 Zenodo 读 zip 中央目录会反复 `IncompleteRead`，`remotezip` 开不了归档 | ① 本地：`backend\.venv\Scripts\python.exe backend\scripts\fetch_zenodo_front_samples.py 2024-01-01 2024-01-02`（分批，每批 ≤ 40 天；用 `C:\temp\fetch_front_batch.py` 那种驱动可 3 路并发）<br>② 同步：`powershell -File tools\pipeline\sync-front-to-server.ps1`（只传服务器缺的，幂等，末尾自动 chown + 重建索引） |
| **海温**（NOAA CoastWatch ERDDAP `noaacwBLendedCsstDaily`，0.05°，2002 至今，0.12 MB/天） | **服务器直连**（稳定） | `OCEAN_RAW_DATA_DIR=/srv/ocean/data/raw /opt/ocean/venv/bin/python backend/scripts/fetch_sst_samples.py 2024-01-01 2024-01-02` |

**加完数据必须重建索引**，否则接口按旧清单找文件、新日期会 404：

```bash
curl -X POST http://127.0.0.1:8000/api/data/index/rebuild
```

（用 `tools/pipeline/sync-front-to-server.ps1` 同步锋面时会自动做这一步。）

批量任务的三条实测建议：
* **并发 3 路最快**（网络等待型）：SST 单进程约 24 s/天 → 3 路约 2.6 s/天（实测 731 天无失败跑完）；锋面单进程 6–20 s/天，3 路后 731 天约 1 小时。
* **单次调用别传太多日期**：一次给 731 个日期当命令行参数，外部命令会直接启动失败（exit 为空、无输出），分批即可，脚本本身会跳过已存在的文件（可中断续跑）。
* **.ps1 上传脚本要带 BOM**：无 BOM 的 UTF-8 中文注释会被 PowerShell 5.1 当 GBK 读，报「表达式或语句中包含意外的标记」；写文件时用 `Set-Content -Encoding utf8`（PS 5.1 会写 BOM）。

## 数据补齐队列（2026-09-22 起，自主排队跑完）

目标：把 Zenodo 归档里所有能用的锋面 / 海温 / 渔场数据补齐到服务器。三条队列并行，都可中断续跑：

| 队列 | 在哪跑 | 范围 | 并发 | 脚本 | 日志 |
|---|---|---|---|---|---|
| 锋面 | **本地 Windows**（服务器到 Zenodo 只有 17 KB/s，本地 198 KB/s） | 2022 → 1982 逐年 | 4 | `tools/pipeline/fetch_front_local.py`（每批自动 `sync-front-to-server.ps1`） | `C:\temp\front-pipeline.log` |
| 海温 | 服务器 | 2022 → 2002 逐年（产品 2002 起） | 4 | `tools/pipeline/sst_pipeline.py` | `/var/log/ocean-sst-pipeline.log` |
| 渔场 | 服务器 | 2024 → 2017 逐年（GFW 2017 起） | 3 | `tools/pipeline/gfw_pipeline.py` | `/var/log/ocean-gfw-pipeline.log` |

- 启动（服务器两条，幂等）：`bash /tmp/start-server-pipelines.sh`
- 启动（本地锋面）：`backend\.venv\Scripts\python.exe tools\pipeline\fetch_front_local.py --workers 4 --batch-size 40`
- 进度查看：服务器 `find /srv/ocean/data/raw/{front,sst} -name '*.nc' | wc -l`、`ls /srv/ocean/data/raw/fishing/effort-*.json | wc -l`；本地看上面的日志与 `data/raw/front/<年>` 文件数
- 索引：三条队列都在**每年跑完时**自动 `POST /api/data/index/rebuild`（不是每批都重建，避免反复重扫目录）

**踩坑：孤儿子进程会让队列"假死"（2026-09-22 实测并修掉）**

现象：SST 队列 40 分钟没有新文件落盘，`/tmp/sst-2021-w*.log` 一直在刷
`HTTP 404: Currently unknown datasetID=noaacwBLENDEDCsstDaily`。

原因：pipeline 被 kill/重启后，它 fork 出来的 `fetch_sst_samples.py` 子进程不会跟着死，
会变成 **PPID=1 的孤儿**继续跑，而重启后的新一代 worker 抓的是**同一批日期** →
ERDDAP 请求量翻倍 → 限流式瞬时 404 → 双方都卡在重试里。
`ps -eo pid,ppid,cmd | grep fetch_sst` 一眼可辨：**PPID=1 的就是孤儿**（实测当时 6 个子进程，应该是 4）。

处理：`bash /opt/ocean/tools/ops/kill-orphans.sh`（只杀 PPID=1 的），或直接看 `ocean-ops health` 的进程表。
事后全量校验了 1704 个 SST 文件（magic 全是 `CDF\x01`、0 个打不开、0 个异常小文件）——
因为 fetcher 本来就是"写 `.part` → `os.replace`"的原子写；现在 `.part` 名字还带上了 PID，
两个进程即使真撞上也不会互相覆盖半成品。

**踩坑：锋面同步传不上去的三件事（2026-09-23 体检发现，全部已修）**

1. **`-Years` 默认值写死过**：原来是 `2015..2024`，于是 1991–2014 在本地全下好了却从没上传
   —— 服务器上的锋面恰好卡在 **3653 个 = 2015–2024 十年**。现在默认"自动探测本地目录里的年份"。
2. **scp 不会自动创建远程目录**：目标年份目录不存在时，
   `scp file ocean:/srv/ocean/data/raw/front/2014/` 直接报 `No such file or directory`，
   而且会让整轮同步 `throw` 中断（所以 2014 把后面所有年份都堵住了）。现在每年前先 `mkdir -p`。
3. **同步会阻塞下载**：原先每批抓完都同步等待 scp 完成，而上传比下载慢得多 →
   下载被上传拖着走。现在改成后台 `Popen` + "上一轮还在跑就跳过本次"，
   队列跑完再补一次同步并重建索引；同步日志单独写 `C:\temp\front-sync.log`。

判据：本地文件数涨了但服务器不涨 → 先看 `C:\temp\front-sync.log`，
再看 `ocean-ops years` 里该年份的锋面数是否停滞。

**补缺口队列**（幂等，已在跑就跳过）：`bash /opt/ocean/tools/ops/start-gap-fills.sh`

- 渔场：跑第三轮补 2017–2023 的约 615 天缺口（抽查 2018-06-15 上游**有**数据：148 格点 / 2510 小时，
  说明是没抓到、不是上游没有）
- 海温：`--years 2018 2016 2015 --workers 2` 补两轮复查都没补上的那几十天
  （用 2 路，避免和主队列的 4 路一起把 ERDDAP 压垮）

**上游 ERDDAP 会整站"数据集列表重载"（2026-09-22 实测）**

现象：SST 队列突然全体卡住，`/tmp/sst-2021-w*.log` 刷
`HTTP 404: Not Found: Currently unknown datasetID=noaacwBLENDEDCsstDaily`，
而且**所有** datasetID 都 404，连随手编的 `zzzNotARealDataset` 也 404。

判据（`ocean-ops erddap` 一把梭）：

| 观察 | 含义 |
|---|---|
| `version` 有输出，`index.html` 200 | ERDDAP 服务在线，不是断网 |
| 所有 datasetID 都 404、搜索返回空、`info/index.json` 302、`status.html` 卡满超时 | **上游正在全量重载数据集**（上游问题，等即可） |
| 只有某个 ID 404、搜索里也搜不到 | 该数据集改名/下线，需要换 `--dataset` |
| 取一天 200 + 约 120 KB | 上游健康，队列会自己续上 |

确认证据（2021-06-15 实测，`ocean-ops erddap` 抓的原文）：

```text
② 取一天（与 fetcher 完全相同的选择器）：
   HTTP=404 2.563s 101B  curl_exit=0
   正文：Error { code=404; message="Not Found: Currently unknown datasetID=noaacwBLENDEDCsstDaily" }
③ 搜索 BLENDEDCsst： [HTTP 302 exit 0]      ← 搜索接口被重定向，没有结果
④ zzzNotARealDataset 404 ；noaacwCRWdaily 404   ← 连编造的 ID 和另一个真实产品也 404
⑤ info/index.json 302 ；status.html 200 in 25.000s
```

处置：**什么都不用做**。fetcher 每个日期本来就有 `--retries 8`（指数退避），
上游一恢复，正在重试的那一天就会成功；当年跑完紧跟的第二遍复查（`--passes 2`）
还会把这段时间失败的日子整体再补一遍。想确认恢复没有，跑 `ocean-ops erddap`。

> **复发与恢复记录**：2026-09-22 17:1x 上游进入该状态（② 返回 404 unknown datasetID）；
> **18:4x 自行恢复**（② 回到 200 / 122 KB），SST 队列无需干预即续上：
> 1704 → 2315 天（80 分钟 +611 天，4 个 worker 在跑 2021 年第二遍复查）。
> 整段时间里渔场（GFW）与本地锋面（Zenodo）队列不受影响，一直在跑。

**GFW 的「取数失败：None」**：`fetch_range()` 原先只在"网络/解析异常"分支记 `last_error`，
若 5 次重试全是 429，`last_error` 仍是 `None` → 报错没头没尾。已修（429 分支同样记录原因）。
真遇到 429 密集不用手忙脚乱：当年的第二遍复查（`--passes 2`）会自动补漏，或把 `--workers` 降到 2 减半请求速率。

**关键实测：Zenodo 的链接选哪个差别 7 倍**

| 链接 | 速率 |
|---|---|
| `https://zenodo.org/api/records/20356239/files/front_location.zip/content` | 17–29 KB/s，range 频繁超时（`remotezip` 读中央目录直接失败） |
| `https://zenodo.org/records/20356239/files/front_location.zip?download=1` | **198 KB/s**，2 MB range 10 秒拿完 |

`fetch_zenodo_front_samples.py` 已默认走后者（`--archive-url` 可覆盖）。另外实测**服务器到 Zenodo 只有 17 KB/s**（换链接也一样），所以锋面只能本地取再上传；本地单连接约 116–198 KB/s，4 路并发下 14,610 天约 11 小时。

**没下的东西**：`front_intensity_YYYY.zip`（43 个分年包，共约 90 GB）——40 GB 磁盘只剩 33 GB，装不下；要用得先扩容或按年挑。

**ERDDAP 会在并发压力下瞬时返回 404**（2026-09 实测）：SST 队列 2021 年有约 200 天报
`RuntimeError: HTTP 404`，但事后用**完全相同的双变量请求**单独拉同一天返回 200（99,168 / 122,540 字节）。
所以这不是数据缺失，而是限流式瞬时错误 → 对策是**多试几次**（`sst_pipeline.py` 默认 `--retries 8 --retry-wait 5`）
加上"每年紧跟一轮复查"的排法；2020 的缺口当天就回填了（226 → 251 → …）。

## 在 VS Code 里看服务器（日常观察入口，2026-09-22 起）

本机工作区根目录带了 `.vscode\tasks.json`（`F:\project\海洋锋面\.vscode\tasks.json`，本地文件、未纳入 git —— 仓库 `.gitignore` 忽略了 `.vscode/`），`Ctrl+Shift+P → Tasks: Run Task` 里可直接选：

| 任务 | 作用 |
|---|---|
| `服务器：SSH 会话（交互式）` | 开一个连到服务器的终端（`ssh ocean`），日常操作都在这做 |
| `服务器：体检` | load / 内存 / 磁盘 / uvicorn 进程 |
| `服务器：数据增长` | 三类文件数 + 磁盘占用（连按两次就能看增量） |
| `服务器：接口自测` | catalog / point / raster 计时，带 `X-Catalog-Cache`、`X-Raster-Cache` 响应头 |
| `服务器：日志` | 三条队列 + `ocean-api` 最近日志 |

`ocean` 这个主机别名写在 `C:\Users\<你>\.ssh\config`：

```sshconfig
Host ocean
    HostName 116.62.54.140
    User root
    IdentityFile ~/.ssh/id_ed25519_ocean
    ServerAliveInterval 30
```

想开**一整个 VS Code 窗口**连服务器（左侧文件树就是 `/opt/ocean`、`/srv/ocean`，还带集成终端）：
装扩展 `ms-vscode-remote.remote-ssh`，然后 `Ctrl+Shift+P → Remote-SSH: Connect to Host… → ocean`；
也可以在终端里直接 `code --remote ssh-remote+ocean /opt/ocean`。

> 服务器上现成有 `htop` / `watch` / `jq`；`iotop`、`nload`、`ncdu` 没装（要看网络得先 `apt install nload`）。

## 服务器性能基线（2026-09-22 实测：4.0 GB / 4557 个文件，三条队列同时在跑）

| 项目 | 实测 |
|---|---|
| 主机 | load **0.17**（2 vCPU）、内存 1.2/3.5 GiB、磁盘 7.6/40 G、CPU 空闲 85–98%、`si/so=0` 零换页 |
| `/api/catalog`（优化前） | 0.38 s / **414 KB**，20 并发最慢 **9.4 s**（单 worker 串行 + 每次重扫 + 4557 个文件名全列） |
| `/api/point/{date}` | 0.87 s（要读 front + sst 两个 .nc 并解算） |
| `/api/fishing/availability` | **0.014 s** / 81 KB |
| `/api/analysis/{date}` | 0.56 s / 657 KB（**不缓存** → 前端图层优先用 raster + point，别整段拉 GeoJSON） |
| raster `kind=sst` | 0.44 s 冷；命中后 `X-Raster-Cache: hit`，`X-Raster-Scale` 由 `.scale` 旁车返回 |
| `POST /api/data/index/rebuild` | 4575 个 .nc → **10.5 s**（队列按年重建完全够用） |
| uvicorn | 单 worker 常驻 205 MB → 已改 **2 worker** |

结论：**瓶颈在公网出口，不在服务器**——三条队列满速取数时服务器 CPU 基本闲置。所以能本地取的（Zenodo 锋面）就本地取、再上传。

### `/api/catalog` 的改动（2026-09-22，就是这么优化的）

1. **默认不返回逐文件清单**：`files` 默认空数组，响应从 414 KB 掉到几 KB；老调用方要清单就加 `?files=true`。
   响应新增 `files_included`（本次是否带清单）与 `cached`（是否命中缓存），并且**总是**返回 `X-Catalog-Cache: hit|miss` 头。
2. **目录指纹缓存**：指纹只遍历目录、不逐个 stat 文件（几千个文件也只毫秒级），任一目录 mtime 变化即失效；
   另加 15 s TTL 兜住"文件被原地覆盖"。`?refresh=true` 强制重扫，`POST /api/data/index/rebuild` 后自动清缓存。
3. **目录扫描串行化**：并发请求同时 miss 时只让一个真正 rglob（双检后其余复用同一结果），
   否则 20 路并发 = 20 次全目录扫描，最慢又回到秒级。
4. **uvicorn 1 → 2 worker**：单 worker 下 20 并发会排队到 9 s；实测每 worker 常驻 205 MB，2 个仍远低于 4 GiB。

四步之后的实测（数据 4.9 GB / 5357 个文件、三条队列仍在写入）：

| 场景 | 优化前 | 优化后 |
|---|---|---|
| catalog 冷（真实扫描） | 0.38 s / 414 KB | **0.17–0.24 s / 47.7 KB** |
| catalog 命中缓存 | — | **0.0098 s** |
| 20 并发最慢 | **9.4 s** | **0.54 s** |
| raster sst 2°（命中） | 0.44 s | **0.065 s** |
| point 2021-02-10 | 0.87 s | 0.58 s |


## SST 色标自适应（2026-09 修）

图层色标原先固定 22–33 ℃（按夏季调的），新增全年数据后 **2024-01-15（13.2–18.2 ℃）与 2024-12-01（18.8–21.4 ℃）渲染出来只有 1 种颜色、整幅一个平色**。
现在 `raster_render.sst_scale()` 按当前窗口 2%/98% 分位算上下限、并保证至少 4 ℃ 跨度；
实际色标通过 **`X-Raster-Scale: vmin,vmax`** 响应头返回（缓存命中时也返回，存在同目录 `.scale` 旁车文件里），前端图例直接用它。
实测：2024-01-15 由 1 色变 402 色、2024-12-01 由 1 色变 216 色；极平稳场（30.0–30.2 ℃）保持 41 色、不会被拉成噪声。
**改了色标要清缓存**：`rm -f /srv/ocean/data/cache/rasters/*`，否则会继续返回旧的平色图。

## 渔场（GFW）取数实测踩过的坑

| 现象 | 原因 | 处理 |
|---|---|---|
| `Invalid leading whitespace, reserved character(s), or return character(s) in header value` | 在 Windows 上生成 `/etc/ocean/gfw.env` 是 CRLF，Linux 下 `set -a; . file` 把 `\r` 吃进变量，请求头成了 `Bearer xxx\r` | 用 `printf` 写文件（或 `sed -i 's/\r$//'`）；脚本侧也已加 `clean_token()` 兜底 |
| 3 天区间的请求 `Read timed out (read timeout=180)` | 不分组时返回的是**每船·每格·每天明细**（实测 1 天 19488 行），区间一大服务端就超时 | 用 `--split-days` 拆成单日（实测单日约 18s），或 `--group-by GEARTYPE` 让服务端先聚合（实测同一区间 29s 返回） |
| `429 速率受限` | 连续请求触发限流 | 脚本会退避重试（20/40/60s…）；把 `--retries` 调到 5 并接受慢一点 |
| 接口里某些日期汇总为 0 | 老版脚本只在整轮跑完才写 `manifest.json`，中途失败/分批抓取就没有索引 | 现已逐日落盘并与旧 manifest 合并；必要时 `--rebuild-manifest` |
| 直接 `nohup /tmp/x.sh &` 报 `Permission denied` | 上传的脚本没有可执行位 | `chmod +x`，或显式 `bash /tmp/x.sh` |
| 分批抓取后老日期从索引里消失 | 循环里复用了 `existing` 变量名，把"待跳过的文件路径"赋给了它，合并时旧日期被丢弃 | 已修（改名 `day_file`）；回归方式：跑完看 `availability` 是否有 0 汇总的天 |

## 编码约定（改动后必须遵守，`.gitattributes` 已锁死前三项）

| 文件 | 换行 | 编码 | 由谁保证 |
|---|---|---|---|
| `deploy/remote-setup.sh`、`deploy/nginx/ocean.conf`、`deploy/systemd/*.service` | **LF** | UTF-8 **无 BOM** | `.gitattributes` 里 `eol=lf`，即使本机 `core.autocrlf=true` 也不会被换成 CRLF |
| `deploy/deploy.ps1`、`deploy/probe-ports.ps1` | **CRLF** | UTF-8 **带 BOM** | `.gitattributes` 里 `eol=crlf`；**BOM 属于内容，必须自己保留**（缺 BOM 时 PowerShell 5.1 按 GBK 解中文 → 一堆假语法错误） |
| `*.md` 文档 | 由 git 归一化为 LF | UTF-8 | `* text=auto eol=lf`，无需手工干预 |

> 自查命令（逐字节看 BOM 与 CR）：
> ```powershell
> $p='deploy\remote-setup.sh'; $b=[System.IO.File]::ReadAllBytes((Resolve-Path $p)); 'BOM=' + ($b[0] -eq 239) + ' CR=' + (($b | Where-Object { $_ -eq 13 } | Measure-Object).Count)
> ```
> 期望：`.sh/.conf/.service` → `BOM=False CR=0`；`.ps1` → `BOM=True CR>0`。

## 回滚 / 迁移 / 成本

- **回滚代码**：本地 `git revert <commit>` 或 `git reset --hard <tag>`（见仓库 tag 列表）；服务器重跑 `deploy.ps1`。
- **到期迁移（2026-12-21）**：`mysqldump db_prac > db_prac.sql` + `tar -czf ocean-data.tgz /srv/ocean/data` + `tar -czf ocean-app.tgz /opt/ocean`。
- **成本提醒**：300 元抵扣额度**只含实例与系统盘**，不含流量；`data\raw` 约 118 MB 走公网流量，一次上传成本可忽略，但站点被反复访问要留意。
- **合规提醒**：底图目前是 Natural Earth（公有领域），**仅限原型期**；对外发布前必须换成有审图号的合规底图。
