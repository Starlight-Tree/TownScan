'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { updateNameAction } from '../actions/auth';
import { DISPLAY_NAME_MAX, displayNameLength, type NameFormState } from '../lib/display-name';

type Props = {
  /** いまの表示名。 */
  initial: string;
  onClose: () => void;
};

const INITIAL_STATE: NameFormState = {};

/**
 * 表示名の変更（DocuNavi の「表示名を変更」と同じ 1 欄）。標準の <dialog>（showModal）で、Esc で閉じ、フォーカスは中に閉じ込める。
 * 背景の押下では閉じない（入力の途中を失わないように）。保存できたら閉じる。この名前は、このアプリの中で自分にだけ表示される。
 * 検査は、サーバーアクション（updateNameAction）が必ず行う。ここでは、字数の表示と、エラーの表示だけ。
 */
export function DisplayNameDialog({ initial, onClose }: Props) {
  const [state, formAction, pending] = useActionState(updateNameAction, INITIAL_STATE);
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const closed = useRef(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (state.saved && !closed.current) {
      closed.current = true;
      onClose();
    }
  }, [state.saved, onClose]);

  return (
    <dialog ref={ref} className="name-dialog" aria-labelledby="name-dialog-title" onClose={onClose}>
      <form action={formAction} noValidate>
        <h2 id="name-dialog-title" className="name-dialog__title">
          表示名を変更
        </h2>
        <p className="name-dialog__note">この名前は、このアプリの中で自分にだけ表示されます。</p>
        <div className="name-dialog__field">
          <label htmlFor="display-name-input" className="name-dialog__label">
            表示名
          </label>
          <input
            ref={inputRef}
            id="display-name-input"
            name="display_name"
            type="text"
            className="name-dialog__input"
            value={value}
            autoComplete="nickname"
            aria-invalid={state.error && !pending ? true : undefined}
            aria-describedby="display-name-hint"
            disabled={pending}
            onChange={(event) => setValue(event.target.value)}
          />
          <div className="name-dialog__meta">
            <span id="display-name-hint">1〜{DISPLAY_NAME_MAX} 文字（前後の空白は除きます）</span>
            <span aria-hidden="true">
              {displayNameLength(value)} / {DISPLAY_NAME_MAX}
            </span>
          </div>
        </div>
        {state.error ? (
          <p role="alert" className="name-dialog__error">
            {state.error}
          </p>
        ) : null}
        <div className="name-dialog__actions">
          <button type="button" className="btn" disabled={pending} onClick={onClose}>
            キャンセル
          </button>
          <button type="submit" className="btn btn--primary" disabled={pending}>
            {pending ? '保存中…' : '保存'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
