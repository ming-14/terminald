"""改尺寸（`session.resize` / `resized`）的行为测试。

尺寸这件事有三层，测试也按三层分开：

1. **协议**（越界、边界值、消息形状）在 `test_protocol.py`；
2. **本文件**：Hub 与客户端侧的行为——改到宿主上了没有、谁收到了、`resized` 在流里的
   **位置**对不对、同尺寸是否幂等；
3. **真实宿主**（子进程是否真的看到新尺寸）在 `test_contract_pywezterm.py`。

第 2 层里最容易写假的那条是"顺序"：`resized` 只有排在该客户端**按旧尺寸产生的全部字节**
之后才是对的（见 `core/client.py` 的 `pending_resizes`）。所以 `Endpoint` 现在记了一份
**出站顺序**日志（`order`），顺序类断言直接用它，而不是靠"控制消息列表里最后一条是它"
这种巧合成立的写法。
"""

from __future__ import annotations

import pytest

from support import Endpoint, client_of, feed, host_of, hub_context, make_endpoint, turn
from terminald.core.errors import SessionNotFound
from terminald.protocol.messages import Ack, Attach, Attached, Resized, SessionResize, Sessions
from terminald.service.hub import Hub

pytestmark = pytest.mark.asyncio

#: 顺序类用例的配置：日志预算足够大（不能触发裁剪，否则客户端会走 `Behind` + 重建，
#: 那是一条与"顺序"无关的路径），窗口小到几十 KB 就能把客户端落在后面。
JOURNAL = 512 * 1024
WINDOW = 32 * 1024
CHUNK = 8 * 1024
OUTBOX_HIGH = 64 * 1024


# --------------------------------------------------------------- 工具


async def new_session(hub: Hub, name: str | None = None) -> str:
    return (await hub.create_session(name=name)).id


def attach_endpoint(hub: Hub, client_id: str, *, baseline: int = 0) -> Endpoint:
    hub.register_client(client_id)
    return make_endpoint(hub, client_id, baseline=baseline)


async def do_attach(endpoint: Endpoint, session_id: str, resume: int | None = None) -> None:
    await endpoint.hub.handle_message(endpoint.client_id, Attach(session=session_id, resume=resume))


def resized_events(endpoint: Endpoint) -> list[tuple[str, int, int]]:
    """该客户端收到的每一次尺寸变更：`(session, cols, rows)`，按到达顺序。

    顺带把控制消息窄化成 `Resized`——`control` 里存的是服务端消息的联合类型，直接取
    `.cols` 在类型上是错的（仓库既有测试遇到这种情况都用 `isinstance`）。写成一处，
    断言就只需比一个列表。
    """
    events: list[tuple[str, int, int]] = []
    for message in endpoint.control_of("resized"):
        assert isinstance(message, Resized)
        events.append((message.session, message.cols, message.rows))
    return events


def last_attached(endpoint: Endpoint) -> Attached:
    """该客户端最后一次订阅交付（同样做窄化）。"""
    message = endpoint.control_of("attached")[-1]
    assert isinstance(message, Attached)
    return message


def last_sessions(endpoint: Endpoint) -> Sessions:
    """该客户端最后一次收到的会话列表。"""
    message = endpoint.control_of("sessions")[-1]
    assert isinstance(message, Sessions)
    return message


def window_settings(**overrides: object) -> dict[str, object]:
    base: dict[str, object] = {
        "journal_budget_bytes": JOURNAL,
        "outbox_high_bytes": OUTBOX_HIGH,
        "attach_chunk_bytes": CHUNK,
        "push_ahead_bytes": WINDOW,
    }
    base.update(overrides)
    return base


async def prove_acking(hub: Hub, endpoint: Endpoint, session_id: str) -> None:
    """让该客户端"证明自己会 ack"——窗口只对证明过的客户端生效（`Client.ack_seen`）。

    这是所有顺序类用例的前置条件：**只有会 ack 的客户端才会被窗口挡住**，否则服务端
    会一直推到发不出去为止，构造不出"落后"这个状态。
    """
    await feed(hub, session_id, b"y" * (4 * CHUNK))
    endpoint.drain()
    record = client_of(hub, endpoint.client_id)
    await hub.handle_message(endpoint.client_id, Ack(offset=record.next_push_offset))
    assert record.ack_seen is True, "前置条件没建立：这个客户端还没证明会 ack"


async def ack_until_caught_up(hub: Hub, endpoint: Endpoint, session_id: str) -> None:
    """按窗口语义把日志补齐：每确认一次，服务端就能再推一个窗口。"""
    session = hub.get_session(session_id)
    for _ in range(64):
        endpoint.drain_until_quiet()
        if endpoint.next_offset >= session.journal.end_offset:
            return
        await hub.handle_message(endpoint.client_id, Ack(offset=endpoint.next_offset))
    raise AssertionError("ack 若干轮之后仍未补齐")


# --------------------------------------------------------------- 基本通路


async def test_resize_reaches_host_session_and_every_subscriber() -> None:
    """一次改尺寸要同时落到四处：宿主、会话字段、每个订阅者、以及会话列表广播。

    少任何一处都会表现成"界面说改了、实际没改"：
    - 宿主没改 ⇒ 子进程还按旧尺寸排版；
    - 会话字段没改 ⇒ 之后 `attached` 报出旧尺寸，新客户端按旧网格渲染；
    - 订阅者没收到 ⇒ 老客户端的网格与服务端不一致（多客户端尺寸分歧）；
    - 列表没广播 ⇒ 侧栏显示的是旧尺寸。
    """
    async with hub_context() as hub:
        sid = await new_session(hub)
        first = attach_endpoint(hub, "a")
        second = attach_endpoint(hub, "b")
        await do_attach(first, sid)
        await do_attach(second, sid)
        first.drain_until_quiet()
        second.drain_until_quiet()

        hub.resize_session(sid, 100, 30)

        session = hub.get_session(sid)
        assert (session.cols, session.rows) == (100, 30)
        assert host_of(hub, sid).resized == [(100, 30)], "尺寸必须真的改到宿主上"

        for endpoint in (first, second):
            endpoint.drain_until_quiet()
            assert resized_events(endpoint) == [(sid, 100, 30)]

        # 会话列表也跟着变（侧栏/接口读的是它）
        assert hub.session_infos()[0].cols == 100
        assert hub.session_infos()[0].rows == 30
        assert (last_sessions(first).items[0].cols, last_sessions(first).items[0].rows) == (100, 30)


async def test_resize_to_the_same_size_is_a_noop() -> None:
    """同尺寸不发消息、也不碰宿主——重复点"应用"不该白白引出宿主的整屏重绘。

    先做一次**真的**改尺寸并确认它到达（正向控制），再改回同一尺寸：否则"没有消息"
    这条否定断言在什么都不发生时也会绿。
    """
    async with hub_context() as hub:
        sid = await new_session(hub)
        endpoint = attach_endpoint(hub, "a")
        await do_attach(endpoint, sid)
        endpoint.drain_until_quiet()

        hub.resize_session(sid, 100, 30)
        endpoint.drain_until_quiet()
        assert endpoint.count("resized") == 1, "用例没构造出正向控制：真改尺寸应当到达"

        hub.resize_session(sid, 100, 30)
        endpoint.drain_until_quiet()
        assert endpoint.count("resized") == 1, "同尺寸不该再发一条"
        assert host_of(hub, sid).resized == [(100, 30)], "同尺寸不该再改一次宿主"


async def test_attach_after_a_resize_delivers_the_current_size() -> None:
    """改尺寸**之后**才订阅的客户端，从 `attached` 就拿新尺寸，不需要额外的 `resized`。

    这正是"尺寸是会话属性"的好处：新客户端没有旧尺寸可谈，`attached` 一个数就够了。
    """
    async with hub_context() as hub:
        sid = await new_session(hub)
        hub.resize_session(sid, 100, 30)

        late = attach_endpoint(hub, "late")
        await do_attach(late, sid)
        late.drain_until_quiet()

        attached = last_attached(late)
        assert (attached.cols, attached.rows) == (100, 30)
        assert late.count("resized") == 0, "新订阅者不该再收到一条多余的 resized"


async def test_resize_after_the_process_exited_is_still_applied() -> None:
    """进程退出后仍可改尺寸。

    会话与它的模型都还在（退出**不销毁**会话，内容与缓存照旧可订阅），所以改尺寸对
    后续接入的客户端仍然有意义。服务端因此不做额外限制——"能不能改"由界面决定
    （`exited` 的会话界面会禁用入口），少一处两套规则。
    """
    async with hub_context() as hub:
        sid = await new_session(hub)
        endpoint = attach_endpoint(hub, "a")
        await do_attach(endpoint, sid)
        endpoint.drain_until_quiet()

        host_of(hub, sid).exit(0)
        await turn()
        endpoint.drain_until_quiet()

        hub.resize_session(sid, 90, 25)
        endpoint.drain_until_quiet()
        assert [cols for _session, cols, _rows in resized_events(endpoint)] == [90]


# --------------------------------------------------------------- 顺序（这条是重点）


async def test_resized_waits_until_the_client_crossed_the_announce_offset() -> None:
    """`resized` 必须排在**该客户端按旧尺寸产生的全部字节**之后下发。

    构造：让客户端证明会 ack（于是推送窗口生效），再灌入远超一个窗口的内容且不回 ack——
    服务端推到窗口就停手，该客户端的游标确定性地落在日志末尾之前。此时改尺寸，断言：

    1. 在它把日志补齐之前，`resized` **不能**到——否则它会先改尺寸、再收到按旧尺寸
       产生的字节；
    2. 补齐之后它到达时，游标确实已经越过登记点。
    """
    base = window_settings()
    async with hub_context(**base) as hub:
        sid = await new_session(hub)
        endpoint = attach_endpoint(hub, "a")
        await do_attach(endpoint, sid)
        endpoint.drain_until_quiet()
        await prove_acking(hub, endpoint, sid)

        await feed(hub, sid, b"X" * 200_000)
        session = hub.get_session(sid)
        announce = session.journal.end_offset
        endpoint.drain()
        assert endpoint.next_offset < announce, "用例没构造出压力：客户端应当被窗口挡在后面"

        hub.resize_session(sid, 100, 30)
        endpoint.drain()
        assert endpoint.count("resized") == 0, "游标还没到变更点，尺寸变更不该先到"

        await ack_until_caught_up(hub, endpoint, sid)
        assert endpoint.next_offset == announce
        assert endpoint.offset_when("resized") >= announce, "顺序错了：变更先于旧尺寸的字节到达"
        assert [cols for _session, cols, _rows in resized_events(endpoint)] == [100]


async def test_every_size_change_is_delivered_when_the_client_is_behind() -> None:
    """落后期间连改两次尺寸：**两条都要到**，且各自排在其登记点之后。

    只保留最后一次（"反正客户端最终要收敛到最新尺寸"）会让它在中途用**更新**的尺寸去
    解释一批按**更旧**尺寸产生的字节。这条用例钉的就是那个洞。
    """
    base = window_settings()
    async with hub_context(**base) as hub:
        sid = await new_session(hub)
        endpoint = attach_endpoint(hub, "a")
        await do_attach(endpoint, sid)
        endpoint.drain_until_quiet()
        await prove_acking(hub, endpoint, sid)

        await feed(hub, sid, b"Y" * 120_000)
        session = hub.get_session(sid)
        first_announce = session.journal.end_offset
        endpoint.drain()
        assert endpoint.next_offset < first_announce, "用例没构造出压力"

        hub.resize_session(sid, 100, 30)

        await feed(hub, sid, b"Z" * 120_000)
        second_announce = session.journal.end_offset
        hub.resize_session(sid, 60, 20)

        await ack_until_caught_up(hub, endpoint, sid)
        assert endpoint.next_offset == second_announce
        assert [cols for _session, cols, _rows in resized_events(endpoint)] == [100, 60]
        positions = [offset for name, offset in endpoint.order if name == "resized"]
        assert positions[0] >= first_announce
        assert positions[1] >= second_announce
        assert positions[0] <= positions[1]


async def test_resize_adds_no_bytes_of_its_own() -> None:
    """改尺寸**不产生**任何输出字节：它是控制面的事，不是内容。

    这条看着多余，其实是在钉一个设计选择：宿主的 PTY 在真实 Windows 上会因此吐出一段
    整屏重绘（`docs/resize-plan.md` §3.1），而那段字节是**普通输出**，将来要是有谁想
    在服务端"顺手补齐重绘字节"，这里就会红——提醒他先回去看那份文档里的决策。
    """
    async with hub_context() as hub:
        sid = await new_session(hub)
        endpoint = attach_endpoint(hub, "a")
        await do_attach(endpoint, sid)
        endpoint.drain_until_quiet()

        before = hub.get_session(sid).journal.end_offset
        hub.resize_session(sid, 100, 30)
        endpoint.drain_until_quiet()
        assert hub.get_session(sid).journal.end_offset == before
        assert endpoint.stream == b""


# --------------------------------------------------------------- 错误路径


async def test_resize_of_a_missing_session_reports_not_found() -> None:
    """会话不存在时抛 `SessionNotFound`；经消息入口则变成一条 `Failure`（WS 路径）。"""
    async with hub_context() as hub:
        with pytest.raises(SessionNotFound):
            hub.resize_session("nope", 100, 30)

        endpoint = attach_endpoint(hub, "a")
        request = SessionResize(session="nope", cols=100, rows=30)
        await hub.handle_message(endpoint.client_id, request)
        endpoint.drain_until_quiet()
        failure = endpoint.last_control()
        assert failure.t == "error"
        assert failure.code == "session_not_found"
        assert "pywezterm" not in failure.message and "/" not in failure.message
