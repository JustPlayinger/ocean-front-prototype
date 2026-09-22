#!/usr/bin/env bash
# ERDDAP 上游可用性探查（每个请求都带超时，不会挂死；结果先写文件再一次性输出，避免管道缓冲看起来"没输出"）。
#
# 判读：
#   ① version 有输出            → ERDDAP 服务在线
#   ② 所有 datasetID 都 404      → 数据集列表没加载（上游在全量重载），**不是我们的问题**
#   ③ 只有某个 ID 404            → 那个数据集被改名/下线，需要换 datasetID
#   ④ 正常取一天返回 200 + 120 KB → 上游健康，队列会自己续上
#
# 实测（2026-09-22 17:1x）：② —— 1704 天取完后上游开始整站重载，连随手编的 ID 也 404，
# 搜索返回空、info/index.json 302、status.html 卡到 25 s 超时。
# 注意：URL 里的 [ ] 是 ERDDAP 的下标语法，curl 默认会当成通配符（报 exit=3 URL malformed），
#      所以每条 curl 都必须带 -g（--globoff）。
CURL=(curl -g -s)

set -u

BASE=${ERDDAP_BASE:-https://coastwatch.noaa.gov/erddap}
DATASET=${ERDDAP_DATASET:-noaacwBLENDEDCsstDaily}
DAY=${1:-2021-06-15}
SEL="analysed_sst[(${DAY}T00:00:00Z):1:(${DAY}T23:59:59Z)][(27):1:(34)][(120):1:(128)],mask[(${DAY}T00:00:00Z):1:(${DAY}T23:59:59Z)][(27):1:(34)][(120):1:(128)]"
OUT=$(mktemp)

{
  echo "① 服务版本："
  printf '   %s\n' "$("${CURL[@]}" -m 20 "$BASE/version" || echo '（取不到）')"

  echo
  echo "② 取一天（$DAY，与 fetcher 完全相同的选择器）："
  code=$("${CURL[@]}" -m 60 -o "$OUT.body" -w '%{http_code} %{time_total}s %{size_download}B' \
    "$BASE/griddap/$DATASET.nc?$SEL")
  status=$?
  echo "   HTTP=$code  curl_exit=$status   （200 且约 120 KB = 上游健康）"
  echo "   正文前 200 字节：$(head -c 200 "$OUT.body" 2>/dev/null)"

  echo
  echo "③ 搜索 BLENDEDCsst（有结果=数据集在列表里）："
  search=$("${CURL[@]}" -m 25 -w '\n[HTTP %{http_code} exit %{exitcode}]\n' "$BASE/search/index.csv?searchFor=BLENDEDCsst&itemsPerPage=5")
  printf '%s\n' "$(printf '%s' "$search" | head -3 | cut -c1-140)"

  echo
  echo "④ 判别用：随手编的 ID 与另一个真实产品"
  for id in zzzNotARealDataset noaacwCRWdaily; do
    printf '   %-24s %s\n' "$id" "$("${CURL[@]}" -m 20 -o /dev/null -w '%{http_code}' "$BASE/griddap/$id.das")"
  done

  echo
  echo "⑤ 服务信息："
  printf '   info/index.json  %s\n' "$("${CURL[@]}" -m 25 -o /dev/null -w '%{http_code}' "$BASE/info/index.json")"
  printf '   status.html      %s\n' "$("${CURL[@]}" -m 25 -o /dev/null -w '%{http_code} in %{time_total}s' "$BASE/status.html")"
} > "$OUT" 2>&1

cat "$OUT"
rm -f "$OUT" "$OUT.body"


