# 双人协作手册 · 两个人共用一台服务器

> **读者：你和你的同伴。** 先分清两页文档，别搞混：
>
> | 文档 | 场景 | 钥匙怎么处理 |
> |---|---|---|
> | `deploy/SERVER-HANDOVER.md` | **单人接手**（原来的人退出） | **换钥**：加了新的就删旧的，`authorized_keys` 只留一行 |
> | 本页 `deploy/COLLAB.md` | **两人并存**（一起改、一起测） | **并存**：两把钥匙同时有效，谁退出就单独吊销谁 |
>
> ⚠️ 所以**不要**照抄 `SERVER-HANDOVER.md` §2.2 第 4 步 —— 那条会 `grep -v ocean-front-ecs` 把你自己的钥匙也删掉。
>
> 本页事实以 **2026-10-09 服务器实测**为准，久了自行复核（§6 有命令）。

---

## 0. 十分钟上手

| 要做的事 | 谁做 | 怎么做 |
|---|---|---|
| 让同伴能登录 | 你（已持有 root 钥匙的人） | §1.2，一条 `add-teammate-key.sh add` |
| 同伴上服务器 | 同伴 | `ssh ocean`（配好 `~/.ssh/config` 之后） |
| 改完代码上线 | **一次只一个人** | §2.3：`deploy.ps1`（Windows）或 rsync（macOS/Linux） |
| 在服务器上试新版本、不动生产 | 谁想试谁起 | §3.1 `bash tools/ops/start-test-instance.sh start` |
| 跑取数队列前 | 任一人 | 先 `ocean-ops health`，别两个人一起跑（§4） |

---

## 1. 让同伴能上服务器

### 1.1 现状（2026-10-09 实测）

| 项 | 实测值 |
|---|---|
| 登录 | `root@116.62.54.140`，端口 22；`PermitRootLogin yes` + `PasswordAuthentication no`（**只能凭密钥**） |
| `/root/.ssh/authorized_keys` | **只有 1 行**（注释 `ocean-front-ecs`，指纹 `SHA256:IPb2hUrat6S2VeGK3J7IzRY5ziF/PSAOrs1b6+i4RM4`） |
| `ocean` 系统用户 | 存在（uid 1000，`/home/ocean`），但**没有 `.ssh`、不在 sudo 组** —— 它只是 `ocean-api` 服务的运行身份，**不是**给人登录用的 |
| 防火墙 | 服务器内 `ufw` inactive、`iptables` 全 ACCEPT → 能不能连**完全由阿里云安全组决定** |
| 22 端口记录 | `last -i` / `journalctl` 里的 `223.80.110.55`、`223.99.13.153`、`223.99.13.244` 等**不是我们的登录，是爆破源**：2026-10-09 上一轮启动期间 sshd 日志 **29,411 行**、峰值上百连接/秒，直接把 sshd 打到不响应 → 整机「假死」（详见 RUNBOOK 末节）——**必须**按 §1.4 把 22 收进白名单 |
| 磁盘 | 40 GB **已用 80%、余约 7.6 GB**（2026-10-09 23:49 清理后实测：删 VS Code Remote 运行时 3.9 GB + journald + cache）。`raw` 已占 **26 GB** → **迟早要扩盘**（建议 ≥ 60 GB）；到 85% 就动手清，**测试时别灌数据** |
| 内存 | 3.6 GB / 可用 2.5 GB / **无 swap** —— 多起一个实例就要盯（8001 单实例约 205 MB）。2026-10-09 整机用户态僵死的**主因是 22 被爆破**，内存吃紧只是帮凶（见 RUNBOOK 末节 + §3.4） |

### 1.2 ✅ 推荐做法：各自生成密钥，两把**并存**（私钥永不外传）

**第 1 步 · 同伴在自己电脑上生成一对**（私钥留在他的机器上，谁也不碰）

```bash
ssh-keygen -t ed25519 -C "他的名字@ocean" -f ~/.ssh/id_ed25519_ocean_他的名字
# 强烈建议设 passphrase：私钥文件被拷走也用不了
```

**第 2 步 · 他把 `.pub` 那一整行发给你**（公钥不含敏感信息，随便贴）

```text
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI...... 他的名字@ocean
```

**第 3 步 · 你把它加进服务器**（幂等；只追加，不动你那一行）

```bash
# 方式 A（你 ssh ocean 进去之后，直接在服务器上跑）：
bash /opt/ocean/deploy/add-teammate-key.sh add "ssh-ed25519 AAAA... 他的名字@ocean"

# 方式 B（本机一条命令，把公钥文件传上去加）：
scp 他的公钥.pub ocean:/tmp/tm.pub
ssh ocean 'bash /opt/ocean/deploy/add-teammate-key.sh add-file /tmp/tm.pub'

ssh ocean 'bash /opt/ocean/deploy/add-teammate-key.sh list'   # 复核：应该看到 2 把
```

> 脚本就是本仓库的 `deploy/add-teammate-key.sh`，四个子命令：`add` / `add-file` / `list` / `revoke`。
> 每次写 `authorized_keys` 前自动备份成 `authorized_keys.bak-<时间戳>`；
> `revoke` **拒绝**把钥匙删到 0 行（防止把自己锁在门外），并且只按注释/指纹**精确**删。

**第 4 步 · 同伴配 `~/.ssh/config`，然后自测**

```sshconfig
Host ocean
    HostName 116.62.54.140
    User root
    IdentityFile ~/.ssh/id_ed25519_ocean_他的名字
    IdentitiesOnly yes
    ServerAliveInterval 30
    ServerAliveCountMax 6
    StrictHostKeyChecking accept-new

# ⚠️ 关键补充：deploy\deploy.ps1 是用 root@116.62.54.140 直连的，
#    「Host ocean」这一段**匹配不上**它 → 要么补上下面这段，要么每次上线显式带 -KeyFile（§2.3）
Host 116.62.54.140
    User root
    IdentityFile ~/.ssh/id_ed25519_ocean_他的名字
    IdentitiesOnly yes
```

```bash
ssh ocean 'echo 新钥匙可用; hostname; ocean-ops health'   # 期望：iZr07vhujhsoywZ + 主机体检
```

### 1.3 三档做法与代价（选一档，别混着来）

| 档 | 做法 | 代价 / 收益 |
|---|---|---|
| A. 共享同一把私钥 | 把 `id_ed25519_ocean`（无口令，411 B）走 U 盘拷给他（历史做法见仓库上一级的 `handover-ssh/`） | 最省事；但**无法单独吊销**（他一走就得换钥、通知所有人）、日志里分不清谁是谁、任何一方机器中招 = 服务器 root 全丢 |
| **B. 各自密钥并存（推荐）** | §1.2 | 一次性 5 分钟；之后每人一把、可单独吊销、`last` / `auth.log` 能分出来源 IP |
| C. 独立系统账号 + 共享组 + 受限 sudo | 给他自己的账号，`/opt/ocean`、`/srv/ocean/data` 改成组权限，配 `/etc/sudoers.d/` 白名单（只允许 `systemctl restart ocean-api`、`nginx -t` 等） | 最规范；但这台机器现在是 `/opt/ocean` 777、服务以 root 拉起（SERVER-HANDOVER.md §6.5），要先做一轮权限收口。2 人项目**收益 < 成本**，等有第三个人或要对外演示时再上 |

### 1.4 把 22 端口收进白名单（**必做**，2026-10-09 事故的根治手段）

`journalctl` 里上万行 `sshd[…]: banner exchange: … invalid format` 说明 22 正被全网爆破。2026-10-09 实录：上一轮启动 **29,411 行 sshd 日志**（本次启动同期 84 行）、峰值上百连接/秒，把 sshd 打到连 banner 都发不出来 → 整机「假死」，只能去控制台重启。所以这条**不是可选优化**：

- 控制台 → 安全组 → 入方向：**22 只放行你和同伴的出口 IP/32**。
  ⚠️ 顺序：**先加新规则 → 验证用新规则还能登进来 → 再删 `0.0.0.0/0`**（反过来会把自己锁在门外）；家用宽带 IP 会变，变了再加一条。
- 可选但推荐：`apt-get install -y fail2ban`（自动封爆破 IP，`fail2ban-client status sshd` 看战果）。
- 可选抗爆破：`/etc/ssh/sshd_config` 里 `MaxStartups 4:50:10`、`LoginGraceTime 20` → 先 `sshd -t` 校验 → `systemctl reload ssh`（**别 restart**）。
- 别指望本机 ufw：现在 `ufw status` 是 **inactive**，安全组是唯一防线。
- 80 保持对全网开放（站点要给人看）。
- **永不放行 8000**（API 无鉴权，SERVER-HANDOVER.md §6.6）。
- 阿里云控制台账号本身也算"钥匙"：同伴若要扩盘/改安全组，要么你代操作，要么给他加**子账号**并在退出时移除授权。

### 1.5 权限登记表（谁有钥匙，填在这里）

| 注释 | 指纹（前 16 位） | 持有人 | 加入日期 | 用途 |
|---|---|---|---|---|
| `ocean-front-ecs` | `SHA256:IPb2hUrat6S2` | （原负责人） | 2026-09-21 | 部署 / 运维 |
| | | | | |

> 复核：`ssh ocean 'bash /opt/ocean/deploy/add-teammate-key.sh list'`（会打印每把的指纹与注释）。

---

## 2. 一起更新代码（别互相覆盖）

### 2.1 ⚠️ 先纠正一个常见误解：服务器上的 `/opt/ocean` **不是 git 仓库**

2026-10-09 实测 `git -C /opt/ocean rev-parse --is-inside-work-tree` → **否**（目录里没有 `.git`）。
`SERVER-HANDOVER.md` §0 表里写的「git 分支 `restructure`」指的是**代码内容来自 `restructure` 分支**，
而不是"这目录是个克隆"。所以：

- 服务器上**不能** `git pull`；
- 上线只有两条路：① `deploy.ps1` 全量覆盖（§2.3）② 手工 `scp`/`rsync`（§2.3 应急）；
- 别在服务器上直接改代码"图省事"——下次部署会把同名文件覆盖掉，而且同伴完全看不到你的改动。

### 2.2 纪律：git 是唯一真相源

```bash
# 每次动手前（两个人都要）：
git pull --rebase origin restructure

# 改完、自检通过后：
git add -A && git commit -m "..." && git pull --rebase origin restructure && git push
```

- 分支约定：`restructure` = 集成分支，**服务器跟它走**（`main` 留作稳定快照）。
- 远端有 4 个（`origin` / `collab` / `demo` / `friend`），别推错（见 `docs/collab-sync.md`）。
- 服务器能直连 GitHub（实测 `git ls-remote` 通），所以将来把 `/opt/ocean` 改成 `git clone` 的工作副本**是可行的**；
  但那会把"运行目录"和"版本库"绑在一起（现在目录里还有 `venv/`、`backup-*` 等未跟踪物），
  **要改就两个人一起拍板**，别一个人默默改。

### 2.3 上线（Windows / macOS 各一套）

**Windows（正式流程）**

```powershell
cd <仓库根>
.\deploy\deploy.ps1 -ServerIp 116.62.54.140 -KeyFile "$env:USERPROFILE\.ssh\id_ed25519_ocean_他的名字" -SkipData
# -SkipData  ：不传 data\raw（约 118 MB），只更新代码 —— 日常改代码就用它
# -SkipUpload：只重跑远程环境/权限/服务，不动代码
```

> ⚠️ 一定要带 `-KeyFile`（原因见 §1.2 第 4 步的注）：不带就会退回**密码登录**，而这台机器已关密码登录 → 必然失败。

**macOS / Linux（等价命令；服务器上已装 rsync）**

```bash
# ① 同步代码（排除清单照抄 deploy.ps1：.git / 数据 / 虚拟环境 / 缓存）
rsync -az \
  --exclude '.git' --exclude 'data/raw' --exclude 'data/processed' --exclude 'data/cache' \
  --exclude 'backend/.venv' --exclude 'node_modules' --exclude '__pycache__' --exclude '*.pyc' \
  ./ ocean:/opt/ocean/

# ② 让服务器重跑权限 + 重启服务（remote-setup.sh 幂等；不传 tar 包 = 沿用现有代码）
scp deploy/remote-setup.sh ocean:/tmp/ocean-remote-setup.sh      # 第一次需要先传
ssh ocean 'bash /tmp/ocean-remote-setup.sh 116.62.54.140'
```

**只改了几个后端文件、要立刻生效（应急、最快）**

```bash
rsync -az backend/app/ ocean:/opt/ocean/backend/app/ && ssh ocean 'systemctl restart ocean-api'
```

### 2.4 两个人**同时**上线会发生什么（都会真踩）

| 冲突点 | 后果 | 约定 |
|---|---|---|
| `deploy.ps1` 用固定临时路径 `/tmp/ocean-front-prototype.tar.gz`、`/tmp/ocean-remote-setup.sh` | 同时跑 → 互相覆盖，可能部署出"半新半旧"的树 | 上线**一次只一个人**，跑完在群里喊一声 |
| `remote-setup.sh` 结尾必然 `systemctl restart ocean-api` | 每次重启有 0.5~2 秒 502，两人同时点会来回重启、日志互相盖 | 同上；要连着重启就改用 §2.3 的 rsync 单文件方式 |
| 解包语义：同名文件被覆盖、**多出来的文件不会被删** | 服务器上手工留下的临时文件长期潜伏（不是 git 仓库，`git status` 看不出来） | 定期 `ssh ocean 'ls -lt /opt/ocean | head'` 看一眼；别把实验文件丢在 `/opt/ocean` |
| 两人都推 `restructure` | 后推的人被拒（非快进） | `git pull --rebase` 后再推（§2.2） |

## 3. 一起测试（不污染生产）

原则：**生产永远是 `127.0.0.1:8000` + nginx 80**；要试新版本就另起一个实例，别改 8000、别动 nginx 生产站点。

### 3.1 在服务器上起一个测试实例（8001）

```bash
ssh ocean
bash /opt/ocean/tools/ops/start-test-instance.sh start     # 起
bash /opt/ocean/tools/ops/start-test-instance.sh status    # 看
bash /opt/ocean/tools/ops/start-test-instance.sh logs      # 日志
bash /opt/ocean/tools/ops/start-test-instance.sh stop      # 停
```

它做了什么、为什么这么设计：

| 设计 | 原因 |
|---|---|
| 端口 **8001**、`--workers 1`、以 `ocean` 用户跑 | 与生产 8000 完全隔离；1 worker 常驻约 205 MB，内存够（3.6 GB 总 / 2.4 GB 可用、无 swap）——**别同时起两个以上** |
| 数据目录 `/srv/ocean/data-test/`，其中 `raw` 是**指向生产 raw 的软链接** | 磁盘只剩约 3.5 GB（91% 已用），**拷贝不了 26 GB 的 raw**；软链让它读同一份数据、不占空间 |
| 独立的 `processed/` 与 `cache/` | 后端的 `processed` 固定取 `raw` 的**同级目录**（`raw_data_dir.parent / "processed"`，见 `backend/app/main.py`），把 raw 放进 `data-test/` 就等于把这些**写目录**一起隔离了；顺手把生产的索引复制一份过去，省一次全量扫描 |
| 日志 `/var/log/ocean-api-test.log`、PID `/run/ocean-api-test.pid` | 完全独立，`ocean-ops logs` 看到的仍是生产 |

### 3.2 怎么看（SSH 端口转发，不对外开端口）

```bash
# 你自己电脑上开一条隧道，然后浏览器/curl 打本机 8001
ssh -N -L 8001:127.0.0.1:8001 ocean
```

```bash
curl -s http://127.0.0.1:8001/api/health
curl -s http://127.0.0.1:8001/api/catalog | head -c 300
```

### 3.3 想连前端页面一起测（可选）

前端页面里的 `/api/` 是**相对路径**，所以只转发 8001 测不到"页面 + 新后端"的完整链路。
真要连起来，加一个**只监听回环**的测试站点（公网访问不到，符合"API 不暴露公网"的纪律）：

```bash
ssh ocean
sed 's/@SERVER_IP@/116.62.54.140/g' /opt/ocean/deploy/nginx/ocean-test.conf \
  > /etc/nginx/sites-available/ocean-test
ln -sf /etc/nginx/sites-available/ocean-test /etc/nginx/sites-enabled/ocean-test
nginx -t && systemctl reload nginx
```

然后本机 `ssh -N -L 8081:127.0.0.1:8081 ocean` → 浏览器打开 `http://127.0.0.1:8081/`。

撤掉：`ssh ocean 'rm /etc/nginx/sites-enabled/ocean-test && nginx -t && systemctl reload nginx'`。

> 模板在仓库里：`deploy/nginx/ocean-test.conf`（监听 `127.0.0.1:8081`，反代 8001，明确 `no-store` 防缓存骗人）。

### 3.4 测试时的资源纪律（这台机器没有余量）

- **别灌数据**：磁盘余量约 3.5 GB（91% 已用）且**补数队列正在让它变小**。用已有日期，别顺手跑全量补数；动手前 `ocean-ops data` 看一眼。
- ⚠️ **取数队列在跑时，不要起测试实例**：2026-10-09 实测出现过「8001 起来几秒后被回收 → 随后**整机用户态无响应**（TCP 能握手但 sshd 不给 banner、nginx 不返回）」的现象。
  机器只有 4 GiB 且**无 swap**，队列跑满时再挂一个 uvicorn（约 205 MB + 首次读数据的峰值）就是压垮点。
  要测就等队列停下；起之前先 `ocean-ops health` + `free -m` 确认有余量，测完**立刻 stop**。
- **别在生产目录里写临时文件**（`/opt/ocean` 会在下次部署被覆盖、留下尸检）。
- **别在测试实例上点"重建索引"**：它写自己的 `processed`（安全），但会扫 2.6 万+文件、吃满 2 vCPU，会拖慢正在跑的队列。

---

## 4. 不撞车：跑取数队列前先看一眼

三条队列（海温 / 全球海温 / 渔场）是 **`setsid nohup` 起的全局单例，不是 systemd 服务**（SERVER-HANDOVER.md §6.3）。

```bash
ssh ocean 'ocean-ops health'     # 有没有在跑的取数进程（含 PPID，能看出孤儿）
ssh ocean 'ocean-ops growth'     # 30 秒窗口：真的在长吗
ssh ocean 'ocean-ops logs'       # 三条队列日志
```

- 两人同时跑同一批日期 → 数据不会坏（幂等 + `.part` 原子写入），但**白费带宽**：上游会限流、断链（CRW 那个源实测每约 1 MB 断一次）。
- 长时间跑一定要 `setsid`（见 `deploy/RUNBOOK.md` 的运维要点），**别在前台 ssh 里跑**：ssh 一断进程就被杀。
- 日志文件名是固定的（如 `/var/log/ocean-sst-plan.log`），两人同时跑会**混写**同一个文件 → 起自己的队列时改个 `--log` 名，并在下表登记一句。

| 时间 | 谁 | 在跑什么 | 日志 |
|---|---|---|---|
| | | | |

---

## 5. 安全与收尾

- **同伴退出 / 换电脑**：`ssh ocean 'bash /opt/ocean/deploy/add-teammate-key.sh revoke 他的名字@ocean'`，
  然后 `list` 复核 —— **只删他那一行**，你的不受影响（这正是与"换钥"的区别）。
- 私钥**建议设 passphrase**；`handover-ssh/` 那种"整包拷贝同一把无口令私钥"是权宜之计（§1.3 档 A）。
- 这个仓库是**公开的**（`JustPlayinger/ocean-front-prototype`）：文档里只写**公钥**与**指纹**，永远不写私钥内容。
- 服务器 IP 与端口已在文档里公开 → 安全组限源（§1.4）是最有效的补救。
- 本页数字是 **2026-10-09 实测**，会过期；**改了配置请顺手回来更新本页**（尤其是 §1.1 现状表与 §1.5 登记表）。

---

## 6. 一页速查

```bash
# ---- 加人那天（一次性） ----
bash /opt/ocean/deploy/add-teammate-key.sh add "<同伴公钥整行>"   # 加
bash /opt/ocean/deploy/add-teammate-key.sh list                  # 查（含指纹）
bash /opt/ocean/deploy/add-teammate-key.sh revoke "<注释关键词>"   # 撤（精确删除，不会误伤别人）

# ---- 两个人日常 ----
git pull --rebase origin restructure                                    # 动手前
.\deploy\deploy.ps1 -ServerIp 116.62.54.140 -KeyFile <私钥> -SkipData   # 上线（Windows）
rsync -az --exclude '.git' --exclude 'data/*' ./ ocean:/opt/ocean/      # 上线（macOS/Linux）
bash /opt/ocean/tools/ops/start-test-instance.sh {start|status|logs|stop}  # 服务器上试新版本
ssh -N -L 8001:127.0.0.1:8001 ocean                                     # 隧道，测 8001
ocean-ops {health|data|growth|years|perf|logs|erddap}                   # 服务器体检
```

> 相关文档：`deploy/SERVER-HANDOVER.md`（单人接手 / 换钥 / 服务器资产清单）·
> `deploy/RUNBOOK.md`（部署与排错细节）· `deploy/HANDOVER.md`（换电脑配本地环境）·
> `docs/collab-sync.md`（与协作者仓的同步规范）


