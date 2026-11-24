'use client';

import { useCallback, useEffect, useEffectEvent, useState } from 'react';
import { ApiError } from './api';

export type AsyncState<T> =
  | { status: 'loading' }
  | { status: 'error'; error: ApiError }
  | { status: 'ready'; data: T };

/**
 * 読み込み → 完了 / 失敗 を持つ取得フック。reload() で取り直す。
 * deps には、取得の条件になる文字列・数値だけを渡す（変わると取り直す）。
 */
export function useAsync<T>(load: (signal: AbortSignal) => Promise<T>, deps: readonly (string | number | null)[] = []) {
  const [nonce, setNonce] = useState(0);
  const [settled, setSettled] = useState<{ key: string; value: AsyncState<T> } | null>(null);
  const key = [nonce, ...deps].join('|');
  const run = useEffectEvent((signal: AbortSignal) => load(signal));

  useEffect(() => {
    const ctrl = new AbortController();
    run(ctrl.signal)
      .then((data) => {
        if (!ctrl.signal.aborted) setSettled({ key, value: { status: 'ready', data } });
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        const error = e instanceof ApiError ? e : new ApiError('読み込みに失敗しました。', 0, 'unknown');
        setSettled({ key, value: { status: 'error', error } });
      });
    return () => ctrl.abort();
  }, [key]);

  const state: AsyncState<T> = settled && settled.key === key ? settled.value : { status: 'loading' };
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { state, reload };
}
