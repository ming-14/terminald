"""ASGI 应用装配。

这一个进程同时承担三种角色，这是刻意的选择：

1. **终端守护**：持有会话、PTY、终端模型（`Hub` + `runtime`）。
2. **实时通道**：`/ws` 广播字节流。
3. **静态托管**：`frontend` 的构建产物挂在 `/`。

把三者放在同一个进程的理由是**会话坐标必须唯一**：offset、裁剪点、订阅表都活在
进程内存里。一旦用 `uvicorn --workers N` 横向扩展，同一个会话的两次 attach 可能落到
不同进程，各自持有互不相同的 offset——那不是性能问题，是正确性问题。所以这里明确：
**单进程**。要扩容就必须先做显式的会话分进程 + 网关路由（见 docs/architecture.md）。

前端由后端托管还顺带消掉了一整类问题：同源（不需要 CORS 配置）、不需要代理、
不需要把端口写进前端构建产物。
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from .. import __version__
from ..config import Settings, get_settings
from ..core.ports import HostFactory
from ..logs import get_logger
from ..runtime import make_host_factory
from ..service.hub import Hub
from . import rest, ws

_log = get_logger(__name__)

_PACKAGE_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_WEB_DIR = _PACKAGE_ROOT / "web"

_NOT_BUILT = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>terminald</title>
<style>
body{
  font:14px/1.6 system-ui,monospace;max-width:44rem;
  margin:12vh auto;padding:0 1.5rem;color:#111;
}
code{background:#f2f2f2;padding:.1rem .35rem;border-radius:3px}
</style></head>
<body><h1>后端已就绪，前端尚未构建</h1>
<p>在 <code>frontend/</code> 下执行 <code>npm install</code> 与
<code>npm run build</code>，然后刷新本页。</p>
<p>接口可用性：<code>GET /api/healthz</code>；实时通道：<code>/ws</code>。</p>
</body></html>
"""


def resolve_web_dir(settings: Settings) -> Path | None:
    """定位前端构建产物；不存在则返回 None。"""
    candidate = Path(settings.web_dir).expanduser() if settings.web_dir else DEFAULT_WEB_DIR
    return candidate if (candidate / "index.html").is_file() else None


def create_app(
    settings: Settings | None = None,
    host_factory: HostFactory | None = None,
) -> FastAPI:
    """构造 ASGI 应用。

    参数可注入，因此测试无需读环境变量、也不需要真实 PTY：
    `create_app(settings, host_factory=make_host_factory("fake"))` 即可跑满整条链路。
    """
    resolved = settings if settings is not None else get_settings()
    factory = host_factory if host_factory is not None else make_host_factory(resolved.host_impl)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        # Hub 必须在事件循环里构造：它内部要创建 asyncio 原语
        app.state.hub = Hub(resolved, factory)
        _log.info(
            "terminald %s 启动 host_impl=%s cols=%d rows=%d",
            __version__,
            resolved.host_impl,
            resolved.cols,
            resolved.rows,
        )
        try:
            yield
        finally:
            await app.state.hub.stop()
            _log.info("terminald 已停止")

    app = FastAPI(
        title="terminald",
        version=__version__,
        summary="pywezterm 支撑的持久会话网页终端",
        lifespan=lifespan,
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
    )
    app.state.settings = resolved
    app.include_router(rest.router)
    app.include_router(ws.router)

    web_dir = resolve_web_dir(resolved)
    if web_dir is None:
        _log.warning("未找到前端构建产物，'/' 将返回提示页（期望目录 %s）", DEFAULT_WEB_DIR)

        @app.get("/", include_in_schema=False)
        async def _placeholder() -> HTMLResponse:
            return HTMLResponse(_NOT_BUILT)
    else:
        # 挂在最后：/api 与 /ws 优先匹配，其余交给静态资源
        app.mount("/", StaticFiles(directory=web_dir, html=True), name="web")
        _log.info("静态资源目录: %s", web_dir)

    return app


__all__ = ["DEFAULT_WEB_DIR", "create_app", "resolve_web_dir"]
