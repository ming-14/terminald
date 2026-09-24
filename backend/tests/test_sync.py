"""订阅对齐决策的测试。

`plan_attach` 是个纯函数，却是“刷新不丢内容”的仲裁点，因此它的决策表要逐个格子覆盖：
**能补字节就补字节（无损），只有日志真的被裁掉了才允许走模型重建（有损）**。
"""

from __future__ import annotations

import pytest

from terminald.core.errors import OffsetAhead
from terminald.core.journal import Journal
from terminald.core.sync import (
    REASON_FRESH_TRUNCATED,
    REASON_RESUME_TRIMMED,
    Rebuild,
    Resume,
    plan_attach,
)


def _journal(*chunks: bytes, budget: int = 1024) -> Journal:
    journal = Journal(budget)
    for chunk in chunks:
        journal.append(chunk)
    return journal


def test_fresh_client_with_full_log_resumes_from_zero() -> None:
    """全新客户端 + 日志完整 → 整段重放（依然无损，因为拿到的是同一份原始字节）。"""
    journal = _journal(b"hello", b" world")
    assert plan_attach(journal, None) == Resume(0, 11)


def test_resume_within_log_only_fills_the_gap() -> None:
    journal = _journal(b"abc", b"def")
    assert plan_attach(journal, 3) == Resume(3, 6)


def test_resume_at_end_is_empty_gap() -> None:
    journal = _journal(b"abc")
    assert plan_attach(journal, 3) == Resume(3, 3)


def test_resume_at_start_is_full_log() -> None:
    journal = _journal(b"abc")
    assert plan_attach(journal, 0) == Resume(0, 3)


def test_explicit_end_is_honoured() -> None:
    """调用方在同一临界区内固定 end，避免“决策之后又来了新输出”的窗口。"""
    journal = _journal(b"abcdef")
    assert plan_attach(journal, 2, end=4) == Resume(2, 4)


def test_fresh_client_after_trim_must_rebuild() -> None:
    journal = _journal(b"x" * 4096, budget=64)
    journal.trim_to_budget()
    assert journal.start_offset > 0
    plan = plan_attach(journal, None)
    assert plan == Rebuild(REASON_FRESH_TRUNCATED)


def test_resume_before_trim_point_must_rebuild() -> None:
    journal = _journal(b"x" * 4096, budget=64)
    journal.trim_to_budget()
    plan = plan_attach(journal, 0)
    assert plan == Rebuild(REASON_RESUME_TRIMMED)


def test_resume_exactly_at_trim_point_is_still_lossless() -> None:
    """断点恰好落在裁剪点上：仍可续传，不需要重建。"""
    journal = _journal(b"x" * 4096, budget=64)
    journal.trim_to_budget()
    plan = plan_attach(journal, journal.start_offset)
    assert isinstance(plan, Resume)
    assert plan.from_offset == journal.start_offset


def test_offset_ahead_is_an_error_not_a_silent_resync() -> None:
    """客户端状态超前属于协议不一致：静默重建会掩盖真正的 bug。"""
    journal = _journal(b"abc")
    with pytest.raises(OffsetAhead):
        plan_attach(journal, 99)
    with pytest.raises(OffsetAhead):
        plan_attach(journal, 1, end=99)


def test_empty_journal_fresh_client_is_lossless_empty_resume() -> None:
    assert plan_attach(Journal(1024), None) == Resume(0, 0)


def test_trimmed_to_zero_journal_never_rebuilds_for_fresh_client() -> None:
    """只要 start_offset 仍是 0，全新客户端就走无损重放，与日志大小无关。"""
    journal = _journal(b"x" * 10_000, budget=1_000_000)
    assert journal.start_offset == 0
    plan = plan_attach(journal, None)
    assert isinstance(plan, Resume)
    assert plan == Resume(0, 10_000)
