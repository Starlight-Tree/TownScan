"""実 LLM（Gemini）の経路。実 API は呼ばない: HTTP は、偽の送信関数（GeminiClient の send）か、偽の opener（post_json の下）に差し替える。

確かめること: function calling の往復・結果の形・数字の検査（guard）・範囲外（refuse）・上限・失敗（429・5xx・タイムアウト・壊れた応答）が
502 になること・キーが応答／ログ／例外に出ないこと・既定の模擬モデルが変わらないこと・/api/health の llm・
一時的な失敗（5xx・タイムアウト・接続エラー）だけを、1 回の要求につき 1 回、1 秒待ってやり直すこと（4xx は直さない・要求の期限を超えない）。
再試行の待ちは、sleep の偽物に差し替える（実際には待たない）。
"""

from __future__ import annotations

import copy
import io
import json
import logging
import traceback
import urllib.error
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app import queries
from app.chat import gemini_model
from app.chat.gemini_model import (
    LLM_UNAVAILABLE_MESSAGE,
    MAX_CONTENT_CHARS,
    GeminiClient,
    LlmUnavailable,
    build_system_instruction,
    function_declarations,
    post_json,
    resolve_area_names,
    result_view,
    sanitize_refusal_args,
    to_contents,
    to_gemini_schema,
)
from app.chat.guard import SAFE_TEMPLATE
from app.chat.tools import DEFAULT_SUGGESTIONS, Tool, ToolContext, build_default_registry
from app.config import Settings
from app.main import create_app
from test_api import A1, A2, A3, assert_error
from test_chat import check_result

KEY = "AIzaSyTEST-SECRET-KEY_0123456789abcdef"  # テスト用の作り物。どの出力にも出てはいけない
MODEL = "gemini-test-model"


# ---- 偽の Gemini ----

def fcall(name: str, args: dict | None = None, **extra: Any) -> dict:
    return {"functionCall": {"name": name, "args": args if args is not None else {}, **extra}}


def reply(*parts: dict, finish: str = "STOP") -> dict:
    return {"candidates": [{"content": {"role": "model", "parts": list(parts)}, "finishReason": finish}]}


def say(text: str) -> dict:
    return reply({"text": text})


class FakeGemini:
    """send の偽物。台本（応答・例外・関数）を 1 往復ごとに 1 つ使い、受けた要求を記録する。repeat を渡すと、同じ応答を延々と返す。"""

    def __init__(self, *script: Any, repeat: Any = None):
        self.script = list(script)
        self.repeat = repeat
        self.requests: list[dict] = []

    def __call__(self, url: str, headers: dict, body: dict, timeout: float) -> dict:
        self.requests.append({"url": url, "headers": dict(headers), "body": copy.deepcopy(body), "timeout": timeout})
        step = self.repeat if self.repeat is not None else self.script.pop(0)  # 台本より多く呼ばれたら IndexError で落ちる
        if callable(step):
            step = step(body)
        if isinstance(step, BaseException):
            raise step
        return copy.deepcopy(step)


@pytest.fixture
def sleeps() -> list[float]:
    """再試行の待ち（GeminiClient の sleep）の記録。実際には待たない。"""
    return []


@pytest.fixture
def gemini_app(db_url, tiles_dir, conn, loaded, sleeps):
    """gemini を選んだ API を作る関数。make(send, **client_kwargs) -> TestClient。send は FakeGemini など。
    再試行の待ちは、既定で sleeps に記録するだけ（実際には待たない）。client_kwargs で sleep・clock・deadline などを差し替えられる。"""
    opened: list[TestClient] = []

    def make(send: Any = None, **client_kwargs: Any) -> TestClient:
        settings = Settings(database_url=db_url, tiles_dir=tiles_dir, llm_provider="gemini", gemini_api_key=KEY, gemini_model=MODEL)
        client_kwargs.setdefault("sleep", sleeps.append)
        c = TestClient(create_app(settings, llm=GeminiClient(KEY, MODEL, send=send, **client_kwargs)), raise_server_exceptions=False)
        c.__enter__()
        opened.append(c)
        return c

    yield make
    for c in opened:
        c.__exit__(None, None, None)


def ask(client: TestClient, text: str, history: list[dict] | None = None):
    return client.post("/api/chat", json={"messages": [*(history or []), {"role": "user", "content": text}]})


def ok(client: TestClient, text: str, history: list[dict] | None = None) -> dict:
    r = ask(client, text, history)
    assert r.status_code == 200, r.text
    msg = r.json()["message"]
    assert msg["role"] == "assistant" and len(msg["results"]) == len(msg["tool_calls"]) >= 1
    for res in msg["results"]:
        check_result(res)  # 結果は、模擬モデルのときと同じ §4.5 の形
    return msg


def assert_llm_unavailable(resp, caplog=None):
    err = assert_error(resp, 502, "llm_unavailable")
    assert err["message"] == LLM_UNAVAILABLE_MESSAGE
    assert set(err) == {"code", "message"}  # 原因の詳細・URL を返さない
    assert KEY not in resp.text and "key=" not in resp.text
    if caplog is not None:
        assert KEY not in caplog.text and "key=" not in caplog.text


# ---- (b) 件数の質問: functionCall → 結果 → 文 ----

def test_count_question_runs_the_function_calling_loop(gemini_app):
    fake = FakeGemini(
        reply({**fcall("count_candidates", {"cls": "confirmed_new"}, id="call-1"), "thoughtSignature": "SIG-ABC"}),
        say("新規出現の候補の件数は、下の結果のカードのとおりです。機械の判定で、確定ではありません。"),
    )
    msg = ok(gemini_app(fake), "新規出現の候補は何件ありますか？")
    # 返すもの: 結果は模擬と同じ形（DB から作った count）。文は LLM のもので、数字を含まない
    assert msg["results"][0]["type"] == "count" and msg["results"][0]["total"] == 4
    assert msg["tool_calls"] == [{"name": "count_candidates", "args": {"cls": "confirmed_new"}}]
    assert msg["content"] == "新規出現の候補の件数は、下の結果のカードのとおりです。機械の判定で、確定ではありません。"
    assert not any(ch.isdigit() for ch in msg["content"])

    first, second = fake.requests
    # 送るもの: キーは URL に付けず、ヘッダーで送る。タイムアウトは 20 秒
    for req in fake.requests:
        assert req["url"] == f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"
        assert req["headers"] == {"x-goog-api-key": KEY}
        assert req["timeout"] == 20.0
        assert KEY not in json.dumps(req["body"], ensure_ascii=False)  # キーは本文にも入れない
    body = first["body"]
    assert body["contents"] == [{"role": "user", "parts": [{"text": "新規出現の候補は何件ありますか？"}]}]
    names = {d["name"] for d in body["tools"][0]["functionDeclarations"]}
    assert {"count_candidates", "list_candidates", "compare_areas", "show_candidate", "get_accuracy", "focus_map", "show_help", "refuse"} == names
    system = body["systemInstruction"]["parts"][0]["text"]
    assert "合成町" in system and "試験町" in system and "仮想町" in system and "中央区" in system  # 地区は名前だけ
    # 最初の往復は必ずツールを呼ばせ、結果を渡したあとは、モデルに任せる
    assert first["body"]["toolConfig"]["functionCallingConfig"]["mode"] == "ANY"
    assert second["body"]["toolConfig"]["functionCallingConfig"]["mode"] == "AUTO"
    # 2 回目: モデルの functionCall を、返ってきたとおり（thoughtSignature・id を含む）戻し、結果を functionResponse で渡す
    model_turn, response_turn = second["body"]["contents"][1], second["body"]["contents"][2]
    assert model_turn == {"role": "model", "parts": [{
        "functionCall": {"name": "count_candidates", "args": {"cls": "confirmed_new"}, "id": "call-1"}, "thoughtSignature": "SIG-ABC"}]}
    fr = response_turn["parts"][0]["functionResponse"]
    assert response_turn["role"] == "user" and fr["name"] == "count_candidates" and fr["id"] == "call-1"
    assert fr["response"]["result"]["total"] == 4
    assert "provenance" not in fr["response"]["result"]  # 出どころ・座標・画像の URL は、LLM に見せない


def test_two_parallel_calls_and_a_chained_call(gemini_app):
    fake = FakeGemini(
        reply(fcall("count_candidates", {}), fcall("compare_areas", {"cls": "confirmed_new"})),
        reply(fcall("list_candidates", {"limit": 2})),
        say("件数と比較と一覧を、下のカードにまとめました。"),
    )
    msg = ok(gemini_app(fake), "件数と地区の比較と一覧を見せて")
    assert [c["name"] for c in msg["tool_calls"]] == ["count_candidates", "compare_areas", "list_candidates"]
    assert [r["type"] for r in msg["results"]] == ["count", "compare", "table"]
    assert msg["results"][2]["shown"] == 2
    # 並列の functionCall には、functionResponse を 1 つの user の発言にまとめて返す
    replies = fake.requests[1]["body"]["contents"][2]
    assert replies["role"] == "user" and [p["functionResponse"]["name"] for p in replies["parts"]] == ["count_candidates", "compare_areas"]


def test_area_names_are_turned_into_ids_and_unknown_arguments_are_dropped(gemini_app):
    fake = FakeGemini(
        reply(fcall("count_candidates", {"area_ids": ["合成町"], "cls": "confirmed_new", "evil": {"x": 1}})),
        say("合成町の件数です。結果のとおりです。"),
    )
    msg = ok(gemini_app(fake), "合成町の新規出現は？")
    assert msg["tool_calls"][0]["args"] == {"area_ids": [A1], "cls": "confirmed_new"}
    r = msg["results"][0]
    assert r["total"] == 1 and r["filter"] == {"area_id": A1, "cls": "confirmed_new", "scope": "合成町"}


def test_ward_and_id_arguments_work_and_unknown_tools_are_refused(gemini_app):
    fake = FakeGemini(
        reply(fcall("count_candidates", {"ward": "東区"}), fcall("count_candidates", {"area_ids": [A2]}), fcall("rm_rf", {"path": "/"})),
        say("結果のとおりです。"),
    )
    client = gemini_app(fake)
    totals = {a["id"]: a["counts"]["total"] for a in client.get("/api/areas").json()}
    msg = ok(client, "いろいろ")
    assert msg["results"][0]["total"] == totals[A3] and msg["results"][0]["filter"]["scope"] == "東区"
    assert msg["results"][1]["total"] == totals[A2] and msg["results"][1]["filter"]["area_id"] == A2
    assert msg["results"][2]["type"] == "refusal" and msg["tool_calls"][2] == {"name": "rm_rf", "args": {}}  # 知らないツール・引数は、断りの結果になる


def test_a_tool_that_raises_on_odd_arguments_becomes_a_refusal(gemini_app, caplog):
    caplog.set_level(logging.WARNING, logger="townscan")

    def boom(ctx, args):
        raise TypeError("unhashable type: 'dict'")

    fake = FakeGemini(reply(fcall("boom", {"x": {"a": 1}})), say("結果のとおりです。"))
    client = gemini_app(fake)
    client.app.state.registry.register(Tool("boom", "テスト用", {"type": "object", "properties": {"x": {"type": "object"}}}, boom))
    msg = ok(client, "ためす")
    assert msg["results"][0]["type"] == "refusal" and msg["results"][0]["reason"] == "out_of_scope"
    assert "boom" in caplog.text and "TypeError" in caplog.text


def test_wrongly_typed_arguments_do_not_become_a_500(gemini_app):
    fake = FakeGemini(reply(fcall("count_candidates", {"area_ids": [{"a": 1}]}), fcall("list_candidates", {"limit": "5", "cls": ["x"]})), say("結果のとおりです。"))
    msg = ok(gemini_app(fake), "変な引数")
    assert all(r["type"] in ("refusal", "table") for r in msg["results"])


# ---- (c) LLM が結果に無い数字を書いた文 → guard がテンプレートに替える ----

def test_a_number_the_model_invented_is_replaced_by_the_safe_template(gemini_app, caplog):
    caplog.set_level(logging.WARNING, logger="townscan")
    fake = FakeGemini(reply(fcall("count_candidates", {"cls": "confirmed_new"})), say("新規出現の候補は 7,777 件です。"))
    msg = ok(gemini_app(fake), "新規出現は何件？")
    assert msg["content"] == SAFE_TEMPLATE and msg["results"][0]["total"] == 4  # 結果は DB の値のまま
    assert "LLM の返答文を安全なテンプレートに差し替えました（通算 " in caplog.text
    assert "新規出現の候補は" not in caplog.text  # 数えるだけ。LLM の文（本文）はログに出さない


@pytest.mark.parametrize("invented", ["候補は 5 件です。", "約 12.5 m² です。", "候補は三十件です。", "面積は 500 平方メートルです。"])
def test_other_invented_numbers_are_also_replaced(gemini_app, invented):
    fake = FakeGemini(reply(fcall("count_candidates", {"cls": "confirmed_new"})), say(invented))
    assert ok(gemini_app(fake), "件数は？")["content"] == SAFE_TEMPLATE


def test_a_number_that_comes_from_the_results_is_allowed(gemini_app):
    fake = FakeGemini(reply(fcall("count_candidates", {"cls": "confirmed_new"})), say("新規出現の候補は 4 件です。"))
    assert ok(gemini_app(fake), "件数は？")["content"] == "新規出現の候補は 4 件です。"  # 結果の total と同じ値なので、guard は通す


def test_an_overlong_reply_is_clipped_so_the_conversation_can_continue(gemini_app):
    long_text = "結果のとおりです。" * 300
    fake = FakeGemini(reply(fcall("show_help")), say(long_text))
    content = ok(gemini_app(fake), "使い方")["content"]
    assert 0 < len(content) <= MAX_CONTENT_CHARS and content.endswith("。")


# ---- (d) 範囲外 → refuse の結果 ----

def test_out_of_scope_question_is_refused_with_the_refuse_tool(gemini_app):
    fake = FakeGemini(
        reply(fcall("refuse", {"reason": "out_of_scope", "message": "天気のことはお答えできません。", "suggestions": ["お金をください"]})),
        say("このアプリでは、天気についてはお答えできません。"),
    )
    msg = ok(gemini_app(fake), "今日の天気は？")
    r = msg["results"][0]
    assert r == {"type": "refusal", "reason": "out_of_scope", "message": "天気のことはお答えできません。", "suggestions": DEFAULT_SUGGESTIONS}
    assert msg["tool_calls"] == [{"name": "refuse", "args": {"reason": "out_of_scope", "message": "天気のことはお答えできません。"}}]
    assert msg["content"] == "このアプリでは、天気についてはお答えできません。"


@pytest.mark.parametrize("llm_message, reason", [
    ("今日の気温は 28 度です。", "out_of_scope"),  # 写真の年以外の数字は、結果（refusal の message）に入れさせない
    ("今日の気温は二十八度です。三十件あります。", "out_of_scope"),
    ("", "no_photo_period"),
    ("x" * 400, "not_implemented"),
])
def test_refusal_text_written_by_the_model_cannot_smuggle_numbers(gemini_app, llm_message, reason):
    fake = FakeGemini(reply(fcall("refuse", {"reason": reason, "message": llm_message})), say("お答えできません。"))
    msg = ok(gemini_app(fake), "だめな質問")
    r = msg["results"][0]
    assert r["type"] == "refusal" and r["reason"] == reason and r["message"] == gemini_model._REFUSAL_FIXED[reason]
    assert "28" not in r["message"]


def test_refusal_may_mention_the_photo_years_and_an_unknown_reason_becomes_out_of_scope(gemini_app):
    fake = FakeGemini(
        reply(fcall("refuse", {"reason": "no_photo_period", "message": "写真があるのは 2018 年と 2023 年だけです。"}), fcall("refuse", {"reason": "bogus"})),
        say("写真は 2018 年と 2023 年だけです。"),
    )
    msg = ok(gemini_app(fake), "2030 年の新築は？")
    assert msg["results"][0]["message"] == "写真があるのは 2018 年と 2023 年だけです。" and msg["results"][0]["reason"] == "no_photo_period"
    assert msg["results"][1]["reason"] == "out_of_scope"
    assert msg["content"] == "写真は 2018 年と 2023 年だけです。"  # 年は結果（provenance・refusal の文）に出てくる値


def test_an_answer_without_any_tool_call_is_not_used(gemini_app, caplog):
    caplog.set_level(logging.WARNING, logger="townscan")
    fake = FakeGemini(say("たぶん百件くらいです。"))
    assert_llm_unavailable(ask(gemini_app(fake), "件数は？"), caplog)
    assert "種別=no_tool_call" in caplog.text


# ---- (e) 上限 ----

def test_endless_function_calls_end_in_a_502_after_the_round_limit(gemini_app, caplog):
    caplog.set_level(logging.WARNING, logger="townscan")
    fake = FakeGemini(repeat=reply(fcall("show_help")))
    assert_llm_unavailable(ask(gemini_app(fake), "使い方"), caplog)
    assert len(fake.requests) == gemini_model.MAX_ROUNDS == 4
    assert "種別=too_many_rounds" in caplog.text


def test_tool_call_limit_is_six_per_question(gemini_app, caplog):
    caplog.set_level(logging.WARNING, logger="townscan")
    six = FakeGemini(reply(*[fcall("show_help")] * 6), say("結果のとおりです。"))
    assert len(ok(gemini_app(six), "使い方")["tool_calls"]) == 6
    seven = FakeGemini(reply(*[fcall("show_help")] * 7), say("結果のとおりです。"))
    assert_llm_unavailable(ask(gemini_app(seven), "使い方"), caplog)
    assert len(seven.requests) == 1 and "種別=too_many_tool_calls" in caplog.text
    across = FakeGemini(reply(*[fcall("show_help")] * 4), reply(*[fcall("show_help")] * 3), say("結果のとおりです。"))
    assert_llm_unavailable(ask(gemini_app(across), "使い方"))  # 往復をまたいでも、合計で数える
    assert len(across.requests) == 2


# ---- (f) 失敗: 429・5xx・タイムアウト・壊れた応答 → 502。本文・ログにキーが無い ----

class FakeResponse:
    def __init__(self, raw: bytes):
        self._raw = raw

    def read(self, n: int = -1) -> bytes:
        return self._raw if n is None or n < 0 else self._raw[:n]

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *exc: object) -> bool:
        return False


class FakeOpener:
    """urllib の opener の偽物（post_json の下を差し替える）。behavior は、受けた要求から応答か例外を作る関数。"""

    def __init__(self, behavior: Any):
        self.behavior = behavior
        self.requests: list[Any] = []

    def open(self, request: Any, timeout: float | None = None) -> Any:
        self.requests.append((request, timeout))
        out = self.behavior(request)
        if isinstance(out, BaseException):
            raise out
        return out


def http_error(request: Any, code: int, status: str = "", reason: str = "") -> urllib.error.HTTPError:
    # Google の本文は message にキーを含みうる。HTTPError の url・msg にも、キーを入れておく（出さないことを確かめるため）
    err = {"code": code, "message": f"Quota exceeded for key {KEY}", "status": status}
    if reason:
        err["details"] = [{"@type": "type.googleapis.com/google.rpc.ErrorInfo", "reason": reason}]
    return urllib.error.HTTPError(f"{request.full_url}?key={KEY}", code, f"Error key={KEY}", {}, io.BytesIO(json.dumps({"error": err}).encode()))


def good_response() -> FakeResponse:
    return FakeResponse(json.dumps(say("結果のとおりです。")).encode())


FAILURES = {
    "429": (lambda r: http_error(r, 429, "RESOURCE_EXHAUSTED"), "rate_limit", "RESOURCE_EXHAUSTED"),
    "500": (lambda r: http_error(r, 500, "INTERNAL"), "server", "INTERNAL"),
    "503": (lambda r: http_error(r, 503, "UNAVAILABLE"), "server", "UNAVAILABLE"),
    "504": (lambda r: http_error(r, 504), "server", None),
    "401": (lambda r: http_error(r, 401, "UNAUTHENTICATED"), "auth", "UNAUTHENTICATED"),
    "403": (lambda r: http_error(r, 403, "PERMISSION_DENIED"), "auth", "PERMISSION_DENIED"),
    "400-invalid-key": (lambda r: http_error(r, 400, "INVALID_ARGUMENT", "API_KEY_INVALID"), "bad_request", "INVALID_ARGUMENT/API_KEY_INVALID"),
    "404": (lambda r: http_error(r, 404, "NOT_FOUND"), "not_found", "NOT_FOUND"),
    "302": (lambda r: http_error(r, 302), "http_error", None),  # リダイレクトは追わない（キーを別のホストへ送らない）
    "timeout": (lambda r: TimeoutError(f"timed out {KEY}"), "timeout", None),
    "url-timeout": (lambda r: urllib.error.URLError(TimeoutError(f"timed out {KEY}")), "timeout", None),
    "refused": (lambda r: urllib.error.URLError(ConnectionRefusedError(f"refused {KEY}")), "network", None),
    "oserror": (lambda r: OSError(f"reset {KEY}"), "network", None),
    "bad-header": (lambda r: ValueError(f"Invalid header value {KEY!r}"), "network", None),
    "broken-json": (lambda r: FakeResponse(b'{"candidates": [ {"con'), "invalid_json", None),
    "not-json": (lambda r: FakeResponse(b"<html>Bad Gateway</html>"), "invalid_json", None),
    "json-list": (lambda r: FakeResponse(b"[1, 2, 3]"), "invalid_json", None),
    "empty-body": (lambda r: FakeResponse(b""), "invalid_json", None),
    "too-large": (lambda r: FakeResponse(b" " * (gemini_model.MAX_RESPONSE_BYTES + 5)), "too_large", None),
}


@pytest.mark.parametrize("name", list(FAILURES))
def test_http_failures_are_a_502_without_the_key_and_never_fall_back_to_the_mock(gemini_app, monkeypatch, caplog, sleeps, name):
    caplog.set_level(logging.DEBUG, logger="townscan")
    behavior, kind, reason = FAILURES[name]
    opener = FakeOpener(behavior)
    monkeypatch.setattr(gemini_model, "_OPENER", opener)
    client = gemini_app(send=None)  # 本物の post_json（opener だけが偽物）
    resp = ask(client, "新規出現は何件？")
    assert_llm_unavailable(resp, caplog)
    assert f"種別={kind}" in caplog.text and (reason is None or f"理由={reason}" in caplog.text)
    # 一時的な失敗（5xx・タイムアウト・接続エラー）だけ、1 秒待って 1 回やり直す。4xx・壊れた応答は、やり直さない。どちらも最後は 502
    transient = kind in {"server", "timeout", "network"}
    assert len(opener.requests) == (2 if transient else 1)
    assert sleeps == ([1.0] if transient else [])
    assert ("やり直します" in caplog.text) == transient
    # 要求の形: キーは URL でなくヘッダー。本物の post_json が組んだ要求を見る（やり直しの要求も同じ）
    for request, timeout in opener.requests:
        assert "key=" not in request.full_url and KEY not in request.full_url and timeout == 20.0
        assert dict(request.header_items())["X-goog-api-key"] == KEY
        assert request.get_method() == "POST"


def test_a_good_response_through_the_real_post_json_path(gemini_app, monkeypatch):
    responses = iter([FakeResponse(json.dumps(reply(fcall("show_help"))).encode()), good_response()])
    monkeypatch.setattr(gemini_model, "_OPENER", FakeOpener(lambda r: next(responses)))
    msg = ok(gemini_app(send=None), "使い方")
    assert msg["results"][0]["type"] == "table" and msg["content"] == "結果のとおりです。"


def test_the_exception_carries_no_cause_and_no_key(monkeypatch):
    # post_json は except の外で raise する: 例外の __cause__・__context__ に、キーを含みうる元の例外が残らない
    monkeypatch.setattr(gemini_model, "_OPENER", FakeOpener(lambda r: http_error(r, 429, "RESOURCE_EXHAUSTED")))
    with pytest.raises(LlmUnavailable) as caught:
        post_json("https://example.invalid/m:generateContent", {"x-goog-api-key": KEY}, {"contents": []}, 1.0)
    exc = caught.value
    assert exc.__cause__ is None and exc.__context__ is None
    text = "".join(traceback.format_exception(exc)) + str(exc) + repr(exc) + repr(vars(exc))
    assert KEY not in text and "key=" not in text
    assert (exc.kind, exc.status, exc.reason) == ("rate_limit", 429, "RESOURCE_EXHAUSTED")


def test_redirects_are_not_followed():
    handler = gemini_model._NoRedirect()
    assert handler.redirect_request(object(), None, 302, "Found", {}, "https://evil.example/") is None


def test_the_reason_is_logged_only_when_it_is_a_google_constant():
    assert gemini_model._error_reason(b'{"error": {"status": "INVALID_ARGUMENT", "message": "key AIza..."}}') == "INVALID_ARGUMENT"
    assert gemini_model._error_reason(json.dumps({"error": {"status": f"bad {KEY}", "details": [{"reason": KEY}]}}).encode()) is None
    assert gemini_model._error_reason(b"not json") is None
    assert LlmUnavailable("server", reason="has space").reason is None


@pytest.mark.parametrize("bad_response, kind", [
    ({}, "no_candidates"),
    ({"candidates": []}, "no_candidates"),
    ({"promptFeedback": {"blockReason": "SAFETY"}}, "blocked"),
    ({"candidates": [{"finishReason": "SAFETY"}]}, "empty_content"),
    ({"candidates": [{"content": {"parts": []}, "finishReason": "MAX_TOKENS"}]}, "empty_content"),
    ({"candidates": [{"content": {"parts": ["not a dict"]}}]}, "empty_content"),
    (reply({"text": "   "}), "empty_text"),
    (reply({"functionCall": {"args": {}}}), "invalid_function_call"),
    (reply({"functionCall": {"name": 5}}), "invalid_function_call"),
])
def test_unusable_model_responses_are_a_502(gemini_app, caplog, bad_response, kind):
    caplog.set_level(logging.WARNING, logger="townscan")
    assert_llm_unavailable(ask(gemini_app(FakeGemini(bad_response)), "件数は？"), caplog)
    assert f"種別={kind}" in caplog.text


def test_failure_after_the_first_round_is_also_a_502_and_returns_no_partial_answer(gemini_app, caplog):
    caplog.set_level(logging.WARNING, logger="townscan")
    # 2 往復目の 503 は、やり直しても 503（3 回目の呼び出し）。部分的な答えは返さない
    fake = FakeGemini(reply(fcall("show_help")), LlmUnavailable("server", 503, "UNAVAILABLE"), LlmUnavailable("server", 503, "UNAVAILABLE"))
    resp = ask(gemini_app(fake), "使い方")
    assert_llm_unavailable(resp, caplog)
    assert "message" not in resp.json() and len(fake.requests) == 3


def test_a_failed_request_does_not_break_the_next_one(gemini_app):
    fake = FakeGemini(LlmUnavailable("rate_limit", 429), reply(fcall("show_help")), say("結果のとおりです。"))
    client = gemini_app(fake)
    assert_llm_unavailable(ask(client, "使い方"))
    assert ok(client, "使い方")["content"] == "結果のとおりです。"


# ---- 再試行: 一時的な失敗（5xx・タイムアウト・接続エラー）だけ・チャット 1 回の要求につき最大 1 回・期限つき ----
# 待ちは、sleep の偽物（記録するだけ）に差し替える。実ネットワークも、実際の待ちも使わない。

class FakeClock:
    """時計と sleep の偽物。sleep は、記録して時計を進めるだけ。after() で、遅い呼び出しを真似る。"""

    def __init__(self) -> None:
        self.now = 1000.0
        self.sleeps: list[float] = []

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds

    def after(self, seconds: float, outcome: Any):
        """FakeGemini の台本の 1 歩: seconds 秒かかってから、outcome（応答か例外）になる。"""
        def step(body: dict) -> Any:
            self.now += seconds
            return outcome
        return step


def test_a_503_is_retried_once_after_one_second_and_the_second_try_succeeds(gemini_app, sleeps, caplog):
    caplog.set_level(logging.WARNING, logger="townscan")
    fake = FakeGemini(LlmUnavailable("server", 503, "UNAVAILABLE"), reply(fcall("show_help")), say("結果のとおりです。"))
    msg = ok(gemini_app(fake), "使い方")
    assert msg["content"] == "結果のとおりです。" and msg["results"][0]["type"] == "table"
    assert sleeps == [1.0]  # 1 秒待った（実際には待たない）
    assert len(fake.requests) == 3 and fake.requests[0]["body"] == fake.requests[1]["body"]  # やり直しは、同じ本文を送る
    # やり直したことは、種別つきでログに残る（成功しても残る）。キー・URL・本文は出ない
    assert "種別=server HTTP=503 理由=UNAVAILABLE" in caplog.text and "やり直します" in caplog.text
    assert KEY not in caplog.text and "key=" not in caplog.text


def test_503_after_the_retry_is_a_502_and_the_retry_is_logged(gemini_app, sleeps, caplog):
    caplog.set_level(logging.WARNING, logger="townscan")
    fake = FakeGemini(LlmUnavailable("server", 503, "UNAVAILABLE"), LlmUnavailable("server", 503, "UNAVAILABLE"))
    resp = ask(gemini_app(fake), "使い方")
    assert_llm_unavailable(resp, caplog)  # 502・固定のメッセージ・キーが出ない・模擬には切り替えない（"message" の答えが無い）
    assert "message" not in resp.json()
    assert len(fake.requests) == 2 and sleeps == [1.0]  # 再試行は 1 回だけ
    assert caplog.text.count("やり直します") == 1 and caplog.text.count("種別=server HTTP=503") == 2  # やり直しの行と、最後の失敗の行


@pytest.mark.parametrize("kind, status", [
    ("rate_limit", 429),  # 無料枠の上限は、待っても直らない
    ("auth", 403),
    ("bad_request", 400),
    ("not_found", 404),
    ("http_error", 302),
    ("invalid_json", None),
    ("too_large", None),
])
def test_other_failures_are_not_retried(gemini_app, sleeps, kind, status):
    fake = FakeGemini(LlmUnavailable(kind, status))  # 2 回目を呼ぶと、台本が尽きて IndexError → 502 でなく 500 になる
    assert_llm_unavailable(ask(gemini_app(fake), "使い方"))
    assert len(fake.requests) == 1 and sleeps == []


@pytest.mark.parametrize("kind", ["timeout", "network", "server"])
def test_a_timeout_or_connection_error_is_retried_and_the_second_try_succeeds(gemini_app, sleeps, caplog, kind):
    caplog.set_level(logging.WARNING, logger="townscan")
    fake = FakeGemini(LlmUnavailable(kind), reply(fcall("show_help")), say("結果のとおりです。"))
    assert ok(gemini_app(fake), "使い方")["content"] == "結果のとおりです。"
    assert sleeps == [1.0] and len(fake.requests) == 3
    assert f"種別={kind}" in caplog.text and "やり直します" in caplog.text


def test_at_most_one_retry_per_request_not_per_round(gemini_app, sleeps):
    # 1 往復目は、1 回失敗してやり直して成功。2 往復目で失敗しても、この要求の再試行は使い切っているので、やり直さず 502
    fake = FakeGemini(LlmUnavailable("server", 503), reply(fcall("show_help")), LlmUnavailable("timeout"))
    resp = ask(gemini_app(fake), "使い方")
    assert_llm_unavailable(resp)
    assert len(fake.requests) == 3 and sleeps == [1.0]


def test_each_request_has_its_own_retry(gemini_app, sleeps):
    fake = FakeGemini(
        LlmUnavailable("server", 503), reply(fcall("show_help")), say("結果のとおりです。"),
        LlmUnavailable("timeout"), reply(fcall("show_help")), say("結果のとおりです。"),
    )
    client = gemini_app(fake)
    assert ok(client, "使い方")["content"] == "結果のとおりです。"
    assert ok(client, "使い方")["content"] == "結果のとおりです。"  # 前の要求が再試行を使ったことは、次の要求に響かない
    assert sleeps == [1.0, 1.0] and len(fake.requests) == 6


def test_the_default_wait_is_time_sleep(monkeypatch):
    waited: list[float] = []
    monkeypatch.setattr(gemini_model.time, "sleep", waited.append)  # 差し替えなければ、本当に 1 秒待つ
    fake = FakeGemini(LlmUnavailable("server", 503), say("結果のとおりです。"))
    assert GeminiClient(KEY, MODEL, send=fake).generate({"contents": []}) == say("結果のとおりです。")
    assert waited == [1.0] and len(fake.requests) == 2


def test_the_failure_after_the_retry_is_the_last_one_and_carries_no_cause():
    fake = FakeGemini(LlmUnavailable("server", 503, "UNAVAILABLE"), LlmUnavailable("timeout"))
    waited: list[float] = []
    with pytest.raises(LlmUnavailable) as caught:
        GeminiClient(KEY, MODEL, send=fake, sleep=waited.append).generate({"contents": []})
    exc = caught.value
    assert (exc.kind, exc.status) == ("timeout", None) and exc.__cause__ is None and exc.__context__ is None  # 最後の失敗。前の失敗を引きずらない
    assert KEY not in "".join(traceback.format_exception(exc)) + repr(vars(exc))


def test_the_retry_wait_is_taken_from_the_remaining_deadline():
    # 20 秒のタイムアウトのあと 1 秒待つと、残りは 27 - 21 = 6 秒。やり直しの待ちは、その残りを超えない
    clock = FakeClock()
    fake = FakeGemini(clock.after(20.0, LlmUnavailable("timeout")), clock.after(2.0, say("結果のとおりです。")))
    client = GeminiClient(KEY, MODEL, send=fake, sleep=clock.sleep, clock=clock)
    assert client.generate({"contents": []}) == say("結果のとおりです。")
    assert [r["timeout"] for r in fake.requests] == [20.0, 6.0] and clock.sleeps == [1.0]


def test_a_request_with_a_retry_never_runs_past_the_deadline():
    clock = FakeClock()
    start = clock.now
    # 20 秒のタイムアウト → 1 秒待つ → 残り 6 秒の呼び出しも、6 秒（その上限いっぱい）で失敗
    fake = FakeGemini(clock.after(20.0, LlmUnavailable("timeout")), clock.after(6.0, LlmUnavailable("timeout")))
    client = GeminiClient(KEY, MODEL, send=fake, sleep=clock.sleep, clock=clock)
    with pytest.raises(LlmUnavailable) as caught:
        client.generate({"contents": []})
    assert caught.value.kind == "timeout" and len(fake.requests) == 2
    assert clock.now - start == gemini_model.REQUEST_DEADLINE_SECONDS == 27.0
    # つまり、各呼び出しが渡した待ちの内に終わる限り、最悪でも、Next.js の転送の待ち（既定 30 秒）より前に、API が 502 を返せる


@pytest.mark.parametrize("slow, retried", [
    (21.0, True),  # 残り 6 秒 - 待ち 1 秒 = 5 秒（新しい呼び出しの最小）。ちょうど足りる
    (21.5, False),  # 残り 5.5 秒 - 待ち 1 秒 = 4.5 秒。足りないので、やり直さず、最初の失敗のまま
    (26.0, False),
])
def test_no_retry_when_too_little_of_the_deadline_is_left(slow, retried):
    clock = FakeClock()
    fake = FakeGemini(clock.after(slow, LlmUnavailable("server", 503)), clock.after(1.0, say("結果のとおりです。")))
    client = GeminiClient(KEY, MODEL, send=fake, sleep=clock.sleep, clock=clock)
    if retried:
        assert client.generate({"contents": []}) == say("結果のとおりです。")
        assert clock.sleeps == [1.0] and [r["timeout"] for r in fake.requests] == [20.0, 5.0]
    else:
        with pytest.raises(LlmUnavailable) as caught:
            client.generate({"contents": []})
        assert (caught.value.kind, caught.value.status) == ("server", 503)
        assert clock.sleeps == [] and len(fake.requests) == 1


def test_the_whole_request_has_a_deadline_across_rounds(gemini_app, caplog):
    # 失敗が無くても、1 往復目に 23 秒かかったら、残り 4 秒では 2 往復目を始めず、502（種別は deadline）にする
    caplog.set_level(logging.WARNING, logger="townscan")
    clock = FakeClock()
    fake = FakeGemini(clock.after(23.0, reply(fcall("show_help"))), say("結果のとおりです。"))
    resp = ask(gemini_app(fake, clock=clock), "使い方")
    assert_llm_unavailable(resp, caplog)
    assert len(fake.requests) == 1 and "種別=deadline" in caplog.text


def test_a_slow_but_in_time_request_is_not_cut(gemini_app):
    clock = FakeClock()
    fake = FakeGemini(clock.after(10.0, reply(fcall("show_help"))), clock.after(10.0, say("結果のとおりです。")))
    msg = ok(gemini_app(fake, clock=clock), "使い方")  # 合計 20 秒。期限（27 秒）の内
    assert msg["content"] == "結果のとおりです。"
    assert [r["timeout"] for r in fake.requests] == [20.0, 17.0]  # 2 回目の待ちは、残りの期限（27 - 10）まで


# ---- データが無いとき: LLM を呼ばない ----

def test_no_data_does_not_call_the_llm(db_url, tiles_dir, conn):
    fake = FakeGemini()
    settings = Settings(database_url=db_url, tiles_dir=tiles_dir, llm_provider="gemini", gemini_api_key=KEY, gemini_model=MODEL)
    with TestClient(create_app(settings, llm=GeminiClient(KEY, MODEL, send=fake)), raise_server_exceptions=False) as client:
        msg = ok(client, "件数は？")
    assert msg["results"][0]["reason"] == "no_data" and fake.requests == []


# ---- 会話の送り方 ----

def test_history_is_sent_as_user_and_model_turns_and_limited_to_the_last_twenty(gemini_app):
    history = [{"role": "user" if i % 2 == 0 else "assistant", "content": f"発言{i}"} for i in range(30)]
    fake = FakeGemini(reply(fcall("show_help")), say("結果のとおりです。"))
    ok(gemini_app(fake), "最後の質問", history)
    contents = fake.requests[0]["body"]["contents"]
    # 31 件の末尾 20 件（発言11〜）のうち、先頭の model（発言11）は捨てる。残りは user と model が交互に並ぶ
    assert contents[0] == {"role": "user", "parts": [{"text": "発言12"}]} and contents[-1] == {"role": "user", "parts": [{"text": "最後の質問"}]}
    assert [c["role"] for c in contents] == ["user", "model"] * 9 + ["user"] and len(contents) == 19


def test_to_contents_merges_same_roles_drops_empty_and_starts_with_user():
    contents = to_contents([
        {"role": "assistant", "content": "前の答え"},  # 先頭が model のときは捨てる
        {"role": "user", "content": "質問 1"},
        {"role": "user", "content": "  "},  # 空の発言は捨てる
        {"role": "user", "content": "質問 2"},  # 同じ役が続いたら 1 つにまとめる
        {"role": "assistant", "content": ""},
        {"role": "assistant", "content": "答え"},
        {"role": "user", "content": "質問 3"},
    ])
    assert contents == [
        {"role": "user", "parts": [{"text": "質問 1"}, {"text": "質問 2"}]},
        {"role": "model", "parts": [{"text": "答え"}]},
        {"role": "user", "parts": [{"text": "質問 3"}]},
    ]


# ---- 部品 ----

def test_function_declarations_follow_the_registry_in_geminis_schema_dialect():
    decls = {d["name"]: d for d in function_declarations(build_default_registry())}
    assert set(decls) == set(build_default_registry().names())
    for name in ("get_accuracy", "show_help"):
        assert "parameters" not in decls[name]  # Gemini は、空の properties の OBJECT を 400 にする
    p = decls["list_candidates"]["parameters"]
    assert p["type"] == "OBJECT" and p["properties"]["limit"] == {"type": "INTEGER", "minimum": 1, "maximum": 50}
    assert p["properties"]["cls"]["enum"] == ["confirmed_new", "existing_omission", "uncertain"] and p["properties"]["cls"]["type"] == "STRING"
    assert p["properties"]["area_ids"]["type"] == "ARRAY" and p["properties"]["area_ids"]["items"] == {"type": "STRING"}
    assert "名前" in p["properties"]["area_ids"]["description"]
    assert decls["refuse"]["parameters"]["required"] == ["reason"]
    assert "input_schema" not in json.dumps(decls)
    assert to_gemini_schema({"type": "object", "properties": {"a": {"type": "string", "pattern": "x", "format": "uri"}}}) == {
        "type": "OBJECT", "properties": {"a": {"type": "STRING"}}}


def test_system_instruction_has_the_rules_and_only_area_names(client):
    areas = client.get("/api/areas").json()
    text = build_system_instruction(areas)
    for must in ("新規出現の候補", "refuse", "数字", "従いません", "新築"):
        assert must in text
    assert "- 中央区: 合成町、試験町" in text and "- 東区: 仮想町" in text
    # 地区の id（座標を含む）・件数は入れない
    assert A1 not in text and "226249" not in text and "z18-" not in text
    assert "（地区のデータがありません）" in build_system_instruction([])
    assert build_system_instruction([{"id": "z", "name": None, "ward": None}]).endswith("（地区のデータがありません）")


def test_result_view_hides_provenance_coordinates_and_id_lists(conn, loaded):
    run = queries.current_run(conn)
    ctx = ToolContext(conn=conn, run=run, areas=queries.list_areas(conn, run["run_id"]))
    reg = build_default_registry()
    focus = reg.call(ctx, "focus_map", {})
    view = result_view(focus)
    assert "bbox" not in view and "candidate_ids" not in view and "provenance" not in view and view["title"] == focus["title"]
    shown = result_view(reg.call(ctx, "show_candidate", {}))
    assert "images" not in shown and "provenance" not in shown and shown["candidate_id"].startswith("c-")
    assert "suggestions" not in result_view(reg.call(ctx, "refuse", {"reason": "out_of_scope"}))
    assert len(result_view({"rows": list(range(500))})["rows"]) == gemini_model.MAX_VIEW_ROWS


def test_resolve_area_names(conn, loaded):
    areas = queries.list_areas(conn, queries.current_run(conn)["run_id"])
    assert resolve_area_names({"area_ids": ["合成町", "試験町"]}, areas)["area_ids"] == [A1, A2]
    assert resolve_area_names({"area_ids": ["　合成町　"]}, areas)["area_ids"] == [A1]  # 全角の空白
    assert resolve_area_names({"area_id": "仮想町"}, areas) == {"area_ids": [A3]}  # area_id も area_ids に統一
    assert resolve_area_names({"area_ids": A1}, areas)["area_ids"] == [A1]  # 文字列 1 つでも、ID のままなら通す
    assert resolve_area_names({"area_ids": ["z18-0-0", "存在しない町"]}, areas)["area_ids"] == ["z18-0-0", "存在しない町"]  # 直せないものは、そのまま（registry が断る）
    assert resolve_area_names({"area_ids": [{"a": 1}]}, areas)["area_ids"] == ["{'a': 1}"]
    assert resolve_area_names({"area_ids": []}, areas) == {"area_ids": []}
    assert resolve_area_names({"cls": "uncertain"}, areas) == {"cls": "uncertain"}


def test_sanitize_refusal_args():
    assert sanitize_refusal_args({}) == {"reason": "out_of_scope", "message": gemini_model._REFUSAL_FIXED["out_of_scope"]}
    assert sanitize_refusal_args({"reason": "no_data", "message": " 該当なし。 "}) == {"reason": "no_data", "message": "該当なし。"}
    assert sanitize_refusal_args({"reason": "no_data", "message": ["x"]})["message"] == gemini_model._REFUSAL_FIXED["no_data"]


# ---- (g) 既定は模擬のまま ----

def test_mock_is_still_the_default_and_never_touches_the_network(client, monkeypatch):
    assert client.app.state.llm is None
    monkeypatch.setattr(gemini_model, "post_json", lambda *a, **k: pytest.fail("模擬モデルが、実 LLM の送信を呼びました"))
    monkeypatch.setattr(gemini_model, "_OPENER", FakeOpener(lambda r: pytest.fail("模擬モデルが、ネットワークを開きました")))
    r = client.post("/api/chat", json={"messages": [{"role": "user", "content": "新規出現の候補は何件ありますか？"}]})
    msg = r.json()["message"]
    assert r.status_code == 200 and msg["results"][0]["total"] == 4 and "4 件" in msg["content"]
    assert msg["tool_calls"] == [{"name": "count_candidates", "args": {"cls": "confirmed_new"}}]


# ---- (h) /api/health の llm ----

def test_health_reports_the_mock_provider_by_default(client):
    j = client.get("/api/health").json()
    assert j["llm"] == "mock" and "llm_model" not in j


def test_health_reports_gemini_and_the_model_but_never_the_key(gemini_app):
    resp = gemini_app(FakeGemini()).get("/api/health")
    j = resp.json()
    assert resp.status_code == 200 and j["llm"] == "gemini" and j["llm_model"] == MODEL and j["status"] == "ok"
    assert KEY not in resp.text


def test_health_with_the_db_down_still_names_the_llm_without_the_key(gemini_app):
    client = gemini_app(FakeGemini())
    client.app.state.pool.close()
    resp = client.get("/api/health")
    assert resp.status_code == 503 and resp.json()["llm"] == "gemini" and KEY not in resp.text


def test_the_client_never_shows_its_key():
    c = GeminiClient(KEY, MODEL)
    assert KEY not in repr(c) and KEY not in str(c) and MODEL in repr(c)
    assert KEY not in repr(Settings(database_url="postgresql://u:p@db/x", llm_provider="gemini", gemini_api_key=KEY))


def test_build_llm_client_only_for_gemini():
    base = {"database_url": "postgresql://u:p@db/x"}
    assert gemini_model.build_llm_client(Settings(**base)) is None
    c = gemini_model.build_llm_client(Settings(**base, llm_provider="gemini", gemini_api_key=KEY, gemini_model="m-1"))
    assert isinstance(c, GeminiClient) and c.model == "m-1"
