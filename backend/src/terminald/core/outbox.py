"""每客户端发送队列（带高水位）。

设计要点（取自 tmux control mode 的做法）：

- **每个客户端一条独立队列**，慢客户端绝不阻塞广播路径上的其他人。
- 水位判断只有一处结论源：`pending_bytes` + `would_exceed()`，由服务层决定还推不推。
- 这里**只有高水位、没有低水位**：唯一的消费者是「现在还要不要继续推」这个即时判断，
  而它不需要滞回（要不要恢复推送由下一次有新输出时的同一条判断决定）。需要滞回的是
  输入方向（`runtime/runner.py` 的 `_held`），那里的滞回有自己的状态位。
  （**不再**额外维护一个派生出来的 `behind` 标志——它谁也不读，只是把同一个事实存两份。）
- 真正的「落后」是**显式状态**，不是静默丢字节：客户端游标落到日志裁剪点之前时由
  服务层下发 `Behind`，客户端主动 `Resync`。那个判断看的是**游标与裁剪点**，不是水位。

## 为什么队列里存的是 (binary, payload) 而不是裸字节

一条 WebSocket 消息只有两种形态：文本帧（控制消息，JSON）与二进制帧（终端字节流）。
两者在**同一条有序队列**里排队——这一点不能妥协：Reattach 时“旧增量先到、快照后到”
的顺序保证就建立在单队列 FIFO 上。

但队列必须记住每段的形态，否则传输层拿到一坨混合字节时无法决定 `send_text` 还是
`send_bytes`，控制 JSON 会被当成终端字节喂给 xterm.js（反之更糟：终端里的 UTF-8
中文会被当成控制消息解析）。所以这里存 `Outbound(binary, payload)`。

水位统计把两类都算进去：控制消息同样是这个客户端还没吃下的负载。
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Outbound:
    """一段待发负载。`binary=False` 表示控制消息（文本帧）。"""

    binary: bool
    payload: bytes

    @property
    def size(self) -> int:
        return len(self.payload)


class Outbox:
    """按字节计数的出站缓冲。非线程安全：只由事件循环线程使用。"""

    __slots__ = ("_high", "_pending", "_queue")

    def __init__(self, high_bytes: int) -> None:
        if high_bytes <= 0:
            raise ValueError("high_bytes 必须为正")
        self._queue: list[Outbound] = []
        self._pending = 0
        self._high = high_bytes

    # ------------------------------------------------------------ 只读

    @property
    def pending_bytes(self) -> int:
        return self._pending

    @property
    def pending_chunks(self) -> int:
        return len(self._queue)

    def would_exceed(self, size: int) -> bool:
        """投递 `size` 字节后是否会触及高水位。"""
        return self._pending + size >= self._high

    # ------------------------------------------------------------ 写入

    def push(self, payload: bytes, *, binary: bool = True) -> None:
        """入队（空负载忽略）。"""
        if payload:
            self._queue.append(Outbound(binary=binary, payload=payload))
            self._pending += len(payload)

    def push_text(self, payload: bytes) -> None:
        """入队一条控制消息（文本帧）。"""
        self.push(payload, binary=False)

    # ------------------------------------------------------------ 读取

    def drain(self) -> tuple[Outbound, ...]:
        """取出全部待发负载并清空（保持顺序）。"""
        if not self._queue:
            self._pending = 0
            return ()
        items = tuple(self._queue)
        self._queue.clear()
        self._pending = 0
        return items

    def discard(self) -> None:
        """丢弃全部待发负载（重建前清空，避免旧增量与新快照交错）。"""
        self._queue.clear()
        self._pending = 0


__all__ = ["Outbound", "Outbox"]
