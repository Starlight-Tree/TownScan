"""GET /api/me（任意のログイン）: JWT を API が JWKS で検証する。構成 main（AUTH_ISSUER・AUTH_JWKS_URL を、偽の JWKS サーバーへ向けて起動）。

偽の JWKS サーバー（support/fakes.py）はこの検査のプロセスの中で動き、鍵は実行ごとに作る。JWKS には、使える鍵（EC P-256・kid あり・署名用）が
2 つ（alg・use が付く鍵と、付かない鍵。Better Auth の実際の出力は付かない形）と、使えない鍵（EdDSA・RSA・P-384・kid 無し・暗号化用）が混ざる。
検証の規則（仕様 §2.1・§4.4）: alg は ES256 だけ（none・HS256・RS256 などは鍵を取りに行く前に断る）、`iss`・`aud`・`exp`・`sub` は必須で完全一致、
時計のずれは 10 秒まで。失敗の理由は返さない（固定の文）。
ログインの設定が無い・不正なとき（noauth・badauth）と、JWKS に届かないとき（jwksdown）は test_me_unconfigured.py。
"""

from __future__ import annotations

import json
import time

import pytest
from cryptography.hazmat.primitives.asymmetric import ec

from support import fakes
from support.checks import assert_error
from support.fakes import bearer, make_token

NOT_LOGGED_IN = {"error": {"code": "unauthorized", "message": "ログインしてください"}}


@pytest.fixture
def me(api, jwks):
    """偽の JWKS サーバーが動いている状態で、/api/me を呼ぶ関数（token を渡すと Bearer で送る）。"""

    def call(token: str | None = None, headers: dict | None = None):
        send = dict(headers or {})
        if token is not None:
            send.update(bearer(token))
        return api.get("/api/me", headers=send)

    return call


def assert_not_logged_in(resp) -> None:
    assert resp.status == 401, resp
    assert resp.json() == NOT_LOGGED_IN  # 固定の文だけ（理由・例外の文字列は無い）
    assert resp.header("www-authenticate") == "Bearer"
    assert resp.header("cache-control") == "no-store"
    assert resp.content_type.startswith("application/json")


# ---- 200 ----

def test_a_valid_token_returns_the_identity(me):
    resp = me(make_token())
    assert resp.status == 200, resp
    assert resp.json() == {
        "sub": fakes.DEFAULT_SUB,
        "email": "tanaka@example.com",
        "name": "田中 太郎",
        "picture": "https://lh3.googleusercontent.com/a/test",
    }
    assert resp.header("cache-control") == "no-store"
    assert resp.content_type.startswith("application/json")


def test_a_token_signed_by_a_key_whose_jwks_entry_has_no_alg_or_use_is_accepted(me):
    # Better Auth の実際の JWKS は alg・use を持たない。使えない鍵が混ざっていても、使える鍵で検証できる
    assert me(make_token(key=fakes.PRIVATE_KEY_PLAIN, kid=fakes.KID_PLAIN)).status == 200


def test_missing_claims_become_null(me):
    resp = me(make_token(email=None, name=None, picture=None))
    assert resp.status == 200
    assert resp.json() == {"sub": fakes.DEFAULT_SUB, "email": None, "name": None, "picture": None}


@pytest.mark.parametrize("scheme", ["Bearer", "bearer", "BEARER"])
def test_the_scheme_is_case_insensitive(me, scheme):
    assert me(headers={"Authorization": f"{scheme} {make_token()}"}).status == 200


def test_audience_may_be_a_list_containing_ours(me):
    assert me(make_token(aud=[fakes.AUDIENCE, "another-app"])).status == 200


def test_a_clock_skew_within_the_leeway_is_accepted(me):
    assert me(make_token(exp=int(time.time()) - 5)).status == 200  # 10 秒までのずれは許す


def test_aud_defaults_to_townscan_when_audience_is_not_configured(me):
    # API は AUTH_AUDIENCE を設定せずに起動している（既定 townscan）
    assert me(make_token(aud="townscan")).status == 200
    assert_not_logged_in(me(make_token(aud="townscan-other")))


# ---- 401（理由は返さない。どの失敗も同じ応答） ----

@pytest.mark.parametrize("headers", [
    {},
    {"Authorization": ""},
    {"Authorization": "Basic abc"},
    {"Authorization": "Token abc"},
    {"Authorization": "Bearer"},
    {"Authorization": "Bearer "},
    {"Authorization": "Bearer a b"},  # トークンが 2 つ
    {"Authorization": "Bearer not-a-jwt"},
    {"Authorization": "Bearer a.b.c"},
    {"Authorization": "Bearer " + "a" * 9000},  # 長すぎる
])
def test_missing_or_malformed_authorization_is_401(me, headers):
    assert_not_logged_in(me(headers=headers))


def test_a_valid_token_in_another_scheme_is_401(me):
    assert_not_logged_in(me(headers={"Authorization": f"Basic {make_token()}"}))


@pytest.mark.parametrize("overrides", [
    pytest.param({"exp": int(time.time()) - 3600}, id="expired"),
    pytest.param({"exp": None}, id="no-exp"),
    pytest.param({"exp": "tomorrow"}, id="exp-not-a-number"),
    pytest.param({"nbf": int(time.time()) + 3600}, id="not-yet-valid"),
    pytest.param({"iat": int(time.time()) + 3600}, id="issued-in-the-future"),
    pytest.param({"aud": "docunavi"}, id="wrong-aud"),
    pytest.param({"aud": None}, id="no-aud"),
    pytest.param({"iss": "http://evil.example"}, id="wrong-iss"),
    pytest.param({"iss": fakes.ISSUER + "/"}, id="iss-with-trailing-slash"),  # 完全一致
    pytest.param({"iss": None}, id="no-iss"),
    pytest.param({"sub": None}, id="no-sub"),
    pytest.param({"sub": "short"}, id="sub-too-short"),
    pytest.param({"sub": "abcdefg"}, id="sub-7-chars"),
    pytest.param({"sub": "a" * 65}, id="sub-65-chars"),
    pytest.param({"sub": "has space in it!"}, id="sub-bad-chars"),
    pytest.param({"sub": 12345678}, id="sub-not-a-string"),
])
def test_bad_claims_are_401(me, overrides):
    assert_not_logged_in(me(make_token(**overrides)))


@pytest.mark.parametrize("sub", ["abcdefgh", "a" * 64, "ba_user-0000_0001", "ABCDEFGH12345678"])
def test_sub_boundaries_that_are_accepted(me, sub):
    resp = me(make_token(sub=sub))
    assert resp.status == 200 and resp.json()["sub"] == sub


@pytest.mark.parametrize("token", [
    pytest.param(lambda: make_token(key=fakes.OTHER_PRIVATE_KEY), id="signed-by-another-key-with-our-kid"),
    pytest.param(lambda: make_token(kid="unknown-kid"), id="unknown-kid"),
    pytest.param(lambda: make_token(kid=None), id="no-kid"),
    pytest.param(fakes.make_unsigned_token, id="alg-none"),
    pytest.param(fakes.make_hs256_token, id="hs256-signed-with-the-public-key"),
    pytest.param(lambda: make_token(key=fakes.RSA_PRIVATE_KEY, alg="RS256"), id="rs256"),
    pytest.param(lambda: make_token(key=fakes.RSA_PRIVATE_KEY, alg="PS256"), id="ps256"),
    pytest.param(lambda: make_token(key=fakes.P384_PRIVATE_KEY, alg="ES384"), id="es384"),
    pytest.param(lambda: make_token(key=ec.generate_private_key(ec.SECP256R1()), kid=fakes.KID_PLAIN), id="plain-key-kid-with-another-signature"),
])
def test_bad_signatures_and_algorithms_are_401(me, token):
    assert_not_logged_in(me(token()))


def test_a_tampered_payload_is_401(me):
    header, _, signature = make_token().split(".")
    forged = fakes.b64(json.dumps(fakes.claims(sub="ba_admin_00000001")).encode())
    assert_not_logged_in(me(f"{header}.{forged}.{signature}"))


# ---- claims から取り出す値（整形の規則。仕様 §4.4） ----

def identity(me, **overrides) -> dict:
    resp = me(make_token(**overrides))
    assert resp.status == 200, resp
    return resp.json()


def test_email_is_kept_as_is_and_the_name_is_trimmed(me):
    got = identity(me, email="Tanaka@Example.com", name=" 田中 太郎 ")
    assert got["email"] == "Tanaka@Example.com" and got["name"] == "田中 太郎"


@pytest.mark.parametrize("picture", [
    "http://example.com/a.png",
    "javascript:alert(1)",
    "https://example.com/" + "a" * 2100,
    "https://example.com/" + "a" * (2049 - len("https://example.com/")),  # 2049 文字
    "   ",
    123,
])
def test_picture_other_than_https_within_2048_characters_is_null(me, picture):
    assert identity(me, picture=picture)["picture"] is None


def test_picture_of_exactly_2048_characters_is_kept(me):
    url = "https://example.com/" + "a" * (2048 - len("https://example.com/"))
    assert identity(me, picture=url)["picture"] == url


def test_the_image_claim_is_used_when_picture_is_absent(me):
    # Better Auth の既定の payload では、画像は claim `image`
    assert identity(me, picture=None, image="https://lh3.googleusercontent.com/a/img")["picture"] == "https://lh3.googleusercontent.com/a/img"


@pytest.mark.parametrize("email", ["not-an-email", "a" * 250 + "@example.com", "a" * 243 + "@example.com", "   ", 123, ["a@example.com"]])
def test_unusable_email_is_null(me, email):
    assert identity(me, email=email)["email"] is None  # @ が無い・254 文字を超える・空・文字列でない


def test_email_of_exactly_254_characters_is_kept(me):
    email = "a" * (254 - len("@example.com")) + "@example.com"
    assert len(email) == 254 and identity(me, email=email)["email"] == email


@pytest.mark.parametrize("raw, name", [
    ("あ" * 150, "あ" * 100),  # 100 文字で切る
    ("😀" * 101, "😀" * 100),  # 文字数はコードポイント
    ("a\nb\tc", "abc"),  # 制御文字は持たない
    ("田中　太郎", "田中太郎"),  # 全角空白も印字できない文字として除く
    ("a​b", "ab"),  # ゼロ幅の文字
    ("   ", None),
    ("\n\t", None),
    (123, None),
])
def test_name_is_a_printable_string_within_100_characters(me, raw, name):
    assert identity(me, name=raw)["name"] == name


def test_email_verified_is_not_exposed(me):
    assert set(identity(me, email_verified=True)) == {"sub", "email", "name", "picture"}


def test_me_rejects_other_methods(api, me):
    me()  # JWKS サーバーを立てておく
    assert_error(api.post("/api/me", headers=bearer(make_token())), 405, "method_not_allowed")
