#!/usr/bin/env bash
# TownScan をローカルで起動する（ホストの Docker。開発コンテナの中では実行しない）。仕様: docs/spec-prototype.md §2・§8 E5
# 使い方: scripts/dev-up.sh [--no-web]
#   --no-web       db と api だけ起動する（frontend がまだ無いとき・API だけ確かめたいとき）
#   WEB_BUILD=host    （既定）frontend をホストの Node 24 でビルドしてから、できた .next/standalone を載せて web を作る
#   WEB_BUILD=docker  web のイメージの中でビルドする（Docker VM に空きメモリーがあるとき・CI 用）
#   LLM_PROVIDER=mock  （Claude Code の内部の検証用。利用者は使わない）返答のモデルを模擬にする。既定は gemini（GEMINI_API_KEY が要る）。終わったら付けずに流して戻す
# やること: .env を作る（無ければ。乱数のパスワード。値は表示しない）→ frontend をビルド → docker compose up -d --build
#          → healthy を待つ → 実データがあれば DB へ読み込む → URL を表示。
# ログイン（Google）: .env に BETTER_AUTH_SECRET が無いときだけ、1 回だけ足す（乱数。値は表示しない）。GOOGLE_CLIENT_ID・GOOGLE_CLIENT_SECRET は、あなたが .env に書く（このスクリプトは作らない・読まない・表示しない。Infisical を使うときは、下の「秘密の置き場」の注記のとおり、BETTER_AUTH_SECRET も含めて Infisical が持つ）。
# 何度流しても同じ（.env は作り直さない。実データの読み込みは同じ run_id を置き換える）。
# .env が無いのに DB のボリュームが残っているときは、新しいパスワードを作らずに止まる（DB と合わなくなるため。直し方を表示する）。
# 秘密の置き場（ADR 0004）: 環境変数 TOWNSCAN_INFISICAL_PROJECT_ID（Infisical のプロジェクト ID。秘密ではない）があれば、Infisical の値を
#   infisical run で渡して compose を起動する（環境は TOWNSCAN_INFISICAL_ENV。既定 dev。Google・BETTER_AUTH_SECRET・Gemini の値は Infisical が正。scripts/login-secrets.sh で登録する）。
#   このとき .env に BETTER_AUTH_SECRET は足さない（.env には DB のパスワードだけが要る）。無ければ、従来どおり .env を compose が読む。どちらで起動したかは 1 行表示する。
set -euo pipefail
cd "$(dirname "$0")/.."

die() { echo "エラー: $*" >&2; exit 1; }

# 16 進の乱数を標準出力へ（使い方: random_hex <バイト数>）。作れなかったとき（openssl の失敗・空の出力）は、何も出さずに失敗する。
# printf の引数の中の $(openssl ...) が失敗しても、set -e はそれを拾わず、空の値の行（BETTER_AUTH_SECRET= など）が .env に書かれて
# 成功に見える。だから、呼ぶ側は先に変数へ取り、成功を確かめてから書く。
random_hex() {
  local value
  value="$(openssl rand -hex "$1")" || return 1
  [ -n "$value" ] || return 1
  printf '%s\n' "$value"
}

NO_WEB=0
while [ $# -gt 0 ]; do
  case "$1" in
    --no-web) NO_WEB=1 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) die "不明な引数: $1（使い方: scripts/dev-up.sh [--no-web]）" ;;
  esac
  shift
done
WEB_BUILD="${WEB_BUILD:-host}"
case "$WEB_BUILD" in host|docker) ;; *) die "WEB_BUILD は host か docker です（実際: $WEB_BUILD）" ;; esac

command -v docker >/dev/null || die "docker が見つかりません（ホストで実行してください）"
docker info >/dev/null 2>&1 || die "Docker が動いていません"

# 秘密の置き場（ADR 0004）: TOWNSCAN_INFISICAL_PROJECT_ID があれば Infisical（infisical run で compose を起動する）、無ければ従来どおり .env。
# プロジェクト ID は秘密ではない。Infisical を指定したのに CLI が無いときは、.env に黙って切り替えず（ログインの値が空になる）、止める。
INFISICAL_PROJECT="${TOWNSCAN_INFISICAL_PROJECT_ID:-}"
INFISICAL_ENV="${TOWNSCAN_INFISICAL_ENV:-dev}"
if [ -n "$INFISICAL_PROJECT" ]; then
  command -v infisical >/dev/null || die "TOWNSCAN_INFISICAL_PROJECT_ID が設定されていますが、infisical が見つかりません（Infisical CLI を入れて infisical login するか、この環境変数を外して .env で動かしてください）"
  case "$INFISICAL_PROJECT$INFISICAL_ENV" in
    *[!A-Za-z0-9_-]*) die "TOWNSCAN_INFISICAL_PROJECT_ID・TOWNSCAN_INFISICAL_ENV には、英数字・ハイフン・アンダースコアだけを使えます" ;;
  esac
fi

# 1. .env（秘密は乱数で作り、値は表示しない。既にあれば触らない）
# Postgres は POSTGRES_PASSWORD を「空のデータで初期化するとき」にしか読まない。DB のボリュームが残っているのに
# パスワードを作り直すと、DB と合わなくなり、api が永久に起動しない。だから、その組み合わせになる前に止める。
PGDATA_VOLUME="${COMPOSE_PROJECT_NAME:-townscan}_townscan-pgdata"
pgdata_hint() {
  cat >&2 <<EOF
注意: DB のボリューム（$PGDATA_VOLUME）が残っています。.env のパスワードを変えると、DB に接続できなくなります。
  次のどちらかにしてください。
  - 元の .env（元の POSTGRES_PASSWORD）を戻す
  - DB の中身を捨ててよいなら、docker compose down -v でボリュームごと消してから、もう一度このスクリプトを実行する
    （DB の中身も消えます。実データは data/townscan/run1/out から、このスクリプトが読み込み直します）
EOF
}
if [ ! -f .env ]; then
  if docker volume inspect "$PGDATA_VOLUME" >/dev/null 2>&1; then
    pgdata_hint
    die ".env がありませんが、DB のボリュームが既にあります。新しい乱数のパスワードでは接続できないため、.env を作らずに止めました"
  fi
  # 乱数が作れないまま .env を作ると、空のパスワードの .env が残る（次に流しても「パスワードが無い」で止まる）。作れてから書く
  pg_password="$(random_hex 24)" || die "openssl で乱数のパスワードを作れませんでした（openssl が使えるか確認してください。.env は作っていません）"
  ( umask 077; printf 'POSTGRES_PASSWORD=%s\n' "$pg_password" > .env )
  unset pg_password
  echo "== .env を作りました（乱数のパスワード。値は表示しません）"
else
  if ! grep -Eq '^POSTGRES_PASSWORD=[A-Za-z0-9]+$' .env; then
    if docker volume inspect "$PGDATA_VOLUME" >/dev/null 2>&1; then pgdata_hint; fi
    die ".env に POSTGRES_PASSWORD（英数字だけ）がありません。直してください（.env.example を参照）。消して作り直すのは、DB のボリュームが無いときだけです"
  fi
fi

# BETTER_AUTH_SECRET（ログイン（Better Auth）が JWT の署名鍵と Google のトークンを暗号化するのに使う）。無いときだけ、1 回だけ足す。
# 決めたら変えない: DB の auth_jwks に暗号化して入れた署名鍵が読めなくなり、全員がログアウトに見える（だから、あるときは触らない）。
# GOOGLE_CLIENT_ID・GOOGLE_CLIENT_SECRET は、あなたが自分で書く値。ここでは作らない・読まない・表示しない。
if [ -n "$INFISICAL_PROJECT" ]; then
  # Infisical が正（scripts/login-secrets.sh が 1 回だけ作る）。.env にも足すと、2 つの値が食い違い、Infisical を外した日に全員がログアウトに見える。
  # infisical run の値は、compose では .env より優先される。ここでは .env を読まない・足さない
  :
elif grep -Eq '^BETTER_AUTH_SECRET=[^[:space:]]' .env; then
  :
elif grep -Eq '^BETTER_AUTH_SECRET=' .env; then
  # 空の行があるまま足すと、同じ名前が 2 行になり、どちらが効くか決まらない。作り直さずに止める
  die ".env の BETTER_AUTH_SECRET が空です。その行を消してから、もう一度このスクリプトを実行してください（無ければ、このスクリプトが乱数で 1 回だけ作ります）"
else
  # 乱数は、.env に何かを書く前に作る（作れなかったときに、.env を 1 バイトも変えずに止めるため）
  auth_secret="$(random_hex 32)" || die "openssl で BETTER_AUTH_SECRET の乱数を作れませんでした（openssl が使えるか確認してください。.env は変えていません）"
  # 最後の行に改行が無いと、足した値が前の行（POSTGRES_PASSWORD）の続きになってしまう。先に改行を足す
  if [ -n "$(tail -c1 .env)" ]; then printf '\n' >> .env; fi
  ( umask 077; printf 'BETTER_AUTH_SECRET=%s\n' "$auth_secret" >> .env )
  unset auth_secret
  echo "== .env に BETTER_AUTH_SECRET を足しました（乱数。値は表示しません。決めたら変えないでください）"
fi

# api に読み取り専用でマウントする場所（無いと Docker が root 所有で作ってしまう）
mkdir -p data/townscan

# 2. web（frontend のビルド）
if [ "$NO_WEB" = 1 ]; then
  SERVICES=(db api)
else
  SERVICES=(db api web)
  [ -f frontend/package.json ] || die "frontend/ がまだありません。db と api だけなら --no-web で起動できます"
  if [ "$WEB_BUILD" = host ]; then
    command -v npx >/dev/null || die "npx が見つかりません（ホストに Node が要ります。WEB_BUILD=docker なら不要）"
    echo "== frontend をホストの Node 24 でビルドする（Docker VM の空きメモリーが少ないため。仕様 §2）"
    ( cd frontend && npx -y -p node@24 -- sh -c 'npm ci && npm run build' )
    [ -d frontend/.next/standalone ] || die "frontend/.next/standalone ができていません（next.config の output: \"standalone\" を確認）"
    export WEB_TARGET=prebuilt
  else
    export WEB_TARGET=runtime
  fi
fi

# 3. 起動（どちらの置き場で起動するかを、1 行で表示する）
if [ -n "$INFISICAL_PROJECT" ]; then
  echo "== 秘密の置き場: Infisical（プロジェクト ${INFISICAL_PROJECT}・環境 ${INFISICAL_ENV}）の値を infisical run で渡して起動する（.env には DB のパスワードだけ）"
  echo "== infisical run --projectId ${INFISICAL_PROJECT} --env ${INFISICAL_ENV} -- docker compose up -d --build ${SERVICES[*]}"
  infisical run --projectId "$INFISICAL_PROJECT" --env "$INFISICAL_ENV" -- docker compose up -d --build "${SERVICES[@]}" \
    || die "infisical run（または docker compose up）に失敗しました。infisical login 済みか、プロジェクト ID・環境・権限が合っているかを確かめてください（値は表示していません）"
else
  echo "== 秘密の置き場: .env（Infisical を使うときは、環境変数 TOWNSCAN_INFISICAL_PROJECT_ID にプロジェクト ID を入れて流す）"
  echo "== docker compose up -d --build ${SERVICES[*]}"
  docker compose up -d --build "${SERVICES[@]}"
fi

# 4. healthy を待つ
echo "== healthy を待つ（最大 5 分）"
deadline=$((SECONDS + 300))
for svc in "${SERVICES[@]}"; do
  while :; do
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "townscan-$svc" 2>/dev/null || echo missing)"
    case "$status" in
      healthy) echo "   $svc: healthy"; break ;;
      unhealthy)
        docker compose logs --tail 30 "$svc" >&2 || true
        if [ "$svc" = api ]; then
          echo "ヒント: ログに「設定の誤り」が出ているときは、既定の LLM（gemini）なのに GEMINI_API_KEY が空、などです（値は表示されません）。キーを登録してください（scripts/login-secrets.sh）。" >&2
        fi
        # パスワードの食い違い（パスワードを作り直した・変えた）は api のログには出ない。db のログで見分けて、直し方を出す
        db_log="$(docker compose logs --tail 50 db 2>&1 || true)"
        case "$db_log" in *"password authentication failed"*) pgdata_hint ;; esac
        die "$svc が unhealthy です（上のログを確認）" ;;
    esac
    [ "$SECONDS" -lt "$deadline" ] || { docker compose logs --tail 30 "$svc" >&2 || true; die "$svc が時間内に healthy になりませんでした（状態: $status）"; }
    sleep 2
  done
done

# 5. 実データがあれば読み込む（Python の loader で。api が Go でも、読み込みは Python の仕事。データは読み取り専用でマウント済み）
if [ -f data/townscan/run1/out/run.json ]; then
  echo "== 実データを読み込む（同じ run_id なら置き換え）"
  docker compose build loader
  docker compose run --rm -T loader python -m pipeline.load --run /data/townscan/run1/out
else
  echo "== 実データ（data/townscan/run1/out/run.json）がまだ無いので、読み込みは飛ばします。"
  echo "   pipeline の出力を置いたあとで: docker compose run --rm -T loader python -m pipeline.load --run /data/townscan/run1/out"
fi

# 6. 結果
echo
echo "== 状態"
curl -fsS http://127.0.0.1:8500/api/health || true
echo
echo "API  : http://127.0.0.1:8500/api/health  （Go。仕様のページは無い。契約は docs/spec-prototype.md §4.4 と contract/）"
if [ "$NO_WEB" = 0 ]; then
  echo "画面 : http://127.0.0.1:3500"
  # Cookie はホスト単位。ログインの往復（Google → /api/auth/callback/google）の state の Cookie は BETTER_AUTH_URL と同じホスト（localhost）に付くので、
  # 127.0.0.1 で開いたまま始めると、戻ってきたときに Cookie が無く失敗する。画面の行（127.0.0.1）は、ログイン以外の確認ではそのままでよい
  if [ -n "$INFISICAL_PROJECT" ]; then
    echo "ログイン（任意）: Infisical の値（Google のクライアント・BETTER_AUTH_SECRET・Gemini）で動かしています。未登録なら scripts/login-secrets.sh ${INFISICAL_PROJECT} ${INFISICAL_ENV} --from-json <JSON のパス> で登録し、infisical run --projectId ${INFISICAL_PROJECT} --env ${INFISICAL_ENV} -- docker compose up -d で作り直す（素の docker compose up -d だと値が空になる）。"
    echo "                未登録でも、ログイン以外の機能は使える。ログインを試すときは http://localhost:3500 で開く（127.0.0.1 では戻れません）。"
  else
    echo "ログイン（任意）: Google ログインを使うには、.env に GOOGLE_CLIENT_ID・GOOGLE_CLIENT_SECRET を書く（リダイレクト URI は http://localhost:3500/api/auth/callback/google）。書いたあとは docker compose up -d web。"
    echo "                書かなくても、ログイン以外の機能は使える。ログインを試すときは http://localhost:3500 で開く（127.0.0.1 では戻れません）。"
  fi
fi
echo "メモリー: docker stats --no-stream ${SERVICES[*]/#/townscan-}"
echo "止める: docker compose down（データは残る。DB ごと消すときは -v）"
