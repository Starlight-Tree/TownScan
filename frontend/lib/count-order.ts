/** 件数のカードの表の並び: 2018 年は未検出 → 要確認など → 端のため未判定 → 2018 年も検出（同じ順位の中は、呼ぶ側が面積で並べる） */
export function countRank({ class: cls, reason }: { class: string; reason?: string }): number {
  if (cls === 'confirmed_new') return 0;
  if (cls === 'uncertain') return reason === 'edge' ? 2 : 1;
  return 3;
}
