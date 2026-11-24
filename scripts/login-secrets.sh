#!/usr/bin/env bash
# TownScan の秘密（Google ログインの 3 つと、任意の Gemini キー）を、Infisical に登録する。ユーザーが自分の端末（ホストのターミナル。開発コンテナには Infisical CLI がまだ無い）で実行する（エージェントは実行しない・値を見ない）。
#
#   scripts/login-secrets.sh <Infisical のプロジェクト ID> [環境名。既定 dev] [--from-json <OAuth クライアントの JSON のパス>]
#
# 登録するもの（名前は compose.yaml と frontend/lib/auth.ts・backend/app/config.py が読むものと同じ）:
#   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET  Google Cloud Console で作った OAuth クライアント（種類: ウェブ）の値。
#                                            画面に出ない入力で受ける。または --from-json で、ダウンロードした JSON から取り出す（下）
#   BETTER_AUTH_SECRET                       その場で作る（openssl rand -base64 32。表示しない）。すでにあれば作り直さない
#   GEMINI_API_KEY（任意）                    Google AI Studio のキー。画面に出ない入力で受ける。空のままなら登録しない（すでにある値は、そのまま）
# 値は、権限 600 の一時ファイルだけに書き、Infisical へ `secrets set --file` で渡す（コマンドの引数・履歴・ログには残さない。終わったら消す）。
#
# --from-json: Google Cloud Console からダウンロードした JSON（{"web":{"client_id":…,"client_secret":…,…}} の形）から、
#   python3 -I のプロセスの中だけで値を取り出し、上の一時ファイルへ書く（標準出力・標準エラー・コマンドの引数には出さない）。
#   web の形でない・キーが無い・空・空白や改行を含むときは、何も登録せずに中止する。
#   登録に成功したときだけ、その JSON を削除する（削除したことだけを表示する）。失敗したときは残す。
#
# BETTER_AUTH_SECRET を作り直さない理由: Better Auth は、これで JWT の署名鍵（DB の auth_jwks）や Google のトークンを暗号化している。
# 変えると、保存済みの鍵が読めなくなり、全員がログアウトされる。変えるのは、理由と影響を確かめてから（手で行う）。
#
# 登録のあとの起動（compose は ${VAR:-} で環境変数を読むので、この形で起動する。素の `docker compose up -d` で作り直すと値が空になる）:
#   infisical run --projectId <プロジェクト ID> --env dev -- docker compose up -d
#   （scripts/dev-up.sh なら、環境変数 TOWNSCAN_INFISICAL_PROJECT_ID にプロジェクト ID を入れて流す）
set -euo pipefail

usage() {
  echo "使い方: $0 <Infisical のプロジェクト ID> [環境名。既定 dev] [--from-json <OAuth クライアントの JSON のパス>]" >&2
  exit 2
}

project=""
env_name=""
json=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --from-json)
      [[ $# -ge 2 && -n "$2" ]] || usage
      json="$2"
      shift 2
      ;;
    --from-json=*)
      json="${1#--from-json=}"
      [[ -n "$json" ]] || usage
      shift
      ;;
    -*) usage ;;
    *)
      if [[ -z "$project" ]]; then
        project="$1"
      elif [[ -z "$env_name" ]]; then
        env_name="$1"
      else
        usage
      fi
      shift
      ;;
  esac
done
env_name="${env_name:-dev}"
if [[ -z "$project" ]]; then
  usage
fi
command -v infisical >/dev/null || { echo "infisical コマンドが見つかりません（Infisical CLI を入れて、infisical login してください）。" >&2; exit 2; }
command -v openssl >/dev/null || { echo "openssl が見つかりません。" >&2; exit 2; }
if [[ -n "$json" ]]; then
  command -v python3 >/dev/null || { echo "python3 が見つかりません（--from-json に要ります）。" >&2; exit 2; }
fi

# 安全装置: 対話端末でなければ、何も実行しない（値を read -rs で受けるため。ログや自動実行に値を流さない）
if [[ ! ( -t 0 && -t 1 ) ]]; then
  echo "対話端末ではないので、何も実行しません（infisical は呼んでいません）。あなた自身の端末で実行してください。" >&2
  exit 3
fi

umask 077
tmp="$(mktemp)"
trap 'rm -f "$tmp" "$tmp.err"' EXIT

echo "登録先: Infisical プロジェクト ${project} / 環境 ${env_name} / パス /"

# JSON は、通常のファイルだけ受ける（シンボリックリンクは、削除の対象がずれるので使わない）
if [[ -n "$json" ]]; then
  if [[ -L "$json" || ! -f "$json" || ! -r "$json" ]]; then
    echo "--from-json のファイルが見つからない、読めない、または通常のファイルではありません: ${json}" >&2
    exit 1
  fi
fi

# すでに BETTER_AUTH_SECRET があれば作り直さない。`secrets get` は、存在しないキーでも終了コード 0 を返す
# （CLI 0.44.11。ホストが 2026-11-20 に実測）ので使わない。`export` の出力（値は変数に入るだけで表示しない）で、名前と値の有無を見る。
# 取得に失敗したら中止する（失敗を「無い」と読むと、すでにある BETTER_AUTH_SECRET を作り直してしまう）。
existing="$(infisical export --projectId "$project" --env "$env_name" --path / --format=dotenv 2>/dev/null)" \
  || { echo "既存の秘密を確認できませんでした（infisical login 済みか、プロジェクトの権限があるかを確かめてください）。中止しました。" >&2; exit 1; }
have_auth_secret=false
if grep -Eq '^BETTER_AUTH_SECRET=.+' <<<"$existing"; then
  have_auth_secret=true
fi
unset existing

if [[ -n "$json" ]]; then
  echo "入力: ${json} の web クライアントから取り出します（値は表示しません）。"
  # python3 -I（isolated: 環境変数・カレントディレクトリの python のコードを読まない）のプロセスの中だけで、値を取り出して一時ファイルへ書く。
  # 渡すのは、JSON のパスと一時ファイルのパスだけ。標準出力へは、文字数（数字 2 つ）だけを出す。エラーの文にも値は入れない。
  IFS= read -r -d '' py_extract <<'PY' || true
import json
import os
import sys


def fail(message):
    sys.stderr.write(message + "\n")
    sys.exit(1)


def main():
    path, out = sys.argv[1], sys.argv[2]
    try:
        with open(path, "rb") as f:
            raw = f.read(65537)
    except OSError:
        fail("JSON を読めませんでした。")
    if len(raw) > 65536:
        fail("JSON が大きすぎます（OAuth クライアントの JSON ではないようです）。")
    try:
        data = json.loads(raw.decode("utf-8"))
    except Exception:
        fail("JSON として読めませんでした。")
    if not isinstance(data, dict) or not isinstance(data.get("web"), dict):
        fail('web の形（{"web": {...}}）の JSON ではありません。種類が「ウェブ アプリケーション」の OAuth クライアントの JSON を使ってください。')
    web = data["web"]
    values = []
    for key in ("client_id", "client_secret"):
        value = web.get(key)
        if not isinstance(value, str) or not value:
            fail("JSON の web に %s が無い、または空です。" % key)
        if any(ch.isspace() or not ch.isprintable() for ch in value):
            fail("JSON の %s に、空白・改行・制御文字が入っています。" % key)
        values.append(value)
    if not values[0].endswith(".apps.googleusercontent.com"):
        sys.stderr.write("注意: Client ID が .apps.googleusercontent.com で終わっていません（別のファイルではないか確かめてください）。\n")
    fd = os.open(out, os.O_WRONLY | os.O_TRUNC)
    with os.fdopen(fd, "w") as f:
        f.write("GOOGLE_CLIENT_ID=%s\nGOOGLE_CLIENT_SECRET=%s\n" % (values[0], values[1]))
    sys.stdout.write("%d %d\n" % (len(values[0]), len(values[1])))


try:
    main()
except SystemExit:
    raise
except BaseException:
    sys.stderr.write("予期しないエラーで、値を取り出せませんでした。\n")
    sys.exit(1)
PY
  lens="$(python3 -I -c "$py_extract" "$json" "$tmp")" \
    || { echo "JSON から値を取り出せなかったため、中止しました（JSON は残しています）。" >&2; exit 1; }
  unset py_extract
  read -r id_length secret_length <<<"$lens"
  unset lens
  if [[ ! ( "$id_length" =~ ^[0-9]+$ && "$secret_length" =~ ^[0-9]+$ ) ]]; then
    echo "JSON から取り出した結果を確認できませんでした。中止しました（JSON は残しています）。" >&2
    exit 1
  fi
else
  read -r -s -p "GOOGLE_CLIENT_ID（入力は表示されません）: " gid
  echo
  read -r -s -p "GOOGLE_CLIENT_SECRET（入力は表示されません）: " gsec
  echo
  if [[ -z "$gid" || -z "$gsec" ]]; then
    echo "Client ID と Client Secret の両方が要ります。中止しました。" >&2
    exit 1
  fi
  case "$gid$gsec" in *[[:space:]]*) echo "値に空白・改行は入れられません。中止しました。" >&2; exit 1 ;; esac
  case "$gid" in *.apps.googleusercontent.com) ;; *) echo "注意: Client ID が .apps.googleusercontent.com で終わっていません（貼り間違いではないか確かめてください）。" >&2 ;; esac
  {
    printf 'GOOGLE_CLIENT_ID=%s\n' "$gid"
    printf 'GOOGLE_CLIENT_SECRET=%s\n' "$gsec"
  } >"$tmp"
  id_length=${#gid}
  secret_length=${#gsec}
  unset gid gsec
fi

# GEMINI_API_KEY は任意。空のままなら登録しない（すでに登録した値があれば、そのまま残る）
read -r -s -p "GEMINI_API_KEY（任意。空のままなら登録しません。入力は表示されません）: " gem
echo
case "$gem" in *[[:space:]]*) echo "値に空白・改行は入れられません。中止しました。" >&2; exit 1 ;; esac
gem_length=""
if [[ -n "$gem" ]]; then
  gem_length=${#gem}
fi

# 乱数は、一時ファイルに何かを足す前に作る。printf の引数の中の $(openssl ...) が失敗しても set -e は拾わず、空の値の行が登録されてしまう
auth_secret=""
if [[ "$have_auth_secret" == false ]]; then
  auth_secret="$(openssl rand -base64 32)" && [[ -n "$auth_secret" ]] \
    || { echo "openssl で BETTER_AUTH_SECRET の乱数を作れませんでした。中止しました（何も登録していません）。" >&2; exit 1; }
fi
{
  if [[ -n "$auth_secret" ]]; then
    printf 'BETTER_AUTH_SECRET=%s\n' "$auth_secret"
  fi
  if [[ -n "$gem" ]]; then
    printf 'GEMINI_API_KEY=%s\n' "$gem"
  fi
} >>"$tmp"
unset gem auth_secret

infisical secrets set --file "$tmp" --projectId "$project" --env "$env_name" --path / --silent >/dev/null 2>"$tmp.err" \
  || { echo "登録に失敗しました（infisical login 済みか、プロジェクトの権限があるかを確かめてください）。" >&2; exit 1; }

# 登録できたことを、キー名と値の有無だけで確かめる（値は表示しない）
exported="$(infisical export --projectId "$project" --env "$env_name" --path / --format=dotenv 2>/dev/null || true)"
required=(GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET BETTER_AUTH_SECRET)
if [[ -n "$gem_length" ]]; then
  required+=(GEMINI_API_KEY)
fi
missing=()
for key in "${required[@]}"; do
  grep -Eq "^${key}=.+" <<<"$exported" || missing+=("$key")
done
if (( ${#missing[@]} > 0 )); then
  echo "登録したあとの確認で、次のキーが見つかりません: ${missing[*]}（Infisical の画面で確かめてください）。" >&2
  exit 1
fi

echo "登録しました: GOOGLE_CLIENT_ID（${id_length} 文字）、GOOGLE_CLIENT_SECRET（${secret_length} 文字）、BETTER_AUTH_SECRET（$([[ "$have_auth_secret" == true ]] && echo '既存のまま' || echo '新しく作成')）、GEMINI_API_KEY（$([[ -n "$gem_length" ]] && echo "${gem_length} 文字" || echo '登録せず')）。値は表示していません。"

# --from-json は、登録に成功したときだけ消す（ここまで来たのは、登録と確認が済んだとき。失敗した経路は、上のどれも、ここへ来る前に exit する）
if [[ -n "$json" ]]; then
  if rm -f -- "$json" && [[ ! -e "$json" ]]; then
    echo "JSON を削除しました: ${json}"
  else
    echo "登録はできましたが、JSON を削除できませんでした。秘密が残っているので、自分で削除してください: ${json}" >&2
    exit 1
  fi
fi

echo "起動: infisical run --projectId ${project} --env ${env_name} -- docker compose up -d"
if [[ "$env_name" == dev ]]; then
  echo "または: TOWNSCAN_INFISICAL_PROJECT_ID=${project} scripts/dev-up.sh"
else
  echo "または: TOWNSCAN_INFISICAL_PROJECT_ID=${project} TOWNSCAN_INFISICAL_ENV=${env_name} scripts/dev-up.sh"
fi
