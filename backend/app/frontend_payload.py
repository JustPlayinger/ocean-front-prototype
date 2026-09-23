"""按需产出「前端离线数据格式」（逐行 RLE）的单日 payload。

背景：前端渲染读的是 ``frontend/prototype/data/day/<date>.js`` 的 RLE 结构，
而 ``/api/analysis`` 返回的是 GeoJSON（为服务端渲染与矢量展示设计）—— 两套契约不同。
本模块复用 ``backend/scripts/export_prototype_data.py`` 的构建函数，让服务端按需产出与
离线文件**完全一致**的结构；前端把它注入 ``OFData`` 的 DAYS/SST 缓存后可直接渲染，
从而在不改渲染层的前提下用上服务器上的全量日期。

边界：
- 只读 raw NetCDF，不做任何插值或补值；
- 锋面文件缺失时抛 ``FrontendPayloadUnavailable``，由上层转 404，绝不返回空图；
- 海温缺失不算错误（``has_sst=false``，前端照旧显示「未接入」）。
"""

from __future__ import annotations

import sys
from pathlib import Path

from .config import settings

# scripts/ 里的导出脚本按「独立脚本」组织而不是包，这里显式加入 import 路径以复用其函数；
# 重新实现一份 RLE / 连通域 / 抽稀逻辑会让服务端与离线数据产生漂移。
_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

import export_prototype_data as exporter  # noqa: E402

# 服务器模式的数据窗口：比离线兜底（东海 120-128E/27-34N）更大，让前端能看到整片海域。
# 实测单日 export 开销：东海 23 KB / 0.16s；本窗口 391 KB / 0.67s；全球 15.7 MB / 25s（不可行，故不取全球）。
BBOX = (105.0, 3.0, 150.0, 45.0)
TOLERANCE_KM = 6.0
MIN_LENGTH_KM = 20.0


class FrontendPayloadUnavailable(RuntimeError):
    """当日锋面原始 NetCDF 不存在。"""


def build_frontend_payload(day: str) -> dict[str, object]:
    """构建单日前端 payload。

    返回 ``{"date", "front", "sst"}``：``front`` 与 ``data/day/<date>.js`` 的结构一致，
    ``sst`` 与 ``data/sst/<date>.js`` 一致（没有海温文件时为 None）。
    """
    raw_root = Path(settings.raw_data_dir)

    try:
        front_path = exporter.find_file(raw_root / "front", day)
    except FileNotFoundError as exc:
        raise FrontendPayloadUnavailable(str(exc)) from exc

    values, lons, lats = exporter.load_window(front_path, BBOX)
    front = exporter.build_day_payload(
        day,
        values,
        lons,
        lats,
        source_file=front_path.name,
        tolerance_km=TOLERANCE_KM,
        min_length_km=MIN_LENGTH_KM,
    )

    sst: dict[str, object] | None = None
    sst_path = exporter.find_sst_file(raw_root / "sst", day)
    if sst_path is not None:
        sst_values, sst_lons, sst_lats = exporter.load_sst_window(sst_path, BBOX)
        sst = exporter.build_sst_payload(
            day,
            sst_values,
            sst_lons,
            sst_lats,
            source_file=sst_path.name,
        )
        front["has_sst"] = True

    return {"date": day, "front": front, "sst": sst}
