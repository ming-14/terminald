"""二进制帧编解码。

终端字节流走二进制 WebSocket 帧，控制消息走文本帧（JSON）。两类由 WebSocket opcode
区分，负载里不再做多路复用。

**每条二进制消息可以串接多个帧**（服务端一次发送多段输出时避免每条一个小消息）。
因此每个帧自带长度前缀，格式是自定界的（**唯一真源**，前端 `protocol/frames.ts`
必须逐字节一致）::

    FRAME = 长度(u32 大端) | tag(u8) | [offset(u64 大端)] | payload

    OUTPUT   (S→C) tag=0x01  带 offset：payload 首个字节在输出日志中的绝对偏移
    INPUT    (C→S) tag=0x02  无 offset
    SNAPSHOT (S→C) tag=0x03  带 offset：payload 是**模型渲染的重建字节**，不是日志字节；
                             应用它之后客户端即对齐到该 offset（日志被裁剪时才用）

`长度` 覆盖 `tag + [offset] + payload`（不含长度字段自身，最少 1）。

offset 是整个同步机制的坐标：客户端据此上报已确认位置、服务端据此补断档、
双方据此判定落后/不一致。OUTPUT 与 SNAPSHOT 必须带它，INPUT 不需要。
"""

from __future__ import annotations

import struct
from collections.abc import Iterator
from enum import IntEnum
from typing import Final

_LEN = struct.Struct(">I")
_OFFSET = struct.Struct(">Q")
_HEADER = struct.Struct(">IB")  # 长度 + tag

MAX_OFFSET: Final = (1 << 64) - 1
MAX_FRAME_BYTES: Final = 64 * 1024 * 1024  # 单帧上限，防御性（16MB 是日志预算量级）


class FrameTag(IntEnum):
    """二进制帧类型标签。"""

    OUTPUT = 0x01
    INPUT = 0x02
    SNAPSHOT = 0x03


_OFFSET_BEARING: Final = frozenset({FrameTag.OUTPUT, FrameTag.SNAPSHOT})


class FrameError(ValueError):
    """帧格式非法。"""


# --------------------------------------------------------------- 编码


def _encode(tag: FrameTag, payload: bytes | bytearray | memoryview, offset: int | None) -> bytes:
    body = bytes(payload)
    head = bytes((int(tag),))
    if tag in _OFFSET_BEARING:
        if offset is None:
            raise FrameError(f"{tag.name} 帧必须带 offset")
        if not 0 <= offset <= MAX_OFFSET:
            raise FrameError(f"offset 越界: {offset}")
        head += _OFFSET.pack(offset)
    elif offset is not None:
        raise FrameError(f"{tag.name} 帧不接受 offset")
    length = len(head) + len(body)
    if length > MAX_FRAME_BYTES:
        raise FrameError(f"帧过大: {length}")
    return _LEN.pack(length) + head + body


def encode_output(offset: int, payload: bytes | bytearray | memoryview) -> bytes:
    """OUTPUT 帧：日志中 `[offset, offset+len(payload))` 的输出字节。"""
    return _encode(FrameTag.OUTPUT, payload, offset)


def encode_snapshot(offset: int, payload: bytes | bytearray | memoryview) -> bytes:
    """SNAPSHOT 帧：模型重建字节，应用后对齐到 `offset`。"""
    return _encode(FrameTag.SNAPSHOT, payload, offset)


def encode_input(payload: bytes | bytearray | memoryview) -> bytes:
    """INPUT 帧：客户端已按当前模式编码好的输入字节。"""
    return _encode(FrameTag.INPUT, payload, None)


# --------------------------------------------------------------- 解码


def iter_frames(
    message: bytes | bytearray | memoryview,
) -> Iterator[tuple[FrameTag, int | None, memoryview]]:
    """解析整条消息，逐个产出 `(tag, offset, payload)`。

    非法/截断的帧抛 `FrameError`——**不允许静默忽略**：静默跳过会让客户端与服务端
    状态悄然分叉，正是这套协议要避免的事。
    """
    view = memoryview(message).cast("B")
    total = len(view)
    pos = 0
    while pos < total:
        if total - pos < _HEADER.size:
            raise FrameError(f"帧头被截断: 剩余 {total - pos} 字节")
        (length, tag_byte) = _HEADER.unpack(view[pos : pos + _HEADER.size])
        pos += _HEADER.size
        if length < 1 or pos + length - 1 > total:
            raise FrameError(f"帧长度非法: {length}（剩余 {total - pos + 1}）")
        try:
            tag = FrameTag(tag_byte)
        except ValueError as exc:
            raise FrameError(f"未知帧标签: {tag_byte:#x}") from exc

        offset: int | None = None
        if tag in _OFFSET_BEARING:
            if length < 1 + _OFFSET.size:
                raise FrameError(f"{tag.name} 帧长度不足以容纳 offset: {length}")
            (offset,) = _OFFSET.unpack(view[pos : pos + _OFFSET.size])
            pos += _OFFSET.size

        # payload 长度 = 长度字段值 - 已消费的头(tag + 可选 offset)
        consumed = 1 + (_OFFSET.size if offset is not None else 0)
        payload = view[pos : pos + length - consumed]
        pos += length - consumed
        yield tag, offset, payload


def decode_output(message: bytes | bytearray | memoryview) -> tuple[int, memoryview]:
    """解析**恰好一个** OUTPUT 帧（测试与简单场景用）。"""
    frames = list(iter_frames(message))
    if len(frames) != 1:
        raise FrameError(f"期望恰好一个帧，实得 {len(frames)} 个")
    tag, offset, payload = frames[0]
    if tag is not FrameTag.OUTPUT or offset is None:
        raise FrameError(f"不是 OUTPUT 帧: {tag.name}")
    return offset, payload


def decode_input(message: bytes | bytearray | memoryview) -> tuple[memoryview, ...]:
    """解析消息中全部 INPUT 帧的负载（客户端发来的输入）。"""
    payloads: list[memoryview] = []
    for tag, _offset, payload in iter_frames(message):
        if tag is not FrameTag.INPUT:
            raise FrameError(f"不是 INPUT 帧: {tag.name}")
        payloads.append(payload)
    return tuple(payloads)


__all__ = [
    "MAX_FRAME_BYTES",
    "MAX_OFFSET",
    "FrameError",
    "FrameTag",
    "decode_input",
    "decode_output",
    "encode_input",
    "encode_output",
    "encode_snapshot",
    "iter_frames",
]
