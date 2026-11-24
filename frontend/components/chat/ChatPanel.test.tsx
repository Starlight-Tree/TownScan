import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatResponse } from '../../lib/api-types';
import { count, jsonResponse, mapFocus, refusal } from '../../tests/fixtures';
import { ChatPanel, SUGGESTIONS } from './ChatPanel';

const reply = (content: string, results: ChatResponse['message']['results'] = []): ChatResponse => ({
  message: { role: 'assistant', content, results, tool_calls: [{ name: 'count_candidates', args: { cls: null } }] },
});

const fetchMock = vi.fn<typeof fetch>();

function setup() {
  const actions = { openCandidate: vi.fn(), focusMap: vi.fn() };
  render(<ChatPanel actions={actions} />);
  return { actions, input: () => screen.getByRole('textbox', { name: '質問を入力' }), send: () => screen.getByRole('button', { name: '送信' }) };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('チャット', () => {
  it('はじめは説明とサジェストを出し、送信ボタンは入力があるまで押せない', () => {
    const { send } = setup();
    expect(screen.getByRole('heading', { name: /写真と会話で調べる/ })).toBeInTheDocument();
    for (const s of SUGGESTIONS) expect(screen.getByRole('button', { name: s })).toBeInTheDocument();
    expect(send()).toBeDisabled();
  });

  it('質問を送ると、同じオリジンの /api/chat へ POST し、返答と結果カードを出す', async () => {
    fetchMock.mockResolvedValue(jsonResponse(reply('件数です。', [count])));
    const { input, send } = setup();
    await userEvent.type(input(), '何件ありますか？');
    await userEvent.click(send());

    expect(await screen.findByText('件数です。')).toBeInTheDocument();
    expect(screen.getByText('何件ありますか？')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: count.title })).toBeInTheDocument();
    expect(input()).toHaveValue('');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/chat');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ messages: [{ role: 'user', content: '何件ありますか？' }] });
    // 使ったツールも見られる
    expect(screen.getByText('使ったツール')).toBeInTheDocument();
  });

  it('2 回目の質問には、これまでの会話（役割と本文だけ）を付ける', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(reply('1 回目', [count]))).mockResolvedValueOnce(jsonResponse(reply('2 回目')));
    const { input } = setup();
    await userEvent.type(input(), 'ひとつめ{Enter}');
    await screen.findByText('1 回目');
    await userEvent.type(input(), 'ふたつめ{Enter}');
    await screen.findByText('2 回目');
    const body = JSON.parse(String(fetchMock.mock.calls[1]![1]?.body)) as { messages: unknown[] };
    expect(body.messages).toEqual([
      { role: 'user', content: 'ひとつめ' },
      { role: 'assistant', content: '1 回目' },
      { role: 'user', content: 'ふたつめ' },
    ]);
  });

  it('送信中は「調べています」を出して二重送信を防ぎ、終わると消える', async () => {
    let resolve!: (r: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((r) => (resolve = r)));
    const { input, send } = setup();
    await userEvent.type(input(), 'テスト');
    await userEvent.click(send());
    expect(await screen.findByText(/調べています/)).toBeInTheDocument();
    expect(screen.getByRole('log')).toHaveAttribute('aria-busy', 'true');
    expect(send()).toBeDisabled();
    await userEvent.type(input(), '二つ目{Enter}');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolve(jsonResponse(reply('できました')));
    expect(await screen.findByText('できました')).toBeInTheDocument();
    expect(screen.queryByText(/調べています/)).not.toBeInTheDocument();
  });

  it('失敗したら、理由を出して「もう一度送る」で同じ内容を再送できる', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: { code: 'mock_failure', message: 'わざとのエラーです。' } }, 500))
      .mockResolvedValueOnce(jsonResponse(reply('今度は届きました')));
    const { input, send } = setup();
    await userEvent.type(input(), '失敗するかも');
    await userEvent.click(send());

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('送信できませんでした');
    expect(alert).toHaveTextContent('わざとのエラーです。');
    expect(screen.getByText('失敗するかも')).toBeInTheDocument();

    await userEvent.click(within(alert).getByRole('button', { name: 'もう一度送る' }));
    expect(await screen.findByText('今度は届きました')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    const retryBody = JSON.parse(String(fetchMock.mock.calls[1]![1]?.body)) as { messages: unknown[] };
    expect(retryBody.messages).toEqual([{ role: 'user', content: '失敗するかも' }]);
  });

  it('サーバーに届かないときは、接続できない旨を出す', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const { input } = setup();
    await userEvent.type(input(), 'こんにちは{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('サーバーに接続できませんでした');
  });

  it('JSON でない 502 でも、画面は壊れず HTTP ステータスを出す', async () => {
    fetchMock.mockResolvedValue(new Response('Bad Gateway', { status: 502 }));
    const { input } = setup();
    await userEvent.type(input(), 'こんにちは{Enter}');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('HTTP 502');
    expect(alert).toHaveTextContent('API に接続できません');
  });

  it('サジェストを押すと、その文を質問として送る', async () => {
    fetchMock.mockResolvedValue(jsonResponse(reply('精度です')));
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'このアプリの精度は？' }));
    await screen.findByText('精度です');
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({ messages: [{ role: 'user', content: 'このアプリの精度は？' }] });
  });

  it('お断りの提案を押すと、新しい質問として送る', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(reply('範囲外です', [refusal]))).mockResolvedValueOnce(jsonResponse(reply('件数です')));
    const { input } = setup();
    await userEvent.type(input(), '渋谷の新築は？{Enter}');
    await screen.findByText('範囲外です');
    const card = screen.getByRole('note', { name: 'この質問は範囲外です' });
    await userEvent.click(within(card).getByRole('button', { name: '新規出現の候補は何件ありますか？' }));
    await screen.findByText('件数です');
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body)).messages.at(-1)).toEqual({
      role: 'user',
      content: '新規出現の候補は何件ありますか？',
    });
  });

  it('地図の表示が返ったら、すぐ地図を寄せる', async () => {
    fetchMock.mockResolvedValue(jsonResponse(reply('地図に出します', [mapFocus])));
    const { input, actions } = setup();
    await userEvent.type(input(), '地図で見せて{Enter}');
    await screen.findByText('地図に出します');
    await waitFor(() => expect(actions.focusMap).toHaveBeenCalledWith({ bbox: mapFocus.bbox, candidateIds: mapFocus.candidate_ids }));
  });

  it('日本語入力の変換を確定する Enter は、送信の操作として扱わない', () => {
    setup();
    const input = screen.getByRole('textbox', { name: '質問を入力' });
    // 既定の動作を止められたら false が返る
    expect(fireEvent.keyDown(input, { key: 'Enter', isComposing: true })).toBe(false);
    expect(fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })).toBe(false);
    expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(true);
  });

  it('空白だけの質問は送らない', async () => {
    const { input } = setup();
    await userEvent.type(input(), '   {Enter}');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// API の上限（backend/app/routes.py の ChatRequest）: messages は 40 件以下、各 content は 2000 字以下
describe('チャットの長さの上限', () => {
  const bodyOf = (call: number) => JSON.parse(String(fetchMock.mock.calls[call]![1]?.body)) as { messages: { role: string; content: string }[] };

  it('入力欄は 2000 字までしか受けない（貼り付けても超えない）', async () => {
    const { input } = setup();
    expect(input()).toHaveAttribute('maxlength', '2000');
    await userEvent.click(input());
    await userEvent.paste('あ'.repeat(2500));
    expect(input()).toHaveValue('あ'.repeat(2000));
  });

  it('送信に失敗した発言は、次の質問の履歴に含めない（含めると以後ずっと同じ失敗になる）', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: { code: 'validation_error', message: '引数が不正です' } }, 422))
      .mockResolvedValueOnce(jsonResponse(reply('件数です')));
    const { input } = setup();
    await userEvent.type(input(), '届かない質問{Enter}');
    await screen.findByRole('alert');
    // 失敗した発言は、未送信と分かる形で画面に残る
    expect(screen.getByText('届かない質問')).toBeInTheDocument();
    expect(screen.getByText('未送信')).toBeInTheDocument();

    await userEvent.type(input(), '件数は？{Enter}');
    await screen.findByText('件数です');
    expect(bodyOf(1).messages).toEqual([{ role: 'user', content: '件数は？' }]);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('失敗した発言を「もう一度送る」で送れたら、未送信の印は消え、発言は二重にならない', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: { code: 'mock_failure', message: 'だめでした' } }, 500))
      .mockResolvedValueOnce(jsonResponse(reply('届きました')))
      .mockResolvedValueOnce(jsonResponse(reply('次の答え')));
    const { input } = setup();
    await userEvent.type(input(), 'ひとつめ{Enter}');
    await userEvent.click(await screen.findByRole('button', { name: 'もう一度送る' }));
    await screen.findByText('届きました');
    expect(screen.queryByText('未送信')).not.toBeInTheDocument();
    expect(screen.getAllByText('ひとつめ')).toHaveLength(1);

    await userEvent.type(input(), 'ふたつめ{Enter}');
    await screen.findByText('次の答え');
    expect(bodyOf(2).messages).toEqual([
      { role: 'user', content: 'ひとつめ' },
      { role: 'assistant', content: '届きました' },
      { role: 'user', content: 'ふたつめ' },
    ]);
  });

  it('何往復しても、送る会話は 40 件以下・各 2000 字以下で、user から始まる', async () => {
    let n = 0;
    fetchMock.mockImplementation(async () => jsonResponse(reply(`答え ${++n}`)));
    const { input } = setup();
    for (let i = 1; i <= 24; i += 1) {
      await userEvent.type(input(), `質問 ${i}{Enter}`);
      await screen.findByText(`答え ${i}`);
    }
    expect(fetchMock).toHaveBeenCalledTimes(24);
    for (let c = 0; c < 24; c += 1) {
      const { messages } = bodyOf(c);
      expect(messages.length).toBeLessThanOrEqual(40);
      expect(messages[0]!.role).toBe('user');
      expect(messages.at(-1)).toEqual({ role: 'user', content: `質問 ${c + 1}` });
      for (const m of messages) expect(m.content.length).toBeLessThanOrEqual(2000);
    }
    // 古い発言から落とす（直近のやりとりは残る）
    expect(bodyOf(23).messages).toContainEqual({ role: 'assistant', content: '答え 23' });
  });

  it('返答が 2000 字を超えても、履歴に入れるときは 2000 字に切る', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(reply('長'.repeat(2600)))).mockResolvedValueOnce(jsonResponse(reply('二つ目')));
    const { input } = setup();
    await userEvent.type(input(), 'ひとつめ{Enter}');
    await screen.findByText('長'.repeat(2600));
    await userEvent.type(input(), 'ふたつめ{Enter}');
    await screen.findByText('二つ目');
    expect(bodyOf(1).messages[1]).toEqual({ role: 'assistant', content: '長'.repeat(2000) });
  });
});

describe('新しい会話', () => {
  const bodyOf = (call: number) => JSON.parse(String(fetchMock.mock.calls[call]![1]?.body)) as { messages: unknown[] };

  it('はじめは出さない。押すと会話・エラーを消して説明に戻り、次の質問は履歴なしで送る', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(reply('1 回目')))
      .mockResolvedValueOnce(jsonResponse({ error: { code: 'mock_failure', message: 'だめでした' } }, 500))
      .mockResolvedValueOnce(jsonResponse(reply('新しい答え')));
    const { input } = setup();
    expect(screen.queryByRole('button', { name: '新しい会話' })).not.toBeInTheDocument();

    await userEvent.type(input(), 'ひとつめ{Enter}');
    await screen.findByText('1 回目');
    await userEvent.type(input(), '失敗する{Enter}');
    await screen.findByRole('alert');

    await userEvent.click(screen.getByRole('button', { name: '新しい会話' }));
    expect(screen.queryByText('1 回目')).not.toBeInTheDocument();
    expect(screen.queryByText('失敗する')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /写真と会話で調べる/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '新しい会話' })).not.toBeInTheDocument();

    await userEvent.type(input(), 'やり直し{Enter}');
    await screen.findByText('新しい答え');
    expect(bodyOf(2).messages).toEqual([{ role: 'user', content: 'やり直し' }]);
  });

  it('返答を待っている途中で押すと、その返答は捨て、すぐ次の質問を送れる', async () => {
    let resolveFirst!: (r: Response) => void;
    fetchMock
      .mockReturnValueOnce(new Promise<Response>((r) => (resolveFirst = r)))
      .mockResolvedValueOnce(jsonResponse(reply('新しい答え')));
    const { input, send } = setup();
    await userEvent.type(input(), '遅い質問{Enter}');
    await screen.findByText(/調べています/);

    await userEvent.click(screen.getByRole('button', { name: '新しい会話' }));
    expect(screen.queryByText(/調べています/)).not.toBeInTheDocument();
    expect(screen.getByRole('log')).toHaveAttribute('aria-busy', 'false');
    // 遅れて届いた返答は、新しい会話に混ざらない
    resolveFirst(jsonResponse(reply('古い答え')));

    await userEvent.type(input(), '新しい質問');
    expect(send()).toBeEnabled();
    await userEvent.click(send());
    await screen.findByText('新しい答え');
    expect(screen.queryByText('古い答え')).not.toBeInTheDocument();
    expect(bodyOf(1).messages).toEqual([{ role: 'user', content: '新しい質問' }]);
  });
});
