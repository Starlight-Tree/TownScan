'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ApiError, postChat } from '../../lib/api';
import type { ChatRequestMessage, ToolCall } from '../../lib/api-types';
import { useHealth } from '../HealthProvider';
import { buildRequestMessages, MAX_CONTENT_LENGTH } from './history';
import { ResultCard } from './ResultCard';
import { isMapFocus, type ChatEntry, type ResultActions } from './types';

export const SUGGESTIONS = [
  '新規出現の候補は何件ありますか？',
  '地区ごとの候補数を比べて',
  '面積の大きい候補を一覧にして',
  'いちばん大きい候補の写真を見せて',
  'このアプリの精度は？',
  '渋谷の新築は？',
];

interface Props {
  actions: Pick<ResultActions, 'openCandidate' | 'focusMap'>;
}

interface Failure {
  message: string;
  code: string;
}

let nextId = 0;
const newId = () => `m${++nextId}`;

export function ChatPanel({ actions }: Props) {
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // 再送する中身と、画面上のどの発言か（失敗の印をつけ外しするため）
  const retryRef = useRef<{ messages: ChatRequestMessage[]; entryId: string } | null>(null);
  const { state: health } = useHealth();

  useEffect(() => () => abortRef.current?.abort(), []);

  // 新しい発言・状態の変化のあと、いちばん下へ
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries, sending, failure]);

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
  }, []);

  const resultActions = useMemo<ResultActions>(() => ({ ...actions, ask: send }), [actions, send]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    send(input);
  };

  // 日本語入力の変換を確定する Enter では送らない
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && (e.nativeEvent.isComposing || e.keyCode === 229)) e.preventDefault();
  };

  const llm = health.status === 'ready' ? health.data.llm : null;

  return (
    <section className="chat" aria-label="チャット">
      <div className="chat__scroll" ref={scrollRef} role="log" aria-live="polite" aria-relevant="additions" aria-busy={sending}>
        {entries.length === 0 && <Welcome onPick={send} />}
        {entries.map((entry) =>
          entry.role === 'user' ? (
            <div key={entry.id} className={entry.failed ? 'msg msg--user msg--failed' : 'msg msg--user'}>
              <span className="visually-hidden">あなた: </span>
              {entry.content}
              {entry.failed && <span className="msg__note">未送信</span>}
            </div>
          ) : (
            <div key={entry.id} className="msg msg--assistant">
              <span className="visually-hidden">TownScan: </span>
              {entry.content && <p className="msg__text">{entry.content}</p>}
              {entry.results?.map((r, i) => <ResultCard key={i} result={r} actions={resultActions} />)}
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
              <button key={s} type="button" className="chip chip--compact" onClick={() => send(s)} disabled={sending}>
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
      <p className="chat__footnote">
        {llm === 'mock' ? '模擬モデルで応答しています。' : llm ? `モデル: ${llm}。` : ''}
        数字・件数・座標は、ツールの結果をそのまま出しています。
      </p>
    </section>
  );
}

function Welcome({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="welcome">
      <h2 className="welcome__title">熊本の街の変化を、写真と会話で調べる</h2>
      <p className="welcome__lead">
        熊本市中心部の航空写真（2018 年と 2023 年）から、<b>新しく現れた建物の候補</b>を棟ごとに見つけています。質問すると、件数・表・地図・写真を、根拠つきで返します。
      </p>
      <dl className="welcome__facts">
        <div>
          <dt>対象</dt>
          <dd>熊本市中心部の 12 地区（1 地区 = 地理院タイル 1 枚）</dd>
        </div>
        <div>
          <dt>出典</dt>
          <dd>国土地理院（地理院タイル・基盤地図情報）</dd>
        </div>
      </dl>
      <p className="welcome__caution">
        結果は「新規出現の<b>候補</b>」です。写真から機械が見つけたもので、新築と断定するものではありません。
      </p>
      <div className="suggest-block">
        <span className="suggest-block__label">まず、こんな質問から</span>
        <ul className="suggest-list">
          {SUGGESTIONS.map((s) => (
            <li key={s}>
              <button type="button" className="chip" onClick={() => onPick(s)}>
                {s}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
