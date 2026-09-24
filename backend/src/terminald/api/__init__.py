"""传输层 —— 唯一的对外边界（HTTP + WebSocket）。

它做三件事，且只做这三件：

1. **装配**：把 config / runtime / service 拼成一个可运行的应用（`create_app`）。
2. **协议编解码**：文本帧 ↔ 控制消息，二进制帧 ↔ 输入字节。
3. **安全围栏**：回环来源校验（`security.py`）。

业务语义**不在这里**。`api` 里的任何 `if` 都应该是在判断“传输是否还活着”或
“输入是否合法”，而不是在判断“这个订阅该怎么办”——后者属于 `service.hub`。
"""

from __future__ import annotations

from .app import DEFAULT_WEB_DIR, create_app, resolve_web_dir

__all__ = ["DEFAULT_WEB_DIR", "create_app", "resolve_web_dir"]
