import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/api';
import type { HealthResponse, ToolResult } from '../../lib/api-types';
import { count, detectionImage, health, mapFocus, provenance, refusal, table } from '../../tests/fixtures';
import { currentRunFrom, entriesFromStored, isLoginCheckFailure, runCheck, type CurrentRun } from './conversation';
import type { ChatEntry } from './types';

const RUN = { runId: 'run-test', created: '2026-11-24T12:00:00+09:00' };
const current: CurrentRun = { status: 'known', runId: RUN.runId, createdAt: Date.parse(RUN.created) };

const answer = (results: ToolResult[], runCreatedAt: string | null): ChatEntry => ({
  id: 'm1',
  role: 'assistant',
  content: '回答',
  results,
  tool_calls: [],
  restored: { runCreatedAt },
});

describe('解析結果（run）の食い違い（仕様 §7.1.5）', () => {
  it('run_id も run_created_at も同じなら、基づいている（表記が違っても、時刻として同じなら同じ）', () => {
    expect(runCheck(answer([count], '2026-11-24T12:00:00+09:00'), current)).toBe('fresh');
    expect(runCheck(answer([count], '2026-11-24T03:00:00Z'), current)).toBe('fresh');
    expect(runCheck(answer([count], '2026-11-24T03:00:00.000+00:00'), current)).toBe('fresh');
  });

  it('run_id が同じでも、run_created_at が違えば、別の解析結果（同じ run_id を後処理し直して読み込み直したとき）', () => {
    expect(runCheck(answer([count], '2026-11-24T12:00:01+09:00'), current)).toBe('stale');
    expect(runCheck(answer([table], '2026-11-25T03:00:00Z'), current)).toBe('stale');
  });

  it('run_id が違えば、別の解析結果', () => {
    const other: ToolResult = { ...count, provenance: { ...provenance, run_id: 'run-other' } };
    expect(runCheck(answer([other], '2026-11-24T12:00:00+09:00'), current)).toBe('stale');
    // 結果の 1 つでも違えば、その回答は別の解析結果
    expect(runCheck(answer([count, other], '2026-11-24T12:00:00+09:00'), current)).toBe('stale');
  });

  it('provenance があるのに run_created_at が null（または読めない）なら、別の解析結果（安全側）', () => {
    expect(runCheck(answer([count], null), current)).toBe('stale');
    expect(runCheck(answer([count], 'yesterday'), current)).toBe('stale');
  });

  it('お断り（refusal）だけの回答・結果が無い回答は、run に依らないので、別の解析結果とは見ない（health が取れなくても）', () => {
    expect(runCheck(answer([refusal], null), current)).toBe('fresh');
    expect(runCheck(answer([refusal], null), { status: 'unknown' })).toBe('fresh');
    expect(runCheck(answer([], null), { status: 'unknown' })).toBe('fresh');
    expect(runCheck(answer([refusal], null), { status: 'pending' })).toBe('fresh');
    // お断りと、provenance のある結果が混ざれば、後者で決まる
    expect(runCheck(answer([refusal, count], null), current)).toBe('stale');
  });

  it('いまの run が分からない（health の取得に失敗・run が無い）ときも、別の解析結果と見る。読み込み中は、まだ決めない（pending）', () => {
    expect(runCheck(answer([count], RUN.created), { status: 'unknown' })).toBe('stale');
    expect(runCheck(answer([count], RUN.created), { status: 'pending' })).toBe('pending');
  });

  it('壊れた provenance（run_id が文字列でない）は、どの run とも一致しない', () => {
    const broken = { ...count, provenance: { ...provenance, run_id: 5 } } as unknown as ToolResult;
    expect(runCheck(answer([broken], RUN.created), current)).toBe('stale');
    // provenance が無い・オブジェクトでない結果は、run を主張しない
    const noProv = { type: 'count', title: 'x' } as unknown as ToolResult;
    expect(runCheck(answer([noProv, null as unknown as ToolResult], null), current)).toBe('fresh');
  });

  it('この画面で届いた回答（restored が無い）と、質問は、調べない', () => {
    const fresh: ChatEntry = { id: 'm2', role: 'assistant', content: 'x', results: [{ ...count, provenance: { ...provenance, run_id: 'other' } }] };
    expect(runCheck(fresh, current)).toBe('fresh');
    expect(runCheck({ id: 'm3', role: 'user', content: 'q' }, current)).toBe('fresh');
  });

  it('いまの run は health から決める: 読み込み中は pending、失敗・run 無し・時刻が読めない は unknown、取れれば known（ミリ秒）', () => {
    expect(currentRunFrom({ status: 'loading' })).toEqual({ status: 'pending' });
    expect(currentRunFrom({ status: 'error', error: new ApiError('x', 500, 'x') })).toEqual({ status: 'unknown' });
    expect(currentRunFrom({ status: 'ready', data: { ...health, run: null } })).toEqual({ status: 'unknown' });
    const badTime: HealthResponse = { ...health, run: { ...health.run!, created_at: 'いつか' } };
    expect(currentRunFrom({ status: 'ready', data: badTime })).toEqual({ status: 'unknown' });
    expect(currentRunFrom({ status: 'ready', data: health })).toEqual({ status: 'known', runId: 'run-test', createdAt: Date.parse('2026-11-24T12:00:00+09:00') });
  });

  it('検出画像・地図の表示の結果も、provenance で調べる', () => {
    expect(runCheck(answer([detectionImage, mapFocus], RUN.created), current)).toBe('fresh');
    expect(runCheck(answer([detectionImage], '2020-01-01T00:00:00Z'), current)).toBe('stale');
  });
});

describe('保存した発言を、画面の発言にする', () => {
  it('古い順のまま並べ、回答は保存された results・tool_calls をそのまま持つ（値を作り直さない）。質問に時刻は付けない', () => {
    let n = 0;
    const entries = entriesFromStored(
      [
        { role: 'user', content: '何件？' },
        { role: 'assistant', content: '件数', results: [count], tool_calls: [{ name: 't', args: {} }], run_created_at: '2026-11-24T03:00:00Z' },
      ],
      () => `x${++n}`,
    );
    expect(entries).toEqual([
      { id: 'x1', role: 'user', content: '何件？' },
      { id: 'x2', role: 'assistant', content: '件数', results: [count], tool_calls: [{ name: 't', args: {} }], restored: { runCreatedAt: '2026-11-24T03:00:00Z' } },
    ]);
    expect(entries[0]).not.toHaveProperty('sentAt');
  });
});

describe('保存を飛ばして送り直す失敗', () => {
  it('401（取り直しても 401）と、ログインの確認だけが 503（code unavailable）。DB の 503・そのほかは送り直さない', () => {
    expect(isLoginCheckFailure(new ApiError('x', 401, 'session_expired'))).toBe(true);
    expect(isLoginCheckFailure(new ApiError('x', 401, 'unauthorized'))).toBe(true);
    expect(isLoginCheckFailure(new ApiError('x', 503, 'unavailable'))).toBe(true);
    expect(isLoginCheckFailure(new ApiError('x', 503, 'db_unavailable'))).toBe(false);
    expect(isLoginCheckFailure(new ApiError('x', 0, 'auth_unavailable'))).toBe(false);
    expect(isLoginCheckFailure(new ApiError('x', 422, 'conversation_full'))).toBe(false);
    expect(isLoginCheckFailure(new ApiError('x', 500, 'internal_error'))).toBe(false);
    expect(isLoginCheckFailure(new Error('x'))).toBe(false);
  });
});
