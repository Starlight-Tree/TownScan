# CLAUDE.md

TownScan。熊本市中心部の空中写真から新築の候補を棟ごとに検出し、衛星（Google Earth Engine）で広域の変化の当たりをつけ、会話で聞けるアプリ。集計・地図・検出画像を根拠付きで返す。屋根の太陽光パネルは後半の拡張。AI スクールの制作課題。
計画の正本は [docs/plan.md](docs/plan.md)（段階・出口条件・決定待ち）。決定は `docs/decisions/` に 1 件 1 ファイル。

## 状態（2026-11-25）

P0（基盤）と P1（データの調査）は済み。調査の結論は [docs/decisions/0001-data-candidates.md](docs/decisions/0001-data-candidates.md)（**建物データの差分は新築の検出器にならない → 写真からの画像認識が要る**。対象地域は熊本市の中心部）。**たたき台（ローカルで動き、UI で操作できる縦切り）のコードがある**: `pipeline/`（推論後の後処理・3 分類・評価・DB へのローダー `pipeline.load`）、`api/`（Go の API・Postgres・チャット）、`frontend/`（Next.js）、`compose.yaml`。契約は [docs/spec-prototype.md](docs/spec-prototype.md)（データの契約・3 分類・出口条件 E1〜E8）。起動は `scripts/dev-up.sh`、検査は `scripts/verify.sh`。画面の枠は JobNavi・DocuNavi と同じ作り: 左のサイドパネル（1024px 以上。開閉・細い帯・保存しない）と、プロフィールアイコンつきのアカウントのメニュー（テーマの切り替えもここ）。**ログインは任意**（Better Auth・Google だけ・Cookie 接頭辞 `townscan`。web が JWT を出し、api が JWKS で検証する。`GET /api/me`。仕様は spec-prototype §2.1）で、ログインしなくても全機能が使える（**会話の保存と開き直しだけが、ログイン中の機能**。API は Go に、画面はサイドパネルの一覧に実装済み（2026-11-25）。[ADR 0006](docs/decisions/0006-conversation-history.md)）。**実 LLM は任意**（既定は模擬。`LLM_PROVIDER=gemini` で Gemini、既定のモデルは `gemini-3.5-flash-lite`。失敗は 502 で、模擬へは落とさない。[ADR 0003](docs/decisions/0003-llm-provider.md)）。実データ（熊本 12 タイル）の物体単位の精度は低く、2018 年の写真での見落としが「新規出現」に入る偏りがある（精度ページの限界欄に書く）。**API は Go**（ユーザー決定 2026-11-25。[ADR 0005](docs/decisions/0005-api-in-go.md)。契約の検査 `contract/` を先に作り、Go の `api/` が満たしたので、Python（FastAPI）の API は 2026-11-25 に消した。最後の版は git 履歴の `e9a6614` の `backend/`）。画像認識・差分・評価・データの読み込みは Python のまま。**方向は B 案で承認済み**（[ADR 0002](docs/decisions/0002-direction.md)）: 核=建物抽出→2 時点差分→チャット、GEE 層は後半の薄い層（小検証のあと go/no-go）、パネルはその後。`docs/plan.md` は書き換え済み。次は、plan.md 末尾の決定待ち（学習データの方針・最初の小実験の承認）。GEE の結果は「新築」と呼ばず「変化の当たり」と呼ぶ。

## 守ること

- **仕様が先。** 段の始めに `docs/plan.md` へ出口条件（実行できる検査）を書いてから実装する。評価（P2）を先に作り、指標を落とさない。
- **数字・件数・座標は LLM に書かせない。** ツールの結果をそのまま描く。範囲外の質問は断る。
- **データの規約を先に確かめる。** 画像・ラベルは、公式ページでライセンスを確認してから使い、ADR に残す。`data/` は Git に入れない（再配布しない）。
- **実 API（課金）・外部への書き込み・新しいサービス・言語・DB（PostGIS を含む）は、事前に承認を得る**（件数・回数・概算費用を先に示す）。
- **`.env`・`backups/` は読まない。** 値を表示・ログ・コミットしない。`BETTER_AUTH_SECRET` は `scripts/dev-up.sh` が 1 回だけ作り、**決めたら変えない**（DB の署名鍵 `auth_jwks` と Google のトークンの暗号化に使う）。秘密の置き場は Infisical（プロジェクト `townscan`・env dev。[ADR 0004](docs/decisions/0004-secrets-infisical.md)）で、`.env` は代わりの経路。`GOOGLE_CLIENT_ID`・`GOOGLE_CLIENT_SECRET`・`GEMINI_API_KEY` は、ユーザーが自分の端末で `scripts/login-secrets.sh` から登録する（値は私が読まない）。
- **言語と責務**（ADR 0005）: 画面は TypeScript、解析（画像認識・評価・差分・GEE・データの読み込み）は Python、**API は Go**。同じ API・業務ロジックを複数言語で二重に実装しない。設定ファイルの JavaScript（`*.mjs`）は例外として許可し、それ以外の新規の JavaScript は足さない。言語の統一だけを理由に、既存のファイルを無断で変更・削除しない。モックや検査は、代わりが同じ検証を満たすまで消さない。新しい言語・実行環境・サービス・依存は、目的・代替案・影響を示して事前に承認を得る。
- 変更したら、触れた範囲の検査を実行してから報告する。確認できていないことは、確認済みと書かない。「最新トレンド」の主張には、出どころ（一般知識か今回の調査か）を 1 行で添える。

## 環境

- 開発は開発コンテナ（`.devcontainer/`。専用ボリューム `townscan-claude-config`）。Python 3.13・Node 24（版の基準は `.python-version`・`.node-version`）。
- ホスト専用: コンテナの作成・再ビルド（`devcontainer up --workspace-folder .`）、Chrome、人間のログイン。コンテナの `.devcontainer`・`.git/hooks`・`.claude/settings.json` は読み取り専用（変更はホストで）。
- 初回: コンテナの中で `claude` にログインする（ボリュームは空で作られる）。
- **開発は開発コンテナで進める**（ユーザー指示 2026-11-24 夜。先に「整うまでホスト」としていたのを切り替えた）。Python の環境は、コンテナの中で `scripts/setup-dev.sh`（venv は `~/.venvs/townscan`。コンテナを作り直したら再実行）。実行・検査は `devcontainer exec --workspace-folder . bash -lc '~/.venvs/townscan/bin/python …'` か `scripts/verify.sh`。Claude のセッションがホストにあるうちは、コードの変更はホストの作業ツリー（コンテナと同じ実体）に書き、実行はコンテナの中で行う。コンテナのセッション（VS Code の Reopen in Container → claude ログイン）に移すかは、ユーザーが決める。

## Git

- Conventional Commits（`type(scope): 英語の命令形の要約`、件名 72 文字以内）、1 コミット 1 論理変更。ステージはパスを指定（`git add -A`・`git add .` は使わない）。
- コミットは `git diff --staged` を見せてから。プッシュ・`git reset`・`git restore` は、操作ごとに承認。強制プッシュはしない。
