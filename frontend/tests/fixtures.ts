import type {
  AccuracyResult,
  AreaSummary,
  CandidateDetail,
  CompareResult,
  CountResult,
  DetectionImageResult,
  HealthResponse,
  MapFocusResult,
  MetricsResponse,
  Provenance,
  RefusalResult,
  TableResult,
  ToolResult,
} from '../lib/api-types';

export const provenance: Provenance = {
  source: '地理院の年度別写真と基盤地図情報（テスト用の値）',
  photo_years: [2018, 2023],
  model: 'テスト用モデル',
  metric: '物体単位 F1',
  run_id: 'run-test',
  run_kind: 'real',
  note: 'テストの注記',
};

export const count: CountResult = {
  type: 'count',
  title: '12 地区の新規出現（旧写真に無い）',
  total: 33,
  breakdown: [
    { key: 'confirmed_new', label: '新規出現（旧写真に無い）', value: 33 },
    { key: 'existing_omission', label: '既存の描き漏れ（旧写真に既にある）', value: 51 },
    { key: 'uncertain', label: '判定保留', value: 18 },
  ],
  filter: { area_id: null, cls: 'confirmed_new' },
  provenance,
};

export const table: TableResult = {
  type: 'table',
  title: '面積の大きい順',
  columns: [
    { key: 'id', label: '候補 ID' },
    { key: 'class', label: '分類' },
    { key: 'area_m2', label: '面積（m²）' },
  ],
  rows: [
    { id: 'c-1-2-1', class: 'confirmed_new', area_m2: 123.4 },
    { id: 'c-1-2-2', class: 'uncertain', area_m2: 88 },
  ],
  total: 102,
  shown: 2,
  provenance,
};

export const compare: CompareResult = {
  type: 'compare',
  title: '地区ごとの候補数',
  items: [
    { area_id: 'z18-1-2', name: 'テスト地区 01', counts: { confirmed_new: 5, existing_omission: 3, uncertain: 1, total: 9 } },
    { area_id: 'z18-2-2', name: 'テスト地区 02', counts: { confirmed_new: 2, existing_omission: 6, uncertain: 2, total: 10 } },
  ],
  provenance,
};

export const mapFocus: MapFocusResult = {
  type: 'map_focus',
  title: '新規出現の候補を地図に表示',
  bbox: [130.7, 32.8, 130.71, 32.81],
  candidate_ids: ['c-1-2-1', 'c-1-2-2', 'c-1-2-3'],
  provenance,
};

export const detectionImage: DetectionImageResult = {
  type: 'detection_image',
  title: '候補 c-1-2-1 の写真',
  candidate_id: 'c-1-2-1',
  class: 'confirmed_new',
  images: [
    { year: 2018, url: '/api/candidates/c-1-2-1/image?year=2018&size=512' },
    { year: 2023, url: '/api/candidates/c-1-2-1/image?year=2023&size=512' },
  ],
  caption: '輪郭が候補の位置です。',
  provenance,
};

export const accuracy: AccuracyResult = {
  type: 'accuracy',
  title: 'このアプリの精度',
  metrics: [
    { key: 'f1', label: '建物の抽出（評価用・物体単位 F1）', value: 0.617, note: '基盤地図情報を正解にした値' },
    { key: 'new_building_recall', label: '新築の再現率', value: null, note: '手ラベルが無いため未測定' },
  ],
  provenance,
};

export const refusal: RefusalResult = {
  type: 'refusal',
  reason: 'out_of_scope',
  message: '熊本市中心部以外の質問には、お答えできません。',
  suggestions: ['新規出現の候補は何件ありますか？', 'このアプリの精度は？'],
};

export const ALL_RESULTS: ToolResult[] = [count, table, compare, mapFocus, detectionImage, accuracy, refusal];

export const areas: AreaSummary[] = [
  {
    id: 'z18-1-2',
    name: 'テスト地区 01',
    ward: '中央区',
    bbox: [130.7, 32.8, 130.701, 32.801],
    centroid: [130.7005, 32.8005],
    counts: { confirmed_new: 5, existing_omission: 3, uncertain: 1, total: 9 },
  },
];

export const health: HealthResponse = {
  status: 'ok',
  db: 'ok',
  llm: 'mock',
  run: { run_id: 'run-test', kind: 'real', created_at: '2026-11-24T12:00:00+09:00' },
  counts: { areas: 12, candidates: 102, buildings: 0 },
};

export const detail: CandidateDetail = {
  id: 'c-1-2-1',
  area_id: 'z18-1-2',
  class: 'confirmed_new',
  area_m2: 123.4,
  bbox: [130.7, 32.8, 130.7001, 32.8001],
  centroid: [130.70005, 32.80005],
  reason: 'new_absent_2018',
  evidence: { prob_2023_mean: 0.912, ov_2018: 0.031, prob_2018_p90: 0.08, ov_kiban: 0.02, edge_touch: false },
  explanation_key: 'new_absent_2018',
  images: [
    { year: 2018, url: '/api/candidates/c-1-2-1/image?year=2018&size=512' },
    { year: 2023, url: '/api/candidates/c-1-2-1/image?year=2023&size=512' },
  ],
  provenance,
};

export const metrics: MetricsResponse = {
  reference: '基盤地図情報 2018 年 10 月版',
  split: { tune: ['z18-1-2'], holdout: ['z18-2-2'] },
  sweep: [
    { scale: 1, threshold: 0.5, tune_object_f1: 0.5 },
    { scale: 1.5, threshold: 0.5, tune_object_f1: 0.6 },
  ],
  chosen: { scale: 1.5, threshold: 0.5 },
  holdout: { pixel: { iou: 0.612, f1: 0.759 }, object: { f1: 0.617, tp: 120 } },
  tune: { pixel: { iou: 0.634, f1: 0.774 }, object: { f1: 0.647, tp: 131 } },
  per_area: [{ area_id: 'z18-1-2', split: 'tune', object_f1: 0.6 }],
  excluded_edge_objects: { reference: 41, prediction: 38 },
  new_building_recall: null,
  notes: ['テスト用の注記'],
  provenance,
};

/**
 * 実データ（熊本 12 地区・2018-10 版の参照・2018 年の写真で選んだ設定）の eval.json の形と数字。
 * pipeline が足した任意項目（year_compare・existing_absent_in_2018・excluded_edge_by_split・excluded_edge_detail・protocol）を含む。
 * 値は eval.json（data/townscan/run1/out）から写した（notes と provenance だけテスト用）。
 */
export const metricsReal: MetricsResponse = {
  "reference": "基盤地図情報 BldA 2018-10 版（2018 年の写真と比べる）",
  "split": {
    "tune": [
      "z18-226274-105752",
      "z18-226266-105755",
      "z18-226258-105756",
      "z18-226256-105763",
      "z18-226249-105769",
      "z18-226240-105772"
    ],
    "holdout": [
      "z18-226238-105782",
      "z18-226227-105787",
      "z18-226240-105790",
      "z18-226211-105791",
      "z18-226218-105791",
      "z18-226233-105791"
    ]
  },
  "protocol": {
    "year": 2018,
    "iou_match": 0.5,
    "matching": "greedy one-to-one by IoU",
    "min_blob_m2": 4.0,
    "simplify_m": 0.3,
    "scales": [
      1.0,
      1.5,
      2.0
    ],
    "thresholds": [
      0.3,
      0.4,
      0.5,
      0.6,
      0.7
    ],
    "edge_overlap_min": 0.5,
    "compare_year": 2023
  },
  "sweep": [
    {
      "scale": 1.0,
      "threshold": 0.3,
      "tune_object_f1": 0.1441,
      "tune_object_precision": 0.2667,
      "tune_object_recall": 0.0988,
      "tune_pixel_iou": 0.2694,
      "tune_pixel_f1": 0.4245
    },
    {
      "scale": 1.0,
      "threshold": 0.4,
      "tune_object_f1": 0.127,
      "tune_object_precision": 0.2105,
      "tune_object_recall": 0.0909,
      "tune_pixel_iou": 0.2847,
      "tune_pixel_f1": 0.4432
    },
    {
      "scale": 1.0,
      "threshold": 0.5,
      "tune_object_f1": 0.1221,
      "tune_object_precision": 0.2,
      "tune_object_recall": 0.0879,
      "tune_pixel_iou": 0.2822,
      "tune_pixel_f1": 0.4402
    },
    {
      "scale": 1.0,
      "threshold": 0.6,
      "tune_object_f1": 0.146,
      "tune_object_precision": 0.2222,
      "tune_object_recall": 0.1087,
      "tune_pixel_iou": 0.2727,
      "tune_pixel_f1": 0.4285
    },
    {
      "scale": 1.0,
      "threshold": 0.7,
      "tune_object_f1": 0.1739,
      "tune_object_precision": 0.2667,
      "tune_object_recall": 0.129,
      "tune_pixel_iou": 0.258,
      "tune_pixel_f1": 0.4102
    },
    {
      "scale": 1.5,
      "threshold": 0.3,
      "tune_object_f1": 0.1379,
      "tune_object_precision": 0.2222,
      "tune_object_recall": 0.1,
      "tune_pixel_iou": 0.3301,
      "tune_pixel_f1": 0.4963
    },
    {
      "scale": 1.5,
      "threshold": 0.4,
      "tune_object_f1": 0.1333,
      "tune_object_precision": 0.2051,
      "tune_object_recall": 0.0988,
      "tune_pixel_iou": 0.3282,
      "tune_pixel_f1": 0.4942
    },
    {
      "scale": 1.5,
      "threshold": 0.5,
      "tune_object_f1": 0.1525,
      "tune_object_precision": 0.25,
      "tune_object_recall": 0.1098,
      "tune_pixel_iou": 0.3098,
      "tune_pixel_f1": 0.4731
    },
    {
      "scale": 1.5,
      "threshold": 0.6,
      "tune_object_f1": 0.1746,
      "tune_object_precision": 0.275,
      "tune_object_recall": 0.1279,
      "tune_pixel_iou": 0.3056,
      "tune_pixel_f1": 0.4681
    },
    {
      "scale": 1.5,
      "threshold": 0.7,
      "tune_object_f1": 0.1732,
      "tune_object_precision": 0.2683,
      "tune_object_recall": 0.1279,
      "tune_pixel_iou": 0.2988,
      "tune_pixel_f1": 0.4602
    },
    {
      "scale": 2.0,
      "threshold": 0.3,
      "tune_object_f1": 0.2121,
      "tune_object_precision": 0.2979,
      "tune_object_recall": 0.1647,
      "tune_pixel_iou": 0.3399,
      "tune_pixel_f1": 0.5074
    },
    {
      "scale": 2.0,
      "threshold": 0.4,
      "tune_object_f1": 0.2273,
      "tune_object_precision": 0.3191,
      "tune_object_recall": 0.1765,
      "tune_pixel_iou": 0.3301,
      "tune_pixel_f1": 0.4964
    },
    {
      "scale": 2.0,
      "threshold": 0.5,
      "tune_object_f1": 0.2,
      "tune_object_precision": 0.2889,
      "tune_object_recall": 0.1529,
      "tune_pixel_iou": 0.3226,
      "tune_pixel_f1": 0.4878
    },
    {
      "scale": 2.0,
      "threshold": 0.6,
      "tune_object_f1": 0.1692,
      "tune_object_precision": 0.2444,
      "tune_object_recall": 0.1294,
      "tune_pixel_iou": 0.3145,
      "tune_pixel_f1": 0.4786
    },
    {
      "scale": 2.0,
      "threshold": 0.7,
      "tune_object_f1": 0.1587,
      "tune_object_precision": 0.2439,
      "tune_object_recall": 0.1176,
      "tune_pixel_iou": 0.3037,
      "tune_pixel_f1": 0.4659
    }
  ],
  "chosen": {
    "scale": 2.0,
    "threshold": 0.4,
    "selected_by": "調整用タイルの物体単位 F1"
  },
  "holdout": {
    "pixel": {
      "iou": 0.4117,
      "precision": 0.6867,
      "recall": 0.5069,
      "f1": 0.5833,
      "tp": 87478,
      "fp": 39905,
      "fn": 85088
    },
    "object": {
      "f1": 0.16,
      "precision": 0.2333,
      "recall": 0.1217,
      "tp": 14,
      "fp": 46,
      "fn": 101,
      "n_ref": 115,
      "n_pred": 60
    }
  },
  "tune": {
    "pixel": {
      "iou": 0.3301,
      "precision": 0.6747,
      "recall": 0.3926,
      "f1": 0.4964,
      "tp": 49116,
      "fp": 23680,
      "fn": 75976
    },
    "object": {
      "f1": 0.2273,
      "precision": 0.3191,
      "recall": 0.1765,
      "tp": 15,
      "fp": 32,
      "fn": 70,
      "n_ref": 85,
      "n_pred": 47
    }
  },
  "overall": {
    "pixel": {
      "iou": 0.3781,
      "precision": 0.6824,
      "recall": 0.4589,
      "f1": 0.5487,
      "tp": 136594,
      "fp": 63585,
      "fn": 161064
    },
    "object": {
      "f1": 0.1889,
      "precision": 0.271,
      "recall": 0.145,
      "tp": 29,
      "fp": 78,
      "fn": 171,
      "n_ref": 200,
      "n_pred": 107
    }
  },
  "per_area": [
    {
      "area_id": "z18-226274-105752",
      "split": "tune",
      "pixel_iou": 0.2685,
      "pixel_f1": 0.4233,
      "object_f1": 0.2353,
      "object_precision": 0.25,
      "object_recall": 0.2222,
      "n_ref": 9,
      "n_pred": 8,
      "excluded_ref": 4,
      "excluded_pred": 2
    },
    {
      "area_id": "z18-226266-105755",
      "split": "tune",
      "pixel_iou": 0.5627,
      "pixel_f1": 0.7202,
      "object_f1": 0.6667,
      "object_precision": 1.0,
      "object_recall": 0.5,
      "n_ref": 2,
      "n_pred": 1,
      "excluded_ref": 4,
      "excluded_pred": 4
    },
    {
      "area_id": "z18-226258-105756",
      "split": "tune",
      "pixel_iou": 0.1737,
      "pixel_f1": 0.296,
      "object_f1": 0.1739,
      "object_precision": 0.2222,
      "object_recall": 0.1429,
      "n_ref": 14,
      "n_pred": 9,
      "excluded_ref": 27,
      "excluded_pred": 13
    },
    {
      "area_id": "z18-226256-105763",
      "split": "tune",
      "pixel_iou": 0.3809,
      "pixel_f1": 0.5517,
      "object_f1": 0.1935,
      "object_precision": 0.375,
      "object_recall": 0.1304,
      "n_ref": 23,
      "n_pred": 8,
      "excluded_ref": 4,
      "excluded_pred": 1
    },
    {
      "area_id": "z18-226249-105769",
      "split": "tune",
      "pixel_iou": 0.2853,
      "pixel_f1": 0.444,
      "object_f1": 0.2414,
      "object_precision": 0.3333,
      "object_recall": 0.1892,
      "n_ref": 37,
      "n_pred": 21,
      "excluded_ref": 20,
      "excluded_pred": 8
    },
    {
      "area_id": "z18-226240-105772",
      "split": "tune",
      "pixel_iou": null,
      "pixel_f1": null,
      "object_f1": null,
      "object_precision": null,
      "object_recall": null,
      "n_ref": 0,
      "n_pred": 0,
      "excluded_ref": 1,
      "excluded_pred": 0
    },
    {
      "area_id": "z18-226238-105782",
      "split": "holdout",
      "pixel_iou": 0.4474,
      "pixel_f1": 0.6182,
      "object_f1": 0.1081,
      "object_precision": 0.1667,
      "object_recall": 0.08,
      "n_ref": 25,
      "n_pred": 12,
      "excluded_ref": 9,
      "excluded_pred": 7
    },
    {
      "area_id": "z18-226227-105787",
      "split": "holdout",
      "pixel_iou": 0.4249,
      "pixel_f1": 0.5964,
      "object_f1": 0.16,
      "object_precision": 0.2727,
      "object_recall": 0.1132,
      "n_ref": 53,
      "n_pred": 22,
      "excluded_ref": 15,
      "excluded_pred": 10
    },
    {
      "area_id": "z18-226240-105790",
      "split": "holdout",
      "pixel_iou": 0.4191,
      "pixel_f1": 0.5907,
      "object_f1": 0.2083,
      "object_precision": 0.2778,
      "object_recall": 0.1667,
      "n_ref": 30,
      "n_pred": 18,
      "excluded_ref": 19,
      "excluded_pred": 11
    },
    {
      "area_id": "z18-226211-105791",
      "split": "holdout",
      "pixel_iou": null,
      "pixel_f1": null,
      "object_f1": null,
      "object_precision": null,
      "object_recall": null,
      "n_ref": 0,
      "n_pred": 0,
      "excluded_ref": 0,
      "excluded_pred": 0
    },
    {
      "area_id": "z18-226218-105791",
      "split": "holdout",
      "pixel_iou": 0.2142,
      "pixel_f1": 0.3528,
      "object_f1": 0.0,
      "object_precision": 0.0,
      "object_recall": 0.0,
      "n_ref": 2,
      "n_pred": 3,
      "excluded_ref": 2,
      "excluded_pred": 2
    },
    {
      "area_id": "z18-226233-105791",
      "split": "holdout",
      "pixel_iou": 0.2069,
      "pixel_f1": 0.3428,
      "object_f1": 0.2,
      "object_precision": 0.2,
      "object_recall": 0.2,
      "n_ref": 5,
      "n_pred": 5,
      "excluded_ref": 2,
      "excluded_pred": 1
    }
  ],
  "excluded_edge_objects": {
    "reference": 107,
    "prediction": 59
  },
  "excluded_edge_by_split": {
    "tune": {
      "reference": 60,
      "prediction": 28
    },
    "holdout": {
      "reference": 47,
      "prediction": 31
    }
  },
  "excluded_edge_detail": {
    "overall": {
      "reference": {
        "touching_edge": 85,
        "overlapping_excluded_prediction": 22
      },
      "prediction": {
        "touching_edge": 56,
        "overlapping_excluded_reference": 3
      }
    },
    "tune": {
      "reference": {
        "touching_edge": 46,
        "overlapping_excluded_prediction": 14
      },
      "prediction": {
        "touching_edge": 26,
        "overlapping_excluded_reference": 2
      }
    },
    "holdout": {
      "reference": {
        "touching_edge": 39,
        "overlapping_excluded_prediction": 8
      },
      "prediction": {
        "touching_edge": 30,
        "overlapping_excluded_reference": 1
      }
    }
  },
  "existing_absent_in_2018": {
    "setting": {
      "scale": 2.0,
      "threshold": 0.4
    },
    "params": {
      "kiban_ov_max": 0.25,
      "min_area_m2": 20.0,
      "omission_ov_2018_min": 0.5,
      "new_ov_2018_max": 0.1,
      "new_p90_max": 0.2
    },
    "overall": {
      "n_buildings": 200,
      "absent": 66,
      "absent_share": 0.33,
      "present": 102,
      "present_share": 0.51
    },
    "tune": {
      "n_buildings": 90,
      "absent": 32,
      "absent_share": 0.3556,
      "present": 41,
      "present_share": 0.4556
    },
    "holdout": {
      "n_buildings": 110,
      "absent": 34,
      "absent_share": 0.3091,
      "present": 61,
      "present_share": 0.5545
    }
  },
  "new_building_recall": null,
  "year_compare": {
    "selected_on_year": 2018,
    "compare_year": 2023,
    "setting": {
      "scale": 2.0,
      "threshold": 0.4
    },
    "by_year": {
      "2018": {
        "tune": {
          "pixel": {
            "iou": 0.3301,
            "precision": 0.6747,
            "recall": 0.3926,
            "f1": 0.4964,
            "tp": 49116,
            "fp": 23680,
            "fn": 75976
          },
          "object": {
            "f1": 0.2273,
            "precision": 0.3191,
            "recall": 0.1765,
            "tp": 15,
            "fp": 32,
            "fn": 70,
            "n_ref": 85,
            "n_pred": 47
          }
        },
        "holdout": {
          "pixel": {
            "iou": 0.4117,
            "precision": 0.6867,
            "recall": 0.5069,
            "f1": 0.5833,
            "tp": 87478,
            "fp": 39905,
            "fn": 85088
          },
          "object": {
            "f1": 0.16,
            "precision": 0.2333,
            "recall": 0.1217,
            "tp": 14,
            "fp": 46,
            "fn": 101,
            "n_ref": 115,
            "n_pred": 60
          }
        },
        "overall": {
          "pixel": {
            "iou": 0.3781,
            "precision": 0.6824,
            "recall": 0.4589,
            "f1": 0.5487,
            "tp": 136594,
            "fp": 63585,
            "fn": 161064
          },
          "object": {
            "f1": 0.1889,
            "precision": 0.271,
            "recall": 0.145,
            "tp": 29,
            "fp": 78,
            "fn": 171,
            "n_ref": 200,
            "n_pred": 107
          }
        }
      },
      "2023": {
        "tune": {
          "pixel": {
            "iou": 0.2815,
            "precision": 0.6299,
            "recall": 0.3373,
            "f1": 0.4393,
            "tp": 49385,
            "fp": 29021,
            "fn": 97047
          },
          "object": {
            "f1": 0.1509,
            "precision": 0.2,
            "recall": 0.1212,
            "tp": 12,
            "fp": 48,
            "fn": 87,
            "n_ref": 99,
            "n_pred": 60
          }
        },
        "holdout": {
          "pixel": {
            "iou": 0.2945,
            "precision": 0.6801,
            "recall": 0.3418,
            "f1": 0.455,
            "tp": 60023,
            "fp": 28238,
            "fn": 115580
          },
          "object": {
            "f1": 0.1,
            "precision": 0.1205,
            "recall": 0.0855,
            "tp": 10,
            "fp": 73,
            "fn": 107,
            "n_ref": 117,
            "n_pred": 83
          }
        },
        "overall": {
          "pixel": {
            "iou": 0.2885,
            "precision": 0.6564,
            "recall": 0.3397,
            "f1": 0.4477,
            "tp": 109408,
            "fp": 57259,
            "fn": 212627
          },
          "object": {
            "f1": 0.1226,
            "precision": 0.1538,
            "recall": 0.1019,
            "tp": 22,
            "fp": 121,
            "fn": 194,
            "n_ref": 216,
            "n_pred": 143
          }
        }
      }
    }
  },
  "notes": [
    "テスト用の注記"
  ],
  provenance,
};

/** fetch のスタブ用: JSON の Response を作る */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
