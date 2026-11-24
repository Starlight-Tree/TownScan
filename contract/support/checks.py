"""検査の共通の道具（応答の形の確かめ方）。"""

from __future__ import annotations

from datetime import datetime
from typing import Any

import pytest

from support.client import Response


def is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def assert_json(resp: Response, status: int = 200) -> Any:
    assert resp.status == status, resp
    assert resp.content_type.startswith("application/json"), resp
    return resp.json()


def assert_error(resp: Response, status: int, code: str | None = None, message: str | None = None) -> dict:
    """エラーの形 `{error:{code,message}}`（422 は details も付く）。code・message を渡せば、その値と一致すること。"""
    assert resp.status == status, resp
    assert resp.content_type.startswith("application/json"), resp
    body = resp.json()
    assert set(body) == {"error"}, body
    err = body["error"]
    assert {"code", "message"} <= set(err) <= {"code", "message", "details"}, err
    assert isinstance(err["code"], str) and err["code"], err
    assert isinstance(err["message"], str) and err["message"], err
    if code is not None:
        assert err["code"] == code, err
    if message is not None:
        assert err["message"] == message, err
    return err


def assert_validation_error(resp: Response, *loc: str) -> dict:
    """422 の形: code=validation_error、message は「引数が不正です（場所）」、details は [{loc:[…], msg}]。loc を渡せば、先頭がそれと一致すること。"""
    err = assert_error(resp, 422, "validation_error")
    assert err["message"].startswith("引数が不正です"), err
    details = err["details"]
    assert isinstance(details, list) and details, err
    for d in details:
        assert set(d) == {"loc", "msg"}, d
        assert isinstance(d["loc"], list) and all(isinstance(p, str) for p in d["loc"]), d
        assert isinstance(d["msg"], str), d
    if loc:
        assert tuple(details[0]["loc"][: len(loc)]) == loc, details
        assert err["message"] == f"引数が不正です（{'.'.join(details[0]['loc'])}）", err
    return err


def assert_close(actual: Any, expected: Any, tol: float = 1e-6) -> None:
    """数（または数の配列・入れ子）が、許容 tol の中で等しい。"""
    if isinstance(expected, (list, tuple)):
        assert isinstance(actual, list) and len(actual) == len(expected), (actual, expected)
        for a, e in zip(actual, expected):
            assert_close(a, e, tol)
    else:
        assert is_num(actual), actual
        assert actual == pytest.approx(expected, abs=tol), (actual, expected)


def assert_same(actual: Any, expected: Any, tol: float = 1e-6, path: str = "$") -> None:
    """JSON の値が等しい。小数（float）は許容 tol で比べ、それ以外（整数・文字列・真偽・null）は完全一致。キーの過不足も見る。"""
    if isinstance(expected, dict):
        assert isinstance(actual, dict) and set(actual) == set(expected), f"{path}: キーが違う {sorted(actual) if isinstance(actual, dict) else actual!r} != {sorted(expected)}"
        for k in expected:
            assert_same(actual[k], expected[k], tol, f"{path}.{k}")
    elif isinstance(expected, list):
        assert isinstance(actual, list) and len(actual) == len(expected), f"{path}: 配列の長さが違う {actual!r} != {expected!r}"
        for i, (a, e) in enumerate(zip(actual, expected)):
            assert_same(a, e, tol, f"{path}[{i}]")
    elif isinstance(expected, float):
        assert is_num(actual) and actual == pytest.approx(expected, abs=tol), f"{path}: {actual!r} != {expected!r}"
    else:
        assert type(actual) is type(expected) and actual == expected, f"{path}: {actual!r} != {expected!r}"


def same_instant(text: str, iso_expected: str) -> bool:
    """ISO 8601（タイムゾーンつき）の文字列 2 つが、同じ時刻か。"""
    a, b = datetime.fromisoformat(text), datetime.fromisoformat(iso_expected)
    return a.tzinfo is not None and a == b
