'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, postChat } from '../../lib/api';
import { planAnswer, type AnswerRef, type ExpandRequest, type FigureKind } from '../../lib/answer-view';
import type { ChatRequestMessage, ToolCall, ToolResult } from '../../lib/api-types';
import { useAreas } from '../../lib/areas-context';
import { conversationErrorKind, getConversationMessages } from '../../lib/conversations-api';
import {
  clearConversationId,
  isConversationId,
  newConversationId,
  readConversationId,
  writeConversationId,
} from '../../lib/conversation-session';
import { formatSentAt } from '../../lib/sentAt';
import { useHealth } from '../HealthProvider';
import { useHistory } from '../HistoryProvider';
import { usePublishConversationStatus, useRegisterConversationOpen, useRegisterNewConversation } from '../NewConversation';
import { TILE_SIDE_TEXT } from './area-scale';
import { ClassDefinitions } from './ClassGuide';
import { Composer } from './Composer';
import {
  currentRunFrom,
  entriesFromStored,
  isLoginCheckFailure,
  MSG_CONVERSATION_FULL,
  MSG_NOT_SAVED,
  MSG_NOT_SAVED_EXPIRED,
  MSG_RESTORE_FAILED,
  MSG_RESTORE_NOT_FOUND,
  MSG_RESTORING,
  MSG_STALE_RUN,
  runCheck,
  type CurrentRun,
} from './conversation';
import { buildRequestMessages } from './history';
import { ResultCard } from './ResultCard';
import type { ChatActions, ChatEntry, ResultActions } from './types';

/** 答えられる質問の例 */
const IN_SCOPE_SUGGESTIONS = [
  '候補は何件ありますか？',
  '地区ごとの候補数を比べて',
  '面積の大きい候補を一覧にして',
  'いちばん大きい候補の写真を見せて',
  'このアプリの精度は？',
];

/** 範囲外の質問の例。押すと、断って理由を返す（最初の画面で「断る」ことも見せる） */
const OUT_OF_SCOPE_SUGGESTIONS = ['渋谷の新築は？'];

export const SUGGESTIONS = [...IN_SCOPE_SUGGESTIONS, ...OUT_OF_SCOPE_SUGGESTIONS];

interface Props {
  actions: ChatActions;
  /**
   * 回答の中に出す図（地図・グラフ）。回答の結果から、出る図（多くても 1 つ）が決まり（planAnswer）、結果カードの下に、この関数が返すものを出す。
   * 図は、親（HomeClient）が持つ回答ごとの状態を読み書きするので、ここでは中身を知らない。渡さなければ、図は出さない
   */
  renderFigure?: (answer: AnswerRef, kind: FigureKind) => ReactNode;
  /** 「新しい会話」（チャットの中のボタンも、サイドパネルのボタンも）で会話を空にしたあとに呼ぶ。親が、拡大ビューを閉じ、回答ごとの状態を捨てる */
  onNewConversation?: () => void;
  /**
   * この画面で、回答が届いて並べたときに呼ぶ（保存した会話を開き直して並べたときは呼ばない）。狭い幅で、チャット以外のタブにいる利用者へ、新着を知らせるため。
   * 親は、ここでフォーカスも画面も動かしてはいけない
   */
  onAnswer?: () => void;
}

interface Failure {
  message: string;
  code: string;
}

/** 保存した会話を開き直しているときの状態（仕様 §7.1.4）。notfound は、失敗と分ける（会話が無い。会話 ID は忘れている） */
type Restore = { status: 'idle' } | { status: 'loading' } | { status: 'error' } | { status: 'notfound' };
const IDLE: Restore = { status: 'idle' };

/**
 * いまの会話の、保存の記録（画面の中だけ。ref で持つ）。
 * - id: 保存する会話の ID。ログイン中の新しい会話の、最初の送信で作る（crypto.randomUUID）。開き直した会話は、その ID
 * - saved: id を sessionStorage に書いたか。conversation_id つきで送った最初の回答が届いたときに書く（失敗・保存を飛ばした送信では書かない。仕様 §7.1.4 の 1〔J6〕）
 * - skipped: 保存を 1 度でも飛ばしたか。飛ばした会話では、以降の送信にも conversation_id を付けない（仕様 §2.3.4・§7.1.7）。「新しい会話」・開き直しで戻る
 * - pendingNotice: 保存を飛ばした回答に、1 回だけ出す注記。回答を並べたときに出して消す（飛ばした送り直しが失敗して「もう一度送る」になっても、成功した回答に出る）
 */
interface ConversationRecord {
  id: string | null;
  saved: boolean;
  skipped: boolean;
  pendingNotice?: string;
}
const NEW_RECORD = (): ConversationRecord => ({ id: null, saved: false, skipped: false });

let nextId = 0;
const newId = () => `m${++nextId}`;

/** 要素 el の上端の位置（スクロールする枠 box の中身の先頭から数える。枠のスクロール量を含む） */
function offsetWithin(box: HTMLElement, el: HTMLElement): number {
  return el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
}

/**
 * 回答が届いたあとの、チャット欄のスクロール位置。
 * - 回答が欄の高さに収まるなら、いちばん下（回答の先頭も見える）。
 * - 欄より長い回答は、いちばん下まで送ると、結論の最初の文と質問が上に隠れる。質問（直前の自分の発言）の先頭が見える位置に合わせる。
 *   質問が長く、欄の 3 分の 1 を超えるときは、回答の先頭に合わせる。
 */
function scrollTopForAnswer(box: HTMLElement): number {
  const nodes = box.querySelectorAll<HTMLElement>('[data-entry]');
  const answer = nodes[nodes.length - 1];
  if (!answer || answer.dataset.entry !== 'assistant') return box.scrollHeight;
  if (answer.getBoundingClientRect().height <= box.clientHeight) return box.scrollHeight;
  const answerTop = offsetWithin(box, answer);
  const question = nodes.length > 1 ? nodes[nodes.length - 2] : undefined;
  if (question && question.dataset.entry === 'user') {
    // 質問の時刻（直前の <time>）は質問の外にある。時刻から合わせないと、時刻が欄の上に隠れる
    const time = question.previousElementSibling;
    const questionTop = offsetWithin(box, time instanceof HTMLElement && time.matches('time.chat__time') ? time : question);
    if (answerTop - questionTop <= box.clientHeight / 3) return questionTop;
  }
  return answerTop;
}

/** 指で触る端末（主な入力が指）では、質問の例を押したあとに入力欄へ移すと、画面のキーボードが開いて回答を隠す */
function prefersTouch(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
}

export function ChatPanel({ actions, renderFigure, onNewConversation, onAnswer }: Props) {
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  // 会話の履歴（ログイン中だけ。ログインしていなければ、ここの値は使わず、履歴の API も /api/auth/token も呼ばない）
  const history = useHistory();
  const historyRef = useRef(history);
  useEffect(() => {
    historyRef.current = history;
  });
  // 「表示を切り替える」でその場に出した、2 位以下の結果（鍵は「回答の ID:結果の添字」。回答の ID は使い回さない）
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(() => new Set());
  const [restore, setRestore] = useState<Restore>(IDLE);
  // サイドパネルの一覧が「いま開いている会話」として見せる ID（保存された会話だけ。始めたばかりの会話は null）
  const [currentId, setCurrentId] = useState<string | null>(null);
  const conversationRef = useRef<ConversationRecord>(NEW_RECORD());
  const sendingRef = useRef(false);
  // 開き直し・新しい会話・送信のたびに進める。遅れて届いた開き直しの結果を捨てるための印（DocuNavi の jobRef）
  const jobRef = useRef(0);
  const restoreAbortRef = useRef<AbortController | null>(null);
  // いまの解析結果。health の読み込みが終わった最初の 1 回だけ決める（開き直した回答との食い違いを、1 回だけ比べる。仕様 §7.1.5 の 2）
  const health = useHealth();
  const [currentRun, setCurrentRun] = useState<CurrentRun>({ status: 'pending' });
  if (currentRun.status === 'pending') {
    const next = currentRunFrom(health.state);
    if (next.status !== 'pending') setCurrentRun(next);
  }
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // 再送する中身と、画面上のどの発言か（失敗の印をつけ外しするため）
  const retryRef = useRef<{ messages: ChatRequestMessage[]; entryId: string } | null>(null);
  // 最後に押されたボタン（結果カードの「地図で見る」・「詳細」など）。拡大ビューを閉じたとき、フォーカスをここへ戻す。
  // ボタンを押してもフォーカスが移らないブラウザー（macOS の Safari・Firefox）でも、押したボタンを正しく指すため、押した時点の対象を控える
  const pressedRef = useRef<HTMLElement | null>(null);
  // request（再作成しない）の中から、最新の onAnswer を呼ぶための控え
  const onAnswerRef = useRef(onAnswer);
  useEffect(() => {
    onAnswerRef.current = onAnswer;
  });

  useEffect(() => () => abortRef.current?.abort(), []);

  // 新しい発言・状態の変化のあと、いちばん下へ。発言が 1 件も無い間（説明の画面だけ）は、下へ動かさない:
  // 開いた直後に下まで送ると、説明の見出しから読み始められない。「新しい会話」で 0 件に戻ったときは、説明の先頭へ戻す。
  // 回答が届いたとき（送信中でも失敗でもない）は、長い回答の冒頭と質問が見える位置にする（scrollTopForAnswer）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (entries.length === 0) el.scrollTop = 0;
    else if (entries[entries.length - 1]?.role === 'assistant' && !sending && !failure) el.scrollTop = scrollTopForAnswer(el);
    else el.scrollTop = el.scrollHeight;
  }, [entries, sending, failure]);

  // 質問の例を押す・「新しい会話」を押すと、押したボタンが消える（または押せなくなる）ので、フォーカスが body へ落ちる。
  // キーボードの人が、先頭から Tab をたどり直さずに続きを入力できるよう、入力欄へ移す。
  // 画面の外へ動かさない（preventScroll）。指で触る端末では、画面のキーボードが開くので移さない
  const focusComposer = useCallback(() => {
    if (!prefersTouch()) inputRef.current?.focus({ preventScroll: true });
  }, []);

  const request = useCallback(
    async (messages: ChatRequestMessage[], entryId: string) => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      // 送信を始めたら、取得中の開き直しの結果は捨てる（仕様 §7.1.4 の 2）
      jobRef.current += 1;
      restoreAbortRef.current?.abort();
      setRestore(IDLE);
      sendingRef.current = true;
      retryRef.current = { messages, entryId };
      setSending(true);
      setFailure(null);
      // 保存するか: ログイン中（期限切れでない）で、保存を飛ばしていない会話だけ、conversation_id を付ける。ログインしていなければ、今までどおり（付けない・JWT も取らない）。
      // ID は、ログイン中の新しい会話の最初の送信で作る（「もう一度送る」は同じ ID で送る）
      const record = conversationRef.current;
      let conversationId: string | null = null;
      if (historyRef.current.active && !record.skipped) {
        record.id ??= newConversationId();
        conversationId = record.id;
      }
      if (conversationId === null && !record.skipped && historyRef.current.loggedIn && historyRef.current.expired) {
        // ログインの期限切れが先に分かっている（一覧・開き直しの 401）。保存せずに送り、注記を 1 回だけ出す（以降の送信にも conversation_id を付けない）
        record.skipped = true;
        record.pendingNotice = MSG_NOT_SAVED_EXPIRED;
      }
      try {
        let res;
        try {
          res = await postChat(messages, ctrl.signal, conversationId ?? undefined);
        } catch (e) {
          if (ctrl.signal.aborted || conversationId === null || !isLoginCheckFailure(e)) throw e;
          // ログインの確認が通らなかった（取り直しても 401、またはログインの確認だけが 503）: 保存せずに送り直す。「ログインしなくても全機能が使える」を、ログインの失敗で崩さない。
          // 401 は LLM を呼ぶ前に返るので、LLM を呼ぶのは、この送り直しの 1 回だけ。保存を飛ばした会話では、以降の送信にも conversation_id を付けない（仕様 §2.3.4・§7.1.7）
          if (e.status === 401) historyRef.current.markExpired();
          record.skipped = true;
          record.pendingNotice = MSG_NOT_SAVED;
          conversationId = null;
          res = await postChat(messages, ctrl.signal);
        }
        // 「新しい会話」で捨てた返答は、新しい会話に混ぜない
        if (ctrl.signal.aborted) return;
        const msg = res.message;
        const results = Array.isArray(msg?.results) ? msg.results : [];
        const toolCalls: ToolCall[] = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
        const notice = record.pendingNotice;
        record.pendingNotice = undefined;
        setEntries((prev) => [
          ...prev.map((e) => (e.id === entryId && e.failed ? { ...e, failed: false } : e)),
          {
            id: newId(),
            role: 'assistant',
            content: typeof msg?.content === 'string' ? msg.content : '',
            results,
            tool_calls: toolCalls,
            ...(notice ? { notice } : {}),
          },
        ]);
        retryRef.current = null;
        onAnswerRef.current?.();
        if (conversationId !== null) {
          // 保存された（サーバーが回答と一緒に保存する）。ID を sessionStorage に書くのは、conversation_id つきで送った最初の回答が届いたとき（失敗・保存を飛ばした送信では書かない）
          if (!record.saved) {
            record.saved = true;
            writeConversationId(conversationId);
            setCurrentId(conversationId);
          }
          // 回答が最後まで届いたので、一覧を取り直す（新しい会話・更新の新しい順）
          historyRef.current.list.reload();
        }
      } catch (e) {
        // 保存つきで送って止まったとき（通信が切れたが、サーバーは保存していたかもしれない）も、一覧を取り直す（仕様 §7.1.3・§2.3.4）
        if (conversationId !== null) historyRef.current.list.reload();
        if (ctrl.signal.aborted) return;
        const err = e instanceof ApiError ? e : new ApiError('送信に失敗しました。', 0, 'unknown');
        setEntries((prev) => prev.map((x) => (x.id === entryId ? { ...x, failed: true } : x)));
        // 1 会話の発言数の上限は、再送しても直らない（「もう一度送る」は出さない）。文は仕様のとおり
        setFailure({ message: err.code === 'conversation_full' ? MSG_CONVERSATION_FULL : err.message, code: err.code });
      } finally {
        if (abortRef.current === ctrl) {
          sendingRef.current = false;
          setSending(false);
        }
      }
    },
    [],
  );

  /** 質問を送る。受け付けたら true（空・返答待ちのときは false で、入力欄の文を残す） */
  const send = useCallback(
    (raw: string): boolean => {
      const text = raw.trim();
      if (!text || sending) return false;
      const messages = buildRequestMessages(entries, text);
      const entryId = newId();
      // 時刻は、質問を作ったこの端末で付ける（表示だけに使う。API へは送らない: messages は buildRequestMessages が役割と本文だけで作る）
      setEntries((prev) => [...prev, { id: entryId, role: 'user', content: text, sentAt: new Date().toISOString() }]);
      setInput('');
      void request(messages, entryId);
      return true;
    },
    [entries, request, sending],
  );

  const retry = useCallback(() => {
    const r = retryRef.current;
    if (r) void request(r.messages, r.entryId);
  }, [request]);

  // 会話をやり直す。返答待ちの通信も止める。開いている会話 ID も忘れる（sessionStorage の値を消し、「保存を飛ばした」印も戻す。次に送るとき、新しい ID を作る）
  const reset = useCallback(() => {
    jobRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    restoreAbortRef.current?.abort();
    restoreAbortRef.current = null;
    sendingRef.current = false;
    retryRef.current = null;
    conversationRef.current = NEW_RECORD();
    clearConversationId();
    setCurrentId(null);
    setRestore(IDLE);
    setEntries([]);
    setFailure(null);
    setSending(false);
    onNewConversation?.();
    focusComposer();
  }, [focusComposer, onNewConversation]);

  /** 保存した会話の発言を取って並べる。取得の間に別の会話へ移った・新しい会話にした・送信を始めたなら（jobRef が進む）、遅れて届いた結果は捨てる */
  const loadConversation = useCallback((id: string) => {
    const token = ++jobRef.current;
    restoreAbortRef.current?.abort();
    const ctrl = new AbortController();
    restoreAbortRef.current = ctrl;
    setRestore({ status: 'loading' });
    getConversationMessages(id, ctrl.signal).then(
      (messages) => {
        if (jobRef.current !== token) return;
        setEntries(entriesFromStored(messages, newId));
        setRestore(IDLE);
      },
      (error: unknown) => {
        if (jobRef.current !== token || ctrl.signal.aborted) return;
        const kind = conversationErrorKind(error);
        if (kind === 'not_found') {
          // 会話が無い（削除された・保存の上限で消えた）。失敗と分けて知らせ、会話 ID を忘れる（再試行しても直らない）
          conversationRef.current = NEW_RECORD();
          clearConversationId();
          setCurrentId(null);
          setRestore({ status: 'notfound' });
          return;
        }
        if (kind === 'unauthorized') historyRef.current.markExpired();
        // 失敗しても会話 ID は捨てない（再試行できるように）
        setRestore({ status: 'error' });
      },
    );
  }, []);

  /**
   * 保存した会話を開く（サイドパネルの一覧の項目・立ち上がり・再試行）。返答待ちを止め、発言を空にし、拡大ビューも「新しい会話」と同じに閉じて回答ごとの状態を捨てる（startup は、まだ何も無いので呼ばない）。
   * 会話 ID を sessionStorage に書き、取得して並べる。生成中は、別の会話へ移らない（一覧のボタンも押せない。生成が止まってしまうため）
   */
  const openConversation = useCallback(
    (id: string, startup = false) => {
      if (!isConversationId(id) || sendingRef.current) return;
      retryRef.current = null;
      conversationRef.current = { id, saved: true, skipped: false };
      writeConversationId(id);
      setCurrentId(id);
      setEntries([]);
      setFailure(null);
      if (!startup) onNewConversation?.();
      loadConversation(id);
    },
    [loadConversation, onNewConversation],
  );
  const openRef = useRef(openConversation);
  useEffect(() => {
    openRef.current = openConversation;
  });

  // 立ち上がり（再読み込み・精度の画面からホームへ戻ったとき）: ログイン中は、覚えている会話 ID があれば、自動で開き直す。
  // ログインしていなければ、ID を見ない（残っていれば消す。次に同じタブで別の人がログインしても、前の人の ID を開こうとしない）
  useEffect(() => {
    if (!historyRef.current.active) {
      clearConversationId();
      return;
    }
    const id = readConversationId();
    if (id !== null) openRef.current(id, true);
    return () => restoreAbortRef.current?.abort();
  }, []);

  const retryRestore = useCallback(() => {
    const id = conversationRef.current.id;
    if (id !== null) loadConversation(id);
  }, [loadConversation]);

  // サイドパネルの「新しい会話」も、同じ処理を呼ぶ。一覧の項目も、会話を開く処理を呼ぶ
  useRegisterNewConversation(reset);
  const openFromList = useCallback((id: string) => openConversation(id), [openConversation]);
  useRegisterConversationOpen(openFromList);
  usePublishConversationStatus(currentId, sending);

  // 回答ごとの質問（その回答の直前の、利用者の発言）。拡大ビューが、どの回答かを示すのに使う
  const questionByAnswer = useMemo(() => {
    const map = new Map<string, string>();
    let last: string | undefined;
    for (const e of entries) {
      if (e.role === 'user') last = e.content;
      else if (last !== undefined) map.set(e.id, last);
    }
    return map;
  }, [entries]);
  const refFor = (entry: ChatEntry): AnswerRef => {
    const question = questionByAnswer.get(entry.id);
    return { id: entry.id, results: entry.results ?? [], ...(question ? { question } : {}) };
  };

  // 結果カードの操作を、その回答に束ねる。状態の単位は回答 1 件で、どの回答のカードを押したかを、親へ渡す
  const actionsFor = useCallback(
    (entry: ChatEntry): ResultActions => {
      const question = questionByAnswer.get(entry.id);
      const answer: AnswerRef = { id: entry.id, results: entry.results ?? [], ...(question ? { question } : {}) };
      const expand = (req: ExpandRequest) => actions.expand(answer, req, pressedRef.current);
      return {
        ask: send,
        openCandidate: (id) => expand({ type: 'candidate', id }),
        focusMap: (target) => expand({ type: 'focus', bbox: target.bbox, candidateIds: target.candidateIds }),
      };
    },
    [actions, send, questionByAnswer],
  );

  // 入力欄から送る。送信ボタンで送ると、ボタンが押せなくなってフォーカスが body へ落ちるので、入力欄へ戻す（指で触る端末では移さない）
  const submit = useCallback(
    (text: string) => {
      if (send(text)) focusComposer();
    },
    [send, focusComposer],
  );

  // 続けて聞く: 回答のあと（返答待ち・失敗のときは出さない）に、まだ聞いていない質問の例を最大 2 件
  const lastEntry = entries[entries.length - 1];
  const followUps = useMemo(() => {
    if (sending || failure || lastEntry?.role !== 'assistant') return [];
    const asked = new Set(entries.filter((e) => e.role === 'user').map((e) => e.content.trim()));
    return IN_SCOPE_SUGGESTIONS.filter((q) => !asked.has(q)).slice(0, 2);
  }, [entries, sending, failure, lastEntry?.role]);

  // 表示を切り替える: 最新の回答の、ほかの見方。押しても質問は送らない。別の解析結果に基づく回答には出さない（拡大ビューへ進めないのと同じ）
  const lastAnswer = !sending && !failure && lastEntry?.role === 'assistant' ? lastEntry : null;
  const switches =
    lastAnswer && runCheck(lastAnswer, currentRun) === 'fresh'
      ? planAnswer(lastAnswer.results ?? []).switches.filter((s) => s.kind !== 'show' || !revealed.has(`${lastAnswer.id}:${s.index}`))
      : [];

  // 開き直した会話に、別の解析結果に基づく回答があるか（health の読み込みを待っている間は、注意書きは出さない）
  const hasStale = entries.some((e) => runCheck(e, currentRun) === 'stale');

  return (
    <section
      className="chat"
      aria-label="チャット"
      // ボタンの click は、そのボタン自身の onClick より先に、ここ（捕捉の段階）を通る。押したボタンを、拡大ビューを開く操作が読む前に控える
      onClickCapture={(e) => {
        pressedRef.current = e.target instanceof Element ? e.target.closest('button') : null;
      }}
    >
      {/* 開き直した会話を並べ終えるまで、aria-busy を真にする（並べる発言を読み上げない。実際の読み上げでの挙動は未確認。仕様 §7.1.4 の 7） */}
      <div className="chat__scroll" ref={scrollRef} role="log" aria-live="polite" aria-relevant="additions" aria-busy={sending || restore.status === 'loading'}>
        {hasStale && (
          // 開き直した会話の一部が、いまとは別の解析結果に基づくとき、会話の先頭に 1 行（仕様 §7.1.5 の 4）
          <p className="chat__notice" role="note">
            {MSG_STALE_RUN}
          </p>
        )}
        {restore.status === 'loading' && (
          <div className="msg msg--assistant msg--pending" role="status">
            <span className="dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            {MSG_RESTORING}
          </div>
        )}
        {restore.status === 'error' && (
          <div className="msg msg--error" role="alert">
            <span>{MSG_RESTORE_FAILED}</span>
            <button type="button" className="btn btn--small" onClick={retryRestore}>
              再試行
            </button>
            <button type="button" className="btn btn--small" onClick={reset}>
              新しい会話
            </button>
          </div>
        )}
        {restore.status === 'notfound' && (
          <div className="msg msg--error" role="alert">
            <span>{MSG_RESTORE_NOT_FOUND}</span>
          </div>
        )}
        {entries.length === 0 && restore.status !== 'loading' && restore.status !== 'error' && (
          <Welcome
            onPick={(text) => {
              send(text);
              focusComposer();
            }}
            onShowMap={(opener) => actions.expand(null, { type: 'view', view: 'map' }, opener)}
          />
        )}
        {entries.map((entry) => {
          // 開き直した回答が、いまとは別の解析結果に基づく（または、まだ確かめられない）ときは、拡大ビューへ進むボタンを押せなくし、回答の中の図を出さない（仕様 §7.1.5 の 4）
          const staleRun = runCheck(entry, currentRun) !== 'fresh';
          // 質問の前に、その時刻を薄く出す（時刻の無い発言・読めない値には出さない）
          const sentLabel = entry.role === 'user' && entry.sentAt ? formatSentAt(entry.sentAt, new Date()) : null;
          const results = entry.results ?? [];
          const plan = planAnswer(results);
          const figure = renderFigure && !staleRun ? plan.figure : null;
          // 地図の表示が 1 位で、回答の中の地図を出すときは、同じことを言うカード（説明と「地図で見る」）を出さない
          const mapOnly = figure === 'map' ? plan.primary : null;
          const card = (r: ToolResult, i: number, chipOnly = false) => (
            <ResultCard key={`${chipOnly ? 'chip' : 'card'}-${i}`} result={r} actions={actionsFor(entry)} answerText={entry.content} staleRun={staleRun} chipOnly={chipOnly} />
          );
          return entry.role === 'user' ? (
            <Fragment key={entry.id}>
              {sentLabel && entry.sentAt && (
                <time className="chat__time" dateTime={entry.sentAt}>
                  {sentLabel}
                </time>
              )}
              <div data-entry="user" className={entry.failed ? 'msg msg--user msg--failed' : 'msg msg--user'}>
                <span className="visually-hidden">あなた: </span>
                {entry.content}
                {entry.failed && <span className="msg__note">未送信</span>}
              </div>
            </Fragment>
          ) : (
            <div key={entry.id} data-entry="assistant" className="msg msg--assistant">
              <span className="visually-hidden">TownScan: </span>
              {entry.content && <p className="msg__text">{entry.content}</p>}
              {/* 本文の下に出す表示は 1 つ（順位 1 位の結果。順位の対象でない結果は、いつも出す） */}
              {results.map((r, i) => (plan.hidden.has(i) || i === mapOnly ? null : card(r, i)))}
              {figure && <Fragment key={figure}>{renderFigure?.(refFor(entry), figure)}</Fragment>}
              {/* 「表示を切り替える」で出した、2 位以下の結果 */}
              {results.map((r, i) => (plan.hidden.has(i) && revealed.has(`${entry.id}:${i}`) ? card(r, i) : null))}
              {/* カードを出さない地図の表示は、合成データの印だけを残す */}
              {results.map((r, i) => (r?.type === 'map_focus' && (i === mapOnly || plan.hidden.has(i)) ? card(r, i, true) : null))}
              {entry.notice && (
                // 保存を飛ばして送り直した回答にだけ、1 回出す（以降の回答には繰り返さない。仕様 §7.1.7）
                <p className="msg__notice" role="note">
                  {entry.notice}
                </p>
              )}
            </div>
          );
        })}
        {(switches.length > 0 || followUps.length > 0) && (
          <div className="follow-ups">
            {lastAnswer && switches.length > 0 && (
              <div className="follow-ups__group" role="group" aria-label="表示を切り替える">
                <span className="follow-ups__label" aria-hidden="true">
                  表示を切り替える
                </span>
                <div className="follow-ups__switches">
                  {switches.map((sw) => (
                    <button
                      key={sw.key}
                      type="button"
                      className="btn btn--small"
                      onClick={(e) => {
                        if (sw.kind === 'open') {
                          actions.expand(refFor(lastAnswer), sw.request, e.currentTarget);
                          return;
                        }
                        setRevealed((prev) => new Set(prev).add(`${lastAnswer.id}:${sw.index}`));
                        focusComposer();
                      }}
                    >
                      {sw.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {followUps.length > 0 && (
              <div className="follow-ups__group" role="group" aria-label="続けて聞く">
                {followUps.map((q) => (
                  <button
                    key={q}
                    type="button"
                    className="follow-up"
                    onClick={() => {
                      send(q);
                      focusComposer();
                    }}
                  >
                    {q}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {sending && (
          <div className="msg msg--assistant msg--pending" role="status">
            <span className="dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            調べています…
          </div>
        )}
        {failure && (
          <div className="msg msg--error" role="alert">
            <strong>送信できませんでした</strong>
            <span>{failure.message}</span>
            {failure.code === 'conversation_full' ? (
              // 1 会話の発言数の上限は、再送しても直らない。「もう一度送る」を出さず、新しい会話へ促す
              <button type="button" className="btn btn--small" onClick={reset}>
                新しい会話
              </button>
            ) : (
              <button type="button" className="btn btn--small" onClick={retry} disabled={sending}>
                もう一度送る
              </button>
            )}
          </div>
        )}
      </div>

      {entries.length > 0 && (
        // 「新しい会話」は、サイドパネルの無い幅（1023px 以下）だけで見える（1024px 以上はサイドパネルのボタン。CSS で隠す）
        <div className="chat__tools">
          <button type="button" className="btn btn--small chat__reset" onClick={reset}>
            新しい会話
          </button>
        </div>
      )}

      <Composer value={input} onChange={setInput} pending={sending} onSend={submit} inputRef={inputRef} />
    </section>
  );
}

function Welcome({ onPick, onShowMap }: { onPick: (text: string) => void; onShowMap: (opener: HTMLElement) => void }) {
  // 地区の数は、読み込んだ地区の一覧から出す（読み込めていない間は、数を伏せる）
  const { areas } = useAreas();
  return (
    <div className="welcome">
      <h2 className="welcome__title">熊本市中心部の変化を、写真と会話で調べる</h2>
      <p className="welcome__lead">
        熊本市中心部の航空写真（2018 年と 2023 年）から、<b>建物データに載っていない建物の候補</b>を棟ごとに見つけています（新築と断定するものではありません）。質問すると、件数・表・地図・写真を、根拠つきで返します。
      </p>
      <div className="welcome__actions">
        <button type="button" className="btn" onClick={(e) => onShowMap(e.currentTarget)}>
          解析した地区を地図で見る
        </button>
      </div>
      <div className="suggest-block">
        <span className="suggest-block__label">まず、こんな質問から</span>
        <div className="example-chips" role="group" aria-label="質問の例">
          {IN_SCOPE_SUGGESTIONS.map((s) => (
            <button key={s} type="button" className="example-chip" onClick={() => onPick(s)}>
              {s}
            </button>
          ))}
        </div>
      </div>
      <details className="welcome__more">
        <summary>くわしく（対象・分類・出典・範囲外の質問）</summary>
        <dl className="welcome__facts">
          <div>
            <dt>対象</dt>
            <dd>
              {areas.length > 0
                ? `熊本市中心部の ${areas.length} 地区（1 地区 = 地理院タイル 1 枚 = ${TILE_SIDE_TEXT}）`
                : `熊本市中心部の地区（1 地区 = 地理院タイル 1 枚 = ${TILE_SIDE_TEXT}）`}
            </dd>
          </div>
          <div>
            <dt>地区の名前</dt>
            <dd>タイルの中心にある住所の名前です。丁目や区の全体を数えた値ではありません。</dd>
          </div>
          <div>
            <dt>比較</dt>
            <dd>2018 年と 2023 年の航空写真</dd>
          </div>
          <div>
            <dt>出典</dt>
            <dd>国土地理院（地理院タイル・基盤地図情報）</dd>
          </div>
        </dl>
        <div className="welcome__classes">
          <span className="suggest-block__label">見つけた候補は、次の 3 つの分類に分けています（3 つの合計が、候補の数です）</span>
          <ClassDefinitions />
        </div>
        <div className="suggest-block suggest-block--refuse">
          <span className="suggest-block__label">範囲外の質問は、断って理由を返します</span>
          <div className="example-chips" role="group" aria-label="範囲外の質問の例">
            {OUT_OF_SCOPE_SUGGESTIONS.map((s) => (
              <button key={s} type="button" className="example-chip" onClick={() => onPick(s)}>
                {s}
              </button>
            ))}
          </div>
        </div>
      </details>
    </div>
  );
}
