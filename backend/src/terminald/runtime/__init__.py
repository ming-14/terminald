"""宿主适配层 —— 唯一允许 import pywezterm 的包。

对上层只暴露两样东西：`HostFactory`（创建宿主）与 `SessionRunner`/`ThreadBridge`
（把阻塞 I/O 移到线程并把结果交回事件循环）。

`import terminald.runtime` 本身**不**导入原生扩展，因此纯逻辑测试与分层测试都不
依赖 pywezterm 是否安装。
"""

from __future__ import annotations

from ..core.ports import HostFactory, SessionHost, SessionSpec
from .bridge import BridgeClosed, ThreadBridge
from .runner import InputVerdict, OutputChunk, ProcessExited, ReaderEvent, SessionRunner


def make_host_factory(impl: str) -> HostFactory:
    """按名字构造宿主工厂。

    `pywezterm` 是默认且唯一的真实实现；`fake` 只供测试与前端联调使用
    （见 `fake_host.py` 的说明，它不是降级方案）。
    """
    if impl == "pywezterm":
        # 延迟到调用点导入，避免在未安装原生扩展时炸掉模块导入
        from .pywezterm_host import PyweztermHost

        def _pywezterm_factory(spec: SessionSpec) -> SessionHost:
            return PyweztermHost(spec)

        return _pywezterm_factory

    if impl == "fake":
        from .fake_host import FakeHost

        def _fake_factory(spec: SessionSpec) -> SessionHost:
            return FakeHost(spec)

        return _fake_factory

    raise ValueError(f"未知 host_impl: {impl!r}")


__all__ = [
    "BridgeClosed",
    "InputVerdict",
    "OutputChunk",
    "ProcessExited",
    "ReaderEvent",
    "SessionRunner",
    "ThreadBridge",
    "make_host_factory",
]
