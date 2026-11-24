"""環境変数からの設定。秘密（DB のパスワード）は DATABASE_URL に入るので、表示・ログに出さない。"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


class ConfigError(RuntimeError):
    """設定が足りない・不正なとき。起動時に出して止める。"""


SUPPORTED_LLM_PROVIDERS = ("mock",)


@dataclass(frozen=True)
class Settings:
    # repr に出さない（ログに秘密が混ざらないように）
    database_url: str = field(repr=False)
    tiles_dir: Path = Path("/data/townscan/tiles")
    llm_provider: str = "mock"

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
        )

    def validate(self) -> None:
        # 実モデルは承認を得てから足す。それまでは mock 以外で起動させない。
        if self.llm_provider not in SUPPORTED_LLM_PROVIDERS:
            raise ConfigError(
                f"LLM_PROVIDER={self.llm_provider!r} は未対応です。"
                "実モデルへの切り替えは承認後に実装します（既定は mock）"
            )
