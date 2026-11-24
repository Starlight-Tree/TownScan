const numberFormat = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 3 });
const oneDecimalFormat = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 });
const probFormat = new Intl.NumberFormat('ja-JP', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
const dateFormat = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

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

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : dateFormat.format(d);
}

export function formatLonLat([lon, lat]: [number, number]): string {
  return `北緯 ${lat.toFixed(5)}・東経 ${lon.toFixed(5)}`;
}
