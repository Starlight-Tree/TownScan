import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { THEME_KEY } from '../lib/theme';
import { health, jsonResponse } from '../tests/fixtures';
import { AppHeader } from './AppHeader';
import { HealthProvider } from './HealthProvider';

vi.mock('next/navigation', () => ({ usePathname: () => '/accuracy' }));

const fetchMock = vi.fn<typeof fetch>();

function renderHeader() {
  render(
    <HealthProvider>
      <AppHeader />
    </HealthProvider>,
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe('ヘッダーとバナー', () => {
  it('run.kind が synthetic のとき、目立つ「合成データ（テスト用）」のバナーを出す', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ...health, run: { ...health.run, kind: 'synthetic' } }));
    renderHeader();
    const banner = await screen.findByRole('status');
    expect(banner).toHaveTextContent('合成データ（テスト用）');
  });

  it('run.kind が real のときは、バナーを出さない', async () => {
    fetchMock.mockResolvedValue(jsonResponse(health));
    renderHeader();
    await screen.findByText('模擬モデルで応答しています');
    expect(screen.queryByText(/合成データ/)).not.toBeInTheDocument();
  });

  it('llm が mock のとき「模擬モデルで応答しています」を出す。mock 以外ではモデル名を出す', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ...health, llm: 'gemini' }));
    renderHeader();
    expect(await screen.findByText('モデル: gemini')).toBeInTheDocument();
    expect(screen.queryByText('模擬モデルで応答しています')).not.toBeInTheDocument();
  });

  it('health は同じオリジンの /api/health を読む', async () => {
    fetchMock.mockResolvedValue(jsonResponse(health));
    renderHeader();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/health');
  });

  it('API に接続できないときは、エラーのバナーと再試行を出す', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(jsonResponse(health));
    renderHeader();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('API に接続できません');
    await userEvent.click(screen.getByRole('button', { name: '再試行' }));
    await screen.findByText('模擬モデルで応答しています');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('現在のページに aria-current を付ける', async () => {
    fetchMock.mockResolvedValue(jsonResponse(health));
    renderHeader();
    expect(screen.getByRole('link', { name: 'このアプリの精度' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'チャットと地図' })).not.toHaveAttribute('aria-current');
    await screen.findByText('模擬モデルで応答しています');
  });
});

describe('ヘッダーのテーマの切り替え', () => {
  it('右端（状態の表示の隣）に、ライト・ダーク・システムの 3 択を出す。はじめは「システム」', async () => {
    fetchMock.mockResolvedValue(jsonResponse(health));
    renderHeader();
    const header = screen.getByRole('banner');
    const group = within(header).getByRole('group', { name: 'テーマ' });
    expect(group.previousElementSibling).toHaveClass('app-header__status');
    expect(within(group).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['ライト', 'ダーク', 'システム']);
    expect(within(group).getByRole('button', { name: 'システム' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(group).getByRole('button', { name: 'ライト' })).toHaveAttribute('aria-pressed', 'false');
    expect(within(group).getByRole('button', { name: 'ダーク' })).toHaveAttribute('aria-pressed', 'false');
    await screen.findByText('模擬モデルで応答しています');
  });

  it('ダークを選ぶと、data-theme と保存に反映する。システムに戻すと、どちらも消す', async () => {
    fetchMock.mockResolvedValue(jsonResponse(health));
    renderHeader();
    await userEvent.click(screen.getByRole('button', { name: 'ダーク' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(window.localStorage.getItem(THEME_KEY)).toBe('dark');
    expect(screen.getByRole('button', { name: 'ダーク' })).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(screen.getByRole('button', { name: 'システム' }));
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(window.localStorage.getItem(THEME_KEY)).toBeNull();
    expect(screen.getByRole('button', { name: 'システム' })).toHaveAttribute('aria-pressed', 'true');
    await screen.findByText('模擬モデルで応答しています');
  });

  it('保存済みの選択を、押した状態として出す', async () => {
    window.localStorage.setItem(THEME_KEY, 'light');
    fetchMock.mockResolvedValue(jsonResponse(health));
    renderHeader();
    expect(await screen.findByRole('button', { name: 'ライト' })).toHaveAttribute('aria-pressed', 'true');
    await screen.findByText('模擬モデルで応答しています');
  });
});
