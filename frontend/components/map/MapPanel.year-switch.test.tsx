import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CandidateFeature } from '../../lib/api-types';
import { featureBBox, nextNonce, type MapFocus } from '../../lib/map-config';
import { areas } from '../../tests/fixtures';
import { MapPanel } from './MapPanel';

// 本物の LeafletMap を使う（MapPanel.test.tsx は、地図を差し替えている）。
// 実画面で「地図で 2014 年（標準地図）へ切り替える → 候補を一覧で見る → 行を押す」と、アプリ全体が白い英語のエラー画面になった。
// 行を押すと、HomeClient は地図を候補へ寄せる（fitBounds）。外した写真の層の処理が地図に残っていると、そこで落ちる
const api = vi.hoisted(() => ({ getCandidates: vi.fn() }));
vi.mock('../../lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/api')>()), getCandidates: api.getCandidates }));

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 600 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const feature: CandidateFeature = {
  type: 'Feature',
  id: 'c-1',
  geometry: { type: 'Polygon', coordinates: [[[130.7, 32.8], [130.7001, 32.8], [130.7001, 32.8001], [130.7, 32.8001], [130.7, 32.8]]] },
  properties: { id: 'c-1', class: 'confirmed_new', area_m2: 142.3, area_id: 'z18-1-2' },
};

/** HomeClient と同じく、一覧の行を押すと、地図をその候補へ寄せる（focus を渡す） */
function Harness() {
  const [focus, setFocus] = useState<MapFocus | null>(null);
  return (
    <MapPanel
      areas={areas}
      areasState={{ status: 'ready', data: areas }}
      candidatesState={{ status: 'ready', data: [feature] }}
      reloadCandidates={vi.fn()}
      reloadAreas={vi.fn()}
      focus={focus}
      selectedId={null}
      highlightIds={new Set()}
      onSelect={vi.fn()}
      onOpen={(id) => {
        const box = featureBBox(feature);
        if (box) setFocus({ bbox: box, ids: [id], nonce: nextNonce() });
      }}
      onClearHighlight={vi.fn()}
    />
  );
}

describe('地図の年（下地）を切り替えたあとに、一覧の行を押して候補へ寄せる（実画面で、アプリ全体が落ちた経路）', () => {
  for (const name of ['2014 年の写真', '標準地図']) {
    it(`${name}へ切り替えたあとでも、行を押せる（例外を出さず、エラー境界にも落ちない）`, async () => {
      api.getCandidates.mockResolvedValue({ total: 1, items: [{ id: 'c-1', area_id: 'z18-1-2', area_name: 'テスト地区 01', class: 'confirmed_new', area_m2: 142.3 }] });
      const errors: unknown[] = [];
      const onError = (e: ErrorEvent) => errors.push(e.error);
      window.addEventListener('error', onError);
      render(<Harness />);
      await screen.findByRole('application');
      await userEvent.click(screen.getByRole('button', { name }));
      await userEvent.click(document.querySelector('.cand-list > summary')!);
      const row = await screen.findByRole('button', { name: /c-1 の詳細を開く/ });
      await userEvent.click(row);
      await act(async () => {});
      window.removeEventListener('error', onError);
      expect(errors).toEqual([]);
      // 地図は壊れず、寄せの要求を受けられる
      await waitFor(() => expect(within(document.body).getByRole('application')).toBeInTheDocument());
    });
  }
});
