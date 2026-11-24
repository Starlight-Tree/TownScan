'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ApiError, postChat } from '../../lib/api';
import type { ChatRequestMessage, ToolCall } from '../../lib/api-types';
import { useAreas } from '../../lib/areas-context';
import { ErrorBoundary } from '../ErrorBoundary';
import { useRegisterNewConversation } from '../NewConversation';
import { AnswerScope } from './AnswerScope';
import { TILE_SIDE_TEXT } from './area-scale';
import { ClassDefinitions } from './ClassGuide';
import { buildRequestMessages, MAX_CONTENT_LENGTH } from './history';
import { ResultCard } from './ResultCard';
import { isMapFocus, type ChatActions, type ChatEntry, type ResultActions } from './types';

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
  /** 「新しい会話」（チャットの中のボタンも、サイドパネルのボタンも）で会話を空にしたあとに呼ぶ。親が、結果領域を最初の状態へ戻す */
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
    const questionTop = offsetWithin(box, question);
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
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // 再送する中身と、画面上のどの発言か（失敗の印をつけ外しするため）
  const retryRef = useRef<{ messages: ChatRequestMessage[]; entryId: string } | null>(null);

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
        // 地図の表示が返ってきたら、すぐ地図を寄せる
        const focus = [...results].reverse().find(isMapFocus);
        if (focus) actions.focusMap({ bbox: focus.bbox, candidateIds: focus.candidate_ids });
        // 回答が届いたことを、結果の領域へ 1 回だけ伝える（合う画面・絞り込みへ切り替える）。
        // 親の処理の失敗は、送信の失敗ではない（回答は届いて画面に出ている）ので、「送信できませんでした」にしない
        if (results.length > 0) {
          try {
            actions.answered(results);
          } catch (err) {
            console.error('回答の通知に失敗しました', err);
          }
        }
      } catch (e) {
        if (ctrl.signal.aborted) return;
        const err = e instanceof ApiError ? e : new ApiError('送信に失敗しました。', 0, 'unknown');
        setEntries((prev) => prev.map((x) => (x.id === entryId ? { ...x, failed: true } : x)));
        setFailure({ message: err.message, code: err.code });
      } finally {
        if (abortRef.current === ctrl) setSending(false);
      }
    },
    [actions],
  );

  const send = useCallback(
    (raw: string) => {
      const text = raw.trim();
      if (!text || sending) return;
      const messages = buildRequestMessages(entries, text);
      const entryId = newId();
      setEntries((prev) => [...prev, { id: entryId, role: 'user', content: text }]);
      setInput('');
      void request(messages, entryId);
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

  const resultActions = useMemo<ResultActions>(() => ({ ...actions, ask: send }), [actions, send]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    send(input);
  };

  // 日本語入力の変換を確定する Enter では送らない
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && (e.nativeEvent.isComposing || e.keyCode === 229)) e.preventDefault();
  };

  return (
    <section className="chat" aria-label="チャット">
      <div className="chat__scroll" ref={scrollRef} role="log" aria-live="polite" aria-relevant="additions" aria-busy={sending}>
        {entries.length === 0 && (
          <Welcome
            onPick={(text) => {
              send(text);
              focusComposer();
            }}
            onShowMap={() => actions.showView('map')}
          />
        )}
        {entries.map((entry) =>
          entry.role === 'user' ? (
            <div key={entry.id} data-entry="user" className={entry.failed ? 'msg msg--user msg--failed' : 'msg msg--user'}>
              <span className="visually-hidden">あなた: </span>
              {entry.content}
              {entry.failed && <span className="msg__note">未送信</span>}
            </div>
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
              {entry.results?.map((r, i) => <ResultCard key={i} result={r} actions={resultActions} answerText={entry.content} />)}
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
          ),
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
        <div className="chat__tools">
          <div className="chat__chips" aria-label="質問の例">
            {SUGGESTIONS.slice(0, 4).map((s) => (
              <button
                key={s}
                type="button"
                className="chip chip--compact"
                onClick={() => {
                  send(s);
                  focusComposer();
                }}
                disabled={sending}
              >
                {s}
              </button>
            ))}
          </div>
          <button type="button" className="btn btn--small chat__reset" onClick={reset}>
            新しい会話
          </button>
        </div>
      )}

      <form className="chat__composer" onSubmit={onSubmit}>
        <label htmlFor="chat-input" className="visually-hidden">
          質問を入力
        </label>
        <input
          id="chat-input"
          ref={inputRef}
          type="text"
          className="input"
          autoComplete="off"
          placeholder="例: 新規出現の候補は何件ありますか？"
          maxLength={MAX_CONTENT_LENGTH}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button type="submit" className="btn btn--primary" disabled={sending || input.trim() === ''}>
          送信
        </button>
      </form>
    </section>
  );
}

function Welcome({ onPick, onShowMap }: { onPick: (text: string) => void; onShowMap: () => void }) {
  // 地区の数は、読み込んだ地区の一覧から出す（読み込めていない間は、数を伏せる）
  const { areas } = useAreas();
  return (
    <div className="welcome">
      <h2 className="welcome__title">熊本市中心部の変化を、写真と会話で調べる</h2>
      <p className="welcome__lead">
        熊本市中心部の航空写真（2018 年と 2023 年）から、<b>新しく現れた建物の候補</b>を棟ごとに見つけています（新築と断定するものではありません）。質問すると、件数・表・地図・写真を、根拠つきで返します。
      </p>
      <div className="welcome__actions">
        <button type="button" className="btn" onClick={onShowMap}>
          解析した地区を地図で見る
        </button>
      </div>
      <div className="suggest-block">
        <span className="suggest-block__label">まず、こんな質問から</span>
        <ul className="suggest-list">
          {IN_SCOPE_SUGGESTIONS.map((s) => (
            <li key={s}>
              <button type="button" className="chip" onClick={() => onPick(s)}>
                {s}
              </button>
            </li>
          ))}
        </ul>
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
          <ul className="suggest-list">
            {OUT_OF_SCOPE_SUGGESTIONS.map((s) => (
              <li key={s}>
                <button type="button" className="chip" onClick={() => onPick(s)}>
                  {s}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </details>
    </div>
  );
}
