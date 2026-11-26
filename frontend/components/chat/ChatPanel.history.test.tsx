import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatResponse, ConversationSummary, StoredMessage, ToolResult } from '../../lib/api-types';
import { clearAccessToken } from '../../lib/auth-token';
import { CONVERSATION_ID_KEY, readConversationId, writeConversationId } from '../../lib/conversation-session';
import { count, detectionImage, health, jsonResponse, mapFocus, provenance, refusal, table } from '../../tests/fixtures';
import { createFetchRouter, deferred, jwtExpiringIn, type FetchRouter } from '../../tests/history-helpers';
import { AppSidebar } from '../AppSidebar';
import { HealthProvider } from '../HealthProvider';
import { HistoryProvider } from '../HistoryProvider';
import { NewConversationProvider } from '../NewConversation';
import { ChatPanel } from './ChatPanel';
import {
  MSG_CONVERSATION_FULL,
  MSG_NOT_SAVED,
  MSG_NOT_SAVED_EXPIRED,
  MSG_RESTORE_FAILED,
  MSG_RESTORE_NOT_FOUND,
  MSG_RESTORING,
  MSG_STALE_PHOTO,
  MSG_STALE_RUN,
} from './conversation';

// 会話の履歴（ログイン中だけ。仕様 §7.1・§2.3.4・§2.3.6）の、チャットの側の検査。サイドパネルの一覧（AppSidebar）・チャット・health を、本物の部品でつなぎ、fetch だけを差し替える

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: nav.push }), usePathname: () => '/' }));

const c = (id: string, title: string): ConversationSummary => ({ id, title, created_at: '2026-11-25T01:00:00+00:00', updated_at: '2026-11-25T01:05:00+00:00' });
const LIST = [c('c1', '2018 年は未検出の候補は何件ありますか？'), c('c2', '地区ごとの候補数を比べて')];

const reply = (content: string, results: ToolResult[] = []): ChatResponse => ({
  message: { role: 'assistant', content, results, tool_calls: [{ name: 'count_candidates', args: {} }] },
});
const user = (content: string): StoredMessage => ({ role: 'user', content });
const answer = (content: string, results: ToolResult[] = [], runCreatedAt: string | null = '2026-11-24T12:00:00+09:00'): StoredMessage => ({
  role: 'assistant',
  content,
  results,
  tool_calls: [],
  run_created_at: runCreatedAt,
});
const errorBody = (code: string, message = '固定の文') => ({ error: { code, message } });

let router: FetchRouter;
let tokenCount = 0;
const actions = { expand: vi.fn() };
const onNewConversation = vi.fn();
const renderFigure = vi.fn((answerRef: { id: string }, kind: string) => <div data-testid="figure" data-kind={kind} data-answer={answerRef.id} />);

function Harness({ loggedIn = true, loginAvailable = true }: { loggedIn?: boolean; loginAvailable?: boolean }): ReactNode {
  return (
    <HealthProvider>
      <HistoryProvider loggedIn={loggedIn} loginAvailable={loginAvailable}>
        <NewConversationProvider>
          <AppSidebar brand="TownScan" brandHref="/" navLabel="主なページ" />
          <ChatPanel actions={actions} renderFigure={renderFigure} onNewConversation={onNewConversation} />
        </NewConversationProvider>
      </HistoryProvider>
    </HealthProvider>
  );
}

beforeEach(() => {
  clearAccessToken();
  window.sessionStorage.clear();
  nav.push.mockReset();
  actions.expand.mockReset();
  onNewConversation.mockReset();
  renderFigure.mockClear();
  tokenCount = 0;
  router = createFetchRouter();
  router.on('GET /api/health', () => jsonResponse(health));
  router.on('GET /api/auth/token', () => jsonResponse({ token: jwtExpiringIn(900, `t${++tokenCount}`) }));
  router.on('GET /api/conversations', () => jsonResponse({ conversations: LIST }));
  router.on('POST /api/chat', () => jsonResponse(reply('回答です。')));
  vi.stubGlobal('fetch', router.fn);
});
afterEach(() => vi.unstubAllGlobals());

const chatRegion = () => screen.getByRole('region', { name: 'チャット' });
const input = () => screen.getByRole('textbox', { name: '質問を入力' });
const ask = async (text: string) => {
  await userEvent.type(input(), `${text}{Enter}`);
};
const chatBody = (n: number) => router.to('POST /api/chat')[n]?.body as { messages: Array<{ role: string; content: string }>; conversation_id?: string };
/** サイドパネルの「新しい会話」（会話が 1 件以上あると、チャット列にも同じ名前のボタンが出る） */
const sideNewConversation = () => within(screen.getByRole('complementary')).getByRole('button', { name: '新しい会話' });
const welcome = () => screen.queryByRole('heading', { name: /写真と会話で調べる/ });
const listItem = (title: string) => screen.findByTitle(title);

describe('ログインしていない: 今までどおり（履歴の API も /api/auth/token も呼ばない）', () => {
  it('conversation_id も Authorization も付けず、sessionStorage も書かない。トークンも履歴の API も一度も呼ばない', async () => {
    render(<Harness loggedIn={false} />);
    await ask('何件ありますか？');
    expect(await screen.findByText('回答です。')).toBeInTheDocument();
    expect(chatBody(0)).toEqual({ messages: [{ role: 'user', content: '何件ありますか？' }] });
    expect(router.to('POST /api/chat')[0]?.headers.get('authorization')).toBeNull();
    expect(router.countPrefix('/api/auth/token')).toBe(0);
    expect(router.countPrefix('/api/conversations')).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    // 2 回目も同じ
    await ask('続き');
    await waitFor(() => expect(router.count('POST /api/chat')).toBe(2));
    expect(chatBody(1)).not.toHaveProperty('conversation_id');
  });

  it('前のログインで残った会話 ID は、見ずに消す（開き直さない）', async () => {
    writeConversationId('c1');
    render(<Harness loggedIn={false} />);
    await waitFor(() => expect(readConversationId()).toBeNull());
    expect(router.countPrefix('/api/conversations')).toBe(0);
    expect(router.countPrefix('/api/auth/token')).toBe(0);
    expect(welcome()).toBeInTheDocument();
    expect(screen.queryByText(MSG_RESTORING)).not.toBeInTheDocument();
  });

  it('ログインを使えない設定でも同じ（案内だけ。何も呼ばない）', async () => {
    render(<Harness loggedIn={false} loginAvailable={false} />);
    await ask('何件ありますか？');
    await screen.findByText('回答です。');
    expect(router.countPrefix('/api/auth/token')).toBe(0);
    expect(router.countPrefix('/api/conversations')).toBe(0);
    expect(screen.getByText('ログインを設定していない環境では、会話は保存されません。')).toBeInTheDocument();
  });
});

describe('ログイン中: 保存（conversation_id）', () => {
  it('新しい会話の最初の送信で、crypto.randomUUID の ID を作って付ける。JWT を Authorization: Bearer で送る', async () => {
    render(<Harness />);
    await ask('何件ありますか？');
    await screen.findByText('回答です。');
    const [call] = router.to('POST /api/chat');
    expect(call?.headers.get('authorization')).toMatch(/^Bearer /);
    expect(chatBody(0).conversation_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(chatBody(0).messages).toEqual([{ role: 'user', content: '何件ありますか？' }]);
  });

  it('ID を sessionStorage に書くのは、conversation_id つきで送った最初の回答が届いたとき（届く前は書かない）。同じ会話の次の送信は、同じ ID', async () => {
    const gate = deferred<Response>();
    router.on('POST /api/chat', (_c, nth) => (nth === 0 ? gate.promise : jsonResponse(reply('二つ目の回答'))));
    render(<Harness />);
    await ask('ひとつめ');
    await waitFor(() => expect(router.count('POST /api/chat')).toBe(1));
    expect(window.sessionStorage.getItem(CONVERSATION_ID_KEY)).toBeNull();
    gate.resolve(jsonResponse(reply('一つ目の回答')));
    await screen.findByText('一つ目の回答');
    const id = chatBody(0).conversation_id!;
    expect(window.sessionStorage.getItem(CONVERSATION_ID_KEY)).toBe(id);
    await ask('ふたつめ');
    await screen.findByText('二つ目の回答');
    expect(chatBody(1).conversation_id).toBe(id);
    expect(chatBody(1).messages.map((m) => m.content)).toEqual(['ひとつめ', '一つ目の回答', 'ふたつめ']);
  });

  it('回答が届いたら、一覧を取り直す（最初の 1 回 + 回答のあとの 1 回）', async () => {
    render(<Harness />);
    await screen.findByTitle('2018 年は未検出の候補は何件ありますか？');
    expect(router.count('GET /api/conversations')).toBe(1);
    await ask('何件ありますか？');
    await screen.findByText('回答です。');
    await waitFor(() => expect(router.count('GET /api/conversations')).toBe(2));
  });

  it('最初の送信が失敗したら、ID は書かない。「もう一度送る」は同じ ID で送り、届いたら書く', async () => {
    router.on('POST /api/chat', (_c, nth) => (nth === 0 ? jsonResponse(errorBody('internal_error', 'わざとのエラーです。'), 500) : jsonResponse(reply('今度は届きました'))));
    render(<Harness />);
    await ask('何件ありますか？');
    const alert = await within(chatRegion()).findByRole('alert');
    expect(alert).toHaveTextContent('わざとのエラーです。');
    expect(window.sessionStorage.getItem(CONVERSATION_ID_KEY)).toBeNull();
    await userEvent.click(within(alert).getByRole('button', { name: 'もう一度送る' }));
    await screen.findByText('今度は届きました');
    expect(chatBody(1).conversation_id).toBe(chatBody(0).conversation_id);
    expect(window.sessionStorage.getItem(CONVERSATION_ID_KEY)).toBe(chatBody(0).conversation_id);
  });

  it('「新しい会話」で ID を忘れる（sessionStorage を消す）。次に送るとき、新しい ID を作る', async () => {
    render(<Harness />);
    await ask('ひとつめ');
    await screen.findByText('回答です。');
    const first = chatBody(0).conversation_id!;
    // サイドパネルの「新しい会話」
    await userEvent.click(sideNewConversation());
    await waitFor(() => expect(window.sessionStorage.getItem(CONVERSATION_ID_KEY)).toBeNull());
    expect(welcome()).toBeInTheDocument();
    await ask('ふたつめ');
    await waitFor(() => expect(router.count('POST /api/chat')).toBe(2));
    expect(chatBody(1).conversation_id).not.toBe(first);
    expect(chatBody(1).messages).toEqual([{ role: 'user', content: 'ふたつめ' }]);
  });

  it('1 つの返答待ちの間（生成中）に、サイドパネルの一覧は、別の会話へ移れない・開いている会話を消せない', async () => {
    const gate = deferred<Response>();
    router.on('GET /api/conversations/c1/messages', () => jsonResponse({ messages: [user('前の質問'), answer('前の回答')] }));
    render(<Harness />);
    await userEvent.click(await listItem('2018 年は未検出の候補は何件ありますか？'));
    await screen.findByText('前の回答');
    router.on('POST /api/chat', () => gate.promise);
    await ask('続きの質問');
    await waitFor(() => expect(router.count('POST /api/chat')).toBe(1));
    expect(screen.getByTitle('地区ごとの候補数を比べて')).toBeDisabled();
    expect(screen.getByRole('button', { name: '「2018 年は未検出の候補は何件ありますか？」を削除' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '「地区ごとの候補数を比べて」を削除' })).toBeEnabled();
    gate.resolve(jsonResponse(reply('続きの回答')));
    await screen.findByText('続きの回答');
    await waitFor(() => expect(screen.getByTitle('地区ごとの候補数を比べて')).toBeEnabled());
    expect(screen.getByRole('button', { name: '「2018 年は未検出の候補は何件ありますか？」を削除' })).toBeEnabled();
  });
});

describe('ログインの確認が通らないとき（仕様 §7.1.7）', () => {
  it('401 は、1 回だけトークンを取り直して送り直す。通れば、そのまま保存される（注記なし）', async () => {
    router.on('POST /api/chat', (_c, nth) => (nth === 0 ? jsonResponse(errorBody('unauthorized', 'ログインしてください'), 401) : jsonResponse(reply('通りました'))));
    render(<Harness />);
    await ask('何件ありますか？');
    await screen.findByText('通りました');
    expect(router.count('POST /api/chat')).toBe(2);
    expect(router.count('GET /api/auth/token')).toBe(2);
    expect(chatBody(1).conversation_id).toBe(chatBody(0).conversation_id);
    expect(router.to('POST /api/chat')[0]?.headers.get('authorization')).not.toBe(router.to('POST /api/chat')[1]?.headers.get('authorization'));
    expect(screen.queryByText(MSG_NOT_SAVED)).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem(CONVERSATION_ID_KEY)).toBe(chatBody(0).conversation_id);
  });

  it('取り直しても 401 なら、conversation_id を外して（保存せずに）送り直し、回答の下に注記を 1 回だけ出す。以降も付けず、注記は繰り返さない。LLM を呼ぶのは最後の 1 回だけ', async () => {
    router.on('POST /api/chat', (call) => (call.headers.get('authorization') ? jsonResponse(errorBody('unauthorized', 'ログインしてください'), 401) : jsonResponse(reply(`回答（付けない: ${!('conversation_id' in (call.body as object))}）`))));
    render(<Harness />);
    await ask('ひとつめ');
    await screen.findByText('回答（付けない: true）');
    // 送った順: 付けて 401 → 取り直して付けて 401 → 付けずに 200
    expect(router.count('POST /api/chat')).toBe(3);
    expect(chatBody(0)).toHaveProperty('conversation_id');
    expect(chatBody(1)).toHaveProperty('conversation_id');
    expect(chatBody(2)).not.toHaveProperty('conversation_id');
    expect(router.to('POST /api/chat')[2]?.headers.get('authorization')).toBeNull();
    expect(screen.getAllByText(MSG_NOT_SAVED)).toHaveLength(1);
    expect(window.sessionStorage.getItem(CONVERSATION_ID_KEY)).toBeNull();
    // 画面は「ログインしていない」扱い: 一覧は期限切れの案内
    expect(await screen.findByText('ログインの有効期限が切れました。ログインし直してください。')).toBeInTheDocument();

    const tokenCalls = router.count('GET /api/auth/token');
    router.on('POST /api/chat', () => jsonResponse(reply('二つ目の回答')));
    await ask('ふたつめ');
    await screen.findByText('二つ目の回答');
    expect(chatBody(3)).not.toHaveProperty('conversation_id');
    expect(router.to('POST /api/chat')[3]?.headers.get('authorization')).toBeNull();
    // 以降は、トークンも取りに行かない・注記も繰り返さない・保存もしない
    expect(router.count('GET /api/auth/token')).toBe(tokenCalls);
    expect(screen.getAllByText(MSG_NOT_SAVED)).toHaveLength(1);
    expect(window.sessionStorage.getItem(CONVERSATION_ID_KEY)).toBeNull();
  });

  it('保存を飛ばした会話は、「新しい会話」で戻らない（期限切れのまま）。ログインしていない扱いなので、新しい会話にも付けない', async () => {
    router.on('POST /api/chat', (call) => (call.headers.get('authorization') ? jsonResponse(errorBody('unauthorized'), 401) : jsonResponse(reply('回答'))));
    render(<Harness />);
    await ask('ひとつめ');
    await screen.findByText('回答');
    await userEvent.click(sideNewConversation());
    await ask('ふたつめ');
    await waitFor(() => expect(router.count('POST /api/chat')).toBe(4));
    expect(chatBody(3)).not.toHaveProperty('conversation_id');
  });

  it('ログインの期限切れが先に分かっているとき（一覧の 401）は、送信の前から conversation_id を付けず、回答に注記を 1 回だけ出す。新しい会話でも、1 回だけ出す', async () => {
    router.on('GET /api/conversations', () => jsonResponse(errorBody('unauthorized', 'ログインしてください'), 401));
    render(<Harness />);
    expect(await screen.findByText('ログインの有効期限が切れました。ログインし直してください。')).toBeInTheDocument();
    await ask('ひとつめ');
    await screen.findByText('回答です。');
    expect(router.count('POST /api/chat')).toBe(1); // 送り直し（LLM の 2 回目）は無い
    expect(chatBody(0)).not.toHaveProperty('conversation_id');
    expect(router.to('POST /api/chat')[0]?.headers.get('authorization')).toBeNull();
    expect(screen.getAllByText(MSG_NOT_SAVED_EXPIRED)).toHaveLength(1);
    await ask('ふたつめ');
    await waitFor(() => expect(router.count('POST /api/chat')).toBe(2));
    await waitFor(() => expect(screen.getAllByText('回答です。')).toHaveLength(2));
    expect(screen.getAllByText(MSG_NOT_SAVED_EXPIRED)).toHaveLength(1); // 繰り返さない
    await userEvent.click(sideNewConversation());
    expect(screen.queryByText(MSG_NOT_SAVED_EXPIRED)).not.toBeInTheDocument(); // 前の会話の画面は消える
    await ask('新しい会話');
    await waitFor(() => expect(router.count('POST /api/chat')).toBe(3));
    expect(await screen.findByText(MSG_NOT_SAVED_EXPIRED)).toBeInTheDocument(); // 新しい会話の最初の回答にだけ、もう 1 回
    expect(chatBody(2)).not.toHaveProperty('conversation_id');
  });

  it('保存を飛ばして送り直した 2 回目が失敗して「もう一度送る」になっても、成功した回答に注記が付く（1 回だけ）', async () => {
    let plain = 0;
    router.on('POST /api/chat', (call) => {
      if (call.headers.get('authorization')) return jsonResponse(errorBody('unavailable', 'いまはログインを確認できません'), 503);
      return plain++ === 0 ? jsonResponse(errorBody('llm_unavailable', 'いまは LLM が応答できません'), 502) : jsonResponse(reply('やっと届いた回答'));
    });
    render(<Harness />);
    await ask('ひとつめ');
    const alert = await within(chatRegion()).findByRole('alert');
    expect(screen.queryByText(MSG_NOT_SAVED)).not.toBeInTheDocument();
    await userEvent.click(within(alert).getByRole('button', { name: 'もう一度送る' }));
    await screen.findByText('やっと届いた回答');
    expect(chatBody(2)).not.toHaveProperty('conversation_id');
    expect(screen.getAllByText(MSG_NOT_SAVED)).toHaveLength(1);
  });

  it('保存つきで送って失敗しても、一覧を取り直す（サーバーは保存していたかもしれない）', async () => {
    router.on('POST /api/chat', () => jsonResponse(errorBody('internal_error', 'サーバー内部のエラーです'), 500));
    render(<Harness />);
    await listItem(LIST[0]!.title);
    const before = router.count('GET /api/conversations');
    await ask('ひとつめ');
    await within(chatRegion()).findByRole('alert');
    await waitFor(() => expect(router.count('GET /api/conversations')).toBe(before + 1));
  });

  it('ログインの確認だけが 503（code unavailable）のときも、保存せずに送り直し、同じ注記と同じ規則。ログインが切れたとは見ない（一覧はそのまま）', async () => {
    router.on('POST /api/chat', (call) => (call.headers.get('authorization') ? jsonResponse(errorBody('unavailable', 'いまはログインを確認できません'), 503) : jsonResponse(reply('保存なしの回答'))));
    render(<Harness />);
    await ask('ひとつめ');
    await screen.findByText('保存なしの回答');
    expect(router.count('POST /api/chat')).toBe(2);
    expect(chatBody(1)).not.toHaveProperty('conversation_id');
    expect(screen.getAllByText(MSG_NOT_SAVED)).toHaveLength(1);
    expect(window.sessionStorage.getItem(CONVERSATION_ID_KEY)).toBeNull();
    // 同じ会話の以降の送信にも付けない
    router.on('POST /api/chat', () => jsonResponse(reply('二つ目')));
    await ask('ふたつめ');
    await screen.findByText('二つ目');
    expect(chatBody(2)).not.toHaveProperty('conversation_id');
    expect(screen.getAllByText(MSG_NOT_SAVED)).toHaveLength(1);
    expect(screen.queryByText('ログインの有効期限が切れました。ログインし直してください。')).not.toBeInTheDocument();
    // 取り直し（トークン）は 503 では行わない
    expect(router.count('GET /api/auth/token')).toBe(1);
  });

  it('DB が使えない 503（db_unavailable）は、送り直さない。「もう一度送る」は、同じ conversation_id で送る（保存を飛ばしたことにならない）', async () => {
    router.on('POST /api/chat', (_c, nth) => (nth === 0 ? jsonResponse(errorBody('db_unavailable', 'DB に接続できません'), 503) : jsonResponse(reply('届きました'))));
    render(<Harness />);
    await ask('ひとつめ');
    const alert = await within(chatRegion()).findByRole('alert');
    expect(alert).toHaveTextContent('DB に接続できません');
    expect(router.count('POST /api/chat')).toBe(1);
    expect(screen.queryByText(MSG_NOT_SAVED)).not.toBeInTheDocument();
    await userEvent.click(within(alert).getByRole('button', { name: 'もう一度送る' }));
    await screen.findByText('届きました');
    expect(chatBody(1).conversation_id).toBe(chatBody(0).conversation_id);
    expect(screen.queryByText(MSG_NOT_SAVED)).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem(CONVERSATION_ID_KEY)).toBe(chatBody(0).conversation_id);
  });

  it('トークンを取れなかったのが通信・5xx のとき（auth_unavailable）は、ログアウトとは見ない。質問は送らず、「もう一度送る」で再試行を促す', async () => {
    render(<Harness />);
    await screen.findByTitle('2018 年は未検出の候補は何件ありますか？');
    clearAccessToken();
    router.on('GET /api/auth/token', () => jsonResponse({}, 502));
    await ask('ひとつめ');
    const alert = await within(chatRegion()).findByRole('alert');
    expect(alert).toHaveTextContent('ログイン状態を確認できませんでした。通信を確認して、もう一度お試しください。');
    expect(router.count('POST /api/chat')).toBe(0);
    expect(screen.queryByText(MSG_NOT_SAVED)).not.toBeInTheDocument();
    router.on('GET /api/auth/token', () => jsonResponse({ token: jwtExpiringIn(900, 'again') }));
    await userEvent.click(within(alert).getByRole('button', { name: 'もう一度送る' }));
    await screen.findByText('回答です。');
    expect(chatBody(0)).toHaveProperty('conversation_id');
  });

  it('1 会話の発言数の上限（422 conversation_full）: 文と「新しい会話」を出し、「もう一度送る」は出さない。押すと最初の状態に戻る', async () => {
    router.on('POST /api/chat', () => jsonResponse({ error: { code: 'conversation_full', message: MSG_CONVERSATION_FULL, details: [] } }, 422));
    render(<Harness />);
    await ask('ひとつめ');
    const alert = await within(chatRegion()).findByRole('alert');
    expect(alert).toHaveTextContent('この会話は長くなりすぎました。新しい会話を始めてください');
    expect(within(alert).queryByRole('button', { name: 'もう一度送る' })).not.toBeInTheDocument();
    expect(router.count('POST /api/chat')).toBe(1);
    await userEvent.click(within(alert).getByRole('button', { name: '新しい会話' }));
    expect(welcome()).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('保存した会話を開き直す（仕様 §7.1.4）', () => {
  it('一覧の項目を押す: 取得の間は説明（Welcome）でなく「これまでのやり取りを読み込んでいます…」（role=status）。並べ終えるまで aria-busy。届いたら、保存された値のまま並べる', async () => {
    const gate = deferred<Response>();
    router.on('GET /api/conversations/c1/messages', () => gate.promise);
    render(<Harness />);
    expect(welcome()).toBeInTheDocument();
    await userEvent.click(await listItem('2018 年は未検出の候補は何件ありますか？'));
    const status = await within(chatRegion()).findByRole('status');
    expect(status).toHaveTextContent(MSG_RESTORING);
    expect(MSG_RESTORING).toBe('これまでのやり取りを読み込んでいます…');
    expect(welcome()).not.toBeInTheDocument();
    expect(screen.getByRole('log')).toHaveAttribute('aria-busy', 'true');
    // 開いている会話に印が付き、ID を sessionStorage に書く。拡大ビューは「新しい会話」と同じに閉じる（回答ごとの状態を捨てる）
    expect(screen.getByTitle('2018 年は未検出の候補は何件ありますか？')).toHaveAttribute('aria-current', 'true');
    expect(window.sessionStorage.getItem(CONVERSATION_ID_KEY)).toBe('c1');
    expect(onNewConversation).toHaveBeenCalledTimes(1);

    gate.resolve(jsonResponse({ messages: [user('何件ありますか？'), answer('件数です。', [count, table])] }));
    expect(await screen.findByText('件数です。')).toBeInTheDocument();
    expect(screen.getByText('何件ありますか？')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: count.title })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: table.title })).toBeInTheDocument();
    expect(screen.queryByText(MSG_RESTORING)).not.toBeInTheDocument();
    expect(screen.getByRole('log')).toHaveAttribute('aria-busy', 'false');
    // 質問に、時刻は付かない（保存していない）
    expect(chatRegion().querySelector('time')).toBeNull();
    // 拡大ビューは開かず、画面は替えない（回答の中の図は、回答の中に出る）
    expect(actions.expand).not.toHaveBeenCalled();
    expect(renderFigure).toHaveBeenCalled();
    expect(router.to('GET /api/conversations/c1/messages')[0]?.headers.get('authorization')).toMatch(/^Bearer /);
  });

  it('開き直したあとの続きは、画面の発言（保存された分を含む）を送り、同じ conversation_id を付ける', async () => {
    router.on('GET /api/conversations/c1/messages', () => jsonResponse({ messages: [user('前の質問'), answer('前の回答')] }));
    render(<Harness />);
    await userEvent.click(await listItem('2018 年は未検出の候補は何件ありますか？'));
    await screen.findByText('前の回答');
    await ask('続きの質問');
    await screen.findByText('回答です。');
    expect(chatBody(0).conversation_id).toBe('c1');
    expect(chatBody(0).messages).toEqual([
      { role: 'user', content: '前の質問' },
      { role: 'assistant', content: '前の回答' },
      { role: 'user', content: '続きの質問' },
    ]);
    expect(window.sessionStorage.getItem(CONVERSATION_ID_KEY)).toBe('c1');
  });

  it('失敗: 文（role=alert）と「再試行」「新しい会話」。会話 ID は捨てない。再試行で並べられる', async () => {
    router.on('GET /api/conversations/c1/messages', (_c, nth) => (nth === 0 ? jsonResponse(errorBody('db_unavailable'), 503) : jsonResponse({ messages: [user('前の質問'), answer('前の回答')] })));
    render(<Harness />);
    await userEvent.click(await listItem('2018 年は未検出の候補は何件ありますか？'));
    const alert = await within(chatRegion()).findByRole('alert');
    expect(alert).toHaveTextContent(MSG_RESTORE_FAILED);
    expect(MSG_RESTORE_FAILED).toBe('過去のやり取りを読み込めませんでした。もう一度読み込むか、新しい会話を始めてください。');
    expect(window.sessionStorage.getItem(CONVERSATION_ID_KEY)).toBe('c1');
    expect(welcome()).not.toBeInTheDocument();
    await userEvent.click(within(alert).getByRole('button', { name: '再試行' }));
    expect(await screen.findByText('前の回答')).toBeInTheDocument();
    expect(within(chatRegion()).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('失敗のとき「新しい会話」で、会話 ID を忘れて最初の状態へ戻る', async () => {
    router.on('GET /api/conversations/c1/messages', () => jsonResponse(errorBody('internal_error'), 500));
    render(<Harness />);
    await userEvent.click(await listItem('2018 年は未検出の候補は何件ありますか？'));
    const alert = await within(chatRegion()).findByRole('alert');
    await userEvent.click(within(alert).getByRole('button', { name: '新しい会話' }));
    expect(welcome()).toBeInTheDocument();
    expect(window.sessionStorage.getItem(CONVERSATION_ID_KEY)).toBeNull();
  });

  it('404（会話が無い）は、失敗と分けた文を出し、会話 ID を忘れる（再試行は出さない）。続けて質問すれば、新しい会話になる', async () => {
    router.on('GET /api/conversations/c1/messages', () => jsonResponse(errorBody('not_found', '会話が見つかりません'), 404));
    render(<Harness />);
    await userEvent.click(await listItem('2018 年は未検出の候補は何件ありますか？'));
    const alert = await within(chatRegion()).findByRole('alert');
    expect(alert).toHaveTextContent(MSG_RESTORE_NOT_FOUND);
    expect(MSG_RESTORE_NOT_FOUND).toBe('この会話は見つかりませんでした。削除されたか、保存の上限（1 人 50 件・最後の動きから 7 日）で消えた可能性があります。');
    expect(within(alert).queryByRole('button')).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem(CONVERSATION_ID_KEY)).toBeNull();
    expect(screen.getByTitle('2018 年は未検出の候補は何件ありますか？')).not.toHaveAttribute('aria-current');
    await ask('新しい質問');
    await screen.findByText('回答です。');
    expect(chatBody(0).conversation_id).not.toBe('c1');
    expect(chatBody(0).conversation_id).toBeTruthy();
    expect(within(chatRegion()).queryByText(MSG_RESTORE_NOT_FOUND)).not.toBeInTheDocument();
  });

  it('取得の間に別の会話へ移ったら、遅れて届いた結果は捨てる', async () => {
    const a = deferred<Response>();
    router.on('GET /api/conversations/c1/messages', () => a.promise);
    router.on('GET /api/conversations/c2/messages', () => jsonResponse({ messages: [user('B の質問'), answer('B の回答')] }));
    render(<Harness />);
    await userEvent.click(await listItem('2018 年は未検出の候補は何件ありますか？'));
    await within(chatRegion()).findByRole('status');
    await userEvent.click(screen.getByTitle('地区ごとの候補数を比べて'));
    expect(await screen.findByText('B の回答')).toBeInTheDocument();
    a.resolve(jsonResponse({ messages: [user('A の質問'), answer('A の回答')] }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByText('A の回答')).not.toBeInTheDocument();
    expect(screen.getByText('B の回答')).toBeInTheDocument();
    expect(window.sessionStorage.getItem(CONVERSATION_ID_KEY)).toBe('c2');
  });

  it('取得の間に新しい会話にした・送信を始めたなら、遅れて届いた結果は捨てる', async () => {
    const a = deferred<Response>();
    router.on('GET /api/conversations/c1/messages', () => a.promise);
    render(<Harness />);
    await userEvent.click(await listItem('2018 年は未検出の候補は何件ありますか？'));
    await within(chatRegion()).findByRole('status');
    await userEvent.click(sideNewConversation());
    a.resolve(jsonResponse({ messages: [user('A の質問'), answer('A の回答')] }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByText('A の回答')).not.toBeInTheDocument();
    expect(welcome()).toBeInTheDocument();

    // 送信を始めた場合
    const b = deferred<Response>();
    router.on('GET /api/conversations/c2/messages', () => b.promise);
    await userEvent.click(screen.getByTitle('地区ごとの候補数を比べて'));
    await within(chatRegion()).findByRole('status');
    await ask('急ぎの質問');
    await screen.findByText('回答です。');
    b.resolve(jsonResponse({ messages: [user('B の質問'), answer('B の回答')] }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByText('B の回答')).not.toBeInTheDocument();
    expect(screen.getByText('急ぎの質問')).toBeInTheDocument();
  });

  it('再読み込み・ホームへ戻った立ち上がりで、覚えている会話 ID があれば、自動で開き直す（拡大ビューの片づけは呼ばない）', async () => {
    writeConversationId('c2');
    router.on('GET /api/conversations/c2/messages', () => jsonResponse({ messages: [user('立ち上がりの質問'), answer('立ち上がりの回答')] }));
    render(<Harness />);
    expect(await screen.findByText('立ち上がりの回答')).toBeInTheDocument();
    expect(router.count('GET /api/conversations/c2/messages')).toBe(1);
    expect(onNewConversation).not.toHaveBeenCalled();
    expect(await screen.findByTitle('地区ごとの候補数を比べて')).toHaveAttribute('aria-current', 'true');
    expect(window.sessionStorage.getItem(CONVERSATION_ID_KEY)).toBe('c2');
  });

  it('立ち上がりで 404 なら、文を出して ID を忘れる', async () => {
    writeConversationId('c9');
    router.on('GET /api/conversations/c9/messages', () => jsonResponse(errorBody('not_found'), 404));
    render(<Harness />);
    expect(await within(chatRegion()).findByRole('alert')).toHaveTextContent(MSG_RESTORE_NOT_FOUND);
    expect(window.sessionStorage.getItem(CONVERSATION_ID_KEY)).toBeNull();
  });

  it('形が違う ID（壊れた値）は、取りに行かず消す', async () => {
    window.sessionStorage.setItem(CONVERSATION_ID_KEY, '../etc');
    render(<Harness />);
    await screen.findByTitle('2018 年は未検出の候補は何件ありますか？');
    expect(router.countPrefix('/api/conversations/')).toBe(0);
    expect(window.sessionStorage.getItem(CONVERSATION_ID_KEY)).toBeNull();
    expect(welcome()).toBeInTheDocument();
  });

  it('開き直しで、取り直しても 401 なら、ログインが切れた扱い（一覧は期限切れの案内）。会話 ID は捨てない', async () => {
    writeConversationId('c1');
    router.on('GET /api/conversations/c1/messages', () => jsonResponse(errorBody('unauthorized', 'ログインしてください'), 401));
    render(<Harness />);
    expect(await within(chatRegion()).findByText(MSG_RESTORE_FAILED)).toBeInTheDocument();
    expect(await screen.findByText('ログインの有効期限が切れました。ログインし直してください。')).toBeInTheDocument();
  });

  it('削除: 開いていた会話を消したら、画面も最初の状態に戻る（会話 ID を忘れる）。別の会話を消しても、いまの画面はそのまま', async () => {
    let remaining = [...LIST];
    router.on('GET /api/conversations', () => jsonResponse({ conversations: remaining }));
    router.on('DELETE /api/conversations/c2', () => {
      remaining = remaining.filter((x) => x.id !== 'c2');
      return new Response(null, { status: 204 });
    });
    router.on('DELETE /api/conversations/c1', () => {
      remaining = remaining.filter((x) => x.id !== 'c1');
      return new Response(null, { status: 204 });
    });
    router.on('GET /api/conversations/c1/messages', () => jsonResponse({ messages: [user('前の質問'), answer('前の回答')] }));
    render(<Harness />);
    await userEvent.click(await listItem('2018 年は未検出の候補は何件ありますか？'));
    await screen.findByText('前の回答');
    // 別の会話を消す
    await userEvent.click(screen.getByRole('button', { name: '「地区ごとの候補数を比べて」を削除' }));
    await userEvent.click(screen.getByRole('button', { name: '削除する' }));
    await waitFor(() => expect(screen.queryByTitle('地区ごとの候補数を比べて')).not.toBeInTheDocument());
    expect(screen.getByText('前の回答')).toBeInTheDocument();
    expect(window.sessionStorage.getItem(CONVERSATION_ID_KEY)).toBe('c1');
    // 開いている会話を消す
    await userEvent.click(screen.getByRole('button', { name: '「2018 年は未検出の候補は何件ありますか？」を削除' }));
    await userEvent.click(screen.getByRole('button', { name: '削除する' }));
    await waitFor(() => expect(welcome()).toBeInTheDocument());
    expect(screen.queryByText('前の回答')).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem(CONVERSATION_ID_KEY)).toBeNull();
    expect(await screen.findByText('まだ会話がありません。質問を送ると、ここに並びます。')).toBeInTheDocument();
  });
});

describe('開き直した会話の、解析結果（run）の食い違い（仕様 §7.1.5）', () => {
  const RUN_AT = '2026-11-24T12:00:00+09:00';
  const open = async (messages: StoredMessage[]) => {
    router.on('GET /api/conversations/c1/messages', () => jsonResponse({ messages }));
    render(<Harness />);
    await userEvent.click(await listItem('2018 年は未検出の候補は何件ありますか？'));
    await screen.findByText('回答（保存）');
  };
  const results = [count, table, mapFocus, detectionImage, refusal];

  it('いまの run と同じ（run_id も run_created_at も。時刻の表記が違っても同じ時刻）なら、ボタンも図も使える。注意書きは出ない', async () => {
    await open([user('質問'), answer('回答（保存）', results, '2026-11-24T03:00:00Z')]);
    expect(screen.queryByText(MSG_STALE_RUN)).not.toBeInTheDocument();
    for (const name of [/^詳細/, '地図で見る', '詳細を開く']) {
      for (const button of screen.getAllByRole('button', { name })) expect(button).toBeEnabled();
    }
    expect(screen.getAllByTestId('figure').length).toBeGreaterThan(0);
    expect(chatRegion().querySelector('img')).not.toBeNull();
  });

  it('run_id が同じでも run_created_at が違えば、別の解析結果: 注意書きを 1 行、ボタンは押せず、図は出さず、写真は読み込まない。カードの数字・文は保存された値のまま', async () => {
    await open([user('質問'), answer('回答（保存）', results, '2026-11-24T12:00:01+09:00')]);
    const note = screen.getByRole('note', { name: '' });
    expect(note).toHaveTextContent(MSG_STALE_RUN);
    expect(MSG_STALE_RUN).toBe('この会話の一部は、いまとは別の解析結果に基づいています。件数や地図は、いまのデータと食い違うことがあります。');
    expect(screen.getAllByText(MSG_STALE_RUN)).toHaveLength(1);
    // 会話の先頭（回答より前）
    const first = chatRegion().querySelector('.chat__scroll')!.firstElementChild;
    expect(first).toBe(note);
    for (const button of [...screen.getAllByRole('button', { name: /^詳細（/ }), screen.getByRole('button', { name: '地図で見る' }), screen.getByRole('button', { name: '詳細を開く' })]) {
      expect(button).toBeDisabled();
    }
    expect(screen.queryByTestId('figure')).not.toBeInTheDocument();
    expect(renderFigure).not.toHaveBeenCalled();
    expect(chatRegion().querySelector('img')).toBeNull();
    expect(screen.getByText(MSG_STALE_PHOTO)).toBeInTheDocument();
    // 数字・題名は、保存された値のまま
    expect(screen.getByRole('region', { name: count.title })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: count.title }).querySelector('.count-value')).toHaveTextContent('33');
    expect(screen.getByRole('region', { name: table.title })).toBeInTheDocument();
    // 質問の例のボタン（ask）は、新しい質問を送るだけなので、そのまま使える
    const suggestion = within(screen.getByRole('note', { name: /お答えできません|範囲外|お断り/ })).getAllByRole('button')[0]!;
    expect(suggestion).toBeEnabled();
    expect(actions.expand).not.toHaveBeenCalled();
  });

  it('run_id が違う回答・provenance があるのに run_created_at が null の回答も、別の解析結果', async () => {
    const otherRun: ToolResult = { ...count, provenance: { ...provenance, run_id: 'run-other' } };
    await open([user('質問'), answer('回答（保存）', [otherRun], RUN_AT)]);
    expect(screen.getByText(MSG_STALE_RUN)).toBeInTheDocument();
  });

  it('run_created_at が null（run が無かった回答）でも、provenance があれば別の解析結果', async () => {
    await open([user('質問'), answer('回答（保存）', [count], null)]);
    expect(screen.getByText(MSG_STALE_RUN)).toBeInTheDocument();
  });

  it('お断り（refusal）だけの回答は、run に依らないので、別の解析結果とは見ない', async () => {
    await open([user('質問'), answer('回答（保存）', [refusal], null)]);
    expect(screen.queryByText(MSG_STALE_RUN)).not.toBeInTheDocument();
  });

  it('health が取れないときも、別の解析結果と見る（食い違いを見せない側に倒す）', async () => {
    router.on('GET /api/health', () => jsonResponse(errorBody('internal_error'), 500));
    await open([user('質問'), answer('回答（保存）', [count, mapFocus], RUN_AT)]);
    expect(await screen.findByText(MSG_STALE_RUN)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '地図で見る' })).toBeDisabled();
    expect(screen.queryByTestId('figure')).not.toBeInTheDocument();
  });

  it('health の読み込みが終わるまでは、ボタンを押せず、図も出さない（注意書きはまだ出さない）。終わって食い違いが無ければ、使える', async () => {
    const gate = deferred<Response>();
    router.on('GET /api/health', () => gate.promise);
    await open([user('質問'), answer('回答（保存）', [count, mapFocus], RUN_AT)]);
    expect(screen.getByRole('button', { name: '地図で見る' })).toBeDisabled();
    expect(screen.queryByTestId('figure')).not.toBeInTheDocument();
    expect(screen.queryByText(MSG_STALE_RUN)).not.toBeInTheDocument();
    gate.resolve(jsonResponse(health));
    await waitFor(() => expect(screen.getByRole('button', { name: '地図で見る' })).toBeEnabled());
    expect(screen.getAllByTestId('figure').length).toBeGreaterThan(0);
    expect(screen.queryByText(MSG_STALE_RUN)).not.toBeInTheDocument();
  });

  it('開き直した会話に続けて送った新しい回答は、食い違いの対象にしない（別の解析結果の回答だけが押せない）', async () => {
    router.on('POST /api/chat', () => jsonResponse(reply('新しい回答', [mapFocus])));
    await open([user('質問'), answer('回答（保存）', [mapFocus], '2020-01-01T00:00:00Z')]);
    await ask('続き');
    await screen.findByText('新しい回答');
    const buttons = screen.getAllByRole('button', { name: '地図で見る' });
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toBeDisabled();
    expect(buttons[1]).toBeEnabled();
    expect(screen.getAllByTestId('figure')).toHaveLength(1);
  });
});
