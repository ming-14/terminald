"""pywezterm **绑定层**的契约测试（跑在真实扩展上）。

与 `test_contract_pywezterm.py` 的分工：那个文件验证的是我们自己的适配器
（`PyweztermHost`）；这个文件验证的是被适配的那一层——`Pty` / `Terminal` 本身的行为。
三处都对应本轮改过的绑定层缺陷：

1. 读缓冲无界 → 背压到不了 PTY
2. `write` 持 GIL 阻塞 → 子进程不读会把整个进程卡死
3. 模式恢复只覆盖 4 类 → 走过快照重建的客户端模式是错的

每条用例都刻意构造成**修复前必然失败**的形态，否则它证明不了任何事。
"""

from __future__ import annotations

import os
import sys
import threading
import time

import pytest

pytestmark = pytest.mark.contract

try:
    import pywezterm
except ImportError:  # pragma: no cover - 取决于环境
    pywezterm = None  # type: ignore[assignment]

pytestmark = [
    pytest.mark.contract,
    pytest.mark.skipif(pywezterm is None, reason="未安装 pywezterm 本地 wheel"),
]


# ============================================================ 1. 背压


#: 本用例自身的设计预算就是 8s 压力 + 最多 90s 排空，远超 pyproject 的全局 60s 超时；
#: 这里显式放宽，避免它偶尔撞上全局超时被误报成缺陷。
@pytest.mark.timeout(180)
def test_read_buffer_is_bounded_under_a_flood() -> None:
    """读缓冲必须有上限：不消费输出时它只能停在高水位附近。

    这是「背压」的可观测形态。**为什么不能只断言「子进程被逼停」**：Windows 上
    ConPTY 自己就是一层终端模拟器，它会把子进程的输出先渲染再吐出来，管道因此天然会被
    它卡住——也就是说「子进程停了」这件事在修复前也成立，单看它根本证伪不了。
    真正能区分的只有一件事：**我们自己的缓冲有没有上限**。

    修复前 reader 会把管道抽干塞进无界 `VecDeque`，`buffered_bytes()` 会一路涨到
    整个输出量。修复后它停在高水位（1 MiB）附近。
    """
    high_water = 1 << 20
    flood = 32 * 1024 * 1024
    pty = pywezterm.Pty(cols=80, rows=24)
    try:
        pty.spawn(
            [
                sys.executable,
                "-c",
                f"import sys;sys.stdout.buffer.write(b'x'*{flood});sys.stdout.flush()",
            ]
        )
        deadline = time.monotonic() + 8.0
        peak = 0
        while time.monotonic() < deadline:
            peak = max(peak, pty.buffered_bytes())
            time.sleep(0.05)
        # 允许一点余量：reader 可能刚好在读第 n+1 块
        assert peak <= 2 * high_water, (
            f"不消费输出时缓冲涨到 {peak} 字节（高水位 {high_water}）—— 读缓冲没有上限，"
            "背压到不了 PTY"
        )
        assert peak > 0, "一个字节都没进缓冲，说明这个用例没构造出压力"

        # 恢复消费：字节一个不少，子进程正常退出
        received = 0
        deadline = time.monotonic() + 90.0
        while time.monotonic() < deadline:
            chunk = pty.read(256 * 1024, 0.5)
            received += len(chunk)
            code = pty.try_wait()
            if code is not None and not chunk:
                break
        assert pty.try_wait() == 0, pty.try_wait()
        # 只能断言「不少于写入量」：ConPTY 自己也会往管道里插东西（清屏、换行重排、
        # OSC 0 标题……），所以总字节数**不是**写入量的函数，严格相等是个假不变量。
        # 「一个字节都没丢」由读缓冲的上限 + 恢复消费后子进程正常退出来保证。
        assert received >= flood, f"恢复消费后只读到 {received}，少于写入的 {flood}"
    finally:
        pty.close()


# ============================================================ 2. GIL


def test_write_does_not_hold_the_gil_while_blocking() -> None:
    """阻塞写不能占着 GIL：否则子进程停止读取输入时，整个解释器一起卡死。

    **构造要小心，否则会得到一个恒真的假用例**（真踩过）：必须确保测量窗口**覆盖真正的
    阻塞期**。所以这里先等 0.3s 让写线程进入阻塞、断言它确实还在进行中，然后一直观察到
    写结束为止。

    Windows/ConPTY 下写入确实会阻塞（实测 1 MB ≈ 4s、8 MB ≈ 30s），所以这条缺陷在本地
    可观测：修复前主线程连一次迭代都跑不动（实测心跳 0），修复后每毫秒一次心跳。
    """
    pty = pywezterm.Pty(cols=80, rows=24)
    try:
        pty.spawn([sys.executable, "-c", "import time;time.sleep(300)"])

        state: dict[str, object] = {"writing": True, "error": ""}

        def blocked_writer() -> None:
            try:
                # 1 MB 已足以在 ConPTY 下阻塞数秒
                pty.write(b"x" * (1 * 1024 * 1024))
            except Exception as exc:
                state["error"] = f"{type(exc).__name__}: {exc}"
            finally:
                state["writing"] = False

        writer = threading.Thread(target=blocked_writer, daemon=True)
        writer.start()

        # 让写线程真正进入阻塞，否则窗口是空的（这正是先前那个假用例的毛病）
        time.sleep(0.3)
        assert state["writing"] is True, (
            f"写没有阻塞（错误={state['error']}），本用例无法验证 GIL 行为 —— "
            "换个更大的写入量或检查 ConPTY 是否在消费输入"
        )

        # 窗口覆盖整个阻塞期
        started = time.monotonic()
        ticks = 0
        while state["writing"] and time.monotonic() - started < 30.0:
            ticks += 1
            time.sleep(0.001)
        window = time.monotonic() - started

        assert window > 0.3, f"观察窗口只有 {window:.3f}s，太短不足以下结论"
        assert ticks > 100, (
            f"{window:.2f}s 的阻塞写期间主线程只跑了 {ticks} 次心跳 —— "
            "写操作占着 GIL，必须放掉（py.detach）"
        )
    finally:
        pty.close()


# ============================================================ 3. 模式恢复


def test_mode_restore_is_empty_when_nothing_was_set() -> None:
    """没观察过任何模式时，恢复序列必须是空的。

    若用「我们以为的默认值」去填，就会把客户端自己的默认值与配置覆盖掉
    （例如客户端把光标闪烁打开着，却被我们一句 `?12l` 关掉）。
    """
    term = pywezterm.Terminal(80, 24, 100)
    assert term.mode_restore_seq() == ""


@pytest.mark.parametrize(
    ("sequence", "expected"),
    [
        (b"\x1b[?2004h", "\x1b[?2004h"),  # bracketed paste
        (b"\x1b[?1004h", "\x1b[?1004h"),  # 焦点上报
        (b"\x1b[?7l", "\x1b[?7l"),  # 自动换行关
        (b"\x1b[?45h", "\x1b[?45h"),  # 反向换行
        (b"\x1b[?12h", "\x1b[?12h"),  # 光标闪烁开
        (b"\x1b[?12l", "\x1b[?12l"),  # 光标闪烁关
        (b"\x1b[?1h", "\x1b[?1h"),  # 应用光标键
        (b"\x1b[?6h", "\x1b[?6h"),  # 原点模式
        (b"\x1b[4h", "\x1b[4h"),  # 插入模式（SM，没有 ? 前缀）
        (b"\x1b[20h", "\x1b[20h"),  # LNM（SM）
        (b"\x1b[?1000h", "\x1b[?1000h"),  # 鼠标追踪 1000
        (b"\x1b[?1002h", "\x1b[?1002h"),  # 鼠标追踪 1002
    ],
)
def test_mode_restore_covers_each_observed_mode(sequence: bytes, expected: str) -> None:
    """凡是应用设过、且客户端能生效的模式，恢复序列里都要出现。"""
    term = pywezterm.Terminal(80, 24, 100)
    term.feed(sequence)
    assert expected in term.mode_restore_seq()


def test_mouse_encoding_modes_come_with_tracking() -> None:
    """SGR 编码（1006）与像素坐标（1016）只在鼠标追踪打开时才有意义。

    因此它们跟着追踪模式一起恢复；单独设 `?1016h` 而不开追踪时不发——
    孤立的编码模式对客户端没有任何作用，发过去只是噪声。
    """
    term = pywezterm.Terminal(80, 24, 100)
    term.feed(b"\x1b[?1002h\x1b[?1006h\x1b[?1016h")
    restore = term.mode_restore_seq()
    assert "\x1b[?1002h" in restore
    assert "\x1b[?1006h" in restore
    assert "\x1b[?1016h" in restore

    lone = pywezterm.Terminal(80, 24, 100)
    lone.feed(b"\x1b[?1016h")
    assert lone.mode_restore_seq() == ""


def test_mode_restore_does_not_emit_synchronized_output() -> None:
    """`?2026`（同步输出）**不能**出现在恢复序列里。

    它是逐帧的瞬时模式：把它打开会让客户端一直缓冲渲染，等于把画面冻住。
    """
    term = pywezterm.Terminal(80, 24, 100)
    term.feed(b"\x1b[?2026h")
    assert "\x1b[?2026" not in term.mode_restore_seq()


def test_mode_sequence_split_across_feeds_is_still_tracked() -> None:
    """模式序列被 feed 边界切开也必须认得出来（跨 feed 的尾部窗口）。"""
    term = pywezterm.Terminal(80, 24, 100)
    term.feed(b"\x1b[?20")
    term.feed(b"04h")
    assert "\x1b[?2004h" in term.mode_restore_seq()


def test_non_mode_csi_does_not_pollute_state() -> None:
    """普通 CSI（如 CUP `CSI 1;2H`）不能被误认成模式设置。"""
    term = pywezterm.Terminal(80, 24, 100)
    term.feed(b"\x1b[1;2H")
    term.feed(b"\x1b[31m")
    term.feed(b"\x1b[2J")
    assert term.mode_restore_seq() == ""


def test_alt_screen_comes_first_and_cursor_visibility_last() -> None:
    """顺序约束：备用屏最先（它会清屏），光标可见性最后（不影响绘制）。"""
    term = pywezterm.Terminal(80, 24, 100)
    term.feed(b"\x1b[?1049h")
    term.feed(b"\x1b[?2004h")
    term.feed(b"\x1b[?25l")
    restore = term.mode_restore_seq()
    assert restore.startswith("\x1b[?1049h"), restore
    assert restore.endswith("\x1b[?25l"), restore


def test_turning_a_mode_back_off_is_reflected() -> None:
    """模式被关回去后，恢复序列里不应再保留它。"""
    term = pywezterm.Terminal(80, 24, 100)
    term.feed(b"\x1b[?2004h")
    assert "\x1b[?2004h" in term.mode_restore_seq()
    term.feed(b"\x1b[?2004l")
    assert "\x1b[?2004h" not in term.mode_restore_seq()
    term.feed(b"\x1b[?7l")
    assert "\x1b[?7l" in term.mode_restore_seq()
    term.feed(b"\x1b[?7h")
    assert "\x1b[?7l" not in term.mode_restore_seq()


def test_mouse_mode_encoding_accessor_is_not_confused_by_options() -> None:
    """`get_mouse_encoding` 在未观察到鼠标模式时必须报「关闭」。"""
    term = pywezterm.Terminal(80, 24, 100)
    assert term.get_mouse_encoding() == (0, False)
    assert term.is_mouse_grabbed() is False
    term.feed(b"\x1b[?1002h\x1b[?1006h")
    assert term.get_mouse_encoding() == (1002, True)
    assert term.is_mouse_grabbed() is True


def test_windows_pty_reports_its_platform_facts() -> None:
    """顺带钉住平台事实：POSIX 上 handle 恒为 0、Windows 上不是。"""
    pty = pywezterm.Pty(cols=80, rows=24)
    try:
        argv = (
            ["/bin/sh", "-c", "true"]
            if os.name == "posix"
            else [os.environ.get("COMSPEC", "cmd.exe"), "/c", "exit"]
        )
        _pid, handle = pty.spawn(argv)
        if os.name == "posix":
            assert handle == 0
        else:
            assert handle != 0
    finally:
        pty.close()
