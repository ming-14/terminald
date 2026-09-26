"""宿主拆除路径的单元测试（不需要真 PTY）。

`docs/audit.md` A13 的机制是「`ClosePseudoConsole` 等控制台客户端退出，而绑定层的
`close()` 持着 GIL 阻塞」——所以真实宿主的拆除必须是：**先终止整棵进程树，再关伪终端**。
顺序反了、或者整棵树没被终止，阻塞就会回来，而且它不是「某个线程慢」，是**整个解释器**
停摆（实测 236 秒，见 `runtime/winjob.py` 的模块文档）。

这里用替身把两件事钉死（真实 ConPTY 那一层由 `test_contract_pywezterm.py` 覆盖）：

1. 调用顺序：`adopt` → （关闭时）`terminate` → `pty.close` → `job.close`；
2. 纳入作业失败的处置策略：子进程**还活着**时失败必须抛出，不能静默降级。
"""

from __future__ import annotations

import ctypes
import os
import subprocess
import sys
from ctypes import wintypes
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from support import process_alive, wait_until
from terminald.core.ports import SessionSpec
from terminald.runtime import pywezterm_host, winjob


class _Recorder(list[str]):
    """按顺序记录调用；`assert calls == [...]` 就是顺序断言。"""


class FakeTree:
    """`winjob.ProcessTree` 的替身。"""

    def __init__(self, calls: _Recorder, *, adopt_error: OSError | None = None) -> None:
        self._calls = calls
        self._adopt_error = adopt_error

    def adopt(self, handle: int) -> None:
        self._calls.append(f"adopt:{handle}")
        if self._adopt_error is not None:
            raise self._adopt_error

    def terminate(self) -> None:
        self._calls.append("terminate")

    def close(self) -> None:
        self._calls.append("tree.close")


class FakePty:
    def __init__(self, calls: _Recorder, *, already_exited: bool = False) -> None:
        self._calls = calls
        self._already_exited = already_exited

    def spawn(self, argv: list[str], *, cwd: str | None, env: Any) -> tuple[int, int]:
        return 4242, 0xBEEF

    def try_wait(self) -> int | None:
        return 0 if self._already_exited else None

    def read(self, max_bytes: int = 8192, timeout: float = 0.2) -> bytes:
        return b""

    def write(self, data: bytes) -> None:
        self._calls.append("pty.write")

    def resize(self, cols: int, rows: int) -> None:
        # `PyweztermHost.resize` 会调它（底层是 ResizePseudoConsole）。本文件不测改尺寸，
        # 但替身要与真 `Pty` 的方法面同形——少了它，日后在这里加一条带 resize 的用例
        # 会以 AttributeError 失败，看起来像产品缺陷。
        self._calls.append(f"pty.resize:{cols}x{rows}")

    def kill(self) -> None:
        self._calls.append("pty.kill")

    def close(self) -> None:
        self._calls.append("pty.close")


def _host(
    monkeypatch: pytest.MonkeyPatch, calls: _Recorder, *, adopt_error: OSError | None = None
) -> pywezterm_host.PyweztermHost:
    pty = FakePty(calls)
    module = SimpleNamespace(Pty=lambda **_: pty, Terminal=lambda *_: SimpleNamespace())
    monkeypatch.setattr(pywezterm_host, "_require_pywezterm", lambda: module)
    monkeypatch.setattr(
        pywezterm_host.winjob, "create", lambda: FakeTree(calls, adopt_error=adopt_error)
    )
    return pywezterm_host.PyweztermHost(SessionSpec(argv=["x"], cols=80, rows=24))


def test_process_tree_is_terminated_before_the_console_is_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """顺序契约：`terminate` 必须在 `pty.close()` **之前**（否则又去等 ConPTY 了）。"""
    calls = _Recorder()
    host = _host(monkeypatch, calls)

    host.close()
    host.close()  # 幂等：拆除路径可能被重复走到

    assert calls == ["adopt:48879", "terminate", "pty.close", "tree.close"]


def test_kill_terminates_the_whole_tree(monkeypatch: pytest.MonkeyPatch) -> None:
    """`kill()` 也要杀整棵树：`Pty.kill()` 只杀直接子进程，孙子进程会继续握着控制台。"""
    calls = _Recorder()
    host = _host(monkeypatch, calls)

    host.kill()

    assert calls == ["adopt:48879", "terminate", "pty.kill"]


def test_adoption_failure_on_a_live_child_is_fatal(monkeypatch: pytest.MonkeyPatch) -> None:
    """纳管失败且子进程还活着 → 必须抛：静默降级等于把 A13 藏起来。"""
    calls = _Recorder()
    with pytest.raises(OSError):
        _host(monkeypatch, calls, adopt_error=OSError("拒绝访问"))


def test_adoption_failure_on_an_exited_child_is_tolerated(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """子进程已经跑完（毫秒级命令）时纳管失败是正常的：它自己就是整棵树。"""
    calls = _Recorder()
    module = SimpleNamespace(
        Pty=lambda **_: FakePty(calls, already_exited=True), Terminal=lambda *_: SimpleNamespace()
    )
    monkeypatch.setattr(pywezterm_host, "_require_pywezterm", lambda: module)
    monkeypatch.setattr(
        pywezterm_host.winjob,
        "create",
        lambda: FakeTree(calls, adopt_error=OSError("进程已退出")),
    )

    host = pywezterm_host.PyweztermHost(SessionSpec(argv=["x"], cols=80, rows=24))

    assert calls == ["adopt:48879"]
    host.close()
    assert calls[-2:] == ["pty.close", "tree.close"]


# --------------------------------------------------------------- 作业本身（真进程树）


def _process_handle(pid: int) -> int:
    """拿到可纳入作业的进程句柄（`AssignProcessToJobObject` 需要 SET_QUOTA + TERMINATE 权限）。"""
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    process_set_quota, process_terminate = 0x0100, 0x0001
    handle = kernel32.OpenProcess(process_set_quota | process_terminate, False, pid)
    if not handle:
        raise OSError(f"OpenProcess 失败: {ctypes.get_last_error()}")
    return int(handle)


@pytest.mark.skipif(os.name != "nt", reason="Job Object 是 Windows 机制")
def test_terminate_kills_grandchildren(tmp_path: Path) -> None:
    """`WinJob.terminate()` 必须杀掉**整棵树**（含孙子进程）——这是 A13 的修法本体。

    为什么不能只杀直接子进程：实测（`docs/audit.md` A13）`cmd /c start /b ping -t`
    残留的孙进程会让 `Pty.close()` 等 **298 秒**，而且那次等待**持着 GIL**——整个解释器停摆。
    """
    pid_file = tmp_path / "grandchild.pid"
    grandchild_code = "import time; time.sleep(60)"
    parent_code = (
        "import subprocess, sys, time\n"
        f"child = subprocess.Popen([sys.executable, '-c', {grandchild_code!r}])\n"
        f"open({str(pid_file)!r}, 'w').write(str(child.pid))\n"
        "time.sleep(60)\n"
    )
    parent = subprocess.Popen([sys.executable, "-c", parent_code])
    job = winjob.create()
    try:
        job.adopt(_process_handle(parent.pid))
        wait_until(pid_file.exists, 10.0, what="孙子进程上报 pid")
        grandchild = int(pid_file.read_text())
        assert process_alive(grandchild), "孙子进程应当在终止前活着（否则用例无效）"

        job.terminate()

        assert parent.wait(timeout=5) is not None, "直接子进程没被杀"
        wait_until(lambda: not process_alive(grandchild), 5.0, what="孙子进程退出")
    finally:
        job.close()
        parent.kill()


def test_failed_spawn_releases_the_tree(monkeypatch: pytest.MonkeyPatch) -> None:
    """启动失败也要不泄漏：作业句柄与 PTY 一起释放。"""
    calls = _Recorder()

    def explode(*_: Any, **__: Any) -> None:
        raise RuntimeError("spawn 失败")

    pty = FakePty(calls)
    monkeypatch.setattr(pty, "spawn", explode)
    module = SimpleNamespace(Pty=lambda **_: pty, Terminal=lambda *_: SimpleNamespace())
    monkeypatch.setattr(pywezterm_host, "_require_pywezterm", lambda: module)
    monkeypatch.setattr(pywezterm_host.winjob, "create", lambda: FakeTree(calls))

    with pytest.raises(RuntimeError):
        pywezterm_host.PyweztermHost(SessionSpec(argv=["x"], cols=80, rows=24))

    assert calls == ["terminate", "pty.close", "tree.close"]
