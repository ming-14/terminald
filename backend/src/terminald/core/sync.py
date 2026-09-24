"""订阅对齐决策 —— 纯函数，无副作用，是同步正确性的唯一判定点。

三种情形，按“信息是否仍可用”择优（不是降级）：

1. **续传**：客户端报的偏移仍在日志覆盖范围内 → 只补 `[resume, end)`，零损。
2. **整段重放**：全新客户端且日志从 0 起完整 → 补 `[0, end)`。
   这仍是无损的：客户端拿到的字节与“从头就在的客户端”完全一致。
3. **重建**：日志已裁剪到断点之前 → 只能用终端模型生成快照（唯一的有损路径）。

`OffsetAhead`（客户端声称的偏移超过服务端）不在此处理：它是协议不一致，必须报错，
而不是悄悄当作“全新客户端”——静默重同步会掩盖真正的 bug。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TypeAlias

from .errors import OffsetAhead
from .journal import Journal


@dataclass(frozen=True, slots=True)
class Resume:
    """直接补字节：`[from_offset, to_offset)`，无损。"""

    from_offset: int
    to_offset: int


@dataclass(frozen=True, slots=True)
class Rebuild:
    """需要模型快照重建（日志已裁剪到客户端断点之前）。"""

    reason: str


AttachPlan: TypeAlias = Resume | Rebuild

REASON_FRESH_TRUNCATED = "fresh_truncated"
REASON_RESUME_TRIMMED = "resume_trimmed"


def plan_attach(journal: Journal, requested: int | None, end: int | None = None) -> AttachPlan:
    """决定如何把客户端对齐到 `end`。

    - `requested=None`：全新客户端（本地无任何状态）
    - `requested=N`：客户端已应用到偏移 N

    `end` 缺省取日志当前末尾；调用方在并发场景下应显式传入，以在同一临界区内
    完成“决策 + 登记对齐点”。
    """
    target = journal.end_offset if end is None else end
    if target < journal.start_offset or target > journal.end_offset:
        raise OffsetAhead(target, journal.end_offset)

    if requested is None:
        if journal.start_offset == 0:
            return Resume(0, target)
        return Rebuild(REASON_FRESH_TRUNCATED)

    if requested > journal.end_offset:
        raise OffsetAhead(requested, journal.end_offset)
    if requested < journal.start_offset:
        return Rebuild(REASON_RESUME_TRIMMED)
    return Resume(requested, target)


__all__ = [
    "REASON_FRESH_TRUNCATED",
    "REASON_RESUME_TRIMMED",
    "AttachPlan",
    "Rebuild",
    "Resume",
    "plan_attach",
]
