import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// jsdom に無いブラウザ API（Leaflet が地図を動かすときに呼ぶ）
if (typeof window !== 'undefined') window.scrollTo = () => {};

afterEach(() => {
  cleanup();
});
