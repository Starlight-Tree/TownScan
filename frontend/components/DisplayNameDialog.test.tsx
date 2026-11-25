import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NameFormState } from '../lib/display-name';

const action = vi.hoisted(() => vi.fn<(prev: NameFormState, data: FormData) => Promise<NameFormState>>());
vi.mock('../actions/auth', () => ({ updateNameAction: action }));

const { DisplayNameDialog } = await import('./DisplayNameDialog');

beforeEach(() => action.mockReset());

describe('DisplayNameDialog', () => {
  it('ダイアログの名前・説明・いまの名前・字数の表示が出て、入力にフォーカスがある', () => {
    render(<DisplayNameDialog initial="試験 花子" onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: '表示名を変更' });
    expect(dialog).toHaveTextContent('この名前は、このアプリの中で自分にだけ表示されます。');
    const input = screen.getByLabelText('表示名');
    expect(input).toHaveValue('試験 花子');
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute('name', 'display_name');
    expect(dialog).toHaveTextContent('1〜30 文字（前後の空白は除きます）');
    expect(dialog).toHaveTextContent('5 / 30');
  });

  it('入力すると字数が変わる。保存すると、入力した値がサーバーアクションへ渡り、成功したら閉じる', async () => {
    action.mockResolvedValue({ saved: true, value: 'Starlight-Tree' });
    const onClose = vi.fn();
    render(<DisplayNameDialog initial="試験 花子" onClose={onClose} />);
    const input = screen.getByLabelText('表示名');
    await userEvent.clear(input);
    await userEvent.type(input, 'Starlight-Tree');
    expect(screen.getByRole('dialog')).toHaveTextContent('14 / 30');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(action).toHaveBeenCalledTimes(1);
    expect((action.mock.calls[0]![1] as FormData).get('display_name')).toBe('Starlight-Tree');
  });

  it('エラーが返れば、閉じずに、入力を残して alert に出す', async () => {
    action.mockResolvedValue({ error: '表示名を入力してください。', value: '' });
    const onClose = vi.fn();
    render(<DisplayNameDialog initial="試験 花子" onClose={onClose} />);
    await userEvent.clear(screen.getByLabelText('表示名'));
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('表示名を入力してください。');
    expect(screen.getByLabelText('表示名')).toHaveAttribute('aria-invalid', 'true');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('キャンセルは、保存せずに閉じる', async () => {
    const onClose = vi.fn();
    render(<DisplayNameDialog initial="試験 花子" onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(action).not.toHaveBeenCalled();
  });
});
