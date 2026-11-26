'use client';

import { useLayoutEffect } from 'react';
import type { FormEvent, KeyboardEvent, RefObject } from 'react';
import { MAX_CONTENT_LENGTH } from './history';
import { CHAT_INPUT_ID } from './types';

/** 上向きの矢印（送信）。アイコンのライブラリは使わず、線だけの SVG を直に置く。 */
function SendIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 16V4" />
      <path d="M5 9l5-5 5 5" />
    </svg>
  );
}

interface ComposerProps {
  /** 入力中の文。親が持つ（質問の例を押して送ったときも、親が空にする） */
  value: string;
  onChange: (value: string) => void;
  /** 返答を待っている間。送信ボタンを押せなくし、Enter も送らない（二重送信を防ぐ） */
  pending: boolean;
  /** 送信を頼む。親が、空・返答待ちのときは断る */
  onSend: (text: string) => void;
  /** 入力欄。親が、質問の例・「新しい会話」のあとにフォーカスを移すため */
  inputRef: RefObject<HTMLTextAreaElement | null>;
}

/**
 * チャットの入力欄。DocuNavi の Composer.tsx と同じ作り: 角丸の枠の中に、伸びる入力（textarea）と、下の行の丸い送信ボタン。
 * Enter で送り、Shift+Enter で改行する。日本語入力の変換を確定する Enter では送らない
 */
export function Composer({ value, onChange, pending, onSend, inputRef }: ComposerProps) {
  const canSend = !pending && value.trim().length > 0;

  // 長い文でも全体が見えるよう、入力に合わせて高さを伸ばす（上限は CSS の max-height。超えたら中でスクロールする）。
  // 高さを測れない環境（scrollHeight が 0）では、CSS の既定のままにする
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = 'auto';
    if (input.scrollHeight > 0) input.style.height = `${input.scrollHeight}px`;
  }, [value, inputRef]);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    onSend(value);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    // IME の変換確定の Enter は送信しない（Safari は確定後に keyCode 229 の keydown が来る）
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    onSend(value);
  };

  return (
    <form className="chat__composer" onSubmit={handleSubmit}>
      <label htmlFor={CHAT_INPUT_ID} className="visually-hidden">
        質問を入力
      </label>
      <div className="chat__field">
        <textarea
          ref={inputRef}
          id={CHAT_INPUT_ID}
          className="chat__input"
          autoComplete="off"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
          maxLength={MAX_CONTENT_LENGTH}
          rows={1}
          placeholder="例: 候補は何件ありますか？"
        />
        <div className="chat__footer">
          <div className="chat__actions">
            <button type="submit" className="btn btn--primary btn--icon" disabled={!canSend} aria-label="送信" title="送信（Enter）">
              <SendIcon />
            </button>
          </div>
        </div>
      </div>
    </form>
  );
}
