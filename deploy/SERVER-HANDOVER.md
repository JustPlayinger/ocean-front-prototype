# 服务器交接清单 · 海洋锋面渔情原型

> **读者：接手这台服务器的同伴。**
> 照着 **§1 连上 → §2 换成你自己的密钥 → §3 验收** 三步走，就算接管完成。
> **动手前先看 §6 第 1 条：磁盘已用 88%，只剩 4.8 GB。**
>
> 本页所有数字都是 **2026-09-30 15:37 (CST) 服务器实测**；过一段时间后以服务器实测为准（§4 有体检命令）。
>
> 相关文档（都别通读，按需查）：
> - `deploy/RUNBOOK.md` —— 部署与排错细节手册（最长，出问题来这查）
> - `deploy/HANDOVER.md` —— 换电脑接手开发环境（SSH 别名、本地环境、队列续跑）
> - `docs/handover.md` —— 代码与功能交接（做了什么、算法口径、还缺什么）
> - `docs/data-schema.md` —— 数据契约（改了会破坏前端，动前先读）

---

## 0. 三十秒速览

| 项 | 值 |
|---|---|
| 实例 | 阿里云 ECS **116.62.54.140**（Ubuntu 24.04.5 LTS，2 vCPU / 4 GiB / **40 GB 系统盘**） |
| 主机名 | `iZr07vhujhsoywZ` |
| 登录 | `ssh -i <私钥> root@116.62.54.140`（端口 **22**）—— 本页假设私钥已按 §2 换好 |
| 公网入口 | **http://116.62.54.140/** ← **唯一对外可用入口** |
| 常驻服务 | `nginx`（监听 80，前端静态 + 反代 `/api/`）· `ocean-api`（监听 **127.0.0.1:8000**，FastAPI） |
| 代码 | `/opt/ocean`（属主 `ocean:ocean`，git 分支 `restructure`） |
| 数据 | `/srv/ocean/data`（raw 共 **26 GB**：锋面 15,706 · 海温 8,158 · 全球海温 2,923 · 渔场 2,911 个文件） |
| ⚠️ 磁盘 | **40 GB 里已用 33 GB（88%），只剩 4.8 GB** |
| ⚠️ 备份 | **没有**自动备份、**没有**磁盘快照、**没有** crontab 定时任务 |
| 费用 | 300 元抵扣额度，**只含实例与系统盘、不含流量**；到期约 **2026-12-21**（以控制台为准） |

> ⚠️ **本文件会随代码提交到 GitHub**（`JustPlayinger/ocean-front-prototype`，**公开可见**）。
> 所以这里**只写公钥与指纹、绝不写私钥内容**；服务器 IP 与端口也请注意已对外暴露 ——
> **把安全组收紧到只放行必要来源 IP** 是最有效的补救（见 §1.4）。

**接管后要做的三件事**

1. **连上服务器**（§1）
2. **换成你自己的 SSH 密钥**，然后**吊销我这把**（§2，强烈建议，别跳过）
3. **跑一遍验收**（§3），再逐条读 §6 注意事项

---

## 1. 登录方式

### 1.1 直接连（不用配置）

```bash
ssh -i /path/to/你的私钥 root@116.62.54.140
```

Windows PowerShell 里路径用反斜杠或引号包住：

```powershell
ssh -i "$env:USERPROFILE\.ssh\你的私钥" root@116.62.54.140
```

### 1.2 推荐：写进 `~/.ssh/config`（省去每次敲参数）

把下面这段追加到 `C:\Users\<你>\.ssh\config`（Linux/macOS 是 `~/.ssh/config`）：

```sshconfig
Host ocean
    HostName 116.62.54.140
    User root
    IdentityFile ~/.ssh/id_ed25519_ocean
    IdentitiesOnly yes
    ServerAliveInterval 30
    ServerAliveCountMax 6
    StrictHostKeyChecking accept-new
```

之后一条 `ssh ocean` 即可。（`IdentityFile` 换成你自己的文件名。）

### 1.3 登录验收

```bash
ssh ocean 'echo ok; hostname; uptime'
```

期望看到 `ok`、主机名 `iZr07vhujhsoywZ`、以及类似 `up 8 days` 的运行时长。

### 1.4 连不上时的排查表

| 现象 | 原因 | 怎么办 |
|---|---|---|
| `Connection timed out` | 阿里云**安全组**没放行你的来源 IP，或实例停机 | 控制台 → 安全组 → 入方向放行 **22**（建议只放行你公司的出口 IP，别开 `0.0.0.0/0`） |
| `Permission denied (publickey)` | 私钥不对 / 权限过宽 / 用了错误的 `-i` | 用 `ssh -v ocean` 看实际用的是哪把密钥；Windows 确认私钥只给当前用户可读 |
| `REMOTE HOST IDENTIFICATION HAS CHANGED` | 实例被重装过（**主机密钥变了**，不一定是被攻击） | 先跟对方确认是否重装；确认后用 `ssh-keygen -R 116.62.54.140` 清掉旧记录再连 |
| `ssh: connect to host ... port 22: Connection refused` | 实例活着但 sshd 没起来 | 用阿里云控制台的 **VNC/远程连接** 登进去 `systemctl status ssh` |
| 能登录但 `ocean-ops` 提示 command not found | 你可能不是 root（脚本装在 `/usr/local/bin`） | `sudo -i` 切到 root 再执行 |

---

## 2. 密钥：现状与「换成你自己的」

### 2.1 现状（⚠️ 单点）

- 服务器上**只认一把**密钥：`/root/.ssh/authorized_keys` 里**只有 1 行**。
- 这把是我（原负责人）的：私钥 `id_ed25519_ocean`（**无口令**，411 字节），
  **指纹 `SHA256:IPb2hUrat6S2VeGK3J7IzRY5ziF/PSAOrs1b6+i4RM4`**，注释 `ocean-front-ecs`。
- 对应公钥（可公开，贴哪都行）：

  ```text
  ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHD19i9zSlPPo/cxo84CJ1lYk1jsT98DnqUipMwjUTpU ocean-front-ecs
  ```

> **私钥不在这份文档里，也不会放仓库 / 网盘 / 聊天记录。**
> 如果你确实需要沿用我这把，我会走 **U 盘或带口令的加密压缩包**单独给你，你用完立刻换成自己的（见下）。

### 2.2 ✅ 推荐做法：你生成自己的密钥，我再吊销旧的

**第 1 步 · 你本机生成一对**（不用传私钥给任何人）：

```bash
ssh-keygen -t ed25519 -C "你的名字@ocean" -f ~/.ssh/id_ed25519_ocean_你自己的名字
# 建议设置口令（passphrase）：私钥文件被拷走也没法直接用
```

**第 2 步 · 把你的公钥给我**，我登上去加到服务器：

```bash
# 我这边执行（把 <你的公钥内容> 换成 .pub 文件里那一整行）
ssh ocean 'umask 077; echo "<你的公钥内容>" >> /root/.ssh/authorized_keys; wc -l /root/.ssh/authorized_keys'
```

> 你也可以自己在还能登录的时候执行同一句（把公钥塞进去），效果一样。

**第 3 步 · 你先验证新密钥能进**（**务必在吊销旧钥之前做**）：

```bash
ssh -i ~/.ssh/id_ed25519_ocean_你自己的名字 root@116.62.54.140 'echo 新密钥可用'
```

**第 4 步 · 确认无误后，我删掉旧公钥并就地销毁私钥：**

```bash
# 服务器侧：只留你的那一行
ssh ocean 'grep -v ocean-front-ecs /root/.ssh/authorized_keys > /tmp/ak && cat /tmp/ak > /root/.ssh/authorized_keys && rm -f /tmp/ak && wc -l /root/.ssh/authorized_keys'
# 我本地侧：删除私钥（Windows 示例）
Remove-Item "$env:USERPROFILE\.ssh\id_ed25519_ocean*"
```

**第 5 步 · 落地登记**（两边都做，避免以后没人说得清谁有权限）：

- 你这边：把 `IdentityFile` 写进 `~/.ssh/config` 的 `ocean` 段（§1.2）。
- 我这边：确认 `ssh ocean` 已经**连不上**（这才是真正交接完成的标志）。

### 2.3 如果私钥泄漏了

私钥**无口令**，谁拿到文件谁就是 root。判断与处置顺序：

1. **先确认是否真被用**：`ssh ocean 'last -n 30; grep -c Accepted /var/log/auth.log'`（看有无陌生来源 IP / 时间）。
2. **立刻吊销**：清空 `authorized_keys`（`> /root/.ssh/authorized_keys`）——**注意**：清空前你要保证自己已有一把能进的钥匙，否则会把自己锁在门外（那时只能走控制台 VNC 救援）。
3. **换 SSH 端口 + 安全组限来源 IP**，重启 `sshd`。
4. **怀疑被横向渗透**时，按 §6.7 评估重建实例（数据可重新同步，见 §5.4）。

### 2.4 其他凭据（也在这台机器上）

| 凭据 | 位置 | 用途 | 权限 |
|---|---|---|---|
| GFW API token | `/etc/ocean/gfw.env` | 渔场取数 | `600 root:root` |
| （无其他） | —— | 后端不连数据库、不调付费 API | —— |

> 交接后**建议把 GFW token 也换一把**（在 GFW 官网重新生成，改 `/etc/ocean/gfw.env` 后重跑渔场队列），
> 因为它现在只有你我两方知道来源——换掉最省心。

---

## 3. 验收：接过来先跑这几条

逐条跑，**每条都该有输出**；有异常就按 §1.4 / §4 去查。

```bash
# ① 主机与服务（应看到 ocean-api / nginx 都 active 且 enabled）
ssh ocean 'systemctl is-active ocean-api nginx; systemctl is-enabled ocean-api nginx; uptime; df -h /'

# ② 站点与接口（服务器本机自测，都应输出 200）
ssh ocean 'curl -s -o /dev/null -w "static=%{http_code}\n" http://127.0.0.1/'
ssh ocean 'curl -s -o /dev/null -w "api=%{http_code}\n" http://127.0.0.1/api/catalog'

# ③ 外网入口（在你自己电脑上跑）
curl -s -o /dev/null -w "%{http_code} %{time_total}s\n" http://116.62.54.140/

# ④ 数据与磁盘体检（ocean-ops 是这台机器的运维入口）
ssh ocean 'ocean-ops health; ocean-ops data'

# ⑤ 数据覆盖面（逐年覆盖矩阵：锋面/海温/渔场）
ssh ocean 'ocean-ops years'

# ⑥ 接口返回 JSON（服务端渲染那条链路）
ssh ocean 'curl -s http://127.0.0.1:8000/api/catalog | head -c 300; echo'
```

**通过标准**：① 两个服务 `active`+`enabled`；② 两个 `200`；③ 公网 `200`；
④ 文件数与 §4.3 接近、磁盘没满；⑤ 矩阵无大片空洞（历史缺口见 §6.9 说明）；⑥ 返回 JSON。

> **Windows 上请用 `curl.exe`**，不要用 PowerShell 的 `Invoke-WebRequest`（别名 `curl`）：
> 本机若开着系统代理（Clash 类，`127.0.0.1:7897`）会让它误报超时。

---

## 4. 这台服务器上有什么

### 4.1 常驻服务（systemd，均已设开机自启）

| 服务 | 监听 | 作用 | 常用命令 |
|---|---|---|---|
| `ocean-api` | **127.0.0.1:8000** | FastAPI：`/api/catalog`、点查询、`/api/analysis/<date>/raster?kind=sst\|front` 服务端渲染 PNG、渔场统计 | `systemctl status ocean-api` · `journalctl -u ocean-api -n 100` |
| `nginx` | **0.0.0.0:80**（含 IPv6） | 前端静态站 + `/api/` 反代到 8000 | `systemctl status nginx` · `nginx -t` |
| `sshd` | **0.0.0.0:22** | 登录 | —— |

**没有数据库、没有 Redis/消息队列**（SQLite 索引随代码走，无需单独备份）。

> ⚠️ **8000 只绑回环是刻意的**：外网只能经 nginx 的 80 端口进来。
> 若改成 `0.0.0.0:8000`，等于把**无鉴权**的 API 直接暴露公网 —— **别改**。

### 4.2 目录地图

| 路径 | 是什么 | 备注 |
|---|---|---|
| `/opt/ocean` | 代码（`backend` / `frontend` / `tools` / `deploy`） | 属主 `ocean:ocean`；⚠️ 当前权限 **777**，见 §6.5 |
| `/opt/ocean/venv` | 后端 Python 虚拟环境 | 服务实际使用的解释器 |
| `/srv/ocean/data/raw` | **原始数据（26 GB）**：`front` / `sst` / `sst_global` / `fishing` | 只增不改，丢了要重下 |
| `/srv/ocean/data/processed` | 加工后的 NetCDF（5.7 MB） | 可从 raw 再生成 |
| `/srv/ocean/data/cache` | 栅格/响应缓存（17 MB） | 可随时删，会自动重建 |
| `/srv/ocean/data/manifest` | 索引清单 | `ocean-ops` 靠它统计 |
| `/opt/ocean/frontend/prototype` | nginx 的 `root`（站点根目录） | 首屏 `prototype-fishing.html` |
| `/etc/ocean/gfw.env` | GFW token（权限 `600`） | **唯一的凭据文件** |
| `/etc/nginx/sites-enabled/ocean` | nginx 站点配置 | 源自 `deploy/nginx/ocean.conf`（`@SERVER_IP@` 已替换为真实 IP） |
| `/etc/systemd/system/ocean-api.service` | 后端服务单元 | 源自 `deploy/systemd/ocean-api.service` |
| `/usr/local/bin/ocean-ops` | 运维入口命令 | 实现体在 `/opt/ocean/tools/ops/server-ops.sh` |
| `/var/log/ocean-*.log` | 取数队列与安装日志 | `ocean-ops logs` 会汇总 |
| `/var/log/nginx/ocean.{access,error}.log` | 站点访问/错误日志 | 排查 502 / 404 看这里 |

### 4.3 数据规模（2026-09-30 实测）

| 数据集 | 目录 | 文件数 | 覆盖 | 来源 |
|---|---|---|---|---|
| 锋面 | `raw/front` | **15,706** | 1982-01-01 ~ 2024-12-31 | Zenodo（**只能本地下载后上传**，见 §6.8） |
| 海温（东海窗口） | `raw/sst` | **8,158** | 2002 起 | NOAA 产品（**上游换过源**，见 §6.9） |
| 全球海温（粗格） | `raw/sst_global` | **2,923** | 近期 | NOAA OISST / CRW（2026-09 新增管线） |
| 渔场（GFW） | `raw/fishing` | **2,911** | 2017 起（有零星缺口） | GFW 4Wings API |

> **当前取数进程为空** —— 三条队列**都没在跑**（跑完了，或中途停了）。要重启见 §5.3。

### 4.4 访问入口

| 入口 | 状态 | 说明 |
|---|---|---|
| **http://116.62.54.140/** | ✅ **可用，唯一对外入口** | 浏览器直接打开即见地图 |
| `http://haifeng.116-62-54-140.sslip.io/` 等别名 | ⚠️ **国内不可用** | sslip.io/nip.io 免注册别名。**国内会被按「未备案」拦截（403，页面标题 `Non-compliance ICP Filing`）**，而服务器本机带同一 Host 头却是 200 —— 所以别名只在**内网/本机**或**已备案域名**场景下有用。 |

> 想上正式域名：需先**备案**，再改 `deploy/nginx/ocean.conf` 的 `server_name`。
> 目前**没有域名、没有 HTTPS**（仅明文 80）。

---


## 5. 日常运维

### 5.1 命令速查（`ocean-ops` 全家桶，登进去直接敲）

```bash
ocean-ops health   # 主机 + 进程（含 PPID，用来发现孤儿取数进程）
ocean-ops data     # 三类文件数 + 磁盘 + 接口侧视图
ocean-ops years    # 逐年覆盖矩阵（判断"数据齐不齐"就看这个）
ocean-ops growth   # 30 秒增长窗口（确认队列"真的在长"）
ocean-ops perf     # 接口耗时（含缓存命中与 20 并发）
ocean-ops logs     # 三条队列日志 + ocean-api 日志
ocean-ops erddap   # 上游 ERDDAP 体检（海温卡住时先看这个）
```

### 5.2 改完代码怎么上线

**正式流程（推荐）** —— 在**本地仓库根目录**跑：

```powershell
.\deploy\deploy.ps1 -ServerIp 116.62.54.140              # 全量：打包 + 上传 + 权限 + 重启
.\deploy\deploy.ps1 -ServerIp 116.62.54.140 -SkipData    # 不传 raw 数据（约 118 MB），只更新代码
.\deploy\deploy.ps1 -ServerIp 116.62.54.140 -SkipUpload  # 只重跑远程环境/权限/服务，不动代码
# 另有 -User（默认 root）、-KeyFile（不传则退回密码登录，会交互提示）
```

**只改了几个后端文件（应急、最快）**：

```bash
scp backend/app/*.py ocean:/opt/ocean/backend/app/
ssh ocean 'systemctl restart ocean-api'
```

> ⚠️ 解包/`scp` 之后文件属主会变成 root，而服务是以 `ocean` 用户运行的 ——
> **正式流程请用 `deploy.ps1`**，它会自动做权限收口（`chown -R ocean:ocean`）。

### 5.3 取数队列（当前**都没在跑**）

```bash
bash /opt/ocean/tools/ops/start-server-pipelines.sh   # 重启服务器侧两条主队列（幂等，已在跑就跳过）
bash /opt/ocean/tools/ops/start-gap-fills.sh          # 补缺口队列（幂等）
bash /opt/ocean/tools/ops/kill-orphans.sh             # 清理孤儿取数进程（只杀 PPID=1 的）
```

- **服务器重启后必做**：跑一次 `start-server-pipelines.sh`。
  队列**不是 systemd 服务**，而是 `setsid nohup` 后台进程 —— **重启不会自动恢复**，也没有 cron 兜底。
- **锋面队列只能在本地跑**（服务器连 Zenodo 只有 ~17 KB/s，且读 18.3 GB zip 中央目录会反复 `IncompleteRead`），
  下完用 `tools/pipeline/sync-front-to-server.ps1` 上传。细节见 `deploy/HANDOVER.md` §1、§4.3。

### 5.4 备份与迁移（⚠️ 现在**没有任何自动备份**）

**建议先手动备一份**（数据 26 GB）：

```bash
# ⚠️ 磁盘只剩 4.8 GB，别在服务器上打包大文件 —— 直接往本地拉：
rsync -av --partial --progress ocean:/srv/ocean/data/raw/front ./backup/front/
```

**到期/换实例时的完整迁移**（约 2026-12-21 前做完）：

```bash
ssh ocean 'tar -czf /tmp/ocean-app.tgz /opt/ocean'    # 代码（venv 可重建，可不带）
scp ocean:/tmp/ocean-app.tgz .
rsync -av --partial --progress ocean:/srv/ocean/data/ ./backup/data/   # 数据用 rsync，别打成 tar
```

> 新实例起来后：装依赖 → `.\deploy\deploy.ps1 -ServerIp <新 IP>` → 回传数据 → 改 nginx `server_name` 与安全组。

---

## 6. 注意事项（交接必读，按重要性排序）

### 6.1 ⚠️ 磁盘只剩 4.8 GB（88%）—— 当前最大风险

- 查：`ssh ocean 'df -h /; du -sh /srv/ocean/data/*'`
- 取数脚本带 `--min-free-gb` 护栏，**空间不足会静默停下** —— 别以为还在跑，用 `ocean-ops growth` 确认。
- 可安全释放的：`/srv/ocean/data/cache`（17 MB，会自动重建）、`/var/log/ocean-*.log`（可清空）。
- 真正占地方的是 `raw`（26 GB），腾空间只能**做取舍**（例如 1982–2001 只有锋面、没有配对海温，删不删要拍板）。
- **盘满的后果**：写入失败、队列停摆、nginx 日志写不进去。**扩容最省事**（控制台扩系统盘 → `growpart` → `resize2fs`）。

### 6.2 ⚠️ 没有任何自动备份 / 快照

`/etc/cron.d`、`/etc/cron.daily` 里**全是系统自带任务**，没有一条是数据备份。
**实例一旦释放或盘损坏，26 GB 原始数据全部丢失**（锋面仅重下就要 20+ 小时）。
→ 建议：控制台开**自动快照策略**（最省事），或加一条 `rsync` 到对象存储的定时任务。

### 6.3 ⚠️ 没有 crontab 定时任务

所有"自动"其实都是**手动拉起的后台进程**（`setsid nohup`）。
→ 重启、进程崩溃、磁盘满导致中止，**都不会自愈**。
每次上来先看一眼：`ocean-ops health` + `ocean-ops growth`。

### 6.4 计费与流量

- 300 元抵扣额度**只含实例与系统盘，不含公网流量**；站点被反复访问/被爬会消耗账户余额。
- 到期约 **2026-12-21**（以阿里云控制台为准）—— **到期不续会释放实例，数据一起没**。
- 想省钱：不用时停机（**停机仍收系统盘费用**），或到期前把数据拉干净再释放。

### 6.5 权限偏宽（安全，低优先级但该收）

- `/opt/ocean` 当前是 `drwxrwxrwx`（**777**）：任何本地用户都能改代码，而服务是以 root 驱动的 systemd 拉起。
- 建议收口：`chmod 755 /opt/ocean && chown -R ocean:ocean /opt/ocean`（`deploy.ps1` 每次部署都会做类似收口）。
- `authorized_keys` **只有 1 行、没有备用钥匙** —— 换钥务必"先验证新的、再吊销旧的"（§2.2 第 3 步）。

### 6.6 别把 API 暴露到公网

8000 只绑 `127.0.0.1`，公网统一走 nginx 的 80。API **没有任何鉴权**，
所以：**不要**把 8000 改成 `0.0.0.0`，也**不要**在安全组里放行 8000。

### 6.7 上游取数源不稳定（2026-09 换过源）

- **NOAA ERDDAP 曾在 2026-09 整站故障**（所有请求返回 `unknown datasetID`），海温队列因此停摆；
  后来改用 **NCEI OISST v2.1 直连** + **CRW CoralTemp 备用源**（带 Range 续传），并加了上游自动探测计划。
- 遇到"队列不涨"的判断顺序：
  `ocean-ops growth`（真在长吗）→ `ocean-ops logs`（报什么错）→ `ocean-ops erddap`（上游活着吗）→ 换源 / 等恢复。
- 取数脚本**支持断点续跑、`.part` 原子写入**：**失败不会破坏已有文件**，放心重试。

### 6.8 锋面数据只能在本地取（架构约束，不是 bug）

服务器到 Zenodo 只有 ~17 KB/s，且读 18.3 GB zip 的中央目录会反复 `IncompleteRead`；
本地走代理实测 116–198 KB/s。**所以锋面永远是"本地下载 → 上传服务器"**，别指望服务器自己拉完。

### 6.9 数据并非全时段对齐

| 时段 | 锋面 | 海温 | 渔场 |
|---|---|---|---|
| 1982–2001 | ✅ | ❌ | ❌ |
| 2002–2016 | ✅ | ✅ | ❌（渔场自 2017 起才有） |
| 2017–2024 | ✅ | ✅ | ✅（有零星缺口，`ocean-ops years` 可查） |

→ 前端在这些时段会**少显示图层，属预期行为**，不是坏了。要"配对齐全"就得补另一类数据。

### 6.10 其他小坑（详细版见 RUNBOOK）

| 现象 | 原因 | 对策 |
|---|---|---|
| 中文乱码 / PS 在中文路径下崩 | PowerShell 5.1 默认按 GBK 解 UTF-8 | 先 `[Console]::OutputEncoding=[Text.Encoding]::UTF8`；长命令写进带 BOM 的 `.ps1` 再执行 |
| `.sh` / `.service` 报语法错 | 行尾是 CRLF | 必须 LF 无 BOM（`.gitattributes` 已锁 `deploy/**`） |
| 部署打包 `could not chdir` | Windows 自带 bsdtar 打不开非 ASCII 路径 | 先 robocopy 到 ASCII 临时目录再 tar（`deploy.ps1` 已这么做） |
| SST/锋面突然全读不了 | 本地装了 `netcdf4`（Windows 打不开非 ASCII 路径，且被 xarray 优先选中） | 卸掉它，靠 `scipy` + `h5netcdf` 双引擎 |
| 取数脚本一启动就退出、无输出 | 一次传了几千个日期当参数（超约 700 个） | 分批（`--batch-size`，队列脚本已默认分批） |

---

## 7. 交接确认清单

**我（原负责人）交出去**：

- [ ] 本文件 `deploy/SERVER-HANDOVER.md` 已给到接手人
- [ ] 确认 `restructure` 已推 origin，接手人能 clone（`git status -sb` 干净）
- [ ] 通过**安全渠道**交付私钥（或按 §2.2 协作换成接手人自己的密钥）
- [ ] 阿里云**控制台账号**登录方式与到期时间已告知（账号密码**不在本文件里**，另行交接）
- [ ] GFW token 位置已知会，并约定是否轮换（§2.4）

**你（接手人）接下来**：

- [ ] §1 能 `ssh ocean` 登录成功
- [ ] §2 已换成自己的密钥，并**确认原负责人的钥匙已失效**
- [ ] §3 六条验收命令全部通过
- [ ] §6.1 磁盘风险已知悉，并**已决定处置方案**（扩容 / 清理 / 继续观察）
- [ ] §6.2 备份方案已定（控制台快照策略，或 rsync 定时任务）
- [ ] 阿里云控制台里原负责人的**子账号/授权已移除**（若曾添加过）

---

## 8. 出问题去哪查

| 你想知道的 | 去哪看 |
|---|---|
| 部署、排错、踩过的坑（最全） | `deploy/RUNBOOK.md` |
| 换电脑、本地环境、队列续跑 | `deploy/HANDOVER.md` |
| 代码做了什么、算法口径、还缺什么 | `docs/handover.md` |
| 数据字段与契约（改了会破坏前端） | `docs/data-schema.md` |
| 前端交互与验收记录 | `docs/ux-spec.md` · `tools/*-check.mjs` |
| 服务器实时状态 | `ssh ocean` 后敲 `ocean-ops <子命令>` |

> **最后一句**：这台机器**没有冗余** —— 无备份、无副本、密钥单点、磁盘将满。
> 接手后的第一优先级不是加功能，而是 **§6.1 磁盘 / §6.2 备份 / §2 换钥** 这三件。

