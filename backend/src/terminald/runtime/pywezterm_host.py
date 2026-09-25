"""`SessionHost` 的真实实现 —— 本包内**唯一**允许 import pywezterm 的模块。

它把 wezterm 的两个概念（`Pty`、`Terminal`）按**线程归属**拆成三组方法
（完整契约见 `core/ports.py`）：

- 读线程：`read()`，只做阻塞读，不碰模型；
- 事件循环线程：`ingest()` / `set_focus()` / `snapshot()` / `metadata()`——终端模型的
  唯一所有者。`ingest()` 会把模型的应答（DSR 等）**返回**给上层，由写线程回写 PTY；
  不回写子进程会等应答卡死，而由上层统一回写则保证应答与客户端输入走同一条 FIFO；
- 写线程：`write()`，唯一写者。

为什么必须这样分：`Terminal` 是可变的共享状态，快照/元数据读取它时必须没有并发 `feed`，
否则重建路径会拿到撕裂的快照；而 `Pty.write` 在缓冲写满时会阻塞，放在事件循环上会冻结
整个进程（两处都有回归测试与 `docs/audit.md` 的探针）。

**拆除路径同样有线程/GIL 约束**：`Pty.close()` 内部的 `ClosePseudoConsole` 会等控制台
客户端退出，而绑定层的 `close()` 不释放 GIL——把它放进线程毫无用处。因此这里用 Job Object
（`winjob`）在关闭前先终止整棵进程树，让那次等待根本不发生（见 `docs/audit.md` A13）。

导入是惰性的：缺少 pywezterm 时 `import terminald.runtime.pywezterm_host` 仍必须成功，
只有真正创建宿主才报 `HostUnavailable`——这样分层测试、纯逻辑单测都不依赖该原生扩展。
"""

from __future__ import annotations

import importlib
from types import ModuleType
from typing import Any

from ..core.errors import HostUnavailable
from ..core.ports import HostMetadata, SessionSpec
from ..logs import get_logger
from . import winjob

_log = get_logger(__name__)

_MODULE_NAME = "pywezterm"
_module: ModuleType | None = None

#: 终端模型的**占位标题**：库内部把窗口标题初始化成这个常量，它不是应用设的标题。
#: 必须当成「没有标题」处理，否则每个还没设过标题的会话都会对外显示成同一个词，
#: 侧栏/标签页里就全是它。改的只能是这里的适配层——那是唯一知道该库怪癖的地方。
_PLACEHOLDER_TITLE = "wezterm"


def _require_pywezterm() -> ModuleType:
    global _module
    if _module is None:
        try:
            _module = importlib.import_module(_MODULE_NAME)
        except ImportError as exc:  # pragma: no cover - 取决于环境
            raise HostUnavailable(
                f"未找到 {_MODULE_NAME}。它是仓库里的长期依赖 vendor/pywezterm/（不安装）："
                "把仓库的 vendor/ 加进 PYTHONPATH（见 backend/README.md 的「运行」一节）"
            ) from exc
    return _module


class PyweztermHost:
    """pywezterm 支持的会话宿主。"""

    def __init__(self, spec: SessionSpec) -> None:
        module = _require_pywezterm()
        self.spec = spec
        # 作业必须先建好：子进程一 spawn 就纳入，它在纳管**之后**fork 出来的后代自动继承
        self._tree = winjob.create()
        self._pty: Any = module.Pty(cols=spec.cols, rows=spec.rows)
        self._term: Any = module.Terminal(spec.cols, spec.rows, spec.scrollback)
        self._closed = False
        # 两个 try 分开：「启动失败」与「纳管失败」都要释放资源，但纳管那一步要用到
        # `pid`/`handle`（日志里要报 pid），因此必须先落字段再纳管。
        try:
            pid, handle = self._pty.spawn(
                list(spec.argv),
                cwd=spec.cwd,
                env=dict(spec.env) if spec.env else None,
            )
        except Exception:
            self._release()
            raise
        self._pid: int | None = int(pid)
        self._handle = int(handle)
        self._fed = 0
        try:
            self._adopt(self._handle)
        except Exception:
            self._release()
            raise
        _log.info("会话已启动 pid=%s argv=%s", self._pid, list(spec.argv))

    def _release(self) -> None:
        """释放底层资源（构造中途失败时用；幂等）。

        三步必须各自都被执行到：先终止整棵树，再关伪终端，最后释放作业句柄。用嵌套
        `finally` 而不是顺序语句，是因为其中任何一步抛出都不应该让后面的资源泄漏——
        `terminate()` 失败而 `pty.close()` 不执行，正好会留下一个没人再关的伪终端。
        """
        if self._closed:
            return
        self._closed = True
        try:
            self._tree.terminate()
        finally:
            try:
                self._pty.close()
            finally:
                self._tree.close()

    def _adopt(self, handle: int) -> None:
        """把子进程纳入作业（其后续后代自动继承）。

        唯一可接受的失败是**子进程已经退出**（毫秒级命令可能跑在 spawn 与这一行之间），
        那时它自己就是整棵树。其余失败必须抛出：一个纳管失败的后代会让拆除重新变成
        无界阻塞（A13），静默降级等于把那个缺陷藏起来。
        """
        try:
            self._tree.adopt(handle)
        except OSError as exc:
            if self._pty.try_wait() is None:
                raise
            _log.debug("子进程在纳入作业前已退出 pid=%s：%s", self._pid, exc)

    # ------------------------------------------------------------ SessionHost

    @property
    def pid(self) -> int | None:
        return self._pid

    @property
    def fed_offset(self) -> int:
        return self._fed

    # ------------------------------------------------------------ 读线程

    def read(self, max_bytes: int = 8192, timeout: float = 0.2) -> bytes:
        """只从 PTY 读，不碰终端模型（读线程唯一允许做的事）。"""
        return bytes(self._pty.read(max_bytes, timeout=timeout))

    # ------------------------------------------------------------ 事件循环线程

    def ingest(self, data: bytes) -> bytes:
        """喂模型并取走应答；调用者（事件循环）负责把应答交给写线程。"""
        if not data:
            return b""
        self._term.feed(data)
        self._fed += len(data)
        return bytes(self._term.drain_written())

    def set_focus(self, focused: bool) -> bytes:
        self._term.focus_changed(focused)
        return bytes(self._term.drain_written())

    # ------------------------------------------------------------ 写线程

    def write(self, data: bytes) -> None:
        """唯一写者：只允许写线程调用（阻塞写，绑定层已放掉 GIL）。"""
        self._pty.write(data)

    def try_wait(self) -> int | None:
        """非阻塞查询退出码；已退出时把 `pid` 清成 None（它不再指向一个活着的进程）。"""
        code = self._pty.try_wait()
        if code is None:
            return None
        self._pid = None
        return int(code)

    def kill(self) -> None:
        """终止整棵进程树（`Pty.kill()` 只杀直接子进程，孙子进程会继续握着控制台）。"""
        self._tree.terminate()
        self._pty.kill()

    def close(self) -> None:
        """释放宿主（幂等）。

        顺序是强制的：**先终止整棵树，再关伪终端**。反过来的话 `ClosePseudoConsole`
        会等控制台客户端退出，而绑定层的 `close()` 持着 GIL 阻塞——实测 236 秒，
        期间整个解释器（所有会话、所有客户端、全部 HTTP 接口）一起停摆。
        """
        self._release()

    def snapshot(self) -> bytes:
        """RIS + （主屏时）scrollback + 可见区重绘 + 模式恢复。

        备用屏重建：`\\x1b[?1049h` 会清屏，必须**先**进备用屏再画可见区，
        且不能重放 scrollback（备用屏没有历史）。
        主屏重建：模式恢复在前（其中 `25l` 之类不影响绘制），再重放历史，最后画可见区。
        `mode_restore_seq()` 覆盖备用屏/鼠标追踪+SGR/bracketed paste/光标可见。
        """
        parts: list[str] = ["\x1bc"]
        if self._term.is_alt_screen_active():
            parts.append(self._term.mode_restore_seq())
            parts.append(self._term.render_ansi(True))
        else:
            parts.append(self._term.mode_restore_seq())
            scrollback = self._term.render_scrollback(True)
            if scrollback:
                parts.append(scrollback)
            parts.append(self._term.render_ansi(True))
        return "".join(parts).encode("utf-8")

    def metadata(self) -> HostMetadata:
        label, value = self._term.get_progress()
        title = self._term.get_title()
        return HostMetadata(
            title=None if title == _PLACEHOLDER_TITLE else title,
            cwd=self._term.get_current_dir(),
            progress_label=str(label),
            progress_value=value,
        )


__all__ = ["PyweztermHost"]
