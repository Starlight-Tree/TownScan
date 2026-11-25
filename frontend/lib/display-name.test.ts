import { describe, expect, it } from 'vitest';
import { DISPLAY_NAME_MAX, MSG_NAME_CONTROL, MSG_NAME_EMPTY, MSG_NAME_TOO_LONG, displayNameLength, validateDisplayName } from './display-name';

describe('validateDisplayName（DocuNavi と同じ規則）', () => {
  it('前後の空白を除いた 1〜30 文字を通し、保存する値は空白を除いたもの', () => {
    expect(validateDisplayName('  Starlight-Tree ')).toEqual({ ok: true, name: 'Starlight-Tree' });
    expect(validateDisplayName('あ')).toEqual({ ok: true, name: 'あ' });
    expect(validateDisplayName('星'.repeat(DISPLAY_NAME_MAX))).toEqual({ ok: true, name: '星'.repeat(DISPLAY_NAME_MAX) });
  });

  it('空・空白だけは断る', () => {
    for (const raw of ['', '   ', '　']) expect(validateDisplayName(raw)).toEqual({ ok: false, message: MSG_NAME_EMPTY });
  });

  it('31 文字は断る。絵文字は 1 文字と数える', () => {
    expect(validateDisplayName('a'.repeat(DISPLAY_NAME_MAX + 1))).toEqual({ ok: false, message: MSG_NAME_TOO_LONG });
    expect(validateDisplayName('😀'.repeat(DISPLAY_NAME_MAX)).ok).toBe(true);
    expect(displayNameLength(' 😀😀 ')).toBe(2);
  });

  it('制御文字（改行・タブ・NUL）を含むものは断る', () => {
    for (const raw of ['a\nb', 'a\tb', 'a\u0000b']) expect(validateDisplayName(raw)).toEqual({ ok: false, message: MSG_NAME_CONTROL });
  });
});
