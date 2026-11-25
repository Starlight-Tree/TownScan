import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { THEME_KEY } from '../lib/theme';
import { health, jsonResponse } from '../tests/fixtures';
import { AppHeader } from './AppHeader';
import { HealthProvider } from './HealthProvider';

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

  it('ページへの入口（nav）は無い。リンクはロゴだけ（精度の画面は、アカウントのメニューの中）', async () => {
    fetchMock.mockResolvedValue(jsonResponse(health));
    renderHeader();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(screen.getAllByRole('link').map((a) => a.textContent)).toEqual(['TownScan']);
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

describe('ヘッダーのアカウント（上の横帯。サイドパネルを出さない 1023px 以下で使う）', () => {
  it('account を渡すと、テーマの切り替えの隣（右端）に出す', async () => {
    fetchMock.mockResolvedValue(jsonResponse(health));
    render(
      <HealthProvider>
        <AppHeader account={<button type="button">アカウント</button>} />
      </HealthProvider>,
    );
    const header = screen.getByRole('banner');
    const slot = within(header).getByRole('button', { name: 'アカウント' }).parentElement!;
    expect(slot).toHaveClass('app-header__account');
    expect(slot.previousElementSibling).toBe(within(header).getByRole('group', { name: 'テーマ' }));
    expect(slot.parentElement).toHaveClass('app-header__tools');
    await screen.findByText('模擬モデルで応答しています');
  });

  it('account を渡さなければ、アカウントの場所を出さない', async () => {
    fetchMock.mockResolvedValue(jsonResponse(health));
    renderHeader();
    expect(document.querySelector('.app-header__account')).toBeNull();
    await screen.findByText('模擬モデルで応答しています');
  });

  it('バナー（合成データ・API 不通）は、<header> の外に出す（1024px 以上で <header> だけを CSS で出さなくても、バナーは残る）', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ...health, run: { ...health.run, kind: 'synthetic' } }));
    renderHeader();
    const banner = await screen.findByRole('status');
    expect(banner.closest('header')).toBeNull();
    expect(screen.getByRole('banner')).not.toContainElement(banner);
  });

  it('API 不通のバナーも、<header> の外', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    renderHeader();
    const alert = await screen.findByRole('alert');
    expect(alert.closest('header')).toBeNull();
  });
});
