import { vi } from 'vitest';
import { jsonResponse } from './fixtures';

// 会話の履歴（ログイン中だけ）のテストの共通の部品。偽の JWT（署名なし。画面が読むのは exp だけ）と、URL ごとに応答を決める fetch の入れ物。

const b64url = (value: object) => btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** exp（秒）を持つ偽の JWT。tag を変えると、別のトークンになる（取り直したことを見分けるため） */
export function fakeJwt(exp: number, tag = 'a'): string {
  return `${b64url({ alg: 'ES256' })}.${b64url({ exp, tag })}.signature`;
}

/** いまから seconds 秒後に切れる偽の JWT */
export function jwtExpiringIn(seconds: number, tag = 'a'): string {
  return fakeJwt(Math.floor(Date.now() / 1000) + seconds, tag);
}

export interface Call {
  method: string;
  /** クエリを含む URL */
  url: string;
  /** クエリを除いた URL（パス） */
  path: string;
  headers: Headers;
  /** 本文（JSON のとき） */
  body: unknown;
  /** credentials など、init のそのままの値 */
  init: RequestInit | undefined;
}

type Responder = (call: Call, nth: number) => Response | Promise<Response>;

/**
 * 「メソッド パス」ごとに応答を決める fetch。決めていない経路は、404 の JSON を返す（呼ばれたことは calls に残る）。
 * on('GET /api/x', responder) の responder は、その経路の何回目の呼び出しか（nth。0 から）も受け取る
 */
export function createFetchRouter() {
  const responders = new Map<string, Responder>();
  const counts = new Map<string, number>();
  const calls: Call[] = [];
  const fn = vi.fn<typeof fetch>(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.split('?')[0] ?? url;
    let body: unknown;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const call: Call = { method, url, path, headers: new Headers(init?.headers), body, init };
    calls.push(call);
    const key = `${method} ${path}`;
    const nth = counts.get(key) ?? 0;
    counts.set(key, nth + 1);
    const responder = responders.get(key);
    if (!responder) return jsonResponse({ error: { code: 'not_found', message: '経路がありません' } }, 404);
    return responder(call, nth);
  });
  return {
    fn,
    calls,
    on(key: string, responder: Responder | Response) {
      responders.set(key, typeof responder === 'function' ? responder : () => responder.clone());
    },
    /** その経路（「メソッド パス」）が呼ばれた回数 */
    count(key: string) {
      return counts.get(key) ?? 0;
    },
    /** その経路の呼び出し（古い順） */
    to(key: string) {
      return calls.filter((c) => `${c.method} ${c.path}` === key);
    },
    /** パスが prefix で始まる呼び出しの数（履歴の API・トークンを、一度も呼んでいないことの確認に使う） */
    countPrefix(prefix: string) {
      return calls.filter((c) => c.path.startsWith(prefix)).length;
    },
  };
}

export type FetchRouter = ReturnType<typeof createFetchRouter>;

/** 応答を、あとから返す（途中の状態を確かめるため）。resolve で返す */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
