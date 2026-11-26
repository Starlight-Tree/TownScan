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
    expect(marks[0]).toHaveAttribute('title', expect.stringContaining('2018 年は未検出'));
    await userEvent.click(marks[1]!);
    expect(onSelect).toHaveBeenCalledWith('c-1-2-2');
    fireEvent.keyDown(marks[0]!, { key: 'Enter' });
    expect(onSelect).toHaveBeenLastCalledWith('c-1-2-1');

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

// ---- 下地（年・標準地図）の切り替え ----

describe('下地（年・標準地図）の切り替え', () => {
  it('年を切り替えたあとに、地図を寄せても落ちない（候補の一覧の行を押すと「Cannot read properties of null (reading getCenter)」で全体が落ちた）', () => {
    const { rerender } = render(<LeafletMap {...props({ base: 'photo2023' })} />);
    rerender(<LeafletMap {...props({ base: 'photo2018' })} />);
    expect(() =>
      act(() => {
        rerender(<LeafletMap {...props({ base: 'photo2018', focus: focusFit([130.7, 32.8, 130.701, 32.801]) })} />);
      }),
    ).not.toThrow();
    // 標準地図へ、年へ戻しても同じ
    rerender(<LeafletMap {...props({ base: 'std', focus: focusFit([130.7, 32.8, 130.701, 32.801]) })} />);
    rerender(<LeafletMap {...props({ base: 'photo2023', focus: focusFit([130.7, 32.8, 130.701, 32.801]) })} />);
    expect(() =>
      act(() => {
        rerender(<LeafletMap {...props({ base: 'photo2023', focus: focusFit([130.71, 32.81, 130.711, 32.811]) })} />);
      }),
    ).not.toThrow();
  });

  it('外した写真の層の処理が、地図に残らない（残っているのは、いま地図に載っている層のものだけ）', () => {
    const mapOf = vi.spyOn(L, 'map');
    const { rerender } = render(<LeafletMap {...props({ base: 'photo2023' })} />);
    const map = mapOf.mock.results[0]!.value as L.Map;
    rerender(<LeafletMap {...props({ base: 'photo2018' })} />);
    rerender(<LeafletMap {...props({ base: 'std' })} />);
    // Leaflet の内部: map._events[種類] = [{ fn, ctx }]。層が外れると ctx._map は null になる
    const events = (map as unknown as { _events: Record<string, { ctx?: { _map?: unknown } }[]> })._events;
    const stale = Object.entries(events).flatMap(([type, list]) => list.filter((l) => l.ctx && '_map' in l.ctx && l.ctx._map === null).map(() => type));
    expect(stale).toEqual([]);
  });

  it('下地を替えても、写真の読み込みの通知（onTileStatus）は、いまの層のものだけを受ける', () => {
    const onTileStatus = vi.fn();
    const { rerender } = render(<LeafletMap {...props({ base: 'photo2023', onTileStatus })} />);
    rerender(<LeafletMap {...props({ base: 'std', onTileStatus })} />);
    expect(onTileStatus).toHaveBeenLastCalledWith('ok');
  });
});

// ---- 操作部品（拡大・縮小・出典）----

describe('地図の操作部品（拡大・縮小・出典）', () => {
  it('拡大・縮小ボタンの名前とツールチップは日本語（英語の Zoom in / Zoom out のままにしない）', () => {
    const { container } = render(<LeafletMap {...props()} />);
    const zoomIn = container.querySelector('.leaflet-control-zoom-in')!;
    const zoomOut = container.querySelector('.leaflet-control-zoom-out')!;
    for (const [el, name] of [
      [zoomIn, '地図を拡大'],
      [zoomOut, '地図を縮小'],
    ] as const) {
      expect(el).toHaveAttribute('aria-label', name);
      expect(el).toHaveAttribute('title', name);
    }
    expect(container.querySelectorAll('.leaflet-control-zoom a')).toHaveLength(2);
  });

  it('Tab の順（DOM の順）で、操作部品は、地図の部品（候補の印）より先。見た目の左上と、Tab の順を合わせる', () => {
    const { container } = render(<LeafletMap {...props({ areas: wideAreas })} />);
    const host = container.querySelector('.leaflet-host')!;
    const controls = host.querySelector('.leaflet-control-container')!;
    const pane = host.querySelector('.leaflet-map-pane')!;
    expect(host.firstElementChild).toBe(controls);
    expect(controls.compareDocumentPosition(pane) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const marker = host.querySelector('.leaflet-marker-icon')!;
    expect(controls.compareDocumentPosition(marker) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 拡大・縮小・出典は、まだ地図の中にある（外へ出していない）
    expect(controls.querySelector('.leaflet-control-zoom')).not.toBeNull();
    expect(controls.querySelector('.leaflet-control-attribution')).not.toBeNull();
  });

  it('地区の枠（マウス向け）は Tab の順から外す（tabindex=-1）。名前の無い Tab の停止が地区の数だけ並ばない', () => {
    const { container } = render(<LeafletMap {...props({ features: [] })} />);
    const frames = container.querySelectorAll('.leaflet-overlay-pane path.leaflet-interactive');
    expect(frames).toHaveLength(areas.length);
    for (const f of frames) expect(f).toHaveAttribute('tabindex', '-1');
  });

  it('描き直し（テーマの切り替え・表示の切り替え）のあとも、地区の枠は Tab の順の外のまま', () => {
    const { container, rerender } = render(<LeafletMap {...props({ features: [] })} />);
    rerender(<LeafletMap {...props({ features: [], showFrames: false })} />);
    rerender(<LeafletMap {...props({ features: [], showFrames: true })} />);
    const frames = container.querySelectorAll('.leaflet-overlay-pane path.leaflet-interactive');
    expect(frames).toHaveLength(areas.length);
    for (const f of frames) expect(f).toHaveAttribute('tabindex', '-1');
  });
});

// ---- キーボード（候補の印・形）----

function at(id: string, cls: CandidateFeature['properties']['class'], lon: number, lat: number): CandidateFeature {
  return {
    type: 'Feature',
    id,
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [lon, lat],
          [lon + 0.0001, lat],
          [lon + 0.0001, lat + 0.0001],
          [lon, lat + 0.0001],
          [lon, lat],
        ],
      ],
    },
    properties: { id, class: cls, area_m2: 50, area_id: 'z18-1-2' },
  };
}
// a の東に b、a の南に c（広い範囲の表示で、印が数十 px ずつ離れる）
const kbA = at('k-a', 'confirmed_new', 130.7, 32.8);
const kbB = at('k-b', 'uncertain', 130.75, 32.8);
const kbC = at('k-c', 'existing_omission', 130.7, 32.75);
const kbFeatures = [kbA, kbB, kbC];

describe('候補の印のキーボード操作（Enter・Space で選ぶ。Tab の停止は 1 つで、矢印キーで隣の印へ）', () => {
  const setup = (over: Partial<LeafletMapProps> = {}) => {
    const onSelect = vi.fn();
    const view = render(<LeafletMap {...props({ areas: wideAreas, features: kbFeatures, onSelect, ...over })} />);
    const marks = Array.from(view.container.querySelectorAll<HTMLElement>('.leaflet-marker-icon'));
    return { ...view, onSelect, marks };
  };
  const tabStops = (marks: HTMLElement[]) => marks.map((m) => m.getAttribute('tabindex'));

  it('印は role=button・名前つき。ツールチップは、実際に効く操作（Enter か Space）を言う', () => {
    const { marks } = setup();
    expect(marks).toHaveLength(3);
    for (const m of marks) expect(m).toHaveAttribute('role', 'button');
    expect(marks[0]).toHaveAttribute('aria-label', expect.stringContaining('2018 年は未検出'));
    expect(marks[1]).toHaveAttribute('aria-label', expect.stringContaining('未判定'));
    expect(marks[0]).toHaveAttribute('title', expect.stringContaining('Enter か Space で選ぶ'));
  });

  it('Enter で選ぶ（マウスのクリックと同じ onSelect）。既定の動きを止める', () => {
    const { marks, onSelect } = setup();
    expect(fireEvent.keyDown(marks[1]!, { key: 'Enter' })).toBe(false);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenLastCalledWith('k-b');
  });

  it('Space で選ぶ。ページがスクロールしないよう、既定の動きを止める', () => {
    const { marks, onSelect } = setup();
    expect(fireEvent.keyDown(marks[2]!, { key: ' ' })).toBe(false);
    expect(onSelect).toHaveBeenLastCalledWith('k-c');
  });

  it('押しっぱなしの繰り返し（repeat）・Alt/Ctrl/Meta つきの組み合わせ・ほかのキーでは選ばない（ブラウザー・OS の操作を奪わない）', () => {
    const { marks, onSelect } = setup();
    fireEvent.keyDown(marks[0]!, { key: 'Enter', repeat: true });
    fireEvent.keyDown(marks[0]!, { key: 'Enter', altKey: true });
    fireEvent.keyDown(marks[0]!, { key: 'Enter', ctrlKey: true });
    fireEvent.keyDown(marks[0]!, { key: 'Enter', metaKey: true });
    expect(fireEvent.keyDown(marks[0]!, { key: 'a' })).toBe(true); // 既定の動きは止めない
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('Tab の停止は 1 つだけ（先頭の印。ほかは -1）。選択中の候補があれば、その印', () => {
    const first = setup();
    expect(tabStops(first.marks)).toEqual(['0', '-1', '-1']);
    first.unmount();
    const selected = setup({ selectedId: 'k-c' });
    expect(tabStops(selected.marks)).toEqual(['-1', '-1', '0']);
  });

  it('選んでいる印は aria-pressed=true（読み上げで、どれが選択中か分かる）。選択を替えても、Tab の停止の数は 1 つのまま', () => {
    const { container, rerender } = setup({ selectedId: 'k-b' });
    const marks = () => Array.from(container.querySelectorAll<HTMLElement>('.leaflet-marker-icon'));
    expect(marks().map((m) => m.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false']);
    rerender(<LeafletMap {...props({ areas: wideAreas, features: kbFeatures, selectedId: 'k-a', highlightIds: new Set(['k-c']) })} />);
    expect(marks().map((m) => m.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false']);
    expect(marks().filter((m) => m.getAttribute('tabindex') === '0')).toHaveLength(1);
    for (const m of marks()) expect(m).toHaveAttribute('role', 'button');
  });

  it('矢印キーで、その向きにいちばん近い印へフォーカスを移す。Tab の停止もそこへ移る。向きに印が無ければ動かない', () => {
    const { marks } = setup();
    const [a, b, c] = marks as [HTMLElement, HTMLElement, HTMLElement];
    a.focus();
    expect(fireEvent.keyDown(a, { key: 'ArrowRight' })).toBe(false); // ページをスクロールしない
    expect(b).toHaveFocus();
    expect(tabStops(marks)).toEqual(['-1', '0', '-1']);
    fireEvent.keyDown(b, { key: 'ArrowRight' }); // 東に印は無い
    expect(b).toHaveFocus();
    fireEvent.keyDown(b, { key: 'ArrowLeft' });
    expect(a).toHaveFocus();
    fireEvent.keyDown(a, { key: 'ArrowDown' });
    expect(c).toHaveFocus();
    fireEvent.keyDown(c, { key: 'ArrowUp' });
    expect(a).toHaveFocus();
    expect(tabStops(marks)).toEqual(['0', '-1', '-1']);
  });

  it('Home・End で、先頭・末尾の印へ', () => {
    const { marks } = setup();
    marks[1]!.focus();
    fireEvent.keyDown(marks[1]!, { key: 'End' });
    expect(marks[2]).toHaveFocus();
    fireEvent.keyDown(marks[2]!, { key: 'Home' });
    expect(marks[0]).toHaveFocus();
  });

  it('矢印で移るだけでは選ばない（選ぶのは Enter・Space のとき）', () => {
    const { marks, onSelect } = setup();
    marks[0]!.focus();
    fireEvent.keyDown(marks[0]!, { key: 'ArrowRight' });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('フォーカスが印に着いたら（マウスで押した・Tab で入った）、そこが Tab の停止になる', () => {
    const { marks } = setup();
    marks[2]!.focus();
    expect(tabStops(marks)).toEqual(['-1', '-1', '0']);
  });

  it('選択を替えて印のアイコンを描き直しても、Tab の停止・role・名前を保つ', () => {
    const { container, rerender, marks } = setup();
    marks[1]!.focus();
    rerender(<LeafletMap {...props({ areas: wideAreas, features: kbFeatures, selectedId: 'k-a' })} />);
    const now = Array.from(container.querySelectorAll<HTMLElement>('.leaflet-marker-icon'));
    expect(tabStops(now)).toEqual(['-1', '0', '-1']); // 手で移した先を保つ
    for (const m of now) {
      expect(m).toHaveAttribute('role', 'button');
      expect(m).toHaveAttribute('aria-label');
    }
  });
});

describe('候補の形（拡大したとき）のキーボード操作も、印と同じ', () => {
  const setup = (over: Partial<LeafletMapProps> = {}) => {
    const onSelect = vi.fn();
    const view = render(<LeafletMap {...props({ onSelect, ...over })} />);
    const shapes = () => Array.from(view.container.querySelectorAll<SVGElement>('.leaflet-overlay-pane path[role="button"]'));
    return { ...view, onSelect, shapes };
  };

  it('拡大して形になると、形が role=button・名前つきで、Tab の停止は 1 つ。地区の枠は含まない', () => {
    const { shapes } = setup();
    expect(shapes()).toHaveLength(3);
    expect(shapes().map((e) => e.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
    expect(shapes()[0]).toHaveAttribute('aria-label', expect.stringContaining('2018 年は未検出'));
    expect(shapes()[1]).toHaveAttribute('aria-label', expect.stringContaining('2018 年も検出'));
  });

  it('Enter・Space で選ぶ', () => {
    const { shapes, onSelect } = setup();
    fireEvent.keyDown(shapes()[1]!, { key: 'Enter' });
    expect(onSelect).toHaveBeenLastCalledWith('c-1-2-2');
    fireEvent.keyDown(shapes()[2]!, { key: ' ' });
    expect(onSelect).toHaveBeenLastCalledWith('c-1-2-3');
  });

  it('矢印キーで隣の形へ移る', () => {
    const { shapes } = setup();
    shapes()[0]!.focus();
    fireEvent.keyDown(shapes()[0]!, { key: 'ArrowRight' });
    expect(shapes()[1]).toHaveFocus();
    expect(shapes().map((e) => e.getAttribute('tabindex'))).toEqual(['-1', '0', '-1']);
  });

  it('縮小して印へ戻ると、印にも role・Tab の停止（1 つ）が付く。拡大して形へ戻っても同じ', () => {
    const mapOf = vi.spyOn(L, 'map');
    const { container, shapes } = setup({ areas: wideAreas, features: kbFeatures });
    const map = mapOf.mock.results[0]!.value as L.Map;
    const marks = () => Array.from(container.querySelectorAll<HTMLElement>('.leaflet-marker-icon'));
    expect(marks()).toHaveLength(3); // 広い範囲: 印
    act(() => {
      map.setZoom(18, { animate: false });
    });
    expect(marks()).toHaveLength(0);
    expect(shapes()).toHaveLength(3);
    expect(shapes().filter((e) => e.getAttribute('tabindex') === '0')).toHaveLength(1);
    act(() => {
      map.setZoom(12, { animate: false });
    });
    expect(shapes()).toHaveLength(0);
    expect(marks()).toHaveLength(3);
    for (const m of marks()) expect(m).toHaveAttribute('role', 'button');
    expect(marks().filter((m) => m.getAttribute('tabindex') === '0')).toHaveLength(1);
  });
});

describe('重なった印（見えている印を押した通りに選ぶ）', () => {
  // 0.004 度は、広い範囲の表示で数 px。2 つの印の箱（24px）は重なる
  const near = [at('n-a', 'existing_omission', 130.7, 32.8), at('n-b', 'uncertain', 130.704, 32.8)];
  function setup() {
    const mapOf = vi.spyOn(L, 'map');
    const onSelect = vi.fn();
    const view = render(<LeafletMap {...props({ areas: wideAreas, features: near, onSelect })} />);
    const map = mapOf.mock.results[0]!.value as L.Map;
    const marks = Array.from(view.container.querySelectorAll<HTMLElement>('.leaflet-marker-icon'));
    // 印の中心（候補の形の中心）の、地図の枠の中の位置
    const center = (f: CandidateFeature) => {
      const [lon, lat] = (f.geometry.coordinates as number[][][])[0]![0]!;
      return map.latLngToContainerPoint([lat! + 0.00005, lon! + 0.00005]);
    };
    return { ...view, onSelect, marks, pa: center(near[0]!), pb: center(near[1]!) };
  }

  it('2 つの印の中心は離れていて（対角の半分より近い）、箱は重なる（前提）', () => {
    const { pa, pb } = setup();
    expect(pa.distanceTo(pb)).toBeGreaterThan(2);
    expect(pa.distanceTo(pb)).toBeLessThan(16);
  });

  it('手前の印の箱が覆っていても、奥の印の中心を押せば、奥の印が選ばれる（押したのと別の候補にならない）', () => {
    const { marks, onSelect, pa } = setup();
    fireEvent.click(marks[1]!, { clientX: pa.x, clientY: pa.y }); // イベントを受けたのは手前の印（b）
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenLastCalledWith('n-a');
  });

  it('手前の印の中心を押せば、手前の印。奥の印の要素がイベントを受けても、押した位置に近い方', () => {
    const { marks, onSelect, pb } = setup();
    fireEvent.click(marks[1]!, { clientX: pb.x, clientY: pb.y });
    expect(onSelect).toHaveBeenLastCalledWith('n-b');
    fireEvent.click(marks[0]!, { clientX: pb.x, clientY: pb.y });
    expect(onSelect).toHaveBeenLastCalledWith('n-b');
  });

  it('押した所から、印の箱（24px）の対角の半分（約 17px）以内にある印も、候補にする。箱の外側の角に近い所を押しても、見えている印を選べる', () => {
    const { marks, onSelect, pa, pb } = setup();
    // 奥の印 a の中心から、手前の印 b と反対の向きへ 16.5px。b の中心からは、それより遠い
    const dx = pa.x - pb.x;
    const dy = pa.y - pb.y;
    const len = Math.hypot(dx, dy);
    fireEvent.click(marks[1]!, { clientX: pa.x + (dx / len) * 16.5, clientY: pa.y + (dy / len) * 16.5 });
    expect(onSelect).toHaveBeenLastCalledWith('n-a');
  });

  it('近くに別の印が無ければ、イベントを受けた印のまま', () => {
    const { marks, onSelect, pa } = setup();
    fireEvent.click(marks[0]!, { clientX: pa.x - 60, clientY: pa.y });
    expect(onSelect).toHaveBeenLastCalledWith('n-a');
  });
});

describe('地図の空いている所を押す（選択を外す）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('地図の空いている所を押すと、少し待って onClearSelection。拡大ボタンでは呼ばない', () => {
    const onClearSelection = vi.fn();
    const { container } = render(<LeafletMap {...props({ areas: wideAreas, onClearSelection })} />);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.click(container.querySelector('.leaflet-host')!);
    expect(onClearSelection).not.toHaveBeenCalled(); // ダブルクリックかどうかを待つ
    vi.advanceTimersByTime(300);
    expect(onClearSelection).toHaveBeenCalledTimes(1);
    fireEvent.click(container.querySelector('.leaflet-control-zoom-in')!);
    vi.advanceTimersByTime(1000);
    expect(onClearSelection).toHaveBeenCalledTimes(1);
  });

  it('ダブルクリック（拡大）では、選択を外さない（2 回の click のあとに dblclick が来る）', () => {
    const onClearSelection = vi.fn();
    const { container } = render(<LeafletMap {...props({ areas: wideAreas, onClearSelection })} />);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const host = container.querySelector('.leaflet-host')!;
    fireEvent.click(host);
    fireEvent.click(host);
    fireEvent.doubleClick(host);
    vi.advanceTimersByTime(1000);
    expect(onClearSelection).not.toHaveBeenCalled();
  });

  it('待っているあいだに地図を片付けても、あとから呼ばない', () => {
    const onClearSelection = vi.fn();
    const { container, unmount } = render(<LeafletMap {...props({ areas: wideAreas, onClearSelection })} />);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.click(container.querySelector('.leaflet-host')!);
    unmount();
    vi.advanceTimersByTime(1000);
    expect(onClearSelection).not.toHaveBeenCalled();
  });

  it('印・形・地区の枠を押したときは、空き地を押した扱いにしない（選んだ直後に外れない）', () => {
    const onClearSelection = vi.fn();
    const onSelect = vi.fn();
    const onAreaSelect = vi.fn();
    const wide = render(<LeafletMap {...props({ areas: wideAreas, onClearSelection, onSelect, onAreaSelect })} />);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.click(wide.container.querySelector('.leaflet-marker-icon')!);
    expect(onSelect).toHaveBeenCalledTimes(1);
    wide.unmount();
    vi.useRealTimers();

    const close = render(<LeafletMap {...props({ onClearSelection, onSelect, onAreaSelect })} />);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const paths = Array.from(close.container.querySelectorAll('.leaflet-overlay-pane path.leaflet-interactive'));
    const shape = close.container.querySelector('path[role="button"]')!;
    const frame = paths.find((p) => !p.hasAttribute('role'))!;
    fireEvent.click(shape);
    fireEvent.click(frame);
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onAreaSelect).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000); // 地図の空き地として扱われていれば、ここまでに呼ばれる
    expect(onClearSelection).not.toHaveBeenCalled();
  });

  it('onClearSelection が無くても落ちない', () => {
    const { container } = render(<LeafletMap {...props({ areas: wideAreas })} />);
    expect(() => fireEvent.click(container.querySelector('.leaflet-host')!)).not.toThrow();
  });
});

// ---- 選択中のカードの下に隠れる印を、上へ寄せる ----

/** jsdom には配置が無い。getBoundingClientRect で、長方形を与える */
const domRect = (left: number, top: number, width: number, height: number): DOMRect =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

/** 「動きを減らす」設定にする（パンが、その場で済む）。ほかの matchMedia（テーマ）は、何も言わない */
function stubReducedMotion(reduce: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: reduce && query.includes('prefers-reduced-motion'), media: query }));
}

describe('選んだ印・フォーカスした印が、選択中のカードの下に隠れるとき、地図を上へ寄せる', () => {
  // 地図の枠は 800×600（左上が原点）。カードは、test ごとに、見たい印の上に置く
  let card: HTMLDivElement;
  let cardBox = domRect(0, 0, 0, 0);
  const coverRef = { current: null as HTMLElement | null };

  beforeEach(() => {
    card = document.createElement('div');
    coverRef.current = card;
    cardBox = domRect(0, 0, 0, 0);
    const original = Element.prototype.getBoundingClientRect;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this === card) return cardBox;
      if (this.classList.contains('leaflet-host')) return domRect(0, 0, 800, 600);
      return original.call(this);
    });
    stubReducedMotion(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** 広い範囲の表示（印）で、候補 k-a の印の、地図の枠の中の位置 */
  function setup(over: Partial<LeafletMapProps> = {}) {
    const mapOf = vi.spyOn(L, 'map');
    const view = render(<LeafletMap {...props({ areas: wideAreas, features: kbFeatures, coverRef, ...over })} />);
    const map = mapOf.mock.results[0]!.value as L.Map;
    const where = (f: CandidateFeature) => {
      const [lon, lat] = (f.geometry.coordinates as number[][][])[0]![0]!;
      return map.latLngToContainerPoint([lat! + 0.00005, lon! + 0.00005]);
    };
    const marks = () => Array.from(view.container.querySelectorAll<HTMLElement>('.leaflet-marker-icon'));
    return { ...view, map, where, marks, a: where(kbA) };
  }

  /** 点 p の少し上から下へ、幅 200・高さ 56 のカードを置く（点は、カードの上から 10px 内側） */
  const coverAt = (p: { x: number; y: number }) => {
    cardBox = domRect(p.x - 100, p.y - 10, 200, 56);
  };

  it('印を選んだとき、その印がカードの下に入るなら、カードの上に出るまで寄せる（印の下端 + 余白 8px がカードの上端）', () => {
    const { map, a, rerender } = setup();
    coverAt(a); // 印の中心が、カードの上端から 10px 内側
    rerender(<LeafletMap {...props({ areas: wideAreas, features: kbFeatures, coverRef, selectedId: 'k-a' })} />);
    const moved = map.latLngToContainerPoint([32.80005, 130.70005]);
    // 印の箱の下端（中心 + 18px）+ 8px が、カードの上端（中心 - 10px）に届くまで: 18 + 8 + 10 = 36px 上へ
    expect(a.y - moved.y).toBeCloseTo(36, 0);
    expect(moved.x).toBeCloseTo(a.x, 0); // 横には動かさない
  });

  it('カードに隠れない印（横・上にある印）は、選んでも動かさない。利用者が動かした地図を引き戻さない', () => {
    const pan = vi.spyOn(L.Map.prototype, 'panBy'); // 地図を作る前に（地図は、作るときの panBy を包む）
    const { map, a, rerender } = setup();
    cardBox = domRect(a.x + 200, a.y - 10, 200, 56); // カードは印の右（横にずれている）
    rerender(<LeafletMap {...props({ areas: wideAreas, features: kbFeatures, coverRef, selectedId: 'k-a' })} />);
    cardBox = domRect(a.x - 100, a.y + 60, 200, 56); // カードは印の下（印はカードより上）
    rerender(<LeafletMap {...props({ areas: wideAreas, features: kbFeatures, coverRef, selectedId: 'k-b' })} />);
    expect(pan).not.toHaveBeenCalled();
    expect(map.latLngToContainerPoint([32.80005, 130.70005]).y).toBeCloseTo(a.y, 0);
  });

  it('カードが無い（coverRef の要素が null・大きさが無い）ときは、何もしない', () => {
    const pan = vi.spyOn(L.Map.prototype, 'panBy'); // 地図を作る前に（地図は、作るときの panBy を包む）
    const { a, where, rerender } = setup();
    const b = where(kbB);
    const c = where(kbC);
    const select = (id: string) => rerender(<LeafletMap {...props({ areas: wideAreas, features: kbFeatures, coverRef, selectedId: id })} />);
    // 要素が無い（null）: カードの位置が印の上でも、動かさない
    coverAt(b);
    coverRef.current = null;
    select('k-b');
    // 大きさが無い（描かれていない。display: none など）: 位置が印の上でも、動かさない
    coverRef.current = card;
    cardBox = domRect(a.x, a.y, 0, 0);
    select('k-a');
    expect(pan).not.toHaveBeenCalled();
    // 対照: 大きさのあるカードなら、同じ操作で寄せる（この spy が、地図の panBy を捉えている）
    coverAt(c);
    select('k-c');
    expect(pan).toHaveBeenCalledTimes(1);
  });

  it('coverRef を渡さなくても落ちない', () => {
    const { rerender } = setup({ coverRef: undefined });
    expect(() => rerender(<LeafletMap {...props({ areas: wideAreas, features: kbFeatures, selectedId: 'k-a' })} />)).not.toThrow();
  });

  it('寄せすぎて、印が地図の枠の上へ出ることはしない（上の余白 8px を残す）', () => {
    const { map, a, rerender } = setup();
    // カードの上端を、印のずっと上（枠の上端の近く）に置く: 全部寄せると、印が枠の外へ出る
    cardBox = domRect(a.x - 100, 0, 200, a.y + 40);
    rerender(<LeafletMap {...props({ areas: wideAreas, features: kbFeatures, coverRef, selectedId: 'k-a' })} />);
    const moved = map.latLngToContainerPoint([32.80005, 130.70005]);
    expect(moved.y - 18).toBeGreaterThanOrEqual(8 - 1); // 印の上端が、枠の上端から 8px 以上
  });

  it('キーボードでフォーカスした印が、カードの下に入るなら寄せる。マウスで押して着いたとき（:focus-visible でない）は、動かさない', () => {
    const { map, a, marks } = setup();
    coverAt(a);
    // マウス: 押した印が、押している間に動かない
    const original = Element.prototype.matches;
    const mouse = vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
      return selector === ':focus-visible' ? false : original.call(this, selector);
    });
    marks()[1]!.focus();
    marks()[0]!.focus();
    expect(map.latLngToContainerPoint([32.80005, 130.70005]).y).toBeCloseTo(a.y, 0);
    mouse.mockRestore();
    // キーボード（:focus-visible）: 寄せる
    const base = map.latLngToContainerPoint([32.80005, 130.70005]).y;
    vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
      return selector === ':focus-visible' ? true : original.call(this, selector);
    });
    marks()[1]!.focus();
    marks()[0]!.focus();
    expect(base - map.latLngToContainerPoint([32.80005, 130.70005]).y).toBeCloseTo(36, 0);
  });

  it('矢印キーで隣の印へ移ったときも、その印がカードの下なら寄せる', () => {
    const { map, where, marks } = setup();
    const b = where(kbB);
    cardBox = domRect(b.x - 100, b.y - 10, 200, 56);
    vi.spyOn(Element.prototype, 'matches').mockImplementation(function () {
      return true; // フォーカスの種類を見る判定は、キーボード
    });
    marks()[0]!.focus();
    fireEvent.keyDown(marks()[0]!, { key: 'ArrowRight' });
    expect(marks()[1]).toHaveFocus();
    expect(b.y - map.latLngToContainerPoint([32.80005, 130.75005]).y).toBeCloseTo(36, 0);
  });

  it('拡大して形のとき（印でなく形）も、形の箱がカードの下に入るなら、形の下端がカードの上に出るまで寄せる', () => {
    const mapOf = vi.spyOn(L, 'map');
    const { rerender } = render(<LeafletMap {...props({ coverRef })} />); // 狭い範囲: 形
    const map = mapOf.mock.results[0]!.value as L.Map;
    expect(map.getZoom()).toBeGreaterThanOrEqual(17);
    const sw = map.latLngToContainerPoint([32.8, 130.7]);
    // カードの上端が、形の下端より 3px 上（形の下端は、カードの中へ 3px 入る）
    cardBox = domRect(sw.x - 100, sw.y - 3, 200, 56);
    rerender(<LeafletMap {...props({ coverRef, selectedId: 'c-1-2-1' })} />);
    const moved = map.latLngToContainerPoint([32.8, 130.7]);
    // 形の外側の余白 9px + 空き 8px + 3px
    expect(sw.y - moved.y).toBeCloseTo(9 + 8 + 3, 0);
  });

  it('寄せる要求（fitBounds）の下の余白は、カードがあれば、カードの分だけ広げる（寄せた候補・強調した候補が、カードの下に入らない）', () => {
    const fit = vi.spyOn(L.Map.prototype, 'fitBounds');
    cardBox = domRect(140, 514, 520, 56); // 地図の枠（高さ 600）の下端から 30px あけて、高さ 56
    render(<LeafletMap {...props({ coverRef, focus: { bbox: [130.7, 32.8, 130.701, 32.801], ids: ['c-1-2-1'], nonce: nextNonce() } })} />);
    // 枠の下端からカードの上端まで 86px + 空き 8px
    expect(fit.mock.calls[0]![1]).toMatchObject({ paddingTopLeft: [32, 32], paddingBottomRight: [32, 94] });
  });

  it('カードが無いときの寄せる余白は、これまでどおり 32px', () => {
    const fit = vi.spyOn(L.Map.prototype, 'fitBounds');
    coverRef.current = null;
    render(<LeafletMap {...props({ coverRef, focus: { bbox: [130.7, 32.8, 130.701, 32.801], ids: ['c-1-2-1'], nonce: nextNonce() } })} />);
    expect(fit.mock.calls[0]![1]).toMatchObject({ paddingBottomRight: [32, 32] });
  });
});

describe('印の押せる大きさ（24px 以上。WCAG 2.2 の 2.5.8）', () => {
  it('印の箱（Leaflet のアイコン）は 24×24px。中心を箱の真ん中に合わせる', () => {
    const { container } = render(<LeafletMap {...props({ areas: wideAreas })} />);
    const marks = Array.from(container.querySelectorAll<HTMLElement>('.leaflet-marker-icon'));
    expect(marks).toHaveLength(3);
    for (const m of marks) {
      expect(m.style.width).toBe('24px');
      expect(m.style.height).toBe('24px');
      expect(m.style.marginLeft).toBe('-12px');
      expect(m.style.marginTop).toBe('-12px');
    }
  });

  it('選んだ・強調した印の箱も、同じ 24px', () => {
    const { container } = render(<LeafletMap {...props({ areas: wideAreas, selectedId: 'c-1-2-1', highlightIds: new Set(['c-1-2-2']) })} />);
    for (const m of Array.from(container.querySelectorAll<HTMLElement>('.leaflet-marker-icon'))) expect(m.style.width).toBe('24px');
  });
});

describe('「動きを減らす」設定（prefers-reduced-motion）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function boot(reduce: boolean, over: Partial<LeafletMapProps> = {}) {
    stubReducedMotion(reduce);
    const mapOf = vi.spyOn(L, 'map');
    const view = render(<LeafletMap {...props({ areas: wideAreas, ...over })} />);
    return { ...view, map: mapOf.mock.results.at(-1)!.value as L.Map, mapOf };
  }

  it('設定していれば、拡大縮小・フェード・印の拡大縮小・ドラッグの慣性の動きを止める。していなければ、Leaflet の既定のまま', () => {
    const on = boot(true);
    expect(on.map.options).toMatchObject({ zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false, inertia: false });
    on.unmount();
    const off = boot(false);
    expect(off.map.options.zoomAnimation).toBe(true);
    expect(off.map.options.fadeAnimation).toBe(true);
    expect(off.map.options.markerZoomAnimation).toBe(true);
    expect(off.map.options.inertia).not.toBe(false);
  });

  it('パン（キーボードの矢印・慣性・寄せる動き）は、設定していれば、その場で済む。していなければ、動かし始めるだけ（アニメーション）', () => {
    const on = boot(true);
    const p0 = on.map.latLngToContainerPoint([32.8, 130.7]);
    on.map.panBy([0, 40]);
    expect(p0.y - on.map.latLngToContainerPoint([32.8, 130.7]).y).toBeCloseTo(40, 0);
    on.unmount();

    const off = boot(false);
    const q0 = off.map.latLngToContainerPoint([32.8, 130.7]);
    off.map.panBy([0, 40]);
    expect(q0.y - off.map.latLngToContainerPoint([32.8, 130.7]).y).toBeCloseTo(0, 0); // 動きの 1 コマ目。まだ動いていない
  });

  it('設定は、動かすたびに見る（地図を開いたあとに設定を替えても追従する）', () => {
    const { map } = boot(false);
    stubReducedMotion(true);
    const p0 = map.latLngToContainerPoint([32.8, 130.7]);
    map.panBy([0, 25]);
    expect(p0.y - map.latLngToContainerPoint([32.8, 130.7]).y).toBeCloseTo(25, 0);
  });

  it('寄せる要求（fitBounds）は、設定していれば animate: false。していなければ、animate を渡さない（Leaflet が状況で決める）', () => {
    stubReducedMotion(true);
    const fit = vi.spyOn(L.Map.prototype, 'fitBounds');
    const focus = { bbox: [130.7, 32.8, 130.701, 32.801] as [number, number, number, number], ids: ['c-1-2-1'], nonce: nextNonce() };
    const { unmount } = render(<LeafletMap {...props({ focus })} />);
    expect(fit.mock.calls[0]![1]).toMatchObject({ animate: false });
    unmount();
    stubReducedMotion(false);
    render(<LeafletMap {...props({ focus: { ...focus, nonce: nextNonce() } })} />);
    expect(fit.mock.calls[1]![1]).not.toHaveProperty('animate');
  });

  it('matchMedia が無い環境でも落ちない（動きは既定のまま）', () => {
    vi.stubGlobal('matchMedia', undefined);
    const { container } = render(<LeafletMap {...props()} />);
    expect(container.querySelector('.leaflet-container')).not.toBeNull();
  });
});

describe('回答の中の図（guardWheel）: ホイールで、ページのスクロールを奪わない', () => {
  // Leaflet の ScrollWheelZoom は、有効なあいだ、ホイールの事象を受け取ると preventDefault（ページのスクロールを止める）する。無効なら、触らない
  const wheel = (el: Element) => {
    const ev = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    return ev.defaultPrevented;
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('既定（拡大ビューの地図）は、ホイールで拡大・縮小する', () => {
    const { container } = render(<LeafletMap {...props()} />);
    expect(wheel(container.querySelector('.leaflet-container')!)).toBe(true);
  });

  it('guardWheel: フォーカスが地図に無いあいだは、ホイールを受け取らない（チャットをホイールで流せる）', () => {
    const { container } = render(<LeafletMap {...props({ guardWheel: true })} />);
    expect(wheel(container.querySelector('.leaflet-container')!)).toBe(false);
  });

  it('guardWheel: 地図へフォーカスが着く（押す・Tab で入る）と、ホイールで拡大・縮小できる。フォーカスが地図の外へ出ると、また止める。地図の中の移動では、止めない', () => {
    const { container } = render(<LeafletMap {...props({ guardWheel: true, areas: wideAreas })} />);
    const host = container.querySelector('.leaflet-container') as HTMLElement;
    fireEvent.focusIn(host);
    expect(wheel(host)).toBe(true);
    // 地図の中の別の部品へ移るだけ（relatedTarget が地図の中）なら、有効のまま
    const inner = host.querySelector('.leaflet-control-container') as HTMLElement;
    fireEvent.focusOut(host, { relatedTarget: inner });
    expect(wheel(host)).toBe(true);
    // 地図の外へ
    fireEvent.focusOut(host, { relatedTarget: document.body });
    expect(wheel(host)).toBe(false);
    fireEvent.focusIn(host);
    fireEvent.focusOut(host, { relatedTarget: null });
    expect(wheel(host)).toBe(false);
  });

  it('アンマウントで、地図に付けた focusin・focusout の処理を片付ける（片付けた地図に触れない）', () => {
    const { container, unmount } = render(<LeafletMap {...props({ guardWheel: true })} />);
    const host = container.querySelector('.leaflet-container') as HTMLElement;
    unmount();
    expect(() => {
      fireEvent.focusIn(host);
      fireEvent.focusOut(host, { relatedTarget: null });
    }).not.toThrow();
  });
});
