import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CandidateSummary } from '../../lib/api-types';
import { CandidateList } from './CandidateList';

const api = vi.hoisted(() => ({ getCandidates: vi.fn() }));
vi.mock('../../lib/api', () => ({ getCandidates: api.getCandidates }));

function item(id: string, cls: CandidateSummary['class'], area_m2: number): CandidateSummary {
  return { id, area_id: 'a', class: cls, area_m2, bbox: [130.7, 32.8, 130.701, 32.801], centroid: [130.7005, 32.8005], area_name: 'アサヒ地区' };
}

beforeEach(() => {
  api.getCandidates.mockReset();
  api.getCandidates.mockResolvedValue({ total: 2, items: [item('c-1', 'confirmed_new', 120), item('c-2', 'uncertain', 80)] });
});

const heading = () => screen.getByText('候補を一覧で見る（面積の大きい順）');

describe('候補の一覧', () => {
  it('見出しの近くに、「分類が 1 つのときだけ、一覧も絞り込みます」と書く（API が分類を 1 つしか受けないため）。閉じていても、開いても同じ', async () => {
    render(<CandidateList areaId={null} cls={null} onSelect={vi.fn()} />);
    const details = heading().closest('details')!;
    expect(details).toHaveTextContent('分類が 1 つのときだけ、一覧も絞り込みます。');
    // 見出し（summary）のすぐ次に置く
    expect(heading().nextElementSibling).toHaveTextContent('分類が 1 つのときだけ');
    await userEvent.click(heading());
    expect(details).toHaveTextContent('分類が 1 つのときだけ、一覧も絞り込みます。');
  });

  it('閉じているあいだは、読み込まない。開くと、地区・分類の条件で取りに行き、返された順（API が面積の大きい順に返す）に並べる', async () => {
    render(<CandidateList areaId="a" cls="uncertain" onSelect={vi.fn()} />);
    expect(api.getCandidates).not.toHaveBeenCalled();
    await userEvent.click(heading());
    await waitFor(() => expect(screen.getByRole('list')).toBeInTheDocument());
    expect(api.getCandidates).toHaveBeenCalledWith({ area_id: 'a', cls: 'uncertain', limit: 30 }, expect.anything());
    const rows = within(screen.getByRole('list')).getAllByRole('button');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('新規出現');
    expect(rows[0]).toHaveTextContent('120 m²');
  });

  it('行を押すと、その候補の ID で onSelect を呼ぶ', async () => {
    const onSelect = vi.fn();
    render(<CandidateList areaId={null} cls={null} onSelect={onSelect} />);
    await userEvent.click(heading());
    await userEvent.click(await screen.findByRole('button', { name: /c-2/ }));
    expect(onSelect).toHaveBeenCalledWith('c-2');
  });

  it('開いたあとで分類（cls）が変わったら、新しい分類で取り直す。同じ分類のままなら、取り直さない', async () => {
    const { rerender } = render(<CandidateList areaId="a" cls={null} onSelect={vi.fn()} />);
    await userEvent.click(heading());
    await waitFor(() => expect(screen.getByRole('list')).toBeInTheDocument());
    expect(api.getCandidates).toHaveBeenCalledTimes(1);
    expect(api.getCandidates).toHaveBeenLastCalledWith({ area_id: 'a', cls: null, limit: 30 }, expect.anything());

    rerender(<CandidateList areaId="a" cls="uncertain" onSelect={vi.fn()} />);
    await waitFor(() => expect(api.getCandidates).toHaveBeenCalledTimes(2));
    expect(api.getCandidates).toHaveBeenLastCalledWith({ area_id: 'a', cls: 'uncertain', limit: 30 }, expect.anything());

    rerender(<CandidateList areaId="a" cls="uncertain" onSelect={vi.fn()} />);
    rerender(<CandidateList areaId="a" cls={null} onSelect={vi.fn()} />);
    await waitFor(() => expect(api.getCandidates).toHaveBeenCalledTimes(3));
    expect(api.getCandidates).toHaveBeenLastCalledWith({ area_id: 'a', cls: null, limit: 30 }, expect.anything());
  });

  it('対象が複数の地区（multiArea）のときは、取りに行かず、「地区を 1 つに絞ると、一覧が出ます」と言う', async () => {
    render(<CandidateList areaId={null} multiArea cls={null} onSelect={vi.fn()} />);
    await userEvent.click(heading());
    expect(heading().closest('details')).toHaveTextContent('地区を 1 つに絞ると、一覧が出ます。');
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(api.getCandidates).not.toHaveBeenCalled();
  });

  it('1 つの地区に絞ったら、一覧が出る（multiArea が外れる）', async () => {
    const { rerender } = render(<CandidateList areaId={null} multiArea cls={null} onSelect={vi.fn()} />);
    await userEvent.click(heading());
    expect(api.getCandidates).not.toHaveBeenCalled();
    rerender(<CandidateList areaId="a" cls={null} onSelect={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('list')).toBeInTheDocument());
    expect(api.getCandidates).toHaveBeenCalledWith({ area_id: 'a', cls: null, limit: 30 }, expect.anything());
  });
});
