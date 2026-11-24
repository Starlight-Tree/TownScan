import { render, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { NewConversationProvider, useRegisterNewConversation, useStartNewConversation } from './NewConversation';

const wrapper = ({ children }: { children: ReactNode }) => <NewConversationProvider>{children}</NewConversationProvider>;

function Registrar({ handler }: { handler: () => void }) {
  useRegisterNewConversation(handler);
  return null;
}
function Starter({ onResult }: { onResult: (start: () => boolean) => void }) {
  onResult(useStartNewConversation());
  return null;
}

describe('サイドパネルの「新しい会話」とチャットをつなぐ', () => {
  it('登録された処理があれば、呼んで true を返す', () => {
    const handler = vi.fn();
    let start: () => boolean = () => false;
    render(
      <NewConversationProvider>
        <Registrar handler={handler} />
        <Starter onResult={(s) => (start = s)} />
      </NewConversationProvider>,
    );
    expect(start()).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('登録が無い（ホーム以外のページ）と、何も呼ばず false を返す', () => {
    const { result } = renderHook(() => useStartNewConversation(), { wrapper });
    expect(result.current()).toBe(false);
  });

  it('チャットが外れたあと（ホームから移った）は、false に戻る', () => {
    const handler = vi.fn();
    let start: () => boolean = () => false;
    const tree = (withChat: boolean) => (
      <NewConversationProvider>
        {withChat && <Registrar handler={handler} />}
        <Starter onResult={(s) => (start = s)} />
      </NewConversationProvider>
    );
    const { rerender } = render(tree(true));
    expect(start()).toBe(true);
    rerender(tree(false));
    expect(start()).toBe(false);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('あとから登録した処理を、先に外れた登録の後始末が消さない（入れ替わり）', () => {
    const first = vi.fn();
    const second = vi.fn();
    let start: () => boolean = () => false;
    const tree = (which: 'first' | 'both' | 'second') => (
      <NewConversationProvider>
        {which !== 'second' && <Registrar handler={first} />}
        {which !== 'first' && <Registrar handler={second} />}
        <Starter onResult={(s) => (start = s)} />
      </NewConversationProvider>
    );
    const { rerender } = render(tree('first'));
    rerender(tree('both'));
    rerender(tree('second'));
    expect(start()).toBe(true);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it('Provider が無いときは、何もしない（テスト・単体の表示）', () => {
    const { result } = renderHook(() => useStartNewConversation());
    expect(result.current()).toBe(false);
    expect(() => render(<Registrar handler={() => {}} />)).not.toThrow();
  });
});
