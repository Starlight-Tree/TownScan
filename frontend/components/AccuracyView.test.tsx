import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse, metrics, metricsReal, provenance } from '../tests/fixtures';
import { AccuracyView } from './AccuracyView';

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('/accuracy', () => {
  it('調整用と評価用を分けて出し、新築の再現率は「未測定」、閾値は未検証の初期値と書く', async () => {
    fetchMock.mockResolvedValue(jsonResponse(metrics));
    render(<AccuracyView />);
    expect(await screen.findByText('新築の再現率')).toBeInTheDocument();
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/metrics');
    expect(screen.getByText('未測定')).toBeInTheDocument();
    expect(screen.getByText(/未検証の初期値/)).toBeInTheDocument();
    expect(screen.getByText(/調整用の地区だけ/)).toBeInTheDocument();

    const pixel = screen.getByRole('table', { name: '画素単位' });
    const iou = within(pixel).getByRole('row', { name: /IoU/ });
    expect(within(iou).getAllByRole('cell').map((c) => c.textContent)).toEqual(['0.634', '0.612']);
    expect(within(pixel).getByRole('columnheader', { name: '調整用' })).toBeInTheDocument();
    expect(within(pixel).getByRole('columnheader', { name: '評価用' })).toBeInTheDocument();
    // 選んだ設定の行を目立たせる
    expect(screen.getByRole('row', { name: /選択/ })).toHaveAttribute('aria-current', 'true');
    // 12 地区・限定つきの数字と明記
    expect(screen.getByText(/12 地区・初期値の閾値/)).toBeInTheDocument();
  });

  it('new_building_recall に数があれば、その数を出す（未測定とは書かない）', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ...metrics, new_building_recall: 0.42 }));
    render(<AccuracyView />);
    expect(await screen.findByText('0.42')).toBeInTheDocument();
    expect(screen.queryByText('未測定')).not.toBeInTheDocument();
  });

  it('合成データの数字には、その旨を明記する', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ...metrics, provenance: { ...provenance, run_kind: 'synthetic' } }));
    render(<AccuracyView />);
    expect(await screen.findByRole('note')).toHaveTextContent('実際の写真の精度ではありません');
  });

  it('読み込み中 → エラー → 再試行', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('x')).mockResolvedValueOnce(jsonResponse(metrics));
    render(<AccuracyView />);
    expect(screen.getByRole('status')).toHaveTextContent('読み込んでいます');
    expect(await screen.findByRole('alert')).toHaveTextContent('読み込めませんでした');
    await userEvent.click(screen.getByRole('button', { name: '再試行' }));
    expect(await screen.findByText('新築の再現率')).toBeInTheDocument();
  });

  it('細部の形が違っても（指標が少ない・無い）落ちない', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ new_building_recall: null }));
    render(<AccuracyView />);
    expect(await screen.findByText('新築の再現率')).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  describe('実データの形（year_compare などの任意項目つき）', () => {
    async function renderReal(body: unknown = metricsReal) {
      fetchMock.mockResolvedValue(jsonResponse(body));
      const view = render(<AccuracyView />);
      await screen.findByText('新築の再現率');
      return view;
    }
    const bodyText = () => document.body.textContent ?? '';

    it('見出しの数字は「2018 年の写真での値」と明記し、2023 年の写真での値を並べる', async () => {
      await renderReal();
      expect(screen.getByTestId('eval-year-note')).toHaveTextContent('2018 年の写真から建物を抽出して測った値');
      expect(screen.getByTestId('eval-year-note')).toHaveTextContent('2023 年の写真での値も並べています');
      const tiles = screen.getAllByRole('listitem').filter((li) => li.classList.contains('metric-tile'));
      expect(tiles).toHaveLength(3);
      // F1: 2018 年 0.16・2023 年 0.1（評価用）
      expect(within(tiles[0]!).getByText('2018 年の写真での値')).toBeInTheDocument();
      expect(tiles[0]).toHaveTextContent('2023 年の写真での値: 0.1');
      expect(within(tiles[0]!).getByText('0.16')).toBeInTheDocument();
      // 画素 IoU: 2018 年 0.412・2023 年 0.295
      expect(within(tiles[1]!).getByText('2018 年の写真での値')).toBeInTheDocument();
      expect(tiles[1]).toHaveTextContent('2023 年の写真での値: 0.295');
      // 新築の再現率は年を持たない（未測定）
      expect(within(tiles[2]!).queryByText(/年の写真での値/)).not.toBeInTheDocument();
    });

    it('year_compare が無い・壊れていても、2018 年の明記は出し、2023 年の値は出さず、落ちない', async () => {
      for (const bad of [undefined, null, 'x', {}, { compare_year: 2023 }, { compare_year: 2023, by_year: {} }, { compare_year: 2023, by_year: { '2023': 5 } }, { compare_year: 2018, by_year: { '2018': { holdout: {} } } }]) {
        const { year_compare: _drop, ...rest } = metricsReal;
        void _drop;
        const { unmount } = await renderReal(bad === undefined ? rest : { ...rest, year_compare: bad });
        expect(screen.getAllByText('2018 年の写真での値')).toHaveLength(2);
        expect(bodyText()).not.toMatch(/2023 年の写真での値/);
        expect(screen.queryByRole('heading', { name: /写真の年で比べる/ })).not.toBeInTheDocument();
        unmount();
      }
    });

    it('year_compare があれば、同じ設定の 2 つの年を表で並べる', async () => {
      await renderReal();
      expect(screen.getByRole('heading', { name: '写真の年で比べる（2018 年と 2023 年）' })).toBeInTheDocument();
      const table = screen.getByRole('table', { name: /写真の年ごとの/ });
      const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent);
      expect(headers).toEqual(['指標', '評価用・2018 年の写真', '評価用・2023 年の写真', '12 地区全体・2018 年の写真', '12 地区全体・2023 年の写真']);
      const f1 = within(table).getByRole('row', { name: /^物体単位・F1/ });
      expect(within(f1).getAllByRole('cell').map((c) => c.textContent)).toEqual(['0.16', '0.1', '0.189', '0.123']);
      expect(screen.getByText(/倍率 2・閾値 0.4）のまま/)).toBeInTheDocument();
    });

    it('建物の抽出の「再現率」は、新築の再現率と取り違えない語で修飾する', async () => {
      await renderReal();
      const recallHeads = screen.getAllByRole('rowheader').concat(screen.getAllByRole('columnheader')).filter((h) => /再現率/.test(h.textContent ?? ''));
      expect(recallHeads.length).toBeGreaterThanOrEqual(6);
      for (const h of recallHeads) expect(h.textContent).toMatch(/建物の抽出の再現率/);
      expect(screen.getAllByRole('rowheader', { name: '建物の抽出の再現率（基盤地図情報に対して）' }).length).toBeGreaterThanOrEqual(2);
      // 新築の再現率の枠には、別の値だと書く
      expect(screen.getByText(/「建物の抽出の再現率」（基盤地図情報に対する値）とは別の値/)).toBeInTheDocument();
      // 「再現率」だけの見出しは残さない
      expect(screen.queryByRole('rowheader', { name: '再現率' })).not.toBeInTheDocument();
    });

    it('生のキー（tune_*・n_ref・excluded_*・reference・prediction）を画面に出さない', async () => {
      await renderReal();
      expect(bodyText()).not.toMatch(/[a-z]+_[a-z]+/);
      expect(bodyText()).not.toMatch(/\b(reference|prediction)\b/);
      const sweep = screen.getByRole('table', { name: /倍率と閾値ごと/ });
      expect(within(sweep).getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
        '選んだ組',
        '倍率',
        '閾値',
        '物体単位 F1',
        '建物の抽出の適合率（物体単位）',
        '建物の抽出の再現率（物体単位）',
        '画素 IoU',
        '画素 F1',
      ]);
      const area = screen.getAllByRole('table').find((t) => within(t).queryByRole('columnheader', { name: '地区' }))!;
      expect(within(area).getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
        '地区',
        '区分',
        '画素 IoU',
        '画素 F1',
        '物体単位 F1',
        '建物の抽出の適合率（物体単位）',
        '建物の抽出の再現率（物体単位）',
        '参照の物体数（縁を除く）',
        '予測の物体数（縁を除く）',
        '縁で外した参照の数',
        '縁で外した予測の数',
      ]);
    });

    it('縁で外した数は、評価用の値を使い、12 地区の合計は合計と書く', async () => {
      await renderReal();
      const note = screen.getByTestId('reference-note').textContent ?? '';
      expect(note).toContain('外した数は、評価用の地区で 参照 47（縁に接する 39・重なりで外した 8）・予測 31（縁に接する 30・重なりで外した 1）');
      expect(note).toContain('12 地区の合計は 参照 107・予測 59');
      expect(note).toContain('面積の 50 % 以上が重なる反対側の物体も外しています');
    });

    it('縁で外した数に評価用の区分が無ければ、合計と明記し、評価用の隣に合計を数として出さない', async () => {
      const { excluded_edge_by_split: _a, excluded_edge_detail: _b, protocol: _c, ...rest } = metricsReal;
      void _a; void _b; void _c;
      await renderReal(rest);
      const note = screen.getByTestId('reference-note').textContent ?? '';
      expect(note).toContain('外した数は、12 地区の合計で 参照 107・予測 59です（評価用の地区だけの数は、評価ファイルにありません）');
      expect(note).not.toContain('評価用の地区で 参照');
      expect(note).not.toContain('反対側の物体も外しています');
    });

    it('画素単位の TP/FP/FN の単位（倍率 2 の格子の升目）と、物体数の「縁を除く」を注記する', async () => {
      await renderReal();
      const pixel = screen.getByTestId('note-pixel');
      expect(pixel).toHaveTextContent('倍率 2 の格子の升目の数');
      expect(pixel).toHaveTextContent('一辺が約 0.25 m');
      expect(pixel).toHaveTextContent('写真の 1 画素の 4 分の 1 の面積');
      expect(screen.getByTestId('note-object')).toHaveTextContent('縁で外した物体を除いた数');
      expect(screen.getAllByRole('rowheader', { name: '参照の物体数（縁を除く）' })).toHaveLength(1);
      expect(screen.getByRole('columnheader', { name: '参照の物体数（縁を除く）' })).toBeInTheDocument();
    });

    it('選んだ行の印は倍率の数字と別のセルに置く', async () => {
      await renderReal();
      const sweep = screen.getByRole('table', { name: /倍率と閾値ごと/ });
      const chosen = within(sweep).getByRole('row', { name: /選択/ });
      expect(chosen).toHaveAttribute('aria-current', 'true');
      const cells = within(chosen).getAllByRole('cell');
      expect(cells[0]).toHaveTextContent(/^選択$/);
      expect(cells[1]).toHaveTextContent(/^2$/);
      expect(cells[2]).toHaveTextContent(/^0\.4$/);
      // 選ばれなかった行は、先頭のセルが空
      const others = within(sweep).getAllByRole('row').filter((r) => !r.hasAttribute('aria-current')).slice(1);
      expect(others.length).toBe(14);
      for (const r of others) expect(within(r).getAllByRole('cell')[0]).toBeEmptyDOMElement();
      // 列見出しは、読み上げ用の文字を持つ（空の見出しにしない）
      expect(within(sweep).getByRole('columnheader', { name: '選んだ組' })).toBeInTheDocument();
    });

    it('物体単位 F1 の根拠（一致 14 棟・参照 115 棟）を、データから 1 行で添える', async () => {
      await renderReal();
      const basis = screen.getByTestId('f1-basis');
      expect(basis).toHaveTextContent('評価用の参照 115 棟（縁を除く）のうち、一致は 14 棟。');
      expect(basis).toHaveTextContent('少数の棟の上の値');
      const stab = screen.getByTestId('choice-stability');
      expect(stab).toHaveTextContent('調整用の地区で一致した棟は 15 棟（縁を除く参照 85 棟中）');
      expect(stab).toHaveTextContent('選んだ組の F1 は 0.227、次に高い組は 0.212（差 0.015）');
    });

    it('一致が十分に多ければ「少数」とは書かない。件数が無ければ根拠の行を出さない', async () => {
      const many = { ...metricsReal, holdout: { ...metricsReal.holdout, object: { ...(metricsReal.holdout!.object as object), tp: 80, n_ref: 100 } } };
      const { unmount } = await renderReal(many);
      expect(screen.getByTestId('f1-basis')).toHaveTextContent('一致は 80 棟');
      expect(screen.getByTestId('f1-basis')).not.toHaveTextContent('少数');
      unmount();
      const none = { ...metricsReal, holdout: { pixel: metricsReal.holdout!.pixel, object: { f1: 0.16 } } };
      await renderReal(none);
      expect(screen.queryByTestId('f1-basis')).not.toBeInTheDocument();
    });

    it('限界欄: 2018 年の写真での見落としの実測の割合を、データから描く（手ラベルの代わりにはならない）', async () => {
      await renderReal();
      const limit = screen.getByTestId('limit-absent');
      expect(limit).toHaveTextContent('2018 年の写真での見落とし（既存の建物が「新規出現」に入る）');
      expect(limit).toHaveTextContent('基盤地図情報にある既存の建物（20 m² 以上・縁に接しない）200 棟のうち、約 3 割（66 棟）で、2018 年の抽出が何も見ていません');
      expect(limit).toHaveTextContent('半分以上を覆っているのは 約 5 割（102 棟）');
      expect(limit).toHaveTextContent('評価用の地区だけでは 110 棟のうち 34 棟（約 3 割）');
      expect(limit).toHaveTextContent('手ラベルの代わりにはなりません');
    });

    it('限界欄の見落としの割合は、データの値に従う（手書きの数字ではない）', async () => {
      const body = {
        ...metricsReal,
        existing_absent_in_2018: { ...(metricsReal.existing_absent_in_2018 as object), overall: { n_buildings: 50, absent: 31, absent_share: 0.62, present: 10, present_share: 0.2 }, holdout: undefined },
      };
      await renderReal(body);
      const limit = screen.getByTestId('limit-absent');
      expect(limit).toHaveTextContent('50 棟のうち、約 6 割（31 棟）で');
      expect(limit).toHaveTextContent('半分以上を覆っているのは 約 2 割（10 棟）');
      expect(limit).not.toHaveTextContent('評価用の地区だけでは');
    });

    it('限界欄: existing_absent_in_2018 が無ければ、数を出さずに測れていないと書く（壊れない）', async () => {
      const { existing_absent_in_2018: _x, ...rest } = metricsReal;
      void _x;
      const first = await renderReal(rest);
      const limit = screen.getByTestId('limit-absent');
      expect(limit).toHaveTextContent('この割合は、評価ファイルに無く、測れていません');
      expect(limit).not.toHaveTextContent('約');
      first.unmount();
      // 形が壊れていても同じ
      for (const bad of [{ overall: { n_buildings: 0, absent: 0 } }, { overall: { n_buildings: 10, absent: 11 } }, { overall: { n_buildings: 'x', absent: 1 } }, 'x', null]) {
        const { unmount } = await renderReal({ ...metricsReal, existing_absent_in_2018: bad });
        expect(screen.getByTestId('limit-absent')).toHaveTextContent('測れていません');
        unmount();
      }
    });

    it('限界欄: 参照が写真より古い可能性と、物体単位の適合率が合成値であること', async () => {
      await renderReal();
      const limit = screen.getByTestId('limit-reference');
      expect(limit).toHaveTextContent('写真より古い可能性があります（推定）');
      expect(limit).toHaveTextContent('独立の確認はしていません');
      expect(limit).toHaveTextContent('物体単位の適合率は、モデルの適合率ではなく、モデルの精度と参照の完全性が混ざった値');
    });

    it('限界欄: 写真の年ごとの画素の再現率を数字だけで書き、原因（暗さなど）は書かない', async () => {
      await renderReal();
      const limit = screen.getByTestId('limit-haze');
      expect(limit).toHaveTextContent('2018 年の写真で 0.459、2023 年の写真で 0.34');
      expect(limit).toHaveTextContent('モデルの見落としが「新規出現」として混ざります');
      expect(limit).toHaveTextContent('違いの原因（写真の暗さ・撮影条件など）は確かめていません');
      expect(limit).not.toHaveTextContent('取りこぼしが多い');
      expect(limit).not.toHaveTextContent('霞');
    });

    it('限界欄: 値が変われば数字が追従し、year_compare が無ければこの項目ごと出さない', async () => {
      const overall = metricsReal.overall as { pixel: object; object: object };
      const swapped = { ...metricsReal, overall: { ...overall, pixel: { ...overall.pixel, recall: 0.2 } } };
      const { unmount } = await renderReal(swapped);
      expect(screen.getByTestId('limit-haze')).toHaveTextContent('2018 年の写真で 0.2、2023 年の写真で 0.34');
      unmount();
      const { year_compare: _y, ...rest } = metricsReal;
      void _y;
      await renderReal(rest);
      expect(screen.queryByTestId('limit-haze')).not.toBeInTheDocument();
    });

    it('既存の限界の項目は残る', async () => {
      await renderReal();
      for (const t of ['撮影月が不明', '2018 年は帯状の範囲だけ', 'タイルの縁', '誤検出の可能性', '正解が無い', '対象範囲']) {
        expect(screen.getByText(t)).toBeInTheDocument();
      }
    });
  });

  it('従来の形（任意項目なし）でも、年の明記と新しい限界欄が出て、2023 年の値は出さない', async () => {
    fetchMock.mockResolvedValue(jsonResponse(metrics));
    render(<AccuracyView />);
    await screen.findByText('新築の再現率');
    expect(screen.getAllByText('2018 年の写真での値')).toHaveLength(2);
    expect(document.body.textContent).not.toMatch(/2023 年の写真での値/);
    expect(screen.getByTestId('reference-note')).toHaveTextContent('12 地区の合計で 参照 41・予測 38です');
    expect(screen.getByTestId('limit-absent')).toHaveTextContent('測れていません');
    expect(screen.getByTestId('limit-reference')).toBeInTheDocument();
    // 年の比べる値が無いときは、写真の年の違いの項目は出さない（根拠の無い固定の文を置かない）
    expect(screen.queryByTestId('limit-haze')).not.toBeInTheDocument();
  });

  it('読み込み中・エラーのときも、限界欄は出る（数は出さない。年の違いの項目は出さない）', async () => {
    fetchMock.mockRejectedValue(new TypeError('x'));
    render(<AccuracyView />);
    expect(screen.getByTestId('limit-absent')).toHaveTextContent('読み込めていないため、出していません');
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByTestId('limit-haze')).not.toBeInTheDocument();
  });
});
