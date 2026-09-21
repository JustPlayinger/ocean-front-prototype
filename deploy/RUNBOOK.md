# 部署实施手册（RUNBOOK）

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
                                        └── systemd: ocean-api.service（用户 ocean，1 worker）
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
