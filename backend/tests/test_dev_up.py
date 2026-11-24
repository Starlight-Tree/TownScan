"""scripts/dev-up.sh の .env とボリュームの扱い。本物の docker は使わず、偽の docker・openssl・curl を PATH に置いて流す。

守りたいこと: Postgres は POSTGRES_PASSWORD を「空のデータで初期化するとき」にしか読まない。DB のボリュームが残っているのに
.env を作り直すと、新しい乱数のパスワードが DB と合わず、api が永久に起動しない。だから、そうなる前に止めて案内する。
スクリプトの場所は、環境変数 DEV_UP_SCRIPT（scripts/test-backend.sh が渡す）か、リポジトリの scripts/dev-up.sh。
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

    def run(self, *args: str, volumes: str = "", **extra_env: str) -> subprocess.CompletedProcess:
        env = {
            "PATH": f"{self.bin}:{os.environ.get('PATH', '/usr/bin:/bin')}",
            "HOME": str(self.root),
            "FAKE_LOG": str(self.log),
            "FAKE_VOLUMES": volumes,
            **extra_env,
        }
        return subprocess.run(
            ["bash", str(self.root / "scripts" / "dev-up.sh"), "--no-web", *args],
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
    assert re.fullmatch(r"POSTGRES_PASSWORD=[0-9a-f]+\n", box.env_file.read_text())
    assert stat.S_IMODE(box.env_file.stat().st_mode) == 0o600
    assert FAKE_PASSWORD not in r.stdout + r.stderr  # 値は表示しない
    assert "docker compose up -d --build db api" in box.docker_calls()


def test_existing_env_is_left_alone_even_with_a_volume(box):
    box.env_file.write_text("POSTGRES_PASSWORD=abc123\n")
    r = box.run(volumes="townscan_townscan-pgdata")
    assert r.returncode == 0, r.stderr
    assert box.env_file.read_text() == "POSTGRES_PASSWORD=abc123\n"


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
