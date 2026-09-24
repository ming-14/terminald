"""协议层测试：帧编解码、共享向量、控制消息。

`vectors/basic.json` 是**前后端的共同契约**：Rust/Python 侧与 TypeScript 侧各跑一遍
同一份文件。任何一侧改了字节布局，另一侧立刻红——这比在两边各写一遍“期望值”可靠，
因为人写两边的时候很可能把同一个误解写两遍。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from terminald.api.schemas import CreateSessionRequest
from terminald.protocol import PROTOCOL_VERSION, frames
from terminald.protocol.messages import (
    SESSION_NAME_MAX,
    Attach,
    Attached,
    MessageError,
    dump_bytes,
    parse_client_message,
    parse_server_message,
    server_message_shapes,
)

VECTORS = json.loads(
    (Path(__file__).resolve().parents[1] / "src/terminald/protocol/vectors/basic.json").read_text(
        encoding="utf-8"
    )
)


def _hex(value: str) -> bytes:
    return bytes.fromhex(value)


# --------------------------------------------------------------- 共享向量


@pytest.mark.parametrize("case", VECTORS["output_frames"], ids=lambda c: c["why"])
def test_vector_output_frames(case: dict[str, object]) -> None:
    raw = _hex(str(case["hex"]))
    payload = str(case["payload_utf8"]).encode()
    assert raw == frames.encode_output(int(case["offset"]), payload)
    offset, decoded = frames.decode_output(raw)
    assert offset == int(case["offset"])
    assert bytes(decoded) == payload


@pytest.mark.parametrize("case", VECTORS["snapshot_frames"], ids=lambda c: c["why"])
def test_vector_snapshot_frames(case: dict[str, object]) -> None:
    raw = _hex(str(case["hex"]))
    payload = str(case["payload_utf8"]).encode()
    assert raw == frames.encode_snapshot(int(case["offset"]), payload)
    ((tag, offset, decoded),) = frames.iter_frames(raw)
    assert tag is frames.FrameTag.SNAPSHOT
    assert offset == int(case["offset"])
    assert bytes(decoded) == payload


@pytest.mark.parametrize("case", VECTORS["input_frames"], ids=lambda c: c["why"])
def test_vector_input_frames(case: dict[str, object]) -> None:
    raw = _hex(str(case["hex"]))
    payload = str(case["payload_utf8"]).encode()
    assert raw == frames.encode_input(payload)
    assert [bytes(p) for p in frames.decode_input(raw)] == [payload]


@pytest.mark.parametrize("case", VECTORS["batched"], ids=lambda c: c["why"])
def test_vector_batched_message(case: dict[str, object]) -> None:
    """一条消息可串接多帧（服务端合并发送、客户端一次 send 多段输入）。"""
    raw = _hex(str(case["hex"]))
    parsed = [(tag, offset, bytes(payload)) for tag, offset, payload in frames.iter_frames(raw)]
    assert parsed == [
        (frames.FrameTag.OUTPUT, 0, b"hi"),
        (frames.FrameTag.INPUT, None, b"x"),
    ]


@pytest.mark.parametrize("case", VECTORS["control_messages"], ids=lambda c: c["why"])
def test_vector_control_messages(case: dict[str, object]) -> None:
    """控制消息向量必须能被解析成对应模型，并往返序列化一致。

    每个向量**只**在一个方向上合法（`hello` / `attach` 是 C→S，`attached` / `behind`
    是 S→C），所以两个解析器里恰好一个能成功——这本身就是方向约束的断言。
    """
    text = json.dumps(case["json"], ensure_ascii=False)
    json_value = case["json"]
    assert isinstance(json_value, dict)
    direction = "client" if json_value["t"] in _CLIENT_MESSAGE_TYPES else "server"

    if direction == "client":
        parsed = parse_client_message(text)
        with pytest.raises(MessageError):
            parse_server_message(text)
    else:
        parsed = parse_server_message(text)
        with pytest.raises(MessageError):
            parse_client_message(text)
    assert json.loads(parsed.model_dump_json()) == json_value


# --------------------------------------------------------------- 会话名


@pytest.mark.parametrize(
    "raw",
    [
        {"t": "session.create", "name": ""},
        {"t": "session.create", "name": "x" * (SESSION_NAME_MAX + 1)},
        {"t": "session.rename", "session": "s1", "name": ""},
        {"t": "session.rename", "session": "s1", "name": "x" * (SESSION_NAME_MAX + 1)},
    ],
    ids=["create-empty", "create-too-long", "rename-empty", "rename-too-long"],
)
def test_session_name_bounds_are_enforced_on_the_wire(raw: dict[str, object]) -> None:
    """空名字与超长名字必须在边界上被拒：

    名字会随 `sessions` 广播给所有客户端，空名字会在侧栏变成一张点不中的卡片，
    而长度上没有上界意味着一个客户端能决定所有客户端要渲染多少文本。
    """
    with pytest.raises(MessageError):
        parse_client_message(json.dumps(raw))


def test_session_name_limit_is_the_same_on_rest_and_ws() -> None:
    """REST 与 WS 是同一个操作的两个入口，边界必须来自同一处（`SESSION_NAME_MAX`）。"""
    at_limit = "x" * SESSION_NAME_MAX
    assert CreateSessionRequest(name=at_limit).name == at_limit
    assert parse_client_message(json.dumps({"t": "session.create", "name": at_limit}))

    with pytest.raises(ValidationError):
        CreateSessionRequest(name=at_limit + "x")


_CLIENT_MESSAGE_TYPES = frozenset(
    {
        "hello",
        "attach",
        "detach",
        "resync",
        "ack",
        "focus",
        "session.create",
        "session.list",
        "session.close",
        "session.rename",
    }
)


# --------------------------------------------------------------- 帧边界


def test_frames_roundtrip_with_offset_boundaries() -> None:
    for offset in (0, 1, 255, 65535, frames.MAX_OFFSET):
        raw = frames.encode_output(offset, b"\x1b[31mred\x1b[0m")
        decoded_offset, payload = frames.decode_output(raw)
        assert decoded_offset == offset
        assert bytes(payload) == b"\x1b[31mred\x1b[0m"


def test_offset_bearing_frames_require_offset() -> None:
    with pytest.raises(frames.FrameError):
        frames.encode_output(-1, b"x")  # type: ignore[arg-type]
    with pytest.raises(frames.FrameError):
        frames.encode_snapshot(1 << 64, b"x")


def test_empty_message_yields_no_frames() -> None:
    """空消息不是错误：一条消息里可以一个帧都没有。"""
    assert list(frames.iter_frames(b"")) == []


@pytest.mark.parametrize(
    ("raw", "why"),
    [
        (b"\x00\x00\x00\x05\x01\x00", "帧头被截断"),
        (b"\x00\x00\x00\x00\x01", "长度为 0 非法"),
        (b"\x00\x00\x00\x02\x7f\x00", "未知标签"),
        (b"\x00\x00\x00\x05\x01\x00\x00", "OUTPUT 帧长度不足以容纳 offset"),
        (b"\x00\x00\x00\x0e\x01" + b"\x00" * 8 + b"he", "声明的负载长度超过实际字节数"),
    ],
)
def test_decode_rejects_malformed(raw: bytes, why: str) -> None:
    """非法帧必须抛错，**绝不能**静默跳过——静默会掩盖双方状态分叉。"""
    with pytest.raises(frames.FrameError):
        list(frames.iter_frames(raw))


def test_truncated_frame_is_rejected() -> None:
    good = frames.encode_output(7, b"hello")
    with pytest.raises(frames.FrameError):
        list(frames.iter_frames(good[:-1]))


def test_iter_frames_yields_views_without_copy() -> None:
    """payload 必须是 memoryview：大块输出直接透传给 socket，不做额外拷贝。"""
    raw = frames.encode_output(0, b"x" * 32)
    ((_, _, payload),) = frames.iter_frames(raw)
    assert isinstance(payload, memoryview)
    assert len(payload) == 32


# --------------------------------------------------------------- 控制消息


def test_client_message_parsing_and_defaults() -> None:
    parsed = parse_client_message('{"t": "attach", "session": "s1"}')
    assert isinstance(parsed, Attach)
    assert parsed.resume is None


def test_unknown_field_is_rejected() -> None:
    """`extra="forbid"`：字段拼错必须在边界炸，而不是静默失效。"""
    with pytest.raises(MessageError):
        parse_client_message('{"t": "attach", "session": "s1", "offset": 5}')


def test_unknown_message_type_is_rejected() -> None:
    with pytest.raises(MessageError):
        parse_client_message('{"t": "nope"}')


def test_negative_values_are_rejected() -> None:
    with pytest.raises(MessageError):
        parse_client_message('{"t": "ack", "offset": -1}')


def test_server_message_roundtrip() -> None:
    message = Attached(
        session="s1", cols=120, rows=30, scrollback=10_000, offset=4096, resumed=True
    )
    parsed = parse_server_message(dump_bytes(message))
    assert parsed == message
    assert parsed.scrollback == 10_000


def test_server_message_shapes_match_shared_contract() -> None:
    """前后端的字段形状契约不得漂移。

    为什么需要这条：`vectors/basic.json` 只钉住了 6 种消息的 JSON 形态，而**前端对每一条
    下行消息都做严格校验**（字段类型 + 多余字段直接报错）。后端加一个字段、改一个类型，
    只要没赶上向量那几条用例，就会被前端当成非法消息丢掉——而两边各自写一遍期望值时，
    同一个误解很容易被写两遍。所以形状单独抽成一份生成物：

    - 改了 pydantic 模型却不重新生成 → **这里红**；
    - 改了前端那套校验器 → `messages.test.ts` 里那条对称的比对红。
    """
    expected = json.loads(
        (
            Path(__file__).resolve().parents[1] / "src/terminald/protocol/vectors/shapes.json"
        ).read_text(encoding="utf-8")
    )
    # `$comment` 只是给人看的说明，不是契约内容
    expected.pop("$comment", None)
    assert server_message_shapes() == expected, (
        "字段形状与 vectors/shapes.json 不一致：模型改了就要重新生成（命令见该文件的 $comment）"
    )


def test_attached_requires_scrollback() -> None:
    """`scrollback` 是终端侧属性，必须由服务端交付。

    少了它前端只能写死一个数去和服务端配置对齐——那是个会漂移的常数，所以这里把
    「必须有」钉住：漏传就是协议错误，而不是悄悄用默认值兜住。
    """
    with pytest.raises(MessageError):
        parse_server_message(
            '{"t":"attached","session":"s1","cols":120,"rows":30,"offset":0,"resumed":true}'
        )


def test_size_messages_do_not_exist_in_either_direction() -> None:
    """尺寸没有消息面：要么客户端改、要么终端侧改——两边都不存在。

    删掉 `sized` 是因为**没有任何代码路径能改 cols/rows**；留着它就只会在协议、前端
    与文档里各挂一个永不触发的分支（A7）。发现它重新出现，说明有人真的做了改尺寸——
    那时应该同时补上发送点，而不是只把消息加回来。
    """
    with pytest.raises(MessageError):
        parse_client_message('{"t": "sized", "session": "s1", "cols": 80, "rows": 24}')
    with pytest.raises(MessageError):
        parse_server_message('{"t": "sized", "session": "s1", "cols": 80, "rows": 24}')
    with pytest.raises(MessageError):
        parse_server_message('{"t": "bell", "session": "s1"}')


def test_protocol_version_is_declared() -> None:
    assert VECTORS["version"] == PROTOCOL_VERSION
    assert parse_client_message('{"t": "hello"}').protocol == PROTOCOL_VERSION
