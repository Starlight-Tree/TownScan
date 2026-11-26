"""ログインの有無・設定は、ほかの入口に影響しない。構成 main・noauth・badauth・jwksdown（認証の設定がどうであっても）。

仕様 §2.1・§4.4: チャット・地図・候補・精度などは、ログインを要求せず、`Authorization` ヘッダーも見ない。ログインの有無で、応答・件数・機能を変えない。
"""

from __future__ import annotations

import pytest

from support.fakes import bearer, make_token

AUTH_VARIANTS = ("main", "noauth", "badauth", "jwksdown")
CHAT = {"messages": [{"role": "user", "content": "新規出現の候補は何件ありますか？"}]}
GET_PATHS = ["/api/health", "/api/areas", "/api/candidates", "/api/candidates.geojson", "/api/metrics", "/api/candidates/c-226250-105759-1"]


@pytest.mark.variant("main")
def test_other_endpoints_do_not_fetch_the_jwks(api, jwks):
    # 鍵を取りに行くのは /api/me だけ。この検査は、JWKS が一度も取られる前に流れる必要がある（このファイルの先頭。
    # test_me.py より前に並ぶ。-k で絞っても、先に /api/me を呼ばなければ成り立つ）
    assert jwks.hits == [], "この検査の前に、JWKS が取られています（/api/me を先に流していませんか）"
    for path in GET_PATHS:
        assert api.get(path, headers=bearer(make_token())).status == 200, path
    assert api.post("/api/chat", json=CHAT, headers=bearer(make_token())).status == 200
    assert jwks.hits == []


@pytest.mark.variant(*AUTH_VARIANTS)
@pytest.mark.parametrize("headers", [
    pytest.param({}, id="no-header"),
    pytest.param({"Authorization": "Bearer garbage"}, id="garbage-bearer"),
    pytest.param({"Authorization": "Basic x"}, id="basic"),
    pytest.param(None, id="valid-looking-token"),
])
def test_other_endpoints_never_require_or_check_login(api, jwks, headers):
    send = bearer(make_token()) if headers is None else headers
    for path in GET_PATHS:
        plain = api.get(path)
        with_header = api.get(path, headers=send)
        assert with_header.status == plain.status == 200, path
        assert with_header.body == plain.body, path  # ログインの有無で、応答は変わらない
    chat = api.post("/api/chat", json=CHAT, headers=send)
    assert chat.status == 200 and chat.json() == api.post("/api/chat", json=CHAT).json()


@pytest.mark.variant(*AUTH_VARIANTS)
def test_the_image_does_not_require_login(api, jwks):
    resp = api.get("/api/candidates/c-226249-105759-2/image", params={"year": 2014, "size": 64}, headers={"Authorization": "Bearer garbage"})
    assert resp.status == 200 and resp.header("content-type") == "image/png"
