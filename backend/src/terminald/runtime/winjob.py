"""Windows Job Object —— 让会话的进程树能够被**有界地整体终止**。

## 为什么需要它（根因）

`Pty.close()` 的内部是 `ClosePseudoConsole`，它会等最后一批控制台客户端（conhost 的客户）
退出。而绑定层的 `close()` **不释放 GIL**（`pywezterm/src/pty.rs` 的 `fn close(&self)`
既没有 `py.detach`，也不接受 `py` 参数），所以这次等待会饿死**整个解释器**的所有线程——
把它挪到别的线程**完全没有作用**。实测（`docs/audit.md` A13）：控制台被孙子进程握着时
`close()` 阻塞 **236.7 秒**，同一时刻主线程的调度间隔也是 **236.7 秒**。

因此唯一正确的修法是让这次等待不发生：**先把进程树的每个成员终止，再关伪终端**。
`Pty.kill()` 只杀直接子进程（`cmd /c start /b <程序>` 这类写法会留下握着控制台的孙子进程），
所以这里用 Job Object 接管整棵树：

- `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`：服务进程无论怎么退出（含崩溃），成员都被回收，
  不留孤儿进程；
- `AssignProcessToJobObject`：子进程创建后立刻纳入，其**后续后代自动继承成员资格**；
- `TerminateJobObject`：一次终止全部成员，**有界**（实测 1 毫秒）。

绑定层为此专门暴露了 `child_handle()`（注释写明「Job 注册用」）——这里就是它的用途。

## 非 Windows 平台

POSIX 的 `Pty.close()` 只关文件描述符，不存在 ConPTY 这条等待链，因此返回 `NullJob`
（三个方法都是空操作），把平台差异收在同一个接口后面，调用点不必分平台。
"""

from __future__ import annotations

import ctypes
import os
from ctypes import wintypes
from typing import Protocol

__all__ = ["NullJob", "ProcessTree", "WinJob", "create"]

_IS_WINDOWS = os.name == "nt"

#: 最后一个句柄关闭时终止成员：进程崩溃也不会留下孤儿
_JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
_JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9


class ProcessTree(Protocol):
    """一个会话的进程树容器：纳入成员 → 整体终止 → 释放。"""

    def adopt(self, handle: int) -> None:
        """纳入子进程（其后续后代自动继承）。失败抛 `OSError`。"""

    def terminate(self) -> None:
        """终止容器内全部成员。有界、幂等。"""

    def close(self) -> None:
        """释放容器句柄。幂等。"""


class NullJob:
    """非 Windows 实现：没有需要整体终止的东西（见模块文档）。"""

    def adopt(self, handle: int) -> None:
        pass

    def terminate(self) -> None:
        pass

    def close(self) -> None:
        pass


class _IoCounters(ctypes.Structure):
    _fields_ = [
        ("ReadOperationCount", ctypes.c_ulonglong),
        ("WriteOperationCount", ctypes.c_ulonglong),
        ("OtherOperationCount", ctypes.c_ulonglong),
        ("ReadTransferCount", ctypes.c_ulonglong),
        ("WriteTransferCount", ctypes.c_ulonglong),
        ("OtherTransferCount", ctypes.c_ulonglong),
    ]


class _BasicLimitInformation(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_longlong),
        ("PerJobUserTimeLimit", ctypes.c_longlong),
        ("LimitFlags", wintypes.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", wintypes.DWORD),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", wintypes.DWORD),
        ("SchedulingClass", wintypes.DWORD),
    ]


class _ExtendedLimitInformation(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", _BasicLimitInformation),
        ("IoInfo", _IoCounters),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


def _kernel32() -> ctypes.WinDLL:
    """取 kernel32 并钉住签名。

    必须显式声明 `argtypes`/`restype`：句柄在 64 位下是 8 字节，ctypes 默认按 `int`
    （4 字节）传参会把高位截断——那不会报错，只会拿到一个无效句柄。
    """
    raw = ctypes.WinDLL("kernel32", use_last_error=True)
    raw.CreateJobObjectW.argtypes = [wintypes.LPVOID, wintypes.LPCWSTR]
    raw.CreateJobObjectW.restype = wintypes.HANDLE
    raw.SetInformationJobObject.argtypes = [
        wintypes.HANDLE,
        ctypes.c_int,
        wintypes.LPVOID,
        wintypes.DWORD,
    ]
    raw.SetInformationJobObject.restype = wintypes.BOOL
    raw.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    raw.AssignProcessToJobObject.restype = wintypes.BOOL
    raw.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
    raw.TerminateJobObject.restype = wintypes.BOOL
    raw.CloseHandle.argtypes = [wintypes.HANDLE]
    raw.CloseHandle.restype = wintypes.BOOL
    return raw


class WinJob:
    """Windows Job Object 的薄封装（只用 ctypes，不引入第三方依赖）。

    线程约定：只被**会话拆除路径**调用，因此不做内部加锁；`terminate()` / `close()`
    必须幂等（拆除路径可能被重复走到，幂等由 `Registry.close` 的语义要求）。
    """

    def __init__(self) -> None:
        self._kernel32 = _kernel32()
        handle = self._kernel32.CreateJobObjectW(None, None)
        if not handle:
            raise ctypes.WinError(ctypes.get_last_error())
        self._handle = int(handle)
        info = _ExtendedLimitInformation()
        info.BasicLimitInformation.LimitFlags = _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not self._kernel32.SetInformationJobObject(
            wintypes.HANDLE(self._handle),
            _JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            ctypes.byref(info),
            ctypes.sizeof(info),
        ):
            error = ctypes.get_last_error()
            self.close()
            raise ctypes.WinError(error)
        self._terminated = False

    @property
    def handle(self) -> int:
        """作业句柄；已释放为 0。"""
        return self._handle

    def adopt(self, handle: int) -> None:
        """把进程纳入作业；`handle` 为 0（无句柄）时什么都不做。

        失败抛 `OSError`。**调用方**决定失败是否可接受：毫秒级的 `cmd /c echo` 完全可能
        在这两行之间跑完，此时纳入失败只说明「没有东西可管」。这个判断需要 `try_wait()`，
        所以留在宿主里而不是藏在这里——静默降级正是 A13 那种「进程树杀不掉」的成因。
        """
        if not self._handle or not handle:
            return
        if not self._kernel32.AssignProcessToJobObject(
            wintypes.HANDLE(self._handle), wintypes.HANDLE(handle)
        ):
            raise ctypes.WinError(ctypes.get_last_error())

    def terminate(self) -> None:
        if not self._handle or self._terminated:
            return
        self._terminated = True
        if not self._kernel32.TerminateJobObject(wintypes.HANDLE(self._handle), 1):
            raise ctypes.WinError(ctypes.get_last_error())

    def close(self) -> None:
        if not self._handle:
            return
        handle, self._handle = self._handle, 0
        self._kernel32.CloseHandle(wintypes.HANDLE(handle))


def create() -> ProcessTree:
    """给一个会话创建进程树容器（Windows：真作业；其他平台：空实现）。"""
    return WinJob() if _IS_WINDOWS else NullJob()
