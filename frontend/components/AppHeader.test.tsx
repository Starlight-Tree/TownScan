import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
});

afterEach(() => {
  vi.unstubAllGlobals();
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
