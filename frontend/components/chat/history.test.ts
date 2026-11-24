import { describe, expect, it } from 'vitest';
import { buildRequestMessages, MAX_CONTENT_LENGTH, MAX_MESSAGES } from './history';
import type { ChatEntry } from './types';

const user = (content: string, failed = false): ChatEntry => ({ id: `u-${content}`, role: 'user', content, ...(failed ? { failed } : {}) });
const bot = (content: string): ChatEntry => ({ id: `a-${content}`, role: 'assistant', content });

/** user / assistant を交互に n 往復ぶん */
function turns(n: number): ChatEntry[] {
  return Array.from({ length: n }, (_, i) => [user(`q${i + 1}`), bot(`a${i + 1}`)]).flat();
}

describe('buildRequestMessages', () => {
  it('履歴の役割と本文だけを渡し、最後に今回の発言を付ける', () => {
    expect(buildRequestMessages([user('a'), bot('b')], 'c')).toEqual([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
    ]);
  });

  it('送信に失敗した発言は含めない', () => {
    expect(buildRequestMessages([user('届いた'), bot('答え'), user('届かない', true)], '次')).toEqual([
      { role: 'user', content: '届いた' },
      { role: 'assistant', content: '答え' },
      { role: 'user', content: '次' },
    ]);
  });

  it('履歴が空なら、今回の発言だけ', () => {
    expect(buildRequestMessages([], '最初')).toEqual([{ role: 'user', content: '最初' }]);
  });

  it(`古い方から落として ${MAX_MESSAGES} 件以内に収め、先頭は user にそろえる`, () => {
    for (let n = 1; n <= 60; n += 1) {
      const out = buildRequestMessages(turns(n), '今回');
      expect(out.length).toBeLessThanOrEqual(MAX_MESSAGES);
      expect(out[0]!.role).toBe('user');
      expect(out.at(-1)).toEqual({ role: 'user', content: '今回' });
    }
    // 24 往復 = 48 件。末尾 39 件は assistant から始まるので 1 件落ち、38 + 今回 1 件
    const out = buildRequestMessages(turns(24), '今回');
    expect(out).toHaveLength(39);
    expect(out.at(-2)).toEqual({ role: 'assistant', content: 'a24' });
    expect(out[0]).toEqual({ role: 'user', content: 'q6' });
  });

  it(`履歴の本文は ${MAX_CONTENT_LENGTH} 字（コードポイント）までに切る。サロゲートペアを割らない`, () => {
    const out = buildRequestMessages([user('q'), bot('😀'.repeat(2500))], '次');
    const text = out[1]!.content;
    expect(Array.from(text)).toHaveLength(MAX_CONTENT_LENGTH);
    expect(text).toBe('😀'.repeat(MAX_CONTENT_LENGTH));
    // 短い本文はそのまま
    expect(out[0]!.content).toBe('q');
  });
});
