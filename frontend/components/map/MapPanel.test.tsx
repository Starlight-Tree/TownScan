import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AreaSummary, CandidateClass, CandidateFeature } from '../../lib/api-types';
import { ApiError } from '../../lib/api';
import { nextNonce, type TileStatus } from '../../lib/map-config';
import { ALL_FILTER, type MapFilter } from '../../lib/result-view';
import type { AsyncState } from '../../lib/use-api';
import { MapPanel } from './MapPanel';

// 一覧（CandidateList）が取りに行く先。分類・地区の条件が、一覧の API の引数に渡るかを見る
const api = vi.hoisted(() => ({ getCandidates: vi.fn() }));
vi.mock('../../lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/api')>()), getCandidates: api.getCandidates }));

// 地図が受け取る coverRef（選択中のカードの要素。印がカードの下に隠れるとき、地図が上へ寄せるのに使う）を控える
const seen = vi.hoisted(() => ({ coverRef: null as { current: HTMLElement | null } | null }));
// Leaflet 本体は LeafletMap.test.tsx で確かめる。ここでは、MapPanel が地図へ渡す props と、地図の外の表示（集計の帯・現在表示・選択中のカード）を見る。
// 本物と同じく、.leaflet-host が地図の本体（印はこの中）
vi.mock('./LeafletMap', () => ({
  default: (p: {
    features: CandidateFeature[];
    focus: { bbox: number[]; ids: string[]; nonce: number } | null;
    onTileStatus: (s: TileStatus) => void;
    onZoom: (z: number) => void;
    coverRef?: { current: HTMLElement | null };
    guardWheel?: boolean;
    onAreaSelect: (areaId: string) => void;
  }) => {
    seen.coverRef = p.coverRef ?? null;
    return (
      <div
        data-testid="leaflet"
        className="leaflet-host"
        data-guard-wheel={String(p.guardWheel === true)}
        data-count={p.features.length}
        data-focus={p.focus ? 'fit' : ''}
        data-focus-keys={p.focus ? Object.keys(p.focus).sort().join(',') : ''}
        data-focus-bbox={p.focus ? p.focus.bbox.join(',') : ''}
        data-focus-nonce={p.focus ? p.focus.nonce : ''}
        tabIndex={0}
      >
        <button type="button" onClick={() => p.onAreaSelect('b')}>
          地区の枠（b）
        </button>
        {(['ok', 'partial', 'none'] as const).map((s) => (
          <button key={s} type="button" onClick={() => p.onTileStatus(s)}>
            タイル（{s}）
          </button>
        ))}
        {[15, 17].map((z) => (
          <button key={z} type="button" onClick={() => p.onZoom(z)}>
            ズーム（{z}）
          </button>
        ))}
      </div>
    );
  },
}));

function area(id: string, name: string, counts: [number, number, number]): AreaSummary {
  const [confirmed_new, existing_omission, uncertain] = counts;
  return {
    id,
    name,
    ward: '中央区',
    bbox: [130.7, 32.8, 130.701, 32.801],
    centroid: [130.7005, 32.8005],
    counts: { confirmed_new, existing_omission, uncertain, total: confirmed_new + existing_omission + uncertain },
  };
}
const areas = [area('a', 'アサヒ地区', [4, 4, 2]), area('b', 'ノース地区', [5, 3, 1])];

function feature(id: string, cls: CandidateFeature['properties']['class'], area_id: string): CandidateFeature {
  return {
    type: 'Feature',
    id,
    geometry: { type: 'Polygon', coordinates: [[[130.7, 32.8], [130.7001, 32.8], [130.7001, 32.8001], [130.7, 32.8001], [130.7, 32.8]]] },
    properties: { id, class: cls, area_m2: 50, area_id },
  };
}
const features = [feature('c-1', 'confirmed_new', 'a'), feature('c-2', 'confirmed_new', 'a'), feature('c-3', 'uncertain', 'b')];

interface SetupOptions {
  filter?: MapFilter;
  onFilterChange?: (f: MapFilter) => void;
  candidates?: 'ready' | 'loading' | 'error';
  areasFail?: boolean;
  areas?: AreaSummary[];
  features?: CandidateFeature[];
  selectedId?: string | null;
  onComparePhotos?: (id: string) => void;
}

const failure = (message: string) => ({ status: 'error', error: new ApiError(message, 503, 'db_down') }) as const;

function propsFor(over: SetupOptions = {}) {
  const list = over.areas ?? areas;
  const candidatesState: AsyncState<CandidateFeature[]> =
    over.candidates === 'loading'
      ? { status: 'loading' }
      : over.candidates === 'error'
        ? failure('DB に接続できません。')
        : { status: 'ready', data: over.features ?? features };
  return {
    areas: list,
    areasState: (over.areasFail ? failure('地区が読めません。') : { status: 'ready', data: list }) as AsyncState<AreaSummary[]>,
    candidatesState,
    reloadCandidates: vi.fn(),
    reloadAreas: vi.fn(),
    focus: null,
    selectedId: over.selectedId ?? null,
    highlightIds: new Set<string>(),
    onSelect: vi.fn(),
    onOpen: vi.fn(),
    onClearHighlight: vi.fn(),
    filter: over.filter,
    onFilterChange: over.onFilterChange,
    onComparePhotos: over.onComparePhotos,
  };
}

function setup(over: SetupOptions = {}) {
  const props = propsFor(over);
  return { ...render(<MapPanel {...props} />), props };
}

beforeEach(() => {
  api.getCandidates.mockReset();
  api.getCandidates.mockResolvedValue({ total: 0, items: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// 帯（.map-status）の中の 1 つの文（.map-status__text）に、現在表示・案内・通知を流し込む。最初の子が、現在表示の文
const status = () => document.querySelector('.map-status__text')!.firstElementChild!.textContent;

describe('地図の下の「現在表示」', () => {
  it('選んだ地図の種類と候補の件数。初期は 2023 年の写真', async () => {
    setup();
    expect(status()).toBe('表示中: 2023 年の写真・候補 3 件');
    await userEvent.click(screen.getByRole('button', { name: '標準地図' }));
    expect(status()).toBe('表示中: 標準地図・候補 3 件');
    await userEvent.click(screen.getByRole('button', { name: '2018 年の写真' }));
    expect(status()).toBe('表示中: 2018 年の写真・候補 3 件');
  });

  it('写真が一部しか無いとき・まったく無いときは、実際に見えているものを言い、既存の注意書き（role=status）も残す', async () => {
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'タイル（partial）' }));
    expect(status()).toBe('表示中: 2023 年の写真（一部は標準地図）・候補 3 件');
    expect(screen.getByRole('status')).toHaveTextContent('この範囲の一部には、この年の写真がありません');

    await userEvent.click(screen.getByRole('button', { name: 'タイル（none）' }));
    expect(status()).toBe('表示中: 標準地図（この範囲には 2023 年の写真がありません）・候補 3 件');
    expect(screen.getByRole('status')).toHaveTextContent('この範囲には、この年の写真がありません');

    await userEvent.click(screen.getByRole('button', { name: 'タイル（ok）' }));
    expect(status()).toBe('表示中: 2023 年の写真・候補 3 件');
    // 通知の入れ物は、いつも描く（文だけを替える）。文が無いあいだは空
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('標準地図を選んでいれば、タイルの状態に関わらず「標準地図」', async () => {
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'タイル（none）' }));
    await userEvent.click(screen.getByRole('button', { name: '標準地図' }));
    expect(status()).toBe('表示中: 標準地図・候補 3 件');
  });

  it('候補がまだ届いていないときは、0 件とは言わない', () => {
    setup({ candidates: 'loading' });
    expect(status()).toBe('表示中: 2023 年の写真・候補はまだ表示できていません');
  });

  it('候補の件数は、絞り込み後の件数', () => {
    setup({ filter: { areaId: '', classes: new Set(['uncertain']) } });
    expect(status()).toBe('表示中: 2023 年の写真・候補 1 件');
  });

  it('標準地図を選んでいれば、タイルが無い範囲でも、「この年の写真がありません」の通知は出ない（通知の入れ物は空のまま）', async () => {
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'タイル（none）' }));
    expect(screen.getByRole('status')).toHaveTextContent('この範囲には、この年の写真がありません');
    await userEvent.click(screen.getByRole('button', { name: '標準地図' }));
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(document.body).not.toHaveTextContent('この年の写真がありません');
    // 写真へ戻せば、また出る（標準地図のときだけ抑える）
    await userEvent.click(screen.getByRole('button', { name: '2018 年の写真' }));
    expect(screen.getByRole('status')).toHaveTextContent('この範囲には、この年の写真がありません');
  });

  it('「強調表示を解除」は、強調している候補があるときだけ出る。押すと onClearHighlight', async () => {
    const props = propsFor();
    const { rerender } = render(<MapPanel {...props} />);
    expect(screen.queryByRole('button', { name: '強調表示を解除' })).not.toBeInTheDocument();
    rerender(<MapPanel {...props} highlightIds={new Set(['c-1'])} />);
    await userEvent.click(screen.getByRole('button', { name: '強調表示を解除' }));
    expect(props.onClearHighlight).toHaveBeenCalledTimes(1);
    rerender(<MapPanel {...props} highlightIds={new Set<string>()} />);
    expect(screen.queryByRole('button', { name: '強調表示を解除' })).not.toBeInTheDocument();
  });

  it('現在表示の帯は、現在表示・解除のボタン・案内・通知を、1 つの文（.map-status__text）に流し込む。項目ごとの折り返しの箱にしない', async () => {
    const props = propsFor();
    render(<MapPanel {...props} highlightIds={new Set(['c-1'])} />);
    await userEvent.click(screen.getByRole('button', { name: 'タイル（partial）' }));
    const text = document.querySelector('.map-status > .map-status__text')!;
    expect(document.querySelector('.map-status')!.children).toHaveLength(1);
    expect(within(text as HTMLElement).getByRole('button', { name: '強調表示を解除' })).toBeInTheDocument();
    expect(text).toHaveTextContent('印・形を選ぶと「写真を比べる」が出ます。');
    expect(within(text as HTMLElement).getByRole('status')).toHaveTextContent('この範囲の一部には、この年の写真がありません');
  });

  it('タイルの通知の入れ物（role=status）は、通知が無いときも描いてある。同じ要素の文だけが替わる（文と同時に挿入された領域は、読み上げられないことがある）', async () => {
    setup();
    const note = screen.getByRole('status'); // 通知が出る前から、ある
    expect(note).toBeEmptyDOMElement();
    await userEvent.click(screen.getByRole('button', { name: 'タイル（partial）' }));
    expect(screen.getByRole('status')).toBe(note);
    expect(note).toHaveTextContent('この範囲の一部には');
    await userEvent.click(screen.getByRole('button', { name: 'タイル（ok）' }));
    expect(screen.getByRole('status')).toBe(note);
    expect(note).toBeEmptyDOMElement();
  });
});

describe('ツールバーの並び（DOM の順 = Tab の順 = 見た目の順）', () => {
  it('地図の見せ方（種類 → 解析した地区の枠）、対象の地区（地区の選択 → 表示範囲を戻す）の順。狭い幅で折り返しても、地区の選択に 1 行ぶんの幅が回る', () => {
    setup();
    const bar = document.querySelector('.map-toolbar')!;
    const order = Array.from(bar.querySelectorAll<HTMLElement>('button, input, select')).map((el) =>
      el.matches('select') ? '地区の選択' : el.matches('input') ? el.closest('label')!.textContent!.trim() : el.textContent,
    );
    expect(order).toEqual(['2023 年の写真', '2018 年の写真', '標準地図', '解析した地区の枠', '地区の選択', '表示範囲を戻す']);
  });
});

describe('集計の帯（分類の件数が、そのまま表示の切り替え）', () => {
  it('地図の上に、全地区の件数の集計の帯を出す（質問しなくても見える）', () => {
    setup();
    const strip = screen.getByRole('group', { name: '件数の集計' });
    expect(strip).toHaveTextContent('全 2 地区');
    expect(strip).toHaveTextContent('2018 年は未検出9');
    // 表示の切り替え（チェックボックス）が、数字のそばにある
    const classes = within(strip).getByRole('group', { name: /表示する分類/ });
    expect(within(classes).getAllByRole('checkbox')).toHaveLength(3);
    expect(within(classes).getByText('9')).toBeInTheDocument();
  });

  it('地図に重ねる凡例（fieldset・legend）は無い。分類の切り替えは、集計の帯の中のチェックボックスだけ（二重に出さない）', () => {
    setup();
    expect(document.querySelector('fieldset')).toBeNull();
    expect(document.querySelector('legend')).toBeNull();
    expect(document.querySelector('.legend')).toBeNull();
    expect(screen.getAllByRole('checkbox', { name: /2018 年は未検出/ })).toHaveLength(1);
    const stage = document.querySelector<HTMLElement>('.map-stage')!;
    expect(within(stage).queryByRole('checkbox', { name: /2018 年は未検出|2018 年も検出|未判定/ })).not.toBeInTheDocument();
    // 「表示する分類」は 1 つのグループで、集計の帯の中にある
    const group = screen.getByRole('group', { name: '表示する分類（色・線・形で区別）' });
    expect(screen.getByRole('group', { name: '件数の集計' })).toContainElement(group);
  });

  it('分類ごとの選択肢は、印（色・線・形）・短い名前・件数のラベルの中のチェックボックス。分類の名前でチェックボックスを探せる', () => {
    setup();
    const group = screen.getByRole('group', { name: /表示する分類/ });
    const items = Array.from(group.querySelectorAll('li'));
    expect(items.map((li) => li.getAttribute('data-class'))).toEqual(['confirmed_new', 'existing_omission', 'uncertain']);
    for (const li of items) {
      const label = li.querySelector('label')!;
      expect(label.querySelector('input[type="checkbox"]')).not.toBeNull();
      expect(label.querySelector('svg.class-swatch')).not.toBeNull();
    }
    expect(screen.getByRole('checkbox', { name: /2018 年は未検出/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /2018 年も検出/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /未判定/ })).toBeChecked();
    // 分類の全文（旧写真に無い、など）は、ラベルの title に残す
    expect(items[0]!.querySelector('label')).toHaveAttribute('title', '2018 年は未検出');
  });

  it('チェックの状態は、渡された絞り込みに従う。外した分類は（非表示）と言う（チェックが外れているので、読み上げでは重ねない）', () => {
    setup({ filter: { areaId: '', classes: new Set<CandidateClass>(['confirmed_new']) } });
    expect(screen.getByRole('checkbox', { name: /2018 年は未検出/ })).toBeChecked();
    const omit = screen.getByRole('checkbox', { name: /2018 年も検出/ });
    expect(omit).not.toBeChecked();
    expect(omit.closest('li')).toHaveTextContent('（非表示）');
    expect(omit).toHaveAccessibleName('2018 年も検出、7 件');
  });

  it('分類を外すと、集計の帯に「表示中」の差と「条件を解除」が出る。解除すると全部に戻る（親が持つ絞り込みにも伝える）', async () => {
    const onFilterChange = vi.fn();
    setup({ onFilterChange });
    await userEvent.click(screen.getByRole('checkbox', { name: /未判定/ }));
    expect(onFilterChange).toHaveBeenLastCalledWith(expect.objectContaining({ areaId: '' }));
    const strip = screen.getByRole('group', { name: '件数の集計' });
    expect(strip).toHaveTextContent('全 19 件のうち、表示中 16 件');
    // 解除（自分で持つ絞り込みでも、全部に戻る）
    await userEvent.click(within(strip).getByRole('button', { name: '条件を解除' }));
    expect(onFilterChange).toHaveBeenLastCalledWith(ALL_FILTER);
    expect(screen.queryByRole('button', { name: '条件を解除' })).not.toBeInTheDocument();
    expect(screen.getByTestId('leaflet')).toHaveAttribute('data-count', '3');
  });

  it('親が渡した絞り込み（地区）を、集計の帯・地区の選択・地図へ同じ条件で反映する', () => {
    setup({ filter: { areaId: 'b', classes: new Set(['confirmed_new', 'existing_omission', 'uncertain']) } });
    const strip = screen.getByRole('group', { name: '件数の集計' });
    expect(strip).toHaveTextContent('対象ノース地区');
    expect(screen.getByRole('combobox', { name: '地区' })).toHaveValue('b');
    expect(screen.getByTestId('leaflet')).toHaveAttribute('data-count', '1');
  });
});

describe('地図の寄せ方（詳細は地図に重ならない）', () => {
  it('地区を選んで寄せるとき、右端をあける欄（padRight）を渡さない。画面が広く、候補を選んでいても同じ', async () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1600);
    const props = {
      areas,
      areasState: { status: 'ready', data: areas } as const,
      candidatesState: { status: 'ready', data: features } as const,
      reloadCandidates: vi.fn(),
      reloadAreas: vi.fn(),
      focus: null,
      selectedId: 'c-1',
      highlightIds: new Set<string>(),
      onSelect: vi.fn(),
      onOpen: vi.fn(),
      onClearHighlight: vi.fn(),
    };
    render(<MapPanel {...props} />);
    await act(async () => {
      await userEvent.selectOptions(screen.getByRole('combobox', { name: '地区' }), 'b');
    });
    const map = screen.getByTestId('leaflet');
    expect(map).toHaveAttribute('data-focus', 'fit');
    expect(map).toHaveAttribute('data-focus-keys', 'bbox,ids,nonce');
  });
});

// 分類ごとの件数（集計の帯の中の数字）を、表示順（2018 年は未検出・2018 年も検出・未判定）で読む
const classCounts = () =>
  Array.from(screen.getByRole('group', { name: /表示する分類/ }).querySelectorAll('li strong')).map((e) => e.textContent);

describe('地区を選んだときの件数と絞り込み', () => {
  it('分類ごとの件数は、選んだ地区だけの数になる（全地区の数のままにしない）', async () => {
    setup();
    expect(classCounts()).toEqual(['9', '7', '3']); // アサヒ [4,4,2] + ノース [5,3,1]
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '地区' }), 'b');
    expect(classCounts()).toEqual(['5', '3', '1']);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '地区' }), '');
    expect(classCounts()).toEqual(['9', '7', '3']);
  });

  it('地区を選んだまま分類を切り替えても、地区の絞り込み（areaId）は保たれる', async () => {
    const onFilterChange = vi.fn();
    setup({ onFilterChange });
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '地区' }), 'b');
    expect(onFilterChange).toHaveBeenLastCalledWith(expect.objectContaining({ areaId: 'b' }));
    await userEvent.click(screen.getByRole('checkbox', { name: /未判定/ }));
    const next = onFilterChange.mock.calls.at(-1)![0] as MapFilter;
    expect(next.areaId).toBe('b');
    expect([...next.classes].sort()).toEqual(['confirmed_new', 'existing_omission']);
    // 地図・集計の帯にも、その地区のまま反映される
    expect(screen.getByRole('group', { name: '件数の集計' })).toHaveTextContent('対象ノース地区');
  });
});

describe('複数の地区（区など。areaIds）の絞り込み', () => {
  // 3 地区（a・b・c）のうち、中央区は a・b。候補は c にも 1 件ある
  const three = [...areas, area('c', 'ミナミ地区', [10, 0, 0])];
  const inC = feature('c-4', 'confirmed_new', 'c');
  const wardFilter = (over: Partial<MapFilter> = {}): MapFilter => ({ ...ALL_FILTER, areaIds: ['a', 'b'], scope: '中央区', ...over });
  const setupWard = (over: Parameters<typeof setup>[0] = {}) =>
    setup({ areas: three, features: [...features, inC], filter: wardFilter(), ...over });

  it('地図に出す候補を、対象の地区だけにする（c の候補は出ない）。「現在表示」の件数も同じ', () => {
    setupWard();
    expect(screen.getByTestId('leaflet')).toHaveAttribute('data-count', '3');
    expect(status()).toBe('表示中: 2023 年の写真・候補 3 件');
  });

  it('分類ごとの件数と集計の帯は、対象の地区の和（c の 10 件は入らない）。対象は API の名前（scope）', () => {
    setupWard();
    expect(classCounts()).toEqual(['9', '7', '3']);
    const strip = screen.getByRole('group', { name: '件数の集計' });
    expect(strip).toHaveTextContent('対象中央区');
    expect(strip).not.toHaveTextContent('全 3 地区');
    expect(strip).toHaveTextContent('2018 年は未検出9');
  });

  it('地区の選択ボックスは、先頭に「{scope}（複数の地区）」を選択済みで出す。選び直しても何も変えない', async () => {
    const onFilterChange = vi.fn();
    setupWard({ onFilterChange });
    const select = screen.getByRole('combobox', { name: '地区' });
    expect(select).toHaveDisplayValue('中央区（複数の地区）');
    expect(within(select).getAllByRole('option')[0]).toHaveTextContent('中央区（複数の地区）');
    await userEvent.selectOptions(select, within(select).getAllByRole('option')[0]!);
    expect(onFilterChange).not.toHaveBeenCalled();
    expect(select).toHaveDisplayValue('中央区（複数の地区）');
  });

  it('複数の地区の条件でなければ、その項目は出さない', () => {
    setup();
    expect(within(screen.getByRole('combobox', { name: '地区' })).queryByRole('option', { name: /複数の地区/ })).not.toBeInTheDocument();
  });

  it('ほかの地区を選ぶと、areaIds・scope を消して単一の地区へ。分類の絞り込みは保つ', async () => {
    const onFilterChange = vi.fn();
    const classes = new Set<CandidateClass>(['confirmed_new', 'uncertain']);
    setupWard({ onFilterChange, filter: wardFilter({ classes }) });
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '地区' }), 'c');
    const next = onFilterChange.mock.calls.at(-1)![0] as MapFilter;
    expect(next).toEqual({ areaId: 'c', classes });
    expect(next).not.toHaveProperty('areaIds');
    expect(next).not.toHaveProperty('scope');
    // 選んだ地区へ寄せる
    expect(screen.getByTestId('leaflet')).toHaveAttribute('data-focus', 'fit');
  });

  it('「すべて」を選ぶと、全地区へ（areaIds・scope も消える）', async () => {
    const onFilterChange = vi.fn();
    setupWard({ onFilterChange });
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '地区' }), '');
    const next = onFilterChange.mock.calls.at(-1)![0] as MapFilter;
    expect(next.areaId).toBe('');
    expect(next).not.toHaveProperty('areaIds');
    expect(next).not.toHaveProperty('scope');
  });

  it('分類を切り替えても、複数の地区の条件（areaIds・scope）は保つ', async () => {
    const onFilterChange = vi.fn();
    setupWard({ onFilterChange });
    await userEvent.click(screen.getByRole('checkbox', { name: /未判定/ }));
    const next = onFilterChange.mock.calls.at(-1)![0] as MapFilter;
    expect(next.areaIds).toEqual(['a', 'b']);
    expect(next.scope).toBe('中央区');
  });

  it('「条件を解除」は ALL_FILTER に戻す', async () => {
    const onFilterChange = vi.fn();
    setupWard({ onFilterChange });
    await userEvent.click(within(screen.getByRole('group', { name: '件数の集計' })).getByRole('button', { name: '条件を解除' }));
    expect(onFilterChange).toHaveBeenLastCalledWith(ALL_FILTER);
  });

  it('候補の一覧は、地区が複数のとき本体を出さず、「地区を 1 つに絞ると、一覧が出ます」と言う（API は地区を 1 つしか受けない）', async () => {
    setupWard();
    const details = document.querySelector<HTMLDetailsElement>('.cand-list')!;
    await userEvent.click(within(details).getByText('候補を一覧で見る（面積の大きい順）'));
    expect(details).toHaveTextContent('地区を 1 つに絞ると、一覧が出ます');
    expect(within(details).queryByRole('list')).not.toBeInTheDocument();
  });
});

describe('選択中の候補のカード（印・形を選んでも地図に留まる。地図の中に重ねる）', () => {
  const group = () => screen.getByRole('group', { name: '選択中の候補' });
  /** 見えない読み上げの領域（地図の枠の中に、いつも描く） */
  const live = () => document.querySelector<HTMLElement>('.map-stage [aria-live="polite"]')!;

  it('選択中の候補があり、onComparePhotos があるとき: 「選択中の候補」・分類の印・ID・「写真を比べる」を出し、押すと ID つきで呼ぶ', async () => {
    const onComparePhotos = vi.fn();
    setup({ selectedId: 'c-3', onComparePhotos });
    expect(group()).toHaveTextContent('選択中の候補');
    expect(group().querySelector('.class-badge')).toHaveAttribute('data-class', 'uncertain');
    expect(group()).toHaveTextContent('未判定');
    expect(group()).toHaveTextContent('c-3');
    await userEvent.click(within(group()).getByRole('button', { name: '写真を比べる' }));
    expect(onComparePhotos).toHaveBeenCalledTimes(1);
    expect(onComparePhotos).toHaveBeenCalledWith('c-3');
  });

  it('カードは地図の枠（map-stage）の子で、地図の本体（.leaflet-host。印はこの中）より後ろにある。枠の外に差し込まない（地図が縮まず、押した印が動かない）', () => {
    setup({ selectedId: 'c-1', onComparePhotos: vi.fn() });
    const stage = document.querySelector<HTMLElement>('.map-stage')!;
    expect(group().parentElement).toBe(stage);
    const host = screen.getByTestId('leaflet');
    expect(host.parentElement).toBe(stage);
    expect(host.compareDocumentPosition(group()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(host).not.toContainElement(group());
    // 地図の外（パネルの直下の帯）には、カードを置かない
    expect(document.querySelector('.map-panel > .map-selected')).toBeNull();
  });

  it('カードが出ても、地図の枠の前後の部品の数・順は同じ（地図を押し下げる帯が増えない）', () => {
    const { unmount } = setup({ onComparePhotos: vi.fn() });
    const names = () => Array.from(document.querySelector('.map-panel')!.children).map((e) => e.className);
    const before = names();
    unmount();
    setup({ selectedId: 'c-1', onComparePhotos: vi.fn() });
    expect(names()).toEqual(before);
  });

  it('地図へ、カードの要素を渡す（coverRef）。カードが出ているあいだだけ、その要素を指す（印がカードの下に隠れるとき、地図が上へ寄せる）', () => {
    const onComparePhotos = vi.fn();
    const { rerender } = setup({ onComparePhotos });
    expect(seen.coverRef).not.toBeNull();
    expect(seen.coverRef!.current).toBeNull();
    rerender(<MapPanel {...propsFor({ selectedId: 'c-1', onComparePhotos })} />);
    expect(seen.coverRef!.current).toBe(document.querySelector('.map-selected'));
    expect(seen.coverRef!.current).not.toBeNull();
    rerender(<MapPanel {...propsFor({ selectedId: null, onComparePhotos })} />);
    expect(seen.coverRef!.current).toBeNull();
  });

  it('onComparePhotos が無ければ、カードを出さない', () => {
    setup({ selectedId: 'c-1' });
    expect(screen.queryByRole('group', { name: '選択中の候補' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '写真を比べる' })).not.toBeInTheDocument();
  });

  it('選択が無い・地図の候補データに無い ID・候補がまだ届いていないときは、出さない', () => {
    const { unmount } = setup({ selectedId: null, onComparePhotos: vi.fn() });
    expect(screen.queryByRole('button', { name: '写真を比べる' })).not.toBeInTheDocument();
    unmount();
    const second = setup({ selectedId: 'zzz', onComparePhotos: vi.fn() });
    expect(screen.queryByRole('button', { name: '写真を比べる' })).not.toBeInTheDocument();
    second.unmount();
    setup({ selectedId: 'c-1', onComparePhotos: vi.fn(), candidates: 'loading' });
    expect(screen.queryByRole('button', { name: '写真を比べる' })).not.toBeInTheDocument();
  });

  it('分類の絞り込みで地図から外れた候補でも、候補データにあればカードに出す', () => {
    setup({ selectedId: 'c-1', onComparePhotos: vi.fn(), filter: { areaId: '', classes: new Set(['uncertain']) } });
    expect(screen.getByTestId('leaflet')).toHaveAttribute('data-count', '1');
    expect(group()).toHaveTextContent('c-1');
  });

  it('案内の文は、「写真を比べる」が出ると言う（詳細が開く、とは言わない）。地図の下の 1 行の帯の中', () => {
    setup();
    const hint = document.querySelector('.map-status__hint');
    expect(hint).toHaveTextContent('印・形を選ぶと「写真を比べる」が出ます。');
    expect(hint?.closest('.map-status')).not.toBeNull();
    expect(document.body).not.toHaveTextContent('詳細が開きます');
  });

  describe('読み上げ（見えない polite の live region）', () => {
    it('いつも描く。選んでいないあいだは空', () => {
      setup({ onComparePhotos: vi.fn() });
      expect(live()).toBeInTheDocument();
      expect(live()).toBeEmptyDOMElement();
      expect(live()).toHaveAttribute('aria-live', 'polite');
      expect(live()).toHaveAttribute('aria-atomic', 'true');
      expect(live()).toHaveClass('visually-hidden');
    });

    it('印を選ぶと「候補 {id} を選びました。「写真を比べる」で写真を比べられます」を出す。別の候補へ替えると文が替わり、外れると空に戻る', () => {
      const onComparePhotos = vi.fn();
      const { rerender } = setup({ onComparePhotos });
      expect(live()).toBeEmptyDOMElement();
      rerender(<MapPanel {...propsFor({ selectedId: 'c-3', onComparePhotos })} />);
      expect(live()).toHaveTextContent('候補 c-3 を選びました。「写真を比べる」で写真を比べられます。');
      rerender(<MapPanel {...propsFor({ selectedId: 'c-1', onComparePhotos })} />);
      expect(live()).toHaveTextContent('候補 c-1 を選びました。');
      expect(live()).not.toHaveTextContent('c-3');
      rerender(<MapPanel {...propsFor({ selectedId: null, onComparePhotos })} />);
      expect(live()).toBeEmptyDOMElement();
    });

    it('カードを出さないとき（onComparePhotos が無い・候補データに無い ID）は、言わない（押せないボタンを案内しない）', () => {
      const { unmount } = setup({ selectedId: 'c-1' });
      expect(live()).toBeEmptyDOMElement();
      unmount();
      setup({ selectedId: 'zzz', onComparePhotos: vi.fn() });
      expect(live()).toBeEmptyDOMElement();
    });

    it('role=status は持たない（地図の下のタイルの通知の role=status と、1 つに決まらなくなる）', () => {
      setup({ selectedId: 'c-1', onComparePhotos: vi.fn() });
      expect(live()).not.toHaveAttribute('role');
      // role=status は、地図の下のタイルの通知の 1 つだけ（空のまま。候補の選択では読み上げない）
      expect(screen.getAllByRole('status')).toHaveLength(1);
      expect(screen.getByRole('status')).toBeEmptyDOMElement();
    });
  });
});

describe('地図の下の 1 行の帯（現在表示・案内・通知）と、地図の上の読み込み・失敗', () => {
  const stage = () => document.querySelector<HTMLElement>('.map-stage')!;
  const statusBar = () => document.querySelector<HTMLElement>('.map-status')!;

  it('タイルの通知は、地図の上に重ねず、地図の下の帯の補足にする。読み上げられる（role=status）', async () => {
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'タイル（partial）' }));
    const note = screen.getByRole('status');
    expect(note).toHaveTextContent('この範囲の一部には、この年の写真がありません（標準地図を表示しています）。');
    expect(statusBar()).toContainElement(note);
    expect(stage()).not.toContainElement(note);
    // 通知の文が変わっても、同じ要素で替わる（読み上げの対象になる）
    await userEvent.click(screen.getByRole('button', { name: 'タイル（none）' }));
    expect(screen.getByRole('status')).toBe(note);
    expect(note).toHaveTextContent('この範囲には、この年の写真がありません');
  });

  it('「候補は印で表示しています」も、地図の下の帯の補足。印で見えるズームのときだけ（拡大して形になったら消える）', async () => {
    setup();
    expect(document.body).not.toHaveTextContent('候補は印で表示しています');
    await userEvent.click(screen.getByRole('button', { name: 'ズーム（15）' }));
    const note = within(statusBar()).getByText('候補は印で表示しています。拡大すると建物の形が見えます。');
    expect(stage()).not.toContainElement(note);
    await userEvent.click(screen.getByRole('button', { name: 'ズーム（17）' }));
    expect(document.body).not.toHaveTextContent('候補は印で表示しています');
  });

  it('候補が 0 件のときの文も、地図の下の帯の補足（地図を覆わない）', () => {
    setup({ features: [] });
    expect(within(statusBar()).getByText('表示できる候補がありません。')).toBeInTheDocument();
    expect(stage()).not.toHaveTextContent('表示できる候補がありません');
  });

  it('現在表示の文が、帯の最初の子。通知・案内が増えても、地図の上の重なり（.map-overlay-top）は作らない', async () => {
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'タイル（partial）' }));
    await userEvent.click(screen.getByRole('button', { name: 'ズーム（15）' }));
    expect(status()).toBe('表示中: 2023 年の写真（一部は標準地図）・候補 3 件');
    expect(document.querySelector('.map-overlay-top')).toBeNull();
    expect(document.querySelector('.map-note')).toBeNull();
  });

  it('候補の読み込み中は、地図の上に小さく 1 つだけ（role=status）', () => {
    setup({ candidates: 'loading' });
    const overlay = stage().querySelector('.map-overlay-top')!;
    expect(overlay.querySelectorAll('.map-note')).toHaveLength(1);
    expect(within(overlay as HTMLElement).getByRole('status')).toHaveTextContent('候補を読み込んでいます…');
  });

  it('候補の失敗は、地図の上に 1 つだけ（role=alert）。再試行で、候補だけを取り直す', async () => {
    const { props } = setup({ candidates: 'error' });
    const overlay = stage().querySelector<HTMLElement>('.map-overlay-top')!;
    expect(overlay.querySelectorAll('.map-note')).toHaveLength(1);
    const alert = within(overlay).getByRole('alert');
    expect(alert).toHaveTextContent('候補を読み込めませんでした（DB に接続できません。）');
    await userEvent.click(within(alert).getByRole('button', { name: '再試行' }));
    expect(props.reloadCandidates).toHaveBeenCalledTimes(1);
    expect(props.reloadAreas).not.toHaveBeenCalled();
  });

  it('地区の一覧だけが失敗したときも、1 つだけ。再試行は地区の一覧だけを取り直す', async () => {
    const { props } = setup({ areasFail: true });
    const alert = within(stage()).getByRole('alert');
    expect(alert).toHaveTextContent('地区の一覧を読み込めませんでした（地区が読めません。）');
    await userEvent.click(within(alert).getByRole('button', { name: '再試行' }));
    expect(props.reloadAreas).toHaveBeenCalledTimes(1);
    expect(props.reloadCandidates).not.toHaveBeenCalled();
  });

  it('候補と地区の一覧が両方失敗しても、地図の上には 1 つだけ。再試行は両方を取り直す', async () => {
    const { props } = setup({ candidates: 'error', areasFail: true });
    expect(within(stage()).getAllByRole('alert')).toHaveLength(1);
    expect(stage().querySelectorAll('.map-note')).toHaveLength(1);
    const alert = within(stage()).getByRole('alert');
    expect(alert).toHaveTextContent('候補と地区の一覧を読み込めませんでした');
    await userEvent.click(within(alert).getByRole('button', { name: '再試行' }));
    expect(props.reloadCandidates).toHaveBeenCalledTimes(1);
    expect(props.reloadAreas).toHaveBeenCalledTimes(1);
  });

  it('失敗のとき、読み込み中の文は重ねない（1 つだけ）', () => {
    setup({ candidates: 'error' });
    expect(screen.queryByText('候補を読み込んでいます…')).not.toBeInTheDocument();
  });
});

describe('ツールバー（地図の種類・地区・解析した地区の枠を 1 つの帯に）', () => {
  it('3 つとも、同じ .map-toolbar の中にある（折り返しは CSS）。地図の種類のボタン 3 つのほか、「表示範囲を戻す」が 1 つ', () => {
    setup();
    const toolbar = document.querySelector<HTMLElement>('.map-toolbar')!;
    expect(within(toolbar).getByRole('group', { name: '地図の種類' })).toBeInTheDocument();
    expect(within(toolbar).getAllByRole('button')).toHaveLength(4);
    expect(within(toolbar).getByRole('button', { name: '表示範囲を戻す' })).toBeInTheDocument();
    expect(within(toolbar).getByRole('combobox', { name: '地区' })).toBeInTheDocument();
    expect(within(toolbar).getByRole('checkbox', { name: '解析した地区の枠' })).toBeChecked();
  });
});

describe('一覧へ渡す分類（API は分類を 1 つしか受けない）', () => {
  const openList = async () => {
    await userEvent.click(document.querySelector('.cand-list > summary')!);
  };

  it('分類を 1 つだけ表示しているとき、一覧の getCandidates に cls が 1 つ渡る（地区の条件も）', async () => {
    setup({ filter: { areaId: 'a', classes: new Set<CandidateClass>(['uncertain']) } });
    await openList();
    await waitFor(() => expect(api.getCandidates).toHaveBeenCalledTimes(1));
    expect(api.getCandidates).toHaveBeenCalledWith({ area_id: 'a', cls: 'uncertain', limit: 30 }, expect.anything());
  });

  it('分類を 2 つ以上表示しているとき（2 つ・3 つ）は、cls を渡さない（null）', async () => {
    const { unmount } = setup({ filter: { areaId: 'a', classes: new Set<CandidateClass>(['uncertain', 'confirmed_new']) } });
    await openList();
    await waitFor(() => expect(api.getCandidates).toHaveBeenCalledTimes(1));
    expect(api.getCandidates).toHaveBeenLastCalledWith({ area_id: 'a', cls: null, limit: 30 }, expect.anything());
    unmount();
    setup({ filter: { areaId: 'a', classes: new Set<CandidateClass>(['uncertain', 'confirmed_new', 'existing_omission']) } });
    await openList();
    await waitFor(() => expect(api.getCandidates).toHaveBeenCalledTimes(2));
    expect(api.getCandidates).toHaveBeenLastCalledWith({ area_id: 'a', cls: null, limit: 30 }, expect.anything());
  });

  it('集計の帯のチェックで分類を 1 つに絞ると、開いている一覧は、その分類で取り直す。2 つに戻すと、また取り直す', async () => {
    setup(); // 絞り込みは自分で持つ
    await openList();
    await waitFor(() => expect(api.getCandidates).toHaveBeenCalledTimes(1));
    expect(api.getCandidates).toHaveBeenLastCalledWith({ area_id: null, cls: null, limit: 30 }, expect.anything());

    await userEvent.click(screen.getByRole('checkbox', { name: /2018 年も検出/ })); // 2 つ残る: 条件は同じ
    await userEvent.click(screen.getByRole('checkbox', { name: /未判定/ })); // 1 つだけ残る
    await waitFor(() => expect(api.getCandidates).toHaveBeenCalledTimes(2));
    expect(api.getCandidates).toHaveBeenLastCalledWith({ area_id: null, cls: 'confirmed_new', limit: 30 }, expect.anything());

    await userEvent.click(screen.getByRole('checkbox', { name: /未判定/ })); // 2 つに戻す
    await waitFor(() => expect(api.getCandidates).toHaveBeenCalledTimes(3));
    expect(api.getCandidates).toHaveBeenLastCalledWith({ area_id: null, cls: null, limit: 30 }, expect.anything());
  });
});

describe('ランドマークの名前', () => {
  it('外側の tabpanel が「地図」なので、同じ名前の region を重ねない', () => {
    setup();
    expect(screen.queryByRole('region', { name: '地図' })).not.toBeInTheDocument();
  });
});

// ---- 絞り込みの地区と、地図の表示範囲 ----

describe('絞り込みの地区が替わったら、地図の表示範囲もそれに合わせる（どの経路でも）', () => {
  const spread = [
    { ...area('a', 'アサヒ地区', [4, 4, 2]), bbox: [130.7, 32.8, 130.71, 32.81] as [number, number, number, number] },
    { ...area('b', 'ノース地区', [5, 3, 1]), bbox: [130.8, 32.9, 130.81, 32.91] as [number, number, number, number] },
  ];
  const BOX_A = '130.7,32.8,130.71,32.81';
  const BOX_B = '130.8,32.9,130.81,32.91';
  const BOX_ALL = '130.7,32.8,130.81,32.91';
  const all = new Set<CandidateClass>(['confirmed_new', 'existing_omission', 'uncertain']);
  const only = (areaId: string, classes = all): MapFilter => ({ areaId, classes });
  const leaflet = () => screen.getByTestId('leaflet');

  function mount(filter: MapFilter) {
    const props: ComponentProps<typeof MapPanel> = propsFor({ areas: spread, filter });
    const view = render(<MapPanel {...props} />);
    const update = (over: Partial<ComponentProps<typeof MapPanel>> = {}) => view.rerender(<MapPanel {...props} {...over} />);
    return { ...view, props, update };
  }

  it('最初の描画では、地図を動かさない（初回の全地区への寄せは、地図が自分で行う）。地区を絞った条件で始まっても同じ', () => {
    mount(only('b'));
    expect(leaflet()).toHaveAttribute('data-focus', '');
  });

  it('グラフの行・チャットの回答など、親が地区の絞り込みを替えたら、その地区へ寄せる', () => {
    const { update } = mount(ALL_FILTER);
    update({ filter: only('b') });
    expect(leaflet()).toHaveAttribute('data-focus', 'fit');
    expect(leaflet()).toHaveAttribute('data-focus-bbox', BOX_B);
    update({ filter: only('a') });
    expect(leaflet()).toHaveAttribute('data-focus-bbox', BOX_A);
  });

  it('「条件を解除」・グラフで同じ行をもう一度押す（全地区へ戻る）と、全地区が収まる範囲へ戻す', () => {
    const { update } = mount(only('b'));
    update({ filter: ALL_FILTER });
    expect(leaflet()).toHaveAttribute('data-focus-bbox', BOX_ALL);
  });

  it('複数の地区（区など）の条件は、その地区の和へ寄せる。地区が 1 つに替わると、その地区へ', () => {
    const { update } = mount(ALL_FILTER);
    update({ filter: { areaId: '', classes: all, areaIds: ['a', 'b'], scope: '中央区' } });
    expect(leaflet()).toHaveAttribute('data-focus-bbox', BOX_ALL);
    update({ filter: only('a') });
    expect(leaflet()).toHaveAttribute('data-focus-bbox', BOX_A);
  });

  it('分類だけ替えても、地図は動かさない（地区が同じ）', () => {
    const { update } = mount(ALL_FILTER);
    update({ filter: only('', new Set<CandidateClass>(['uncertain'])) });
    expect(leaflet()).toHaveAttribute('data-focus', '');
  });

  it('同じ描画で、親が地図を動かす要求（候補の選択・チャットの地図表示）も渡したら、そちらを優先する（選んだ候補を、地区へ引き戻さない）', () => {
    const { update } = mount(only('a'));
    // 親が先に作った要求（HomeClient の fitTo と同じ順で nonce を取る）。地区の絞り込みを替えるのと同じ描画で届く
    update({ filter: ALL_FILTER, focus: { bbox: [130.7, 32.8, 130.7001, 32.8001], ids: ['c-1'], nonce: nextNonce() } });
    expect(leaflet()).toHaveAttribute('data-focus-bbox', '130.7,32.8,130.7001,32.8001');
  });

  it('地区の選択で「すべて」へ戻すと、全地区が収まる範囲へ寄せる（これまでは、地区のまま動かなかった）', async () => {
    const props = propsFor({ areas: spread });
    render(<MapPanel {...props} filter={undefined} />);
    const select = screen.getByRole('combobox', { name: '地区' });
    await userEvent.selectOptions(select, 'b');
    expect(leaflet()).toHaveAttribute('data-focus-bbox', BOX_B);
    await userEvent.selectOptions(select, '');
    expect(leaflet()).toHaveAttribute('data-focus-bbox', BOX_ALL);
    await userEvent.selectOptions(select, 'a');
    expect(leaflet()).toHaveAttribute('data-focus-bbox', BOX_A);
  });

  it('「条件を解除」を押すと、全地区の範囲へ戻る（絞り込みも全部に戻る）', async () => {
    const props = propsFor({ areas: spread });
    render(<MapPanel {...props} filter={undefined} />);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '地区' }), 'a');
    expect(leaflet()).toHaveAttribute('data-focus-bbox', BOX_A);
    await userEvent.click(screen.getByRole('button', { name: '条件を解除' }));
    expect(leaflet()).toHaveAttribute('data-focus-bbox', BOX_ALL);
    expect(screen.getByRole('combobox', { name: '地区' })).toHaveValue('');
  });

  describe('「表示範囲を戻す」', () => {
    it('全地区のときは全地区の範囲、地区を選んでいるときはその地区の範囲へ、地図を寄せ直す（拡大・移動で見失ったとき）', async () => {
      const props = propsFor({ areas: spread });
      render(<MapPanel {...props} filter={undefined} />);
      const reset = screen.getByRole('button', { name: '表示範囲を戻す' });
      await userEvent.click(reset);
      expect(leaflet()).toHaveAttribute('data-focus-bbox', BOX_ALL);
      const first = leaflet().getAttribute('data-focus-bbox');
      await userEvent.selectOptions(screen.getByRole('combobox', { name: '地区' }), 'b');
      await userEvent.click(reset);
      expect(leaflet()).toHaveAttribute('data-focus-bbox', BOX_B);
      expect(first).toBe(BOX_ALL);
    });

    it('押すたびに、新しい寄せの要求になる（同じ範囲でも、もう一度寄せ直す）。絞り込みは変えない', async () => {
      const onFilterChange = vi.fn();
      render(<MapPanel {...propsFor({ areas: spread, filter: only('b'), onFilterChange })} />);
      const nonce = () => Number(leaflet().getAttribute('data-focus-nonce'));
      await userEvent.click(screen.getByRole('button', { name: '表示範囲を戻す' }));
      const first = nonce();
      await userEvent.click(screen.getByRole('button', { name: '表示範囲を戻す' }));
      expect(nonce()).toBeGreaterThan(first);
      expect(onFilterChange).not.toHaveBeenCalled();
    });

    it('地区の一覧が無いあいだは押せない', () => {
      render(<MapPanel {...propsFor({ areas: [] })} />);
      expect(screen.getByRole('button', { name: '表示範囲を戻す' })).toBeDisabled();
    });
  });
});

// ---- 選択の解除 ----

describe('選択の解除（カードの「選択を解除」・Esc・地図の空いている所）', () => {
  const group = () => screen.getByRole('group', { name: '選択中の候補' });
  function mount(over: { selectedId?: string | null; withClear?: boolean } = {}) {
    const onClearSelection = vi.fn();
    const selectedId = 'selectedId' in over ? over.selectedId : 'c-1';
    const props = { ...propsFor({ selectedId, onComparePhotos: vi.fn() }), onClearSelection: over.withClear === false ? undefined : onClearSelection };
    render(<MapPanel {...props} />);
    return { onClearSelection };
  }

  it('カードに「選択を解除」を出し、押すと解除する。「写真を比べる」は残る', async () => {
    const { onClearSelection } = mount();
    expect(within(group()).getByRole('button', { name: '写真を比べる' })).toBeInTheDocument();
    await userEvent.click(within(group()).getByRole('button', { name: '選択を解除' }));
    expect(onClearSelection).toHaveBeenCalledTimes(1);
  });

  it('解除の手段を受け取っていなければ、ボタンを出さない（押しても何も起きないボタンを出さない）', () => {
    mount({ withClear: false });
    expect(within(group()).queryByRole('button', { name: '選択を解除' })).not.toBeInTheDocument();
  });

  it('押したボタン（カードの中）が消えるので、フォーカスは地図へ移す（body へ落とさない）', async () => {
    mount();
    await userEvent.click(within(group()).getByRole('button', { name: '選択を解除' }));
    expect(screen.getByTestId('leaflet')).toHaveFocus();
  });

  it('Esc で解除する。地図の中・カードの中のどちらにフォーカスがあっても（Esc の修飾キーつきは、ブラウザー・OS の操作なので奪わない）', async () => {
    const { onClearSelection } = mount();
    screen.getByTestId('leaflet').focus();
    await userEvent.keyboard('{Escape}');
    expect(onClearSelection).toHaveBeenCalledTimes(1);
    within(group()).getByRole('button', { name: '写真を比べる' }).focus();
    await userEvent.keyboard('{Escape}');
    expect(onClearSelection).toHaveBeenCalledTimes(2);
    await userEvent.keyboard('{Shift>}{Escape}{/Shift}');
    expect(onClearSelection).toHaveBeenCalledTimes(2);
  });

  it('選んでいる候補が無いとき、Esc では何もしない（地図の外の Esc も奪わない）', async () => {
    const { onClearSelection } = mount({ selectedId: null });
    screen.getByTestId('leaflet').focus();
    await userEvent.keyboard('{Escape}');
    expect(onClearSelection).not.toHaveBeenCalled();
  });
});

describe('回答の中の図として使う（inline）と、2 つの地図パネルが同時にあるとき', () => {
  it('inline のときだけ、地図へ guardWheel を渡す（チャットのスクロールの中で、ホイールでページのスクロールを奪わない）。拡大ビューの中（inline なし）では、渡さない', () => {
    const { unmount } = render(<MapPanel {...propsFor()} inline />);
    expect(screen.getByTestId('leaflet')).toHaveAttribute('data-guard-wheel', 'true');
    unmount();
    render(<MapPanel {...propsFor()} />);
    expect(screen.getByTestId('leaflet')).toHaveAttribute('data-guard-wheel', 'false');
  });

  it('inline は、地図と印の凡例と状態の帯だけ。操作の行・分類の帯（チェックボックス）・候補の一覧は、拡大ビューにだけある', () => {
    const { unmount } = render(<MapPanel {...propsFor()} inline />);
    expect(screen.queryByRole('combobox', { name: '地区' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: '地図の種類' })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByText('候補を一覧で見る（面積の大きい順）')).not.toBeInTheDocument();
    expect([...screen.getByRole('group', { name: '地図の印' }).querySelectorAll('.class-badge')].map((el) => el.textContent)).toEqual(['2018 年は未検出', '2018 年も検出', '未判定']);
    expect(screen.getByTestId('leaflet')).toBeInTheDocument();
    unmount();
    render(<MapPanel {...propsFor()} />);
    expect(screen.getByRole('combobox', { name: '地区' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: '地図の印' })).not.toBeInTheDocument();
    expect(screen.getByText('候補を一覧で見る（面積の大きい順）')).toBeInTheDocument();
  });

  it('inline では、地区の枠を押しても絞り込まない（戻す操作が無いため）。拡大ビューでは、その地区に絞り込む', async () => {
    const onFilterChange = vi.fn();
    const { unmount } = render(<MapPanel {...propsFor({ onFilterChange })} filter={ALL_FILTER} inline />);
    await userEvent.click(screen.getByRole('button', { name: '地区の枠（b）' }));
    expect(onFilterChange).not.toHaveBeenCalled();
    unmount();
    render(<MapPanel {...propsFor({ onFilterChange })} filter={ALL_FILTER} />);
    await userEvent.click(screen.getByRole('button', { name: '地区の枠（b）' }));
    expect(onFilterChange).toHaveBeenCalledWith(expect.objectContaining({ areaId: 'b' }));
  });

  it('inline の凡例は、絞り込みで出している分類だけ', () => {
    render(<MapPanel {...propsFor()} filter={{ areaId: '', classes: new Set(['confirmed_new'] as const) }} inline />);
    expect([...screen.getByRole('group', { name: '地図の印' }).querySelectorAll('.class-badge')].map((el) => el.textContent)).toEqual(['2018 年は未検出']);
  });

  it('地図のパネルが 2 つ同時にあっても、地区の選択の id は重ならない。ラベルは、自分の選択を指す', () => {
    render(
      <>
        <section aria-label="図">
          <MapPanel {...propsFor()} />
        </section>
        <section aria-label="拡大ビュー">
          <MapPanel {...propsFor()} />
        </section>
      </>,
    );
    const selects = screen.getAllByRole('combobox', { name: '地区' });
    expect(selects).toHaveLength(2);
    expect(selects[0]!.id).not.toBe('');
    expect(selects[0]!.id).not.toBe(selects[1]!.id);
    // 文書全体で、id が 1 つも重ならない
    const ids = [...document.querySelectorAll('[id]')].map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
    // それぞれのラベル（「地区」）が、同じパネルの選択を指す
    for (const name of ['図', '拡大ビュー']) {
      const panel = screen.getByRole('region', { name });
      const select = within(panel).getByRole('combobox', { name: '地区' });
      expect(within(panel).getByText('地区', { selector: 'label' })).toHaveAttribute('for', select.id);
    }
  });
});
