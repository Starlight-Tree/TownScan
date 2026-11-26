import { render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AreaSummary, CandidateClass } from '../../lib/api-types';
import { ALL_FILTER, type MapFilter } from '../../lib/result-view';
import { AreaChartView, showSegmentCount } from './AreaChartView';

function area(id: string, name: string, ward: string, counts: [number, number, number]): AreaSummary {
  const [confirmed_new, existing_omission, uncertain] = counts;
  return {
    id,
    name,
    ward,
    bbox: [130.7, 32.8, 130.701, 32.801],
    centroid: [130.7005, 32.8005],
    counts: { confirmed_new, existing_omission, uncertain, total: confirmed_new + existing_omission + uncertain },
  };
}

// 合計: アサヒ 10・イースト 10（同数→地区名の順）・ノース 9・ゼロ 0
const areas = [
  area('a', 'イースト地区', '東区', [2, 6, 2]),
  area('b', 'アサヒ地区', '中央区', [4, 4, 2]),
  area('c', 'ノース地区', '北区', [5, 3, 1]),
  area('d', 'ゼロ地区', '南区', [0, 0, 0]),
];

const only = (...cs: CandidateClass[]): MapFilter => ({ areaId: '', classes: new Set(cs) });

function setup(filter: MapFilter = ALL_FILTER) {
  const onFilterChange = vi.fn();
  const view = render(<AreaChartView areas={areas} filter={filter} onFilterChange={onFilterChange} />);
  return { onFilterChange, ...view };
}

const rowButtons = () => within(screen.getByRole('list')).getAllByRole('button');
const widths = (row: HTMLElement) => Array.from(row.querySelectorAll<HTMLElement>('.area-chart__seg')).map((s) => [s.dataset.class, parseFloat(s.style.width)]);

describe('グラフ（地区ごとの件数の積み上げ横棒）', () => {
  it('合計の多い順に並べる（同数は地区名の順）。1 行 = 1 地区で、地区名・区・合計を出す。0 件の地区は、行にせず 1 行にまとめる', () => {
    setup();
    const rows = rowButtons();
    expect(rows.map((r) => r.querySelector('.area-chart__name')?.textContent)).toEqual(['アサヒ地区（中央区）', 'イースト地区（東区）', 'ノース地区（北区）']);
    expect(rows.map((r) => r.querySelector('.area-chart__total strong')?.textContent)).toEqual(['10', '10', '9']);
    expect(document.querySelector('.area-chart__zero')).toHaveTextContent('0 件の地区（1） ゼロ地区');
    // まとめた地区も、「表で見る」の表には残る（全地区の数字は、表で読める）
    expect(screen.getByRole('row', { name: /ゼロ地区/ })).toBeInTheDocument();
  });

  it('0 件の地区が複数なら、数と名前を 1 行に並べる。選んでいる地区は、0 件でも行に残す（押し直して戻せる）', () => {
    const many = [...areas, area('e', 'ゼロ二地区', '西区', [0, 0, 0])];
    const { rerender } = render(<AreaChartView areas={many} filter={ALL_FILTER} onFilterChange={vi.fn()} />);
    const zero = document.querySelector('.area-chart__zero')!;
    expect(zero).toHaveTextContent('0 件の地区（2）');
    expect(zero).toHaveTextContent('ゼロ地区');
    expect(zero).toHaveTextContent('ゼロ二地区');
    expect(rowButtons()).toHaveLength(3);
    rerender(<AreaChartView areas={many} filter={{ ...ALL_FILTER, areaId: 'd' }} onFilterChange={vi.fn()} />);
    expect(rowButtons().map((r) => r.querySelector('.area-chart__name')?.textContent)).toContain('ゼロ地区（南区）');
    expect(document.querySelector('.area-chart__zero')).toHaveTextContent('0 件の地区（1） ゼロ二地区');
  });

  it('0 件の地区が無ければ、まとめの行は出さない。全部が 0 件なら、行は無く、その旨と 0 件の地区の一覧を出す', () => {
    const { unmount } = render(<AreaChartView areas={areas.slice(0, 3)} filter={ALL_FILTER} onFilterChange={vi.fn()} />);
    expect(document.querySelector('.area-chart__zero')).toBeNull();
    unmount();
    render(<AreaChartView areas={[areas[3]!]} filter={ALL_FILTER} onFilterChange={vi.fn()} />);
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(screen.getByText('表示中の分類の候補は、どの地区にもありません。')).toBeInTheDocument();
    expect(document.querySelector('.area-chart__zero')).toHaveTextContent('0 件の地区（1） ゼロ地区');
  });

  it('区間の中に件数を書く（棒に対して十分な幅があるときだけ）。書かない区間も、ホバーの題と行の読み上げで読める', () => {
    setup();
    const [asahi] = rowButtons() as [HTMLElement];
    const labels = Array.from(asahi.querySelectorAll('.area-chart__seg')).map((seg) => [seg.getAttribute('title'), seg.querySelector('.area-chart__seg-n')?.textContent]);
    expect(labels).toEqual([
      ['2018 年は未検出 4 件', '4'],
      ['2018 年も検出 4 件', '4'],
      ['未判定 2 件', '2'],
    ]);
    // 書くかどうかは、棒に対する割合（1 桁は 10% 以上、2 桁は 18% 以上）
    expect(showSegmentCount(1, 10)).toBe(true);
    expect(showSegmentCount(1, 11)).toBe(false);
    expect(showSegmentCount(10, 100)).toBe(false);
    expect(showSegmentCount(18, 100)).toBe(true);
    expect(showSegmentCount(0, 10)).toBe(false);
  });

  it('3 分類を積み上げる。幅は、最大の合計（10）に対する割合。0 件の分類は描かない', () => {
    setup();
    const [asahi, , north] = rowButtons() as [HTMLElement, HTMLElement, HTMLElement];
    expect(widths(asahi)).toEqual([
      ['confirmed_new', 40],
      ['existing_omission', 40],
      ['uncertain', 20],
    ]);
    expect(widths(north)).toEqual([
      ['confirmed_new', 50],
      ['existing_omission', 30],
      ['uncertain', 10],
    ]);
    // 棒は装飾（読み上げは行の aria-label が担う）
    expect(asahi.querySelector('.area-chart__bar')).toHaveAttribute('aria-hidden', 'true');
  });

  it('filter.classes に含まれない分類は、描かない。合計も、描いた分類の和になる', () => {
    setup(only('existing_omission', 'uncertain'));
    const rows = rowButtons();
    // 並びも、表示する分類の和（イースト 8、アサヒ 6、ノース 4）の順
    expect(rows.map((r) => r.querySelector('.area-chart__name')?.textContent)).toEqual(['イースト地区（東区）', 'アサヒ地区（中央区）', 'ノース地区（北区）']);
    expect(rows.map((r) => r.querySelector('.area-chart__total strong')?.textContent)).toEqual(['8', '6', '4']);
    for (const r of rows) expect(r.querySelector('[data-class="confirmed_new"]')).toBeNull();
    // 最大の合計（8）が、棒の幅の基準になる
    expect(widths(rows[0]!)).toEqual([
      ['existing_omission', 75],
      ['uncertain', 25],
    ]);
  });

  it('各行の aria-label に、地区名と 3 分類の件数・合計を書く。選んだ行は aria-pressed', () => {
    setup({ ...ALL_FILTER, areaId: 'c' });
    const north = screen.getByRole('button', { name: /ノース地区/ });
    expect(north).toHaveAccessibleName('ノース地区（北区）、2018 年は未検出 5 件、2018 年も検出 3 件、未判定 1 件、合計 9 件');
    expect(north).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /アサヒ地区/ })).toHaveAttribute('aria-pressed', 'false');
  });

  it('グラフに出していない分類は、行の aria-label でもそう言う', () => {
    setup(only('confirmed_new'));
    expect(screen.getByRole('button', { name: /ノース地区/ })).toHaveAccessibleName(
      'ノース地区（北区）、2018 年は未検出 5 件、2018 年も検出 3 件（グラフには出していません）、未判定 1 件（グラフには出していません）、合計 5 件',
    );
  });

  it('行を押すと、その地区に絞り込む（分類の絞り込みは保つ）。選んでいる行をもう一度押すと全地区に戻る', async () => {
    const filter = only('confirmed_new', 'uncertain');
    const { onFilterChange, rerender } = setup(filter);
    await userEvent.click(screen.getByRole('button', { name: /ノース地区/ }));
    expect(onFilterChange).toHaveBeenLastCalledWith({ areaId: 'c', classes: filter.classes });

    rerender(<AreaChartView areas={areas} filter={{ ...filter, areaId: 'c' }} onFilterChange={onFilterChange} />);
    await userEvent.click(screen.getByRole('button', { name: /ノース地区/ }));
    expect(onFilterChange).toHaveBeenLastCalledWith({ areaId: '', classes: filter.classes });
    expect(onFilterChange).toHaveBeenCalledTimes(2);
  });

  it('行はキーボード（Enter）でも押せる', async () => {
    const { onFilterChange } = setup();
    screen.getByRole('button', { name: /イースト地区/ }).focus();
    await userEvent.keyboard('{Enter}');
    expect(onFilterChange).toHaveBeenCalledWith(expect.objectContaining({ areaId: 'a' }));
  });

  it('凡例は、押すと分類の絞り込みを切り替えるボタン（aria-pressed）。地区の絞り込みは保つ', async () => {
    const { onFilterChange, rerender } = setup({ ...ALL_FILTER, areaId: 'c' });
    const legend = screen.getByRole('group', { name: /分類/ });
    const buttons = within(legend).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['2018 年は未検出', '2018 年も検出', '未判定']);
    for (const b of buttons) expect(b).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(within(legend).getByRole('button', { name: '未判定' }));
    const next = onFilterChange.mock.calls.at(-1)![0] as MapFilter;
    expect(next.areaId).toBe('c');
    expect([...next.classes].sort()).toEqual(['confirmed_new', 'existing_omission']);

    // 外した状態から押すと、戻る
    rerender(<AreaChartView areas={areas} filter={next} onFilterChange={onFilterChange} />);
    expect(within(legend).getByRole('button', { name: '未判定' })).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(within(legend).getByRole('button', { name: '未判定' }));
    expect([...(onFilterChange.mock.calls.at(-1)![0] as MapFilter).classes].sort()).toEqual(['confirmed_new', 'existing_omission', 'uncertain']);
  });

  it('凡例のボタンに、分類の印（色・線・形）を付ける', () => {
    setup();
    const legend = screen.getByRole('group', { name: /分類/ });
    expect(legend.querySelectorAll('svg.class-swatch')).toHaveLength(3);
  });

  it('分類をすべて外すと、「表示する分類がありません」を知らせ、棒と表は出さない（凡例は残る）', () => {
    setup(only());
    expect(screen.getByRole('status')).toHaveTextContent('表示する分類がありません');
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(screen.queryByText('表で見る')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(3);
  });

  it('「表で見る」に、同じ数字の表を出す（caption つき・行見出し・列見出し）', async () => {
    setup();
    const details = screen.getByText('表で見る').closest('details')!;
    expect(details).not.toHaveAttribute('open');
    await userEvent.click(screen.getByText('表で見る'));
    expect(details).toHaveAttribute('open');

    const table = screen.getByRole('table', { name: '地区ごとの件数（合計の多い順）' });
    expect(table.querySelector('caption')).toHaveTextContent('地区ごとの件数');
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['地区', '区', '2018 年は未検出', '2018 年も検出', '未判定', '合計']);
    const body = within(table).getAllByRole('row').slice(1);
    const cells = body.map((tr) => Array.from(tr.querySelectorAll('th, td')).map((c) => c.textContent));
    expect(cells).toEqual([
      ['アサヒ地区', '中央区', '4', '4', '2', '10'],
      ['イースト地区', '東区', '2', '6', '2', '10'],
      ['ノース地区', '北区', '5', '3', '1', '9'],
      ['ゼロ地区', '南区', '0', '0', '0', '0'],
    ]);
  });

  it('表も、表示する分類だけの列・合計にそろえる', async () => {
    setup(only('uncertain'));
    await userEvent.click(screen.getByText('表で見る'));
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['地区', '区', '未判定', '合計']);
    expect(Array.from(within(table).getAllByRole('row')[1]!.querySelectorAll('th, td')).map((c) => c.textContent)).toEqual(['アサヒ地区', '中央区', '2', '2']);
  });

  it('地区が 0 件なら、「表示できる地区がありません」だけを出す', () => {
    render(<AreaChartView areas={[]} filter={ALL_FILTER} onFilterChange={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('表示できる地区がありません');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});

describe('複数の地区（区など。areaIds）の条件', () => {
  // 北区（c）と中央区（b）だけが対象。東区（a）・南区（d）は対象外
  const ward = (over: Partial<MapFilter> = {}): MapFilter => ({ ...ALL_FILTER, areaIds: ['b', 'c'], scope: '中央区・北区', ...over });

  it('行を対象の地区だけにし、題の近くに「対象: {scope}」を出す。棒の幅は、出している行の最大に対する割合', () => {
    setup(ward());
    expect(rowButtons().map((r) => r.querySelector('.area-chart__name')?.textContent)).toEqual(['アサヒ地区（中央区）', 'ノース地区（北区）']);
    expect(screen.queryByRole('button', { name: /イースト地区/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /ゼロ地区/ })).not.toBeInTheDocument();
    const head = document.querySelector('.area-chart__head')!;
    expect(head).toHaveTextContent('対象: 中央区・北区');
    // 最大の合計は 10（アサヒ）。ノースの2018 年は未検出 5 は 50%
    expect(widths(rowButtons()[1]!)[0]).toEqual(['confirmed_new', 50]);
  });

  it('scope が無ければ「N 地区」。複数の地区の条件でなければ、対象の行は出さない', () => {
    const { unmount } = setup(ward({ scope: undefined }));
    expect(document.querySelector('.area-chart__head')).toHaveTextContent('対象: 2 地区');
    unmount();
    setup(ALL_FILTER);
    expect(document.querySelector('.area-chart__scope')).toBeNull();
  });

  it('表も、対象の地区だけ', async () => {
    setup(ward());
    await userEvent.click(screen.getByText('表で見る'));
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('row').slice(1).map((tr) => tr.querySelector('th')?.textContent)).toEqual(['アサヒ地区', 'ノース地区']);
  });

  it('行を押すと、複数の地区の条件（areaIds・scope）を消し、その 1 地区に絞る（分類の絞り込みは保つ）', async () => {
    const classes = new Set<CandidateClass>(['confirmed_new', 'uncertain']);
    const { onFilterChange } = setup(ward({ classes }));
    await userEvent.click(screen.getByRole('button', { name: /ノース地区/ }));
    const next = onFilterChange.mock.calls.at(-1)![0] as MapFilter;
    expect(next).toEqual({ areaId: 'c', classes });
    expect(next).not.toHaveProperty('areaIds');
    expect(next).not.toHaveProperty('scope');
  });

  it('凡例（分類）を切り替えても、複数の地区の条件は保つ', async () => {
    const { onFilterChange } = setup(ward());
    await userEvent.click(within(screen.getByRole('group', { name: /分類/ })).getByRole('button', { name: '未判定' }));
    const next = onFilterChange.mock.calls.at(-1)![0] as MapFilter;
    expect(next.areaIds).toEqual(['b', 'c']);
    expect(next.scope).toBe('中央区・北区');
    expect([...next.classes].sort()).toEqual(['confirmed_new', 'existing_omission']);
  });

  it('単一の地区を選んでいるときは、これまでどおり件数のある全行を出して、選んだ行に印を付ける（対象の行は出さない）', () => {
    setup({ ...ALL_FILTER, areaId: 'c' });
    expect(rowButtons()).toHaveLength(3);
    expect(document.querySelector('.area-chart__scope')).toBeNull();
  });
});

describe('見出し・ランドマーク・フォーカス', () => {
  it('グラフの題は h2（結果領域の中の詳細の題と同じ階層）。内側の region は題の名前で、外側の tabpanel（グラフ）と重ならない', () => {
    setup();
    expect(screen.getByRole('heading', { level: 2, name: '地区ごとの件数' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 3 })).not.toBeInTheDocument();
    const region = screen.getByRole('region', { name: '地区ごとの件数' });
    expect(region).toBe(document.querySelector('.area-chart'));
    expect(screen.queryByRole('region', { name: 'グラフ' })).not.toBeInTheDocument();
  });

  it('凡例の名前は、地図・集計の帯にも同じ分類が効くことを言う。地図の凡例（「表示する分類」）とは名前が重ならない', () => {
    setup();
    const legend = screen.getByRole('group', { name: /分類/ });
    expect(legend).toHaveAccessibleName(/地図・集計の帯/);
    expect(legend).not.toHaveAccessibleName(/表示する分類/);
  });

  it('地区が 0 件の空の状態は、枠自身がフォーカスを受ける（パネルにフォーカスできる中身が無いので）。中身があるときは付けない', () => {
    const { unmount } = render(<AreaChartView areas={[]} filter={ALL_FILTER} onFilterChange={vi.fn()} />);
    const empty = screen.getByRole('region', { name: '地区ごとの件数' });
    expect(empty).toHaveAttribute('tabindex', '0');
    expect(empty).toHaveTextContent('表示できる地区がありません');
    empty.focus();
    expect(empty).toHaveFocus();
    unmount();

    setup();
    expect(screen.getByRole('region', { name: '地区ごとの件数' })).not.toHaveAttribute('tabindex');
  });

  it('CSS: .area-chart は、フォーカスの輪（3px + 離れ 2px）が親の overflow で切れない余白（6px 以上）を持つ', () => {
    const css = readFileSync(join(process.cwd(), 'app', 'globals.css'), 'utf8');
    const block = /\n\.area-chart \{([^}]*)\}/.exec(css)?.[1] ?? '';
    const pad = /padding:\s*(\d+(?:\.\d+)?)px\s*;/.exec(block)?.[1];
    expect(Number(pad)).toBeGreaterThanOrEqual(6);
  });
});

describe('グラフの操作が地図とつながっていることの案内', () => {
  const view = (filter: MapFilter, onShowMap?: () => void) =>
    render(<AreaChartView areas={areas} filter={filter} onFilterChange={vi.fn()} onShowMap={onShowMap} />);

  it('見出しの説明は、数字と並びが「表示中の分類の合計」であることと、絞り込みが地図にも反映されることを、文字で言う', () => {
    view(ALL_FILTER);
    const hint = document.querySelector('.area-chart__hint')!;
    expect(hint).toHaveTextContent('表示中の分類の合計が多い順です');
    // 分類・地区の操作が地図にも効くことは、画面の文字で 1 回だけ言う（読み上げの名前にだけ書かない）
    expect(hint).toHaveTextContent('分類・地区の絞り込みは、地図と集計の帯にも反映されます');
    expect(document.querySelector('.area-chart__note')).toBeNull();
  });

  it('凡例の近くに、未判定の意味を 1 行で出す（「分類の意味」を開かなくても読める）。未判定をグラフから外したときは出さない', () => {
    const first = view(ALL_FILTER);
    const gloss = document.querySelector('.area-chart__gloss')!;
    expect(gloss).toHaveTextContent('未判定は、写真の端で切れているもの（端のため未判定）と、どちらとも言えないもの（要確認）です。目で確かめる候補です。');
    // チップの群れの直後
    expect(screen.getByRole('group', { name: /グラフに出す分類/ }).nextElementSibling).toBe(gloss);
    first.unmount();
    view(only('confirmed_new'));
    expect(document.querySelector('.area-chart__gloss')).toBeNull();
  });

  it('絞り込み中（地区・分類）で onShowMap があれば、「地図で見る」を出し、押すと呼ぶ', async () => {
    const onShowMap = vi.fn();
    view({ areaId: 'a', classes: ALL_FILTER.classes }, onShowMap);
    expect(document.querySelector('.area-chart__linked')).toHaveTextContent('地図にも反映されています');
    await userEvent.click(screen.getByRole('button', { name: '地図で見る' }));
    expect(onShowMap).toHaveBeenCalledTimes(1);
  });

  it('分類だけを絞っていても出す（地図の印も消えている）。何も絞っていないとき・onShowMap が無いときは出さない', () => {
    const shown = view(only('confirmed_new'), vi.fn());
    expect(screen.getByRole('button', { name: '地図で見る' })).toBeInTheDocument();
    shown.unmount();
    const all = view(ALL_FILTER, vi.fn());
    expect(screen.queryByRole('button', { name: '地図で見る' })).not.toBeInTheDocument();
    all.unmount();
    view({ areaId: 'a', classes: ALL_FILTER.classes });
    expect(screen.queryByRole('button', { name: '地図で見る' })).not.toBeInTheDocument();
  });
});
