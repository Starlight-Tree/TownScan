/**
 * 「1 地区」の大きさ。地区は、地理院タイル（z18）1 枚。熊本（北緯 33 度付近）では、一辺が約 128 m（z18 の 1 画素 約 0.5 m × 256）。
 * 丁目名・区名は、タイルの中心の住所から付けた名前で、丁目や区の全体ではない。画面のどこでも同じ言い方にするため、ここに 1 つだけ置く
 */
export const TILE_SIDE_TEXT = '約 130 m 四方';

/** 回答の「地区」の値に添える、範囲の説明。areaIds は複数の地区（区など）。totalAreas は解析した地区の総数（分からなければ 0） */
export function areaScopeHint(scope: { areaIds?: readonly string[]; areaId: string }, totalAreas: number): string | null {
  if (scope.areaIds && scope.areaIds.length > 0) return `解析した ${scope.areaIds.length} 地区・各${TILE_SIDE_TEXT}`;
  if (scope.areaId !== '') return `1 地区・${TILE_SIDE_TEXT}`;
  return totalAreas > 0 ? `解析した全 ${totalAreas} 地区・各${TILE_SIDE_TEXT}` : null;
}
