'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

type Handler = () => void;
type OpenHandler = (id: string) => void;
type Control = {
  /** 「新しい会話」を受ける処理を登録する。返す関数で外す（後から登録したものを、先の後始末が消さない） */
  register: (handler: Handler) => () => void;
  /** 登録された処理を呼ぶ。登録が無ければ false（呼び出し側が、ホームへ移る） */
  trigger: () => boolean;
  /** 保存した会話を「開く」処理を登録する（会話の履歴。ログイン中だけ使う）。返す関数で外す */
  registerOpen: (handler: OpenHandler) => () => void;
  /** 登録された「開く」処理を呼ぶ。登録が無ければ false（呼び出し側が、会話 ID を書いてホームへ移る） */
  open: (id: string) => boolean;
};

/** チャットがサイドパネルの一覧へ知らせる、いまの会話の状態 */
export interface ConversationStatus {
  /** いま開いている（保存された）会話の ID。始めたばかりで、まだ保存されていない会話は null */
  currentId: string | null;
  /** 回答の生成中。この間は、開いている会話を削除できず、別の会話にも移れない（生成が止まってしまうため） */
  busy: boolean;
}

const IDLE_STATUS: ConversationStatus = { currentId: null, busy: false };

const NewConversationContext = createContext<Control | null>(null);
const StatusContext = createContext<{ status: ConversationStatus; setStatus: (next: ConversationStatus) => void }>({
  status: IDLE_STATUS,
  setStatus: () => {},
});

/**
 * サイドパネルと、ホームのチャットをつなぐ（DocuNavi と同じ位置の「新しい会話」と、会話の履歴の「開く」「いま開いている会話」「生成中」。会話の状態はホームのチャットが持つので、枠の側から直接は触れない）。
 * ホームが開いている間だけ、チャットが処理を登録する。ほかのページでは登録が無いので、「新しい会話」はホームへ移る（移ればチャットは新しく始まる）。一覧の項目は、会話 ID を書いてからホームへ移る。
 */
export function NewConversationProvider({ children }: { children: ReactNode }) {
  const current = useRef<Handler | null>(null);
  const opener = useRef<OpenHandler | null>(null);
  const control = useMemo<Control>(
    () => ({
      register: (handler) => {
        current.current = handler;
        return () => {
          if (current.current === handler) current.current = null;
        };
      },
      trigger: () => {
        if (!current.current) return false;
        current.current();
        return true;
      },
      registerOpen: (handler) => {
        opener.current = handler;
        return () => {
          if (opener.current === handler) opener.current = null;
        };
      },
      open: (id) => {
        if (!opener.current) return false;
        opener.current(id);
        return true;
      },
    }),
    [],
  );
  const [status, setStatusState] = useState<ConversationStatus>(IDLE_STATUS);
  const setStatus = useCallback(
    (next: ConversationStatus) => setStatusState((prev) => (prev.currentId === next.currentId && prev.busy === next.busy ? prev : next)),
    [],
  );
  const statusValue = useMemo(() => ({ status, setStatus }), [status, setStatus]);
  return (
    <NewConversationContext.Provider value={control}>
      <StatusContext.Provider value={statusValue}>{children}</StatusContext.Provider>
    </NewConversationContext.Provider>
  );
}

/** チャットが、「新しい会話」を受ける処理を登録する（Provider が無いとき・テストでは、何もしない） */
export function useRegisterNewConversation(handler: Handler): void {
  const control = useContext(NewConversationContext);
  useEffect(() => control?.register(handler), [control, handler]);
}

/** 「新しい会話」を始める。登録された処理があれば呼んで true、無ければ false */
export function useStartNewConversation(): () => boolean {
  const control = useContext(NewConversationContext);
  return useCallback(() => control?.trigger() ?? false, [control]);
}

/** チャットが、保存した会話を「開く」処理を登録する（Provider が無いとき・テストでは、何もしない） */
export function useRegisterConversationOpen(handler: OpenHandler): void {
  const control = useContext(NewConversationContext);
  useEffect(() => control?.registerOpen(handler), [control, handler]);
}

/** 保存した会話を開く。チャットが登録していれば呼んで true、無ければ false（呼び出し側が、会話 ID を書いてホームへ移る） */
export function useOpenConversation(): (id: string) => boolean {
  const control = useContext(NewConversationContext);
  return useCallback((id: string) => control?.open(id) ?? false, [control]);
}

/** チャットが知らせた、いまの会話の状態（サイドパネルの一覧が読む） */
export function useConversationStatus(): ConversationStatus {
  return useContext(StatusContext).status;
}

/**
 * チャットが、いまの会話の状態をサイドパネルへ知らせる。チャットが外れたとき（ほかのページへ移った）は、生成中でなくなる（通信も止まる）。
 * 開いていた会話の ID は残す（ホームへ戻ると、その会話を開き直す。仕様 §7.1.3）
 */
export function usePublishConversationStatus(currentId: string | null, busy: boolean): void {
  const { setStatus } = useContext(StatusContext);
  useEffect(() => {
    setStatus({ currentId, busy });
    return () => setStatus({ currentId, busy: false });
  }, [setStatus, currentId, busy]);
}
