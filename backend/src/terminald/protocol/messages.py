"""控制消息（文本帧 / JSON）。

二进制帧只承载终端字节流；**所有**控制语义都在这里。消息以 `t` 字段做判别标签，
用 pydantic 严格校验（`extra="forbid"`），因此任何字段拼写错误都会在边界立刻暴露，
而不是变成线上一个静默失效的功能。

有意**不做**的三类消息，理由记录在此以免后来者困惑：

- **无 resize（两个方向都没有）**：`cols`/`rows` 是终端自身属性，由终端侧在会话创建时
  决定（见 config.py 与 docs/architecture.md）。当前没有任何“终端侧改尺寸”的代码路径，
  所以也没有对应的下行消息——真要加时才加，不留占位面。
- **无 Mouse 消息**：鼠标编码由 xterm.js 依据应用开启的追踪模式完成，结果与键盘
  一样走 INPUT 二进制帧；应用未接管鼠标时由前端本地做选择/链接，服务端无需知情。
- **无 Paste 消息**：bracketed paste 的包裹由知道该模式的一方（xterm.js）完成，
  同样落到 INPUT 帧。
"""

from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Literal, TypeAlias

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter

from . import PROTOCOL_VERSION

#: 会话名的长度上限。REST（`api/schemas.py`）与 WebSocket 两个入口**共用这一个值**：
#: 同一个操作在两个入口上用不同的校验，只会得到「REST 拒了、WS 收了」这种查不出来的分歧。
#: 名字会随 `sessions` 广播给所有客户端，所以它的上界是协议的一部分，不是 UI 的偏好。
SESSION_NAME_MAX = 64


class MessageError(ValueError):
    """控制消息非法。"""


class _Msg(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class SessionStatus(StrEnum):
    RUNNING = "running"
    EXITED = "exited"


class SessionInfo(_Msg):
    """会话摘要（列表与 UI 用）。"""

    id: str
    name: str
    cols: int
    rows: int
    status: SessionStatus
    created_at: str  # ISO-8601
    pid: int | None = None
    cwd: str | None = None
    title: str | None = None


# --------------------------------------------------------------- C → S


class Hello(_Msg):
    """握手：客户端自述协议版本。版本不符直接拒绝，避免半懂协议产生诡异行为。"""

    t: Literal["hello"] = "hello"
    protocol: int = PROTOCOL_VERSION
    client: str = ""


class Attach(_Msg):
    """订阅一个会话。

    `resume` 是客户端**已经应用到本地终端**的输出字节偏移（从 0 开始）；
    为 None 表示全新客户端（没有任何本地状态）。
    """

    t: Literal["attach"] = "attach"
    session: str
    resume: int | None = Field(default=None, ge=0)


class Detach(_Msg):
    """结束订阅但保留连接（切换会话/回到列表页）。会话本身不受影响。"""

    t: Literal["detach"] = "detach"


class Resync(_Msg):
    """请求从指定偏移重新对齐（落后、或本地状态可疑时由客户端发起）。"""

    t: Literal["resync"] = "resync"
    session: str
    offset: int = Field(ge=0)


class Ack(_Msg):
    """确认“已解析（渲染）到 offset 之前的全部字节”，用于服务端流控。"""

    t: Literal["ack"] = "ack"
    offset: int = Field(ge=0)


class Focus(_Msg):
    """窗口聚焦变化（聚合后转发给应用，见 docs/architecture.md）。"""

    t: Literal["focus"] = "focus"
    focused: bool


class SessionCreate(_Msg):
    t: Literal["session.create"] = "session.create"
    # 空名字不是一个「更短的合法名字」：它会让侧栏出现一张点不中名字的卡片，
    # 所以下界是 1 而不是 0。约束在这里定，两个入口都受它管。
    name: str | None = Field(default=None, min_length=1, max_length=SESSION_NAME_MAX)
    argv: list[str] | None = None
    cwd: str | None = None


class SessionList(_Msg):
    t: Literal["session.list"] = "session.list"


class SessionClose(_Msg):
    t: Literal["session.close"] = "session.close"
    session: str


class SessionRename(_Msg):
    t: Literal["session.rename"] = "session.rename"
    session: str
    name: str = Field(min_length=1, max_length=SESSION_NAME_MAX)


# --------------------------------------------------------------- S → C


class HelloOk(_Msg):
    t: Literal["hello_ok"] = "hello_ok"
    protocol: int = PROTOCOL_VERSION
    server: str = ""


class Attached(_Msg):
    """订阅成功。`offset` 是**本次对齐完成处**的偏移，客户端据此设置下一帧基线。

    `resumed` 的含义是**这次对齐是否无损**，而不是“是不是老客户端”：

    - `True`：字节级对齐（补断档，或全新客户端从 offset 0 整段重放）。
    - `False`：日志已裁剪到断点之前，只能下发模型快照重建——唯一有损的路径。

    客户端不需要因此改变行为（两种情况后续都从 `offset` 续接），它的用途是
    可观测性：无损对齐与有损重建应该被分开计数。

    `cols` / `rows` / `scrollback` 都是**终端侧属性**，在这里一并交付：它们决定客户端如何
    渲染与保留历史，而客户端无权修改。`scrollback` 尤其不能不传——否则前端只能写死一个数
    去和服务端配置对齐，那是个会漂移的常数。
    """

    t: Literal["attached"] = "attached"
    session: str
    cols: int
    rows: int
    scrollback: int
    offset: int
    resumed: bool


class Meta(_Msg):
    """会话元数据（来自终端模型，经 OSC 解析得到）。"""

    t: Literal["meta"] = "meta"
    session: str
    title: str | None = None
    cwd: str | None = None
    progress_label: str = "none"
    progress_value: int | None = None


class Exited(_Msg):
    t: Literal["exited"] = "exited"
    session: str
    code: int


class Sessions(_Msg):
    t: Literal["sessions"] = "sessions"
    items: tuple[SessionInfo, ...] = ()


class Behind(_Msg):
    """服务端告知该客户端已落后：增量已停止发送，请发起 Resync。

    这是“绝不静默丢弃字节”的落点——落后是**显式状态**，不是静默丢失。
    """

    t: Literal["behind"] = "behind"
    session: str
    offset: int
    reason: str


class InputHold(_Msg):
    """输入方向的流控：请该客户端**暂缓/恢复**发送输入。

    为什么是让发送方停下来，而不是服务端停读接收循环：停读会把同一条连接上的控制面
    （detach、关会话、焦点上报）一起堵住，且对端在暂停期间断开时服务端无从察觉
    （ASGI 只把 disconnect 放进队列，不会取消应用任务）。所以服务端到高水位就下发
    `paused=true`，客户端在本端按序排队，收到 `paused=false` 后原序补发。

    与 `Behind` 同构：拥塞是**显式状态**，两端都能观测到；字节一个不丢。
    客户端必须按 `session` 过滤——切换会话后到达的旧暂缓/放行不得影响新订阅。
    """

    t: Literal["input_hold"] = "input_hold"
    session: str
    paused: bool


class Failure(_Msg):
    t: Literal["error"] = "error"
    code: str
    message: str


ClientMessage: TypeAlias = Annotated[
    Hello
    | Attach
    | Detach
    | Resync
    | Ack
    | Focus
    | SessionCreate
    | SessionList
    | SessionClose
    | SessionRename,
    Field(discriminator="t"),
]
ServerMessage: TypeAlias = Annotated[
    HelloOk | Attached | Meta | Exited | Sessions | Behind | InputHold | Failure,
    Field(discriminator="t"),
]

_client_adapter: TypeAdapter[ClientMessage] = TypeAdapter(ClientMessage)
_server_adapter: TypeAdapter[ServerMessage] = TypeAdapter(ServerMessage)


def parse_client_message(raw: str | bytes) -> ClientMessage:
    """解析客户端控制消息；非法输入抛 MessageError。"""
    try:
        return _client_adapter.validate_json(raw)
    except Exception as exc:  # pydantic ValidationError 及 JSON 解析错误
        raise MessageError(f"非法控制消息: {exc}") from exc


def parse_server_message(raw: str | bytes) -> ServerMessage:
    """解析服务端控制消息（前端测试与契约测试用）。"""
    try:
        return _server_adapter.validate_json(raw)
    except Exception as exc:
        raise MessageError(f"非法控制消息: {exc}") from exc


def dump(message: ServerMessage | ClientMessage) -> str:
    """序列化为 JSON 文本。"""
    return message.model_dump_json()


def dump_bytes(message: ServerMessage | ClientMessage) -> bytes:
    """序列化为 UTF-8 字节（直接丢给 WebSocket）。"""
    return dump(message).encode("utf-8")


# --------------------------------------------------------------- 形状契约

#: 前端 `messages.ts` 里那套字段校验器的取值域。两边必须用**同一组**名字，
#: 否则「形状一致」这句话没有意义。
_KIND_BY_TYPE: dict[object, str] = {str: "str", int: "int", bool: "bool"}


def _kind(annotation: object) -> str:
    """把一个字段注解映射成前端校验器认识的 Kind。

    只支持协议里实际用到的形状；遇到没见过的注解就**报错**而不是猜一个——猜错会让
    契约变成假的（前端会以为它在校验一个不存在的形状）。
    """
    import types
    import typing

    origin = typing.get_origin(annotation)
    args = typing.get_args(annotation)

    # `X | None` → 可空形态（两种写法：typing.Union[X, None] 与 PEP 604 的 X | None）
    if origin is typing.Union or origin is types.UnionType:
        non_none = [arg for arg in args if arg is not type(None)]
        if len(non_none) == 1 and len(args) == 2:
            return f"{_kind(non_none[0])}|null"

    # `tuple[SessionInfo, ...]` → 会话数组
    if origin in {tuple, list} and args and args[0] is SessionInfo:
        return "sessionInfo[]"

    if annotation is SessionStatus or annotation is str:
        return "str"
    if annotation in _KIND_BY_TYPE:
        return _KIND_BY_TYPE[annotation]
    raise MessageError(f"形状契约不认识这个注解: {annotation!r}")


def _fields(model: type[BaseModel]) -> dict[str, str]:
    """模型的字段 → Kind（不含判别标签 `t`：它不是数据，是类型本身）。"""
    return {
        name: _kind(field.annotation) for name, field in model.model_fields.items() if name != "t"
    }


def server_message_shapes() -> dict[str, dict[str, str]]:
    """服务端下发的每种消息的字段形状（`t` → 字段 → Kind）。

    这是**前后端共享的契约**，与 `vectors/basic.json` 同一思路：只有一份事实
    （`vectors/shapes.json`），由这里的模型生成、由前端测试逐字比对。
    手抄一份到 TypeScript 里是允许的，但必须与这份生成物一致。
    """
    models: tuple[tuple[str, type[BaseModel]], ...] = (
        ("hello_ok", HelloOk),
        ("attached", Attached),
        ("meta", Meta),
        ("exited", Exited),
        ("sessions", Sessions),
        ("behind", Behind),
        ("input_hold", InputHold),
        ("error", Failure),
    )
    shapes = {name: _fields(model) for name, model in models}
    # 会话摘要嵌在 `sessions` 里，前端也要校验它，所以单独给一份
    shapes["session_info"] = _fields(SessionInfo)
    return shapes


__all__ = [
    "PROTOCOL_VERSION",
    "SESSION_NAME_MAX",
    "Ack",
    "Attach",
    "Attached",
    "Behind",
    "ClientMessage",
    "Detach",
    "Exited",
    "Failure",
    "Focus",
    "Hello",
    "HelloOk",
    "InputHold",
    "MessageError",
    "Meta",
    "Resync",
    "ServerMessage",
    "SessionClose",
    "SessionCreate",
    "SessionInfo",
    "SessionList",
    "SessionRename",
    "SessionStatus",
    "Sessions",
    "dump",
    "dump_bytes",
    "parse_client_message",
    "parse_server_message",
    "server_message_shapes",
]
