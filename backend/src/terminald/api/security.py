"""传输层安全边界。

当前版本**不做认证**（用户决定：以后再说）。这不是“省事”，而是一个必须被围栏兜住的
决定：这个进程在自己的机器上开了一个 shell，任何能连上该端口的人都能操作它。

因此这里只有一件事——把暴露面钉死在回环地址上：

1. 服务器只 bind `127.0.0.1`（配置层保证）。
2. WebSocket 握手校验 `Host` / `Origin`：两者都必须是回环主机名。

第 2 条不能省。浏览器不会对 WebSocket 施加 CORS 保护，但页面的 `Origin` 仍然会被
带上；而**恶意网页可以用 `<script>` 对 `127.0.0.1:8765` 发起 WS 连接**——这是真实的
攻击面（DNS rebinding / 本地服务扫描），不是理论问题。校验 Origin 是这里唯一的防线。

一旦将来加认证，这两个检查仍然要在认证之前执行。
"""

from __future__ import annotations

from urllib.parse import urlsplit

from ..core.errors import ProtocolViolation

#: 允许的回环主机名（小写）。`[::1]` 是 IPv6 回环的 URL 形式。
_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1", "[::1]"})

_LOOPBACK_HOST_SUFFIXES = (".localhost",)


def is_loopback_host(host: str | None) -> bool:
    """判断 URL 里的主机名是否指向本机。

    注意**不接受** `0.0.0.0`：那不是本机地址，而是“任意地址”的占位符，出现在 Origin
    或 Host 里只可能是伪造或配置错误。
    """
    if not host:
        return False
    name = host.strip().lower()
    if name in _LOOPBACK_HOSTS:
        return True
    # 127.0.0.0/8 整段都是回环
    if name.startswith("127."):
        parts = name.split(".")
        if len(parts) == 4 and all(p.isdigit() and 0 <= int(p) <= 255 for p in parts):
            return True
    return name.endswith(_LOOPBACK_HOST_SUFFIXES)


def host_of(authority: str | None) -> str | None:
    """从 `Host` 头（`host:port` / `[::1]:port`）取出主机名。"""
    if not authority:
        return None
    value = authority.strip()
    if value.startswith("["):  # IPv6 字面量
        end = value.find("]")
        return value[: end + 1] if end != -1 else value
    return value.rsplit(":", 1)[0] if ":" in value else value


def assert_websocket_origin(headers_host: str | None, headers_origin: str | None) -> None:
    """校验 WS 握手来源；不合法则抛 `ProtocolViolation`（由调用方以 1008 关闭）。

    `Origin` 缺失是允许的：非浏览器客户端（CLI、集成测试）不会发送它，而它们不受
    “恶意网页”这一威胁模型约束。反过来，**一旦带上就必须是回环**。
    """
    host = host_of(headers_host)
    if host is not None and not is_loopback_host(host):
        raise ProtocolViolation(f"Host 非回环地址: {headers_host!r}")

    if headers_origin is None:
        return
    parsed = urlsplit(headers_origin)
    if parsed.scheme not in ("http", "https"):
        raise ProtocolViolation(f"Origin 协议非法: {headers_origin!r}")
    if not is_loopback_host(parsed.hostname):
        raise ProtocolViolation(f"Origin 非回环地址: {headers_origin!r}")


__all__ = ["assert_websocket_origin", "host_of", "is_loopback_host"]
