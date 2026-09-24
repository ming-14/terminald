"""Hub —— 传输无关的应用服务。

把三件事缝在一起：core 的领域对象、runtime 的线程、protocol 的帧。
它不 import fastapi，也不 await 网络，因此测试里可以直接驱动并断言产出的帧。

## 流控分两个方向，共用同一条原则：拥塞只暂停，绝不丢字节

**输出方向**（服务端 → 客户端）：按客户端游标补齐。

每个客户端持有 `next_push_offset`——**它下一个需要收到的字节偏移**。有新输出时，
服务端对每个订阅者从该游标往日志末尾补齐（受发送队列水位限制），补到哪就把游标推进到哪。

好处是决定性的：**拥塞只会让推送暂停，绝不会丢字节**——没推的部分一直躺在日志里，
队列排空后从游标继续补。因此客户端之间不可能出现“有人悄悄缺了一段”。这正是
tmux control mode 的 `struct client_offset{offset, queued}` 模型。

`Behind` 因此只在一个条件下发出：**客户端游标落后到日志已经裁剪掉的位置**。
此时它必须重同步，没有别的办法。

**输入方向**（客户端 → PTY）：按写队列水位暂缓发送方。

写队列按字节计量（`SessionRunner.submit_input`）。超过高水位就给那个客户端下发
`InputHold(paused=true)`，它在**本端**按序排队；写队列回落到低水位后由写线程回调
`_release_input` 放行（`InputHold(paused=false)`），客户端原序补发。越到硬上限说明
它无视了暂缓——那是协议违例，由传输层显式断开（见 `api/ws.py`）。

这一方向刻意**不**用“停读接收循环”那种内核背压：停读会把同一条连接上的控制面
（detach、关会话、焦点上报）一起堵住，而且对端在暂停期间断开时服务端无从察觉
（ASGI 只把 disconnect 放进队列，不会取消应用任务）。让发送方停下来两者都不会发生，
而且字节仍是一个不丢——它们只是排在了产生输入的那一端。

## 原子性从哪来

所有会话状态（含**终端模型**）只在事件循环线程上改动；订阅、补流、对齐点登记都在
**同一个没有 await 的临界区**内完成，因此既不存在“补流期间又插进来一段输出”的窗口，
也不存在“快照渲染到一半模型又变了”的窗口。

并发正确性靠「单线程所有者 + 唯一写者」而不是加锁：

- 终端模型由事件循环独占（`host.ingest` 与 `journal.append` 相邻执行，见 `_ingest_output`）；
- PTY 由写线程独占（客户端输入与宿主应答统一经 `_submit_write`），详见 `core/ports.py`
  的线程归属表；两者都是重建路径正确性的前提（`docs/audit.md` A1/A2）。
"""

from __future__ import annotations

import asyncio
import contextlib
import time
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Final

from ..config import Settings
from ..core import (
    Client,
    HostFactory,
    Outbound,
    Outbox,
    Registry,
    Resume,
    Session,
    TerminaldError,
    plan_attach,
)
from ..core.errors import SessionNotFound
from ..logs import get_logger
from ..protocol import frames
from ..protocol.messages import (
    Ack,
    Attach,
    Attached,
    Behind,
    ClientMessage,
    Detach,
    Exited,
    Failure,
    Focus,
    Hello,
    InputHold,
    Meta,
    Resync,
    ServerMessage,
    SessionClose,
    SessionCreate,
    SessionInfo,
    SessionList,
    SessionRename,
    Sessions,
    SessionStatus,
    dump_bytes,
)
from ..runtime.bridge import BridgeClosed, ThreadBridge
from ..runtime.runner import (
    InputVerdict,
    OutputChunk,
    ProcessExited,
    ReaderEvent,
    SessionRunner,
)

_log = get_logger(__name__)

# 读线程 → 事件循环的队列深度（单位是“块”，每块 ≤ 8KB）。
# 取小值让背压更快传导到 PTY：宁可让应用写阻塞，也不让服务端无限缓冲。
_BRIDGE_MAXSIZE: Final = 256
_PUMP_MAX_BYTES: Final = 8192
_PUMP_TIMEOUT: Final = 0.2
# 元数据轮询节流（秒）：避免每个输出块都去读一次终端模型
_META_POLL_INTERVAL: Final = 0.25


@dataclass(frozen=True, slots=True)
class _Detached:
    """被摘除会话的拆除凭据：之后在线程里释放它们。"""

    session: Session | None
    runner: SessionRunner | None


REASON_TRIMMED: Final = "trimmed"


class Hub:
    """会话与客户端的编排者。"""

    def __init__(self, settings: Settings, host_factory: HostFactory) -> None:
        self._settings = settings
        self._registry = Registry(
            host_factory,
            journal_budget_bytes=settings.journal_budget_bytes,
            default_cols=settings.cols,
            default_rows=settings.rows,
            default_scrollback=settings.scrollback,
            default_argv=settings.shell,
            default_cwd=settings.cwd,
        )
        self._clients: dict[str, Client] = {}
        self._runners: dict[str, SessionRunner] = {}
        self._bridges: dict[str, ThreadBridge[ReaderEvent]] = {}
        self._pumps: dict[str, asyncio.Task[None]] = {}
        self._meta_polled_at: dict[str, float] = {}
        self._stopped = False

    # ============================================================ 生命周期

    async def stop(self) -> None:
        """停止全部会话与客户端（幂等）。"""
        if self._stopped:
            return
        self._stopped = True
        for session_id in list(self._runners):
            detached = self._detach_session(session_id)
            await self._release_session(detached)
        for task in list(self._pumps.values()):
            task.cancel()
        self._pumps.clear()
        for client in self._clients.values():
            client.closed = True
        self._clients.clear()
        # 兜底：销毁没有 runner 的残留会话（例如 `_start_session` 抛错留下的那些）。
        # 阻塞释放同样只在事件循环之外做（见 `_release_session`）。
        await asyncio.to_thread(self._registry.close_all)

    # ============================================================ 客户端

    def register_client(self, client_id: str, label: str = "") -> Client:
        """登记一条连接。由传输层在握手后调用。"""
        client = Client(
            id=client_id,
            label=label,
            outbox=Outbox(self._settings.outbox_high_bytes),
        )
        self._clients[client_id] = client
        return client

    def drop_client(self, client_id: str) -> None:
        """连接断开：解除订阅（**会话本身不受影响**）。"""
        client = self._clients.pop(client_id, None)
        if client is None:
            return
        client.closed = True
        session = self._session_of(client)
        if session is not None:
            before = session.focused
            session.detach(client_id)
            if before != session.focused:
                self._apply_focus(session)
        client.wakeup.set()

    def take_output(self, client_id: str) -> tuple[Outbound, ...]:
        """取走该客户端待发负载（传输层排空 outbox 用）。"""
        client = self._clients.get(client_id)
        return client.outbox.drain() if client is not None else ()

    async def wait_output(self, client_id: str) -> bool:
        """等待该客户端有可发字节（传输层发送循环用）。

        返回 False 表示**该客户端已消失**，发送循环应当退出。这个返回值不是可有可无的
        装饰：少了它，发送循环会在客户端被移除后变成空转（每次 sleep(0) 拿不到数据）。
        """
        client = self._clients.get(client_id)
        if client is None or client.closed:
            return False
        if self.has_output(client_id):
            return True
        client.wakeup.clear()
        # 清标志后再查一次，避免丢唤醒（`clear` 与 `put` 之间可能已经置位）
        if self.has_output(client_id):
            return True
        await client.wakeup.wait()
        return client_id in self._clients

    def on_drained(self, client_id: str) -> None:
        """传输层排空 outbox 后回调。

        补流可能因为水位上限而中途停下；排空后必须再推一轮，否则“输出恰好停止”与
        “队列恰好满”同时发生时，剩余的字节会一直躺在日志里没人送。
        """
        client = self._clients.get(client_id)
        if client is None or client.closed:
            return
        session = self._session_of(client)
        if session is not None:
            self._push_client(session, client)

    def has_output(self, client_id: str) -> bool:
        """该客户端当前是否有待发字节（传输层用）。"""
        client = self._clients.get(client_id)
        return client is not None and client.outbox.pending_bytes > 0

    # ============================================================ 消息入口

    async def handle_message(self, client_id: str, message: ClientMessage) -> None:
        """处理一条客户端控制消息。"""

        client = self._clients.get(client_id)
        if client is None or client.closed:
            return
        try:
            match message:
                case Hello():
                    return  # 握手在传输层完成
                case Attach():
                    self._on_attach(client, message)
                case Detach():
                    self._on_detach(client)
                case Resync():
                    self._on_resync(client, message)
                case Ack():
                    self._on_ack(client, message)
                case Focus():
                    self._on_focus(client, message)
                case SessionList():
                    self._send(client, Sessions(items=self.session_infos()))
                case SessionCreate():
                    await self._on_session_create(client, message)
                case SessionClose():
                    await self._on_session_close(client, message)
                case SessionRename():
                    self._on_session_rename(client, message)
        except TerminaldError as exc:
            self._fail(client, type(exc).__name__, str(exc))

    def handle_input(self, client_id: str, data: bytes) -> InputVerdict:
        """处理 INPUT 二进制帧（客户端已编码好的键盘/粘贴字节）。

        字节不直接写 PTY，而是交给该会话的**写线程**（唯一写者）：`Pty.write` 会在
        PTY 缓冲写满时阻塞，放在事件循环上会让整个进程停摆（A1）。

        返回值是该次入队的背压判定，由传输层决定是否断开连接：

        - `ACCEPTED`：继续接收；
        - `HOLD`：已下发 `InputHold(paused=true)`（**只发一次**，不随每一帧重复）；
        - `OVERFLOW`：发送方无视了暂缓，应当显式断开。
        """
        client = self._clients.get(client_id)
        if client is None or client.closed:
            return InputVerdict.ACCEPTED
        session = self._session_of(client)
        if session is None:
            # 未订阅时的输入无处可去（没有会话就没有 PTY）；这不是错误，也不产生背压
            return InputVerdict.ACCEPTED
        runner = self._runners.get(session.id)
        if runner is None:
            return InputVerdict.ACCEPTED
        verdict = runner.submit_input(data)
        if verdict is InputVerdict.HOLD and not client.input_held:
            client.input_held = True
            self._send(client, InputHold(session=session.id, paused=True))
        return verdict

    # ============================================================ 查询

    @property
    def settings(self) -> Settings:
        """生效配置（只读；测试与运维接口需要读取而不重算）。"""
        return self._settings

    def session_infos(self) -> tuple[SessionInfo, ...]:
        return tuple(session.info() for session in self._registry.list())

    def get_session(self, session_id: str) -> Session:
        """取会话；不存在则抛 `SessionNotFound`。"""
        return self._registry.get(session_id)

    def find_session(self, session_id: str) -> Session | None:
        """取会话；不存在返回 None（用于“是否还在”的判断）。"""
        return self._registry.find(session_id)

    def client_count(self) -> int:
        return len(self._clients)

    # ============================================================ 会话操作

    async def create_session(
        self,
        *,
        name: str | None = None,
        argv: Sequence[str] | None = None,
        cwd: str | None = None,
        attach_client: Client | None = None,
    ) -> SessionInfo:
        # openpty/spawn 是阻塞调用：不能压在事件循环上
        session = await asyncio.to_thread(self._registry.create, name=name, argv=argv, cwd=cwd)
        self._start_session(session)
        self._publish_sessions()
        if attach_client is not None and not attach_client.closed:
            self._attach(attach_client, session, resume=None)
        return session.info()

    async def close_session(self, session_id: str) -> None:
        """显式关闭会话。

        `Registry.close` 是幂等的资源释放原语（拆除路径可能被重复走到），但**应用层
        的关闭操作**必须能区分“关掉了”和“本来就不存在”：UI 需要这个信号，静默成功
        会让“关闭失败”变成不可观测。

        两阶段刻意分开：摘除是同步的（会话立刻从列表消失、不再扇出），阻塞的释放交给
        线程；两阶段之间就把新列表广播出去，其他客户端不必陪着一个正在拆除的会话等。
        """
        if self._registry.find(session_id) is None:
            raise SessionNotFound(session_id)
        detached = self._detach_session(session_id)
        self._publish_sessions()
        await self._release_session(detached)

    # ============================================================ 内部：订阅

    def _on_attach(self, client: Client, message: Attach) -> None:
        session = self._registry.get(message.session)
        self._attach(client, session, resume=message.resume)

    def _attach(self, client: Client, session: Session, resume: int | None) -> None:
        """订阅并对齐。**本方法内没有 await**，因此是一个原子临界区。"""
        # 先解除旧订阅（切换会话）
        previous = self._session_of(client)
        if previous is not None and previous.id != session.id:
            self._detach(client, previous)

        end = session.journal.end_offset
        plan = plan_attach(session.journal, resume, end)

        before = session.focused
        session.attach(client)
        if before != session.focused:
            self._apply_focus(session)

        if isinstance(plan, Resume):
            resumed = True
            rebuild_from = plan.from_offset
            # 续传时对齐点就是日志末尾：客户端本来就在那个偏移上，后面从游标补到 end。
            alignment = end
        else:
            resumed = False
            # 重建时**不能**直接对齐到 end：日志末尾可能正卡在一个残缺的转义序列或多字节
            # 字符中间，而客户端是「快照 + 从对齐点起的字节」拼出来的——那样它会把序列的
            # 尾巴（`3m` 之类）当普通文本画到屏幕上。`replay_offset` 会把对齐点退到那个
            # 残缺序列/字符的起点，回退的几个字节在快照之后重放，正好把它补全。
            rebuild_from = session.journal.replay_offset()
            alignment = rebuild_from

        # Attached 必须先于流字节入队：客户端要先知道 cols/rows 与对齐点再应用字节
        self._send(
            client,
            Attached(
                session=session.id,
                cols=session.cols,
                rows=session.rows,
                scrollback=self._settings.scrollback,
                offset=alignment,
                resumed=resumed,
            ),
        )
        if not resumed:
            # 日志已裁剪到断点之前：只能用模型快照重建（唯一的有损路径）
            self._send(client, self._meta(session))
            self._push_snapshot(client, session, alignment)
        client.next_push_offset = rebuild_from
        client.reset_ack(alignment)
        if resumed:
            # 从游标补齐到 end；队列满就下次继续，绝不丢字节
            self._push_client(session, client)

    def _on_detach(self, client: Client) -> None:
        session = self._session_of(client)
        if session is not None:
            self._detach(client, session)

    def _detach(self, client: Client, session: Session) -> None:
        before = session.focused
        session.detach(client.id)
        if before != session.focused:
            self._apply_focus(session)
        client.reset_subscription()

    # ============================================================ 内部：同步

    def _on_resync(self, client: Client, message: Resync) -> None:
        """客户端要求重新对齐：**一律整段重建**。

        为什么不尝试增量续传：此刻传输层可能已经交给 socket 一批旧增量，我们无法知道
        客户端还会收到多少。单条连接的发送是 FIFO，所以“旧增量先到、快照后到”必然成立，
        快照覆盖一切——这是可证明的收敛，而不是碰运气。
        """
        session = self._registry.get(message.session)
        client.outbox.discard()
        client.behind_notified = False
        # 与 `_attach` 的重建分支同一个对齐点：必须是解析状态干净的位置（见那里的注释）
        alignment = session.journal.replay_offset()
        self._send(
            client,
            Attached(
                session=session.id,
                cols=session.cols,
                rows=session.rows,
                scrollback=self._settings.scrollback,
                offset=alignment,
                resumed=False,
            ),
        )
        self._send(client, self._meta(session))
        self._push_snapshot(client, session, alignment)
        client.next_push_offset = alignment
        client.reset_ack(alignment)

    def _on_ack(self, client: Client, message: Ack) -> None:
        """客户端报告「已渲染到 offset」。

        它是**窗口的解锁信号**：`_push_client` 会在 `acked_offset + push_ahead_bytes` 处停手，
        所以这里的重试不是“顺手再来一次”，而是推送能继续下去的唯一原因——
        `on_drained` 只能解除 socket 那一层的停顿，它不知道客户端渲染到哪了。

        越界的确认（超过已经发给它的字节数）不记账：它不可能是真的，而接受它等于把窗口
        推到一个从未填满的位置——也就是把这个客户端的流控整个关掉（`cursor - acked` 永远
        到不了 `push_ahead_bytes`）。不抛错是因为它只伤害宣告者自己；但它必须留下痕迹。
        """
        if message.offset > client.next_push_offset:
            _log.warning(
                "客户端 %s 确认了未发送过的偏移：ack=%d 已发送到=%d，忽略",
                client.id,
                message.offset,
                client.next_push_offset,
            )
            return
        client.note_ack(message.offset)
        session = self._session_of(client)
        if session is not None:
            self._push_client(session, client)

    def _push_snapshot(self, client: Client, session: Session, offset: int) -> None:
        payload = self._snapshot_bytes(session)
        client.outbox.push(frames.encode_snapshot(offset, payload))
        client.wakeup.set()

    def _snapshot_bytes(self, session: Session) -> bytes:
        """生成重建字节。

        注意：`host.snapshot()` 是阻塞调用（要序列化整段 scrollback），会短暂占用事件
        循环。这是刻意的取舍——它只在日志被裁剪后发生，属低频路径；若日后成为热点，
        优化方向是**在裁剪切点预先离线生成并缓存快照**，而不是把它挪进 await
        （那会破坏订阅区间的原子性）。
        """
        if session.host is None:
            return b""
        return session.host.snapshot()

    def _declare_gap(self, session: Session, client: Client, cursor: int) -> None:
        """客户端游标落到已裁剪区间 → 显式宣告空洞，要求重同步。"""
        if client.behind_notified:
            return
        client.behind_notified = True
        _log.warning(
            "客户端 %s 落后到裁剪区间: cursor=%d start=%d session=%s",
            client.id,
            cursor,
            session.journal.start_offset,
            session.id,
        )
        self._send(
            client,
            Behind(session=session.id, offset=cursor, reason=REASON_TRIMMED),
        )

    # ============================================================ 内部：推送

    def _push_client(self, session: Session, client: Client) -> None:
        """把该客户端缺的字节按游标补齐。

        **两道互相独立的限制：**

        1. 发送队列水位（`Outbox`）——限制的是「已交给 socket、还没写完」的字节；
        2. 解析窗口（`push_ahead_bytes`，**仅对会 ack 的客户端**）——限制的是
           「已交给 socket、客户端还没渲染完」的字节。

        第二道是必要的：水位管不到客户端**已经吃下**的字节。实测（见 docs/audit.md A4，
        回归在 tests/test_push_window.py）
        一个「socket 很快但渲染很慢」的客户端可以让服务端把 4 MiB 输出全推出去、`acked` 还停在 0，
        这跟日志预算无关——慢渲染的浏览器会在内核/浏览器里攒出任意大的未解析积压。

        窗口只对**证明过自己会 ack** 的客户端生效（见 `Client.ack_seen`）：不会 ack 的实现
        保持旧行为，不会停在一个永远解不开的窗口上。附加与重建的补齐也不受限：
        那时 `acked_offset` 已被设成对齐点，`cursor - acked` 是负的。
        """
        if client.closed or client.behind_notified:
            return
        journal = session.journal
        cursor = client.next_push_offset
        end = journal.end_offset
        start = journal.start_offset
        if cursor < start:
            self._declare_gap(session, client, cursor)
            return
        if cursor > end:  # 理论不可达：重置后必然 <= end
            client.next_push_offset = end
            return

        window = self._settings.push_ahead_bytes if client.ack_seen else None
        chunk = self._settings.attach_chunk_bytes
        while cursor < end:
            if window is not None and cursor - client.acked_offset >= window:
                # 客户端还没渲染到这里：停手，等 `Ack` 把窗口往前推（`_on_ack` 会再喊一次）
                break
            take = min(chunk, end - cursor)
            data = journal.read(cursor, take)
            if not data:
                break
            frame = frames.encode_output(cursor, data)
            # 水位判断放在编码之后：帧头(13B)与外层封装一样要计入尚未消费的负载。
            # 队列非空时才检查——否则一个大于水位的分片会让循环永远无法推进。
            if client.outbox.pending_bytes and client.outbox.would_exceed(len(frame)):
                break
            client.outbox.push(frame)
            cursor += len(data)
        client.next_push_offset = cursor
        if client.outbox.pending_bytes:
            client.wakeup.set()

    def _release_input(self, session_id: str) -> None:
        """输入队列已排水：放行该会话下被暂缓的客户端。**只允许事件循环调用。**

        由写线程经 `loop.call_soon_threadsafe` 转过来，所以这里看到的是完整的、没有被
        并发改动的订阅表。放行只发给“确实被暂缓过”的客户端：其余客户端从未收到
        `InputHold`，给它发一条 `paused=false` 只会让前端的状态机凭空多一分不确定性。
        """
        session = self._registry.find(session_id)
        if session is None:
            return
        for client in session.subscribers:
            if client.input_held:
                client.input_held = False
                self._send(client, InputHold(session=session_id, paused=False))

    def _submit_response(self, session: Session, data: bytes) -> None:
        """把**宿主应答**（模型对输出的回应：DSR、焦点）交给该会话的写线程。

        与客户端输入共一条 FIFO（唯一写者），但**不参与输入水位**：它是模型对流量的
        回复，必须无条件发出，且总量只有几个字节。客户端输入走 `handle_input`。
        """
        if not data:
            return
        runner = self._runners.get(session.id)
        if runner is not None:
            runner.submit_response(data)

    def _ingest_output(self, session: Session, data: bytes) -> None:
        """把一段输出喂进模型并并入日志，然后给所有订阅者按游标补齐。

        `host.ingest` 与 `journal.append` 必须**相邻**（同一线程、中间无 await）：
        两者之间的距离就是“模型超前于日志”的窗口，而重建路径的正确性建立在窗口为零
        之上（快照恰是 `[0, journal.end_offset)` 的状态，对齐点才能与快照同源）。
        """
        if session.host is not None:
            # 模型要回写给应用的应答（DSR 等）同样经唯一写者，保证与输入共一条 FIFO
            self._submit_response(session, session.host.ingest(data))
        session.journal.append(data)
        session.journal.trim_to_budget()
        for client in session.subscribers:
            self._push_client(session, client)
        self._publish_meta(session)

    def _broadcast(self, session: Session, message: ServerMessage) -> None:
        for client in session.subscribers:
            self._send(client, message)

    def _send(self, client: Client, message: ServerMessage) -> None:
        # 控制消息走文本帧，与终端字节流共享同一条有序队列（顺序是正确性的一部分）
        client.outbox.push_text(dump_bytes(message))
        client.wakeup.set()

    def _fail(self, client: Client, code: str, message: str) -> None:
        _log.debug("向客户端 %s 报错 %s: %s", client.id, code, message)
        self._send(client, Failure(code=code, message=message))

    # ============================================================ 内部：元数据与焦点

    def _meta(self, session: Session) -> Meta:
        """构造元数据消息。

        直接返回 `Meta` 而不是拼一个 `dict[str, object]` 再展开：后者把字段类型
        全部擦成 object，`Meta(...)` 的校验就彻底失效了。
        """
        return Meta(
            session=session.id,
            title=session.meta.title,
            cwd=session.meta.cwd,
            progress_label=session.meta.progress_label,
            progress_value=session.meta.progress_value,
        )

    def _publish_meta(self, session: Session) -> None:
        now = time.monotonic()
        if now - self._meta_polled_at.get(session.id, 0.0) < _META_POLL_INTERVAL:
            return
        self._meta_polled_at[session.id] = now
        if session.host is None:
            return
        meta = session.host.metadata()
        if meta == session.meta:
            return
        session.meta = meta
        self._broadcast(session, self._meta(session))

    def _on_focus(self, client: Client, message: Focus) -> None:
        client.focused = message.focused
        session = self._session_of(client)
        if session is None:
            return
        aggregate = session.set_client_focus(client.id, message.focused)
        if aggregate is not None:
            self._apply_focus(session)

    def _apply_focus(self, session: Session) -> None:
        """把聚合后的焦点下发给应用。

        多客户端必须聚合成一个布尔量：否则每个客户端各自上报 DECSET 1004，
        应用会收到互相矛盾的 FocusIn/FocusOut。应答经唯一写者回写。
        """
        if session.host is not None:
            self._submit_response(session, session.host.set_focus(session.focused))

    # ============================================================ 内部：会话操作

    async def _on_session_create(self, client: Client, message: SessionCreate) -> None:
        await self.create_session(
            name=message.name,
            argv=message.argv,
            cwd=message.cwd,
            attach_client=client,
        )

    async def _on_session_close(self, client: Client, message: SessionClose) -> None:
        await self.close_session(message.session)

    def _on_session_rename(self, client: Client, message: SessionRename) -> None:
        session = self._registry.get(message.session)
        session.name = message.name
        self._publish_sessions()

    def _publish_sessions(self) -> None:
        items = self.session_infos()
        for client in self._clients.values():
            if not client.closed:
                self._send(client, Sessions(items=items))

    # ============================================================ 内部：会话运行

    def _start_session(self, session: Session) -> None:
        if session.host is None:
            raise RuntimeError("会话缺少宿主")
        loop = asyncio.get_running_loop()
        bridge: ThreadBridge[ReaderEvent] = ThreadBridge(loop, maxsize=_BRIDGE_MAXSIZE)
        session_id = session.id

        def on_input_drained() -> None:
            """写线程回调：把“输入队列已排水”转到事件循环上放行客户端。

            这里**只能**做“把回调排到循环上”这一件事：`_release_input` 会触碰 Hub 的
            状态（客户端、订阅表），而它们的所有者永远是事件循环线程。
            事件循环已关闭（进程收尾）时 `call_soon_threadsafe` 会抛 RuntimeError；
            那是正常终止路径，吞掉比在写线程里炸出 traceback 好。
            """
            with contextlib.suppress(RuntimeError):  # pragma: no cover - 仅进程收尾时可达
                loop.call_soon_threadsafe(self._release_input, session_id)

        runner = SessionRunner(
            session.host,
            bridge,
            max_bytes=_PUMP_MAX_BYTES,
            poll_timeout=_PUMP_TIMEOUT,
            input_high_bytes=self._settings.input_high_bytes,
            input_low_bytes=self._settings.input_low_bytes,
            input_hard_bytes=self._settings.input_hard_bytes,
            on_drained=on_input_drained,
        )
        self._bridges[session.id] = bridge
        self._runners[session.id] = runner
        runner.start()
        task = loop.create_task(self._pump_loop(session.id), name=f"pump-{session.id}")
        self._pumps[session.id] = task
        _log.info("会话已就绪 id=%s name=%s", session.id, session.name)

    async def _pump_loop(self, session_id: str) -> None:
        session = self._registry.find(session_id)
        bridge = self._bridges.get(session_id)
        if session is None or bridge is None:
            return
        try:
            while True:
                try:
                    event = await bridge.get()
                except BridgeClosed:
                    return
                if isinstance(event, OutputChunk):
                    self._ingest_output(session, event.data)
                elif isinstance(event, ProcessExited):
                    session.status = SessionStatus.EXITED
                    session.exit_code = event.code
                    _log.info("会话进程已退出 id=%s code=%s", session.id, event.code)
                    # 会话**不销毁**：内容与 journal 保留，可继续订阅
                    self._broadcast(session, Exited(session=session.id, code=event.code))
                    self._publish_sessions()
                    return
        except asyncio.CancelledError:
            raise
        except Exception:
            _log.exception("会话 pump 异常退出 id=%s", session_id)

    def _detach_session(self, session_id: str) -> _Detached:
        """把会话从 Hub 的运转状态里摘除。**同步、无 await**，因此是原子临界区。

        摘除只改内存：会话立刻从列表消失、不再进入任何扇出、也不会再被 attach 到。
        真正阻塞的资源释放见 `_release_session`——两者分开是因为释放可能无界（A13）。
        订阅者要被重置：它们订阅的那个会话已经不存在了，留着旧的 offset 只会让下一次
        订阅从荒唐的位置续传。
        """
        runner = self._runners.pop(session_id, None)
        bridge = self._bridges.pop(session_id, None)
        task = self._pumps.pop(session_id, None)
        self._meta_polled_at.pop(session_id, None)
        if task is not None and not task.done():
            task.cancel()
        if bridge is not None:
            bridge.close()
        session = self._registry.detach(session_id)
        if session is not None:
            for client in session.subscribers:
                client.reset_subscription()
        return _Detached(session=session, runner=runner)

    async def _release_session(self, detached: _Detached) -> None:
        """释放被摘除会话的资源。阻塞，**只在事件循环之外的线程里做**。

        `runner.stop()` 会 join 读写线程并调用 `host.close()`；`host.close()` 在 Windows
        上要等控制台客户端退出（实测 236 秒，且**持着 GIL**——换线程也没用，所以真实
        宿主会在关闭前先终止整棵进程树，见 `runtime/winjob.py`）。这里能保证的只有一件事：
        无论它阻塞多久，都不会挡住事件循环上的其他会话、客户端与 HTTP 接口。
        """
        if detached.runner is not None:
            await asyncio.to_thread(detached.runner.stop)
        elif detached.session is not None and detached.session.host is not None:
            # 没有 runner 的会话（`_start_session` 失败留下的）：只有宿主要释放
            await asyncio.to_thread(detached.session.host.close)

    # ============================================================ 内部：工具

    def _session_of(self, client: Client) -> Session | None:
        if client.session_id is None:
            return None
        return self._registry.find(client.session_id)


__all__ = ["Hub", "SessionNotFound"]
