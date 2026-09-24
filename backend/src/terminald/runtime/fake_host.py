"""`SessionHost` 的**测试替身**。

用途只有一个：让 core 与 api 的整条链路（订阅、补流、裁剪、重同步、流控、焦点聚合）
可以在**没有真实 PTY、没有 pywezterm** 的情况下被确定性地测出来。

它**不是**降级方案：`config.host_impl` 默认仍是 `pywezterm`；这里实现的方法与线程归属
与真实适配器完全一致，因此它能暴露协议与同步逻辑的 bug，而不是掩盖它们：

- `feed(data)`：测试驱动接口，把数据当作子进程输出排队（线程安全）
- `read()`：按 `feed` 的先后顺序吐出字节（读线程）
- `ingest()`：更新模型可见区、返回模型的 DSR 应答（事件循环）
- `write()`：记录客户端/宿主要写入 PTY 的字节，并可选地回显（写线程，唯一写者）
"""

from __future__ import annotations

import threading
import time
from collections import deque

from ..core.ports import HostMetadata, SessionSpec

# 模拟 pywezterm.Terminal 的应答行为：输出里出现 DSR 查询，模型就回一个应答
_DSR = b"\x1b[6n"
_DSR_REPLY = b"\x1b[1;1R"

# 空转等待间隔：与真实适配器内部 `Pty.read` 的 2ms 轮询对齐
_POLL_INTERVAL = 0.002


class FakeHost:
    """内存宿主。

    方法分组与线程归属严格对齐 `core/ports.py` 的契约；`_visible` 只在 `ingest()`
    里更新，因此 `snapshot()` 与 `fed_offset` 反映的都是「模型已吃到的字节」。
    """

    def __init__(self, spec: SessionSpec, *, echo: bool = True) -> None:
        self.spec = spec
        self.echo = echo
        self.pid: int | None = 4242
        self.written = bytearray()
        self.responses: list[bytes] = []
        self._queue: deque[bytes] = deque()
        self._lock = threading.Lock()
        self._closed = False
        self._exit_code: int | None = None
        self._title: str | None = None
        self._cwd: str | None = None
        self._visible = bytearray()
        self._fed = 0

    # ------------------------------------------------------------ 测试驱动接口

    def feed(self, data: bytes) -> None:
        """模拟子进程产生输出（只入队，等 `read()` + `ingest()` 消费）。"""
        with self._lock:
            self._queue.append(bytes(data))

    def exit(self, code: int = 0) -> None:
        """模拟子进程退出。"""
        with self._lock:
            self._exit_code = code
            self.pid = None

    def set_metadata(self, *, title: str | None = None, cwd: str | None = None) -> None:
        self._title = title
        self._cwd = cwd

    # ------------------------------------------------------------ SessionHost：读线程

    def read(self, max_bytes: int = 8192, timeout: float = 0.2) -> bytes:
        """读取**至多** `max_bytes` 字节，余量留在原地。

        必须只取走 n 字节：真实适配器里 `Pty.read(n)` 是从内部缓冲取 n、剩的留在原处。
        若这里把整块切一刀、丢掉余量，测试就会凭空少字节，把「要验证的裁剪与流控行为」
        掩盖成「数据没到」——先前的实现正是如此（`popleft()[:max_bytes]`）。
        """
        deadline = time.monotonic() + timeout
        while True:
            with self._lock:
                if self._queue:
                    chunk = self._queue.popleft()
                    if len(chunk) <= max_bytes:
                        return chunk
                    self._queue.appendleft(chunk[max_bytes:])
                    return chunk[:max_bytes]
                if self._closed:
                    return b""
            if time.monotonic() >= deadline:
                return b""
            # 空转需让出 CPU，否则读线程会与事件循环抢 GIL
            time.sleep(_POLL_INTERVAL)

    # ------------------------------------------------------------ SessionHost：事件循环

    def ingest(self, data: bytes) -> bytes:
        with self._lock:
            self._fed += len(data)
            if not self._closed:
                self._visible.extend(data)
        # 真实模型遇到 DSR 查询会生成应答；由上层交给写线程回写
        return _DSR_REPLY if _DSR in data else b""

    @property
    def fed_offset(self) -> int:
        return self._fed

    def set_focus(self, focused: bool) -> bytes:
        return b"\x1b[I" if focused else b"\x1b[O"

    def snapshot(self) -> bytes:
        with self._lock:
            visible = bytes(self._visible[-self.spec.cols :])
        return b"\x1bc" + visible

    def metadata(self) -> HostMetadata:
        return HostMetadata(title=self._title, cwd=self._cwd)

    # ------------------------------------------------------------ SessionHost：写线程

    def write(self, data: bytes) -> None:
        self.written.extend(data)
        self.responses.append(bytes(data))
        if self.echo and b"\r" not in data:
            self.feed(data)

    # ------------------------------------------------------------ SessionHost：生命周期

    def try_wait(self) -> int | None:
        with self._lock:
            return self._exit_code

    def kill(self) -> None:
        self.exit(-1)

    def close(self) -> None:
        self._closed = True
        self.pid = None


__all__ = ["FakeHost"]
