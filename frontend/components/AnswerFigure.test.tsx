import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { NO_IDS, type AnswerView } from '../lib/answer-view';
import type { AreaSummary, CandidateFeature } from '../lib/api-types';
import { ALL_FILTER } from '../lib/result-view';
import { areas, count } from '../tests/fixtures';
import { AnswerFigure, type FigureActions, type FigureData } from './AnswerFigure';

// 地図・グラフの中身は担当が別。ここでは、図の枠（名前・「拡大」・読み込み中の枠・状態を作る呼び出し・押した操作の宛先）だけを見る
vi.mock('./map/MapPanel', () => ({
  MapPanel: (p: {
    inline?: boolean;
    onSelect: (id: string) => void;
    onOpen: (id: string) => void;
    onComparePhotos?: (id: string) => void;
    onClearSelection?: () => void;
    onClearHighlight: () => void;
    onFilterChange?: (f: unknown) => void;
  }) => (
    <div data-testid="map-panel" data-inline={String(p.inline === true)}>
      <button type="button" onClick={() => p.onSelect('c-1')}>
        select
      </button>
      <button type="button" onClick={() => p.onOpen('c-2')}>
        open
      </button>
      <button type="button" onClick={() => p.onComparePhotos?.('c-3')}>
        compare
      </button>
      <button type="button" onClick={() => p.onClearSelection?.()}>
        clear-selection
      </button>
      <button type="button" onClick={() => p.onClearHighlight()}>
        clear-highlight
      </button>
      <button type="button" onClick={() => p.onFilterChange?.({ areaId: 'z18-1-2', classes: new Set(['uncertain']) })}>
        filter
      </button>
    </div>
  ),
}));
const boom = vi.hoisted(() => ({ on: false }));
vi.mock('./chart/AreaChartView', () => ({
  AreaChartView: (p: { onShowMap?: () => void; onFilterChange: (f: unknown) => void }) => {
    if (boom.on) throw new Error('グラフの描画が壊れた');
    return (
      <div data-testid="chart-view">
        {p.onShowMap && (
          <button type="button" onClick={p.onShowMap}>
            show-map
          </button>
        )}
        <button type="button" onClick={() => p.onFilterChange({ areaId: '', classes: new Set(['confirmed_new']) })}>
          chart-filter
        </button>
      </div>
    );
  },
}));

const answer = { id: 'm7', results: [count] };
const state: AnswerView = { view: 'map', filter: ALL_FILTER, highlightIds: NO_IDS, selected: null, mapFocus: null, pendingFocusId: null };

const ready = { status: 'ready' } as const;
function data(over: Partial<FigureData> = {}): FigureData {
  return {
    areas: areas as AreaSummary[],
    areasState: { ...ready, data: areas },
    candidatesState: { ...ready, data: [] as CandidateFeature[] },
    reloadAreas: vi.fn(),
    reloadCandidates: vi.fn(),
    ...over,
  };
}
function makeActions(): { [K in keyof FigureActions]: ReturnType<typeof vi.fn> } & FigureActions {
  return { ensure: vi.fn(), setFilter: vi.fn(), clearHighlight: vi.fn(), selectOnMap: vi.fn(), clearSelection: vi.fn(), expand: vi.fn() } as never;
}

function setup(over: Partial<ComponentProps<typeof AnswerFigure>> = {}) {
  const actions = makeActions();
  render(<AnswerFigure kind="map" answer={answer} state={state} data={data()} actions={actions} {...over} />);
  return actions;
}

describe('AnswerFigure（回答の中の図の枠）', () => {
  it('名前つきの region（名前は「地図」「グラフ」）。aria-live="off"。頭の行に、名前と「拡大」ボタン（名前は「地図を拡大」「グラフを拡大」）', () => {
    const { unmount } = render(<AnswerFigure kind="map" answer={answer} state={state} data={data()} actions={makeActions()} />);
    const map = screen.getByRole('region', { name: '地図' });
    expect(map).toHaveAttribute('aria-live', 'off');
    expect(map).toHaveClass('result-card', 'answer-figure');
    expect(within(map).getByRole('button', { name: '地図を拡大ビューで開く' })).toHaveTextContent('拡大');
    unmount();
    render(<AnswerFigure kind="chart" answer={answer} state={state} data={data()} actions={makeActions()} />);
    const chart = screen.getByRole('region', { name: 'グラフ' });
    expect(chart).toHaveAttribute('aria-live', 'off');
    expect(within(chart).getByRole('button', { name: 'グラフを拡大ビューで開く' })).toBeInTheDocument();
  });

  it('「拡大」: その回答を、その図の画面で開く。フォーカスの戻し先は、押した「拡大」ボタン', async () => {
    const actions = setup();
    const button = screen.getByRole('button', { name: '地図を拡大ビューで開く' });
    await userEvent.click(button);
    expect(actions.expand).toHaveBeenCalledWith(answer, { type: 'view', view: 'map' }, button);
  });

  it('グラフの「拡大」は、グラフの画面で開く', async () => {
    const actions = setup({ kind: 'chart' });
    const button = screen.getByRole('button', { name: 'グラフを拡大ビューで開く' });
    await userEvent.click(button);
    expect(actions.expand).toHaveBeenCalledWith(answer, { type: 'view', view: 'chart' }, button);
  });

  it('地図の操作は、回答の鍵（m7 の鍵）で状態へ当てる。写真を比べる・一覧は、拡大ビューを写真の比較で開く（戻し先は「拡大」ボタン）', async () => {
    const actions = setup();
    const opener = screen.getByRole('button', { name: '地図を拡大ビューで開く' });
    const key = 'answer:m7';
    await userEvent.click(screen.getByRole('button', { name: 'select' }));
    expect(actions.selectOnMap).toHaveBeenCalledWith(key, 'c-1');
    await userEvent.click(screen.getByRole('button', { name: 'clear-selection' }));
    expect(actions.clearSelection).toHaveBeenCalledWith(key);
    await userEvent.click(screen.getByRole('button', { name: 'clear-highlight' }));
    expect(actions.clearHighlight).toHaveBeenCalledWith(key);
    await userEvent.click(screen.getByRole('button', { name: 'filter' }));
    expect(actions.setFilter).toHaveBeenCalledWith(key, { areaId: 'z18-1-2', classes: new Set(['uncertain']) });
    await userEvent.click(screen.getByRole('button', { name: 'open' }));
    expect(actions.expand).toHaveBeenLastCalledWith(answer, { type: 'candidate', id: 'c-2' }, opener);
    await userEvent.click(screen.getByRole('button', { name: 'compare' }));
    expect(actions.expand).toHaveBeenLastCalledWith(answer, { type: 'compare', id: 'c-3' }, opener);
    // 地図は、回答の中の図として作る（ホイールでページのスクロールを奪わない）
    expect(screen.getByTestId('map-panel')).toHaveAttribute('data-inline', 'true');
  });

  it('グラフの絞り込みは、回答の鍵で状態へ当てる。「地図で見る」を押すと、地図の画面で開く（戻し先は「拡大」ボタン）', async () => {
    const actions = setup({ kind: 'chart' });
    await userEvent.click(screen.getByRole('button', { name: 'chart-filter' }));
    expect(actions.setFilter).toHaveBeenCalledWith('answer:m7', { areaId: '', classes: new Set(['confirmed_new']) });
    await userEvent.click(screen.getByRole('button', { name: 'show-map' }));
    expect(actions.expand).toHaveBeenCalledWith(answer, { type: 'view', view: 'map' }, screen.getByRole('button', { name: 'グラフを拡大ビューで開く' }));
  });

  it('その回答の状態が無いあいだは、読み込み中の枠だけ（中身は出さない）。地区・候補が届いた（失敗も含む）ら、状態を作るよう頼む。状態が有れば、頼まない', () => {
    const loading = makeActions();
    const { unmount } = render(
      <AnswerFigure kind="map" answer={answer} state={undefined} data={data({ candidatesState: { status: 'loading' } })} actions={loading} />,
    );
    expect(screen.getByText('地図を読み込んでいます…')).toBeInTheDocument();
    expect(screen.queryByTestId('map-panel')).toBeNull();
    expect(loading.ensure).not.toHaveBeenCalled();
    unmount();

    const done = makeActions();
    const second = render(<AnswerFigure kind="chart" answer={answer} state={undefined} data={data()} actions={done} />);
    expect(screen.getByText('グラフを読み込んでいます…')).toBeInTheDocument();
    expect(done.ensure).toHaveBeenCalledTimes(1);
    expect(done.ensure).toHaveBeenCalledWith(answer);
    second.unmount();

    const failed = makeActions();
    const third = render(
      <AnswerFigure
        kind="map"
        answer={answer}
       
        state={undefined}
        data={data({ candidatesState: { status: 'error', error: new Error('x') as never } })}
        actions={failed}
      />,
    );
    expect(failed.ensure).toHaveBeenCalledTimes(1);
    third.unmount();

    const has = makeActions();
    render(<AnswerFigure kind="map" answer={answer} state={state} data={data()} actions={has} />);
    expect(has.ensure).not.toHaveBeenCalled();
  });

  it('中身の描画が壊れても、図の枠（と「拡大」）は残り、チャットは巻き込まない（日本語のエラーと、もう一度表示する手段）', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    boom.on = true;
    try {
      setup({ kind: 'chart' });
      const region = screen.getByRole('region', { name: 'グラフ' });
      expect(within(region).getByRole('alert')).toHaveTextContent('「グラフ」を表示できませんでした');
      expect(within(region).getByRole('button', { name: 'グラフを拡大ビューで開く' })).toBeInTheDocument();
      boom.on = false;
      await userEvent.click(within(region).getByRole('button', { name: 'もう一度表示する' }));
      expect(within(region).getByTestId('chart-view')).toBeInTheDocument();
    } finally {
      boom.on = false;
      spy.mockRestore();
    }
  });
});
