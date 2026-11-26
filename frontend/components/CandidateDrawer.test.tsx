import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

describe('候補の詳細（結果領域の「写真の比較」に埋め込む）', () => {
  it('2014・2024 の切り出し、分類の説明、根拠の数字、「地図で見る」を出す', async () => {
    fetchMock.mockResolvedValue(jsonResponse(detail));
    const onShowOnMap = vi.fn();
    render(<CandidateDrawer candidateId="c-1-2-1" onShowOnMap={onShowOnMap} />);

    const dialog = screen.getByRole('region', { name: '候補の詳細' });
    expect(await within(dialog).findAllByRole('img')).toHaveLength(2);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/candidates/c-1-2-1');
    expect(within(dialog).getByText('2014 年は未検出')).toBeInTheDocument();
    expect(within(dialog).getByText(/2014 年の写真のモデルが、この範囲に建物をほとんど見ていません/)).toBeInTheDocument();
    // 根拠の数字
    expect(within(dialog).getByText('0.912')).toBeInTheDocument();
    expect(within(dialog).getByText('3.1 %')).toBeInTheDocument();
    expect(within(dialog).getByText('いいえ')).toBeInTheDocument();
    expect(within(dialog).getByText(/閾値は未検証の初期値/)).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: '地図で見る' }));
    expect(onShowOnMap).toHaveBeenCalledWith(expect.objectContaining({ id: 'c-1-2-1' }));
  });

  it('開くと見出しにフォーカスが移り、外れると元の場所へ戻る', () => {
    fetchMock.mockResolvedValue(jsonResponse(detail));
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const { unmount } = render(<CandidateDrawer candidateId="c-1-2-1" onShowOnMap={() => {}} />);
    expect(screen.getByRole('heading', { name: '候補の詳細' })).toHaveFocus();
    unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it('閉じるボタンは持たず、Esc も止めない（閉じるのは、外の拡大ビューの ✕・Esc の 1 通り）', async () => {
    fetchMock.mockResolvedValue(jsonResponse(detail));
    const onKeyDown = vi.fn();
    render(
      <div onKeyDown={(e) => onKeyDown(e.key, e.defaultPrevented)}>
        <CandidateDrawer candidateId="c-1-2-1" onShowOnMap={() => {}} />
      </div>,
    );
    expect(screen.queryByRole('button', { name: '閉じる' })).not.toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(onKeyDown).toHaveBeenCalledWith('Escape', false);
  });

  describe('autoFocus={false}（チャットの回答から自動で開くとき。入力欄のフォーカスを奪わない）', () => {
    it('開いても、見出しへフォーカスを移さない（外にあったフォーカスはそのまま）', () => {
      fetchMock.mockResolvedValue(jsonResponse(detail));
      const input = document.createElement('input');
      document.body.append(input);
      input.focus();
      render(<CandidateDrawer candidateId="c-1-2-1" onShowOnMap={() => {}} autoFocus={false} />);
      expect(screen.getByRole('heading', { name: '候補の詳細' })).not.toHaveFocus();
      expect(input).toHaveFocus();
      input.remove();
    });

    it('autoFocus を省くか true なら、これまでどおり見出しへ移す', () => {
      fetchMock.mockResolvedValue(jsonResponse(detail));
      const { unmount } = render(<CandidateDrawer candidateId="c-1-2-1" onShowOnMap={() => {}} autoFocus />);
      expect(screen.getByRole('heading', { name: '候補の詳細' })).toHaveFocus();
      unmount();
    });

    it('外れて（外した・切り替えた）フォーカスが body に落ちても、元の場所へ戻さない（元の場所を覚えていない）', () => {
      fetchMock.mockResolvedValue(jsonResponse(detail));
      const opener = document.createElement('button');
      const other = document.createElement('button');
      document.body.append(opener, other);
      opener.focus(); // 開く前に、ここにフォーカスがあった
      const { unmount } = render(<CandidateDrawer candidateId="c-1-2-1" onShowOnMap={() => {}} autoFocus={false} />);
      other.focus(); // そのあと、利用者が別の所へ移り、
      other.remove(); // その要素が消えて、フォーカスが body に落ちた
      expect(document.activeElement).toBe(document.body);
      unmount();
      expect(opener).not.toHaveFocus(); // opener へ引き戻さない
      expect(document.activeElement).toBe(document.body);
      opener.remove();
    });

    it('autoFocus が true のときは、同じ手順（フォーカスが body に落ちた）で、外れると元の場所へ戻す（対照）', () => {
      fetchMock.mockResolvedValue(jsonResponse(detail));
      const opener = document.createElement('button');
      const other = document.createElement('button');
      document.body.append(opener, other);
      opener.focus();
      const { unmount } = render(<CandidateDrawer candidateId="c-1-2-1" onShowOnMap={() => {}} />);
      other.focus();
      other.remove();
      expect(document.activeElement).toBe(document.body);
      unmount();
      expect(opener).toHaveFocus();
      opener.remove();
    });

    it('autoFocus が true でも、外れるとき、フォーカスが別の所にあるなら、元の場所へ引き戻さない（いまのフォーカスを奪わない）', () => {
      fetchMock.mockResolvedValue(jsonResponse(detail));
      const opener = document.createElement('button');
      const other = document.createElement('button');
      document.body.append(opener, other);
      opener.focus();
      const { unmount } = render(<CandidateDrawer candidateId="c-1-2-1" onShowOnMap={() => {}} />);
      other.focus(); // 見えない間に、利用者が別の所（地図の印・チャットの入力欄など）へ移った
      unmount();
      expect(other).toHaveFocus();
      opener.remove();
      other.remove();
    });

    it('あとから autoFocus が変わっても、フォーカスを動かさない（開いた時点の指定だけを使う）', () => {
      fetchMock.mockResolvedValue(jsonResponse(detail));
      const outside = document.createElement('input');
      document.body.append(outside);
      outside.focus();
      const { rerender } = render(<CandidateDrawer candidateId="c-1-2-1" onShowOnMap={() => {}} autoFocus={false} />);
      rerender(<CandidateDrawer candidateId="c-1-2-1" onShowOnMap={() => {}} autoFocus />);
      expect(outside).toHaveFocus();
      outside.remove();
    });

    it('読み込み中（role=status）・見つからない（role=alert）・通信エラー（再試行）の通知は、変わらず出る', async () => {
      let resolve!: (r: Response) => void;
      fetchMock.mockReturnValueOnce(new Promise<Response>((r) => (resolve = r)));
      const first = render(<CandidateDrawer candidateId="c-1-2-1" onShowOnMap={() => {}} autoFocus={false} />);
      expect(screen.getByRole('status')).toHaveTextContent('読み込んでいます');
      resolve(jsonResponse({ error: { code: 'not_found', message: '候補が見つかりません。' } }, 404));
      expect(await screen.findByRole('alert')).toHaveTextContent('c-1-2-1 は見つかりませんでした');
      first.unmount();

      fetchMock.mockRejectedValueOnce(new TypeError('x')).mockResolvedValueOnce(jsonResponse(detail));
      render(<CandidateDrawer candidateId="c-1-2-1" onShowOnMap={() => {}} autoFocus={false} />);
      await userEvent.click(await screen.findByRole('button', { name: '再試行' }));
      await waitFor(() => expect(screen.getByText('どう判定したか')).toBeInTheDocument());
      expect(screen.getByRole('heading', { name: '候補の詳細' })).not.toHaveFocus();
    });
  });

  describe('focusNonce（同じ詳細が開いているときに、もう一度「開く」を押した合図）', () => {
    const open = (nonce: number | undefined, autoFocus?: boolean) => (
      <CandidateDrawer candidateId="c-1-2-1" autoFocus={autoFocus} focusNonce={nonce} onShowOnMap={() => {}} />
    );

    it('増えると、見出しへフォーカスを移す。マウントしたときの値と、同じ値のままの再描画では移さない', () => {
      fetchMock.mockResolvedValue(jsonResponse(detail));
      const outside = document.createElement('input');
      document.body.append(outside);
      outside.focus();
      const { rerender } = render(open(3, false));
      expect(outside).toHaveFocus(); // マウントしたときの値（3）は、合図に数えない
      rerender(open(3, false));
      expect(outside).toHaveFocus();
      rerender(open(4, false));
      expect(screen.getByRole('heading', { name: '候補の詳細' })).toHaveFocus();
      outside.remove();
    });

    it('合図で移したあと、外れると、押したボタン（合図の前にフォーカスがあった所）へ戻る', () => {
      fetchMock.mockResolvedValue(jsonResponse(detail));
      const button = document.createElement('button');
      document.body.append(button);
      const { rerender, unmount } = render(open(0, false));
      button.focus(); // ユーザーが押した「開く」ボタン
      rerender(open(1, false));
      expect(screen.getByRole('heading', { name: '候補の詳細' })).toHaveFocus();
      unmount();
      expect(button).toHaveFocus();
      button.remove();
    });

    it('フォーカスがすでに詳細の中にあるときの合図は、戻し先を詳細の中の要素にしない', async () => {
      fetchMock.mockResolvedValue(jsonResponse(detail));
      const button = document.createElement('button');
      document.body.append(button);
      button.focus();
      const { rerender, unmount } = render(open(0)); // 開いたとき、button が戻し先
      await screen.findByRole('button', { name: '地図で見る' });
      screen.getByRole('button', { name: '地図で見る' }).focus();
      rerender(open(1));
      unmount();
      expect(button).toHaveFocus();
      button.remove();
    });
  });

  it('読み込み中の表示 → 詳細', async () => {
    let resolve!: (r: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((r) => (resolve = r)));
    render(<CandidateDrawer candidateId="c-1-2-1" onShowOnMap={() => {}} />);
    expect(screen.getByRole('status')).toHaveTextContent('読み込んでいます');
    resolve(jsonResponse(detail));
    expect(await screen.findByText('どう判定したか')).toBeInTheDocument();
  });

  it('404 は「見つかりませんでした」（再試行は出さない）', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'not_found', message: '候補が見つかりません。' } }, 404));
    render(<CandidateDrawer candidateId="c-9-9-9" onShowOnMap={() => {}} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('c-9-9-9 は見つかりませんでした');
    expect(screen.queryByRole('button', { name: '再試行' })).not.toBeInTheDocument();
  });

  it('通信エラーは再試行できる', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('x')).mockResolvedValueOnce(jsonResponse(detail));
    render(<CandidateDrawer candidateId="c-1-2-1" onShowOnMap={() => {}} />);
    await userEvent.click(await screen.findByRole('button', { name: '再試行' }));
    await waitFor(() => expect(screen.getByText('どう判定したか')).toBeInTheDocument());
  });

  it('画像の一覧が無い応答でも、候補 ID から画像の URL を作る', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ...detail, images: undefined }));
    render(<CandidateDrawer candidateId="c-1-2-1" onShowOnMap={() => {}} />);
    const imgs = await screen.findAllByRole('img');
    expect(imgs.map((i) => i.getAttribute('src'))).toEqual([
      '/api/candidates/c-1-2-1/image?year=2014&size=512',
      '/api/candidates/c-1-2-1/image?year=2024&size=512',
    ]);
  });

  it('地図に重なる表示ではない（fixed・幕・影・z-index のクラスや規則を持たない）。流れの中の部品として、親の枠に収まる', () => {
    fetchMock.mockResolvedValue(jsonResponse(detail));
    render(<CandidateDrawer candidateId="c-1-2-1" onShowOnMap={() => {}} />);
    const root = screen.getByRole('region', { name: '候補の詳細' });
    expect(root.className).toBe('drawer');
    expect(root.style.position).toBe('');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    // CSS はテストでは読み込まれないので、規則そのものを確かめる（`.drawer { … }` の本体）
    const css = readFileSync(join(process.cwd(), 'app', 'globals.css'), 'utf8');
    const bodies = [...css.matchAll(/(?:^|\})\s*\.drawer\s*\{([^}]*)\}/g)].map((m) => m[1] ?? '');
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body).not.toMatch(/position\s*:\s*(fixed|absolute|sticky)/);
      expect(body).not.toMatch(/z-index/);
      expect(body).not.toMatch(/box-shadow/);
    }
  });
});
