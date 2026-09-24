"""测试脚手架：把「某个客户端实际收到了什么」变成可断言的记录。

它刻意复用了线上真实的编解码路径（`frames.iter_frames` + `parse_server_message`），
而不是自己解析：如果帧格式写错了，这里就会先炸，而不是被测试的宽容解析掩盖。

`Endpoint` 里那条 `offset == next_offset` 断言是**同步正确性的核心不变量**：
一个客户端收到的 OUTPUT 帧必须首尾相接、无空洞、无重复（全新客户端从 0 起，
续传客户端从它自报的断点起）。多客户端“内容完全同步”最终就是这条不变量在所有
客户端上同时成立。

## 同步纪律：不睡，只等栅栏

这个模块里**没有** `settle()` 这类固定睡眠，也不该再有。固定睡眠有两个无法修复的
缺陷：机器一忙它必然假红（等到的不是事件，是时间）；而失败信息为零（`assert` 只会说
“条件不成立”，说不清是“没发生”还是“还没发生”）。

取而代之的是四个**具名栅栏**，每个都对应管道上真实存在的可观察点：

- `feed()` —— 输出栅栏：喂进去的字节已并入日志（因而也已推给所有订阅者）；
- `writes_drained()` —— 写栅栏：此前提交给写线程的字节已真正落到宿主上；
- `wait_for()` —— 通用条件等待，超时会指出判定点的源码位置；
- `turn()` —— 让事件循环把手头排队的回调跑完一轮（“已经跑过”而非“过了多久”）。

「否定断言」（“不该发生 X”）只有在**先证明“该发生的都发生完了”**之后才有意义，
否则它会在什么都没发生时也变绿——这类空断言是比假红更坏的东西。各条栅栏为什么成立，
见它们各自的 docstring；这些理由不是注释，而是被 `test_sync_discipline.py` 机器化钉住的。
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
from terminald.core import Client, Session, SessionSpec
from terminald.protocol import frames
from terminald.protocol.frames import FrameTag
from terminald.protocol.messages import ServerMessage, parse_server_message
from terminald.runtime import make_host_factory
from terminald.runtime.fake_host import FakeHost
from terminald.runtime.runner import SessionRunner
from terminald.service.hub import Hub


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


async def turn() -> None:
    """让事件循环把**此刻已排队**的回调跑完一轮，然后回来。

    语义是“已经跑过一轮”，不是“过了一段时间”，所以它没有固定睡眠的假红问题：
    `call_soon` 是 FIFO，我们自己那个标记跑完就说明排在它之前的东西都跑过了。

    它也不能当栅栏用——只能用来断言“某个任务确实已经执行过至少一步”（否则“任务未完成”
    这类否定断言会因为任务压根还没被调度而变得恒真）。
    """
    loop = asyncio.get_running_loop()
    done: asyncio.Future[None] = loop.create_future()
    loop.call_soon(done.set_result, None)
    await done


def _where(predicate: Callable[[], object]) -> str:
    """判定点的源码位置（`文件:行`）。

    超时信息里最有价值的是**哪一行断言的前提没等到**；只写“等待条件超时”等于让人
    从零开始排查。lambda 一般在调用点同一行定义，所以行号几乎总是指向那一处。
    """
    code = getattr(predicate, "__code__", None)
    if code is None:
        return "（无法定位的判定点）"
    return f"{os.path.basename(code.co_filename)}:{code.co_firstlineno}"


async def wait_for(predicate: Callable[[], bool], timeout: float = 3.0, what: str = "条件") -> None:
    """轮询等待条件成立；超时则报出**判定点位置**与已等待时长。

    间隔只是“多久检查一次”，不承载正确性：先连续让出时间片（同一轮事件循环里就能
    成立的条件在微秒级返回），再退避到 10ms（等的是别的线程时可观测量时，避免空转）。
    所以它既不是睡眠，也不会因为机器忙而漏掉一个**已经**成立的条件。
    """
    loop = asyncio.get_running_loop()
    started = loop.time()
    deadline = started + timeout
    delay = 0.0
    while True:
        if predicate():
            return
        if loop.time() >= deadline:
            raise AssertionError(
                f"等待{what}超时（已等 {loop.time() - started:.2f}s / 上限 {timeout:.2f}s）"
                f"，判定点 {_where(predicate)}"
            )
        await asyncio.sleep(delay)
        delay = min(0.01, max(0.0005, delay * 2))


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
        """反复排空直到没有新负载（补流可能因水位上限分多轮）。

        注意：它是**同步**的，所以给不出事件循环的任何一圈。服务端那侧还在飞的效果
        （典型是写线程经 `call_soon_threadsafe` 转回来的放行、`on_drained` 回调）
        不会因为你循环排空几轮就出现——那种情况下先用一个条件栅栏（例如
        `wait_for(lambda: client_of(hub, cid).input_held is False)`）等到效果确已发生，
        再来排空。否则它会在机器忙时安静地变成“什么都没收到”（实测 10 轮里红 2 轮）。
        """
        for _ in range(rounds):
            before = len(self.stream) + len(self.control) + len(self.snapshots)
            self.drain()
            after = len(self.stream) + len(self.control) + len(self.snapshots)
            if before == after:
                return

    def drain_until_caught_up(self, session: Session, *, rounds: int = 64) -> None:
        """反复排空，直到该客户端把日志里缺的字节补齐（或确定补不动了）。

        补流受发送水位限制，每轮只能推进到水位为止；而**水位一空就由 `on_drained`
        同步再推一轮**，所以“排空 → 再排空”是确定的，不需要在两轮之间睡一下。

        `rounds` 是给“本来就应该卡住”的用例留的出口（窗口卡住、游标落到裁剪点之前）：
        那时两轮之间不再有任何变化，于是提前返回，由调用方去断言**为什么**卡住。
        """
        for _ in range(rounds):
            before = self.next_offset
            self.drain()
            if self.next_offset >= session.journal.end_offset:
                return
            if self.next_offset == before and not self.hub.has_output(self.client_id):
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
    """等到条件成立（同步上下文用；间隔同样只是“多久检查一次”）。"""
    started = time.monotonic()
    deadline = started + timeout
    while time.monotonic() < deadline:
        if condition():
            return
        time.sleep(0.01)
    raise AssertionError(
        f"等待{what}超时（已等 {time.monotonic() - started:.2f}s / 上限 {timeout:.2f}s）"
        f"，判定点 {_where(condition)}"
    )


def host_of(hub: Hub, session_id: str) -> FakeHost:
    """取出会话的测试替身宿主（强制类型，避免测试里到处 cast）。"""
    host: Any = hub.get_session(session_id).host
    assert isinstance(host, FakeHost), "测试必须以 fake 宿主运行"
    return host


def client_of(hub: Hub, client_id: str) -> Client:
    """从 Hub 内部取出客户端对象（测试需要驱动焦点/关闭等状态）。"""
    return hub._clients[client_id]


def runner_of(hub: Hub, session_id: str) -> SessionRunner:
    """取出会话的 I/O 线程组（测试需要观察/驱动写线程时用）。"""
    runner = hub._runners.get(session_id)
    assert runner is not None, "该会话没有运行中的 I/O 线程组"
    return runner


async def feed(hub: Hub, session_id: str, data: bytes) -> None:
    """**输出栅栏**：把 `data` 当作子进程输出喂进去，并等到它并入日志。

    它同时就是“已推给所有订阅者”的栅栏，因为 `Hub._ingest_output` 是**一段没有 await
    的原子步**（喂模型 → 追加日志 → 裁剪 → 按游标推给每个订阅者）。事件循环不可能在
    半路把控制权交给别的任务，所以“日志偏移已推进”这件事一旦可观察，该步的全部副作用
    就已经发生完毕——这正是「否定断言不需要睡眠」的依据。

    这条理由不是注释，而是被 `test_sync_discipline.py` 机器化钉住的：`_ingest_output`
    里一旦出现 await（例如把推送改成“稍后再说”），本函数就不再是完整栅栏，那条测试会红。
    """
    session = hub.get_session(session_id)
    target = session.journal.end_offset + len(data)
    host_of(hub, session_id).feed(data)
    await wait_for(
        lambda: session.journal.end_offset == target,
        what=f"输出并入日志（目标 offset={target}）",
    )


async def writes_drained(hub: Hub, session_id: str) -> None:
    """**写入栅栏**：等到“此刻之前提交给写线程的字节”全部落到宿主上。

    为什么需要它：写线程是异步的，所以「应用不该收到焦点序列」这类**否定断言**在完全
    不等待时是**空的**——真写了也还没写出去，断言照样绿（比假红更坏：它静默地不再有判别力）。

    为什么 `pending_bytes == 0` 是正确答案：在途计数只在 `SessionRunner._release` 里扣减，
    而 `_release` 是在 `host.write()` **返回之后**才被调用的（见 `_write_loop`）。于是：

    - 还有字节没写出去 ⇒ 计数必然 > 0，栅栏不会被“提前满足”；
    - 计数归零 ⇒ 此前入队的每一次写都真的落到宿主上了。

    这条不变量由两处钉住：`test_hub.py::test_writes_drained_waits_for_a_gated_write`（写线程
    卡在闸上时栅栏不得放行）与 `test_sync_discipline.py`（扫 AST 确认扣减在 `write()` 之后的
    `finally` 里——它一旦被挪到写之前，上面这条推理就整个失效）。
    """
    runner = runner_of(hub, session_id)
    await wait_for(lambda: runner.pending_bytes == 0, what="写线程排空输入队列")


def make_endpoint(hub: Hub, client_id: str, *, baseline: int = 0) -> Endpoint:
    """构造接收侧记录器。

    `baseline` 是该客户端**连接之前本地已应用**的字节数：全新客户端为 0；「刷新/切换
    后续传」的场景必须显式声明它，否则无法表达“它已经看到 N 个字节”这件事，
    于是“断档为空 → 什么都不该重发”这类用例根本无从断言。
    """
    return Endpoint(hub=hub, client_id=client_id, next_offset=baseline)


__all__ = [
    "BlockingCloseHost",
    "BlockingHost",
    "Endpoint",
    "client_of",
    "feed",
    "host_of",
    "hub_context",
    "make_endpoint",
    "make_settings",
    "process_alive",
    "runner_of",
    "turn",
    "wait_for",
    "wait_until",
    "writes_drained",
]
