import { act, render, renderHook, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import {
  NewConversationProvider,
  useConversationStatus,
  useOpenConversation,
  usePublishConversationStatus,
  useRegisterConversationOpen,
  useRegisterNewConversation,
  useStartNewConversation,
} from './NewConversation';

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

describe('会話の履歴: 「開く」の登録と、いまの会話の状態（チャット → サイドパネルの一覧）', () => {
  function Opener({ handler }: { handler: (id: string) => void }) {
    useRegisterConversationOpen(handler);
    return null;
  }
  function OpenCaller({ onResult }: { onResult: (open: (id: string) => boolean) => void }) {
    onResult(useOpenConversation());
    return null;
  }
  function Publisher({ currentId, busy }: { currentId: string | null; busy: boolean }) {
    usePublishConversationStatus(currentId, busy);
    return null;
  }
  function Status() {
    const { currentId, busy } = useConversationStatus();
    return <p data-testid="status">{`${currentId ?? '-'}|${busy ? 'busy' : 'idle'}`}</p>;
  }

  it('登録された「開く」処理を、会話 ID つきで呼んで true。登録が無ければ false（呼び出し側が、ID を書いてホームへ移る）', () => {
    const handler = vi.fn();
    let open: (id: string) => boolean = () => false;
    const tree = (withChat: boolean) => (
      <NewConversationProvider>
        {withChat && <Opener handler={handler} />}
        <OpenCaller onResult={(o) => (open = o)} />
      </NewConversationProvider>
    );
    const { rerender } = render(tree(true));
    expect(open('abc-1')).toBe(true);
    expect(handler).toHaveBeenCalledWith('abc-1');
    rerender(tree(false));
    expect(open('abc-1')).toBe(false);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('「開く」は、「新しい会話」の登録とは別（片方だけ登録されていても、もう片方は呼ばれない）', () => {
    const onNew = vi.fn();
    let start: () => boolean = () => false;
    let open: (id: string) => boolean = () => false;
    render(
      <NewConversationProvider>
        <Registrar handler={onNew} />
        <Starter onResult={(s) => (start = s)} />
        <OpenCaller onResult={(o) => (open = o)} />
      </NewConversationProvider>,
    );
    expect(open('x')).toBe(false);
    expect(start()).toBe(true);
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it('チャットが知らせた状態（開いている会話の ID・生成中）を、サイドパネルが読む。チャットが外れると、生成中でなくなり、ID は残る', () => {
    const tree = (publisher: ReactNode) => (
      <NewConversationProvider>
        {publisher}
        <Status />
      </NewConversationProvider>
    );
    const { rerender } = render(tree(<Publisher currentId={null} busy={false} />));
    expect(screen.getByTestId('status')).toHaveTextContent('-|idle');
    rerender(tree(<Publisher currentId="c1" busy />));
    expect(screen.getByTestId('status')).toHaveTextContent('c1|busy');
    rerender(tree(<Publisher currentId="c1" busy={false} />));
    expect(screen.getByTestId('status')).toHaveTextContent('c1|idle');
    rerender(tree(<Publisher currentId="c1" busy />));
    act(() => {
      rerender(tree(null));
    });
    expect(screen.getByTestId('status')).toHaveTextContent('c1|idle');
  });

  it('Provider が無いときは、何もしない（テスト・単体の表示）', () => {
    const { result } = renderHook(() => useOpenConversation());
    expect(result.current('x')).toBe(false);
    expect(renderHook(() => useConversationStatus()).result.current).toEqual({ currentId: null, busy: false });
    expect(() => render(<Publisher currentId="c1" busy />)).not.toThrow();
    expect(() => render(<Opener handler={() => {}} />)).not.toThrow();
  });
});
