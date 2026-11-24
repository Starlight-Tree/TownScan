// API の型（docs/spec-prototype.md §4.4・§4.5 が契約）。仕様を変えるときは先に仕様を直す。
// 注意: dev/check-api.mjs が Node の型除去で直接読み込むため、enum・namespace などの「消せない構文」は使わない。

export const CANDIDATE_CLASSES = ['confirmed_new', 'existing_omission', 'uncertain'] as const;
export type CandidateClass = (typeof CANDIDATE_CLASSES)[number];

export const CANDIDATE_REASONS = ['new_absent_2018', 'present_2018', 'ambiguous', 'edge', 'small'] as const;
export type CandidateReason = (typeof CANDIDATE_REASONS)[number];

export type BBox = [west: number, south: number, east: number, north: number];
export type LonLat = [lon: number, lat: number];
export type RunKind = 'real' | 'synthetic';

// ---- /api/health ----

export interface RunInfo {
  run_id: string;
  kind: RunKind;
  created_at: string;
}

export interface HealthResponse {
  status: string;
  db: string;
  llm: string;
  run: RunInfo | null;
  counts: { areas: number; candidates: number; buildings: number };
}

// ---- /api/areas ----

export interface ClassCounts {
  confirmed_new: number;
  existing_omission: number;
  uncertain: number;
  total: number;
}

export interface AreaSummary {
  id: string;
  name: string;
  ward: string;
  bbox: BBox;
  centroid: LonLat;
  counts: ClassCounts;
}

// ---- /api/candidates ----

export interface CandidateSummary {
  id: string;
  area_id: string;
  class: CandidateClass;
  area_m2: number;
  bbox: BBox;
  centroid: LonLat;
  reason?: CandidateReason;
  /** 実 API は地区名も一緒に返す（仕様には無い追加。無くても動く） */
  area_name?: string;
  ward?: string;
}

export interface CandidateList {
  total: number;
  items: CandidateSummary[];
}

export interface CandidateEvidence {
  prob_2023_mean: number;
  ov_2018: number;
  prob_2018_p90: number;
  ov_kiban: number;
  edge_touch: boolean;
}

export interface Provenance {
  source: string;
  photo_years: number[];
  model: string;
  metric?: string;
  run_id: string;
  run_kind: RunKind;
  note?: string;
}

export interface CandidateImage {
  year: number;
  url: string;
}

export interface CandidateDetail extends CandidateSummary {
  reason: CandidateReason;
  evidence: CandidateEvidence;
  /** 説明文のキー。画面側が文言を持つ（未知のキーは分類の説明で代える） */
  explanation_key?: string;
  /** 実 API が説明文も返すとき（仕様には無い追加）。画面が文言を持たないキーのときの代わりに使う */
  explanation?: string;
  images: CandidateImage[];
  provenance: Provenance;
}

// ---- /api/candidates.geojson ----

export interface CandidateGeometry {
  type: 'Polygon' | 'MultiPolygon';
  // Polygon: [ring][point][lon,lat] / MultiPolygon: [polygon][ring][point][lon,lat]
  coordinates: number[][][] | number[][][][];
}

export interface CandidateFeatureProperties {
  id: string;
  class: CandidateClass;
  area_m2: number;
  area_id: string;
}

export interface CandidateFeature {
  type: 'Feature';
  id?: string;
  geometry: CandidateGeometry;
  properties: CandidateFeatureProperties;
}

export interface CandidateFeatureCollection {
  type: 'FeatureCollection';
  features: CandidateFeature[];
}

// ---- /api/metrics（eval.json の内容 + provenance。pipeline が細部を決めるため、数値の入れ物は緩く持つ） ----

export type MetricBlock = Record<string, number | null | undefined>;

export interface SplitMetrics {
  pixel?: MetricBlock;
  object?: MetricBlock;
  [key: string]: unknown;
}

export interface MetricsResponse {
  reference?: string;
  split?: { tune?: string[]; holdout?: string[] };
  sweep?: Array<Record<string, number | null | undefined>>;
  chosen?: { scale?: number; threshold?: number; selected_by?: string };
  holdout?: SplitMetrics;
  tune?: SplitMetrics;
  per_area?: Array<Record<string, unknown>>;
  excluded_edge_objects?: number | Record<string, number> | null;
  /**
   * 任意項目（pipeline が足した。仕様 §6）。無くても動く。形は画面側（lib/accuracy.ts）が確かめて読む。
   * protocol: {year, compare_year, edge_overlap_min, ...} / year_compare: 比べる年の写真での指標 /
   * existing_absent_in_2018: 既存の建物のうち 2018 年の抽出が何も見ていない棟の割合 /
   * excluded_edge_by_split・excluded_edge_detail: 縁で外した数の区分別・内訳
   */
  protocol?: unknown;
  year_compare?: unknown;
  existing_absent_in_2018?: unknown;
  excluded_edge_by_split?: unknown;
  excluded_edge_detail?: unknown;
  /** 手ラベルが無いので null（画面は「未測定」と出す） */
  new_building_recall: number | null;
  notes?: string[];
  provenance?: Partial<Provenance>;
  [key: string]: unknown;
}

// ---- /api/chat ----

export interface ChatRequestMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export type TableCell = string | number | boolean | null;
export type TableRow = { id?: string } & Record<string, TableCell | undefined>;

export interface CountResult {
  type: 'count';
  title: string;
  total: number;
  breakdown: Array<{ key: string; label: string; value: number }>;
  filter: { area_id?: string | null; cls?: CandidateClass | null };
  provenance: Provenance;
}

export interface TableResult {
  type: 'table';
  title: string;
  columns: Array<{ key: string; label: string }>;
  rows: TableRow[];
  total: number;
  shown: number;
  provenance: Provenance;
}

export interface CompareResult {
  type: 'compare';
  title: string;
  items: Array<{ area_id: string; name: string; counts: Record<string, number> }>;
  provenance: Provenance;
}

export interface MapFocusResult {
  type: 'map_focus';
  title: string;
  bbox: BBox;
  candidate_ids: string[];
  provenance: Provenance;
}

export interface DetectionImageResult {
  type: 'detection_image';
  title: string;
  candidate_id: string;
  class: CandidateClass;
  images: CandidateImage[];
  caption: string;
  provenance: Provenance;
}

export interface AccuracyResult {
  type: 'accuracy';
  title: string;
  metrics: Array<{ key: string; label: string; value: number | null; note: string }>;
  provenance: Provenance;
}

export const REFUSAL_REASONS = ['out_of_scope', 'no_photo_period', 'not_implemented', 'no_data'] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

export interface RefusalResult {
  type: 'refusal';
  reason: RefusalReason;
  message: string;
  suggestions: string[];
}

export type ToolResult =
  | CountResult
  | TableResult
  | CompareResult
  | MapFocusResult
  | DetectionImageResult
  | AccuracyResult
  | RefusalResult;

export type ToolResultType = ToolResult['type'];

/** 型ごとの表示名。Record にしてあるので、型を足して表示名を忘れるとコンパイルが通らない */
export const TOOL_RESULT_LABELS: Record<ToolResultType, string> = {
  count: '件数',
  table: '一覧',
  compare: '地区の比較',
  map_focus: '地図の表示',
  detection_image: '検出画像',
  accuracy: '精度',
  refusal: 'お断り',
};

export const TOOL_RESULT_TYPES = Object.keys(TOOL_RESULT_LABELS) as ToolResultType[];

export interface AssistantMessage {
  role: 'assistant';
  content: string;
  results: ToolResult[];
  tool_calls: ToolCall[];
}

export interface ChatResponse {
  message: AssistantMessage;
}

// ---- エラー ----

export interface ApiErrorBody {
  error: { code: string; message: string };
}
