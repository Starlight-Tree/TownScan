import { fetchAuthorized, SessionExpiredError, TokenUnavailableError } from './auth-token';
import type {
  AreaSummary,
  CandidateDetail,
  CandidateFeatureCollection,
  CandidateList,
  ChatRequestMessage,
  ChatResponse,
  HealthResponse,
  MetricsResponse,
} from './api-types';

// ブラウザのコードは、同じオリジンの /api/* だけを呼ぶ（転送は proxy.ts）。絶対 URL は書かない。
const BASE = '/api';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function parseError(res: Response): Promise<ApiError> {
  let code = `http_${res.status}`;
  let message = `サーバーがエラーを返しました（HTTP ${res.status}）。`;
  try {
    const body: unknown = await res.json();
    if (body && typeof body === 'object' && 'error' in body) {
      const err = (body as { error?: { code?: unknown; message?: unknown } }).error;
      if (err && typeof err.message === 'string') message = err.message;
      if (err && typeof err.code === 'string') code = err.code;
    }
  } catch {
    // 本文が JSON でない = API 自身の応答ではない（転送先に届かないときの Next のエラーなど）
    if (res.status >= 500) {
      message = `API に接続できません（HTTP ${res.status}）。API が起動しているか、API_URL を確かめてください。`;
      code = 'upstream_unreachable';
    }
  }
  return new ApiError(message, res.status, code);
}

/** ログインが切れたとき（取り直しても 401。lib/auth-token.ts）の文。履歴の API とチャットが、同じ文・同じ code（session_expired）で扱う */
export const MSG_SESSION_EXPIRED = 'ログインの有効期限が切れました。ログインし直してください。';
/** トークンを取れなかったのが通信・サーバーの不調のとき（ログアウトとは限らない）。再試行を促す */
const MSG_AUTH_UNAVAILABLE = 'ログイン状態を確認できませんでした。通信を確認して、もう一度お試しください。';

/**
 * 応答を返す（成功の応答だけ）。失敗は ApiError にする。authorized が真なら、ログイン中の JWT（Authorization: Bearer）を付ける（lib/auth-token.ts。401 は 1 回だけ取り直して送り直す）。
 * ログインの確認に失敗したときの code は、取り直しても 401 なら session_expired（status 401）、トークンを取れなかったのが通信・5xx なら auth_unavailable（status 0）。
 */
export async function sendRequest(path: string, init?: RequestInit, authorized = false): Promise<Response> {
  let res: Response;
  try {
    res = authorized ? await fetchAuthorized(`${BASE}${path}`, init) : await fetch(`${BASE}${path}`, init);
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    if (e instanceof SessionExpiredError) throw new ApiError(MSG_SESSION_EXPIRED, 401, 'session_expired');
    if (e instanceof TokenUnavailableError) throw new ApiError(MSG_AUTH_UNAVAILABLE, 0, 'auth_unavailable');
    throw new ApiError('サーバーに接続できませんでした。起動しているか確かめてください。', 0, 'network');
  }
  if (!res.ok) throw await parseError(res);
  return res;
}

async function request<T>(path: string, init?: RequestInit, authorized = false): Promise<T> {
  const res = await sendRequest(path, init, authorized);
  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiError('サーバーの応答を読めませんでした。', res.status, 'invalid_json');
  }
}

function query(params: Record<string, string | number | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined && v !== '') sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export function getHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return request('/health', { signal });
}

/** 地区の一覧。配列でも {items: [...]} でも受ける（仕様に形の指定が無いため） */
export async function getAreas(signal?: AbortSignal): Promise<AreaSummary[]> {
  const body = await request<AreaSummary[] | { items?: AreaSummary[]; areas?: AreaSummary[] }>('/areas', { signal });
  if (Array.isArray(body)) return body;
  return body.items ?? body.areas ?? [];
}

export function getCandidates(
  params: { area_id?: string | null; cls?: string | null; limit?: number; offset?: number },
  signal?: AbortSignal,
): Promise<CandidateList> {
  return request(`/candidates${query({ ...params, sort: 'area_desc' })}`, { signal });
}

export function getCandidatesGeoJson(
  params: { area_id?: string | null; cls?: string | null } = {},
  signal?: AbortSignal,
): Promise<CandidateFeatureCollection> {
  return request(`/candidates.geojson${query(params)}`, { signal });
}

export function getCandidate(id: string, signal?: AbortSignal): Promise<CandidateDetail> {
  return request(`/candidates/${encodeURIComponent(id)}`, { signal });
}

export function candidateImageUrl(id: string, year: number, size = 512): string {
  return `${BASE}/candidates/${encodeURIComponent(id)}/image${query({ year, size })}`;
}

export function getMetrics(signal?: AbortSignal): Promise<MetricsResponse> {
  return request('/metrics', { signal });
}

/**
 * 質問を送る。conversationId を渡すと（ログイン中の、会話を保存するとき。仕様 §2.3.4）、本文に conversation_id を足し、JWT を付けて送る。
 * 渡さなければ、今までと同じ（Authorization を付けない・conversation_id を足さない）
 */
export function postChat(messages: ChatRequestMessage[], signal?: AbortSignal, conversationId?: string): Promise<ChatResponse> {
  return request(
    '/chat',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(conversationId === undefined ? { messages } : { messages, conversation_id: conversationId }),
      signal,
    },
    conversationId !== undefined,
  );
}
