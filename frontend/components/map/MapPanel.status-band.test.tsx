import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AreaSummary, CandidateFeature } from '../../lib/api-types';
import type { TileStatus } from '../../lib/map-config';
import { MapPanel } from './MapPanel';

// 地図の下の帯（.map-status）の守り: 標準地図のときのタイル通知・「強調表示を解除」・帯の最小の高さ。
// 通知を地図の上から帯へ移した新しい位置で、変異（判定を外す・条件を外す）に落ちるようにする。
// 一覧（CandidateList）が取りに行く先は、ここでは見ない（空を返す）
const api = vi.hoisted(() => ({ getCandidates: vi.fn() }));
vi.mock('../../lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/api')>()), getCandidates: api.getCandidates }));

// Leaflet 本体は LeafletMap.test.tsx で確かめる。ここでは、タイルの状態を、押したボタンで MapPanel へ伝える
vi.mock('./LeafletMap', () => ({
  default: (p: { onTileStatus: (s: TileStatus) => void }) => (
    <div className="leaflet-host" tabIndex={0}>
      {(['ok', 'partial', 'none'] as const).map((s) => (
        <button key={s} type="button" onClick={() => p.onTileStatus(s)}>
          タイル（{s}）
        </button>
      ))}
    </div>
  ),
}));

const areas: AreaSummary[] = [
  {
    id: 'a',
    name: 'アサヒ地区',
    ward: '中央区',
    bbox: [130.7, 32.8, 130.701, 32.801],
    centroid: [130.7005, 32.8005],
    counts: { confirmed_new: 1, existing_omission: 0, uncertain: 0, total: 1 },
  },
];
const features: CandidateFeature[] = [
  {
    type: 'Feature',
    id: 'c-1',
    geometry: { type: 'Polygon', coordinates: [[[130.7, 32.8], [130.7001, 32.8], [130.7001, 32.8001], [130.7, 32.8001], [130.7, 32.8]]] },
    properties: { id: 'c-1', class: 'confirmed_new', area_m2: 50, area_id: 'a' },
  },
];

function setup(highlightIds: ReadonlySet<string> = new Set()) {
  const onClearHighlight = vi.fn();
  render(
    <MapPanel
      areas={areas}
      areasState={{ status: 'ready', data: areas }}
      candidatesState={{ status: 'ready', data: features }}
      reloadCandidates={vi.fn()}
      reloadAreas={vi.fn()}
      focus={null}
      selectedId={null}
      highlightIds={highlightIds}
      onSelect={vi.fn()}
      onOpen={vi.fn()}
      onClearHighlight={onClearHighlight}
    />,
  );
  return { onClearHighlight };
}

const statusBar = () => document.querySelector<HTMLElement>('.map-status')!;
// タイル通知は、いつも描く入れ物（role=status）の文だけが替わる（空のときは、文字が無い）
const tileNotice = () => statusBar().querySelector('.map-status__note[role="status"]')?.textContent ?? '';

beforeEach(() => {
  api.getCandidates.mockReset();
  api.getCandidates.mockResolvedValue({ total: 0, items: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('標準地図のときは、写真が無い旨のタイル通知を出さない', () => {
  it('対照: 写真の地図で、タイルが none / partial なら、通知を出す（role=status）。ok なら出さない', async () => {
    setup();
    await screen.findByRole('button', { name: 'タイル（none）' }); // 地図は、遅れて読み込む
    expect(tileNotice()).toBe('');
    await userEvent.click(screen.getByRole('button', { name: 'タイル（none）' }));
    expect(tileNotice()).toContain('この範囲には、この年の写真がありません');
    await userEvent.click(screen.getByRole('button', { name: 'タイル（partial）' }));
    expect(tileNotice()).toContain('この範囲の一部には、この年の写真がありません');
    await userEvent.click(screen.getByRole('button', { name: 'タイル（ok）' }));
    expect(tileNotice()).toBe('');
  });

  it('標準地図を選んでいれば、タイルが none / partial でも、通知を出さない（標準地図には、写真の有無が関係しない）', async () => {
    setup();
    await screen.findByRole('button', { name: 'タイル（none）' });
    await userEvent.click(screen.getByRole('button', { name: '標準地図' }));
    await userEvent.click(screen.getByRole('button', { name: 'タイル（none）' }));
    expect(tileNotice()).toBe('');
    expect(document.body).not.toHaveTextContent('写真がありません');
    await userEvent.click(screen.getByRole('button', { name: 'タイル（partial）' }));
    expect(tileNotice()).toBe('');
    // 写真の地図へ戻すと、同じタイルの状態で、通知が出る
    await userEvent.click(screen.getByRole('button', { name: '2024 年の写真' }));
    expect(tileNotice()).toContain('この範囲の一部には、この年の写真がありません');
  });
});

describe('「強調表示を解除」は、強調している候補があるときだけ出す', () => {
  it('強調が無いときは、地図の下の帯に出さない', () => {
    setup(new Set());
    expect(screen.queryByRole('button', { name: '強調表示を解除' })).not.toBeInTheDocument();
  });

  it('強調があるときは、地図の下の帯に出し、押すと onClearHighlight を呼ぶ', async () => {
    const { onClearHighlight } = setup(new Set(['c-1']));
    const button = screen.getByRole('button', { name: '強調表示を解除' });
    expect(statusBar()).toContainElement(button);
    await userEvent.click(button);
    expect(onClearHighlight).toHaveBeenCalledTimes(1);
  });
});

describe('地図の下の帯（.map-status）の高さ', () => {
  // CSS はテストでは読み込まれない（vitest の css: false）。規則そのものを確かめる
  const css = readFileSync(join(process.cwd(), 'app', 'globals.css'), 'utf8');
  const rule = (() => {
    const start = css.indexOf('\n.map-status {');
    return start < 0 ? '' : css.slice(start, css.indexOf('}', start));
  })();

  it('最小の高さは 36px（通知・案内が無い間も、帯の高さが揺れない。地図の高さの見積もりの一部）', () => {
    expect(rule).not.toBe('');
    expect(rule).toMatch(/min-height\s*:\s*36px/);
  });

  it('長い文は、帯の中で折り返す（文の部分が縮められる。通知・案内を足しても、はみ出さない）', () => {
    const textStart = css.indexOf('\n.map-status__text {');
    const textRule = textStart < 0 ? '' : css.slice(textStart, css.indexOf('}', textStart));
    expect(textRule).not.toBe('');
    expect(textRule).toMatch(/flex\s*:\s*1/);
    expect(textRule).toMatch(/min-width\s*:\s*0/);
  });
});
