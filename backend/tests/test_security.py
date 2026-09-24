"""来源校验测试。

这一层是当前版本唯一的安全边界（不做认证 → 只能绑回环）。**恶意网页可以对
`127.0.0.1:8765` 发起 WebSocket 连接**，浏览器不会拦——Origin 校验是唯一防线，
所以它必须有测试，而不是靠“看起来对”。
"""

from __future__ import annotations

import pytest

from terminald.api.security import assert_websocket_origin, host_of, is_loopback_host
from terminald.core.errors import ProtocolViolation


@pytest.mark.parametrize(
    "host",
    ["127.0.0.1", "127.1.2.3", "localhost", "LocalHost", "::1", "[::1]", "app.localhost"],
)
def test_loopback_hosts_are_accepted(host: str) -> None:
    assert is_loopback_host(host) is True


@pytest.mark.parametrize(
    "host",
    ["0.0.0.0", "192.168.1.10", "example.com", "127.0.0.1.attacker.com", "256.1.1.1", "", None],
)
def test_non_loopback_hosts_are_rejected(host: str | None) -> None:
    assert is_loopback_host(host) is False


@pytest.mark.parametrize(
    ("authority", "expected"),
    [
        ("127.0.0.1:8765", "127.0.0.1"),
        ("localhost", "localhost"),
        ("[::1]:8765", "[::1]"),
        ("", None),
        (None, None),
    ],
)
def test_host_of(authority: str | None, expected: str | None) -> None:
    assert host_of(authority) == expected


def test_loopback_origin_is_accepted() -> None:
    assert_websocket_origin("127.0.0.1:8765", "http://127.0.0.1:8765")


def test_missing_origin_is_accepted_for_non_browser_clients() -> None:
    """非浏览器客户端（CLI、测试）不发 Origin：它不在“恶意网页”这个威胁模型里。"""
    assert_websocket_origin("127.0.0.1:8765", None)


def test_foreign_origin_is_rejected() -> None:
    with pytest.raises(ProtocolViolation):
        assert_websocket_origin("127.0.0.1:8765", "https://evil.example")


def test_localhost_lookalike_is_rejected() -> None:
    with pytest.raises(ProtocolViolation):
        assert_websocket_origin("127.0.0.1:8765", "http://127.0.0.1.evil.example")


def test_non_http_scheme_is_rejected() -> None:
    with pytest.raises(ProtocolViolation):
        assert_websocket_origin("127.0.0.1:8765", "file:///etc/passwd")


def test_foreign_host_header_is_rejected() -> None:
    """Host 头被伪造（DNS rebinding）时同样拒绝。"""
    with pytest.raises(ProtocolViolation):
        assert_websocket_origin("evil.example:8765", None)


def test_wildcard_bind_address_is_not_loopback() -> None:
    with pytest.raises(ProtocolViolation):
        assert_websocket_origin("0.0.0.0:8765", "http://0.0.0.0:8765")
