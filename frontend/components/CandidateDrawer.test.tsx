import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detail, jsonResponse } from '../tests/fixtures';
import { CandidateDrawer } from './CandidateDrawer';

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('詳細ドロワー', () => {
  it('2018・2023 の切り出し、分類の説明、根拠の数字、「地図で見る」を出す', async () => {
    fetchMock.mockResolvedValue(jsonResponse(detail));
    const onShowOnMap = vi.fn();
    render(<CandidateDrawer candidateId="c-1-2-1" onClose={() => {}} onShowOnMap={onShowOnMap} />);

    const dialog = screen.getByRole('dialog', { name: '候補の詳細' });
    expect(await within(dialog).findAllByRole('img')).toHaveLength(2);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/candidates/c-1-2-1');
    expect(within(dialog).getByText('新規出現（旧写真に無い）')).toBeInTheDocument();
    expect(within(dialog).getByText(/2018 年の写真のモデルが、この範囲に建物をほとんど見ていません/)).toBeInTheDocument();
    // 根拠の数字
    expect(within(dialog).getByText('0.912')).toBeInTheDocument();
    expect(within(dialog).getByText('3.1 %')).toBeInTheDocument();
    expect(within(dialog).getByText('いいえ')).toBeInTheDocument();
    expect(within(dialog).getByText(/閾値は未検証の初期値/)).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: '地図で見る' }));
    expect(onShowOnMap).toHaveBeenCalledWith(expect.objectContaining({ id: 'c-1-2-1' }));
  });

  it('開くと見出しにフォーカスが移り、Esc で閉じ、閉じると元の場所へ戻る', async () => {
    fetchMock.mockResolvedValue(jsonResponse(detail));
    const onClose = vi.fn();
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const { unmount } = render(<CandidateDrawer candidateId="c-1-2-1" onClose={onClose} onShowOnMap={() => {}} />);
    expect(screen.getByRole('heading', { name: '候補の詳細' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
    unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it('読み込み中の表示 → 詳細', async () => {
    let resolve!: (r: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((r) => (resolve = r)));
    render(<CandidateDrawer candidateId="c-1-2-1" onClose={() => {}} onShowOnMap={() => {}} />);
    expect(screen.getByRole('status')).toHaveTextContent('読み込んでいます');
    resolve(jsonResponse(detail));
    expect(await screen.findByText('どう判定したか')).toBeInTheDocument();
  });

  it('404 は「見つかりませんでした」（再試行は出さない）', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'not_found', message: '候補が見つかりません。' } }, 404));
    render(<CandidateDrawer candidateId="c-9-9-9" onClose={() => {}} onShowOnMap={() => {}} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('c-9-9-9 は見つかりませんでした');
    expect(screen.queryByRole('button', { name: '再試行' })).not.toBeInTheDocument();
  });

  it('通信エラーは再試行できる', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('x')).mockResolvedValueOnce(jsonResponse(detail));
    render(<CandidateDrawer candidateId="c-1-2-1" onClose={() => {}} onShowOnMap={() => {}} />);
    await userEvent.click(await screen.findByRole('button', { name: '再試行' }));
    await waitFor(() => expect(screen.getByText('どう判定したか')).toBeInTheDocument());
  });

  it('画像の一覧が無い応答でも、候補 ID から画像の URL を作る', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ...detail, images: undefined }));
    render(<CandidateDrawer candidateId="c-1-2-1" onClose={() => {}} onShowOnMap={() => {}} />);
    const imgs = await screen.findAllByRole('img');
    expect(imgs.map((i) => i.getAttribute('src'))).toEqual([
      '/api/candidates/c-1-2-1/image?year=2018&size=512',
      '/api/candidates/c-1-2-1/image?year=2023&size=512',
    ]);
  });
});
