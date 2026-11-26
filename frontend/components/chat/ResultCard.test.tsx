import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AccuracyResult, CandidateClass, CandidateFeature, CandidateReason, CompareResult, CountResult, TableResult, ToolResult } from '../../lib/api-types';
import { CandidateFeaturesContext } from '../../lib/candidates-context';
import { ALL_RESULTS, accuracy, compare, count, countWards, detectionImage, mapFocus, refusal, table } from '../../tests/fixtures';
import { ResultCard } from './ResultCard';
import type { ResultActions } from './types';

function makeActions(): ResultActions {
  return { openCandidate: vi.fn(), focusMap: vi.fn(), ask: vi.fn() };
}

describe('結果カード: 型ごとの描画', () => {
  it('count: 表を出せないときは、見出しに聞かれた数と地区、下に全体の数・根拠。未判定の説明の行・大きな数字・内訳の棒は無い', () => {
    render(<ResultCard result={count} actions={makeActions()} />);
    const card = screen.getByRole('region', { name: count.title });
    expect(within(card).getByRole('heading')).toHaveTextContent('2018 年は未検出 33 件（全地区）');
    expect(within(card).getByText('候補は全部で 102 件（うち未判定 18 件）')).toBeInTheDocument();
    expect(card.querySelector('.uncertain-note')).toBeNull();
    expect(card).not.toHaveClass('result-card--plain');
    expect(within(card).queryByRole('list')).not.toBeInTheDocument();
    expect(card.querySelector('.bar')).toBeNull();
    expect(within(card).getByText('根拠を見る')).toBeInTheDocument();
    expect(within(card).getByText(count.provenance.model)).toBeInTheDocument();
  });

  it('count: 分類を絞らなければ、見出しは「候補」で、下に分類ごとの内訳', () => {
    render(<ResultCard result={{ ...count, total: 102, overall: undefined, filter: {} }} actions={makeActions()} />);
    expect(screen.getByRole('heading')).toHaveTextContent('候補 102 件（全地区）');
    expect(screen.getByText('2018 年は未検出 33 件・2018 年も検出 51 件・未判定 18 件')).toBeInTheDocument();
    expect(screen.queryByText(/候補は全部で/)).not.toBeInTheDocument();
  });

  it('count: 未判定で絞った回答の全体の行は、未判定を重ねて言わない。全体の件数の無い保存済みの回答は、全体の行を出さない', () => {
    const { unmount } = render(<ResultCard result={{ ...count, total: 18, filter: { cls: 'uncertain' } }} actions={makeActions()} />);
    expect(screen.getByText('候補は全部で 102 件')).toBeInTheDocument();
    unmount();
    render(<ResultCard result={{ ...count, overall: undefined, breakdown: [count.breakdown[0]!] }} actions={makeActions()} />);
    expect(screen.queryByText(/候補は全部で/)).not.toBeInTheDocument();
    expect(screen.queryByText(/未判定/)).not.toBeInTheDocument();
  });

  describe('count: 候補の表（地図と同じ候補データから作る）', () => {
    const feature = (n: number, cls: CandidateClass, area_m2: number, area_id = 'z18-1-2', reason?: CandidateReason): CandidateFeature => ({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [] },
      properties: { id: `c-9-9-${n}`, class: cls, area_m2, area_id, reason },
    });
    /** 2018 年は未検出 7 件（面積は番号の順ではない）と、ほかの分類 2 件 */
    const features = [
      ...[30, 70, 10, 60, 20, 50, 40].map((a, i) => feature(i + 1, 'confirmed_new', a)),
      feature(8, 'uncertain', 999),
      feature(9, 'existing_omission', 888, 'z18-2-2'),
    ];
    const seven: CountResult = { ...count, total: 7 };
    const show = (result: CountResult, props: { staleRun?: boolean; data?: CandidateFeature[] | null } = {}) => {
      const actions = makeActions();
      const rendered = render(
        <CandidateFeaturesContext.Provider value={props.data === undefined ? features : props.data}>
          <ResultCard result={result} actions={actions} staleRun={props.staleRun} />
        </CandidateFeaturesContext.Provider>,
      );
      return { actions, ...rendered };
    };
    const ids = () => screen.getAllByRole('row').slice(1).map((r) => r.textContent!.match(/c-9-9-\d/)![0]);

    it('面積の大きい順に 5 行。残りは、ボタンで開き、もう一度押すと戻る。分類で絞った表に、分類の列は無い', async () => {
      show(seven);
      expect(ids()).toEqual(['c-9-9-2', 'c-9-9-4', 'c-9-9-6', 'c-9-9-7', 'c-9-9-1']);
      expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['地区', '面積（m²）', '操作']);
      const more = screen.getByRole('button', { name: '全 7 件を表示' });
      expect(more).toHaveAttribute('aria-expanded', 'false');
      await userEvent.click(more);
      expect(ids()).toEqual(['c-9-9-2', 'c-9-9-4', 'c-9-9-6', 'c-9-9-7', 'c-9-9-1', 'c-9-9-5', 'c-9-9-3']);
      await userEvent.click(screen.getByRole('button', { name: '先頭の 5 件だけ表示' }));
      expect(ids()).toHaveLength(5);
    });

    it('表を出すときは、カードの枠を外し、見出しは読み上げだけ。全体の数・内訳の行は出さない', () => {
      show({ ...seven, filter: { cls: 'confirmed_new' }, overall: { total: 9, uncertain: 1 } });
      const card = screen.getByRole('table').closest('section') as HTMLElement;
      expect(card).toHaveClass('result-card--plain');
      expect(within(card).getByRole('heading')).toHaveClass('visually-hidden');
      expect(within(card).getByRole('heading')).toHaveTextContent('2018 年は未検出 7 件（全地区）');
      expect(card.querySelector('.count-context')).toBeNull();
      expect(screen.queryByText(/候補は全部で/)).not.toBeInTheDocument();
    });

    it('分類を絞らない表は、2018 年は未検出 → 要確認 → 端のため未判定 → 2018 年も検出の順（同じ中は面積の大きい順）。未判定は理由の呼び名', () => {
      const mixed = [
        feature(1, 'existing_omission', 900, 'z18-1-2', 'present_2018'),
        feature(2, 'uncertain', 800, 'z18-1-2', 'edge'),
        feature(3, 'uncertain', 100, 'z18-1-2', 'ambiguous'),
        feature(4, 'confirmed_new', 10, 'z18-1-2', 'new_absent_2018'),
        feature(5, 'confirmed_new', 20, 'z18-1-2', 'new_absent_2018'),
      ];
      show({ ...count, total: 5, overall: undefined, filter: {} }, { data: mixed });
      expect(ids()).toEqual(['c-9-9-5', 'c-9-9-4', 'c-9-9-3', 'c-9-9-2', 'c-9-9-1']);
      expect(screen.getAllByRole('row').slice(1).map((r) => r.querySelector('.class-badge')!.textContent)).toEqual([
        '2018 年は未検出',
        '2018 年は未検出',
        '要確認',
        '端のため未判定',
        '2018 年も検出',
      ]);
    });

    it('表の「根拠を見る」は、表のすぐ下。行の「詳細」は、その候補を開く', async () => {
      const { actions } = show(seven);
      expect(screen.getByRole('table').compareDocumentPosition(screen.getByText('根拠を見る')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      await userEvent.click(screen.getByRole('button', { name: /詳細.*c-9-9-2/ }));
      expect(actions.openCandidate).toHaveBeenCalledWith('c-9-9-2');
    });

    it('分類を絞らない件数の表には、分類の列がある。地区の条件があれば、その地区の行だけ。5 件以下なら、開くボタンは無い', () => {
      show({ ...count, total: 1, overall: undefined, filter: { area_id: 'z18-2-2' } });
      expect(ids()).toEqual(['c-9-9-9']);
      expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['地区', '分類', '面積（m²）', '操作']);
      expect(screen.queryByRole('button', { name: /件を表示/ })).not.toBeInTheDocument();
    });

    it('表の行数が結果の件数と合わないとき・別の解析結果の回答・候補データが無いときは、表を出さない（件数の文は出る）', () => {
      for (const [result, props] of [[{ ...seven, total: 8 }, {}], [seven, { staleRun: true }], [seven, { data: null }]] as const) {
        const { unmount } = show(result, props);
        expect(screen.queryByRole('table')).not.toBeInTheDocument();
        expect(screen.getByRole('heading')).toHaveTextContent('件（全地区）');
        unmount();
      }
    });
  });

  it('count: 「グラフで見る」「地図で見る」のボタンは無い（グラフ・地図そのものが、回答の中の図に出る）。カードは、拡大ビューを開く操作を持たない', () => {
    const actions = makeActions();
    for (const result of [count, countWards]) {
      const { unmount } = render(<ResultCard result={result} actions={actions} />);
      const card = screen.getByRole('region', { name: result.title });
      expect(within(card).queryByRole('button', { name: 'グラフで見る' })).not.toBeInTheDocument();
      expect(within(card).queryByRole('button', { name: '地図で見る' })).not.toBeInTheDocument();
      // グラフ・地図のボタンの代わりに、根拠の箱（「根拠を見る」）がある
      expect(within(card).getByText('根拠を見る')).toBeInTheDocument();
      unmount();
    }
    expect(actions.focusMap).not.toHaveBeenCalled();
    expect(actions.openCandidate).not.toHaveBeenCalled();
  });

  it('count: 見出しの地区。複数の地区は API の scope をそのまま、scope が無ければ「N 地区」（「全地区」とは言わない）', () => {
    const { unmount } = render(<ResultCard result={countWards} actions={makeActions()} />);
    expect(screen.getByRole('heading')).toHaveTextContent('候補 14 件（中央区）');
    unmount();
    render(<ResultCard result={{ ...countWards, filter: { ...countWards.filter, scope: null } }} actions={makeActions()} />);
    expect(screen.getByRole('heading')).toHaveTextContent('候補 14 件（2 地区）');
  });

  it('compare: 「グラフで見る」のボタンは無い（グラフが、回答の中の図に出る）。比べる地区が無いときも、ボタンは出さない', () => {
    const { unmount } = render(<ResultCard result={compare} actions={makeActions()} />);
    expect(screen.queryByRole('button', { name: 'グラフで見る' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '地図で見る' })).not.toBeInTheDocument();
    unmount();
    render(<ResultCard result={{ ...compare, items: [] }} actions={makeActions()} />);
    expect(screen.getByText('比べる地区がありません。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'グラフで見る' })).not.toBeInTheDocument();
  });

  it('「グラフで見る」ボタンは、どの型のカードにも無い。「地図で見る」は、地図の表示（map_focus）のカードだけ', () => {
    for (const result of ALL_RESULTS) {
      const { unmount } = render(<ResultCard result={result} actions={makeActions()} />);
      expect(screen.queryByRole('button', { name: 'グラフで見る' }), result.type).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '地図で見る' }) !== null, result.type).toBe(result.type === 'map_focus');
      unmount();
    }
  });

  it('table: 列・行・「全 N 件中 M 件」、候補の行から詳細を開く', async () => {
    const actions = makeActions();
    render(<ResultCard result={table} actions={actions} />);
    // 候補 ID の列は、最初の列（ここでは分類）の下に添える。列の名前には、ID を含むことを読み上げ用に足す
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['分類と候補 ID', '面積（m²）', '操作']);
    expect(screen.getAllByRole('row')).toHaveLength(3);
    expect(screen.getByText('全 102 件中 2 件を表示')).toBeInTheDocument();
    expect(screen.getByText('2018 年は未検出')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /詳細.*c-1-2-1/ }));
    expect(actions.openCandidate).toHaveBeenCalledWith('c-1-2-1');
  });

  it('table: 行が無いときは空の表示', () => {
    render(<ResultCard result={{ ...table, rows: [], shown: 0, total: 0 }} actions={makeActions()} />);
    expect(screen.getByText('該当する行はありません。')).toBeInTheDocument();
  });

  describe('compare: 要点だけを言う（地区ごとの数字の表は出さない。全地区は、回答の中のグラフで読める）', () => {
    /** API の並びのまま、n 地区（件数は地区ごとに違う値） */
    const many = (n: number): CompareResult => ({
      ...compare,
      items: Array.from({ length: n }, (_, i) => ({
        area_id: `z18-${i + 1}-1`,
        name: `地区 ${String(i + 1).padStart(2, '0')}`,
        counts: { confirmed_new: n - i, existing_omission: i, uncertain: 1, total: n + 1 },
      })),
    });

    it('表は出さず、最も多い地区と、全地区の合計・内訳を、結果の数字から言う', () => {
      render(<ResultCard result={compare} actions={makeActions()} />);
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
      const card = screen.getByRole('region', { name: compare.title });
      // テスト地区 02 が合計 10 で最多。2 地区の合計は 19 件（2018 年は未検出 7・2018 年も検出 9・未判定 3）
      expect(card).toHaveTextContent('候補が最も多いのはテスト地区 02で、10 件です。');
      expect(card).toHaveTextContent('全 2 地区の合計は 19 件（2018 年は未検出 7・2018 年も検出 9・未判定 3）。');
      expect(card).not.toHaveTextContent('未判定が過半');
    });

    it('地区の数が多くても、カードの大きさは同じ（地区の行を並べない。「N 地区中 5 地区を表示」とは言わない）', () => {
      render(<ResultCard result={many(12)} actions={makeActions()} />);
      expect(screen.queryByRole('row')).not.toBeInTheDocument();
      expect(screen.queryByText(/地区中 5 地区を表示/)).not.toBeInTheDocument();
      expect(screen.getByText(/全 12 地区の合計は/)).toBeInTheDocument();
    });

    it('並びの基準の分類（filter.cls）があれば、その分類で最多を言う', () => {
      render(<ResultCard result={{ ...compare, filter: { cls: 'uncertain' } }} actions={makeActions()} />);
      expect(screen.getByText('未判定の候補が最も多いのはテスト地区 02で、2 件です。')).toBeInTheDocument();
    });

    it('要点は、未判定の 1 行・根拠より前', () => {
      render(<ResultCard result={compare} actions={makeActions()} />);
      const lead = screen.getByText(/候補が最も多いのは/);
      expect(lead.compareDocumentPosition(screen.getByText(/^未判定: /)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(lead.compareDocumentPosition(screen.getByText('根拠を見る')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('比べる地区が無いときは、その旨だけ', () => {
      render(<ResultCard result={many(0)} actions={makeActions()} />);
      expect(screen.getByText('比べる地区がありません。')).toBeInTheDocument();
    });
  });

  it('map_focus: 「地図で見る」で範囲と候補 ID を渡す', async () => {
    const actions = makeActions();
    render(<ResultCard result={mapFocus} actions={actions} />);
    await userEvent.click(screen.getByRole('button', { name: '地図で見る' }));
    expect(actions.focusMap).toHaveBeenCalledWith({ bbox: mapFocus.bbox, candidateIds: mapFocus.candidate_ids });
  });

  it('map_focus: 1 文（「地図で、候補 N 件を目立たせて表示します」。候補が無い範囲だけの表示は「この範囲を」）と、「地図で見る」。常設の結果領域は無いので、「結果領域」「右」とは言わない', () => {
    render(<ResultCard result={mapFocus} actions={makeActions()} />);
    const card = screen.getByRole('region', { name: mapFocus.title });
    expect(card).toHaveTextContent('地図で、候補 3 件を目立たせて表示します。');
    expect(card).not.toHaveTextContent('結果領域');
    expect(card).not.toHaveTextContent('地図の右側');
    expect(within(card).getByRole('button', { name: '地図で見る' })).toBeInTheDocument();
    cleanup();
    render(<ResultCard result={{ ...mapFocus, candidate_ids: [] }} actions={makeActions()} />);
    expect(screen.getByRole('region', { name: mapFocus.title })).toHaveTextContent('地図で、この範囲を表示します。');
  });

  it('detection_image: 2018・2023 の 2 枚と、詳細を開く操作', async () => {
    const actions = makeActions();
    render(<ResultCard result={detectionImage} actions={actions} />);
    const imgs = screen.getAllByRole('img');
    expect(imgs).toHaveLength(2);
    expect(imgs[0]).toHaveAttribute('src', '/api/candidates/c-1-2-1/image?year=2018&size=512');
    expect(imgs[1]).toHaveAccessibleName(/2023 年の写真/);
    expect(screen.getByText('輪郭が候補の位置です。')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '詳細を開く' }));
    expect(actions.openCandidate).toHaveBeenCalledWith('c-1-2-1');
  });

  it('detection_image: 画像の取得に失敗しても、理由を文字で出す', () => {
    render(<ResultCard result={detectionImage} actions={makeActions()} />);
    const [first] = screen.getAllByRole('img');
    fireEvent.error(first!);
    expect(screen.getByRole('status')).toHaveTextContent('2018 年の写真を取得できませんでした');
  });

  it('accuracy: 値が null の指標は「未測定」', () => {
    render(<ResultCard result={accuracy} actions={makeActions()} />);
    expect(screen.getByText('0.617')).toBeInTheDocument();
    expect(screen.getByText('未測定')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /精度の画面/ })).toHaveAttribute('href', '/accuracy');
  });

  it('refusal: 理由の見出し・本文・提案（押すと質問として送る）', async () => {
    const actions = makeActions();
    render(<ResultCard result={refusal} actions={actions} />);
    expect(screen.getByRole('heading', { name: 'この質問は範囲外です' })).toBeInTheDocument();
    expect(screen.getByText(refusal.message)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'このアプリの精度は？' }));
    expect(actions.ask).toHaveBeenCalledWith('このアプリの精度は？');
  });

  it('refusal: 理由ごとに見出しが変わる', () => {
    const cases = [
      ['no_photo_period', 'この期間の写真がありません'],
      ['not_implemented', 'まだ実装していない機能です'],
      ['no_data', '該当するデータがありません'],
    ] as const;
    for (const [reason, heading] of cases) {
      const { unmount } = render(<ResultCard result={{ ...refusal, reason }} actions={makeActions()} />);
      expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
      unmount();
    }
  });

  it('合成データの結果には「合成データ」の印が付く', () => {
    const synthetic: ToolResult = { ...count, provenance: { ...count.provenance, run_kind: 'synthetic' } };
    render(<ResultCard result={synthetic} actions={makeActions()} />);
    expect(screen.getAllByText('合成データ').length).toBeGreaterThan(0);
  });

  it('7 種類すべて、描画で例外を出さない', () => {
    for (const result of ALL_RESULTS) {
      const { container, unmount } = render(<ResultCard result={result} actions={makeActions()} />);
      expect(container.textContent).not.toContain('この結果は表示できません');
      unmount();
    }
  });
});

describe('結果カード: 想定外の入力', () => {
  it('未知の type は、画面を壊さず「表示できません」と中身を出す', async () => {
    const heatmap = { type: 'heatmap', title: '衛星の変化', cells: [1, 2, 3] } as unknown as ToolResult;
    render(<ResultCard result={heatmap} actions={makeActions()} />);
    const note = screen.getByRole('note', { name: '表示できない結果' });
    expect(note).toHaveTextContent('type: heatmap');
    await userEvent.click(within(note).getByText('受け取った内容'));
    expect(note).toHaveTextContent('"cells"');
  });

  it('type が無い・オブジェクトでない値も落ちない', () => {
    for (const bad of [null, 'text', 42, {}]) {
      const { unmount } = render(<ResultCard result={bad as unknown as ToolResult} actions={makeActions()} />);
      expect(screen.getByRole('note', { name: '表示できない結果' })).toBeInTheDocument();
      unmount();
    }
  });

  it('既知の type でも中身が壊れていれば、そのカードだけ代わりの表示になる', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = { type: 'count', title: '壊れた件数', total: 1, provenance: count.provenance } as unknown as ToolResult;
    render(
      <>
        <ResultCard result={broken} actions={makeActions()} />
        <ResultCard result={refusal} actions={makeActions()} />
      </>,
    );
    expect(screen.getByRole('note', { name: '表示できない結果' })).toHaveTextContent('表示中にエラーが起きました');
    expect(screen.getByRole('heading', { name: 'この質問は範囲外です' })).toBeInTheDocument();
    expect(spy).toHaveBeenCalled();
  });
});

// ---- チャットの狭い幅（340px 前後）に収める表・分類の意味・精度・同じ文の重複 ----

/** backend の list_candidates が返す形そのまま（分類は表示名。候補 ID・地区・分類・面積の 4 列） */
const realTable: TableResult = {
  ...table,
  title: '2018 年は未検出候補の一覧（全地区・面積の大きい順）',
  columns: [
    { key: 'id', label: '候補 ID' },
    { key: 'area', label: '地区' },
    { key: 'class', label: '分類' },
    { key: 'area_m2', label: '面積（m²）' },
  ],
  rows: [
    { id: 'c-226274-105752-9', area: '薄場一丁目', class: '2018 年は未検出', area_m2: 232.4 },
    { id: 'c-226266-105755-3', area: '本荘五丁目', class: '未判定', area_m2: 180 },
    { id: 'c-226258-105756-1', area: '本荘五丁目', class: '2018 年も検出', area_m2: 96.5 },
  ],
};

describe('結果カード: 表（チャットの狭い幅）', () => {
  it('一覧: 候補 ID は列にせず、最初の列（地区）の下に添える。面積と「詳細」の列は、そのまま残る', async () => {
    const actions = makeActions();
    render(<ResultCard result={realTable} actions={actions} />);
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['地区と候補 ID', '分類', '面積（m²）', '操作']);
    const row = screen.getByRole('row', { name: /薄場一丁目/ });
    const cells = within(row).getAllByRole('cell');
    expect(cells).toHaveLength(4);
    expect(cells[0]).toHaveTextContent('薄場一丁目');
    expect(cells[0]!.querySelector('.data-table__sub')).toHaveTextContent('c-226274-105752-9');
    expect(cells[2]).toHaveTextContent('232.4');
    await userEvent.click(within(row).getByRole('button', { name: /詳細.*c-226274-105752-9/ }));
    expect(actions.openCandidate).toHaveBeenCalledWith('c-226274-105752-9');
  });

  it('一覧: 分類は、表示名で届いても、印つきの短い名前で出す（長い名前で幅を使い切らない）', () => {
    render(<ResultCard result={realTable} actions={makeActions()} />);
    const rows = screen.getAllByRole('row').slice(1);
    const badge = (i: number) => rows[i]!.querySelector('.class-badge');
    expect(badge(0)).toHaveTextContent(/^2018 年は未検出$/);
    expect(badge(0)).toHaveAttribute('data-class', 'confirmed_new');
    expect(badge(1)).toHaveTextContent(/^未判定$/);
    expect(badge(2)).toHaveTextContent(/^2018 年も検出$/);
    expect(badge(2)!.querySelector('svg')).not.toBeNull();
    // 表の中には、旧写真に…の長い名前を出さない（分類の意味の折りたたみは別）
    for (const r of rows) expect(r).not.toHaveTextContent('旧写真に');
  });

  it('一覧: 知らない分類の値は、そのまま文字で出す', () => {
    const odd: TableResult = { ...realTable, rows: [{ id: 'c-1-2-1', area: '地区', class: 'まだ無い分類', area_m2: 1 }] };
    render(<ResultCard result={odd} actions={makeActions()} />);
    expect(screen.getByText('まだ無い分類')).toBeInTheDocument();
  });

  it('一覧: 「詳細」のボタンが無い表（候補 ID の無い行）は、列をそのまま出す', () => {
    const plain: TableResult = {
      ...table,
      columns: [
        { key: 'id', label: '項目' },
        { key: 'note', label: '説明' },
      ],
      rows: [{ id: '件数', note: '候補の数を聞けます' }],
    };
    render(<ResultCard result={plain} actions={makeActions()} />);
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['項目', '説明']);
    expect(screen.queryByRole('button', { name: /詳細/ })).not.toBeInTheDocument();
  });

  it('一覧は、チャット用の表のクラスと、横にスクロールできる枠（フォーカスできる）に入る', () => {
    render(<ResultCard result={realTable} actions={makeActions()} />);
    const region = screen.getByRole('region', { name: `${realTable.title}（横にスクロールできます）` });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region.querySelector('table')).toHaveClass('data-table--chat');
    expect(region.parentElement).toHaveClass('table-scroll-wrap');
  });
});

describe('結果カード: 分類の説明', () => {
  const note = '未判定: 写真の端で切れているもの（端のため未判定）と、どちらとも言えないもの（要確認）です。';

  it('未判定を含む比較にだけ、畳まずに 1 行の説明を出す。件数と一覧には出さない。「分類の意味」の折りたたみは、どの型にも無い', () => {
    const shown = render(<ResultCard result={compare} actions={makeActions()} />);
    expect(screen.getByText(note).closest('details')).toBeNull();
    expect(screen.queryByText('分類の意味')).not.toBeInTheDocument();
    shown.unmount();
    for (const result of [count, realTable]) {
      const { unmount } = render(<ResultCard result={result} actions={makeActions()} />);
      expect(screen.queryByText(note)).not.toBeInTheDocument();
      expect(screen.queryByText('分類の意味')).not.toBeInTheDocument();
      unmount();
    }
  });

  it('候補の一覧は枠を重ねない。詳細のボタンが無い表（使い方の表）は、枠を残す', () => {
    const listed = render(<ResultCard result={realTable} actions={makeActions()} />);
    expect(screen.getByRole('region', { name: realTable.title })).toHaveClass('result-card--plain');
    listed.unmount();
    const help: TableResult = { ...table, columns: [{ key: 'example', label: '質問の例' }], rows: [{ example: '候補は何件ありますか？' }], total: 1, shown: 1 };
    render(<ResultCard result={help} actions={makeActions()} />);
    expect(screen.getByRole('region', { name: help.title })).not.toHaveClass('result-card--plain');
  });

  it('未判定を含まない結果・分類の列が無い一覧・地図の表示・精度・お断りには、出さない', () => {
    const noClass: TableResult = { ...table, columns: [{ key: 'id', label: '候補 ID' }, { key: 'area_m2', label: '面積（m²）' }] };
    const newOnly: TableResult = { ...table, rows: [table.rows[0]!], shown: 1 };
    const noHeld: CompareResult = { ...compare, items: compare.items.map((i) => ({ ...i, counts: { ...i.counts, uncertain: 0 } })) };
    for (const result of [noClass, newOnly, noHeld, mapFocus, accuracy, refusal, { ...compare, items: [] }]) {
      const { unmount } = render(<ResultCard result={result} actions={makeActions()} />);
      expect(screen.queryByText(note)).not.toBeInTheDocument();
      expect(screen.queryByText('分類の意味')).not.toBeInTheDocument();
      unmount();
    }
  });
});

describe('結果カード: 精度（平易な一言）', () => {
  const withRates: AccuracyResult = {
    ...accuracy,
    metrics: [
      { key: 'holdout_object_f1', label: '物体単位 F1（評価用・2018 年の写真）', value: 0.123, note: '評価用 6 地区' },
      { key: 'holdout_object_precision', label: '建物の抽出の適合率・物体単位', value: 0.163, note: '評価用 6 地区' },
      { key: 'holdout_object_recall', label: '建物の抽出の再現率・物体単位', value: 0.098, note: '評価用 6 地区' },
      { key: 'new_building_recall', label: '新築の再現率', value: null, note: '未測定（手ラベルが無いため）' },
    ],
  };

  it('適合率と再現率が届いたら、専門の数字の前に、% に直した 1 文を出す。専門の指標は、折りたたみの中', () => {
    render(<ResultCard result={withRates} actions={makeActions()} />);
    const plain = document.querySelector('.accuracy-plain') as HTMLElement;
    expect(plain).toHaveTextContent('機械が見つけた建物のうち、既存の建物データ（基盤地図情報）と一致したのは約 16 %');
    expect(plain).toHaveTextContent('機械が見つけられたのは約 10 %');
    expect(plain).toHaveTextContent('結果は目で確かめる前提の「候補」です');
    const details = screen.getByText('くわしい指標（専門の数字）を見る').closest('details') as HTMLElement;
    expect(details).not.toHaveAttribute('open');
    expect(within(details).getByText('0.123')).toBeInTheDocument();
    expect(within(details).getByText('未測定')).toBeInTheDocument();
    // 一言は、折りたたみより前
    expect(plain.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 精度の画面への道は、そのまま
    expect(screen.getByRole('link', { name: /精度の画面/ })).toHaveAttribute('href', '/accuracy');
  });

  it('適合率か再現率が無い（未測定・古い評価ファイル）ときは、一言を作らず、指標をこれまでどおり並べる', () => {
    for (const result of [accuracy, { ...withRates, metrics: withRates.metrics.filter((m) => m.key !== 'holdout_object_recall') }]) {
      const { container, unmount } = render(<ResultCard result={result} actions={makeActions()} />);
      expect(container.querySelector('.accuracy-plain')).toBeNull();
      expect(screen.queryByText('くわしい指標（専門の数字）を見る')).not.toBeInTheDocument();
      expect(container.querySelector('.metric-grid')).not.toBeNull();
      unmount();
    }
  });

  it('値は 0〜100 % に収める（想定外の値で、画面に変な数を出さない）', () => {
    const odd: AccuracyResult = {
      ...withRates,
      metrics: withRates.metrics.map((m) => (m.key === 'holdout_object_precision' ? { ...m, value: 1.4 } : m.key === 'holdout_object_recall' ? { ...m, value: 0 } : m)),
    };
    render(<ResultCard result={odd} actions={makeActions()} />);
    const plain = document.querySelector('.accuracy-plain') as HTMLElement;
    expect(plain).toHaveTextContent('約 100 %');
    expect(plain).toHaveTextContent('約 0 %');
  });
});

describe('結果カード: 回答の本文と同じ文は、カードで繰り返さない', () => {
  it('お断り: 理由の文が本文にすでにあれば、カードには出さない（見出しと「代わりの質問」は残す）', () => {
    render(<ResultCard result={refusal} actions={makeActions()} answerText={refusal.message} />);
    expect(screen.queryByText(refusal.message)).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'この質問は範囲外です' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'このアプリの精度は？' })).toBeInTheDocument();
  });

  it('お断り: 本文に理由の文が無ければ（本文が別の言い方）、カードに出す。本文を渡さなければ、これまでどおり出す', () => {
    const { unmount } = render(<ResultCard result={refusal} actions={makeActions()} answerText="お答えできません。" />);
    expect(screen.getByText(refusal.message)).toBeInTheDocument();
    unmount();
    render(<ResultCard result={refusal} actions={makeActions()} />);
    expect(screen.getByText(refusal.message)).toBeInTheDocument();
  });

  it('お断り: 本文が、理由の文の前後に別の文を足していても、含んでいれば出さない', () => {
    render(<ResultCard result={refusal} actions={makeActions()} answerText={`先に一言。${refusal.message}あとに一言。`} />);
    expect(screen.queryByText(refusal.message)).not.toBeInTheDocument();
  });

  it('検出画像: 写真の説明が本文にすでにあれば、カードには出さない（分類の印・写真・「詳細を開く」は残す）', () => {
    render(<ResultCard result={detectionImage} actions={makeActions()} answerText={`候補 c-1-2-1 の写真を、2018 年と 2023 年で並べます。${detectionImage.caption}`} />);
    expect(screen.queryByText(detectionImage.caption)).not.toBeInTheDocument();
    expect(screen.getAllByRole('img')).toHaveLength(2);
    expect(screen.getByRole('button', { name: '詳細を開く' })).toBeInTheDocument();
    expect(document.querySelector('.class-badge')).not.toBeNull();
  });

  it('検出画像: 本文に説明が無ければ、カードに出す', () => {
    render(<ResultCard result={detectionImage} actions={makeActions()} answerText="写真です。" />);
    expect(screen.getByText(detectionImage.caption)).toBeInTheDocument();
  });
});
