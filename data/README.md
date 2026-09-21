# data/ · 运行时数据（不入 git）

本地与服务器**同路径**，用 `deploy/deploy.ps1` 或手工 `scp` 同步；服务器上落在 `/srv/ocean/data`。
（前端随页面发布的那份导出物在 [`../frontend/prototype/data/`](../frontend/prototype/data/)，那是**要入库**的离线兜底数据。）

| 路径 | 内容 | 谁写 | 入库 |
|---|---|---|---|
| `raw/front/<年>/front_location<YYYYMMDD>.nc` | Zenodo 20356239 全球逐日中尺度锋面（CC BY 4.0）东海裁剪 | `backend/scripts/fetch_zenodo_front_samples.py` | ❌ |
| `raw/sst/<年>/sst_<YYYYMMDD>.nc` | NOAA GHRSST 逐日海温子集（免账号 ERDDAP） | `backend/scripts/fetch_sst_samples.py` | ❌ |
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
