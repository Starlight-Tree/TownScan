// 契約（api-types.ts）に API の応答が合っているかを、実行時に調べる検査。
// 使い道: ① モック API と型の整合のテスト ② dev/check-api.mjs で、動いている実 API を同じ物差しで調べる。
// 画面の描画には使わない（画面は、形が少し違っても壊れないように別に守っている）。
// 注意: Node の型除去で直接読み込めるよう、enum・namespace などの消せない構文は使わない。
import { CANDIDATE_CLASSES, CANDIDATE_REASONS, REFUSAL_REASONS, TOOL_RESULT_TYPES } from './api-types.ts';
import type { ToolResultType } from './api-types.ts';

export type Problems = string[];

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

function str(o: Obj, key: string, path: string, out: Problems) {
  if (!isStr(o[key])) out.push(`${path}.${key}: 文字列ではありません（${JSON.stringify(o[key])}）`);
}

function num(o: Obj, key: string, path: string, out: Problems) {
  if (!isNum(o[key])) out.push(`${path}.${key}: 数ではありません（${JSON.stringify(o[key])}）`);
}

function oneOf(o: Obj, key: string, allowed: readonly string[], path: string, out: Problems) {
  if (!isStr(o[key]) || !allowed.includes(o[key])) out.push(`${path}.${key}: ${allowed.join('|')} のどれかではありません（${JSON.stringify(o[key])}）`);
}

function tuple(v: unknown, n: number, path: string, out: Problems) {
  if (!Array.isArray(v) || v.length !== n || !v.every(isNum)) out.push(`${path}: 数が ${n} 個の配列ではありません`);
}

function arr(o: Obj, key: string, path: string, out: Problems): unknown[] {
  const v = o[key];
  if (!Array.isArray(v)) {
    out.push(`${path}.${key}: 配列ではありません`);
    return [];
  }
  return v;
}

export function checkProvenance(v: unknown, path = 'provenance'): Problems {
  const out: Problems = [];
  if (!isObj(v)) return [`${path}: オブジェクトではありません`];
  str(v, 'source', path, out);
  str(v, 'model', path, out);
  str(v, 'run_id', path, out);
  oneOf(v, 'run_kind', ['real', 'synthetic'], path, out);
  if (!Array.isArray(v.photo_years) || !v.photo_years.every(isNum)) out.push(`${path}.photo_years: 数の配列ではありません`);
  if (v.metric !== undefined && !isStr(v.metric)) out.push(`${path}.metric: 文字列ではありません`);
  if (v.note !== undefined && !isStr(v.note)) out.push(`${path}.note: 文字列ではありません`);
  return out;
}

export function checkHealth(v: unknown): Problems {
  const out: Problems = [];
  if (!isObj(v)) return ['health: オブジェクトではありません'];
  str(v, 'status', 'health', out);
  str(v, 'db', 'health', out);
  str(v, 'llm', 'health', out);
  if (v.run !== null) {
    if (!isObj(v.run)) out.push('health.run: オブジェクトか null ではありません');
    else {
      str(v.run, 'run_id', 'health.run', out);
      oneOf(v.run, 'kind', ['real', 'synthetic'], 'health.run', out);
      str(v.run, 'created_at', 'health.run', out);
    }
  }
  if (!isObj(v.counts)) out.push('health.counts: オブジェクトではありません');
  else for (const k of ['areas', 'candidates', 'buildings']) num(v.counts, k, 'health.counts', out);
  return out;
}

export function checkArea(v: unknown, path = 'area'): Problems {
  const out: Problems = [];
  if (!isObj(v)) return [`${path}: オブジェクトではありません`];
  for (const k of ['id', 'name', 'ward']) str(v, k, path, out);
  tuple(v.bbox, 4, `${path}.bbox`, out);
  tuple(v.centroid, 2, `${path}.centroid`, out);
  if (!isObj(v.counts)) out.push(`${path}.counts: オブジェクトではありません`);
  else for (const k of [...CANDIDATE_CLASSES, 'total']) num(v.counts, k, `${path}.counts`, out);
  return out;
}

/** /api/areas は、配列でも {items: [...]} でもよいことにしている（仕様に形の指定が無いため） */
export function checkAreaList(v: unknown): Problems {
  const list = Array.isArray(v) ? v : isObj(v) && Array.isArray(v.items) ? v.items : null;
  if (!list) return ['areas: 配列か {items: 配列} ではありません'];
  return list.flatMap((a, i) => checkArea(a, `areas[${i}]`));
}

export function checkCandidateSummary(v: unknown, path = 'candidate'): Problems {
  const out: Problems = [];
  if (!isObj(v)) return [`${path}: オブジェクトではありません`];
  str(v, 'id', path, out);
  str(v, 'area_id', path, out);
  oneOf(v, 'class', CANDIDATE_CLASSES, path, out);
  num(v, 'area_m2', path, out);
  tuple(v.bbox, 4, `${path}.bbox`, out);
  tuple(v.centroid, 2, `${path}.centroid`, out);
  if (v.reason !== undefined) oneOf(v, 'reason', CANDIDATE_REASONS, path, out);
  return out;
}

export function checkCandidateList(v: unknown): Problems {
  if (!isObj(v)) return ['candidates: オブジェクトではありません'];
  const out: Problems = [];
  num(v, 'total', 'candidates', out);
  arr(v, 'items', 'candidates', out).forEach((c, i) => out.push(...checkCandidateSummary(c, `candidates.items[${i}]`)));
  return out;
}

export function checkCandidateDetail(v: unknown): Problems {
  const out = checkCandidateSummary(v, 'detail');
  if (!isObj(v)) return out;
  oneOf(v, 'reason', CANDIDATE_REASONS, 'detail', out);
  if (!isObj(v.evidence)) out.push('detail.evidence: オブジェクトではありません');
  else {
    for (const k of ['prob_2023_mean', 'ov_2018', 'prob_2018_p90', 'ov_kiban']) num(v.evidence, k, 'detail.evidence', out);
    if (typeof v.evidence.edge_touch !== 'boolean') out.push('detail.evidence.edge_touch: 真偽値ではありません');
  }
  arr(v, 'images', 'detail', out).forEach((img, i) => {
    if (!isObj(img)) return out.push(`detail.images[${i}]: オブジェクトではありません`);
    num(img, 'year', `detail.images[${i}]`, out);
    str(img, 'url', `detail.images[${i}]`, out);
  });
  out.push(...checkProvenance(v.provenance, 'detail.provenance'));
  return out;
}

export function checkFeatureCollection(v: unknown): Problems {
  if (!isObj(v) || v.type !== 'FeatureCollection') return ['geojson: FeatureCollection ではありません'];
  const out: Problems = [];
  arr(v, 'features', 'geojson', out).forEach((f, i) => {
    const p = `geojson.features[${i}]`;
    if (!isObj(f) || f.type !== 'Feature') return out.push(`${p}: Feature ではありません`);
    if (!isObj(f.geometry) || !['Polygon', 'MultiPolygon'].includes(String(f.geometry.type))) out.push(`${p}.geometry: Polygon か MultiPolygon ではありません`);
    if (!isObj(f.properties)) return out.push(`${p}.properties: オブジェクトではありません`);
    str(f.properties, 'id', `${p}.properties`, out);
    str(f.properties, 'area_id', `${p}.properties`, out);
    oneOf(f.properties, 'class', CANDIDATE_CLASSES, `${p}.properties`, out);
    num(f.properties, 'area_m2', `${p}.properties`, out);
  });
  return out;
}

export function checkMetrics(v: unknown): Problems {
  if (!isObj(v)) return ['metrics: オブジェクトではありません'];
  const out: Problems = [];
  if (!('new_building_recall' in v)) out.push('metrics.new_building_recall: ありません（手ラベルが無いうちは null）');
  else if (v.new_building_recall !== null && !isNum(v.new_building_recall)) out.push('metrics.new_building_recall: 数か null ではありません');
  for (const k of ['holdout', 'tune']) {
    if (v[k] !== undefined && !isObj(v[k])) out.push(`metrics.${k}: オブジェクトではありません`);
  }
  if (v.provenance !== undefined && !isObj(v.provenance)) out.push('metrics.provenance: オブジェクトではありません');
  return out;
}

// ---- チャットのツール結果 ----

function checkToolResultByType(r: Obj, type: ToolResultType, p: string): Problems {
  const out: Problems = [];
  switch (type) {
    case 'count':
      str(r, 'title', p, out);
      num(r, 'total', p, out);
      arr(r, 'breakdown', p, out).forEach((b, i) => {
        if (!isObj(b)) return out.push(`${p}.breakdown[${i}]: オブジェクトではありません`);
        str(b, 'key', `${p}.breakdown[${i}]`, out);
        str(b, 'label', `${p}.breakdown[${i}]`, out);
        num(b, 'value', `${p}.breakdown[${i}]`, out);
      });
      if (!isObj(r.filter)) out.push(`${p}.filter: オブジェクトではありません`);
      out.push(...checkProvenance(r.provenance, `${p}.provenance`));
      return out;
    case 'table':
      str(r, 'title', p, out);
      num(r, 'total', p, out);
      num(r, 'shown', p, out);
      arr(r, 'columns', p, out).forEach((c, i) => {
        if (!isObj(c)) return out.push(`${p}.columns[${i}]: オブジェクトではありません`);
        str(c, 'key', `${p}.columns[${i}]`, out);
        str(c, 'label', `${p}.columns[${i}]`, out);
      });
      arr(r, 'rows', p, out).forEach((row, i) => {
        if (!isObj(row)) out.push(`${p}.rows[${i}]: オブジェクトではありません`);
      });
      out.push(...checkProvenance(r.provenance, `${p}.provenance`));
      return out;
    case 'compare':
      str(r, 'title', p, out);
      arr(r, 'items', p, out).forEach((it, i) => {
        if (!isObj(it)) return out.push(`${p}.items[${i}]: オブジェクトではありません`);
        str(it, 'area_id', `${p}.items[${i}]`, out);
        str(it, 'name', `${p}.items[${i}]`, out);
        if (!isObj(it.counts)) out.push(`${p}.items[${i}].counts: オブジェクトではありません`);
        else if (!Object.values(it.counts).every(isNum)) out.push(`${p}.items[${i}].counts: 数だけにしてください`);
      });
      out.push(...checkProvenance(r.provenance, `${p}.provenance`));
      return out;
    case 'map_focus':
      str(r, 'title', p, out);
      tuple(r.bbox, 4, `${p}.bbox`, out);
      if (!Array.isArray(r.candidate_ids) || !r.candidate_ids.every(isStr)) out.push(`${p}.candidate_ids: 文字列の配列ではありません`);
      out.push(...checkProvenance(r.provenance, `${p}.provenance`));
      return out;
    case 'detection_image':
      str(r, 'title', p, out);
      str(r, 'candidate_id', p, out);
      oneOf(r, 'class', CANDIDATE_CLASSES, p, out);
      str(r, 'caption', p, out);
      arr(r, 'images', p, out).forEach((img, i) => {
        if (!isObj(img)) return out.push(`${p}.images[${i}]: オブジェクトではありません`);
        num(img, 'year', `${p}.images[${i}]`, out);
        str(img, 'url', `${p}.images[${i}]`, out);
      });
      out.push(...checkProvenance(r.provenance, `${p}.provenance`));
      return out;
    case 'accuracy':
      str(r, 'title', p, out);
      arr(r, 'metrics', p, out).forEach((m, i) => {
        if (!isObj(m)) return out.push(`${p}.metrics[${i}]: オブジェクトではありません`);
        str(m, 'key', `${p}.metrics[${i}]`, out);
        str(m, 'label', `${p}.metrics[${i}]`, out);
        str(m, 'note', `${p}.metrics[${i}]`, out);
        if (m.value !== null && !isNum(m.value)) out.push(`${p}.metrics[${i}].value: 数か null ではありません`);
      });
      out.push(...checkProvenance(r.provenance, `${p}.provenance`));
      return out;
    case 'refusal':
      oneOf(r, 'reason', REFUSAL_REASONS, p, out);
      str(r, 'message', p, out);
      if (!Array.isArray(r.suggestions) || !r.suggestions.every(isStr)) out.push(`${p}.suggestions: 文字列の配列ではありません`);
      return out;
    default: {
      // 型を足して検査を足し忘れると、ここでコンパイルが通らない
      const unreachable: never = type;
      return [`${p}: 未対応の type（${String(unreachable)}）`];
    }
  }
}

export function checkToolResult(v: unknown, path = 'result'): Problems {
  if (!isObj(v)) return [`${path}: オブジェクトではありません`];
  const type = v.type;
  if (!isStr(type) || !(TOOL_RESULT_TYPES as string[]).includes(type)) return [`${path}.type: 未知の type（${JSON.stringify(type)}）`];
  return checkToolResultByType(v, type as ToolResultType, path);
}

export function checkChatResponse(v: unknown): Problems {
  if (!isObj(v) || !isObj(v.message)) return ['chat: {message: {...}} ではありません'];
  const m = v.message;
  const out: Problems = [];
  if (m.role !== 'assistant') out.push('chat.message.role: assistant ではありません');
  str(m, 'content', 'chat.message', out);
  arr(m, 'results', 'chat.message', out).forEach((r, i) => out.push(...checkToolResult(r, `chat.message.results[${i}]`)));
  arr(m, 'tool_calls', 'chat.message', out).forEach((c, i) => {
    if (!isObj(c)) return out.push(`chat.message.tool_calls[${i}]: オブジェクトではありません`);
    str(c, 'name', `chat.message.tool_calls[${i}]`, out);
    if (!isObj(c.args)) out.push(`chat.message.tool_calls[${i}].args: オブジェクトではありません`);
  });
  return out;
}

export function checkErrorBody(v: unknown): Problems {
  if (!isObj(v) || !isObj(v.error)) return ['error: {error: {code, message}} ではありません'];
  const out: Problems = [];
  str(v.error, 'code', 'error', out);
  str(v.error, 'message', 'error', out);
  return out;
}
