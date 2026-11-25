"""会話の履歴（構成 history・H-系。仕様 §2.3・§4.4・§8 の E9）の検査の道具: 経路・固定の文・利用者ごとの呼び出し（Member）・応答の確かめ方。

契約の検査は HTTP だけで叩く（アプリのコードは import しない）。履歴の 3 本は、`Authorization: Bearer <JWT>` の `sub` だけから利用者を決める。
利用者は、検査ごとに別の人（`fakes.fresh_user()`。`auth_user` に行がある）にする。検査どうしが同じ利用者の状態（一覧が空・件数）に依存しないため。
"""

from __future__ import annotations

import time
import uuid
from datetime import datetime
from typing import Any

from support import chat as chat_support
from support.checks import assert_json
from support.client import Client, Response
from support.fakes import bearer, make_token

LIST_PATH = "/api/conversations"

# 固定の文（仕様 §4.4。ユーザーに見える文）
UNAUTHORIZED = {"error": {"code": "unauthorized", "message": "ログインしてください"}}
NOT_CONFIGURED = {"error": {"code": "unavailable", "message": "Google でのログインは、まだ設定されていません"}}
CANNOT_VERIFY = {"error": {"code": "unavailable", "message": "ログインを確認できませんでした。しばらくしてから、もう一度お試しください"}}
NOT_FOUND = {"error": {"code": "not_found", "message": "会話が見つかりません"}}
DB_UNAVAILABLE_MESSAGE = "データベースに接続できません。しばらくしてから再試行してください"
CONVERSATION_FULL_MESSAGE = "この会話は長くなりすぎました。新しい会話を始めてください"
LAST_MESSAGE_RULE = "最後のメッセージは、空でない user のメッセージである必要があります"

LIST_KEYS = {"id", "title", "created_at", "updated_at"}
MAX_CONVERSATIONS = 50  # 1 人あたりの会話の数（一覧の上限と、保存時の整理の上限）
MAX_STORED_MESSAGES = 500  # 1 会話の発言数の上限
MAX_TITLE_CHARS = 40
DB_DOWN_TIMEOUT = 45.0  # DB が止まったときの接続の待ちの上限（実装の 10 秒前後）を見込む

QUESTION = "新規出現の候補は何件ありますか？"  # 模擬モデルが count_candidates で答える、ふつうの質問


def new_id() -> str:
    """画面と同じ形の会話 ID（`crypto.randomUUID()` に相当。小文字 36 文字。`^[A-Za-z0-9_-]{1,128}$` に合う）。"""
    return str(uuid.uuid4())


def messages_path(conversation_id: str) -> str:
    return f"{LIST_PATH}/{conversation_id}/messages"


def conversation_path(conversation_id: str) -> str:
    return f"{LIST_PATH}/{conversation_id}"


def user_message(text: str) -> dict:
    return {"role": "user", "content": text}


def assistant_message(text: str) -> dict:
    return {"role": "assistant", "content": text}


def chat_body(text: str, conversation_id: str | None = None, history: list[dict] | tuple = ()) -> dict:
    body: dict = {"messages": [*history, user_message(text)]}
    if conversation_id is not None:
        body["conversation_id"] = conversation_id
    return body


# ---- 認証の失敗の作り方（H-A1・A2。どれも同じ 401 になる） ----

BAD_CREDENTIALS = ("no-header", "basic", "bearer-only", "garbage", "expired", "wrong-aud")


def bad_headers(kind: str, sub: str | None = None) -> dict[str, str]:
    """ログインしていない・壊れた・期限切れ・`aud` 違いの `Authorization`。署名は正しい鍵で付ける（期限と `aud` だけが違う）。sub を渡せば、その利用者の JWT になる。"""
    extra = {"sub": sub} if sub else {}
    if kind == "no-header":
        return {}
    if kind == "basic":
        return {"Authorization": "Basic abc"}
    if kind == "bearer-only":
        return {"Authorization": "Bearer"}
    if kind == "garbage":
        return {"Authorization": "Bearer not-a-jwt"}
    if kind == "expired":
        return bearer(make_token(exp=int(time.time()) - 3600, **extra))
    if kind == "wrong-aud":
        return bearer(make_token(aud="townscan-other", **extra))
    raise ValueError(kind)


# ---- 応答の確かめ方 ----

def assert_no_store(resp: Response) -> None:
    assert resp.header("cache-control") == "no-store", resp


def assert_unauthorized(resp: Response, *, no_store: bool = True) -> None:
    """401・固定の文・`WWW-Authenticate: Bearer`（履歴の 3 本は `Cache-Control: no-store` も。chat は付けない約束なので、no_store=False で確かめない）。"""
    assert resp.status == 401, resp
    assert resp.content_type.startswith("application/json"), resp
    assert resp.json() == UNAUTHORIZED, resp
    assert resp.header("www-authenticate") == "Bearer", resp
    if no_store:
        assert_no_store(resp)


def assert_not_found(resp: Response) -> None:
    """404・固定の文（無い会話と他人の会話で同じ）・`no-store`。"""
    assert resp.status == 404, resp
    assert resp.content_type.startswith("application/json"), resp
    assert resp.json() == NOT_FOUND, resp
    assert_no_store(resp)


def assert_not_answered(resp: Response) -> None:
    """chat が回答を返していない（エラーの本文で、`message` が無い）。"""
    assert resp.status >= 400, resp
    assert "message" not in resp.json(), resp


def parse_time(text: Any) -> datetime:
    """時刻の文字列を読む（ISO 8601。表記の `+00:00` か `Z` かは問わないが、タイムゾーンは付いている）。"""
    assert isinstance(text, str), text
    parsed = datetime.fromisoformat(text)
    assert parsed.tzinfo is not None, f"タイムゾーンが無い時刻です: {text!r}"
    return parsed


def assert_json_equal(actual: Any, expected: Any, path: str = "$") -> None:
    """JSON として等しい。キーの順は問わない（jsonb が正規化する）。数は値で比べる（5 と 5.0 は同じ）が、真偽・文字列・null とは混ぜない。キーの過不足も見る。"""
    if isinstance(expected, dict):
        assert isinstance(actual, dict), f"{path}: {actual!r} != {expected!r}"
        assert set(actual) == set(expected), f"{path}: キーが違う {sorted(actual)} != {sorted(expected)}"
        for key in expected:
            assert_json_equal(actual[key], expected[key], f"{path}.{key}")
    elif isinstance(expected, list):
        assert isinstance(actual, list) and len(actual) == len(expected), f"{path}: 配列の長さが違う {actual!r} != {expected!r}"
        for i, (a, e) in enumerate(zip(actual, expected)):
            assert_json_equal(a, e, f"{path}[{i}]")
    elif isinstance(expected, bool) or expected is None or isinstance(expected, str):
        assert type(actual) is type(expected) and actual == expected, f"{path}: {actual!r} != {expected!r}"
    else:  # 数
        assert isinstance(actual, (int, float)) and not isinstance(actual, bool) and actual == expected, f"{path}: {actual!r} != {expected!r}"


# ---- 利用者 ----

class Member:
    """1 人の利用者（`sub`）として履歴の API を呼ぶ。トークンは呼ぶたびに作る（有効 15 分）。"""

    def __init__(self, api: Client, sub: str) -> None:
        self.api = api
        self.sub = sub

    @property
    def headers(self) -> dict[str, str]:
        return bearer(make_token(sub=self.sub))

    # --- 生の応答 ---
    def list(self) -> Response:
        return self.api.get(LIST_PATH, headers=self.headers)

    def messages(self, conversation_id: str) -> Response:
        return self.api.get(messages_path(conversation_id), headers=self.headers)

    def delete(self, conversation_id: str) -> Response:
        return self.api.request("DELETE", conversation_path(conversation_id), headers=self.headers)

    def chat(self, text: str, conversation_id: str | None, history: list[dict] | tuple = ()) -> Response:
        return self.api.post("/api/chat", json=chat_body(text, conversation_id, history), headers=self.headers)

    def chat_raw(self, body: Any) -> Response:
        """本文をそのまま送る（不正な本文の検査用）。"""
        return self.api.post("/api/chat", json=body, headers=self.headers)

    # --- 成功を確かめて、中身を返す ---
    def listed(self) -> list[dict]:
        body = assert_json(self.list())
        assert set(body) == {"conversations"} and isinstance(body["conversations"], list), body
        return body["conversations"]

    def listed_ids(self) -> list[str]:
        return [c["id"] for c in self.listed()]

    def stored(self, conversation_id: str) -> list[dict]:
        body = assert_json(self.messages(conversation_id))
        assert set(body) == {"messages"} and isinstance(body["messages"], list), body
        return body["messages"]

    def say(self, text: str, conversation_id: str | None, history: list[dict] | tuple = ()) -> dict:
        """`conversation_id` つき（None なら無し）で 1 回話しかけて、回答（`message`）を返す。応答の形・結果の形・数字の検査つき。"""
        return chat_support.ask(self.api, text, history, conversation_id=conversation_id, headers=self.headers)
