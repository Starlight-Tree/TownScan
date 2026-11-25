'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { MSG_SESSION_EXPIRED } from '../lib/api';
import type { ConversationSummary } from '../lib/api-types';
import { clearConversationId, readConversationId, writeConversationId } from '../lib/conversation-session';
import { useHistory } from './HistoryProvider';
import { TrashIcon } from './icons';
import { useConversationStatus, useOpenConversation, useStartNewConversation } from './NewConversation';

// 会話の履歴の一覧（サイドパネルの「新しい会話」の下・アカウントの上。仕様 §7.1）。見た目・クラス名・文言は DocuNavi の ThreadSidebar（`thread-*`）と同じ。
// 領域の名前（読み上げ）は「会話の一覧」。DocuNavi は <aside> だが、TownScan はサイドパネル（<aside>）の中に置くので、ランドマークが二重にならないよう <section> にする。

export const MSG_NO_CONVERSATIONS = 'まだ会話がありません。質問を送ると、ここに並びます。';
export const MSG_SIGNED_OUT = 'ログインすると、会話を保存して、ここから開き直せます。';
export const MSG_NOT_CONFIGURED = 'ログインを設定していない環境では、会話は保存されません。';
export const MSG_EXPIRED = MSG_SESSION_EXPIRED;

/** 一覧の見せ方（仕様 §7.1.2 の 6 つの状態。DocuNavi の 'unavailable' は、TownScan では「未ログイン」と「設定なし」の 2 つに分かれる） */
export type ConversationsView =
  | { status: 'not-configured' }
  | { status: 'signed-out' }
  | { status: 'expired' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; conversations: ConversationSummary[] };

interface ViewProps {
  view: ConversationsView;
  /** いま開いている会話の ID。まだ一覧に無い（始めたばかり）こともある */
  currentId: string | null;
  /** 回答の生成中。この間は、開いている会話を削除できず、別の会話にも移れない（生成が止まってしまうため） */
  busy: boolean;
  onSelect: (id: string) => void;
  /** 削除する。失敗したときは、利用者向けの文を返す（成功は null） */
  onDelete: (id: string) => Promise<string | null>;
  onRetry: () => void;
}

/** 更新時刻（DocuNavi の formatTime と同じ。ja-JP・月日と時分）。読めない値は空 */
function formatTime(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function ConversationListView({ view, currentId, busy, onSelect, onDelete, onRetry }: ViewProps) {
  // 削除の確認は、その場で 2 段階にする（誤って押しても消えない）
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const confirmDelete = async (id: string) => {
    // 生成中は、開いている会話を消せない（確認に入ったあとに送信を始めた場合も。消すと、生成が止まり、画面が空になる。仕様 §7.1.3・§7.1.6 の 4）
    if (busy && id === currentId) return;
    setDeleteError(null);
    setConfirmingId(null);
    setDeleteError(await onDelete(id));
  };

  return (
    <section className="thread-sidebar" aria-label="会話の一覧">
      <h2 className="thread-sidebar-title">会話の履歴</h2>

      {deleteError && view.status === 'ready' && (
        <p className="thread-sidebar-error" role="alert">
          {deleteError}
        </p>
      )}

      {view.status === 'not-configured' && <p className="thread-sidebar-note">{MSG_NOT_CONFIGURED}</p>}

      {view.status === 'signed-out' && (
        <div className="thread-sidebar-note">
          <p>{MSG_SIGNED_OUT}</p>
          <Link href="/login">Google でログイン</Link>
        </div>
      )}

      {view.status === 'expired' && (
        <div className="thread-sidebar-note">
          <p>{MSG_EXPIRED}</p>
          <Link href="/login">Google でログイン</Link>
        </div>
      )}

      {view.status === 'loading' && (
        <p className="thread-sidebar-note" role="status">
          読み込み中…
        </p>
      )}

      {view.status === 'error' && (
        <div className="thread-sidebar-note">
          <p role="alert">{view.message}</p>
          <button type="button" className="btn btn--small" onClick={onRetry}>
            再読み込み
          </button>
        </div>
      )}

      {view.status === 'ready' && view.conversations.length === 0 && <p className="thread-sidebar-note">{MSG_NO_CONVERSATIONS}</p>}

      {view.status === 'ready' && view.conversations.length > 0 && (
        <ul className="thread-list">
          {view.conversations.map((conversation) => {
            const current = conversation.id === currentId;
            const confirming = confirmingId === conversation.id;
            return (
              <li key={conversation.id} className="thread-item" data-current={current ? 'true' : undefined}>
                <button
                  type="button"
                  className="thread-open"
                  aria-current={current ? 'true' : undefined}
                  title={conversation.title}
                  disabled={busy && !current}
                  onClick={() => onSelect(conversation.id)}
                >
                  <span className="thread-title">{conversation.title}</span>
                  <span className="thread-time">{formatTime(conversation.updated_at)}</span>
                </button>
                {confirming ? (
                  <span className="thread-confirm">
                    <button type="button" className="btn btn--small thread-confirm-yes" disabled={current && busy} onClick={() => void confirmDelete(conversation.id)}>
                      削除する
                    </button>
                    <button type="button" className="btn btn--small" onClick={() => setConfirmingId(null)}>
                      やめる
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="thread-delete"
                    aria-label={`「${conversation.title}」を削除`}
                    title="削除"
                    disabled={current && busy}
                    onClick={() => {
                      setDeleteError(null);
                      setConfirmingId(conversation.id);
                    }}
                  >
                    <TrashIcon />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * サイドパネルの会話の一覧（ログイン中だけ。状態の出し分けは、仕様 §7.1.2）。
 * 未ログイン・ログインを使えない設定・期限切れのときは、履歴の API を呼ばず、案内だけを出す（呼ばないのは HistoryProvider が保つ）。
 * 項目を押すと、チャットがその会話を開き直す。ホーム以外のページ（精度）では、会話 ID を書いてからホームへ移る（チャットが立ち上がるときに開き直す）。
 */
export function ConversationList() {
  const router = useRouter();
  const history = useHistory();
  const { currentId, busy } = useConversationStatus();
  const open = useOpenConversation();
  const startNew = useStartNewConversation();

  let view: ConversationsView;
  if (history.expired) view = { status: 'expired' };
  else if (!history.loggedIn) view = { status: history.loginAvailable ? 'signed-out' : 'not-configured' };
  else {
    const { state } = history.list;
    // 取りに行かない状態（一覧を出さない幅）でも、ここは出さない側で描かないので、読み込み中として扱って構わない
    view = state.status === 'unavailable' ? { status: 'loading' } : state;
  }

  const select = (id: string) => {
    if (open(id)) return;
    writeConversationId(id);
    router.push('/');
  };

  const remove = async (id: string): Promise<string | null> => {
    const failure = await history.list.remove(id);
    // 開いていた会話（ほかのページにいるときは、覚えている会話）を消したら、画面も最初の状態に戻す
    if (failure === null && (id === currentId || id === readConversationId())) {
      if (!startNew()) clearConversationId();
    }
    return failure;
  };

  return <ConversationListView view={view} currentId={currentId} busy={busy} onSelect={select} onDelete={remove} onRetry={history.list.reload} />;
}
