#!/usr/bin/env bash
# 海温下载"自动计划"：上游 ERDDAP 不可用时**不空烧重试**，每 5 分钟探一次，
# 恢复后按顺序跑完各阶段（脚本都跳过已存在的日期 → 中断/重跑即续跑）。
#
# 阶段（对应用户计划）：
#   A 东海明细 0.05°（2002–2024，跳过已有的；当前补到 2009）
#   B 全球粗格 1°：2023 + 2024
#   C 全球粗格 1°：2021 + 2022
#   D（默认不跑，需明确决定）全球高分辨率：
#       - 0.25°（--stride 4）≈ 6.7MB/天 → 两年 ≈ 5GB  ← 盘内可行
#       - 0.05° 全分辨率（--stride 1）≈ 110–135MB/天 → 两年 ≈ 80–100GB ← 必须先扩盘
#
# 用法（服务器上，后台常驻）：
#   cd /opt/ocean && setsid nohup bash tools/pipeline/sst_plan.sh > /var/log/ocean-sst-plan.log 2>&1 &
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

recent_progress() {
  # 兜底信号：最近 5 分钟有成片文件落盘 → 上游显然是通的（省得白白等探测）
  local n
  n=$(find "$SST_ROOT" -name '*.nc' -newermt '-5 minutes' 2>/dev/null | wc -l)
  [ "$n" -gt 2 ]
}

wait_upstream() {
  local code
  while :; do
    if recent_progress; then
      log "上游可用（最近 5 分钟有新文件落盘，跳过探测）"
      return 0
    fi
    code=$(upstream_code)
    [ "$code" = "200" ] && return 0
    log "上游未就绪（探测 HTTP $code）→ 5 分钟后再试"
    sleep 300
  done
}

count_global() { find "$SST_ROOT/sst_global" -name '*.nc' 2>/dev/null | wc -l; }
count_regional() { find "$SST_ROOT/sst" -name '*.nc' 2>/dev/null | wc -l; }
free_gb() { df -P "$SST_ROOT" | tail -1 | awk '{printf "%.0f", $4/1048576}'; }

run_phase() {   # run_phase <描述> <脚本> <参数...>
  local desc="$1" script="$2"; shift 2
  wait_upstream
  log "开始：$desc（磁盘可用 $(free_gb)GB）"
  "$PY" "$script" "$@" >> "$LOG" 2>&1
  log "结束：$desc → exit=$? · 东海 $(count_regional) 天 · 全球粗格 $(count_global) 天 · 磁盘可用 $(free_gb)GB"
}

log "=== 海温自动计划启动（东海 $(count_regional) 天 · 全球 $(count_global) 天 · 磁盘可用 $(free_gb)GB）==="

# 顺序说明（2026-09-24 调整）：**先全球（用户优先），东海续跑放最后**。
# 原先把东海续跑放第一位，结果它要跑一两天，全球粗格一直排不上（实测 14 小时没动一天）。
# B：全球粗格 1°，2024 + 2023
run_phase "B 全球粗格 1°：2024+2023" tools/pipeline/sst_global_pipeline.py --stride 20 --years 2024 2023 --workers 3

# C：全球粗格 1°，2021 + 2022
run_phase "C 全球粗格 1°：2022+2021" tools/pipeline/sst_global_pipeline.py --stride 20 --years 2022 2021 --workers 3

# D：全球 0.25°（两年 ≈ 5GB，盘内可行；比 1° 细 4 倍）
run_phase "D 全球 0.25°：2024+2023" tools/pipeline/sst_global_pipeline.py --stride 4 --years 2024 2023 --workers 3
#   0.05° 全分辨率两年 ≈ 80–100GB（必须先把盘扩到 200GB 级）——决定扩盘后再取消下面这行
# run_phase "D 全球 0.05° 全分辨率：2024+2023" tools/pipeline/sst_global_pipeline.py --stride 1 --years 2024 2023 --workers 2

# A：东海 0.05° 明细续跑（默认年份序列 2022→2002，跳过已存在的；放最后，因为它要跑更久）
run_phase "A 东海明细 0.05°（续跑）" tools/pipeline/sst_pipeline.py --workers 4

log "=== 计划结束（东海 $(count_regional) 天 · 全球粗格 $(count_global) 天 · 磁盘可用 $(free_gb)GB）==="
