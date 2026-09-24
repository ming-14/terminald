"""会话 —— 服务端一等对象，生命周期与任何连接无关。

这是“多会话 / 刷新不丢 / 多客户端同步”三件事共同的落点：

- 会话独立持有 `Journal`（内容真源）与 `SessionHost`（PTY + 终端模型）。
- 客户端只是订阅者，`attach` / `detach` 不影响会话本身；因此切换标签、刷新页面、
  关掉所有网页都不会中断会话里正在跑的程序。
- 焦点由会话**聚合**成一个布尔量再下发给应用：任一客户端聚焦即 `True`，
  全部失焦才 `False`。绝不让每个客户端各自上报（否则应用会收到互相矛盾的 FocusIn/Out）。

输入不在这里转发：它是运行时的职责（唯一写者 = `SessionRunner` 的写线程），
见 `core/ports.py` 的线程归属表。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime

from ..protocol.messages import SessionInfo, SessionStatus
from .client import Client
from .journal import Journal
from .ports import HostMetadata, SessionHost


@dataclass(slots=True)
class Session:
    id: str
    name: str
    cols: int
    rows: int
    journal: Journal
    host: SessionHost | None = None
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    status: SessionStatus = SessionStatus.RUNNING
    exit_code: int | None = None
    meta: HostMetadata = field(default_factory=HostMetadata)
    _subscribers: dict[str, Client] = field(default_factory=dict, repr=False)
    _focused: set[str] = field(default_factory=set, repr=False)

    # ------------------------------------------------------------ 订阅

    @property
    def subscribers(self) -> tuple[Client, ...]:
        return tuple(self._subscribers.values())

    def attach(self, client: Client) -> None:
        client.session_id = self.id
        self._subscribers[client.id] = client
        if client.focused:
            self._focused.add(client.id)

    def detach(self, client_id: str) -> None:
        self._subscribers.pop(client_id, None)
        self._focused.discard(client_id)

    # ------------------------------------------------------------ 焦点聚合

    def set_client_focus(self, client_id: str, focused: bool) -> bool | None:
        """更新某客户端的焦点；返回需要下发给应用的聚合值（无变化返回 None）。"""
        before = bool(self._focused)
        if focused:
            self._focused.add(client_id)
        else:
            self._focused.discard(client_id)
        after = bool(self._focused)
        if after == before:
            return None
        return after

    @property
    def focused(self) -> bool:
        return bool(self._focused)

    # ------------------------------------------------------------ 视图

    def info(self) -> SessionInfo:
        return SessionInfo(
            id=self.id,
            name=self.name,
            cols=self.cols,
            rows=self.rows,
            status=self.status,
            created_at=self.created_at.isoformat(),
            pid=self.host.pid if self.host is not None else None,
            cwd=self.meta.cwd,
            title=self.meta.title,
        )


__all__ = ["Session"]
