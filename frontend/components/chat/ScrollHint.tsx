'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

/** はみ出し方の判定に使う誤差（px）。小数の丸めで、端にいるのに「続きがある」と出ないように */
const EDGE_SLACK = 2;

/**
 * 横にスクロールできる表の枠（チャットの結果カード）。幅が足りず中身がはみ出すとき、続きがある側の縁に影を出す
 * （globals.css の .table-scroll-wrap。data-overflow-start / data-overflow-end）。影が無いと、切れているのに気づけない。
 * 枠自身がフォーカスを受け、矢印キーで横に動かせる（読み上げの名前は label）。
 */
export function ScrollHint({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const start = el.scrollLeft > EDGE_SLACK;
    const end = el.scrollWidth - el.clientWidth - el.scrollLeft > EDGE_SLACK;
    setEdges((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, []);

  // 初めと、枠・表の大きさが変わったとき（列の幅の変更・折りたたみ・窓の幅）に測り直す
  useEffect(() => {
    update();
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, [update]);

  return (
    <div className="table-scroll-wrap" data-overflow-start={edges.start ? '' : undefined} data-overflow-end={edges.end ? '' : undefined}>
      <div ref={ref} className="table-scroll" role="region" aria-label={label} tabIndex={0} onScroll={update}>
        {children}
      </div>
    </div>
  );
}
