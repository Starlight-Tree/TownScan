import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { health, jsonResponse } from '../tests/fixtures';
import { AppBanners } from './AppBanners';
import { HealthProvider } from './HealthProvider';

const fetchMock = vi.fn<typeof fetch>();

function renderBanners() {
  render(
    <HealthProvider>
      <AppBanners />
    </HealthProvider>,
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe('AppBanners', () => {
  it('run.kind が synthetic のとき、目立つ「合成データ（テスト用）」のバナーを出す', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ...health, run: { ...health.run, kind: 'synthetic' } }));
    renderBanners();
    const banner = await screen.findByRole('status');
    expect(banner).toHaveTextContent('合成データ（テスト用）');
  });

  it('run.kind が real のときは、バナーを出さない', async () => {
    fetchMock.mockResolvedValue(jsonResponse(health));
    renderBanners();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByText(/合成データ/)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('health は同じオリジンの /api/health を読む', async () => {
    fetchMock.mockResolvedValue(jsonResponse(health));
    renderBanners();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/health');
  });

  it('API に接続できないときは、エラーのバナーと再試行を出す。再試行で消える', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(jsonResponse(health));
    renderBanners();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('API に接続できません');
    await userEvent.click(screen.getByRole('button', { name: '再試行' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
});
