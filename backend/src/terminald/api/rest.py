"""REST 路由。

刻意保持极薄：这里只做参数校验 + 调用 `Hub` + 把领域错误映射成 HTTP 状态码。
任何“业务判断”写在 Hub 里，这样 WS 与 REST 共享同一份语义。
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, Response, status

from .. import __version__
from ..core.errors import SessionNameConflict, SessionNotFound
from ..logs import get_logger
from ..protocol.messages import SessionInfo
from ..service.hub import Hub
from .schemas import CreateSessionRequest, HealthResponse

_log = get_logger(__name__)

router = APIRouter(prefix="/api", tags=["session"])


def _hub(request: Request) -> Hub:
    """取当前应用的 Hub。带上返回类型是必要的：否则每个路由的返回值都会退化成 Any，
    响应模型的静态检查与 `response_model` 校验就形同虚设。"""
    hub: Hub = request.app.state.hub
    return hub


@router.get("/healthz", response_model=HealthResponse, summary="探活")
async def healthz(request: Request) -> HealthResponse:
    hub = _hub(request)
    return HealthResponse(
        version=__version__,
        sessions=len(hub.session_infos()),
        clients=hub.client_count(),
    )


@router.get("/sessions", response_model=list[SessionInfo], summary="会话列表")
async def list_sessions(request: Request) -> list[SessionInfo]:
    return list(_hub(request).session_infos())


@router.post(
    "/sessions",
    response_model=SessionInfo,
    status_code=status.HTTP_201_CREATED,
    summary="新建会话",
)
async def create_session(request: Request, body: CreateSessionRequest) -> SessionInfo:
    try:
        return await _hub(request).create_session(name=body.name, argv=body.argv, cwd=body.cwd)
    except SessionNameConflict as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc


@router.delete(
    "/sessions/{session_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
    summary="关闭会话",
)
async def close_session(request: Request, session_id: str) -> Response:
    """关闭会话（幂等语义：不存在则 404）。"""
    try:
        await _hub(request).close_session(session_id)
    except SessionNotFound as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
    return Response(status_code=status.HTTP_204_NO_CONTENT)


__all__ = ["router"]
