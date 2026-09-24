"""端口定义（依赖倒置的接缝）。

`core` **定义**它需要宿主提供什么；`runtime` 提供实现；`api` 负责装配。
因此 core 里不会出现 `import pywezterm`，可以脱离真实 PTY 完整单测——
而 offset/裁剪/重同步这些最容易出错的逻辑正好都在 core 里。

## 线程归属是端口契约的一部分

终端模型（pywezterm 的 `Terminal`）是可变的共享状态，必须由**同一个线程**独占读写。
因此端口按**允许调用的线程**划分方法，而不是按功能划分：

| 方法 | 唯一允许的调用者 | 为什么 |
|---|---|---|
| `read()` | 读线程 | 只做阻塞读，不碰模型 |
| `ingest()` / `set_focus()` / `snapshot()` / `metadata()` | 事件循环线程 | 模型的唯一所有者 |
| `write()` | 写线程 | PTY 写会阻塞，不能压在事件循环上 |

两条由此得到的硬不变量（都有回归测试）：

1. `ingest()` 与 journal 追加由同一线程**相邻执行**（见 `Hub._ingest_output`）
   → `fed_offset == journal.end_offset` 恒成立；
2. 正因为如此，`snapshot()` 渲染期间不可能有任何 `ingest()` 插进来
   → 快照恰是「重放 `[0, journal.end_offset)` 之后」的状态，对齐点与快照内容同源。

这条契约曾经是反的：模型在读线程里被喂，事件循环却拿它做快照与对齐点登记，
于是重建路径同时产出空洞与重复（见 `docs/audit.md` A2）。
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable


@dataclass(frozen=True, slots=True)
class SessionSpec:
    """创建一个会话宿主所需的全部输入。"""

    argv: Sequence[str]
    cols: int
    rows: int
    cwd: str | None = None
    env: Mapping[str, str] = field(default_factory=dict)
    scrollback: int = 10_000


@dataclass(frozen=True, slots=True)
class HostMetadata:
    """由终端模型解析出的元数据（OSC 0/2/7/9 等）。"""

    title: str | None = None
    cwd: str | None = None
    progress_label: str = "none"
    progress_value: int | None = None


@runtime_checkable
class SessionHost(Protocol):
    """一个会话的宿主：PTY + 终端模型。每个方法都注明了唯一允许的调用线程。"""

    @property
    def pid(self) -> int | None:
        """子进程 PID；未启动为 None。"""
        ...

    @property
    def fed_offset(self) -> int:
        """已喂进终端模型的字节总数（绝对偏移，从 0 起）。

        存在的意义是让「模型与日志同源」这条不变量**可被断言**：
        契约测试要求任意时刻 `fed_offset == journal.end_offset`。
        """
        ...

    # ------------------------------------------------------------ 读线程

    def read(self, max_bytes: int = 8192, timeout: float = 0.2) -> bytes:
        """从 PTY 读取至多 `max_bytes` 字节。**只允许读线程调用，不碰终端模型。**

        空返回值表示本轮无数据（超时），不代表 EOF；EOF 由 `try_wait()` 判断。
        """
        ...

    # ------------------------------------------------------------ 事件循环线程

    def ingest(self, data: bytes) -> bytes:
        """把一段输出喂进终端模型，返回模型要回写给应用的应答字节（可能为空）。

        必须与 journal 追加在同一线程相邻执行（见 `Hub._ingest_output`）：
        两者之间的距离就是「模型超前于日志」的窗口，必须为零。
        """
        ...

    def set_focus(self, focused: bool) -> bytes:
        """把（聚合后的）焦点状态告知终端模型，返回要回写给应用的应答字节。事件循环调用。"""
        ...

    def snapshot(self) -> bytes:
        """生成重建用字节：RIS + scrollback 重放 + 可见区 + 模式恢复。事件循环调用。

        **只在日志已裁剪到客户端断点之前时使用**——这是唯一需要动终端模型的路径，
        因此也是唯一可能有保真损耗的路径。它依赖「模型此刻恰好等于 journal 末尾」，
        而该前提由 `ingest()` 的同线程相邻性保证。
        """
        ...

    def metadata(self) -> HostMetadata:
        """当前元数据快照。事件循环调用。"""
        ...

    # ------------------------------------------------------------ 写线程（唯一写者）

    def write(self, data: bytes) -> None:
        """把输入字节写入 PTY。**唯一调用者必须是该会话的写线程（`SessionRunner`）。**

        写会在 PTY 缓冲写满时阻塞（绑定层已在 `Pty.write` 里放掉 GIL）；把它放在
        事件循环上会冻结整个进程的所有会话与 HTTP 接口（见 `docs/audit.md` A1）。
        """
        ...

    # ------------------------------------------------------------ 生命周期

    def try_wait(self) -> int | None:
        """非阻塞查询退出码；None 表示仍在运行。"""
        ...

    def kill(self) -> None:
        """终止子进程。"""
        ...

    def close(self) -> None:
        """释放宿主资源（幂等）。"""
        ...


HostFactory = Callable[[SessionSpec], SessionHost]
"""由装配层注入；core 只依赖这个可调用对象，不依赖任何具体实现。"""


__all__ = ["HostFactory", "HostMetadata", "SessionHost", "SessionSpec"]
