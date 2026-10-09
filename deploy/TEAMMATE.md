# 同伴上手 · 一页纸

> 只讲**必须知道的最小集合**（5 分钟能上手）。
> 想深入 → `deploy/COLLAB.md`（双人协作手册）；出故障 → `deploy/RUNBOOK.md`；整台机器交接 → `deploy/HANDOVER.md`。
> 事实基准：**2026-10-10 服务器实测**。

## 0. 先认清你要哪档权限（别多要）

| 你想做的事 | 需要的权限 | 怎么拿 |
|---|---|---|
| 看代码、改代码、提 PR | **只要有 GitHub 仓库权限**（不用碰服务器） | 让负责人把你加为 collaborator，然后 `git clone`、开分支、推上去 |
| 上线、看日志、跑队列、起测试实例 | **SSH 密钥**（本文第 1 节，5 分钟） | 见下 |
| 改安全组、扩盘、重启实例 | **阿里云控制台**（默认不给） | 找负责人代操作；确实需要就申请 RAM 子账号，退出即撤 |

⚠️ 服务器**没有密码登录**（`PasswordAuthentication no`），只能凭密钥 —— 所以「给我个账号密码」这条路不存在。

## 1. 拿到 SSH 密钥（3 步）

服务器：`root@116.62.54.140`，端口 22。

**第 1 步 · 在你自己的电脑上生成**（私钥**永远留在你机器上**，别发给任何人）

```bash
ssh-keygen -t ed25519 -C "你的名字@ocean" -f ~/.ssh/id_ed25519_ocean_你的名字
```

会问 passphrase：**建议设**（私钥文件被拷走也用不了）。

**第 2 步 · 把公钥发给负责人**（`.pub` 那一整行，公钥不含敏感信息）

```text
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI...... 你的名字@ocean
```

**第 3 步 · 配好 `~/.ssh/config`，然后自测**

```sshconfig
Host ocean
    HostName 116.62.54.140
    User root
    IdentityFile ~/.ssh/id_ed25519_ocean_你的名字
    IdentitiesOnly yes
    ServerAliveInterval 30
    ServerAliveCountMax 6
    StrictHostKeyChecking accept-new

# 这段也要写：部署脚本是拿 IP 直连的，「Host ocean」匹配不上它
Host 116.62.54.140
    User root
    IdentityFile ~/.ssh/id_ed25519_ocean_你的名字
    IdentitiesOnly yes
```

```bash
ssh ocean 'echo 新钥匙可用; hostname; ocean-ops health'
# 期望：主机名 iZr07vhujhsoywZ + 一段主机体检
```

> Windows：config 放在 `%USERPROFILE%\.ssh\config`，用记事本**另存为 UTF-8（无 BOM）**，别用 Word；
> `IdentityFile` 写成 `C:/Users/你/.ssh/id_ed25519_ocean_你的名字`。

## 2. 每天用得上的命令

```bash
ssh ocean                          # 登录（Ctrl-D 退出）
ssh ocean 'ocean-ops health'       # 体检：内存 / 磁盘 / 进程（上来先看这个）
ssh ocean 'ocean-ops years'        # 数据齐不齐（逐年覆盖矩阵）
ssh ocean 'ocean-ops logs'         # 队列 & API 日志
ssh ocean 'ocean-ops growth'       # 30 秒窗口：数据真的在长吗
ssh ocean 'ocean-ops data'         # 三类文件数 + 磁盘 + 接口侧视图

# 在服务器上试新版本（不动生产）：
bash /opt/ocean/tools/ops/start-test-instance.sh start|status|logs|stop
ssh -N -L 8001:127.0.0.1:8001 ocean   # 开隧道，本地浏览器看 http://127.0.0.1:8001
```

站点（生产）：`http://116.62.54.140` 。API 只在服务器本机 `127.0.0.1:8000` 监听，**不对外**。

## 3. 三条铁律（都是踩过坑换来的）

1. **一次只一个人上线** —— 部署会覆盖服务器上的代码；上线方式见 `COLLAB.md` §2.3。
2. **队列在跑时：别起 8001 测试实例、别两个人同时跑队列。** 这台机器只有 3.6 GiB 内存 —— 2026-10-09 就是「0 swap + 进程风暴」把整机拖死的（`%commit` 冲到 154%、load 84，最后只能从控制台重启）。现在已加 1 GB swap 兜底，但纪律不变。
3. **别灌数据、别删 `raw`。** 磁盘 40 GB 已用 **83%**（余 6.6 GB），`raw` 那 26 GB 是全部正资产。

其他：别在生产目录 `/opt/ocean` 下写临时文件；别把 8000 / 8001 开进安全组。

## 4. 出问题先跑这三句

```bash
ssh ocean 'ocean-ops health; free -m; df -h /'                          # 谁占了内存 / 磁盘
ssh ocean 'systemctl status ocean-api nginx --no-pager | head -20'
ssh ocean 'bash /opt/ocean/tools/ops/start-test-instance.sh status'     # 8001 有残留就 stop
```

网站打不开，多半是这两种：队列正在跑把内存吃满 / 磁盘接近满。

## 5. 你不用了，记得交回钥匙

```bash
# 负责人执行（精确吊销，不影响别人的钥匙）：
ssh ocean 'bash /opt/ocean/deploy/add-teammate-key.sh revoke 你的名字'
```

---

更细的内容：`COLLAB.md` §1 接入 / §2 上线 / §3 测试实例 / §4 队列纪律；
`RUNBOOK.md` 末节是 2026-10-09 整机假死的完整取证过程与对策。
