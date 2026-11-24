import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CompareResult, CountResult, DetectionImageResult, ToolResult } from '../../lib/api-types';
import { AreasProvider } from '../../lib/areas-context';
import { ALL_RESULTS, accuracy, areas, compare, count, countWards, detectionImage, mapFocus, provenance, refusal, table } from '../../tests/fixtures';
import { filterFromResults, isWellFormedResult } from '../../lib/result-view';
import { AnswerScope, answerAreaHint, answerScope, type ScopeItem } from './AnswerScope';

const nameOf = (id: string) => (id === 'z18-1-2' ? 'テスト地区 01' : id);
const countWith = (filter: CountResult['filter']): CountResult => ({ ...count, filter });

describe('answerScope（結果の値から対象・条件を作る）', () => {
  it('count: 絞り込み条件の地区名（地区の一覧から）と分類の名前、写真の年', () => {
    const items = answerScope([countWith({ area_id: 'z18-1-2', cls: 'uncertain' })], nameOf);
    expect(items).toEqual([
      { key: 'area', label: '地区', text: 'テスト地区 01' },
      { key: 'class', label: '分類', text: '判定保留', cls: 'uncertain' },
      { key: 'years', label: '写真の年', text: '2018・2023 年' },
    ]);
  });

  it('count: 条件が空（全地区・全分類）なら、「すべて」と出す', () => {
    const items = answerScope([countWith({ area_id: null, cls: null })], nameOf);
    expect(items.slice(0, 2)).toEqual([
      { key: 'area', label: '地区', text: 'すべて' },
      { key: 'class', label: '分類', text: 'すべて' },
    ]);
  });

  it('count: 地区の一覧に無い ID は、その ID のまま出す（名前を作らない）', () => {
    const [area] = answerScope([countWith({ area_id: 'z18-9-9', cls: null })], nameOf);
    expect(area).toEqual({ key: 'area', label: '地区', text: 'z18-9-9' });
  });

  it('count: 知らない分類は、結果の値のまま出す', () => {
    const odd = countWith({ area_id: null, cls: 'mystery' as never });
    expect(answerScope([odd], nameOf)[1]).toEqual({ key: 'class', label: '分類', text: 'mystery' });
  });

  it('count: 複数の地区（area_ids）は、「すべて」ではなく API の scope をそのまま出す。scope が無ければ「N 地区」', () => {
    const [area, cls] = answerScope([countWards], nameOf);
    expect(area).toEqual({ key: 'area', label: '地区', text: '中央区' });
    expect(cls).toEqual({ key: 'class', label: '分類', text: 'すべて' });
    const noScope = answerScope([countWith({ area_ids: ['z18-1-2', 'z18-2-2', 'z18-3-3'], cls: 'uncertain' })], nameOf);
    expect(noScope[0]).toEqual({ key: 'area', label: '地区', text: '3 地区' });
    expect(noScope[1]).toEqual({ key: 'class', label: '分類', text: '判定保留', cls: 'uncertain' });
  });

  it('count が複数なら、地区・分類とも最後の件数の条件を出す', () => {
    const items = answerScope([countWith({ area_id: 'z18-1-2', cls: 'uncertain' }), countWards], nameOf);
    expect(items.slice(0, 2)).toEqual([
      { key: 'area', label: '地区', text: '中央区' },
      { key: 'class', label: '分類', text: 'すべて' },
    ]);
  });

  it('compare: 比べる地区の名前（結果の name）。重複は 1 つにする。地区の行は出すが、分類の行は出さない（比較は 3 分類と合計を並べる）', () => {
    const items = answerScope([compare, compare], nameOf);
    expect(items.find((i) => i.key === 'compare')).toEqual({ key: 'compare', label: '比べる地区', text: 'テスト地区 01、テスト地区 02' });
    expect(items.find((i) => i.key === 'area')).toEqual({ key: 'area', label: '地区', text: 'すべて' });
    expect(items.some((i) => i.key === 'class')).toBe(false);
  });

  describe('1 回答に count と compare が両方あるとき: 右の絞り込み（filterFromResults）と同じ「最後の条件」', () => {
    const narrow = countWith({ area_id: 'z18-1-2', cls: 'uncertain' });
    const byWard: CompareResult = { ...compare, filter: { area_ids: ['z18-1-2', 'z18-2-2'], scope: '中央区', cls: 'confirmed_new' } };
    const rows = (items: ScopeItem[]) => items.filter((i) => i.key === 'area' || i.key === 'class');

    it('count のあとに compare: compare の条件（地区だけ。分類の行は出さない）。先の count の地区・分類を出さない', () => {
      const items = answerScope([narrow, byWard], nameOf);
      expect(rows(items)).toEqual([{ key: 'area', label: '地区', text: '中央区' }]);
      // 右の絞り込みも、同じ（地区は比較の条件、分類はすべて）
      expect(filterFromResults([narrow, byWard])).toMatchObject({ areaIds: ['z18-1-2', 'z18-2-2'], scope: '中央区' });
    });

    it('compare のあとに count: count の条件（地区と分類）', () => {
      const items = answerScope([byWard, narrow], nameOf);
      expect(rows(items)).toEqual([
        { key: 'area', label: '地区', text: 'テスト地区 01' },
        { key: 'class', label: '分類', text: '判定保留', cls: 'uncertain' },
      ]);
      expect(filterFromResults([byWard, narrow])).toMatchObject({ areaId: 'z18-1-2' });
    });

    it('間に table などが挟まっても、最後の count・compare を採る。比べる地区の行は、compare があれば出す', () => {
      const items = answerScope([narrow, table, byWard, mapFocus], nameOf);
      expect(rows(items)).toEqual([{ key: 'area', label: '地区', text: '中央区' }]);
      expect(items.find((i) => i.key === 'compare')?.text).toBe('テスト地区 01、テスト地区 02');
    });

    it('壊れた filter の compare でも落ちない（地区は「すべて」）', () => {
      const odd = { ...compare, filter: 'x' } as unknown as CompareResult;
      expect(() => answerScope([narrow, odd], nameOf)).not.toThrow();
      expect(rows(answerScope([narrow, odd], nameOf))).toEqual([{ key: 'area', label: '地区', text: 'すべて' }]);
    });
  });

  it('壊れた count（filter が無い）は飛ばし、その前の compare の条件を採る。右の絞り込み（HomeClient）も同じ前処理（isWellFormedResult）で、同じ結果になる', () => {
    const byWard: CompareResult = { ...compare, filter: { area_ids: ['z18-1-2', 'z18-2-2'], scope: '中央区', cls: null } };
    const noFilter = { type: 'count', title: '壊れた件数', total: 1, provenance } as unknown as ToolResult;
    const items = answerScope([byWard, noFilter], nameOf);
    expect(items.find((i) => i.key === 'area')?.text).toBe('中央区');
    expect(items.some((i) => i.key === 'class')).toBe(false);
    expect(answerAreaHint([byWard, noFilter], 12)).toBe(answerAreaHint([byWard], 12));
    expect(filterFromResults([byWard, noFilter].filter(isWellFormedResult))).toMatchObject({ areaIds: ['z18-1-2', 'z18-2-2'], scope: '中央区' });
  });

  it('compare: 地区が多いときは、先頭の 3 つと残りの数にまとめる', () => {
    const many: CompareResult = {
      ...compare,
      items: Array.from({ length: 12 }, (_, i) => ({ area_id: `a${i}`, name: `地区${i + 1}`, counts: { total: i } })),
    };
    expect(answerScope([many], nameOf).find((i) => i.key === 'compare')?.text).toBe('地区1、地区2、地区3 ほか 9 地区');
  });

  it('compare: name が空なら、地区の一覧から名前を引く', () => {
    const noName: CompareResult = { ...compare, items: [{ area_id: 'z18-1-2', name: '', counts: { total: 1 } }] };
    expect(answerScope([noName], nameOf).find((i) => i.key === 'compare')?.text).toBe('テスト地区 01');
  });

  it('検出画像: 写真の年は images の year（昇順）。provenance の年は使わない', () => {
    const img: DetectionImageResult = {
      ...detectionImage,
      images: [
        { year: 2023, url: '/a' },
        { year: 2018, url: '/b' },
      ],
      provenance: { ...provenance, photo_years: [1999] },
    };
    expect(answerScope([img], nameOf)).toEqual([{ key: 'years', label: '写真の年', text: '2018・2023 年' }]);
  });

  it('年が 1 つだけでも、複数の結果にまたがっても、重複なく並べる', () => {
    const only2023 = countWith({ area_id: null, cls: null });
    only2023.provenance = { ...provenance, photo_years: [2023] };
    const items = answerScope([only2023, compare], nameOf);
    expect(items.find((i) => i.key === 'years')?.text).toBe('2018・2023 年');
    const single = answerScope([only2023], nameOf).find((i) => i.key === 'years');
    expect(single?.text).toBe('2023 年');
  });

  it('値の無い結果（表・地図の表示・精度・お断り）からは、何も作らない', () => {
    for (const r of [table, mapFocus, accuracy, refusal]) expect(answerScope([r], nameOf)).toEqual([]);
    expect(answerScope([], nameOf)).toEqual([]);
  });

  it('年の無い count・compare は、年の項目を出さない', () => {
    const noYears = countWith({ area_id: null, cls: 'confirmed_new' });
    noYears.provenance = { ...provenance, photo_years: [] };
    expect(answerScope([noYears], nameOf).some((i) => i.key === 'years')).toBe(false);
  });

  it('壊れた結果があっても例外にせず、読めるものだけで作る', () => {
    const broken = [
      null,
      'text',
      42,
      {},
      { type: 'count', title: '壊れた件数', total: 1, provenance },
      { type: 'compare', title: '壊れた比較', items: 'なし', provenance: null },
      { type: 'detection_image', images: [null, { year: 'x' }, { year: 2023 }] },
      countWith({ area_id: 'z18-1-2', cls: null }),
    ];
    expect(() => answerScope(broken, nameOf)).not.toThrow();
    const items = answerScope(broken, nameOf);
    expect(items.find((i) => i.key === 'area')?.text).toBe('テスト地区 01');
    expect(items.find((i) => i.key === 'years')?.text).toBe('2018・2023 年');
  });

  it('7 種類すべての例で、例外を出さない', () => {
    expect(() => answerScope(ALL_RESULTS, nameOf)).not.toThrow();
  });
});

describe('AnswerScope（回答の対象・条件の行）', () => {
  const renderScope = (results: ToolResult[]) =>
    render(
      <AreasProvider areas={areas}>
        <AnswerScope results={results} />
      </AreasProvider>,
    );

  it('項目ごとに、ラベルと値を出す。分類は印（形・線）つきの名前で出す', () => {
    renderScope([countWith({ area_id: 'z18-1-2', cls: 'confirmed_new' })]);
    const group = screen.getByRole('group', { name: 'この回答の対象・条件' });
    const term = (label: string) => within(group).getByText(label, { selector: 'dt' });
    expect(term('地区').nextElementSibling).toHaveTextContent('テスト地区 01');
    expect(term('分類').nextElementSibling).toHaveTextContent('新規出現（旧写真に無い）');
    expect(term('分類').nextElementSibling?.querySelector('svg')).not.toBeNull();
    expect(term('写真の年').nextElementSibling).toHaveTextContent('2018・2023 年');
  });

  it('地区の一覧が読み込めていなければ、ID のまま出す', () => {
    render(<AnswerScope results={[countWith({ area_id: 'z18-1-2', cls: null })]} />);
    expect(screen.getByText('z18-1-2')).toBeInTheDocument();
  });

  it('複数の地区の件数は、対象の「地区」に scope（区の名前）を出す', () => {
    renderScope([countWards]);
    const group = screen.getByRole('group', { name: 'この回答の対象・条件' });
    const area = within(group).getByText('地区', { selector: 'dt' }).nextElementSibling;
    expect(area).toHaveTextContent('中央区');
    expect(area).not.toHaveTextContent('すべて');
  });

  it('出せる値が無い結果・お断りには、何も出さない', () => {
    const { container } = renderScope([table, mapFocus, accuracy, refusal]);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
  });
});

describe('地区の範囲の説明（地区は 1 枚のタイル。丁目・区の全体ではない）', () => {
  const groupOf = (results: ToolResult[], withAreas = true) => {
    render(
      <AreasProvider areas={withAreas ? areas : []}>
        <AnswerScope results={results} />
      </AreasProvider>,
    );
    return screen.getByRole('group', { name: 'この回答の対象・条件' });
  };
  const areaValue = (group: HTMLElement) => within(group).getByText('地区', { selector: 'dt' }).nextElementSibling;

  it('複数の地区（区）: 区の名前のあとに、解析した地区の数と 1 地区の大きさを添える', () => {
    const group = groupOf([countWards]);
    expect(areaValue(group)).toHaveTextContent('中央区（解析した 2 地区・各約 130 m 四方）');
  });

  it('1 つの地区: 地区の名前のあとに、1 地区の大きさを添える', () => {
    const group = groupOf([countWith({ area_id: 'z18-1-2', cls: null })]);
    expect(areaValue(group)).toHaveTextContent('テスト地区 01（1 地区・約 130 m 四方）');
  });

  it('全地区: 「すべて」のあとに、解析した地区の数（地区の一覧から）を添える', () => {
    const group = groupOf([countWith({ area_id: null, cls: null })]);
    expect(areaValue(group)).toHaveTextContent('すべて（解析した全 1 地区・各約 130 m 四方）');
  });

  it('全地区: 地区の一覧が読めていなければ、数を作らず「すべて」だけ', () => {
    const group = groupOf([countWith({ area_id: null, cls: null })], false);
    expect(areaValue(group)).toHaveTextContent(/^すべて$/);
    expect(group.querySelector('.answer-scope__hint')).toBeNull();
  });

  it('説明は「地区」の行だけ。分類・写真の年の行には付けない', () => {
    const group = groupOf([countWith({ area_id: 'z18-1-2', cls: 'uncertain' })]);
    expect(group.querySelectorAll('.answer-scope__hint')).toHaveLength(1);
    expect(within(group).getByText('分類', { selector: 'dt' }).nextElementSibling).not.toHaveTextContent('130 m');
  });

  it('answerAreaHint: 地区の行と同じ条件（最後の件数・比較）から作る。件数も比較も無ければ null。壊れた結果でも落ちない', () => {
    const narrow = countWith({ area_id: 'z18-1-2', cls: 'uncertain' });
    expect(answerAreaHint([narrow, countWards], 12)).toBe('解析した 2 地区・各約 130 m 四方');
    expect(answerAreaHint([countWards, narrow], 12)).toBe('1 地区・約 130 m 四方');
    expect(answerAreaHint([table, mapFocus, accuracy, refusal], 12)).toBeNull();
    expect(answerAreaHint([null, 'x', {}, { type: 'count', title: '壊れた件数' }], 12)).toBeNull();
  });
});
