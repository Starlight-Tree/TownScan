import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import L from 'leaflet';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CandidateFeature } from '../../lib/api-types';
import { areas } from '../../tests/fixtures';
import { MapPanel } from './MapPanel';

// 本物の LeafletMap と MapPanel を組み合わせる（MapPanel.test.tsx は地図を、LeafletMap.test.tsx はカードを、それぞれ差し替えている）。
// 選択中のカード（地図の中に重なる）と地図の受け渡し: 「印からカードへの Tab の数」と、「カードの下に隠れる印を、上へ寄せる」
vi.mock('../../lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/api')>()), getCandidates: vi.fn().mockResolvedValue({ total: 0, items: [] }) }));

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 600 });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const square = (lon: number): CandidateFeature['geometry'] => ({
  type: 'Polygon',
  coordinates: [[[lon, 32.8], [lon + 0.0001, 32.8], [lon + 0.0001, 32.8001], [lon, 32.8001], [lon, 32.8]]],
});
const features: CandidateFeature[] = [
  { type: 'Feature', id: 'c-1', geometry: square(130.7), properties: { id: 'c-1', class: 'confirmed_new', area_m2: 142.3, area_id: 'z18-1-2' } },
  { type: 'Feature', id: 'c-2', geometry: square(130.7003), properties: { id: 'c-2', class: 'uncertain', area_m2: 88, area_id: 'z18-1-2' } },
];

function panel(selectedId: string | null) {
  return (
    <MapPanel
      areas={areas}
      areasState={{ status: 'ready', data: areas }}
      candidatesState={{ status: 'ready', data: features }}
      reloadCandidates={vi.fn()}
      reloadAreas={vi.fn()}
      focus={null}
      selectedId={selectedId}
      highlightIds={new Set()}
      onSelect={vi.fn()}
      onOpen={vi.fn()}
      onClearHighlight={vi.fn()}
      onComparePhotos={vi.fn()}
      onClearSelection={vi.fn()}
    />
  );
}

describe('選択中のカードと地図（本物の組み合わせ）', () => {
  it('印・形（Tab の停止は 1 つ）から、1 回の Tab で、カードの「写真を比べる」へ着く（残りの印を通らない）', async () => {
    render(panel('c-1'));
    await screen.findByRole('application');
    const stops = document.querySelectorAll<HTMLElement>('path[role="button"][tabindex="0"], .leaflet-marker-icon[tabindex="0"]');
    expect(stops).toHaveLength(1);
    stops[0]!.focus();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: '写真を比べる' })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: '選択を解除' })).toHaveFocus();
  });

  it('カードの下に隠れる形を選ぶと、地図がカードの上へ寄せる（MapPanel が、カードの要素を地図へ渡している）', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('prefers-reduced-motion'), media: query }));
    const mapOf = vi.spyOn(L, 'map');
    const { rerender } = render(panel(null));
    await screen.findByRole('application');
    const map = mapOf.mock.results.at(-1)!.value as L.Map;
    expect(map.getZoom()).toBeGreaterThanOrEqual(17); // 形で出ている
    const sw = map.latLngToContainerPoint([32.8, 130.7]);
    const rect = (left: number, top: number, width: number, height: number) =>
      ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
    const original = Element.prototype.getBoundingClientRect;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this.classList.contains('leaflet-host')) return rect(0, 0, 800, 600);
      // カードの上端が、形の下端より 3px 上（形の下端がカードの中へ入る）
      if (this.classList.contains('map-selected')) return rect(sw.x - 100, sw.y - 3, 200, 56);
      return original.call(this);
    });
    rerender(panel('c-1'));
    expect(screen.getByRole('group', { name: '選択中の候補' })).toBeInTheDocument();
    const moved = map.latLngToContainerPoint([32.8, 130.7]);
    expect(sw.y - moved.y).toBeGreaterThan(0);
    // 形の下端 + 形の外側の余白 9px + 空き 8px が、カードの上端に届く
    expect(sw.y - moved.y).toBeCloseTo(9 + 8 + 3, 0);
  });
});
