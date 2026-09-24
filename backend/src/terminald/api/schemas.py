"""REST 层的请求/响应模型。

只有**不依赖会话实时状态**的操作才走 REST（探活、会话增删查）。所有订阅、输入、
流控、同步语义一律走 WebSocket 文本/二进制帧——把同一件事同时暴露在两个通道上，
迟早会出现两条通道状态不一致的问题。

响应模型直接复用 `protocol.messages.SessionInfo`，避免“REST 版的会话摘要”与
“WS 版的会话摘要”悄悄分叉。
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from ..protocol.messages import SESSION_NAME_MAX


class CreateSessionRequest(BaseModel):
    """新建会话。

    有意**没有** `cols` / `rows` 字段：终端尺寸由终端侧决定，客户端不参与
    （见 docs/architecture.md 的尺寸模型）。

    `name` 的约束来自协议层（`SESSION_NAME_MAX`）：REST 与 WebSocket 是同一个操作的两个
    入口，校验必须在**一处**定义，否则两边会各说各话。
    """

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=SESSION_NAME_MAX)
    argv: list[str] | None = None
    cwd: str | None = None


class HealthResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: str = "ok"
    version: str
    sessions: int
    clients: int


__all__ = ["CreateSessionRequest", "HealthResponse"]
