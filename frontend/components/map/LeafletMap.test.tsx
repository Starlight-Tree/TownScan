import { act, fireEvent, render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import L from 'leaflet';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
  delete document.documentElement.dataset.theme;
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

  it('寄せる要求を受けても落ちない', () => {
    const { rerender } = render(<LeafletMap {...props()} />);
    act(() => {
      rerender(<LeafletMap {...props({ focus: { bbox: [130.7, 32.8, 130.701, 32.801], ids: ['c-1-2-1'], nonce: nextNonce() } })} />);
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

// jsdom には CSS が無く、変数は空になる。テーマごとの値を返す getComputedStyle に差し替えて、Leaflet に渡る色を確かめる
const THEME_VALUES: Record<'light' | 'dark', Record<string, string>> = {
  light: {
    '--class-new': '#c2410c',
    '--class-omit': '#047857',
    '--class-unc': '#9c27b0',
    '--map-casing': '#ffffff',
    '--map-frame': '#111827',
    '--map-select': '#facc15',
    '--map-highlight': '#fde047',
  },
  dark: {
    '--class-new': '#ff8a57',
    '--class-omit': '#34d399',
    '--class-unc': '#e879f9',
    '--map-casing': '#0d1014',
    '--map-frame': '#e6e8eb',
    '--map-select': '#facc15',
    '--map-highlight': '#fde047',
  },
};

function stubThemeStyles() {
  const original = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element, pseudo?: string | null) => {
    if (el !== document.documentElement) return original(el, pseudo);
    const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    return { getPropertyValue: (name: string) => THEME_VALUES[theme][name] ?? '' } as unknown as CSSStyleDeclaration;
  });
}

const strokes = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('.leaflet-overlay-pane path')).map((p) => p.getAttribute('stroke'));

describe('地図の色（テーマ）', () => {
  it('線・塗り・縁は、CSS の変数から読んだ値で描く（TS に色の値を持たない）', () => {
    stubThemeStyles();
    const { container } = render(<LeafletMap {...props()} />);
    const s = strokes(container);
    // 候補 3 件の本線（3 分類の色）、縁（--map-casing）、地区の枠（--map-frame）
    expect(s).toEqual(expect.arrayContaining(['#c2410c', '#047857', '#9c27b0', '#ffffff', '#111827']));
    expect(container.querySelectorAll('.leaflet-overlay-pane path[fill="#c2410c"]')).toHaveLength(1);
  });

  it('変数が読めない環境でも、var(--…) をそのまま渡して落ちない', () => {
    const { container } = render(<LeafletMap {...props()} />);
    expect(strokes(container)).toEqual(expect.arrayContaining(['var(--class-new)', 'var(--class-omit)', 'var(--class-unc)', 'var(--map-casing)']));
  });

  it('テーマを切り替えると、線・塗り・縁・地区の枠を、新しいテーマの値で描き直す', async () => {
    stubThemeStyles();
    const { container } = render(<LeafletMap {...props()} />);
    expect(strokes(container)).toContain('#c2410c');
    act(() => {
      document.documentElement.dataset.theme = 'dark';
    });
    await waitFor(() => expect(strokes(container)).toContain('#ff8a57'));
    const dark = strokes(container);
    expect(dark).toEqual(expect.arrayContaining(['#ff8a57', '#34d399', '#e879f9', '#0d1014', '#e6e8eb']));
    expect(dark).not.toContain('#c2410c');
    expect(dark).not.toContain('#ffffff');
    expect(dark).not.toContain('#111827');
    // 描き直しても、本数は増えも減りもしない
    expect(container.querySelectorAll('.leaflet-overlay-pane path')).toHaveLength(8);

    act(() => {
      delete document.documentElement.dataset.theme;
    });
    await waitFor(() => expect(strokes(container)).toContain('#c2410c'));
  });

  it('OS の設定が変わったとき（システムのまま追従しているとき）も、描き直す', async () => {
    stubThemeStyles();
    let listener: (() => void) | null = null;
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      addEventListener: (_type: string, fn: () => void) => {
        listener = fn;
      },
      removeEventListener: () => {
        listener = null;
      },
    }));
    const { container, unmount } = render(<LeafletMap {...props()} />);
    expect(listener).not.toBeNull();
    expect(strokes(container)).toContain('#c2410c');
    // OS がダークに変わると、CSS が変数の値を替える。ここでは、getComputedStyle の返す値を替えて再現する
    document.documentElement.dataset.theme = 'dark';
    await waitFor(() => expect(strokes(container)).toContain('#ff8a57'));
    unmount();
    expect(listener).toBeNull();
    vi.unstubAllGlobals();
  });

  it('選んだ候補には黄色の輪を足し、外すと取り除く。強調は別の黄色。輪は専用の pane（輪郭より下）に描く', () => {
    stubThemeStyles();
    const { container, rerender } = render(<LeafletMap {...props()} />);
    const overlay = () => container.querySelectorAll('.leaflet-overlay-pane path');
    const ring = () => container.querySelectorAll('.leaflet-ring-pane path');
    const ringStrokes = () => Array.from(ring()).map((p) => p.getAttribute('stroke'));
    expect(overlay()).toHaveLength(8); // 普通の候補は縁と本線の 2 本だけ
    expect(ring()).toHaveLength(0);

    rerender(<LeafletMap {...props({ selectedId: 'c-1-2-1', highlightIds: new Set(['c-1-2-3']) })} />);
    expect(overlay()).toHaveLength(8); // 輪は輪郭の pane に入らない（追加の順に依らず、輪郭の下に固定される）
    expect(ring()).toHaveLength(2);
    const pane = container.querySelector<HTMLElement>('.leaflet-ring-pane')!;
    expect(Number(pane.style.zIndex)).toBeLessThan(400); // 輪郭の pane（overlayPane = 400）より下
    expect(ringStrokes()).toContain('#facc15'); // 選んだ候補
    expect(ringStrokes()).toContain('#fde047'); // 強調した候補

    rerender(<LeafletMap {...props()} />);
    expect(overlay()).toHaveLength(8);
    expect(ring()).toHaveLength(0);
    expect(ringStrokes()).not.toContain('#facc15');
  });

  it('ツールチップに色を直接指定しない（テーマの CSS に従う。文字として組む作りも変えない）', () => {
    const { container } = render(<LeafletMap {...props({ features: [] })} />);
    const frame = Array.from(container.querySelectorAll<SVGPathElement>('.leaflet-overlay-pane path.leaflet-interactive')).at(-1)!;
    fireEvent.mouseOver(frame, { clientX: 100, clientY: 100 });
    const tip = container.querySelector('.leaflet-tooltip');
    expect(tip).not.toBeNull();
    expect(tip!.getAttribute('style') ?? '').not.toMatch(/background|color/);
  });
});

// ---- 初回の表示範囲（全地区）と、枠の大きさが変わる地図（結果領域の拡大） ----

const areaAt = (id: string, bbox: [number, number, number, number]) => ({ ...areas[0]!, id, bbox });
const twoAreas = [areaAt('a', [130.6, 32.7, 130.65, 32.75]), areaAt('b', [130.8, 32.85, 130.9, 32.95])];
const focusFit = (bbox: [number, number, number, number]) => ({ bbox, ids: [], nonce: nextNonce() });
const boundsOf = (arg: L.LatLngBoundsExpression) => L.latLngBounds(arg as L.LatLngTuple[]).toBBoxString();

describe('初回の表示範囲', () => {
  it('地区の一覧が届いたら、全地区の枠の和へ 1 度だけ寄せる。0 件のあいだは動かさない', () => {
    const fit = vi.spyOn(L.Map.prototype, 'fitBounds');
    const { rerender } = render(<LeafletMap {...props({ areas: [] })} />);
    expect(fit).not.toHaveBeenCalled();

    rerender(<LeafletMap {...props({ areas: twoAreas })} />);
    expect(fit).toHaveBeenCalledTimes(1);
    expect(boundsOf(fit.mock.calls[0]![0])).toBe('130.6,32.7,130.9,32.95');

    // 地区の一覧を取り直しても、利用者が動かした地図を戻さない
    rerender(<LeafletMap {...props({ areas: [...twoAreas] })} />);
    expect(fit).toHaveBeenCalledTimes(1);
  });

  it('チャットや選択が先に地図を動かしていたら、地区の一覧が届いても、全地区へは寄せない', () => {
    const fit = vi.spyOn(L.Map.prototype, 'fitBounds');
    const focus = focusFit([130.7, 32.8, 130.701, 32.801]);
    const { rerender } = render(<LeafletMap {...props({ areas: [], focus })} />);
    expect(fit).toHaveBeenCalledTimes(1);
    rerender(<LeafletMap {...props({ areas: twoAreas, focus })} />);
    expect(fit).toHaveBeenCalledTimes(1);
    expect(boundsOf(fit.mock.calls[0]![0])).toBe('130.7,32.8,130.701,32.801');
  });

  it('寄せるときの余白は、四方とも 32px。右端をあける欄（padRight）は持たない（詳細は地図に重ならない）', () => {
    const fit = vi.spyOn(L.Map.prototype, 'fitBounds');
    render(<LeafletMap {...props({ focus: focusFit([130.7, 32.8, 130.701, 32.801]) })} />);
    expect(fit).toHaveBeenCalledTimes(1);
    expect(fit.mock.calls[0]![1]).toMatchObject({ paddingTopLeft: [32, 32], paddingBottomRight: [32, 32], maxZoom: 19 });
  });

  it('地区の一覧と寄せる要求が同時なら、要求だけを実行する（一度全体を見せて、すぐ動かすことをしない）', () => {
    const fit = vi.spyOn(L.Map.prototype, 'fitBounds');
    render(<LeafletMap {...props({ areas: twoAreas, focus: focusFit([130.7, 32.8, 130.701, 32.801]) })} />);
    expect(fit).toHaveBeenCalledTimes(1);
    expect(boundsOf(fit.mock.calls[0]![0])).toBe('130.7,32.8,130.701,32.801');
  });
});

describe('結果領域の拡大・縮小（地図の枠の大きさが変わるとき）', () => {
  let size = { w: 800, h: 600 };
  let fire: () => void = () => {};
  const disconnect = vi.fn();

  beforeEach(() => {
    size = { w: 800, h: 600 };
    disconnect.mockClear();
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => size.w });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => size.h });
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          fire = cb;
        }
        observe() {}
        unobserve() {}
        disconnect() {
          // 本物の ResizeObserver は、止めたあとは通知しない
          disconnect();
          fire = () => {};
        }
      },
    );
  });

  afterEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 800 });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 600 });
    vi.unstubAllGlobals();
  });

  const resizeTo = (w: number, h: number) => {
    size = { w, h };
    act(() => fire());
  };

  it('枠の大きさが変わるたびに、地図へ知らせる（invalidateSize）。地図の大きさが、新しい枠に追従する', () => {
    const invalidate = vi.spyOn(L.Map.prototype, 'invalidateSize');
    const mapOf = vi.spyOn(L, 'map');
    render(<LeafletMap {...props({ areas: twoAreas })} />);
    const map = mapOf.mock.results[0]!.value as L.Map;
    expect(invalidate).not.toHaveBeenCalled();
    expect(map.getSize().x).toBe(800);

    resizeTo(1200, 600);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(map.getSize().x).toBe(1200);

    resizeTo(600, 600);
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(map.getSize().x).toBe(600);
  });

  it('広げても縮めても、地図の中心と縮尺は変わらない。元の大きさへ戻せば、表示範囲も元のとおり', () => {
    const mapOf = vi.spyOn(L, 'map');
    render(<LeafletMap {...props({ areas: twoAreas, focus: focusFit([130.7, 32.8, 130.71, 32.81]) })} />);
    const map = mapOf.mock.results[0]!.value as L.Map;
    const center = map.getCenter();
    const zoom = map.getZoom();
    const bounds = map.getBounds().toBBoxString();
    // 中心は、画面の 1 ピクセル未満のずれまで同じ（Leaflet は枠の変化を整数のピクセルで補正するので、緯度経度では丸め分がずれる）
    const driftPx = () => map.project(map.getCenter(), zoom).distanceTo(map.project(center, zoom));

    // 結果領域を「拡大」: チャットの列が狭まり、地図の枠が横に広がる
    resizeTo(1200, 600);
    expect(map.getZoom()).toBe(zoom);
    expect(driftPx()).toBeLessThan(1);
    expect(map.getBounds().toBBoxString()).not.toBe(bounds); // 広い枠には、より広い範囲が映る

    // もう一度押して、元の幅へ
    resizeTo(800, 600);
    expect(map.getZoom()).toBe(zoom);
    expect(driftPx()).toBeLessThan(1);
    expect(map.getBounds().toBBoxString()).toBe(bounds);
  });

  it('寄せる要求は、すぐ実行する（枠の大きさを待たない）。大きさが変わっても、寄せ直さない', () => {
    const fit = vi.spyOn(L.Map.prototype, 'fitBounds');
    const { rerender } = render(<LeafletMap {...props({ areas: [] })} />);
    rerender(<LeafletMap {...props({ areas: [], focus: focusFit([130.7, 32.8, 130.701, 32.801]) })} />);
    expect(fit).toHaveBeenCalledTimes(1);
    resizeTo(1200, 600);
    expect(fit).toHaveBeenCalledTimes(1);
  });

  it('アンマウントすると、観測をやめる（片付けた地図に触れない）', () => {
    const invalidate = vi.spyOn(L.Map.prototype, 'invalidateSize');
    const { unmount } = render(<LeafletMap {...props({ areas: twoAreas })} />);
    unmount();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(() => resizeTo(1200, 600)).not.toThrow();
    expect(invalidate).not.toHaveBeenCalled();
  });
});
