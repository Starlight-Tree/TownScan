'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, postChat } from '../../lib/api';
import type { AnswerRef, ExpandRequest } from '../../lib/answer-view';
import type { ChatRequestMessage, ToolCall } from '../../lib/api-types';
import { useAreas } from '../../lib/areas-context';
import { formatSentAt } from '../../lib/sentAt';
import { ErrorBoundary } from '../ErrorBoundary';
import { useRegisterNewConversation } from '../NewConversation';
import { AnswerScope } from './AnswerScope';
import { TILE_SIDE_TEXT } from './area-scale';
import { ClassDefinitions } from './ClassGuide';
import { Composer } from './Composer';
import { buildRequestMessages } from './history';
import { ResultCard } from './ResultCard';
import type { ChatActions, ChatEntry, ResultActions } from './types';

/** 答えられる質問の例 */
const IN_SCOPE_SUGGESTIONS = [
  '新規出現の候補は何件ありますか？',
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
  /** 「新しい会話」（チャットの中のボタンも、サイドパネルのボタンも）で会話を空にしたあとに呼ぶ。親が、拡大ビューを閉じ、回答ごとの状態を捨てる */
  onNewConversation?: () => void;
}

interface Failure {
  message: string;
  code: string;
}

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

export function ChatPanel({ actions, onNewConversation }: Props) {
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // 再送する中身と、画面上のどの発言か（失敗の印をつけ外しするため）
  const retryRef = useRef<{ messages: ChatRequestMessage[]; entryId: string } | null>(null);
  // 最後に押されたボタン（結果カードの「グラフで見る」など）。拡大ビューを閉じたとき、フォーカスをここへ戻す。
  // ボタンを押してもフォーカスが移らないブラウザー（macOS の Safari・Firefox）でも、押したボタンを正しく指すため、押した時点の対象を控える
  const pressedRef = useRef<HTMLElement | null>(null);

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
      retryRef.current = { messages, entryId };
      setSending(true);
      setFailure(null);
      try {
        const res = await postChat(messages, ctrl.signal);
        // 「新しい会話」で捨てた返答は、新しい会話に混ぜない
        if (ctrl.signal.aborted) return;
        const msg = res.message;
        const results = Array.isArray(msg?.results) ? msg.results : [];
        const toolCalls: ToolCall[] = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
        setEntries((prev) => [
          ...prev.map((e) => (e.id === entryId && e.failed ? { ...e, failed: false } : e)),
          { id: newId(), role: 'assistant', content: typeof msg?.content === 'string' ? msg.content : '', results, tool_calls: toolCalls },
        ]);
        retryRef.current = null;
      } catch (e) {
        if (ctrl.signal.aborted) return;
        const err = e instanceof ApiError ? e : new ApiError('送信に失敗しました。', 0, 'unknown');
        setEntries((prev) => prev.map((x) => (x.id === entryId ? { ...x, failed: true } : x)));
        setFailure({ message: err.message, code: err.code });
      } finally {
        if (abortRef.current === ctrl) setSending(false);
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

  // 会話をやり直す。返答待ちの通信も止める
  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    retryRef.current = null;
    setEntries([]);
    setFailure(null);
    setSending(false);
    onNewConversation?.();
    focusComposer();
  }, [focusComposer, onNewConversation]);

  // サイドパネルの「新しい会話」も、同じ処理を呼ぶ
  useRegisterNewConversation(reset);

  // 結果カードの操作を、その回答に束ねる。拡大の単位は回答 1 件で、どの回答のカードを押したかを、親へ渡す
  const actionsFor = useCallback(
    (entry: ChatEntry): ResultActions => {
      const answer: AnswerRef = { id: entry.id, results: entry.results ?? [] };
      const expand = (req: ExpandRequest) => actions.expand(answer, req, pressedRef.current);
      return {
        ask: send,
        showView: (view) => expand({ type: 'view', view }),
        openCandidate: (id) => expand({ type: 'candidate', id }),
        focusMap: (target) => expand({ type: 'focus', bbox: target.bbox, candidateIds: target.candidateIds }),
      };
    },
    [actions, send],
  );

  // 入力欄から送る。送信ボタンで送ると、ボタンが押せなくなってフォーカスが body へ落ちるので、入力欄へ戻す（指で触る端末では移さない）
  const submit = useCallback(
    (text: string) => {
      if (send(text)) focusComposer();
    },
    [send, focusComposer],
  );

  // 続けて聞く: 回答のあと（返答待ち・失敗のときは出さない）に、まだ聞いていない質問の例を最大 3 件（DocuNavi の followUpQuestions と同じ規則）
  const lastEntry = entries[entries.length - 1];
  const followUps = useMemo(() => {
    if (sending || failure || lastEntry?.role !== 'assistant') return [];
    const asked = new Set(entries.filter((e) => e.role === 'user').map((e) => e.content.trim()));
    return IN_SCOPE_SUGGESTIONS.filter((q) => !asked.has(q)).slice(0, 3);
  }, [entries, sending, failure, lastEntry?.role]);

  return (
    <section
      className="chat"
      aria-label="チャット"
      // ボタンの click は、そのボタン自身の onClick より先に、ここ（捕捉の段階）を通る。押したボタンを、拡大ビューを開く操作が読む前に控える
      onClickCapture={(e) => {
        pressedRef.current = e.target instanceof Element ? e.target.closest('button') : null;
      }}
    >
      <div className="chat__scroll" ref={scrollRef} role="log" aria-live="polite" aria-relevant="additions" aria-busy={sending}>
        {entries.length === 0 && (
          <Welcome
            onPick={(text) => {
              send(text);
              focusComposer();
            }}
            onShowMap={(opener) => actions.expand(null, { type: 'view', view: 'map' }, opener)}
          />
        )}
        {entries.map((entry) => {
          // 質問の前に、その時刻を薄く出す（時刻の無い発言・読めない値には出さない）
          const sentLabel = entry.role === 'user' && entry.sentAt ? formatSentAt(entry.sentAt, new Date()) : null;
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
              {entry.results && entry.results.length > 0 && (
                // 条件の行が壊れても、回答とカードは出す
                <ErrorBoundary fallback={() => null}>
                  <AnswerScope results={entry.results} />
                </ErrorBoundary>
              )}
              {entry.results?.map((r, i) => <ResultCard key={i} result={r} actions={actionsFor(entry)} answerText={entry.content} />)}
              {entry.tool_calls && entry.tool_calls.length > 0 && (
                <details className="provenance provenance--tools">
                  <summary>使ったツール</summary>
                  <ul className="tool-list">
                    {entry.tool_calls.map((c, i) => (
                      <li key={i}>
                        <code>{c.name}</code>
                        <code className="tool-list__args">{JSON.stringify(c.args)}</code>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          );
        })}
        {followUps.length > 0 && (
          <div className="follow-ups" role="group" aria-label="続けて聞く">
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
            <button type="button" className="btn btn--small" onClick={retry} disabled={sending}>
              もう一度送る
            </button>
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
        熊本市中心部の航空写真（2018 年と 2023 年）から、<b>新しく現れた建物の候補</b>を棟ごとに見つけています（新築と断定するものではありません）。質問すると、件数・表・地図・写真を、根拠つきで返します。
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
