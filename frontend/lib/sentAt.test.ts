import { describe, expect, it } from 'vitest';
import { formatSentAt, parseSentAt } from './sentAt';

// 端末のタイムゾーンで表示するので、時刻は new Date(年, 月, 日, 時, 分)（端末の時刻）で作って、ISO にして渡す
const at = (y: number, m: number, d: number, h: number, min: number) => new Date(y, m - 1, d, h, min).toISOString();
const NOW = new Date(2026, 10, 16, 21, 30); // 2026-11-16 21:30

describe('formatSentAt', () => {
  it('同じ日は「今日」', () => {
    expect(formatSentAt(at(2026, 11, 16, 21, 2), NOW)).toBe('今日 21:02');
    expect(formatSentAt(at(2026, 11, 16, 0, 5), NOW)).toBe('今日 0:05');
    expect(formatSentAt(at(2026, 11, 16, 4, 46), NOW)).toBe('今日 4:46'); // 時は 0 埋めしない、分は 2 桁
  });

  it('前の日は「昨日」（月をまたいでも）', () => {
    expect(formatSentAt(at(2026, 11, 15, 20, 41), NOW)).toBe('昨日 20:41');
    expect(formatSentAt(at(2026, 10, 31, 9, 0), new Date(2026, 10, 1, 8, 0))).toBe('昨日 9:00');
  });

  it('それより前の今年は「月日」、去年以前は年も付ける', () => {
    expect(formatSentAt(at(2026, 11, 14, 21, 2), NOW)).toBe('11月14日 21:02');
    expect(formatSentAt(at(2025, 11, 14, 21, 2), NOW)).toBe('2025年11月14日 21:02');
  });

  it('未来の時刻（端末の時計のずれ）は、同じ日なら「今日」、違う日なら日付', () => {
    expect(formatSentAt(at(2026, 11, 16, 23, 59), NOW)).toBe('今日 23:59');
    expect(formatSentAt(at(2026, 11, 20, 10, 0), NOW)).toBe('11月20日 10:00');
  });

  it('読めない値は null', () => {
    expect(formatSentAt('昨日', NOW)).toBeNull();
    expect(formatSentAt('', NOW)).toBeNull();
  });
});

describe('parseSentAt', () => {
  it('読める ISO 8601 だけを返す', () => {
    expect(parseSentAt('2026-11-16T12:34:56+00:00')).toBe('2026-11-16T12:34:56+00:00');
    expect(parseSentAt('2026-11-16T12:34:56.123Z')).toBe('2026-11-16T12:34:56.123Z');
  });

  it('文字列でない・読めない値は undefined', () => {
    expect(parseSentAt(undefined)).toBeUndefined();
    expect(parseSentAt(12345)).toBeUndefined();
    expect(parseSentAt('昨日')).toBeUndefined();
    expect(parseSentAt(null)).toBeUndefined();
  });
});
