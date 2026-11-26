import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, type ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnswerRef, ExpandRequest, FigureKind } from '../lib/answer-view';
import type { AreaSummary, CandidateFeature, ToolResult } from '../lib/api-types';
import type { MapFilter, ResultView } from '../lib/result-view';
import { accuracy, areas, compare, count, countWards, detail, detectionImage, jsonResponse, mapFocus, refusal, table } from '../tests/fixtures';
import type { CandidateDrawer } from './CandidateDrawer';
import type { ChatActions } from './chat/types';
import { HomeClient } from './HomeClient';
import type { MapPanel } from './map/MapPanel';
import { NewConversationProvider, useStartNewConversation } from './NewConversation';

// 拡大ビューを開く操作（expand）は、チャットが呼ぶ。ここでは本物のチャットを使いつつ、渡された操作を控えて、テストから直接呼ぶ（回答を指定して開く）。
// ボタンを押して開く経路は、本物のチャットのカードで確かめる
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

// 地図・詳細に渡る props を控える（本物をそのまま描く）。地図の上のボタン・詳細のフォーカスは担当が別なので、ここでは、渡す値と、渡された操作を呼んだときの動きだけを見る
const spy = vi.hoisted(() => ({
  map: null as ComponentProps<typeof MapPanel> | null,
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
const other: CandidateFeature = {
  type: 'Feature',
  id: 'c-3-3-1',
  geometry: square(130.72),
  properties: { id: 'c-3-3-1', class: 'existing_omission', area_m2: 40, area_id: 'z18-3-3' },
};

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

// ---- 共通の道具 ----

const tab = (name: string) => screen.getByRole('tab', { name });
/** 拡大ビュー（タブの画面の側。質問の行と 3 つの画面）。開いていなければ null */
const panel = () => document.querySelector<HTMLElement>('.expanded-view');
const panelEl = () => {
  const el = panel();
  if (!el) throw new Error('拡大ビューが開いていない');
  return el;
};
/** 拡大ビューの中のグラフ。回答の中の図にも同じ部品が出るので、拡大ビューの中に限る */
const chart = () => within(panelEl()).getByTestId('chart');
/** 拡大ビューの中の地図 */
const panelMap = () => within(panelEl()).getByTestId('leaflet');
const input = () => screen.getByRole('textbox', { name: '質問を入力' });
const heading = () => screen.getByRole('heading', { name: '候補の詳細' });
/** 拡大ビューを閉じる操作は Esc だけ（「閉じる」ボタンは無い。ADR 0008）。選んでいるタブにフォーカスがある状態で押す */
const closeDialog = async () => {
  const tab = screen.getAllByRole('tab', { selected: true })[0];
  tab!.focus();
  await userEvent.keyboard('{Escape}');
};

/** 回答の中の図（名前つきの region）。root は、探す範囲（既定は画面全体。回答が複数あるときは、その回答の発言） */
const figureRegion = (kind: FigureKind, root: Pick<typeof screen, 'getByRole'> = screen) => root.getByRole('region', { name: kind === 'map' ? '地図' : 'グラフ' });
const figureExpand = (kind: FigureKind, root: Pick<typeof screen, 'getByRole'> = screen) =>
  within(figureRegion(kind, root)).getByRole('button', { name: kind === 'map' ? '地図を拡大ビューで開く' : 'グラフを拡大ビューで開く' });
/** 本文の文で探した回答の発言（結果カード・図を含む） */
const answerBox = (text: string) => within(screen.getByText(text).closest<HTMLElement>('[data-entry="assistant"]')!);

let nextAnswer = 0;
/** 回答（拡大の単位）。結果は、その回答の道具の結果 */
const answerOf = (...results: ToolResult[]): AnswerRef => ({ id: `a${++nextAnswer}`, results });
const view = (v: ResultView): ExpandRequest => ({ type: 'view', view: v });
const candidate = (id: string): ExpandRequest => ({ type: 'candidate', id });
/** チャットのカードのボタンを押すのと同じ操作を、回答を指定して呼ぶ */
const expand = (answer: AnswerRef | null, request: ExpandRequest, opener: HTMLElement | null = null) => act(() => chat.actions!.expand(answer, request, opener));
/** 結果が返ってくる・描画が済むのを待つ（読み込みの完了で state が更新される） */
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

/** 地区の一覧と候補データが届くまで待ってから返す（拡大ビューは、開いた時点の読み込み済みの値で、はじめての状態を決める） */
async function renderLoaded(overrides: Record<string, () => Response | Promise<Response>> = {}) {
  route(overrides);
  const rendered = render(<HomeClient />);
  await waitFor(() => expect(chat.actions).not.toBeNull());
  await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith('/api/candidates.geojson'))).toBe(true));
  await settle();
  return rendered;
}

/** 最初の画面の「解析した地区を地図で見る」を押して、拡大ビュー（地図）を開く。地図の候補が届くまで待つ */
async function openWelcomeMap(count = 2) {
  await userEvent.click(screen.getByRole('button', { name: '解析した地区を地図で見る' }));
  const map = await screen.findByTestId('leaflet');
  await waitFor(() => expect(map).toHaveAttribute('data-count', String(count)));
  return map;
}

/** 質問を送り、返ってきた回答（結果カード）が会話に出るまで待つ */
async function ask(results: ToolResult[], content = '回答です。', question = '質問です') {
  route({ '/api/chat': () => jsonResponse({ message: { role: 'assistant', content, results, tool_calls: [] } }) });
  const rendered = render(<HomeClient />);
  await waitFor(() => expect(chat.actions).not.toBeNull());
  await userEvent.type(input(), `${question}{Enter}`);
  await screen.findByText(content);
  return rendered;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  spy.map = null;
  spy.drawer = null;
  chat.actions = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('最初の画面と、回答が届いたとき（チャットの 1 列。拡大ビューは開かない）', () => {
  it('最初の画面は、チャットのタブを選んだ状態。タブの帯（4 つ。「閉じる」は無い）とチャットの枠と空の知らせの領域だけで、拡大ビュー・地図・「拡大」ボタン・結果領域は、マウントもしない。画面を替えた知らせの live region も無い', async () => {
    await renderLoaded();
    const home = document.querySelector('.home')!;
    expect(home).toHaveClass('home');
    // タブの帯・チャットの枠・空の知らせの領域（新着用）だけ。パネルは無い
    expect(Array.from(home.children).map((c) => c.className)).toEqual(['home__tabs', 'home__chat', 'visually-hidden']);
    expect(home.querySelector('.home__chat')!.firstElementChild).toHaveClass('chat');
    expect(home.querySelector('.home__chat')).toHaveAttribute('role', 'tabpanel');
    expect(within(screen.getByRole('tablist')).getAllByRole('tab').map((x) => x.textContent)).toEqual(['回答', '地図', 'グラフ', '画像']);
    expect(tab('回答')).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('button', { name: '閉じる' })).toBeNull();
    expect(panel()).toBeNull();
    expect(screen.queryByTestId('leaflet')).toBeNull();
    expect(screen.queryByRole('region', { name: '結果' })).toBeNull();
    expect(screen.queryByRole('button', { name: '拡大' })).toBeNull();
    // 新着の知らせの領域は、空のまま先に置いてある（何も入れていない）
    expect(document.querySelector('.home > [aria-live]')).toBeNull();
    expect(document.querySelector('.home > [role="status"]')).toBeEmptyDOMElement();
    expect(spy.map).toBeNull();
    expect(spy.drawer).toBeNull();
    // 見出し・「解析した地区を地図で見る」・質問の例・入力欄は、ここにある
    expect(screen.getByRole('heading', { name: /写真と会話で調べる/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '解析した地区を地図で見る' })).toBeInTheDocument();
  });

  it('結果つきの回答（件数・地図の表示・検出画像）が届いても、拡大ビューは開かず、画面は替わらない。カードと図は会話の中に出て、詳細も取りに行かない', async () => {
    await ask([count, mapFocus, detectionImage], '件数と地図と写真です。');
    expect(screen.getByRole('region', { name: count.title })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: mapFocus.title })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: detectionImage.title })).toBeInTheDocument();
    // 件数と地図の表示から、地図とグラフの図が 1 つずつ、回答の中に出る（地図は 1 つだけ。拡大ビューではない）
    expect(figureRegion('map')).toBeInTheDocument();
    expect(figureRegion('chart')).toBeInTheDocument();
    expect(await screen.findAllByTestId('leaflet')).toHaveLength(1);
    expect(screen.getAllByTestId('chart')).toHaveLength(1);
    expect(panel()).toBeNull();
    expect(tab('回答')).toHaveAttribute('aria-selected', 'true');
    expect(spy.drawer).toBeNull();
    expect(detailCalls()).toHaveLength(0);
    // 続けて、別の結果つきの回答（表・地図の表示）が届いても、拡大ビューは開かない（図は、その回答の中に増える）
    route();
    await userEvent.type(input(), '一覧も{Enter}');
    await screen.findByText('一覧です。');
    expect(panel()).toBeNull();
    await waitFor(() => expect(screen.getAllByTestId('leaflet')).toHaveLength(2));
    expect(screen.getAllByRole('region', { name: '地図' })).toHaveLength(2);
  });

  it('比較の回答は、地区の数字の表を会話に出さず、要点（最多の地区・合計）だけを出す。全地区は、回答の中のグラフで読める。拡大ビューは開かない', async () => {
    const items = Array.from({ length: 8 }, (_, i) => ({
      area_id: `z18-${i + 1}-1`,
      name: `地区 ${i + 1}`,
      counts: { confirmed_new: 8 - i, existing_omission: 0, uncertain: 0, total: 8 - i },
    }));
    await ask([{ ...compare, items }], '比べました。');
    const card = screen.getByRole('region', { name: compare.title });
    expect(within(card).queryAllByRole('row')).toHaveLength(0);
    expect(within(card).getByText('候補が最も多いのは地区 1で、8 件です。')).toBeInTheDocument();
    expect(within(card).queryByText(/地区中 5 地区を表示/)).not.toBeInTheDocument();
    expect(panel()).toBeNull();
  });
});

describe('結果カードのボタンで、その回答の拡大ビューが開く（全幅のタブ。モーダルではない。aria-modal なし）', () => {
  /** 開いた拡大ビューの共通の確かめ。モーダルでも領域でもない・選んだタブが選択中・フォーカスはタブの帯か中へ */
  function expectOpenDialog(selectedTab: string) {
    const d = panelEl();
    expect(d).not.toHaveAttribute('aria-modal');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(tab(selectedTab)).toHaveAttribute('aria-selected', 'true');
    const active = document.activeElement as HTMLElement;
    expect(d.contains(active) || tab(selectedTab).closest('.result-area__bar')!.contains(active)).toBe(true);
    return d;
  }

  it('件数のグラフの「グラフを拡大」: グラフの画面で開く。回答の条件（分類 = 新規出現）が、グラフにも拡大ビューにも写る。押したボタンは、閉じるまで覚えている', async () => {
    await ask([count]);
    // 図のグラフは、はじめから回答の条件で出ている
    await waitFor(() => expect(within(figureRegion('chart')).getByTestId('chart')).toHaveAttribute('data-classes', 'confirmed_new'));
    expect(within(figureRegion('chart')).getByTestId('chart')).toHaveAttribute('data-area-id', '');
    await userEvent.click(figureExpand('chart'));
    expectOpenDialog('グラフ');
    expect(tab('グラフ')).toHaveFocus();
    expect(chart()).toHaveAttribute('data-classes', 'confirmed_new');
    expect(chart()).toHaveAttribute('data-area-id', '');
  });

  it('件数の地図の「地図を拡大」: 地図の画面で開く。回答の条件の分類だけを、図の地図にも拡大ビューの地図にも出す', async () => {
    await ask([count]);
    const inline = await within(figureRegion('map')).findByTestId('leaflet');
    await waitFor(() => expect(inline).toHaveAttribute('data-count', '1'));
    expect(inline).toHaveAttribute('data-classes', 'confirmed_new');
    await userEvent.click(figureExpand('map'));
    expectOpenDialog('地図');
    const map = panelMap();
    await waitFor(() => expect(map).toHaveAttribute('data-count', '1'));
    expect(map).toHaveAttribute('data-classes', 'confirmed_new');
  });

  it('比較の回答は、グラフの図だけ（地図の図は無い）。「グラフを拡大」で、グラフの画面で開く。比較は 3 分類すべて、地区は全地区', async () => {
    await ask([compare]);
    expect(screen.queryByRole('region', { name: '地図' })).toBeNull();
    expect(screen.queryByTestId('leaflet')).toBeNull();
    await userEvent.click(figureExpand('chart'));
    expectOpenDialog('グラフ');
    expect(chart()).toHaveAttribute('data-classes', 'confirmed_new,existing_omission,uncertain');
    expect(chart()).toHaveAttribute('data-area-id', '');
  });

  it('地図の表示の回答: 地図の図に、その候補が目立って出る。カードの「地図で見る」は、地図の画面で開き、その候補を目立たせ、範囲へ寄せる', async () => {
    await ask([mapFocus]);
    const inline = await within(figureRegion('map')).findByTestId('leaflet');
    expect(inline).toHaveAttribute('data-highlight', 'c-1-2-1,c-1-2-2,c-1-2-3');
    expect(inline).toHaveAttribute('data-focus-bbox', mapFocus.bbox.join(','));
    expect(screen.queryByRole('region', { name: 'グラフ' })).toBeNull();
    await userEvent.click(within(screen.getByRole('region', { name: mapFocus.title })).getByRole('button', { name: '地図で見る' }));
    expectOpenDialog('地図');
    const map = panelMap();
    expect(map).toHaveAttribute('data-highlight', 'c-1-2-1,c-1-2-2,c-1-2-3');
    expect(map).toHaveAttribute('data-focus-bbox', mapFocus.bbox.join(','));
  });

  it('表の「詳細」: 写真の比較で開き、その候補の詳細を出す（見出しへフォーカス）。地図もその候補を選んで寄せる', async () => {
    await ask([table]);
    await userEvent.click(screen.getByRole('button', { name: /詳細.*c-1-2-1/ }));
    expectOpenDialog('画像');
    const region = await screen.findByRole('region', { name: '候補の詳細' });
    expect(await within(region).findAllByRole('img')).toHaveLength(2);
    expect(heading()).toHaveFocus();
    expect(spy.drawer).toMatchObject({ candidateId: 'c-1-2-1', autoFocus: true });
    expect(screen.getByTestId('leaflet')).toHaveAttribute('data-selected', 'c-1-2-1');
  });

  it('検出画像の「詳細を開く」: 写真の比較で開き、その候補の詳細を出す', async () => {
    await ask([detectionImage]);
    await userEvent.click(screen.getByRole('button', { name: '詳細を開く' }));
    expectOpenDialog('画像');
    const region = await screen.findByRole('region', { name: '候補の詳細' });
    expect(await within(region).findByText(detectionImage.candidate_id)).toBeInTheDocument();
    expect(heading()).toHaveFocus();
  });

  it('最初の画面の「解析した地区を地図で見る」: 回答を持たない拡大ビューを、地図で開く。全地区・全分類で、強調も選択も無い', async () => {
    await renderLoaded();
    const map = await openWelcomeMap();
    expectOpenDialog('地図');
    expect(map).toHaveAttribute('data-classes', 'confirmed_new,uncertain');
    expect(map).toHaveAttribute('data-highlight', '');
    expect(map).toHaveAttribute('data-selected', '');
    expect(screen.getByRole('combobox', { name: '地区' })).toHaveValue('');
    expect(map).toHaveAttribute('data-focus-bbox', areas[0]!.bbox.join(','));
  });

  it('拡大ビューは、開いているあいだだけマウントする（開く前は、タブも詳細も無く、閉じると外す）。回答の中の図は、拡大ビューとは別に、残る', async () => {
    await ask([table, mapFocus]);
    // 開く前: 拡大ビューは無い（タブの帯は、チャットのタブを選んだ状態）。地図は、回答の中の図の 1 つだけ
    expect(panel()).toBeNull();
    expect(tab('回答')).toHaveAttribute('aria-selected', 'true');
    const inline = await screen.findByTestId('leaflet');
    expect(screen.getAllByTestId('leaflet')).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: /詳細.*c-1-2-1/ }));
    await screen.findByRole('region', { name: '候補の詳細' });
    // 開いているあいだ: 回答の中の図は外れない（チャットは隠れるだけ）。地図は、図と拡大ビューの 2 つ
    expect(screen.getAllByTestId('leaflet')).toHaveLength(2);
    expect(within(panelEl()).getAllByTestId('leaflet')).toHaveLength(1);
    expect(inline.isConnected).toBe(true);
    await closeDialog();
    expect(panel()).toBeNull();
    expect(tab('回答')).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('region', { name: '候補の詳細' })).toBeNull();
    expect(screen.queryByTestId('chart')).toBeNull();
    // 閉じると、拡大ビューだけが外れ、図は残る
    expect(screen.getAllByTestId('leaflet')).toHaveLength(1);
    expect(inline.isConnected).toBe(true);
    expect(within(figureRegion('map')).getByRole('button', { name: '地図を拡大ビューで開く' })).toBeInTheDocument();
  });
});

describe('拡大ビューを閉じる（「閉じる」・Esc）。フォーカスは、開いたボタンへ戻る。後ろのページは、そのまま（非モーダル）', () => {
  /** 回答の中のグラフの図の「グラフを拡大」 */
  const openButton = () => figureExpand('chart');

  it('「閉じる」: 閉じて、開いたボタンへフォーカスが戻る', async () => {
    await ask([count]);
    const opener = openButton();
    await userEvent.click(opener);
    expect(panel()).not.toBeNull();
    await closeDialog();
    expect(panel()).toBeNull();
    expect(opener).toHaveFocus();
  });

  it('Esc: 閉じて、開いたボタンへフォーカスが戻る', async () => {
    await ask([count]);
    const opener = openButton();
    await userEvent.click(opener);
    await userEvent.keyboard('{Escape}');
    expect(panel()).toBeNull();
    expect(opener).toHaveFocus();
  });

  it('拡大ビューの中を押しても、閉じない。チャットのタブへ移っても、閉じない（開いたまま。モーダルではないので、後ろの暗い部分は無い）', async () => {
    await ask([count]);
    await userEvent.click(openButton());
    await userEvent.click(panelEl());
    await userEvent.click(chart());
    expect(panel()).not.toBeNull();
    await userEvent.click(tab('回答'));
    expect(panel()).not.toBeNull();
    await userEvent.click(input());
    expect(panel()).not.toBeNull();
    expect(input()).toHaveFocus();
  });

  it('開いたボタンが無くなっていたら、チャットの入力欄へ戻る', async () => {
    await renderLoaded();
    const gone = document.createElement('button');
    await expand(null, view('map'), gone);
    expect(panel()).not.toBeNull();
    await closeDialog();
    expect(panel()).toBeNull();
    expect(input()).toHaveFocus();
  });

  it('開いているあいだも、後ろ（サイドパネルなど）に inert を付けず、スクロールも固定しない。チャットのタブへ移れば、入力して送れる', async () => {
    const { container } = await renderLoaded();
    document.body.style.overflow = 'auto';
    try {
      await openWelcomeMap();
      expect(document.querySelector('[inert]')).toBeNull();
      expect(container).not.toHaveAttribute('inert');
      expect(document.body.style.overflow).toBe('auto');
      expect(panelEl()).not.toHaveAttribute('aria-modal');
      // チャットのタブへ移ると、チャットの入力欄へ入力できる（拡大ビューは開いたまま）
      await userEvent.click(tab('回答'));
      await userEvent.type(input(), 'あ');
      expect(input()).toHaveValue('あ');
      expect(panel()).not.toBeNull();
    } finally {
      document.body.style.overflow = '';
    }
  });

  it('Esc は、フォーカスがタブの帯・拡大ビューの中にあるときだけ閉じる。チャットのタブ（拡大ビューの外）で押しても、閉じない。Tab で、外へ抜けられる（トラップしない）', async () => {
    await renderLoaded();
    await openWelcomeMap();
    await userEvent.click(tab('回答'));
    await userEvent.click(input());
    await userEvent.keyboard('{Escape}');
    expect(panel()).not.toBeNull();
    // タブの帯の中のタブから押せば、閉じる
    await userEvent.click(tab('グラフ'));
    tab('グラフ').focus();
    await userEvent.keyboard('{Escape}');
    expect(panel()).toBeNull();
  });

  it('開く・閉じるを、live region で知らせない（フォーカスの移動で足りる）。開く前から DOM にある知らせ（チャットの記録・地図の選択）以外に、知らせを足さない', async () => {
    await ask([count]);
    const live = () => [...document.querySelectorAll('[aria-live], [role="status"], [role="alert"]')];
    const before = live();
    await userEvent.click(openButton());
    // 拡大ビューの枠（ダイアログ・タブの帯・パネルの枠）は、知らせを持たない。中に出た知らせは、すべて空
    const dialogEl = panelEl();
    for (const el of live().filter((e) => dialogEl.contains(e))) expect(el).toBeEmptyDOMElement();
    // 拡大ビューの外にも、知らせは増えない（タブの帯も、知らせを持たない）
    expect(live().filter((e) => !dialogEl.contains(e) && !before.includes(e))).toEqual([]);
    expect(document.querySelector('.home__tabs [aria-live], .home__tabs [role="status"]')).toBeNull();
    await closeDialog();
    // 閉じても、知らせは増えない
    expect(live().filter((e) => !before.includes(e))).toEqual([]);
  });
});

describe('回答ごとの状態（拡大の単位は回答 1 件）', () => {
  const uncertainOnly = { ...count, title: '判定保留の件数', total: 18, filter: { area_id: null, cls: 'uncertain' as const } };
  const areaOne = { ...count, title: '地区 01 の新規出現', filter: { area_id: 'z18-1-2', cls: 'confirmed_new' as const } };

  it('回答 A のタブ・絞り込み・選んだ候補を変えて閉じ、回答 B を開くと B は B の状態で開く。A を開き直すと、A の変えた状態が残る（B と混ざらない）', async () => {
    await renderLoaded();
    const A = answerOf(uncertainOnly);
    const B = answerOf(areaOne);

    await expand(A, view('chart'));
    expect(chart()).toHaveAttribute('data-classes', 'uncertain');
    await userEvent.click(tab('地図'));
    await userEvent.click(screen.getByRole('checkbox', { name: /新規出現/ })); // 新規出現を足す
    const map = screen.getByTestId('leaflet');
    await waitFor(() => expect(map).toHaveAttribute('data-classes', 'confirmed_new,uncertain'));
    await userEvent.click(screen.getByRole('button', { name: '地図の印（c-1-2-2）' }));
    expect(map).toHaveAttribute('data-selected', 'c-1-2-2');
    await closeDialog();

    // B: B の回答の条件で開く。A の変更・選択は見えない
    await expand(B, view('chart'));
    expect(tab('グラフ')).toHaveAttribute('aria-selected', 'true');
    expect(chart()).toHaveAttribute('data-classes', 'confirmed_new');
    expect(chart()).toHaveAttribute('data-area-id', 'z18-1-2');
    expect(screen.getByTestId('leaflet')).toHaveAttribute('data-selected', '');
    // B でも変える（A に写らない）
    await userEvent.click(screen.getByRole('button', { name: /グラフの行/ }));
    expect(chart()).toHaveAttribute('data-classes', 'uncertain');
    await closeDialog();

    // A を開き直す: 押したボタンの画面（グラフ）で、変えた絞り込み・選択はそのまま
    await expand(A, view('chart'));
    expect(tab('グラフ')).toHaveAttribute('aria-selected', 'true');
    expect(chart()).toHaveAttribute('data-classes', 'confirmed_new,uncertain');
    expect(chart()).toHaveAttribute('data-area-id', '');
    expect(screen.getByTestId('leaflet')).toHaveAttribute('data-selected', 'c-1-2-2');
    await closeDialog();

    // B を開き直す: B の変えた状態（A の変更ではない）
    await expand(B, view('map'));
    expect(chart()).toHaveAttribute('data-classes', 'uncertain');
    expect(chart()).toHaveAttribute('data-area-id', 'z18-1-2');
    expect(screen.getByTestId('leaflet')).toHaveAttribute('data-selected', '');
  });

  it('開き直すときの画面は、押したボタンで決まる（前に見ていたタブではなく）。回答の条件で、変えた絞り込みを上書きしない', async () => {
    await renderLoaded();
    const A = answerOf(uncertainOnly);
    await expand(A, view('chart'));
    await userEvent.click(tab('地図'));
    await userEvent.click(screen.getByRole('checkbox', { name: /新規出現/ }));
    await closeDialog();
    await expand(A, view('chart'));
    expect(tab('グラフ')).toHaveAttribute('aria-selected', 'true');
    expect(chart()).toHaveAttribute('data-classes', 'confirmed_new,uncertain');
    await closeDialog();
    await expand(A, view('map'));
    expect(tab('地図')).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(screen.getByTestId('leaflet')).toHaveAttribute('data-classes', 'confirmed_new,uncertain'));
  });

  it('古い回答の図の「拡大」は、いまの回答（あとから届いた比較）の条件ではなく、その回答の条件で開く。手で替えたあとの開き直しは、替えたまま', async () => {
    const replies = [
      { ...count, title: '判定保留の件数', total: 18, filter: { area_id: null, cls: 'uncertain' as const } },
      { ...compare, title: '地区ごとの比較' },
    ];
    let n = 0;
    route({ '/api/chat': () => jsonResponse({ message: { role: 'assistant', content: `回答 ${n + 1}`, results: [replies[n++]!], tool_calls: [] } }) });
    render(<HomeClient />);
    await waitFor(() => expect(chat.actions).not.toBeNull());
    await userEvent.type(input(), '判定保留は？{Enter}');
    await screen.findByRole('region', { name: '判定保留の件数' });
    await userEvent.type(input(), '比べて{Enter}');
    await screen.findByRole('region', { name: '地区ごとの比較' });
    expect(panel()).toBeNull();
    const first = answerBox('回答 1');
    const second = answerBox('回答 2');

    // 比較の回答の図（グラフ）の「拡大」で開いて、閉じる
    await userEvent.click(figureExpand('chart', second));
    expect(chart()).toHaveAttribute('data-classes', 'confirmed_new,existing_omission,uncertain');
    await closeDialog();

    // 古い件数の図の「拡大」を押すと、その回答の条件（判定保留だけ）で開く
    await userEvent.click(figureExpand('chart', first));
    expect(tab('グラフ')).toHaveAttribute('aria-selected', 'true');
    expect(chart()).toHaveAttribute('data-classes', 'uncertain');

    // 手で凡例を替えて閉じ、地図の「拡大」で開き直しても、替えたまま
    await userEvent.click(tab('地図'));
    await userEvent.click(within(panelEl()).getByRole('checkbox', { name: /新規出現/ }));
    await closeDialog();
    await userEvent.click(figureExpand('map', first));
    expect(tab('地図')).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(panelMap()).toHaveAttribute('data-classes', 'confirmed_new,uncertain'));
  });

  it('最初の画面の「解析した地区を地図で見る」は、回答を持たない 1 つの状態。回答の状態と混ざらない', async () => {
    await renderLoaded();
    const map = await openWelcomeMap();
    await userEvent.click(screen.getByRole('checkbox', { name: /判定保留/ }));
    expect(map).toHaveAttribute('data-classes', 'confirmed_new');
    await closeDialog();

    // 回答（判定保留だけ）は、自分の条件で開く
    await expand(answerOf(uncertainOnly), view('map'));
    await waitFor(() => expect(screen.getByTestId('leaflet')).toHaveAttribute('data-classes', 'uncertain'));
    await closeDialog();

    // 最初の画面のボタンで開き直すと、そのボタンの状態（判定保留を外したまま）
    await userEvent.click(screen.getByRole('button', { name: '解析した地区を地図で見る' }));
    await waitFor(() => expect(screen.getByTestId('leaflet')).toHaveAttribute('data-classes', 'confirmed_new'));
  });

  it('1 つの回答に、件数と比較の両方があるときは、あとの結果（比較）の条件で開く。ボタンは、どのカードのものでも同じ状態', async () => {
    await renderLoaded();
    const byWard = { ...compare, filter: { area_ids: ['z18-1-2', 'z18-2-2'], scope: '中央区', cls: null } };
    await expand(answerOf(uncertainOnly, byWard), view('chart'));
    expect(chart()).toHaveAttribute('data-area-ids', 'z18-1-2,z18-2-2');
    expect(chart()).toHaveAttribute('data-scope', '中央区');
    expect(chart()).toHaveAttribute('data-classes', 'confirmed_new,existing_omission,uncertain');
  });
});

describe('「新しい会話」: 拡大ビューを閉じ、回答ごとの状態をすべて捨てる', () => {
  it('チャット列の「新しい会話」: 閉じたあとの会話の状態（絞り込み・強調・選んだ候補）は、次の会話に残らない。回答の中の図も消える', async () => {
    await ask([table, mapFocus], '一覧です。');
    // 地図の表示のカードで開くと、候補が強調され、絞り込み・選択ができる
    await userEvent.click(within(screen.getByRole('region', { name: mapFocus.title })).getByRole('button', { name: '地図で見る' }));
    const map = panelMap();
    await waitFor(() => expect(map).toHaveAttribute('data-count', '2'));
    expect(map).toHaveAttribute('data-highlight', 'c-1-2-1,c-1-2-2,c-1-2-3');
    await userEvent.click(within(panelEl()).getByRole('checkbox', { name: /判定保留/ }));
    await userEvent.click(within(panelEl()).getByRole('button', { name: '地図の印（c-1-2-2）' }));
    await closeDialog();
    expect(screen.getByRole('region', { name: '地図' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '新しい会話' }));
    expect(panel()).toBeNull();
    expect(screen.queryByTestId('leaflet')).toBeNull();
    expect(screen.queryByRole('region', { name: '地図' })).toBeNull();
    expect(screen.getByRole('heading', { name: /写真と会話で調べる/ })).toBeInTheDocument();

    const again = await openWelcomeMap();
    expect(again).toHaveAttribute('data-highlight', '');
    expect(again).toHaveAttribute('data-selected', '');
    expect(again).toHaveAttribute('data-classes', 'confirmed_new,uncertain');
    expect(tab('地図')).toHaveAttribute('aria-selected', 'true');
  });

  it('同じ回答（ID）が、次の会話に出ても、前の会話の状態は残らない（会話ごとに捨てる）', async () => {
    await renderLoaded();
    const A = answerOf({ ...count, filter: { area_id: null, cls: 'uncertain' } });
    await expand(A, view('chart'));
    await userEvent.click(tab('地図'));
    await userEvent.click(screen.getByRole('checkbox', { name: /新規出現/ }));
    await closeDialog();
    // 「新しい会話」は、会話が 1 件以上のときだけ出る。質問して、押す
    await userEvent.type(input(), 'x{Enter}');
    await userEvent.click(await screen.findByRole('button', { name: '新しい会話' }));
    await expand(A, view('chart'));
    expect(chart()).toHaveAttribute('data-classes', 'uncertain');
  });

  it('サイドパネルの「新しい会話」（登録された処理）: 開いている拡大ビューを閉じ、状態を捨てる。フォーカスは入力欄へ', async () => {
    route();
    let startNew: () => boolean = () => false;
    function Probe() {
      startNew = useStartNewConversation();
      return null;
    }
    render(
      <NewConversationProvider>
        <Probe />
        <HomeClient />
      </NewConversationProvider>,
    );
    await waitFor(() => expect(chat.actions).not.toBeNull());
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith('/api/candidates.geojson'))).toBe(true));
    await settle();
    const map = await openWelcomeMap();
    await userEvent.click(screen.getByRole('checkbox', { name: /判定保留/ }));
    expect(map).toHaveAttribute('data-classes', 'confirmed_new');
    act(() => {
      expect(startNew()).toBe(true);
    });
    expect(panel()).toBeNull();
    expect(document.querySelector('[inert]')).toBeNull();
    expect(input()).toHaveFocus();
    expect(document.body.style.overflow).toBe('');
    // 開き直すと、最初の状態（判定保留を外した状態は残らない）
    await openWelcomeMap();
    expect(screen.getByTestId('leaflet')).toHaveAttribute('data-classes', 'confirmed_new,uncertain');
  });
});

describe('画面 `/`（地図・詳細の連携）', () => {
  it('地区の枠と候補を読み込み、地図に渡す。標準の下地は 2023 年の写真', async () => {
    await renderLoaded();
    const map = await openWelcomeMap();
    expect(map).toHaveAttribute('data-base', 'photo2023');
    expect(screen.getByRole('combobox', { name: '地区' })).toHaveTextContent('テスト地区 01');
    // 凡例に分類ごとの件数（地区の件数の合計）
    const legend = screen.getByRole('group', { name: /表示する分類/ });
    expect(within(legend).getAllByRole('checkbox')).toHaveLength(3);
    expect(within(legend).getByText('5')).toBeInTheDocument();
  });

  it('下地を切り替える（aria-pressed）', async () => {
    await renderLoaded();
    const map = await openWelcomeMap();
    await userEvent.click(screen.getByRole('button', { name: '2018 年の写真' }));
    expect(map).toHaveAttribute('data-base', 'photo2018');
    expect(screen.getByRole('button', { name: '2018 年の写真' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '2023 年の写真' })).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(screen.getByRole('button', { name: '標準地図' }));
    expect(map).toHaveAttribute('data-base', 'std');
  });

  it('凡例のチェックで分類を絞り、全部外すと「条件に合う候補がありません」', async () => {
    await renderLoaded();
    const map = await openWelcomeMap();
    await userEvent.click(screen.getByRole('checkbox', { name: /判定保留/ }));
    expect(map).toHaveAttribute('data-classes', 'confirmed_new');
    await userEvent.click(screen.getByRole('checkbox', { name: /新規出現/ }));
    expect(map).toHaveAttribute('data-count', '0');
    expect(screen.getByText(/条件に合う候補がありません/)).toBeInTheDocument();
  });

  it('チャットで一覧を出し、地図の表示・行の「詳細」で、拡大ビューが開く（地図の選択・寄せも連動）', async () => {
    await renderLoaded();
    await userEvent.type(input(), '一覧にして{Enter}');
    await screen.findByText('一覧です。');
    // 回答が届いただけでは、拡大ビューは開かない
    expect(panel()).toBeNull();

    // 地図の表示のカードで開くと、候補が強調され、地図が寄る
    await userEvent.click(within(screen.getByRole('region', { name: mapFocus.title })).getByRole('button', { name: '地図で見る' }));
    const map = panelMap();
    await waitFor(() => expect(map).toHaveAttribute('data-highlight', 'c-1-2-1,c-1-2-2,c-1-2-3'));
    expect(map).toHaveAttribute('data-focus', 'fit');
    await closeDialog();

    // 表の行の「詳細」で、同じ回答の拡大ビューを、写真の比較で開く
    await userEvent.click(screen.getByRole('button', { name: /詳細.*c-1-2-1/ }));
    const region = await screen.findByRole('region', { name: '候補の詳細' });
    expect(await within(region).findAllByRole('img')).toHaveLength(2);
    expect(panelMap()).toHaveAttribute('data-selected', 'c-1-2-1');

    // 閉じると選択も外れる
    await userEvent.click(within(region).getByRole('button', { name: '閉じる' }));
    expect(screen.queryByRole('region', { name: '候補の詳細' })).not.toBeInTheDocument();
    expect(panelMap()).toHaveAttribute('data-selected', '');

    // 強調表示の解除（詳細を開いたあとは写真の比較なので、地図のタブへ戻ってから）。強調は、この回答の状態に残っている
    await userEvent.click(tab('地図'));
    expect(panelMap()).toHaveAttribute('data-highlight', 'c-1-2-1,c-1-2-2,c-1-2-3');
    await userEvent.click(within(panelEl()).getByRole('button', { name: '強調表示を解除' }));
    expect(panelMap()).toHaveAttribute('data-highlight', '');
  });

  it('地図の印を選ぶと、地図に留まる。「写真を比べる」を押したときだけ、その候補の詳細（写真の比較）が開く', async () => {
    await renderLoaded();
    await openWelcomeMap();
    await userEvent.click(await screen.findByRole('button', { name: '地図の印（c-1-2-2）' }));
    // 画面は替えない（地図のまま。詳細は写真の比較の中で、まだ隠れている）
    expect(tab('地図')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('leaflet')).toHaveAttribute('data-selected', 'c-1-2-2');
    expect(screen.queryByRole('region', { name: '候補の詳細' })).not.toBeInTheDocument();
    // 地図の上の「写真を比べる」（MapPanel が出す）が渡された操作を呼ぶと、写真の比較へ
    act(() => spy.map!.onComparePhotos!('c-1-2-2'));
    const dialogRegion = await screen.findByRole('region', { name: '候補の詳細' });
    expect(within(dialogRegion).getByText('c-1-2-2')).toBeInTheDocument();
    expect(tab('画像')).toHaveAttribute('aria-selected', 'true');
    expect(fetchMock.mock.calls.some(([u]) => u === '/api/candidates/c-1-2-2')).toBe(true);
  });

  it('候補の読み込みに失敗したら、地図の上にエラーと再試行を出す', async () => {
    let fail = true;
    await renderLoaded({
      '/api/candidates.geojson': () => (fail ? jsonResponse({ error: { code: 'db_down', message: 'DB に接続できません。' } }, 503) : jsonResponse({ type: 'FeatureCollection', features })),
    });
    await userEvent.click(screen.getByRole('button', { name: '解析した地区を地図で見る' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('候補を読み込めませんでした');
    expect(alert).toHaveTextContent('DB に接続できません。');
    fail = false;
    await userEvent.click(within(alert).getByRole('button', { name: '再試行' }));
    await waitFor(() => expect(screen.getByTestId('leaflet')).toHaveAttribute('data-count', '2'));
  });

  it('候補が 0 件のときは「表示できる候補がありません」', async () => {
    await renderLoaded({ '/api/candidates.geojson': () => jsonResponse({ type: 'FeatureCollection', features: [] }) });
    await userEvent.click(screen.getByRole('button', { name: '解析した地区を地図で見る' }));
    expect(await screen.findByText('表示できる候補がありません。')).toBeInTheDocument();
  });

  it('一覧（キーボードで使える代わりの手段）は、開いたときに読み込む', async () => {
    await renderLoaded({
      '/api/candidates?': () =>
        jsonResponse({ total: 1, items: [{ id: 'c-1-2-1', area_id: 'z18-1-2', class: 'confirmed_new', area_m2: 123.4, bbox: [0, 0, 1, 1], centroid: [0, 0] }] }),
    });
    await userEvent.click(screen.getByRole('button', { name: '解析した地区を地図で見る' }));
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

describe('回答の中の図（地図・グラフ）', () => {
  /** 回答の中の図の地図・グラフ（拡大ビューの中ではないもの） */
  const inlineMap = (root: Pick<typeof screen, 'getByRole'> = screen) => within(figureRegion('map', root)).findByTestId('leaflet');
  const inlineChart = (root: Pick<typeof screen, 'getByRole'> = screen) => within(figureRegion('chart', root)).findByTestId('chart');

  describe('出る条件（結果の種類で決まる）', () => {
    it('件数: 地図とグラフ。比較: グラフだけ。地図の表示: 地図だけ', async () => {
      await ask([count]);
      expect(figureRegion('map')).toBeInTheDocument();
      expect(figureRegion('chart')).toBeInTheDocument();
      cleanup();
      chat.actions = null;
      await ask([compare]);
      expect(screen.queryByRole('region', { name: '地図' })).toBeNull();
      expect(figureRegion('chart')).toBeInTheDocument();
      cleanup();
      chat.actions = null;
      await ask([mapFocus]);
      expect(figureRegion('map')).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'グラフ' })).toBeNull();
    });

    it('表・検出画像・精度・お断りは、図を出さない（写真の比較は図に入れない）。拡大ビューも開かない', async () => {
      await ask([table, detectionImage, accuracy, refusal]);
      expect(screen.queryByRole('region', { name: '地図' })).toBeNull();
      expect(screen.queryByRole('region', { name: 'グラフ' })).toBeNull();
      expect(screen.queryByTestId('leaflet')).toBeNull();
      expect(screen.queryByTestId('chart')).toBeNull();
      expect(panel()).toBeNull();
      expect(document.querySelector('.answer-figure')).toBeNull();
    });

    it('壊れた結果・知らない型だけの回答にも、図は出ない', async () => {
      await ask([{ ...count, filter: undefined } as unknown as ToolResult, { type: 'heatmap' } as unknown as ToolResult]);
      expect(document.querySelector('.answer-figure')).toBeNull();
    });
  });

  describe('見た目・読み上げ・キーボード', () => {
    it('名前つきの region。チャットの記録（role="log"）の中の、結果カードの下。自分は aria-live="off" で、図の中身を、記録の読み上げに含めない', async () => {
      await ask([count]);
      const map = figureRegion('map');
      const chartFigure = figureRegion('chart');
      for (const f of [map, chartFigure]) {
        expect(f.closest('[role="log"]')).not.toBeNull();
        expect(f).toHaveAttribute('aria-live', 'off');
        expect(within(f).queryByRole('log')).toBeNull();
        // 結果カードと同じ枠（.result-card）で、同じ列の中にある
        expect(f).toHaveClass('result-card');
        expect(f.parentElement).toBe(screen.getByRole('region', { name: count.title }).parentElement);
        expect(screen.getByRole('region', { name: count.title }).compareDocumentPosition(f) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      }
      // 図の頭の行は、名前と「拡大」ボタンだけ（ボタンの名前は「地図を拡大」「グラフを拡大」）
      expect(within(map).getByRole('button', { name: '地図を拡大ビューで開く' })).toHaveTextContent('拡大');
      expect(within(chartFigure).getByRole('button', { name: 'グラフを拡大ビューで開く' })).toHaveTextContent('拡大');
    });

    it('図の中の、自分で知らせる部品（地図の選択の知らせ）は、図の aria-live="off" の中でも、自分の aria-live="polite" のまま', async () => {
      await ask([mapFocus]);
      await inlineMap();
      const announcer = figureRegion('map').querySelector('.map-stage [aria-live="polite"]');
      expect(announcer).not.toBeNull();
      expect(announcer!.closest('[aria-live="off"]')).toBe(figureRegion('map'));
    });

    it('図の中を Tab で巡って、そのまま抜けられる（フォーカストラップは無い）。印・一覧にも届き、Shift+Tab で戻れる', async () => {
      await ask([mapFocus], '地図です。');
      await inlineMap();
      const region = figureRegion('map');
      const expandButton = within(region).getByRole('button', { name: '地図を拡大ビューで開く' });
      expandButton.focus();
      const visited: Element[] = [expandButton];
      for (let i = 0; i < 60 && region.contains(document.activeElement); i++) {
        await userEvent.tab();
        visited.push(document.activeElement!);
      }
      // 図の外へ出た（body に落ちていない）。印（地図の本体）・一覧の見出しにも届いた
      const outside = document.activeElement!;
      expect(region.contains(outside)).toBe(false);
      expect(outside).not.toBe(document.body);
      expect(visited.some((el) => el.textContent === '地図の印（c-1-2-2）')).toBe(true);
      expect(visited.some((el) => el.textContent === '候補を一覧で見る（面積の大きい順）')).toBe(true);
      // 戻る: Shift+Tab で、図の最後の部品へ入れる
      await userEvent.tab({ shift: true });
      expect(region.contains(document.activeElement)).toBe(true);
    });

    it('図の中に tabindex が正の値の要素は無い（Tab の順は DOM の順）', async () => {
      await ask([count]);
      await inlineMap();
      await inlineChart();
      for (const f of document.querySelectorAll('.answer-figure')) {
        expect([...f.querySelectorAll('[tabindex]')].filter((el) => Number(el.getAttribute('tabindex')) > 0)).toEqual([]);
      }
    });
  });

  describe('状態は拡大ビューと共有する', () => {
    it('はじめの状態は、回答の結果から決まる（件数の条件・地図の表示の強調と寄せ先）。図を出しただけでは、拡大ビューは開かない', async () => {
      await ask([{ ...count, filter: { area_id: 'z18-1-2', cls: 'confirmed_new' } }, mapFocus]);
      const map = await inlineMap();
      const chartEl = await inlineChart();
      await waitFor(() => expect(map).toHaveAttribute('data-highlight', 'c-1-2-1,c-1-2-2,c-1-2-3'));
      // 強調する候補（判定保留の c-1-2-2）が隠れないよう、分類を広げる（拡大ビューをはじめて開くときと同じ規則）
      expect(map).toHaveAttribute('data-classes', 'confirmed_new,uncertain');
      expect(map).toHaveAttribute('data-focus-bbox', mapFocus.bbox.join(','));
      expect(chartEl).toHaveAttribute('data-area-id', 'z18-1-2');
      expect(chartEl).toHaveAttribute('data-classes', 'confirmed_new,uncertain');
      expect(panel()).toBeNull();
    });

    it('図で変えた絞り込みは、その回答の拡大ビューに引き継がれる。拡大ビューで変えたことも、図に戻る（地図とグラフの図も、互いに写る）', async () => {
      await ask([count]); // 分類 = 新規出現
      const map = await inlineMap();
      const chartEl = await inlineChart();
      await waitFor(() => expect(map).toHaveAttribute('data-classes', 'confirmed_new'));

      // グラフの図で行（z18-1-2・判定保留）を選ぶ → 地図の図にも写る
      await userEvent.click(within(figureRegion('chart')).getByRole('button', { name: /グラフの行/ }));
      expect(chartEl).toHaveAttribute('data-classes', 'uncertain');
      expect(chartEl).toHaveAttribute('data-area-id', 'z18-1-2');
      await waitFor(() => expect(map).toHaveAttribute('data-classes', 'uncertain'));
      expect(panel()).toBeNull();

      // 拡大: 図で変えた絞り込みのまま開く（地図もグラフも）
      await userEvent.click(figureExpand('map'));
      await waitFor(() => expect(panelMap()).toHaveAttribute('data-classes', 'uncertain'));
      await userEvent.click(tab('グラフ'));
      expect(chart()).toHaveAttribute('data-classes', 'uncertain');
      expect(chart()).toHaveAttribute('data-area-id', 'z18-1-2');

      // 拡大ビューの地図で、分類を足す → 閉じると、図の地図・グラフに写っている
      await userEvent.click(tab('地図'));
      await userEvent.click(within(panelEl()).getByRole('checkbox', { name: /新規出現/ }));
      // 図は外れない（チャットは隠れるだけ）。閉じると、図（同じ要素）に、拡大ビューで変えたことが写っている
      expect(map.isConnected).toBe(true);
      await closeDialog();
      await waitFor(() => expect(within(figureRegion('map')).getByTestId('leaflet')).toHaveAttribute('data-classes', 'confirmed_new,uncertain'));
      expect(within(figureRegion('chart')).getByTestId('chart')).toHaveAttribute('data-classes', 'confirmed_new,uncertain');
    });

    it('地図の図で印を選ぶと、地図に留まる（拡大ビューは開かず、詳細も取らない）。拡大ビューを開くと、その選択を引き継ぐ。強調の解除も共有する', async () => {
      await ask([mapFocus]);
      const map = await inlineMap();
      await userEvent.click(within(figureRegion('map')).getByRole('button', { name: '地図の印（c-1-2-2）' }));
      expect(map).toHaveAttribute('data-selected', 'c-1-2-2');
      expect(panel()).toBeNull();
      expect(detailCalls()).toHaveLength(0);
      // 強調表示の解除（地図の図の中の帯）
      await userEvent.click(within(figureRegion('map')).getByRole('button', { name: '強調表示を解除' }));
      expect(map).toHaveAttribute('data-highlight', '');
      await userEvent.click(figureExpand('map'));
      expect(panelMap()).toHaveAttribute('data-selected', 'c-1-2-2');
      expect(panelMap()).toHaveAttribute('data-highlight', '');
    });

    it('鍵（回答）を渡して当てる: ある回答の図・拡大ビューでの操作は、別の回答の状態を壊さない（開いていない回答の図を操作しても、開いている回答の拡大ビューは変わらない）', async () => {
      const replies = [
        { ...count, title: '判定保留の件数', total: 18, filter: { area_id: null, cls: 'uncertain' as const } },
        { ...compare, title: '地区ごとの比較' },
      ];
      let n = 0;
      route({ '/api/chat': () => jsonResponse({ message: { role: 'assistant', content: `回答 ${n + 1}`, results: [replies[n++]!], tool_calls: [] } }) });
      render(<HomeClient />);
      await waitFor(() => expect(chat.actions).not.toBeNull());
      await userEvent.type(input(), '判定保留は？{Enter}');
      await screen.findByRole('region', { name: '判定保留の件数' });
      await userEvent.type(input(), '比べて{Enter}');
      await screen.findByRole('region', { name: '地区ごとの比較' });
      const first = answerBox('回答 1');
      const second = answerBox('回答 2');
      const firstChart = await inlineChart(first);
      const secondChart = await inlineChart(second);
      expect(firstChart).toHaveAttribute('data-classes', 'uncertain');
      expect(secondChart).toHaveAttribute('data-classes', 'confirmed_new,existing_omission,uncertain');

      // 回答 1 の拡大ビューを開いたまま、チャットのタブで回答 2 の図を操作する（操作は鍵で、回答 2 の状態にだけ当たる）
      await userEvent.click(figureExpand('chart', first));
      await userEvent.click(tab('回答'));
      fireEvent.click(within(figureRegion('chart', second)).getByRole('button', { name: /グラフの行/ }));
      expect(secondChart).toHaveAttribute('data-area-id', 'z18-1-2');
      expect(secondChart).toHaveAttribute('data-classes', 'uncertain');
      expect(chart()).toHaveAttribute('data-area-id', ''); // 開いている回答 1 は、そのまま
      expect(chart()).toHaveAttribute('data-classes', 'uncertain');
      expect(firstChart.isConnected).toBe(true); // どの回答の図も、外れない
      expect(secondChart.isConnected).toBe(true);
      // 開いている回答 1 の中の操作は、回答 2 に写らない
      await userEvent.click(tab('地図'));
      await userEvent.click(within(panelEl()).getByRole('checkbox', { name: /新規出現/ }));
      expect(secondChart).toHaveAttribute('data-classes', 'uncertain');
      await closeDialog();
      // 閉じて戻った回答 1 の図に、パネルで変えたことが写っている
      await waitFor(() => expect(within(figureRegion('chart', first)).getByTestId('chart')).toHaveAttribute('data-classes', 'confirmed_new,uncertain'));

      // 回答 2 を開くと、回答 2 の図で変えたとおり（回答 1 の変更ではない）
      await userEvent.click(figureExpand('chart', second));
      expect(chart()).toHaveAttribute('data-area-id', 'z18-1-2');
      expect(chart()).toHaveAttribute('data-classes', 'uncertain');
    });

    it('「新しい会話」で、回答の中の図も、回答ごとの状態も捨てる（次の会話の図は、その回答の条件から始まる）', async () => {
      await ask([count]);
      await inlineMap();
      await userEvent.click(within(figureRegion('chart')).getByRole('button', { name: /グラフの行/ }));
      await waitFor(() => expect(within(figureRegion('chart')).getByTestId('chart')).toHaveAttribute('data-area-id', 'z18-1-2'));
      await userEvent.click(screen.getByRole('button', { name: '新しい会話' }));
      expect(document.querySelector('.answer-figure')).toBeNull();
      expect(screen.queryByTestId('leaflet')).toBeNull();
      // 次の会話の回答（地図の表示）の図は、その回答の条件（強調する候補）から始まる
      route();
      await userEvent.type(input(), '一覧も{Enter}');
      await screen.findByText('一覧です。');
      const map = await inlineMap();
      await waitFor(() => expect(map).toHaveAttribute('data-highlight', 'c-1-2-1,c-1-2-2,c-1-2-3'));
      expect(screen.queryByRole('region', { name: 'グラフ' })).toBeNull();
    });
  });

  describe('拡大', () => {
    it('「地図を拡大」: その回答の拡大ビューを、地図の画面で開く。「グラフを拡大」: グラフの画面で開く。閉じると、フォーカスは、押した「拡大」ボタンへ戻る', async () => {
      await ask([count]);
      await inlineMap();
      const mapButton = figureExpand('map');
      await userEvent.click(mapButton);
      expect(panelEl()).not.toHaveAttribute('aria-modal');
      expect(tab('地図')).toHaveAttribute('aria-selected', 'true');
      await userEvent.keyboard('{Escape}');
      expect(panel()).toBeNull();
      expect(mapButton).toHaveFocus();

      const chartButton = figureExpand('chart');
      await userEvent.click(chartButton);
      expect(tab('グラフ')).toHaveAttribute('aria-selected', 'true');
      await closeDialog();
      expect(chartButton).toHaveFocus();
    });

    it('図の地図の「写真を比べる」・一覧の項目: その回答の拡大ビューを、写真の比較で開く。閉じると、図の「地図を拡大」へフォーカスが戻る', async () => {
      await ask([mapFocus]);
      await inlineMap();
      const opener = figureExpand('map');
      // 図の地図が受け取った操作（拡大ビューの地図も、同じ spy に書くので、図のものを先に控える）
      const inline = spy.map!;
      // 図の地図で印を選び、地図の「写真を比べる」（MapPanel が渡された操作を呼ぶ）
      await userEvent.click(within(figureRegion('map')).getByRole('button', { name: '地図の印（c-1-2-2）' }));
      act(() => inline.onComparePhotos!('c-1-2-2'));
      await screen.findByRole('region', { name: '候補の詳細' });
      expect(tab('画像')).toHaveAttribute('aria-selected', 'true');
      expect(spy.drawer).toMatchObject({ candidateId: 'c-1-2-2', autoFocus: true });
      expect(heading()).toHaveFocus();
      // 地図は動かさない（回答の地図の表示の寄せ先のまま）
      expect(panelMap()).toHaveAttribute('data-focus-bbox', mapFocus.bbox.join(','));
      await closeDialog();
      expect(opener).toHaveFocus();

      // 一覧の項目（「開く」）: 写真の比較で開き、地図もその候補へ寄せる
      act(() => inline.onOpen('c-1-2-1'));
      await screen.findByRole('region', { name: '候補の詳細' });
      expect(spy.drawer).toMatchObject({ candidateId: 'c-1-2-1', autoFocus: true });
      expect(panelMap()).toHaveAttribute('data-selected', 'c-1-2-1');
      await userEvent.keyboard('{Escape}'); // 詳細の中の Esc は、詳細だけを閉じる
      await waitFor(() => expect(screen.queryByRole('region', { name: '候補の詳細' })).toBeNull());
      expect(panel()).not.toBeNull();
      // 非モーダルなので、詳細を開く前にフォーカスがあったところ（パネルの外）へ戻りうる。パネルの中で Esc を押すと、閉じる
      tab('画像').focus();
      await userEvent.keyboard('{Escape}');
      await waitFor(() => expect(panel()).toBeNull());
      expect(opener).toHaveFocus();
    });

    it('グラフの図の「地図で見る」: 地図の図が同じ回答に無いとき（比較）だけ出て、押すと、地図の画面で開く。件数（地図の図がすぐ近くにある）では出さない', async () => {
      await ask([count]);
      await inlineChart();
      await userEvent.click(within(figureRegion('chart')).getByRole('button', { name: /グラフの行/ }));
      expect(within(figureRegion('chart')).queryByRole('button', { name: 'グラフから地図へ' })).toBeNull();
      cleanup();
      chat.actions = null;
      await ask([compare]);
      await userEvent.click(await within(figureRegion('chart')).findByRole('button', { name: 'グラフから地図へ' }));
      expect(tab('地図')).toHaveAttribute('aria-selected', 'true');
    });

    it('その回答の拡大ビューを開いているあいだも、回答の中の図は外れない（チャットは隠れるだけ。地図は、図と拡大ビューで 2 つ）。チャットのタブへ戻ると、同じ図が見える。閉じると、開いた「拡大」ボタンへフォーカスが戻る', async () => {
      await ask([count]);
      const map = await inlineMap();
      const chartEl = await inlineChart();
      const chartButton = figureExpand('chart');
      await userEvent.click(chartButton);
      expect(map.isConnected).toBe(true);
      expect(chartEl.isConnected).toBe(true);
      expect(screen.getAllByTestId('leaflet')).toHaveLength(2);
      expect(document.querySelector('.home__chat')).toHaveAttribute('hidden');
      await userEvent.click(tab('回答'));
      expect(within(figureRegion('map')).getByTestId('leaflet')).toBe(map);
      expect(within(figureRegion('chart')).getByTestId('chart')).toBe(chartEl);
      expect(figureExpand('chart')).toBe(chartButton);
      // 回答のタブでは Esc は何も閉じない。画面のタブ（グラフ）へ移してから、Esc で閉じる
      await userEvent.click(tab('グラフ'));
      await closeDialog();
      expect(panel()).toBeNull();
      expect(chartButton).toHaveFocus();
      expect(chartButton).toHaveTextContent('拡大');
    });

    it('別の回答の「拡大」で、拡大ビューがその回答へ切り替わる（拡大ビューは 1 つのまま）。新しく開いた扱いで、フォーカスはタブの帯へ移り、閉じると、いま押した回答の図のボタンへ戻る', async () => {
      let n = 0;
      route({ '/api/chat': () => jsonResponse({ message: { role: 'assistant', content: `回答 ${++n}`, results: [compare], tool_calls: [] } }) });
      render(<HomeClient />);
      await waitFor(() => expect(chat.actions).not.toBeNull());
      await userEvent.type(input(), '一つ目{Enter}');
      await screen.findByText('回答 1');
      await userEvent.type(input(), '二つ目{Enter}');
      await screen.findByText('回答 2');
      const first = answerBox('回答 1');
      const second = answerBox('回答 2');
      await userEvent.click(figureExpand('chart', first));
      expect(document.querySelectorAll('.expanded-view')).toHaveLength(1);
      // チャットのタブへ戻って、別の回答の「拡大」を押す（どの回答の図も、そのまま出ている）
      await userEvent.click(tab('回答'));
      expect(first.getByRole('button', { name: 'グラフを拡大ビューで開く' })).toBeInTheDocument();
      expect(second.getByRole('button', { name: 'グラフを拡大ビューで開く' })).toBeInTheDocument();
      await userEvent.click(figureExpand('chart', second));
      expect(document.querySelectorAll('.expanded-view')).toHaveLength(1);
      expect(tab('グラフ')).toHaveAttribute('aria-selected', 'true');
      expect(tab('グラフ')).toHaveFocus();
      await closeDialog();
      expect(figureExpand('chart', second)).toHaveFocus();
    });
  });

  describe('マウントの遅らせ方（地図は、画面に近づくまで作らない）', () => {
    class FakeIntersectionObserver {
      static instances: FakeIntersectionObserver[] = [];
      target: Element | null = null;
      disconnected = false;
      constructor(
        private readonly callback: IntersectionObserverCallback,
        readonly options?: IntersectionObserverInit,
      ) {
        FakeIntersectionObserver.instances.push(this);
      }
      observe(el: Element) {
        this.target = el;
      }
      unobserve() {}
      disconnect() {
        this.disconnected = true;
      }
      takeRecords() {
        return [];
      }
      fire(isIntersecting: boolean) {
        this.callback([{ isIntersecting, target: this.target! } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
      }
    }
    const live = () => FakeIntersectionObserver.instances.filter((o) => !o.disconnected);

    beforeEach(() => {
      FakeIntersectionObserver.instances = [];
    });

    it('IntersectionObserver が無い環境（jsdom・古いブラウザー）では、すぐマウントする', async () => {
      expect(typeof IntersectionObserver).toBe('undefined');
      await ask([mapFocus]);
      expect(await inlineMap()).toBeInTheDocument();
    });

    it('近づくまで、地図はマウントしない（枠と「拡大」は出る）。グラフは、すぐ出る。近づいたら、マウントして、そのまま保つ', async () => {
      vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
      await ask([count]);
      // 地図の枠: 大きさを持つ読み込み中の枠だけ。Leaflet は無い
      await waitFor(() => expect(within(figureRegion('chart')).getByTestId('chart')).toBeInTheDocument());
      expect(within(figureRegion('map')).getByText('地図を読み込んでいます…')).toBeInTheDocument();
      expect(screen.queryByTestId('leaflet')).toBeNull();
      expect(spy.map).toBeNull();
      expect(within(figureRegion('map')).getByRole('button', { name: '地図を拡大ビューで開く' })).toBeInTheDocument();
      // 見る枠は、チャットのスクロール領域。余白は 200px（親の枠で切られるので、窓ではなく、この枠を基準にする）
      const observer = live().find((o) => o.target && figureRegion('map').contains(o.target))!;
      expect(observer.options?.rootMargin).toBe('200px');
      expect(observer.options?.root).toBe(document.querySelector('.chat__scroll'));
      // 画面の外のあいだは、マウントしない
      act(() => observer.fire(false));
      expect(screen.queryByTestId('leaflet')).toBeNull();
      // 近づいた: マウントする。観測は終わる
      act(() => observer.fire(true));
      expect(await within(figureRegion('map')).findByTestId('leaflet')).toBeInTheDocument();
      expect(observer.disconnected).toBe(true);
      // 別の回答が届いても、同じ要素のまま保つ
      const map = screen.getByTestId('leaflet');
      route();
      await userEvent.type(input(), '一覧も{Enter}');
      await screen.findByText('一覧です。');
      expect(screen.getAllByTestId('leaflet')[0]).toBe(map);
    });

    it('拡大ビューは、近づく前でも開ける（図の地図は、まだ無いまま。拡大ビューの地図だけ）', async () => {
      vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
      await ask([mapFocus]);
      expect(screen.queryByTestId('leaflet')).toBeNull();
      await userEvent.click(figureExpand('map'));
      expect(await within(panelEl()).findByTestId('leaflet')).toBeInTheDocument();
      expect(screen.getAllByTestId('leaflet')).toHaveLength(1);
    });
  });

  it('入力欄に打っても、回答の中の図は描き直さない（チャットは入力のたびに描き直すので、図の地図を重くしない）。状態が変わったときだけ、描き直す', async () => {
    await ask([mapFocus]);
    await inlineMap();
    const before = spy.map;
    expect(before).not.toBeNull();
    await userEvent.type(input(), 'あいう');
    expect(spy.map).toBe(before);
    await userEvent.click(within(figureRegion('map')).getByRole('button', { name: '強調表示を解除' }));
    expect(spy.map).not.toBe(before);
  });

  describe('データの読み込み', () => {
    it('地区・候補の読み込みが終わるまで、図の中身は出さない（読み込み中の枠）。終わってから、そのデータで、はじめの状態（強調する候補を隠さない絞り込み）を決める', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      route({
        '/api/candidates.geojson': async () => {
          await gate;
          return jsonResponse({ type: 'FeatureCollection', features });
        },
        '/api/chat': () => jsonResponse({ message: { role: 'assistant', content: '回答です。', results: [count, mapFocus], tool_calls: [] } }),
      });
      render(<HomeClient />);
      await waitFor(() => expect(chat.actions).not.toBeNull());
      await userEvent.type(input(), '質問です{Enter}');
      await screen.findByText('回答です。');
      expect(within(figureRegion('chart')).getByText('グラフを読み込んでいます…')).toBeInTheDocument();
      expect(within(figureRegion('map')).getByText('地図を読み込んでいます…')).toBeInTheDocument();
      expect(screen.queryByTestId('chart')).toBeNull();
      expect(screen.queryByTestId('leaflet')).toBeNull();
      release();
      const map = await inlineMap();
      // 候補が届いてから決めたので、強調する判定保留の候補（c-1-2-2）が、絞り込み（新規出現だけ）から隠れていない
      await waitFor(() => expect(map).toHaveAttribute('data-classes', 'confirmed_new,uncertain'));
      expect(await inlineChart()).toHaveAttribute('data-classes', 'confirmed_new,uncertain');
    });

    it('候補の読み込みに失敗しても、図は出る（地図の中に、エラーと再試行）', async () => {
      route({
        '/api/candidates.geojson': () => jsonResponse({ error: { code: 'db_down', message: 'DB に接続できません。' } }, 503),
        '/api/chat': () => jsonResponse({ message: { role: 'assistant', content: '回答です。', results: [count], tool_calls: [] } }),
      });
      render(<HomeClient />);
      await waitFor(() => expect(chat.actions).not.toBeNull());
      await userEvent.type(input(), '質問です{Enter}');
      await screen.findByText('回答です。');
      expect(await within(figureRegion('map')).findByRole('alert')).toHaveTextContent('候補を読み込めませんでした');
    });
  });
});

describe('拡大ビューのタブ（地図・グラフ・写真の比較）', () => {
  /** タブが指すパネル（hidden のものは、名前での検索から外れるので、aria-controls から引く） */
  const panelOf = (name: string) => document.getElementById(tab(name).getAttribute('aria-controls')!)!;

  async function renderReady() {
    await renderLoaded();
    return openWelcomeMap();
  }

  it('はじめは地図のタブ。ほかの 2 画面は hidden で、空の状態のまま（地図は外さない）', async () => {
    const map = await renderReady();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['回答', '地図', 'グラフ', '画像']);
    expect(tab('地図')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { name: '地図' })).toBeVisible();
    expect(panelOf('グラフ')).toHaveAttribute('hidden');
    expect(panelOf('画像')).toHaveAttribute('hidden');
    expect(map).toBeVisible();
  });

  it('タブを押すと画面が替わる。地図は外さず hidden にするので、戻すと同じ要素', async () => {
    const map = await renderReady();
    await userEvent.click(tab('グラフ'));
    expect(tab('グラフ')).toHaveAttribute('aria-selected', 'true');
    expect(chart()).toBeVisible();
    expect(map.isConnected).toBe(true);
    expect(map).not.toBeVisible();
    expect(map.closest('[role="tabpanel"]')).toHaveAttribute('hidden');
    // 写真の比較は、候補を選ぶまで空の状態の文
    await userEvent.click(tab('画像'));
    expect(screen.getByText('候補を選ぶと、2018 年と 2023 年の写真を並べて見られます。')).toBeVisible();
    expect(screen.getByText(/地図の印、候補の一覧、チャットの結果の「詳細」から選べます/)).toBeVisible();
    await userEvent.click(tab('地図'));
    expect(screen.getByTestId('leaflet')).toBe(map);
    expect(map).toBeVisible();
  });

  it('回答の件数の条件（分類・地区）を、地図とグラフの絞り込みに同じ条件で写す（その回答をはじめて開くとき）。条件の無い回答（表）は、すべて', async () => {
    await renderLoaded();
    await expand(answerOf(count), view('chart')); // 分類 = 新規出現、地区 = すべて
    const map = screen.getByTestId('leaflet');
    await waitFor(() => expect(map).toHaveAttribute('data-count', '1'));
    expect(chart()).toHaveAttribute('data-classes', 'confirmed_new');
    expect(chart()).toHaveAttribute('data-area-id', '');
    expect(map).toHaveAttribute('data-classes', 'confirmed_new');
    await closeDialog();

    await expand(answerOf(table), view('chart')); // 件数ではない回答（表）。別の回答なので、前の回答の条件は持ち越さない
    expect(chart()).toHaveAttribute('data-classes', 'confirmed_new,existing_omission,uncertain');
    await closeDialog();

    await expand(answerOf({ ...count, filter: { area_id: 'z18-1-2', cls: null } }), view('chart'));
    expect(chart()).toHaveAttribute('data-area-id', 'z18-1-2');
    expect(chart()).toHaveAttribute('data-classes', 'confirmed_new,existing_omission,uncertain');
    await waitFor(() => expect(screen.getByTestId('leaflet')).toHaveAttribute('data-count', '2'));
  });

  it('地図の凡例を操作すると、グラフの絞り込みも同じ。グラフから絞り込むと、地図も同じ', async () => {
    const map = await renderReady();
    await userEvent.click(screen.getByRole('checkbox', { name: /判定保留/ }));
    expect(map).toHaveAttribute('data-classes', 'confirmed_new');
    await userEvent.click(tab('グラフ'));
    expect(chart()).toHaveAttribute('data-classes', 'confirmed_new,existing_omission');

    await userEvent.click(screen.getByRole('button', { name: /グラフの行/ }));
    expect(map).toHaveAttribute('data-classes', 'uncertain');
    expect(map).toHaveAttribute('data-count', '1');
  });

  it('画面だけを指定して開く（compare）: 写真の比較で開くと、空の状態。フォーカスは、選んでいるタブへ移る', async () => {
    await renderLoaded();
    await expand(answerOf(count), view('photos'));
    expect(tab('画像')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('候補を選ぶと、2018 年と 2023 年の写真を並べて見られます。')).toBeVisible();
    expect(tab('画像')).toHaveFocus();
  });

  it('openCandidate: 写真の比較で、詳細を地図に重ならない形で出す。地図はその候補へ寄る（右端をあける欄は無い）', async () => {
    await renderLoaded();
    await expand(null, candidate('c-1-2-1'));
    const map = await screen.findByTestId('leaflet');
    expect(tab('画像')).toHaveAttribute('aria-selected', 'true');
    const region = await screen.findByRole('region', { name: '候補の詳細' });
    expect(region).toBeVisible();
    // 詳細は、拡大ビューのパネルの中にある（地図の上に重ならない）
    expect(region.closest('[role="tabpanel"]')).toBe(screen.getByRole('tabpanel', { name: '画像' }));
    expect(await within(region).findAllByRole('img')).toHaveLength(2);
    expect(map).toHaveAttribute('data-selected', 'c-1-2-1');
    expect(map).toHaveAttribute('data-focus', 'fit');
    expect(map).toHaveAttribute('data-focus-keys', 'bbox,ids,nonce'); // 右端をあける欄（padRight）は無い
    expect(map).toHaveAttribute('data-focus-bbox', '130.7,32.8,130.7001,32.8001');
  });

  it('閉じるで選択を外し、写真の比較は空の状態に戻る（タブは写真の比較のまま）', async () => {
    await renderLoaded();
    await expand(null, candidate('c-1-2-1'));
    const region = await screen.findByRole('region', { name: '候補の詳細' });
    await userEvent.click(within(region).getByRole('button', { name: '閉じる' }));
    expect(screen.queryByRole('region', { name: '候補の詳細' })).not.toBeInTheDocument();
    expect(screen.getByText('候補を選ぶと、2018 年と 2023 年の写真を並べて見られます。')).toBeVisible();
    expect(tab('画像')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('leaflet')).toHaveAttribute('data-selected', '');
    // 詳細の「閉じる」では、拡大ビューは閉じない
    expect(panel()).not.toBeNull();
  });

  it('「地図で見る」: 地図へ切り替えて、その候補の範囲へ寄せる。押したボタンが隠れるので、フォーカスは地図のタブへ', async () => {
    await renderLoaded();
    await expand(null, candidate('c-1-2-1'));
    const map = await screen.findByTestId('leaflet');
    const button = await screen.findByRole('button', { name: '地図で見る' });
    await userEvent.click(button);
    expect(tab('地図')).toHaveAttribute('aria-selected', 'true');
    expect(map).toBeVisible();
    expect(map).toHaveAttribute('data-focus-keys', 'bbox,ids,nonce');
    expect(map).toHaveAttribute('data-selected', 'c-1-2-1'); // 選択の強調は残す
    expect(tab('地図')).toHaveFocus();
    // 選択は残っているので、写真の比較へ戻ると、同じ詳細が見える
    await userEvent.click(tab('画像'));
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
    expect(tab('画像')).toHaveAttribute('aria-selected', 'true');
    expect(map).toHaveAttribute('data-selected', '');
  });

  it('focusMap（地図の表示の「地図で見る」）: 地図で、候補を強調して寄せる', async () => {
    await renderLoaded();
    await expand(answerOf(count), view('chart'));
    // 同じ回答の地図の表示のカード（チャットの別のカードのボタン）。同じ回答の状態へ当てる
    const answer = answerOf(count);
    await closeDialog();
    await expand(answer, { type: 'focus', bbox: [130.7, 32.8, 130.71, 32.81], candidateIds: ['c-1-2-1'] });
    const map = await screen.findByTestId('leaflet');
    expect(tab('地図')).toHaveAttribute('aria-selected', 'true');
    expect(map).toHaveAttribute('data-highlight', 'c-1-2-1');
    expect(map).toHaveAttribute('data-focus', 'fit');
    expect(map).toHaveAttribute('data-focus-keys', 'bbox,ids,nonce');
    expect(map).toHaveAttribute('data-focus-bbox', '130.7,32.8,130.71,32.81');
  });

  it('詳細の候補が地図の候補データに無くても、詳細が届いてから寄せる', async () => {
    await renderLoaded({ '/api/candidates.geojson': () => jsonResponse({ type: 'FeatureCollection', features: [] }) });
    await expand(null, candidate('c-1-2-1'));
    const map = await screen.findByTestId('leaflet');
    await screen.findByRole('region', { name: '候補の詳細' });
    await waitFor(() => expect(map).toHaveAttribute('data-focus-bbox', detail.bbox.join(',')));
    expect(map).toHaveAttribute('data-focus-keys', 'bbox,ids,nonce');
    expect(spy.map!.focus!.ids).toEqual(['c-1-2-1']);
  });

  it('写真の比較の空の状態は、フォーカスできる中身が無いパネルなので、外枠にフォーカスできる', async () => {
    await renderReady();
    await userEvent.click(tab('画像'));
    const empty = screen.getByText('候補を選ぶと、2018 年と 2023 年の写真を並べて見られます。').closest('.result-area__empty') as HTMLElement;
    expect(empty).toHaveAttribute('tabindex', '0');
    empty.focus();
    expect(empty).toHaveFocus();
  });
});

describe('回答の条件の受け渡し（複数地区・比較・壊れた結果）', () => {
  it('複数の地区（区）の件数は、areaIds と scope のまま地図・グラフに渡る。areaId は空（「すべて」に見せない）', async () => {
    await renderLoaded();
    await expand(answerOf(countWards), view('chart'));
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

  it('比較の回答は、分類はすべて・地区は比較の条件にする（別の回答の件数の絞り込みは持ち越さない）', async () => {
    await renderLoaded();
    await expand(answerOf({ ...count, filter: { area_id: 'z18-1-2', cls: 'uncertain' } }), view('chart'));
    expect(chart()).toHaveAttribute('data-classes', 'uncertain');
    expect(chart()).toHaveAttribute('data-area-id', 'z18-1-2');
    await closeDialog();

    await expand(answerOf(compare), view('chart'));
    expect(chart()).toHaveAttribute('data-classes', 'confirmed_new,existing_omission,uncertain');
    expect(chart()).toHaveAttribute('data-area-id', '');
  });

  it('壊れた件数（filter が無い）が、比較のあとに来ても、絞り込みは、比較の条件のまま（全地区・全分類にしない）。回答の条件の行（AnswerScope）と同じ', async () => {
    await renderLoaded();
    const byWard = { ...compare, filter: { area_ids: ['z18-1-2', 'z18-2-2'], scope: '中央区', cls: null } };
    const noFilter = { type: 'count', title: '壊れた件数', total: 1, provenance: compare.provenance } as unknown as ToolResult;
    await expand(answerOf(byWard, noFilter), view('chart'));
    expect(chart()).toHaveAttribute('data-area-ids', 'z18-1-2,z18-2-2');
    expect(chart()).toHaveAttribute('data-scope', '中央区');
    expect(chart()).toHaveAttribute('data-classes', 'confirmed_new,existing_omission,uncertain');
  });
});

describe('候補の選び方（地図に留まる・検出画像の選択・絞り込みで隠れない）', () => {
  async function renderReady(opts: { withOther?: boolean; empty?: boolean } = {}) {
    await renderLoaded({
      '/api/candidates.geojson': () =>
        jsonResponse({ type: 'FeatureCollection', features: opts.empty ? [] : opts.withOther ? [...features, other] : features }),
    });
  }
  /** 画面を決めずに（グラフで）開き、地図の候補データが届くまで待つ */
  async function openMap(answer: AnswerRef | null, request: ExpandRequest, count = 2) {
    await expand(answer, request);
    const map = await screen.findByTestId('leaflet');
    await waitFor(() => expect(map).toHaveAttribute('data-count', String(count)));
    return map;
  }

  it('(A) 地図の印・形を選んでも、画面は替えず（地図に留まる）、その候補を選ぶが、詳細は、写真の比較が見えるまでマウントしない（通信もしない）', async () => {
    await renderReady();
    const map = await openMap(null, view('map'));
    await userEvent.click(screen.getByRole('button', { name: '地図の印（c-1-2-2）' }));
    expect(tab('地図')).toHaveAttribute('aria-selected', 'true');
    expect(map).toBeVisible();
    expect(map).toHaveAttribute('data-selected', 'c-1-2-2');
    // 見ていない詳細は、取りに行かない（先読みしない）
    expect(spy.drawer).toBeNull();
    expect(document.querySelector('.drawer')).toBeNull();
    expect(detailCalls()).toHaveLength(0);
  });

  it('(A) 「写真を比べる」: 選択中の候補の写真の比較へ切り替える。すでに選択中でも、別の候補でも動く', async () => {
    await renderReady();
    await openMap(null, view('map'));
    await userEvent.click(screen.getByRole('button', { name: '地図の印（c-1-2-2）' }));
    expect(spy.map?.onComparePhotos).toBeTypeOf('function');
    act(() => spy.map!.onComparePhotos!('c-1-2-2'));
    expect(tab('画像')).toHaveAttribute('aria-selected', 'true');
    const region = await screen.findByRole('region', { name: '候補の詳細' });
    expect(await within(region).findByText('c-1-2-2')).toBeInTheDocument();

    // 地図へ戻って、同じ候補でもう一度（すでに選択中）
    await userEvent.click(tab('地図'));
    act(() => spy.map!.onComparePhotos!('c-1-2-2'));
    expect(tab('画像')).toHaveAttribute('aria-selected', 'true');

    // 別の候補を比べると、詳細はその候補に替わる
    await userEvent.click(tab('地図'));
    act(() => spy.map!.onComparePhotos!('c-1-2-1'));
    expect(await within(await screen.findByRole('region', { name: '候補の詳細' })).findByText('c-1-2-1')).toBeInTheDocument();
  });

  it('チャットの結果カードの「詳細を開く」など、ユーザーが押したボタンから開くときは、見出しへフォーカスを移す指定にする。地図の印のあとは、「写真を比べる」を押したときに、その指定でマウントする', async () => {
    await renderReady();
    await openMap(null, candidate('c-1-2-1'));
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
    await openMap(null, view('map'));
    await userEvent.click(screen.getByRole('button', { name: '地図の印（c-1-2-2）' }));
    await userEvent.click(tab('画像'));
    const region = await screen.findByRole('region', { name: '候補の詳細' });
    expect(spy.drawer).toMatchObject({ candidateId: 'c-1-2-2', autoFocus: false });
    expect(within(region).getByRole('heading', { name: '候補の詳細' })).not.toHaveFocus();
    expect(tab('画像')).toHaveFocus();
  });

  it('検出画像の回答をはじめて開くとき: その候補を、見出しへフォーカスを移さずに選ぶ。詳細の中身（候補 ID）が出て、地図もその候補へ寄る', async () => {
    await renderReady();
    const map = await openMap(answerOf(detectionImage), view('photos'));
    expect(tab('画像')).toHaveAttribute('aria-selected', 'true');
    const region = await screen.findByRole('region', { name: '候補の詳細' });
    expect(await within(region).findByText(detectionImage.candidate_id)).toBeInTheDocument();
    expect(map).toHaveAttribute('data-selected', detectionImage.candidate_id);
    expect(map).toHaveAttribute('data-focus', 'fit');
    expect(map).toHaveAttribute('data-focus-bbox', '130.7,32.8,130.7001,32.8001');
    // 見出しへは移さない。フォーカスは、選んでいるタブ
    expect(spy.drawer).toMatchObject({ candidateId: detectionImage.candidate_id, autoFocus: false });
    expect(heading()).not.toHaveFocus();
    expect(tab('画像')).toHaveFocus();
    expect(fetchMock.mock.calls.some(([u]) => u === `/api/candidates/${detectionImage.candidate_id}`)).toBe(true);
  });

  it('検出画像が複数ある回答は、最後のものを選ぶ（最初ではない）', async () => {
    await renderReady();
    const map = await openMap(
      answerOf({ ...detectionImage, candidate_id: 'c-1-2-1' }, table, { ...detectionImage, candidate_id: 'c-1-2-2' }),
      view('photos'),
    );
    const region = await screen.findByRole('region', { name: '候補の詳細' });
    expect(await within(region).findByText('c-1-2-2')).toBeInTheDocument();
    expect(map).toHaveAttribute('data-selected', 'c-1-2-2');
    expect(spy.drawer).toMatchObject({ candidateId: 'c-1-2-2', autoFocus: false });
    expect(detailCalls().map(([u]) => String(u))).toEqual(['/api/candidates/c-1-2-2']);
  });

  it('別の回答の検出画像を開くと、前に開いた回答の選択ではなく、その回答の候補（空の状態や前の候補のままにしない）', async () => {
    await renderReady();
    await openMap(answerOf({ ...detectionImage, candidate_id: 'c-1-2-2' }), view('photos'));
    await within(await screen.findByRole('region', { name: '候補の詳細' })).findByText('c-1-2-2');
    await closeDialog();
    await expand(answerOf({ ...detectionImage, candidate_id: 'c-1-2-1' }), view('photos'));
    const region = await screen.findByRole('region', { name: '候補の詳細' });
    expect(await within(region).findByText('c-1-2-1')).toBeInTheDocument();
    expect(within(region).queryByText('c-1-2-2')).not.toBeInTheDocument();
  });

  it('候補が地図の候補データにまだ無い検出画像でも、詳細は開き、詳細が届いてから地図を寄せる', async () => {
    await renderReady({ empty: true });
    await expand(answerOf(detectionImage), view('photos'));
    const map = await screen.findByTestId('leaflet');
    const region = await screen.findByRole('region', { name: '候補の詳細' });
    expect(await within(region).findByText(detectionImage.candidate_id)).toBeInTheDocument();
    await waitFor(() => expect(map).toHaveAttribute('data-focus-bbox', detail.bbox.join(',')));
  });

  describe('(R1-med3) 強調・選択する候補が、絞り込みで隠れない', () => {
    const only = (cls: 'confirmed_new' | 'existing_omission' | 'uncertain', areaId: string | null = null) =>
      ({ ...count, filter: { area_id: areaId, cls } }) as typeof count;

    it('openCandidate: 分類が絞り込みに無ければ足す（ほかの分類は残す）。地図にも出る', async () => {
      await renderReady();
      const answer = answerOf(only('confirmed_new'));
      const map = await openMap(answer, view('chart'), 1);
      expect(map).toHaveAttribute('data-classes', 'confirmed_new');
      await closeDialog();
      await expand(answer, candidate('c-1-2-2')); // 判定保留
      expect(chart()).toHaveAttribute('data-classes', 'confirmed_new,uncertain');
      expect(screen.getByTestId('leaflet')).toHaveAttribute('data-classes', 'confirmed_new,uncertain');
      expect(screen.getByTestId('leaflet')).toHaveAttribute('data-selected', 'c-1-2-2');
    });

    it('openCandidate: 地区が対象の地区に無ければ、全地区に戻す。複数の地区の絞り込み（areaIds・scope）も消す', async () => {
      await renderReady({ withOther: true });
      const one = answerOf(only('existing_omission', 'z18-1-2'));
      await openMap(one, view('chart'), 0);
      expect(chart()).toHaveAttribute('data-area-id', 'z18-1-2');
      await closeDialog();
      await expand(one, candidate('c-3-3-1')); // 別の地区（分類は絞り込みの中）
      expect(chart()).toHaveAttribute('data-area-id', '');
      expect(chart()).toHaveAttribute('data-classes', 'existing_omission');
      await closeDialog();

      const wards = answerOf(countWards); // z18-1-2 と z18-2-2
      await expand(wards, view('chart'));
      expect(chart()).toHaveAttribute('data-area-ids', 'z18-1-2,z18-2-2');
      await closeDialog();
      await expand(wards, candidate('c-1-2-1')); // 対象の地区の中なら、そのまま
      expect(chart()).toHaveAttribute('data-area-ids', 'z18-1-2,z18-2-2');
      expect(chart()).toHaveAttribute('data-scope', '中央区');
      act(() => spy.map!.onOpen('c-3-3-1')); // 対象の外
      expect(chart()).toHaveAttribute('data-area-ids', '');
      expect(chart()).toHaveAttribute('data-scope', '');
      expect(chart()).toHaveAttribute('data-area-id', '');
    });

    it('対象の候補がまだ読み込まれていない（byId に無い）ときは、絞り込みを動かさない', async () => {
      await renderReady();
      const answer = answerOf(only('uncertain'));
      await openMap(answer, view('chart'), 1);
      expect(chart()).toHaveAttribute('data-classes', 'uncertain');
      await closeDialog();
      await expand(answer, candidate('c-9-9-9'));
      expect(chart()).toHaveAttribute('data-classes', 'uncertain');
      expect(chart()).toHaveAttribute('data-area-id', '');
      await closeDialog();
      await expand(answer, { type: 'focus', bbox: [130.7, 32.8, 130.71, 32.81], candidateIds: ['c-9-9-9'] });
      expect(chart()).toHaveAttribute('data-classes', 'uncertain');
    });

    it('focusMap: 強調する候補の分類・地区が絞り込みの外なら広げる', async () => {
      await renderReady({ withOther: true });
      const answer = answerOf(only('uncertain', 'z18-1-2'));
      const map = await openMap(answer, view('chart'), 1);
      await closeDialog();
      await expand(answer, { type: 'focus', bbox: [130.7, 32.8, 130.73, 32.81], candidateIds: ['c-1-2-1', 'c-3-3-1'] });
      expect(chart()).toHaveAttribute('data-area-id', '');
      expect(chart()).toHaveAttribute('data-classes', 'confirmed_new,existing_omission,uncertain');
      expect(screen.getByTestId('leaflet')).toHaveAttribute('data-count', '3');
      expect(screen.getByTestId('leaflet')).toHaveAttribute('data-highlight', 'c-1-2-1,c-3-3-1');
      expect(map).not.toBe(screen.getByTestId('leaflet')); // 閉じて、開き直したので、地図は作り直し
    });

    it('selectFromMap: 地図の印を選んだ候補が絞り込みの外なら広げる', async () => {
      await renderReady();
      const map = await openMap(answerOf(only('confirmed_new')), view('map'), 1);
      await userEvent.click(screen.getByRole('button', { name: '地図の印（c-1-2-2）' }));
      expect(map).toHaveAttribute('data-classes', 'confirmed_new,uncertain');
      expect(tab('地図')).toHaveAttribute('aria-selected', 'true');
    });

    it('検出画像の回答: 件数の絞り込みが先に狭めても、選んだ候補は隠れない。同じ回答の地図の表示で強調する候補も、隠れない', async () => {
      await renderReady();
      const map = await openMap(answerOf(only('confirmed_new'), { ...detectionImage, candidate_id: 'c-1-2-2' }), view('map'));
      expect(map).toHaveAttribute('data-classes', 'confirmed_new,uncertain');
      expect(map).toHaveAttribute('data-selected', 'c-1-2-2');
      await closeDialog();

      // 地図の表示の回答。件数の絞り込み（描き漏れだけ）で、強調した候補がまた隠れない
      const narrow = { ...only('existing_omission'), total: 51 };
      await expand(answerOf(narrow, mapFocus), view('map'));
      await waitFor(() => expect(screen.getByTestId('leaflet')).toHaveAttribute('data-count', '2'));
      expect(screen.getByTestId('leaflet')).toHaveAttribute('data-classes', 'confirmed_new,uncertain');
      await userEvent.click(tab('グラフ'));
      expect(chart()).toHaveAttribute('data-classes', 'confirmed_new,existing_omission,uncertain');
    });

    it('showOnMap（詳細の「地図で見る」）: 詳細の分類・地区で広げる（地図の候補データに無い候補でも）', async () => {
      await renderReady({ empty: true });
      const answer = answerOf(only('uncertain'));
      await expand(answer, view('chart'));
      await screen.findByTestId('leaflet');
      await closeDialog();
      await expand(answer, candidate('c-1-2-1')); // byId に無いので、ここでは動かさない
      const map = screen.getByTestId('leaflet');
      expect(chart()).toHaveAttribute('data-classes', 'uncertain');
      await userEvent.click(await screen.findByRole('button', { name: '地図で見る' }));
      expect(chart()).toHaveAttribute('data-classes', 'confirmed_new,uncertain'); // 詳細の分類は新規出現
      expect(tab('地図')).toHaveAttribute('aria-selected', 'true');
      expect(map).toHaveAttribute('data-selected', 'c-1-2-1');
    });
  });
});

describe('詳細の遅延マウント（「写真の比較」が見えるまで、詳細を取りに行かない）', () => {
  const drawerNode = () => document.querySelector('.drawer');

  async function renderReady() {
    await renderLoaded();
    return openWelcomeMap();
  }

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
    await userEvent.click(tab('画像'));
    await screen.findByRole('region', { name: '候補の詳細' });
    expect(detailCalls().map(([u]) => String(u))).toEqual(['/api/candidates/c-1-2-2']);
  });

  it('チャットの「詳細」・回答の検出画像で開くときは、写真の比較が見えるので、すぐ取る', async () => {
    await renderLoaded();
    await expand(null, candidate('c-1-2-1'));
    await screen.findByRole('region', { name: '候補の詳細' });
    expect(detailCalls().map(([u]) => String(u))).toEqual(['/api/candidates/c-1-2-1']);
  });

  it('一度見えた詳細は、別のタブへ替えても保つ（同じ要素のまま。戻しても取り直さない）', async () => {
    await renderLoaded();
    await expand(null, candidate('c-1-2-1'));
    const region = await screen.findByRole('region', { name: '候補の詳細' });
    await within(region).findByText('どう判定したか');
    await userEvent.click(tab('地図'));
    await userEvent.click(tab('グラフ'));
    expect(region.isConnected).toBe(true);
    await userEvent.click(tab('画像'));
    expect(screen.getByRole('region', { name: '候補の詳細' })).toBe(region);
    expect(detailCalls()).toHaveLength(1);
  });

  it('選んだ候補が替わったら、新しい候補は、見えるまでマウントしない（前の詳細は外れる）。見えたら、その候補を 1 回だけ取る', async () => {
    await renderLoaded();
    await expand(null, candidate('c-1-2-1'));
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

    await userEvent.click(tab('画像'));
    const region = await screen.findByRole('region', { name: '候補の詳細' });
    expect(await within(region).findByText('c-1-2-2')).toBeInTheDocument();
    expect(detailCalls().map(([u]) => String(u))).toEqual(['/api/candidates/c-1-2-1', '/api/candidates/c-1-2-2']);
  });

  it('詳細を閉じたあと、地図で同じ候補を選び直しても、見えるまでは取りに行かない', async () => {
    await renderLoaded();
    await expand(null, candidate('c-1-2-1'));
    await userEvent.click(within(await screen.findByRole('region', { name: '候補の詳細' })).getByRole('button', { name: '閉じる' }));
    await userEvent.click(tab('地図'));
    await userEvent.click(screen.getByRole('button', { name: '地図の印（c-1-2-2）' }));
    act(() => spy.map!.onSelect('c-1-2-1'));
    expect(drawerNode()).toBeNull();
    expect(detailCalls()).toHaveLength(1);
  });

  it('選んでいない間の「写真の比較」は、空の状態（見えたときだけ）。選んだだけの hidden のパネルには、何も描かない', async () => {
    await renderReady();
    const panel = document.getElementById(tab('画像').getAttribute('aria-controls')!)!;
    expect(panel.querySelector('.result-area__empty')).not.toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '地図の印（c-1-2-2）' }));
    expect(panel).toHaveAttribute('hidden');
    expect(panel).toBeEmptyDOMElement();
  });

  it('拡大ビューを閉じると詳細も外れる。開き直すと、写真の比較が見えるなら、選んでいる候補の詳細をまた取る', async () => {
    await renderLoaded();
    const answer = answerOf(table);
    await expand(answer, candidate('c-1-2-1'));
    await screen.findByRole('region', { name: '候補の詳細' });
    await closeDialog();
    expect(drawerNode()).toBeNull();
    await expand(answer, view('photos'));
    await within(await screen.findByRole('region', { name: '候補の詳細' })).findByText('c-1-2-1');
    expect(detailCalls().map(([u]) => String(u))).toEqual(['/api/candidates/c-1-2-1', '/api/candidates/c-1-2-1']);
    // 開き直したあとの詳細は、タブで見えるだけ（「詳細」を押した操作ではない）なので、見出しへフォーカスを移さない
    expect(spy.drawer).toMatchObject({ candidateId: 'c-1-2-1', autoFocus: false });
    expect(tab('画像')).toHaveFocus();
  });
});

describe('詳細を閉じたあとのフォーカス（body に落ちない）', () => {
  async function renderReady() {
    await renderLoaded();
    return openWelcomeMap();
  }

  /** 地図の印を選び、本物の MapPanel の「写真を比べる」ボタンを押して、詳細（写真の比較）を開く */
  async function compareFromMap() {
    await userEvent.click(screen.getByRole('button', { name: '地図の印（c-1-2-2）' }));
    await userEvent.click(screen.getByRole('button', { name: '写真を比べる' }));
    return screen.findByRole('region', { name: '候補の詳細' });
  }

  it('「写真を比べる」で開いた詳細を「閉じる」で閉じる: フォーカスは「写真の比較」のタブ（body ではない）', async () => {
    await renderReady();
    const region = await compareFromMap();
    expect(heading()).toHaveFocus(); // 開くと、見出しへ
    await userEvent.click(within(region).getByRole('button', { name: '閉じる' }));
    expect(screen.queryByRole('region', { name: '候補の詳細' })).not.toBeInTheDocument();
    expect(document.activeElement).not.toBe(document.body);
    expect(tab('画像')).toHaveFocus();
  });

  it('「写真を比べる」で開いた詳細を Esc で閉じる: フォーカスは「写真の比較」のタブ。Esc は詳細だけを閉じ、拡大ビューは閉じない', async () => {
    await renderReady();
    await compareFromMap();
    expect(heading()).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('region', { name: '候補の詳細' })).not.toBeInTheDocument();
    expect(document.activeElement).not.toBe(document.body);
    expect(tab('画像')).toHaveFocus();
    expect(panel()).not.toBeNull();
    // もう一度 Esc（詳細の外）で、拡大ビューが閉じる
    await userEvent.keyboard('{Escape}');
    expect(panel()).toBeNull();
  });

  it('検出画像の回答で自動で開いた詳細（autoFocus=false）を「閉じる」で閉じる: フォーカスは「写真の比較」のタブ', async () => {
    await renderLoaded();
    await expand(answerOf(detectionImage), view('photos'));
    const region = await screen.findByRole('region', { name: '候補の詳細' });
    await userEvent.click(within(region).getByRole('button', { name: '閉じる' }));
    expect(screen.queryByRole('region', { name: '候補の詳細' })).not.toBeInTheDocument();
    expect(document.activeElement).not.toBe(document.body);
    expect(tab('画像')).toHaveFocus();
  });

  it('検出画像の自動の詳細を、詳細の中から Esc で閉じても、同じ（拡大ビューは閉じない）', async () => {
    await renderLoaded();
    await expand(answerOf(detectionImage), view('photos'));
    const region = await screen.findByRole('region', { name: '候補の詳細' });
    within(region).getByRole('button', { name: '閉じる' }).focus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('region', { name: '候補の詳細' })).not.toBeInTheDocument();
    expect(tab('画像')).toHaveFocus();
    expect(panel()).not.toBeNull();
  });

  it('タブで写真の比較へ移して開いた詳細（autoFocus=false）を閉じても、タブへ', async () => {
    await renderReady();
    await userEvent.click(screen.getByRole('button', { name: '地図の印（c-1-2-2）' }));
    await userEvent.click(tab('画像'));
    const region = await screen.findByRole('region', { name: '候補の詳細' });
    await userEvent.click(within(region).getByRole('button', { name: '閉じる' }));
    expect(tab('画像')).toHaveFocus();
  });

  it('チャットの「詳細」ボタンから開いた詳細は、「閉じる」では、「写真の比較」のタブへ戻る（チャットは隠れていて、押した「詳細」ボタンへは戻せない）。拡大ビューは開いたまま。拡大ビューごと閉じると、押したボタンへ戻る', async () => {
    await renderLoaded();
    await userEvent.type(input(), '一覧にして{Enter}');
    await screen.findByText('一覧です。');
    const opener = screen.getByRole('button', { name: /詳細.*c-1-2-1/ });
    await userEvent.click(opener);
    const region = await screen.findByRole('region', { name: '候補の詳細' });
    expect(heading()).toHaveFocus();
    await userEvent.click(within(region).getByRole('button', { name: '閉じる' }));
    expect(tab('画像')).toHaveFocus();
    expect(panel()).not.toBeNull();
    await closeDialog();
    expect(opener).toHaveFocus();
  });

  it('別の候補へ替えると（key={選択中の候補} の再マウント）、見出しへフォーカスが移る', async () => {
    await renderLoaded();
    await expand(null, candidate('c-1-2-1'));
    await screen.findByRole('region', { name: '候補の詳細' });
    expect(heading()).toHaveFocus();
    // フォーカスを、詳細の外（タブ）へ移してから、別の候補を開く（地図の一覧から）
    tab('画像').focus();
    act(() => spy.map!.onOpen('c-1-2-2'));
    expect(await within(await screen.findByRole('region', { name: '候補の詳細' })).findByText('c-1-2-2')).toBeInTheDocument();
    expect(heading()).toHaveFocus();
  });
});

describe('見えていない詳細が外れる・同じ候補をもう一度開く（フォーカスの扱い）', () => {
  /** 拡大ビューの中の印（チャットの表の回答には、地図の図が無いが、念のため、ダイアログの中に限る） */
  const marker = () => within(panelEl()).getByRole('button', { name: '地図の印（c-1-2-2）' });

  async function renderReady() {
    await renderLoaded();
    return openWelcomeMap();
  }

  /** チャットに質問して表を出し、行の「詳細（c-1-2-1）」ボタンを返す（拡大ビューは閉じたまま） */
  async function chatDetailButton() {
    await userEvent.type(input(), '一覧にして{Enter}');
    await screen.findByText('一覧です。');
    return screen.getByRole('button', { name: /詳細.*c-1-2-1/ });
  }

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
    expect(tab('画像')).not.toHaveFocus();
  });

  it('再現 B: チャットの表の「詳細」で開いた詳細を残して地図へ戻り、別の印を選んでも、フォーカスはチャットの「詳細」ボタンへ飛ばない', async () => {
    await renderLoaded();
    const opener = await chatDetailButton();
    await userEvent.click(opener);
    await screen.findByRole('region', { name: '候補の詳細' });
    await userEvent.click(tab('地図'));
    await userEvent.click(marker());
    expect(document.querySelector('.drawer')).toBeNull();
    expect(marker()).toHaveFocus();
    expect(opener).not.toHaveFocus();
  });

  it('同じ候補を、見えているまま、もう一度「開く」（地図の一覧から）ときも、見出しへ移す。詳細は取り直さない', async () => {
    await renderLoaded();
    await expand(null, candidate('c-1-2-1'));
    await screen.findByRole('region', { name: '候補の詳細' });
    expect(heading()).toHaveFocus();
    tab('画像').focus();
    act(() => spy.map!.onOpen('c-1-2-1'));
    expect(heading()).toHaveFocus();
    expect(detailCalls()).toHaveLength(1);
  });

  it('同じ候補の詳細が、フォーカスを移さずに開いている（検出画像の回答）とき、地図の一覧から同じ候補を「開く」と、見出しへフォーカスが移る。詳細は取り直さない', async () => {
    await renderLoaded();
    await expand(answerOf(detectionImage), view('photos'));
    const region = await screen.findByRole('region', { name: '候補の詳細' });
    expect(heading()).not.toHaveFocus();
    expect(spy.drawer).toMatchObject({ candidateId: 'c-1-2-1', autoFocus: false });
    act(() => spy.map!.onOpen('c-1-2-1'));
    expect(screen.getByRole('region', { name: '候補の詳細' })).toBe(region); // 同じ詳細のまま（取り直さない）
    expect(detailCalls()).toHaveLength(1);
    expect(heading()).toHaveFocus();
    // 閉じると、詳細の外（拡大ビューの中のタブ）へ戻る。body に落ちない
    await userEvent.click(within(region).getByRole('button', { name: '閉じる' }));
    expect(tab('画像')).toHaveFocus();
  });

  it('地図の印を選び、タブで写真の比較を見た（詳細は、フォーカスを移さずに開いた）あと、地図へ戻って同じ候補の「写真を比べる」を押すと、見出しへフォーカスが移る', async () => {
    await renderReady();
    await userEvent.click(marker());
    await userEvent.click(tab('画像'));
    await screen.findByRole('region', { name: '候補の詳細' });
    expect(heading()).not.toHaveFocus();
    await userEvent.click(tab('地図'));
    await userEvent.click(screen.getByRole('button', { name: '写真を比べる' }));
    expect(tab('画像')).toHaveAttribute('aria-selected', 'true');
    expect(heading()).toHaveFocus();
    expect(detailCalls()).toHaveLength(1); // 同じ詳細のまま（取り直さない）
  });

  it('地図の印・同じ候補の選び直し（フォーカスを移さない経路）では、見出しへは移さない。フォーカスは、いまの場所のまま', async () => {
    await renderLoaded();
    await expand(answerOf(detectionImage), view('photos'));
    await screen.findByRole('region', { name: '候補の詳細' });
    expect(tab('画像')).toHaveFocus();
    act(() => spy.map!.onSelect(detectionImage.candidate_id));
    expect(tab('画像')).toHaveFocus();
    expect(heading()).not.toHaveFocus();
  });
});

describe('詳細が届いてから地図を寄せる予約（pendingFocusId）の取り消し', () => {
  const AREA_BOX = areas[0]!.bbox.join(',');
  /** 地図の候補データに無い候補（byId に無い）の詳細を、開けるまで待たせる */
  async function renderWithGate() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await renderLoaded({
      '/api/candidates.geojson': () => jsonResponse({ type: 'FeatureCollection', features: [] }),
      '/api/candidates/c-1-2-1': async () => {
        await gate;
        return jsonResponse({ ...detail, id: 'c-1-2-1' });
      },
    });
    return release;
  }

  it('候補の形が地図の候補データから分かるときは、予約しない。詳細が届いても、地図を寄せ直さない（そのあいだに動かした地図を、引き戻さない）', async () => {
    await renderLoaded();
    await expand(null, candidate('c-1-2-1'));
    const map = await screen.findByTestId('leaflet');
    await waitFor(() => expect(map).toHaveAttribute('data-count', '2'));
    expect(map).toHaveAttribute('data-focus', 'fit'); // 形が分かるので、すぐ寄せる
    const nonce = map.getAttribute('data-focus-nonce');
    await within(await screen.findByRole('region', { name: '候補の詳細' })).findByText('どう判定したか');
    await act(async () => {}); // 詳細が届いたあとの効果（onLoaded → 寄せる）が、済むまで待つ
    expect(map.getAttribute('data-focus-nonce')).toBe(nonce);
  });

  it('形が分かる候補を開いたとき、前の（まだ詳細が届いていない）候補の予約も取り消す。あとでその候補の詳細が届いても、寄せない', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await renderLoaded({
      // c-1-2-2 だけが地図の候補データにある。c-1-2-1 は形が分からず、詳細が届くまで予約する
      '/api/candidates.geojson': () => jsonResponse({ type: 'FeatureCollection', features: features.slice(1) }),
      '/api/candidates/c-1-2-1': async () => {
        await gate;
        return jsonResponse({ ...detail, id: 'c-1-2-1' });
      },
    });
    await expand(null, candidate('c-1-2-1')); // 予約する（まだ寄せない。寄せ先は、地区の枠のまま）
    const map = await screen.findByTestId('leaflet');
    await waitFor(() => expect(map).toHaveAttribute('data-count', '1'));
    expect(map).toHaveAttribute('data-focus-bbox', AREA_BOX);
    act(() => spy.map!.onOpen('c-1-2-2')); // 形が分かる: すぐ寄せ、前の予約は取り消す
    expect(map).toHaveAttribute('data-focus-bbox', '130.701,32.8,130.7011,32.8001');
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
    await expand(null, candidate('c-1-2-1'));
    await screen.findByTestId('leaflet');
    expect(spy.map?.focus?.ids).toEqual([]); // 寄せ先は、地区の枠のまま
    release();
    await within(await screen.findByRole('region', { name: '候補の詳細' })).findByText('どう判定したか');
    await waitFor(() => expect(spy.map?.focus?.ids).toEqual(['c-1-2-1']));
    expect(spy.map?.focus?.bbox).toEqual(detail.bbox);
  });

  it('届く前に、地図の印（selectFromMap）で選び直すと、予約は取り消される（届いても寄せない）', async () => {
    const release = await renderWithGate();
    await expand(null, candidate('c-1-2-1'));
    await screen.findByTestId('leaflet');
    act(() => spy.map!.onSelect('c-1-2-1'));
    release();
    await within(await screen.findByRole('region', { name: '候補の詳細' })).findByText('どう判定したか');
    await act(async () => {}); // 詳細が届いたあとの効果（onLoaded → 寄せる）が、済むまで待つ
    expect(spy.map?.focus?.ids).toEqual([]);
  });

  it('届く前に、詳細を閉じる（closeDrawer）と、予約は取り消される（あとで同じ候補の詳細が出ても寄せない）', async () => {
    const release = await renderWithGate();
    await expand(null, candidate('c-1-2-1'));
    await userEvent.click(within(await screen.findByRole('region', { name: '候補の詳細' })).getByRole('button', { name: '閉じる' }));
    // 予約を作り直さない経路（地図の上の「写真を比べる」）で、同じ候補の詳細を出す
    act(() => spy.map!.onComparePhotos!('c-1-2-1'));
    release();
    await within(await screen.findByRole('region', { name: '候補の詳細' })).findByText('どう判定したか');
    await act(async () => {});
    expect(spy.map?.focus?.ids).toEqual([]);
  });

  it('候補の位置が、地図の候補データから分かるときは、予約を作らない: 地図は開いたときに 1 回だけ寄り、詳細が届いても寄せ直さない（そのあいだに利用者が動かした地図を、引き戻さない）', async () => {
    await renderLoaded();
    await expand(null, candidate('c-1-2-1'));
    await screen.findByTestId('leaflet');
    await waitFor(() => expect(spy.map?.candidatesState.status).toBe('ready'));
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

  async function renderReady() {
    await renderLoaded({ '/api/areas': () => jsonResponse(twoAreas) });
  }
  async function openMapOfTwo(answer: AnswerRef | null, request: ExpandRequest, shown = 2) {
    await expand(answer, request);
    const map = await screen.findByTestId('leaflet');
    await waitFor(() => expect(map).toHaveAttribute('data-count', String(shown)));
    await screen.findByRole('option', { name: /テスト地区 02/, hidden: true });
    return map;
  }

  it('グラフの行で地区を絞ってから地図へ戻ると、地図はその地区へ寄っている。「条件を解除」で、全地区へ戻る', async () => {
    await renderReady();
    const map = await openMapOfTwo(null, view('map'));
    expect(map).toHaveAttribute('data-focus-bbox', BOX_ALL);
    await userEvent.click(tab('グラフ'));
    await userEvent.click(screen.getByRole('button', { name: /グラフの行/ }));
    await userEvent.click(tab('地図'));
    expect(map).toHaveAttribute('data-focus-bbox', BOX_1);
    await userEvent.click(screen.getByRole('button', { name: '条件を解除' }));
    expect(map).toHaveAttribute('data-focus-bbox', BOX_ALL);
  });

  it('回答の条件（件数の地区）でも、同じ。地図の画面でなくても、地図は条件の地区へ寄る', async () => {
    await renderReady();
    // 候補（2 件）は、どちらも z18-1-2。z18-2-2 の候補は 0 件
    const map = await openMapOfTwo(answerOf({ ...count, filter: { area_id: 'z18-2-2', cls: null } }), view('chart'), 0);
    expect(tab('グラフ')).toHaveAttribute('aria-selected', 'true');
    expect(map).toHaveAttribute('data-focus-bbox', BOX_2);
  });

  it('「地図で見る」: はじめて開くときは、条件の地区（なければ全地区）が収まる範囲へ寄せる。グラフへ切り替えただけでは、寄せ先を動かさない。開き直しても、同じ範囲へ寄る', async () => {
    await renderReady();
    const all = answerOf(table);
    const map = await openMapOfTwo(all, view('map'));
    expect(map).toHaveAttribute('data-focus-bbox', BOX_ALL);
    await closeDialog();
    // 開き直しても、保っている寄せ先へ寄る（地図の拡大・移動は保たない: 地図は作り直し）
    const reopened = await openMapOfTwo(all, view('map'));
    expect(reopened).not.toBe(map);
    expect(reopened).toHaveAttribute('data-focus-bbox', BOX_ALL);
    await closeDialog();

    const ward2 = answerOf({ ...count, filter: { area_id: 'z18-2-2', cls: null } });
    const scoped = await openMapOfTwo(ward2, view('map'), 0);
    expect(scoped).toHaveAttribute('data-focus-bbox', BOX_2);
    await closeDialog();
    await expand(ward2, view('chart'));
    expect(screen.getByTestId('leaflet')).toHaveAttribute('data-focus-bbox', BOX_2); // グラフで開いても、寄せ先は動かさない
  });

  it('チャットの「解析した地区を地図で見る」: 開き直すと、保っている寄せ先（全地区）の範囲へ寄る', async () => {
    await renderReady();
    await screen.findByText(/熊本市中心部の 2 地区/);
    const map = await openMapOfTwo(null, view('map'));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '地区' }), 'z18-1-2');
    expect(map).toHaveAttribute('data-focus-bbox', BOX_1);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '地区' }), '');
    expect(map).toHaveAttribute('data-focus-bbox', BOX_ALL);
    await closeDialog();
    await userEvent.click(screen.getByRole('button', { name: '解析した地区を地図で見る' }));
    const again = await screen.findByTestId('leaflet');
    expect(again).not.toBe(map);
    expect(again).toHaveAttribute('data-focus-bbox', BOX_ALL);
  });

  it('候補を選ぶ（地区が絞り込みの外）と、全地区へ戻す絞り込みの変更があっても、地図は選んだ候補へ寄る（全体へ引き戻さない）', async () => {
    await renderReady();
    const map = await openMapOfTwo(null, view('map'));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '地区' }), 'z18-2-2');
    expect(map).toHaveAttribute('data-focus-bbox', BOX_2);
    act(() => spy.map!.onOpen('c-1-2-1')); // z18-1-2 の候補。絞り込みを全地区へ広げる（画面は写真の比較へ替わるので、地図の中は hidden）
    expect(screen.getByRole('combobox', { name: '地区', hidden: true })).toHaveValue('');
    expect(map).toHaveAttribute('data-focus-bbox', '130.7,32.8,130.7001,32.8001');
  });

  it('グラフの「地図で見る」: 地図の画面へ切り替える', async () => {
    await renderReady();
    await openMapOfTwo(null, view('map'));
    await userEvent.click(tab('グラフ'));
    await userEvent.click(screen.getByRole('button', { name: 'グラフから地図へ' }));
    expect(tab('地図')).toHaveAttribute('aria-selected', 'true');
  });

  it('選択を解除する: カードの「選択を解除」・Esc。写真の比較の選択も外れ、空の状態に戻る（印を選び直せる）。Esc は、地図が使ったときは、拡大ビューを閉じない', async () => {
    await renderReady();
    const map = await openMapOfTwo(null, view('map'));
    await userEvent.click(screen.getByRole('button', { name: '地図の印（c-1-2-2）' }));
    expect(map).toHaveAttribute('data-selected', 'c-1-2-2');
    await userEvent.click(screen.getByRole('button', { name: '選択を解除' }));
    expect(map).toHaveAttribute('data-selected', '');
    expect(screen.queryByRole('group', { name: '選択中の候補' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '地図の印（c-1-2-2）' }));
    expect(map).toHaveAttribute('data-selected', 'c-1-2-2');
    screen.getByRole('button', { name: '地図の印（c-1-2-2）' }).focus();
    await userEvent.keyboard('{Escape}');
    expect(map).toHaveAttribute('data-selected', '');
    expect(panel()).not.toBeNull(); // 選択の解除に使われた Esc では、閉じない

    // もう一度 Esc（選択は無い）で、拡大ビューが閉じる
    await userEvent.keyboard('{Escape}');
    expect(panel()).toBeNull();
  });

  it('フォーカスが地図の外（body）にあるときの Esc は、非モーダルなので、何も閉じない。タブの帯の、地図の外（タブ）での Esc は、地図の選択を奪わず、拡大ビューを閉じる。選択は、その回答の状態に残る', async () => {
    await renderReady();
    await openMapOfTwo(null, view('map'));
    await userEvent.click(screen.getByRole('button', { name: '地図の印（c-1-2-2）' }));
    expect(screen.getByTestId('leaflet')).toHaveAttribute('data-selected', 'c-1-2-2');
    (document.activeElement as HTMLElement).blur();
    await userEvent.keyboard('{Escape}');
    expect(panel()).not.toBeNull();
    expect(screen.getByTestId('leaflet')).toHaveAttribute('data-selected', 'c-1-2-2');
    tab('地図').focus();
    await userEvent.keyboard('{Escape}');
    expect(panel()).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '解析した地区を地図で見る' }));
    expect(await screen.findByTestId('leaflet')).toHaveAttribute('data-selected', 'c-1-2-2');
  });
});

afterEach(() => {
  cleanup();
});

// ---- 結果のタブ: 全幅の 4 つのタブ（ADR 0008。E8 ⑨）----
describe('全幅の 4 つのタブ: チャット・地図・グラフ・写真の比較', () => {
  const tabs = () => within(screen.getByRole('tablist', { name: '結果の見せ方' })).getAllByRole('tab');
  const names = () => tabs().map((t) => t.textContent);
  /** チャットの入力欄。チャットを隠しているあいだは、役割では見つからない（hidden の中）ので、id で取る */
  const chatInput = () => document.getElementById('chat-input') as HTMLTextAreaElement;
  const chatPanel = () => document.querySelector<HTMLElement>('.home__chat')!;
  const status = () => document.querySelector<HTMLElement>('.home > [role="status"]')!;

  it('最初の画面から、タブの帯は出ている（チャットのタブを選んだ状態）。図の「拡大」で開くと、開いた画面のタブが選ばれ、チャットは隠れる（外れない）', async () => {
    await ask([count], '回答です。', '件数は？');
    expect(names()).toEqual(['回答', '地図', 'グラフ', '画像']);
    expect(tab('回答')).toHaveAttribute('aria-selected', 'true');
    expect(chatPanel()).toHaveAttribute('role', 'tabpanel');
    expect(chatPanel()).not.toHaveAttribute('hidden');
    const inputBefore = chatInput();
    const mapBefore = await within(figureRegion('map')).findByTestId('leaflet');
    await userEvent.click(figureExpand('chart'));
    expect(names()).toEqual(['回答', '地図', 'グラフ', '画像']);
    expect(tab('グラフ')).toHaveAttribute('aria-selected', 'true');
    expect(tabs().filter((t) => t.getAttribute('aria-selected') === 'true')).toHaveLength(1);
    // チャットは、隠すだけ（同じ要素のまま。入力欄・回答の中の地図の図も外れない）
    expect(chatPanel()).toHaveAttribute('hidden');
    expect(chatPanel()).toHaveAttribute('role', 'tabpanel');
    // 画面の最初の要素はフォーカスを受けないので、tabpanel 自体を Tab の順に入れる（APG の注 4）
    expect(chatPanel()).toHaveAttribute('tabindex', '0');
    expect(chatInput()).toBe(inputBefore);
    expect(mapBefore.isConnected).toBe(true);
    // 回答の図は外れない（チャットは隠すだけ）
    expect(screen.getByRole('region', { name: '地図', hidden: true })).toBeInTheDocument();
    // 後ろを inert にしない・領域（region）にしない（タブの画面の一部）
    expect(document.querySelector('[inert]')).toBeNull();
    expect(screen.queryByRole('region', { name: '結果' })).toBeNull();
    // フォーカスは、選んでいるタブへ
    expect(tab('グラフ')).toHaveFocus();
  });

  it('最初の画面で、地図・グラフ・写真の比較のタブを押すと、回答を持たない拡大ビュー（全地区）がその画面で開く。「閉じる」が出て、閉じると押したタブへフォーカスが戻る。開く前の地図などのタブは、aria-controls を持たない', async () => {
    await renderLoaded();
    for (const name of ['地図', 'グラフ', '画像']) expect(tab(name)).not.toHaveAttribute('aria-controls');
    expect(tab('回答')).toHaveAttribute('aria-controls');
    await userEvent.click(tab('グラフ'));
    expect(tab('グラフ')).toHaveAttribute('aria-selected', 'true');
    expect(chart()).toHaveAttribute('data-area-id', '');
    expect(within(panelEl()).getByText('解析した地区')).toBeInTheDocument();
    expect(chatPanel()).toHaveAttribute('hidden');
    expect(tab('グラフ')).toHaveFocus();
    for (const t of tabs()) expect(t).toHaveAttribute('aria-controls');
    // 別のタブへ替えても、拡大ビューは 1 つのまま
    await userEvent.click(tab('地図'));
    expect(tab('地図')).toHaveAttribute('aria-selected', 'true');
    expect(document.querySelectorAll('.expanded-view')).toHaveLength(1);
    // 「閉じる」ボタンは無い（Esc で閉じる）
    expect(screen.queryByRole('button', { name: '閉じる' })).toBeNull();
    await closeDialog();
    expect(panel()).toBeNull();
    expect(tab('回答')).toHaveAttribute('aria-selected', 'true');
    // 押したタブ（開いたときに押した「グラフ」）が戻し先
    expect(tab('グラフ')).toHaveFocus();
  });

  it('タブの属性: tablist に名前、各 tab に aria-controls（実在する画面）、各 tabpanel に aria-labelledby。選んでいるタブだけ Tab の順に入る（tabindex 0、ほかは -1）', async () => {
    await ask([count]);
    await userEvent.click(figureExpand('map'));
    for (const t of tabs()) {
      const target = document.getElementById(t.getAttribute('aria-controls')!)!;
      expect(target).toHaveAttribute('role', 'tabpanel');
      expect(target).toHaveAttribute('aria-labelledby', t.id);
      expect(t).toHaveAttribute('tabindex', t.getAttribute('aria-selected') === 'true' ? '0' : '-1');
    }
    // 選んでいない画面は hidden
    const panels = document.querySelectorAll<HTMLElement>('[role="tabpanel"]');
    expect([...panels].filter((el) => !el.hasAttribute('hidden'))).toHaveLength(1);
  });

  it('矢印キーでタブの間を移る（端で反対側へ回る）。選ぶと同時に切り替わる。Home・End も動く', async () => {
    await ask([count]);
    await userEvent.click(figureExpand('map'));
    tab('回答').focus();
    await userEvent.keyboard('{ArrowLeft}'); // 先頭から、末尾へ回る
    expect(tab('画像')).toHaveFocus();
    expect(tab('画像')).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{ArrowRight}'); // 末尾から、先頭（チャット）へ回る
    expect(tab('回答')).toHaveFocus();
    expect(tab('回答')).toHaveAttribute('aria-selected', 'true');
    expect(chatPanel()).not.toHaveAttribute('hidden');
    await userEvent.keyboard('{End}');
    expect(tab('画像')).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{Home}');
    expect(tab('回答')).toHaveAttribute('aria-selected', 'true');
  });

  it('チャットのタブを選ぶと、チャットが見え、画面は隠れる。タブの帯と、地図などの中身（同じ要素）は保つ。地図のタブへ戻すと、同じ地図', async () => {
    await ask([count]);
    await userEvent.click(figureExpand('map'));
    const map = panelMapNarrow();
    await userEvent.click(tab('回答'));
    expect(chatPanel()).not.toHaveAttribute('hidden');
    expect(document.querySelector('.home__panel')).toHaveAttribute('hidden');
    expect(screen.getByRole('tablist')).toBeInTheDocument();
    await userEvent.click(tab('地図'));
    expect(chatPanel()).toHaveAttribute('hidden');
    expect(panelMapNarrow()).toBe(map);
  });

  /** 拡大ビュー（タブの画面）の中の地図。回答の中の図の地図とは別（タブの画面の中のもの） */
  function panelMapNarrow() {
    return within(document.querySelector<HTMLElement>('.home__panel')!).getByTestId('leaflet');
  }

  it('回答の質問の行と「チャットへ戻る」: 質問を示し、押すと、チャットのタブを選ぶ（拡大ビューは閉じない）。フォーカスはチャットのタブへ', async () => {
    await ask([count], '回答です。', '新規出現は何件？');
    await userEvent.click(figureExpand('map'));
    expect(within(document.querySelector<HTMLElement>('.home__panel')!).getByText(/新規出現は何件？/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'チャットへ戻る' }));
    expect(tab('回答')).toHaveAttribute('aria-selected', 'true');
    expect(tab('回答')).toHaveFocus();
    expect(screen.getByRole('tablist')).toBeInTheDocument();
  });

  it('Esc で閉じる: チャットのタブへ戻る（地図などの中身は外す。タブの帯は残る）。フォーカスは、開いたボタンへ戻る。「閉じる」ボタンは無い', async () => {
    await ask([count]);
    const opener = figureExpand('chart');
    await userEvent.click(opener);
    expect(screen.queryByRole('button', { name: '閉じる' })).toBeNull();
    await closeDialog();
    expect(tab('回答')).toHaveAttribute('aria-selected', 'true');
    expect(document.querySelector('.home__panel')).toBeNull();
    expect(chatPanel()).not.toHaveAttribute('hidden');
    expect(opener).toHaveFocus();
    await userEvent.click(opener);
    await userEvent.keyboard('{Escape}');
    expect(tab('回答')).toHaveAttribute('aria-selected', 'true');
    expect(document.querySelector('.home__panel')).toBeNull();
    expect(opener).toHaveFocus();
  });

  it('別のタブにいる間に回答が届くと、チャットのタブに文字の印（新着）を出し、先に置いた空の領域（role="status"）へ 1 文を入れる。フォーカスも画面も動かさない。チャットのタブを選ぶと消える', async () => {
    await ask([count], '一つ目', '最初の質問');
    // 空のまま先に置いてある
    expect(status()).toBeEmptyDOMElement();
    await userEvent.click(figureExpand('map'));
    // 次の回答は、手で届ける（質問を送ってから、別のタブへ移り、そのあとで届く）
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    route({
      '/api/chat': async () => {
        await gate;
        return jsonResponse({ message: { role: 'assistant', content: '二つ目', results: [], tool_calls: [] } });
      },
    });
    await userEvent.click(tab('回答'));
    await userEvent.type(chatInput(), '次の質問{Enter}');
    await userEvent.click(tab('地図'));
    expect(status()).toBeEmptyDOMElement(); // まだ届いていない
    await act(async () => {
      release();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => expect(status()).toHaveTextContent('新しい回答が届きました'));
    const chatTab = () => screen.getByRole('tab', { name: /^回答/ });
    expect(chatTab()).toHaveTextContent('回答（新着）'); // 色や点だけにしない、文字の印
    expect(tab('地図')).toHaveAttribute('aria-selected', 'true'); // 画面は替わらない
    expect(tab('地図')).toHaveFocus(); // フォーカスも動かさない
    await userEvent.click(chatTab());
    expect(chatTab()).not.toHaveTextContent('新着');
    expect(status()).toBeEmptyDOMElement();
  });

  it('チャットのタブにいるとき・拡大ビューを開いていないときは、新着を知らせない', async () => {
    await ask([count], '一つ目', '最初の質問');
    // 拡大ビューを開いていない
    route({ '/api/chat': () => jsonResponse({ message: { role: 'assistant', content: '二つ目', results: [], tool_calls: [] } }) });
    await userEvent.type(input(), '次の質問{Enter}');
    await screen.findByText('二つ目');
    expect(status()).toBeEmptyDOMElement();
    // 開いたが、チャットのタブを選んでいる
    await userEvent.click(figureExpand('map'));
    await userEvent.click(tab('回答'));
    route({ '/api/chat': () => jsonResponse({ message: { role: 'assistant', content: '三つ目', results: [], tool_calls: [] } }) });
    await userEvent.type(chatInput(), '三つ目の質問{Enter}');
    await screen.findByText('三つ目');
    expect(status()).toBeEmptyDOMElement();
    expect(tab('回答')).not.toHaveTextContent('新着');
  });

  it('同じ回答の別の「拡大」・別の回答の「拡大」で開き直すと、新しく開いた扱いで、選んでいるタブへフォーカスが移る（チャットのタブにいても、画面のタブへ）', async () => {
    await ask([count]);
    await userEvent.click(figureExpand('map'));
    await userEvent.click(tab('回答'));
    await userEvent.click(figureExpand('chart'));
    expect(tab('グラフ')).toHaveAttribute('aria-selected', 'true');
    expect(tab('グラフ')).toHaveFocus();
    expect(chatPanel()).toHaveAttribute('hidden');
  });
});
