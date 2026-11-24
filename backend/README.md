# TownScan backend

FastAPI（Python 3.13）・Postgres 17（psycopg 3・SQL は自前でパラメータ化）。仕様の正本は [../docs/spec-prototype.md](../docs/spec-prototype.md)（§2・§4.3〜§4.5・§8 E3/E5）。

## 動かす・試す

```sh
scripts/dev-up.sh [--no-web]                      # ホストで。.env 作成 → ビルド → compose up → healthy 待ち → 実データがあれば読み込み
                                                  # .env が無いのに DB のボリュームが残っているときは、パスワードを作り直さず止まる（DB と合わなくなるため）
scripts/test-backend.sh [pytest の引数]            # ホストで。使い捨ての Postgres（townscan-test-db・256m）でテストを流し、終わったら片付ける
docker compose exec -T api python -m app.load --run /data/townscan/run1/out [--check]   # pipeline の出力を DB へ（冪等）
python tests/synthetic.py --out DIR [--tiles DIR]  # 合成データ（kind=synthetic）の書き出し。tests/fixtures/synthetic_run はその写し
```

- ローダーは、全ファイルを先に検査してから 1 トランザクションで `run_id` ごと置き換える。足りない・壊れたファイルは日本語のエラーで止まる（DB は変わらない）。`--check` は DB に触れない。
- 環境変数: `DATABASE_URL`（必須）、`TILES_DIR`（既定 `/data/townscan/tiles`）、`LLM_PROVIDER`（既定 `mock`。mock 以外は起動時にエラー）。
- 開発コンテナの Python（`~/.venvs/townscan-backend`）でも `pytest` は動くが、DB のテストは `TEST_DATABASE_URL` が無いと skip になる。全部流すには `scripts/test-backend.sh`。

## 仕様に形の指定が無い応答（backend が決めたもの。frontend の型と合わせ済み）

- `GET /api/areas` は配列。要素は `{id, name, ward, municipality, bbox, centroid, counts}`（`name` は無ければ id、`ward` は無ければ空文字）。並びは北から南、西から東。
- `CandidateSummary` = `{id, area_id, area_name, ward, class, area_m2, bbox, centroid, reason}`。
- `CandidateDetail` = Summary + `{evidence, geometry, explanation_key, explanation, images:[{year,url}], provenance}`。`explanation_key` は `reason` と同じ値、`explanation` はその平易な日本語。
- `GET /api/metrics` は `eval.json` の内容に `provenance` を足したもの。
- 地区 id は `z18-{x}-{y}`、候補 id は `c-{x}-{y}-{n}`。形が違う値は 422、形が合って存在しない候補は 404。`year` は文字列 `"2018"` か `"2023"` だけ。`size` は 64〜1024。
- `POST /api/chat` の `messages` は 500 件まで受け付ける（超えたら 422）。frontend は会話の全履歴を送るので、件数で弾くと、その会話は二度と進まない。**返答に使う文脈は末尾 20 件だけ**（`app/chat/service.py` の `CONTEXT_MESSAGES`）。それより前の「その地区」「さっきの候補」は引き継がない。
- 模擬モデルは、ID（`c-…`・`z18-…`）が日本語に直接つながっていても読む（前後の半角の英数字・ハイフン以外は区切り）。区が複数出たら、すべて使う: 1 つなら `ward`、2 つ以上なら `wards`（ツールの引数。その区の地区の和集合。表示名は「中央区・西区」）。年は西暦のほか、和暦（令和6年・R6年）と漢数字（二〇二四年）も読み、写真が無い年・「最近」「現在」などは `no_photo_period` で断る。取り壊し・減少（2018 年にあって 2023 年に無い建物）は `not_implemented` で断る。
- `focus_map` の件数は DB の実数。地図に渡す候補 ID は 5000 件で切り、切ったときだけ、タイトルに「N 件のうち、面積の大きい上位 M 件」と書く。

## チャットのツールを足す

`app/chat/tools.py` の `ToolRegistry`（登録表）に `Tool(name, description, JSON Schema, handler)` を `register` する。ハンドラは §4.5 の形の結果（辞書）を返し、`ToolError` で refusal にできる。
模擬モデルに規則を足すのは `app/chat/mock_model.py`（`plan`）、結果の文章化は `register_renderer(type, fn)`。返答文は必ず `guard_numbers`（`app/chat/guard.py`）を通る: 数字が結果の値から出ていなければ、返さず安全なテンプレートに落とす。
