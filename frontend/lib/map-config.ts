import type { BBox, CandidateFeature, CandidateGeometry, AreaSummary } from './api-types';

// 地図タイルは、仕様 §7 のとおり地理院から直接読む（API の呼び出しではないので、同じオリジンの縛りの外）。
const GSI_XYZ = 'https://cyberjapandata.gsi.go.jp/xyz';

export type BaseLayerId = 'std' | 'photo2018' | 'photo2023';

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
  std: { id: 'std', label: '標準地図', photo: false, url: `${GSI_XYZ}/std/{z}/{x}/{y}.png`, maxNativeZoom: 18 },
  photo2018: {
    id: 'photo2018',
    label: '2018 年の写真',
    photo: true,
    year: 2018,
    url: `${GSI_XYZ}/nendophoto2018/{z}/{x}/{y}.png`,
    maxNativeZoom: 18,
  },
  photo2023: {
    id: 'photo2023',
    label: '2023 年の写真',
    photo: true,
    year: 2023,
    url: `${GSI_XYZ}/nendophoto2023/{z}/{x}/{y}.png`,
    maxNativeZoom: 18,
  },
};

export const BASE_LAYER_ORDER: BaseLayerId[] = ['photo2023', 'photo2018', 'std'];

export const STD_URL = BASE_LAYERS.std.url;

export const ATTRIBUTION =
  '出典：<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener noreferrer">国土地理院（地理院タイル）</a>';

/** 404 のタイルに出す透明な 1×1 PNG（壊れた画像のアイコンを出さない） */
export const BLANK_TILE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=';

export const DEFAULT_CENTER: [number, number] = [32.8032, 130.7417]; // 熊本市中心部（緯度, 経度）
export const DEFAULT_ZOOM = 14;
export const MIN_ZOOM = 10;
export const MAX_ZOOM = 20;
/** このズーム以上で候補を形（ポリゴン）で描く。未満は印（点）。z17 は約 1 m/px */
export const POLYGON_MIN_ZOOM = 17;

let nonceCounter = 0;
export const nextNonce = () => ++nonceCounter;

// ---- 地図の操作要求 ----

export type MapFocus =
  | { kind: 'fit'; bbox: BBox; ids: string[]; padRight: number; nonce: number }
  | { kind: 'reveal'; point: [lon: number, lat: number]; padRight: number; nonce: number };

/** ドロワーが地図の右側をふさぐ幅（広い画面だけ） */
export const DRAWER_WIDTH = 440;
export const WIDE_MIN_WIDTH = 900;

export function drawerPad(): number {
  return typeof window !== 'undefined' && window.innerWidth >= WIDE_MIN_WIDTH ? DRAWER_WIDTH : 0;
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

/** GeoJSON の [lon,lat] を Leaflet の [lat,lon] へ（Polygon・MultiPolygon） */
export function toLatLngs(geometry: CandidateGeometry): number[][][] | number[][][][] {
  const swap = (ring: number[][]) => ring.map(([lon, lat]) => [lat, lon] as number[]);
  if (geometry.type === 'MultiPolygon') {
    return (geometry.coordinates as number[][][][]).map((poly) => poly.map(swap));
  }
  return (geometry.coordinates as number[][][]).map(swap);
}
