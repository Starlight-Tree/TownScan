'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  fallback: (error: Error) => ReactNode;
  children: ReactNode;
  /** 開発者向けのログの 1 行目（無ければ、結果カードの文）。何が壊れたかを区別する */
  label?: string;
}

interface State {
  error: Error | null;
}

/** 1 枚のカードの描画が壊れても、会話全体を巻き込まない */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(this.props.label ?? '結果カードの描画に失敗しました', error, info.componentStack);
  }

  render() {
    return this.state.error ? this.props.fallback(this.state.error) : this.props.children;
  }
}
