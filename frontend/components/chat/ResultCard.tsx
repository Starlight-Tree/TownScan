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

function renderResult(result: ToolResult, actions: ResultActions, answerText: string | undefined) {
  switch (result.type) {
    case 'count':
      return <CountCard result={result} />;
    case 'table':
      return <TableCard result={result} actions={actions} />;
    case 'compare':
      return <CompareCard result={result} />;
    case 'map_focus':
      return <MapFocusCard result={result} actions={actions} />;
    case 'detection_image':
      return <DetectionImageCard result={result} actions={actions} answerText={answerText} />;
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
 * （同じ文が 2 回並ばないように）。渡さなければ、カードは自分の文をすべて出す
 */
export function ResultCard({ result, actions, answerText }: { result: ToolResult; actions: ResultActions; answerText?: string }) {
  if (!result || typeof result !== 'object' || typeof (result as { type?: unknown }).type !== 'string') {
    return <UnknownResultCard raw={result} reason="結果の形が正しくありません。" />;
  }
  return (
    <ErrorBoundary
      fallback={(error) => <UnknownResultCard raw={result} reason={`表示中にエラーが起きました（${error.message}）。`} />}
    >
      {renderResult(result, actions, answerText)}
    </ErrorBoundary>
  );
}
