// 開いている会話の ID を、このタブだけで覚える（sessionStorage。仕様 §7.1.4）。再読み込み・精度の画面からホームへ戻ったときに、最後に開いていた会話を開き直すために使う。
// localStorage・URL・ログには置かない（タブごと。別のタブ・別の人へ持ち越さない）。ID は秘密ではないが、本人の会話を指すので、画面の外へ出さない。
// sessionStorage が使えない環境（プライベートモードの一部・保存を禁じた設定）でも、例外にしない（保存できないだけで、会話は今までどおり動く）。

/** sessionStorage のキー（仕様 §7.1.4） */
export const CONVERSATION_ID_KEY = 'townscan:conversation_id';

/** 会話 ID の形（API の `^[A-Za-z0-9_-]{1,128}$` と同じ） */
export const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function isConversationId(value: unknown): value is string {
  return typeof value === 'string' && CONVERSATION_ID_PATTERN.test(value);
}

/** 覚えている会話 ID。無い・形が違う（壊れた値）ときは null（形が違う値は消す） */
export function readConversationId(): string | null {
  try {
    const value = window.sessionStorage.getItem(CONVERSATION_ID_KEY);
    if (value === null) return null;
    if (isConversationId(value)) return value;
    window.sessionStorage.removeItem(CONVERSATION_ID_KEY);
  } catch {
    // 使えない環境では、覚えていないものとして扱う
  }
  return null;
}

export function writeConversationId(id: string): void {
  try {
    window.sessionStorage.setItem(CONVERSATION_ID_KEY, id);
  } catch {
    // 保存できなくても、画面の中の会話は続けられる（開き直しができないだけ）
  }
}

export function clearConversationId(): void {
  try {
    window.sessionStorage.removeItem(CONVERSATION_ID_KEY);
  } catch {
    // 使えない環境では、消すものも無い
  }
}

/**
 * 新しい会話の ID。画面が作る（仕様 §2.3.4: サーバーが「無ければ作って返す」にすると、ログイン中の要求の既定が変わるため）。
 * 小文字 36 文字の UUID（上の形に合う）。`crypto.randomUUID` は安全な文脈（https・localhost）だけなので、無いときは乱数 16 バイトを 16 進にする（同じ形に合う）
 */
export function newConversationId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}
