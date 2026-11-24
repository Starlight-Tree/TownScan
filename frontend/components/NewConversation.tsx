'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';

type Handler = () => void;
type Control = {
  /** 「新しい会話」を受ける処理を登録する。返す関数で外す（後から登録したものを、先の後始末が消さない） */
  register: (handler: Handler) => () => void;
  /** 登録された処理を呼ぶ。登録が無ければ false（呼び出し側が、ホームへ移る） */
  trigger: () => boolean;
};

const NewConversationContext = createContext<Control | null>(null);

/**
 * サイドパネルの「新しい会話」と、ホームのチャットをつなぐ（DocuNavi と同じ位置のボタン。会話の状態はホームのチャットが持つので、枠の側から直接は消せない）。
 * ホームが開いている間だけ、チャットが処理を登録する。ほかのページでは登録が無いので、ボタンはホームへ移る（移ればチャットは新しく始まる）。
 */
export function NewConversationProvider({ children }: { children: ReactNode }) {
  const current = useRef<Handler | null>(null);
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
    }),
    [],
  );
  return <NewConversationContext.Provider value={control}>{children}</NewConversationContext.Provider>;
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
