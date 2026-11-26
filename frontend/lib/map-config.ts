import type { BBox, CandidateFeature, CandidateGeometry, AreaSummary } from './api-types';
import { formatNumber } from './format';

// 地図タイルは、仕様 §7 のとおり配信元（フランス国土地理院 IGN の公開タイル配信）から直接読む（API の呼び出しではないので、同じオリジンの縛りの外）。
const IGN_WMTS = 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&STYLE=normal';
const ignUrl = (layer: string, matrixSet: string, format: string) =>
  `${IGN_WMTS}&LAYER=${layer}&FORMAT=${format}&TILEMATRIXSET=${matrixSet}&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}`;

export type BaseLayerId = 'std' | 'photo2014' | 'photo2024';

export interface BaseLayerDef {
  id: BaseLayerId;
  label: string;
  /** 写真のレイヤーは、標準地図の上に重ねる（写真が無い範囲でも地図が崩れず、地名が読める） */
  photo: boolean;
  year?: number;
  url: string;
  maxNativeZoom: number;
}

export const BASE_LAYERS: Record<BaseLayerId, BaseLayerDef> = {
  std: { id: 'std', label: '標準地図', photo: false, url: ignUrl('GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2', 'PM_0_19', 'image/png'), maxNativeZoom: 19 },
  photo2014: {
    id: 'photo2014',
    label: '2014 年の写真',
    photo: true,
    year: 2014,
    url: ignUrl('ORTHOIMAGERY.ORTHOPHOTOS2014', 'PM_0_18', 'image/jpeg'),
    maxNativeZoom: 18,
  },
  photo2024: {
    id: 'photo2024',
    label: '2024 年の写真',
    photo: true,
    year: 2024,
    url: ignUrl('ORTHOIMAGERY.ORTHOPHOTOS2024', 'PM_6_19', 'image/jpeg'),
    maxNativeZoom: 19,
  },
};

export const BASE_LAYER_ORDER: BaseLayerId[] = ['photo2024', 'photo2014', 'std'];

/** 写真のタイルが、いま見えている範囲に届いたか。ok=すべて、partial=一部は標準地図、none=1 枚も無い */
export type TileStatus = 'ok' | 'partial' | 'none';

/**
 * 地図の下の「現在表示」の文。選んだ地図の種類（base）と、実際に見えているもの（タイルの有無）を区別して言う。
 * candidateCount が null のときは、候補がまだ地図に出ていない（読み込み中・失敗）
 */
export function displayStatusText(base: BaseLayerId, tile: TileStatus, candidateCount: number | null): string {
  const def = BASE_LAYERS[base];
  const std = BASE_LAYERS.std.label;
  let map = def.label;
  if (def.photo && tile === 'partial') map = `${def.label}（一部は${std}）`;
  if (def.photo && tile === 'none') map = `${std}（この範囲には ${def.label}がありません）`;
  const cands = candidateCount === null ? '候補はまだ表示できていません' : `候補 ${formatNumber(candidateCount)} 件`;
  return `表示中: ${map}・${cands}`;
}

export const STD_URL = BASE_LAYERS.std.url;

export const ATTRIBUTION =
  '出典：<a href="https://cartes.gouv.fr/cgu/" target="_blank" rel="noopener noreferrer">IGN（フランス国土地理院）</a>';

/** 404 のタイルに出す透明な 1×1 PNG（壊れた画像のアイコンを出さない） */
export const BLANK_TILE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=';

export const DEFAULT_CENTER: [number, number] = [48.8376, 2.2474]; // パリ南西の近郊（緯度, 経度）
export const DEFAULT_ZOOM = 12;
export const MIN_ZOOM = 10;
export const MAX_ZOOM = 20;
/** このズーム以上で候補を形（ポリゴン）で描く。未満は印（点）。z17 は約 1 m/px */
export const POLYGON_MIN_ZOOM = 17;

let nonceCounter = 0;
export const nextNonce = () => ++nonceCounter;

// ---- 地図の操作要求 ----

/**
 * 地図を動かす要求（bbox へ寄せる）。nonce が変わるたびに 1 回だけ動かす。
 * 詳細は地図に重ならない（結果領域の別の画面に出る）ので、寄せるときに右端をあける欄（padRight）は持たない。
 * 動かし方は 1 通りだけなので、種類を表す欄（kind）も持たない。
 */
export type MapFocus = { bbox: BBox; ids: string[]; nonce: number };

// ---- 地図の上に重ねる部品の下に隠れる印を、上へ寄せる ----

/** 地図の枠の左上を原点にした、長方形（ピクセル） */
export interface PixelBox {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * 地図の上に重ねた部品（選択中の候補のカード。cover）の下に、印・形（target）が隠れるとき、地図を上へ寄せる量（ピクセル）。隠れなければ 0。
 * カードの横にある印・上にある印は、隠れていないので動かさない（利用者が動かした地図を、無駄に引き戻さない）。
 * 寄せたあと、印の下端がカードの上端から gap だけ離れるようにする。ただし、印の上端が地図の枠の上端より上へ出るほどは寄せない。
 */
export function shiftAboveCover(target: PixelBox, cover: PixelBox, gap: number): number {
  const overlapsX = target.right > cover.left && target.left < cover.right;
  const overlapsY = target.bottom > cover.top && target.top < cover.bottom;
  if (!overlapsX || !overlapsY) return 0;
  return Math.max(0, Math.min(target.bottom + gap - cover.top, target.top - gap));
}

/** 利用者が「動きを減らす」設定にしているか（OS の prefers-reduced-motion）。matchMedia が無い環境では false */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// ---- 幾何 ----

function eachPoint(coords: unknown, fn: (lon: number, lat: number) => void): void {
  if (!Array.isArray(coords)) return;
  if (coords.length >= 2 && typeof coords[0] === 'number' && typeof coords[1] === 'number') {
    fn(coords[0], coords[1]);
    return;
  }
  for (const c of coords) eachPoint(c, fn);
}

export function geometryBBox(geometry: CandidateGeometry): BBox | null {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  eachPoint(geometry.coordinates, (lon, lat) => {
    w = Math.min(w, lon);
    e = Math.max(e, lon);
    s = Math.min(s, lat);
    n = Math.max(n, lat);
  });
  return Number.isFinite(w) ? [w, s, e, n] : null;
}

export function featureBBox(feature: CandidateFeature): BBox | null {
  return geometryBBox(feature.geometry);
}

export function unionBBox(boxes: BBox[]): BBox | null {
  if (boxes.length === 0) return null;
  return [
    Math.min(...boxes.map((b) => b[0])),
    Math.min(...boxes.map((b) => b[1])),
    Math.max(...boxes.map((b) => b[2])),
    Math.max(...boxes.map((b) => b[3])),
  ];
}

export function areasBBox(areas: AreaSummary[]): BBox | null {
  return unionBBox(areas.map((a) => a.bbox));
}

/**
 * 絞り込みの対象の地区（scope。全地区なら null）が収まる範囲。全地区なら全地区の和。
 * 対象の地区が一覧に 1 つも無い（一覧がまだ届いていない・知らない地区）ときは null
 */
export function scopeBBox(areas: AreaSummary[], scope: ReadonlySet<string> | null): BBox | null {
  return unionBBox(areas.filter((a) => scope === null || scope.has(a.id)).map((a) => a.bbox));
}

/** GeoJSON の [lon,lat] を Leaflet の [lat,lon] へ（Polygon・MultiPolygon） */
export function toLatLngs(geometry: CandidateGeometry): number[][][] | number[][][][] {
  const swap = (ring: number[][]) => ring.map(([lon, lat]) => [lat, lon] as number[]);
  if (geometry.type === 'MultiPolygon') {
    return (geometry.coordinates as number[][][][]).map((poly) => poly.map(swap));
  }
  return (geometry.coordinates as number[][][]).map(swap);
}
