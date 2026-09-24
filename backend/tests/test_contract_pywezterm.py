"""真实 pywezterm 宿主的**环境契约测试**。

整套单测都跑在 `FakeHost` 上，因此它们证明的是「协议与同步逻辑自洽」，**不能**证明
「真实 PTY + 终端模型接上之后这套东西还成立」。这个文件补的就是那一层：

- 真实 `Pty` 能 spawn 子进程、读到输出，子进程能正常退出并给出退出码
- 终端模型确实被喂到了同一份字节（`text()` 里看得到子进程的输出）
- 输出经 Hub 的日志与补流落到客户端，且与「从头就在的客户端」逐字节一致
- 进程退出**不销毁会话**，退出后接入的新客户端依然能拿到退出前的全部内容
- 适配器产出的快照（唯一有损路径的产物）是**可直接喂给终端**的字节流
- 模型与日志同源（`fed_offset == journal.end_offset`），因此裁剪后的重建既没有撕裂空洞、
  也不与后续补发的字节重叠（`docs/audit.md` A2 的两条回归不变量）

按约定，`contract` 用例默认不跑（真实 ConPTY 子进程比 fake 宿主慢两个数量级，且依赖
本地安装的原生扩展）；用 `pytest -m contract` 或 `TERMINALD_CONTRACT=1` 显式启用。
"""

from __future__ import annotations

import asyncio
import os
import re
import sys
import time

import pytest

from support import Endpoint, make_endpoint, make_settings
from terminald.protocol.messages import Attach, Attached, SessionStatus
from terminald.runtime import make_host_factory
from terminald.service.hub import Hub

#: 子进程输出里用作同步点的标记
MARKER = "TERMD_CONTRACT_OK"

#: 采集超时：真实 ConPTY 启动 + 退出通常 < 2s，留足余量
_TIMEOUT = 30.0


def _pywezterm_available() -> bool:
    try:
        import pywezterm  # noqa: F401
    except ImportError:
        return False
    return True


pytestmark = [
    pytest.mark.contract,
    pytest.mark.skipif(not _pywezterm_available(), reason="未安装 pywezterm 本地 wheel"),
]


def _shell_argv(command: str) -> list[str]:
    """跨平台「跑一条命令然后退出」的 argv。"""
    if os.name == "posix":
        return ["/bin/sh", "-c", command]
    return [os.environ.get("COMSPEC", "cmd.exe"), "/c", command]


def _make_hub(command: str) -> Hub:
    settings = make_settings(host_impl="pywezterm", shell=_shell_argv(command))
    return Hub(settings, make_host_factory("pywezterm"))


#: 洪水输出：每行带唯一行号，用来把「内容位置」变成可比较的数字
_FLOOD_LINE = re.compile(rb"N(\d{5})")
_FLOOD_CODE = (
    "import sys\n"
    "w = sys.stdout.write\n"
    "for i in range(1, 40001):\n"
    "    w('N%05d-abcdefghijklmnopqrst\\r\\n' % i)\n"
)


def _make_flood_hub() -> Hub:
    """小日志预算 + 长输出：逼出「日志被裁剪后重建」这条唯一的有损路径。"""
    settings = make_settings(
        host_impl="pywezterm",
        shell=[sys.executable, "-c", _FLOOD_CODE],
        journal_budget_bytes=64 * 1024,
        outbox_high_bytes=8 * 1024 * 1024,
        attach_chunk_bytes=64 * 1024,
    )
    return Hub(settings, make_host_factory("pywezterm"))


async def _attach(hub: Hub, session_id: str, client_id: str) -> Endpoint:
    hub.register_client(client_id)
    endpoint = make_endpoint(hub, client_id)
    await hub.handle_message(client_id, Attach(session=session_id))
    return endpoint


async def _drive_until_exit(hub: Hub, session_id: str, endpoint: Endpoint) -> None:
    """反复排空，直到会话退出**且**没有剩余待发负载。"""
    deadline = time.monotonic() + _TIMEOUT
    while time.monotonic() < deadline:
        endpoint.drain_until_quiet(rounds=32)
        session = hub.get_session(session_id)
        if session.status is SessionStatus.EXITED and not hub.has_output(endpoint.client_id):
            endpoint.drain_until_quiet(rounds=32)
            return
        await asyncio.sleep(0.02)
    raise AssertionError(f"会话在 {_TIMEOUT}s 内没有结束")


async def test_real_pty_output_reaches_client_and_model() -> None:
    """真实 PTY 的输出原样到达客户端，并且同一份字节喂进了终端模型。"""
    hub = _make_hub(f"echo {MARKER}")
    try:
        info = await hub.create_session()
        assert info.pid is not None, "真实宿主必须给出子进程 pid"

        endpoint = await _attach(hub, info.id, "c1")
        await _drive_until_exit(hub, info.id, endpoint)
        text = bytes(endpoint.stream).decode("utf-8", "replace")
        assert MARKER in text, text[-400:]

        attached = endpoint.control_of("attached")[0]
        assert isinstance(attached, Attached)
        assert attached.resumed is True, "日志从 0 起完整，应当无损重放而不是模型重建"
        assert (attached.cols, attached.rows) == (80, 24)

        # 模型是否也被喂到了：`snapshot()` 是模型自身状态序列化的产物，
        # 里面出现标记即说明喂进去了（端口只暴露 snapshot，不暴露 text）。
        session = hub.get_session(info.id)
        assert session.host is not None
        assert MARKER.encode() in session.host.snapshot(), "终端模型必须与字节流同源"
    finally:
        await hub.stop()


async def test_exit_keeps_session_and_content_readable() -> None:
    """进程退出不销毁会话：退出码上报、内容保留，退出后接入的客户端仍能拿全。"""
    hub = _make_hub(f"echo {MARKER}")
    try:
        info = await hub.create_session()
        first = await _attach(hub, info.id, "c1")
        await _drive_until_exit(hub, info.id, first)

        session = hub.get_session(info.id)
        assert session.status is SessionStatus.EXITED
        assert session.exit_code == 0, session.exit_code
        assert session.journal.end_offset > 0

        # 退出之后接入的全新客户端：仍应从 0 整段重放，而不是空
        second = await _attach(hub, info.id, "c2")
        await _drive_until_exit(hub, info.id, second)

        assert bytes(second.stream) == bytes(first.stream)
        assert second.next_offset == first.next_offset == session.journal.end_offset
        assert MARKER in bytes(second.stream).decode("utf-8", "replace")
    finally:
        await hub.stop()


async def test_real_snapshot_agrees_with_the_byte_stream() -> None:
    """真实宿主产出的快照必须与「字节真源」重建出同样的可见文本。

    重建的**决策**（何时该重建）由 test_sync.py / test_hub.py 覆盖——那是纯逻辑。
    这里验证真实适配器「把模型序列化成字节流」这件事本身没坏。判据刻意选成**两条
    独立路径互相印证**：

    - 路径 A：把 `snapshot()`（模型序列化，唯一有损路径）喂进一个新终端
    - 路径 B：把客户端收到的原始字节流（内容真源）喂进另一个新终端

    两者可见文本不一致，就说明快照这条路径丢了东西——这正是它唯一可能的失效方式。
    """
    # 必须在这里导入：模块级导入会在 skipif 生效之前就抛 ImportError，变成收集错误。
    import pywezterm

    hub = _make_hub(f"echo {MARKER}")
    try:
        info = await hub.create_session()
        endpoint = await _attach(hub, info.id, "c1")
        await _drive_until_exit(hub, info.id, endpoint)

        session = hub.get_session(info.id)
        assert session.host is not None
        snapshot = session.host.snapshot()
        assert snapshot.startswith(b"\x1bc"), snapshot[:32]

        by_snapshot = pywezterm.Terminal(80, 24, 1000)
        by_snapshot.feed(snapshot)
        by_stream = pywezterm.Terminal(80, 24, 1000)
        by_stream.feed(bytes(endpoint.stream))

        assert MARKER in by_stream.text()
        assert by_snapshot.text().rstrip() == by_stream.text().rstrip(), (
            f"快照路径与字节真源不一致:\nsnapshot={by_snapshot.text()!r}\nstream={by_stream.text()!r}"
        )
    finally:
        await hub.stop()


def _host(argv: list[str]) -> object:
    """直接构造真实宿主（不走 Hub），用于验证适配层自己的行为。"""
    from terminald.core.ports import SessionSpec
    from terminald.runtime.pywezterm_host import PyweztermHost

    return PyweztermHost(SessionSpec(argv=argv, cols=80, rows=24, scrollback=100))


def test_placeholder_title_is_reported_as_absent() -> None:
    """库的占位标题不能被当成真标题上报。

    终端模型把窗口标题初始化成一个固定占位串；如果原样上报，每个还没设过标题的会话
    在侧栏/标签页里都会显示成同一个词（真实 UI 探针里就是这样露出来的）。
    """
    import sys

    host = _host([sys.executable, "-c", "pass"])
    try:
        assert host.metadata().title is None  # type: ignore[attr-defined]
    finally:
        host.close()  # type: ignore[attr-defined]


def test_conpty_normalises_title_and_the_first_change_is_dropped() -> None:
    """Windows/ConPTY 下的标题行为要被钉住，因为它反直觉。

    实测（见下面的 raw 断言）：子进程写的是 OSC 2，到达模型时已经被 ConPTY 规范化成
    **OSC 0**；而适配层构造时调用了 `enable_conpty_quirks()`，它会抑制**第一个** OSC 0
    （本意是吞掉 ConPTY 自动发出的 shell 路径）。两者叠加的结果是：
    **应用在启动时设的那一次标题会丢**，第二次才生效。

    所以「启动时设一次标题」的 shell 在 Windows 上拿不到标题。这是已知行为，
    用测试固定下来，免得将来改绑定层时无声地变了。
    """
    import sys
    import time

    code = (
        "import sys, time; out=sys.stdout;"
        " out.write('\x1b]2;FIRST\x07'); out.flush(); time.sleep(0.3);"
        " out.write('\x1b]2;SECOND\x07'); out.flush(); time.sleep(0.3)"
    )
    host = _host([sys.executable, "-c", code])
    try:
        seen = bytearray()
        deadline = time.monotonic() + 15.0
        while time.monotonic() < deadline:
            data = host.read(8192, 0.2)  # type: ignore[attr-defined]
            if data:
                seen.extend(data)
                host.ingest(data)  # type: ignore[attr-defined]
            if host.try_wait() is not None and not data:  # type: ignore[attr-defined]
                break
        raw = bytes(seen)
        # 归一化证据：我们写的是 OSC 2，到达的是 OSC 0
        # （断言里写成转义而不是把 ESC/BEL 字节直接嵌进源码：后者在编辑器里看不见，
        #   任何文本处理都可能把它弄丢，而那样这条断言会变成“永久为真”的假绿）
        assert b"\x1b]0;FIRST\x07" in raw, raw
        assert b"\x1b]0;SECOND\x07" in raw, raw
        # 第一个被吞、第二个生效
        assert host.metadata().title == "SECOND"  # type: ignore[attr-defined]
    finally:
        host.close()  # type: ignore[attr-defined]


# ============================================================ 模型与日志同源（A2 回归）


async def test_model_and_journal_stay_aligned_under_flood() -> None:
    """模型与日志必须同源：`fed_offset == journal.end_offset` 在任何时刻都成立。

    这是重建路径正确性的全部依据：快照渲染的是模型状态，而客户端被对齐到日志偏移；
    两个数字一旦不相等，快照就会与对齐点错位（`docs/audit.md` A2）。
    """
    hub = _make_flood_hub()
    try:
        info = await hub.create_session()
        endpoint = await _attach(hub, info.id, "c1")
        session = hub.get_session(info.id)
        assert session.host is not None

        deadline = time.monotonic() + _TIMEOUT
        while time.monotonic() < deadline and session.journal.trimmed_bytes == 0:
            endpoint.drain_until_quiet(rounds=8)
            assert session.host.fed_offset == session.journal.end_offset, (
                f"模型超前日志 {session.host.fed_offset - session.journal.end_offset} 字节"
            )
            await asyncio.sleep(0.005)

        assert session.journal.trimmed_bytes > 0, "没能触发日志裁剪，用例无效"
        assert session.host.fed_offset == session.journal.end_offset
    finally:
        await (
            hub.stop()
        )  # ============================================================ 输入方向（A10 回归）


#: 子进程：把收到的 N 字节算成 sha256 打回来。
#:
#: 只收 ASCII 可打印字符 + CRLF：控制台输入是 UTF-16 内部表示，非 ASCII 字节会经过
#: 码页转换，而那是**控制台语义**而不是我们的搬运是否忠实。
_ECHO_HASH_CODE = (
    "import hashlib, sys\n"
    "data = sys.stdin.buffer.read({size})\n"
    "print('HASH %s %d' % (hashlib.sha256(data).hexdigest(), len(data)), flush=True)\n"
)


def _payload(lines: int) -> bytes:
    return b"".join(b"line%04d-payload\r\n" % index for index in range(lines))


async def test_input_reaches_the_child_byte_identical() -> None:
    """输入方向的端到端不变量：客户端发出的字节**原样**到达子进程（内容真源）。

    多客户端、背压、日志与补流都建立在「字节不丢、不改」上；这一条把它钉在真实
    ConPTY 上：子进程自己算 sha256，与客户端构造的字节比对。

    A10 的战术（暂缓/放行/硬上限）由 `test_input_backpressure.py` 覆盖，这里只验证
    **搬运本身不失真**——即上面那些机制不是为了掩盖一条本来就丢字节的通路。
    """
    payload = _payload(2048)  # ≈ 38 KiB：够跨多次 PTY 读/写，又不至于让用例变慢
    settings = make_settings(
        host_impl="pywezterm",
        shell=[sys.executable, "-c", _ECHO_HASH_CODE.format(size=len(payload))],
    )
    hub = Hub(settings, make_host_factory("pywezterm"))
    try:
        info = await hub.create_session()
        endpoint = await _attach(hub, info.id, "c1")
        for start in range(0, len(payload), 4096):
            hub.handle_input("c1", payload[start : start + 4096])

        deadline = time.monotonic() + _TIMEOUT
        found: re.Match[bytes] | None = None
        while time.monotonic() < deadline and found is None:
            endpoint.drain_until_quiet(rounds=8)
            found = re.search(rb"HASH ([0-9a-f]{64}) (\d+)", bytes(endpoint.stream))
            await asyncio.sleep(0.05)
        assert found is not None, "子进程没有回传哈希（输入没到达或没读完）"

        import hashlib

        assert found.group(1).decode() == hashlib.sha256(payload).hexdigest(), (
            f"子进程收到的 {int(found.group(2))} 字节与客户端发出的 {len(payload)} 字节不一致"
        )
    finally:
        await hub.stop()


# ============================================================ 拆除路径（A13 回归）

#: 让控制台被一个「直接子进程已退出、孙子进程还握着」的进程树占住的形态。
#:
#: 必须是这个形态才复现得出来：`cmd /c start /b <控制台程序>` 让 cmd 立刻退出，
#: 孙进程（`ping`）继续附着在 ConPTY 的控制台上。实测（`docs/audit.md` A13）：
#: 这种形态下不做树终止时 `Pty.close()` 会等 **298 秒**；把孙进程改成「活着的父进程
#: 用 `subprocess.Popen` 起」反倒不阻塞（实测 6 毫秒）——所以回归测试必须用前者。
#: 用 `-n 20` 而不是 `-t`：万一树没被终止，它也会自己退出，不留孤儿进程。
_HOLD_CONSOLE_ARGV: list[str] = [
    os.environ.get("COMSPEC", "cmd.exe"),
    "/c",
    "start",
    "/b",
    "ping",
    "-n",
    "20",
    "127.0.0.1",
]


@pytest.mark.skipif(os.name != "nt", reason="ConPTY 的等待链是 Windows 行为")
async def test_closing_a_session_kills_the_tree_and_stays_bounded() -> None:
    """A13 回归（真实 ConPTY）：拆除会话必须**有界**，且整棵进程树被终止。

    机制：`Pty.close()` 内部的 `ClosePseudoConsole` 会等控制台客户端退出，而绑定层的
    `close()` **持着 GIL 阻塞**——把它挪到线程毫无用处。实测控制台被孙子进程握着时
    `close()` 阻塞 236–298 秒，**同一时刻主线程的调度间隔也是那么长**，于是整个服务
    （所有会话、所有客户端、全部 HTTP 接口）一起停摆。

    修法：关闭前先用 Job Object 终止整棵树（`runtime/winjob.py`）。两条断言各自对应
    修法的一个环节，任一条红都说明修法失效：

    1. `close_session` 有界——树没被杀掉时它要等 ping 退出（20 秒级）；
    2. 全程事件循环**没被饿死**（GIL 没被持住）——这条才是用户看到的「服务冻住」。
    """
    settings = make_settings(host_impl="pywezterm", shell=_HOLD_CONSOLE_ARGV)
    hub = Hub(settings, make_host_factory("pywezterm"))
    lags: list[float] = []

    async def monitor() -> None:
        while True:
            started_at = time.perf_counter()
            await asyncio.sleep(0.01)
            lags.append(time.perf_counter() - started_at - 0.01)

    try:
        info = await hub.create_session()
        await _attach(hub, info.id, "c1")
        await asyncio.sleep(1.5)  # 让孙进程真正附着到控制台上

        watcher = asyncio.create_task(monitor())
        started_at = time.perf_counter()
        await asyncio.wait_for(hub.close_session(info.id), timeout=_TIMEOUT)
        elapsed = time.perf_counter() - started_at
        watcher.cancel()

        assert hub.session_infos() == ()
        assert elapsed < 5.0, f"拆除用了 {elapsed:.1f}s：进程树没被整体终止，close() 又等上控制了"
        assert max(lags) < 0.5, f"拆除期间事件循环被饿死 {max(lags):.1f}s（= 服务停摆）"
    finally:
        await hub.stop()


async def test_rebuild_after_trim_has_no_hole_and_no_overlap() -> None:
    """裁剪后的重建：快照不得有撕裂空洞，补发字节不得与快照重叠。

    三条断言：

    1. 对齐点与快照同源（`attached.offset == fed_offset == journal.end_offset`）；
    2. 快照里的行号**连续**——撕裂读会在滚动区与可见区之间留下空洞（或重复），
       于是行号出现断档；
    3. 快照与随后补发的原始字节**没有相同行号**（同一内容不得被应用两次），
       并且「快照 + 补发字节」重建出的画面与「从头就在的客户端」看到的一致。
    """
    import pywezterm

    hub = _make_flood_hub()
    try:
        info = await hub.create_session()
        a = await _attach(hub, info.id, "c1")  # 从头就在：收到的是内容真源
        session = hub.get_session(info.id)
        assert session.host is not None

        deadline = time.monotonic() + _TIMEOUT
        while time.monotonic() < deadline and session.journal.trimmed_bytes == 0:
            a.drain_until_quiet(rounds=8)
            await asyncio.sleep(0.005)
        assert session.journal.trimmed_bytes > 0, "没能触发日志裁剪，用例无效"

        # 输出仍在进行时接入全新客户端 → 必然走重建路径
        b = await _attach(hub, info.id, "c2")
        b.drain_until_quiet(rounds=32)
        attached = b.control_of("attached")[0]
        assert isinstance(attached, Attached)
        assert attached.resumed is False
        # 对齐点 = 重建路径的干净边界（这份输出的末尾是普通文本，所以它就等于日志末尾）：
        # 快照渲染的是 fed_offset 处的模型，而 fed_offset 与日志同源。
        assert attached.offset == session.journal.replay_offset() <= session.journal.end_offset
        assert session.journal.end_offset == session.host.fed_offset

        snap = bytes(b.snapshots[0])
        markers = [int(m) for m in _FLOOD_LINE.findall(snap)]
        assert len(markers) > 100, f"快照里只有 {len(markers)} 行，构不成有效样本"
        assert markers == list(range(markers[0], markers[0] + len(markers))), (
            "快照不连续：滚动区与可见区之间存在撕裂空洞或重复"
        )

        # 一直读到会话结束（两边都要排空，否则慢的一边会在水位上被暂停）
        deadline = time.monotonic() + _TIMEOUT
        while time.monotonic() < deadline:
            a.drain_until_quiet(rounds=32)
            b.drain_until_quiet(rounds=32)
            if session.status is SessionStatus.EXITED and not hub.has_output("c2"):
                a.drain_until_quiet(rounds=32)
                b.drain_until_quiet(rounds=32)
                break
            await asyncio.sleep(0.02)
        else:
            raise AssertionError(f"会话在 {_TIMEOUT}s 内没有结束")

        stream = bytes(b.stream)
        stream_markers = {int(m) for m in _FLOOD_LINE.findall(stream)}
        overlap = stream_markers & set(markers)
        assert not overlap, f"快照与补发字节重叠了 {len(overlap)} 行：重建路径重复应用输出"

        # 两条独立路径必须重建出同一画面
        by_bytes = pywezterm.Terminal(80, 24, 1000)
        by_bytes.feed(bytes(a.stream))
        by_rebuild = pywezterm.Terminal(80, 24, 1000)
        by_rebuild.feed(snap)
        by_rebuild.feed(stream)
        assert by_rebuild.text().rstrip() == by_bytes.text().rstrip(), (
            f"重建画面与字节真源不一致:\nrebuild={by_rebuild.text()!r}\nbytes={by_bytes.text()!r}"
        )
    finally:
        await hub.stop()
