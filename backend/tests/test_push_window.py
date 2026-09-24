"""实时推送窗口（`Ack` 真正在管的那件事）。

背景与取证在 `docs/audit.md` A4：`acked_offset` 以前只写不读，而实测证明
「socket 很快、渲染很慢」的客户端能让服务端把整条流推出去而 `acked` 停在 0——
未解析积压与日志预算无关，慢渲染的浏览器会在内核/浏览器里攒出任意大的缓冲。

窗口语义（本文件钉住的就是这几条）：

1. 对**会 ack** 的客户端，服务端最多推到 `acked_offset + push_ahead_bytes`；
2. `Ack` 一到就继续推（`on_drained` 管不到这一层：它不知道客户端渲染到哪）；
3. 对**不会 ack** 的客户端窗口不生效——保持旧行为，而不是停在一个永远解不开的窗口上；
4. 窗口卡住的客户端不会静默死掉：游标迟早落到日志裁剪点之前，于是走 `Behind` + 重建。

驱动方式与时序无关：每一步都等到一个**可观察的栅栏**（`feed()` / `drain_until_caught_up()`），
不用“等一会儿再看”，所以这些用例在机器被抢占时也不会变成另一条结论。
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from support import (
    Endpoint,
    client_of,
    feed,
    make_endpoint,
    make_settings,
    wait_for,
)
from terminald.core import Client
from terminald.protocol.messages import Ack, Attach
from terminald.runtime import make_host_factory
from terminald.service.hub import Hub

JOURNAL = 512 * 1024
WINDOW = 32 * 1024
CHUNK = 8 * 1024
OUTBOX_HIGH = 64 * 1024


def settings(**overrides: object):
    base: dict[str, object] = {
        "journal_budget_bytes": JOURNAL,
        "outbox_high_bytes": OUTBOX_HIGH,
        "attach_chunk_bytes": CHUNK,
        "push_ahead_bytes": WINDOW,
    }
    base.update(overrides)
    return make_settings(**base)


async def flood(hub: Hub, session_id: str, total: int) -> None:
    """持续产出；每一步都等到输出真正并入日志（栅栏，不是定时器）。"""
    produced = 0
    step = 16 * 1024
    while produced < total:
        await feed(hub, session_id, b"x" * step)
        produced += step


async def prove_acking(hub: Hub, endpoint: Endpoint, session_id: str) -> Client:
    """让该客户端“证明自己会 ack”，并返回它在 Hub 里的记录。

    窗口只对证明过的客户端生效（`Client.ack_seen`）——ack 必须真的**推进**过游标才算数，
    所以这是所有窗口用例共同的前置条件；写成一处，前置条件本身也只有一份。
    """
    record = client_of(hub, endpoint.client_id)
    await feed(hub, session_id, b"y" * (4 * CHUNK))
    endpoint.drain()  # socket 照单全收（但客户端还不 ack）
    await hub.handle_message(endpoint.client_id, Ack(offset=record.next_push_offset))
    assert record.ack_seen is True, "前置条件没建立：这个客户端还没证明会 ack"
    return record


@pytest.mark.asyncio
async def test_live_push_stops_at_the_window_and_resumes_on_ack() -> None:
    hub = Hub(settings(), make_host_factory("fake"))
    try:
        info = await hub.create_session(name="w")
        hub.register_client("a")
        endpoint = make_endpoint(hub, "a")
        await hub.handle_message("a", Attach(session=info.id))
        endpoint.drain_until_quiet()

        # 先让它证明自己会 ack（窗口只对这种客户端生效）
        await hub.handle_message("a", Ack(offset=0))
        record = client_of(hub, "a")
        assert record.ack_seen is False, "ack 没有真正推进时不算证明"
        record = await prove_acking(hub, endpoint, info.id)

        # 开始灌：socket 每次都排空（照单全收），但**不 ack**
        for _ in range(8):
            await feed(hub, info.id, b"z" * (64 * 1024))
            endpoint.drain()

        pushed = record.next_push_offset - record.acked_offset
        assert pushed <= WINDOW + CHUNK, f"越过窗口还在推：{pushed} > {WINDOW + CHUNK}"
        end = hub.get_session(info.id).journal.end_offset
        assert record.next_push_offset < end, "应该被窗口卡住，而不是已经推完"
        stalled_at = record.next_push_offset

        # ack 一下：必须立刻继续推（且只推一个窗口的量）
        await hub.handle_message("a", Ack(offset=stalled_at))
        endpoint.drain()
        assert record.next_push_offset > stalled_at, "Ack 之后必须继续推进"
        assert record.next_push_offset - record.acked_offset <= WINDOW + CHUNK
    finally:
        await hub.stop()


@pytest.mark.asyncio
async def test_client_that_never_acks_is_not_throttled() -> None:
    """不会 ack 的客户端保持旧行为：一直推，而不是停在永远解不开的窗口上。"""
    hub = Hub(settings(), make_host_factory("fake"))
    try:
        info = await hub.create_session(name="w")
        hub.register_client("a")
        endpoint = make_endpoint(hub, "a")
        await hub.handle_message("a", Attach(session=info.id))
        endpoint.drain_until_quiet()

        total = 256 * 1024
        await flood(hub, info.id, total)
        endpoint.drain_until_caught_up(hub.get_session(info.id))

        record = client_of(hub, "a")
        assert record.ack_seen is False
        assert record.next_push_offset == hub.get_session(info.id).journal.end_offset
        assert record.behind_notified is False, "一直推的客户端不该被宣布落后"
    finally:
        await hub.stop()


@pytest.mark.asyncio
async def test_window_stalled_client_escalates_to_behind_and_rebuild() -> None:
    """窗口卡住 + 持续输出 → 游标落到裁剪点之前 → 显式 `Behind`（收敛路径没被破坏）。"""
    hub = Hub(settings(journal_budget_bytes=128 * 1024), make_host_factory("fake"))
    try:
        info = await hub.create_session(name="w")
        hub.register_client("a")
        endpoint = make_endpoint(hub, "a")
        await hub.handle_message("a", Attach(session=info.id))
        endpoint.drain_until_quiet()

        # 证明会 ack → 窗口生效
        record = await prove_acking(hub, endpoint, info.id)

        # 从这里开始既不 ack 也不让 socket 排空过快：输出远超日志预算
        for _ in range(60):
            await feed(hub, info.id, b"z" * (32 * 1024))

        await wait_for(lambda: record.behind_notified, timeout=10)
        endpoint.drain_until_quiet()
        assert endpoint.control_of("behind"), "落后必须是显式状态"
    finally:
        await hub.stop()


@pytest.mark.asyncio
async def test_ack_beyond_what_was_sent_cannot_open_the_window() -> None:
    """越界的确认不记账。

    窗口判据是 `cursor - acked_offset >= push_ahead_bytes`，所以一个谎报的（或算错的）
    大偏移会把窗口推到从未填满的位置——效果等于把这个客户端的流控关掉。它只伤害宣告者
    自己，因此不构成协议违例，但绝不能生效。
    """
    hub = Hub(settings(), make_host_factory("fake"))
    try:
        info = await hub.create_session(name="w")
        hub.register_client("a")
        endpoint = make_endpoint(hub, "a")
        await hub.handle_message("a", Attach(session=info.id))
        endpoint.drain_until_quiet()

        # 先让它证明自己会 ack（窗口只对这种客户端生效）
        record = await prove_acking(hub, endpoint, info.id)
        sent_to = record.next_push_offset

        await hub.handle_message("a", Ack(offset=sent_to + 16 * 1024 * 1024))
        assert record.acked_offset == sent_to, "越界的 ack 不该被记账"

        for _ in range(8):
            await feed(hub, info.id, b"z" * (64 * 1024))
            endpoint.drain()

        pushed = record.next_push_offset - record.acked_offset
        assert pushed <= WINDOW + CHUNK, f"一个越界 ack 就把窗口解开了：{pushed} > {WINDOW + CHUNK}"
    finally:
        await hub.stop()


def test_push_window_must_fit_at_least_one_chunk() -> None:
    # 窗口比一个分片还小的话，推进的单位变成分片，水位失去意义 → 配置边界就拒绝
    with pytest.raises(ValidationError):
        settings(push_ahead_bytes=1024, attach_chunk_bytes=64 * 1024)
