"""输入方向背压（输入流控）的回归测试。

这一层要钉住的是：**拥塞只会让发送方停下来，绝不丢字节，也绝不堵住控制面**。

构造压力的方式与 A1 回归同源：宿主的 `write()` 停在闸上（真实场景 = 子进程不读 stdin
把 PTY 缓冲写满）。此时写队列只在累积、不在排出，于是水位判定可以被确定性地驱动，
而不是靠“发得够快”。

三个水位在测试里刻意压到 64 KiB / 8 KiB / 128 KiB，让整套行为在毫秒级内可观测。
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import pytest

from support import (
    BlockingHost,
    Endpoint,
    client_of,
    make_endpoint,
    make_settings,
    wait_for,
)
from terminald.protocol.messages import Attach, Detach, InputHold
from terminald.runtime.runner import InputVerdict
from terminald.service.hub import Hub

pytestmark = pytest.mark.asyncio

#: 单帧输入大小：16 KiB。水位都是它的整数倍，判定点因此完全可预测。
CHUNK = 16 * 1024
HIGH = 64 * 1024
LOW = 8 * 1024
HARD = 128 * 1024


@asynccontextmanager
async def congested_hub() -> AsyncIterator[tuple[Hub, list[BlockingHost]]]:
    """写队列会停止排出的 Hub：输入只能累积，直到测试打开闸门。"""
    settings = make_settings(
        input_high_bytes=HIGH,
        input_low_bytes=LOW,
        input_hard_bytes=HARD,
    )
    hosts: list[BlockingHost] = []

    def factory(spec: Any) -> BlockingHost:
        # 不回显：本用例要断言的是写队列，不需要输出掺进来
        host = BlockingHost(spec, echo=False)
        hosts.append(host)
        return host

    hub = Hub(settings, factory)
    try:
        yield hub, hosts
    finally:
        for host in hosts:
            host.write_gate.set()  # 先放闸，避免收尾时 join 写线程超时
        await hub.stop()


async def attach(hub: Hub, client_id: str, session_id: str) -> Endpoint:
    hub.register_client(client_id)
    endpoint = make_endpoint(hub, client_id)
    await hub.handle_message(client_id, Attach(session=session_id, resume=None))
    return endpoint


async def test_input_hold_pauses_sender_without_dropping_bytes() -> None:
    """核心用例：越过高水位 → 暂缓（只通知一次）；排水后放行，字节一个不丢、顺序不变。"""
    async with congested_hub() as (hub, hosts):
        sid = (await hub.create_session()).id
        endpoint = await attach(hub, "a", sid)
        host = hosts[0]

        # 提交的块按序记下来：最后要拿它逐字节比对“一个不丢、乱序也算丢”
        chunks: list[bytes] = []

        def send(payload: bytearray | bytes) -> InputVerdict:
            data = bytes(payload)
            chunks.append(data)
            return hub.handle_input("a", data)

        # 第一块就卡在闸上：写线程已取走它，队列里的都在等
        assert send(b"0" * CHUNK) is InputVerdict.ACCEPTED
        await wait_for(host.write_entered.is_set)

        # 累计到高水位之前都不该惊动客户端
        assert send(b"1" * CHUNK) is InputVerdict.ACCEPTED
        assert send(b"2" * CHUNK) is InputVerdict.ACCEPTED
        endpoint.drain_until_quiet()
        assert endpoint.control_of("input_hold") == [], "未到水位就不该下发暂缓"

        # 第 4 块 = 64 KiB = 高水位 → 判定 HOLD，且只下发一次
        assert send(b"3" * CHUNK) is InputVerdict.HOLD
        assert send(b"4" * CHUNK) is InputVerdict.HOLD
        endpoint.drain_until_quiet()
        holds = endpoint.control_of("input_hold")
        assert len(holds) == 1, "已暂缓时不得重复下发（否则洪水会把控制面刷爆）"
        assert isinstance(holds[0], InputHold)
        assert holds[0].paused is True
        assert holds[0].session == sid
        assert client_of(hub, "a").input_held is True

        # 继续无视暂缓灌到硬上限 → OVERFLOW（由传输层据此断开）
        assert send(b"5" * CHUNK) is InputVerdict.HOLD
        assert send(b"6" * CHUNK) is InputVerdict.HOLD
        assert send(b"7" * CHUNK) is InputVerdict.OVERFLOW
        # 越限之后仍然是 OVERFLOW（传输层会在第一条上断开，这里只钉住判定本身）
        assert send(b"8" * CHUNK) is InputVerdict.OVERFLOW
        expected = b"".join(chunks)

        # 排水：写线程把队列写完 → 触发放行（经 call_soon_threadsafe 回到事件循环）
        host.write_gate.set()
        await wait_for(lambda: bytes(host.written) == expected)

        endpoint.drain_until_quiet()
        releases = [
            m
            for m in endpoint.control_of("input_hold")
            if isinstance(m, InputHold) and not m.paused
        ]
        assert len(releases) == 1, "放行只发一次（滞回，不随每次写出抖动）"
        assert client_of(hub, "a").input_held is False

        # 最硬的一条：8 块全部按原序送达，一个字节都没丢、没有重复
        assert bytes(host.written) == expected


async def test_hold_is_per_client_and_cleared_on_detach() -> None:
    """暂缓是**每客户端**状态：只发给真正灌满队列的那个；解除订阅后不再保留。"""
    async with congested_hub() as (hub, hosts):
        sid = (await hub.create_session()).id
        a = await attach(hub, "a", sid)
        b = await attach(hub, "b", sid)
        host = hosts[0]

        assert hub.handle_input("a", b"x" * CHUNK) is InputVerdict.ACCEPTED
        await wait_for(host.write_entered.is_set)
        for _ in range(3):
            hub.handle_input("a", b"x" * CHUNK)
        a.drain_until_quiet()
        b.drain_until_quiet()

        assert len(a.control_of("input_hold")) == 1
        assert b.control_of("input_hold") == [], "没人灌队列的客户端不该被停发"
        assert client_of(hub, "b").input_held is False

        # 管道已经饱和：这时另一个客户端也发东西，同样要被告知暂缓
        assert hub.handle_input("b", b"y") is InputVerdict.HOLD
        b.drain_until_quiet()
        assert len(b.control_of("input_hold")) == 1

        # a 解除订阅：状态清掉，放行也不会再发给它
        await hub.handle_message("a", Detach())
        assert client_of(hub, "a").input_held is False

        host.write_gate.set()
        await wait_for(lambda: client_of(hub, "b").input_held is False)
        b.drain_until_quiet()
        releases = [
            m for m in b.control_of("input_hold") if isinstance(m, InputHold) and not m.paused
        ]
        assert len(releases) == 1

        a.drain_until_quiet()
        assert len(a.control_of("input_hold")) == 1, "已解除订阅的客户端不该再收到任何状态"


async def test_input_before_attach_is_dropped_without_backpressure() -> None:
    """没有会话的输入无处可去：既不报错也不产生背压（这是现有语义，这里把它钉住）。"""
    async with congested_hub() as (hub, _hosts):
        await hub.create_session()
        hub.register_client("a")
        assert hub.handle_input("a", b"x" * (HARD * 4)) is InputVerdict.ACCEPTED


async def test_response_bytes_are_never_refused_and_do_not_trigger_hold() -> None:
    """宿主应答不参与水位：它必须无条件入队（否则模型永远收不到 DSR 回复）。"""
    async with congested_hub() as (hub, hosts):
        sid = (await hub.create_session()).id
        endpoint = await attach(hub, "a", sid)
        host = hosts[0]

        assert hub.handle_input("a", b"x" * CHUNK) is InputVerdict.ACCEPTED
        await wait_for(host.write_entered.is_set)
        for _ in range(3):
            hub.handle_input("a", b"x" * CHUNK)
        assert client_of(hub, "a").input_held is True

        runner = hub._runners[sid]
        before = runner.pending_bytes
        response = b"\x1b[1;1R" * 64
        runner.submit_response(response)
        # 应答计入在途字节（否则写线程的扣减会让计数失真），但不会被拒绝
        assert runner.pending_bytes == before + len(response)

        host.write_gate.set()
        await wait_for(lambda: b"\x1b[1;1R" in bytes(host.written))
        endpoint.drain_until_quiet()
