# TownScan

[![CI](https://github.com/Starlight-Tree/TownScan/actions/workflows/ci.yml/badge.svg)](https://github.com/Starlight-Tree/TownScan/actions/workflows/ci.yml)

[English](README.md) | 日本語

熊本市の中心部で、2 時点（2018 年・2023 年）の空中写真から新築の候補を見つけ、件数・地図・検出画像を根拠にして、会話で答えるアプリ「TownScan」です（FastAPI、Next.js、Postgres 17、Docker Compose。建物の抽出モデルは Google Colab で実行）。
ローカルで動くたたき台で、公開はしていません。答えは、ツールを呼ぶ模擬モデル（固定の返答）が返します。画面に出る精度は実測値で、低い値です（「機能」を参照）。

## 機能

- **ツールの結果だけを根拠にするチャット。** 件数・面積・座標は、ツールの結果（候補の一覧、地区ごとの件数、地図、画像の切り出し）だけから出し、モデルの文章では書きません。データの範囲外の質問は断ります。モデルは既定で模擬で、実際の LLM はまだつないでいません。
- **差分から出す、新築候補の 3 分類。** 2023 年の建物の外形のうち、2018 年の建物データに無いものを、2018 年の写真で確かめます。`confirmed_new`（2018 年に何も無い）・`existing_omission`（2018 年の写真に既にある。建物データの描き漏れ）・`uncertain`（判定保留）。差分は入口で、確かめるのは写真です。画面では「新規出現（旧写真に無い）」「既存の描き漏れ（旧写真に既にある）」「判定保留」と呼び、色・線・形で区別します。
- **地図と、写真の見比べ。** 候補を地理院タイル（標準地図・2018 年の写真・2023 年の写真）の上に描きます。詳細のドロワーで、1 棟の 2018 年と 2023 年の切り出しを並べ、根拠の数字を出します。
- **限界を隠さない精度ページ。** 建物の抽出を、2018 年の建物データを参照にして、画素 IoU と物体単位 F1 で測っています。調整用と評価用のタイルを分けて報告します（選んだ設定での評価用の物体単位 F1 は約 0.16。閾値は未検証の初期値）。いまの実行では、確かめた既存の建物のうち約 3 割（200 棟中 66 棟）を、2018 年の抽出が何も見ていないので、既存の建物が「新規出現」に混ざる向きの偏りがあります。新築の再現率は、手ラベルが無いので「未測定」と明示しています。
- **合成データと実データを取り違えない。** 実行ごとに種別（`real`・`synthetic`）を記録し、合成のテスト用データのときは、画面にバナーを出します。

## 構成

```mermaid
flowchart LR
    B[ブラウザー] --> W["Next.js<br/>web (:3500)"]
    W -->|"/api/* を転送"| A["FastAPI<br/>api (:8500)"]
    A --> DB[("Postgres 17")]
    A -.->|"読み取り専用: 写真タイル"| D[("data/townscan")]
    B -->|"地図タイル"| G["地理院タイル"]
```

データは、必要なときに流すオフラインの処理（pipeline）で作ります。

```mermaid
flowchart LR
    P["地理院の写真<br/>2018 / 2023"] --> C["Google Colab（T4）<br/>建物の抽出"]
    C --> PP["pipeline/<br/>ベクトル化・2018 年の建物データとの差分・3 分類・評価"]
    K[("基盤地図情報<br/>建物の外形 2018-10 版")] --> PP
    PP --> O["out/<br/>run.json・candidates.geojson・eval.json"]
    O -->|"python -m app.load"| DB[("Postgres 17")]
```

ブラウザーは同じオリジンの `/api/*` だけを呼び、web のコンテナが API へ転送します（転送先は実行時の環境変数 `API_URL`）。ポートは `127.0.0.1` だけに公開し、DB は公開しません。pipeline と API の間のデータの契約は [docs/spec-prototype.md](docs/spec-prototype.md) です。

## クイックスタート

ホストで実行します（Docker と Node 24 が要ります）。

```bash
scripts/dev-up.sh    # 初回は .env を作り（乱数の DB パスワード）、frontend をビルドして、db・api・web を起動する
```

- 画面: <http://127.0.0.1:3500>、API の仕様: <http://127.0.0.1:8500/api/docs>
- このスクリプトは何度流しても同じです。`data/townscan/run1/out/run.json` があれば実データを DB へ読み込み、無ければ読み込みを飛ばします。`data/` は Git に入れていない（写真と建物データは再配布しない）ので、クローンしただけでは候補は空です。実行に必要なファイルは [docs/spec-prototype.md](docs/spec-prototype.md) §4.1 にあり、`python -m pipeline.run_postprocess` が Colab の出力から作ります。
- 止める: `docker compose down`。DB ごと消すとき: `docker compose down -v`。

検査: `scripts/verify.sh [repo|pipeline|backend|frontend|all]`。`backend` は使い捨ての Postgres（Docker が要る）で `pytest` を流し、frontend の重い処理（`npm ci`・型検査・テスト・`next build`）は、Docker VM の空きメモリーが少ないので、ホストの Node 24 で流します。

## 文書

文書は日本語です。

| 文書 | 内容 |
|---|---|
| [docs/plan.md](docs/plan.md) | 計画・段階・出口条件・決定待ち |
| [docs/spec-prototype.md](docs/spec-prototype.md) | たたき台の契約: データのファイル・DB・API・3 分類・評価・画面・出口条件 |
| [docs/decisions/](docs/decisions/) | 決定とその理由: データの候補と規約（0001）、方向（0002） |
| [frontend/README.md](frontend/README.md) | 画面: 動かし方・検査 |
| [backend/README.md](backend/README.md) | API: 動かし方・テスト・入口 |
| [CLAUDE.md](CLAUDE.md) | 開発の規約（AI エージェント向け） |

## このリポジトリについて

ポートフォリオとして公開している個人のプロジェクトです。次のことを試すために作りました: 限界を隠さずに評価する画像認識、数字を自分では書けないチャット、検出を写真で確かめる地図の画面。秘密は含みません（`.env` は Git の管理外で、コミットしているのは `.env.example` だけ）。パターンによる秘密の検査は、完全な保証ではありません。

データ: 写真は国土地理院のタイル（出典は画面に表示）、参照の建物は国土地理院の基盤地図情報、モデルは `giswqs/whu-building-unetplusplus-efficientnet-b4`（Apache-2.0。学習データ WHU の利用条件は未確認）です。どれも、このリポジトリでは再配布しません。詳細は [docs/decisions/0001-data-candidates.md](docs/decisions/0001-data-candidates.md) です。

## ライセンス

[MIT](LICENSE)（このリポジトリのコードに対するものです。上のデータとモデルは、それぞれの規約に従います）
