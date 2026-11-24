import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { THEME_KEY } from '../lib/theme';
import { ThemeSwitch } from './ThemeSwitch';

beforeEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
});
afterEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe('ThemeSwitch', () => {
  it('保存が無ければ「システム」が選ばれている', () => {
    render(<ThemeSwitch />);
    expect(screen.getByRole('group', { name: 'テーマ' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'システム' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'ライト' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'ダーク' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('保存済みの選択を、描画のあとに反映する', async () => {
    window.localStorage.setItem(THEME_KEY, 'dark');
    render(<ThemeSwitch />);
    expect(await screen.findByRole('button', { name: 'ダーク' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'システム' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('ダークを選ぶと、適用して保存する。システムに戻すと、どちらも消す', async () => {
    render(<ThemeSwitch />);
    await userEvent.click(screen.getByRole('button', { name: 'ダーク' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(window.localStorage.getItem(THEME_KEY)).toBe('dark');
    expect(screen.getByRole('button', { name: 'ダーク' })).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(screen.getByRole('button', { name: 'システム' }));
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(window.localStorage.getItem(THEME_KEY)).toBeNull();
    expect(screen.getByRole('button', { name: 'システム' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('ライトを選ぶと、適用して保存する', async () => {
    render(<ThemeSwitch />);
    await userEvent.click(screen.getByRole('button', { name: 'ライト' }));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(window.localStorage.getItem(THEME_KEY)).toBe('light');
    expect(screen.getByRole('button', { name: 'ライト' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('サーバーの出力は、保存値があっても「システム」で始める（ハイドレーションのずれを避ける契約）', () => {
    window.localStorage.setItem(THEME_KEY, 'dark');
    const html = renderToString(<ThemeSwitch />);
    expect(html).toMatch(/aria-label="システム"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*aria-label="システム"/);
    expect(html).not.toMatch(/aria-label="ダーク"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*aria-label="ダーク"/);
  });

  it('保存できない環境でも、このページで選んだテーマ（data-theme）を、別の画面の ThemeSwitch が引き継ぐ', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const first = render(<ThemeSwitch />);
    await userEvent.click(screen.getByRole('button', { name: 'ダーク' }));
    first.unmount();

    render(<ThemeSwitch />);
    expect(await screen.findByRole('button', { name: 'ダーク' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'システム' })).toHaveAttribute('aria-pressed', 'false');
  });
});
