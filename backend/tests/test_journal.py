"""输出字节日志测试。

这里验证的是整个同步机制的坐标系统：offset 语义、裁剪安全性、预算行为。
裁剪必须落在转义序列边界——否则“从日志中间重放”会把 `\\x1b[31m` 切成两半，
客户端会看到 `31m` 这样的可见乱码，而 RIS 修不回来。
"""

from __future__ import annotations

import pytest

from terminald.core.errors import JournalTrimmed, OffsetAhead
from terminald.core.journal import Journal


def test_offsets_start_at_zero_and_advance_monotonically() -> None:
    journal = Journal(1024)
    assert (journal.start_offset, journal.end_offset) == (0, 0)

    journal.append(b"abc")
    assert (journal.start_offset, journal.end_offset) == (0, 3)

    journal.append(b"def")
    assert journal.end_offset == 6
    assert journal.read(0, 6) == b"abcdef"
    assert journal.read(3, 3) == b"def"
    assert journal.read(6, 3) == b""


def test_read_beyond_end_returns_empty_not_error() -> None:
    journal = Journal(1024)
    journal.append(b"ab")
    assert journal.read(2, 10) == b""


def test_read_before_start_raises() -> None:
    journal = Journal(8)
    journal.append(b"a" * 64)
    journal.trim_to_budget()
    assert journal.start_offset > 0
    with pytest.raises(JournalTrimmed):
        journal.read(0, 1)


def test_read_past_end_raises() -> None:
    """客户端声称的偏移超过服务端 → 协议不一致，必须报错而不是静默容忍。"""
    journal = Journal(1024)
    journal.append(b"ab")
    with pytest.raises(OffsetAhead):
        journal.read(3, 1)


def test_trim_never_splits_escape_sequence() -> None:
    """裁剪点不能落在一个 CSI 序列内部。"""
    journal = Journal(1024)
    # 前 20 字节是普通文本，接着一个 10 字节的 SGR 序列
    journal.append(b"A" * 20)
    journal.append(b"\x1b[38;5;196m")
    journal.append(b"B" * 100)

    cut = journal.safe_offset_at_or_after(25)
    # 25 落在序列内部（序列是 [20, 31)），必须被推到序列之后
    assert cut >= 31

    journal.trim_to(cut)
    assert journal.read(journal.start_offset, 100).startswith(b"B")


def test_unclosed_sequence_falls_back_to_its_start() -> None:
    """序列还没闭合时无法知道安全终点 → 退回到序列起点（保守且正确）。"""
    journal = Journal(1024)
    journal.append(b"A" * 10 + b"\x1b]0;partial title")
    assert journal.safe_offset_at_or_after(12) == 10


def test_trim_never_splits_multibyte_character() -> None:
    """裁剪点不能落在多字节 UTF-8 字符中间。

    切在字符中间时，重放的字节流会以**续字节**开头（`0x80..0xBF` 单独出现是非法编码），
    客户端会先打出几个替换字符。切点应当被推到下一个字符边界。
    """
    journal = Journal(1024)
    journal.append(b"A" * 20)
    journal.append("中文测试".encode())
    journal.append(b"B" * 100)

    # 21 落在第一个汉字的第 2 个字节上（汉字是 [20, 23)）
    cut = journal.safe_offset_at_or_after(21)
    assert cut == 23
    tail = journal.read(cut, 64)
    # 重放出来的字节流必须逐字符可解：前面那几个字节被整段丢掉，而不是留下半个字符
    assert tail.decode("utf-8", "replace") == "文测试" + "B" * 55


def test_trim_keeps_character_that_starts_on_the_cut() -> None:
    """切点本来就落在字符边界上时不动它。"""
    journal = Journal(1024)
    journal.append(b"A" * 20 + "中".encode() + b"B" * 20)
    assert journal.safe_offset_at_or_after(20) == 20
    assert journal.safe_offset_at_or_after(23) == 23


def test_replay_offset_is_end_when_the_tail_is_clean() -> None:
    journal = Journal(1024)
    journal.append(b"hello")
    journal.append("中文".encode())
    journal.append(b"\x1b[31m")
    assert journal.replay_offset() == journal.end_offset


def test_replay_offset_rewinds_to_an_unclosed_sequence() -> None:
    """末尾卡在残缺序列里时，重建对齐点回到序列起点。

    否则客户端会先收到 `3` `8` `;` `5` 这些**参数字节**——它们不在序列里就是普通文本，
    会直接画到屏幕上。
    """
    journal = Journal(1024)
    journal.append(b"A" * 10 + b"\x1b[38;5")
    assert journal.end_offset == 16  # 10 个文本字节 + 6 字节的残缺序列
    assert journal.replay_offset() == 10

    journal.append(b";196m")
    assert journal.replay_offset() == journal.end_offset


def test_replay_offset_rewinds_to_an_incomplete_utf8_character() -> None:
    journal = Journal(1024)
    journal.append(b"ok " + "中".encode()[:2])
    assert journal.end_offset == 5
    assert journal.replay_offset() == 3


def test_replay_offset_never_before_trim_point() -> None:
    """重建对齐点不得后退到已裁剪的区间（那里已经没有字节了）。"""
    journal = Journal(64)
    journal.append(b"x" * 4096)
    journal.trim_to_budget()
    journal.append(b"\x1b[38;5")  # 末尾卡在残缺序列里
    assert journal.start_offset < journal.replay_offset() <= journal.end_offset


def test_trim_to_budget_keeps_recent_bytes() -> None:
    journal = Journal(64)
    journal.append(b"x" * 4096)
    start = journal.trim_to_budget()
    assert start > 0
    assert journal.size <= 64
    assert journal.end_offset == 4096
    assert journal.trimmed_bytes == start


def test_trim_to_budget_keeps_everything_when_under_budget() -> None:
    journal = Journal(1024)
    journal.append(b"x" * 100)
    assert journal.trim_to_budget() == 0
    assert journal.size == 100


def test_trim_to_budget_waits_for_sequence_to_close() -> None:
    """单条超大序列（例如一个巨型 OSC 粘贴）在闭合前不裁剪：正确性优先于预算。"""
    journal = Journal(32)
    journal.append(b"\x1b]52;c;" + b"Q" * 256)  # 未闭合
    assert journal.trim_to_budget() == 0
    assert journal.size > 32

    journal.append(b"\x07")  # 闭合
    assert journal.trim_to_budget() > 0


def test_trim_span_bookkeeping_does_not_grow_without_bound() -> None:
    """反复裁剪后，区间表必须跟着收缩，否则内存会被已裁掉的区间拖住。"""
    journal = Journal(256)
    for _ in range(200):
        journal.append(b"\x1b[31m" + b"x" * 64 + b"\x1b[0m")
        journal.trim_to_budget()
    stats = journal.stats()
    assert stats["span_count"] < 40, stats
    assert journal.size <= 256


def test_trim_to_before_start_is_noop() -> None:
    journal = Journal(64)
    journal.append(b"x" * 128)
    journal.trim_to_budget()
    before = journal.start_offset
    assert journal.trim_to(0) == before


def test_stats_are_consistent() -> None:
    journal = Journal(128)
    journal.append(b"hello")
    stats = journal.stats()
    assert stats["end_offset"] == 5
    assert stats["size"] == 5
    assert stats["budget_bytes"] == 128
    assert stats["start_offset"] + stats["size"] == stats["end_offset"]


def test_append_returns_new_end_offset() -> None:
    journal = Journal(1024)
    assert journal.append(b"abc") == 3
    assert journal.append(b"") == 3


def test_budget_must_be_positive() -> None:
    with pytest.raises(ValueError):
        Journal(0)
