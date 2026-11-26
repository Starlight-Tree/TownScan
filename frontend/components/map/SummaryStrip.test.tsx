import { cleanup, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AreaSummary, CandidateClass } from '../../lib/api-types';
import { ALL_FILTER, type MapFilter } from '../../lib/result-view';
import { SummaryStrip } from './SummaryStrip';

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

const areas = [area('a', 'アサヒ地区', [4, 4, 2]), area('b', 'ノース地区', [5, 3, 1]), area('c', 'ミナミ地区', [1200, 0, 0])];

const strip = () => screen.getByRole('group', { name: '件数の集計' });
/** 「2018 年は未検出 5」のように、分類ごとの数字を読む */
const countOf = (label: string) => within(strip()).getByText(label).closest('li')!.querySelector('strong')!.textContent;

function setup(filter: MapFilter = ALL_FILTER, list: AreaSummary[] = areas) {
  const onFilterChange = vi.fn();
  render(<SummaryStrip areas={list} filter={filter} onFilterChange={onFilterChange} />);
  return { onFilterChange };
}

describe('集計の帯', () => {
  it('絞り込みが無いとき: 対象は「全 N 地区」（地区数は一覧から数える）。3 分類の件数は全地区の合計。解除のボタンは出さない', () => {
    setup();
    expect(strip()).toHaveTextContent('対象全 3 地区');
    expect(countOf('2018 年は未検出')).toBe('1,209');
    expect(countOf('2018 年も検出')).toBe('7');
    expect(countOf('未判定')).toBe('3');
    expect(within(strip()).queryByText(/表示中/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '条件を解除' })).not.toBeInTheDocument();
  });

  it('地区の数を固定しない（一覧が 1 地区なら「全 1 地区」）', () => {
    setup(ALL_FILTER, [areas[0]!]);
    expect(strip()).toHaveTextContent('全 1 地区');
  });

  it('地区を選んでいるとき: 対象は地区の名前、件数はその地区だけ。「条件を解除」で ALL_FILTER に戻す', async () => {
    const { onFilterChange } = setup({ ...ALL_FILTER, areaId: 'b' });
    expect(strip()).toHaveTextContent('対象ノース地区');
    expect(strip()).not.toHaveTextContent('全 3 地区');
    expect(countOf('2018 年は未検出')).toBe('5');
    expect(countOf('2018 年も検出')).toBe('3');
    expect(countOf('未判定')).toBe('1');
    await userEvent.click(screen.getByRole('button', { name: '条件を解除' }));
    expect(onFilterChange).toHaveBeenCalledWith(ALL_FILTER);
  });

  it('分類の一部だけを表示しているとき: 3 分類の数字は全体のまま、「全 m 件のうち、表示中 n 件」を足す。外した分類は（非表示）', async () => {
    const classes = new Set<CandidateClass>(['confirmed_new', 'uncertain']);
    const { onFilterChange } = setup({ areaId: '', classes });
    // 全体: 1209+7+3=1219 件のうち、表示中は 1209+3=1212 件
    expect(strip()).toHaveTextContent('全 1,219 件のうち、表示中 1,212 件');
    expect(countOf('2018 年も検出')).toBe('7');
    const omit = within(strip()).getByText('2018 年も検出').closest('li')!;
    expect(omit).toHaveTextContent('（非表示）');
    expect(omit).toHaveAttribute('data-shown', 'false');
    expect(within(strip()).getByText('2018 年は未検出').closest('li')).not.toHaveTextContent('非表示');
    await userEvent.click(screen.getByRole('button', { name: '条件を解除' }));
    expect(onFilterChange).toHaveBeenCalledWith(ALL_FILTER);
  });

  it('地区と分類の両方を絞っているとき: 全体はその地区の件数', () => {
    setup({ areaId: 'a', classes: new Set<CandidateClass>(['existing_omission']) });
    expect(strip()).toHaveTextContent('対象アサヒ地区');
    expect(strip()).toHaveTextContent('全 10 件のうち、表示中 4 件');
  });

  it('一覧に無い地区の条件・地区の一覧が空のときは、数字を作らず「—」を出す', () => {
    setup({ ...ALL_FILTER, areaId: 'zzz' });
    expect(strip()).toHaveTextContent('対象zzz');
    expect(countOf('2018 年は未検出')).toBe('—');
  });

  it('地区の一覧が空（未着）のとき', () => {
    setup(ALL_FILTER, []);
    expect(strip()).toHaveTextContent('地区の情報がありません');
    expect(countOf('未判定')).toBe('—');
    expect(within(strip()).queryByText(/全 0 地区/)).not.toBeInTheDocument();
  });

  it('分類の印（色・線・形）を、数字のそばに付ける', () => {
    setup();
    expect(strip().querySelectorAll('svg.class-swatch')).toHaveLength(3);
  });
});

describe('分類の件数は、そのまま表示の切り替え（チェックボックス）', () => {
  const group = () => within(strip()).getByRole('group', { name: '表示する分類（色・線・形で区別）' });

  it('role=group「表示する分類（色・線・形で区別）」の中に、分類ごとのチェックボックス。名前は分類の全文と件数（見える文字を含む）', () => {
    setup();
    const boxes = within(group()).getAllByRole('checkbox');
    expect(boxes.map((b) => b.getAttribute('aria-label'))).toEqual([
      '2018 年は未検出、1,209 件',
      '2018 年も検出、7 件',
      '未判定、3 件',
    ]);
    expect(boxes.every((b) => (b as HTMLInputElement).checked)).toBe(true);
    // ふつうの幅で 1 行に並べるため、対象・分類・解除は、同じ帯の直下の子
    expect(strip().querySelector('.summary-strip__target')).not.toBeNull();
  });

  it('一覧に無い地区・地区が空のとき、件数の名前は「件数不明」（数字を作らない）', () => {
    setup({ ...ALL_FILTER, areaId: 'zzz' });
    expect(within(group()).getByRole('checkbox', { name: '未判定、件数不明' })).toBeInTheDocument();
  });

  it('押すと、その分類だけを切り替えて onFilterChange へ渡す（元の集合を書き換えない）', async () => {
    const classes = new Set<CandidateClass>(['confirmed_new', 'existing_omission', 'uncertain']);
    const { onFilterChange } = setup({ areaId: '', classes });
    await userEvent.click(within(group()).getByRole('checkbox', { name: /未判定/ }));
    const off = onFilterChange.mock.calls.at(-1)![0] as MapFilter;
    expect([...off.classes].sort()).toEqual(['confirmed_new', 'existing_omission']);
    expect(classes.size).toBe(3);
    // 外れているものを押すと、足される
    cleanup();
    const second = setup({ areaId: '', classes: new Set<CandidateClass>(['confirmed_new']) });
    await userEvent.click(within(group()).getByRole('checkbox', { name: /未判定/ }));
    const on = second.onFilterChange.mock.calls.at(-1)![0] as MapFilter;
    expect([...on.classes].sort()).toEqual(['confirmed_new', 'uncertain']);
  });

  it('地区（areaId）・複数の地区（areaIds・scope）の条件は、切り替えても保つ', async () => {
    const wardFilter: MapFilter = { areaId: '', areaIds: ['a', 'b'], scope: '中央区', classes: new Set<CandidateClass>(['confirmed_new', 'uncertain']) };
    const { onFilterChange } = setup(wardFilter);
    await userEvent.click(within(group()).getByRole('checkbox', { name: /2018 年は未検出/ }));
    const next = onFilterChange.mock.calls.at(-1)![0] as MapFilter;
    expect(next.areaIds).toEqual(['a', 'b']);
    expect(next.scope).toBe('中央区');
    expect(next.areaId).toBe('');
    expect([...next.classes]).toEqual(['uncertain']);

    cleanup();
    const single = setup({ areaId: 'b', classes: new Set<CandidateClass>(['confirmed_new']) });
    await userEvent.click(within(group()).getByRole('checkbox', { name: /2018 年も検出/ }));
    expect((single.onFilterChange.mock.calls.at(-1)![0] as MapFilter).areaId).toBe('b');
  });

  it('キーボードで操作できる（Tab で届き、Space で切り替わる）。押してもフォーカスは動かない', async () => {
    const { onFilterChange } = setup();
    const box = within(group()).getByRole('checkbox', { name: /2018 年は未検出/ });
    box.focus();
    await userEvent.keyboard(' ');
    expect(onFilterChange).toHaveBeenCalledTimes(1);
    expect(box).toHaveFocus();
  });

  it('外した分類は（非表示）。表示中の分類にはつけない。チェックと data-shown が状態を持つ', () => {
    setup({ areaId: '', classes: new Set<CandidateClass>(['confirmed_new', 'uncertain']) });
    const items = Array.from(group().querySelectorAll('li'));
    expect(items.map((li) => li.getAttribute('data-shown'))).toEqual(['true', 'false', 'true']);
    expect(items.map((li) => li.textContent?.includes('（非表示）'))).toEqual([false, true, false]);
    expect(within(group()).getByRole('checkbox', { name: /2018 年も検出/ })).not.toBeChecked();
  });
});

describe('複数の地区（区など。areaIds）の条件', () => {
  const ward = (over: Partial<MapFilter> = {}): MapFilter => ({ ...ALL_FILTER, areaIds: ['a', 'b'], scope: '中央区', ...over });

  it('対象は API の表示用の名前（scope）。「全 N 地区」とは言わない。3 分類の数字は、対象の地区の和', () => {
    setup(ward());
    expect(strip()).toHaveTextContent('対象中央区');
    expect(strip()).not.toHaveTextContent('全 3 地区');
    expect(countOf('2018 年は未検出')).toBe('9'); // 4 + 5（ミナミ地区の 1,200 は入らない）
    expect(countOf('2018 年も検出')).toBe('7');
    expect(countOf('未判定')).toBe('3');
  });

  it('scope が無ければ、名前を作らず「N 地区」と言う', () => {
    setup(ward({ scope: undefined }));
    expect(strip()).toHaveTextContent('対象2 地区');
    expect(countOf('2018 年は未検出')).toBe('9');
  });

  it('分類の一部だけを表示しているとき: 「全 m 件のうち、表示中 n 件」も、対象の地区の和', () => {
    setup(ward({ classes: new Set<CandidateClass>(['uncertain']) }));
    expect(strip()).toHaveTextContent('全 19 件のうち、表示中 3 件');
  });

  it('対象の地区が一覧に 1 つでも無ければ、足りない和を出さず「—」', () => {
    setup(ward({ areaIds: ['a', 'zzz'] }));
    expect(strip()).toHaveTextContent('対象中央区');
    expect(countOf('2018 年は未検出')).toBe('—');
  });

  it('「条件を解除」を出し、押すと ALL_FILTER（areaIds・scope も消える）に戻す', async () => {
    const { onFilterChange } = setup(ward());
    await userEvent.click(screen.getByRole('button', { name: '条件を解除' }));
    expect(onFilterChange).toHaveBeenCalledWith(ALL_FILTER);
    expect(onFilterChange.mock.calls[0]![0]).not.toHaveProperty('areaIds');
  });
});

describe('「条件を解除」とフォーカス', () => {
  // 親が絞り込みを持ち、解除で本当にボタンが消える（実際の画面と同じ）状況で確かめる
  function Harness() {
    const [filter, setFilter] = useState<MapFilter>({ ...ALL_FILTER, areaId: 'b' });
    return <SummaryStrip areas={areas} filter={filter} onFilterChange={setFilter} />;
  }

  it('押してボタンが消えても、フォーカスは <body> へ落ちず、帯の見出し（対象）へ移る', async () => {
    render(<Harness />);
    const reset = screen.getByRole('button', { name: '条件を解除' });
    reset.focus();
    expect(reset).toHaveFocus();
    await userEvent.click(reset);
    expect(screen.queryByRole('button', { name: '条件を解除' })).not.toBeInTheDocument();
    expect(strip()).toHaveTextContent('対象全 3 地区');
    expect(document.body).not.toHaveFocus();
    const target = strip().querySelector<HTMLElement>('.summary-strip__target')!;
    expect(target).toHaveFocus();
    // Tab の順には入らず、スクリプトからだけフォーカスできる
    expect(target).toHaveAttribute('tabindex', '-1');
  });

  it('キーボード（Enter）で解除しても、同じ', async () => {
    render(<Harness />);
    screen.getByRole('button', { name: '条件を解除' }).focus();
    await userEvent.keyboard('{Enter}');
    expect(strip().querySelector('.summary-strip__target')).toHaveFocus();
  });
});

describe('帯の高さが動かない（「全 m 件のうち…」と「条件を解除」は、出ないときも場所を取る）', () => {
  const scope = () => strip().querySelector<HTMLElement>('.summary-strip__scope')!;
  const reset = () => strip().querySelector<HTMLElement>('.summary-strip__reset')!;

  it('絞り込みが無いときも、2 つの要素は描いてある。hidden で、読み上げにもフォーカスにも出ない（文は空）', () => {
    setup();
    expect(scope()).toHaveAttribute('hidden');
    expect(scope()).toBeEmptyDOMElement();
    expect(reset()).toHaveAttribute('hidden');
    expect(screen.queryByRole('button', { name: '条件を解除' })).not.toBeInTheDocument();
    expect(within(strip()).queryByText(/表示中/)).not.toBeInTheDocument();
  });

  it('2 つの要素は、「対象」と同じ先頭の行（.summary-strip__head）にあり、分類の件数（チェックボックス）より前。Tab の順も見た目の順', () => {
    setup({ ...ALL_FILTER, areaId: 'b' });
    const head = strip().querySelector('.summary-strip__head')!;
    expect(Array.from(head.children).map((c) => c.className.split(' ').find((n) => n.startsWith('summary-strip__')))).toEqual([
      'summary-strip__target',
      'summary-strip__scope',
      'summary-strip__reset',
    ]);
    const counts = within(strip()).getByRole('group', { name: /表示する分類/ });
    expect(head.compareDocumentPosition(counts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(head).not.toContainElement(counts);
  });

  it('分類を外す・地区を選ぶ・解除で、同じ要素の hidden と文が替わる。要素は増えも減りもしない（帯の行の数が変わらない）', () => {
    const all = new Set<CandidateClass>(['confirmed_new', 'existing_omission', 'uncertain']);
    const onFilterChange = vi.fn();
    const view = (filter: MapFilter) => <SummaryStrip areas={areas} filter={filter} onFilterChange={onFilterChange} />;
    const { rerender } = render(view({ areaId: '', classes: all }));
    const [s0, r0] = [scope(), reset()];

    rerender(view({ areaId: '', classes: new Set<CandidateClass>(['confirmed_new', 'uncertain']) })); // 分類を 1 つ外す
    expect(scope()).toBe(s0);
    expect(reset()).toBe(r0);
    expect(s0).not.toHaveAttribute('hidden');
    expect(s0).toHaveTextContent('全 1,219 件のうち、表示中 1,212 件');
    expect(r0).not.toHaveAttribute('hidden');
    expect(screen.getByRole('button', { name: '条件を解除' })).toBe(r0);

    rerender(view({ areaId: 'b', classes: all })); // 地区だけを選ぶ（分類は全部）: 解除は出て、「全 m 件のうち…」は出ない
    expect(scope()).toBe(s0);
    expect(s0).toHaveAttribute('hidden');
    expect(s0).toBeEmptyDOMElement();
    expect(r0).not.toHaveAttribute('hidden');

    rerender(view({ areaId: '', classes: all })); // 解除
    expect(reset()).toBe(r0);
    expect(r0).toHaveAttribute('hidden');
  });

  it('対象の地区の件数が分からないとき（一覧が届く前）は、「全 m 件のうち…」を出さない（数字を作らない）。場所は保つ', () => {
    setup({ areaId: 'zzz', classes: new Set<CandidateClass>(['uncertain']) });
    expect(scope()).toHaveAttribute('hidden');
    expect(scope()).toBeEmptyDOMElement();
  });
});
