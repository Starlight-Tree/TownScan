"""契約の検査の共通部品。起動中の API に HTTP だけで叩く（アプリのコードは import しない）。

環境変数:
  API_BASE_URL       叩く API（既定 http://127.0.0.1:8500）
  CONTRACT_VARIANT   API の構成（main・empty・noauth・badauth・jwksdown・dbdown・history。既定 main）。README の「API の構成」。
                     検査は、自分の構成のものだけが流れる（ほかは deselected として数えられる）
  CONTRACT_FEATURES  この API が持つ機能（空白かカンマで区切る。いまは history だけ）。機能の印（@pytest.mark.history）の付いた検査は、
                     ここに無い機能のとき、構成が合っていても deselect される（会話の履歴は Go の API にだけある。Python の API に流さない）。
                     scripts/test-contract.sh は、対象が go のときだけ history を渡す
  CONTRACT_USER_POOL 履歴の検査用の利用者の人数（既定 200。scripts/test-contract.sh が auth_user へ入れる人数と同じ）
  CONTRACT_JWKS_*    偽の JWKS サーバー（support/fakes.py）の待ち受け先。API の AUTH_JWKS_URL がここを指す
"""

from __future__ import annotations

import os
import time
from typing import Any

import pytest

from support import expected, fakes
from support.client import Client
from support.fakes import JwksServer
from support.history import Member

API_BASE_URL = os.environ.get("API_BASE_URL", "http://127.0.0.1:8500")
VARIANT = os.environ.get("CONTRACT_VARIANT", "main")
VARIANTS = ("main", "empty", "noauth", "badauth", "jwksdown", "dbdown", "history")
READY_TIMEOUT = float(os.environ.get("CONTRACT_READY_TIMEOUT", "60"))
# 合成データ（kind=synthetic の run）が入っている構成。ここで run_id が違えば、契約の外のデータを叩いている
DATA_VARIANTS = ("main", "noauth", "badauth", "jwksdown", "history")
# 機能の印（構成の印 variant とは別）。付いた検査は、CONTRACT_FEATURES にその機能が無いとき deselect される
FEATURES = ("history",)
ENABLED_FEATURES = frozenset(f for f in os.environ.get("CONTRACT_FEATURES", "").replace(",", " ").split() if f)


def pytest_configure(config: pytest.Config) -> None:
    if VARIANT not in VARIANTS:
        raise pytest.UsageError(f"CONTRACT_VARIANT={VARIANT!r} は未知の構成です。使えるのは {'・'.join(VARIANTS)}")
    unknown = sorted(ENABLED_FEATURES - set(FEATURES))
    if unknown:
        raise pytest.UsageError(f"CONTRACT_FEATURES に未知の機能 {unknown} があります。使えるのは {'・'.join(FEATURES)}")
    if VARIANT == "history" and "history" not in ENABLED_FEATURES:
        # 流すと、全部が deselect されて「検査が無い」で終わる。黙って空振りさせない
        raise pytest.UsageError("構成 history は、機能 history を持つ API（Go）だけに流します。CONTRACT_FEATURES=history を付けてください")


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    """検査の構成（@pytest.mark.variant("main", ...)。付けなければ main）と、CONTRACT_VARIANT が合わないものを外す。
    機能の印（@pytest.mark.history）が付いた検査は、CONTRACT_FEATURES にその機能が無ければ、構成が合っていても外す（Python の API に流さない）。"""
    keep, drop = [], []
    for item in items:
        marker = item.get_closest_marker("variant")
        names = tuple(marker.args) if marker else ("main",)
        unknown = [n for n in names if n not in VARIANTS]
        if unknown:
            raise pytest.UsageError(f"{item.nodeid}: 未知の構成 {unknown}")
        missing_feature = any(item.get_closest_marker(f) is not None and f not in ENABLED_FEATURES for f in FEATURES)
        (keep if VARIANT in names and not missing_feature else drop).append(item)
    if drop:
        config.hook.pytest_deselected(items=drop)
        items[:] = keep


def pytest_report_header(config: pytest.Config) -> list[str]:
    return [f"contract: API_BASE_URL={API_BASE_URL} variant={VARIANT} features={','.join(sorted(ENABLED_FEATURES)) or '-'}"]


def pytest_terminal_summary(terminalreporter: Any) -> None:
    """履歴の検査が使った利用者の人数（プール fakes.USER_POOL_SIZE のうち）。使い切りに近づいたら気づけるように。"""
    used = fakes.users_used()
    if used:
        terminalreporter.write_line(f"contract: 検査用の利用者 {used} / {fakes.USER_POOL_SIZE} 人を使用")


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


# ---- 会話の履歴（構成 history）。利用者は、検査ごとに別の人（auth_user に行がある。scripts/test-contract.sh が入れる）を使う ----

@pytest.fixture
def fresh_user():
    """まだ使っていない利用者の sub を返す関数（support/fakes.py の fresh_user。同じ実行の中で重ならない。使い切ったら、はっきり失敗する）。"""
    return fakes.fresh_user


@pytest.fixture
def member(api, jwks):
    """履歴の検査の利用者を作る関数。呼ぶたびに、まだ使っていない利用者（`member()`）か、指定した sub（`member(sub=…)`）の `Member`。"""

    def make(sub: str | None = None) -> Member:
        return Member(api, sub or fakes.fresh_user())

    return make


@pytest.fixture
def nouser(api, jwks) -> Member:
    """`auth_user` に行が無い利用者（プールの外の固定の sub。H-A4）。有効な JWT は作れる。"""
    return Member(api, fakes.NOUSER_SUB)
