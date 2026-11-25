// 履歴の API（と、conversation_id つきのチャット）へ渡す JWT（仕様 §2.3.6）。DocuNavi の authFetch.ts・betterAuth.ts と同じ考え方。
// ブラウザーが同じオリジンの GET /api/auth/token（Better Auth の jwt プラグイン。Cookie のセッションがあれば {token} を返す）で JWT を取り、Authorization: Bearer で送る。
// - トークンは**メモリにだけ**置く（localStorage・sessionStorage・URL・ログ・例外の文に出さない）。
// - 期限（JWT は 15 分）の 60 秒前になったら、使う前に取り直す。同時に何本の要求があっても、取りに行くのは 1 回。
// - API が 401 を返したら、1 回だけ取り直して送り直す。それでも 401 なら、ログインが切れたと見る（SessionExpiredError）。
// - トークンを取れなかったのが通信の失敗・5xx のときは、ログアウトとは見ない（TokenUnavailableError。再試行を促す）。
// ログインしていない人の画面では、ここを一度も呼ばない（呼ぶかどうかは、サーバーの layout が決めた真偽値。components/HistoryProvider.tsx）。

/** JWT を取る入口（web 自身の Route Handler。api へは転送しない。proxy.ts） */
export const TOKEN_PATH = '/api/auth/token';

/** 期限のこの秒数前になったら、使う前に取り直す（DocuNavi の REFRESH_MARGIN_SECONDS） */
export const REFRESH_MARGIN_SECONDS = 60;

/** ログインが切れた: トークンを取れない（セッションが無い・無効）、または取り直して送っても 401 */
export class SessionExpiredError extends Error {
  constructor() {
    super('session expired');
    this.name = 'SessionExpiredError';
  }
}

/** トークンを取れなかったのが、通信の失敗・サーバーの不調（ログアウトとは限らない一時的な失敗） */
export class TokenUnavailableError extends Error {
  constructor() {
    super('token unavailable');
    this.name = 'TokenUnavailableError';
  }
}

interface Cached {
  token: string;
  /** 期限（秒。JWT の exp）。読めなければ 0（毎回取り直す） */
  exp: number;
}

let cached: Cached | null = null;
let inflight: Promise<string | null> | null = null;

/** JWT の exp（秒）。読めなければ 0 */
function expiresAt(token: string): number {
  try {
    const payload = token.split('.')[1] ?? '';
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp : 0;
  } catch {
    return 0;
  }
}

/** 4xx（ただし 408・429 を除く）は「セッションが無い・無効」。それ以外（5xx・混雑）は、ログアウトとは限らない一時的な失敗 */
function isSessionRejected(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

async function requestToken(): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(TOKEN_PATH, { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
  } catch {
    // 通信の失敗。キャッシュは残す（期限内のトークンは、まだ使える）
    throw new TokenUnavailableError();
  }
  if (!res.ok) {
    if (!isSessionRejected(res.status)) throw new TokenUnavailableError();
    cached = null;
    return null;
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new TokenUnavailableError();
  }
  const token = body && typeof body === 'object' && 'token' in body ? (body as { token?: unknown }).token : null;
  if (typeof token !== 'string' || token === '') {
    cached = null;
    return null;
  }
  cached = { token, exp: expiresAt(token) };
  return token;
}

/** 同時に何本が要求しても、取りに行くのは 1 回（同じ結果を共有する） */
function fetchToken(): Promise<string | null> {
  inflight ??= requestToken().finally(() => {
    inflight = null;
  });
  return inflight;
}

function fresh(entry: Cached | null): entry is Cached {
  return entry !== null && entry.exp - Math.floor(Date.now() / 1000) > REFRESH_MARGIN_SECONDS;
}

/**
 * 送る直前のトークン。期限の 60 秒前までは、持っているものを返す。
 * セッションが無いときは null。通信の失敗・5xx のときは TokenUnavailableError
 */
export async function getAccessToken(): Promise<string | null> {
  if (fresh(cached)) return cached.token;
  return fetchToken();
}

/**
 * 401 のあとの取り直し。failed は、401 を返されたトークン。
 * 別の要求がすでに取り直していれば（持っているトークンが failed と違い、期限内なら）、それを使う（同時の 401 で、取りに行くのを 1 回に保つ）
 */
export async function refreshAccessToken(failed: string): Promise<string | null> {
  if (fresh(cached) && cached.token !== failed) return cached.token;
  return fetchToken();
}

/** 持っているトークンを捨てる（ログインしていない状態になったとき・期限切れと見たとき） */
export function clearAccessToken(): void {
  cached = null;
}

function withToken(init: RequestInit | undefined, token: string): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${token}`);
  return { ...init, headers };
}

/**
 * ログイン中のトークンを付けて fetch する。
 * 401 が返ったら、1 回だけ取り直して送り直す。それでも 401（または取り直せない）なら SessionExpiredError。
 * 本文は文字列（JSON）なので、送り直しても同じ内容になる。401 以外の応答は、そのまま返す（呼び出し側が見る）
 */
export async function fetchAuthorized(input: string, init?: RequestInit): Promise<Response> {
  const token = await getAccessToken();
  if (!token) throw new SessionExpiredError();
  const first = await fetch(input, withToken(init, token));
  if (first.status !== 401) return first;
  const next = await refreshAccessToken(token);
  if (!next) throw new SessionExpiredError();
  const second = await fetch(input, withToken(init, next));
  if (second.status === 401) throw new SessionExpiredError();
  return second;
}
