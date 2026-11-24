import { describe, expect, it } from 'vitest';
import type { CandidateGeometry } from './api-types';
import {
  ATTRIBUTION,
  BASE_LAYERS,
  BASE_LAYER_ORDER,
  BLANK_TILE,
  areasBBox,
  geometryBBox,
  nextNonce,
  toLatLngs,
  unionBBox,
} from './map-config';
import { areas } from '../tests/fixtures';

describe('地図の設定', () => {
  it('地理院タイルを直接読む（標準地図・2018・2023 年の写真）', () => {
    expect(BASE_LAYERS.std.url).toBe('https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png');
    expect(BASE_LAYERS.photo2018.url).toContain('/nendophoto2018/');
    expect(BASE_LAYERS.photo2023.url).toContain('/nendophoto2023/');
    expect([...BASE_LAYER_ORDER].sort()).toEqual(['photo2018', 'photo2023', 'std']);
  });

  it('出典（国土地理院）を必ず表示する文言を持つ', () => {
    expect(ATTRIBUTION).toContain('国土地理院');
    expect(ATTRIBUTION).toContain('地理院タイル');
  });

  it('タイルが 404 のとき用の空の PNG', () => {
    expect(BLANK_TILE.startsWith('data:image/png;base64,')).toBe(true);
    const bytes = Buffer.from(BLANK_TILE.split(',')[1]!, 'base64');
    expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
  });

  it('nextNonce は増え続ける（同じ操作を続けても地図が動く）', () => {
    const a = nextNonce();
    expect(nextNonce()).toBeGreaterThan(a);
  });
});

describe('幾何', () => {
  const polygon: CandidateGeometry = {
    type: 'Polygon',
    coordinates: [
      [
        [130.1, 32.1],
        [130.3, 32.1],
        [130.3, 32.4],
        [130.1, 32.4],
        [130.1, 32.1],
      ],
    ],
  };

  it('geometryBBox: Polygon と MultiPolygon の外接矩形', () => {
    expect(geometryBBox(polygon)).toEqual([130.1, 32.1, 130.3, 32.4]);
    const multi: CandidateGeometry = { type: 'MultiPolygon', coordinates: [polygon.coordinates as number[][][], [[[131, 33], [131.5, 33], [131.5, 33.5], [131, 33]]]] };
    expect(geometryBBox(multi)).toEqual([130.1, 32.1, 131.5, 33.5]);
    expect(geometryBBox({ type: 'Polygon', coordinates: [] })).toBeNull();
  });

  it('toLatLngs: [lon,lat] を Leaflet の [lat,lon] へ入れ替える', () => {
    expect((toLatLngs(polygon) as number[][][])[0]![0]).toEqual([32.1, 130.1]);
    const multi: CandidateGeometry = { type: 'MultiPolygon', coordinates: [polygon.coordinates as number[][][]] };
    expect((toLatLngs(multi) as number[][][][])[0]![0]![1]).toEqual([32.1, 130.3]);
  });

  it('unionBBox / areasBBox', () => {
    expect(unionBBox([])).toBeNull();
    expect(unionBBox([[0, 0, 1, 1], [2, -1, 3, 0.5]])).toEqual([0, -1, 3, 1]);
    expect(areasBBox(areas)).toEqual(areas[0]!.bbox);
  });
});
