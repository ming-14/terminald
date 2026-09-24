"""Hub 测试 —— 多客户端同步、刷新恢复、流控、焦点聚合。

这些测试是需求的直接落点（“多客户端内容完全同步 / 刷新不丢 scrollback”），因此断言写得
很硬：不比较“看起来差不多”，而是比较**字节流本身**，并且由 `Endpoint` 强制校验
offset 首尾相接（无空洞、无重复）。

驱动方式：`FakeHost` 是宿主端口的一个实现，**线程归属**与真实适配器一致：`read()` 只搬运、
`ingest()` 独占模型、`write()` 走唯一写者。所以这里的结论对真实 pywezterm 宿主同样成立。
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import pytest

from support import (
    BlockingCloseHost,
    BlockingHost,
    Endpoint,
    client_of,
    feed,
    host_of,
    hub_context,
    make_endpoint,
    make_settings,
    runner_of,
    turn,
    wait_for,
    writes_drained,
)
from terminald.core import Client, SessionNotFound
from terminald.protocol.messages import (
    Ack,
    Attach,
    Attached,
    Behind,
    Detach,
    Exited,
    Failure,
    Focus,
    Resync,
    SessionClose,
    SessionCreate,
    SessionList,
    SessionRename,
    Sessions,
    SessionStatus,
)
from terminald.service.hub import Hub

pytestmark = pytest.mark.asyncio


# --------------------------------------------------------------- 工具


async def new_session(hub: Hub, name: str | None = None) -> str:
    return (await hub.create_session(name=name)).id


def attach_endpoint(hub: Hub, client_id: str, *, baseline: int = 0) -> Endpoint:
    """登记一个客户端并返回其记录器。

    `baseline` 表达“该客户端连接前本地已应用到 baseline 字节”，供续传用例使用。
    """
    hub.register_client(client_id)
    return make_endpoint(hub, client_id, baseline=baseline)


async def do_attach(endpoint: Endpoint, session_id: str, resume: int | None = None) -> None:
    await endpoint.hub.handle_message(endpoint.client_id, Attach(session=session_id, resume=resume))


@asynccontextmanager
async def blocked_hub() -> AsyncIterator[tuple[Hub, list[BlockingHost]]]:
    """宿主写会阻塞的 Hub（A1 回归用）。"""
    settings = make_settings()
    hosts: list[BlockingHost] = []

    def factory(spec: Any) -> BlockingHost:
        host = BlockingHost(spec)
        hosts.append(host)
        return host

    hub = Hub(settings, factory)
    try:
        yield hub, hosts
    finally:
        await hub.stop()


# --------------------------------------------------------------- 线程隔离（A1 回归）


async def test_blocked_write_never_stalls_the_event_loop() -> None:
    """A1 回归：写被 PTY 阻塞时，事件循环必须继续服务。

    构造：宿主的 `write()` 停在闸上（真实场景 = 子进程不读 stdin 把 PTY 缓冲写满）。
    断言两件事：进入写的是**写线程**而不是循环；阻塞期间循环仍能处理其他客户端。
    """
    async with blocked_hub() as (hub, hosts):
        sid = (await hub.create_session()).id
        a = attach_endpoint(hub, "a")
        await do_attach(a, sid)
        host = hosts[0]

        hub.handle_input("a", b"Z" * 4096)  # 必须立即返回，不得在循环上阻塞
        await wait_for(host.write_entered.is_set)  # 字节确实交给了写线程
        # 这里不需要“等一会儿再断言它是空的”：`BlockingHost.write` 先置位 `write_entered`、
        # 再等闸，而真正追加到 `written` 的 `super().write(...)` 在闸**之后**。所以
        # “已进入 write()” + “闸未开”本身就已经证明 `written` 仍为空——这是顺序，不是时机。
        assert host.written == b"", "写应当仍停在闸上（否则这个用例没构造出压力）"

        # 阻塞期间，循环仍能服务另一个客户端。`await` 能返回本身就是证据：
        # 循环若被写阻塞停摆，下一行根本不会被执行到。
        b = attach_endpoint(hub, "b")
        await hub.handle_message("b", SessionList())
        b.drain_until_quiet()
        assert b.count("sessions") == 1, "事件循环在写阻塞期间停摆了"

        # 放开闸：输入按原样送达
        host.write_gate.set()
        await wait_for(lambda: bytes(host.written) == b"Z" * 4096)


# --------------------------------------------------------------- 拆除路径（A13 回归）


async def test_blocked_close_never_stalls_the_event_loop() -> None:
    """A13 回归：拆除会话期间，事件循环必须继续服务其他客户端。

    构造：宿主的 `close()` 停在闸上（真实场景 = `ClosePseudoConsole` 等控制台客户端
    退出，实测 236 秒且持着 GIL）。断言三件事：

    1. 拆除在**事件循环之外**的执行流里等（否则循环会停在这里）；
    2. 等的同时循环照常服务另一个客户端；
    3. 摘除发生在阻塞释放**之前**——会话立刻从列表消失，不会以已死状态被 attach。
    """
    settings = make_settings()
    hosts: list[BlockingCloseHost] = []

    def factory(spec: Any) -> BlockingCloseHost:
        host = BlockingCloseHost(spec)
        hosts.append(host)
        return host

    hub = Hub(settings, factory)
    try:
        sid = (await hub.create_session()).id
        victim = attach_endpoint(hub, "victim")
        await do_attach(victim, sid)

        closing = asyncio.create_task(hub.close_session(sid))
        await wait_for(hosts[0].close_entered.is_set)  # 已经进入 host.close()，卡在闸上
        # `close_entered` 已置位 ⇒ 线程 join 已过、只剩闸未开 ⇒ 这个 task 不可能已完成。
        assert not closing.done(), "用例没构造出压力：close() 应当还停在闸上"

        # 拆除进行中：另一个客户端仍被服务，并且**看不到**那个正在拆除的会话
        observer = attach_endpoint(hub, "observer")
        await hub.handle_message("observer", SessionList())
        observer.drain_until_quiet()
        assert observer.count("sessions") == 1, "事件循环在拆除期间停摆了"
        assert hub.session_infos() == ()
        # 已经摘除的会话不能再被 attach（否则客户端会订阅到一个正在死去的终端）
        await do_attach(observer, sid)
        observer.drain_until_quiet()
        assert observer.last_control().t == "error"

        hosts[0].close_gate.set()
        await closing
        assert hub.session_infos() == ()
    finally:
        for host in hosts:
            host.close_gate.set()
        await hub.stop()


async def test_writes_drained_waits_for_a_gated_write() -> None:
    """写栅栏自身要有承载力：写线程卡在闸上时它**不得**放行。

    否定断言（“应用不该收到这一串”）只有在一个“该发生的都已经发生完”的栅栏之后才有
    判别力；栅栏若提前返回，那些断言就退化成永远为真。这里把栅栏单独做一次压力测试。
    """
    async with blocked_hub() as (hub, hosts):
        sid = (await hub.create_session()).id
        a = attach_endpoint(hub, "a")
        await do_attach(a, sid)
        host = hosts[0]

        hub.handle_input("a", b"Q" * 64)  # 这一次写会卡在闸上
        await wait_for(host.write_entered.is_set)
        assert runner_of(hub, sid).pending_bytes > 0

        fence = asyncio.create_task(writes_drained(hub, sid))
        await turn()  # 保证栅栏确实已经执行过至少一步（不是“等一会儿”）
        assert not fence.done(), "写还卡在闸上，栅栏却已经放行"

        host.write_gate.set()
        await asyncio.wait_for(fence, timeout=3)
        assert bytes(host.written) == b"Q" * 64


# --------------------------------------------------------------- 多客户端同步


async def test_two_clients_receive_byte_identical_streams(hub: Hub) -> None:
    """多客户端“内容完全同步”的最小证明：两边收到的字节完全相同、偏移完全一致。"""
    sid = await new_session(hub)
    a = attach_endpoint(hub, "a")
    b = attach_endpoint(hub, "b")
    await do_attach(a, sid)
    await do_attach(b, sid)

    await feed(hub, sid, b"hello \x1b[31mred\x1b[0m world\r\n")
    a.drain_until_quiet()
    b.drain_until_quiet()

    assert a.stream == b.stream == b"hello \x1b[31mred\x1b[0m world\r\n"
    assert a.next_offset == b.next_offset == len(a.stream)


async def test_fresh_client_gets_full_lossless_replay(hub: Hub) -> None:
    """新客户端从 offset 0 整段重放：与“一直在的客户端”拿到的是同一份输入。"""
    sid = await new_session(hub)
    a = attach_endpoint(hub, "a")
    await do_attach(a, sid)
    await feed(hub, sid, b"line-1\r\nline-2\r\n")
    a.drain_until_quiet()

    b = attach_endpoint(hub, "b")
    await do_attach(b, sid)
    b.drain_until_quiet()

    assert b.stream == a.stream == b"line-1\r\nline-2\r\n"
    assert isinstance(b.control_of("attached")[-1], Attached)
    assert b.control_of("attached")[-1].resumed is True  # 无损重放，不是模型重建
    assert b.snapshots == []
    assert b.next_offset == a.next_offset == len(b"line-1\r\nline-2\r\n")


async def test_resume_sends_only_the_gap(hub: Hub) -> None:
    """刷新续传：客户端带上本地偏移，服务端只补断档（内容不会重复应用）。"""
    sid = await new_session(hub)
    a = attach_endpoint(hub, "a")
    await do_attach(a, sid)
    await feed(hub, sid, b"12345")
    a.drain_until_quiet()
    known = a.next_offset
    assert known == 5

    b = attach_endpoint(hub, "b", baseline=known)
    await do_attach(b, sid, resume=known)
    b.drain_until_quiet()
    assert b.stream == b""  # 没有断档，就不重发
    assert b.next_offset == known

    await feed(hub, sid, b"67890")
    a.drain_until_quiet()
    b.drain_until_quiet()

    assert a.stream == b"1234567890"
    assert b.stream == b"67890"  # 只收到断档
    assert a.next_offset == b.next_offset == 10


async def test_snapshot_rebuild_when_log_was_trimmed(hub: Hub) -> None:
    """日志已裁剪到断点之前 → 只能用模型快照重建（唯一有损路径），之后仍精确续接。"""
    sid = await new_session(hub)
    a = attach_endpoint(hub, "a")
    await do_attach(a, sid)
    await feed(hub, sid, b"x" * (hub.settings.journal_budget_bytes + 4096))
    a.drain_until_quiet()
    session = hub.get_session(sid)
    assert session.journal.start_offset > 0
    # 模型与日志同源：重建路径的全部正确性都建在这一条上（见 docs/audit.md A2）
    assert host_of(hub, sid).fed_offset == session.journal.end_offset

    b = attach_endpoint(hub, "b")
    await do_attach(b, sid)
    b.drain_until_quiet()

    attached = b.control_of("attached")[-1]
    assert isinstance(attached, Attached)
    assert attached.resumed is False
    assert attached.offset == session.journal.end_offset
    assert b.snapshots and b.snapshots[0].startswith(b"\x1bc")
    assert b.next_offset == attached.offset

    # 快照之后的新输出必须无缝续接（Endpoint 会校验 offset 连续）
    await feed(hub, sid, b"after-rebuild")
    b.drain_until_quiet()
    assert b.stream == b"after-rebuild"


async def test_rebuild_alignment_point_never_splits_a_sequence(hub: Hub) -> None:
    """A2 的姊妹条款：重建的对齐点必须落在**解析状态干净**的位置。

    客户端是「快照 + 从对齐点起的字节」拼出来的。如果日志末尾正卡在一个残缺的转义序列
    里而我们直接对齐到 end，客户端拿到的第一段就是 `3` `8` `;` `5` 这些**参数字节**——
    它们不在序列里就是普通文本，会被直接画到屏幕上（真实的可见乱码）。

    这里断言：对齐点回到序列起点，且那段字节确实作为原始字节补发（快照 + 它们拼起来
    才等于模型的状态），拼写补全后两个客户端逐字节收敛。
    """
    sid = await new_session(hub)
    a = attach_endpoint(hub, "a")
    await do_attach(a, sid)
    # 先逼出裁剪，再让日志末尾卡在一个残缺的 SGR 序列上
    await feed(hub, sid, b"y" * (hub.settings.journal_budget_bytes + 4096))
    await feed(hub, sid, b"\x1b[38;5")
    a.drain_until_quiet()

    session = hub.get_session(sid)
    assert session.journal.start_offset > 0
    assert session.journal.replay_offset() == session.journal.end_offset - len(b"\x1b[38;5")

    b = attach_endpoint(hub, "b")
    await do_attach(b, sid)
    b.drain_until_quiet()

    attached = b.control_of("attached")[-1]
    assert isinstance(attached, Attached)
    assert attached.resumed is False
    assert attached.offset == session.journal.replay_offset()
    assert attached.offset < session.journal.end_offset
    assert b.snapshots
    # 残缺序列整段补发（不是只补尾巴）
    assert b.stream == b"\x1b[38;5"

    # 把序列补全：两个客户端必须收敛到同一状态（新客户端不会把参数字节留在屏幕上）
    await feed(hub, sid, b";196mRED")
    a.drain_until_quiet()
    b.drain_until_quiet()
    assert b.next_offset == a.next_offset == session.journal.end_offset
    assert b.stream.endswith(b"\x1b[38;5;196mRED")


async def test_resync_rebuilds_and_converges(hub: Hub) -> None:
    """客户端主动重同步：整段重建，此后与日志偏移对齐。"""
    sid = await new_session(hub)
    a = attach_endpoint(hub, "a")
    await do_attach(a, sid)
    await feed(hub, sid, b"before")
    a.drain_until_quiet()

    await hub.handle_message("a", Resync(session=sid, offset=0))
    a.drain_until_quiet()

    assert isinstance(a.control_of("attached")[-1], Attached)
    assert len(a.control_of("attached")) == 2
    assert a.snapshots  # 整段重建
    assert a.next_offset == hub.get_session(sid).journal.end_offset

    await feed(hub, sid, b"after")
    a.drain_until_quiet()
    assert a.stream.endswith(b"after")


# --------------------------------------------------------------- 流控


async def test_backpressure_pauses_without_dropping_bytes(hub: Hub) -> None:
    """水位触发只让推送**暂停**，绝不丢字节：排空后从游标继续补齐。"""
    sid = await new_session(hub)
    a = attach_endpoint(hub, "a")
    await do_attach(a, sid)

    blob = bytes(range(256)) * 256  # 64 KiB，远大于测试配置的水位
    await feed(hub, sid, blob)
    a.drain()  # 只取一轮（部分）
    assert not a.stream or len(a.stream) < len(blob)

    a.drain_until_quiet(rounds=64)

    assert bytes(a.stream) == blob
    assert a.next_offset == len(blob)
    assert a.count("behind") == 0  # 只是因为水位暂停，不是落后


async def test_client_cursor_behind_trim_point_gets_explicit_behind(hub: Hub) -> None:
    """落后到已裁剪区间：必须是**显式**通知，而不是静默少发一段。

    构造：客户端从不排空 → 游标在发送水位（64 KiB）附近就停住；随后持续喂入，
    日志被裁到「末尾 - 预算」的位置并越过游标。两个参数都受配置下限约束，
    所以靠**喂得足够多**（256 KiB ≫ 水位 + 预算）来制造这个落差。
    """
    sid = await new_session(hub)
    a = attach_endpoint(hub, "a")
    await do_attach(a, sid)

    chunk = b"y" * 8192
    for _ in range(32):
        await feed(hub, sid, chunk)

    session = hub.get_session(sid)
    assert session.journal.start_offset > 0
    cursor_before_drain = client_of(hub, "a").next_push_offset
    assert cursor_before_drain < session.journal.start_offset, "前置条件：游标已落到裁剪区间之前"
    a.drain()

    behind = a.control_of("behind")
    assert behind, "游标落到裁剪区间后必须收到 behind"
    assert isinstance(behind[-1], Behind)
    assert behind[-1].reason == "trimmed"
    assert behind[-1].offset < session.journal.start_offset

    # 落后是显式状态：客户端重同步后必须能重新对齐且之后无缝续接
    await hub.handle_message("a", Resync(session=sid, offset=session.journal.end_offset))
    a.drain_until_quiet()
    assert a.snapshots
    assert a.next_offset == session.journal.end_offset
    await feed(hub, sid, b"recovered")
    a.drain_until_quiet()
    assert a.stream.endswith(b"recovered")


async def test_ack_releases_paused_client(hub: Hub) -> None:
    """水位暂停后由 ack（“已解析到 offset”的回程信号）放开推送。

    这里刻意**不用** `drain()`：它会在排空后回调 `on_drained`，把“队列空了”和
    “客户端解析完了”两件事混在一起，就测不出 ack 到底有没有用。
    """
    sid = await new_session(hub)
    a = attach_endpoint(hub, "a")
    await do_attach(a, sid)

    # 正好等于日志预算：既能把发送水位压住，又不会触发裁剪（否则会走 Behind 分支）
    blob = b"z" * hub.settings.journal_budget_bytes
    await feed(hub, sid, blob)

    a.drain(notify=False)  # 字节已送达客户端，但客户端还没解析完
    cursor = client_of(hub, "a").next_push_offset
    assert cursor < len(blob), "水位应让推送停在日志末尾之前"
    assert a.next_offset == cursor

    await hub.handle_message("a", Ack(offset=cursor))  # 解析完了 → 由它放开推送
    assert client_of(hub, "a").next_push_offset == len(blob)

    a.drain_until_quiet(rounds=64)
    assert a.next_offset == hub.get_session(sid).journal.end_offset


# --------------------------------------------------------------- 焦点聚合


async def test_focus_is_aggregated_across_clients(hub: Hub) -> None:
    """多客户端的焦点必须聚合成一个布尔量下发给应用。"""
    sid = await new_session(hub)
    a = attach_endpoint(hub, "a")
    b = attach_endpoint(hub, "b")
    await do_attach(a, sid)
    await do_attach(b, sid)
    host = host_of(hub, sid)

    baseline = len(host.responses)
    await hub.handle_message("a", Focus(focused=True))
    await wait_for(lambda: host.responses[baseline:] == [b"\x1b[I"])

    # 第二个客户端聚焦：聚合值没有变化，不应再上报
    baseline = len(host.responses)
    await hub.handle_message("b", Focus(focused=True))
    await writes_drained(hub, sid)
    assert host.responses[baseline:] == []

    # 其中一个失焦：另一个仍聚焦，聚合值依旧没有变化
    baseline = len(host.responses)
    await hub.handle_message("a", Focus(focused=False))
    await writes_drained(hub, sid)
    assert host.responses[baseline:] == []

    # 全部失焦：才上报 FocusOut
    baseline = len(host.responses)
    await hub.handle_message("b", Focus(focused=False))
    await wait_for(lambda: host.responses[baseline:] == [b"\x1b[O"])


async def test_focus_on_attach_followed_by_disconnect(hub: Hub) -> None:
    """客户端断开要能被聚合逻辑正确吸收（不会留下“永久聚焦”）。"""
    sid = await new_session(hub)
    a = attach_endpoint(hub, "a")
    await do_attach(a, sid)
    await hub.handle_message("a", Focus(focused=True))
    host = host_of(hub, sid)
    assert hub.get_session(sid).focused is True

    hub.drop_client("a")
    assert hub.get_session(sid).focused is False
    await wait_for(lambda: host.responses and host.responses[-1] == b"\x1b[O")


# --------------------------------------------------------------- 会话生命周期


async def test_process_exit_keeps_session_and_content(hub: Hub) -> None:
    """进程退出**不销毁**会话：内容保留、可继续订阅（只有显式关闭才释放）。"""
    sid = await new_session(hub)
    a = attach_endpoint(hub, "a")
    await do_attach(a, sid)
    await feed(hub, sid, b"bye\r\n")

    host_of(hub, sid).exit(3)
    await wait_for(lambda: hub.get_session(sid).status is SessionStatus.EXITED)
    a.drain_until_quiet()

    session = hub.get_session(sid)
    assert session.exit_code == 3
    assert session.journal.end_offset == 5
    assert isinstance(a.control_of("exited")[-1], Exited)
    assert a.control_of("exited")[-1].code == 3

    # 会话仍在，新客户端依然能看到退出前的全部内容
    b = attach_endpoint(hub, "b")
    await do_attach(b, sid)
    b.drain_until_quiet()
    assert b.stream == b"bye\r\n"


async def test_detach_leaves_session_running(hub: Hub) -> None:
    sid = await new_session(hub)
    a = attach_endpoint(hub, "a")
    await do_attach(a, sid)
    await hub.handle_message("a", Detach())
    assert hub.get_session(sid).subscribers == ()

    await feed(hub, sid, b"still-alive")
    a.drain_until_quiet()
    assert a.stream == b""  # 已取消订阅，不再收到内容
    assert hub.get_session(sid).journal.end_offset == 11  # 会话仍在推进


async def test_switch_session_does_not_leak_subscription(hub: Hub) -> None:
    first = await new_session(hub, "one")
    second = await new_session(hub, "two")
    a = attach_endpoint(hub, "a")
    await do_attach(a, first)
    await do_attach(a, second)

    assert hub.get_session(first).subscribers == ()
    assert [c.id for c in hub.get_session(second).subscribers] == ["a"]

    await feed(hub, first, b"from-one")
    await feed(hub, second, b"from-two")
    a.drain_until_quiet()
    assert a.stream == b"from-two"


async def test_close_session_detaches_and_removes(hub: Hub) -> None:
    sid = await new_session(hub)
    a = attach_endpoint(hub, "a")
    await do_attach(a, sid)
    await hub.handle_message("a", SessionClose(session=sid))
    a.drain_until_quiet()

    assert hub.find_session(sid) is None
    with pytest.raises(SessionNotFound):
        hub.get_session(sid)
    assert a.control_of("sessions")  # 关闭后重新广播了会话列表
    assert a.control_of("sessions")[-1].items == ()


async def test_session_create_via_message_attaches_client(hub: Hub) -> None:
    a = attach_endpoint(hub, "a")
    await hub.handle_message("a", SessionCreate(name="workbench"))
    a.drain_until_quiet()

    sessions = a.control_of("sessions")
    assert sessions and isinstance(sessions[-1], Sessions)
    created = sessions[-1].items[0]
    assert created.name == "workbench"
    assert (created.cols, created.rows) == (hub.settings.cols, hub.settings.rows)
    attached = a.control_of("attached")[-1]
    assert isinstance(attached, Attached)
    assert (attached.cols, attached.rows) == (80, 24)
    assert hub.get_session(created.id).subscribers[0].id == "a"


async def test_rename_broadcasts_session_list(hub: Hub) -> None:
    sid = await new_session(hub, "old")
    a = attach_endpoint(hub, "a")
    await do_attach(a, sid)
    await hub.handle_message("a", SessionRename(session=sid, name="new"))
    a.drain_until_quiet()
    listing = a.control_of("sessions")[-1]
    assert [item.name for item in listing.items] == ["new"]


async def test_attach_unknown_session_reports_failure(hub: Hub) -> None:
    a = attach_endpoint(hub, "a")
    await do_attach(a, "s-does-not-exist")
    a.drain_until_quiet()
    failure = a.control_of("error")[-1]
    assert isinstance(failure, Failure)
    assert failure.code == "SessionNotFound"


async def test_input_is_forwarded_to_host(hub: Hub) -> None:
    sid = await new_session(hub)
    a = attach_endpoint(hub, "a")
    await do_attach(a, sid)
    hub.handle_input("a", b"ls\r")
    await wait_for(lambda: b"ls\r" in bytes(host_of(hub, sid).written))


async def test_input_is_ignored_when_not_attached(hub: Hub) -> None:
    await new_session(hub)
    attach_endpoint(hub, "a")
    hub.handle_input("a", b"ignored")  # 不应抛错，也不应送达任何宿主


async def test_clients_share_canonical_dimensions() -> None:
    """尺寸来自终端侧：所有客户端拿到的 cols/rows 必须完全相同。"""
    async with hub_context(cols=132, rows=43) as instance:
        sid = (await instance.create_session()).id
        sizes = []
        for client_id in ("a", "b"):
            instance.register_client(client_id)
            endpoint = make_endpoint(instance, client_id)
            await do_attach(endpoint, sid)
            endpoint.drain_until_quiet()
            attached = endpoint.control_of("attached")[-1]
            sizes.append((attached.cols, attached.rows))
        assert sizes == [(132, 43), (132, 43)]
        assert make_settings(cols=132, rows=43).cols == 132


async def test_stop_is_idempotent_and_marks_clients_closed(hub: Hub) -> None:
    await new_session(hub)
    a: Client = hub.register_client("a")
    await hub.stop()
    await hub.stop()
    assert a.closed is True
    assert hub.client_count() == 0
