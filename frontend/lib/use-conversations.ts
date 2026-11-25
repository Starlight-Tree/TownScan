'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConversationSummary } from './api-types';
import { conversationErrorKind, deleteConversation, listConversations } from './conversations-api';

const MSG_LIST_FAILED = '会話の一覧を取得できませんでした。しばらく待ってから再試行してください。';
const MSG_DELETE_FAILED = '会話を削除できませんでした。しばらく待ってから再試行してください。';

export type ConversationsState =
  /** 取りに行かない（ログインしていない・ログインが切れた・一覧を出さない幅）。読み込み中ではない */
  | { status: 'unavailable' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; conversations: ConversationSummary[] };

export interface UseConversations {
  state: ConversationsState;
  /** 一覧を取り直す。取り直している間も、前の一覧を出し続ける（ちらつかせない。DocuNavi の useThreads と同じ） */
  reload: () => void;
  /** 会話を消して、一覧を取り直す。失敗したら、利用者向けの文を返す（成功は null）。404 は成功（すでに無い） */
  remove: (id: string) => Promise<string | null>;
}

/** 履歴を持たない画面（Provider が無い単体のテスト・ログインしていない人）の、何もしない一覧 */
export const UNAVAILABLE_CONVERSATIONS: UseConversations = { state: { status: 'unavailable' }, reload: () => {}, remove: async () => null };

/**
 * 会話の一覧（GET /api/conversations）と削除。enabled が偽の間は何も呼ばず、unavailable を返す
 * （ログインしていない人の画面で、/api/auth/token・/api/conversations を呼ばないための唯一の入口）。
 * 取り直しても 401（ログインが切れた）のときは、onExpired を呼ぶ（画面が「ログインしていない」扱いにする。仕様 §7.1.7）
 */
export function useConversations(enabled: boolean, onExpired: () => void): UseConversations {
  const [loaded, setLoaded] = useState<ConversationsState>({ status: 'loading' });
  const [round, setRound] = useState(0);
  // 呼び出し側の関数は、取得のたびに作り直されうる。最新のものを控えて使う（取得の条件にしない）
  const expiredRef = useRef(onExpired);
  useEffect(() => {
    expiredRef.current = onExpired;
  });

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    listConversations(controller.signal).then(
      (conversations) => {
        if (!controller.signal.aborted) setLoaded({ status: 'ready', conversations });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        if (conversationErrorKind(error) === 'unauthorized') expiredRef.current();
        setLoaded({ status: 'error', message: MSG_LIST_FAILED });
      },
    );
    return () => controller.abort();
  }, [enabled, round]);

  const reload = useCallback(() => setRound((n) => n + 1), []);

  const remove = useCallback(async (id: string): Promise<string | null> => {
    try {
      await deleteConversation(id);
    } catch (error) {
      if (conversationErrorKind(error) === 'unauthorized') expiredRef.current();
      return MSG_DELETE_FAILED;
    }
    setRound((n) => n + 1);
    return null;
  }, []);

  const state: ConversationsState = enabled ? loaded : { status: 'unavailable' };
  return { state, reload, remove };
}
