"""scripts/login-secrets.sh（秘密を Infisical に登録する、ユーザーが自分の端末で流すスクリプト）。

本物の infisical は呼ばない。偽の infisical・openssl・python3（呼び出しを記録するだけ）を PATH の先頭に置き、PATH はその 2 つのディレクトリだけにする
（ホストの本物の infisical に届かないようにするため）。値はどれも偽物（FAKE_*）。
このスクリプトは「対話端末でなければ何もしない」ので、対話の経路は疑似端末（pty）で流す。値の入力は read -s（画面に出ない）なので、
疑似端末の出力に偽の値が出ていないこと自体が、値を画面に出していない確認になる。
守りたいこと:
 - 値は、標準出力・標準エラー（疑似端末の出力）・偽の infisical に渡った引数・python3 に渡った引数の、どこにも出ない。infisical に渡るのは一時ファイルのパスだけ。
 - 一時ファイルは権限 600 で、終わったら（成功しても失敗しても）残らない。
 - --from-json: 登録に成功したときだけ JSON を消す。失敗したら残す。web の形でない・キーが無い・空・空白を含むときは、何も登録せず中止する。
スクリプトの場所は、環境変数 LOGIN_SECRETS_SCRIPT か、リポジトリの scripts/login-secrets.sh。
"""

from __future__ import annotations

import json
import os
import pty
import re
import select
import shutil
import signal
import stat
import subprocess
import sys
import time
from pathlib import Path

import pytest

REPO_SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "login-secrets.sh"
SCRIPT = Path(os.environ.get("LOGIN_SECRETS_SCRIPT", REPO_SCRIPT))
BASH = shutil.which("bash")

pytestmark = pytest.mark.skipif(
    not SCRIPT.is_file() or BASH is None,
    reason="scripts/login-secrets.sh か bash が見つかりません（LOGIN_SECRETS_SCRIPT で指定できます）",
)

PROJECT = "proj123"
# どれも偽の値。出力・記録のどこかに出たら失敗にする（FAKE_AUTH は偽の openssl が返す）
FAKE_ID = "fake-client-id-0001.apps.googleusercontent.com"
FAKE_SECRET = "fake-client-secret-0002"
FAKE_GEMINI = "fake-gemini-key-0003"
FAKE_AUTH = "fakeauthsecret0004+/fakeauthsecretXYZ="
ALL_FAKES = (FAKE_ID, FAKE_SECRET, FAKE_GEMINI, FAKE_AUTH)

# 偽の infisical: 引数を FAKE_LOG へ。export は FAKE_STATE（dotenv）を出し、secrets set --file は、そのファイルの権限と中身を FAKE_SET_RECORD に残して、FAKE_STATE へ混ぜる
FAKE_INFISICAL = """#!@PY@
import json, os, sys
argv = sys.argv[1:]
with open(os.environ["FAKE_LOG"], "a") as log:
    log.write("infisical " + " ".join(argv) + "\\n")
state = os.environ["FAKE_STATE"]


def read_state():
    try:
        with open(state) as f:
            return [line for line in f.read().splitlines() if line]
    except FileNotFoundError:
        return []


if argv[:1] == ["export"]:
    if os.environ.get("FAKE_EXPORT_FAIL") == "1":
        sys.exit(1)
    sys.stdout.write("".join(line + "\\n" for line in read_state()))
    sys.exit(0)
if argv[:2] == ["secrets", "set"]:
    if os.environ.get("FAKE_SET_FAIL") == "1":
        sys.stderr.write("fake infisical: 偽の失敗\\n")
        sys.exit(1)
    path = argv[argv.index("--file") + 1]
    mode = os.stat(path).st_mode & 0o777
    with open(path) as f:
        content = f.read()
    with open(os.environ["FAKE_SET_RECORD"], "a") as rec:
        rec.write(json.dumps({"path": path, "mode": oct(mode), "content": content}) + "\\n")
    if os.environ.get("FAKE_SET_NOSTORE") != "1":
        merged = {}
        for line in read_state() + content.splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                merged[k] = v
        with open(state, "w") as f:
            f.write("".join("%s=%s\\n" % kv for kv in merged.items()))
    sys.exit(0)
sys.exit(9)
"""

# 偽の openssl: 呼ばれた引数を記録し、偽の乱数を返す（FAKE_OPENSSL_FAIL=1 なら失敗）
FAKE_OPENSSL = f"""#!/bin/sh
echo "openssl $*" >> "$FAKE_LOG"
if [ "${{FAKE_OPENSSL_FAIL:-}}" = 1 ]; then echo "openssl: 偽の失敗" >&2; exit 1; fi
echo '{FAKE_AUTH}'
"""

# python3 の包み: 本物の python3 を呼ぶ。記録するのは -I -c と、コードのあとの引数（JSON と一時ファイルのパス）だけ（コードは記録しない）
FAKE_PYTHON3 = """#!/bin/bash
echo "python3 $1 $2 [code] ${@:4}" >> "$FAKE_LOG"
exec "@PY@" "$@"
"""

# mktemp の包み: 引数なしの mktemp が一時ファイルを置く場所は、OS で違う（macOS は TMPDIR を見ない）。置き場を FAKE_TMPDIR に決めて、残らないことを確かめられるようにする
FAKE_MKTEMP = """#!/bin/sh
exec "@MKTEMP@" "$FAKE_TMPDIR/tmp.XXXXXXXXXX"
"""

REAL_TOOLS = ("grep", "rm")


class Sandbox:
    def __init__(self, root: Path):
        self.root = root
        self.fakebin = root / "fakebin"
        self.toolbin = root / "toolbin"
        self.tmpdir = root / "tmp"
        for d in (self.fakebin, self.toolbin, self.tmpdir):
            d.mkdir()
        self.log = root / "calls.log"
        self.state = root / "infisical-state.env"
        self.record = root / "set-record.jsonl"
        self.log.write_text("")
        self._script("infisical", FAKE_INFISICAL.replace("@PY@", sys.executable))
        self._script("openssl", FAKE_OPENSSL)
        self._script("python3", FAKE_PYTHON3.replace("@PY@", sys.executable))
        real_mktemp = shutil.which("mktemp")
        assert real_mktemp
        self._script("mktemp", FAKE_MKTEMP.replace("@MKTEMP@", real_mktemp))
        for tool in REAL_TOOLS:
            real = shutil.which(tool)
            assert real, tool
            (self.toolbin / tool).symlink_to(real)

    def _script(self, name: str, body: str) -> None:
        p = self.fakebin / name
        p.write_text(body)
        p.chmod(p.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

    def env(self, **extra: str) -> dict[str, str]:
        return {
            "PATH": f"{self.fakebin}:{self.toolbin}",
            "HOME": str(self.root),
            "FAKE_TMPDIR": str(self.tmpdir),
            "FAKE_LOG": str(self.log),
            "FAKE_STATE": str(self.state),
            "FAKE_SET_RECORD": str(self.record),
            **extra,
        }

    def set_state(self, text: str) -> None:
        self.state.write_text(text)

    def calls(self) -> list[str]:
        return self.log.read_text().splitlines()

    def infisical_calls(self, sub: str) -> list[str]:
        return [c for c in self.calls() if c.startswith(f"infisical {sub}")]

    def set_records(self) -> list[dict]:
        if not self.record.exists():
            return []
        return [json.loads(line) for line in self.record.read_text().splitlines()]

    def run_plain(self, *args: str, **extra_env: str) -> subprocess.CompletedProcess:
        """対話端末ではない流し方（標準入力は /dev/null、標準出力はパイプ）。"""
        return subprocess.run(
            [BASH, str(SCRIPT), *args], stdin=subprocess.DEVNULL, capture_output=True, text=True,
            env=self.env(**extra_env), timeout=60,
        )

    def run_tty(self, args: list[str], answers: list[tuple[str, str]], timeout: float = 30.0, **extra_env: str) -> tuple[int, str]:
        """疑似端末で流す。answers は (プロンプトの文字列, 返す入力) の並び。プロンプトが出たら、その入力を 1 行で打つ。戻り値は (終了コード, 画面に出た全文)。"""
        pid, fd = pty.fork()
        if pid == 0:  # 子: スクリプトに置き換わる
            try:
                os.execve(BASH, [BASH, str(SCRIPT), *args], self.env(**extra_env))
            finally:
                os._exit(127)
        out = b""
        pos = 0
        pending = list(answers)
        deadline = time.monotonic() + timeout
        try:
            while True:
                if time.monotonic() > deadline:
                    os.kill(pid, signal.SIGKILL)
                    raise AssertionError("時間内に終わりませんでした。ここまでの出力:\n" + out.decode("utf-8", "replace"))
                ready, _, _ = select.select([fd], [], [], 0.2)
                if ready:
                    try:
                        data = os.read(fd, 4096)
                    except OSError:  # Linux: 子が終わると EIO
                        break
                    if not data:
                        break
                    out += data
                    text = out.decode("utf-8", "replace")
                    while pending:
                        prompt, reply = pending[0]
                        at = text.find(prompt, pos)
                        if at < 0:
                            break
                        pos = at + len(prompt)
                        pending.pop(0)
                        time.sleep(0.15)  # read -s が、入力の表示を止めたあとに打つ（人が打つのと同じ順）
                        os.write(fd, reply.encode() + b"\n")
        finally:
            _, status = os.waitpid(pid, 0)
            os.close(fd)
        code = os.waitstatus_to_exitcode(status)
        text = out.decode("utf-8", "replace").replace("\r\n", "\n")
        assert not pending, f"出るはずのプロンプトが出ませんでした: {pending[0][0]}\n出力:\n{text}"
        return code, text


@pytest.fixture
def box(tmp_path) -> Sandbox:
    return Sandbox(tmp_path)


def make_json(path: Path, body=None) -> Path:
    if body is None:
        body = {"web": {
            "client_id": FAKE_ID, "project_id": "fake-project", "client_secret": FAKE_SECRET,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth", "token_uri": "https://oauth2.googleapis.com/token",
            "redirect_uris": ["http://localhost:3500/api/auth/callback/google"],
        }}
    path.write_text(body if isinstance(body, str) else json.dumps(body))
    return path


def assert_no_fake_values(box: Sandbox, output: str) -> None:
    """画面・infisical と python3 への引数のどこにも、偽の値が出ていない。"""
    everything = output + "\n" + box.log.read_text()
    for fake in ALL_FAKES:
        assert fake not in everything, fake


def assert_only_the_temp_path_was_passed(box: Sandbox) -> str:
    """secrets set は 1 回で、渡ったのは一時ファイルのパスだけ。そのパスを返す。"""
    sets = box.infisical_calls("secrets set")
    assert len(sets) == 1, sets
    m = re.fullmatch(rf"infisical secrets set --file (\S+) --projectId {PROJECT} --env dev --path / --silent", sets[0])
    assert m, sets[0]
    path = m.group(1)
    assert path.startswith(str(box.tmpdir) + "/")
    return path


def assert_temp_files_are_gone(box: Sandbox) -> None:
    assert list(box.tmpdir.iterdir()) == []  # 成功しても失敗しても、一時ファイル（と .err）が残らない


def parse_env(text: str) -> dict[str, str]:
    return dict(line.split("=", 1) for line in text.splitlines() if "=" in line)


# ---- 引数・安全装置 ----

@pytest.mark.parametrize("args", [[], ["--from-json"], ["--from-json="], ["proj", "dev", "extra"], ["--unknown", PROJECT]], ids=["none", "json-no-path", "json-empty", "too-many", "unknown-option"])
def test_bad_arguments_print_usage_and_exit_2(box, args):
    r = box.run_plain(*args)
    assert r.returncode == 2
    assert "使い方" in r.stderr
    assert box.calls() == []  # 何も呼んでいない


def test_without_a_terminal_it_does_nothing_and_never_calls_infisical(box, tmp_path):
    j = make_json(tmp_path / "client.json")
    for args in ([PROJECT], [PROJECT, "--from-json", str(j)]):
        r = box.run_plain(*args)
        assert r.returncode == 3, r.stderr
        assert "対話端末ではない" in r.stderr and "infisical は呼んでいません" in r.stderr
    assert box.calls() == []  # infisical も openssl も python3 も呼ばれていない
    assert j.exists()  # JSON も触らない
    assert_temp_files_are_gone(box)


def test_missing_infisical_cli_stops_with_exit_2(box):
    (box.fakebin / "infisical").unlink()
    r = box.run_plain(PROJECT)
    assert r.returncode == 2 and "infisical コマンドが見つかりません" in r.stderr


# ---- 対話の入力 ----

def test_prompts_register_the_four_values_without_showing_any(box):
    code, out = box.run_tty([PROJECT], [
        ("GOOGLE_CLIENT_ID（入力は表示されません）: ", FAKE_ID),
        ("GOOGLE_CLIENT_SECRET（入力は表示されません）: ", FAKE_SECRET),
        ("GEMINI_API_KEY（任意。空のままなら登録しません。入力は表示されません）: ", FAKE_GEMINI),
    ])
    assert code == 0, out
    assert out.count("入力は表示されません") == 3
    assert_no_fake_values(box, out)
    path = assert_only_the_temp_path_was_passed(box)
    [rec] = box.set_records()
    assert rec["path"] == path and rec["mode"] == "0o600"  # 権限 600 の一時ファイル
    assert parse_env(rec["content"]) == {
        "GOOGLE_CLIENT_ID": FAKE_ID, "GOOGLE_CLIENT_SECRET": FAKE_SECRET, "BETTER_AUTH_SECRET": FAKE_AUTH, "GEMINI_API_KEY": FAKE_GEMINI,
    }
    assert box.calls().count("openssl rand -base64 32") == 1
    assert f"GOOGLE_CLIENT_ID（{len(FAKE_ID)} 文字）" in out and f"GOOGLE_CLIENT_SECRET（{len(FAKE_SECRET)} 文字）" in out
    assert "BETTER_AUTH_SECRET（新しく作成）" in out and f"GEMINI_API_KEY（{len(FAKE_GEMINI)} 文字）" in out
    assert f"起動: infisical run --projectId {PROJECT} --env dev -- docker compose up -d" in out
    assert_temp_files_are_gone(box)


def test_an_empty_gemini_key_is_not_registered(box):
    code, out = box.run_tty([PROJECT], [
        ("GOOGLE_CLIENT_ID（", FAKE_ID), ("GOOGLE_CLIENT_SECRET（", FAKE_SECRET), ("GEMINI_API_KEY（", ""),
    ])
    assert code == 0, out
    [rec] = box.set_records()
    assert "GEMINI_API_KEY" not in rec["content"]
    assert "GEMINI_API_KEY（登録せず）" in out
    assert_no_fake_values(box, out)


def test_an_existing_better_auth_secret_is_never_recreated(box):
    box.set_state("BETTER_AUTH_SECRET=existing-value-0005\n")
    code, out = box.run_tty([PROJECT], [
        ("GOOGLE_CLIENT_ID（", FAKE_ID), ("GOOGLE_CLIENT_SECRET（", FAKE_SECRET), ("GEMINI_API_KEY（", ""),
    ])
    assert code == 0, out
    [rec] = box.set_records()
    assert "BETTER_AUTH_SECRET" not in rec["content"]
    assert "openssl" not in " ".join(box.calls())  # 乱数も頼まない
    assert "BETTER_AUTH_SECRET（既存のまま）" in out
    assert parse_env(box.state.read_text())["BETTER_AUTH_SECRET"] == "existing-value-0005"
    assert "existing-value-0005" not in out


def test_both_google_values_are_required_and_no_whitespace(box):
    code, out = box.run_tty([PROJECT], [("GOOGLE_CLIENT_ID（", FAKE_ID), ("GOOGLE_CLIENT_SECRET（", "")])
    assert code == 1 and "両方が要ります" in out
    code, out = box.run_tty([PROJECT], [("GOOGLE_CLIENT_ID（", FAKE_ID), ("GOOGLE_CLIENT_SECRET（", "GOCSPX has space FAKE")])
    assert code == 1 and "空白・改行は入れられません" in out
    assert "GOCSPX has space" not in out
    assert box.set_records() == []
    assert_temp_files_are_gone(box)


def test_an_export_failure_stops_before_asking_for_anything(box):
    code, out = box.run_tty([PROJECT], [], FAKE_EXPORT_FAIL="1")
    assert code == 1 and "既存の秘密を確認できませんでした" in out
    assert "入力は表示されません" not in out
    assert box.infisical_calls("secrets set") == []


def test_a_failed_registration_exits_1_and_cleans_up(box):
    code, out = box.run_tty([PROJECT], [
        ("GOOGLE_CLIENT_ID（", FAKE_ID), ("GOOGLE_CLIENT_SECRET（", FAKE_SECRET), ("GEMINI_API_KEY（", FAKE_GEMINI),
    ], FAKE_SET_FAIL="1")
    assert code == 1 and "登録に失敗しました" in out
    assert_no_fake_values(box, out)
    assert "偽の失敗" not in out  # infisical のエラー出力は、画面に出さない（一時ファイルへ捨てる）
    assert_temp_files_are_gone(box)


def test_an_openssl_failure_registers_nothing_instead_of_an_empty_secret(box):
    code, out = box.run_tty([PROJECT], [
        ("GOOGLE_CLIENT_ID（", FAKE_ID), ("GOOGLE_CLIENT_SECRET（", FAKE_SECRET), ("GEMINI_API_KEY（", ""),
    ], FAKE_OPENSSL_FAIL="1")
    assert code == 1 and "乱数を作れませんでした" in out
    assert box.infisical_calls("secrets set") == []
    assert_temp_files_are_gone(box)


def test_a_missing_key_after_registration_is_reported(box):
    # 登録が成功したように見えて、中身が無かったとき（偽の infisical が、混ぜずに終わる）
    code, out = box.run_tty([PROJECT], [
        ("GOOGLE_CLIENT_ID（", FAKE_ID), ("GOOGLE_CLIENT_SECRET（", FAKE_SECRET), ("GEMINI_API_KEY（", FAKE_GEMINI),
    ], FAKE_SET_NOSTORE="1")
    assert code == 1
    assert "登録したあとの確認で、次のキーが見つかりません: GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET BETTER_AUTH_SECRET GEMINI_API_KEY" in out
    assert_no_fake_values(box, out)


# ---- --from-json ----

def test_from_json_registers_without_prompting_for_google_and_deletes_the_json(box, tmp_path):
    j = make_json(tmp_path / "client_secret.json")
    code, out = box.run_tty([PROJECT, "--from-json", str(j)], [("GEMINI_API_KEY（", FAKE_GEMINI)])
    assert code == 0, out
    assert out.count("入力は表示されません") == 1  # Google の 2 つは聞かない（聞くのは Gemini だけ）
    assert_no_fake_values(box, out)  # (1) 偽の値が標準出力・標準エラーに出ない（infisical・python3 への引数にも出ない）
    # (2) infisical に渡るのは一時ファイルのパスだけ。python3 に渡るのは、-I -c とコードのあとの JSON と一時ファイルのパスだけ
    path = assert_only_the_temp_path_was_passed(box)
    [py] = [c for c in box.calls() if c.startswith("python3 ")]
    assert re.fullmatch(rf"python3 -I -c \[code\] {re.escape(str(j))} {re.escape(path)}", py), py
    [rec] = box.set_records()
    assert rec["mode"] == "0o600"
    assert parse_env(rec["content"]) == {
        "GOOGLE_CLIENT_ID": FAKE_ID, "GOOGLE_CLIENT_SECRET": FAKE_SECRET, "BETTER_AUTH_SECRET": FAKE_AUTH, "GEMINI_API_KEY": FAKE_GEMINI,
    }
    assert f"GOOGLE_CLIENT_ID（{len(FAKE_ID)} 文字）" in out and f"GOOGLE_CLIENT_SECRET（{len(FAKE_SECRET)} 文字）" in out
    assert not j.exists()  # (3) 成功したら JSON が消える
    assert f"JSON を削除しました: {j}" in out
    assert_temp_files_are_gone(box)


def test_from_json_equals_form_and_a_custom_environment(box, tmp_path):
    j = make_json(tmp_path / "client.json")
    code, out = box.run_tty([PROJECT, "staging", f"--from-json={j}"], [("GEMINI_API_KEY（", "")])
    assert code == 0, out
    assert box.infisical_calls("secrets set")[0].endswith(f"--projectId {PROJECT} --env staging --path / --silent")
    assert "TOWNSCAN_INFISICAL_ENV=staging" in out
    assert not j.exists()


def test_from_json_keeps_the_json_when_the_registration_fails(box, tmp_path):
    j = make_json(tmp_path / "client.json")
    before = j.read_bytes()
    code, out = box.run_tty([PROJECT, "--from-json", str(j)], [("GEMINI_API_KEY（", "")], FAKE_SET_FAIL="1")
    assert code == 1 and "登録に失敗しました" in out
    assert j.read_bytes() == before  # (4) 失敗したら JSON は残る（中身も同じ）
    assert "JSON を削除しました" not in out
    assert_no_fake_values(box, out)
    assert_temp_files_are_gone(box)


def test_from_json_keeps_the_json_when_the_check_after_registration_fails(box, tmp_path):
    j = make_json(tmp_path / "client.json")
    code, out = box.run_tty([PROJECT, "--from-json", str(j)], [("GEMINI_API_KEY（", "")], FAKE_SET_NOSTORE="1")
    assert code == 1 and "次のキーが見つかりません" in out
    assert j.exists()


def test_from_json_keeps_the_json_when_infisical_cannot_be_read(box, tmp_path):
    j = make_json(tmp_path / "client.json")
    code, out = box.run_tty([PROJECT, "--from-json", str(j)], [], FAKE_EXPORT_FAIL="1")
    assert code == 1 and j.exists()
    assert box.calls() == [f"infisical export --projectId {PROJECT} --env dev --path / --format=dotenv"]  # JSON は読んでもいない（python3 も呼んでいない）


def test_from_json_keeps_the_json_when_openssl_fails(box, tmp_path):
    j = make_json(tmp_path / "client.json")
    code, out = box.run_tty([PROJECT, "--from-json", str(j)], [("GEMINI_API_KEY（", "")], FAKE_OPENSSL_FAIL="1")
    assert code == 1 and j.exists()
    assert box.infisical_calls("secrets set") == []
    assert_no_fake_values(box, out)
    assert_temp_files_are_gone(box)


def test_from_json_with_an_existing_secret_does_not_ask_openssl(box, tmp_path):
    box.set_state("BETTER_AUTH_SECRET=existing-value-0005\n")
    j = make_json(tmp_path / "client.json")
    code, out = box.run_tty([PROJECT, "--from-json", str(j)], [("GEMINI_API_KEY（", "")])
    assert code == 0, out
    [rec] = box.set_records()
    assert set(parse_env(rec["content"])) == {"GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"}
    assert not any(c.startswith("openssl") for c in box.calls())
    assert not j.exists()


BAD_JSONS = {
    "installed-type": {"installed": {"client_id": FAKE_ID, "client_secret": FAKE_SECRET}},
    "no-web-key": {"client_id": FAKE_ID, "client_secret": FAKE_SECRET},
    "web-not-an-object": {"web": FAKE_SECRET},
    "list-at-top": [FAKE_ID, FAKE_SECRET],
    "no-client-secret": {"web": {"client_id": FAKE_ID}},
    "no-client-id": {"web": {"client_secret": FAKE_SECRET}},
    "empty-client-id": {"web": {"client_id": "", "client_secret": FAKE_SECRET}},
    "empty-client-secret": {"web": {"client_id": FAKE_ID, "client_secret": ""}},
    "number-secret": {"web": {"client_id": FAKE_ID, "client_secret": 12345}},
    "space-in-secret": {"web": {"client_id": FAKE_ID, "client_secret": "GOCSPX-fake secret"}},
    "newline-in-id": {"web": {"client_id": FAKE_ID + "\nINJECTED=1", "client_secret": FAKE_SECRET}},
    "tab-in-id": {"web": {"client_id": "a\tb" + FAKE_ID, "client_secret": FAKE_SECRET}},
    "not-json": "client_id=" + FAKE_ID + "\nclient_secret=" + FAKE_SECRET + "\n",
    "broken-json": '{"web": {"client_id": "' + FAKE_ID + '", ',
}


@pytest.mark.parametrize("name", sorted(BAD_JSONS))
def test_from_json_aborts_on_a_bad_file_and_keeps_it(box, tmp_path, name):
    j = make_json(tmp_path / "client.json", BAD_JSONS[name])
    before = j.read_bytes()
    code, out = box.run_tty([PROJECT, "--from-json", str(j)], [])
    assert code == 1, out
    assert "中止しました" in out
    assert "入力は表示されません" not in out  # Gemini の入力に進まない（何も登録しない）
    assert box.infisical_calls("secrets set") == []
    assert j.read_bytes() == before
    assert "JSON を削除しました" not in out
    # エラーの文に値を入れない（偽の値と、改行に混ぜた文字列）
    assert_no_fake_values(box, out)
    assert "INJECTED" not in out and "GOCSPX-fake secret" not in out
    assert_temp_files_are_gone(box)


def test_from_json_rejects_a_missing_file_and_a_symlink(box, tmp_path):
    code, out = box.run_tty([PROJECT, "--from-json", str(tmp_path / "nothing.json")], [])
    assert code == 1 and "通常のファイルではありません" in out
    real = make_json(tmp_path / "real.json")
    link = tmp_path / "link.json"
    link.symlink_to(real)
    code, out = box.run_tty([PROJECT, "--from-json", str(link)], [])
    assert code == 1 and "通常のファイルではありません" in out
    assert real.exists() and link.is_symlink()
    assert box.calls() == []  # infisical にも python3 にも、まだ触れていない


def test_from_json_rejects_a_huge_file_without_reading_it_all(box, tmp_path):
    j = tmp_path / "big.json"
    j.write_text('{"web": {"client_id": "' + "a" * 70000 + '"}}')
    code, out = box.run_tty([PROJECT, "--from-json", str(j)], [])
    assert code == 1 and "大きすぎます" in out and j.exists()


def test_from_json_warns_about_a_client_id_that_looks_wrong_but_still_works(box, tmp_path):
    j = make_json(tmp_path / "client.json", {"web": {"client_id": "not-a-google-id-" + FAKE_SECRET[:5], "client_secret": FAKE_SECRET}})
    code, out = box.run_tty([PROJECT, "--from-json", str(j)], [("GEMINI_API_KEY（", "")])
    assert code == 0, out
    assert "注意: Client ID が .apps.googleusercontent.com で終わっていません" in out
    assert "not-a-google-id-" not in out
