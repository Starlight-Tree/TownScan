# CLAUDE.md

TownScan。パリ南西の近郊（県 92 の 12 地区）の IGN の空中写真（2014 年と 2024 年）から新築の候補を棟ごとに検出し、会話で聞けるアプリ（[ADR 0015](docs/decisions/0015-move-to-france.md)）。回答は、短い本文と表示 1 つ（地図・グラフ・写真など）で返す（[ADR 0013](docs/decisions/0013-one-view-per-answer.md)）。屋根の太陽光パネルを数える機能は、後のフェーズで追加し、新築の候補と合わせたハイブリッドにする（ユーザー決定 2026-11-27。時期と範囲は未定）。衛星（Google Earth Engine）で広域の変化の当たりをつける層は後の拡張で、やるかは未決。AI スクールの制作課題。
計画の正本は [docs/plan.md](docs/plan.md)（段階・出口条件・決定待ち。今の段は §4.1 で、§1・§2 の熊本の記述は記録）。決定は `docs/decisions/` に 1 件 1 ファイル。

## 構成と検査

- `pipeline/`（推論後の後処理・3 分類・評価・DB へのローダー）・`api/`（Go の API・Postgres・チャット）・`frontend/`（Next.js）・`compose.yaml`。起動は `scripts/dev-up.sh`。仕様の正本は [docs/spec-prototype.md](docs/spec-prototype.md)。
- `evals/` は、実 Gemini が質問ごとに期待したツールを呼ぶかを測る（実 API。[evals/README.md](evals/README.md)）。指示（`gemini_model.go`）やツールを変えたら、承認を得て流し直す。
- 検査は `scripts/verify.sh`（repo・pipeline・loader・contract・frontend）。**Go のテストは含まれない**ので、`api/` を変えたら `scripts/test-go.sh` を引数なしで流す。**CI が流すのは `verify.sh repo` だけ**で、CI の成功はテストの合格ではない。

## 守ること

- **仕様が先。** 段の始めに `docs/plan.md` へ出口条件（実行できる検査）を書いてから実装する。評価（P2）を先に作り、指標を落とさない。
- **数字は、ツールの結果の値だけから出す。** 結果（件数・表・地図など）は画面が結果のまま描く。**件数の結果 1 件だけの回答は、本文をコードが組み立てる**（LLM の文は使わない。`api/internal/chat/text.go` の `renderCount`。[ADR 0013](docs/decisions/0013-one-view-per-answer.md)）。**候補の一覧・写真・精度・お断りの結果 1 件だけの回答も LLM の文を使わず、結果からコードが本文を作る**（実 LLM のとき。写真は結果の説明、お断りは理由の文。`service.go`）。それ以外の回答で LLM の返答文に書かれる数字は、結果の値だけから出ていることを `guard.go` が検査し、満たさなければ固定文に替える（座標・ID は書かせない。[ADR 0009](docs/decisions/0009-llm-writes-result-numbers.md)）。**検査が止めるのは、数字とカードの位置の語（上の・下記など）だけ**で、数字以外の主張（最も多い・過半など）は検査の外。範囲外の質問は断る。
- **データの規約を先に確かめる。** 画像・ラベルは、公式ページでライセンスを確認してから使い、ADR に残す。`data/` は Git に入れない（再配布しない）。
- **実 API（課金）・外部への書き込み・新しいサービス・言語・DB（PostGIS を含む）は、事前に承認を得る**（件数・回数・概算費用を先に示す）。
- **`.env`・`backups/` は読まない。** 値を表示・ログ・コミットしない。`BETTER_AUTH_SECRET` は `scripts/dev-up.sh` が 1 回だけ作り、**決めたら変えない**（DB の署名鍵 `auth_jwks` と Google のトークンの暗号化に使う）。秘密の置き場は Infisical（プロジェクト `townscan`・env dev。[ADR 0004](docs/decisions/0004-secrets-infisical.md)）で、`.env` は代わりの経路。`GOOGLE_CLIENT_ID`・`GOOGLE_CLIENT_SECRET`・`GEMINI_API_KEY` は、ユーザーが自分の端末で `scripts/login-secrets.sh` から登録する（値は私が読まない）。
- **言語と責務**（ADR 0005）: 画面は TypeScript、解析（画像認識・評価・差分・GEE・データの読み込み）は Python、**API は Go**。同じ API・業務ロジックを複数言語で二重に実装しない。設定ファイルの JavaScript（`*.mjs`）は例外として許可し、それ以外の新規の JavaScript は足さない。言語の統一だけを理由に、既存のファイルを無断で変更・削除しない。モックや検査は、代わりが同じ検証を満たすまで消さない。新しい言語・実行環境・サービス・依存は、目的・代替案・影響を示して事前に承認を得る。
- 変更したら、触れた範囲の検査を実行してから報告する。確認できていないことは、確認済みと書かない。「最新トレンド」の主張には、出どころ（一般知識か今回の調査か）を 1 行で添える。
- **LLM は既定が実 Gemini**（ユーザー決定 2026-11-25。モデルは `gemini-3.5-flash-lite`。失敗は 502 で、模擬へは落とさない）。**模擬は利用者は使わない**（契約の検査・テストと、Claude Code の内部の検証だけ）。切り替えは手でやらず `scripts/with-mock-llm.sh <コマンド>`（終わり・失敗・中断のどれでも gemini へ戻して `llm` を確かめる）。フック（`scripts/hooks/`。検査は `scripts/hooks/test-hooks.sh`）はガードで、完全な防御ではない。**画面の確認の前に `llm` を見る**（[ADR 0003](docs/decisions/0003-llm-provider.md)）。
- **呼び名**: 全体は「候補」。画面の分類は「2014 年は未検出」「未判定」（1 件ごとは「端のため未判定」「要確認」）の 2 つで、モデルが確認した事実を言う（[ADR 0011](docs/decisions/0011-class-labels-by-observation.md)。年と分類の数は ADR 0015）。2014 年の写真でも検出した建物は候補にしない（分類「2014 年も検出」`existing_omission` は DB・API・型に残る）。**回答の中では分類を出さない**（拡大ビューの地図・グラフ、候補の詳細、精度の画面では出す）。分類を指定した件数の本文は、分類名でなく「モデルが 2024 年の写真だけで見つけた候補」「モデルが 2014 年の写真でも見つけた候補」「判定できていない候補」と書く（[ADR 0013](docs/decisions/0013-one-view-per-answer.md)。分類を指定した一覧の題と、別の解析結果の回答の比較の文には、分類名が残る）。「新築」と断定しない。GEE の結果は「変化の当たり」と呼ぶ。

## 環境

- 開発は開発コンテナ（`.devcontainer/`。専用ボリューム `townscan-claude-config`）。Python 3.13・Node 24（版の基準は `.python-version`・`.node-version`）。
- ホスト専用: コンテナの作成・再ビルド（`devcontainer up --workspace-folder .`）、Chrome、人間のログイン。コンテナの `.devcontainer`・`.git/hooks`・`.claude/settings.json` は読み取り専用（変更はホストで）。
- 初回: コンテナの中で `claude` にログインする（ボリュームは空で作られる）。
- **開発は開発コンテナで進める**（ユーザー指示 2026-11-24 夜。先に「整うまでホスト」としていたのを切り替えた）。Python の環境は、コンテナの中で `scripts/setup-dev.sh`（venv は `~/.venvs/townscan`。コンテナを作り直したら再実行）。実行・検査は `devcontainer exec --workspace-folder . bash -lc '~/.venvs/townscan/bin/python …'` か `scripts/verify.sh`。Claude のセッションがホストにあるうちは、コードの変更はホストの作業ツリー（コンテナと同じ実体）に書き、実行はコンテナの中で行う。コンテナのセッション（VS Code の Reopen in Container → claude ログイン）に移すかは、ユーザーが決める。

## Git

- Conventional Commits（`type(scope): 英語の命令形の要約`、件名 72 文字以内）、1 コミット 1 論理変更。ステージはパスを指定（`git add -A`・`git add .` は使わない）。
- コミットは `git diff --staged` を見せてから。プッシュ・`git reset`・`git restore` は、操作ごとに承認。強制プッシュはしない。
