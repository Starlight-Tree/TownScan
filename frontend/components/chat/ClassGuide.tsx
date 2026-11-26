import { CLASS_INFO, CLASS_ORDER } from '../../lib/classes';
import { ClassBadge } from '../ClassBadge';

/** 画面に出す分類の意味（印・名前・1 行の説明）。説明は lib/classes.ts の CLASS_INFO.summary をそのまま出す（詳細の画面と同じ文） */
export function ClassDefinitions() {
  return (
    <dl className="class-guide__list">
      {CLASS_ORDER.map((cls) => (
        <div key={cls} className="class-guide__item" data-class={cls}>
          <dt>
            <ClassBadge cls={cls} />
          </dt>
          <dd>{CLASS_INFO[cls].summary}</dd>
        </div>
      ))}
    </dl>
  );
}
