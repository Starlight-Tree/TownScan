import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AreaSummary, ChatResponse } from '../../lib/api-types';
import { AreasProvider } from '../../lib/areas-context';
import { areas, compare, count, countWards, detectionImage, jsonResponse, mapFocus, refusal, table } from '../../tests/fixtures';
import { CLASS_INFO, CLASS_ORDER } from '../../lib/classes';
import { NewConversationProvider, useStartNewConversation } from '../NewConversation';
import { ChatPanel, SUGGESTIONS } from './ChatPanel';
import type { ChatActions } from './types';

const reply = (content: string, results: ChatResponse['message']['results'] = []): ChatResponse => ({
  message: { role: 'assistant', content, results, tool_calls: [{ name: 'count_candidates', args: { cls: null } }] },
});

const fetchMock = vi.fn<typeof fetch>();

function makeActions() {
  return { expand: vi.fn() } satisfies ChatActions;
}

function setup(opts: { areas?: AreaSummary[] } = {}) {
  const actions = makeActions();
  render(
    opts.areas ? (
      <AreasProvider areas={opts.areas}>
        <ChatPanel actions={actions} />
      </AreasProvider>
    ) : (
      <ChatPanel actions={actions} />
    ),
  );
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

describe('最初の画面（説明・サンプルの質問）', () => {
  const threeAreas: AreaSummary[] = ['a', 'b', 'c'].map((id) => ({ ...areas[0]!, id, name: `地区 ${id}` }));
  const FACT = (n: string) => `熊本市中心部の${n}地区（1 地区 = 地理院タイル 1 枚 = 約 130 m 四方）`;

  it('対象の地区数は、読み込んだ地区の数から出す。読み込み前は数を伏せる', () => {
    const actions = makeActions();
    const { rerender } = render(
      <AreasProvider areas={[]}>
        <ChatPanel actions={actions} />
      </AreasProvider>,
    );
    expect(screen.getByText(FACT(''))).toBeInTheDocument();
    expect(screen.queryByText(/\d+ 地区（/)).not.toBeInTheDocument();

    rerender(
      <AreasProvider areas={threeAreas}>
        <ChatPanel actions={actions} />
      </AreasProvider>,
    );
    expect(screen.getByText(FACT(' 3 '))).toBeInTheDocument();
    expect(screen.queryByText(FACT(''))).not.toBeInTheDocument();
    // 固定の 12 を出さない
    expect(screen.queryByText(/12 地区/)).not.toBeInTheDocument();
  });

  it('対象・比較・出典と、新規出現の「候補」であって新築と断定しない旨を出す', () => {
    setup({ areas });
    const facts = screen.getByText('対象').closest('dl')!;
    expect(within(facts).getByText('比較').nextElementSibling).toHaveTextContent('2018 年と 2023 年の航空写真');
    expect(within(facts).getByText('出典').nextElementSibling).toHaveTextContent('国土地理院（地理院タイル・基盤地図情報）');
    expect(screen.getByText(/新築と断定するものではありません/)).toBeInTheDocument();
  });

  it('答えられる質問の例と、範囲外の質問の例（断って理由を返す）を分けて見せる', async () => {
    fetchMock.mockResolvedValue(jsonResponse(reply('範囲外です', [refusal])));
    setup();
    const refuseGroup = screen.getByText('範囲外の質問は、断って理由を返します').closest('.suggest-block') as HTMLElement;
    expect(within(refuseGroup).getAllByRole('button').map((b) => b.textContent)).toEqual(['渋谷の新築は？']);
    const inScope = screen.getByText('まず、こんな質問から').closest('.suggest-block') as HTMLElement;
    expect(within(inScope).queryByRole('button', { name: '渋谷の新築は？' })).not.toBeInTheDocument();
    expect(within(inScope).getAllByRole('button')).toHaveLength(SUGGESTIONS.length - 1);

    await userEvent.click(within(refuseGroup).getByRole('button', { name: '渋谷の新築は？' }));
    await screen.findByText('範囲外です');
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({ messages: [{ role: 'user', content: '渋谷の新築は？' }] });
  });

  it('「解析した地区を地図で見る」を押すと、回答を持たない拡大ビューを、地図の画面で開く（押したボタンを、フォーカスの戻し先として渡す）', async () => {
    const { actions } = setup({ areas });
    const button = screen.getByRole('button', { name: '解析した地区を地図で見る' });
    await userEvent.click(button);
    expect(actions.expand).toHaveBeenCalledTimes(1);
    expect(actions.expand).toHaveBeenCalledWith(null, { type: 'view', view: 'map' }, button);
    // 質問を送ったわけではない
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('回答が届いても、拡大ビューは開かず、何も頼まない（開くのは、結果カードのボタンを押したときだけ）', () => {
  it('結果つきの回答（件数・地図の表示・検出画像）が届いても、拡大ビューを開く操作（expand）を呼ばない。カードは会話の中に出る', async () => {
    fetchMock.mockResolvedValue(jsonResponse(reply('件数と地図と写真です', [count, mapFocus, detectionImage])));
    const { input, actions } = setup();
    await userEvent.type(input(), '見せて{Enter}');
    await screen.findByText('件数と地図と写真です');
    expect(screen.getByRole('region', { name: count.title })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: mapFocus.title })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: detectionImage.title })).toBeInTheDocument();
    expect(actions.expand).not.toHaveBeenCalled();
  });

  it('次の回答・再描画（入力・親の再描画）でも、呼ばない', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(reply('1 回目', [count]))).mockResolvedValueOnce(jsonResponse(reply('2 回目', [compare])));
    const actions = makeActions();
    const { rerender } = render(<ChatPanel actions={actions} />);
    const input = () => screen.getByRole('textbox', { name: '質問を入力' });
    await userEvent.type(input(), 'ひとつめ{Enter}');
    await screen.findByText('1 回目');
    await userEvent.type(input(), 'あ');
    rerender(<ChatPanel actions={{ ...actions }} />);
    await userEvent.clear(input());
    await userEvent.type(input(), 'ふたつめ{Enter}');
    await screen.findByText('2 回目');
    expect(actions.expand).not.toHaveBeenCalled();
  });

  it('results が配列でない回答でも、画面は壊れず、呼ばない', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: { role: 'assistant', content: '結果なし', results: null, tool_calls: [] } }));
    const { input, actions } = setup();
    await userEvent.type(input(), 'こんにちは{Enter}');
    await screen.findByText('結果なし');
    expect(actions.expand).not.toHaveBeenCalled();
  });

  it('送信に失敗したときも、「もう一度送る」で届いたときも、呼ばない', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: { code: 'mock_failure', message: 'だめでした' } }, 500))
      .mockResolvedValueOnce(jsonResponse(reply('届きました', [count])));
    const { input, actions } = setup();
    await userEvent.type(input(), '質問{Enter}');
    await userEvent.click(await screen.findByRole('button', { name: 'もう一度送る' }));
    await screen.findByText('届きました');
    expect(actions.expand).not.toHaveBeenCalled();
  });

  it('「新しい会話」で捨てた返答は、新しい会話に混ぜない（出さず、呼ばない）', async () => {
    let resolveFirst!: (r: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((r) => (resolveFirst = r)));
    const { input, actions } = setup();
    await userEvent.type(input(), '遅い質問{Enter}');
    await screen.findByText(/調べています/);
    await userEvent.click(screen.getByRole('button', { name: '新しい会話' }));
    resolveFirst(jsonResponse(reply('古い答え', [count])));
    // 捨てた返答が処理される猶予
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('古い答え')).not.toBeInTheDocument();
    expect(actions.expand).not.toHaveBeenCalled();
  });
});

describe('回答の対象・条件の行', () => {
  const scopeName = 'この回答の対象・条件';

  it('件数の回答の文とカードのあいだに、地区・分類・写真の年を出す（地区名は地区の一覧から）', async () => {
    const filtered = { ...count, filter: { area_id: 'z18-1-2', cls: 'uncertain' as const } };
    fetchMock.mockResolvedValue(jsonResponse(reply('件数です。', [filtered])));
    const { input } = setup({ areas });
    await userEvent.type(input(), '保留は？{Enter}');
    const scope = await screen.findByRole('group', { name: scopeName });
    expect(scope).toHaveTextContent('テスト地区 01');
    expect(scope).toHaveTextContent('判定保留');
    expect(scope).toHaveTextContent('2018・2023 年');
    const text = screen.getByText('件数です。');
    const card = screen.getByRole('region', { name: count.title });
    expect(text.compareDocumentPosition(scope) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(scope.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('比較の回答には、比べる地区を出す', async () => {
    fetchMock.mockResolvedValue(jsonResponse(reply('比べました。', [compare])));
    const { input } = setup();
    await userEvent.type(input(), '比べて{Enter}');
    const scope = await screen.findByRole('group', { name: scopeName });
    expect(scope).toHaveTextContent('比べる地区');
    expect(scope).toHaveTextContent('テスト地区 01、テスト地区 02');
  });

  it('お断り・一覧・結果なしの回答には出さない', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(reply('範囲外です', [refusal])))
      .mockResolvedValueOnce(jsonResponse(reply('一覧です', [table])))
      .mockResolvedValueOnce(jsonResponse(reply('ただの返事です')));
    const { input } = setup();
    for (const [q, answer] of [
      ['渋谷の新築は？', '範囲外です'],
      ['一覧', '一覧です'],
      ['こんにちは', 'ただの返事です'],
    ] as const) {
      await userEvent.type(input(), `${q}{Enter}`);
      await screen.findByText(answer);
    }
    expect(screen.queryByRole('group', { name: scopeName })).not.toBeInTheDocument();
  });

  it('結果の形が壊れていても、会話は壊れない（条件の行は出さない）', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = { type: 'count', title: '壊れた件数', total: 1 } as unknown as ChatResponse['message']['results'][number];
    fetchMock.mockResolvedValue(jsonResponse(reply('壊れた結果です', [broken])));
    const { input } = setup();
    await userEvent.type(input(), '壊れる{Enter}');
    await screen.findByText('壊れた結果です');
    expect(screen.queryByRole('group', { name: scopeName })).not.toBeInTheDocument();
    expect(screen.getByRole('note', { name: '表示できない結果' })).toBeInTheDocument();
    spy.mockRestore();
  });
});

describe('結果カードのボタン: その回答の拡大ビューを開く（拡大の単位は回答 1 件）', () => {
  it('回答の件数のカードの「グラフで見る」「地図で見る」: その回答（ID と結果）と、画面を渡す。押したボタンを、フォーカスの戻し先として渡す', async () => {
    fetchMock.mockResolvedValue(jsonResponse(reply('件数です。', [count])));
    const { input, actions } = setup();
    await userEvent.type(input(), '何件？{Enter}');
    const card = await screen.findByRole('region', { name: count.title });
    const chart = within(card).getByRole('button', { name: 'グラフで見る' });
    await userEvent.click(chart);
    expect(actions.expand).toHaveBeenCalledTimes(1);
    const [answer, request, opener] = actions.expand.mock.calls[0]!;
    expect(answer).toEqual({ id: expect.stringMatching(/^m\d+$/), results: [count] });
    expect(request).toEqual({ type: 'view', view: 'chart' });
    expect(opener).toBe(chart);

    const map = within(card).getByRole('button', { name: '地図で見る' });
    await userEvent.click(map);
    expect(actions.expand).toHaveBeenLastCalledWith(answer, { type: 'view', view: 'map' }, map);
  });

  it('フォーカスが移らないブラウザー（macOS の Safari・Firefox）でも、押したボタンを戻し先として渡す（click だけを送る）', async () => {
    fetchMock.mockResolvedValue(jsonResponse(reply('件数です。', [count])));
    const { input, actions } = setup();
    await userEvent.type(input(), '何件？{Enter}');
    const chart = within(await screen.findByRole('region', { name: count.title })).getByRole('button', { name: 'グラフで見る' });
    expect(chart).not.toHaveFocus();
    fireEvent.click(chart);
    expect(actions.expand.mock.calls[0]![2]).toBe(chart);
  });

  it('回答ごとに別の ID と結果を渡す（古い回答のカードを押すと、その回答として開く）', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(reply('1 回目', [count]))).mockResolvedValueOnce(jsonResponse(reply('2 回目', [compare])));
    const { input, actions } = setup();
    await userEvent.type(input(), 'ひとつめ{Enter}');
    await screen.findByText('1 回目');
    await userEvent.type(input(), 'ふたつめ{Enter}');
    await screen.findByText('2 回目');
    await userEvent.click(within(screen.getByRole('region', { name: compare.title })).getByRole('button', { name: 'グラフで見る' }));
    await userEvent.click(within(screen.getByRole('region', { name: count.title })).getByRole('button', { name: 'グラフで見る' }));
    const [second, first] = actions.expand.mock.calls.map((c) => c[0]);
    expect(second).toEqual({ id: expect.any(String), results: [compare] });
    expect(first).toEqual({ id: expect.any(String), results: [count] });
    expect(first!.id).not.toBe(second!.id);
  });

  it('1 つの回答の結果すべてを渡す（回答の条件は、その回答の結果から決まる）。どのカードのボタンでも同じ回答', async () => {
    fetchMock.mockResolvedValue(jsonResponse(reply('件数と地図です。', [count, mapFocus])));
    const { input, actions } = setup();
    await userEvent.type(input(), '見せて{Enter}');
    await userEvent.click(within(await screen.findByRole('region', { name: count.title })).getByRole('button', { name: 'グラフで見る' }));
    await userEvent.click(within(screen.getByRole('region', { name: mapFocus.title })).getByRole('button', { name: '地図で見る' }));
    expect(actions.expand.mock.calls[0]![0]).toEqual({ id: expect.any(String), results: [count, mapFocus] });
    expect(actions.expand.mock.calls[1]![0]!.id).toBe(actions.expand.mock.calls[0]![0]!.id);
  });

  it('地図の表示の「地図で見る」: 範囲と候補 ID を渡す。表の「詳細」・検出画像の「詳細を開く」: 候補 ID を渡す', async () => {
    fetchMock.mockResolvedValue(jsonResponse(reply('いろいろです。', [mapFocus, table, detectionImage])));
    const { input, actions } = setup();
    await userEvent.type(input(), '見せて{Enter}');
    await userEvent.click(within(await screen.findByRole('region', { name: mapFocus.title })).getByRole('button', { name: '地図で見る' }));
    expect(actions.expand.mock.calls[0]![1]).toEqual({ type: 'focus', bbox: mapFocus.bbox, candidateIds: mapFocus.candidate_ids });
    await userEvent.click(screen.getByRole('button', { name: /詳細.*c-1-2-2/ }));
    expect(actions.expand.mock.calls[1]![1]).toEqual({ type: 'candidate', id: 'c-1-2-2' });
    await userEvent.click(screen.getByRole('button', { name: '詳細を開く' }));
    expect(actions.expand.mock.calls[2]![1]).toEqual({ type: 'candidate', id: detectionImage.candidate_id });
  });
});

describe('チャットのスクロール位置（開いた直後は説明の見出しから）', () => {
  /** jsdom には、レイアウトが無い（scrollHeight は 0）。いちばん下の位置を、決まった値にする */
  const BOTTOM = 900;
  const log = () => screen.getByRole('log');

  beforeEach(() => {
    vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(BOTTOM);
  });

  it('開いた直後（発言が 1 件も無い）は、下へ動かさない。説明の見出しが見える位置（scrollTop が 0）のまま', () => {
    setup();
    expect(log().scrollTop).toBe(0);
    expect(screen.getByRole('heading', { name: /写真と会話で調べる/ })).toBeInTheDocument();
  });

  it('発言が増える（送信中・返答）たびに、いちばん下へ動かす。失敗のときも', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(reply('1 回目'))).mockResolvedValueOnce(jsonResponse({ error: { code: 'mock_failure', message: 'だめでした' } }, 500));
    const { input } = setup();
    expect(log().scrollTop).toBe(0);
    await userEvent.type(input(), 'ひとつめ{Enter}');
    await screen.findByText('1 回目');
    expect(log().scrollTop).toBe(BOTTOM);

    // 利用者が上へ戻って読んでいても、新しい発言のあとは、また下へ
    log().scrollTop = 120;
    await userEvent.type(input(), '失敗する{Enter}');
    await screen.findByRole('alert');
    expect(log().scrollTop).toBe(BOTTOM);
  });

  it('「新しい会話」で発言が 0 件に戻ったら、いちばん上（説明の先頭）へ戻す', async () => {
    fetchMock.mockResolvedValue(jsonResponse(reply('答えです')));
    const { input } = setup();
    await userEvent.type(input(), 'ひとつめ{Enter}');
    await screen.findByText('答えです');
    expect(log().scrollTop).toBe(BOTTOM);

    await userEvent.click(screen.getByRole('button', { name: '新しい会話' }));
    expect(screen.getByRole('heading', { name: /写真と会話で調べる/ })).toBeInTheDocument();
    expect(log().scrollTop).toBe(0);
  });
});

describe('回答の対象・条件の行: 最後の条件（拡大ビューの絞り込みと同じ）', () => {
  const scopeName = 'この回答の対象・条件';

  it('件数のあとに比較がある回答は、比較の条件（地区だけ。分類の行は出さない）。先の件数の条件を出さない', async () => {
    const narrow = { ...count, filter: { area_id: 'z18-1-2', cls: 'uncertain' as const } };
    const byWard = { ...compare, filter: { area_ids: ['z18-1-2', 'z18-2-2'], scope: '中央区', cls: 'confirmed_new' as const } };
    fetchMock.mockResolvedValue(jsonResponse(reply('件数と比較です。', [narrow, byWard])));
    const { input } = setup({ areas });
    await userEvent.type(input(), '件数と比較{Enter}');
    const scope = await screen.findByRole('group', { name: scopeName });
    expect(within(scope).getByText('地区', { selector: 'dt' }).nextElementSibling).toHaveTextContent('中央区');
    expect(within(scope).queryByText('分類', { selector: 'dt' })).not.toBeInTheDocument();
    expect(scope).not.toHaveTextContent('判定保留');
    // 比べる地区の行は、比較の結果の名前（条件の行とは別）
    expect(scope).toHaveTextContent('比べる地区');
    expect(scope).toHaveTextContent('テスト地区 01、テスト地区 02');
  });

  it('比較のあとに件数がある回答は、件数の条件（地区と分類）', async () => {
    fetchMock.mockResolvedValue(jsonResponse(reply('比較と件数です。', [compare, countWards])));
    const { input } = setup({ areas });
    await userEvent.type(input(), '比較と件数{Enter}');
    const scope = await screen.findByRole('group', { name: scopeName });
    expect(within(scope).getByText('地区', { selector: 'dt' }).nextElementSibling).toHaveTextContent('中央区');
    expect(within(scope).getByText('分類', { selector: 'dt' }).nextElementSibling).toHaveTextContent('すべて');
  });
});

describe('長い回答が届いたあとのスクロール位置（質問か回答の先頭が見える）', () => {
  /** jsdom にはレイアウトが無い。チャット欄の高さ・全体の高さ・発言の位置と高さを決める */
  const VIEW = 400;
  const BOTTOM = 2000;
  const log = () => screen.getByRole('log');

  type Box = { top: number; height: number };
  function layout(boxes: { log: Box; question: Box; answer: Box }) {
    vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(BOTTOM);
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(VIEW);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const entry = this.getAttribute('data-entry');
      const box = entry === 'assistant' ? boxes.answer : entry === 'user' ? boxes.question : this.getAttribute('role') === 'log' ? boxes.log : { top: 0, height: 0 };
      // 本物のブラウザと同じく、発言の画面上の位置は、チャット欄のスクロール量の分だけ上へ動く
      const scrolled = entry ? (this.closest('[role="log"]')?.scrollTop ?? 0) : 0;
      const top = box.top - scrolled;
      return { top, height: box.height, bottom: top + box.height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
    });
  }

  it('欄より長い回答は、いちばん下まで送らず、質問の先頭が見える位置に合わせる（結論の最初の文が隠れない）', async () => {
    // 枠の上端 50。質問は、中身の先頭から 700px 下、回答はその 54px 下から 900px の高さ（欄の 400px を超える）
    layout({ log: { top: 50, height: VIEW }, question: { top: 750, height: 40 }, answer: { top: 804, height: 900 } });
    fetchMock.mockResolvedValue(jsonResponse(reply('長い回答です', [table])));
    const { input } = setup();
    await userEvent.type(input(), '一覧{Enter}');
    await screen.findByText('長い回答です');
    expect(log().scrollTop).toBe(700);
  });

  it('質問が長い（欄の 3 分の 1 を超える）ときは、回答の先頭に合わせる', async () => {
    layout({ log: { top: 50, height: VIEW }, question: { top: 750, height: 300 }, answer: { top: 1064, height: 900 } });
    fetchMock.mockResolvedValue(jsonResponse(reply('長い回答です', [table])));
    const { input } = setup();
    await userEvent.type(input(), '一覧{Enter}');
    await screen.findByText('長い回答です');
    expect(log().scrollTop).toBe(1014);
  });

  it('欄に収まる短い回答は、これまでどおり、いちばん下', async () => {
    layout({ log: { top: 50, height: VIEW }, question: { top: 750, height: 40 }, answer: { top: 804, height: 120 } });
    fetchMock.mockResolvedValue(jsonResponse(reply('短い回答です')));
    const { input } = setup();
    await userEvent.type(input(), 'こんにちは{Enter}');
    await screen.findByText('短い回答です');
    expect(log().scrollTop).toBe(BOTTOM);
  });

  it('返答を待つ間（調べています…）は、質問と待ち表示が見えるいちばん下。回答が届いたら、長ければ質問の先頭へ', async () => {
    layout({ log: { top: 50, height: VIEW }, question: { top: 750, height: 40 }, answer: { top: 804, height: 900 } });
    let resolve!: (r: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((r) => (resolve = r)));
    const { input } = setup();
    await userEvent.type(input(), '一覧{Enter}');
    await screen.findByText(/調べています/);
    expect(log().scrollTop).toBe(BOTTOM);
    resolve(jsonResponse(reply('長い回答です', [table])));
    await screen.findByText('長い回答です');
    expect(log().scrollTop).toBe(700);
  });

  it('失敗のときは、いちばん下（エラーと「もう一度送る」が見える）', async () => {
    layout({ log: { top: 50, height: VIEW }, question: { top: 750, height: 40 }, answer: { top: 804, height: 900 } });
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'mock_failure', message: 'だめでした' } }, 500));
    const { input } = setup();
    await userEvent.type(input(), '一覧{Enter}');
    await screen.findByRole('alert');
    expect(log().scrollTop).toBe(BOTTOM);
  });
});

describe('キーボードの操作: 押したボタンが消えても、フォーカスが入力欄へ戻る', () => {
  const input = () => screen.getByRole('textbox', { name: '質問を入力' });

  it('最初の画面の質問の例を Enter で選ぶと、入力欄へフォーカスが移る（body に落ちない）', async () => {
    fetchMock.mockResolvedValue(jsonResponse(reply('精度です')));
    setup();
    const chip = screen.getByRole('button', { name: 'このアプリの精度は？' });
    chip.focus();
    await userEvent.keyboard('{Enter}');
    await screen.findByText('精度です');
    expect(document.activeElement).not.toBe(document.body);
    expect(input()).toHaveFocus();
  });

  it('マウスで押しても同じ（次の質問をすぐ打てる）', async () => {
    fetchMock.mockResolvedValue(jsonResponse(reply('精度です')));
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'このアプリの精度は？' }));
    await screen.findByText('精度です');
    expect(input()).toHaveFocus();
  });

  it('会話の下の質問の例（小さいほう）を押したときも、入力欄へ', async () => {
    fetchMock.mockResolvedValue(jsonResponse(reply('答えです')));
    setup();
    await userEvent.type(input(), 'ひとつめ{Enter}');
    await screen.findByText('答えです');
    const compact = within(screen.getByLabelText('質問の例')).getByRole('button', { name: SUGGESTIONS[1]! });
    compact.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(input()).toHaveFocus();
  });

  it('「新しい会話」を Enter で押すと、ボタンが消えても、入力欄へフォーカスが移る', async () => {
    fetchMock.mockResolvedValue(jsonResponse(reply('答えです')));
    setup();
    await userEvent.type(input(), 'ひとつめ{Enter}');
    await screen.findByText('答えです');
    const reset = screen.getByRole('button', { name: '新しい会話' });
    reset.focus();
    await userEvent.keyboard('{Enter}');
    expect(screen.queryByRole('button', { name: '新しい会話' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /写真と会話で調べる/ })).toBeInTheDocument();
    expect(document.activeElement).not.toBe(document.body);
    expect(input()).toHaveFocus();
  });

  it('サイドパネルの「新しい会話」（NewConversation）でも、同じ処理で会話が空に戻り、入力欄へフォーカスが移る', async () => {
    fetchMock.mockResolvedValue(jsonResponse(reply('答えです')));
    let startNew: () => boolean = () => false;
    function Probe() {
      startNew = useStartNewConversation();
      return null;
    }
    render(
      <NewConversationProvider>
        <Probe />
        <ChatPanel actions={makeActions()} />
      </NewConversationProvider>,
    );
    const box = screen.getByRole('textbox', { name: '質問を入力' });
    await userEvent.type(box, 'ひとつめ{Enter}');
    await screen.findByText('答えです');
    expect(screen.queryByRole('heading', { name: /写真と会話で調べる/ })).not.toBeInTheDocument();
    act(() => {
      expect(startNew()).toBe(true);
    });
    expect(screen.queryByText('答えです')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /写真と会話で調べる/ })).toBeInTheDocument();
    expect(box).toHaveFocus();
  });

  it('チャットを外す（ホームから移る）と、サイドパネルの「新しい会話」は何もしない（ホームへ移る側に回る）', () => {
    let startNew: () => boolean = () => true;
    function Probe() {
      startNew = useStartNewConversation();
      return null;
    }
    const tree = (withChat: boolean) => (
      <NewConversationProvider>
        <Probe />
        {withChat && <ChatPanel actions={makeActions()} />}
      </NewConversationProvider>
    );
    const { rerender } = render(tree(true));
    expect(startNew()).toBe(true);
    rerender(tree(false));
    expect(startNew()).toBe(false);
  });

  it('指で触る端末（pointer: coarse）では、画面のキーボードを開かないよう、入力欄へ移さない', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(pointer: coarse)', media: query, addEventListener() {}, removeEventListener() {} }));
    fetchMock.mockResolvedValue(jsonResponse(reply('精度です')));
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'このアプリの精度は？' }));
    await screen.findByText('精度です');
    expect(input()).not.toHaveFocus();
  });
});

describe('同じ文を 2 回出さない（本文とカード）', () => {
  it('範囲外・見つからない: 本文と同じお断りの文は、カードには出さない（見出しと「代わりの質問」は出す）', async () => {
    const gone = { ...refusal, reason: 'no_data' as const, message: 'その候補は見つかりません。', suggestions: ['このアプリの精度は？'] };
    fetchMock.mockResolvedValue(jsonResponse(reply(gone.message, [gone])));
    const { input } = setup();
    await userEvent.type(input(), 'c-000000-000000-9 の写真を見せて{Enter}');
    await screen.findByRole('note', { name: '該当するデータがありません' });
    expect(screen.getAllByText('その候補は見つかりません。')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'このアプリの精度は？' })).toBeInTheDocument();
  });

  it('範囲外: 12 地区の列挙のような長い文も、1 回だけ', async () => {
    const long = { ...refusal, message: '「渋谷」は、解析した地区に含まれていません。解析した地区は、薄場一丁目、本荘五丁目 です。' };
    fetchMock.mockResolvedValue(jsonResponse(reply(long.message, [long])));
    const { input } = setup();
    await userEvent.type(input(), '渋谷の新築は？{Enter}');
    await screen.findByRole('note', { name: 'この質問は範囲外です' });
    expect(screen.getAllByText(long.message)).toHaveLength(1);
  });

  it('写真の回答: 本文の中の説明（caption）は、カードでは繰り返さない。カードの写真・分類の印・詳細は出す', async () => {
    const body = `候補 c-1-2-1 の写真を、2018 年と 2023 年で並べます。${detectionImage.caption}`;
    fetchMock.mockResolvedValue(jsonResponse(reply(body, [detectionImage])));
    const { input } = setup();
    await userEvent.type(input(), 'いちばん大きい候補の写真を見せて{Enter}');
    const card = await screen.findByRole('region', { name: detectionImage.title });
    expect(screen.getAllByText(new RegExp(detectionImage.caption))).toHaveLength(1);
    expect(within(card).getAllByRole('img')).toHaveLength(2);
    expect(within(card).getByRole('button', { name: '詳細を開く' })).toBeInTheDocument();
  });

  it('本文が別の言い方なら（実 LLM など）、カードの文も出す（情報を落とさない）', async () => {
    fetchMock.mockResolvedValue(jsonResponse(reply('お答えできません。', [refusal])));
    const { input } = setup();
    await userEvent.type(input(), '渋谷の新築は？{Enter}');
    await screen.findByText('お答えできません。');
    expect(screen.getByText(refusal.message)).toBeInTheDocument();
  });
});

describe('最初の画面: 地区の大きさ・分類の意味・「候補」の言い方', () => {
  it('1 地区 = 約 130 m 四方であること、地区の名前はタイルの中心の住所であることを書く（丁目・区の全体に読めないように）', () => {
    setup({ areas });
    const facts = screen.getByText('対象').closest('dl')!;
    expect(within(facts).getByText('対象').nextElementSibling).toHaveTextContent('1 地区 = 地理院タイル 1 枚 = 約 130 m 四方');
    expect(within(facts).getByText('地区の名前').nextElementSibling).toHaveTextContent('タイルの中心にある住所の名前です。丁目や区の全体を数えた値ではありません。');
  });

  it('見出しは、市全体でなく「熊本市中心部」', () => {
    setup();
    expect(screen.getByRole('heading', { name: '熊本市中心部の変化を、写真と会話で調べる' })).toBeInTheDocument();
  });

  it('3 つの分類（印・名前・1 行の説明）を、最初の画面に出す。説明は詳細の画面と同じ文（CLASS_INFO.summary）', () => {
    setup();
    const group = screen.getByText(/次の 3 つの分類に分けています/).closest('.welcome__classes') as HTMLElement;
    for (const cls of CLASS_ORDER) {
      const item = group.querySelector(`[data-class="${cls}"]`) as HTMLElement;
      expect(item).toHaveTextContent(CLASS_INFO[cls].label);
      expect(item).toHaveTextContent(CLASS_INFO[cls].summary);
      expect(item.querySelector('svg')).not.toBeNull();
    }
  });

  it('「候補」は 3 分類の合計の意味で、新築と断定しない。最初の画面は短く、くわしいことは「くわしく」の中（閉じた状態）', () => {
    setup();
    const lead = document.querySelector('.welcome__lead') as HTMLElement;
    expect(lead).toHaveTextContent('新しく現れた建物の候補');
    expect(lead).toHaveTextContent('新築と断定するものではありません');
    expect(lead).not.toHaveTextContent('新規出現');
    expect(document.querySelector('.welcome__caution')).toBeNull(); // 大きな注意書きの枠は出さない
    expect(screen.getByText(/3 つの合計が、候補の数です/)).toBeInTheDocument();
    const more = document.querySelector('details.welcome__more') as HTMLDetailsElement;
    expect(more).not.toBeNull();
    expect(more.open).toBe(false);
    // 最初に見えるのは、見出し・説明・地図のボタン・質問の例。対象・分類・出典・範囲外の質問は、くわしくの中
    expect(more).toContainElement(screen.getByText('対象'));
    expect(more).toContainElement(screen.getByText(/次の 3 つの分類に分けています/));
    expect(more).toContainElement(screen.getByText('範囲外の質問は、断って理由を返します'));
    expect(more).not.toContainElement(screen.getByRole('button', { name: '解析した地区を地図で見る' }));
    expect(more).not.toContainElement(screen.getByText('まず、こんな質問から'));
  });

  it('入力欄の下に、モデル名や「ツールの結果をそのまま」の注記を出さない（モデルの印はサイドパネル・上の横帯に 1 か所）', () => {
    setup();
    expect(document.querySelector('.chat__footnote')).toBeNull();
    expect(screen.queryByText(/模擬モデルで応答しています/)).not.toBeInTheDocument();
    expect(screen.queryByText(/ツールの結果をそのまま出しています/)).not.toBeInTheDocument();
  });
});
