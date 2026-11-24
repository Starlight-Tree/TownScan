import socket

import pytest


@pytest.fixture(autouse=True)
def _no_network(monkeypatch):
    """pipeline のテストは外部へ通信しない（地理院などの API は承認の範囲外）。通信しようとしたら失敗させる。"""

    def blocked(self, *args, **kwargs):
        raise RuntimeError("テストから外部への通信は禁止（pipeline）")

    monkeypatch.setattr(socket.socket, "connect", blocked)
    monkeypatch.setattr(socket.socket, "connect_ex", blocked)
