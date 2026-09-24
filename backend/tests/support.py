"""测试脚手架：把「某个客户端实际收到了什么」变成可断言的记录。

它刻意复用了线上真实的编解码路径（`frames.iter_frames` + `parse_server_message`），
而不是自己解析：如果帧格式写错了，这里就会先炸，而不是被测试的宽容解析掩盖。

`Endpoint` 里那条 `offset == next_offset` 断言是**同步正确性的核心不变量**：
一个客户端收到的 OUTPUT 帧必须首尾相接、无空洞、无重复（全新客户端从 0 起，
续传客户端从它自报的断点起）。多客户端“内容完全同步”最终就是这条不变量在所有
客户端上同时成立。
"""

from __future__ import annotations

import asyncio
import os
import threading
import time
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any

from terminald.config import Settings
from terminald.core import Client, SessionSpec
from terminald.protocol import frames
from terminald.protocol.frames import FrameTag
from terminald.protocol.messages import ServerMessage, parse_server_message
from terminald.runtime import make_host_factory
from terminald.runtime.fake_host import FakeHost
from terminald.service.hub import Hub

#: 会话启动后等待读线程把首批输出交给事件循环
SETTLE = 0.15


def make_settings(**overrides: object) -> Settings:
    """构造测试配置：小水位、小日志预算，便于在毫秒级触发裁剪与流控。"""
    base: dict[str, object] = {
        "host_impl": "fake",
        "cols": 80,
        "rows": 24,
        "scrollback": 200,
        "shell": ["fake-shell"],
        "log_level": "WARNING",
        "journal_budget_bytes": 64 * 1024,
        "outbox_high_bytes": 64 * 1024,
        "attach_chunk_bytes": 8 * 1024,
    }
    base.update(overrides)
    return Settings(**base)  # type: ignore[arg-type]


@asynccontextmanager
async def hub_context(**overrides: object) -> AsyncIterator[Hub]:
    """用自定义配置构造 Hub，并在退出时确保资源释放。"""
    settings = make_settings(**overrides)
    instance = Hub(settings, make_host_factory(settings.host_impl))
    try:
        yield instance
    finally:
        await instance.stop()


async def settle(seconds: float = SETTLE) -> None:
    """让出时间片，等待事件循环与后台线程完成一轮传递。"""
    await asyncio.sleep(seconds)


async def wait_for(predicate: Callable[[], bool], timeout: float = 3.0) -> None:
    """轮询等待条件成立（比固定 sleep 稳，失败时仍然是有界的）。"""
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if predicate():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("等待条件超时")


@dataclass
class Endpoint:
    """一个客户端的接收侧记录器。

    `next_offset` 的语义是「该客户端**期望下一个**收到的输出偏移」，因此它同时表示
    客户端的本地状态：全新客户端为 0，刷新后续传的客户端为它自报的断点（见
    `make_endpoint(..., baseline=N)`）。
    """

    hub: Hub
    client_id: str
    #: 该客户端已收到的终端字节（连续、无空洞）
    stream: bytearray = field(default_factory=bytearray)
    #: 服务端下发的控制消息（按到达顺序）
    control: list[ServerMessage] = field(default_factory=list)
    #: SNAPSHOT 帧的原始负载
    snapshots: list[bytes] = field(default_factory=list)
    #: 下一个期望的 offset
    next_offset: int = 0

    def drain(self, *, notify: bool = True) -> None:
        """取走全部待发负载并记账。

        `notify=False` 表示「字节已送达客户端，但客户端还没解析完」：服务端**不应**
        因此推进游标，这正是 `Ack` 与 `on_drained` 两种回程信号的区别所在。
        """
        for item in self.hub.take_output(self.client_id):
            if not item.binary:
                self.control.append(parse_server_message(item.payload))
                continue
            for tag, offset, payload in frames.iter_frames(item.payload):
                if tag is FrameTag.OUTPUT:
                    assert offset == self.next_offset, (
                        f"OUTPUT 帧不连续: 期望 {self.next_offset}，收到 {offset}"
                    )
                    self.stream.extend(payload)
                    self.next_offset = offset + len(payload)
                elif tag is FrameTag.SNAPSHOT:
                    assert offset is not None
                    # 快照取代本地画面：这个客户端之后就是“从 offset 开始”的新生客户端
                    self.snapshots.append(bytes(payload))
                    self.stream.clear()
                    self.next_offset = offset
                else:  # pragma: no cover - 服务端不该给客户端发 INPUT
                    raise AssertionError(f"服务端发出了 {tag!r} 帧")
        if notify:
            self.hub.on_drained(self.client_id)

    def drain_until_quiet(self, rounds: int = 4) -> None:
        """反复排空直到没有新负载（补流可能因水位上限分多轮）。"""
        for _ in range(rounds):
            before = len(self.stream) + len(self.control) + len(self.snapshots)
            self.drain()
            after = len(self.stream) + len(self.control) + len(self.snapshots)
            if before == after:
                return

    # ------------------------------------------------------------ 断言辅助

    def last_control(self) -> ServerMessage:
        assert self.control, "尚未收到任何控制消息"
        return self.control[-1]

    def control_of(self, kind: str) -> list[ServerMessage]:
        return [m for m in self.control if m.t == kind]

    def count(self, kind: str) -> int:
        return sum(1 for m in self.control if m.t == kind)


class BlockingHost(FakeHost):
    """写会阻塞的宿主（A1 回归用）。

    `Pty.write` 在 PTY 缓冲写满时会阻塞；这个阻塞必须被隔离在写线程里，否则事件循环
    会连同所有会话、所有客户端、全部 HTTP 接口一起停摆。两道闸把它变成可断言的状态：

    - `write_entered`：已经进入 `write()`（证明字节确实交给了写线程）；
    - `write_gate`：置位前 `write()` 不返回（模拟 PTY 缓冲写满）。
    """

    def __init__(self, spec: SessionSpec, *, echo: bool = True) -> None:
        super().__init__(spec, echo=echo)
        self.write_gate = threading.Event()
        self.write_entered = threading.Event()
        self.write_calls = 0

    def write(self, data: bytes) -> None:
        self.write_calls += 1
        self.write_entered.set()
        self.write_gate.wait(timeout=10.0)
        super().write(data)


class BlockingCloseHost(FakeHost):
    """关闭会阻塞的宿主（A13 拆除路径回归用）。

    真实阻塞点在 `Pty.close()` 内部的 `ClosePseudoConsole`：它等控制台客户端退出，
    实测可以等 236 秒，而且**持着 GIL**——所以「把它挪到线程」不够，应用层必须保证
    拆除期间事件循环仍然服务其他人。这个替身把该阻塞变成可断言的状态：

    - `close_entered`：已经进入 `close()`（证明拆除确实在循环之外进行）；
    - `close_gate`：置位前 `close()` 不返回（模拟那次等待）。

    宿主**自身**的进程树终止由 contract 用例用真 ConPTY 验证（`runtime/winjob.py`）。
    """

    def __init__(self, spec: SessionSpec, *, echo: bool = True) -> None:
        super().__init__(spec, echo=echo)
        self.close_gate = threading.Event()
        self.close_entered = threading.Event()
        self.close_calls = 0

    def close(self) -> None:
        self.close_calls += 1
        self.close_entered.set()
        self.close_gate.wait(timeout=10.0)
        super().close()


def process_alive(pid: int) -> bool:
    """该 pid 是否仍在运行。

    Windows 上不能用 `os.kill(pid, 0)`：那里它等价于 `TerminateProcess`（会把进程杀掉），
    所以查存活必须走 `OpenProcess` + `GetExitCodeProcess`。
    """
    if os.name != "nt":
        try:
            os.kill(pid, 0)
        except (ProcessLookupError, PermissionError):
            return False
        return True

    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel32.GetExitCodeProcess.restype = wintypes.BOOL
    handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        return False
    try:
        code = wintypes.DWORD()
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
            return False
        return code.value == 259  # STILL_ACTIVE
    finally:
        kernel32.CloseHandle(handle)


def wait_until(condition: Callable[[], bool], timeout: float = 3.0, what: str = "条件") -> None:
    """等到条件成立（同步上下文用）。"""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if condition():
            return
        time.sleep(0.01)
    raise AssertionError(f"等待{what}超时")


def host_of(hub: Hub, session_id: str) -> FakeHost:
    """取出会话的测试替身宿主（强制类型，避免测试里到处 cast）。"""
    host: Any = hub.get_session(session_id).host
    assert isinstance(host, FakeHost), "测试必须以 fake 宿主运行"
    return host


def client_of(hub: Hub, client_id: str) -> Client:
    """从 Hub 内部取出客户端对象（测试需要驱动焦点/关闭等状态）。"""
    return hub._clients[client_id]


def make_endpoint(hub: Hub, client_id: str, *, baseline: int = 0) -> Endpoint:
    """构造接收侧记录器。

    `baseline` 是该客户端**连接之前本地已应用**的字节数：全新客户端为 0；「刷新/切换
    后续传」的场景必须显式声明它，否则无法表达“它已经看到 N 个字节”这件事，
    于是“断档为空 → 什么都不该重发”这类用例根本无从断言。
    """
    return Endpoint(hub=hub, client_id=client_id, next_offset=baseline)


__all__ = [
    "SETTLE",
    "BlockingCloseHost",
    "BlockingHost",
    "Endpoint",
    "client_of",
    "host_of",
    "hub_context",
    "make_endpoint",
    "make_settings",
    "process_alive",
    "settle",
    "wait_for",
    "wait_until",
]
