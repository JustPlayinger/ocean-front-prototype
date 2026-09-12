# data/ · 生成物（不要手改）

这些 `.js` 文件由脚本生成，页面用 `<script>` 直接引入（可离线双击打开，不需要本地服务器）：

| 文件 | 生成者 | 内容 |
|---|---|---|
| `meta.js` | `Ocean/backend/scripts/export_prototype_data.py` | 数据产品 / 许可 / 可用日期 / 缺什么 |
| `day/<日期>.js` | 同上（`--dates` 指定日期） | 真实锋面：对象中心线、锋面带、冷暖侧、缺测掩码、质量统计 |
| `clim/same-period.js` | 同上（`--mode clim`） | 往年同期统计（唯一口径：front_present = 半径内线像元 > 0） |
| `base/basemap.js` | `tools/build-basemap.mjs` | Natural Earth 公有领域底图（陆地 / 海岸线 / 200 m·1000 m 等深线） |

```powershell
# 重新生成（在 Ocean/backend 下）
.\.venv\Scripts\python.exe scripts\export_prototype_data.py --dates 2024-08-05 2024-08-06 2024-08-07
.\.venv\Scripts\python.exe scripts\export_prototype_data.py --mode clim
# 底图（在本仓根目录）
node tools\build-basemap.mjs
# 校验
node tools\data-check.mjs
```

完整结构说明、字段含义、来源与许可见 [`../docs/data-schema.md`](../docs/data-schema.md)。
