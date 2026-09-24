"""领域错误。

约定：核心层的错误都是**可判定的状态**（而不是“出错了”），每一类对应上层一个明确的
响应动作。协议层的 `Failure` 消息由这些错误映射而来（见 api/ws.py）。
"""

from __future__ import annotations


class TerminaldError(Exception):
    """本项目所有错误的基类。"""


class SessionNotFound(TerminaldError):
    """会话不存在或已关闭。"""


class SessionNameConflict(TerminaldError):
    """会话名已被占用。"""


class JournalTrimmed(TerminaldError):
    """请求的偏移已被日志裁剪，无法续传——调用方必须改走重建。"""

    def __init__(self, requested: int, start_offset: int) -> None:
        super().__init__(f"偏移 {requested} 已被裁剪（日志起点 {start_offset}）")
        self.requested = requested
        self.start_offset = start_offset


class OffsetAhead(TerminaldError):
    """客户端声称的偏移超过服务端已产生的字节数——本地状态与服务端不一致。"""

    def __init__(self, requested: int, end_offset: int) -> None:
        super().__init__(f"偏移 {requested} 越过日志末尾 {end_offset}")
        self.requested = requested
        self.end_offset = end_offset


class HostUnavailable(TerminaldError):
    """宿主实现不可用（例如缺少 pywezterm 扩展）。"""


class ProtocolViolation(TerminaldError):
    """客户端发来的消息在当前状态下非法。"""
