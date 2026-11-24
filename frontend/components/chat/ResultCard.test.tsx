import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ToolResult } from '../../lib/api-types';
import { ALL_RESULTS, accuracy, compare, count, countWards, detectionImage, mapFocus, refusal, table } from '../../tests/fixtures';
import { ResultCard } from './ResultCard';
import type { ResultActions } from './types';

function makeActions(): ResultActions {
  return { openCandidate: vi.fn(), focusMap: vi.fn(), ask: vi.fn(), showView: vi.fn() };
}

describe('結果カード: 型ごとの描画', () => {
  it('count: 件数・内訳・絞り込み条件・根拠', () => {
    render(<ResultCard result={count} actions={makeActions()} />);
    const card = screen.getByRole('region', { name: count.title });
    expect(within(card).getByText('33', { selector: '.count-hero__value' })).toBeInTheDocument();
    expect(within(card).getByRole('list', { name: '内訳' }).querySelectorAll('li')).toHaveLength(3);
    expect(within(card).getByText('51')).toBeInTheDocument();
    expect(within(card).getByText('根拠を見る')).toBeInTheDocument();
    expect(within(card).getByText(count.provenance.model)).toBeInTheDocument();
  });

  it('count: 「グラフで見る」でグラフの画面へ切り替える（根拠の手前に並ぶ）', async () => {
    const actions = makeActions();
    render(<ResultCard result={count} actions={actions} />);
    const card = screen.getByRole('region', { name: count.title });
    const button = within(card).getByRole('button', { name: 'グラフで見る' });
    expect(button.compareDocumentPosition(within(card).getByText('根拠を見る')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await userEvent.click(button);
    expect(actions.showView).toHaveBeenCalledTimes(1);
    // そのカードの結果の条件（分類 = 新規出現、地区 = すべて）を添えて渡す
    expect(actions.showView).toHaveBeenCalledWith('chart', { areaId: '', classes: new Set(['confirmed_new']) });
    expect(actions.focusMap).not.toHaveBeenCalled();
  });

  it('count: 「地図で見る」も、そのカードの条件で地図の画面を開く（根拠の手前。グラフで見るの隣）', async () => {
    const actions = makeActions();
    render(<ResultCard result={countWards} actions={actions} />);
    const card = screen.getByRole('region', { name: countWards.title });
    const chart = within(card).getByRole('button', { name: 'グラフで見る' });
    const map = within(card).getByRole('button', { name: '地図で見る' });
    expect(chart.parentElement).toBe(map.parentElement);
    expect(map.compareDocumentPosition(within(card).getByText('根拠を見る')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await userEvent.click(map);
    expect(actions.showView).toHaveBeenCalledTimes(1);
    // 複数の地区（区）の条件は、area_ids と scope のまま（areaId は空）
    expect(actions.showView).toHaveBeenCalledWith('map', {
      areaId: '',
      areaIds: ['z18-1-2', 'z18-2-2'],
      scope: '中央区',
      classes: new Set(['confirmed_new', 'existing_omission', 'uncertain']),
    });
    await userEvent.click(chart);
    expect(actions.showView).toHaveBeenLastCalledWith('chart', expect.objectContaining({ areaIds: ['z18-1-2', 'z18-2-2'], scope: '中央区' }));
  });

  it('count: 絞り込み条件のチップ。複数の地区は API の scope をそのまま、scope が無ければ「N 地区」（「すべて」とは言わない）', () => {
    const { unmount } = render(<ResultCard result={countWards} actions={makeActions()} />);
    expect(within(screen.getByLabelText('絞り込み条件')).getByText('地区: 中央区')).toBeInTheDocument();
    unmount();
    render(<ResultCard result={{ ...countWards, filter: { ...countWards.filter, scope: null } }} actions={makeActions()} />);
    expect(within(screen.getByLabelText('絞り込み条件')).getByText('地区: 2 地区')).toBeInTheDocument();
  });

  it('compare: 「グラフで見る」でグラフの画面へ切り替える。比べる地区が無いときは出さない', async () => {
    const actions = makeActions();
    const { unmount } = render(<ResultCard result={compare} actions={actions} />);
    await userEvent.click(screen.getByRole('button', { name: 'グラフで見る' }));
    // 比較のカードは、3 分類と合計を出すので、分類はすべて（地区は結果に無ければ全地区）
    expect(actions.showView).toHaveBeenCalledWith('chart', { areaId: '', classes: new Set(['confirmed_new', 'existing_omission', 'uncertain']) });
    expect(screen.queryByRole('button', { name: '地図で見る' })).not.toBeInTheDocument();
    unmount();
    render(<ResultCard result={{ ...compare, items: [] }} actions={actions} />);
    expect(screen.getByText('比べる地区がありません。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'グラフで見る' })).not.toBeInTheDocument();
  });

  it('グラフで見るボタンは、件数・比較だけに付く', () => {
    for (const result of [table, mapFocus, detectionImage, accuracy, refusal]) {
      const { unmount } = render(<ResultCard result={result} actions={makeActions()} />);
      expect(screen.queryByRole('button', { name: 'グラフで見る' })).not.toBeInTheDocument();
      unmount();
    }
  });

  it('table: 列・行・「全 N 件中 M 件」、候補の行から詳細を開く', async () => {
    const actions = makeActions();
    render(<ResultCard result={table} actions={actions} />);
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent).slice(0, 3)).toEqual(['候補 ID', '分類', '面積（m²）']);
    expect(screen.getAllByRole('row')).toHaveLength(3);
    expect(screen.getByText('全 102 件中 2 件を表示')).toBeInTheDocument();
    expect(screen.getByText('新規出現')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /詳細.*c-1-2-1/ }));
    expect(actions.openCandidate).toHaveBeenCalledWith('c-1-2-1');
  });

  it('table: 行が無いときは空の表示', () => {
    render(<ResultCard result={{ ...table, rows: [], shown: 0, total: 0 }} actions={makeActions()} />);
    expect(screen.getByText('該当する行はありません。')).toBeInTheDocument();
  });

  it('compare: 地区ごとに分類別の件数と合計', () => {
    render(<ResultCard result={compare} actions={makeActions()} />);
    const row = screen.getByRole('row', { name: /テスト地区 02/ });
    expect(within(row).getByText('6')).toBeInTheDocument();
    expect(within(row).getByText('10')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '合計' })).toBeInTheDocument();
  });

  it('map_focus: 「地図で見る」で範囲と候補 ID を渡す', async () => {
    const actions = makeActions();
    render(<ResultCard result={mapFocus} actions={actions} />);
    await userEvent.click(screen.getByRole('button', { name: '地図で見る' }));
    expect(actions.focusMap).toHaveBeenCalledWith({ bbox: mapFocus.bbox, candidateIds: mapFocus.candidate_ids });
  });

  it('map_focus: 説明は、右の「結果領域」の「地図」を指す（旧「地図の右側で…」に戻らない。結果領域は、地図の右ではなくチャットの右）', () => {
    render(<ResultCard result={mapFocus} actions={makeActions()} />);
    const card = screen.getByRole('region', { name: mapFocus.title });
    expect(card).toHaveTextContent('結果領域の「地図」で、候補 3 件を目立たせて表示します。');
    expect(card).not.toHaveTextContent('地図の右側');
    // 候補が無い範囲だけの表示は、「この範囲を」
    cleanup();
    render(<ResultCard result={{ ...mapFocus, candidate_ids: [] }} actions={makeActions()} />);
    expect(screen.getByRole('region', { name: mapFocus.title })).toHaveTextContent('結果領域の「地図」で、この範囲を表示します。');
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
