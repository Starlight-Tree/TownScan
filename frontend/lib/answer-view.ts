import type { AreaSummary, BBox, CandidateDetail, CandidateFeature, ToolResult } from './api-types';
import { featureBBox, nextNonce, scopeBBox, type MapFocus } from './map-config';
import {
  ALL_FILTER,
  areaScopeIds,
  filterFromResults,
  isWellFormedResult,
  widenFilterFor,
  type MapFilter,
  type ResultView,
} from './result-view';

/**
 * 拡大ビュー（`/` のダイアログ。地図・グラフ・写真の比較）の、回答 1 件ぶんの状態。
 * 拡大の単位は回答 1 件で、会話のあいだ HomeClient が回答ごとに持つ（保存はしない）。地図の拡大・移動は含めない（閉じると地図は外れる）。
 * ここの関数は、状態を受けて新しい状態を返すだけの純粋な関数（HomeClient が、いまの状態へ当てる）
 */

/** 詳細（写真の比較）で選んでいる候補。focus は、その詳細を開いたとき見出しへフォーカスを移すか（詳細をマウントする時点の値で決まる） */
export interface Selection {
  id: string;
  focus: boolean;
}

export interface AnswerView {
  /** 選んでいるタブ */
  view: ResultView;
  /** 地図・グラフ・一覧に共通の絞り込み */
  filter: MapFilter;
  /** 地図で強調している候補 */
  highlightIds: ReadonlySet<string>;
  /** 写真の比較で選んでいる候補 */
  selected: Selection | null;
  /** 地図の寄せ先。開き直したとき、この範囲へ寄せる（無ければ、地図が地区の枠の収まる範囲を見せる） */
  mapFocus: MapFocus | null;
  /** 詳細を開いたとき、地図の候補データにまだ形が無ければ、詳細が届いてから寄せる候補 */
  pendingFocusId: string | null;
}

/** 状態を持つ回答（チャットの回答 1 件）。results は、その回答の道具の結果 */
export interface AnswerRef {
  id: string;
  results: readonly ToolResult[];
}

/** 押したボタンが頼む、拡大ビューの開き方 */
export type ExpandRequest =
  /** 「グラフで見る」「地図で見る」（件数・比較）、最初の画面の「解析した地区を地図で見る」: その画面で開く */
  | { type: 'view'; view: ResultView }
  /** 地図の表示（map_focus）の「地図で見る」: 候補を目立たせ、範囲へ寄せて、地図で開く */
  | { type: 'focus'; bbox: BBox; candidateIds: string[] }
  /** 結果カードの「詳細」「詳細を開く」: その候補を選び、地図もその候補へ寄せて、写真の比較で開く */
  | { type: 'candidate'; id: string };

/** 状態を決めるときに読む、いまの地区の一覧と地図の候補データ（まだ読み込まれていなければ空） */
export interface AnswerContext {
  areas: AreaSummary[];
  byId: ReadonlyMap<string, CandidateFeature>;
}

export const NO_IDS: ReadonlySet<string> = new Set();

const WELCOME_KEY = 'welcome';

/** 回答ごとの状態の鍵。回答を持たない拡大ビュー（最初の画面の「解析した地区を地図で見る」）は、1 つだけの鍵を使う */
export function answerKey(answer: AnswerRef | null): string {
  return answer ? `answer:${answer.id}` : WELCOME_KEY;
}

const fit = (bbox: BBox, ids: string[]): MapFocus => ({ bbox, ids, nonce: nextNonce() });

/** 絞り込みの対象の地区（なければ全地区）が収まる範囲への寄せ。地区の一覧が無ければ null */
function scopeFocus(areas: AreaSummary[], filter: MapFilter): MapFocus | null {
  const box = scopeBBox(areas, areaScopeIds(filter));
  return box ? fit(box, []) : null;
}

/**
 * 強調・選択する候補が、いまの絞り込みで隠れないように広げる（分類が無ければ足し、地区が外なら全地区に戻す）。
 * まだ読み込まれていない候補（byId に無い）は、何もしない
 */
function widenForIds(filter: MapFilter, ids: readonly string[], byId: ReadonlyMap<string, CandidateFeature>): MapFilter {
  return ids.reduce((acc, id) => {
    const f = byId.get(id);
    return f ? widenFilterFor(acc, f.properties) : acc;
  }, filter);
}

/**
 * 候補を選び、地図もその候補へ寄せる（画面は替えない）。focus は、開く詳細が見出しへフォーカスを移すか。
 * 候補の形が地図の候補データに無いときは、詳細が届いてから寄せる（pendingFocusId）
 */
function selectCandidate(state: AnswerView, id: string, focus: boolean, ctx: AnswerContext): AnswerView {
  const feature = ctx.byId.get(id);
  const box = feature ? featureBBox(feature) : null;
  return {
    ...state,
    selected: { id, focus },
    filter: widenForIds(state.filter, [id], ctx.byId),
    mapFocus: box ? fit(box, [id]) : state.mapFocus,
    pendingFocusId: box ? null : id,
  };
}

/**
 * 回答の結果から決める、はじめて開くときの状態（絞り込みは「回答の条件」、強調・選択は map_focus・検出画像の候補。寄せ先は、それらの範囲か、条件の地区）。
 * 回答が届いたことでは、何も開かず、何も替えない。ここは、その回答の拡大ビューを、はじめて開くときだけ使う
 */
export function initialAnswerView(results: readonly ToolResult[], ctx: AnswerContext): AnswerView {
  // 回答の「対象・条件」の行（AnswerScope）と同じ前処理: 壊れた結果（filter の無い count）は、条件なしと読まず、飛ばす
  const readable = results.filter(isWellFormedResult);
  let state: AnswerView = {
    view: 'map',
    filter: filterFromResults(readable) ?? ALL_FILTER,
    highlightIds: NO_IDS,
    selected: null,
    mapFocus: null,
    pendingFocusId: null,
  };
  // 地図の表示（最後のもの）: 候補を強調し、その範囲へ寄せる。強調する候補が、絞り込みで隠れないように広げる
  const focus = [...readable].reverse().find((r) => r.type === 'map_focus');
  if (focus?.type === 'map_focus' && Array.isArray(focus.candidate_ids)) {
    state = {
      ...state,
      highlightIds: new Set(focus.candidate_ids),
      filter: widenForIds(state.filter, focus.candidate_ids, ctx.byId),
      mapFocus: fit(focus.bbox, focus.candidate_ids),
    };
  }
  // 検出画像（最後のもの）: その候補を、見出しへフォーカスを移さずに選ぶ
  const detection = [...readable].reverse().find((r) => r.type === 'detection_image');
  if (detection?.type === 'detection_image' && typeof detection.candidate_id === 'string' && detection.candidate_id !== '') {
    state = selectCandidate(state, detection.candidate_id, false, ctx);
  }
  // 範囲の指定が無ければ、条件の地区（なければ全地区）が収まる範囲へ
  return state.mapFocus ? state : { ...state, mapFocus: scopeFocus(ctx.areas, state.filter) };
}

/**
 * 押したボタンの画面で、拡大ビューを開く。はじめてでも開き直しでも、利用者が変えたタブ・絞り込み・選択はそのまま残し（はじめてのときは、initialAnswerView の状態）、
 * ボタンが決める分だけを当てる: 画面と、地図の表示・詳細の候補（押すたびに、強調・選択・寄せ先を当て直す）
 */
export function applyExpandRequest(state: AnswerView, request: ExpandRequest, ctx: AnswerContext): AnswerView {
  // 見出しへフォーカスを移す指定は、その詳細を開いた操作のもの。開き直したとき、タブ操作で見える詳細が、フォーカスを奪わないように外す
  const calm: AnswerView = state.selected?.focus ? { ...state, selected: { ...state.selected, focus: false } } : state;
  switch (request.type) {
    case 'view': {
      // 寄せ先が候補を指すもの（ids がある。地図の表示・詳細）なら、そのまま残す（押しても動かさない）。
      // 条件の地区から決めたもの（ids が空）・まだ無いものは、開き直すたびに、いまの絞り込みの地区へ決め直す
      // （地区の選択・グラフの行で絞ったあとに開き直しても、その地区が見える。地区の一覧が無ければ、いまの寄せ先のまま）
      const targeted = calm.mapFocus !== null && calm.mapFocus.ids.length > 0;
      const mapFocus = targeted ? calm.mapFocus : (scopeFocus(ctx.areas, calm.filter) ?? calm.mapFocus);
      return { ...calm, view: request.view, mapFocus };
    }
    case 'focus':
      return {
        ...calm,
        view: 'map',
        highlightIds: new Set(request.candidateIds),
        filter: widenForIds(calm.filter, request.candidateIds, ctx.byId),
        mapFocus: fit(request.bbox, request.candidateIds),
      };
    case 'candidate':
      return { ...selectCandidate(calm, request.id, true, ctx), view: 'photos' };
    default: {
      const unexpected: never = request;
      return unexpected;
    }
  }
}

// ---- 拡大ビューの中の操作（開いているあいだ、いまの回答の状態へ当てる）----

/** 地図の印・形を選んだ: 地図に留まり、その候補を選ぶ（フォーカスは地図に残す）。絞り込みの外なら広げる */
export function selectFromMap(state: AnswerView, id: string, ctx: AnswerContext): AnswerView {
  return { ...state, selected: { id, focus: false }, pendingFocusId: null, filter: widenForIds(state.filter, [id], ctx.byId) };
}

/** 地図の上の「写真を比べる」: その候補を選んで（すでに選んでいても）写真の比較へ。見出しへフォーカスを移す */
export function comparePhotos(state: AnswerView, id: string): AnswerView {
  return { ...state, selected: { id, focus: true }, view: 'photos' };
}

/** 候補の一覧から開く: 写真の比較へ切り替えて、見出しへフォーカスを移し、地図もその候補へ寄せる */
export function openCandidate(state: AnswerView, id: string, ctx: AnswerContext): AnswerView {
  return { ...selectCandidate(state, id, true, ctx), view: 'photos' };
}

/** 選択を外す（詳細の「閉じる」・地図のカードの「選択を解除」） */
export function clearSelection(state: AnswerView): AnswerView {
  return state.selected === null && state.pendingFocusId === null ? state : { ...state, selected: null, pendingFocusId: null };
}

/** 詳細が届いた: 地図の候補データに形が無かった候補は、ここで寄せる（予約が残っているときだけ） */
export function detailLoaded(state: AnswerView, detail: CandidateDetail): AnswerView {
  if (state.pendingFocusId !== detail.id || !detail.bbox) return state;
  return { ...state, pendingFocusId: null, mapFocus: fit(detail.bbox, [detail.id]) };
}

/** 詳細の「地図で見る」: 詳細の分類・地区で絞り込みを広げ（地図の候補データに無い候補でも、詳細は届いている）、その候補へ寄せて、地図へ */
export function showDetailOnMap(state: AnswerView, detail: CandidateDetail): AnswerView {
  return { ...state, filter: widenFilterFor(state.filter, detail), mapFocus: fit(detail.bbox, [detail.id]), view: 'map' };
}

/** グラフの「地図で見る」: 地図へ切り替え、いまの条件の地区（なければ全地区）が収まる範囲へ寄せる */
export function showMapForFilter(state: AnswerView, ctx: AnswerContext): AnswerView {
  return { ...state, view: 'map', mapFocus: scopeFocus(ctx.areas, state.filter) ?? state.mapFocus };
}
