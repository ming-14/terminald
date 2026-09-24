"""应用服务层 —— 把领域对象、宿主线程、协议帧拼成可运行的系统。

这一层是**传输无关**的：`Hub` 不 import fastapi，也不直接 await 网络。
因此它可以被直接驱动并断言“产生了哪些帧”，无需真实 WebSocket 或浏览器——
多客户端同步这类最难测的行为正好都落在这里。

它也不 import pywezterm：宿主由装配层注入的 `HostFactory` 提供。
"""

from __future__ import annotations

from .hub import Hub

__all__ = ["Hub"]
