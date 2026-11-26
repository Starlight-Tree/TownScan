import { createContext } from 'react';
import type { CandidateFeature } from './api-types';

/** 読み込み済みの候補（地図と同じもの）。件数のカードの表が読む。読み込み前・失敗・Provider の外は null（表を出さない） */
export const CandidateFeaturesContext = createContext<CandidateFeature[] | null>(null);
