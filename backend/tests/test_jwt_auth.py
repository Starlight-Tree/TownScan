"""JWT の検証（app/jwt_auth.py）。DB は使わない。Better Auth の代わりに、テストの中で作った鍵と JWKS を使う（jwt_tokens.py・conftest の jwks_fetches）。"""

from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec

import jwt_tokens
from app import jwt_auth
from app.config import AuthConfig
from jwt_tokens import make_token


@pytest.fixture
def verifier(auth_config, jwks_fetches) -> jwt_auth.JwtVerifier:
    return jwt_auth.JwtVerifier(auth_config)


@pytest.fixture
def clock(monkeypatch) -> list[float]:
    """時計（秒）。進めるには clock[0] を足す。"""
    now = [1000.0]
    monkeypatch.setattr(jwt_auth, "_now", lambda: now[0])
    return now


def down(url: str):
    raise OSError("connection refused: http://secret-host.internal/api/auth/jwks")


# ---- 正常 ----


def test_valid_token_gives_identity(verifier):
    ident = verifier.verify(make_token(email="Tanaka@Example.com", name=" 田中 太郎 "))
    assert ident == jwt_auth.Identity(
        sub="ba_user_0000000001",
        email="Tanaka@Example.com",  # メールは、そのまま返す（前後の空白だけ除く）
        name="田中 太郎",
        picture="https://lh3.googleusercontent.com/a/test",
    )
    assert ident.as_dict() == {
        "sub": "ba_user_0000000001",
        "email": "Tanaka@Example.com",
        "name": "田中 太郎",
        "picture": "https://lh3.googleusercontent.com/a/test",
    }


def test_audience_may_be_a_list_containing_ours(verifier):
    assert verifier.verify(make_token(aud=[jwt_tokens.AUDIENCE, "another-app"])).sub == jwt_tokens.DEFAULT_SUB


def test_clock_skew_within_leeway_is_accepted(verifier):
    assert verifier.verify(make_token(exp=int(time.time()) - 5)).sub == jwt_tokens.DEFAULT_SUB


def test_jwks_without_alg_and_use_is_readable(auth_config, monkeypatch):
    # 実際の Better Auth の JWKS が alg / use を持たなくても読める
    monkeypatch.setattr(jwt_auth, "fetch_jwks_document", lambda url: jwt_tokens.jwks_document(with_alg=False))
    assert jwt_auth.JwtVerifier(auth_config).verify(make_token()).sub == jwt_tokens.DEFAULT_SUB


def test_audience_comes_from_the_config(jwks_fetches):
    other = jwt_auth.JwtVerifier(AuthConfig(issuer=jwt_tokens.ISSUER, jwks_url=jwt_tokens.JWKS_URL, audience="another-app"))
    assert other.verify(make_token(aud="another-app")).sub == jwt_tokens.DEFAULT_SUB
    with pytest.raises(jwt_auth.InvalidToken):
        other.verify(make_token())  # aud=townscan は、another-app の API では受け付けない


# ---- 受け付けないもの ----


@pytest.mark.parametrize(
    "overrides",
    [
        {"iss": "http://evil.example"},
        {"iss": jwt_tokens.ISSUER + "/"},  # 末尾の / も別の値（完全一致）
        {"iss": None},
        {"aud": "docunavi"},
        {"aud": "jobnavi"},
        {"aud": None},
        {"exp": int(time.time()) - 3600},
        {"exp": None},
        {"exp": "tomorrow"},
        {"nbf": int(time.time()) + 3600},
        {"iat": int(time.time()) + 3600},
        {"sub": None},
        {"sub": "short"},
        {"sub": "has space in it!"},
        {"sub": 12345678},
    ],
)
def test_bad_claims_are_rejected(verifier, overrides):
    with pytest.raises(jwt_auth.InvalidToken):
        verifier.verify(make_token(**overrides))


def test_signature_from_another_key_is_rejected(verifier):
    with pytest.raises(jwt_auth.InvalidToken):
        verifier.verify(make_token(key=jwt_tokens.OTHER_PRIVATE_KEY))  # kid は同じでも、署名が JWKS の鍵と違う


def test_tampered_payload_is_rejected(verifier):
    header, _, signature = make_token().split(".")
    forged_payload = jwt_tokens._b64(json.dumps(jwt_tokens.claims(sub="ba_admin_00000001")).encode())
    with pytest.raises(jwt_auth.InvalidToken):
        verifier.verify(f"{header}.{forged_payload}.{signature}")


def test_alg_none_is_rejected_before_any_key_is_fetched(verifier, jwks_fetches):
    with pytest.raises(jwt_auth.InvalidToken, match="algorithm"):
        verifier.verify(jwt_tokens.make_unsigned_token())
    assert jwks_fetches == []


def test_hs256_signed_with_the_public_key_is_rejected_before_any_key_is_fetched(verifier, jwks_fetches):
    with pytest.raises(jwt_auth.InvalidToken, match="algorithm"):
        verifier.verify(jwt_tokens.make_hs256_token())
    assert jwks_fetches == []


@pytest.mark.parametrize("alg", ["RS256", "ES384", "PS256"])
def test_other_algorithms_are_rejected_even_when_validly_signed(verifier, jwks_fetches, alg):
    key = jwt_tokens.RSA_PRIVATE_KEY if alg != "ES384" else ec.generate_private_key(ec.SECP384R1())
    with pytest.raises(jwt_auth.InvalidToken, match="algorithm"):
        verifier.verify(make_token(key=key, alg=alg))
    assert jwks_fetches == []


@pytest.mark.parametrize("token", ["", "abc", "a.b.c", "Bearer x", "....", "a" * 9000, "é.é.é"])
def test_malformed_tokens_are_rejected(verifier, token):
    with pytest.raises(jwt_auth.InvalidToken):
        verifier.verify(token)


def test_token_without_kid_is_rejected(verifier):
    with pytest.raises(jwt_auth.InvalidToken, match="kid"):
        verifier.verify(make_token(kid=None))


def test_unknown_kid_is_rejected_and_jwks_is_not_hammered(verifier, jwks_fetches, clock):
    with pytest.raises(jwt_auth.InvalidToken, match="unknown_key"):
        verifier.verify(make_token(kid="nope-1"))
    assert len(jwks_fetches) == 1
    # でたらめな kid を続けても、最小間隔（60 秒）のあいだは、JWKS を取り直さない
    for i in range(5):
        clock[0] += 5
        with pytest.raises(jwt_auth.InvalidToken):
            verifier.verify(make_token(kid=f"nope-{i}"))
    assert len(jwks_fetches) == 1
    # 間隔が過ぎれば、新しい鍵（ローテーション）を取りに行ける
    clock[0] += 120
    with pytest.raises(jwt_auth.InvalidToken):
        verifier.verify(make_token(kid="nope-after"))
    assert len(jwks_fetches) == 2


def test_key_rotation_is_picked_up_for_an_unknown_kid(auth_config, clock, monkeypatch):
    new_key = ec.generate_private_key(ec.SECP256R1())
    old_document = jwt_tokens.jwks_document()
    rotated_document = {"keys": old_document["keys"] + jwt_tokens.jwks_document(new_key, "rotated-2")["keys"]}
    served = [old_document]
    monkeypatch.setattr(jwt_auth, "fetch_jwks_document", lambda url: served[0])
    verifier = jwt_auth.JwtVerifier(auth_config)
    assert verifier.verify(make_token()).sub == jwt_tokens.DEFAULT_SUB
    served[0] = rotated_document  # web が鍵を回した
    with pytest.raises(jwt_auth.InvalidToken, match="unknown_key"):
        verifier.verify(make_token(key=new_key, kid="rotated-2"))  # 最小間隔の内は、取り直さない
    clock[0] += jwt_auth._MIN_REFRESH_INTERVAL_SECONDS + 1
    assert verifier.verify(make_token(key=new_key, kid="rotated-2")).sub == jwt_tokens.DEFAULT_SUB
    assert verifier.verify(make_token()).sub == jwt_tokens.DEFAULT_SUB  # 古い鍵も、JWKS に残っている間は使える


def test_keys_are_cached_and_refreshed_after_ttl(verifier, jwks_fetches, clock):
    verifier.verify(make_token())
    verifier.verify(make_token())
    assert len(jwks_fetches) == 1
    clock[0] += jwt_auth._KEYS_TTL_SECONDS + 1
    verifier.verify(make_token())
    assert len(jwks_fetches) == 2


# ---- JWKS が取れないとき ----


def test_jwks_failure_keeps_using_previous_keys(verifier, clock, monkeypatch):
    verifier.verify(make_token())  # 鍵を取る
    monkeypatch.setattr(jwt_auth, "fetch_jwks_document", down)
    clock[0] += jwt_auth._KEYS_TTL_SECONDS + 1
    assert verifier.verify(make_token()).sub == jwt_tokens.DEFAULT_SUB  # 前の鍵で続ける
    # 前の鍵があるあいだは、最小間隔（60 秒）に 1 回だけ取りに行く。間は、前の鍵で検証が続く
    assert verifier.verify(make_token()).sub == jwt_tokens.DEFAULT_SUB


@pytest.mark.parametrize(
    "error",
    [
        OSError("connect ECONNREFUSED 10.0.0.5:3000"),
        TimeoutError("timed out"),
        ValueError("JWKS が大きすぎます"),
        json.JSONDecodeError("Expecting value", "<html>", 0),
    ],
)
def test_no_keys_and_jwks_down_means_unavailable(verifier, monkeypatch, error):
    def fail(url: str):
        raise error

    monkeypatch.setattr(jwt_auth, "fetch_jwks_document", fail)
    with pytest.raises(jwt_auth.AuthUnavailable):
        verifier.verify(make_token())


def test_jwks_failure_is_not_retried_on_every_request(verifier, clock, monkeypatch):
    # web が落ちている間、要求のたびに取得を待たせない（API のスレッドを埋めない）
    calls: list[str] = []

    def fail(url: str):
        calls.append(url)
        raise TimeoutError

    monkeypatch.setattr(jwt_auth, "fetch_jwks_document", fail)
    for _ in range(4):
        with pytest.raises(jwt_auth.AuthUnavailable):
            verifier.verify(make_token())
        clock[0] += 1
    assert len(calls) == 1
    # 間隔（5 秒）が過ぎれば、もう一度試す。web が戻っていれば、そのまま使える
    clock[0] += jwt_auth._FAILURE_BACKOFF_SECONDS
    monkeypatch.setattr(jwt_auth, "fetch_jwks_document", lambda url: jwt_tokens.jwks_document())
    assert verifier.verify(make_token()).sub == jwt_tokens.DEFAULT_SUB


def test_jwks_failure_log_has_no_url_or_exception_text(verifier, monkeypatch, caplog):
    monkeypatch.setattr(jwt_auth, "fetch_jwks_document", down)
    with caplog.at_level("DEBUG", logger="townscan"), pytest.raises(jwt_auth.AuthUnavailable):
        verifier.verify(make_token())
    assert "OSError" in caplog.text
    assert "secret-host" not in caplog.text and "refused" not in caplog.text


def test_jwks_without_usable_keys_is_unavailable_and_keeps_old_keys(verifier, clock, monkeypatch):
    # 使える鍵が 1 つも無い JWKS は、取得の失敗として扱う（前の鍵は捨てない）
    monkeypatch.setattr(jwt_auth, "fetch_jwks_document", lambda url: {"keys": []})
    with pytest.raises(jwt_auth.AuthUnavailable):
        verifier.verify(make_token())
    monkeypatch.setattr(jwt_auth, "fetch_jwks_document", lambda url: jwt_tokens.jwks_document())
    clock[0] += jwt_auth._FAILURE_BACKOFF_SECONDS
    assert verifier.verify(make_token()).sub == jwt_tokens.DEFAULT_SUB
    monkeypatch.setattr(jwt_auth, "fetch_jwks_document", lambda url: {"keys": []})
    clock[0] += jwt_auth._KEYS_TTL_SECONDS + 1
    assert verifier.verify(make_token()).sub == jwt_tokens.DEFAULT_SUB


def test_parse_keys_keeps_only_usable_keys():
    good = jwt_tokens.jwks_document()["keys"][0]
    p384 = json.loads(jwt.algorithms.ECAlgorithm.to_jwk(ec.generate_private_key(ec.SECP384R1()).public_key())) | {"kid": "p384"}
    rsa_jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(jwt_tokens.RSA_PRIVATE_KEY.public_key())) | {"kid": "rsa"}
    document = {
        "keys": [
            good,
            {**good, "kid": ""},  # kid が空
            {k: v for k, v in good.items() if k != "kid"},  # kid なし
            {**good, "kid": "enc", "use": "enc"},  # 署名用ではない
            {**good, "kid": "garbled", "x": 12345},  # 壊れた鍵（捨てるだけで、ほかの鍵は使える）
            p384,  # ES384 の鍵は使わない
            rsa_jwk,  # RSA の鍵は使わない
            {"kty": "oct", "kid": "sym", "k": "c2VjcmV0"},  # 共有秘密の鍵は使わない
            "not-a-dict",
        ]
    }
    assert list(jwt_auth._parse_keys(document)) == [jwt_tokens.KID]
    assert jwt_auth._parse_keys({"keys": "x"}) == {}
    assert jwt_auth._parse_keys({}) == {}


# ---- claims から取り出す値 ----


def test_missing_optional_claims_become_none(verifier):
    ident = verifier.verify(make_token(email=None, name=None, picture=None))
    assert ident.as_dict() == {"sub": jwt_tokens.DEFAULT_SUB, "email": None, "name": None, "picture": None}


def test_picture_other_than_https_is_dropped(verifier):
    assert verifier.verify(make_token(picture="http://example.com/a.png")).picture is None
    assert verifier.verify(make_token(picture="javascript:alert(1)")).picture is None
    assert verifier.verify(make_token(picture="https://example.com/" + "a" * 2100)).picture is None


def test_better_auth_default_image_claim_is_used_when_picture_is_absent(verifier):
    assert verifier.verify(make_token(picture=None, image="https://lh3.googleusercontent.com/a/img")).picture == "https://lh3.googleusercontent.com/a/img"


@pytest.mark.parametrize("email", ["not-an-email", "a" * 250 + "@example.com", "   ", 123, ["a@example.com"]])
def test_unusable_email_becomes_none(verifier, email):
    assert verifier.verify(make_token(email=email)).email is None


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("あ" * 150, "あ" * 100),  # 上限（100 文字）で切る
        ("😀" * 101, "😀" * 100),  # 文字数はコードポイント
        ("a\nb\tc", "abc"),  # 制御文字は持たない
        ("   ", None),
        (123, None),
    ],
)
def test_name_claim_is_a_printable_string_within_the_limit(verifier, raw, expected):
    assert verifier.verify(make_token(name=raw)).name == expected


# ---- 本物の HTTP での JWKS の取得（urllib） ----


@pytest.fixture
def jwks_server():
    """JWKS を配る使い捨てのサーバー（127.0.0.1・空いているポート）。パスごとに、返す中身を変える。"""
    big = b'{"keys": [], "pad": "' + b"a" * (jwt_auth._MAX_JWKS_BYTES + 10) + b'"}'

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            if self.path == "/jwks":
                body, status = json.dumps(jwt_tokens.jwks_document(with_alg=False)).encode(), 200
            elif self.path == "/big":
                body, status = big, 200
            elif self.path == "/list":
                body, status = b"[1, 2]", 200
            elif self.path == "/html":
                body, status = b"<html>not json</html>", 200
            elif self.path == "/slow":
                time.sleep(1.5)
                body, status = b"{}", 200
            else:
                body, status = b"{}", 500
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            try:
                self.wfile.write(body)
            except OSError:
                pass

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)


def test_real_http_fetch_verifies_a_token(jwks_server):
    config = AuthConfig(issuer=jwt_tokens.ISSUER, jwks_url=f"{jwks_server}/jwks", audience=jwt_tokens.AUDIENCE)
    assert jwt_auth.JwtVerifier(config).verify(make_token()).sub == jwt_tokens.DEFAULT_SUB


@pytest.mark.parametrize("path", ["/big", "/list", "/html", "/missing"])
def test_real_http_fetch_failures_are_unavailable(jwks_server, path):
    config = AuthConfig(issuer=jwt_tokens.ISSUER, jwks_url=f"{jwks_server}{path}", audience=jwt_tokens.AUDIENCE)
    with pytest.raises(jwt_auth.AuthUnavailable):
        jwt_auth.JwtVerifier(config).verify(make_token())


def test_real_http_fetch_times_out(jwks_server, monkeypatch):
    monkeypatch.setattr(jwt_auth, "_FETCH_TIMEOUT_SECONDS", 0.3)
    config = AuthConfig(issuer=jwt_tokens.ISSUER, jwks_url=f"{jwks_server}/slow", audience=jwt_tokens.AUDIENCE)
    started = time.monotonic()
    with pytest.raises(jwt_auth.AuthUnavailable):
        jwt_auth.JwtVerifier(config).verify(make_token())
    assert time.monotonic() - started < 1.2  # サーバーの待ち（1.5 秒）を待たない


def test_real_http_connection_refused_is_unavailable():
    config = AuthConfig(issuer=jwt_tokens.ISSUER, jwks_url="http://127.0.0.1:1/jwks", audience=jwt_tokens.AUDIENCE)
    with pytest.raises(jwt_auth.AuthUnavailable):
        jwt_auth.JwtVerifier(config).verify(make_token())
