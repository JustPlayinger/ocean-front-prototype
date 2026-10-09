#!/usr/bin/env bash
# 海洋锋面 · 给服务器加 / 删 / 列 SSH 公钥（多人协作共用 root 登录时用）
#
# 为什么需要它：deploy/SERVER-HANDOVER.md §2.2 写的是「**换**钥」——
#   单人接手场景：同伴加了自己的钥匙，就要删掉原负责人的那把（authorized_keys 只留一行）。
#   而**两人同时在用**时要的是「**并存**」——本脚本只追加、只按注释精确吊销，
#   绝不会顺手把别人的行删掉（`--revoke` 命中多行时会先列给你看，并拒绝把钥匙清空）。
#
# 用法（服务器上，root）：
#   bash /opt/ocean/deploy/add-teammate-key.sh add "<整行公钥>" [注释]
#   bash /opt/ocean/deploy/add-teammate-key.sh add-file /tmp/teammate.pub [注释]
#   bash /opt/ocean/deploy/add-teammate-key.sh list
#   bash /opt/ocean/deploy/add-teammate-key.sh revoke <注释里的关键词或指纹前 16 位>
#
# 幂等：同一把公钥（按 base64 主体比对）重复 add 只会提示「已存在」，不会出现两行。
# 每次写入前自动备份到 /root/.ssh/authorized_keys.bak-<时间戳>。
#
# 编码约定：本文件必须 LF + UTF-8 无 BOM（CRLF 会让 bash 报 `$'\r': command not found`）。

set -euo pipefail

AK="${AK:-/root/.ssh/authorized_keys}"
SSH_DIR="$(dirname "$AK")"
STAMP="$(date +%Y%m%d-%H%M%S)"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

die() { printf '错误：%s\n' "$*" >&2; exit 1; }
ok() { printf '✅ %s\n' "$*"; }
warn() { printf '⚠️  %s\n' "$*" >&2; }

[ "$(id -u)" -eq 0 ] || die "请用 root 运行（sudo bash $0 ...）"

# ---------- 公共：把一行公钥拆成 类型 / 主体 / 注释 ----------
split_key() {
  # $1 = 一行公钥；输出三个字段（注释可能为空）
  KEY_TYPE="$(printf '%s' "$1" | awk '{print $1}')"
  KEY_BODY="$(printf '%s' "$1" | awk '{print $2}')"
  KEY_COMMENT="$(printf '%s' "$1" | awk '{$1="";$2="";sub(/^[ \t]+/,"");print}')"
}

# ---------- 公共：写入（先备份，再整文件替换，保留原权限） ----------
write_ak() {
  # $1 = 准备写入的新内容文件
  mkdir -p "$SSH_DIR"
  chmod 700 "$SSH_DIR"
  if [ -f "$AK" ]; then
    cp -a "$AK" "${AK}.bak-${STAMP}"
    printf '（旧文件已备份：%s）\n' "${AK}.bak-${STAMP}"
  fi
  cat "$1" > "$AK"
  chmod 600 "$AK"
}

count_ak() { [ -f "$AK" ] && grep -c . "$AK" || echo 0; }

# ---------- list ----------
cmd_list() {
  if [ ! -s "$AK" ]; then
    echo "authorized_keys 为空或不存在：$AK（当前没人能用钥匙登录！）"
    return 0
  fi
  printf '文件：%s（共 %s 把）\n\n' "$AK" "$(count_ak)"
  local i=0 line fp
  while IFS= read -r line; do
    case "$line" in ''|'#'*) continue ;; esac
    i=$((i + 1))
    printf '%s\n' "$line" > "$TMP"
    fp="$(ssh-keygen -lf "$TMP" 2>/dev/null | awk '{print $2}' || true)"
    split_key "$line"
    printf '  #%-2s %-12s %-24s 注释：%s\n' \
      "$i" "$KEY_TYPE" "${fp:-（无法解析）}" "${KEY_COMMENT:-（无注释，吊销时不好定位）}"
  done < "$AK"
  printf '\n吊销：bash %s revoke <注释关键词>\n' "$0"
}

# ---------- add ----------
cmd_add() {
  local raw="$1" label="${2:-}"
  # 折掉换行/BOM/CR，防止把半行写进去
  raw="$(printf '%s' "$raw" | tr -d '\r\n' | sed 's/^\xEF\xBB\xBF//')"
  case "$raw" in
    ssh-ed25519\ *|ssh-rsa\ *|ecdsa-sha2-*\ *|sk-ssh-ed25519@openssh.com\ *|sk-ecdsa-sha2-*\ *) ;;
    *) die "这不像一行公钥（应以 ssh-ed25519 / ssh-rsa / ecdsa-sha2- 开头）：${raw:0:40}..." ;;
  esac

  split_key "$raw"
  # 注释：公钥自带优先；没有就用传入的 label；再没有就用时间戳兜底（吊销时要靠它）
  if [ -z "$KEY_COMMENT" ]; then
    KEY_COMMENT="${label:-teammate-${STAMP}}"
    warn "公钥没有自带注释，已补为「$KEY_COMMENT」（以后 revoke 就按它找）"
  fi
  printf '%s %s %s\n' "$KEY_TYPE" "$KEY_BODY" "$KEY_COMMENT" > "$TMP"
  ssh-keygen -lf "$TMP" >/dev/null 2>&1 || die "ssh-keygen 无法解析这把公钥，请确认贴的是 .pub 文件整行"

  if [ -f "$AK" ] && awk -v body="$KEY_BODY" '$2==body {found=1} END{exit !found}' "$AK"; then
    ok "这把钥匙已经在 authorized_keys 里了，无需重复添加"
    return 0
  fi

  cp "$TMP" "${AK}.new-${STAMP}"
  if [ -f "$AK" ]; then cat "$AK" >> "${AK}.new-${STAMP}"; fi
  write_ak "${AK}.new-${STAMP}"
  rm -f "${AK}.new-${STAMP}"
  ok "已添加：$KEY_COMMENT"
  printf '   指纹：%s\n' "$(ssh-keygen -lf "$TMP" | awk '{print $2}')"
  printf '   现在共有 %s 把钥匙：\n' "$(count_ak)"
  cmd_list
  printf '\n下一步（**务必先做**）：让对方用自己的私钥登录验证——\n'
  printf '   ssh -i <他的私钥> root@116.62.54.140 '"'"'echo 新钥匙可用; hostname'"'"'\n'
  printf '   通过之后再考虑吊销旧钥，否则可能把所有人锁在门外。\n'
}

# ---------- revoke ----------
cmd_revoke() {
  local pat="$1"
  [ -n "$pat" ] || die "用法：$0 revoke <注释关键词 / 指纹前 16 位>"
  [ -f "$AK" ] || die "找不到 $AK"
  [ "$(count_ak)" -gt 0 ] || die "authorized_keys 已经是空的，没什么可删"

  # 先算出「哪些行会命中」，让调用者看清楚
  local hit_file="${TMP}.hit"
  : > "$hit_file"
  local i=0 line fp
  while IFS= read -r line; do
    case "$line" in ''|'#'*) continue ;; esac
    i=$((i + 1))
    printf '%s\n' "$line" > "${TMP}.one"
    fp="$(ssh-keygen -lf "${TMP}.one" 2>/dev/null | awk '{print $2}' || true)"
    split_key "$line"
    if printf '%s\n%s\n' "$KEY_COMMENT" "$fp" | grep -q -- "$pat"; then
      printf '%s\n' "$line" >> "$hit_file"
      printf '  将删除 #%s  %s  注释：%s\n' "$i" "${fp:0:24}" "${KEY_COMMENT:-（无）}"
    fi
  done < "$AK"
  rm -f "${TMP}.one"

  if [ ! -s "$hit_file" ]; then
    warn "没有命中任何一把钥匙（模式：$pat）。先看清单：bash $0 list"
    return 1
  fi

  local remain
  remain="$(grep -Fvx -f "$hit_file" "$AK" | grep -c . || true)"
  if [ "$remain" -eq 0 ]; then
    die "这次会删光所有钥匙 → 你会被锁在门外。若确实要清空，请自己确认后再执行（见 SERVER-HANDOVER.md §2.3）"
  fi

  grep -Fvx -f "$hit_file" "$AK" > "${TMP}.keep" || true
  write_ak "${TMP}.keep"
  ok "已吊销，剩余 $remain 把："
  cmd_list
}

# ---------- 入口 ----------
[ $# -ge 1 ] || die "用法：$0 {add|add-file|list|revoke} ...（详见文件头注释）"
action="$1"; shift

case "$action" in
  add)
    [ $# -ge 1 ] || die "用法：$0 add \"<整行公钥>\" [注释]"
    cmd_add "$1" "${2:-}"
    ;;
  add-file)
    [ $# -ge 1 ] || die "用法：$0 add-file <公钥文件路径> [注释]"
    [ -f "$1" ] || die "找不到文件：$1"
    cmd_add "$(cat "$1")" "${2:-}"
    ;;
  list|ls)
    cmd_list
    ;;
  revoke|rm|del)
    [ $# -ge 1 ] || die "用法：$0 revoke <关键词>"
    cmd_revoke "$1"
    ;;
  *)
    die "未知子命令：$action（支持 add / add-file / list / revoke）"
    ;;
esac
