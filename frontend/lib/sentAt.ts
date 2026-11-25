/** 質問の時刻（ISO 8601）の検証と、会話の区切りに出す表示。React にも通信にも依存しない。 */

/** 読める ISO 8601 の文字列だけを返す（サーバー・端末の値を、使う前に確かめる）。 */
export function parseSentAt(value: unknown): string | undefined {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** 分は 2 桁、時は桁をそろえない（「4:46」。「04:46」にしない）。 */
function clock(at: Date): string {
  return `${at.getHours()}:${String(at.getMinutes()).padStart(2, '0')}`;
}

/**
 * 「今日 21:02」「今日 4:46」「昨日 20:41」「11月14日 21:02」「2025年11月14日 21:02」（時は 0 埋めしない）。端末のタイムゾーンで表示する。
 * 読めない値は null（区切りを出さない）。`now` は引数で受ける（テストで固定できるように）。
 */
export function formatSentAt(iso: string, now: Date): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const time = clock(at);
  if (sameDay(at, now)) return `今日 ${time}`;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (sameDay(at, yesterday)) return `昨日 ${time}`;
  const date = `${at.getMonth() + 1}月${at.getDate()}日`;
  return at.getFullYear() === now.getFullYear() ? `${date} ${time}` : `${at.getFullYear()}年${date} ${time}`;
}
