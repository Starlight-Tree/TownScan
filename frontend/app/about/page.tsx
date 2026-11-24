import Link from 'next/link';
import { ClassSwatch } from '../../components/ClassBadge';
import { CLASS_INFO, CLASS_ORDER } from '../../lib/classes';

export default function AboutPage() {
  return (
    <div className="page page--narrow">
      <h1 className="page__title">このアプリについて</h1>
      <p className="page__lead">
        熊本市中心部の航空写真から、<b>新しく現れた建物の候補</b>を棟ごとに見つけ、会話で調べられるようにした、たたき台です。結果は「候補」であり、新築と断定するものではありません。
      </p>

      <section className="panel" aria-labelledby="h-how">
        <h2 id="h-how" className="panel__title">使い方</h2>
        <ol className="steps">
          <li>
            <Link href="/">チャットと地図</Link> を開き、左のチャットに質問を入れます（例: 「新規出現の候補は何件ありますか？」）。例の質問を押してもかまいません。
          </li>
          <li>返ってきた結果カードで、件数・表・比較・写真・精度を見ます。「根拠を見る」で、データの出どころを確かめられます。</li>
          <li>右の地図で、写真の年（2018・2023）と標準地図を切り替えます。候補の印や形を選ぶと、詳細が開きます。</li>
          <li>詳細では、同じ場所の 2018 年と 2023 年の写真を見比べ、分類の理由と根拠の数字を読めます。</li>
        </ol>
        <p className="page__small">
          数字・件数・座標は、ツールの結果をそのまま出しています。いまの応答は「模擬モデル」で、決まった規則で質問の意図を選んでいます。
        </p>
      </section>

      <section className="panel" aria-labelledby="h-classes">
        <h2 id="h-classes" className="panel__title">3 つの分類の意味</h2>
        <p className="page__small">入口は、2023 年の写真から見つけた建物のうち、建物データ（基盤地図情報 2018 年 10 月版）に載っていないものです。そのうえで、2018 年の写真で確かめます。地図では、色・線の種類・形でも区別しています。</p>
        <dl className="class-list">
          {CLASS_ORDER.map((c) => (
            <div key={c} className="class-list__row">
              <dt>
                <ClassSwatch cls={c} size={22} />
                {CLASS_INFO[c].label}
              </dt>
              <dd>{CLASS_INFO[c].description}</dd>
            </div>
          ))}
        </dl>
        <p className="page__small">分類の閾値は、手でラベルした正解が無いため検証できていない、初期値です。</p>
      </section>

      <section className="panel" aria-labelledby="h-limits">
        <h2 id="h-limits" className="panel__title">限界</h2>
        <ul className="plain-list">
          <li><b>写真が無い期間</b>: 使える年は 2018 年と 2023 年です。2024 年以降に建った建物は、写真が無いので確かめられません。</li>
          <li><b>2018 年は帯状の範囲だけ</b>: 2018 年の写真は、斜めの帯状の断片です。2018 年と 2023 年を比べられるのは、その帯の中の 12 地区だけです。</li>
          <li><b>タイルの縁</b>: 1 地区は地理院タイル 1 枚です。縁で切れた建物は、判定を保留するか、精度の評価から外しています。</li>
          <li><b>誤検出の可能性</b>: モデルは写真から建物らしい塊を見つけるだけです。駐車場の屋根・仮設の建物・影などを誤って拾うことがあり、2 つの年で同じ誤検出が起きると「既存の描き漏れ」に入ります。</li>
          <li><b>撮影月が不明</b>: 写真は年度単位で、「いつ建ったか」は年の幅でしか言えません。</li>
          <li><b>対象外</b>: 衛星の「変化の当たり」（Google Earth Engine）は<b>未実装</b>です。屋根の太陽光パネル、人による確認・確定、実際の言語モデル、公開もしていません。</li>
        </ul>
        <p className="page__small">
          精度の数字は <Link href="/accuracy">このアプリの精度</Link> にあります。新築の再現率は未測定です。
        </p>
      </section>

      <section className="panel" aria-labelledby="h-sources">
        <h2 id="h-sources" className="panel__title">出典と規約</h2>
        <ul className="plain-list">
          <li><b>地図・写真</b>: 国土地理院「地理院タイル」（標準地図、年度別の写真 <code>nendophoto2018</code>・<code>nendophoto2023</code>）。出典を地図に表示しています。</li>
          <li><b>建物データ（評価の正解）</b>: 国土地理院「基盤地図情報」の建築物の外周（2018 年 10 月版）。</li>
          <li>
            <b>建物抽出モデル</b>: <code>giswqs/whu-building-unetplusplus-efficientnet-b4</code>（Apache-2.0）。学習に使われたデータセット（WHU）の利用条件は、確認できていません。
          </li>
          <li>地理院タイルを機械学習などに大量に使うことの扱いは未確認です。公開する前に、規約を確かめます。</li>
        </ul>
      </section>
    </div>
  );
}
