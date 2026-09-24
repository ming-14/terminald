"""工作线程 → 事件循环的单向通道。

设计取舍：**所有会话状态只在事件循环线程上改动**。读 PTY 的线程只做“读 + 投递”，
journal 追加、广播、订阅判定全部回到事件循环，因此 core 里不需要任何锁——
并发正确性靠“单线程所有者”而不是靠加锁保证。

代价是线程与循环之间需要一条有界队列；队列满时读线程**等待**，于是背压一路传导到
PTY，子进程写阻塞。这正是 tmux `CONTROL_PANE_PAUSED` / ttyd `PAUSE` 的同一条路：
**宁可让应用停下来，也不丢字节。**
"""

from __future__ import annotations

import asyncio
import contextlib
import queue
from typing import Generic, TypeVar

T = TypeVar("T")

_CLOSED = object()


class BridgeClosed(RuntimeError):
    """桥已关闭。"""


class ThreadBridge(Generic[T]):
    """有界、线程安全、单向的线程→循环通道。

    必须在事件循环线程内构造（内部会创建 `asyncio.Event`）。
    """

    __slots__ = ("_closed", "_event", "_loop", "_queue")

    def __init__(self, loop: asyncio.AbstractEventLoop, maxsize: int = 8192) -> None:
        if maxsize < 1:
            raise ValueError("maxsize 必须为正")
        self._loop = loop
        self._queue: queue.Queue[object] = queue.Queue(maxsize=maxsize)
        self._event = asyncio.Event()
        self._closed = False

    # ------------------------------------------------------------ 线程侧

    def put(self, item: T, timeout: float = 0.05) -> bool:
        """入队并唤醒事件循环。队列满则最多等待 `timeout`，返回是否成功。

        返回 False 是**背压信号**，调用方（读线程）应当稍后重试而不是丢弃数据。
        """
        if self._closed:
            return False
        try:
            self._queue.put(item, timeout=timeout)
        except queue.Full:
            return False
        try:
            self._loop.call_soon_threadsafe(self._event.set)
        except RuntimeError:  # 事件循环已关闭
            return False
        return True

    # ------------------------------------------------------------ 循环侧

    async def get(self) -> T:
        """取出一个元素（阻塞等待）。桥关闭且队列已空时抛 `BridgeClosed`。"""
        while True:
            item = self._drain_one()
            if item is not _CLOSED and item is not None:
                return item  # type: ignore[return-value]
            if item is _CLOSED:
                raise BridgeClosed()
            # 队列为空：清标志后再查一次，避免 clear 与 put 之间丢唤醒
            self._event.clear()
            item = self._drain_one()
            if item is not _CLOSED and item is not None:
                return item  # type: ignore[return-value]
            if item is _CLOSED:
                raise BridgeClosed()
            await self._event.wait()

    @property
    def closed(self) -> bool:
        """桥是否已关闭。读线程据此退出重试循环（否则会在 put 永远失败时空转）。"""
        return self._closed

    def close(self) -> None:
        """关闭桥（可从任意线程调用）。"""
        if self._closed:
            return
        self._closed = True
        # 入队关闭哨兵；队列满说明读者已落后，哨兵进不去也无妨——closed 标志即可让它退出
        with contextlib.suppress(queue.Full):
            self._queue.put_nowait(_CLOSED)
        with contextlib.suppress(RuntimeError):  # 事件循环已关闭
            self._loop.call_soon_threadsafe(self._event.set)

    # ------------------------------------------------------------ 内部

    def _drain_one(self) -> object | None:
        try:
            item = self._queue.get_nowait()
        except queue.Empty:
            return None
        return item


__all__ = ["BridgeClosed", "ThreadBridge"]
