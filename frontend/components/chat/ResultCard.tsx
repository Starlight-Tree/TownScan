'use client';

import type { ToolResult } from '../../lib/api-types';
import { ErrorBoundary } from '../ErrorBoundary';
import {
  AccuracyCard,
  CompareCard,
  CountCard,
  DetectionImageCard,
  MapFocusCard,
  RefusalCard,
  TableCard,
  UnknownResultCard,
} from './cards';
import type { ResultActions } from './types';

/** 比較のカードだけ、本文（body）と補足（notes）に分けて置ける。ほかの種類は、いつも全部（all）を 1 か所に出す */
export type ResultPart = 'all' | 'body' | 'notes';

function renderResult(result: ToolResult, actions: ResultActions, answerText: string | undefined, staleRun: boolean, part: ResultPart) {
  switch (result.type) {
    case 'count':
      return <CountCard result={result} />;
    case 'table':
      return <TableCard result={result} actions={actions} staleRun={staleRun} />;
    case 'compare':
      return <CompareCard result={result} part={part} />;
    case 'map_focus':
      return <MapFocusCard result={result} actions={actions} staleRun={staleRun} />;
    case 'detection_image':
      return <DetectionImageCard result={result} actions={actions} answerText={answerText} staleRun={staleRun} />;
    case 'accuracy':
      return <AccuracyCard result={result} />;
    case 'refusal':
      return <RefusalCard result={result} actions={actions} answerText={answerText} />;
    default: {
      // 型を足して上の switch に足し忘れると、ここで never にならずコンパイルが通らない。
      // 実行時には、API が新しい型を返しても画面を壊さず「表示できない」と出す。
      const unexpected: never = result;
      return <UnknownResultCard raw={unexpected} />;
    }
  }
}

/**
 * answerText は、このカードを含む回答の本文。カードの中の文（お断りの理由・写真の説明）が本文にすでにあれば、カードでは出さない
 * （同じ文が 2 回並ばないように）。渡さなければ、カードは自分の文をすべて出す。
 * staleRun は、開き直した会話の回答が、いまとは別の解析結果に基づくとき（仕様 §7.1.5）: 拡大ビューへ進むボタン（地図の表示の「地図で見る」・表の行の「詳細」・検出画像の「詳細を開く」）を押せなくし、
 * 検出画像は写真も読み込まない。カードの数字・文は、保存された値のまま読める。質問の例のボタン（ask）は、新しい質問を送るだけなので、そのまま使える
 */
export function ResultCard({
  result,
  actions,
  answerText,
  staleRun = false,
  part = 'all',
}: {
  result: ToolResult;
  actions: ResultActions;
  answerText?: string;
  staleRun?: boolean;
  part?: ResultPart;
}) {
  if (!result || typeof result !== 'object' || typeof (result as { type?: unknown }).type !== 'string') {
    return <UnknownResultCard raw={result} reason="結果の形が正しくありません。" />;
  }
  return (
    <ErrorBoundary
      fallback={(error) => <UnknownResultCard raw={result} reason={`表示中にエラーが起きました（${error.message}）。`} />}
    >
      {renderResult(result, actions, answerText, staleRun, part)}
    </ErrorBoundary>
  );
}
