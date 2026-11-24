import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

class Redirected extends Error {
  constructor(readonly to: string) {
    super(to);
  }
}
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Redirected(to);
  },
}));

const loginAction = vi.hoisted(() => vi.fn());
vi.mock('../../../actions/auth', () => ({ googleLoginAction: loginAction }));
const authRef = vi.hoisted(() => ({ current: {} as object | null }));
vi.mock('../../../lib/auth', () => ({ getAuth: () => authRef.current }));
const user = vi.hoisted(() => ({ current: null as null | { id: string; email: string; name: string; image: string | null } }));
vi.mock('../../../lib/session', () => ({ currentUser: async () => user.current }));

const mod = await import('./page');
const LoginPage = mod.default;

const show = async (error?: string) => render(await LoginPage({ searchParams: Promise.resolve(error === undefined ? {} : { error }) }));

beforeEach(() => {
  authRef.current = {};
  user.current = null;
  loginAction.mockReset();
});

describe('/login', () => {
  it('見出し・1 行の案内・「Google でログイン」のボタン（サーバーアクションのフォーム）だけ。メール・パスワードの入力は無い', async () => {
    const { container } = await show();
    expect(screen.getByRole('heading', { level: 1, name: 'ログイン' })).toBeInTheDocument();
    expect(screen.getByText('Google アカウントでログインしてください')).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Google でログイン' });
    expect(button).toHaveAttribute('type', 'submit');
    expect(button.closest('form')).not.toBeNull();
    expect(container.querySelector('input')).toBeNull();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('ログインしなくても使えることを 1 行で伝える（任意のログイン）', async () => {
    await show();
    expect(screen.getByText('ログインしなくても、チャット・地図・精度は使えます。')).toBeInTheDocument();
  });

  it('設定が足りないとき（getAuth が null）は、「まだ設定されていません」を出して、ボタンは出さない（?error が無くても）', async () => {
    authRef.current = null;
    const { container } = await show();
    expect(screen.getByRole('alert')).toHaveTextContent('Google でのログインは、まだ設定されていません');
    expect(screen.queryByRole('button', { name: 'Google でログイン' })).not.toBeInTheDocument();
    expect(container.querySelector('form')).toBeNull();
    // ログインしなくても使えることは、そのまま伝える
    expect(screen.getByText('ログインしなくても、チャット・地図・精度は使えます。')).toBeInTheDocument();
  });

  it('設定が足りないときは、URL の ?error の文字を使わず、まだ設定されていませんだけを出す', async () => {
    authRef.current = null;
    await show('<b>x</b>');
    expect(screen.getByRole('alert')).toHaveTextContent('まだ設定されていません');
    expect(screen.getByRole('alert')).not.toHaveTextContent('<b>');
  });

  it('設定があっても、戻りのコード（?error=not_configured）には、その文を出す', async () => {
    await show('not_configured');
    expect(screen.getByRole('alert')).toHaveTextContent('まだ設定されていません');
    expect(screen.getByRole('button', { name: 'Google でログイン' })).toBeInTheDocument();
  });

  it('取り消し・失敗のコードは、決めた文にする。知らない文字は、そのまま画面に出さない', async () => {
    const { unmount } = await show('access_denied');
    expect(screen.getByRole('alert')).toHaveTextContent('取り消されました');
    unmount();
    await show('<img src=x onerror=alert(1)>');
    expect(screen.getByRole('alert')).toHaveTextContent('Google でのログインに失敗しました。もう一度お試しください');
    expect(screen.getByRole('alert')).not.toHaveTextContent('onerror');
  });

  it('すでにログインしていれば、/ へ移す', async () => {
    user.current = { id: 'u', email: 'a@example.com', name: '花子', image: null };
    await expect(show()).rejects.toMatchObject({ to: '/' });
  });

  it('動的に描く（ログインの状態を見るので、ビルドで固めない）。タブ名は、ほかのページと同じ TownScan のまま（metadata を持たない）', () => {
    expect(mod.dynamic).toBe('force-dynamic');
    expect(mod).not.toHaveProperty('metadata');
    expect(mod).not.toHaveProperty('generateMetadata');
  });
});
