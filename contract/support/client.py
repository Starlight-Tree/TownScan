"""HTTP だけで API を叩く小さなクライアント（標準ライブラリの http.client）。アプリのコードは import しない。

URL の正規化（`..` の解決・再エンコード）をしないので、検査が書いた経路がそのまま API に届く。
1 回の要求ごとに接続を作る（Connection: close）。応答の本文は bytes のまま持ち、`.json()` で読む。
"""

from __future__ import annotations

import http.client
import json as _json
from typing import Any
from urllib.parse import quote, urlencode, urlsplit

_UNSET = object()


class Response:
    def __init__(self, status: int, headers: dict[str, str], body: bytes) -> None:
        self.status = status
        self.headers = headers  # キーは小文字。同じ名前が複数あれば ", " でつなぐ
        self.body = body
        self._json: Any = _UNSET

    @property
    def text(self) -> str:
        return self.body.decode("utf-8", errors="replace")

    def json(self) -> Any:
        if self._json is _UNSET:
            self._json = _json.loads(self.body)
        return self._json

    def header(self, name: str) -> str | None:
        return self.headers.get(name.lower())

    @property
    def content_type(self) -> str:
        return (self.header("content-type") or "").lower()

    def __repr__(self) -> str:  # アサーションの失敗に、状態コードと本文の頭を出す
        return f"<Response {self.status} {self.content_type!r} {self.text[:300]!r}>"


class Client:
    def __init__(self, base_url: str, timeout: float = 20.0) -> None:
        parts = urlsplit(base_url)
        if parts.scheme != "http" or not parts.hostname:
            raise ValueError(f"API_BASE_URL は http://ホスト[:ポート] の形にしてください: {base_url!r}")
        self.base_url = base_url.rstrip("/")
        self.host = parts.hostname
        self.port = parts.port or 80
        self.timeout = timeout

    def request(
        self,
        method: str,
        target: str,
        *,
        params: dict[str, Any] | None = None,
        json: Any = _UNSET,
        body: bytes | None = None,
        headers: dict[str, str] | None = None,
        timeout: float | None = None,
    ) -> Response:
        """target は `/api/...`（クエリを含めてよい。含める値は呼び出し側がエンコード済みにする）。params は足りない分を足す（エンコードはここで行う）。"""
        if params:
            sep = "&" if "?" in target else "?"
            target = target + sep + urlencode({k: str(v) for k, v in params.items()}, quote_via=quote, safe="")
        send_headers = {"Accept": "*/*", "Connection": "close", **(headers or {})}
        if json is not _UNSET:
            body = _json.dumps(json, ensure_ascii=False).encode("utf-8")
            send_headers.setdefault("Content-Type", "application/json")
        conn = http.client.HTTPConnection(self.host, self.port, timeout=timeout or self.timeout)
        try:
            conn.request(method, target, body=body, headers=send_headers)
            resp = conn.getresponse()
            raw = resp.read()
            out: dict[str, str] = {}
            for key, value in resp.getheaders():
                key = key.lower()
                out[key] = f"{out[key]}, {value}" if key in out else value
            return Response(resp.status, out, raw)
        finally:
            conn.close()

    def get(self, target: str, params: dict[str, Any] | None = None, headers: dict[str, str] | None = None, **kw: Any) -> Response:
        return self.request("GET", target, params=params, headers=headers, **kw)

    def post(self, target: str, json: Any = _UNSET, *, body: bytes | None = None, headers: dict[str, str] | None = None, **kw: Any) -> Response:
        return self.request("POST", target, json=json, body=body, headers=headers, **kw)
