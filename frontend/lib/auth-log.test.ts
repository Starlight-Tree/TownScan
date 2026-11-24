import { afterEach, describe, expect, it, vi } from 'vitest';
import { APIError } from 'better-auth/api';
import { isUnauthorized, logAuthError } from './auth-log';

afterEach(() => vi.restoreAllMocks());

describe('isUnauthorized', () => {
  it('Better Auth の 401（ログインしていない）だけを true にする', () => {
    expect(isUnauthorized(new APIError('UNAUTHORIZED'))).toBe(true);
  });

  it('ほかの失敗は false（500・普通の例外・値でないもの）', () => {
    expect(isUnauthorized(new APIError('INTERNAL_SERVER_ERROR'))).toBe(false);
    expect(isUnauthorized(new Error('Failed to decrypt private key'))).toBe(false);
    expect(isUnauthorized('401')).toBe(false);
    expect(isUnauthorized(null)).toBe(false);
  });
});

describe('logAuthError', () => {
  it('場所・名前・本文を 1 行で出す（改行は 1 つの空白にし、200 文字で切る）', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = new Error(`Failed to decrypt\nprivate key ${'x'.repeat(300)}`);
    error.name = 'BetterAuthError';
    logAuthError('currentUser', error);
    const line = String(spy.mock.calls[0]![0]);
    expect(line.startsWith('auth: currentUser failed: BetterAuthError: Failed to decrypt private key ')).toBe(true);
    expect(line).not.toContain('\n');
    expect(line.length).toBeLessThan(260);
  });

  it('Error ではない値でも落ちない（本文は出さない）', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logAuthError('googleLoginAction', 'secret-looking-string');
    expect(spy).toHaveBeenCalledWith('auth: googleLoginAction failed: Error');
  });
});
