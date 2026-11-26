import { CLASS_INFO, classText } from '../lib/classes';
import type { CandidateClass } from '../lib/api-types';

/** 分類の印。色だけでなく、形と線種のサンプルも並べる */
export function ClassSwatch({ cls, size = 18 }: { cls: CandidateClass; size?: number }) {
  const info = CLASS_INFO[cls];
  const s = size;
  // 色は CSS の変数（テーマで値が変わる）。SVG の属性ではなく style で渡す
  const paint = { fill: info.color, stroke: info.color };
  return (
    <svg width={s} height={s} viewBox="0 0 18 18" aria-hidden="true" focusable="false" className="class-swatch">
      {info.shape === 'circle' && (
        <circle cx="9" cy="9" r="6.5" style={paint} fillOpacity={0.35} strokeWidth="2" strokeDasharray={info.dash} />
      )}
      {info.shape === 'square' && (
        <rect x="2.5" y="2.5" width="13" height="13" style={paint} fillOpacity={0.25} strokeWidth="2" strokeDasharray={info.dash} />
      )}
      {info.shape === 'triangle' && (
        <path d="M9 2.5 16 15H2Z" style={paint} fillOpacity={0.2} strokeWidth="2" strokeDasharray={info.dash} strokeLinejoin="round" />
      )}
    </svg>
  );
}

export function ClassBadge({ cls, short = false, reason }: { cls: CandidateClass; short?: boolean; reason?: string }) {
  const info = CLASS_INFO[cls];
  return (
    <span className="class-badge" style={{ borderColor: info.color, color: info.color }} data-class={cls}>
      <ClassSwatch cls={cls} size={14} />
      {reason ? classText(cls, reason) : short ? info.short : info.label}
    </span>
  );
}
