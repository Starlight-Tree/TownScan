import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONVERSATION_ID_KEY,
  CONVERSATION_ID_PATTERN,
  clearConversationId,
  isConversationId,
  newConversationId,
  readConversationId,
  writeConversationId,
} from './conversation-session';

beforeEach(() => window.sessionStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe('開いている会話の ID（sessionStorage）', () => {
  it('キーは townscan:conversation_id。書いて読んで消せる。localStorage には置かない', () => {
    expect(CONVERSATION_ID_KEY).toBe('townscan:conversation_id');
    expect(readConversationId()).toBeNull();
    writeConversationId('abc-123_X');
    expect(window.sessionStorage.getItem('townscan:conversation_id')).toBe('abc-123_X');
    expect(readConversationId()).toBe('abc-123_X');
    expect(window.localStorage.length).toBe(0);
    clearConversationId();
    expect(readConversationId()).toBeNull();
    expect(window.sessionStorage.length).toBe(0);
  });

  it('形（API の ^[A-Za-z0-9_-]{1,128}$）に合わない値は、無いものとして扱い、消す', () => {
    window.sessionStorage.setItem(CONVERSATION_ID_KEY, 'a:b');
    expect(readConversationId()).toBeNull();
    expect(window.sessionStorage.getItem(CONVERSATION_ID_KEY)).toBeNull();
    expect(isConversationId('x'.repeat(128))).toBe(true);
    expect(isConversationId('x'.repeat(129))).toBe(false);
    expect(isConversationId('')).toBe(false);
    expect(isConversationId('a b')).toBe(false);
    expect(isConversationId(null)).toBe(false);
  });

  it('sessionStorage が使えなくても（アクセスで例外）、例外にしない', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    });
    expect(readConversationId()).toBeNull();
    expect(() => writeConversationId('abc')).not.toThrow();
    expect(() => clearConversationId()).not.toThrow();
  });

  it('新しい ID は、API の形に合い、毎回違う', () => {
    const a = newConversationId();
    const b = newConversationId();
    expect(a).toMatch(CONVERSATION_ID_PATTERN);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
  });

  it('crypto.randomUUID が無い環境（http の LAN など）でも、同じ形に合う ID を作る', () => {
    vi.stubGlobal('crypto', { getRandomValues: (a: Uint8Array) => a.fill(171) });
    const id = newConversationId();
    expect(id).toMatch(CONVERSATION_ID_PATTERN);
    expect(id).toBe('ab'.repeat(16));
  });
});
