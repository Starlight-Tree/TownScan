import Link from 'next/link';

// 存在しない URL の 404。ルートの layout（html・body・スキップリンクだけ）の中に出る。
// (site)・(auth) の枠は付かないので、スキップリンクの行き先（#main）になる <main> を、ここで持つ。持たないと、404 でスキップリンクが何も指さない。
// metadata は出さない: タブ名を全ページで TownScan にそろえている（tests/tab-title.test.ts）。
export default function NotFound() {
  return (
    <main id="main" className="page page--narrow" tabIndex={-1}>
      <h1 className="page__title">ページが見つかりません</h1>
      <p className="page__lead">開こうとしたページは、ないか、移動した可能性があります。URL を確かめるか、トップへ戻ってください。</p>
      <div className="button-row">
        <Link href="/" className="btn">
          トップへ戻る
        </Link>
      </div>
    </main>
  );
}
