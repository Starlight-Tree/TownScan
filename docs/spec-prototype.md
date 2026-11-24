# たたき台の仕様（ローカルで動き、UI で操作できる縦切り）

状態: 2026-11-24 起草（ユーザー依頼「アプリをローカル環境で動かして UI で操作できるたたき台になるところまで」）。**この文書が契約**。実装はここに従い、変えるときは先にここを直す。
改訂 2026-11-25: §4.2（`reason` から `small` を外す）と §6（縁の除外を左右対称に・追加の診断・参照の時期の注記）を、実装と監査の指摘に合わせて直した。
位置づけ: [plan.md](plan.md) の P2（建物抽出と評価）・P3（差分・API・DB）・P4（チャット）を、薄く一通り通す。GEE 層（P5）・パネル（P6）・公開（P7）は対象外。

## 1. 何ができれば「たたき台」か

1. 熊本の 12 地区（z18 タイル 12 枚。2018・2023 年の写真が両方ある）で、事前学習モデルの建物抽出 → 2 時点の差分 → 「新規出現候補」3 分類が、**実データで**出る（Colab の T4 で推論）。
2. `docker compose up` で db・api・web が立ち上がり、ブラウザ（`http://127.0.0.1:3500`）で、チャットで質問でき、地図に候補が出て、1 棟ずつ 2018 / 2023 の写真を見比べられる。
3. 「このアプリの精度」の画面に、**実測した数字**（基盤地図情報 2018-10 版を参照にした建物抽出の指標）が出る。新築の再現率は手ラベルが無いので「未測定」と明示する。
4. 数字・件数・座標は、ツールの結果だけから出る（LLM に書かせない。模擬モデルが既定）。範囲外は断る。
5. 合成データ（テスト用）と実データを取り違えない（§4 の `run.kind`、UI のバナー）。

対象外（やらない・やったと書かない）: GEE 層、パネル、確認モード（人の確定）、実 LLM、認証、公開、地区の行政区画の厳密な境界、PostGIS。

## 2. 構成

```
host ブラウザ ──> web (Next.js, 127.0.0.1:3500) ──/api/* を転送──> api (FastAPI, 127.0.0.1:8500) ──> db (Postgres 17, 公開しない)
                                                                  └─ ./data/townscan を読み取り専用でマウント（写真タイル）
```

- 起動はホストの Docker Compose（`compose.yaml`）。ポートは `127.0.0.1` だけに公開（既存の jobnavi 3200/8200・shoporder 3400/8400・docunavi 5433 と重ねない）。db は公開しない。
- Docker VM は 8 GB で、他プロジェクトが約 5.3 GB を使っている。**本番ビルド（`next build` + standalone 実行）**にし、compose の `mem_limit` を db 256m・api 512m・web 512m とする。実測の使用量を報告する。
- **メモリーの制約（2026-11-24 夜に実測）:** Docker VM の空きは約 0.5 GB（`free -m` の available 519 MB。jobnavi-frontend 1.9 GB・shoporder-frontend 3.3 GB が常駐）。ここで `next build`・`tsc`・`vitest` のような重い処理を流すと、OOM キラーが他プロジェクトのコンテナを落とす恐れがある。**他プロジェクトのコンテナは止めない・触らない。** よって **frontend の重い処理（`npm ci`・型検査・テスト・`next build`）はホストの Node 24 で行う**（理由: VM の空きメモリー。ホストの RAM は 17 GB。Node 24 は `npx -y -p node@24 -- <コマンド>` で得られる。実測で node v24.22.3）。Python の処理（pipeline・backend の単体テスト）は軽いので開発コンテナで行う。
- web のイメージは 2 つの target を持つ: `runtime`（イメージの中で `npm ci` と `next build` まで行う。メモリーに余裕のある環境・CI 用）と `prebuilt`（ホストで作った `.next/standalone` を載せるだけ。この VM ではこちらを使う）。`scripts/dev-up.sh` は `WEB_BUILD=host`（既定）／`docker` で選ぶ。
- コード・テストの実行は、可能なものは開発コンテナ（`devcontainer exec --workspace-folder /Users/Home/Projects/TownScan bash -lc '…'`、venv は `~/.venvs/townscan`）で行う。compose・DB を使うものはホストの Docker。
- 秘密: 無い。DB のパスワードは `scripts/dev-up.sh` が初回に乱数で `.env`（gitignore 済み）へ書く。`.env` は読まない・表示しない。

## 3. ディレクトリと担当

| 場所 | 内容 |
|---|---|
| `pipeline/` | 後処理（ベクトル化・基盤地図情報の読み込み・評価・差分と 3 分類・地区名）。出力は §4.1 |
| `pipeline/colab/` | Colab 側の推論スクリプト（**メインのセッションが担当。触らない**） |
| `backend/` | FastAPI・DB スキーマ・ローダー・ツール・模擬チャット・画像切り出し |
| `frontend/` | Next.js（App Router・TypeScript）。`frontend/Dockerfile` を含む |
| `compose.yaml`・`.env.example`・`scripts/dev-up.sh` | backend の担当 |
| `scripts/verify.sh`・`.github/` | 最後に統合役が配線（それまで触らない） |
| `data/townscan/` | 実行時データ（gitignore 済み。Git に入れない） |

## 4. データの契約

### 4.1 ディスク（`data/townscan/`）

```
data/townscan/
  tiles/{year}/{x}_{y}.png            写真タイル 256×256 RGB（z18。地理院 nendophoto{year}。Colab が取得したものを持ち帰る）
  run1/colab/                         Colab の出力（メインが置く）
    meta.json                         モデル・版・正規化・タイル一覧・取得結果
    prob_{year}_{x}_{y}_s{100|150|200}.npy   建物の確率 float16 (H,W)。H=W=256×倍率（1.0/1.5/2.0 倍に双三次で拡大して推論）
  run1/out/                           後処理の出力（pipeline が作る。backend のローダーが読む）
    run.json                          {run_id, kind:"real"|"synthetic", created, model, params, tiles:[...], notes}
    areas.json                        [{id, z, x, y, bbox:[w,s,e,n], centroid:[lon,lat], name, ward, municipality, name_source}]
    buildings_2018.geojson / buildings_2023.geojson   建物ポリゴン（lon/lat）。properties: area_id, area_m2, prob_mean
    candidates.geojson                新規出現候補（§5）
    eval.json                         評価（§6）
```

- 地区 = z18 タイル 1 枚。`id` = `z18-{x}-{y}`。範囲は Web メルカトルのタイル境界を lon/lat にしたもの。
- 地区名 = 地理院の逆ジオコーダ（`https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=&lon=`）の `muniCd`・`lv01Nm`。`name` は「町丁目名」、`ward` は 43101 中央区・43102 東区・43103 西区・43104 南区・43105 北区。**pipeline のコードは外部へ通信しない**（`geocode.py` は、取得済みの応答を受けて名前を作る関数と、メインが実行する取得用の関数に分ける。取得は承認済みの範囲外なのでメインが行う）。
- 面積 `area_m2` は EPSG:6670（JGD2011 / 平面直角座標系 II 系）で計算。

### 4.2 `candidates.geojson`

FeatureCollection。Feature の `id` は `c-{x}-{y}-{n}`（n は地区内の連番、面積の大きい順）。geometry は Polygon（lon/lat）。`properties`:

```
area_id, class ("confirmed_new"|"existing_omission"|"uncertain"), area_m2,
bbox [w,s,e,n], centroid [lon,lat],
evidence: { prob_2023_mean, ov_2018, prob_2018_p90, ov_kiban, edge_touch },
reason: "new_absent_2018" | "present_2018" | "ambiguous" | "edge"
```

`reason` は上の 4 つだけ。面積 20 m² 未満の塊は §5 で**捨てる**ので、`candidates.geojson` に出ず、`"small"` は**出力しない**（pipeline の `diff` は、捨てる理由として内部でだけ使う）。backend のローダーは `"small"` も受理するが、これは余分に許しているだけで、pipeline は出さない。

### 4.3 DB（Postgres 17。拡張なし）

`runs(run_id pk, kind, created_at, model, params jsonb, notes)`・`areas(id pk, run_id, z, x, y, west, south, east, north, centroid_lon, centroid_lat, name, ward, municipality, name_source)`・`buildings(id bigserial pk, run_id, area_id, year, area_m2, prob_mean, geom jsonb)`・`candidates(id text pk, run_id, area_id, class, area_m2, west, south, east, north, centroid_lon, centroid_lat, geom jsonb, evidence jsonb, reason)`・`metrics(run_id pk, body jsonb)`。`class` は CHECK 制約。ローダーは冪等（同じ run_id を入れ直すと置き換える。トランザクション）。表示する現在の run は「最新の created_at」。

### 4.4 API（JSON。接頭辞 `/api`）

| メソッド・パス | 内容 |
|---|---|
| GET `/api/health` | `{status, db, llm:"mock", run:{run_id, kind, created_at}, counts:{areas, candidates, buildings}}` |
| GET `/api/areas` | 地区の一覧（`id,name,ward,bbox,centroid,counts:{confirmed_new,existing_omission,uncertain,total}`） |
| GET `/api/candidates?area_id=&cls=&sort=area_desc&limit=&offset=` | `{total, items:[CandidateSummary]}` |
| GET `/api/candidates.geojson?area_id=&cls=` | 地図用 FeatureCollection（properties に `id,class,area_m2,area_id`） |
| GET `/api/candidates/{id}` | `CandidateDetail`（summary + evidence + 説明文のキー + 画像 URL + provenance） |
| GET `/api/candidates/{id}/image?year=2018\|2023&size=512` | PNG。候補の外接矩形に余白（約 20 m）を足した切り出しをタイルから作り、輪郭を描く。タイルの外へは出ない |
| GET `/api/metrics` | `eval.json` の内容 + provenance |
| POST `/api/chat` | 入力 `{messages:[{role,content}]}`、出力 `{message:{role:"assistant", content, results:ToolResult[], tool_calls:[{name,args}]}}` |

エラーは `{error:{code,message}}` と適切な HTTP ステータス。存在しない id は 404、不正な引数は 422。

### 4.5 チャットのツール結果（判別可能ユニオン。`type` で分ける）

```
Provenance = { source, photo_years:number[], model, metric?, run_id, run_kind, note? }
ToolResult =
 | { type:"count",   title, total, breakdown:[{key,label,value}], filter:{area_id?,cls?}, provenance }
 | { type:"table",   title, columns:[{key,label}], rows:[{id?, ...}], total, shown, provenance }
 | { type:"compare", title, items:[{area_id,name,counts:{...}}], provenance }
 | { type:"map_focus", title, bbox:[w,s,e,n], candidate_ids:string[], provenance }
 | { type:"detection_image", title, candidate_id, class, images:[{year,url}], caption, provenance }
 | { type:"accuracy", title, metrics:[{key,label,value|null,note}], provenance }
 | { type:"refusal", reason:"out_of_scope"|"no_photo_period"|"not_implemented"|"no_data", message, suggestions:string[] }
```

- **数字は結果からだけ**: 返答文 `content` に出る数字は、`results` に含まれる値だけ。API 側に検査（`guard_numbers`）を置き、満たさない返答は返さない（テストで確かめる）。文はテンプレートで作る。
- 模擬モデルは、日本語の規則で意図を決める（件数・一覧・比較・詳細／写真・精度・使い方・範囲外）。地区名は DB の `areas.name`・`ward` との部分一致。意図は `tool_calls` に出す。
- 範囲外の例: 天気・雑談、2024 年以降の棟の確認（写真が無い → `no_photo_period`）、衛星の「変化の当たり」（`not_implemented`: 未実装と言う）、対象地区の外。
- LLM の切り替え: 環境変数 `LLM_PROVIDER`（既定 `mock`）。`mock` 以外は起動時にエラー（実モデルは承認後）。道具の登録口は、後から GEE の道具を足せる形にする（登録表）。

## 5. 差分と 3 分類（`pipeline/diff.py`）

入口 = 2023 年の建物の塊 `c` のうち、**基盤地図情報（2018-10 版）に載っていないもの**（`ov_kiban < 0.25`。`ov_kiban` = c の面積のうち建物データが覆う割合）。面積が 20 m² 未満は捨てる（`small`）。次に旧写真（2018 年）で確かめる:

- `existing_omission`: `ov_2018 ≥ 0.5`（2018 の抽出が c の半分以上を覆う。旧写真に既にある → 建物データの描き漏れ。**モデルが両年とも同じ誤検出をしている場合も、ここに入る**）。
- `confirmed_new`: `ov_2018 ≤ 0.10` かつ `prob_2018_p90 < 0.20`（2018 のモデルが c の範囲に何も見ていない）。
- `uncertain`: 上のどちらでもない、またはタイルの縁に接する（`edge_touch`。`reason: "edge"`）。

閾値は `run.json.params` に入れる。**この閾値は未検証の初期値**（手ラベルが無い）と、UI の「このアプリの精度」に書く。名前に「確定」を使わない UI 文言は「新規出現（旧写真に無い）」「既存の描き漏れ（旧写真に既にある）」「判定保留」。

## 6. 評価（`pipeline/evaluate.py` → `eval.json`）

- 参照: `data/kiban/kmm_20181001`（基盤地図情報 BldA 2018-10 版。解析の読み方は `scripts/spike/kiban/loader_only.py`）。対象は 2018 年の写真 12 枚。
- 指標: 画素 IoU・適合率・再現率・F1、物体単位 F1（IoU ≥ 0.5 の 1 対 1 対応）。
- **縁の除外は、参照と予測で対称にする。**
  1. タイルの縁に接する物体は、参照・予測の両方から外す（切れた建物の不利を避けるため。参照 = 建物のポリゴンがタイルの縁の線と交わる、予測 = 連結成分が配列の縁に接する）。
  2. 1 で外した物体と、**自分の面積の半分以上が重なる反対側の物体も外す**（縁の手前で止まった予測の相手の参照、縁まで届いて隣と合体した予測の中の参照が、片側だけ残らないように。重なりは、相手側の外した物体の和との重なり。半分ちょうどを含む）。1 で外した物体を起点にした 1 段だけで、2 で外した物体からさらに外すことはしない（実データ 12 地区で 2 段目まで広げて数えたところ、増える物体は 0 だった）。
  3. 画素の指標では、外した物体の画素を、その物体の側の配列から除く（棟と画素は同じ決定で扱う）。
  4. 外した数を出す（`excluded_edge_objects` = 縁に接する数 + 重なりで外した数。内訳は `excluded_edge_detail`）。
- 分割: 12 枚を、`tiles` の並び順の前半 6 枚（調整用）と後半 6 枚（評価用）に分ける。倍率（1.0/1.5/2.0）と閾値（0.3〜0.7）は**調整用だけ**で選び、評価用と全体を別に報告する。選んだ値は `run.json.params`。
- `eval.json`: `{reference, split:{tune:[area_id], holdout:[area_id]}, sweep:[{scale,threshold,tune_object_f1,...}], chosen:{scale,threshold,selected_by}, holdout:{pixel:{...}, object:{...}}, tune:{...}, overall:{...}, per_area:[...], excluded_edge_objects:{reference,prediction}, excluded_edge_by_split:{...}, reference_detail:{...}, protocol:{year,...}, new_building_recall:null, notes:[...]}`。`overall` は 12 地区の合計の指標（`tune`・`holdout` と同じ形）、`excluded_edge_by_split` は縁の除外の数を調整用・評価用・全体に分けたもの、`protocol` は評価の取り決め（評価に使った写真の年 `year`、縁の除外の下限 `edge_overlap_min` など）、`reference_detail` は参照の素性。`new_building_recall` は手ラベルが無いので **null**（UI は「未測定」と表示）。
- **任意項目**（追加のみ。既存の項目の形は変えない。読む側は、知らない項目を無視する）:
  - `excluded_edge_detail`: `{overall|tune|holdout: {reference:{touching_edge, overlapping_excluded_prediction}, prediction:{touching_edge, overlapping_excluded_reference}}}`。`excluded_edge_objects`・`excluded_edge_by_split` の内訳（足すと一致する）。
  - `year_compare`: 同じ参照・同じ設定（調整用で選んだ倍率・閾値）で、もう一方の年の写真の抽出を測った指標。`{selected_on_year:2018, compare_year:2023, setting:{scale,threshold}, by_year:{"2018":{tune,holdout,overall}, "2023":{tune,holdout,overall}}}`（各 `tune`・`holdout`・`overall` は `{pixel:{...}, object:{...}}`）。選択には使わない。評価の年 `protocol.year` は 2018 のまま、比べる年を `protocol.compare_year` に書く。
  - `existing_absent_in_2018`: 基盤地図情報にある既存の建物（面積 20 m² 以上・縁に接しない）のうち、2018 年の抽出が「何も見ていない」（§5 の `confirmed_new` の 2018 側の条件。`diff` の関数と `DiffParams` をそのまま使う）棟数と割合 `absent`・`absent_share`、`ov_2018 ≥ 0.5` の棟数と割合 `present`・`present_share`。`{setting, params, overall|tune|holdout:{n_buildings, absent, absent_share, present, present_share}}`。**手ラベルの代わりにはならない**（absent には、モデルの見逃しと、写真の時点で取り壊し済みの参照の建物が混ざり、分けられない）。
  - `reference_detail.vintage`: 読み込んだ建物の属性の集計 `{gml_id_prefix, lf_span_from, dev_date: {値: 棟数}}`。`protocol.edge_overlap_min`: 縁の除外の重なりの下限（0.5）。
- `notes` には、**参照の時期**を、事実と推定を分けて書く。
  - 事実（読み込んだデータの集計。`reference_detail.vintage` から作る）: 読み込んだ建物は全棟が gml:id 接頭辞 K17・lfSpanFr 2018-10-01・devDate 2018-10-02 で、「2018-10」は配布の版の日付にすぎず、建物ごとの日付の違いは無い。
  - 推定（独立の確認はしていない）: [ADR 0001](decisions/0001-data-candidates.md) は、この地域の建物データは 2017-10 の更新のあと実質凍結、2018 年の熊本の写真は 2018 年 12 月の簡易空中写真と記す。これが正しければ、参照は写真より古い。写真にあって参照に無い建物は予測の FP に、参照に残る取り壊し済みの建物は FN に入る。**物体単位の適合率は、モデルの適合率ではなく、モデルの精度と参照の完全性が混ざった値**である。

## 7. UI（`frontend/`）

デザインの参考: 以前の UI モックのソース `/private/tmp/claude-501/-Users-Home-Projects/1150cdf2-1c45-42c2-85c0-d568636ced2a/scratchpad/ts-mock/project/*.dc.html`（Main＝会話と地図・Welcome＝初回の説明・Detail＝建物の詳細・Quality＝精度）。レイアウト・文言・色を踏襲してよい（写真は模式図で、数値はダミーだった。今回は実データ）。

- `/`: 左にチャット、右に地図（狭い幅では縦に積む）。チャットは結果カードを §4.5 の型ごとに描く（`switch` を網羅的にし、`never` で漏れを検出）。サジェストのチップ。送信中・エラーの状態。「模擬モデルで応答しています」の表示（`/api/health` の `llm`）。`run.kind = synthetic` のとき、目立つバナー「合成データ（テスト用）」。
- 地図: 地理院タイルを直接読む（標準地図・2018 年の写真 `nendophoto2018`・2023 年の写真 `nendophoto2023`。帯の外・範囲外のタイルが 404 でも崩れない。出典の表示）。解析した 12 地区の枠を描く。候補のポリゴンを 3 分類の色（色だけに頼らず、形・線種・凡例でも区別）で描き、クリックで詳細。
- 詳細（ドロワー）: 2018・2023 の切り出し画像を並べる（`/api/candidates/{id}/image`）、分類のバッジと平易な説明、根拠の数字（`evidence`）、「地図で見る」。
- `/accuracy`: `/api/metrics` の数字。調整用／評価用の区別、「新築の再現率: 未測定」、閾値は未検証の初期値であることを書く。
  - 見出しの数字（物体単位 F1・画素 IoU）には、**どの年の写真で測った値か**を明記する（`protocol.year`。無ければ 2018）。「再現率」は、「建物の抽出の再現率（基盤地図情報に対する値）」と「新築の再現率（未測定）」を、必ず修飾して書き分ける。
  - `year_compare` があれば、もう一方の年の写真での値と、年で比べる表を出す。無い・形が違うときは、その部分を出さず、画面は落ちない。
  - 限界欄に、`existing_absent_in_2018` から描く「2018 年の写真での見落とし」（既存の建物のうち、2018 年の抽出が何も見ていない割合。手ラベルの代わりにならない）、参照が写真より古い可能性（推定）と物体単位の適合率が合成値であること、年ごとの再現率の違い（数字だけ。原因は書かない）を載せる。数字はデータから描き、手書きにしない。
  - 評価の内部のキー名（`pixel_iou` など）は、日本語の見出しにする。
- `/about`: 使い方・3 分類の意味・限界（写真が無い期間・2018 年は帯状の範囲だけ・タイルの縁・誤検出の可能性）・出典と規約（地理院タイル、基盤地図情報、モデル `giswqs/whu-building-unetplusplus-efficientnet-b4`＝Apache-2.0・学習データ WHU の利用条件は不明）。「変化の当たり（衛星）」は未実装と書く。
- ブラウザから API へは、同じオリジンの `/api/*`（Next の rewrites。転送先は実行時の環境変数 `API_URL`）。
- 技術: Next.js（最新の安定版を、版を固定して）、React、TypeScript strict、Node 24、`output: "standalone"`。地図は Leaflet か MapLibre GL JS（版を固定。選んだ理由を 1 行）。`npm ci` で入れる（ロックファイルをコミット対象に含める）。

## 8. 出口条件（実行して確かめる）

| # | 検査 | 担当 |
|---|---|---|
| E1 | `scripts/verify.sh repo` が合格 | 統合 |
| E2 | `pipeline` の単体テストが合格（タイル計算・ベクトル化・基盤地図情報の読み込み・評価指標・3 分類を、合成データで） | pipeline |
| E3 | `backend` のテストが合格（DB を使うもの、`guard_numbers`、範囲外の拒否、画像の切り出し、ローダーの冪等性） | backend |
| E4 | `frontend` の型検査・lint・テスト・`next build` が合格 | frontend |
| E5 | `scripts/dev-up.sh` で 3 つが起動し、`/api/health`・web の `/`・web 経由の `/api/candidates` が応答。3 つの使用メモリを実測して記録 | backend + 統合 |
| E6 | 実データを読み込み、DB の件数 = `candidates.geojson` の件数 = UI の件数 | メイン |
| E7 | Chrome で、質問 → 結果カード → 地図 → 詳細（2018/2023 の写真）→ 精度の画面、の一連を操作して確認（スクリーンショット） | メイン |

確認できていないことは「確認済み」と書かない。実データでの精度は、12 地区・初期値の閾値という限定つきの数字である。
