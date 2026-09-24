"""核心层（common）—— 领域逻辑，零外部依赖。

**禁止**在本包内 import `pywezterm` / `fastapi` / `uvicorn`；由
`tests/test_layering.py` 扫描 AST 强制。这样 offset、裁剪、重同步这些最容易出错的
部分可以脱离真实 PTY 与网络完整单测。
"""

from __future__ import annotations

from .client import Client
from .errors import (
    HostUnavailable,
    JournalTrimmed,
    OffsetAhead,
    ProtocolViolation,
    SessionNameConflict,
    SessionNotFound,
    TerminaldError,
)
from .journal import Journal
from .outbox import Outbound, Outbox
from .ports import HostFactory, HostMetadata, SessionHost, SessionSpec
from .registry import Registry
from .session import Session
from .sync import (
    REASON_FRESH_TRUNCATED,
    REASON_RESUME_TRIMMED,
    AttachPlan,
    Rebuild,
    Resume,
    plan_attach,
)

__all__ = [
    "REASON_FRESH_TRUNCATED",
    "REASON_RESUME_TRIMMED",
    "AttachPlan",
    "Client",
    "HostFactory",
    "HostMetadata",
    "HostUnavailable",
    "Journal",
    "JournalTrimmed",
    "OffsetAhead",
    "Outbound",
    "Outbox",
    "ProtocolViolation",
    "Rebuild",
    "Registry",
    "Resume",
    "Session",
    "SessionHost",
    "SessionNameConflict",
    "SessionNotFound",
    "SessionSpec",
    "TerminaldError",
    "plan_attach",
]
