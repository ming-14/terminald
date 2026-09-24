"""terminald —— 网页终端守护进程。

分层（依赖方向严格单向，见 docs/architecture.md）：

    api ──→ core, protocol, runtime
    runtime ──→ core, protocol          # 唯一可 import pywezterm 的包
    core ──→ protocol                   # 纯逻辑，零外部依赖
    protocol ──→ stdlib, pydantic       # 与前端共享的协议定义

铁律由 tests/test_layering.py 扫描 AST 强制执行，不靠自觉。
"""

__all__ = ["__version__"]

__version__ = "0.1.0"
