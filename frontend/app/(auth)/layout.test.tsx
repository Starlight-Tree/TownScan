import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import AuthLayout from './layout';

describe('(auth) の枠（ログインの画面）', () => {
  it('サイドパネルを出さず、上の帯は「← チャットと地図」とテーマの切り替えだけ', () => {
    const { container } = render(
      <AuthLayout>
        <p>ログインの中身</p>
      </AuthLayout>,
    );
    expect(container.querySelector('.app-sidebar')).toBeNull();
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    const header = screen.getByRole('banner');
    expect(within(header).getByRole('link', { name: '← チャットと地図' })).toHaveAttribute('href', '/');
    expect(within(header).getByRole('group', { name: 'テーマ' })).toBeInTheDocument();
    // ほかの行き先（精度）は、ここには出さない
    expect(within(header).queryByRole('link', { name: 'このアプリの精度' })).not.toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main');
    expect(within(screen.getByRole('main')).getByText('ログインの中身')).toBeInTheDocument();
  });
});
