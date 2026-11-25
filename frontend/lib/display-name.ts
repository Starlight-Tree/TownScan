// 表示名（アカウントのメニューの「表示名を変更」）の検査。DocuNavi の `lib/displayName.ts` と同じ規則。

/** 表示名の長さの上限（文字数。絵文字などは 1 文字と数える）。 */
export const DISPLAY_NAME_MAX = 30;

export const MSG_NAME_EMPTY = '表示名を入力してください。';
export const MSG_NAME_TOO_LONG = `表示名は ${DISPLAY_NAME_MAX} 文字以内にしてください。`;
export const MSG_NAME_CONTROL = '表示名に使えない文字（改行・タブなど）が含まれています。';

/** 表示名のフォームの状態（サーバーアクション `updateNameAction` の返り値）。 */
export type NameFormState = {
  error?: string;
  /** 保存できた（ダイアログを閉じてよい）。 */
  saved?: boolean;
  /** 入力した値（エラーのあとも入力を残す）。 */
  value?: string;
};

/** 前後の空白を除いた文字数（コードポイント単位）。 */
export function displayNameLength(raw: string): number {
  return Array.from(raw.trim()).length;
}

/**
 * 表示名の検査。前後の空白を除いた 1〜30 文字で、制御文字（改行・タブなど。Unicode の Cc）を含まないこと。日本語・絵文字は通す。
 * 問題なければ `{ ok: true, name }`（保存する値）、だめなら `{ ok: false, message }`。サーバーアクションが、保存の前に必ず通す。
 */
export function validateDisplayName(raw: string): { ok: true; name: string } | { ok: false; message: string } {
  const name = raw.trim();
  if (name === '') return { ok: false, message: MSG_NAME_EMPTY };
  if (/\p{Cc}/u.test(name)) return { ok: false, message: MSG_NAME_CONTROL };
  if (Array.from(name).length > DISPLAY_NAME_MAX) return { ok: false, message: MSG_NAME_TOO_LONG };
  return { ok: true, name };
}
