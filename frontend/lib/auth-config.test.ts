import { describe, expect, it } from 'vitest';
import { AUTH_COOKIE_PREFIX, authConfigProblem, isAuthConfigured } from './auth-config';

const ok = {
  BETTER_AUTH_SECRET: 'x'.repeat(40),
  BETTER_AUTH_URL: 'http://localhost:3500',
  GOOGLE_CLIENT_ID: 'id',
  GOOGLE_CLIENT_SECRET: 'secret',
  DATABASE_URL: 'postgresql://u:p@db:5432/d',
};

describe('authConfigProblem', () => {
  it('全部そろっていれば問題なし', () => {
    expect(authConfigProblem(ok)).toBeNull();
  });

  it('未設定・空白だけの変数名を挙げる（値は出さない）', () => {
    expect(authConfigProblem({ ...ok, BETTER_AUTH_SECRET: undefined })).toBe('missing: BETTER_AUTH_SECRET');
    expect(authConfigProblem({ ...ok, GOOGLE_CLIENT_ID: '  ', GOOGLE_CLIENT_SECRET: '' })).toBe('missing: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET');
    expect(authConfigProblem({})).toBe('missing: BETTER_AUTH_SECRET, BETTER_AUTH_URL, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, DATABASE_URL');
  });

  it('メッセージに、設定の値を含めない', () => {
    const problem = authConfigProblem({ ...ok, GOOGLE_CLIENT_ID: '', BETTER_AUTH_SECRET: 'x'.repeat(40) });
    expect(problem).not.toContain('xxxx');
    expect(problem).not.toContain('postgresql');
  });

  it('公開されている既定の Secret・短すぎる Secret は通さない（値は出さない）', () => {
    expect(authConfigProblem({ ...ok, BETTER_AUTH_SECRET: 'better-auth-secret-123456789' })).toBe('BETTER_AUTH_SECRET is the public default value');
    expect(authConfigProblem({ ...ok, BETTER_AUTH_SECRET: 'short' })).toBe('BETTER_AUTH_SECRET is shorter than 32 characters');
  });

  it('BETTER_AUTH_URL は http(s) の URL だけ通す（localhost:3500 のような書き間違いを、起動のときに止める）', () => {
    for (const bad of ['localhost:3500', 'example.com', 'https//x.example', 'ftp://x.example', 'http://']) {
      expect(authConfigProblem({ ...ok, BETTER_AUTH_URL: bad }), bad).toBe('BETTER_AUTH_URL is not an http(s) URL');
    }
    expect(authConfigProblem({ ...ok, BETTER_AUTH_URL: 'https://townscan.example.com/' })).toBeNull();
  });
});

describe('isAuthConfigured', () => {
  it('authConfigProblem が null のときだけ true（getAuth() が null を返さない条件と同じ）', () => {
    expect(isAuthConfigured(ok)).toBe(true);
    expect(isAuthConfigured({ ...ok, GOOGLE_CLIENT_ID: '' })).toBe(false);
    expect(isAuthConfigured({ ...ok, BETTER_AUTH_SECRET: 'short' })).toBe(false);
    expect(isAuthConfigured({})).toBe(false);
  });
});

describe('AUTH_COOKIE_PREFIX', () => {
  it('townscan（既定の better-auth ではない。同じ localhost の JobNavi・DocuNavi と Cookie を取り合わない）', () => {
    expect(AUTH_COOKIE_PREFIX).toBe('townscan');
    expect(AUTH_COOKIE_PREFIX).not.toContain('better-auth');
    expect(AUTH_COOKIE_PREFIX).not.toBe('jobnavi');
    expect(AUTH_COOKIE_PREFIX).toMatch(/^[a-z][a-z0-9-]*$/);
  });
});
