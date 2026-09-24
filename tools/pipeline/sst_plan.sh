#!/usr/bin/env bash
# 海温下载"自动计划"（v2，2026-09-24）：上游 ERDDAP 抖动时**不空烧重试**，
# 而且**某个阶段没产出就等上游恢复再重试**，直到真的拿到数据才往下走。
#
# 阶段顺序（2026-09-24 调整）：**先全球（用户优先），东海续跑放最后**。
# 原先把东海续跑放第一位，它要跑一两天，全球粗格 14 小时一天没动。
#   B 全球粗格 1°：2024 + 2023
#   C 全球粗格 1°：2022 + 2021
#   D 全球 0.25°：2024 + 2023（≈5GB；比 1° 细 4 倍）
#   A 东海明细 0.05° 续跑（2002–2024，跳过已存在）
#   D2 全球 0.05° 全分辨率：默认注释（两年 ≈80–100GB，需先扩盘到 200GB 级）
#
# 用法（服务器上，后台常驻）：
#   cd /opt/ocean && setsid nohup bash tools/pipeline/sst_plan.sh > /var/log/ocean-sst-plan.log 2>&1 &
# 注意：必须 LF 换行（Windows 写的 .sh 带 CRLF 会让 bash 报 $'\r': command not found）。
set -u

PY=/opt/ocean/venv/bin/python
LOG=/var/log/ocean-sst-plan.log
SST_ROOT=/srv/ocean/data/raw
export OCEAN_RAW_DATA_DIR="$SST_ROOT"
cd /opt/ocean

log() { echo "[$(date '+%m-%d %H:%M:%S')] $*"; }

upstream_code() {
  # 用一个"小范围真实取数"探活：和实际抓取同一形状。
  # 不要用 .dds / 单点带时间戳的采样——ERDDAP 在这两种请求上经常超时或 404，
  # 会造成"上游明明好着、脚本却一直等"的假信号（2026-09-24 踩过）。
  curl -s -o /dev/null -w '%{http_code}' --max-time 60 \
    "https://coastwatch.noaa.gov/erddap/griddap/noaacwBLENDEDCsstDaily.nc?analysed_sst%5B(2024-01-01T00:00:00Z):1:(2024-01-01T00:00:00Z)%5D%5B(0):20:(60)%5D%5B(100):20:(160)%5D"
}

recent_in() {   # 该目录最近 5 分钟是否有新文件落盘
  find "$1" -name '*.nc' -newermt '-5 minutes' 2>/dev/null | wc -l
}

wait_upstream_for() {   # $1 = 该阶段的目标目录（看它有没有新文件落盘）
  local dir="$1" code
  while :; do
    if [ "$(recent_in "$dir")" -gt 0 ]; then
      log "上游可用（$dir 最近 5 分钟有新文件落盘，跳过探测）"
      return 0
    fi
    code=$(upstream_code)
    [ "$code" = "200" ] && return 0
    log "上游未就绪（探测 HTTP $code，$dir 5 分钟无新文件）→ 10 分钟后再试"
    sleep 600
  done
}

count_global() { find "$SST_ROOT/sst_global" -name '*.nc' 2>/dev/null | wc -l; }
count_regional() { find "$SST_ROOT/sst" -name '*.nc' 2>/dev/null | wc -l; }
count_nc() { find "$1" -name '*.nc' 2>/dev/null | wc -l; }
free_gb() { df -P "$SST_ROOT" | tail -1 | awk '{printf "%.0f", $4/1048576}'; }

# 自愈执行：阶段跑完若**一天新数据都没有**，判定为上游抖动 → 等 10 分钟重跑该阶段（最多 MAX_ATTEMPTS 次）
MAX_ATTEMPTS=24
run_phase_guarded() {   # run_phase_guarded <描述> <目标目录> <脚本> <参数...>
  local desc="$1" target="$2" script="$3"; shift 3
  local attempt=0 before after
  while :; do
    attempt=$((attempt + 1))
    wait_upstream_for "$target"
    before=$(count_nc "$target")
    log "开始（第 $attempt 次）：$desc · 目标已有 $before 天 · 磁盘可用 $(free_gb)GB"
    "$PY" "$script" "$@" >> "$LOG" 2>&1
    after=$(count_nc "$target")
    if [ "$after" -gt "$before" ]; then
      log "完成：$desc（+$((after - before)) 天，现共 $after 天）"
      return 0
    fi
    log "本轮没有新数据（$before → $after，多半是上游重载/抖动）"
    if [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
      log "达到重试上限 $MAX_ATTEMPTS 次，跳过 $desc（重跑本脚本会继续）"
      return 1
    fi
    sleep 600
  done
}

log "=== 海温自动计划启动（东海 $(count_regional) 天 · 全球 $(count_global) 天 · 磁盘可用 $(free_gb)GB）==="

# 顺序说明（2026-09-24 调整）：**先全球（用户优先），东海续跑放最后**。
# 原先把东海续跑放第一位，结果它要跑一两天，全球粗格一直排不上（实测 14 小时没动一天）。
# B：全球粗格 1°，2024 + 2023
run_phase_guarded "B 全球粗格 1°：2024+2023" "$SST_ROOT/sst_global/1deg" \
  tools/pipeline/sst_global_pipeline.py --stride 20 --years 2024 2023 --workers 3

# C：全球粗格 1°，2021 + 2022
run_phase_guarded "C 全球粗格 1°：2022+2021" "$SST_ROOT/sst_global/1deg" \
  tools/pipeline/sst_global_pipeline.py --stride 20 --years 2022 2021 --workers 3

# D：全球 0.25°（两年 ≈ 5GB，盘内可行；比 1° 细 4 倍）
run_phase_guarded "D 全球 0.25°：2024+2023" "$SST_ROOT/sst_global/0p25deg" \
  tools/pipeline/sst_global_pipeline.py --stride 4 --years 2024 2023 --workers 3
#   0.05° 全分辨率两年 ≈ 80–100GB（必须先把盘扩到 200GB 级）——决定扩盘后再取消下面两行
# run_phase_guarded "D2 全球 0.05°：2024+2023" "$SST_ROOT/sst_global/0p05deg" \
#   tools/pipeline/sst_global_pipeline.py --stride 1 --years 2024 2023 --workers 2

# A：东海 0.05° 明细续跑（默认年份序列 2022→2002，跳过已存在的；放最后，因为它要跑更久）
run_phase_guarded "A 东海明细 0.05°（续跑）" "$SST_ROOT/sst" \
  tools/pipeline/sst_pipeline.py --workers 4

log "=== 计划结束（东海 $(count_regional) 天 · 全球粗格 $(count_global) 天 · 磁盘可用 $(free_gb)GB）==="
