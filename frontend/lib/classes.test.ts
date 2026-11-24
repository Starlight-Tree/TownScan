import { describe, expect, it } from 'vitest';
import { CANDIDATE_CLASSES, CANDIDATE_REASONS } from './api-types';
import { CLASS_INFO, CLASS_ORDER, REASON_TEXT, isCandidateClass, reasonText, refusalTitle } from './classes';
import { formatArea, formatDateTime, formatNumber, formatProb, formatRatio } from './format';

describe('3 分類の見た目', () => {
  it('全分類に定義があり、色・線種・形が互いに異なる（色だけに頼らない）', () => {
    expect([...CLASS_ORDER].sort()).toEqual([...CANDIDATE_CLASSES].sort());
    const infos = CANDIDATE_CLASSES.map((c) => CLASS_INFO[c]);
    expect(new Set(infos.map((i) => i.color)).size).toBe(3);
    expect(new Set(infos.map((i) => i.shape)).size).toBe(3);
    expect(new Set(infos.map((i) => i.dash ?? 'solid')).size).toBe(3);
  });

  it('名前に「確定」を使わない', () => {
    for (const c of CANDIDATE_CLASSES) {
      expect(CLASS_INFO[c].label).not.toContain('確定');
      expect(CLASS_INFO[c].short).not.toContain('確定');
    }
  });

  it('理由の文言が全ての reason にある。未知の値は null', () => {
    for (const r of CANDIDATE_REASONS) expect(REASON_TEXT[r].length).toBeGreaterThan(5);
    expect(reasonText('unknown_key')).toBeNull();
    expect(reasonText(undefined)).toBeNull();
    expect(reasonText('edge')).toBe(REASON_TEXT.edge);
  });

  it('isCandidateClass / refusalTitle は未知の値を安全に扱う', () => {
    expect(isCandidateClass('uncertain')).toBe(true);
    expect(isCandidateClass('toString')).toBe(false);
    expect(isCandidateClass(null)).toBe(false);
    expect(refusalTitle('something_new')).toBe('お答えできません');
  });
});

describe('表示の整形', () => {
  it('数・面積・割合・確率・日時', () => {
    expect(formatNumber(1234.5678)).toBe('1,234.568');
    expect(formatNumber(Number.NaN)).toBe('—');
    expect(formatArea(123.45)).toBe('123.5 m²');
    expect(formatRatio(0.031)).toBe('3.1 %');
    expect(formatProb(0.9)).toBe('0.90');
    expect(formatDateTime('2026-11-24T12:00:00+09:00')).toContain('2026');
    expect(formatDateTime('not a date')).toBe('not a date');
  });
});
