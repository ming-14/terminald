"""传输层测试（REST + WebSocket）。

这里验证的是**边界行为**：握手、协议版本、来源校验、帧形态、以及“断开连接不影响会话”。

关于线程：`TestClient` 在独立线程里跑事件循环，因此测试线程会直接触碰
`app.state.hub` 来喂输出。这不是随手取巧——真实场景里 PTY 输出本来就从别的线程来，
测试这样做反而更贴近生产路径。
"""

from __future__ import annotations

import threading
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from support import BlockingCloseHost, BlockingHost, make_settings, wait_until
from terminald.api import create_app
from terminald.protocol import PROTOCOL_VERSION, frames
from terminald.protocol.messages import (
    Focus,
    Hello,
    SessionCreate,
    SessionList,
    dump,
)
from terminald.runtime import make_host_factory


@pytest.fixture
def app() -> Any:
    settings = make_settings()
    return create_app(settings, host_factory=make_host_factory(settings.host_impl))


@pytest.fixture
def client(app: Any) -> Iterator[TestClient]:
    # base_url 决定 Host 头 → 来源校验要求它是回环地址
    with TestClient(app, base_url="http://127.0.0.1") as test_client:
        yield test_client


def connect(client: TestClient, **headers: str) -> Any:
    """连接 `/ws`。

    必须显式给出回环 `host`：`TestClient` 默认发 `Host: testserver`，而来源校验会
    （正确地）拒绝它。**不修改服务端校验来迁就测试**——那正是安全围栏失效的开端。
    """
    merged = {"host": "127.0.0.1", **headers}
    return client.websocket_connect("/ws", headers=merged)


# --------------------------------------------------------------- REST


def test_healthz(client: TestClient) -> None:
    response = client.get("/api/healthz")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["sessions"] == 0


def test_session_crud(client: TestClient) -> None:
    created = client.post("/api/sessions", json={"name": "one"})
    assert created.status_code == 201
    info = created.json()
    assert info["name"] == "one"
    assert (info["cols"], info["rows"]) == (80, 24)  # 尺寸来自服务端
    assert info["status"] == "running"

    listed = client.get("/api/sessions").json()
    assert [item["id"] for item in listed] == [info["id"]]

    assert client.delete(f"/api/sessions/{info['id']}").status_code == 204
    assert client.get("/api/sessions").json() == []


def test_duplicate_session_name_conflicts(client: TestClient) -> None:
    assert client.post("/api/sessions", json={"name": "dup"}).status_code == 201
    assert client.post("/api/sessions", json={"name": "dup"}).status_code == 409


def test_closing_unknown_session_is_404(client: TestClient) -> None:
    assert client.delete("/api/sessions/nope").status_code == 404


def test_rest_rejects_client_supplied_dimensions(client: TestClient) -> None:
    """REST 层不能接受 cols/rows：尺寸由终端侧决定，客户端不参与。"""
    response = client.post("/api/sessions", json={"name": "x", "cols": 200, "rows": 10})
    assert response.status_code == 422


def test_placeholder_page_is_served_without_build(client: TestClient) -> None:
    response = client.get("/")
    assert response.status_code == 200


# --------------------------------------------------------------- WS 握手


def test_handshake_returns_hello_ok(client: TestClient) -> None:
    with connect(client) as ws:
        ws.send_text(dump(Hello(client="test")))
        message = ws.receive_json()
        assert message["t"] == "hello_ok"
        assert message["protocol"] == PROTOCOL_VERSION


def test_protocol_mismatch_is_rejected(client: TestClient) -> None:
    with connect(client) as ws:
        ws.send_text('{"t": "hello", "protocol": 999}')
        message = ws.receive_json()
        assert message["t"] == "error"
        assert message["code"] == "protocol_mismatch"
        with pytest.raises(WebSocketDisconnect):
            ws.receive_json()


def test_foreign_origin_is_rejected_before_accept(client: TestClient) -> None:
    with pytest.raises(WebSocketDisconnect), connect(client, origin="https://evil.example"):
        pass


@pytest.mark.parametrize(
    ("payload", "reason"),
    [
        ('{"t": "session.list"}', "首条不是 hello"),
        ("{oops", "JSON 非法"),
        ("{}", "缺 t 字段"),
        ('{"t": "hello", "protocol": "one"}', "字段类型错"),
        ('{"t": "hello", "protocol": 1, "nope": 2}', "多余字段（extra=forbid）"),
    ],
)
def test_bad_hello_is_rejected_with_a_diagnosable_failure(
    client: TestClient, payload: str, reason: str
) -> None:
    """握手不合法必须给出 `error{code:bad_hello}` + 明确关闭码。

    这些异常以前会逃出 WS 端点：客户端**什么都收不到**、得到一个 1006 硬断，服务端每次
    留一条 ASGI traceback（见 docs/audit.md A3）。
    """
    with connect(client) as ws:
        ws.send_text(payload)
        failure = ws.receive_json()
        assert failure["t"] == "error", reason
        assert failure["code"] == "bad_hello", reason
        assert failure["message"], reason
        with pytest.raises(WebSocketDisconnect) as closed:
            while True:
                ws.receive_json()
        assert closed.value.code == 1002, reason


def test_binary_frame_before_handshake_is_ignored(client: TestClient) -> None:
    """握手前不接受二进制帧：丢弃而不是当成输入。"""
    with connect(client) as ws:
        ws.send_bytes(frames.encode_input(b"rm -rf /\r"))
        ws.send_text(dump(Hello()))
        assert ws.receive_json()["t"] == "hello_ok"


def test_malformed_control_message_yields_failure(client: TestClient) -> None:
    with connect(client) as ws:
        ws.send_text(dump(Hello()))
        assert ws.receive_json()["t"] == "hello_ok"
        ws.send_text('{"t": "attach"}')  # 缺 session
        failure = ws.receive_json()
        assert failure["t"] == "error"
        assert failure["code"] == "bad_message"


def test_malformed_binary_frame_closes_connection(client: TestClient) -> None:
    """帧解析失败意味着字节流已错位：断开比继续读更安全。"""
    with connect(client) as ws:
        ws.send_text(dump(Hello()))
        assert ws.receive_json()["t"] == "hello_ok"
        ws.send_bytes(b"\x00\x00\x00\x02\x7f\x00")  # 未知标签
        with pytest.raises(WebSocketDisconnect):
            ws.receive_json()


# --------------------------------------------------------------- WS 全链路


def test_full_flow_create_attach_output_input(client: TestClient, app: Any) -> None:
    hub = app.state.hub
    with connect(client) as ws:
        ws.send_text(dump(Hello(client="pytest")))
        assert ws.receive_json()["t"] == "hello_ok"

        ws.send_text(dump(SessionList()))
        assert ws.receive_json()["t"] == "sessions"

        ws.send_text(dump(SessionCreate(name="console")))
        listing = ws.receive_json()
        assert listing["t"] == "sessions"
        assert [item["name"] for item in listing["items"]] == ["console"]
        session_id = listing["items"][0]["id"]

        attached = ws.receive_json()
        assert attached["t"] == "attached"
        assert (attached["cols"], attached["rows"]) == (80, 24)
        assert attached["offset"] == 0

        # 输出：从内容真源（日志）流向客户端，原样透传
        session = hub.get_session(session_id)
        session.host.feed(b"\x1b[32mok\x1b[0m\r\n")
        frame = ws.receive_bytes()
        ((tag, offset, payload),) = frames.iter_frames(frame)
        assert tag is frames.FrameTag.OUTPUT
        assert offset == 0
        assert bytes(payload) == b"\x1b[32mok\x1b[0m\r\n"

        # 输入：二进制帧 → PTY
        ws.send_bytes(frames.encode_input(b"echo hi\r"))
        wait_until(lambda: b"echo hi\r" in bytes(session.host.written))

        # 焦点被聚合后下发给应用
        ws.send_text(dump(Focus(focused=True)))
        wait_until(lambda: b"\x1b[I" in session.host.responses)


def test_disconnect_keeps_session_alive(client: TestClient, app: Any) -> None:
    hub = app.state.hub
    session_id = client.post("/api/sessions", json={"name": "keep"}).json()["id"]
    session = hub.get_session(session_id)

    with connect(client) as ws:
        ws.send_text(dump(Hello()))
        assert ws.receive_json()["t"] == "hello_ok"
        ws.send_text(f'{{"t": "attach", "session": "{session_id}"}}')
        assert ws.receive_json()["t"] == "attached"

    wait_until(lambda: session.subscribers == ())
    assert hub.find_session(session_id) is not None  # 连接断开不影响会话
    session.host.feed(b"still running")
    wait_until(lambda: session.journal.end_offset > 0)


# --------------------------------------------------------------- 输入背压（传输层反应）


def test_ignoring_input_hold_closes_the_connection_without_losing_bytes() -> None:
    """输入越限：显式告知原因 + 以 1009 断开，且**已收下的字节一个不丢**。

    构造：宿主写会阻塞（子进程不读 stdin）→ 写队列只累积；客户端无视 `input_hold`
    继续灌到硬上限。传输层必须断开（否则服务端内存被无视协议的客户端拖爆），但断开
    只能断在“连接”这一层：已经进入写队列的字节仍然会被写完（会话不受影响）。
    """
    settings = make_settings(
        input_high_bytes=64 * 1024, input_low_bytes=8 * 1024, input_hard_bytes=128 * 1024
    )
    hosts: list[Any] = []

    def factory(spec: Any) -> Any:
        host = BlockingHost(spec, echo=False)
        hosts.append(host)
        return host

    app = create_app(settings, host_factory=factory)
    with TestClient(app, base_url="http://127.0.0.1") as client:
        with connect(client) as ws:
            ws.send_text(dump(Hello()))
            assert ws.receive_json()["t"] == "hello_ok"
            ws.send_text(dump(SessionCreate(name="stuck")))
            assert ws.receive_json()["t"] == "sessions"
            assert ws.receive_json()["t"] == "attached"

            for _ in range(12):
                ws.send_bytes(frames.encode_input(b"x" * (16 * 1024)))

            seen: list[dict[str, Any]] = []
            with pytest.raises(WebSocketDisconnect) as closed:
                while True:
                    seen.append(ws.receive_json())
            assert closed.value.code == 1009  # 消息过大：服务端接不下更多输入
            overflow = [m for m in seen if m["t"] == "error" and m["code"] == "input_overflow"]
            assert overflow, "越限必须带着原因显式断开，不能只有一条冷冰冰的关闭帧"

        host = hosts[0]
        host.write_gate.set()
        # 写队列里的字节（这份连接已收下的全部输入）仍会被写完
        wait_until(lambda: len(host.written) >= 128 * 1024)
        assert set(bytes(host.written)) == {ord("x")}


# --------------------------------------------------------------- 拆除路径（A13 回归）


def test_deleting_a_session_does_not_freeze_http() -> None:
    """A13 回归（用户看到的那个症状）：删一个会话不得冻住整个服务。

    构造：宿主的 `close()` 停在闸上（真实场景 = `ClosePseudoConsole` 等控制台客户端退出，
    实测 236 秒）。断言两件事：

    1. 删除请求悬在释放上时，**其他 HTTP 请求照常被服务**（以前这里是整个服务停摆）；
    2. 列表里那个会话**立刻消失**——摘除在阻塞释放之前，多客户端不必陪着它等。
    """
    hosts: list[BlockingCloseHost] = []

    def factory(spec: Any) -> BlockingCloseHost:
        host = BlockingCloseHost(spec)
        hosts.append(host)
        return host

    app = create_app(make_settings(), host_factory=factory)
    with TestClient(app, base_url="http://127.0.0.1") as client:
        session_id = client.post("/api/sessions", json={"name": "stuck"}).json()["id"]
        status: list[int] = []
        deleter = threading.Thread(
            target=lambda: status.append(client.delete(f"/api/sessions/{session_id}").status_code)
        )
        deleter.start()
        try:
            wait_until(hosts[0].close_entered.is_set)
            assert client.get("/api/sessions").json() == [], "事件循环在拆除期间停摆了"
            assert client.get("/api/healthz").json()["sessions"] == 0
            assert deleter.is_alive(), "用例没构造出压力：删除应当还停在闸上"
        finally:
            hosts[0].close_gate.set()
            deleter.join(timeout=10)
        assert status == [204]


def test_reconnect_resumes_from_client_offset(client: TestClient, app: Any) -> None:
    """刷新恢复：第二次连接带上本地偏移，只补断档。"""
    hub = app.state.hub
    session_id = client.post("/api/sessions", json={"name": "resume"}).json()["id"]
    session = hub.get_session(session_id)
    session.host.feed(b"before")
    # 日志偏移就是栅栏：追平到 6 字节即可。无需在栅栏之后再等一段时间——
    # `_ingest_output` 是一个原子步，所以偏移可观察时推送决策也已发生。
    wait_until(lambda: session.journal.end_offset == 6, what="输出并入日志（6 字节）")

    with connect(client) as ws:
        ws.send_text(dump(Hello()))
        ws.receive_json()
        ws.send_text(f'{{"t": "attach", "session": "{session_id}", "resume": 6}}')
        attached = ws.receive_json()
        assert attached["t"] == "attached"
        assert attached["resumed"] is True

        session.host.feed(b"after")
        frame = ws.receive_bytes()
        offset, payload = frames.decode_output(frame)
        assert offset == 6  # 没有重发已知字节
        assert bytes(payload) == b"after"
