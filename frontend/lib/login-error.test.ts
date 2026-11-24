import { describe, expect, it } from 'vitest';
import { loginErrorMessage } from './login-error';

describe('loginErrorMessage', () => {
  it('コードが無ければ、何も出さない', () => {
    expect(loginErrorMessage(undefined)).toBeNull();
    expect(loginErrorMessage('')).toBeNull();
  });

  it('決めたコードは、決めた文にする', () => {
    expect(loginErrorMessage('not_configured')).toContain('まだ設定されていません');
    expect(loginErrorMessage('access_denied')).toContain('取り消されました');
  });

  it('知らないコードは、ひとまとめの失敗の文にする。URL の文字を、そのまま画面に出さない', () => {
    const message = loginErrorMessage('<script>alert(1)</script>');
    expect(message).toBe('Google でのログインに失敗しました。もう一度お試しください');
    expect(message).not.toContain('script');
    // プロトタイプにある名前も、関数を返さない
    expect(typeof loginErrorMessage('constructor')).toBe('string');
    expect(loginErrorMessage('constructor')).toBe(message);
  });
});
