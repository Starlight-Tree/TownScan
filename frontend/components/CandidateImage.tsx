'use client';

import { useState } from 'react';

interface Props {
  src: string;
  year: number;
  candidateId: string;
}

/** 切り出し画像 1 枚。取得に失敗しても枠は崩さず、理由を文字で出す */
export function CandidateImage({ src, year, candidateId }: Props) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  return (
    <figure className="cand-image">
      <div className="cand-image__frame" data-state={failed ? 'error' : loaded ? 'loaded' : 'loading'}>
        {!failed && (
          // eslint-disable-next-line @next/next/no-img-element -- API が切り出した PNG をそのまま出す（最適化の対象外）
          <img
            src={src}
            alt={`${year} 年の写真の切り出し。候補 ${candidateId} の輪郭を描いています`}
            loading="lazy"
            onLoad={() => setLoaded(true)}
            onError={() => setFailed(true)}
          />
        )}
        {failed && (
          <p className="cand-image__error" role="status">
            {year} 年の写真を取得できませんでした。この年の写真が無い範囲かもしれません。
          </p>
        )}
        <span className="year-chip">{year}</span>
      </div>
      <figcaption className="visually-hidden">{year} 年</figcaption>
    </figure>
  );
}
