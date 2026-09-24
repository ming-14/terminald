"""发送队列测试。

两条必须成立的语义：

1. **顺序**：控制消息与终端字节共享同一条 FIFO。Reattach 时“旧增量先到、快照后到”
   的收敛保证完全依赖它。
2. **形态**：每段负载必须记住自己是文本帧还是二进制帧——混了就会把控制 JSON
   当成终端字节喂给 xterm.js（或反过来把 UTF-8 中文当成控制消息解析）。
"""

from __future__ import annotations

import pytest

from terminald.core.outbox import Outbox


def test_push_and_drain_preserves_order_and_kind() -> None:
    outbox = Outbox(high_bytes=1024)
    outbox.push(b"binary-1")
    outbox.push_text(b"text-2")
    outbox.push(b"binary-3")

    drained = outbox.drain()
    assert [(item.binary, item.payload) for item in drained] == [
        (True, b"binary-1"),
        (False, b"text-2"),
        (True, b"binary-3"),
    ]


def test_drain_clears_pending_bytes() -> None:
    outbox = Outbox(high_bytes=1024)
    outbox.push(b"x" * 100)
    assert outbox.pending_bytes == 100
    outbox.drain()
    assert outbox.pending_bytes == 0
    assert outbox.drain() == ()


def test_high_watermark_is_reported_by_bytes_not_by_a_flag() -> None:
    """水位只有一处结论源：`pending_bytes` / `would_exceed()`。

    曾经还有一个派生出来的 `behind` 标志（写进去、从不被读）——同一个事实存两份就会漂移，
    而它一漂移就是「推送停了但没有理由」这类最难查的 bug。
    """
    outbox = Outbox(high_bytes=100)
    outbox.push(b"x" * 99)
    assert outbox.pending_bytes == 99
    assert outbox.would_exceed(1) is True  # 99 + 1 >= 100
    outbox.push(b"x")
    assert outbox.pending_bytes == 100
    outbox.drain()
    assert outbox.pending_bytes == 0


def test_discard_drops_everything_and_resets_state() -> None:
    outbox = Outbox(high_bytes=100)
    outbox.push(b"x" * 200)
    outbox.discard()
    assert outbox.pending_bytes == 0
    assert outbox.pending_chunks == 0


def test_would_exceed_is_used_for_progress_guarantee() -> None:
    """水位判断必须允许“队列为空时无条件入队”，否则大分片会永久卡住推送。"""
    outbox = Outbox(high_bytes=16)
    oversized = b"x" * 64
    assert outbox.would_exceed(len(oversized)) is True
    assert outbox.pending_bytes == 0  # 但仍应被允许入队（由调用方判断）
    outbox.push(oversized)
    assert outbox.pending_bytes == 64


def test_empty_push_is_ignored() -> None:
    outbox = Outbox(high_bytes=16)
    outbox.push(b"")
    outbox.push_text(b"")
    assert outbox.pending_bytes == 0
    assert outbox.drain() == ()


@pytest.mark.parametrize("high", [0, -1])
def test_non_positive_high_watermark_is_rejected(high: int) -> None:
    with pytest.raises(ValueError):
        Outbox(high_bytes=high)
