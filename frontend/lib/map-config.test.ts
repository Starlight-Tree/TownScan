import { describe, expect, it } from 'vitest';
import type { CandidateGeometry } from './api-types';
import {
  ATTRIBUTION,
  BASE_LAYERS,
  BASE_LAYER_ORDER,
  BLANK_TILE,
  areasBBox,
  displayStatusText,
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

describe('areasBBox（全地区の枠の和。初回の表示範囲）', () => {
  const box = (w: number, s: number, e: number, n: number): [number, number, number, number] => [w, s, e, n];

  it('地区が 0 件なら null（いまの表示のまま）', () => {
    expect(areasBBox([])).toBeNull();
  });

  it('複数の地区の枠をすべて含む外接矩形を返す。順序に依らない', () => {
    const list = [
      { ...areas[0]!, id: 'a', bbox: box(130.70, 32.80, 130.71, 32.81) },
      { ...areas[0]!, id: 'b', bbox: box(130.65, 32.83, 130.68, 32.85) },
      { ...areas[0]!, id: 'c', bbox: box(130.72, 32.78, 130.75, 32.79) },
    ];
    expect(areasBBox(list)).toEqual([130.65, 32.78, 130.75, 32.85]);
    expect(areasBBox([...list].reverse())).toEqual([130.65, 32.78, 130.75, 32.85]);
  });
});

describe('displayStatusText（地図の下の「現在表示」）', () => {
  it('写真がそろっているとき: 選んだ種類と候補の件数', () => {
    expect(displayStatusText('photo2023', 'ok', 18)).toBe('表示中: 2023 年の写真・候補 18 件');
    expect(displayStatusText('photo2018', 'ok', 0)).toBe('表示中: 2018 年の写真・候補 0 件');
  });

  it('写真が一部しか無いとき: 見えているのは一部が標準地図', () => {
    expect(displayStatusText('photo2023', 'partial', 18)).toBe('表示中: 2023 年の写真（一部は標準地図）・候補 18 件');
  });

  it('写真がまったく無いとき: 選んだ種類ではなく、実際に見えている標準地図を言い、理由を添える', () => {
    expect(displayStatusText('photo2023', 'none', 18)).toBe('表示中: 標準地図（この範囲には 2023 年の写真がありません）・候補 18 件');
    expect(displayStatusText('photo2018', 'none', 1)).toBe('表示中: 標準地図（この範囲には 2018 年の写真がありません）・候補 1 件');
  });

  it('標準地図を選んでいるとき: タイルの状態は関係ない', () => {
    for (const tile of ['ok', 'partial', 'none'] as const) {
      expect(displayStatusText('std', tile, 5)).toBe('表示中: 標準地図・候補 5 件');
    }
  });

  it('件数は千の区切り。候補が届いていない（null）ときは、0 件と言わない', () => {
    expect(displayStatusText('std', 'ok', 1234)).toBe('表示中: 標準地図・候補 1,234 件');
    expect(displayStatusText('photo2023', 'ok', null)).toBe('表示中: 2023 年の写真・候補はまだ表示できていません');
  });
});
