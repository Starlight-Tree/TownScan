import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// next/font/google は、Next のビルドが呼び出しを置き換える前提で、素の Node（vitest）では関数ではない。
// app/layout.tsx を読み込むテスト（tests/tab-title.test.ts）のために、フォントの取得を伴わない形に差し替える
vi.mock('next/font/google', () => ({
  Inter: () => ({ className: 'inter-test', variable: 'inter-test-variable', style: { fontFamily: 'Inter' } }),
}));

// jsdom に無いブラウザ API（Leaflet が地図を動かすときに呼ぶ）
if (typeof window !== 'undefined') window.scrollTo = () => {};

afterEach(() => {
  cleanup();
});
