const numberFormat = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 3 });
const oneDecimalFormat = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 });
const probFormat = new Intl.NumberFormat('ja-JP', { minimumFractionDigits: 2, maximumFractionDigits: 3 });

export function formatNumber(value: number): string {
  return Number.isFinite(value) ? numberFormat.format(value) : '—';
}

export function formatArea(m2: number): string {
  return `${oneDecimalFormat.format(m2)} m²`;
}

/** 0〜1 の割合を % で出す */
export function formatRatio(ratio: number): string {
  return `${oneDecimalFormat.format(ratio * 100)} %`;
}

export function formatProb(p: number): string {
  return probFormat.format(p);
}

export function formatLonLat([lon, lat]: [number, number]): string {
  return `北緯 ${lat.toFixed(5)}・東経 ${lon.toFixed(5)}`;
}
