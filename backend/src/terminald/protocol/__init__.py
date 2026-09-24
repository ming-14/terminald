"""协议层（common）—— 与前端 `frontend/src/protocol/` 一一对应。

这是**唯一的协议真源**：帧格式、消息模型、以及 `vectors/` 下的共享测试向量。
前端必须用同一份向量跑一遍编解码，任何一侧漂移都会在测试里暴露。

约定：
- 二进制帧 = 终端字节流（`frames.py`）
- 文本帧   = 控制消息 JSON（`messages.py`）
"""

from __future__ import annotations

# 协议版本：前后端不一致时拒绝连接（见 messages.Hello）
PROTOCOL_VERSION = 1
