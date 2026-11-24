"""契約の検査の共通部品。起動中の API に HTTP だけで叩く（アプリのコードは import しない）。

環境変数:
  API_BASE_URL       叩く API（既定 http://127.0.0.1:8500）
  CONTRACT_VARIANT   API の構成（main・empty・noauth・badauth・jwksdown・dbdown。既定 main）。README の「API の構成」。
                     検査は、自分の構成のものだけが流れる（ほかは deselected として数えられる）
  CONTRACT_JWKS_*    偽の JWKS サーバー（support/fakes.py）の待ち受け先。API の AUTH_JWKS_URL がここを指す
"""

from __future__ import annotations

import os
import time

import pytest

from support import expected
from support.client import Client
from support.fakes import JwksServer

API_BASE_URL = os.environ.get("API_BASE_URL", "http://127.0.0.1:8500")
VARIANT = os.environ.get("CONTRACT_VARIANT", "main")
VARIANTS = ("main", "empty", "noauth", "badauth", "jwksdown", "dbdown")
READY_TIMEOUT = float(os.environ.get("CONTRACT_READY_TIMEOUT", "60"))
# 合成データ（kind=synthetic の run）が入っている構成。ここで run_id が違えば、契約の外のデータを叩いている
DATA_VARIANTS = ("main", "noauth", "badauth", "jwksdown")


def pytest_configure(config: pytest.Config) -> None:
    if VARIANT not in VARIANTS:
        raise pytest.UsageError(f"CONTRACT_VARIANT={VARIANT!r} は未知の構成です。使えるのは {'・'.join(VARIANTS)}")


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    """検査の構成（@pytest.mark.variant("main", ...)。付けなければ main）と、CONTRACT_VARIANT が合わないものを外す。"""
    keep, drop = [], []
    for item in items:
        marker = item.get_closest_marker("variant")
        names = tuple(marker.args) if marker else ("main",)
        unknown = [n for n in names if n not in VARIANTS]
        if unknown:
            raise pytest.UsageError(f"{item.nodeid}: 未知の構成 {unknown}")
        (keep if VARIANT in names else drop).append(item)
    if drop:
        config.hook.pytest_deselected(items=drop)
        items[:] = keep


def pytest_report_header(config: pytest.Config) -> list[str]:
    return [f"contract: API_BASE_URL={API_BASE_URL} variant={VARIANT}"]


@pytest.fixture(scope="session")
def api() -> Client:
    """API のクライアント。最初に、API が応答するまで待ち、データが契約の合成データであることを確かめる（違えば、検査を始めない）。"""
    client = Client(API_BASE_URL, timeout=float(os.environ.get("CONTRACT_TIMEOUT", "20")))
    deadline = time.monotonic() + READY_TIMEOUT
    last = ""
    while True:
        try:
            health = client.get("/api/health", timeout=15)
            break
        except OSError as exc:
            last = f"{type(exc).__name__}: {exc}"
            if time.monotonic() > deadline:
                pytest.exit(f"API に届きません（{API_BASE_URL}。{last}）", returncode=3)
            time.sleep(0.5)
    if VARIANT in DATA_VARIANTS:
        run_id = (health.json().get("run") or {}).get("run_id") if health.content_type.startswith("application/json") else None
        if run_id != expected.RUN_ID:
            pytest.exit(
                f"この API のデータは契約の合成データではありません（run_id={run_id!r}。期待は {expected.RUN_ID!r}）。"
                "scripts/test-contract.sh で起動した API に流してください（README の「データの準備」）",
                returncode=3,
            )
    return client


@pytest.fixture(scope="session")
def jwks():
    """偽の JWKS サーバー（この検査のプロセスの中）。使うときだけ立てる。"""
    try:
        server = JwksServer().start()
    except OSError as exc:
        pytest.exit(f"偽の JWKS サーバーを立てられません（CONTRACT_JWKS_BIND・CONTRACT_JWKS_PORT を確認: {exc}）", returncode=3)
    yield server
    server.stop()
