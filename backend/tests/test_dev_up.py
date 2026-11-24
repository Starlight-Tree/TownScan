"""scripts/dev-up.sh の .env とボリュームの扱い。本物の docker は使わず、偽の docker・openssl・curl を PATH に置いて流す。

守りたいこと: Postgres は POSTGRES_PASSWORD を「空のデータで初期化するとき」にしか読まない。DB のボリュームが残っているのに
.env を作り直すと、新しい乱数のパスワードが DB と合わず、api が永久に起動しない。だから、そうなる前に止めて案内する。
スクリプトの場所は、環境変数 DEV_UP_SCRIPT（scripts/test-backend.sh が渡す）か、リポジトリの scripts/dev-up.sh。

もう 1 つ守りたいこと（ログイン）: .env の BETTER_AUTH_SECRET は、無いときだけ 1 回足し、あるときは変えない（変えると、DB の署名鍵が読めなくなり
全員がログアウトに見える）。値は表示しない。GOOGLE_CLIENT_ID・GOOGLE_CLIENT_SECRET は、利用者が自分で書く値なので、作らない・読まない・表示しない。
"""

from __future__ import annotations

import os
import re
import shutil
import stat
import subprocess
from pathlib import Path

import pytest

REPO_SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "dev-up.sh"
SCRIPT = Path(os.environ.get("DEV_UP_SCRIPT", REPO_SCRIPT))

FAKE_PASSWORD = "0123456789abcdef0123456789abcdef0123456789abcdef"
# BETTER_AUTH_SECRET 用（openssl rand -hex 32 の見立て。64 文字）。distinct_openssl() の偽の openssl だけが返す
FAKE_AUTH_SECRET = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"
GUIDANCE_URI = "http://localhost:3500/api/auth/callback/google"

FAKE_DOCKER = r"""#!/usr/bin/env bash
echo "docker $*" >> "$FAKE_LOG"
case "$1" in
  info) exit 0 ;;
  volume)
    if [ "$2" = inspect ]; then
      for v in $FAKE_VOLUMES; do [ "$v" = "$3" ] && exit 0; done
      exit 1
    fi ;;
  inspect)
    name="${@: -1}"; var="FAKE_HEALTH_${name#townscan-}"; echo "${!var:-healthy}"; exit 0 ;;
  compose)
    if [ "$2" = logs ]; then
      svc="${@: -1}"; var="FAKE_LOG_${svc}"; echo "${!var:-}"; exit 0
    fi ;;
esac
exit 0
"""

# 呼ばれた引数を FAKE_LOG に残し、-hex 32（BETTER_AUTH_SECRET）と、それ以外（POSTGRES_PASSWORD）で別の値を返す
FAKE_OPENSSL_DISTINCT = f"""#!/usr/bin/env bash
echo "openssl $*" >> "$FAKE_LOG"
case "$*" in
  *"-hex 32"*) echo {FAKE_AUTH_SECRET} ;;
  *) echo {FAKE_PASSWORD} ;;
esac
"""

# openssl が失敗する偽物（終了コード 1）と、成功の終了コードで何も出さない偽物（出力が空）。どちらも「乱数が作れなかった」場合
FAKE_OPENSSL_FAILS = """#!/usr/bin/env bash
echo "openssl $*" >> "$FAKE_LOG"
echo "openssl: 偽の失敗" >&2
exit 1
"""
FAKE_OPENSSL_EMPTY = """#!/usr/bin/env bash
echo "openssl $*" >> "$FAKE_LOG"
exit 0
"""

pytestmark = pytest.mark.skipif(not SCRIPT.is_file(), reason="scripts/dev-up.sh が見つかりません（DEV_UP_SCRIPT で指定できます）")


class Sandbox:
    def __init__(self, root: Path):
        self.root = root
        self.bin = root / "bin"
        self.bin.mkdir()
        (root / "scripts").mkdir()
        shutil.copy(SCRIPT, root / "scripts" / "dev-up.sh")
        self.log = root / "docker.log"
        self.log.write_text("")
        self._fake("docker", FAKE_DOCKER)
        self._fake("openssl", f"#!/usr/bin/env bash\necho {FAKE_PASSWORD}\n")
        self._fake("curl", "#!/usr/bin/env bash\necho '{}'\n")

    def _fake(self, name: str, body: str) -> None:
        p = self.bin / name
        p.write_text(body)
        p.chmod(p.stat().st_mode | stat.S_IXUSR)

    @property
    def env_file(self) -> Path:
        return self.root / ".env"

    def distinct_openssl(self) -> None:
        """POSTGRES_PASSWORD と BETTER_AUTH_SECRET で別の値を返す偽の openssl に替える（呼び出しは openssl_calls() で見る）。"""
        self._fake("openssl", FAKE_OPENSSL_DISTINCT)

    def broken_openssl(self, body: str) -> None:
        """乱数を作れない偽の openssl に替える（FAKE_OPENSSL_FAILS・FAKE_OPENSSL_EMPTY）。"""
        self._fake("openssl", body)

    def openssl_calls(self) -> list[str]:
        return [c for c in self.docker_calls() if c.startswith("openssl ")]

    def run(self, *args: str, volumes: str = "", no_web: bool = True, **extra_env: str) -> subprocess.CompletedProcess:
        env = {
            "PATH": f"{self.bin}:{os.environ.get('PATH', '/usr/bin:/bin')}",
            "HOME": str(self.root),
            "FAKE_LOG": str(self.log),
            "FAKE_VOLUMES": volumes,
            **extra_env,
        }
        return subprocess.run(
            ["bash", str(self.root / "scripts" / "dev-up.sh"), *(["--no-web"] if no_web else []), *args],
            cwd=self.root, env=env, capture_output=True, text=True, timeout=60,
        )

    def docker_calls(self) -> list[str]:
        return self.log.read_text().splitlines()


@pytest.fixture
def box(tmp_path) -> Sandbox:
    return Sandbox(tmp_path)


def test_first_run_creates_env_with_a_random_password_and_starts(box):
    r = box.run()
    assert r.returncode == 0, r.stderr
    # 新しい挙動: パスワードのほかに、ログインの BETTER_AUTH_SECRET（乱数）が 1 行だけ入る（GOOGLE_* は作らない）
    assert re.fullmatch(r"POSTGRES_PASSWORD=[0-9a-f]+\nBETTER_AUTH_SECRET=[0-9a-f]+\n", box.env_file.read_text())
    assert stat.S_IMODE(box.env_file.stat().st_mode) == 0o600
    assert FAKE_PASSWORD not in r.stdout + r.stderr  # 値は表示しない
    assert "docker compose up -d --build db api" in box.docker_calls()


def test_existing_env_is_left_alone_even_with_a_volume(box):
    box.env_file.write_text("POSTGRES_PASSWORD=abc123\n")
    r = box.run(volumes="townscan_townscan-pgdata")
    assert r.returncode == 0, r.stderr
    # パスワードの行は触らない。足されるのは、無かった BETTER_AUTH_SECRET だけ（後ろに 1 行。完全一致で確かめる）
    assert box.env_file.read_text() == f"POSTGRES_PASSWORD=abc123\nBETTER_AUTH_SECRET={FAKE_PASSWORD}\n"


def test_missing_env_with_a_leftover_db_volume_stops_before_creating_a_new_password(box):
    r = box.run(volumes="townscan_townscan-pgdata")
    assert r.returncode != 0
    assert not box.env_file.exists()  # 新しいパスワードを作らない
    assert not any(c.startswith("docker compose up") for c in box.docker_calls())  # 起動もしない
    for needle in ("townscan_townscan-pgdata", "docker compose down -v", "元の .env", "中身も消え"):
        assert needle in r.stderr, needle
    assert FAKE_PASSWORD not in r.stdout + r.stderr


def test_the_volume_name_follows_compose_project_name(box):
    r = box.run(volumes="review-bk_townscan-pgdata", COMPOSE_PROJECT_NAME="review-bk")
    assert r.returncode != 0 and not box.env_file.exists()
    assert "review-bk_townscan-pgdata" in r.stderr
    # 別のプロジェクトのボリュームは関係ない
    r2 = box.run(volumes="other_townscan-pgdata")
    assert r2.returncode == 0 and box.env_file.exists()


def test_broken_env_message_warns_about_the_volume(box):
    box.env_file.write_text("SOMETHING=else\n")
    r = box.run(volumes="townscan_townscan-pgdata")
    assert r.returncode != 0
    assert "POSTGRES_PASSWORD" in r.stderr and "docker compose down -v" in r.stderr
    assert box.env_file.read_text() == "SOMETHING=else\n"  # 勝手に直さない


def test_unhealthy_api_with_a_password_mismatch_explains_the_cause(box):
    box.env_file.write_text("POSTGRES_PASSWORD=newpassword\n")
    r = box.run(FAKE_HEALTH_api="unhealthy",
                FAKE_LOG_db='FATAL:  password authentication failed for user "townscan"')
    assert r.returncode != 0 and "api が unhealthy です" in r.stderr
    assert "パスワード" in r.stderr and "docker compose down -v" in r.stderr and "元の .env" in r.stderr


def test_unhealthy_api_for_another_reason_has_no_password_hint(box):
    box.env_file.write_text("POSTGRES_PASSWORD=newpassword\n")
    r = box.run(FAKE_HEALTH_api="unhealthy", FAKE_LOG_db="LOG:  database system is ready to accept connections")
    assert r.returncode != 0 and "api が unhealthy です" in r.stderr
    assert "docker compose down -v" not in r.stderr


# ---- ログイン（Better Auth）の BETTER_AUTH_SECRET と、Google の案内 ----

AUTH_SECRET_LINE_RE = re.compile(r"^BETTER_AUTH_SECRET=", re.MULTILINE)
GOOGLE_ID_MARKER = "gid-marker-for-test-0001"
GOOGLE_SECRET_MARKER = "gsec-marker-for-test-0002"


def _outputs(box: Sandbox, r: subprocess.CompletedProcess) -> str:
    """スクリプトの出力と、偽の docker に渡った引数の全部（どこにも秘密が出ていないことを確かめる範囲）。"""
    return r.stdout + r.stderr + box.log.read_text()


def test_first_run_adds_a_random_better_auth_secret_once_and_never_shows_it(box):
    box.distinct_openssl()
    r = box.run()
    assert r.returncode == 0, r.stderr
    assert box.env_file.read_text() == f"POSTGRES_PASSWORD={FAKE_PASSWORD}\nBETTER_AUTH_SECRET={FAKE_AUTH_SECRET}\n"
    assert stat.S_IMODE(box.env_file.stat().st_mode) == 0o600
    assert "BETTER_AUTH_SECRET を足しました" in r.stdout
    # 32 バイトの乱数（16 進で 64 文字。Better Auth が勧める 32 文字以上）を 1 回だけ頼んでいる
    assert box.openssl_calls().count("openssl rand -hex 32") == 1
    for secret in (FAKE_PASSWORD, FAKE_AUTH_SECRET):
        assert secret not in _outputs(box, r)  # 値は、標準出力・標準エラー・docker への引数のどこにも出さない
    # 利用者が自分で書く値は、作らない
    assert "GOOGLE_" not in box.env_file.read_text()

    # 2 回目は何もしない（作り直さない・言わない・乱数も頼まない）
    before = box.env_file.read_text()
    r2 = box.run()
    assert r2.returncode == 0, r2.stderr
    assert box.env_file.read_text() == before
    assert "BETTER_AUTH_SECRET を足しました" not in r2.stdout
    assert box.openssl_calls().count("openssl rand -hex 32") == 1
    assert len(AUTH_SECRET_LINE_RE.findall(box.env_file.read_text())) == 1


def test_an_existing_env_without_the_secret_gets_only_that_line_appended(box):
    # 以前の dev-up.sh が作った .env（パスワードだけ）と、利用者が書いた Google の値
    original = f"POSTGRES_PASSWORD=abc123\nGOOGLE_CLIENT_ID={GOOGLE_ID_MARKER}\nGOOGLE_CLIENT_SECRET={GOOGLE_SECRET_MARKER}\n"
    box.env_file.write_text(original)
    box.env_file.chmod(0o600)
    box.distinct_openssl()
    r = box.run(volumes="townscan_townscan-pgdata")
    assert r.returncode == 0, r.stderr
    # 元の行は 1 文字も変えず、順番もそのまま。足すのは BETTER_AUTH_SECRET の 1 行だけ
    assert box.env_file.read_text() == original + f"BETTER_AUTH_SECRET={FAKE_AUTH_SECRET}\n"
    assert stat.S_IMODE(box.env_file.stat().st_mode) == 0o600
    out = _outputs(box, r)
    for secret in (FAKE_AUTH_SECRET, GOOGLE_ID_MARKER, GOOGLE_SECRET_MARKER):
        assert secret not in out  # Google の値は、読んだ・表示した形跡が出ない
    assert "docker compose up -d --build db api" in box.docker_calls()


def test_the_secret_is_not_glued_to_a_last_line_without_a_newline(box):
    box.env_file.write_text("POSTGRES_PASSWORD=abc123")  # 改行なしで終わる
    box.distinct_openssl()
    r = box.run()
    assert r.returncode == 0, r.stderr
    assert box.env_file.read_text() == f"POSTGRES_PASSWORD=abc123\nBETTER_AUTH_SECRET={FAKE_AUTH_SECRET}\n"


def test_an_existing_better_auth_secret_is_never_changed(box):
    kept = "keepme0123456789abcdef0123456789abcdef"
    original = f"BETTER_AUTH_SECRET={kept}\nPOSTGRES_PASSWORD=abc123\nGOOGLE_CLIENT_ID={GOOGLE_ID_MARKER}\n"
    box.env_file.write_text(original)
    box.distinct_openssl()
    for _ in range(2):
        r = box.run(volumes="townscan_townscan-pgdata")
        assert r.returncode == 0, r.stderr
        assert box.env_file.read_text() == original  # 全体が同じ（鍵は変わらない。行も増えない）
        assert "BETTER_AUTH_SECRET を足しました" not in r.stdout
        for secret in (kept, FAKE_AUTH_SECRET, GOOGLE_ID_MARKER):
            assert secret not in _outputs(box, r)
    assert box.openssl_calls() == []  # 乱数を頼みもしない


def test_an_empty_better_auth_secret_line_stops_instead_of_adding_a_second_one(box):
    original = "POSTGRES_PASSWORD=abc123\nBETTER_AUTH_SECRET=\n"
    box.env_file.write_text(original)
    box.distinct_openssl()
    r = box.run()
    assert r.returncode != 0
    assert "BETTER_AUTH_SECRET" in r.stderr and "空" in r.stderr
    assert box.env_file.read_text() == original  # 勝手に直さない・足さない
    assert not any(c.startswith("docker compose up") for c in box.docker_calls())
    assert box.openssl_calls() == []


def test_a_broken_env_gets_no_secret_either(box):
    # パスワードの行が無い .env は、これまでどおり直さずに止まる（BETTER_AUTH_SECRET も足さない）
    box.env_file.write_text("GOOGLE_CLIENT_ID=" + GOOGLE_ID_MARKER + "\n")
    box.distinct_openssl()
    r = box.run()
    assert r.returncode != 0
    assert box.env_file.read_text() == "GOOGLE_CLIENT_ID=" + GOOGLE_ID_MARKER + "\n"
    assert GOOGLE_ID_MARKER not in r.stdout + r.stderr
    assert box.openssl_calls() == []


@pytest.mark.parametrize("openssl_body", [FAKE_OPENSSL_FAILS, FAKE_OPENSSL_EMPTY], ids=["exit-1", "empty-output"])
def test_openssl_failure_on_the_first_run_does_not_write_an_empty_password(box, openssl_body):
    # コマンド置換の失敗は set -e に拾われず、以前は POSTGRES_PASSWORD= の空の行が書かれて、成功と表示された
    box.broken_openssl(openssl_body)
    r = box.run()
    assert r.returncode != 0
    assert not box.env_file.exists()  # 空のパスワードの .env を作らない（次に流しても、直し方の分からない失敗になるため）
    assert "openssl" in r.stderr and "乱数" in r.stderr
    assert "== .env を作りました" not in r.stdout
    assert not any(c.startswith("docker compose up") for c in box.docker_calls())  # 起動もしない


@pytest.mark.parametrize("openssl_body", [FAKE_OPENSSL_FAILS, FAKE_OPENSSL_EMPTY], ids=["exit-1", "empty-output"])
def test_openssl_failure_leaves_an_existing_env_untouched_and_stops(box, openssl_body):
    # 改行なしで終わる .env でも、乱数が作れなかったときは、改行も空の BETTER_AUTH_SECRET の行も足さない（1 バイトも変えない）
    original = f"POSTGRES_PASSWORD=abc123\nGOOGLE_CLIENT_ID={GOOGLE_ID_MARKER}"
    box.env_file.write_text(original)
    box.broken_openssl(openssl_body)
    r = box.run()
    assert r.returncode != 0
    assert box.env_file.read_text() == original
    assert "BETTER_AUTH_SECRET" in r.stderr and "乱数" in r.stderr
    assert "BETTER_AUTH_SECRET を足しました" not in r.stdout
    assert GOOGLE_ID_MARKER not in r.stdout + r.stderr
    assert not any(c.startswith("docker compose up") for c in box.docker_calls())


def _run_with_web(box: Sandbox, **extra_env: str) -> subprocess.CompletedProcess:
    """web も起動する経路（--no-web なし）。ホストの Node でのビルドは飛ばす（WEB_BUILD=docker。イメージの中でビルドする指定）。"""
    (box.root / "frontend").mkdir(exist_ok=True)
    (box.root / "frontend" / "package.json").write_text("{}\n")
    return box.run(no_web=False, WEB_BUILD="docker", **extra_env)


def test_the_end_message_explains_google_login_in_two_lines_and_prints_no_google_values(box):
    box.env_file.write_text(
        f"POSTGRES_PASSWORD=abc123\nGOOGLE_CLIENT_ID={GOOGLE_ID_MARKER}\nGOOGLE_CLIENT_SECRET={GOOGLE_SECRET_MARKER}\n"
    )
    box.distinct_openssl()
    r = _run_with_web(box)
    assert r.returncode == 0, r.stderr
    assert "docker compose up -d --build db api web" in box.docker_calls()
    lines = r.stdout.splitlines()
    start = next(i for i, line in enumerate(lines) if line.startswith("ログイン（任意）"))
    guide = lines[start : start + 2]
    text = "\n".join(guide)
    for needle in ("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", ".env", GUIDANCE_URI, "ログイン以外の機能は使える"):
        assert needle in text, needle
    # ログインが動くのは BETTER_AUTH_URL と同じホスト（localhost）だけ。127.0.0.1 では、戻ったときに state の Cookie が無く失敗する
    assert "ログインを試すときは http://localhost:3500 で開く（127.0.0.1 では戻れません）" in text
    # 画面の行は 127.0.0.1 のまま（ログイン以外の確認はそこで足りる。案内は上の 2 行に足した）
    assert "画面 : http://127.0.0.1:3500" in lines
    assert lines[start + 2].startswith("メモリー")  # 案内は 2 行だけ
    assert r.stdout.count("GOOGLE_CLIENT_ID") == 1
    for secret in (GOOGLE_ID_MARKER, GOOGLE_SECRET_MARKER, FAKE_AUTH_SECRET):
        assert secret not in _outputs(box, r)


def test_no_web_run_does_not_show_the_login_guidance(box):
    r = box.run()
    assert r.returncode == 0, r.stderr
    assert "GOOGLE_CLIENT_ID" not in r.stdout and GUIDANCE_URI not in r.stdout


# ---- 秘密の置き場: Infisical（環境変数 TOWNSCAN_INFISICAL_PROJECT_ID があるときだけ。ADR 0004）----
# 偽の infisical は、呼ばれた引数を FAKE_LOG に残し、`--` のあとのコマンド（偽の docker compose）をそのまま実行する。
# 本物の infisical は呼ばない（偽を PATH の先頭に置く。CLI が無い場合の試験は、PATH を絞る）。

FAKE_INFISICAL = r"""#!/usr/bin/env bash
echo "infisical $*" >> "$FAKE_LOG"
if [ "${FAKE_INFISICAL_FAIL:-}" = 1 ]; then echo "infisical: 偽の失敗" >&2; exit 1; fi
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
shift
exec "$@"
"""
INFISICAL_PROJECT = "proj-123abc"
RUN_LINE = f"infisical run --projectId {INFISICAL_PROJECT} --env dev -- docker compose up -d --build"


@pytest.fixture
def ibox(box) -> Sandbox:
    box._fake("infisical", FAKE_INFISICAL)
    return box


def test_without_the_project_id_variable_it_starts_from_env_as_before_and_says_so(box):
    r = box.run()
    assert r.returncode == 0, r.stderr
    assert [line for line in r.stdout.splitlines() if line.startswith("== 秘密の置き場")] == [
        "== 秘密の置き場: .env（Infisical を使うときは、環境変数 TOWNSCAN_INFISICAL_PROJECT_ID にプロジェクト ID を入れて流す）"
    ]
    assert "docker compose up -d --build db api" in box.docker_calls()
    assert not any(c.startswith("infisical") for c in box.docker_calls())


def test_with_the_project_id_it_starts_through_infisical_run_and_leaves_the_auth_secret_out_of_env(ibox):
    ibox.distinct_openssl()
    r = ibox.run(TOWNSCAN_INFISICAL_PROJECT_ID=INFISICAL_PROJECT)
    assert r.returncode == 0, r.stderr
    calls = ibox.docker_calls()
    # compose は infisical run の中で、1 回だけ起動する（素の docker compose up は無い）
    i = calls.index(f"{RUN_LINE} db api")
    assert calls[i + 1] == "docker compose up -d --build db api"
    assert calls.count("docker compose up -d --build db api") == 1
    # どちらで起動したかの 1 行
    assert [line for line in r.stdout.splitlines() if line.startswith("== 秘密の置き場")] == [
        f"== 秘密の置き場: Infisical（プロジェクト {INFISICAL_PROJECT}・環境 dev）の値を infisical run で渡して起動する（.env には DB のパスワードだけ）"
    ]
    # .env には DB のパスワードだけ（BETTER_AUTH_SECRET は Infisical が正。乱数も頼まない）
    assert ibox.env_file.read_text() == f"POSTGRES_PASSWORD={FAKE_PASSWORD}\n"
    assert "openssl rand -hex 32" not in ibox.openssl_calls()
    assert FAKE_PASSWORD not in _outputs(ibox, r)


def test_infisical_mode_leaves_an_existing_env_alone_even_without_or_with_an_empty_auth_secret(ibox):
    for original in (
        f"POSTGRES_PASSWORD=abc123\nGOOGLE_CLIENT_ID={GOOGLE_ID_MARKER}\n",  # BETTER_AUTH_SECRET が無い（足さない）
        "POSTGRES_PASSWORD=abc123\nBETTER_AUTH_SECRET=\n",  # 空の行（従来は止まる。Infisical のときは .env の値を使わないので、止めない・直さない）
    ):
        ibox.env_file.write_text(original)
        ibox.distinct_openssl()
        r = ibox.run(volumes="townscan_townscan-pgdata", TOWNSCAN_INFISICAL_PROJECT_ID=INFISICAL_PROJECT)
        assert r.returncode == 0, r.stderr
        assert ibox.env_file.read_text() == original
        assert ibox.openssl_calls() == []
        assert GOOGLE_ID_MARKER not in _outputs(ibox, r)


def test_infisical_mode_still_checks_the_db_password_in_env(ibox):
    ibox.env_file.write_text("SOMETHING=else\n")
    r = ibox.run(volumes="townscan_townscan-pgdata", TOWNSCAN_INFISICAL_PROJECT_ID=INFISICAL_PROJECT)
    assert r.returncode != 0 and "POSTGRES_PASSWORD" in r.stderr
    assert ibox.env_file.read_text() == "SOMETHING=else\n"
    assert not any(c.startswith(("infisical", "docker compose up")) for c in ibox.docker_calls())


def test_the_infisical_environment_can_be_chosen(ibox):
    r = ibox.run(TOWNSCAN_INFISICAL_PROJECT_ID=INFISICAL_PROJECT, TOWNSCAN_INFISICAL_ENV="staging")
    assert r.returncode == 0, r.stderr
    assert f"infisical run --projectId {INFISICAL_PROJECT} --env staging -- docker compose up -d --build db api" in ibox.docker_calls()


@pytest.mark.parametrize("project,env", [("proj 123", "dev"), ("a;b", "dev"), ("$(x)", "dev"), (INFISICAL_PROJECT, "de v"), (INFISICAL_PROJECT, "--x\n")],
                         ids=["space", "semicolon", "substitution", "env-space", "env-newline"])
def test_odd_characters_in_the_project_id_or_environment_stop_before_anything_runs(ibox, project, env):
    r = ibox.run(TOWNSCAN_INFISICAL_PROJECT_ID=project, TOWNSCAN_INFISICAL_ENV=env)
    assert r.returncode != 0 and "英数字" in r.stderr
    assert not ibox.env_file.exists()
    assert not any(c.startswith(("infisical", "docker compose up")) for c in ibox.docker_calls())


def test_a_project_id_without_the_cli_stops_instead_of_falling_back_to_env(box, tmp_path):
    # PATH を、偽の docker・openssl・curl と、最低限の道具だけにする（ホストの本物の infisical に届かないように）
    tools = tmp_path / "tools"
    tools.mkdir()
    for name in ("bash", "dirname", "grep", "tail", "mkdir", "cat", "sed", "sleep"):
        real = shutil.which(name)
        assert real, name
        (tools / name).symlink_to(real)
    r = box.run(TOWNSCAN_INFISICAL_PROJECT_ID=INFISICAL_PROJECT, PATH=f"{box.bin}:{tools}")
    assert r.returncode != 0
    assert "infisical が見つかりません" in r.stderr and "TOWNSCAN_INFISICAL_PROJECT_ID" in r.stderr
    assert not box.env_file.exists()  # .env を作る前に止める
    assert not any(c.startswith("docker compose up") for c in box.docker_calls())  # .env に黙って切り替えて起動しない


def test_a_failing_infisical_run_stops_with_a_message(ibox):
    r = ibox.run(TOWNSCAN_INFISICAL_PROJECT_ID=INFISICAL_PROJECT, FAKE_INFISICAL_FAIL="1")
    assert r.returncode != 0
    assert "infisical run" in r.stderr and "infisical login" in r.stderr
    assert "docker compose up -d --build db api" not in ibox.docker_calls()  # 起動していない
    assert "healthy を待つ" not in r.stdout


def test_the_end_message_in_infisical_mode_points_to_the_registration_script(ibox):
    ibox.env_file.write_text("POSTGRES_PASSWORD=abc123\n")
    r = _run_with_web(ibox, TOWNSCAN_INFISICAL_PROJECT_ID=INFISICAL_PROJECT)
    assert r.returncode == 0, r.stderr
    assert f"{RUN_LINE} db api web" in ibox.docker_calls()
    lines = r.stdout.splitlines()
    start = next(i for i, line in enumerate(lines) if line.startswith("ログイン（任意）"))
    text = "\n".join(lines[start : start + 2])
    for needle in (
        "Infisical の値", f"scripts/login-secrets.sh {INFISICAL_PROJECT} dev --from-json",
        f"infisical run --projectId {INFISICAL_PROJECT} --env dev -- docker compose up -d で作り直す",
        "素の docker compose up -d だと値が空になる", "ログイン以外の機能は使える",
        "ログインを試すときは http://localhost:3500 で開く（127.0.0.1 では戻れません）",
    ):
        assert needle in text, needle
    assert lines[start + 2].startswith("メモリー")  # 案内は 2 行だけ
    # Infisical が正なので、.env に書くよう案内しない
    assert "GOOGLE_CLIENT_ID" not in r.stdout and "GOOGLE_CLIENT_SECRET" not in r.stdout
