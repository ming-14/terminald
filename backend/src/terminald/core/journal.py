"""输出字节日志 —— 会话内容真源。

这是整个多客户端/刷新恢复机制的基石，语义必须钉死：

- **offset 从 0 开始、单调递增、永不回退**。offset N 表示“该会话已产生 N 字节输出”，
  区间语义统一为半开 `[0, end)`。
- **内容真源就是这条字节流本身**，不是终端模型的渲染结果。新客户端整段重放 → 与
  “从头就在的客户端”收到完全相同的字节 → 解析结果必然逐格一致（无损，且不需要
  任何有损的模型序列化）。
- **裁剪只发生在转义序列边界**（见 `protocol/scan.py`）。从序列中间切断再重放会产生
  可见乱码，RIS 无法修复。多字节 UTF-8 字符同理（切断后重放会先打出几个替换字符）。
- 裁剪点之前的内容丢失，这与原生终端 scrollback 写满后丢最早行的行为是**同一件事**。
- **重建时的对齐点**（`replay_offset`）也必须是这种干净边界，理由见该方法。

预算不足时**宁可保持不裁剪**（正确性优先于内存预算）；这只会发生在单条序列大到
超过预算的病态输入上。
"""

from __future__ import annotations

from array import array
from bisect import bisect_right
from typing import Final

from ..protocol.scan import SequenceScanner
from .errors import JournalTrimmed, OffsetAhead

# bisect 上界哨兵：比任何 offset 都大
_INF: Final = 1 << 64


class Journal:
    """按 offset 定位的输出字节日志（非线程安全，由调用方串行化）。"""

    __slots__ = (
        "_budget",
        "_buf",
        "_scanner",
        "_span_ends",
        "_span_starts",
        "_start",
        "trimmed_bytes",
    )

    def __init__(self, budget_bytes: int) -> None:
        if budget_bytes < 1:
            raise ValueError("budget_bytes 必须为正")
        self._buf = bytearray()
        self._start = 0
        self._budget = budget_bytes
        self._scanner = SequenceScanner()
        # 已闭合的“不可切断”区间（绝对偏移，按 start 升序、互不重叠）。
        # 用 array("q") 而不是 list[tuple]：8MB 预算下区间数可达十万级，
        # tuple 的对象开销会让内存与分配成本都明显高于收益。
        self._span_starts = array("q")
        self._span_ends = array("q")
        # 累计被裁剪掉的字节数（可观测性）
        self.trimmed_bytes = 0

    # ------------------------------------------------------------ 只读属性

    @property
    def start_offset(self) -> int:
        """当前仍可读的最早偏移（裁剪点）。"""
        return self._start

    @property
    def end_offset(self) -> int:
        """已产生的总字节数 = 下一个待写入字节的偏移。"""
        return self._start + len(self._buf)

    @property
    def size(self) -> int:
        """当前驻留内存的字节数。"""
        return len(self._buf)

    @property
    def budget_bytes(self) -> int:
        return self._budget

    # ------------------------------------------------------------ 写入

    def append(self, data: bytes | bytearray | memoryview) -> int:
        """追加输出字节，返回追加后的 `end_offset`。

        扫描与追加的顺序无关紧要，但必须先扫描后扩展，避免偏移错位。
        """
        if not data:
            return self.end_offset
        spans, _open_start = self._scanner.feed(data, self.end_offset)
        self._buf.extend(data)
        for span_start, span_end in spans:
            self._span_starts.append(span_start)
            self._span_ends.append(span_end)
        return self.end_offset

    # ------------------------------------------------------------ 读取

    def read(self, offset: int, limit: int) -> bytes:
        """读取 `[offset, offset+limit)`。

        - `offset < start_offset` → `JournalTrimmed`（无法续传，必须重建）
        - `offset > end_offset`   → `OffsetAhead`（客户端状态超前，协议不一致）
        """
        if offset < self._start:
            raise JournalTrimmed(offset, self._start)
        if offset > self.end_offset:
            raise OffsetAhead(offset, self.end_offset)
        if limit <= 0:
            return b""
        begin = offset - self._start
        return bytes(self._buf[begin : begin + limit])

    # ------------------------------------------------------------ 裁剪

    def safe_offset_at_or_after(self, pos: int) -> int:
        """返回 `>= pos` 的最近一个**可安全切断**的偏移。

        「安全」= 重放的字节流从这里开始时，解析器处于干净状态：

        - 不在未闭合序列内部（退回到该序列起点）；
        - 不落在已闭合序列内部（推到序列之后）；
        - 不落在多字节 UTF-8 字符中间（推到下一个字符边界）。
        """
        if pos <= self._start:
            return self._start

        open_start = self._scanner.open_start
        if open_start is not None and pos > open_start:
            # 序列尚未闭合，无法知道安全终点；退到它的起点（足够安全）
            return open_start

        index = bisect_right(self._span_starts, pos) - 1
        if index >= 0 and self._span_ends[index] > pos:
            # 切在序列内部：推到它之后。序列之后必然是字符边界，不必再看 UTF-8
            return int(self._span_ends[index])
        return self._utf8_boundary_at_or_after(pos)

    def replay_offset(self) -> int:
        """重建时客户端应当**从哪个偏移开始接字节**。

        重建交付给客户端的是一对东西：模型快照 + 从这里往后的原始字节。两者拼起来必须
        与模型的状态一致，所以这个点必须是**解析状态干净**的位置——否则客户端会把残缺
        序列的尾巴当普通文本画出来（`\x1b[38;5` 里的 `3` `8` `;` `5` 就是四个可见字符）。

        它因此可能**回退**到 `end_offset` 之前。回退的那几个字节在快照之后重放：
        快照本来就没有把这段残缺序列/字符的效果画进去（残缺就没有效果），所以这是补全
        而不是重复。
        """
        end = self.end_offset
        limit = end
        open_start = self._scanner.open_start
        if open_start is not None:
            limit = min(limit, open_start)
        pending = self._pending_utf8_start()
        if pending is not None:
            limit = min(limit, pending)
        return max(self._start, limit)

    def _utf8_boundary_at_or_after(self, pos: int) -> int:
        """`pos` 之后（含）最近的 UTF-8 字符边界。

        落在多字节字符中间时，重放的字节流会以几个**续字节**开头，客户端会先画出几个
        替换字符（`0x80..0xBF` 单独出现是非法编码）。往前推到下一个字符边界，就整段
        丢掉了那个残缺字符。
        """
        if pos >= self.end_offset:
            return pos  # 已经到末尾，再往后没有“更安全的边界”可言
        buf = self._buf
        index = max(0, pos - self._start)
        while index < len(buf) and 0x80 <= buf[index] < 0xC0:
            index += 1
        return self._start + index

    def _pending_utf8_start(self) -> int | None:
        """末尾那段**不完整**的多字节 UTF-8 的起点；末尾是干净边界时返回 None。"""
        buf = self._buf
        # UTF-8 序列最长 4 字节，所以最多回看 4 个
        for back in range(1, min(4, len(buf)) + 1):
            byte = buf[-back]
            if byte < 0x80:
                return None  # 末尾是 ASCII：不可能处在多字节字符中间
            if byte < 0xC0:
                continue  # 续字节：继续往前找前导字节
            if 0xC0 <= byte < 0xE0:
                expected = 2
            elif byte < 0xF0:
                expected = 3
            else:
                # 0xF0..0xF7 是 4 字节前导；0xF8..0xFF 不是合法编码，当作干净数据
                expected = 4 if byte < 0xF8 else 0
            if back >= expected:
                return None  # 已经凑满：这个字符是完整的
            return self.end_offset - back
        return None

    def trim_to(self, offset: int) -> int:
        """裁剪到指定偏移（必须是安全点，调用方负责）。返回新的 start_offset。"""
        if offset <= self._start:
            return self._start
        if offset > self.end_offset:
            raise OffsetAhead(offset, self.end_offset)

        dropped = offset - self._start
        del self._buf[:dropped]
        self._start = offset
        self.trimmed_bytes += dropped

        # 丢弃完全落在裁剪点之前的区间（保留跨过裁剪点的，虽然理论上不存在）
        live = int(bisect_right(self._span_ends, offset - 1))
        if live > 0:
            del self._span_starts[:live]
            del self._span_ends[:live]
        return self._start

    def trim_to_budget(self) -> int:
        """若超出预算则裁剪到安全点，返回新的 `start_offset`。"""
        if len(self._buf) <= self._budget:
            return self._start
        target = self.end_offset - self._budget
        cut = self.safe_offset_at_or_after(target)
        if cut <= self._start:
            # 找不到可用的安全点：保持不动，等序列闭合后下次再收
            return self._start
        return self.trim_to(cut)

    # ------------------------------------------------------------ 诊断

    def stats(self) -> dict[str, int]:
        return {
            "start_offset": self._start,
            "end_offset": self.end_offset,
            "size": self.size,
            "budget_bytes": self._budget,
            "trimmed_bytes": self.trimmed_bytes,
            "span_count": len(self._span_starts),
        }


__all__ = ["Journal"]
