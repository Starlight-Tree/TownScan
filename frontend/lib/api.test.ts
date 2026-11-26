import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, candidateImageUrl, getAreas, getCandidates, getCandidatesGeoJson, getCandidate, getHealth, postChat } from './api';
import { areas, health, jsonResponse } from '../tests/fixtures';

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('API クライアント', () => {
  it('呼ぶ先は、同じオリジンの /api/* だけ（絶対 URL を使わない）', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ total: 0, items: [], features: [], ...health }));
    await getHealth();
    await getAreas().catch(() => {});
    await getCandidates({ area_id: 'z18-1-2', cls: 'uncertain', limit: 5 });
    await getCandidatesGeoJson({});
    await getCandidate('c-1-2-3');
    await postChat([{ role: 'user', content: 'こんにちは' }]);
    const urls = fetchMock.mock.calls.map(([u]) => String(u));
    expect(urls.every((u) => u.startsWith('/api/'))).toBe(true);
    expect(urls).toContain('/api/candidates?area_id=z18-1-2&cls=uncertain&limit=5&sort=area_desc');
    expect(urls).toContain('/api/candidates.geojson');
    expect(urls).toContain('/api/candidates/c-1-2-3');
  });

  it('条件が null・空のときは、クエリに入れない', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ total: 0, items: [] }));
    await getCandidates({ area_id: null, cls: null });
    expect(String(fetchMock.mock.calls[0]![0])).toBe('/api/candidates?sort=area_desc');
  });

  it('画像の URL は同じオリジンの相対パス', () => {
    expect(candidateImageUrl('c-1-2-3', 2014)).toBe('/api/candidates/c-1-2-3/image?year=2014&size=512');
    expect(candidateImageUrl('c-1-2-3', 2024, 256)).toBe('/api/candidates/c-1-2-3/image?year=2024&size=256');
  });

  it('地区の一覧は、配列でも {items} でも受ける', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(areas)).mockResolvedValueOnce(jsonResponse({ items: areas }));
    expect(await getAreas()).toEqual(areas);
    expect(await getAreas()).toEqual(areas);
  });

  it('エラー本文 {error:{code,message}} を ApiError にする', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'not_found', message: '候補が見つかりません。' } }, 404));
    await expect(getCandidate('c-0-0-0')).rejects.toMatchObject({ name: 'ApiError', status: 404, code: 'not_found', message: '候補が見つかりません。' });
  });

  it('接続できない・JSON でない 2xx・JSON でない 5xx を、それぞれ分ける', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(getHealth()).rejects.toMatchObject({ code: 'network', status: 0 });
    fetchMock.mockResolvedValueOnce(new Response('<html>', { status: 200 }));
    await expect(getHealth()).rejects.toMatchObject({ code: 'invalid_json' });
    fetchMock.mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }));
    const err = await getHealth().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: 'upstream_unreachable', status: 500 });
  });

  it('中止（AbortError）は ApiError にしない', async () => {
    fetchMock.mockRejectedValue(new DOMException('aborted', 'AbortError'));
    await expect(getHealth()).rejects.toMatchObject({ name: 'AbortError' });
  });
});
