'use client';

import { useState, type ReactNode } from 'react';
import { ErrorBoundary } from './ErrorBoundary';

interface Props {
  /** 結果領域の画面の名前（「地図」「グラフ」「写真の比較」） */
  name: string;
  children: ReactNode;
}

/**
 * 結果領域の 1 つの画面の描画が壊れても、アプリ全体（サイドバー・チャット・ほかの画面）を巻き込まない。
 * 何も囲まないと、Next の既定のエラー画面（白地・英語の「This page couldn't load」）がアプリ全体に出てしまう。
 * 代わりに、その画面の中に日本語で知らせ、描き直す手段を出す。「もう一度表示する」は、画面の中身を作り直す（地図ならもう一度作る）
 */
export function ResultPanelBoundary({ name, children }: Props) {
  const [attempt, setAttempt] = useState(0);
  return (
    <ErrorBoundary
      key={attempt}
      label={`結果領域の「${name}」の描画に失敗しました`}
      fallback={() => (
        <div className="panel-error" role="alert">
          <p className="panel-error__title">「{name}」を表示できませんでした</p>
          <p>この画面だけで問題が起きました。チャットと、ほかの画面は、そのまま使えます。</p>
          <div className="panel-error__actions">
            <button type="button" className="btn" onClick={() => setAttempt((n) => n + 1)}>
              もう一度表示する
            </button>
            <button type="button" className="btn" onClick={() => window.location.reload()}>
              ページを再読み込み
            </button>
          </div>
        </div>
      )}
    >
      {children}
    </ErrorBoundary>
  );
}
