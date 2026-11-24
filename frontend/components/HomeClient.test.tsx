import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CandidateFeature } from '../lib/api-types';
import { areas, detail, jsonResponse, mapFocus, table } from '../tests/fixtures';
import { HomeClient } from './HomeClient';

// Leaflet 本体は別のテストで確かめる。ここでは、地図に渡る props だけを見る
vi.mock('./map/LeafletMap', () => ({
  default: (p: {
    base: string;
    features: CandidateFeature[];
    selectedId: string | null;
    highlightIds: ReadonlySet<string>;
    focus: { kind: string } | null;
    onSelect: (id: string) => void;
  }) => (
    <div
      data-testid="leaflet"
      data-base={p.base}
      data-count={p.features.length}
      data-classes={[...new Set(p.features.map((f) => f.properties.class))].sort().join(',')}
      data-selected={p.selectedId ?? ''}
      data-highlight={[...p.highlightIds].join(',')}
      data-focus={p.focus?.kind ?? ''}
    >
      <button type="button" onClick={() => p.onSelect('c-1-2-2')}>
        地図の印（c-1-2-2）
      </button>
    </div>
  ),
}));

const square = (lon: number): CandidateFeature['geometry'] => ({
  type: 'Polygon',
  coordinates: [[[lon, 32.8], [lon + 0.0001, 32.8], [lon + 0.0001, 32.8001], [lon, 32.8001], [lon, 32.8]]],
});
const features: CandidateFeature[] = [
  { type: 'Feature', id: 'c-1-2-1', geometry: square(130.7), properties: { id: 'c-1-2-1', class: 'confirmed_new', area_m2: 123.4, area_id: 'z18-1-2' } },
  { type: 'Feature', id: 'c-1-2-2', geometry: square(130.701), properties: { id: 'c-1-2-2', class: 'uncertain', area_m2: 88, area_id: 'z18-1-2' } },
];

const fetchMock = vi.fn<typeof fetch>();

function route(overrides: Record<string, () => Response | Promise<Response>> = {}) {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    for (const [prefix, make] of Object.entries(overrides)) if (url.startsWith(prefix)) return make();
    if (url.startsWith('/api/areas')) return jsonResponse(areas);
    if (url.startsWith('/api/candidates.geojson')) return jsonResponse({ type: 'FeatureCollection', features });
    if (url.startsWith('/api/candidates/c-')) return jsonResponse({ ...detail, id: url.split('/').pop() });
    if (url.startsWith('/api/candidates')) return jsonResponse({ total: 2, items: [] });
    if (url === '/api/chat' && init?.method === 'POST') {
      return jsonResponse({ message: { role: 'assistant', content: '一覧です。', results: [table, mapFocus], tool_calls: [] } });
    }
    return jsonResponse({ error: { code: 'not_found', message: 'テストに無いパス' } }, 404);
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('画面 `/`（チャット・地図・詳細の連携）', () => {
  it('地区の枠と候補を読み込み、地図に渡す。標準の下地は 2023 年の写真', async () => {
    route();
    render(<HomeClient />);
    const map = await screen.findByTestId('leaflet');
    await waitFor(() => expect(map).toHaveAttribute('data-count', '2'));
    expect(map).toHaveAttribute('data-base', 'photo2023');
    expect(screen.getByRole('combobox', { name: '地区' })).toHaveTextContent('テスト地区 01');
    // 凡例に分類ごとの件数（地区の件数の合計）
    const legend = screen.getByRole('group', { name: /表示する分類/ });
    expect(within(legend).getAllByRole('checkbox')).toHaveLength(3);
    expect(within(legend).getByText('5')).toBeInTheDocument();
  });

  it('下地を切り替える（aria-pressed）', async () => {
    route();
    render(<HomeClient />);
    const map = await screen.findByTestId('leaflet');
    await userEvent.click(screen.getByRole('button', { name: '2018 年の写真' }));
    expect(map).toHaveAttribute('data-base', 'photo2018');
    expect(screen.getByRole('button', { name: '2018 年の写真' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '2023 年の写真' })).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(screen.getByRole('button', { name: '標準地図' }));
    expect(map).toHaveAttribute('data-base', 'std');
  });

  it('凡例のチェックで分類を絞り、全部外すと「条件に合う候補がありません」', async () => {
    route();
    render(<HomeClient />);
    const map = await screen.findByTestId('leaflet');
    await waitFor(() => expect(map).toHaveAttribute('data-count', '2'));
    await userEvent.click(screen.getByRole('checkbox', { name: /判定保留/ }));
    expect(map).toHaveAttribute('data-classes', 'confirmed_new');
    await userEvent.click(screen.getByRole('checkbox', { name: /新規出現/ }));
    expect(map).toHaveAttribute('data-count', '0');
    expect(screen.getByText(/条件に合う候補がありません/)).toBeInTheDocument();
  });

  it('チャットで一覧を出し、行の「詳細」でドロワーが開く（地図の選択・寄せも連動）', async () => {
    route();
    render(<HomeClient />);
    const map = await screen.findByTestId('leaflet');
    await waitFor(() => expect(map).toHaveAttribute('data-count', '2'));

    await userEvent.type(screen.getByRole('textbox', { name: '質問を入力' }), '一覧にして{Enter}');
    await screen.findByText('一覧です。');
    // map_focus が返ったので、候補が強調され、地図が寄る
    await waitFor(() => expect(map).toHaveAttribute('data-highlight', 'c-1-2-1,c-1-2-2,c-1-2-3'));
    expect(map).toHaveAttribute('data-focus', 'fit');

    await userEvent.click(screen.getByRole('button', { name: /詳細.*c-1-2-1/ }));
    const dialog = await screen.findByRole('dialog', { name: '候補の詳細' });
    expect(await within(dialog).findAllByRole('img')).toHaveLength(2);
    expect(map).toHaveAttribute('data-selected', 'c-1-2-1');

    // 閉じると選択も外れる
    await userEvent.click(within(dialog).getByRole('button', { name: '閉じる' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(map).toHaveAttribute('data-selected', '');

    // 強調表示の解除
    await userEvent.click(screen.getByRole('button', { name: '強調表示を解除' }));
    expect(map).toHaveAttribute('data-highlight', '');
  });

  it('地図の印を選ぶと、その候補の詳細が開く', async () => {
    route();
    render(<HomeClient />);
    await userEvent.click(await screen.findByRole('button', { name: '地図の印（c-1-2-2）' }));
    const dialog = await screen.findByRole('dialog', { name: '候補の詳細' });
    expect(within(dialog).getByText('c-1-2-2')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([u]) => u === '/api/candidates/c-1-2-2')).toBe(true);
  });

  it('候補の読み込みに失敗したら、地図の上にエラーと再試行を出す', async () => {
    let fail = true;
    route({
      '/api/candidates.geojson': () => (fail ? jsonResponse({ error: { code: 'db_down', message: 'DB に接続できません。' } }, 503) : jsonResponse({ type: 'FeatureCollection', features })),
    });
    render(<HomeClient />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('候補を読み込めませんでした');
    expect(alert).toHaveTextContent('DB に接続できません。');
    fail = false;
    await userEvent.click(within(alert).getByRole('button', { name: '再試行' }));
    await waitFor(() => expect(screen.getByTestId('leaflet')).toHaveAttribute('data-count', '2'));
  });

  it('候補が 0 件のときは「表示できる候補がありません」', async () => {
    route({ '/api/candidates.geojson': () => jsonResponse({ type: 'FeatureCollection', features: [] }) });
    render(<HomeClient />);
    expect(await screen.findByText('表示できる候補がありません。')).toBeInTheDocument();
  });

  it('一覧（キーボードで使える代わりの手段）は、開いたときに読み込む', async () => {
    route({
      '/api/candidates?': () =>
        jsonResponse({ total: 1, items: [{ id: 'c-1-2-1', area_id: 'z18-1-2', class: 'confirmed_new', area_m2: 123.4, bbox: [0, 0, 1, 1], centroid: [0, 0] }] }),
    });
    render(<HomeClient />);
    await screen.findByTestId('leaflet');
    expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith('/api/candidates?'))).toBe(false);
    await userEvent.click(screen.getByText('候補を一覧で見る（面積の大きい順）'));
    const item = await screen.findByRole('button', { name: /c-1-2-1 の詳細を開く/ });
    await userEvent.click(item);
    expect(await screen.findByRole('dialog', { name: '候補の詳細' })).toBeInTheDocument();
    const call = fetchMock.mock.calls.find(([u]) => String(u).startsWith('/api/candidates?'))!;
    expect(String(call[0])).toContain('sort=area_desc');
  });
});
