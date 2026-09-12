/* 本文件由 Ocean/backend/scripts/export_prototype_data.py 生成，请勿手工修改。
   数据源：Zenodo 20356239 全球逐日中尺度锋面数据集（CC BY 4.0）。*/
window.OF_DATA_META = {
  "product": {
    "id": "zenodo-20356239",
    "name": "A global daily mesoscale front dataset from satellite observations",
    "name_zh": "全球逐日中尺度锋面数据集",
    "version": "V1.0",
    "doi": "10.5281/zenodo.20356239",
    "url": "https://zenodo.org/records/20356239",
    "license": "CC BY 4.0",
    "citation": "Xing et al. (Shanghai Ocean University), 0.05 deg daily global mesoscale front dataset",
    "resolution_deg": 0.05,
    "variables": [
      "front"
    ],
    "code_semantics": {
      "line": [
        -10,
        10,
        30
      ],
      "cold_side": -20,
      "warm_side": 20,
      "nodata": -128,
      "note": "-128 同时表示陆地、湖泊、云与缺测，无法区分“没有锋面”与“没有观测”"
    }
  },
  "region": {
    "name": "东海",
    "bbox": [
      120.0,
      27.0,
      128.0,
      34.0
    ],
    "anchor": [
      124.5,
      30.2
    ],
    "ranges_km": [
      10,
      20,
      30
    ]
  },
  "grid": {
    "resolution_deg": 0.05
  },
  "availability": {
    "days": [
      "2024-08-05",
      "2024-08-06",
      "2024-08-07"
    ],
    "clim": {
      "ready": true,
      "years": [
        "2015",
        "2016",
        "2017",
        "2018",
        "2019",
        "2024"
      ],
      "dates": [
        "2015-08-05",
        "2015-08-06",
        "2015-08-07",
        "2016-08-05",
        "2016-08-06",
        "2016-08-07",
        "2017-08-05",
        "2017-08-06",
        "2018-08-05",
        "2018-08-06",
        "2018-08-07",
        "2019-08-06",
        "2019-08-07",
        "2024-08-05",
        "2024-08-06",
        "2024-08-07"
      ],
      "sample_note": "数据集是逐日的，本演示每年只取 8 月 5—7 日 3 天做同期对比，页面上会写明这个抽样口径；本次实际取样 16 天，覆盖 2015、2016、2017、2018、2019、2024 年"
    },
    "basemap": {
      "ready": true,
      "source": "Natural Earth 1:10m（公有领域）"
    }
  },
  "status": {
    "front_line": "real",
    "cold_side": "real",
    "warm_side": "real",
    "front_objects": "real",
    "sst": "not_available",
    "intensity": "not_available",
    "forecast": "not_available",
    "sea_state": "not_available",
    "fishing_grounds": "not_available"
  },
  "generated_at": "2026-09-12",
  "generator": "Ocean/backend/scripts/export_prototype_data.py",
  "known_issues": [
    "锋面文件不含 SST：温度相关展示在接入真实海温前一律显示“待接入”，不用纬度插值假造",
    "-128 同时表示陆地、湖泊、云与缺测，无法区分“没有锋面”与“没有观测”",
    "锋面线编码 -10/10/30 的物理语义在数据集说明中仍有歧义，原型不区分其含义，只按“锋面线”统一呈现",
    "锋面文件的时间坐标单位错误（days since 0000-00-00），日期一律以文件名解析",
    "锋面对象编号是本地连通域临时编号，不是数据集自带的长期锋面轨迹编号",
    "海况（风/浪/涌）、锋面强度、预报、渔场分布均未接入真实数据"
  ]
};
