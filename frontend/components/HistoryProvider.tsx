'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { clearAccessToken } from '../lib/auth-token';
import { UNAVAILABLE_CONVERSATIONS, useConversations, type UseConversations } from '../lib/use-conversations';

export interface HistoryValue {
  /** サーバーの layout が、currentUser() で 1 回だけ決めた真偽値（仕様 §2.3.6）。ログインの期限切れ（expired）になっても、この値は変わらない */
  loggedIn: boolean;
  /** ログインを使える設定か（isAuthConfigured()）。未ログインの人の一覧の文が、「ログインすると…」か「ログインを設定していない環境では…」かを決める */
  loginAvailable: boolean;
  /** 取り直しても 401 だった（ログインが切れた）。画面は「ログインしていない」扱いにする（仕様 §7.1.7） */
  expired: boolean;
  /**
   * 履歴の API・/api/auth/token を呼んでよいか（ログイン中で、期限切れでない）。偽なら、一度も呼ばず、conversation_id も付けない。
   * 会話の保存・開き直し・一覧は、すべてこの真偽値の下にある
   */
  active: boolean;
  /** ログインが切れたと見る（履歴の API・チャットが、取り直しても 401 だったとき） */
  markExpired: () => void;
  /** 会話の一覧と削除。active でない間は、取りに行かない */
  list: UseConversations;
}

const noop = () => {};
// Provider が無いとき（単体のテスト・ログインの画面）は、ログインしていない・ログインを使えない設定と同じ: 何も呼ばない
const DEFAULT_VALUE: HistoryValue = {
  loggedIn: false,
  loginAvailable: false,
  expired: false,
  active: false,
  markExpired: noop,
  list: UNAVAILABLE_CONVERSATIONS,
};

const HistoryContext = createContext<HistoryValue>(DEFAULT_VALUE);

/**
 * 会話の履歴（ログイン中だけ）の共通の状態。サーバーの layout が決めた「ログイン中か」を、画面の部品（サイドパネルの一覧・チャット）へ渡す。
 * ログインしていなければ（または期限切れなら）、/api/auth/token も /api/conversations も、一度も呼ばない。
 * 一覧は、幅によらず、ログイン中なら取りに行く（1024px 以上は左のサイドパネル、1023px 以下は重ねて開くパネルに出す。仕様 §7.1.1）。
 */
export function HistoryProvider({ loggedIn, loginAvailable, children }: { loggedIn: boolean; loginAvailable: boolean; children: ReactNode }) {
  const [expired, setExpired] = useState(false);
  const active = loggedIn && !expired;

  // ログインしていない（またはログインが切れた）状態になったら、持っているトークンを捨てる
  useEffect(() => {
    if (!active) clearAccessToken();
  }, [active]);

  const markExpired = useCallback(() => setExpired(true), []);
  const list = useConversations(active, markExpired);

  const value = useMemo<HistoryValue>(
    () => ({ loggedIn, loginAvailable, expired, active, markExpired, list }),
    [loggedIn, loginAvailable, expired, active, markExpired, list],
  );
  return <HistoryContext.Provider value={value}>{children}</HistoryContext.Provider>;
}

export function useHistory(): HistoryValue {
  return useContext(HistoryContext);
}
