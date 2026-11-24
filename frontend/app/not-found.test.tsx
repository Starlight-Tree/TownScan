import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import NotFound from './not-found';

describe('404 の画面（app/not-found.tsx）', () => {
  it('見出し「ページが見つかりません」を出す', () => {
    render(<NotFound />);
    expect(screen.getByRole('heading', { level: 1, name: 'ページが見つかりません' })).toBeInTheDocument();
  });

  it('スキップリンクの行き先になる <main id="main"> を持つ（枠が無い 404 でも #main が指す先がある）', () => {
    render(<NotFound />);
    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', 'main');
    // スキップリンクで移したフォーカスを受けられる
    expect(main).toHaveAttribute('tabindex', '-1');
    expect(main).toContainElement(screen.getByRole('heading', { level: 1 }));
  });

  it('トップ（/）へ戻るリンクがある', () => {
    render(<NotFound />);
    expect(screen.getByRole('link', { name: 'トップへ戻る' })).toHaveAttribute('href', '/');
  });

  it('既存の CSS クラスだけで作る（このファイルは色も CSS も持たない）', () => {
    const { container } = render(<NotFound />);
    expect(container.querySelector('main.page.page--narrow')).not.toBeNull();
    expect(container.querySelector('[style]')).toBeNull();
  });
});
