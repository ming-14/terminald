"""会话运行器 —— 读线程 + 写线程。

职责边界刻意划得很窄：

- **读线程**：`host.read()` → 把原始字节投给事件循环（经 `ThreadBridge`）。
  它不碰模型、不碰 journal、不碰会话状态，因此没有竞态。
- **写线程**：从线程安全队列取字节 → `host.write()`，并且是**该 PTY 的唯一写者**
  （客户端输入、模型应答、焦点应答都进这一条 FIFO）。

写为什么必须独立成线程：`Pty.write` 在 PTY 缓冲写满时会阻塞（实测 ConPTY 下
1 MB ≈ 4s、8 MB ≈ 30s）。绑定层已在 `py.detach` 之后才做这个阻塞写，所以
**放在写线程里完全能隔离阻塞**；反过来，若在事件循环上调用，循环（连同所有会话、
所有客户端、全部 HTTP 接口）会一起停摆——这正是 `docs/audit.md` A1 的机制。

## 写队列是有界的（输入方向的背压）

队列本身仍是一个无 `maxsize` 的 `queue.Queue`，但它**按字节计量**并配两道水位：

- 在途字节 `pending >= input_high_bytes` → 本次入队返回 `InputVerdict.HOLD`，
  由服务层通知该客户端“暂缓发送输入”（客户端在本端排队，见 docs/protocol.md §3）；
- 在途字节回落到 `<= input_low_bytes` → 写线程经 `on_drained` 回调通知事件循环放行；
- 越到 `input_hard_bytes` 说明发送方无视了暂缓 → 返回 `InputVerdict.OVERFLOW`，
  由传输层显式断开该连接。

为什么不直接“停读接收循环”用内核背压：那会把同一条连接上的控制面（detach、关闭会话、
焦点上报）一起堵住，而且对端在暂停期间断开时服务端无从察觉（uvicorn 只把 disconnect
放进队列，不会取消 app 任务）。让**发送方**停下来则两者都不会发生。

进程退出**不结束会话**（需求：关掉网页不影响终端里的程序）。退出码经桥上报，
会话转为 `EXITED` 但仍保留 journal 与终端内容，可继续订阅。
"""

from __future__ import annotations

import queue
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from enum import StrEnum
from typing import TypeAlias

from ..core.ports import SessionHost
from ..logs import get_logger
from .bridge import ThreadBridge

_log = get_logger(__name__)


@dataclass(frozen=True, slots=True)
class OutputChunk:
    """一段原始输出（尚未分配 offset；offset 由事件循环在追加 journal 时确定）。"""

    data: bytes


@dataclass(frozen=True, slots=True)
class ProcessExited:
    """子进程已退出。"""

    code: int


ReaderEvent: TypeAlias = OutputChunk | ProcessExited


class InputVerdict(StrEnum):
    """一次输入入队的结果。

    `HOLD` / `OVERFLOW` 描述的**都不是丢字节**：字节都已入队，差别只在“发送方还能不能
    继续发”。丢字节这件事在这套机制里不存在——队列排空后，服务层会放行客户端。
    """

    #: 已入队，客户端可以继续发送
    ACCEPTED = "accepted"
    #: 已入队，但已到高水位：客户端必须在本端排队，等服务端放行
    HOLD = "hold"
    #: 已入队，但发送方无视了暂缓、已越过硬上限：该连接应按协议违例断开
    OVERFLOW = "overflow"


class SessionRunner:
    """一个会话的 I/O 线程组。"""

    def __init__(
        self,
        host: SessionHost,
        bridge: ThreadBridge[ReaderEvent],
        *,
        max_bytes: int = 8192,
        poll_timeout: float = 0.2,
        input_high_bytes: int,
        input_low_bytes: int,
        input_hard_bytes: int,
        on_drained: Callable[[], None] | None = None,
    ) -> None:
        self._host = host
        self._bridge = bridge
        self._max_bytes = max_bytes
        self._poll_timeout = poll_timeout
        self._input_high = input_high_bytes
        self._input_low = input_low_bytes
        self._input_hard = input_hard_bytes
        #: 写线程回调：在途字节越过低水位时由**写线程**调用，实现方必须自身线程安全
        #: （Hub 的实现只是 `loop.call_soon_threadsafe`）。
        self._on_drained = on_drained
        self._input: queue.Queue[bytes | None] = queue.Queue()
        self._pending_bytes = 0
        self._pending_lock = threading.Lock()
        #: 当前是否处于“已通知暂缓”的状态（滞回位，避免在阈值附近反复放行/暂缓）
        self._held = False
        self._closed = threading.Event()
        self._reader: threading.Thread | None = None
        self._writer: threading.Thread | None = None
        self._exited = threading.Event()
        self.exit_code: int | None = None

    # ------------------------------------------------------------ 生命周期

    def start(self) -> None:
        if self._reader is not None:
            raise RuntimeError("SessionRunner 已启动")
        self._reader = threading.Thread(
            target=self._read_loop, name=f"termd-read-{id(self):x}", daemon=True
        )
        self._writer = threading.Thread(
            target=self._write_loop, name=f"termd-write-{id(self):x}", daemon=True
        )
        self._reader.start()
        self._writer.start()

    def stop(self, timeout: float = 2.0) -> None:
        """停止线程组并释放宿主（幂等）。"""
        self._closed.set()
        self._input.put(None)
        self._bridge.close()
        for thread in (self._reader, self._writer):
            if thread is not None and thread.is_alive():
                thread.join(timeout=timeout)
        self._host.close()

    @property
    def running(self) -> bool:
        return not self._closed.is_set() and not self._exited.is_set()

    @property
    def pending_bytes(self) -> int:
        """写队列里尚未写出去的字节数（输入方向背压的依据）。"""
        with self._pending_lock:
            return self._pending_bytes

    # ------------------------------------------------------------ 写入（事件循环侧调用）

    def submit_input(self, data: bytes) -> InputVerdict:
        """投递**客户端输入**（线程安全、非阻塞），并返回本次的背压判定。

        客户端输入与宿主应答走同一条队列：写入顺序就是入队顺序，与 pty 的字节流语义
        一致；两个写者并发写同一个 master fd 无法保证字节序，已禁止。

        与 `submit_response` 的区别只有一条：**只有客户端输入参与水位判定**。宿主应答
        （DSR、焦点应答）是模型对流量的回复，它必须无条件发出，且总量只有几个字节。
        """
        if not data or self._closed.is_set():
            return InputVerdict.ACCEPTED
        with self._pending_lock:
            self._input.put(data)
            self._pending_bytes += len(data)
            pending = self._pending_bytes
            if pending >= self._input_high:
                # 置滞回位：放行必须等到**穿过**低水位那一次，见 _release
                self._held = True
        if pending >= self._input_hard:
            # 注意：`hard` 必须显著高于 `high`（配置校验强制 `hard >= 2 × high`）。
            # 客户端收到“暂缓”之前已经在路上的帧仍会被接收，那是守规矩的客户端，
            # 不是违约；只有量级上越过 hard 才说明它根本没停。
            return InputVerdict.OVERFLOW
        if pending >= self._input_high:
            return InputVerdict.HOLD
        return InputVerdict.ACCEPTED

    def submit_response(self, data: bytes) -> None:
        """投递**宿主应答**（模型对输出的回应）给写线程。不参与水位判定。

        它仍计入在途字节（否则写线程的扣减会让计数失真），但永远不会被拒绝、也不会
        因拥塞被延后到队列之外——它排在输入后面，顺序与 pty 的字节流语义一致。
        """
        if not data or self._closed.is_set():
            return
        with self._pending_lock:
            self._input.put(data)
            self._pending_bytes += len(data)

    # ------------------------------------------------------------ 线程体

    def _read_loop(self) -> None:
        try:
            while not self._closed.is_set() and not self._bridge.closed:
                data = self._host.read(self._max_bytes, self._poll_timeout)
                if data:
                    self._deliver(OutputChunk(bytes(data)))
                code = self._host.try_wait()
                if code is not None:
                    # 退出前把残余输出排空（子进程可能已退出但管道仍有数据）
                    self._drain_host()
                    self.exit_code = code
                    self._exited.set()
                    self._deliver(ProcessExited(code))
                    return
        except Exception:  # 读线程必须吞掉异常，否则整个会话静默死亡
            _log.exception("读线程异常退出")
        finally:
            self._exited.set()

    def _drain_host(self) -> None:
        deadline = time.monotonic() + 1.0
        while time.monotonic() < deadline and not self._closed.is_set() and not self._bridge.closed:
            data = self._host.read(self._max_bytes, 0.05)
            if not data:
                break
            self._deliver(OutputChunk(bytes(data)))

    def _deliver(self, event: ReaderEvent) -> None:
        """投递给事件循环；队列满则等待（背压传导到 PTY）。

        退出条件必须同时看**自身**与**桥**的关闭位：桥可能先于 runner 被关（会话拆除
        时会先关闭桥让读线程退出），此时 put 会永久返回 False，只看自身标志就会
        在这一点上空转。
        """
        while not self._bridge.put(event, timeout=0.05):
            if self._closed.is_set() or self._bridge.closed:
                return

    def _write_loop(self) -> None:
        try:
            while not self._closed.is_set():
                try:
                    data = self._input.get(timeout=0.2)
                except queue.Empty:
                    continue
                if data is None:
                    return
                try:
                    self._host.write(data)
                except Exception:
                    _log.exception("写入 PTY 失败")
                finally:
                    # 无论写成功与否都要扣减：卡在“已写出去”的计数上会让该客户端被
                    # 永久暂缓（而错误已经记在日志里了）。
                    self._release(len(data))
        except Exception:
            _log.exception("写线程异常退出")

    def _release(self, count: int) -> None:
        """写线程：扣减在途字节；越过低水位时通知事件循环放行被暂缓的客户端。

        滞回（`_held`，只在**穿过**低水位的那一次回调）不是优化而是必需：没有它，
        每写出去一块就会触发一次 `call_soon_threadsafe`，在连续输出下会把事件循环
        的回调队列刷爆。
        """
        with self._pending_lock:
            self._pending_bytes = max(0, self._pending_bytes - count)
            drained = self._held and self._pending_bytes <= self._input_low
            if drained:
                self._held = False
        if drained and self._on_drained is not None:
            self._on_drained()


__all__ = ["InputVerdict", "OutputChunk", "ProcessExited", "ReaderEvent", "SessionRunner"]
