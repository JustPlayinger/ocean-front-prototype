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

### 访问入口与域名（2026-09-23）

| 入口 | 可用性 | 说明 |
|---|---|---|
| `http://116.62.54.140/` | ✅ 公网可达（外部实测 200） | 主入口。本机无 ufw/iptables 拦截，nginx 监听 0.0.0.0:80；对外可达说明 **ECS 安全组已放行 80（0.0.0.0/0）** |
| `http://haifeng.116-62-54-140.sslip.io/`<br>`http://ocean-front.116-62-54-140.sslip.io/` | ⚠️ **外部不可用（2026-09-26 实测）**：阿里云按**域名**拦截未备案站点（HTTP 403，响应头 `Server: Beaver`、页面标题 `Non-compliance ICP Filing`）——**与我们的 nginx 无关**（服务器本机带同一个 Host 头是 200，`Server: nginx`） | **免注册别名**：sslip.io / nip.io 是公共通配 DNS，`任意前缀.<IP 连字符形式>.sslip.io` 直接解析到该 IP。nginx 里已加精确名 + `~^.+\.116-62-54-140\.sslip\.io$` / `~^.+\.116\.62\.54\.140\.nip\.io$` 通配（改前请读 `deploy/nginx/ocean.conf` 顶部四条决策）。代价：名字里仍带着 IP；依赖第三方 DNS，国内解析可能不稳。**结论：对外只用 `http://116.62.54.140/`**；别名/正式域名要等 ICP 备案（备案后证书与 443 才有意义——当前 nginx **只监听 80**，未开 HTTPS） |
| 团队本机 hosts 别名 | ✅ 只影响自己机器 | Windows：`Add-Content $env:windir\System32\drivers\etc\hosts "116.62.54.140 haifeng.demo"`（需管理员）；macOS/Linux：`echo "116.62.54.140 haifeng.demo" | sudo tee -a /etc/hosts`。之后浏览器直接敲 `http://haifeng.demo/` |
| **正式域名**（如 `haifeng.example.com`） | ⚠️ 暂不建议 | 国内 ECS 用域名对外提供 Web 服务**必须 ICP 备案**（未备案域名指向本机会被阿里云拦 80 端口）；地图类内容对外发布还需**审图号 + 合规底图**。备案与审图号办好之前，请用上面的 IP / 别名 / hosts |
| 免费子域（duckdns.org / freedns.afraid.org） | 需你注册 | 给我「域名 + 更新 token」，我把解析更新脚本挂到服务器（cron）并加进 nginx server_name；同样受"未备案域名"这条约束 |

**核对公开可达性**（不依赖自己的网络）：
```bash
# 服务器侧：确认在听、没被本机防火墙拦
ss -ltnp | grep ':80 '           # 应看到 0.0.0.0:80
ufw status; iptables -S | head   # 本机应为 inactive / ACCEPT
# 外部侧：用第三方抓取服务或手机热点打开 http://116.62.54.140/（能看到地图即达标）
```
> 注意（2026-09-26 更正）：此前把「别名从外部访问 403」归因于云端抓取服务的出口策略，**是错的**——
> 真正原因是**阿里云对未备案域名的 ICP 拦截**（响应头 `Server: Beaver`，页面 `Non-compliance ICP Filing`）。
> 判断服务器是否正常请用 **IP 直连**或 nginx 日志（`tail -f /var/log/nginx/access.log`）；本机自测要带 Host 头：
> `curl -H 'Host: haifeng.116-62-54-140.sslip.io' http://127.0.0.1/`（本机会 200，不代表外部可达）。
> 另：`sites-enabled` 里**别留 `*.bak` 文件**——`include /etc/nginx/sites-enabled/*` 会把备份也加载成生效配置，
> 造成重复 `server` 块（conflicting server name），排查时极易看错（2026-09-26 踩过，已移到 `/etc/nginx/backup/`）。

### 数据铺满：按视野取数（2026-09-23 上线，v1.10）

`GET /api/frontend/day/<date>` 支持 `bbox=minLon,minLat,maxLon,maxLat` 与 `step=1|2|4|10|20|40`：

- **为什么**：原始锋面数据本身是全球 0.05°（7200×3600/天），但全球 0.05° 单日 payload 15.7 MB / 25s 不可行；
  于是按「当前视野」取数，并按窗口宽度自动降一档（`≤25°`→0.05°、`≤60°`→0.2°、`≤120°`→1°、更大→2°）。
- **口径**：概览窗口 `objects`/`front_line` 恒为空（1° 的聚合格不是锋面对象），返回 `front.overview` 标明
  step / 分辨率 / 聚合规则；卡片统计与对象清单永远用 0.05° 主片（前端 `OFData.patches` 里 `primary: true` 的那片）。
- **实测**（服务器上 `bash /tmp/probe-bbox.sh` 同款命令）：默认窗口 1.0 s / 360 KB；全球 1° 首次 2.5 s / 284 KB、
  命中 **0.025 s**；全球 2° 89 KB；东亚 60° 窗口 1.2 s / 311 KB。
- **缓存**：`/srv/ocean/data/cache/frontend_payload/v1_<date>_<bbox>_<step>.json`，上限 150 个文件
  （超出按 mtime 淘汰最旧）；改出数口径时把 `frontend_payload.CACHE_VERSION` +1，否则旧缓存会被继续命中。
  查缓存：`ls -lt /srv/ocean/data/cache/frontend_payload | head`、`du -sh`；清缓存：`rm -f .../v1_*.json`（安全，随时重算）。
- **运维核对**：`curl -s -D- -o /dev/null "http://127.0.0.1:8000/api/frontend/day/2024-08-05?bbox=-55,25,-35,45"`
  看 `X-Payload-Cache` 与 `%{time_total}`。
- **流量特征**：页面启动/换日期时前端会**预热一次全球 2° 概览**（`bbox=-180,-90,180,90&step=40`，≈89 KB），
  之后每个新视野窗口再各一次；同一窗口不重复取，失败 20 s 后才重试。日常演示每天的请求数是个位数。

### 上游不可用时的换源（2026-09-25 实战）

**症状**：`coastwatch.noaa.gov/erddap` 的 `/` 正常返 200，但 `/erddap/*` 一律 **40s 超时**；
镜像 `coastwatch.pifsc.noaa.gov` / `erddap.aoml.noaa.gov` 上数据集在索引里（`.dds` 能出维度）
却**取数 404 / info 404 / 索引式请求 500** —— 同族数据集共用后端，一坏一起坏。
结论：**这是 NOAA 服务侧的故障，我们改不了，也没必要等** —— 换一条独立链路即可。

**换源方案（已落地）**：NCEI 的 **OISST v2.1 0.25° 全球逐日直连文件**（1981-09 至今）：
```
https://www.ncei.noaa.gov/data/sea-surface-temperature-optimum-interpolation/v2.1/access/avhrr/{YYYYMM}/oisst-avhrr-v02r01.{YYYYMMDD}.nc
```
- ⚠️ 目录是 **年月**（`202401`），不是年（`2024` 会 404）；变量名是 **`sst`**（不是 `analysed_sst`）；
  实测单日 1.55MB、0.25°（1440×720）、国内链路单流 40–85s。
- 取数脚本：`tools/pipeline/fetch_oisst_ncei.py`（`--years/--dates`、并发线程 `--workers`、
  跳过已存在、`.part` 原子写入），落到 `raw/sst_global/0p25deg/<年>/`，后端自动当"最细可用档"之一。
- 执行入口：`tools/pipeline/sst_plan.sh` 的 **E 阶段**（放在最前，因为它当下就能跑）；
  ERDDAP 恢复后 B/C/D 会自动接力（守卫会等，但不空烧）。
- 用这套跑两年（731 天）：约 **1.1GB / 5–6 小时**（3 线程实测 ~2.2 天/分钟）。

**已知状态（2026-09-27 检查）**：全球三档（`1deg` / `0p2deg` / `0p25deg`）在 2023+2024 都已 **731/731 天**；
东海明细 **6,362/8,158**，缺口 1,796 天集中在 2002-09–2006、2007（119 天）、2009（91 天）、2010（3 天）。
2026-09-26 那次 A 阶段被两个原因一起挡下：磁盘可用 4.9GB < `sst_pipeline.py` 默认的 6GB 门槛
（日志 `磁盘可用 4.9 GB 低于 6.0 GB，停止队列`），守卫重试 24 轮无进展后整个计划退出。
**2026-09-27 已恢复**：ERDDAP 自愈（`status.html` 与取数都是 200），计划重跑后 A 用
`--min-free-gb 4` 续跑——A 只剩 1,796 天 × 0.12MB ≈ 0.22GB，6GB 门槛属于误伤（盘 40G／已用 33G／剩 5.2G）。
真要再腾空间，最划算的仍是删 `sst_global/0p2deg`（4.5GB；它被 0p25deg 覆盖同两年，代价只是显示档 0.2°→0.25°）。

**教训**：探活与取数要用同一链路（ERDDAP 阶段探 ERDDAP、NCEI 阶段探 NCEI）；
一种源挂了不该挡住另一种源（`sst_plan.sh` 里 `probe_ok erddap|ncei` 就是干这个的）。

**东海明细（0.05°）的备用源调研（2026-09-27）**：ERDDAP 挂掉的那两天，东海明细**完全没有第二来源**，
所以把候选逐一实测了一遍，结论照抄可省一次排查：

| 候选 | 实测结果 | 结论 |
|---|---|---|
| `coastwatch.noaa.gov/thredds` | catalog 首页 200，但 SST → `Blended and Coastwatch Cogridded (Level-4)` 下 4 个数据集**没有 urlPath**、无 NCSS | ❌ 空壳（数据后端与 ERDDAP 同源） |
| `www.star.nesdis.noaa.gov/pub/`（STAR 文件服务） | 可列目录、可下载、**支持 `Range`** | ✅ **CRW CoralTemp v3.1 在这里**，见下 |
| `coralreefwatch.noaa.gov/erddap`、`/thredds` | 404 | ❌ 不存在 |
| `cwcgom.aoml.noaa.gov`、`erddap.aoml.noaa.gov`、`oceanwatch.pifsc.noaa.gov` | 站点活着，但没有 `noaacwBLENDEDCsstDaily` 的可取数据（404） | ❌ 镜像不解决 |
| `podaac-opendap.jpl.nasa.gov`、AWS `noaa-crw-pds` / `noaa-geopolar-blended-pds` | 连不上 / 404 | ❌ |
| `erddap.emodnet.eu`（欧洲） | 可达，但只有欧洲产品 | ❌ 覆盖不到东海 |
| `mds.nmdis.org.cn`（国家海洋科学数据中心） | 可达 | ⚠️ 需网页端申请/登录，无法脚本化 |

**可用的备用源**：CRW **CoralTemp v3.1**（5km ≈ 0.05°、全球逐日、**1985–至今**、GHRSST L4）
```
https://www.star.nesdis.noaa.gov/pub/socd/mecb/crw/data/5km/v3.1_op/nc/v1.0/daily/sst/{YYYY}/coraltemp_v3.1_{YYYYMMDD}.nc
```
- 脚本：`tools/pipeline/fetch_coraltemp_crw.py`——整球下载（**带 `Range` 断点续传**）→ 裁到东海窗口（落盘 ~120KB）
  → 删整球文件；输出与 ERDDAP 版**同目录、同命名、同变量**（`raw/sst/<年>/sst_<yyyymmdd>.nc`、`analysed_sst`），后端/前端零改动。
- 代价：整球单日 **11.5MB**、国内单流约 20KB/s（一天约 10 分钟）→ **只在 ERDDAP 不可用时用**（ERDDAP 一天 0.1MB）。
  全历史（2002–2024，约 1,800 天缺口）全量换源 ≈ 21GB 流量、数十小时，应急补几十天可以，别当日常方案。
- ⚠️ **产品不同源**（CoralTemp ≠ Geo-Polar Blended Night）：换源期间页面与台账必须标注，不能与 ERDDAP 版混为一谈。
- 想切出与 ERDDAP 版**逐格一致**的 141×161，要传 `--bbox 119.9,26.9,128.1,34.1`（CRW 格点在 `*.025` 上；
  默认 `120,27,128,34` 会少最东/最北各一格 → 140×160）。
- 实测这条链路**会断流**（11.5MB 下到 3.3MB / 0.66MB 就报 `IncompleteRead`），所以脚本里「Range 续传 + 运行内重试」
  是主路径、不是兜底；另外"本地已下完"时服务器会回 **416**（Range 起点越界），脚本按"已完整"处理——
  这条别当失败，否则下好的整球文件会被白白删掉重来（2026-09-27 两个坑都踩过）。
- 长跑要用 `setsid nohup ... &`（和计划脚本一样）。实测用普通 `nohup` 在 ssh 会话结束时会被带走，
  下载停在半截（临时文件不再增长）——**这不是脚本坏了**，重跑会带着 `Range` 从断点继续。
  单日整球在国内链路要十几分钟且会反复断流，属于"能跑但不轻松"，别指望它快。





- `raw/sst/`（东海 120.03–128.02°E / 27.02–34.03°N，0.05°，5,300+ 天，≈640MB）：**作业海域的明细**，
  由 `tools/pipeline/sst_pipeline.py` 逐年补（后台常驻，2022 → 2002）。
- `raw/sst_global/<分辨率>/`（全球，按分辨率分目录；**目录名 = `0.05°×stride` 去掉小数点 + `deg`**：
  `1deg` = `--stride 20` ≈0.27MB/天、`0p2deg` = `--stride 4` ≈6.2MB/天、`0p25deg` = `--stride 5`、
  `1deg` 与 `0p2deg` 可并存，后端**取最细的可用档**）：**别处的海温**。抓取（后台常驻、可续跑、跳过已存在）：
  ```bash
  cd /opt/ocean && OCEAN_RAW_DATA_DIR=/srv/ocean/data/raw \
    setsid nohup /opt/ocean/venv/bin/python tools/pipeline/sst_global_pipeline.py \
      --stride 20 --years 2024 2023 > /var/log/ocean-sst-global.log 2>&1 &
  ```
  后端 `GET /api/frontend/day` 会同时给 `sst`（东海明细）与 `sst_coarse`（全球，取最细可用档），
  前端粗格垫底、明细压上；**粗格也做显示层 LOD**：窗口像元数超过 20 万就隔格取样
  （0.25° 整球 1440×720 → 隔 3 格 0.75°），否则球面档一个 payload 会有几十万条游程。
- **当前排期（`tools/pipeline/sst_plan.sh`，v3 · 上游探测 + 阶段级自愈 + 幂等跳过）**：**先全球、后东海**——
  B 全球 1°：2024+2023（731 天）→ C 全球 1°：2022+2021（730 天）→
  D 全球 **0.2°**：2024+2023（`--stride 4`，731 天 ≈4.5GB）→ A 东海明细 0.05° 续跑（8,401 天）；
  0.05° 全分辨率那行默认注释（两年≈80–100GB，需先扩盘到 200GB 级）。
  守卫规则：**按"目标目录 + 年份"计数**，已满足期望天数的阶段直接跳过（重跑幂等）；没跑够就继续，
  某一轮零进展就等 10 分钟重试（最多 24 次，有进展则重置计数）——不会"失败一次就把队列跑空"。
  探测用的请求与真实抓取同形状（**不要用 `.dds` 或单点带时间戳的采样** —— 那两种在 ERDDAP 上经常
  超时/404，会让脚本误判"上游没恢复"而干等，2026-09-24 踩过）；
  另有兜底信号：目标目录最近 5 分钟有新文件落盘就直接放过。
  ⚠️ 目录名与分辨率的对应关系别记错：`res_label(stride) = 0.05×stride` → stride 4 = **0.2°（`0p2deg`）**，
  stride 5 才是 0.25°（2026-09-25 就因为写错目录名，导致"数据在落盘、守卫却说没产出"）。
- 单日全球子集在 ERDDAP 侧要现裁 1–3 分钟，**必须 nohup/setsid**（前台 ssh 一断就被杀）。
- **查看进度**（两年 731 天 · 1° · 3 路，实测约 40 秒/天/路 → 全部约 2.6 小时）：
  ```bash
  find /srv/ocean/data/raw/sst_global -name '*.nc' | wc -l   # 已落盘天数（目标 731）
  tail -3 /var/log/ocean-sst-global.log                      # 队列日志
  tail -2 /tmp/sst-global-w0.log                             # 单路进度
  du -sh /srv/ocean/data/raw/sst_global                      # 单日 268KB
  ```
  脚本跳过已存在的日期，**中断后重跑即续跑**；磁盘低于 `--min-free-gb`（默认 4G）会自动停。
- ⚠️ ERDDAP 偶发 `Currently unknown datasetID=...`（上游在重载数据集，不是我们的错）：
  脚本带 `--retries` 会自己重试；大面积 404 时先等上游恢复（见 §6 排障表）。
- **自动计划（推荐用法，v1.11 起）**：`tools/pipeline/sst_plan.sh` 会先探上游，404 时每 5 分钟再探
  （不空烧重试），恢复后按顺序跑：
  A 东海明细 0.05°（续跑）→ B 全球粗格 1°：2024+2023 → C 全球粗格 1°：2022+2021 →
  D 全球高分辨率（默认注释掉，需明确决定）。启动：
  ```bash
  cd /opt/ocean && setsid nohup bash tools/pipeline/sst_plan.sh > /var/log/ocean-sst-plan.log 2>&1 &
  ```
  ⚠️ 脚本必须 **LF 换行**（Windows 写的 .sh 带 CRLF 会让 bash 报 `$'\r': command not found`；
  服务器上修：`tr -d '\r' < f > f.tmp && mv f.tmp f`）。
- **全球高分辨率的体积（实测元数据折算，2026-09-23）**：源数据 `analysed_sst` 是 float32，
  全球 0.05° = 7200×3600 ≈ 2,592 万格 → **约 110–135 MB/天**（东海那批 161×141 实测 118 KB/天，
  折算单格约 5.2 字节）。所以：

  | 分辨率 | stride | 单日 | 2023+2024（731 天） | 2002–2024（8,400 天） |
  |---|---|---|---|---|
  | 0.05° 全分辨率 | 1 | 110–135 MB | **80–100 GB** ✗ | 1.0–1.3 TB ✗ |
  | 0.25° | 4 | ≈6.7 MB | ≈5 GB ✓ | ≈56 GB ✗ |
  | 0.5° | 10 | ≈1.7 MB | ≈1.2 GB ✓ | ≈14 GB ✗ |
  | 1°（当前粗格） | 20 | ≈0.27 MB | ≈0.2 GB ✓ | ≈2.3 GB ✓ |

  盘现在 40 GB / 剩 12 GB → 想跑 0.05° 的 2023+2024 **必须先扩盘**（建议 ≥200 GB）；
  不扩盘的话 0.25° 是"全球都看得见、又比 1° 细 4 倍"的现实选择。
- ⚠️ **发布后核对前端版本**：改完前端用**公网 URL** 核对内容指纹，别用 `curl 127.0.0.1` + `Host:` 头
  （本机回环那条路径可能落到另一个站点/缓存，会得出"没生效"的错误结论）：
  `curl -s http://116.62.54.140/prototype-fishing.js | md5sum` 对比 `md5sum /opt/ocean/frontend/prototype/prototype-fishing.js`，
  或直接 `curl -s ... | grep -c resolutionLabel` 之类按版本特征定位。

### 图层与锋面强度（2026-09-23 上线）

- **图层开关**在地图**左上角**「☰」呼出的抽屉里（默认收起）：鼠标靠近地图左边缘 28px 自动呼出、
  移开 0.6s 自动收起，点 ☰ 可固定展开、✕ 收起。共 7 个图层；机制仍是
  `data-layer` + `state.layers`，新增图层只要在 HTML 加一行并在 `drawDataLayers()` 里加一段绘制。
- **数据窗口**：离线兜底是东海（120–128°E / 27–34°N，62 天）；服务器模式默认窗口 **105–150°E / 3–45°N**
  （0.05°，锋面对象 10 → 200 个），实测 391~361 KB / 0.67~1.0s。
  v1.10 起球面/大洲尺度**也**有真实数据：前端按视野请求 `bbox`，全球用 2° 概览（89 KB / 1.7s，缓存后 0.03s），
  不再是"全球 15.7 MB 不可行"；`OFData.patches(iso)` 里一天可同时有多片（主片 0.05° + 概览片），渲染按粗→细叠加。
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

### 地图视野：从整颗地球到 0.05° 像元（2026-09-23 上线）

- **两档投影，同一套视野真源** `{lon0, lat0, zoom}`（可见经度跨度 `span = 5.556 / zoom`）：
  跨度 ≤ 40° 走**等距平面**（比例尺与 10/20/30 km 半径圈仍是真实 km），> 40° 自动切**正射球面**
  （纯 SVG，无新依赖；缩到最小＝整颗地球，可拖动转动）。切档瞬间球心比例连续，用 220 ms 淡入遮住形变。
- **底图三级 LOD**（都由 `tools/build-basemap.mjs` 生成，公有领域、离线提交，随包一起上传）：
  `data/base/basemap.js` 1:10m 东海（含等深线，≤10° 用）、`data/base/asia.js` 1:50m 西太平洋（10–40° 叠上）、
  `data/base/world.js` 1:110m 全球（>40° 用，跨 ±180° 的环生成时已切开，避免球面上连出横穿全球的假线）。
  ⚠️ 部署时**别漏传这三个文件**（`data/base/` 下应有 3 个 js），否则球面档只剩底色。
- **球面档口径**：只画世界轮廓 + 数据覆盖框（105–150°E / 3–45°N）+ 当天锋面对象线；**不画 0.05° 栅格**、
  不给 km 比例尺，地图顶部写明「放大到 40° 以内显示 0.05° 栅格」。
- **视野记忆**：停止操作 0.5 s 后写 `localStorage["of.view.v1"]`，下次打开回到上次停留的区域；
  服务器模式启动时不再无条件覆盖成 `SERVER_ZOOM`（用户上次的视野优先）。
- 交互：指针事件统一鼠标 / 触摸 / 笔；滚轮连续缩放、双击放大、`+/-` 与方向键、`◎` 回定位点、`🌍` 整颗地球 ↔ 数据窗口。
- 自检：`node tools/e2e-check.mjs` 的第 17.5 节 8 条（球面档、往返自洽、拖动、切回、视野记忆）+ `data-check` 的底图 LOD 断言；
  截图 `%TEMP%\shot-11-globe.png`、`shot-12-plane-wide.png`、`shot-13-memory.png`。

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
| ping 通、`probe-ports` 显示 22/80 **OPEN**，但 `ssh` 卡在等 banner、`curl` 一个字节都没有 | **服务器用户态僵死**。2026-10-09 实测死因是**无 swap 下的内存超售 + 进程/线程风暴**（`%commit` 154.73%、`plist-sz` 6833、磁盘读 194 MB/s → 成片进程卡 D 状态）；**盘满 / OOM / 22 被爆破都不是本次死因**，与安全组、本机网络也**无关** | 见文末「事故处置：服务器『假死』」；只能去控制台重启，进去立刻跑末节取证命令（重点 `sar -r/-q -f /var/log/sysstat/sa<日>`），再按末节 ⑤① 加 swap + 限并发 |

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

## 事故处置：服务器「假死」——TCP 能握手但没有响应（2026-10-09 实录）

判读固定为**三层**，少测一层就会误判（第一反应通常是「安全组 / 网络」，实际是机器自己僵了）：

| 探测 | 假死时 | 正常时 | 这层证明了什么 |
|---|---|---|---|
| `ping 116.62.54.140` | ✅ 通（约 35 ms，0% 丢包） | 通 | 只有主机网络层活着 |
| `deploy\probe-ports.ps1 -ServerIp 116.62.54.140 -Ports "22,80"` | ✅ **OPEN** | OPEN | 三次握手由**内核**完成，只证明安全组放行 |
| `ssh -o ConnectTimeout=10 root@116.62.54.140 "echo ok"` | ❌ 卡在等 banner（20 s 收不到 `SSH-2.0-OpenSSH…`） | 秒进 | banner 要 **sshd** 参与 → 用户态 |
| `curl.exe -m 5 -o NUL -w "%{http_code}" http://116.62.54.140/` | ❌ 一个字节都没有 | 200 | HTTP 要 **nginx** 参与 → 用户态 |

**口径**：前三层都通、banner/HTTP 全无 = **内核活着、用户态进程被卡死或被内核杀光**。
先在本机 `curl.exe -m 5 http://223.5.5.5/` 做对照，正常就说明**不是你的网络** —— 此时**不要再翻安全组**。

### 重启后取证：真凶是 **无 swap 下的内存超售 + 进程/线程风暴**（2026-10-10 逐帧核对；**推翻** 10-09 当晚「22 被爆破」与更早「盘满 / OOM」两个初判）

重启（10-09 22:52）后把**上一轮启动**（覆盖 09-29 10:00 → 10-09 20:58，约 10 天）的日志与 **sysstat 采样**逐条核对：

```bash
# —— 排除项：全部为 0 或极小 ——
journalctl -b -1 -k | grep -icE 'out of memory|killed process'   # → 0     ：不是 OOM（dmesg 重启后清空，必须查 -b -1）
journalctl -b -1    | grep -c  'No space left on device'         # → 0     ：不是盘满（ENOSPC 一次都没出现）
journalctl -b -1    | grep -cE 'sshd\['                          # → 1842  ：10 天累计（对照：本次启动 185 行），不是「上万行」
journalctl -b -1    | grep -c  'beginning MaxStartups'           # → 1     ：整个启动只触发 1 次，且在 20:58:31（崩前最后一刻）
journalctl -b -1    | grep -c  'banner exchange'                 # → 244   ：10 天累计，不是「一秒上百条」
journalctl -b -1    | grep -ci 'under memory pressure'           # → 32    ：★ 真凶侧证据，集中在 20:06–20:58
journalctl -b -1    | grep -c  'Connection reset by user root'   #         ：20:09 起我们自己的 ssh 就被 reset，
                                                                 #           logind 同时报 'Transport endpoint is not connected'

# —— ★ 最有用：sysstat 采样快照（不用控制台就能还原僵死前的资源曲线）——
sar -r -f /var/log/sysstat/sa09 -s 19:50:00 -e 21:05:00   # 内存：%memused / kbdirty / kbcommit / %commit
sar -q -f /var/log/sysstat/sa09 -s 19:50:00 -e 21:05:00   # 负载：ldavg / blocked / plist-sz（blocked>0 = 进程卡在 D 状态）
sar -d -f /var/log/sysstat/sa09 -s 19:50:00 -e 21:05:00   # 磁盘：tps / await / %util
sar -u -f /var/log/sysstat/sa09 -s 19:50:00 -e 21:05:00   # CPU：%iowait / %steal（%steal=0 → 不是云厂商偷算力）
```

**僵死前的资源曲线（sysstat 实录）**

| 时刻 | `%memused` | `kbcommit / %commit` | load / blocked | 磁盘（vda） |
|---|---|---|---|---|
| 19:50:22 | 21.41 | 1.77 G / 47.75% | 正常 | 空闲 |
| **20:00:22** | **40.69** | **3.10 G / 83.59%** | 1.00 / 0 | 4 tps |
| 20:10 – 20:50 | **采样全部缺失**（连 10 分钟一次的定时采集都跑不动，与「20:15 起外部断联」吻合） | — | — | — |
| **20:58:34** | **82.89**（`kbavail` 只剩 **58 MB**） | **5.75 G / 154.73%** | **84.29 / 90.49 / 89.38**；`blocked 10`；`plist-sz` **2162 → 6833** | **1413 tps / 读 194 MB/s / await 160 ms / %util 81.6%**；`kbcached` **1.34 G → 104 M** |
| 20:58:46 | 最后一行日志；此后**一行都没有**，直到 22:52 重启（journal 索引也不一致 = 硬崩） | | | |

**死因链（一句话）**：`commit` 冲到 **154.73%**（3.6 GB 内存、**0 swap**）＋进程数从 2162 暴涨到 **6833** →
直接回收 / 换页风暴 → 磁盘读被打满（`await` 160 ms、队列深度 226）→ 2 vCPU 上负载 **84**、成片进程卡在 D 状态 →
**用户态集体僵死**（连 `journald` 自己都写不出日志，所以最后 2 小时是空白）。磁盘 91% 满是**放大器**（页缓存没有周转余量），
但**不是** ENOSPC（0 条）。

**22 被扫描的真实定位（仍要加固，但不是根因）**：20:58:32 确有 `115.120.234.30` 一分钟内连开 12+ 连接、
触发过 `beginning MaxStartups throttling`（整个启动仅此 1 次），10 天累计 244 条 `banner exchange … invalid format`
—— 那是在机器**已经濒死**时又补的一脚（真实存在，但量级远不足以打死 sshd）。
另外：`last -i` 里的 `223.99.13.*` / `223.80.110.*` 是**我们自己的出口 IP**，不是攻击源（早先把它们当成爆破源是 grep 口径错误）。
**结论：先治内存，再收 22。**

- 口径修正（重要）：**「内核活着、用户态不响应」按 ⑤ 的顺序查** —— 先看 `%commit` / `plist-sz` / `blocked`（内存与进程数），
  再看 ENOSPC，最后才看 sshd 日志量。**盘满、OOM、被爆破都不是 10-09 的死因**；判读三层表照旧用。

### 这次实际怎么处置的（可照抄，含结果）

| 步 | 动作 | 结果 |
|---|---|---|
| ① | 控制台**重启**（**不要用「停止」**，会丢公网 IP） | 22:52 起来，`free -m` 内存回到 999 M / 3627 M |
| ② | 先断后路：确认**没有队列在跑**（本轮两条服务器队列已于 06:06 / 12:26 `队列跑完`） | 没有惊群重跑，`load 0.01` |
| ③ | 清盘：`rm -rf /root/.vscode-server/{cli,bin}`（VS Code Remote 可再生产物，**3.9 GB**）+ `journalctl --vacuum-size=50M`（45 MB）+ `rm -rf /srv/ocean/data/cache/*`（17 MB）+ `apt-get clean` | **91% → 80%，可用 3.6 GB → 7.6 GB**（10-10 00:09 加 1 GB swap 后为 **83% / 6.6 GB**） |
| ④ | 只补**唯一**数据缺口：单起渔场补缺队列（海温 8158 / 锋面 15706 已满，渔场 2019 缺 12 天） | 补齐后三口径全满 |
| ⑤ | 真机复测 `tools/ops/start-test-instance.sh`（start→health→stop，含「接管道」场景） | 全通过；`start` 修前接管道 40 s 卡死 → 修后 4.4 s 返回，8001 每次干净释放 |

> 取证结论一句话：**这是一台 3.6 GiB、0 swap 的小机器，被「队列 + 测试实例」把内存超额提交推到 154%、
> 进程数推到 6833，触发回收/换页风暴并打满磁盘读，最终用户态集体僵死**。
> 磁盘 91% 满是放大器、22 被扫描是噪声，都不是触发器。
> **对策的第一优先级是给 ⑤①「内存超售」加 swap + 限并发，而不是删数据、也不是先收 22。**


### 处置（按顺序，别跳步）

**① 控制台看监控（零风险，先做）**
实例 → 监控：24 h 的 **磁盘使用率 / 内存 / CPU** 曲线一眼分病因。顺手确认有没有装**云助手**（有就能在控制台直接执行命令，最省事）。

**② 只能从控制台救活：重启**
用户态已僵死，外部无计可施。实例 → 更多 → 实例状态 → **重启**（严重时用强制重启）。
⚠️ **不要用「停止」**：停机可能释放公网 IP（阶段 A2 的老坑），重启不会。
（VNC / Workbench 若能登进去，就先按 ③ 留证据再重启；登不进就直接重启。）

**③ 重启后先断后路、再看病因（先别让队列自己跑起来）**

```bash
df -h /; free -m; uptime
journalctl -b -1 -k | grep -iE 'out of memory|killed process' | tail -5   # OOM 只能查上一轮 journal！
                                                                          # （dmesg 重启后就被清空了，别用它查旧事）
journalctl -b -1 -n 40 --no-pager | tail -40                   # 上一次启动的最后遗言
systemctl --no-pager status nginx ocean-api | head -20
bash /opt/ocean/tools/ops/start-test-instance.sh status        # 8001 若有残留实例，先 stop
du -sh /srv/ocean/data/* 2>/dev/null | sort -h | tail -8       # 谁把盘吃掉了
```

**④ 急救清理（都是可重建的，删了会自动重算）**

```bash
journalctl --vacuum-size=50M
rm -rf /srv/ocean/data/cache/*          # raster / frontend_payload 缓存，安全（见「数据铺满」一节）
rm -rf /root/.vscode-server/{cli,bin}   # VS Code Remote 的运行时（可再生产物，2026-10-09 实测 3.9 GB），重连会自动重装
apt-get clean
: > /var/log/ocean-sst-pipeline.log; : > /var/log/ocean-gfw-pipeline.log; : > /var/log/ocean-api-test.log
df -h /                                 # 目标：≥ 6 GB（2026-10-09 实测 3.6 GB → 7.6 GB；10-10 加 1 GB swap 后为 6.6 GB）
```

**⑤ 对症下药（按 2026-10-09 的实测死因排序）**

- **① 内存超售 / 进程风暴 —— 10-09 的真凶，最高优先级：加 swap + 限并发**
  ✅ **2026-10-10 00:09 已在本机执行**（加了 1 GB swap + `swappiness=10`；盘 80% → **83%**、可用 6.6 GB）：

  ```bash
  # 本机原本 0 swap —— 这是被拖死的根本前提。加 1 GB swap（治本，风险最低；盘紧就 1 GB，宽裕再上 2 GB）
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -qE '^[^#]*[[:space:]]/swapfile[[:space:]]' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  printf 'vm.swappiness=10\n' > /etc/sysctl.d/99-ocean-swap.conf && sysctl -q -p /etc/sysctl.d/99-ocean-swap.conf
  swapon --show; free -m; sysctl vm.swappiness

  # 限并发：队列 --workers 2；给生产服务设内存上限（⚠️ 这一项【还没做】）
  systemctl edit ocean-api        # 加 [Service] MemoryMax=800M
  systemctl daemon-reload && systemctl restart ocean-api
  ```

  实测：`/swapfile 1024M` 已启用、`vm.swappiness=10`、`/etc/fstab` 已追加（备份 `fstab.bak-20261010-000918`），重启会自动挂载。
  ⚠️ swap 占盘后**扩盘优先级上升**（83%）：先清 `cache`，再按 ② 扩到 ≥ 60 GB。

  监控口径也要换：盯 **`%commit`（`sar -r`）+ `plist-sz` / `blocked`（`sar -q`）**，别只看 `free` ——
  本次 `%memused` 只有 40% 时 `%commit` 就已 **83.59%**，10 分钟后的采样直接整段断档。
  队列在跑时**不要**起 8001 测试实例（见 `deploy/COLLAB.md` §3.4）。
- **② 盘满**：清完仍紧就扩盘（控制台扩容后 `growpart /dev/vda 1 && resize2fs /dev/vda1`）。`raw`（26 GB）是正资产**别删**，要定期清的是 `cache`。
- **③ OOM**：这次**没有** OOM 记录（`Killed process` 0 条），别把它当默认答案；真出现时再降 `--workers`、加 `MemoryMax=`。
- **④ 22 端口被全网扫描（加固项；**不是** 10-09 的死因）**：
  1. 控制台 → 安全组 → 入方向：**22 只放行你和同伴的出口 IP/32**（顺序：先加新规则 → 验证还能登 → 再删 `0.0.0.0/0`；否则把自己锁在门外）；
  2. 可选加固：`apt-get install -y fail2ban`（自动封爆破 IP）；
  3. 可选抗爆破：`/etc/ssh/sshd_config` 里 `MaxStartups 4:50:10`、`LoginGraceTime 20` → 先 `sshd -t` 校验 → `systemctl reload ssh`（**reload 不断已建连接，别 restart**）。
     为什么降级：上一轮启动 10 天里 sshd 日志共 **1,842 行**、`MaxStartups` 只触发 **1 次**（20:58:31，机器已濒死）；
     收白名单是为了**消除噪声、别让扫描流量在你下次急救时抢 banner**，不是治死机。

**⑥ 恢复业务（顺序别反：先服务 → 健康检查 → 最后才拉队列）**

```bash
systemctl restart nginx ocean-api
curl -fsS http://127.0.0.1:8000/api/health && echo api-ok
bash /opt/ocean/tools/ops/start-server-pipelines.sh
ocean-ops health     # 顺便看有没有 PPID=1 的孤儿 fetch_*
```

**⑦ 复盘**：把控制台看到的峰值更新回 `deploy/COLLAB.md` §1.1 资源表（磁盘 / 内存两行）。

> **预防线**：`%commit` 超 80%、`plist-sz` 超 3000、`ldavg` 超「vCPU 数 × 2」、磁盘 85% —— **任一条命中就停手**（退队列 / 清缓存 / 扩盘）。
> 一键复查当天：`sar -r -f /var/log/sysstat/sa$(date +%d) | tail -3; sar -q -f /var/log/sysstat/sa$(date +%d) | tail -3`
> （本次事故就是 `%memused` 只有 40%、看着很闲，而 `%commit` 已经 83.59% → 47 分钟后整机僵死。）
> 僵死期间**全部**外部访问（ssh、页面、接口）同时不可用，只能靠控制台重启 —— 代价远高于提前加 swap、降一次并发。
