import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, type ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AreaSummary, CandidateFeature, ToolResult } from '../lib/api-types';
import type { MapFilter } from '../lib/result-view';
import { areas, compare, count, countWards, detail, detectionImage, jsonResponse, mapFocus, table } from '../tests/fixtures';
import type { CandidateDrawer } from './CandidateDrawer';
import type { ChatActions } from './chat/types';
import { HomeClient } from './HomeClient';
import type { MapPanel } from './map/MapPanel';
import type { ResultArea } from './ResultArea';

// 回答が届いたときの切り替え（answered）は、チャットが呼ぶ。ここでは本物のチャットを使いつつ、渡された操作を控えて、テストから直接呼ぶ
const chat = vi.hoisted(() => ({ actions: null as ChatActions | null }));
vi.mock('./chat/ChatPanel', async (importOriginal) => {
  const original = await importOriginal<typeof import('./chat/ChatPanel')>();
  return {
    ...original,
    ChatPanel: (props: ComponentProps<typeof original.ChatPanel>) => {
      useEffect(() => {
        chat.actions = props.actions;
      });
      return <original.ChatPanel {...props} />;
    },
  };
});

// 地図・結果領域・詳細に渡る props を控える（本物をそのまま描く）。地図の上のボタン・結果領域の「拡大」・詳細のフォーカスは担当が別なので、ここでは、渡す値と、渡された操作を呼んだときの動きだけを見る
const spy = vi.hoisted(() => ({
  map: null as ComponentProps<typeof MapPanel> | null,
  area: null as ComponentProps<typeof ResultArea> | null,
  drawer: null as ComponentProps<typeof CandidateDrawer> | null,
}));
vi.mock('./map/MapPanel', async (importOriginal) => {
  const original = await importOriginal<typeof import('./map/MapPanel')>();
  return {
    ...original,
    MapPanel: (props: ComponentProps<typeof original.MapPanel>) => {
      useEffect(() => {
        spy.map = props;
      });
      return <original.MapPanel {...props} />;
    },
  };
});
vi.mock('./ResultArea', async (importOriginal) => {
  const original = await importOriginal<typeof import('./ResultArea')>();
  return {
    ...original,
    ResultArea: (props: ComponentProps<typeof original.ResultArea>) => {
      useEffect(() => {
        spy.area = props;
      });
      return <original.ResultArea {...props} />;
    },
  };
});
vi.mock('./CandidateDrawer', async (importOriginal) => {
  const original = await importOriginal<typeof import('./CandidateDrawer')>();
  return {
    ...original,
    CandidateDrawer: (props: ComponentProps<typeof original.CandidateDrawer>) => {
      useEffect(() => {
        spy.drawer = props;
      });
      return <original.CandidateDrawer {...props} />;
    },
  };
});

// グラフの中身は担当が別。ここでは、グラフに渡る絞り込みと、グラフからの絞り込みの変更だけを見る
vi.mock('./chart/AreaChartView', () => ({
  AreaChartView: (p: { areas: AreaSummary[]; filter: MapFilter; onFilterChange: (next: MapFilter) => void; onShowMap?: () => void }) => (
    <div
      data-testid="chart"
      data-area-id={p.filter.areaId}
      data-area-ids={(p.filter.areaIds ?? []).join(',')}
      data-scope={p.filter.scope ?? ''}
      data-classes={[...p.filter.classes].sort().join(',')}
    >
      <button type="button" onClick={() => p.onFilterChange({ areaId: 'z18-1-2', classes: new Set(['uncertain']) })}>
        グラフの行（z18-1-2・判定保留）
      </button>
      {p.onShowMap && (
        <button type="button" onClick={p.onShowMap}>
          グラフから地図へ
        </button>
      )}
    </div>
  ),
}));

// Leaflet 本体は別のテストで確かめる。ここでは、地図に渡る props だけを見る
vi.mock('./map/LeafletMap', () => ({
  default: (p: {
    base: string;
    features: CandidateFeature[];
    selectedId: string | null;
    highlightIds: ReadonlySet<string>;
    focus: { bbox: number[]; ids: string[]; nonce: number } | null;
    onSelect: (id: string) => void;
  }) => (
    <div
      data-testid="leaflet"
      data-base={p.base}
      data-count={p.features.length}
      data-classes={[...new Set(p.features.map((f) => f.properties.class))].sort().join(',')}
      data-selected={p.selectedId ?? ''}
      data-highlight={[...p.highlightIds].join(',')}
      data-focus={p.focus ? 'fit' : ''}
      data-focus-keys={p.focus ? Object.keys(p.focus).sort().join(',') : ''}
      data-focus-bbox={p.focus ? p.focus.bbox.join(',') : ''}
      data-focus-nonce={p.focus ? p.focus.nonce : ''}
    >
      <button type="button" onClick={() => p.onSelect('c-1-2-2')}>
        地図の印（c-1-2-2）
      </button>
    </div>
  ),
}));

const square = (lon: number): CandidateFeature['geometry'] => ({
  type: 'Polygon',
  coordinates: [[[lon, 32.8], [lon + 0.0001, 32.8], [lon + 0.0001, 32.8001], [lon, 32.8001], [lon, 32.8]]],
});
const features: CandidateFeature[] = [
  { type: 'Feature', id: 'c-1-2-1', geometry: square(130.7), properties: { id: 'c-1-2-1', class: 'confirmed_new', area_m2: 123.4, area_id: 'z18-1-2' } },
  { type: 'Feature', id: 'c-1-2-2', geometry: square(130.701), properties: { id: 'c-1-2-2', class: 'uncertain', area_m2: 88, area_id: 'z18-1-2' } },
];

const fetchMock = vi.fn<typeof fetch>();

function route(overrides: Record<string, () => Response | Promise<Response>> = {}) {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    for (const [prefix, make] of Object.entries(overrides)) if (url.startsWith(prefix)) return make();
    if (url.startsWith('/api/areas')) return jsonResponse(areas);
    if (url.startsWith('/api/candidates.geojson')) return jsonResponse({ type: 'FeatureCollection', features });
    if (url.startsWith('/api/candidates/c-')) return jsonResponse({ ...detail, id: url.split('/').pop() });
    if (url.startsWith('/api/candidates')) return jsonResponse({ total: 2, items: [] });
    if (url === '/api/chat' && init?.method === 'POST') {
      return jsonResponse({ message: { role: 'assistant', content: '一覧です。', results: [table, mapFocus], tool_calls: [] } });
    }
    return jsonResponse({ error: { code: 'not_found', message: 'テストに無いパス' } }, 404);
  });
}

/** 候補の詳細（GET /api/candidates/{id}）への通信。画像（/image）・一覧・GeoJSON は含めない */
const detailCalls = () => fetchMock.mock.calls.filter(([u]) => /^\/api\/candidates\/c-[^/?]+$/.test(String(u)));

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  spy.map = null;
  spy.area = null;
  spy.drawer = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('画面 `/`（チャット・地図・詳細の連携）', () => {
  it('地区の枠と候補を読み込み、地図に渡す。標準の下地は 2023 年の写真', async () => {
    route();
    render(<HomeClient defaultResultOpen />);
    const map = await screen.findByTestId('leaflet');
    await waitFor(() => expect(map).toHaveAttribute('data-count', '2'));
    expect(map).toHaveAttribute('data-base', 'photo2023');
    expect(screen.getByRole('combobox', { name: '地区' })).toHaveTextContent('テスト地区 01');
    // 凡例に分類ごとの件数（地区の件数の合計）
    const legend = screen.getByRole('group', { name: /表示する分類/ });
    expect(within(legend).getAllByRole('checkbox')).toHaveLength(3);
    expect(within(legend).getByText('5')).toBeInTheDocument();
  });

  it('下地を切り替える（aria-pressed）', async () => {
    route();
    render(<HomeClient defaultResultOpen />);
    const map = await screen.findByTestId('leaflet');
    await userEvent.click(screen.getByRole('button', { name: '2018 年の写真' }));
    expect(map).toHaveAttribute('data-base', 'photo2018');
    expect(screen.getByRole('button', { name: '2018 年の写真' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '2023 年の写真' })).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(screen.getByRole('button', { name: '標準地図' }));
    expect(map).toHaveAttribute('data-base', 'std');
  });

  it('凡例のチェックで分類を絞り、全部外すと「条件に合う候補がありません」', async () => {
    route();
    render(<HomeClient defaultResultOpen />);
    const map = await screen.findByTestId('leaflet');
    await waitFor(() => expect(map).toHaveAttribute('data-count', '2'));
    await userEvent.click(screen.getByRole('checkbox', { name: /判定保留/ }));
    expect(map).toHaveAttribute('data-classes', 'confirmed_new');
    await userEvent.click(screen.getByRole('checkbox', { name: /新規出現/ }));
    expect(map).toHaveAttribute('data-count', '0');
    expect(screen.getByText(/条件に合う候補がありません/)).toBeInTheDocument();
  });

  it('チャットで一覧を出し、行の「詳細」で写真の比較が開く（地図の選択・寄せも連動）', async () => {
    route();
    render(<HomeClient defaultResultOpen />);
    const map = await screen.findByTestId('leaflet');
    await waitFor(() => expect(map).toHaveAttribute('data-count', '2'));

    await userEvent.type(screen.getByRole('textbox', { name: '質問を入力' }), '一覧にして{Enter}');
    await screen.findByText('一覧です。');
    // map_focus が返ったので、候補が強調され、地図が寄る
    await waitFor(() => expect(map).toHaveAttribute('data-highlight', 'c-1-2-1,c-1-2-2,c-1-2-3'));
    expect(map).toHaveAttribute('data-focus', 'fit');

    await userEvent.click(screen.getByRole('button', { name: /詳細.*c-1-2-1/ }));
    const dialog = await screen.findByRole('region', { name: '候補の詳細' });
    expect(await within(dialog).findAllByRole('img')).toHaveLength(2);
    expect(map).toHaveAttribute('data-selected', 'c-1-2-1');

    // 閉じると選択も外れる
    await userEvent.click(within(dialog).getByRole('button', { name: '閉じる' }));
    expect(screen.queryByRole('region', { name: '候補の詳細' })).not.toBeInTheDocument();
    expect(map).toHaveAttribute('data-selected', '');

    // 強調表示の解除（詳細を開いたあとは右が「写真の比較」なので、地図のタブへ戻ってから）
    await userEvent.click(screen.getByRole('tab', { name: '地図' }));
    await userEvent.click(screen.getByRole('button', { name: '強調表示を解除' }));
    expect(map).toHaveAttribute('data-highlight', '');
  });

  it('地図の印を選ぶと、地図に留まる。「写真を比べる」を押したときだけ、その候補の詳細（写真の比較）が開く', async () => {
    route();
    render(<HomeClient defaultResultOpen />);
    await userEvent.click(await screen.findByRole('button', { name: '地図の印（c-1-2-2）' }));
    // 画面は替えない（地図のまま。詳細は写真の比較の中で、まだ隠れている）
    expect(screen.getByRole('tab', { name: '地図' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('leaflet')).toHaveAttribute('data-selected', 'c-1-2-2');
    expect(screen.queryByRole('region', { name: '候補の詳細' })).not.toBeInTheDocument();
    // 地図の上の「写真を比べる」（MapPanel が出す）が渡された操作を呼ぶと、写真の比較へ
    act(() => spy.map!.onComparePhotos!('c-1-2-2'));
    const dialog = await screen.findByRole('region', { name: '候補の詳細' });
    expect(within(dialog).getByText('c-1-2-2')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '写真の比較' })).toHaveAttribute('aria-selected', 'true');
    expect(fetchMock.mock.calls.some(([u]) => u === '/api/candidates/c-1-2-2')).toBe(true);
  });

  it('候補の読み込みに失敗したら、地図の上にエラーと再試行を出す', async () => {
    let fail = true;
    route({
      '/api/candidates.geojson': () => (fail ? jsonResponse({ error: { code: 'db_down', message: 'DB に接続できません。' } }, 503) : jsonResponse({ type: 'FeatureCollection', features })),
    });
    render(<HomeClient defaultResultOpen />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('候補を読み込めませんでした');
    expect(alert).toHaveTextContent('DB に接続できません。');
    fail = false;
    await userEvent.click(within(alert).getByRole('button', { name: '再試行' }));
    await waitFor(() => expect(screen.getByTestId('leaflet')).toHaveAttribute('data-count', '2'));
  });

  it('候補が 0 件のときは「表示できる候補がありません」', async () => {
    route({ '/api/candidates.geojson': () => jsonResponse({ type: 'FeatureCollection', features: [] }) });
    render(<HomeClient defaultResultOpen />);
    expect(await screen.findByText('表示できる候補がありません。')).toBeInTheDocument();
  });

  it('一覧（キーボードで使える代わりの手段）は、開いたときに読み込む', async () => {
    route({
      '/api/candidates?': () =>
        jsonResponse({ total: 1, items: [{ id: 'c-1-2-1', area_id: 'z18-1-2', class: 'confirmed_new', area_m2: 123.4, bbox: [0, 0, 1, 1], centroid: [0, 0] }] }),
    });
    render(<HomeClient defaultResultOpen />);
    await screen.findByTestId('leaflet');
    expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith('/api/candidates?'))).toBe(false);
    await userEvent.click(screen.getByText('候補を一覧で見る（面積の大きい順）'));
    const item = await screen.findByRole('button', { name: /c-1-2-1 の詳細を開く/ });
    await userEvent.click(item);
    expect(await screen.findByRole('region', { name: '候補の詳細' })).toBeInTheDocument();
    const call = fetchMock.mock.calls.find(([u]) => String(u).startsWith('/api/candidates?'))!;
    expect(String(call[0])).toContain('sort=area_desc');
  });
});

describe('右の結果領域（地図・グラフ・写真の比較のタブ）', () => {
  const tab = (name: string) => screen.getByRole('tab', { name });
  /** 画面に見えない、自動の切り替えの知らせ */
  const live = () => document.querySelector<HTMLElement>('.home > [aria-live="polite"]')!;
  const actions = () => chat.actions!;
  /** タブが指すパネル（hidden のものは、名前での検索から外れるので、aria-controls から引く） */
  const panelOf = (name: string) => document.getElementById(tab(name).getAttribute('aria-controls')!)!;

  async function renderReady() {
    route();
    render(<HomeClient defaultResultOpen />);
    const map = await screen.findByTestId('leaflet');
    await waitFor(() => expect(map).toHaveAttribute('data-count', '2'));
    await waitFor(() => expect(chat.actions).not.toBeNull());
    return map;
  }

  beforeEach(() => {
    chat.actions = null;
  });

  it('はじめは地図のタブ。ほかの 2 画面は hidden で、空の状態のまま（地図は外さない）', async () => {
    const map = await renderReady();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['地図', 'グラフ', '写真の比較']);
    expect(tab('地図')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { name: '地図' })).toBeVisible();
    expect(panelOf('グラフ')).toHaveAttribute('hidden');
    expect(panelOf('写真の比較')).toHaveAttribute('hidden');
    expect(map).toBeVisible();
    expect(live()).toBeEmptyDOMElement();
  });

  it('タブを押すと画面が替わる。地図は外さず hidden にするので、戻すと同じ要素', async () => {
    const map = await renderReady();
    await userEvent.click(tab('グラフ'));
    expect(tab('グラフ')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('chart')).toBeVisible();
    expect(map.isConnected).toBe(true);
    expect(map).not.toBeVisible();
    expect(map.closest('[role="tabpanel"]')).toHaveAttribute('hidden');
    // 写真の比較は、候補を選ぶまで空の状態の文
    await userEvent.click(tab('写真の比較'));
    expect(screen.getByText('候補を選ぶと、2018 年と 2023 年の写真を並べて見られます。')).toBeVisible();
    expect(screen.getByText(/地図の印、候補の一覧、チャットの結果の「詳細」から選べます/)).toBeVisible();
    await userEvent.click(tab('地図'));
    expect(screen.getByTestId('leaflet')).toBe(map);
    expect(map).toBeVisible();
    // ユーザー自身の操作は、読み上げの知らせを出さない
    expect(live()).toBeEmptyDOMElement();
  });

  it('answered: 件数・比較はグラフ、検出画像は写真の比較へ自動で切り替え、見えない live region で知らせる。フォーカスは動かさない', async () => {
    await renderReady();
    const input = screen.getByRole('textbox', { name: '質問を入力' });
    input.focus();
    act(() => actions().answered([count]));
    expect(tab('グラフ')).toHaveAttribute('aria-selected', 'true');
    expect(live()).toHaveTextContent('「グラフ」を表示しました');
    expect(input).toHaveFocus();

    act(() => actions().answered([detectionImage]));
    expect(tab('写真の比較')).toHaveAttribute('aria-selected', 'true');
    expect(live()).toHaveTextContent('「写真の比較」を表示しました');
    // 検出画像の候補を自動で選ぶが、入力欄のフォーカスは奪わない（詳細へ autoFocus={false} を渡す。見出しへ移すかは CandidateDrawer の担当）
    expect(spy.drawer?.autoFocus).toBe(false);
  });

  it('answered: 件数の条件（分類・地区）を、地図とグラフの絞り込みに同じ条件で写す。条件の無い回答は、いまの絞り込みのまま', async () => {
    const map = await renderReady();
    act(() => actions().answered([count])); // 分類 = 新規出現、地区 = すべて
    expect(screen.getByTestId('chart')).toHaveAttribute('data-classes', 'confirmed_new');
    expect(screen.getByTestId('chart')).toHaveAttribute('data-area-id', '');
    expect(map).toHaveAttribute('data-classes', 'confirmed_new');
    expect(map).toHaveAttribute('data-count', '1');

    act(() => actions().answered([table])); // 件数ではない回答（表）
    expect(screen.getByTestId('chart')).toHaveAttribute('data-classes', 'confirmed_new');

    act(() => actions().answered([{ ...count, filter: { area_id: 'z18-1-2', cls: null } }]));
    expect(screen.getByTestId('chart')).toHaveAttribute('data-area-id', 'z18-1-2');
    expect(screen.getByTestId('chart')).toHaveAttribute('data-classes', 'confirmed_new,existing_omission,uncertain');
    expect(map).toHaveAttribute('data-count', '2');
  });

  it('地図の凡例を操作すると、グラフの絞り込みも同じ。グラフから絞り込むと、地図も同じ', async () => {
    const map = await renderReady();
    await userEvent.click(screen.getByRole('checkbox', { name: /判定保留/ }));
    expect(map).toHaveAttribute('data-classes', 'confirmed_new');
    await userEvent.click(tab('グラフ'));
    expect(screen.getByTestId('chart')).toHaveAttribute('data-classes', 'confirmed_new,existing_omission');

    await userEvent.click(screen.getByRole('button', { name: /グラフの行/ }));
    expect(map).toHaveAttribute('data-classes', 'uncertain');
    expect(map).toHaveAttribute('data-count', '1');
  });

  it('手で選んだタブは、次の回答が届くまで保つ。画面を決めない回答（表・精度・お断り）や、絞り込みの変更では動かない', async () => {
    await renderReady();
    act(() => actions().answered([count]));
    expect(tab('グラフ')).toHaveAttribute('aria-selected', 'true');

    await userEvent.click(tab('地図')); // 手で選ぶ
    expect(tab('地図')).toHaveAttribute('aria-selected', 'true');
    expect(live()).toBeEmptyDOMElement(); // 手で選んだときは、知らせない（直前の知らせも消える）

    act(() => actions().answered([table]));
    expect(tab('地図')).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(screen.getByRole('checkbox', { name: /判定保留/ }));
    expect(tab('地図')).toHaveAttribute('aria-selected', 'true');

    act(() => actions().answered([count])); // 次の回答で、また合う画面へ
    expect(tab('グラフ')).toHaveAttribute('aria-selected', 'true');
    expect(live()).toHaveTextContent('「グラフ」を表示しました');
  });

  it('いまと同じ画面への切り替えは、知らせない', async () => {
    await renderReady();
    act(() => actions().answered([mapFocus]));
    expect(tab('地図')).toHaveAttribute('aria-selected', 'true');
    expect(live()).toBeEmptyDOMElement();
  });

  it('showView: 結果カードから画面を切り替える。フォーカスは動かさない', async () => {
    await renderReady();
    const input = screen.getByRole('textbox', { name: '質問を入力' });
    input.focus();
    act(() => actions().showView('photos'));
    expect(tab('写真の比較')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('候補を選ぶと、2018 年と 2023 年の写真を並べて見られます。')).toBeVisible();
    expect(live()).toHaveTextContent('「写真の比較」を表示しました');
    expect(input).toHaveFocus();
  });

  it('openCandidate: 写真の比較へ切り替え、詳細を地図に重ならない形で出す。地図はその候補へ寄る（右端をあける欄は無い）', async () => {
    const map = await renderReady();
    act(() => actions().openCandidate('c-1-2-1'));
    expect(tab('写真の比較')).toHaveAttribute('aria-selected', 'true');
    const region = await screen.findByRole('region', { name: '候補の詳細' });
    expect(region).toBeVisible();
    // 詳細は、結果領域のパネルの中にある（地図の上に重ならない）
    expect(region.closest('[role="tabpanel"]')).toBe(screen.getByRole('tabpanel', { name: '写真の比較' }));
    expect(await within(region).findAllByRole('img')).toHaveLength(2);
    expect(map).toHaveAttribute('data-selected', 'c-1-2-1');
    expect(map).toHaveAttribute('data-focus', 'fit');
    expect(map).toHaveAttribute('data-focus-keys', 'bbox,ids,nonce'); // 右端をあける欄（padRight）は無い
    expect(live()).toHaveTextContent('「写真の比較」を表示しました');
  });

  it('閉じるで選択を外し、写真の比較は空の状態に戻る（タブは写真の比較のまま）', async () => {
    const map = await renderReady();
    act(() => actions().openCandidate('c-1-2-1'));
    const region = await screen.findByRole('region', { name: '候補の詳細' });
    await userEvent.click(within(region).getByRole('button', { name: '閉じる' }));
    expect(screen.queryByRole('region', { name: '候補の詳細' })).not.toBeInTheDocument();
    expect(screen.getByText('候補を選ぶと、2018 年と 2023 年の写真を並べて見られます。')).toBeVisible();
    expect(tab('写真の比較')).toHaveAttribute('aria-selected', 'true');
    expect(map).toHaveAttribute('data-selected', '');
  });

  it('「地図で見る」: 地図へ切り替えて、その候補の範囲へ寄せる。押したボタンが隠れるので、フォーカスは地図のタブへ', async () => {
    const map = await renderReady();
    act(() => actions().openCandidate('c-1-2-1'));
    const button = await screen.findByRole('button', { name: '地図で見る' });
    await userEvent.click(button);
    expect(tab('地図')).toHaveAttribute('aria-selected', 'true');
    expect(map).toBeVisible();
    expect(map).toHaveAttribute('data-focus-keys', 'bbox,ids,nonce');
    expect(map).toHaveAttribute('data-selected', 'c-1-2-1'); // 選択の強調は残す
    expect(tab('地図')).toHaveFocus();
    // 選択は残っているので、写真の比較へ戻ると、同じ詳細が見える
    await userEvent.click(tab('写真の比較'));
    expect(screen.getByRole('region', { name: '候補の詳細' })).toBeVisible();
  });

  it('地図の印を選んだあと「写真を比べる」で開いた詳細は、閉じると写真の比較の空の状態に戻る（タブは写真の比較のまま）', async () => {
    const map = await renderReady();
    await userEvent.click(screen.getByRole('button', { name: '地図の印（c-1-2-2）' }));
    act(() => spy.map!.onComparePhotos!('c-1-2-2'));
    const region = await screen.findByRole('region', { name: '候補の詳細' });
    await userEvent.click(within(region).getByRole('button', { name: '閉じる' }));
    expect(screen.queryByRole('region', { name: '候補の詳細' })).not.toBeInTheDocument();
    expect(screen.getByText('候補を選ぶと、2018 年と 2023 年の写真を並べて見られます。')).toBeVisible();
    expect(tab('写真の比較')).toHaveAttribute('aria-selected', 'true');
    expect(map).toHaveAttribute('data-selected', '');
  });

  it('focusMap: 地図へ切り替え、候補を強調して寄せる', async () => {
    const map = await renderReady();
    act(() => actions().showView('chart'));
    act(() => actions().focusMap({ bbox: [130.7, 32.8, 130.71, 32.81], candidateIds: ['c-1-2-1'] }));
    expect(tab('地図')).toHaveAttribute('aria-selected', 'true');
    expect(map).toHaveAttribute('data-highlight', 'c-1-2-1');
    expect(map).toHaveAttribute('data-focus', 'fit');
    expect(map).toHaveAttribute('data-focus-keys', 'bbox,ids,nonce');
  });

  it('詳細の候補が地図の候補データに無くても、詳細が届いてから寄せる', async () => {
    route({ '/api/candidates.geojson': () => jsonResponse({ type: 'FeatureCollection', features: [] }) });
    render(<HomeClient defaultResultOpen />);
    const map = await screen.findByTestId('leaflet');
    await waitFor(() => expect(chat.actions).not.toBeNull());
    act(() => chat.actions!.openCandidate('c-1-2-1'));
    await screen.findByRole('region', { name: '候補の詳細' });
    await waitFor(() => expect(map).toHaveAttribute('data-focus', 'fit'));
    expect(map).toHaveAttribute('data-focus-keys', 'bbox,ids,nonce');
  });
});

describe('回答の条件の受け渡し（複数地区・比較・カードのボタン）', () => {
  const tab = (name: string) => screen.getByRole('tab', { name });
  const actions = () => chat.actions!;
  const chart = () => screen.getByTestId('chart');

  async function renderReady(extra: Record<string, () => Response | Promise<Response>> = {}) {
    route(extra);
    render(<HomeClient defaultResultOpen />);
    const map = await screen.findByTestId('leaflet');
    await waitFor(() => expect(chat.actions).not.toBeNull());
    return map;
  }

  beforeEach(() => {
    chat.actions = null;
  });

  it('複数の地区（区）の件数は、areaIds と scope のまま地図・グラフに渡る。areaId は空（「すべて」に見せない）', async () => {
    await renderReady();
    act(() => actions().answered([countWards]));
    expect(chart()).toHaveAttribute('data-area-ids', 'z18-1-2,z18-2-2');
    expect(chart()).toHaveAttribute('data-scope', '中央区');
    expect(chart()).toHaveAttribute('data-area-id', '');
    expect(spy.map?.filter).toEqual({
      areaId: '',
      areaIds: ['z18-1-2', 'z18-2-2'],
      scope: '中央区',
      classes: new Set(['confirmed_new', 'existing_omission', 'uncertain']),
    });
  });

  it('比較の回答は、直前の件数の絞り込みを残さず、分類はすべて・地区は比較の条件にする', async () => {
    await renderReady();
    act(() => actions().answered([{ ...count, filter: { area_id: 'z18-1-2', cls: 'uncertain' } }]));
    expect(chart()).toHaveAttribute('data-classes', 'uncertain');
    expect(chart()).toHaveAttribute('data-area-id', 'z18-1-2');

    act(() => actions().answered([compare]));
    expect(chart()).toHaveAttribute('data-classes', 'confirmed_new,existing_omission,uncertain');
    expect(chart()).toHaveAttribute('data-area-id', '');
  });

  it('壊れた件数（filter が無い）が、比較のあとに来ても、右の絞り込みは、比較の条件のまま（全地区・全分類にしない）。回答の条件の行（AnswerScope）と同じ', async () => {
    await renderReady();
    const byWard = { ...compare, filter: { area_ids: ['z18-1-2', 'z18-2-2'], scope: '中央区', cls: null } };
    const noFilter = { type: 'count', title: '壊れた件数', total: 1, provenance: compare.provenance } as unknown as ToolResult;
    act(() => actions().answered([byWard, noFilter]));
    expect(chart()).toHaveAttribute('data-area-ids', 'z18-1-2,z18-2-2');
    expect(chart()).toHaveAttribute('data-scope', '中央区');
    expect(chart()).toHaveAttribute('data-classes', 'confirmed_new,existing_omission,uncertain');
  });

  it('showView に条件を渡すと、地図・グラフの絞り込みをそれに替えてから切り替える。渡さなければ、いまの絞り込みのまま', async () => {
    await renderReady();
    act(() => actions().answered([count])); // 新規出現だけ
    act(() => actions().showView('map', { areaId: 'z18-1-2', classes: new Set(['uncertain']) }));
    expect(tab('地図')).toHaveAttribute('aria-selected', 'true');
    expect(spy.map?.filter).toEqual({ areaId: 'z18-1-2', classes: new Set(['uncertain']) });
    act(() => actions().showView('chart'));
    expect(tab('グラフ')).toHaveAttribute('aria-selected', 'true');
    expect(chart()).toHaveAttribute('data-classes', 'uncertain');
    expect(chart()).toHaveAttribute('data-area-id', 'z18-1-2');
  });

  it('古い回答のカードの「グラフで見る」「地図で見る」は、いまの絞り込みではなく、そのカードの条件で開く', async () => {
    const replies = [
      { ...count, title: '判定保留の件数', total: 18, filter: { area_id: null, cls: 'uncertain' as const } },
      { ...compare, title: '地区ごとの比較' },
    ];
    let n = 0;
    const map = await renderReady({
      '/api/chat': () => jsonResponse({ message: { role: 'assistant', content: `回答 ${n + 1}`, results: [replies[n++]!], tool_calls: [] } }),
    });
    const input = screen.getByRole('textbox', { name: '質問を入力' });
    await userEvent.type(input, '判定保留は？{Enter}');
    const card = await screen.findByRole('region', { name: '判定保留の件数' });
    expect(chart()).toHaveAttribute('data-classes', 'uncertain');

    // 比較の回答が来て、絞り込みは全分類になる
    await userEvent.type(input, '比べて{Enter}');
    await screen.findByRole('region', { name: '地区ごとの比較' });
    expect(chart()).toHaveAttribute('data-classes', 'confirmed_new,existing_omission,uncertain');

    // 古い件数のカードを押すと、そのカードの条件（判定保留だけ）で開く
    await userEvent.click(within(card).getByRole('button', { name: 'グラフで見る' }));
    expect(tab('グラフ')).toHaveAttribute('aria-selected', 'true');
    expect(chart()).toHaveAttribute('data-classes', 'uncertain');

    // 手で凡例を替えたあと、「地図で見る」を押しても、そのカードの条件
    await userEvent.click(tab('地図'));
    await userEvent.click(screen.getByRole('checkbox', { name: /新規出現/ }));
    expect(map).toHaveAttribute('data-classes', 'confirmed_new,uncertain');
    await userEvent.click(within(card).getByRole('button', { name: '地図で見る' }));
    expect(tab('地図')).toHaveAttribute('aria-selected', 'true');
    expect(map).toHaveAttribute('data-classes', 'uncertain');
  });
});

describe('候補の選び方（地図に留まる・検出画像の自動選択・絞り込みで隠れない）', () => {
  const tab = (name: string) => screen.getByRole('tab', { name });
  const live = () => document.querySelector<HTMLElement>('.home > [aria-live="polite"]')!;
  const actions = () => chat.actions!;
  const chart = () => screen.getByTestId('chart');
  const other: CandidateFeature = {
    type: 'Feature',
    id: 'c-3-3-1',
    geometry: square(130.72),
    properties: { id: 'c-3-3-1', class: 'existing_omission', area_m2: 40, area_id: 'z18-3-3' },
  };

  async function renderReady(opts: { withOther?: boolean; empty?: boolean } = {}) {
    route({
      '/api/candidates.geojson': () =>
        jsonResponse({ type: 'FeatureCollection', features: opts.empty ? [] : opts.withOther ? [...features, other] : features }),
    });
    render(<HomeClient defaultResultOpen />);
    const map = await screen.findByTestId('leaflet');
    await waitFor(() => expect(chat.actions).not.toBeNull());
    if (!opts.empty) await waitFor(() => expect(map).toHaveAttribute('data-count', opts.withOther ? '3' : '2'));
    return map;
  }

  beforeEach(() => {
    chat.actions = null;
  });

  it('(A) 地図の印・形を選んでも、画面は替えず（地図に留まる）、知らせも出さない。その候補を選ぶが、詳細は、写真の比較が見えるまでマウントしない（通信もしない）', async () => {
    const map = await renderReady();
    const nonce = spy.area!.revealNonce;
    await userEvent.click(screen.getByRole('button', { name: '地図の印（c-1-2-2）' }));
    expect(tab('地図')).toHaveAttribute('aria-selected', 'true');
    expect(map).toBeVisible();
    expect(map).toHaveAttribute('data-selected', 'c-1-2-2');
    expect(live()).toBeEmptyDOMElement();
    expect(spy.area?.revealNonce).toBe(nonce);
    // 見ていない詳細は、取りに行かない（先読みしない）
    expect(spy.drawer).toBeNull();
    expect(document.querySelector('.drawer')).toBeNull();
    expect(detailCalls()).toHaveLength(0);
  });

  it('(A) 「写真を比べる」: 選択中の候補の写真の比較へ切り替える。すでに選択中でも、別の候補でも動く', async () => {
    await renderReady();
    await userEvent.click(screen.getByRole('button', { name: '地図の印（c-1-2-2）' }));
    expect(spy.map?.onComparePhotos).toBeTypeOf('function');
    act(() => spy.map!.onComparePhotos!('c-1-2-2'));
    expect(tab('写真の比較')).toHaveAttribute('aria-selected', 'true');
    expect(live()).toHaveTextContent('「写真の比較」を表示しました');
    const region = await screen.findByRole('region', { name: '候補の詳細' });
    expect(await within(region).findByText('c-1-2-2')).toBeInTheDocument();

    // 地図へ戻って、同じ候補でもう一度（すでに選択中）
    await userEvent.click(tab('地図'));
    act(() => spy.map!.onComparePhotos!('c-1-2-2'));
    expect(tab('写真の比較')).toHaveAttribute('aria-selected', 'true');

    // 別の候補を比べると、詳細はその候補に替わる
    await userEvent.click(tab('地図'));
    act(() => spy.map!.onComparePhotos!('c-1-2-1'));
    expect(await within(await screen.findByRole('region', { name: '候補の詳細' })).findByText('c-1-2-1')).toBeInTheDocument();
  });

  it('チャットの結果カードの「詳細を開く」など、ユーザーが押したボタンから開くときは、見出しへフォーカスを移す指定にする。地図の印のあとは、「写真を比べる」を押したときに、その指定でマウントする', async () => {
    await renderReady();
    act(() => actions().openCandidate('c-1-2-1'));
    expect(spy.drawer).toMatchObject({ candidateId: 'c-1-2-1', autoFocus: true });
    // 地図の印を選ぶと、前の詳細は外れ、新しい候補の詳細は（見えるまで）マウントしない
    await userEvent.click(screen.getByRole('tab', { name: '地図' }));
    await userEvent.click(screen.getByRole('button', { name: '地図の印（c-1-2-2）' }));
    expect(document.querySelector('.drawer')).toBeNull();
    // 「写真を比べる」を押したときは、見出しへフォーカスを移す指定でマウントする（押したボタンは、ユーザーの操作）
    await userEvent.click(screen.getByRole('button', { name: '写真を比べる' }));
    expect(spy.drawer).toMatchObject({ candidateId: 'c-1-2-2', autoFocus: true });
  });

  it('地図の印を選んだあと、利用者がタブで写真の比較へ移したときは、フォーカスを奪わない指定（タブにフォーカスが残る）でマウントする', async () => {
    await renderReady();
    await userEvent.click(screen.getByRole('button', { name: '地図の印（c-1-2-2）' }));
    await userEvent.click(tab('写真の比較'));
    const region = await screen.findByRole('region', { name: '候補の詳細' });
    expect(spy.drawer).toMatchObject({ candidateId: 'c-1-2-2', autoFocus: false });
    expect(within(region).getByRole('heading', { name: '候補の詳細' })).not.toHaveFocus();
    expect(tab('写真の比較')).toHaveFocus();
  });

  it('検出画像の回答: その候補を、入力欄のフォーカスを奪わずに選ぶ。詳細の中身（候補 ID）が出て、地図もその候補へ寄る', async () => {
    const map = await renderReady();
    const input = screen.getByRole('textbox', { name: '質問を入力' });
    input.focus();
    act(() => actions().answered([detectionImage]));
    expect(tab('写真の比較')).toHaveAttribute('aria-selected', 'true');
    const region = await screen.findByRole('region', { name: '候補の詳細' });
    expect(await within(region).findByText(detectionImage.candidate_id)).toBeInTheDocument();
    expect(map).toHaveAttribute('data-selected', detectionImage.candidate_id);
    expect(map).toHaveAttribute('data-focus', 'fit');
    expect(spy.drawer).toMatchObject({ candidateId: detectionImage.candidate_id, autoFocus: false });
    expect(fetchMock.mock.calls.some(([u]) => u === `/api/candidates/${detectionImage.candidate_id}`)).toBe(true);
    expect(live()).toHaveTextContent('「写真の比較」を表示しました');
  });

  it('検出画像が複数ある回答は、最後のものを選ぶ（最初ではない）', async () => {
    const map = await renderReady();
    act(() => actions().answered([{ ...detectionImage, candidate_id: 'c-1-2-1' }, table, { ...detectionImage, candidate_id: 'c-1-2-2' }]));
    const region = await screen.findByRole('region', { name: '候補の詳細' });
    expect(await within(region).findByText('c-1-2-2')).toBeInTheDocument();
    expect(map).toHaveAttribute('data-selected', 'c-1-2-2');
    expect(spy.drawer).toMatchObject({ candidateId: 'c-1-2-2', autoFocus: false });
    expect(detailCalls().map(([u]) => String(u))).toEqual(['/api/candidates/c-1-2-2']);
  });

  it('検出画像の回答は、前に選んでいた候補を、新しい候補に替える（空の状態や前の候補のままにしない）', async () => {
    await renderReady();
    act(() => actions().openCandidate('c-1-2-2'));
    await screen.findByRole('region', { name: '候補の詳細' });
    act(() => actions().answered([{ ...detectionImage, candidate_id: 'c-1-2-1' }]));
    const region = await screen.findByRole('region', { name: '候補の詳細' });
    expect(await within(region).findByText('c-1-2-1')).toBeInTheDocument();
    expect(within(region).queryByText('c-1-2-2')).not.toBeInTheDocument();
  });

  it('候補が地図の候補データにまだ無い検出画像でも、詳細は開き、詳細が届いてから地図を寄せる', async () => {
    const map = await renderReady({ empty: true });
    act(() => actions().answered([detectionImage]));
    const region = await screen.findByRole('region', { name: '候補の詳細' });
    expect(await within(region).findByText(detectionImage.candidate_id)).toBeInTheDocument();
    await waitFor(() => expect(map).toHaveAttribute('data-focus', 'fit'));
  });

  describe('(R1-med3) 強調・選択する候補が、絞り込みで隠れない', () => {
    const only = (cls: 'confirmed_new' | 'existing_omission' | 'uncertain', areaId: string | null = null) =>
      ({ ...count, filter: { area_id: areaId, cls } }) as typeof count;

    it('openCandidate: 分類が絞り込みに無ければ足す（ほかの分類は残す）。地図にも出る', async () => {
      const map = await renderReady();
      act(() => actions().answered([only('confirmed_new')]));
      expect(map).toHaveAttribute('data-classes', 'confirmed_new');
      act(() => actions().openCandidate('c-1-2-2')); // 判定保留
      expect(chart()).toHaveAttribute('data-classes', 'confirmed_new,uncertain');
      expect(map).toHaveAttribute('data-classes', 'confirmed_new,uncertain');
      expect(map).toHaveAttribute('data-selected', 'c-1-2-2');
    });

    it('openCandidate: 地区が対象の地区に無ければ、全地区に戻す。複数の地区の絞り込み（areaIds・scope）も消す', async () => {
      await renderReady({ withOther: true });
      act(() => actions().answered([only('existing_omission', 'z18-1-2')]));
      expect(chart()).toHaveAttribute('data-area-id', 'z18-1-2');
      act(() => actions().openCandidate('c-3-3-1')); // 別の地区（分類は絞り込みの中）
      expect(chart()).toHaveAttribute('data-area-id', '');
      expect(chart()).toHaveAttribute('data-classes', 'existing_omission');

      act(() => actions().answered([countWards])); // z18-1-2 と z18-2-2
      expect(chart()).toHaveAttribute('data-area-ids', 'z18-1-2,z18-2-2');
      act(() => actions().openCandidate('c-1-2-1')); // 対象の地区の中なら、そのまま
      expect(chart()).toHaveAttribute('data-area-ids', 'z18-1-2,z18-2-2');
      expect(chart()).toHaveAttribute('data-scope', '中央区');
      act(() => actions().openCandidate('c-3-3-1')); // 対象の外
      expect(chart()).toHaveAttribute('data-area-ids', '');
      expect(chart()).toHaveAttribute('data-scope', '');
      expect(chart()).toHaveAttribute('data-area-id', '');
    });

    it('対象の候補がまだ読み込まれていない（byId に無い）ときは、絞り込みを動かさない', async () => {
      await renderReady();
      act(() => actions().answered([only('uncertain')]));
      act(() => actions().openCandidate('c-9-9-9'));
      expect(chart()).toHaveAttribute('data-classes', 'uncertain');
      expect(chart()).toHaveAttribute('data-area-id', '');
      act(() => actions().focusMap({ bbox: [130.7, 32.8, 130.71, 32.81], candidateIds: ['c-9-9-9'] }));
      expect(chart()).toHaveAttribute('data-classes', 'uncertain');
    });

    it('focusMap: 強調する候補の分類・地区が絞り込みの外なら広げる', async () => {
      const map = await renderReady({ withOther: true });
      act(() => actions().answered([only('uncertain', 'z18-1-2')]));
      expect(map).toHaveAttribute('data-count', '1');
      act(() => actions().focusMap({ bbox: [130.7, 32.8, 130.73, 32.81], candidateIds: ['c-1-2-1', 'c-3-3-1'] }));
      expect(chart()).toHaveAttribute('data-area-id', '');
      expect(chart()).toHaveAttribute('data-classes', 'confirmed_new,existing_omission,uncertain');
      expect(map).toHaveAttribute('data-count', '3');
      expect(map).toHaveAttribute('data-highlight', 'c-1-2-1,c-3-3-1');
    });

    it('selectFromMap: 地図の印を選んだ候補が絞り込みの外なら広げる', async () => {
      const map = await renderReady();
      act(() => actions().answered([only('confirmed_new')]));
      await userEvent.click(tab('地図'));
      await userEvent.click(screen.getByRole('button', { name: '地図の印（c-1-2-2）' }));
      expect(map).toHaveAttribute('data-classes', 'confirmed_new,uncertain');
      expect(tab('地図')).toHaveAttribute('aria-selected', 'true');
    });

    it('検出画像の回答: 件数の絞り込みが先に狭めても、選んだ候補は隠れない。同じ回答の地図の表示で強調する候補も、隠れない', async () => {
      const map = await renderReady();
      act(() => actions().answered([only('confirmed_new'), { ...detectionImage, candidate_id: 'c-1-2-2' }]));
      expect(map).toHaveAttribute('data-classes', 'confirmed_new,uncertain');
      expect(map).toHaveAttribute('data-selected', 'c-1-2-2');

      // ChatPanel と同じ順（地図の表示 → 回答）。回答の絞り込みの置き換えで、強調した候補がまた隠れない
      const narrow = { ...only('existing_omission'), total: 51 };
      act(() => {
        actions().focusMap({ bbox: mapFocus.bbox, candidateIds: mapFocus.candidate_ids });
        actions().answered([narrow, mapFocus]);
      });
      expect(map).toHaveAttribute('data-classes', 'confirmed_new,uncertain');
      expect(chart()).toHaveAttribute('data-classes', 'confirmed_new,existing_omission,uncertain');
    });

    it('showOnMap（詳細の「地図で見る」）: 詳細の分類・地区で広げる（地図の候補データに無い候補でも）', async () => {
      const map = await renderReady({ empty: true });
      act(() => actions().answered([only('uncertain')]));
      act(() => actions().openCandidate('c-1-2-1')); // byId に無いので、ここでは動かさない
      expect(chart()).toHaveAttribute('data-classes', 'uncertain');
      await userEvent.click(await screen.findByRole('button', { name: '地図で見る' }));
      expect(chart()).toHaveAttribute('data-classes', 'confirmed_new,uncertain'); // 詳細の分類は新規出現
      expect(tab('地図')).toHaveAttribute('aria-selected', 'true');
      expect(map).toHaveAttribute('data-selected', 'c-1-2-1');
    });
  });
});

describe('画面を替えた知らせ・拡大・スクロールの合図', () => {
  const tab = (name: string) => screen.getByRole('tab', { name });
  const live = () => document.querySelector<HTMLElement>('.home > [aria-live="polite"]')!;
  const actions = () => chat.actions!;

  async function renderReady() {
    route();
    render(<HomeClient defaultResultOpen />);
    await screen.findByTestId('leaflet');
    await waitFor(() => expect(chat.actions).not.toBeNull());
  }

  beforeEach(() => {
    chat.actions = null;
  });

  it('地図の表示を含む回答: ChatPanel と同じ順（地図の表示 → 回答）で呼んでも、画面が替わった知らせは消えない', async () => {
    await renderReady();
    act(() => actions().showView('chart'));
    expect(live()).toHaveTextContent('「グラフ」を表示しました');
    act(() => {
      actions().focusMap({ bbox: mapFocus.bbox, candidateIds: mapFocus.candidate_ids });
      actions().answered([count, mapFocus]); // 画面は地図のまま（2 回目は変わらない）
    });
    expect(tab('地図')).toHaveAttribute('aria-selected', 'true');
    expect(live()).toHaveTextContent('「地図」を表示しました');
  });

  it('チャットの本物の回答（件数 + 地図の表示）でも、画面が替わった知らせが読み上げに残る', async () => {
    route({
      '/api/chat': () => jsonResponse({ message: { role: 'assistant', content: '件数と地図です。', results: [count, mapFocus], tool_calls: [] } }),
    });
    render(<HomeClient defaultResultOpen />);
    await screen.findByTestId('leaflet');
    await userEvent.click(tab('グラフ'));
    expect(live()).toBeEmptyDOMElement();
    await userEvent.type(screen.getByRole('textbox', { name: '質問を入力' }), '件数と地図で{Enter}');
    await screen.findByText('件数と地図です。');
    await waitFor(() => expect(tab('地図')).toHaveAttribute('aria-selected', 'true'));
    expect(live()).toHaveTextContent('「地図」を表示しました');
  });

  it('写真の比較の空の状態は、フォーカスできる中身が無いパネルなので、外枠にフォーカスできる', async () => {
    await renderReady();
    await userEvent.click(tab('写真の比較'));
    const empty = screen.getByText('候補を選ぶと、2018 年と 2023 年の写真を並べて見られます。').closest('.result-area__empty') as HTMLElement;
    expect(empty).toHaveAttribute('tabindex', '0');
    empty.focus();
    expect(empty).toHaveFocus();
  });

  it('知らせを消すのは、ユーザー自身のタブ操作のときだけ', async () => {
    await renderReady();
    act(() => actions().answered([count]));
    expect(live()).toHaveTextContent('「グラフ」を表示しました');
    act(() => actions().showView('chart')); // 同じ画面への切り替え（知らせは変えない）
    expect(live()).toHaveTextContent('「グラフ」を表示しました');
    await userEvent.click(tab('地図'));
    expect(live()).toBeEmptyDOMElement();
  });

  it('(C) 拡大: 状態を持ち、外枠の class と結果領域へ渡す。もう一度で戻る。保存しない', async () => {
    await renderReady();
    const home = () => document.querySelector('.home')!;
    expect(home()).toHaveAttribute('class', 'home');
    expect(spy.area?.expanded).toBe(false);
    expect(spy.area?.onToggleExpanded).toBeTypeOf('function');
    act(() => spy.area!.onToggleExpanded!());
    expect(home()).toHaveAttribute('class', 'home home--expanded');
    expect(spy.area?.expanded).toBe(true);
    // チャットと入力欄は残る
    expect(screen.getByRole('textbox', { name: '質問を入力' })).toBeInTheDocument();
    act(() => spy.area!.onToggleExpanded!());
    expect(home()).toHaveAttribute('class', 'home');
    expect(spy.area?.expanded).toBe(false);

    // 保存しない: 広げたまま作り直すと、広げていない状態から始まる
    act(() => spy.area!.onToggleExpanded!());
    cleanup();
    chat.actions = null;
    await renderReady();
    expect(document.querySelector('.home')).toHaveAttribute('class', 'home');
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it('(C) 拡大は、回答（answered）・タブ操作・showView・focusMap・詳細を開いて閉じる、のあとも保たれる（home--expanded と aria-pressed）', async () => {
    await renderReady();
    const home = () => document.querySelector('.home')!;
    const expandButton = () => screen.getByRole('button', { name: '拡大' });
    await userEvent.click(expandButton());
    const stillExpanded = (step: string) => {
      expect(home(), step).toHaveClass('home--expanded');
      expect(expandButton(), step).toHaveAttribute('aria-pressed', 'true');
    };
    stillExpanded('押した直後');

    act(() => actions().answered([count]));
    stillExpanded('回答（件数 → グラフ）');
    act(() => actions().answered([detectionImage]));
    stillExpanded('回答（検出画像 → 写真の比較）');
    await userEvent.click(tab('地図'));
    stillExpanded('タブ操作（地図）');
    await userEvent.click(tab('グラフ'));
    stillExpanded('タブ操作（グラフ）');
    act(() => actions().showView('photos'));
    stillExpanded('showView');
    act(() => actions().focusMap({ bbox: mapFocus.bbox, candidateIds: ['c-1-2-1'] }));
    stillExpanded('focusMap');
    act(() => actions().openCandidate('c-1-2-2'));
    stillExpanded('詳細を開く');
    await userEvent.click(within(await screen.findByRole('region', { name: '候補の詳細' })).getByRole('button', { name: '閉じる' }));
    stillExpanded('詳細を閉じる');
    // 押すと、戻る
    await userEvent.click(expandButton());
    expect(home()).toHaveAttribute('class', 'home');
    expect(expandButton()).toHaveAttribute('aria-pressed', 'false');
  });

  it('スクロールの合図（revealNonce）: 回答・カード・詳細の操作で画面を替えるたびに増える（画面が同じでも）。ユーザー自身のタブ操作・地図の印では増えない', async () => {
    await renderReady();
    const nonce = () => spy.area!.revealNonce!;
    const start = nonce();
    act(() => actions().answered([count]));
    expect(nonce()).toBe(start + 1);
    act(() => actions().showView('chart')); // すでにグラフ
    expect(nonce()).toBe(start + 2);
    act(() => actions().openCandidate('c-1-2-1'));
    expect(nonce()).toBe(start + 3);
    await userEvent.click(tab('地図'));
    expect(nonce()).toBe(start + 3);
    await userEvent.click(screen.getByRole('button', { name: '地図の印（c-1-2-2）' }));
    expect(nonce()).toBe(start + 3);
    act(() => spy.map!.onComparePhotos!('c-1-2-2'));
    expect(nonce()).toBe(start + 4);
    // 回答が画面を決めない（表）ときは、画面を替えないので増やさない
    act(() => actions().answered([table]));
    expect(nonce()).toBe(start + 4);
  });
});

describe('詳細の遅延マウント（「写真の比較」が見えるまで、詳細を取りに行かない）', () => {
  const tab = (name: string) => screen.getByRole('tab', { name });
  const actions = () => chat.actions!;
  const drawerNode = () => document.querySelector('.drawer');

  async function renderReady() {
    route();
    render(<HomeClient defaultResultOpen />);
    const map = await screen.findByTestId('leaflet');
    await waitFor(() => expect(map).toHaveAttribute('data-count', '2'));
    await waitFor(() => expect(chat.actions).not.toBeNull());
    return map;
  }

  beforeEach(() => {
    chat.actions = null;
  });

  it('印を 3 つ続けて押しても、詳細の通信は 0 回。「写真を比べる」を押すと、選んでいる候補の 1 回だけ', async () => {
    await renderReady();
    await userEvent.click(screen.getByRole('button', { name: '地図の印（c-1-2-2）' }));
    act(() => spy.map!.onSelect('c-1-2-1'));
    act(() => spy.map!.onSelect('c-1-2-2'));
    act(() => spy.map!.onSelect('c-1-2-1'));
    expect(drawerNode()).toBeNull();
    expect(detailCalls()).toHaveLength(0);

    await userEvent.click(screen.getByRole('button', { name: '写真を比べる' }));
    const region = await screen.findByRole('region', { name: '候補の詳細' });
    expect(await within(region).findByText('c-1-2-1')).toBeInTheDocument();
    expect(detailCalls().map(([u]) => String(u))).toEqual(['/api/candidates/c-1-2-1']);
  });

  it('タブで「写真の比較」を選んだときも、そこで初めて 1 回取る', async () => {
    await renderReady();
    await userEvent.click(screen.getByRole('button', { name: '地図の印（c-1-2-2）' }));
    expect(detailCalls()).toHaveLength(0);
    await userEvent.click(tab('写真の比較'));
    await screen.findByRole('region', { name: '候補の詳細' });
    expect(detailCalls().map(([u]) => String(u))).toEqual(['/api/candidates/c-1-2-2']);
  });

  it('チャットの「詳細」・回答の検出画像で開くときは、写真の比較が見えるので、すぐ取る', async () => {
    await renderReady();
    act(() => actions().openCandidate('c-1-2-1'));
    await screen.findByRole('region', { name: '候補の詳細' });
    expect(detailCalls().map(([u]) => String(u))).toEqual(['/api/candidates/c-1-2-1']);
  });

  it('一度見えた詳細は、別のタブへ替えても保つ（同じ要素のまま。戻しても取り直さない）', async () => {
    await renderReady();
    act(() => actions().openCandidate('c-1-2-1'));
    const region = await screen.findByRole('region', { name: '候補の詳細' });
    await within(region).findByText('どう判定したか');
    await userEvent.click(tab('地図'));
    await userEvent.click(tab('グラフ'));
    expect(region.isConnected).toBe(true);
    await userEvent.click(tab('写真の比較'));
    expect(screen.getByRole('region', { name: '候補の詳細' })).toBe(region);
    expect(detailCalls()).toHaveLength(1);
  });

  it('選んだ候補が替わったら、新しい候補は、見えるまでマウントしない（前の詳細は外れる）。見えたら、その候補を 1 回だけ取る', async () => {
    await renderReady();
    act(() => actions().openCandidate('c-1-2-1'));
    await within(await screen.findByRole('region', { name: '候補の詳細' })).findByText('どう判定したか');
    await userEvent.click(tab('地図'));
    await userEvent.click(screen.getByRole('button', { name: '地図の印（c-1-2-2）' }));
    expect(drawerNode()).toBeNull();
    expect(detailCalls()).toHaveLength(1);
    // 前に見た候補（c-1-2-1）に選び直しても、いまは見えていないので、また取りに行かない（見えた履歴は、候補が替わったら消える）
    act(() => spy.map!.onSelect('c-1-2-1'));
    act(() => spy.map!.onSelect('c-1-2-2'));
    expect(drawerNode()).toBeNull();
    expect(detailCalls()).toHaveLength(1);

    await userEvent.click(tab('写真の比較'));
    const region = await screen.findByRole('region', { name: '候補の詳細' });
    expect(await within(region).findByText('c-1-2-2')).toBeInTheDocument();
    expect(detailCalls().map(([u]) => String(u))).toEqual(['/api/candidates/c-1-2-1', '/api/candidates/c-1-2-2']);
  });

  it('詳細を閉じたあと、地図で同じ候補を選び直しても、見えるまでは取りに行かない', async () => {
    await renderReady();
    act(() => actions().openCandidate('c-1-2-1'));
    await userEvent.click(within(await screen.findByRole('region', { name: '候補の詳細' })).getByRole('button', { name: '閉じる' }));
    await userEvent.click(tab('地図'));
    await userEvent.click(screen.getByRole('button', { name: '地図の印（c-1-2-2）' }));
    act(() => spy.map!.onSelect('c-1-2-1'));
    expect(drawerNode()).toBeNull();
    expect(detailCalls()).toHaveLength(1);
  });

  it('選んでいない間の「写真の比較」は、空の状態（見えたときだけ）。選んだだけの hidden のパネルには、何も描かない', async () => {
    await renderReady();
    const panel = document.getElementById(tab('写真の比較').getAttribute('aria-controls')!)!;
    expect(panel.querySelector('.result-area__empty')).not.toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '地図の印（c-1-2-2）' }));
    expect(panel).toHaveAttribute('hidden');
    expect(panel).toBeEmptyDOMElement();
  });
});

describe('詳細を閉じたあとのフォーカス（body に落ちない）', () => {
  const tab = (name: string) => screen.getByRole('tab', { name });
  const actions = () => chat.actions!;
  const heading = () => screen.getByRole('heading', { name: '候補の詳細' });

  async function renderReady() {
    route();
    render(<HomeClient defaultResultOpen />);
    const map = await screen.findByTestId('leaflet');
    await waitFor(() => expect(map).toHaveAttribute('data-count', '2'));
    await waitFor(() => expect(chat.actions).not.toBeNull());
  }

  /** 地図の印を選び、本物の MapPanel の「写真を比べる」ボタンを押して、詳細（写真の比較）を開く */
  async function compareFromMap() {
    await userEvent.click(screen.getByRole('button', { name: '地図の印（c-1-2-2）' }));
    await userEvent.click(screen.getByRole('button', { name: '写真を比べる' }));
    return screen.findByRole('region', { name: '候補の詳細' });
  }

  beforeEach(() => {
    chat.actions = null;
  });

  it('「写真を比べる」で開いた詳細を「閉じる」で閉じる: フォーカスは「写真の比較」のタブ（body ではない）', async () => {
    await renderReady();
    const region = await compareFromMap();
    expect(heading()).toHaveFocus(); // 開くと、見出しへ
    await userEvent.click(within(region).getByRole('button', { name: '閉じる' }));
    expect(screen.queryByRole('region', { name: '候補の詳細' })).not.toBeInTheDocument();
    expect(document.activeElement).not.toBe(document.body);
    expect(tab('写真の比較')).toHaveFocus();
  });

  it('「写真を比べる」で開いた詳細を Esc で閉じる: フォーカスは「写真の比較」のタブ', async () => {
    await renderReady();
    await compareFromMap();
    expect(heading()).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('region', { name: '候補の詳細' })).not.toBeInTheDocument();
    expect(document.activeElement).not.toBe(document.body);
    expect(tab('写真の比較')).toHaveFocus();
  });

  it('検出画像の回答で自動で開いた詳細（autoFocus=false）を「閉じる」で閉じる: フォーカスは「写真の比較」のタブ', async () => {
    await renderReady();
    act(() => actions().answered([detectionImage]));
    const region = await screen.findByRole('region', { name: '候補の詳細' });
    await userEvent.click(within(region).getByRole('button', { name: '閉じる' }));
    expect(screen.queryByRole('region', { name: '候補の詳細' })).not.toBeInTheDocument();
    expect(document.activeElement).not.toBe(document.body);
    expect(tab('写真の比較')).toHaveFocus();
  });

  it('検出画像の自動の詳細を、詳細の中から Esc で閉じても、同じ', async () => {
    await renderReady();
    act(() => actions().answered([detectionImage]));
    const region = await screen.findByRole('region', { name: '候補の詳細' });
    within(region).getByRole('button', { name: '閉じる' }).focus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('region', { name: '候補の詳細' })).not.toBeInTheDocument();
    expect(tab('写真の比較')).toHaveFocus();
  });

  it('タブで写真の比較へ移して開いた詳細（autoFocus=false）を閉じても、タブへ', async () => {
    await renderReady();
    await userEvent.click(screen.getByRole('button', { name: '地図の印（c-1-2-2）' }));
    await userEvent.click(tab('写真の比較'));
    const region = await screen.findByRole('region', { name: '候補の詳細' });
    await userEvent.click(within(region).getByRole('button', { name: '閉じる' }));
    expect(tab('写真の比較')).toHaveFocus();
  });

  it('チャットの「詳細」ボタンから開いた詳細は、閉じると、押したボタンへ戻る（これまでどおり）', async () => {
    await renderReady();
    await userEvent.type(screen.getByRole('textbox', { name: '質問を入力' }), '一覧にして{Enter}');
    await screen.findByText('一覧です。');
    const opener = screen.getByRole('button', { name: /詳細.*c-1-2-1/ });
    await userEvent.click(opener);
    const region = await screen.findByRole('region', { name: '候補の詳細' });
    expect(heading()).toHaveFocus();
    await userEvent.click(within(region).getByRole('button', { name: '閉じる' }));
    expect(opener).toHaveFocus();
  });

  it('別の候補へ替えると（key={選択中の候補} の再マウント）、見出しへフォーカスが移る', async () => {
    await renderReady();
    act(() => actions().openCandidate('c-1-2-1'));
    await screen.findByRole('region', { name: '候補の詳細' });
    expect(heading()).toHaveFocus();
    // フォーカスを、詳細の外（チャットの入力）へ移してから、別の候補を開く
    const input = screen.getByRole('textbox', { name: '質問を入力' });
    input.focus();
    act(() => actions().openCandidate('c-1-2-2'));
    expect(await within(await screen.findByRole('region', { name: '候補の詳細' })).findByText('c-1-2-2')).toBeInTheDocument();
    expect(heading()).toHaveFocus();
  });
});

describe('見えていない詳細が外れる・同じ候補をもう一度開く（フォーカスの扱い）', () => {
  const tab = (name: string) => screen.getByRole('tab', { name });
  const actions = () => chat.actions!;
  const heading = () => screen.getByRole('heading', { name: '候補の詳細' });
  const marker = () => screen.getByRole('button', { name: '地図の印（c-1-2-2）' });
  const input = () => screen.getByRole('textbox', { name: '質問を入力' });

  async function renderReady() {
    route();
    render(<HomeClient defaultResultOpen />);
    const map = await screen.findByTestId('leaflet');
    await waitFor(() => expect(map).toHaveAttribute('data-count', '2'));
    await waitFor(() => expect(chat.actions).not.toBeNull());
    return map;
  }

  /** チャットに質問して表を出し、行の「詳細（c-1-2-1）」ボタンを返す */
  async function chatDetailButton() {
    await userEvent.type(input(), '一覧にして{Enter}');
    await screen.findByText('一覧です。');
    return screen.getByRole('button', { name: /詳細.*c-1-2-1/ });
  }

  beforeEach(() => {
    chat.actions = null;
  });

  it('再現 A: 「写真を比べる」で開いた詳細を残して地図へ戻り、別の印を Enter で選んでも、フォーカスは押した印のまま（写真の比較のタブへ飛ばない）', async () => {
    const map = await renderReady();
    // 地図の中の印から「写真を比べる」を押した形: フォーカスは、写真の比較のタブへ移り、詳細の見出しへ移る
    marker().focus();
    act(() => spy.map!.onComparePhotos!('c-1-2-1'));
    await screen.findByRole('region', { name: '候補の詳細' });
    expect(heading()).toHaveFocus();
    await userEvent.click(tab('地図'));
    // 別の印にフォーカスして Enter。見えていない詳細（c-1-2-1）は外れる
    marker().focus();
    await userEvent.keyboard('{Enter}');
    expect(map).toHaveAttribute('data-selected', 'c-1-2-2');
    expect(document.querySelector('.drawer')).toBeNull();
    expect(marker()).toHaveFocus();
    expect(tab('写真の比較')).not.toHaveFocus();
  });

  it('再現 B: チャットの表の「詳細」で開いた詳細を残して地図へ戻り、別の印を選んでも、フォーカスはチャットの「詳細」ボタンへ飛ばない', async () => {
    await renderReady();
    const opener = await chatDetailButton();
    await userEvent.click(opener);
    await screen.findByRole('region', { name: '候補の詳細' });
    await userEvent.click(tab('地図'));
    await userEvent.click(marker());
    expect(document.querySelector('.drawer')).toBeNull();
    expect(marker()).toHaveFocus();
    expect(opener).not.toHaveFocus();
  });

  it('再現 C: チャットの「詳細」で開いた詳細が、入力欄で聞いた回答（検出画像）で別の候補に替わっても、入力欄のフォーカスを奪わない', async () => {
    await renderReady();
    const opener = await chatDetailButton();
    await userEvent.click(opener);
    await screen.findByRole('region', { name: '候補の詳細' });
    input().focus();
    act(() => actions().answered([{ ...detectionImage, candidate_id: 'c-1-2-2' }]));
    expect(await within(await screen.findByRole('region', { name: '候補の詳細' })).findByText('c-1-2-2')).toBeInTheDocument();
    expect(input()).toHaveFocus();
    expect(opener).not.toHaveFocus();
  });

  it('同じ候補の詳細が、フォーカスを移さずに開いている（検出画像の回答）とき、チャットの「詳細」を押すと、見出しへフォーカスが移る。閉じると、押したボタンへ戻る', async () => {
    await renderReady();
    act(() => actions().answered([{ ...detectionImage, candidate_id: 'c-1-2-1' }]));
    const region = await screen.findByRole('region', { name: '候補の詳細' });
    expect(heading()).not.toHaveFocus();
    // 質問して表を出す（回答は地図へ切り替える）。詳細（c-1-2-1）は外さずに、見えないまま残る
    const opener = await chatDetailButton();
    expect(screen.getByRole('region', { name: '候補の詳細', hidden: true })).toBe(region);
    await userEvent.click(opener);
    expect(tab('写真の比較')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('region', { name: '候補の詳細' })).toBe(region); // 取り直さない（同じ詳細のまま）
    expect(detailCalls()).toHaveLength(1);
    expect(heading()).toHaveFocus();
    await userEvent.click(within(region).getByRole('button', { name: '閉じる' }));
    expect(opener).toHaveFocus();
  });

  it('同じ候補を、見えているまま、もう一度チャットの「詳細」で開いたときも、見出しへ移す', async () => {
    await renderReady();
    const opener = await chatDetailButton();
    await userEvent.click(opener);
    await screen.findByRole('region', { name: '候補の詳細' });
    expect(heading()).toHaveFocus();
    opener.focus();
    await userEvent.keyboard('{Enter}');
    expect(heading()).toHaveFocus();
  });

  it('地図の印を選び、タブで写真の比較を見た（詳細は、フォーカスを移さずに開いた）あと、地図へ戻って同じ候補の「写真を比べる」を押すと、見出しへフォーカスが移る', async () => {
    await renderReady();
    await userEvent.click(marker());
    await userEvent.click(tab('写真の比較'));
    await screen.findByRole('region', { name: '候補の詳細' });
    expect(heading()).not.toHaveFocus();
    await userEvent.click(tab('地図'));
    await userEvent.click(screen.getByRole('button', { name: '写真を比べる' }));
    expect(tab('写真の比較')).toHaveAttribute('aria-selected', 'true');
    expect(heading()).toHaveFocus();
    expect(detailCalls()).toHaveLength(1); // 同じ詳細のまま（取り直さない）
  });

  it('地図の印・検出画像の回答で同じ候補を選び直しても（フォーカスを移さない経路）、見出しへは移さない', async () => {
    await renderReady();
    act(() => actions().answered([{ ...detectionImage, candidate_id: 'c-1-2-2' }]));
    await screen.findByRole('region', { name: '候補の詳細' });
    input().focus();
    act(() => actions().answered([{ ...detectionImage, candidate_id: 'c-1-2-2' }]));
    act(() => spy.map!.onSelect('c-1-2-2'));
    expect(input()).toHaveFocus();
    expect(heading()).not.toHaveFocus();
  });
});

describe('詳細が届いてから地図を寄せる予約（pendingFocusId）の取り消し', () => {
  const actions = () => chat.actions!;
  /** 地図の候補データに無い候補（byId に無い）の詳細を、開けるまで待たせる */
  async function renderWithGate() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    route({
      '/api/candidates.geojson': () => jsonResponse({ type: 'FeatureCollection', features: [] }),
      '/api/candidates/c-1-2-1': async () => {
        await gate;
        return jsonResponse({ ...detail, id: 'c-1-2-1' });
      },
    });
    render(<HomeClient defaultResultOpen />);
    await screen.findByTestId('leaflet');
    await waitFor(() => expect(chat.actions).not.toBeNull());
    return release;
  }

  beforeEach(() => {
    chat.actions = null;
  });

  it('候補の形が地図の候補データから分かるときは、予約しない。詳細が届いても、地図を寄せ直さない（そのあいだに動かした地図を、引き戻さない）', async () => {
    route();
    render(<HomeClient defaultResultOpen />);
    const map = await screen.findByTestId('leaflet');
    await waitFor(() => expect(map).toHaveAttribute('data-count', '2'));
    await waitFor(() => expect(chat.actions).not.toBeNull());
    act(() => actions().openCandidate('c-1-2-1'));
    expect(map).toHaveAttribute('data-focus', 'fit'); // 形が分かるので、すぐ寄せる
    const nonce = map.getAttribute('data-focus-nonce');
    await within(await screen.findByRole('region', { name: '候補の詳細' })).findByText('どう判定したか');
    await act(async () => {}); // 詳細が届いたあとの効果（onLoaded → 寄せる）が、済むまで待つ
    expect(map.getAttribute('data-focus-nonce')).toBe(nonce);
  });

  it('形が分かる候補を開いたとき、前の（まだ詳細が届いていない）候補の予約も取り消す。あとでその候補の詳細が届いても、寄せない', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    route({
      // c-1-2-2 だけが地図の候補データにある。c-1-2-1 は形が分からず、詳細が届くまで予約する
      '/api/candidates.geojson': () => jsonResponse({ type: 'FeatureCollection', features: features.slice(1) }),
      '/api/candidates/c-1-2-1': async () => {
        await gate;
        return jsonResponse({ ...detail, id: 'c-1-2-1' });
      },
    });
    render(<HomeClient defaultResultOpen />);
    const map = await screen.findByTestId('leaflet');
    await waitFor(() => expect(map).toHaveAttribute('data-count', '1'));
    await waitFor(() => expect(chat.actions).not.toBeNull());
    act(() => actions().openCandidate('c-1-2-1')); // 予約する（まだ寄せない）
    expect(map).toHaveAttribute('data-focus', '');
    act(() => actions().openCandidate('c-1-2-2')); // 形が分かる: すぐ寄せ、前の予約は取り消す
    expect(map).toHaveAttribute('data-focus', 'fit');
    const nonce = map.getAttribute('data-focus-nonce');
    // 予約を作り直さない経路（地図の上の「写真を比べる」）で、前の候補の詳細を出す
    act(() => spy.map!.onComparePhotos!('c-1-2-1'));
    release();
    await within(await screen.findByRole('region', { name: '候補の詳細' })).findByText('どう判定したか');
    await act(async () => {});
    expect(map.getAttribute('data-focus-nonce')).toBe(nonce);
  });

  it('対照: 予約したまま詳細が届けば、地図を寄せる', async () => {
    const release = await renderWithGate();
    act(() => actions().openCandidate('c-1-2-1'));
    expect(spy.map?.focus).toBeNull();
    release();
    await within(await screen.findByRole('region', { name: '候補の詳細' })).findByText('どう判定したか');
    await waitFor(() => expect(spy.map?.focus).not.toBeNull());
  });

  it('届く前に、地図の印（selectFromMap）で選び直すと、予約は取り消される（届いても寄せない）', async () => {
    const release = await renderWithGate();
    act(() => actions().openCandidate('c-1-2-1'));
    act(() => spy.map!.onSelect('c-1-2-1'));
    release();
    await within(await screen.findByRole('region', { name: '候補の詳細' })).findByText('どう判定したか');
    await act(async () => {}); // 詳細が届いたあとの効果（onLoaded → 寄せる）が、済むまで待つ
    expect(spy.map?.focus).toBeNull();
  });

  it('届く前に、詳細を閉じる（closeDrawer）と、予約は取り消される（あとで同じ候補の詳細が出ても寄せない）', async () => {
    const release = await renderWithGate();
    act(() => actions().openCandidate('c-1-2-1'));
    await userEvent.click(within(await screen.findByRole('region', { name: '候補の詳細' })).getByRole('button', { name: '閉じる' }));
    // 予約を作り直さない経路（地図の上の「写真を比べる」）で、同じ候補の詳細を出す
    act(() => spy.map!.onComparePhotos!('c-1-2-1'));
    release();
    await within(await screen.findByRole('region', { name: '候補の詳細' })).findByText('どう判定したか');
    await act(async () => {});
    expect(spy.map?.focus).toBeNull();
  });

  it('候補の位置が、地図の候補データから分かるときは、予約を作らない: 地図は開いたときに 1 回だけ寄り、詳細が届いても寄せ直さない（そのあいだに利用者が動かした地図を、引き戻さない）', async () => {
    route();
    render(<HomeClient defaultResultOpen />);
    await screen.findByTestId('leaflet');
    await waitFor(() => expect(chat.actions).not.toBeNull());
    await waitFor(() => expect(spy.map?.candidatesState.status).toBe('ready'));
    act(() => actions().openCandidate('c-1-2-1'));
    const first = spy.map!.focus;
    expect(first).not.toBeNull();
    expect(first!.ids).toEqual(['c-1-2-1']);
    await within(await screen.findByRole('region', { name: '候補の詳細' })).findByText('どう判定したか');
    await act(async () => {}); // 詳細が届いたあとの効果（onLoaded → 寄せる）が、済むまで待つ
    expect(spy.map!.focus).toBe(first); // 同じ要求（nonce も同じ）のまま。2 回目は来ない
  });
});

describe('地図の表示範囲（絞り込みの経路が違っても同じ）と、選択の解除', () => {
  const twoAreas: AreaSummary[] = [
    { ...areas[0]!, id: 'z18-1-2', bbox: [130.7, 32.8, 130.701, 32.801] },
    { ...areas[0]!, id: 'z18-2-2', name: 'テスト地区 02', bbox: [130.8, 32.9, 130.801, 32.901], centroid: [130.8005, 32.9005] },
  ];
  const BOX_1 = '130.7,32.8,130.701,32.801';
  const BOX_2 = '130.8,32.9,130.801,32.901';
  const BOX_ALL = '130.7,32.8,130.801,32.901';
  const tab = (name: string) => screen.getByRole('tab', { name });
  const actions = () => chat.actions!;

  async function renderReady() {
    route({ '/api/areas': () => jsonResponse(twoAreas) });
    render(<HomeClient defaultResultOpen />);
    const map = await screen.findByTestId('leaflet');
    await waitFor(() => expect(map).toHaveAttribute('data-count', '2'));
    await waitFor(() => expect(chat.actions).not.toBeNull());
    await screen.findByRole('option', { name: /テスト地区 02/ });
    return map;
  }

  beforeEach(() => {
    chat.actions = null;
  });

  it('グラフの行で地区を絞ってから地図へ戻ると、地図はその地区へ寄っている。「条件を解除」で、全地区へ戻る', async () => {
    const map = await renderReady();
    expect(map).toHaveAttribute('data-focus', '');
    await userEvent.click(tab('グラフ'));
    await userEvent.click(screen.getByRole('button', { name: /グラフの行/ }));
    await userEvent.click(tab('地図'));
    expect(map).toHaveAttribute('data-focus-bbox', BOX_1);
    await userEvent.click(screen.getByRole('button', { name: '条件を解除' }));
    expect(map).toHaveAttribute('data-focus-bbox', BOX_ALL);
  });

  it('回答の条件（件数の地区）でも、同じ。地図の画面でなくても、地図は条件の地区へ寄る', async () => {
    const map = await renderReady();
    act(() => actions().answered([{ ...count, filter: { area_id: 'z18-2-2', cls: null } }]));
    expect(tab('グラフ')).toHaveAttribute('aria-selected', 'true');
    expect(map).toHaveAttribute('data-focus-bbox', BOX_2);
  });

  it('「地図で見る」（showView の地図）: 条件の地区（なければ全地区）が収まる範囲へ寄せる。地図がすでに出ていて動かしたあとでも、押すたびに寄せ直す', async () => {
    const map = await renderReady();
    act(() => actions().showView('map'));
    expect(map).toHaveAttribute('data-focus-bbox', BOX_ALL);
    const first = Number(map.getAttribute('data-focus-nonce'));
    act(() => actions().showView('map'));
    expect(Number(map.getAttribute('data-focus-nonce'))).toBeGreaterThan(first);
    // 条件つきなら、その条件の地区へ（絞り込みの替えと、同じ描画で 1 回だけ寄せる）
    act(() => actions().showView('map', { areaId: 'z18-2-2', classes: new Set(['confirmed_new', 'existing_omission', 'uncertain']) }));
    expect(map).toHaveAttribute('data-focus-bbox', BOX_2);
    act(() => actions().showView('chart'));
    expect(map).toHaveAttribute('data-focus-bbox', BOX_2); // グラフへ切り替えただけでは、動かさない
  });

  it('チャットの「解析した地区を地図で見る」: 地区を選んで拡大していても、押すと、いまの対象（全地区）の範囲へ寄せ直す', async () => {
    const map = await renderReady();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '地区' }), 'z18-1-2');
    expect(map).toHaveAttribute('data-focus-bbox', BOX_1);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '地区' }), '');
    expect(map).toHaveAttribute('data-focus-bbox', BOX_ALL);
    // 手で地図を動かした（拡大・移動）あとの再表示は、いまの nonce より新しい要求になる
    const before = Number(map.getAttribute('data-focus-nonce'));
    await userEvent.click(screen.getByRole('button', { name: '解析した地区を地図で見る' }));
    expect(map).toHaveAttribute('data-focus-bbox', BOX_ALL);
    expect(Number(map.getAttribute('data-focus-nonce'))).toBeGreaterThan(before);
  });

  it('候補を選ぶ（地区が絞り込みの外）と、全地区へ戻す絞り込みの変更があっても、地図は選んだ候補へ寄る（全体へ引き戻さない）', async () => {
    const map = await renderReady();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '地区' }), 'z18-2-2');
    expect(map).toHaveAttribute('data-focus-bbox', BOX_2);
    act(() => actions().openCandidate('c-1-2-1')); // z18-1-2 の候補。絞り込みを全地区へ広げる（画面は写真の比較へ替わるので、地図の中は hidden）
    expect(screen.getByRole('combobox', { name: '地区', hidden: true })).toHaveValue('');
    expect(map).toHaveAttribute('data-focus-bbox', '130.7,32.8,130.7001,32.8001');
  });

  it('グラフの「地図で見る」: 地図の画面へ切り替える', async () => {
    await renderReady();
    await userEvent.click(tab('グラフ'));
    await userEvent.click(screen.getByRole('button', { name: 'グラフから地図へ' }));
    expect(tab('地図')).toHaveAttribute('aria-selected', 'true');
  });

  it('選択を解除する: カードの「選択を解除」・Esc。写真の比較の選択も外れ、空の状態に戻る（印を選び直せる）', async () => {
    const map = await renderReady();
    await userEvent.click(screen.getByRole('button', { name: '地図の印（c-1-2-2）' }));
    expect(map).toHaveAttribute('data-selected', 'c-1-2-2');
    await userEvent.click(screen.getByRole('button', { name: '選択を解除' }));
    expect(map).toHaveAttribute('data-selected', '');
    expect(screen.queryByRole('group', { name: '選択中の候補' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '地図の印（c-1-2-2）' }));
    expect(map).toHaveAttribute('data-selected', 'c-1-2-2');
    (document.activeElement as HTMLElement).blur();
    await userEvent.keyboard('{Escape}');
    expect(map).toHaveAttribute('data-selected', 'c-1-2-2'); // フォーカスが地図の外（body）にあるあいだは、Esc は奪わない
    screen.getByRole('button', { name: '地図の印（c-1-2-2）' }).focus();
    await userEvent.keyboard('{Escape}');
    expect(map).toHaveAttribute('data-selected', '');
  });
});

describe('最初の画面（結果領域は閉じている）と、開く・閉じる', () => {
  const resultRegion = () => screen.queryByRole('region', { name: '結果' });
  const home = (container: HTMLElement) => container.querySelector('.home')!;
  /** 結果領域が開く前から DOM にある、画面を替えた知らせの live region（チャットの「調べています」の status とは別） */
  const announcer = (container: HTMLElement) => container.querySelector<HTMLElement>('.home > [role="status"][aria-live="polite"]')!;
  const showMapButton = () => screen.getByRole('button', { name: '解析した地区を地図で見る' });

  beforeEach(() => {
    chat.actions = null;
  });

  it('会話の前は、チャットだけを出す。結果領域（地図・タブ・拡大）は、マウントもしない', async () => {
    route();
    const { container } = render(<HomeClient />);
    await waitFor(() => expect(chat.actions).not.toBeNull());
    expect(resultRegion()).toBeNull();
    expect(screen.queryByTestId('leaflet')).toBeNull();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('button', { name: '拡大' })).toBeNull();
    expect(home(container)).toHaveClass('home--chat-only');
    expect(spy.area).toBeNull();
    // 知らせの live region は、開く前から DOM にあり、空
    expect(announcer(container)).toBeEmptyDOMElement();
  });

  it('「解析した地区を地図で見る」で、結果領域が開いて地図を出す。開いたことを、先からある live region が知らせる', async () => {
    route();
    const { container } = render(<HomeClient />);
    await waitFor(() => expect(chat.actions).not.toBeNull());
    const live = announcer(container);
    await userEvent.click(showMapButton());
    const map = await screen.findByTestId('leaflet');
    await waitFor(() => expect(map).toHaveAttribute('data-count', '2'));
    expect(resultRegion()).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '地図' })).toHaveAttribute('aria-selected', 'true');
    expect(home(container)).not.toHaveClass('home--chat-only');
    // 同じ要素が、そのまま知らせを持つ（開くときに作り直さない）
    expect(announcer(container)).toBe(live);
    expect(live).toHaveTextContent('「地図」を表示しました');
    // 開いた直後に、縦に積む幅でも見える所へ動かす合図（最初から開いて描くときは false）
    expect(spy.area?.revealOnMount).toBe(true);
  });

  it('defaultResultOpen で始めると、最初から開いている（勝手にスクロールもしない）', async () => {
    route();
    const { container } = render(<HomeClient defaultResultOpen />);
    expect(await screen.findByRole('region', { name: '結果' })).toBeInTheDocument();
    expect(home(container)).not.toHaveClass('home--chat-only');
    expect(spy.area?.revealOnMount).toBe(false);
  });

  it('結果つきの回答（件数・地図の表示）が届くと開く。画面を替える結果が無い回答では、開かない', async () => {
    route();
    render(<HomeClient />);
    await waitFor(() => expect(chat.actions).not.toBeNull());
    act(() => chat.actions!.answered([]));
    expect(resultRegion()).toBeNull();
    act(() => chat.actions!.answered([count]));
    expect(await screen.findByRole('region', { name: '結果' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'グラフ' })).toHaveAttribute('aria-selected', 'true');
  });

  it('結果カードの「詳細」（写真の比較）・地図の表示の操作でも、閉じていた結果領域が開く', async () => {
    route();
    render(<HomeClient />);
    await waitFor(() => expect(chat.actions).not.toBeNull());
    act(() => chat.actions!.openCandidate('c-1-2-1'));
    expect(await screen.findByRole('tab', { name: '写真の比較' })).toHaveAttribute('aria-selected', 'true');
    cleanup();
    chat.actions = null;
    route();
    render(<HomeClient />);
    await waitFor(() => expect(chat.actions).not.toBeNull());
    act(() => chat.actions!.focusMap({ bbox: [130.7, 32.8, 130.71, 32.81], candidateIds: ['c-1-2-1'] }));
    expect(await screen.findByRole('tab', { name: '地図' })).toHaveAttribute('aria-selected', 'true');
  });

  it('質問を送って結果つきの回答が届くと開き、「新しい会話」で最初の画面へ戻る。開き直すと、前の会話の強調・選択・絞り込みは残っていない', async () => {
    route();
    const { container } = render(<HomeClient />);
    await waitFor(() => expect(chat.actions).not.toBeNull());
    await userEvent.type(screen.getByRole('textbox', { name: '質問を入力' }), '一覧を見せて');
    await userEvent.click(screen.getByRole('button', { name: '送信' }));
    const map = await screen.findByTestId('leaflet');
    await waitFor(() => expect(map).toHaveAttribute('data-count', '2'));
    // 回答の地図の表示（mapFocus）が、候補を強調する
    await waitFor(() => expect(map).toHaveAttribute('data-highlight', 'c-1-2-1,c-1-2-2,c-1-2-3'));
    expect(map).toHaveAttribute('data-focus', 'fit');

    await userEvent.click(screen.getByRole('button', { name: '新しい会話' }));
    expect(resultRegion()).toBeNull();
    expect(screen.queryByTestId('leaflet')).toBeNull();
    expect(home(container)).toHaveClass('home--chat-only');
    expect(announcer(container)).toBeEmptyDOMElement();

    await userEvent.click(showMapButton());
    const again = await screen.findByTestId('leaflet');
    await waitFor(() => expect(again).toHaveAttribute('data-count', '2'));
    expect(again).toHaveAttribute('data-highlight', '');
    expect(again).toHaveAttribute('data-selected', '');
    expect(screen.getByRole('tab', { name: '地図' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('button', { name: '拡大' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('サイドパネルの「新しい会話」（登録された処理）でも、結果領域は閉じる', async () => {
    route();
    const { container } = render(<HomeClient defaultResultOpen />);
    await screen.findByRole('region', { name: '結果' });
    await userEvent.click(showMapButton());
    // チャットに会話が無くても、onNewConversation は、会話を空にする処理の中で呼ばれる
    await userEvent.type(screen.getByRole('textbox', { name: '質問を入力' }), 'x');
    await userEvent.click(screen.getByRole('button', { name: '送信' }));
    await userEvent.click(await screen.findByRole('button', { name: '新しい会話' }));
    expect(resultRegion()).toBeNull();
    expect(home(container)).toHaveClass('home--chat-only');
  });
});
