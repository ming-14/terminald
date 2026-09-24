"""会话注册表 —— 会话的创建、查找、关闭。

core 只依赖注入进来的 `HostFactory`，因此测试可以用测试替身跑满整条链路，
不需要真实 PTY，也不需要 pywezterm。
"""

from __future__ import annotations

from collections.abc import Sequence
from uuid import uuid4

from .errors import SessionNameConflict, SessionNotFound
from .journal import Journal
from .ports import HostFactory, SessionSpec
from .session import Session


class Registry:
    """进程内会话表（单进程架构下即全局唯一）。"""

    def __init__(
        self,
        host_factory: HostFactory,
        *,
        journal_budget_bytes: int,
        default_cols: int,
        default_rows: int,
        default_scrollback: int,
        default_argv: Sequence[str] | None = None,
        default_cwd: str | None = None,
    ) -> None:
        self._host_factory = host_factory
        self._journal_budget = journal_budget_bytes
        self._cols = default_cols
        self._rows = default_rows
        self._scrollback = default_scrollback
        self._default_argv = tuple(default_argv or ())
        self._default_cwd = default_cwd
        self._sessions: dict[str, Session] = {}
        self._counter = 0

    # ------------------------------------------------------------ 查询

    def get(self, session_id: str) -> Session:
        try:
            return self._sessions[session_id]
        except KeyError as exc:
            raise SessionNotFound(session_id) from exc

    def find(self, session_id: str) -> Session | None:
        return self._sessions.get(session_id)

    def list(self) -> list[Session]:
        return sorted(self._sessions.values(), key=lambda s: s.created_at)

    def __len__(self) -> int:
        return len(self._sessions)

    # ------------------------------------------------------------ 创建

    def create(
        self,
        *,
        name: str | None = None,
        argv: Sequence[str] | None = None,
        cwd: str | None = None,
    ) -> Session:
        """创建并启动一个会话。

        cols/rows 在此定死：**终端尺寸由终端侧决定**，浏览器可视面积不参与，
        因此这里没有来自客户端的尺寸参数。
        """
        self._counter += 1
        resolved_name = name or f"shell {self._counter}"
        if any(s.name == resolved_name for s in self._sessions.values()):
            raise SessionNameConflict(resolved_name)

        session_id = f"s{uuid4().hex[:10]}"
        spec = SessionSpec(
            argv=tuple(argv) if argv else self._default_argv,
            cols=self._cols,
            rows=self._rows,
            cwd=cwd if cwd is not None else self._default_cwd,
            scrollback=self._scrollback,
        )
        host = self._host_factory(spec)
        session = Session(
            id=session_id,
            name=resolved_name,
            cols=self._cols,
            rows=self._rows,
            journal=Journal(self._journal_budget),
            host=host,
        )
        self._sessions[session_id] = session
        return session

    # ------------------------------------------------------------ 关闭

    def detach(self, session_id: str) -> Session | None:
        """只把会话从注册表摘除，**不**释放宿主。

        摘除是纯内存操作，因此可以在事件循环上同步完成（会话立刻从列表消失、不再进入
        任何扇出）；释放宿主是**阻塞且可能无界**的（`ClosePseudoConsole` 会等控制台
        客户端退出，实测 236 秒），二者必须分开，否则又会在循环上阻塞（`docs/audit.md`
        A13）。返回被摘除的会话，没有则 None。
        """
        return self._sessions.pop(session_id, None)

    def close(self, session_id: str) -> None:
        """摘除并释放宿主（幂等语义：不存在即视为已关闭）。**阻塞，只允许在线程里调用。**"""
        session = self.detach(session_id)
        if session is None:
            return
        if session.host is not None:
            session.host.close()

    def close_all(self) -> None:
        """释放全部会话。**阻塞，只允许在线程里调用。**"""
        for session_id in list(self._sessions):
            self.close(session_id)


__all__ = ["Registry"]
