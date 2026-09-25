"""WebSocket 端点 —— 唯一的实时通道。

一条连接上有两个并发任务，职责严格分开：

- **接收循环**：解析客户端消息（文本帧 → 控制消息；二进制帧 → 输入字节），
  同步地交给 `Hub`。它只在**输入方向**直接发两种东西：帧错位与输入越限的
  `Failure`——两者都是“读完这一帧就必须断开”的致命路径，走 outbox 反而会把
  错误排在断开之后。其余一律不发送。
- **发送循环**：从 `Hub` 的 outbox 排空字节并 `send_bytes`。它不解析任何东西。

分开的原因不是风格，而是**正确性**：`Hub` 的所有决策（订阅、补流、对齐点登记）
发生在一个没有 await 的临界区里，因此天然原子；如果让 `Hub` 自己去 await
`send_bytes`，慢客户端会把整个广播路径拖住，而且状态机中间会出现 await 点。

## 断开连接 = 只解除订阅

连接消失**绝不**触发会话销毁：会话归后端所有，进程退出也不销毁（见 Hub 的说明）。
所以这里的清理只有 `hub.drop_client()`。
"""

from __future__ import annotations

import asyncio
import contextlib
from enum import StrEnum
from uuid import uuid4

from fastapi import APIRouter, WebSocket
from starlette.websockets import WebSocketDisconnect, WebSocketState

from ..core.errors import ProtocolViolation
from ..logs import get_logger
from ..protocol import PROTOCOL_VERSION, frames
from ..protocol.messages import (
    Failure,
    Hello,
    HelloOk,
    MessageError,
    parse_client_message,
)
from ..runtime.runner import InputVerdict
from ..service.hub import Hub
from .security import assert_websocket_origin

_log = get_logger(__name__)

router = APIRouter()

#: 握手上限：连上却不发 hello 的连接直接断开（避免半开连接堆积）
HELLO_TIMEOUT = 10.0
#: 控制消息上限：控制消息是固定结构的小 JSON，1 MiB 已是两个数量级的余量
MAX_CONTROL_BYTES = 1 << 20
#: 输入积压越限时给人的说明（关闭帧的 reason 也会带上一份）。
#: 关闭帧的 reason 走的是 WebSocket 协议，收得到它的是对端程序与抓包的人，
#: 不是终端使用者，所以这里保留技术措辞。
INPUT_OVERFLOW_REASON = "输入积压超出上限：已暂缓仍继续发送"
#: 同一个情况**弹给使用者**的文案（`Failure.message`）。连接随即断开，他能做的
#: 只有重连，因此就这么说。
INPUT_OVERFLOW_MESSAGE = "输入太多，服务端已断开连接，请重新连接。"
#: 自定义关闭码
WS_NORMAL = 1000
WS_REJECTED = 1008
WS_PROTOCOL_ERROR = 1002
WS_TOO_LARGE = 1009
#: 握手不合法的错误码（首条不是 hello / JSON 非法 / 字段不合法）
BAD_HELLO_CODE = "bad_hello"

#: 下面几条 `Failure.message` 都面向**使用者**，因此只写「发生了什么」——
#: 一句话，不带处置说明。原因、字段、该怎么修一律进服务端日志，不挂在报错句子后面。
#: 唯一例外是可以当场照做的动作（例如「刷新页面后重试」）。
BAD_HELLO_MESSAGE = "连接被拒绝：握手不合法。"
PROTOCOL_MISMATCH_MESSAGE = "页面与服务端版本不一致，请刷新页面后重试。"
BAD_MESSAGE_MESSAGE = "这个请求无法识别，已被忽略。"
TOO_LARGE_MESSAGE = "这个请求太大，已被忽略。"


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    """`/ws` —— 一个客户端连接。"""
    hub: Hub = websocket.app.state.hub

    # 未通过来源校验就不要 accept：Starlette 会以 HTTP 403 拒绝升级。
    try:
        assert_websocket_origin(websocket.headers.get("host"), websocket.headers.get("origin"))
    except ProtocolViolation as exc:
        _log.warning("拒绝 WS 握手: %s", exc)
        await websocket.close(code=WS_REJECTED, reason=str(exc))
        return

    await websocket.accept()
    client_id = f"c{uuid4().hex[:8]}"

    try:
        hello = await _read_hello(websocket)
    except WebSocketDisconnect:
        return
    except TimeoutError:
        await _close(websocket, WS_REJECTED, "握手超时")
        return
    except (ProtocolViolation, MessageError) as exc:
        # 握手不合法（首条不是 hello、JSON 坏、字段类型错）也要给一个**可诊断**的结局：
        # `error{code:bad_hello}` + 明确关闭码。不接住的话异常会逃出端点，客户端只看到
        # 一个 1006 硬断（实测：什么都没收到），服务端则每次留一条 ASGI traceback（A3）。
        _log.warning("拒绝 WS 握手: %s", exc)
        await _send_control(websocket, Failure(code=BAD_HELLO_CODE, message=BAD_HELLO_MESSAGE))
        await _close(websocket, WS_PROTOCOL_ERROR, "握手不合法")
        return

    if hello.protocol != PROTOCOL_VERSION:
        _log.warning(
            "拒绝协议版本不符的客户端 %s：期望 %s，收到 %s",
            client_id,
            PROTOCOL_VERSION,
            hello.protocol,
        )
        await _send_control(
            websocket,
            Failure(code="protocol_mismatch", message=PROTOCOL_MISMATCH_MESSAGE),
        )
        await _close(websocket, WS_PROTOCOL_ERROR, "协议版本不符")
        return

    hub.register_client(client_id, label=hello.client)
    await _send_control(websocket, HelloOk(server="terminald"))
    _log.info("客户端已连接 %s (%s)", client_id, hello.client or "anonymous")

    try:
        await _serve(hub, websocket, client_id)
    finally:
        hub.drop_client(client_id)
        # 显式关闭：本端点是连接的所有者，结束前必须把关闭帧发出去。依赖 ASGI 服务器
        # 在应用返回后收尾，对端只能等到 TCP 超时；而“帧解析失败”这类路径本来就必须
        # 立刻断开（继续读只会放大错位）。客户端已断开时这里是空操作。
        await _close(websocket, WS_NORMAL, "连接结束")
        _log.info("客户端已断开 %s", client_id)


# --------------------------------------------------------------- 主体


async def _serve(hub: Hub, websocket: WebSocket, client_id: str) -> None:
    inbound = asyncio.create_task(
        _receive_loop(hub, websocket, client_id), name=f"ws-recv-{client_id}"
    )
    outbound = asyncio.create_task(
        _send_loop(hub, websocket, client_id), name=f"ws-send-{client_id}"
    )
    try:
        done, pending = await asyncio.wait({inbound, outbound}, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        for task in pending:
            # 被我们取消的子任务会抛 CancelledError，收尾阶段必须吞掉它；同时也不该让
            # 另一条循环里的异常盖住已完成任务要冒出的真实异常。
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        # 让已完成任务里的真实异常冒出来（CancelledError 除外）
        for task in done:
            task.result()
    except asyncio.CancelledError:
        inbound.cancel()
        outbound.cancel()
        raise


async def _send_loop(hub: Hub, websocket: WebSocket, client_id: str) -> None:
    """把 Hub 为该客户端准备的负载送到 socket。

    控制消息走文本帧、终端字节流走二进制帧（WebSocket 原生的两种形态，不用自己多
    路复用）；**相邻的二进制段会合并成一次发送**，避免一帧一个 syscall。顺序严格
    保持队列顺序——“快照在旧增量之后”这个收敛保证就靠它。
    """
    while True:
        if not await hub.wait_output(client_id):
            return
        pending = bytearray()
        for item in hub.take_output(client_id):
            if item.binary:
                pending.extend(item.payload)
                continue
            if pending and _writable(websocket):
                await websocket.send_bytes(bytes(pending))
                pending.clear()
            if _writable(websocket):
                await websocket.send_text(item.payload.decode("utf-8"))
        if pending and _writable(websocket):
            await websocket.send_bytes(bytes(pending))
        # 排空后让 Hub 继续按游标补齐（补流可能因水位上限中途停过）
        hub.on_drained(client_id)


async def _receive_loop(hub: Hub, websocket: WebSocket, client_id: str) -> None:
    """解析客户端消息并交给 Hub。"""
    while True:
        try:
            message = await websocket.receive()
        except WebSocketDisconnect:
            return

        if message.get("type") == "websocket.disconnect":
            return

        text = message.get("text")
        if text is not None:
            if len(text) > MAX_CONTROL_BYTES:
                await _send_control(websocket, Failure(code="too_large", message=TOO_LARGE_MESSAGE))
                await _close(websocket, WS_TOO_LARGE, "控制消息过大")
                return
            await _dispatch_control(hub, websocket, client_id, text)
            continue

        data = message.get("bytes")
        if data is None:
            continue
        outcome = _dispatch_input(hub, client_id, data)
        if outcome is _InputOutcome.FRAME_ERROR:
            # 帧错位时必须断开，并让对端知道原因是协议错误
            await _close(websocket, WS_PROTOCOL_ERROR, "二进制帧解析失败")
            return
        if outcome is _InputOutcome.OVERFLOW:
            # 服务端已经明确暂缓过输入，对端仍灌到硬上限：**显式**断开并说明原因。
            # 这里只断开、不丢我们已收下的字节（它们仍在写队列里，会被写完）。
            await _send_control(
                websocket,
                Failure(code="input_overflow", message=INPUT_OVERFLOW_MESSAGE),
            )
            await _close(websocket, WS_TOO_LARGE, INPUT_OVERFLOW_REASON)
            return


async def _dispatch_control(hub: Hub, websocket: WebSocket, client_id: str, text: str) -> None:
    try:
        parsed = parse_client_message(text)
    except MessageError as exc:
        _log.warning("客户端 %s 发来非法控制消息: %s", client_id, exc)
        await _send_control(websocket, Failure(code="bad_message", message=BAD_MESSAGE_MESSAGE))
        return
    # 不必在这里接 `TerminaldError`：`hub.handle_message` 内部已经把它换成一次
    # `Failure`（技术细节只进日志，见 core/errors.py）。再接一层不仅不可达，
    # 一旦哪天 hub 那层被去掉，这里还会**重复下发**同一条错误。
    await hub.handle_message(client_id, parsed)


class _InputOutcome(StrEnum):
    """一次二进制消息处理完之后，接收循环该怎么走。"""

    CONTINUE = "continue"
    #: 帧错位：字节流已不可信，必须断开
    FRAME_ERROR = "frame_error"
    #: 该客户端无视输入暂缓、已越过硬上限：显式断开
    OVERFLOW = "overflow"


def _dispatch_input(hub: Hub, client_id: str, data: bytes) -> _InputOutcome:
    """处理二进制帧（输入字节），并给出接收循环的去向。

    背压判定直接来自 `Hub.handle_input` 的返回值：传输层只管“继续读还是断开”，
    下发 `InputHold` 这件事由服务层做（它才知道水位与会话归属）。
    """
    try:
        payloads = frames.decode_input(data)
    except frames.FrameError as exc:
        _log.warning("客户端 %s 发来非法二进制帧: %s", client_id, exc)
        # 帧解析失败意味着字节流已错位，继续读只会放大混乱 → 断开
        return _InputOutcome.FRAME_ERROR
    for payload in payloads:
        if hub.handle_input(client_id, bytes(payload)) is InputVerdict.OVERFLOW:
            _log.warning("客户端 %s 无视输入暂缓，越过硬上限，断开连接", client_id)
            return _InputOutcome.OVERFLOW
    return _InputOutcome.CONTINUE


# --------------------------------------------------------------- 握手与工具


async def _read_hello(websocket: WebSocket) -> Hello:
    """读取首条消息并校验是合法握手。"""
    async with asyncio.timeout(HELLO_TIMEOUT):
        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                raise WebSocketDisconnect(message.get("code") or 1000)
            text = message.get("text")
            if text is None:
                continue  # 握手前不接受二进制帧，直接丢弃
            parsed = parse_client_message(text)
            if isinstance(parsed, Hello):
                return parsed
            raise ProtocolViolation(f"首条消息必须是 hello，收到 {parsed.t!r}")


def _writable(websocket: WebSocket) -> bool:
    """本端是否还能往这条连接写。

    两个状态位缺一不可，而且**不能再只看 `client_state`**：

    - `application_state` 是「我们这边发过 close 没有」。Starlette 的 `send()` 只在
      状态为 `CONNECTED` 时才允许写，否则抛 `RuntimeError`；而 `client_state` 在我们
      自己发完 close 之后仍然是 `CONNECTED`。只看 `client_state` 就会在收尾时二次
      close，把 `RuntimeError` 抛出端点、连带把已经写进缓冲的关闭帧一起丢掉。
    - `client_state` 是「对端断没断」，对端已经走了就没必要再写。
    """
    return (
        websocket.application_state is WebSocketState.CONNECTED
        and websocket.client_state is WebSocketState.CONNECTED
    )


async def _send_control(websocket: WebSocket, message: Failure | HelloOk) -> None:
    if _writable(websocket):
        await websocket.send_text(message.model_dump_json())


async def _close(websocket: WebSocket, code: int, reason: str) -> None:
    if _writable(websocket):
        await websocket.close(code=code, reason=reason)


__all__ = ["router"]
