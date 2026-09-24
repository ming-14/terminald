"""转义序列边界扫描器（增量、无分配状态机）。

**它为什么必须存在**：输出日志超预算时要从头裁剪，而“从中间切断字节流再重放”
会把一个转义序列劈成两半——重放到客户端就变成几个可见的乱码字符（例如 `31m`）。
前置一个 RIS (`\\x1bc`) 也不能修复它。因此裁剪点必须落在**序列边界**上。

扫描器只判断“边界安全性”，不解析序列语义：
- GROUND：普通字节，任意位置都可安全切断
- ESC：`0x1b` 后的单字节/中间字节序列
- CSI：`ESC [` 直到 final 字节 `0x40..0x7e`
- STRING：OSC / DCS / APC / PM / SOS，直到 `BEL` 或 `ST`（`ESC \\`）

对使用者而言只需要两件事：哪些区间是**不可切断**的，以及当前位置是否已回到
GROUND。
"""

from __future__ import annotations

from typing import Final

_ESC: Final = 0x1B
_BEL: Final = 0x07
_ST_C1: Final = 0x9C
_BACKSLASH: Final = 0x5C
_CAN: Final = 0x18
_SUB: Final = 0x1A

# ESC 之后进入字符串型序列的首字节
_STRING_INTROS: Final = frozenset({0x5D, 0x50, 0x5F, 0x5E, 0x58})  # ] P _ ^ X

_GROUND: Final = 0
_ESC_STATE: Final = 1
_CSI: Final = 2
_STRING: Final = 3


class SequenceScanner:
    """有状态的转义序列扫描器。

    唯一使用者在 `core/journal.py` 的 `Journal.append`：先把新区块喂给它、拿到
    「本次闭合的不可切断区间」，再扩展缓冲区并记下这些区间（顺序不能反，否则
    区间会带上错的绝对偏移）。裁剪与重建时再由 `Journal` 拿 `open_start` 与
    `safe_offset_at_or_after()` 求安全切点。
    """

    __slots__ = ("_esc_in_string", "_start", "_state")

    def __init__(self) -> None:
        self._state = _GROUND
        self._start = -1
        self._esc_in_string = False

    @property
    def in_sequence(self) -> bool:
        """是否正处在某个未闭合的序列内部。"""
        return self._state != _GROUND

    @property
    def open_start(self) -> int | None:
        """未闭合序列的起始绝对偏移。"""
        return self._start if self._state != _GROUND else None

    def feed(
        self, data: bytes | bytearray | memoryview, base_offset: int
    ) -> tuple[list[tuple[int, int]], int | None]:
        """喂入一段字节。

        返回 `(本次闭合的不可切断区间列表, 未闭合序列起点或 None)`；
        区间是**绝对偏移**，半开区间 `[start, end)`。
        """
        view = memoryview(data).cast("B")
        closed: list[tuple[int, int]] = []
        if self._state == _GROUND:
            self._start = -1

        for i, byte in enumerate(view):
            offset = base_offset + i
            state = self._state

            if state == _GROUND:
                if byte == _ESC:
                    self._state = _ESC_STATE
                    self._start = offset
                continue

            if state == _ESC_STATE:
                if byte == _ESC:  # ESC ESC：重新开始
                    self._start = offset
                elif byte == 0x5B:  # '[' → CSI
                    self._state = _CSI
                elif byte in _STRING_INTROS:  # OSC / DCS / APC / PM / SOS
                    self._state = _STRING
                    self._esc_in_string = False
                elif 0x20 <= byte <= 0x2F:  # 中间字节，继续
                    pass
                elif 0x30 <= byte <= 0x7E:  # 单字节序列结束
                    closed.append((self._start, offset + 1))
                    self._state = _GROUND
                    self._start = -1
                else:  # 非法续字节：把 ESC 本身当作已结束的序列
                    closed.append((self._start, offset))
                    self._state = _GROUND
                    self._start = -1
                    if byte == _ESC:
                        self._state = _ESC_STATE
                        self._start = offset
                continue

            if state == _CSI:
                # final 字节（0x40-0x7E）结束序列；CAN/SUB（0x18/0x1A）是显式中止，
                # 两者都把已收集的区间闭合、回到 GROUND。
                if 0x40 <= byte <= 0x7E or byte in (_CAN, _SUB):
                    closed.append((self._start, offset + 1))
                    self._state = _GROUND
                    self._start = -1
                # 其余（参数/中间字节/C0）一律继续收集
                continue

            # state == _STRING
            if self._esc_in_string:
                self._esc_in_string = False
                if byte == _BACKSLASH:  # ST = ESC '\'
                    closed.append((self._start, offset + 1))
                    self._state = _GROUND
                    self._start = -1
                    continue
            if byte in (_BEL, _ST_C1):
                closed.append((self._start, offset + 1))
                self._state = _GROUND
                self._start = -1
            elif byte == _ESC:
                self._esc_in_string = True

        return closed, self.open_start


__all__ = ["SequenceScanner"]
