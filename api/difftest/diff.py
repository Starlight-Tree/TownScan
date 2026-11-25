#!/usr/bin/env python3
"""Python の API（FastAPI）と Go の API を、同じ入力で叩いて、応答を比べる（標準ライブラリだけ）。

使い方（api/difftest/run.sh が、使い捨ての DB・両方の API を用意して、段階（--phase）ごとに呼ぶ）:
    python3 -I diff.py --python http://tsgo-diff-py:8000 --go http://tsgo-diff-go:8000 --phase synthetic

比べるもの: 状態コード・ヘッダー（Content-Type・Cache-Control・Location・Allow・WWW-Authenticate・Transfer-Encoding など。COMPARED_HEADERS）・本文。
本文は次の 4 つに分ける:
  同一        バイト列まで同じ
  同値        JSON として、型（整数と浮動小数点・真偽値）・キーの並び・配列の並びまで同じで、書き方だけが違う（空白・数の書式）
  並び違い    JSON として同値だが、オブジェクトのキーの並びだけが違う（許す違い。件数を出す）
  差分        上のどれでもない。1 件でもあれば、終了コード 1
Date・Server・Content-Length（本文が違うとき）は比べない。Go が足す X-Content-Type-Options も比べない（Python には無い。意図した違い）。
Allow も比べない: Python の API は 405 に Allow を付けない（RFC 9110 §15.5.6 に反する。独自のエラー応答が落とす）。Go は付ける。check_allow が、その違いだけを確かめる。

あとの段（検出画像・チャット）が足すとき: PHASE_CASES に段階を足すか、cases_* の関数に入力を足す。
Go にまだ無いルート（NOT_YET_IN_GO）は、比べずに、状態だけを表示する（Go は、ルートが無いときの 404 を返すこと）。
"""

from __future__ import annotations

import argparse
import http.client
import json
import random
import socket
import sys
import time
import urllib.parse
from dataclasses import dataclass, field

# 比べるヘッダー（小文字）。これ以外（date・server・x-content-type-options など）は比べない
COMPARED_HEADERS = (
    "content-type", "cache-control", "location", "www-authenticate", "etag", "vary", "last-modified",
    "retry-after", "content-disposition", "transfer-encoding", "access-control-allow-origin",
)

HOST_HEADER = "diff.test"  # 両方に同じ Host を送る（307 の Location に入る）
TIMEOUT = 30  # DB が止まっているとき、Python の API は接続の待ち（10 秒）のあとに 503 を返す

# ---- 入力の部品 ----

# 合成データ（backend/tests/synthetic.py）の ID
SYN_AREAS = ["z18-226249-105759", "z18-226250-105759", "z18-226249-105760"]
SYN_CANDS = [
    "c-226250-105759-1", "c-226249-105759-1", "c-226249-105759-2", "c-226249-105759-3",
    "c-226250-105759-2", "c-226250-105759-3", "c-226249-105760-1", "c-226249-105760-2", "c-226249-105760-3",
]

CLASSES = ["confirmed_new", "existing_omission", "uncertain"]
SORTS = ["area_desc", "area_asc"]

# クエリの値（%XX は、そのまま送る）。無効な値は、検証エラー（422）の文言まで比べる
AREA_VALUES = [
    "", "z18-1-1", "z0-0-0", "z99-1234567-7654321", "z18-226249-105759",
    "z18-1-1%0A", "%20z18-1-1", "z18-1-1%20", "Z18-1-1", "z100-1-1", "z18-12345678-1", "z18-1-1-1", "z-1-1", "nope",
    "z18-1-1'%20OR%20'1'='1", "z18-%EF%BC%91-1", "z18-%D9%A1-1", "%zz", "%FF", "z18-1-1%FF", "%E3%81%82", "a" * 5000,
    "z18-1-1%00", "z18-1-1;x", "z18-1-1%26x", "z18%2D1%2D1", "%7A18-1-1", "z18+1-1", "z18-1-1%0D%0A",
]
CLS_VALUES = CLASSES + [
    "", "bogus", "CONFIRMED_NEW", "Confirmed_new", "confirmed_new%20", "%20confirmed_new", "confirmed_new%0A", "x", "%E3%81%82",
    "confirmed%5Fnew", "confirmed_new%00", "uncertain,confirmed_new",
]
SORT_VALUES = SORTS + ["", "bogus", "AREA_DESC", "area_desc%20", "area_asc%0A", "desc", "%E3%81%82"]
LIMIT_VALUES = [
    "1", "2", "50", "500", "0", "501", "-1", "", "abc", "1.0", "1.5", "1e2", "%201", "1%20", "+1", "01", "1_0", "1__0", "_1", "1_", "1_000",
    "%EF%BC%91", "0x10", "99999999999999999999", "-99999999999999999999", "nan", "inf", "true", "-0", ".5", "5.", "1%0A", "%0A1",
    "500.0", "501.0", "100.00", "1.0_0", "%E2%80%831", "%0B1", "%1C1", "%C2%851", "1" * 4300, "1" * 4301, "9" * 5000, "%00",
]
OFFSET_VALUES = [
    "0", "1", "5", "9", "10", "40", "600", "619", "620", "1000000", "1000001", "-1", "", "abc", "1.0", "1.5", "1_0", "%203", "+3",
    "99999999999999999999", "-0", "0.0", "1e3", "1000000.0", "1_000_000", "1_000_001",
]

# 詳細の ID の無効な値
BAD_DETAIL_IDS = [
    "c-1-2-3", "c-0000001-0000002-0000003", "c-9999999-9999999-9999999", "c-1-2", "x", "c-1-2-3%27;%20DROP%20TABLE%20candidates;--",
    "c-a-b-c", "c-1-2-3%0A", "%20c-1-2-3", "c-12345678-1-1", "c-1-12345678-1", "c-1-1-12345678", "c-1-2-3-4", "c-%EF%BC%91-2-3",
    "C-1-2-3", "%63-1-2-3", "c-1-2%2F3", "%E3%81%82", "%FF", "c-1-2-3%00", "c--2-3", "c-1--3", "a" * 3000, "c-1-2-3'", "c%2D1%2D2%2D3",
]

# パスのルーティング（GET）。Python（Starlette）の振る舞いを、そのまま比べる
ROUTING_PATHS = [
    "/", "/api", "/api/", "/nothing", "/api/nothing", "/api/nothing/", "/API/areas", "/api/AREAS", "/api//areas", "//api/areas",
    "/api/areas/", "/api/areas//", "/api/areas///", "/api/areas/?limit=2&x=%20y", "/api/areas/x", "/api/areas/x/",
    "/api/health/", "/api/health//", "/api/metrics/", "/api/metrics/?a=b", "/api/me", "/api/me/", "/api/me//", "/api/me/?a=b", "/api/ME",
    "/api/candidates/", "/api/candidates//", "/api/candidates/?limit=1", "/api/candidates.geojson/", "/api/candidates.geojson/?cls=x",
    "/api/candidates.geojson//", "/api/candidates.geojson/x", "/api/candidates.geojson.", "/api/candidates.GEOJSON", "/api/candidatesxgeojson",
    "/api/candidates/c-1-2-3/", "/api/candidates/c-1-2-3//", "/api/candidates/c-1-2/", "/api/candidates/c-1-2-3/foo", "/api/candidates/c-1-2-3/foo/",
    "/api/candidates/c-226250-105759-1/", "/api/candidates/c-226250-105759-1%2F", "/api/candidates/c-226250-105759-1%2f",
    "/api/candidates/%E3%81%82/", "/api/candidates/%E3%81%82", "/api/candidates/a%20b/", "/api/candidates/c-1-2%2F3", "/api/candidates/c-1-2%2F3/",
    "/api/candidates/%2F", "/api/candidates/%2E", "/api/candidates/..", "/api/candidates/../areas", "/api/./areas", "/api/areas/.", "/api/%61reas",
    "/api/areas%2F", "/api%2Fareas", "/api/areas;x=1", "/api/areas%00", "/api/areas%20", "/api/areas?", "/api/areas?#x", "/api/areas#x",
    "/api/health?x=1", "/api/health?%zz", "/api/health?a=%FF",
]

# Go にまだ無いルート（Python にはある）。比べずに、状態だけを表示する。Go は、ルートが無いときの 404 を返すこと
NOT_YET_IN_GO = [
    ("POST", "/api/chat"), ("GET", "/api/chat"), ("GET", "/api/candidates/c-1-2-3/image?year=2018"),
    ("GET", "/api/candidates/c-226250-105759-1/image?year=2018&size=64"), ("GET", "/api/docs"), ("GET", "/api/openapi.json"),
]
GO_NOT_FOUND = '{"error":{"code":"not_found","message":"見つかりません"}}'

# 意図した違い: (メソッド, 入力, Python の状態, Go の状態, 理由, 流す段階。None は dbdown 以外のすべて)。
# 1 つ目: Go（net/http）は、不正な %XX を含むパスを、ハンドラーの前に 400 で断る（ハンドラーでは変えられない）。
# 2 つ目: Python は、検証より先に DB の接続を取る（FastAPI は Depends を先に解く）ので、DB が止まっていると、不正な引数でも 503。Go は先に検証する（422）
KNOWN_DIFFERENCES = [
    ("GET", "/api/candidates/%zz", 422, 400, "パスの不正なパーセントエンコード: Go の http.Server が、ハンドラーの前に text/plain の 400 で断る", None),
    ("GET", "/api/%zz", 404, 400, "同上", None),
    ("GET", "/api/areas%zz", 404, 400, "同上", None),
    ("GET", "/%", 404, 400, "同上", None),
    ("GET", "/api/candidates/%zz?limit=0", 422, 400, "同上", None),
    ("GET", "/api/candidates?area_id=あ", 400, 422, "生の UTF-8（パーセントエンコードしていない非 ASCII）: uvicorn の HTTP 解析器は 400（本文は text/plain）で断る。Go は受け付けて、検証（422）する。ブラウザーの fetch は必ずエンコードする", None),
    ("GET", "/api/candidates?limit=１", 400, 422, "同上", None),
    ("GET", "/api/candidates/あ", 400, 422, "同上", None),
    ("GET", "/api/candidates?cls=confirmed_new&area_id=z18-1-1あ", 400, 422, "同上", None),
    ("GET", "/api/candidates?limit=0", 503, 422, "Python は DB の接続を取ってから検証する。Go は先に検証する（DB を使わずに断れる）", {"dbdown"}),
]


@dataclass
class Resp:
    status: int
    headers: list[tuple[str, str]]
    body: bytes
    error: str = ""

    def header(self, name: str) -> list[str]:
        return [v for k, v in self.headers if k == name]


def send(base: str, method: str, target: str, extra_headers: dict[str, str] | None = None, body: bytes = b"") -> Resp:
    """生のソケットで送る（http.client は、パスを書き換えたり、不正な値を拒んだりするため）。リダイレクトは追わない。"""
    u = urllib.parse.urlsplit(base)
    lines = [f"{method} {target} HTTP/1.1", f"Host: {HOST_HEADER}", "Connection: close", "Accept: */*"]
    for k, v in (extra_headers or {}).items():
        lines.append(f"{k}: {v}")
    if body:
        lines.append(f"Content-Length: {len(body)}")
    raw = ("\r\n".join(lines) + "\r\n\r\n").encode("utf-8") + body
    try:
        with socket.create_connection((u.hostname, u.port or 80), timeout=TIMEOUT) as sock:
            sock.sendall(raw)
            resp = http.client.HTTPResponse(sock, method=method)
            resp.begin()
            data = resp.read()
            headers = [(k.lower(), v) for k, v in resp.getheaders()]
            return Resp(resp.status, headers, data)
    except (OSError, http.client.HTTPException) as exc:
        return Resp(0, [], b"", error=f"{type(exc).__name__}: {exc}")


# ---- 比較 ----

def strict_equal(a, b, ordered: bool) -> bool:
    """型（bool・int・float・str）まで同じ。ordered なら、オブジェクトのキーの並びも同じ。"""
    if type(a) is not type(b):
        return False
    if isinstance(a, dict):
        if ordered and list(a) != list(b):
            return False
        return set(a) == set(b) and all(strict_equal(a[k], b[k], ordered) for k in a)
    if isinstance(a, list):
        return len(a) == len(b) and all(strict_equal(x, y, ordered) for x, y in zip(a, b))
    if isinstance(a, float):
        return repr(a) == repr(b)
    return a == b


def first_difference(a, b, path="$") -> str:
    if type(a) is not type(b):
        return f"{path}: 型が違う（{type(a).__name__} と {type(b).__name__}）: {short(a)} / {short(b)}"
    if isinstance(a, dict):
        if list(a) != list(b) and set(a) == set(b):
            return f"{path}: キーの並びが違う: {list(a)[:8]} / {list(b)[:8]}"
        for k in a:
            if k not in b:
                return f"{path}.{k}: Go に無い"
            if not strict_equal(a[k], b[k], True):
                return first_difference(a[k], b[k], f"{path}.{k}")
        for k in b:
            if k not in a:
                return f"{path}.{k}: Python に無い"
    if isinstance(a, list):
        if len(a) != len(b):
            return f"{path}: 配列の長さが違う（{len(a)} と {len(b)}）"
        for i, (x, y) in enumerate(zip(a, b)):
            if not strict_equal(x, y, True):
                return first_difference(x, y, f"{path}[{i}]")
    return f"{path}: {short(a)} / {short(b)}"


def short(v, n=80) -> str:
    s = json.dumps(v, ensure_ascii=False) if not isinstance(v, str) else repr(v)
    return s if len(s) <= n else s[:n] + "…"


def is_json(r: Resp) -> bool:
    ct = (r.header("content-type") or [""])[0]
    return ct.split(";")[0].strip().endswith("json")


@dataclass
class Outcome:
    kind: str  # identical / equivalent / reordered / diff
    detail: str = ""


def compare(py: Resp, go: Resp) -> Outcome:
    if py.error or go.error:
        if py.error and go.error and py.error.split(":")[0] == go.error.split(":")[0]:
            return Outcome("identical")
        return Outcome("diff", f"接続の失敗: Python={py.error or py.status} Go={go.error or go.status}")
    if py.status != go.status:
        return Outcome("diff", f"状態が違う: Python={py.status} Go={go.status}\n    Python: {preview(py)}\n    Go:     {preview(go)}")
    for h in COMPARED_HEADERS:
        if py.header(h) != go.header(h):
            return Outcome("diff", f"ヘッダー {h} が違う: Python={py.header(h)} Go={go.header(h)}")
    if py.body == go.body:
        if py.header("content-length") != go.header("content-length"):
            return Outcome("diff", f"Content-Length が違う: Python={py.header('content-length')} Go={go.header('content-length')}")
        return Outcome("identical")
    if not (is_json(py) and is_json(go)):
        return Outcome("diff", f"本文が違う:\n    Python: {preview(py)}\n    Go:     {preview(go)}")
    try:
        a, b = json.loads(py.body), json.loads(go.body)
    except ValueError as exc:
        return Outcome("diff", f"JSON として読めない: {exc}\n    Python: {preview(py)}\n    Go:     {preview(go)}")
    if strict_equal(a, b, True):
        return Outcome("equivalent", "書き方だけが違う: " + text_difference(py.body, go.body))
    if strict_equal(a, b, False):
        return Outcome("reordered", first_difference(a, b))
    return Outcome("diff", "JSON の中身が違う: " + first_difference(a, b))


def text_difference(a: bytes, b: bytes) -> str:
    for i, (x, y) in enumerate(zip(a, b)):
        if x != y:
            lo = max(0, i - 30)
            return f"位置 {i}: Python …{a[lo:i + 30].decode('utf-8', 'replace')}… / Go …{b[lo:i + 30].decode('utf-8', 'replace')}…"
    return f"長さが違う（{len(a)} と {len(b)}）"


def preview(r: Resp, n=300) -> str:
    t = r.body.decode("utf-8", "replace")
    return f"{r.status} {t[:n]}{'…' if len(t) > n else ''}"


# ---- 入力の組み立て ----

@dataclass
class Case:
    group: str
    method: str
    target: str
    headers: dict[str, str] = field(default_factory=dict)
    body: bytes = b""


def get(group, target, **kw):
    return Case(group, "GET", target, **kw)


def fetch_json(base: str, target: str):
    r = send(base, "GET", target)
    if r.status != 200:
        raise SystemExit(f"{base}{target} が {r.status} でした: {preview(r)}")
    return json.loads(r.body)


def discover(base: str) -> tuple[list[str], list[str]]:
    """Python の API から、データの地区 ID・候補 ID を集める（run が無ければ空）。"""
    r = send(base, "GET", "/api/health")
    if r.status != 200 or json.loads(r.body).get("run") is None:
        return [], []
    areas = [a["id"] for a in fetch_json(base, "/api/areas")]
    ids: list[str] = []
    offset = 0
    while True:
        page = fetch_json(base, f"/api/candidates?limit=500&offset={offset}")
        ids += [i["id"] for i in page["items"]]
        offset += 500
        if offset >= page["total"]:
            break
    return areas, ids


def cases_basic(areas: list[str], ids: list[str]) -> list[Case]:
    out = [get("health", "/api/health"), get("areas", "/api/areas"), get("candidates", "/api/candidates"),
           get("geojson", "/api/candidates.geojson"), get("metrics", "/api/metrics")]
    # 引数ごとに、値を 1 つずつ変える
    for v in AREA_VALUES + areas[:6]:
        out.append(get("candidates:area_id", f"/api/candidates?area_id={v}"))
        out.append(get("geojson:area_id", f"/api/candidates.geojson?area_id={v}"))
    for v in CLS_VALUES:
        out.append(get("candidates:cls", f"/api/candidates?cls={v}"))
        out.append(get("geojson:cls", f"/api/candidates.geojson?cls={v}"))
    for v in SORT_VALUES:
        out.append(get("candidates:sort", f"/api/candidates?sort={v}"))
    for v in LIMIT_VALUES:
        out.append(get("candidates:limit", f"/api/candidates?limit={v}"))
    for v in OFFSET_VALUES:
        out.append(get("candidates:offset", f"/api/candidates?offset={v}&limit=7"))
    # 複数の引数（誤りが複数のときの並び・メッセージ）
    out += [
        get("candidates:multi", "/api/candidates?limit=0&offset=-1&cls=x&sort=y&area_id=q"),
        get("candidates:multi", "/api/candidates?area_id=&cls=&sort=&limit=&offset="),
        get("candidates:multi", "/api/candidates?offset=x&limit=y"),
        get("candidates:multi", "/api/candidates?cls=x&area_id=y"),
        get("candidates:multi", "/api/candidates?limit=501&limit=2"),  # 最後の値
        get("candidates:multi", "/api/candidates?limit=2&limit=501"),
        get("candidates:multi", "/api/candidates?limit=2&limit=x&offset=1&offset=-1"),
        get("geojson:multi", "/api/candidates.geojson?cls=x&area_id=y"),
        get("geojson:multi", "/api/candidates.geojson?limit=0&offset=-1&sort=zzz"),  # geojson は、これらの引数を見ない
    ]
    # 正しい引数の組み合わせ（データがあるときに、絞り込み・並び・ページ分けを比べる）
    rnd = random.Random(20261125)
    area_pool = (areas or SYN_AREAS) + [None]
    for _ in range(90):
        params = []
        a = rnd.choice(area_pool)
        if a:
            params.append(f"area_id={a}")
        if rnd.random() < 0.5:
            params.append(f"cls={rnd.choice(CLASSES)}")
        if rnd.random() < 0.5:
            params.append(f"sort={rnd.choice(SORTS)}")
        if rnd.random() < 0.7:
            params.append(f"limit={rnd.choice([1, 2, 3, 5, 10, 25, 50, 100, 250, 500])}")
        if rnd.random() < 0.7:
            params.append(f"offset={rnd.choice([0, 1, 2, 5, 9, 10, 33, 100, 300, 619, 620, 700, 1000000])}")
        rnd.shuffle(params)
        qs = "&".join(params)
        out.append(get("candidates:combo", "/api/candidates" + ("?" + qs if qs else "")))
    for a in area_pool:
        for c in CLASSES + [None]:
            params = [p for p in (f"area_id={a}" if a else None, f"cls={c}" if c else None) if p]
            out.append(get("geojson:combo", "/api/candidates.geojson" + ("?" + "&".join(params) if params else "")))
    # クエリ文字列の読み方（Starlette の parse_qsl と同じか）
    for qs in ["limit", "limit=", "=x&limit=1", "a=b&&limit=2&", "&&", "&", "?", "limit=2;offset=1", "limit=1#frag", "limit=2&limit",
               "%6Cimit=2", "limit%3D2", "limit=%32", "lim+it=2", "limit=2&cls=confirmed_new&cls=", "area_id=%zz", "area_id=%4", "area_id=%",
               "unknown=1&limit=2", "LIMIT=2", "limit%20=2", "%20limit=2", "limit=2%26offset=1", "limit=2&offset=1&", "cls=uncertain&cls=confirmed_new"]:
        out.append(get("query-parsing", f"/api/candidates?{qs}"))
    # 詳細
    for i in SYN_CANDS + sample(ids, 140, 11):
        out.append(get("detail", f"/api/candidates/{i}"))
    for i in ids[:3]:
        out.append(get("detail:query", f"/api/candidates/{i}?x=1&year=2018"))
    for v in BAD_DETAIL_IDS:
        out.append(get("detail:invalid", f"/api/candidates/{v}"))
        out.append(get("detail:invalid", f"/api/candidates/{v}?limit=0"))
    # ルーティング（GET）
    for p in ROUTING_PATHS:
        out.append(get("routing", p))
    # メソッド（実在するルートに、GET 以外）
    for p in ["/api/health", "/api/areas", "/api/candidates", "/api/candidates.geojson", "/api/candidates/c-226250-105759-1", "/api/metrics",
              "/api/me", "/api/areas/", "/api/nothing", "/"]:
        for m in ["POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "TRACE", "FOO"]:
            out.append(Case("methods", m, p))
    out.append(Case("methods", "POST", "/api/areas", headers={"Content-Type": "application/json"}, body=b'{"a":1}'))
    out.append(Case("methods", "GET", "/api/areas", headers={"Content-Type": "application/json"}, body=b'{"a":1}'))
    out.append(Case("methods", "GET", "/api/health", headers={"Authorization": "Bearer abc", "Accept": "text/html", "Accept-Encoding": "gzip"}))
    # /api/me: この検査の API は、どちらも AUTH_* なしで起動する（ログインの設定が無い）。トークンの有無・形を見る前に 503（固定の文・no-store）
    for h in [None, {"Authorization": ""}, {"Authorization": "Basic abc"}, {"Authorization": "Bearer abc"}, {"Authorization": "Bearer a.b.c"}]:
        out.append(Case("auth-unconfigured", "GET", "/api/me", headers=h or {}))
    out.append(Case("methods", "GET", "/api/areas", headers={"Origin": "http://localhost:3500", "Cache-Control": "no-cache"}))
    out.append(Case("methods", "OPTIONS", "/api/areas", headers={"Origin": "http://localhost:3500", "Access-Control-Request-Method": "GET"}))
    return out


def sample(items: list[str], n: int, seed: int) -> list[str]:
    if len(items) <= n:
        return list(items)
    rnd = random.Random(seed)
    picked = set(rnd.sample(range(len(items)), n - 2)) | {0, len(items) - 1}
    return [items[i] for i in sorted(picked)]


def cases_db_down() -> list[Case]:
    return [get("health", "/api/health"), get("areas", "/api/areas"), get("candidates", "/api/candidates?limit=2"),
            get("geojson", "/api/candidates.geojson"), get("detail", "/api/candidates/c-226250-105759-1"), get("metrics", "/api/metrics")]


PHASES = ("empty", "synthetic", "rich", "bare", "tie", "weird", "dbdown")


def cases_weird() -> list[Case]:
    """面積が NaN の候補（JSON に書けない → 500）と、配列の評価（{**body} が失敗 → 500）。地区の一覧・ID の指定は、どちらも正常に返る。"""
    return [get("health", "/api/health"), get("areas", "/api/areas"), get("candidates", "/api/candidates"), get("candidates", "/api/candidates?limit=1"),
            get("candidates", "/api/candidates?area_id=z18-1-1"), get("candidates", "/api/candidates?cls=confirmed_new"),
            get("geojson", "/api/candidates.geojson"), get("geojson", "/api/candidates.geojson?cls=confirmed_new"),
            get("detail", "/api/candidates/c-2-2-1"), get("detail", "/api/candidates/c-1-1-1"), get("metrics", "/api/metrics"),
            get("validation", "/api/candidates?limit=0")]


def build_cases(phase: str, areas: list[str], ids: list[str]) -> list[Case]:
    if phase == "dbdown":
        return cases_db_down()
    if phase == "weird":
        return cases_weird()
    if phase in ("empty", "bare"):
        # データ（行）が無い。run が無い・run だけがある、の 2 通り
        c = cases_basic(areas, ids)
        c += [get("detail", f"/api/candidates/{i}") for i in SYN_CANDS[:2]]
        return c
    return cases_basic(areas, ids)


def wait_ready(urls: list[str], seconds: int) -> None:
    deadline = time.time() + seconds
    for u in urls:
        while True:
            r = send(u, "GET", "/api/health")
            if r.status in (200, 503):
                break
            if time.time() > deadline:
                raise SystemExit(f"{u} が {seconds} 秒以内に起動しませんでした: {r.error or r.status}")
            time.sleep(0.5)


def check_allow(python: str, go: str) -> list[tuple[str, bool]]:
    out = []
    for path in ("/api/health", "/api/areas", "/api/candidates", "/api/candidates.geojson", "/api/candidates/c-1-2-3", "/api/metrics"):
        for method in ("POST", "HEAD", "DELETE"):
            py, g = send(python, method, path), send(go, method, path)
            ok = py.status == 405 and g.status == 405 and not py.header("allow") and g.header("allow") == ["GET"]
            out.append((f"     {method:6s} {path:28s} Python: 405 Allow={py.header('allow') or '（なし）'}  Go: {g.status} Allow={g.header('allow') or '（なし）'}"
                        + ("" if ok else "  ← 想定は Go が Allow: GET"), ok))
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--python", required=True, help="Python の API の URL（http://host:port）")
    ap.add_argument("--go", required=True, help="Go の API の URL")
    ap.add_argument("--phase", required=True, choices=PHASES, help="DB の状態（run.sh が用意する）")
    ap.add_argument("--wait", type=int, default=0, metavar="SECONDS", help="両方の API が応答するまで、最大この秒数だけ待つ")
    ap.add_argument("--show", type=int, default=15, help="差分を、最大この件数まで詳しく表示する")
    args = ap.parse_args()

    if args.wait:
        wait_ready([args.python, args.go], args.wait)
    areas, ids = discover(args.python) if args.phase not in ("dbdown", "weird") else ([], [])
    cases = build_cases(args.phase, areas, ids)

    tally: dict[str, dict[str, int]] = {}
    diffs: list[tuple[Case, Outcome]] = []
    reordered: list[tuple[Case, Outcome]] = []
    equivalent: list[tuple[Case, Outcome]] = []
    for c in cases:
        py = send(args.python, c.method, c.target, c.headers, c.body)
        go = send(args.go, c.method, c.target, c.headers, c.body)
        out = compare(py, go)
        t = tally.setdefault(c.group, {"identical": 0, "equivalent": 0, "reordered": 0, "diff": 0})
        t[out.kind] += 1
        if out.kind == "diff":
            diffs.append((c, out))
        elif out.kind == "reordered":
            reordered.append((c, out))
        elif out.kind == "equivalent":
            equivalent.append((c, out))

    total = len(cases)
    n = {k: sum(t[k] for t in tally.values()) for k in ("identical", "equivalent", "reordered", "diff")}
    print(f"== 段階 {args.phase}: 地区 {len(areas)}・候補 {len(ids)}")
    for g in sorted(tally):
        t = tally[g]
        print(f"  {g:22s} 件数 {sum(t.values()):4d}  同一 {t['identical']:4d}  同値 {t['equivalent']:3d}  並び違い {t['reordered']:3d}  差分 {t['diff']:3d}")

    # Go にまだ無いルート
    bad_not_yet = 0
    if args.phase != "dbdown":
        print("  -- Go にまだ無いルート（比べない。Go は、ルートが無いときの 404 を返すこと）")
        for m, p in NOT_YET_IN_GO:
            py = send(args.python, m, p)
            go = send(args.go, m, p)
            ok = go.status == 404 and go.body.decode("utf-8", "replace") == GO_NOT_FOUND
            bad_not_yet += 0 if ok else 1
            print(f"     {m:4s} {p:55s} Python={py.status} Go={go.status} {'' if ok else ' ← Go が 404 の形ではない: ' + preview(go)}")
    if args.phase != "dbdown":
        print("  -- 405 の Allow（意図した違い: Go は、そのパスで使えるメソッドを付ける。Python は付けない）")
        results = check_allow(args.python, args.go)
        bad_lines = [line for line, ok in results if not ok]
        bad_not_yet += len(bad_lines)
        print(f"     {len(results) - len(bad_lines)}/{len(results)} 件が想定どおり（POST・HEAD・DELETE を、6 つのルートへ）")
        for line in bad_lines:
            print(line)
    known = [k for k in KNOWN_DIFFERENCES if (k[5] is None and args.phase != "dbdown") or (k[5] is not None and args.phase in k[5])]
    if known:
        print("  -- 意図した違い（比べず、想定どおりの違いであることだけを確かめる）")
        for m, p, py_status, go_status, why, _ in known:
            py = send(args.python, m, p)
            go = send(args.go, m, p)
            ok = py.status == py_status and go.status == go_status
            bad_not_yet += 0 if ok else 1
            print(f"     {m:4s} {p:30s} Python={py.status} Go={go.status} {'（想定どおり）' if ok else f'← 想定は Python={py_status} Go={go_status}'} {why}")

    print(f"  合計 {total} 件: 同一 {n['identical']}・同値 {n['equivalent']}・並び違い {n['reordered']}（許す違い）・差分 {n['diff']}")
    for title, items in (("同値（書き方だけが違う）", equivalent), ("並び違い（キーの並びだけが違う）", reordered)):
        for c, o in items[: args.show]:
            print(f"  [{title}] {c.method} {c.target[:100]}\n    {o.detail}")
    for c, o in diffs[: args.show]:
        print(f"  [差分] {c.method} {c.target[:120]}\n    {o.detail}")
    if len(diffs) > args.show:
        print(f"  …ほか {len(diffs) - args.show} 件の差分")
    return 1 if diffs or bad_not_yet else 0


if __name__ == "__main__":
    sys.exit(main())
