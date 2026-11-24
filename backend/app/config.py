"""環境変数からの設定。秘密（DB のパスワードは DATABASE_URL に、Gemini のキーは GEMINI_API_KEY に入る）は、表示・ログに出さない。"""

from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit


log = logging.getLogger("townscan")


class ConfigError(RuntimeError):
    """設定が足りない・不正なとき。起動時に出して止める（ただし、任意のログインの設定は止めない。下の _auth_from_env）。"""


SUPPORTED_LLM_PROVIDERS = ("mock", "gemini")
# 既定は gemini-3.5-flash-lite。実測（2026-11-25、docs/decisions/0003-llm-provider.md）で、gemini-3.1-flash-lite は 503（high demand）と
# タイムアウトで全滅、gemini-3.5-flash-lite は 32 回中 28 回成功だった（DocuNavi の既定とは、ここで変えた）。変えるときは GEMINI_MODEL で上書きする
DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite"
DEFAULT_AUTH_AUDIENCE = "townscan"
# キーは HTTP ヘッダーに載せる。空白・改行・日本語が混ざると http.client が値そのもの（=キー）を含む例外を出すので、先に形で止める
_GEMINI_KEY_PATTERN = re.compile(r"[\x21-\x7e]+")
# モデル名は URL の path に入る。`/`・`:`・`?` などを通さない
_GEMINI_MODEL_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")


@dataclass(frozen=True)
class AuthConfig:
    """JWT（画面のサーバーの中の Better Auth が発行）を検証するための設定。値はどれも秘密ではない（公開の URL と名前）。

    issuer = Better Auth の BETTER_AUTH_URL（JWT の iss）、jwks_url = API から届く JWKS の URL（compose の中では http://web:3000/api/auth/jwks）、
    audience = JWT の aud（既定 townscan。画面側の JWT_AUDIENCE と同じ値）。
    """

    issuer: str
    jwks_url: str
    audience: str = DEFAULT_AUTH_AUDIENCE


def _http_url(raw: str) -> str | None:
    """末尾の / を外した URL。http(s) 以外・ホストなし・読めない形（`http://[::1`・ポートが数字でない など）は None。"""
    raw = raw.strip().rstrip("/")
    try:
        parts = urlsplit(raw)
        _ = parts.port  # 読むだけ。ポートの形が不正なら ValueError（urlsplit はポートを遅れて検査する）
    except ValueError:
        return None
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return None
    return raw


def _auth_from_env(env: dict[str, str]) -> AuthConfig | None:
    """AUTH_ISSUER と AUTH_JWKS_URL がそろっているときだけ有効（ログインは任意の機能。足りなければ None で、/api/me が 503 になるだけ）。

    形が不正な URL も、起動を止めずに「無い」として扱う。ここで ConfigError にすると、BETTER_AUTH_URL の書き間違い
    （compose が同じ値を AUTH_ISSUER へ渡す。例: localhost:3500）で api が起動のたびに落ち続け、web も api の healthy を
    待つので、チャット・地図まで使えなくなる。仕様 §2.1 の「どの場合も、いまの機能は壊れない」に反する。
    ログに出すのは変数名だけ（値は出さない。URL にユーザー名・パスワードが入っていることがあるため）。
    AUTH_AUDIENCE は形の検査が無い（任意の文字列。空なら既定）ので、起動を止める理由にならない。
    """
    urls: dict[str, str | None] = {}
    malformed: list[str] = []
    for name in ("AUTH_ISSUER", "AUTH_JWKS_URL"):
        raw = env.get(name, "").strip()
        urls[name] = _http_url(raw) if raw else None
        if raw and urls[name] is None:
            malformed.append(name)
    if malformed:
        log.warning(
            "環境変数 %s は http(s) の URL ではないため、ログインの検証を無効にしました（/api/me は 503。ほかの機能は動きます）",
            "・".join(malformed),
        )
        return None
    issuer, jwks_url = urls["AUTH_ISSUER"], urls["AUTH_JWKS_URL"]
    if issuer is None or jwks_url is None:
        return None
    return AuthConfig(issuer=issuer, jwks_url=jwks_url, audience=env.get("AUTH_AUDIENCE", "").strip() or DEFAULT_AUTH_AUDIENCE)


@dataclass(frozen=True)
class Settings:
    # repr に出さない（ログに秘密が混ざらないように）
    database_url: str = field(repr=False)
    tiles_dir: Path = Path("/data/townscan/tiles")
    llm_provider: str = "mock"
    # None = ログインは未設定（/api/me は 503。ほかの機能は影響を受けない）
    auth: AuthConfig | None = None
    # 実 LLM（Gemini。任意）。キーは repr に出さない（ログ・pytest の差分・例外に混ざらないように）。LLM_PROVIDER=gemini のときだけ使う
    gemini_api_key: str = field(default="", repr=False)
    gemini_model: str = DEFAULT_GEMINI_MODEL

    @classmethod
    def from_env(cls, environ: dict[str, str] | None = None) -> "Settings":
        env = os.environ if environ is None else environ
        url = env.get("DATABASE_URL", "").strip()
        if not url:
            raise ConfigError("環境変数 DATABASE_URL が未設定です（例: postgresql://ユーザー:パスワード@db:5432/townscan）")
        return cls(
            database_url=url,
            tiles_dir=Path(env.get("TILES_DIR", "/data/townscan/tiles")),
            llm_provider=env.get("LLM_PROVIDER", "mock").strip() or "mock",
            auth=_auth_from_env(env),
            gemini_api_key=env.get("GEMINI_API_KEY", "").strip(),
            gemini_model=env.get("GEMINI_MODEL", "").strip() or DEFAULT_GEMINI_MODEL,
        )

    def validate(self) -> None:
        if self.llm_provider not in SUPPORTED_LLM_PROVIDERS:
            raise ConfigError(
                f"LLM_PROVIDER={self.llm_provider!r} は未対応です。"
                f"使えるのは {'・'.join(SUPPORTED_LLM_PROVIDERS)} です（既定は mock）"
            )
        if self.llm_provider == "gemini":
            # 起動時に止める（実行中に初めて失敗するより早い）。キーの値は、どの文にも入れない
            if not self.gemini_api_key:
                raise ConfigError("LLM_PROVIDER=gemini には GEMINI_API_KEY が要ります（Infisical に登録したなら infisical run 経由で api を作り直す。使わないなら .env に書く）")
            if not _GEMINI_KEY_PATTERN.fullmatch(self.gemini_api_key):
                raise ConfigError("GEMINI_API_KEY の形が正しくありません（空白・改行・全角文字を含まない 1 行の文字列にしてください）")
            if not _GEMINI_MODEL_PATTERN.fullmatch(self.gemini_model):
                raise ConfigError("GEMINI_MODEL の形が正しくありません（英数字・ドット・ハイフン・アンダースコアだけ。例: gemini-3.5-flash-lite）")
