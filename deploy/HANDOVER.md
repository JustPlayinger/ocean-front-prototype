# 交接文档 · 换电脑接手（2026-09-23）

> **读者：另一台电脑上的 AI 或人。** 目标：先拿到代码，再把服务器上的取数与服务接管起来、把没跑完的数据跑完。
> 本页是"怎么做"的清单；细节手册在 `deploy/RUNBOOK.md`（很长，**按需查，不要通读**）。
> 权威现状快照见 §4.1（时间戳写在那，久了就以服务器实测为准）。

---

## 0. 三十秒速览

- **服务器**：阿里云 `116.62.54.140`（Ubuntu 24.04，2 vCPU / 4 GiB / 40 GB 盘），
  FastAPI 后端 + nginx 前端已部署并常驻，数据在 `/srv/ocean/data/raw`。
- **三条取数队列**（都在跑，或需要你续跑）：
  | 队列 | 在哪跑 | 数据源 | 为什么在那 |
  |---|---|---|---|
  | 锋面 front | **只能在本地电脑跑**，再上传服务器 | Zenodo（18.3 GB zip，按天 Range 取） | 服务器直连 Zenodo 读 zip 中央目录会反复 `IncompleteRead`（实测） |
  | 海温 sst | **服务器**上跑 | NOAA CoastWatch ERDDAP | 服务器直连很稳 |
  | 渔场 fishing | **服务器**上跑 | GFW 4Wings API | 同上；token 在服务器 `/etc/ocean/gfw.env` |
- **接管要做的三件事**：**[A] 拿到代码**（⚠️ `restructure` 分支还没推到远端，见 §2）→
  **[B] 配好 SSH 密钥与别名**（§3）→ **[C] 检查并续跑锋面队列**（§4.3）。
  服务器上的两条队列不需要你启动（除非服务器重启过，那时跑一次 `start-server-pipelines.sh`）。

---

## 1. 三条硬约束（先记住，能省几小时）

1. **锋面只能在本地取**。服务器到 Zenodo 只有 ~17 KB/s，而且读 18.3 GB zip 的中央目录会反复
   `IncompleteRead`；本机走代理实测 116–198 KB/s。所以锋面永远是"本地下载 → scp 上传"。
2. **服务器上两条队列是 `setsid nohup` 后台进程，不是 systemd 服务**。服务器重启后要手动
   `bash /opt/ocean/tools/ops/start-server-pipelines.sh`（幂等）。只有 `ocean-api`、`nginx`、`mysql`
   是 systemd 服务（`systemctl status ocean-api`）。
3. **本机的锋面数据（12,339 个 .nc / 14.67 GB）既不在 git 里、也不在新电脑上**。
   新电脑**不要全量重下**（Zenodo ~198 KB/s，全量 15,706 天要 20+ 小时），
   而是**只补服务器还缺的年份**（一条命令，见 §4.3）。

---

## 2. [A] 拿到代码

- 远端：`origin` = `https://github.com/JustPlayinger/ocean-front-prototype.git`
  （另有 `demo`、`friend` 两个远端，历史遗留，**别推错**）。
- ⚠️ **`restructure` 分支有 34 个提交还没推**（`main` 只在 demo 远端后面，本地 `main` 比它多 3 个）。
  **先在旧电脑上推**：

  ```powershell
  cd f:\project\海洋锋面\ocean-front-prototype
  git push -u origin restructure
  ```

  推成功（需要 GitHub 凭据/令牌）再换电脑；**没推成功就别换**，否则今天所有修复（catalog 缓存、
  2 worker、sync 修复、ops 脚本…）都拿不到。
- **推不上去的兜底**：用 `git bundle` 把分支整个打包成单文件带走（不需要网络/远端）。
  **旧电脑上已经生成好一份**：`F:\project\海洋锋面\ocean-restructure.bundle`（1.39 MB，含 `restructure`
  完整历史，`git bundle verify` 通过）——直接拷到新电脑即可：

  ```powershell
  # 旧电脑（已执行过，需要更新时再跑一次）
  git bundle create C:\ocean-restructure.bundle restructure
  # 新电脑（bundle 就是个可以 clone 的仓库）
  git clone C:\ocean-restructure.bundle ocean-front-prototype
  cd ocean-front-prototype
  git remote set-url origin https://github.com/JustPlayinger/ocean-front-prototype.git
  git checkout restructure
  ```


- 新电脑：

  ```bash
  git clone https://github.com/JustPlayinger/ocean-front-prototype.git
  cd ocean-front-prototype
  git checkout restructure
  git log --oneline -1      # 期望看到 d539f32 或更新的提交
  ```

- 备选（不依赖 GitHub）：直接复制整个仓库目录过去（`.git` 必须带；`data/raw/`、`backend/.venv/`、
  `__pycache__/` 不必带）。
- 仓库只跟踪 203 个文件（代码+文档+前端离线兜底数据），`data/raw|processed|cache` 被 `.gitignore` 排除。

---

## 3. [B] 环境与 SSH 接入

### 3.1 需要的工具

- **Windows**：Python 3.12（≥3.11 均可）、Git、自带 OpenSSH 客户端即可。用 Anaconda 也行，但**别拿它装依赖**（见 3.2 的提醒）。
- **Linux / macOS**：`python3.12`、`git`、`openssh-client`。

### 3.2 后端环境（本地跑脚本/跑服务/跑测试）

```powershell
cd ocean-front-prototype\backend
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -U pip
.\.venv\Scripts\python.exe -m pip install -e ".[dev]"
.\.venv\Scripts\python.exe -m pytest -q        # 期望：5 passed
```

Linux/macOS 把 `.\\.venv\\Scripts\\python.exe` 换成 `.venv/bin/python`。

> ⚠️ **不要装 `netcdf4`**：它在 Windows 打不开非 ASCII 路径（本仓库在中文目录下），
> 且一旦装了会被 xarray 优先选中，导致 SST 与锋面全都读不了。`pyproject.toml` 里刻意没有它，
> 靠 `scipy`（SST 是 NetCDF-3 classic）与 `h5netcdf`（锋面是 NetCDF-4）双引擎。

### 3.3 SSH 密钥（**必须从旧电脑拷过来**，服务器只认这一把）

- 私钥 `id_ed25519_ocean`（**无口令**，411 字节）+ 同名 `.pub`（98 字节），旧电脑位置 `C:\Users\<你>\.ssh\`。
- **指纹核对**（这是判定"是不是这把"的唯一依据）：

  ```text
  SHA256:IPb2hUrat6S2VeGK3J7IzRY5ziF/PSAOrs1b6+i4RM4   ocean-front-ecs (ED25519)
  公钥：ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHD19i9zSlPPo/cxo84CJ1lYk1jsT98DnqUipMwjUTpU ocean-front-ecs
  ```

  2026-09-23 核对结果：本地 `~/.ssh` **只有这一对密钥**，服务器 `/root/.ssh/authorized_keys`
  **也只有这一把**，指纹完全一致 → 新电脑上只要这把私钥就能连。
- 拷到新电脑同一位置（Windows 记得只给当前用户读权限），然后建 `~/.ssh/config`：

  ```sshconfig
  Host ocean
      HostName 116.62.54.140
      User root
      IdentityFile ~/.ssh/id_ed25519_ocean
      IdentitiesOnly yes
      ServerAliveInterval 30
  ```

- **验收**：`ssh ocean 'echo ok; uptime'` 有输出即可；再跑 `ssh ocean 'ocean-ops health'` 看主机状态。
  没有 config 时也能直接连：
  `ssh -i <私钥路径> root@116.62.54.140 'echo ok'`。

> **安全提醒**：这把私钥**没有口令**，谁拿到文件谁就是那台服务器的 root。
> 转交请走 U 盘 / 加密压缩包等可信渠道，别贴聊天记录、别放网盘公开链接，用完记得从临时位置删掉。
> 顺带：GFW 的 token 不在本地，在服务器 `/etc/ocean/gfw.env`（新机器不需要它，除非要把渔场队列搬到本地跑）。

### 3.4 VS Code（可选，但强烈建议）

- 装扩展 **`ms-vscode-remote.remote-ssh`** → `Ctrl+Shift+P` → `Remote-SSH: Connect to Host…` → `ocean` →
  打开 `/opt/ocean`，就能直接看服务器上的代码、日志、数据目录。
- 工作区 `.vscode/tasks.json`（一键"服务器体检/数据增长/接口自测/日志"）**不在 git 里**
  （`.gitignore` 忽略了 `.vscode/`）：想用就从旧电脑 `F:\project\海洋锋面\.vscode\tasks.json` 拷过去，
  或按 RUNBOOK「在 VS Code 里看服务器」一节自己加。

---

## 4. [C] 三条队列：现在什么状态、怎么续、怎么算跑完

### 4.1 现状快照（2026-09-23 10:00 实测；以后一律以 `ocean-ops years` 为准）

| 数据集 | 本地 | 服务器 | 还缺 |
|---|---|---|---|
| 锋面 front | 12,339 个（14.67 GB），已下到 1991 | 约 4,900 个（正在逐年上传） | 本地：1991 部分 + 1990→1982；服务器：1991→1982 还没传完 |
| 海温 sst | —（只在服务器） | 4,842 个（2011 进行中；2012–2024 已完成） | 2011 剩约 200 天 + 2010→2002（约 3,290 天） |
| 渔场 fishing | — | 2,307 天（2024 完整；2017–2023 有缺口） | 约 615 天（第三轮补缺正在跑） |

服务器盘：40 GB 里已用约 11 GB。三条队列各有磁盘护栏（`--min-free-gb`），空间不够会自己停。

### 4.2 服务器上的两条队列（海温 / 渔场）

```bash
ssh ocean
ocean-ops health       # 主机 + 进程（fetch_* 的 PPID=1 表示独立后台进程，正常）
ocean-ops years        # 逐年覆盖矩阵（锋面/海温/渔场）
ocean-ops growth       # 30 秒增长窗口：确认"真的在长"
ocean-ops logs         # 三条队列日志 + ocean-api 日志
ocean-ops erddap       # 上游 ERDDAP 体检（海温卡住时先看这个）
```

- **服务器重启后必做**：`bash /opt/ocean/tools/ops/start-server-pipelines.sh`（幂等，已在跑就跳过）
- **补缺口**：`bash /opt/ocean/tools/ops/start-gap-fills.sh`（渔场第三轮 + 海温 2018/2016/2015）
- **清理重复/孤儿取数进程**：`bash /opt/ocean/tools/ops/kill-orphans.sh`（只杀 PPID=1 的）
- **改了后端代码**：`scp backend/app/*.py ocean:/opt/ocean/backend/app/` 然后
  `ssh ocean 'systemctl restart ocean-api'`（正式流程是 `deploy\deploy.ps1`，见 RUNBOOK）

**跑完判据**：海温 2002–2024 每格 = 365/366；渔场 2017–2024 每格 ≈ 该年天数；
并且 `ocean-ops growth` 连续两次都为 0。

### 4.3 本地锋面队列（新电脑重点，别踩"全量重下"的坑）

新电脑上 `data/raw/front` 是空的，跑全量队列会从 Zenodo 重下 14.67 GB（20+ 小时，纯浪费）。
正确做法是**只跑服务器还缺的年份**：

```powershell
cd ocean-front-prototype
ssh ocean 'ocean-ops years'      # ① 先看服务器缺哪些年份
# ② 只补缺的年份（--years 可任意组合；已存在的 .nc 会跳过，给多了也不怕）
.\backend\.venv\Scripts\python.exe tools\pipeline\fetch_front_local.py --workers 4 `
    --years 1991 1990 1989 1988 1987 1986 1985 1984 1983 1982
```

- 每批抓完会**自动后台同步到服务器**（`sync-front-to-server.ps1`：只传缺的文件、
  自动 `mkdir` 远程年份目录、末尾重建索引）；日志 `C:\temp\front-pipeline.log` 与 `C:\temp\front-sync.log`
- 手动同步：`powershell -File tools\pipeline\sync-front-to-server.ps1`
- **跑队列的电脑不能睡**（Windows：电源选项 → 接通电源时"从不"睡眠）
- 想彻底省事：等旧电脑把 1991→1982 下完并传完，新电脑什么都不用做（见 §8 收尾清单）

---

## 5. 数据清单与理论天数（判断缺口用）

| 路径 | 内容 |
|---|---|
| `data/raw/front/<年>/front_location<YYYYMMDD>.nc` | 锋面：NetCDF-4/HDF5，1.3 MB/天 |
| `data/raw/sst/<年>/sst_<YYYYMMDD>.nc` | 海温：**NetCDF-3 classic**（文件头 `CDF\x01`），120 KB/天 |
| `data/raw/fishing/effort-<YYYYMMDD>.json` | 渔场：GFW 表观捕捞努力量逐日聚合 + `manifest.json` |
| `data/processed/data_index.sqlite` | 后端元数据索引（`POST /api/data/index/rebuild` 重建） |
| `data/cache/rasters/*.png` `*.scale` | 服务端渲染 PNG 缓存与色标旁车（可删，会自动重算） |

| 数据集 | 起止 | 理论天数 | 说明 |
|---|---|---|---|
| 锋面 | 1982-01-01 ~ 2024-12-31 | 15,706 | Zenodo 全量；1982–2001 **没有配对海温** |
| 海温 | 2002-01-01 ~ 当天 | ≈ 8,400 | ERDDAP 产品 2002 年起 |
| 渔场 | 2017-01-01 ~ 2024-12-31 | ≈ 2,922 | GFW 4Wings 2017-01-01 起 |

---

## 6. 排错手册（今天真实踩过的坑，按"症状 → 根因 → 处置"）

| 症状 | 根因 | 处置 |
|---|---|---|
| `curl` 探测 ERDDAP 报 `curl_exit=3 URL malformed` | URL 里的 `[ ]` 是 ERDDAP 下标语法，curl 默认当**通配符**，请求根本没发出去 | 所有 curl 加 **`-g`**（在 `tools/ops/probe-erddap.sh` 里已固定） |
| 本地文件数在涨、**服务器锋面数不涨** | ① 同步脚本 `-Years` 曾写死 2015–2024；② **scp 不会创建远程目录**，目标年份目录不存在时报 `No such file or directory` 并中断整轮；③ 同步曾阻塞下载 | 都已修好。排查：看 `C:\temp\front-sync.log`；再 `ocean-ops years` 看该年份是否停滞 |
| 队列"假死"：文件数长时间不涨、取数子进程数 > 应有值 | **孤儿进程**：pipeline 被重启后它 fork 的 `fetch_*` 变成 PPID=1 继续跑，与新一代抢同一批日期 → 上游限流 | `bash /opt/ocean/tools/ops/kill-orphans.sh`；`ocean-ops health` 看 PPID |
| 海温 404 `Not Found: Currently unknown datasetID=...` | **上游 ERDDAP 整站重载数据集**（判据：所有 ID 都 404，连随手编的也 404） | 等它恢复即可（实测约 1.5 小时后自行恢复），队列重试 + 第二遍复查会自动补；`ocean-ops erddap` 判读 |
| 渔场报 `取数失败：None` | 5 次重试全是 429 且当时没记 `last_error`（已修） | 跑 `start-gap-fills.sh` 补一轮；或把 `--workers` 降到 2 |
| 渔场 `Invalid leading whitespace, reserved character(s)...` | `/etc/ocean/gfw.env` 是 CRLF，`\r` 混进请求头 | 用 `printf` 重写该文件；脚本侧已有 `clean_token()` 兜底 |
| 中文全乱码 / 终端在中文路径下崩（PSReadLine） | PowerShell 5.1 默认按 GBK 解 UTF-8 | 会话里先 `[Console]::OutputEncoding=[Text.Encoding]::UTF8`；**长命令写进带 BOM 的 `.ps1` 再 `powershell -File` 执行** |
| `.ps1` 报"意外的标记" | 无 BOM 的 UTF-8 中文被 PS 5.1 当 GBK 读 | 写文件时用 `Set-Content -Encoding utf8`（PS 5.1 会写 BOM） |
| `.sh` / `.service` 在服务器上报语法错 | 行尾是 CRLF | 必须是 LF 无 BOM（`.gitattributes` 已锁 `deploy/**`；新加的 `.sh` 要自己确认） |
| 部署打包失败 `could not chdir` | Windows 自带 bsdtar **打不开非 ASCII 路径**（本仓在中文目录下） | 先 robocopy 到 ASCII 临时目录再 tar（`deploy.ps1` 已这么做） |
| SST/锋面突然全都读不了 | 装了 `netcdf4`（Windows 下打不开非 ASCII 路径，且被 xarray 优先选中） | 卸载它，靠 `scipy` + `h5netcdf`（见 §3.2） |
| 取数脚本一启动就退出、无输出 | 一次把几千个日期当命令行参数（超过约 700 个） | 分批（`--batch-size`，队列脚本已默认分批） |

---

## 7. 文件地图（新机器上先认这些）

| 路径 | 干什么的 |
|---|---|
| `backend/app/` | FastAPI 服务：`main.py` 路由、`catalog.py` 目录指纹缓存、`data_access.py` 读写 NetCDF、`raster_render.py` 服务端渲染 PNG、`data_index.py` SQLite 索引、`fishing_effort.py` 渔场、`history.py` 历史统计 |
| `backend/scripts/` | 取数脚本：`fetch_sst_samples.py`（ERDDAP 单日）、`fetch_zenodo_front_samples.py`（Zenodo 按天 Range）、`build_data_index.py` 等 |
| `tools/pipeline/` | 三条队列与上传：`fetch_front_local.py`（本地锋面+自动同步）、`sst_pipeline.py`、`gfw_pipeline.py`、`fetch_gfw_effort.py`、`sync-front-to-server.ps1`、`extract_front_from_zip.py`、`front_gap_fill.py` |
| `tools/ops/` | 服务器运维：`server-ops.sh`（`ocean-ops` 的实现）、`kill-orphans.sh`、`probe-erddap.sh`、`start-server-pipelines.sh`、`start-gap-fills.sh` |
| `deploy/` | `RUNBOOK.md`（细节手册）、`HANDOVER.md`（本文件）、`deploy.ps1`、`remote-setup.sh`、`systemd/ocean-api.service`、`nginx/ocean.conf` |
| `data/README.md` | 数据布局、口径、来源许可 |
| `docs/` | 数据契约、架构、验收记录 |
| 服务器侧 | 代码 `/opt/ocean`、venv `/opt/ocean/venv`、数据 `/srv/ocean/data`、日志 `/var/log/ocean-*.log`、GFW token `/etc/ocean/gfw.env`、systemd 单元 `ocean-api`、nginx 站点 `ocean` |

---

## 8. 收尾清单与待决策

**队列跑完后逐条核对（预计 2026-09-24 上午前）**

1. `ocean-ops years`：海温 2002–2024 满格；渔场 2017–2024 满格；锋面与本地文件数一致
2. `ssh ocean 'curl -s -X POST http://127.0.0.1:8000/api/data/index/rebuild'`（同步脚本末尾会自动做）
3. 抽检接口：`curl -s localhost:8000/api/catalog | jq '.file_count, (.available_dates|length)'`、
   `/api/point/<date>`、`/api/analysis/<date>/raster?kind=sst|front`、`/api/fishing/availability`
4. 公网抽检：`curl -s -o NUL -w '%{http_code} %{time_total}s' http://116.62.54.140/api/catalog`

**待决策（需要人拍板，AI 不要自己删数据）**

1. **1982–2001 只有锋面、没有海温** → `/api/analysis` 对这些日期拿不到配对结果。
   要么删掉这些年份省约 3 GB，要么保留给"只有锋面"的图层。**先问用户。**
2. `front_intensity_YYYY.zip`（43 个分年包共约 90 GB，含锋面强度）**没下**——盘只有 40 GB，要用得先扩容。
3. 成本：300 元抵扣额度**只含实例与系统盘，不含流量**；站点被反复访问要留意。
4. 到期迁移（2026-12-21）：`mysqldump db_prac > db_prac.sql` +
   `tar -czf ocean-data.tgz /srv/ocean/data` + `tar -czf ocean-app.tgz /opt/ocean`。

---

## 9. 常用命令速查

```bash
# —— 服务器（ssh ocean 之后）——
ocean-ops health     # 主机 + 进程（含 PPID，看孤儿）
ocean-ops data       # 三类文件数 + 磁盘 + 接口侧视图
ocean-ops years      # 逐年覆盖矩阵
ocean-ops growth     # 30 秒增长窗口
ocean-ops perf       # 接口耗时（含缓存命中与 20 并发）
ocean-ops logs       # 队列与 API 日志
ocean-ops erddap     # 上游 ERDDAP 体检
bash /opt/ocean/tools/ops/start-server-pipelines.sh   # 重启两条主队列（幂等）
bash /opt/ocean/tools/ops/start-gap-fills.sh          # 补缺口队列（幂等）
bash /opt/ocean/tools/ops/kill-orphans.sh             # 清孤儿子进程
systemctl status ocean-api | nginx
curl -s -X POST http://127.0.0.1:8000/api/data/index/rebuild

# —— 本地（Windows PowerShell）——
.\backend\.venv\Scripts\python.exe tools\pipeline\fetch_front_local.py --workers 4 --years 1991 1990 1989
powershell -File tools\pipeline\sync-front-to-server.ps1
.\backend\.venv\Scripts\python.exe -m pytest -q      # backend 目录下，期望 5 passed
```


