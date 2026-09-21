# data/ · 运行时数据（不入 git）

本地与服务器**同路径**，用 `deploy/deploy.ps1` 或手工 `scp` 同步；服务器上落在 `/srv/ocean/data`。
（前端随页面发布的那份导出物在 [`../frontend/prototype/data/`](../frontend/prototype/data/)，那是**要入库**的离线兜底数据。）

| 路径 | 内容 | 谁写 | 入库 |
|---|---|---|---|
| `raw/front/<年>/front_location<YYYYMMDD>.nc` | Zenodo 20356239 全球逐日中尺度锋面（CC BY 4.0）东海裁剪 | `backend/scripts/fetch_zenodo_front_samples.py` | ❌ |
| `raw/sst/<年>/sst_<YYYYMMDD>.nc` | NOAA GHRSST 逐日海温子集（免账号 ERDDAP） | `backend/scripts/fetch_sst_samples.py` | ❌ |
| `raw/fishing/effort-<YYYYMMDD>.json` | **渔场数据**：GFW AIS 表观捕捞努力量（小时/格点，0.1° 默认） | `tools/pipeline/fetch_gfw_effort.py` | ❌ |
| `raw/fishing/manifest.json` | 渔场数据清单（覆盖日期、格点数、合计小时） | 同上 | ❌ |
| `processed/data_index.sqlite` | front/SST 文件索引（按日期定位源文件） | `build_data_index.py` 或 `POST /api/data/index/rebuild` | ❌ |
| `processed/data_manifest.json` | 数据清单与配对情况 | `build_data_manifest.py` | ❌ |
| `cache/rasters/*.png` | **服务器端渲染**出来的 PNG 缓存（可删，命中不到会重算） | 后端按需写入 | ❌ |
| `cache/history/*.json` | 历史统计缓存 | 后端 | ❌ |
| `manifest/` | 覆盖与缺口报告（预留） | — | ❌ |

## 当前覆盖（2026-09-21 实测）

| 数据 | 覆盖日期 | 文件数 | 体积 |
|---|---|---|---|
| front | 2015–2023 每年 08-05~08-07（27 天）+ 2024-07-01 ~ 2024-08-31（62 天） | 89 | 110.7 MB |
| sst | 2024-07-01 ~ 2024-08-31 | 62 | 7.2 MB |

⚠️ **2015–2023 那 27 天只有锋面、没有 SST**：`/api/analysis/{date}`（要求 front+sst 配对）与 `/api/point/{date}` 现在会对这些日期返回 404。
两条出路：① 用 `fetch_sst_samples.py` 把那 27 天的 SST 补下来；② 按计划改造接口，缺 SST 时返回 `sst_celsius: null` 而不是 404（见 `docs/handover.md` 待办）。

## 渔场数据（Global Fishing Watch，需要 token）

来源：Kroodsma et al., *Science* 2018, doi:**10.1126/science.aao5646**（"Tracking the global footprint of fisheries"）所发布的
**AIS 表观捕捞努力量**（apparent fishing effort，单位：小时）。取数走 GFW API v3 · 4Wings report。

| 项 | 值 |
|---|---|
| 端点 | `POST https://gateway.api.globalfishingwatch.org/v3/4wings/report` |
| 数据集 | `public-global-fishing-effort:latest`（努力量）/ `public-global-presence:latest`（船舶存在时长） |
| 认证 | 请求头 `Authorization: Bearer <token>`；token 在 https://globalfishingwatch.org/our-apis/tokens 免费申请 |
| 覆盖 | **2017-01-01 起 ~ 5 天前**（所以我们 2015–2016 的同期样本取不到） |
| 分辨率 | `LOW` 0.1° / `HIGH` 0.01°；时间粒度 `HOURLY/DAILY/MONTHLY/YEARLY` |
| 窗口 | 默认东海 `120,27,128,34`（与锋面/海温一致），用 `--bbox` 可改；单次 `date-range` 跨度 ≤ 366 天 |
| 许可 | GFW 公开数据 CC BY-SA 4.0，但**API 使用条款限定非商业用途** —— 页面「数据来源」必须写明出处与用途限制 |

```powershell
# 只打印将发出的请求（不需要 token，先确认无误）
backend\.venv\Scripts\python.exe tools\pipeline\fetch_gfw_effort.py --from-front-data --dry-run

# 真取数：覆盖锋面数据的全部可覆盖日期（自动跳过 2015–2016）
$env:GFW_TOKEN = '<你的 token>'
# 推荐跑法：单日请求 + 断点续跑（GFW 大区间会超时，单日实测约 18s）
backend\.venv\Scripts\python.exe tools\pipeline\fetch_gfw_effort.py --from-front-data --split-days --skip-existing --timeout 240 --retries 5

# 只要某几天 / 换更高分辨率 / 让服务端先按作业方式聚合（大区间更快）
backend\.venv\Scripts\python.exe tools\pipeline\fetch_gfw_effort.py --dates 2024-08-05 2024-08-06
backend\.venv\Scripts\python.exe tools\pipeline\fetch_gfw_effort.py --start 2024-07-01 --end 2024-09-01 --resolution HIGH
backend\.venv\Scripts\python.exe tools\pipeline\fetch_gfw_effort.py --dates 2018-08-05 2018-08-06 2018-08-07 --group-by GEARTYPE

# 索引（manifest.json）与文件对不上时重建，不重新取数、不需要 token
backend\.venv\Scripts\python.exe tools\pipeline\fetch_gfw_effort.py --rebuild-manifest
```

> 服务器上还要加 `OCEAN_RAW_DATA_DIR=/srv/ocean/data/raw`（脚本与后端共用这个约定）；
> 完整跑法与实测坑见 `deploy/RUNBOOK.md` 的「GFW token」节。

**字段口径**：GFW 的 CSV 是「每船·每格·每天」明细（实测单日 19488 行），落盘前已按
`(lon, lat)` 汇总（83 天 1.2 MB/天 → 约 340 KB/天）。每格：`hours`（总捕捞小时）、
`vessel_count`（当天在这一格出现过的船数）、`top_gears`（按小时排序的前 3 类作业方式，小写）。
`spatial_resolution_deg`（0.1）供前端把 PNG 摆到正确经纬度；`total_hours` 是当日全窗口合计。

**接口**（常驻服务直接读这份数据）：`/api/fishing/availability`（逐日汇总 + 出处）、
`/api/fishing/{date}`（单日格点）、`/api/fishing/{date}/point?longitude=&latitude=`（某一格），
`/api/fishing/{date}/raster`（半透明热力 PNG，约 2–7 KB，带 `X-Raster-Bounds`）。
所有响应都带 `source`：署名 Global Fishing Watch、CC BY-SA 4.0、**非商业用途**。

输出结构（每天一个文件，按小时数降序）：

```json
{
  "date": "2024-08-05",
  "source": { "name": "Global Fishing Watch · AIS apparent fishing effort", "dataset": "public-global-fishing-effort:latest",
              "citation": "Kroodsma et al. 2018, Science, doi:10.1126/science.aao5646", "license": "CC BY-SA 4.0（API 条款：仅限非商业用途）" },
  "spatial_resolution": "LOW", "bbox": [120, 27, 128, 34],
  "cell_count": 321, "total_hours": 1234.5,
  "cells": [ { "lon": 124.05, "lat": 30.15, "hours": 12.3 } ]
}
```

> **尚未接入页面**：目前只完成「取数落盘」。要在界面里作为图层/指标展示，还需要在
> `backend/app` 增加对应接口、并把它接进前端（与 SST 锋面图层同一套"服务器渲染、前端收图"的路线）。

## 常用命令（在仓根目录执行）

首次准备 Python 环境：

```powershell
python -m venv backend\.venv
backend\.venv\Scripts\python.exe -m pip install -e backend      # 依赖见 backend\pyproject.toml
```

拉数据 → 导出 → 校验：

```powershell
backend\.venv\Scripts\python.exe backend\scripts\fetch_zenodo_front_samples.py 2024-09-01 2024-09-02
backend\.venv\Scripts\python.exe backend\scripts\fetch_sst_samples.py 2024-09-01 2024-09-02
backend\.venv\Scripts\python.exe backend\scripts\export_prototype_data.py          # 写进 frontend\prototype\data
backend\.venv\Scripts\python.exe backend\scripts\export_prototype_data.py --mode clim
backend\.venv\Scripts\python.exe backend\scripts\build_data_index.py
node tools\data-check.mjs
```

服务器上（同一份路径约定）：

```bash
cd /opt/ocean && /opt/ocean/venv/bin/python backend/scripts/build_data_index.py
curl -fsS -X POST http://127.0.0.1/api/data/index/rebuild
```

字段含义、编号规则与已知坑见 [`../docs/data-schema.md`](../docs/data-schema.md)；部署与数据同步见 [`../deploy/RUNBOOK.md`](../deploy/RUNBOOK.md)。
