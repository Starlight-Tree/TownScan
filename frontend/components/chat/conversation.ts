import { ApiError } from '../../lib/api';
import type { HealthResponse, StoredMessage } from '../../lib/api-types';
import type { AsyncState } from '../../lib/use-api';
import type { ChatEntry } from './types';

// チャットの、会話の履歴（ログイン中だけ。仕様 §7.1）まわりの、状態を持たない部品。文言は仕様の案のとおり（ユーザー決定済みのものと、DocuNavi と同じ文言を含む）

/** 開き直しの取得中（DocuNavi と同じ文言） */
export const MSG_RESTORING = 'これまでのやり取りを読み込んでいます…';
/** 開き直しの失敗（DocuNavi と同じ文言） */
export const MSG_RESTORE_FAILED = '過去のやり取りを読み込めませんでした。もう一度読み込むか、新しい会話を始めてください。';
/** 開き直しの 404（失敗と分ける。7 日の掃除は手で流すので、「可能性」で書く。仕様 §7.1.4 の 5） */
export const MSG_RESTORE_NOT_FOUND =
  'この会話は見つかりませんでした。削除されたか、保存の上限（1 人 50 件・最後の動きから 7 日）で消えた可能性があります。';
/** 保存を飛ばした回答に、1 回だけ出す注記（仕様 §7.1.7） */
export const MSG_NOT_SAVED = 'ログインを確認できなかったため、この回答から保存されません。続きを保存するには、新しい会話を始めてください。';
/** ログインの期限切れが先に分かっているとき（一覧・開き直しの 401）に、保存しない回答へ 1 回だけ出す注記。ログインし直すまで、新しい会話でも保存されない */
export const MSG_NOT_SAVED_EXPIRED = 'ログインの有効期限が切れているため、この回答は保存されません。ログインし直すと、会話を保存できます。';
/** 1 会話の発言数の上限（422 conversation_full）。再送しても直らない */
export const MSG_CONVERSATION_FULL = 'この会話は長くなりすぎました。新しい会話を始めてください';
/** 別の解析結果に基づく回答があるとき、会話の先頭に出す 1 行（仕様 §7.1.5） */
export const MSG_STALE_RUN = 'この会話の一部は、いまとは別の解析結果に基づいています。件数や地図は、いまのデータと食い違うことがあります。';
/** 別の解析結果の検出画像カード（写真は読み込まない。仕様 §7.1.5 の〔J5〕） */
export const MSG_STALE_PHOTO = '別の解析結果の写真は表示しません';
/** 別の解析結果の回答の、押せないボタンの説明（title） */
export const MSG_STALE_BUTTON = '別の解析結果に基づく回答なので、開けません';

/** 保存した発言を、画面の発言（ChatEntry）に並べる。回答は、保存された results・tool_calls をそのまま持つ（値を作り直さない） */
export function entriesFromStored(messages: readonly StoredMessage[], newId: () => string): ChatEntry[] {
  return messages.map<ChatEntry>((m) =>
    m.role === 'user'
      ? { id: newId(), role: 'user', content: m.content }
      : { id: newId(), role: 'assistant', content: m.content, results: m.results, tool_calls: m.tool_calls, restored: { runCreatedAt: m.run_created_at } },
  );
}

/**
 * 保存を飛ばして送り直す失敗か（仕様 §7.1.7）: ログインの確認が通らなかった。
 * 401（取り直しても 401。lib/auth-token.ts）と、ログインの確認だけが 503（JWKS に届かない・設定が無い。code は unavailable）。
 * DB が使えない 503（db_unavailable）は含めない（チャット自体が DB を使うので、送り直さない）
 */
export function isLoginCheckFailure(error: unknown): error is ApiError {
  return error instanceof ApiError && (error.status === 401 || (error.status === 503 && error.code === 'unavailable'));
}

// ---- 開き直した会話の、解析結果（run）の食い違い（仕様 §7.1.5） ----

/** いまの解析結果。health の読み込みが終わるまでは pending、取れなかった・run が無いときは unknown（食い違いを見せない側に倒す） */
export type CurrentRun = { status: 'pending' } | { status: 'unknown' } | { status: 'known'; runId: string; createdAt: number };

export function currentRunFrom(health: AsyncState<HealthResponse>): CurrentRun {
  if (health.status === 'loading') return { status: 'pending' };
  if (health.status === 'error') return { status: 'unknown' };
  const run = health.data.run;
  if (!run || typeof run.run_id !== 'string') return { status: 'unknown' };
  const createdAt = Date.parse(run.created_at);
  return Number.isNaN(createdAt) ? { status: 'unknown' } : { status: 'known', runId: run.run_id, createdAt };
}

/** 結果が持つ provenance.run_id（refusal には provenance が無い。形が壊れていれば '' で、どの run とも一致しない）。provenance が無ければ null */
function provenanceRunId(result: unknown): string | null {
  if (!result || typeof result !== 'object' || !('provenance' in result)) return null;
  const provenance = (result as { provenance?: unknown }).provenance;
  if (!provenance || typeof provenance !== 'object') return null;
  const runId = (provenance as { run_id?: unknown }).run_id;
  return typeof runId === 'string' ? runId : '';
}

/** 開き直した回答が、いまの解析結果に基づくか。fresh=基づく（または run に依らない）・stale=食い違う・pending=health の読み込み待ち */
export type RunCheck = 'fresh' | 'stale' | 'pending';

/**
 * 回答ごとに、作ったときの run といまの run を比べる:
 * - 作ったとき: 結果の provenance.run_id と、その回答の run_created_at。
 * - run_id が同じでも、run_created_at が違えば別の解析結果（ローダーは同じ run_id の行を消して入れ直す）。時刻は文字列でなく Date.parse のミリ秒で比べる。
 * - provenance があるのに run_created_at が null なら、別の解析結果（安全側）。refusal だけ（provenance が無い）の回答は、run に依らないので別とは見ない。
 * - いまの run が分からない（health の取得に失敗・run が無い）ときも別の解析結果と見る。
 * 開き直した回答（restored）だけを調べる。この画面で届いた回答は、いまの API が作ったものなので調べない
 */
export function runCheck(entry: ChatEntry, current: CurrentRun): RunCheck {
  if (entry.role !== 'assistant' || !entry.restored) return 'fresh';
  const ids = (entry.results ?? []).map(provenanceRunId).filter((id): id is string => id !== null);
  if (ids.length === 0) return 'fresh';
  if (current.status === 'pending') return 'pending';
  if (current.status === 'unknown') return 'stale';
  const createdAt = entry.restored.runCreatedAt === null ? Number.NaN : Date.parse(entry.restored.runCreatedAt);
  if (Number.isNaN(createdAt) || createdAt !== current.createdAt) return 'stale';
  return ids.every((id) => id === current.runId) ? 'fresh' : 'stale';
}
