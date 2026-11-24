import { act, fireEvent, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CandidateFeature } from '../../lib/api-types';
import { areas } from '../../tests/fixtures';
import { nextNonce } from '../../lib/map-config';
import LeafletMap, { type LeafletMapProps } from './LeafletMap';

// jsdom には大きさが無い。Leaflet が割り算で壊れないよう、地図の大きさを与える
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 600 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function feature(id: string, cls: CandidateFeature['properties']['class'], dx: number): CandidateFeature {
  const lon = 130.7 + dx;
  return {
    type: 'Feature',
    id,
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [lon, 32.8],
          [lon + 0.0001, 32.8],
          [lon + 0.0001, 32.8001],
          [lon, 32.8001],
          [lon, 32.8],
        ],
      ],
    },
    properties: { id, class: cls, area_m2: 50, area_id: 'z18-1-2' },
  };
}

// 広い範囲に収めると縮尺が小さく（z17 未満）なり、候補は「印」で出る。狭いと z17 以上で「形」になる
const wideAreas = [{ ...areas[0]!, bbox: [130.6, 32.7, 130.9, 32.9] as [number, number, number, number] }];

const features = [feature('c-1-2-1', 'confirmed_new', 0), feature('c-1-2-2', 'existing_omission', 0.0003), feature('c-1-2-3', 'uncertain', 0.0006)];

function props(over: Partial<LeafletMapProps> = {}): LeafletMapProps {
  return {
    base: 'photo2023',
    areas,
    features,
    showFrames: true,
    selectedId: null,
    highlightIds: new Set(),
    focus: null,
    onSelect: vi.fn(),
    onAreaSelect: vi.fn(),
    onTileStatus: vi.fn(),
    onZoom: vi.fn(),
    ...over,
  };
}

describe('Leaflet の地図', () => {
  it('拡大すると、候補は印ではなく形（ポリゴン）で描く', () => {
    const { container } = render(<LeafletMap {...props()} />);
    expect(container.querySelectorAll('.leaflet-marker-icon')).toHaveLength(0);
    // 白縁 + 本線 = 候補 3 件 × 2 本 + 地区の枠 2 本
    expect(container.querySelectorAll('.leaflet-overlay-pane path').length).toBe(8);
  });

  it('地図・出典・タイル・地区の枠・候補の印を作り、例外を出さない', () => {
    const { container } = render(<LeafletMap {...props({ areas: wideAreas })} />);
    expect(container.querySelector('.leaflet-container')).not.toBeNull();
    // 出典
    expect(container.querySelector('.leaflet-control-attribution')?.textContent).toContain('国土地理院');
    // 写真は標準地図の上に重ねる（タイルが無くても崩れない）
    expect(container.querySelectorAll('.leaflet-tile-pane .leaflet-layer').length).toBe(2);
    // 3 分類の印: 形が 3 通り
    expect(container.querySelectorAll('.cand-dot--circle').length).toBe(1);
    expect(container.querySelectorAll('.cand-dot--square').length).toBe(1);
    expect(container.querySelectorAll('.cand-dot--triangle').length).toBe(1);
    // 地区の枠（白縁 + 本線 = 2 本 × 1 地区）
    expect(container.querySelectorAll('.leaflet-overlay-pane path').length).toBeGreaterThanOrEqual(2);
  });

  it('標準地図のときは下地 1 枚だけ。切り替えても壊れない', () => {
    const { container, rerender } = render(<LeafletMap {...props({ base: 'std' })} />);
    expect(container.querySelectorAll('.leaflet-tile-pane .leaflet-layer').length).toBe(1);
    rerender(<LeafletMap {...props({ base: 'photo2018' })} />);
    expect(container.querySelectorAll('.leaflet-tile-pane .leaflet-layer').length).toBe(2);
    rerender(<LeafletMap {...props({ base: 'std', showFrames: false })} />);
    expect(container.querySelectorAll('.leaflet-tile-pane .leaflet-layer').length).toBe(1);
  });

  it('候補の印を選ぶ（クリックと Enter）と onSelect が呼ばれる。選択・強調は印に反映される', async () => {
    const onSelect = vi.fn();
    const { container, rerender } = render(<LeafletMap {...props({ areas: wideAreas, onSelect })} />);
    const marks = container.querySelectorAll<HTMLElement>('.leaflet-marker-icon');
    expect(marks).toHaveLength(3);
    expect(marks[0]).toHaveAttribute('tabindex', '0');
    expect(marks[0]).toHaveAttribute('title', expect.stringContaining('新規出現'));
    await userEvent.click(marks[1]!);
    expect(onSelect).toHaveBeenCalledWith('c-1-2-2');

    rerender(<LeafletMap {...props({ areas: wideAreas, onSelect, selectedId: 'c-1-2-1', highlightIds: new Set(['c-1-2-3']) })} />);
    expect(container.querySelectorAll('.cand-dot.is-selected')).toHaveLength(1);
    expect(container.querySelectorAll('.cand-dot.is-highlight')).toHaveLength(1);
  });

  it('候補が空・unknown な分類でも落ちない', () => {
    const odd = { ...feature('c-9-9-9', 'uncertain', 0.001), properties: { id: 'c-9-9-9', class: 'sure_new', area_m2: 1, area_id: 'x' } } as unknown as CandidateFeature;
    const { container, rerender } = render(<LeafletMap {...props({ areas: wideAreas, features: [odd] })} />);
    expect(container.querySelectorAll('.leaflet-marker-icon')).toHaveLength(0);
    rerender(<LeafletMap {...props({ areas: wideAreas, features: [] })} />);
    expect(container.querySelector('.leaflet-container')).not.toBeNull();
  });

  it('寄せる・見える位置へずらす要求を受けても落ちない', () => {
    const { rerender } = render(<LeafletMap {...props()} />);
    act(() => {
      rerender(<LeafletMap {...props({ focus: { kind: 'fit', bbox: [130.7, 32.8, 130.701, 32.801], ids: ['c-1-2-1'], padRight: 440, nonce: nextNonce() } })} />);
    });
    act(() => {
      rerender(<LeafletMap {...props({ focus: { kind: 'reveal', point: [130.7, 32.8], padRight: 440, nonce: nextNonce() } })} />);
    });
  });

  it('地区名・区名に HTML が入っていても、ツールチップは文字として出し、要素にしない', () => {
    // 名前は地理院の逆ジオコーダの応答から作った値で、HTML を取り除いていない
    const evil = {
      ...areas[0]!,
      name: '<img src=x onerror="window.__xss=1">',
      ward: '<b id="injected">中央区</b>',
    };
    const { container } = render(<LeafletMap {...props({ areas: [evil], features: [] })} />);
    const frame = Array.from(container.querySelectorAll<SVGPathElement>('.leaflet-overlay-pane path.leaflet-interactive')).at(-1);
    expect(frame).toBeDefined();
    fireEvent.mouseOver(frame!, { clientX: 100, clientY: 100 });

    const tip = container.querySelector('.leaflet-tooltip');
    expect(tip).not.toBeNull();
    expect(tip!.querySelector('img, b, script')).toBeNull();
    expect(container.querySelector('#injected')).toBeNull();
    expect(tip!.textContent).toContain('<img src=x onerror="window.__xss=1">');
    expect(tip!.textContent).toContain('<b id="injected">中央区</b>');
    expect(tip!.textContent).toContain(`候補 ${evil.counts.total} 件`);
  });

  it('アンマウントで地図を片付ける', () => {
    const { container, unmount } = render(<LeafletMap {...props()} />);
    const host = container.querySelector('.leaflet-host')!;
    unmount();
    expect(host.querySelector('.leaflet-pane')).toBeNull();
  });
});
