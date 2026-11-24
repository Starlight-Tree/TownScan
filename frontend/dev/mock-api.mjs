// 開発用のスタブ API（Node の標準モジュールだけ）。画面の確認とテストに使う。本番のコードには混ぜない。
// 形は docs/spec-prototype.md §4.4・§4.5 に合わせた小さな合成データ。health の run.kind は既定で "synthetic"。
//
//   node dev/mock-api.mjs            # 127.0.0.1:8599（MOCK_API_PORT で変更。実 API の 8500 とは重ねない）
//   MOCK_RUN_KIND=real node ...      # run.kind を "real" にして、バナーが出ない状態を見る
//
// 動作確認用の合言葉: チャットに「エラーを起こして」と送ると、500 を返す（画面のエラー表示の確認用）。
import http from 'node:http';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';

const CLASSES = ['confirmed_new', 'existing_omission', 'uncertain'];
const CLASS_LABEL = {
  confirmed_new: '新規出現（旧写真に無い）',
  existing_omission: '既存の描き漏れ（旧写真に既にある）',
  uncertain: '判定保留',
};
const CLASS_RGB = { confirmed_new: [194, 65, 12], existing_omission: [29, 95, 209], uncertain: [124, 58, 237] };
const WARDS = ['中央区', '東区', '西区', '南区', '北区'];
const Z = 18;

// ---- 決まった乱数（同じ並びを毎回出す） ----
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- タイル計算（Web メルカトル） ----
function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const rad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  return { x, y };
}

function tileBBox(x, y, z) {
  const n = 2 ** z;
  const lon = (tx) => (tx / n) * 360 - 180;
  const lat = (ty) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / n))) * 180) / Math.PI;
  return [lon(x), lat(y + 1), lon(x + 1), lat(y)];
}

const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

// ---- 合成データの生成 ----
export function buildDataset({ runKind = 'synthetic' } = {}) {
  const center = lonLatToTile(130.7417, 32.8032, Z);
  const areas = [];
  const candidates = [];
  let areaIndex = 0;
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -2; dx <= 1; dx += 1) {
      const x = center.x + dx;
      const y = center.y + dy;
      areaIndex += 1;
      const rand = mulberry32(1000 + areaIndex * 17);
      const bbox = tileBBox(x, y, Z);
      const [w, s, e, n] = bbox;
      const centroid = [(w + e) / 2, (s + n) / 2];
      const mPerLat = 111320;
      const mPerLon = 111320 * Math.cos((centroid[1] * Math.PI) / 180);
      const area = {
        id: `z18-${x}-${y}`,
        z: Z,
        x,
        y,
        bbox,
        centroid,
        name: `テスト地区 ${String(areaIndex).padStart(2, '0')}`,
        ward: WARDS[areaIndex % WARDS.length],
        municipality: '43100',
        name_source: 'mock',
      };
      const count = 5 + ((areaIndex * 3) % 8);
      const list = [];
      for (let i = 0; i < count; i += 1) {
        const r = rand();
        const cls = r < 0.45 ? 'confirmed_new' : r < 0.8 ? 'existing_omission' : 'uncertain';
        const cx = w + (0.12 + 0.76 * rand()) * (e - w);
        const cy = s + (0.12 + 0.76 * rand()) * (n - s);
        const wm = 6 + rand() * 12;
        const hm = 5 + rand() * 10;
        const ang = rand() * Math.PI;
        const ring = [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
          [-1, -1],
        ].map(([sx, sy]) => {
          const px = (sx * wm) / 2;
          const py = (sy * hm) / 2;
          const rx = px * Math.cos(ang) - py * Math.sin(ang);
          const ry = px * Math.sin(ang) + py * Math.cos(ang);
          return [round(cx + rx / mPerLon, 7), round(cy + ry / mPerLat, 7)];
        });
        const lons = ring.map((p) => p[0]);
        const lats = ring.map((p) => p[1]);
        const cbbox = [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
        const edge = cls === 'uncertain' && rand() < 0.35;
        const evidence =
          cls === 'confirmed_new'
            ? { prob_2023_mean: round(0.75 + rand() * 0.2, 3), ov_2018: round(rand() * 0.08, 3), prob_2018_p90: round(0.02 + rand() * 0.13, 3), ov_kiban: round(rand() * 0.15, 3), edge_touch: false }
            : cls === 'existing_omission'
              ? { prob_2023_mean: round(0.7 + rand() * 0.25, 3), ov_2018: round(0.55 + rand() * 0.4, 3), prob_2018_p90: round(0.5 + rand() * 0.45, 3), ov_kiban: round(rand() * 0.2, 3), edge_touch: false }
              : { prob_2023_mean: round(0.55 + rand() * 0.3, 3), ov_2018: round(0.15 + rand() * 0.3, 3), prob_2018_p90: round(0.2 + rand() * 0.3, 3), ov_kiban: round(rand() * 0.2, 3), edge_touch: edge };
        const reason = cls === 'confirmed_new' ? 'new_absent_2018' : cls === 'existing_omission' ? 'present_2018' : edge ? 'edge' : 'ambiguous';
        list.push({
          class: cls,
          area_m2: round(wm * hm, 1),
          bbox: cbbox,
          centroid: [round(cx, 7), round(cy, 7)],
          geometry: { type: 'Polygon', coordinates: [ring] },
          evidence,
          reason,
          area_id: area.id,
        });
      }
      list.sort((a, b) => b.area_m2 - a.area_m2);
      list.forEach((c, i) => {
        c.id = `c-${x}-${y}-${i + 1}`;
      });
      candidates.push(...list);
      area.counts = {
        confirmed_new: list.filter((c) => c.class === 'confirmed_new').length,
        existing_omission: list.filter((c) => c.class === 'existing_omission').length,
        uncertain: list.filter((c) => c.class === 'uncertain').length,
        total: list.length,
      };
      areas.push(area);
    }
  }
  return {
    runKind,
    run: { run_id: 'mock-run-0001', kind: runKind, created_at: '2026-11-24T12:00:00+09:00' },
    areas,
    candidates,
  };
}

// ---- 応答の部品 ----
function provenanceOf(data, extra = {}) {
  return {
    source: '開発用の合成データ（地理院の写真・基盤地図情報は使っていません）',
    photo_years: [2018, 2023],
    model: '模擬データ（建物抽出モデルは動かしていません）',
    run_id: data.run.run_id,
    run_kind: data.run.kind,
    note: 'dev/mock-api.mjs が作った小さなデータです。',
    ...extra,
  };
}

function areaSummary(a) {
  return { id: a.id, name: a.name, ward: a.ward, bbox: a.bbox, centroid: a.centroid, counts: a.counts };
}

function candidateSummary(c) {
  return { id: c.id, area_id: c.area_id, class: c.class, area_m2: c.area_m2, bbox: c.bbox, centroid: c.centroid, reason: c.reason };
}

function candidateDetail(data, c) {
  return {
    ...candidateSummary(c),
    evidence: c.evidence,
    explanation_key: c.reason,
    images: [2018, 2023].map((year) => ({ year, url: `/api/candidates/${c.id}/image?year=${year}&size=512` })),
    provenance: provenanceOf(data, { metric: '基盤地図情報との重なり・2018 年の抽出との重なり' }),
  };
}

function metricsOf(data) {
  const tune = data.areas.slice(0, 6).map((a) => a.id);
  const holdout = data.areas.slice(6).map((a) => a.id);
  const sweep = [];
  for (const scale of [1.0, 1.5, 2.0]) {
    for (const threshold of [0.3, 0.4, 0.5, 0.6, 0.7]) {
      const f1 = 0.55 + 0.1 * (scale - 1) - Math.abs(threshold - 0.5) * 0.3;
      sweep.push({ scale, threshold, tune_object_f1: round(f1, 3) });
    }
  }
  return {
    reference: '基盤地図情報（建築物の外周 2018 年 10 月版）の合成データ。実際の値ではありません',
    split: { tune, holdout },
    sweep,
    chosen: { scale: 1.5, threshold: 0.5 },
    holdout: {
      pixel: { iou: 0.612, precision: 0.78, recall: 0.74, f1: 0.759 },
      object: { precision: 0.66, recall: 0.58, f1: 0.617, tp: 120, fp: 62, fn: 87 },
    },
    tune: {
      pixel: { iou: 0.634, precision: 0.8, recall: 0.75, f1: 0.774 },
      object: { precision: 0.69, recall: 0.61, f1: 0.647, tp: 131, fp: 59, fn: 84 },
    },
    per_area: data.areas.map((a, i) => ({
      area_id: a.id,
      split: i < 6 ? 'tune' : 'holdout',
      pixel_iou: round(0.55 + ((i * 7) % 10) / 100, 3),
      object_f1: round(0.5 + ((i * 11) % 15) / 100, 3),
    })),
    excluded_edge_objects: { reference: 41, prediction: 38 },
    new_building_recall: null,
    notes: [
      'これは開発用の合成データの値です。実測した精度ではありません。',
      '新築の再現率は、手でラベルした正解が無いので測っていません。',
      '3 分類の閾値は、検証していない初期値です。',
    ],
    provenance: provenanceOf(data, { metric: '物体単位 F1（IoU 0.5 以上で 1 対 1）' }),
  };
}

// ---- チャット（決まった規則で意図を選ぶ模擬モデル） ----
function findArea(data, text) {
  const m = text.match(/テスト地区\s*0?(\d{1,2})/);
  if (!m) return null;
  const name = `テスト地区 ${String(Number(m[1])).padStart(2, '0')}`;
  return data.areas.find((a) => a.name === name) ?? null;
}

function findClass(text) {
  if (/描き漏れ|既存/.test(text)) return 'existing_omission';
  if (/保留|不明|判定できない/.test(text)) return 'uncertain';
  if (/新規|新築|新しく|建った/.test(text)) return 'confirmed_new';
  return null;
}

const SUGGESTIONS = ['新規出現の候補は何件ありますか？', '地区ごとの候補数を比べて', 'このアプリの精度は？'];

function refusal(reason, message, suggestions = SUGGESTIONS) {
  return { type: 'refusal', reason, message, suggestions };
}

export function answerChat(data, messages) {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  const text = String(last?.content ?? '').trim();
  const area = findArea(data, text);
  const cls = findClass(text);
  const pool = data.candidates.filter((c) => (!area || c.area_id === area.id) && (!cls || c.class === cls));
  const clsLabel = cls ? CLASS_LABEL[cls] : '新規出現の候補（全分類）';
  const scope = area ? area.name : '12 地区の合計';

  let content;
  let results;
  let toolCalls;

  if (/天気|雑談|こんにちは|渋谷|東京|大阪|福岡/.test(text)) {
    content = 'このアプリが扱うのは、熊本市中心部の写真だけです。';
    results = [refusal('out_of_scope', '熊本市中心部の 12 地区以外の場所や、写真に関係のない質問には、お答えできません。')];
    toolCalls = [];
  } else if (/20(2[4-9]|[3-9]\d)\s*年/.test(text)) {
    content = '2024 年以降の写真は持っていないので、棟の確認はできません。';
    results = [refusal('no_photo_period', '使える写真は 2018 年と 2023 年です。2024 年以降に建った建物は、写真が無いので確かめられません。')];
    toolCalls = [];
  } else if (/衛星|変化の当たり|ヒートマップ|GEE/i.test(text)) {
    content = '衛星による「変化の当たり」は、まだ実装していません。';
    results = [refusal('not_implemented', '衛星（Google Earth Engine）の層は未実装です。いまは、航空写真から棟ごとに見つけた候補だけを扱います。')];
    toolCalls = [];
  } else if (/存在しない|データがない|空っぽ/.test(text)) {
    content = '該当するデータがありません。';
    results = [refusal('no_data', '条件に合う候補が 1 件もありませんでした。')];
    toolCalls = [{ name: 'count_candidates', args: { area_id: null, cls: null } }];
  } else if (/精度|F1|再現率|正確/.test(text)) {
    const m = metricsOf(data);
    content = '建物の抽出の精度です（評価用の地区での値）。新築の再現率は、手ラベルが無いので未測定です。';
    results = [
      {
        type: 'accuracy',
        title: 'このアプリの精度',
        metrics: [
          { key: 'holdout_object_f1', label: '建物の抽出（評価用・物体単位 F1）', value: m.holdout.object.f1, note: '基盤地図情報を正解にした値' },
          { key: 'holdout_pixel_iou', label: '建物の抽出（評価用・画素 IoU）', value: m.holdout.pixel.iou, note: '面積の重なり' },
          { key: 'new_building_recall', label: '新築の再現率', value: null, note: '手ラベルが無いため未測定' },
        ],
        provenance: provenanceOf(data, { metric: m.provenance.metric }),
      },
    ];
    toolCalls = [{ name: 'get_accuracy', args: {} }];
  } else if (/写真|画像|見比べ/.test(text)) {
    const target = pool.filter((c) => c.class === (cls ?? 'confirmed_new'))[0] ?? pool[0];
    if (!target) {
      content = '該当する候補がありません。';
      results = [refusal('no_data', '条件に合う候補がありませんでした。')];
      toolCalls = [];
    } else {
      content = `${areaName(data, target)}の、いちばん大きい候補の写真です。`;
      results = [
        {
          type: 'detection_image',
          title: `候補 ${target.id} の 2018 年と 2023 年の写真`,
          candidate_id: target.id,
          class: target.class,
          images: [2018, 2023].map((year) => ({ year, url: `/api/candidates/${target.id}/image?year=${year}&size=512` })),
          caption: `${CLASS_LABEL[target.class]}。輪郭が候補の位置です。`,
          provenance: provenanceOf(data),
        },
      ];
      toolCalls = [{ name: 'show_detection_image', args: { candidate_id: target.id } }];
    }
  } else if (/地図|どこ|場所/.test(text)) {
    const list = pool.length > 0 ? pool : data.candidates;
    const bbox = [
      Math.min(...list.map((c) => c.bbox[0])),
      Math.min(...list.map((c) => c.bbox[1])),
      Math.max(...list.map((c) => c.bbox[2])),
      Math.max(...list.map((c) => c.bbox[3])),
    ];
    content = `${scope}の「${clsLabel}」を、地図に表示します。`;
    results = [{ type: 'map_focus', title: `${scope}の${clsLabel}`, bbox, candidate_ids: list.map((c) => c.id), provenance: provenanceOf(data) }];
    toolCalls = [{ name: 'focus_map', args: { area_id: area?.id ?? null, cls } }];
  } else if (/比較|比べ|地区ごと|地区別/.test(text)) {
    content = '地区ごとの候補数を比べました。';
    results = [
      {
        type: 'compare',
        title: '地区ごとの候補数',
        items: data.areas.map((a) => ({ area_id: a.id, name: a.name, counts: a.counts })),
        provenance: provenanceOf(data),
      },
    ];
    toolCalls = [{ name: 'compare_areas', args: {} }];
  } else if (/一覧|表|リスト|大きい|上位/.test(text)) {
    const rows = pool.slice().sort((a, b) => b.area_m2 - a.area_m2).slice(0, 10);
    content = `${scope}の「${clsLabel}」を、面積の大きい順に示します。`;
    results = [
      {
        type: 'table',
        title: `${scope}の${clsLabel}（面積の大きい順）`,
        columns: [
          { key: 'id', label: '候補 ID' },
          { key: 'area_id', label: '地区' },
          { key: 'class', label: '分類' },
          { key: 'area_m2', label: '面積（m²）' },
        ],
        rows: rows.map((c) => ({ id: c.id, area_id: c.area_id, class: c.class, area_m2: c.area_m2 })),
        total: pool.length,
        shown: rows.length,
        provenance: provenanceOf(data),
      },
    ];
    toolCalls = [{ name: 'list_candidates', args: { area_id: area?.id ?? null, cls, limit: 10 } }];
  } else if (/件数|何件|何棟|いくつ|数|新規|候補|新築|建った/.test(text)) {
    const breakdown = CLASSES.map((k) => ({
      key: k,
      label: CLASS_LABEL[k],
      value: data.candidates.filter((c) => (!area || c.area_id === area.id) && c.class === k).length,
    }));
    content = `${scope}の「${clsLabel}」の件数です。写真だけでは建築時期を確定できないため、「候補」としています。`;
    results = [
      {
        type: 'count',
        title: `${scope}の${clsLabel}`,
        total: pool.length,
        breakdown,
        filter: { area_id: area?.id ?? null, cls },
        provenance: provenanceOf(data),
      },
    ];
    toolCalls = [{ name: 'count_candidates', args: { area_id: area?.id ?? null, cls } }];
  } else {
    content = 'うまく読み取れませんでした。';
    results = [refusal('out_of_scope', '熊本市中心部の新規出現の候補について、件数・一覧・比較・写真・精度などをお聞きください。')];
    toolCalls = [];
  }
  return { message: { role: 'assistant', content, results, tool_calls: toolCalls } };
}

function areaName(data, c) {
  return data.areas.find((a) => a.id === c.area_id)?.name ?? c.area_id;
}

// ---- 画像（PNG を標準モジュールだけで作る） ----
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let c;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n += 1) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgb) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 3 + 1)] = 0;
    rgb.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const imageCache = new Map();

/** 写真に見立てた模様 + 建物（2023 年、または既存の描き漏れの 2018 年）+ 候補の輪郭 */
export function renderCandidateImage(c, year, size) {
  const key = `${c.id}:${year}:${size}`;
  const hit = imageCache.get(key);
  if (hit) return hit;
  const rand = mulberry32([...key].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7));
  const rgb = Buffer.alloc(size * size * 3);
  const base = year === 2018 ? [150, 160, 138] : [140, 150, 140];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const n = (rand() - 0.5) * 22 + Math.sin(x / 17) * 6 + Math.cos(y / 23) * 6;
      const i = (y * size + x) * 3;
      rgb[i] = Math.max(0, Math.min(255, base[0] + n));
      rgb[i + 1] = Math.max(0, Math.min(255, base[1] + n));
      rgb[i + 2] = Math.max(0, Math.min(255, base[2] + n));
    }
  }
  const rect = (x0, y0, x1, y1, color, fill) => {
    for (let y = Math.max(0, y0); y < Math.min(size, y1); y += 1) {
      for (let x = Math.max(0, x0); x < Math.min(size, x1); x += 1) {
        const i = (y * size + x) * 3;
        rgb[i] = Math.round(rgb[i] * (1 - fill) + color[0] * fill);
        rgb[i + 1] = Math.round(rgb[i + 1] * (1 - fill) + color[1] * fill);
        rgb[i + 2] = Math.round(rgb[i + 2] * (1 - fill) + color[2] * fill);
      }
    }
  };
  const w = Math.round(size * 0.42);
  const h = Math.round(size * 0.32);
  const x0 = Math.round((size - w) / 2);
  const y0 = Math.round((size - h) / 2);
  const hasBuilding = year === 2023 || c.class === 'existing_omission' || (c.class === 'uncertain' && c.evidence.ov_2018 > 0.25);
  if (hasBuilding) rect(x0, y0, x0 + w, y0 + h, [196, 188, 176], 0.92);
  const t = Math.max(2, Math.round(size / 160));
  const color = CLASS_RGB[c.class] ?? [0, 0, 0];
  rect(x0 - t, y0 - t, x0 + w + t, y0, color, 1);
  rect(x0 - t, y0 + h, x0 + w + t, y0 + h + t, color, 1);
  rect(x0 - t, y0, x0, y0 + h, color, 1);
  rect(x0 + w, y0, x0 + w + t, y0 + h, color, 1);
  const png = encodePng(size, rgb);
  imageCache.set(key, png);
  return png;
}

// ---- HTTP ----
function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

function sendError(res, status, code, message) {
  sendJson(res, status, { error: { code, message } });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

export function createMockApi({ runKind = 'synthetic' } = {}) {
  const data = buildDataset({ runKind });
  const byId = new Map(data.candidates.map((c) => [c.id, c]));

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://mock.local');
      const path = url.pathname;
      const q = url.searchParams;

      if (req.method === 'POST' && path === '/api/chat') {
        let body;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          return sendError(res, 422, 'invalid_body', 'JSON を読めませんでした。');
        }
        if (!body || !Array.isArray(body.messages) || body.messages.some((m) => typeof m?.content !== 'string')) {
          return sendError(res, 422, 'invalid_body', 'messages は {role, content} の配列にしてください。');
        }
        const last = body.messages[body.messages.length - 1];
        if (/エラーを起こして/.test(String(last?.content))) {
          return sendError(res, 500, 'mock_failure', '動作確認用に、わざとエラーを返しました。');
        }
        return sendJson(res, 200, answerChat(data, body.messages));
      }

      if (req.method !== 'GET') return sendError(res, 405, 'method_not_allowed', 'このパスは GET だけです。');

      if (path === '/api/health') {
        return sendJson(res, 200, {
          status: 'ok',
          db: 'none (mock)',
          llm: 'mock',
          run: data.run,
          counts: { areas: data.areas.length, candidates: data.candidates.length, buildings: 0 },
        });
      }
      if (path === '/api/areas') return sendJson(res, 200, data.areas.map(areaSummary));

      const filtered = () => {
        const areaId = q.get('area_id');
        const cls = q.get('cls');
        if (cls && !CLASSES.includes(cls)) return { error: 'cls は confirmed_new・existing_omission・uncertain のどれかにしてください。' };
        return { list: data.candidates.filter((c) => (!areaId || c.area_id === areaId) && (!cls || c.class === cls)) };
      };

      if (path === '/api/candidates') {
        const f = filtered();
        if (f.error) return sendError(res, 422, 'invalid_query', f.error);
        const limit = Math.min(500, Math.max(1, Number(q.get('limit') ?? 50)));
        const offset = Math.max(0, Number(q.get('offset') ?? 0));
        if (!Number.isFinite(limit) || !Number.isFinite(offset)) return sendError(res, 422, 'invalid_query', 'limit・offset は数にしてください。');
        const sorted = f.list.slice().sort((a, b) => b.area_m2 - a.area_m2);
        return sendJson(res, 200, { total: sorted.length, items: sorted.slice(offset, offset + limit).map(candidateSummary) });
      }
      if (path === '/api/candidates.geojson') {
        const f = filtered();
        if (f.error) return sendError(res, 422, 'invalid_query', f.error);
        return sendJson(res, 200, {
          type: 'FeatureCollection',
          features: f.list.map((c) => ({
            type: 'Feature',
            id: c.id,
            geometry: c.geometry,
            properties: { id: c.id, class: c.class, area_m2: c.area_m2, area_id: c.area_id },
          })),
        });
      }

      const imageMatch = path.match(/^\/api\/candidates\/([^/]+)\/image$/);
      if (imageMatch) {
        const c = byId.get(decodeURIComponent(imageMatch[1]));
        if (!c) return sendError(res, 404, 'not_found', '候補が見つかりません。');
        const year = Number(q.get('year'));
        const size = Number(q.get('size') ?? 512);
        if (year !== 2018 && year !== 2023) return sendError(res, 422, 'invalid_query', 'year は 2018 か 2023 です。');
        if (!Number.isInteger(size) || size < 64 || size > 1024) return sendError(res, 422, 'invalid_query', 'size は 64〜1024 の整数です。');
        const png = renderCandidateImage(c, year, size);
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length, 'cache-control': 'max-age=60' });
        return res.end(png);
      }

      const detailMatch = path.match(/^\/api\/candidates\/([^/]+)$/);
      if (detailMatch) {
        const c = byId.get(decodeURIComponent(detailMatch[1]));
        if (!c) return sendError(res, 404, 'not_found', '候補が見つかりません。');
        return sendJson(res, 200, candidateDetail(data, c));
      }

      if (path === '/api/metrics') return sendJson(res, 200, metricsOf(data));

      return sendError(res, 404, 'not_found', 'このパスはありません。');
    } catch (e) {
      return sendError(res, 500, 'internal', e instanceof Error ? e.message : String(e));
    }
  });
}

// 直接実行したときだけ待ち受ける（テストからは createMockApi を import して使う）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.MOCK_API_PORT ?? 8599);
  // 既定は自分の Mac だけ。コンテナから host.docker.internal で呼ぶ確認のときだけ MOCK_API_HOST=0.0.0.0
  const host = process.env.MOCK_API_HOST ?? '127.0.0.1';
  const runKind = process.env.MOCK_RUN_KIND === 'real' ? 'real' : 'synthetic';
  const server = createMockApi({ runKind });
  server.listen(port, host, () => {
    console.log(`mock-api: http://${host}:${port}/api/health （run.kind=${runKind}）`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
