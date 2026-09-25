"""领域错误。

约定：核心层的错误都是**可判定的状态**（而不是“出错了”），每一类对应上层一个明确的
响应动作。协议层的 `Failure` 消息由这些错误映射而来（见 api/ws.py）。

每个错误带三层信息，**受众不同，不能混用**：

- `code`：给客户端与排查用的**稳定标识**（snake_case）。**不是**类名的镜像——
  类名会随重构改名，而这个字符串是协议的一部分，改名即破坏兼容性。
- `user_message`：面向**浏览器前面那个人**的**一句话**，只说发生了什么。
  处置说明（怎么补依赖、配什么环境变量）与指向别处的话（「详情见服务端日志」
  「见 README 的「运行」一节」）都是运维备注，写进来只会把一句报错撑成一段说明书——
  曾经就写成 `未找到 pywezterm。它是仓库里的长期依赖 vendor/pywezterm/（不安装）：
  把仓库的 vendor/ 加进 PYTHONPATH（见 backend/README.md 的「运行」一节）`，
  正确的是 `未找到 pywezterm，无法新建会话。`
  另一条：**不许承诺没发生的事**——曾经写着「正在重新载入」，而前端收到 `error`
  只显示提示、没有任何重载分支。
- `str(exc)`：**技术细节**，只进服务端日志与 REST 的 HTTP detail。要写多长写多长。

这三层分开是因为它们曾经是同一个字符串：那时 `Failure` 直接拿 `type(exc).__name__`
与 `str(exc)`，于是部署指引被原样弹给使用者；而 `SessionNotFound` 这种没有自定义
`__init__` 的错误还会让用户看到一条空白提示。

前两条由 `tests/test_error_messages.py` 机器检查（禁用词、字数、句号数、假承诺）。
"""

from __future__ import annotations

from typing import ClassVar


class TerminaldError(Exception):
    """本项目所有错误的基类。"""

    #: 协议层的稳定标识（覆盖它，不要依赖类名）
    code: ClassVar[str] = "internal_error"
    #: 面向使用者的一句话文案（同样受上面那些约束）
    user_message: ClassVar[str] = "服务端处理这个请求时出错了。"


class SessionNotFound(TerminaldError):
    """会话不存在或已关闭。"""

    code = "session_not_found"
    user_message = "会话不存在。"

    def __init__(self, session_id: str) -> None:
        super().__init__(f"会话不存在: {session_id}")
        self.session_id = session_id


class SessionNameConflict(TerminaldError):
    """会话名已被占用。"""

    code = "session_name_conflict"
    user_message = "会话名已被占用，换一个试试。"

    def __init__(self, name: str) -> None:
        super().__init__(f"会话名已被占用: {name}")
        self.name = name


class JournalTrimmed(TerminaldError):
    """请求的偏移已被日志裁剪，无法续传——调用方必须改走重建。"""

    code = "journal_trimmed"
    user_message = "请求的读取位置已被裁剪。"

    def __init__(self, requested: int, start_offset: int) -> None:
        super().__init__(f"偏移 {requested} 已被裁剪（日志起点 {start_offset}）")
        self.requested = requested
        self.start_offset = start_offset


class OffsetAhead(TerminaldError):
    """客户端声称的偏移超过服务端已产生的字节数——本地状态与服务端不一致。"""

    code = "offset_ahead"
    user_message = "请求的读取位置超出服务端已有内容。"

    def __init__(self, requested: int, end_offset: int) -> None:
        super().__init__(f"偏移 {requested} 越过日志末尾 {end_offset}")
        self.requested = requested
        self.end_offset = end_offset


class HostUnavailable(TerminaldError):
    """宿主实现不可用（例如缺少 pywezterm 扩展）。

    怎么补依赖（`vendor/` 在哪、wheel 怎么打）属于**部署者**的事，由
    `runtime/pywezterm_host.load_error()` 打进服务端日志；使用者既看不到日志也
    改不了环境，因此他只该知道「服务端没起来」。
    """

    code = "host_unavailable"
    user_message = "未找到 pywezterm，无法新建会话。"


class ProtocolViolation(TerminaldError):
    """客户端发来的消息在当前状态下非法。"""

    code = "protocol_violation"
    user_message = "请求在当前状态下不被接受。"


__all__ = [
    "HostUnavailable",
    "JournalTrimmed",
    "OffsetAhead",
    "ProtocolViolation",
    "SessionNameConflict",
    "SessionNotFound",
    "TerminaldError",
]
