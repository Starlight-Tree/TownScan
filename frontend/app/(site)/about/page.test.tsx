import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import AboutPage from './page';

describe('このアプリについて（使い方）', () => {
  it('いまの画面を説明する: 左のチャット・右の結果領域（3 つのタブ・自動で切り替わる）・写真を比べる・回答のボタン・拡大', () => {
    render(<AboutPage />);
    const how = screen.getByRole('region', { name: '使い方' });
    const text = how.textContent ?? '';
    expect(text).toContain('左のチャット');
    expect(text).toContain('結果領域');
    for (const tab of ['地図', 'グラフ', '写真の比較']) expect(text).toContain(`「${tab}」`);
    expect(text).toContain('自動で切り替わります');
    expect(text).toContain('「写真を比べる」');
    expect(text).toContain('「グラフで見る」「地図で見る」');
    expect(text).toContain('その回答の条件');
    expect(text).toContain('「拡大」');
    expect(within(how).getByRole('link', { name: 'チャットと地図' })).toHaveAttribute('href', '/');
  });

  it('昔の説明（印を選ぶと詳細が開く・右の地図）を残さない', () => {
    render(<AboutPage />);
    const how = screen.getByRole('region', { name: '使い方' });
    expect(how).not.toHaveTextContent('詳細が開きます');
    expect(how).not.toHaveTextContent('右の地図で');
  });
});
