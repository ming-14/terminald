"""同步纪律的机器化执行——「测试怎么等」这件事必须会红，才会被遵守。

与 `test_layering.py` 同一个理由：只写在文档里的约定等于没有。

背景（`docs/audit.md` §2.9）：这套测试原先用 `settle()`（固定 `asyncio.sleep(0.15)`）
来“等一等”，46 处调用点里有相当一部分压在**否定断言**前面。固定睡眠有两个毛病：

1. 等到的不是事件、而是时间 ⇒ 机器一被抢占就假红（一条无法归因的 pytest 红由此而来）；
2. 失败信息为零 ⇒ 分不清“没发生”和“还没发生”。

改法是把每个等待换成管道上真实存在的栅栏（`feed` / `writes_drained` / `wait_for` / `turn`）。
而栅栏之所以成立，靠的是三处**代码里的不变量**，所以它们也必须被机器盯住：

- 控制面处理函数不是协程，且内部无 await ⇒ `await handle_message(...)` 返回时副作用已完成；
- `Hub._ingest_output` 同理是原子步 ⇒ 日志偏移可观察时，推送决策已经发生；
- `SessionRunner._release` 只在 `host.write()` 返回之后扣减 ⇒ `pending_bytes == 0` 即写入已完成。

这个文件还会拦住“把固定睡眠再写回来”。
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

TESTS_DIR = Path(__file__).resolve().parent
SOURCE = TESTS_DIR.parent / "src" / "terminald"
HUB_PATH = SOURCE / "service" / "hub.py"
RUNNER_PATH = SOURCE / "runtime" / "runner.py"

#: 这些用例等的是**真实操作系统**事件（子进程启动/控制台附着/进程退出），
#: 那里没有可观察的内部状态可以做成栅栏，固定等待是唯一手段 —— 故豁免。
REAL_OS_TESTS = frozenset(
    {
        "test_binding_pywezterm.py",
        "test_contract_pywezterm.py",
        "test_host_teardown.py",
    }
)

#: 允许存在 sleep 的函数：轮询间隔只是“多久检查一次”，不承载正确性。
POLL_HELPERS = frozenset({"wait_for", "wait_until"})

#: 这些模块的 `sleep` 才算“当同步手段用”（`time.sleep` 也可能出现在被生成的子进程脚本里）。
SLEEP_MODULES = frozenset({"asyncio", "time", "anyio", "trio"})

#: 这些 Hub 方法必须是**同步且无 await** 的：测试的同步点建立在“返回即副作用完成”上。
SYNC_CONTROL_PLANE: dict[str, str] = {
    "_ingest_output": "输出栅栏的依据：日志偏移可观察 ⇒ 推送已发生",
    "_push_client": "推送本身（水位/窗口判定）",
    "_send": "控制消息入队",
    "_broadcast": "向订阅者扇出",
    "_fail": "错误回复",
    "_apply_focus": "焦点聚合后的应答",
    "_on_focus": "焦点消息处理",
    "_on_ack": "Ack 推进推送窗口",
    "_on_attach": "订阅",
    "_on_detach": "解除订阅",
    "_on_resync": "重同步",
    "_on_session_rename": "改名后广播会话列表",
    "_publish_sessions": "会话列表扇出",
    "_declare_gap": "显式宣告落后",
    "_push_snapshot": "重建快照入队",
}


def _is_sleep_call(node: ast.Call) -> bool:
    """`asyncio.sleep(...)` / `time.sleep(...)` 这类调用。"""
    func = node.func
    if not isinstance(func, ast.Attribute) or func.attr != "sleep":
        return False
    return isinstance(func.value, ast.Name) and func.value.id in SLEEP_MODULES


def _is_zero_sleep(node: ast.Call) -> bool:
    """`sleep(0)`：语义是“让出一轮”，不是“等一段时间”，因此不算固定睡眠。"""
    first = node.args[0] if node.args else None
    return isinstance(first, ast.Constant) and first.value == 0


def _enclosing_function(tree: ast.Module, lineno: int) -> str | None:
    """覆盖该行的**最内层**函数名（没有则为 None）。"""
    best: tuple[int, str] | None = None
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            end = node.end_lineno or node.lineno
            if node.lineno <= lineno <= end:
                span = end - node.lineno
                if best is None or span <= best[0]:
                    best = (span, node.name)
    return best[1] if best else None


def _fixed_sleeps(path: Path) -> list[str]:
    """该文件里“当同步手段用”的 sleep 调用（轮询辅助函数里的间隔除外）。"""
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    found: list[str] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not _is_sleep_call(node) or _is_zero_sleep(node):
            continue
        if _enclosing_function(tree, node.lineno) in POLL_HELPERS:
            continue
        found.append(f"第 {node.lineno} 行")
    return found


def test_no_fixed_sleeps_outside_polling_helpers() -> None:
    """测试里不许把“睡一会儿”当同步手段。

    等什么就用什么栅栏：`feed()`（输出已并入日志）、`writes_drained()`（写入已落到宿主）、
    `wait_for()`（任意可观察条件）、`turn()`（事件循环把手头回调跑完一轮）。
    """
    offenders: list[str] = []
    for path in sorted(TESTS_DIR.glob("*.py")):
        if path.name in REAL_OS_TESTS:
            continue
        offenders.extend(f"{path.name}:{where}" for where in _fixed_sleeps(path))

    assert not offenders, (
        "把固定睡眠当同步手段（等到的会是时间而不是事件）：\n  "
        + "\n  ".join(offenders)
        + f"\n用例请改用具名栅栏；轮询间隔只能留在 {sorted(POLL_HELPERS)} 里。"
    )


def test_real_os_exemptions_still_exist() -> None:
    """豁免名单不能变成僵尸——文件没了就该清理，避免它悄悄豁免掉别的东西。"""
    missing = sorted(name for name in REAL_OS_TESTS if not (TESTS_DIR / name).exists())
    assert not missing, f"豁免名单里的文件已不存在：{missing}"


def _class_methods(
    path: Path, class_name: str
) -> dict[str, ast.FunctionDef | ast.AsyncFunctionDef]:
    """某个类里的方法（只看类体，不含嵌套函数）。"""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name == class_name:
            return {
                item.name: item
                for item in node.body
                if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef))
            }
    raise AssertionError(f"{path.name} 里找不到 {class_name} 类")


def _hub_methods() -> dict[str, ast.FunctionDef | ast.AsyncFunctionDef]:
    return _class_methods(HUB_PATH, "Hub")


def _await_lines(node: ast.AST) -> list[int]:
    """这个节点里的 await 所在行（空列表 = 该段没有让出事件循环的点）。"""
    return sorted(item.lineno for item in ast.walk(node) if isinstance(item, ast.Await))


@pytest.mark.parametrize(("name", "reason"), sorted(SYNC_CONTROL_PLANE.items()))
def test_control_plane_effects_are_complete_on_return(name: str, reason: str) -> None:
    """`await handle_message(...)` 返回时，这条消息的副作用必须**已经发生**。

    测试里大量“发一条消息 → 紧接着断言结果”的写法都建立在这条上（分发是同步调用）。
    把其中任何一个改成 `async def`、或在中间塞进 await，那些断言就退化成“看运气”。
    """
    method = _hub_methods().get(name)
    assert method is not None, f"Hub.{name} 不存在了（用例的同步依据随之消失）：{reason}"
    assert not isinstance(method, ast.AsyncFunctionDef), (
        f"Hub.{name} 变成了协程：{reason}。调用方不再等待它，"
        "“返回即副作用已完成”不再成立——请连同调用点一起改回同步，或改掉依赖它的断言"
    )
    awaits = _await_lines(method)
    assert not awaits, (
        f"Hub.{name} 里出现 await（行 {awaits}）：{reason}。"
        "await 之后的那半段副作用不再与“消息处理完成”同步，测试的栅栏会漏掉它"
    )


def test_process_exit_branch_is_atomic() -> None:
    """`EXITED` 的可见性与它引发的广播必须在同一事件循环步内完成。

    `test_process_exit_keeps_session_and_content` 用 `wait_for(status is EXITED)` 当栅栏，
    随后断言客户端已收到 `Exited`——这条断言的合法性完全取决于“置状态与广播之间没有 await”。
    """
    pump = _hub_methods().get("_pump_loop")
    assert pump is not None, "hub.py 里找不到 _pump_loop"

    branch = next(
        (
            node
            for node in ast.walk(pump)
            if isinstance(node, ast.If) and "ProcessExited" in ast.unparse(node.test)
        ),
        None,
    )
    assert branch is not None, "`_pump_loop` 里找不到 ProcessExited 分支（用例的栅栏依据没了）"

    awaits = _await_lines(branch)
    assert not awaits, (
        f"ProcessExited 分支里出现 await（行 {awaits}）："
        "置 EXITED 与广播之间一旦让出事件循环，"
        "`wait_for(status is EXITED)` 就不再是“广播也已完成”的栅栏"
    )


def test_write_fence_counts_a_write_only_after_it_landed() -> None:
    """写栅栏的依据：`_release()` 在 `host.write()` 返回之后（异常路径也一样）才扣减计数。

    `writes_drained()` 等到 `pending_bytes == 0` 就放行，这条推理只在“扣减发生在写之后”
    时成立。把扣减挪到写之前（“先记账再写”看着更整齐），字节还没落到宿主、计数就已归零，
    栅栏会提前放行——它后面那些否定断言随之退回成永远为真的空断言。
    """
    write_loop = _class_methods(RUNNER_PATH, "SessionRunner").get("_write_loop")
    assert write_loop is not None, "runner.py 里找不到 SessionRunner._write_loop"

    def is_direct_write(statement: ast.stmt) -> bool:
        """这条语句**本身**就是 `host.write(...)`——不是“里面某处有”。"""
        return (
            isinstance(statement, ast.Expr)
            and isinstance(statement.value, ast.Call)
            and ast.unparse(statement.value.func).endswith("host.write")
        )

    guarded = next(
        (
            node
            for node in ast.walk(write_loop)
            if isinstance(node, ast.Try) and any(is_direct_write(item) for item in node.body)
        ),
        None,
    )
    assert guarded is not None, "`_write_loop` 里找不到包住 `host.write()` 的 try"

    releases = [item for item in map(ast.unparse, guarded.finalbody) if "_release(" in item]
    assert releases, (
        "`host.write()` 的 `try` 里，`finally` 没有调用 `_release()`："
        "扣减一旦早于写、或从异常路径漏掉，`pending_bytes == 0` 就不再等于"
        "“此前入队的字节都已落到宿主”，`writes_drained()` 会提前放行"
    )
