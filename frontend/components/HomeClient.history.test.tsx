import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CandidateFeature, ConversationSummary, StoredMessage, ToolResult } from '../lib/api-types';
import { clearAccessToken } from '../lib/auth-token';
import { CONVERSATION_ID_KEY, writeConversationId } from '../lib/conversation-session';
import { areas, count, compare, health, jsonResponse, mapFocus } from '../tests/fixtures';
import { createFetchRouter, jwtExpiringIn, type FetchRouter } from '../tests/history-helpers';
import { AppSidebar } from './AppSidebar';
import { HealthProvider } from './HealthProvider';
import { HistoryProvider } from './HistoryProvider';
import { HomeClient } from './HomeClient';
import { NewConversationProvider } from './NewConversation';

// 画面全体（サイドパネルの一覧 + ホームのチャット + 回答の中の図 + 拡大ビュー）で、保存した会話を開き直したときの振る舞い（仕様 §7.1.4・§7.1.5・E9 の「画面」）。
// 地図の本体（Leaflet）は別のテストで確かめる

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => '/' }));
vi.mock('./map/LeafletMap', () => ({ default: () => <div data-testid="leaflet" /> }));

const c = (id: string, title: string): ConversationSummary => ({ id, title, created_at: '2026-11-25T01:00:00+00:00', updated_at: '2026-11-25T01:05:00+00:00' });
const LIST = [c('c1', '新規出現の候補は何件ありますか？'), c('c2', '地区ごとの候補数を比べて')];
const user = (content: string): StoredMessage => ({ role: 'user', content });
const RUN_AT = '2026-11-24T12:00:00+09:00';
const answer = (content: string, results: ToolResult[], runCreatedAt: string | null = RUN_AT): StoredMessage => ({
  role: 'assistant',
  content,
  results,
  tool_calls: [],
  run_created_at: runCreatedAt,
});

let router: FetchRouter;

function Screen({ home = true }: { home?: boolean }) {
  return (
    <HealthProvider>
      <HistoryProvider loggedIn loginAvailable>
        <NewConversationProvider>
          <AppSidebar brand="TownScan" brandHref="/" navLabel="主なページ" />
          {home && <HomeClient />}
        </NewConversationProvider>
      </HistoryProvider>
    </HealthProvider>
  );
}

beforeEach(() => {
  clearAccessToken();
  window.sessionStorage.clear();
  router = createFetchRouter();
  router.on('GET /api/health', () => jsonResponse(health));
  router.on('GET /api/areas', () => jsonResponse(areas));
  router.on('GET /api/candidates.geojson', () => jsonResponse({ type: 'FeatureCollection', features: [] as CandidateFeature[] }));
  router.on('GET /api/auth/token', () => jsonResponse({ token: jwtExpiringIn(900) }));
  router.on('GET /api/conversations', () => jsonResponse({ conversations: LIST }));
  vi.stubGlobal('fetch', router.fn);
});
afterEach(() => vi.unstubAllGlobals());

describe('開き直した会話（画面全体）', () => {
  it('拡大ビューは開かず、画面は替わらない: 回答の中に図が出るだけ。フォーカスは、押した一覧のボタンに残す', async () => {
    router.on('GET /api/conversations/c1/messages', () => jsonResponse({ messages: [user('何件？'), answer('件数です。', [count, compare])] }));
    render(<Screen />);
    const item = await screen.findByTitle('新規出現の候補は何件ありますか？');
    await userEvent.click(item);
    expect(await screen.findByText('件数です。')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // 回答の中の図は、回答が届いたときと同じく、回答の中に出る（件数: 地図とグラフ・比較: グラフ。同じ回答の中では、種類ごとに 1 つ）
    expect(await screen.findAllByRole('region', { name: 'グラフ' })).toHaveLength(1);
    expect(screen.getAllByRole('region', { name: '地図' })).toHaveLength(1);
    // フォーカスは動かさない（押した一覧のボタンに残す）
    expect(item).toHaveFocus();
  });

  it('別の解析結果の回答は、図を出さず、ボタンを押せなくする。押しても拡大ビューは開かない', async () => {
    router.on('GET /api/conversations/c1/messages', () =>
      jsonResponse({ messages: [user('地図で'), answer('地図です。', [mapFocus], '2025-01-01T00:00:00Z')] }),
    );
    render(<Screen />);
    await userEvent.click(await screen.findByTitle('新規出現の候補は何件ありますか？'));
    await screen.findByText('地図です。');
    expect(screen.getByText(/別の解析結果に基づいています/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '地図' })).not.toBeInTheDocument();
    const button = screen.getByRole('button', { name: '地図で見る' });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('いまの解析結果の回答は、「地図で見る」で拡大ビューを開ける（押したときだけ）。開き直すとき、開いていた拡大ビューは閉じる前提（サイドパネルは後ろで操作できない）', async () => {
    router.on('GET /api/conversations/c1/messages', () => jsonResponse({ messages: [user('地図で'), answer('地図です。', [mapFocus])] }));
    render(<Screen />);
    await userEvent.click(await screen.findByTitle('新規出現の候補は何件ありますか？'));
    await screen.findByText('地図です。');
    await waitFor(() => expect(screen.getByRole('button', { name: '地図で見る' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: '地図で見る' }));
    expect(await screen.findByRole('dialog', { name: '結果' })).toBeInTheDocument();
  });

  it('再読み込み（立ち上がり）の自動の開き直しは、React の StrictMode（開発の二重実行）でも、並べ終える', async () => {
    writeConversationId('c2');
    router.on('GET /api/conversations/c2/messages', () => jsonResponse({ messages: [user('立ち上がりの質問'), answer('立ち上がりの回答', [])] }));
    render(
      <StrictMode>
        <Screen />
      </StrictMode>,
    );
    expect(await screen.findByText('立ち上がりの回答')).toBeInTheDocument();
    expect(screen.queryByText('これまでのやり取りを読み込んでいます…')).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem(CONVERSATION_ID_KEY)).toBe('c2');
    expect(screen.getByRole('log')).toHaveAttribute('aria-busy', 'false');
  });

  it('ホームから別のページへ移ってチャットが外れても、開いていた会話の印と ID は残る（戻ると開き直す）。生成中の印だけ消える', async () => {
    router.on('GET /api/conversations/c1/messages', () => jsonResponse({ messages: [user('何件？'), answer('件数です。', [])] }));
    const { rerender } = render(<Screen />);
    await userEvent.click(await screen.findByTitle('新規出現の候補は何件ありますか？'));
    await screen.findByText('件数です。');
    // ホームのチャットだけを外す（ほかのページへ移った状態。サイドパネルと各 Provider は残る）
    rerender(<Screen home={false} />);
    expect(screen.queryByText('件数です。')).not.toBeInTheDocument();
    const item = within(screen.getByRole('complementary')).getByTitle('新規出現の候補は何件ありますか？');
    expect(item).toHaveAttribute('aria-current', 'true');
    expect(item).toBeEnabled();
    expect(window.sessionStorage.getItem(CONVERSATION_ID_KEY)).toBe('c1');
    // ホームへ戻ると、覚えている会話を開き直す
    rerender(<Screen />);
    expect(await screen.findByText('件数です。')).toBeInTheDocument();
    expect(router.count('GET /api/conversations/c1/messages')).toBe(2);
  });
});
