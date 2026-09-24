"""分层铁律的机器化执行。

架构文档里的“依赖只能单向”如果不被机器检查，它就只是一段愿望。这里用 AST 扫描
`src/terminald` 的 import 语句，把规则变成会红的测试：

- 只有 `runtime` 可以触碰原生扩展 `pywezterm`
- 只有 `api` 可以触碰 web 框架（`fastapi` / `starlette` / `uvicorn`）
- 依赖方向严格向下：`api → service → runtime → core → protocol`
- `core` / `protocol` 不得依赖 `config`（它们要能在任何配置下被单测）

为什么用 AST 而不是 grep：grep 会把注释、字符串、`importlib` 惰性导入全部误判，
于是在“禁止触碰 pywezterm”的检查里给出假绿。
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[1] / "src"
PACKAGE = "terminald"

LAYERS = ("protocol", "core", "runtime", "service", "api")

#: 每一层允许依赖的层（含自身）
ALLOWED_TARGETS: dict[str, frozenset[str]] = {
    "protocol": frozenset({"protocol"}),
    "core": frozenset({"protocol", "core"}),
    "runtime": frozenset({"protocol", "core", "runtime"}),
    "service": frozenset({"protocol", "core", "runtime", "service"}),
    "api": frozenset({"protocol", "core", "runtime", "service", "api"}),
}

#: 顶层叶子模块允许被哪些层依赖（不在这张表里的顶层模块允许全部层依赖）
SPECIAL_MODULES: dict[str, frozenset[str]] = {
    f"{PACKAGE}.config": frozenset({"runtime", "service", "api"}),
    f"{PACKAGE}.logs": frozenset(LAYERS),
}

#: 只有这些层可以 import 对应第三方包
EXCLUSIVE_PACKAGES: dict[str, frozenset[str]] = {
    "pywezterm": frozenset({"runtime"}),
    "fastapi": frozenset({"api"}),
    "starlette": frozenset({"api"}),
    "uvicorn": frozenset({"api"}),
}


def _modules() -> list[tuple[Path, str, bool]]:
    """列出 `(路径, 模块名, 是否包)`。"""
    found: list[tuple[Path, str, bool]] = []
    for path in sorted(SRC.rglob("*.py")):
        rel = path.relative_to(SRC)
        if rel.parts[0] != PACKAGE or rel.parts[1:2] == ("web",):
            continue
        is_package = path.name == "__init__.py"
        parts = list(rel.with_suffix("").parts)
        if is_package:
            parts.pop()
        found.append((path, ".".join(parts), is_package))
    assert found, "未扫描到任何模块，检查 SRC 路径"
    return found


def _layer_of(module: str) -> str:
    """模块所属的层；顶层模块（`terminald`、`__main__`、`config`、`logs`）归入装配层。"""
    parts = module.split(".")
    if len(parts) >= 2 and parts[1] in LAYERS:
        return parts[1]
    return "api"


def _resolve_target(module: str, is_package: bool, node: ast.ImportFrom) -> str | None:
    """把 `from ... import` 解析成绝对模块名（相对导入按当前包推算）。"""
    if node.level == 0:
        return node.module
    parts = module.split(".")
    base = parts if is_package else parts[:-1]
    # level=1 表示当前包，level=2 表示上一级
    if node.level - 1 > len(base):
        return None
    base = base[: len(base) - (node.level - 1)]
    if node.module:
        base = [*base, *node.module.split(".")]
    return ".".join(base) or None


def _imported_names(tree: ast.Module, module: str, is_package: bool) -> set[str]:
    """收集该文件全部被导入的绝对模块名，并展开到顶层包名。"""
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                names.add(alias.name)
        elif isinstance(node, ast.ImportFrom):
            target = _resolve_target(module, is_package, node)
            if target:
                names.add(target)
    return names


def _collect() -> list[tuple[Path, str, set[str]]]:
    collected = []
    for path, module, is_package in _modules():
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        collected.append((path, module, _imported_names(tree, module, is_package)))
    return collected


COLLECTED = _collect()


def _rel(path: Path) -> str:
    return str(path.relative_to(SRC.parent))


_COLLECTED_IDS = [_rel(p) for p, _, _ in COLLECTED]


@pytest.mark.parametrize(("path", "module", "imports"), COLLECTED, ids=_COLLECTED_IDS)
def test_dependency_direction(path: Path, module: str, imports: set[str]) -> None:
    """依赖方向：各层只能依赖自己或更下层，且叶子模块有额外的可见性约束。"""
    layer = _layer_of(module)
    allowed = ALLOWED_TARGETS[layer]
    violations: list[str] = []

    for name in sorted(imports):
        if name in SPECIAL_MODULES:
            if layer not in SPECIAL_MODULES[name]:
                visible = "/".join(sorted(SPECIAL_MODULES[name]))
                violations.append(f"{name}（该模块仅对 {visible} 可见）")
            continue
        if not name.startswith(f"{PACKAGE}."):
            continue
        target_layer = name.split(".")[1]
        if target_layer in LAYERS and target_layer not in allowed:
            violations.append(f"{name}（属于 {target_layer} 层，{layer} 层不允许依赖）")

    assert not violations, f"{_rel(path)} 违反分层：\n  " + "\n  ".join(violations)


@pytest.mark.parametrize(("path", "module", "imports"), COLLECTED, ids=_COLLECTED_IDS)
def test_exclusive_dependencies(path: Path, module: str, imports: set[str]) -> None:
    """独占依赖：原生扩展与 web 框架只能出现在被允许的层里。"""
    layer = _layer_of(module)
    violations: list[str] = []
    for name in sorted(imports):
        root = name.split(".")[0]
        keepers = EXCLUSIVE_PACKAGES.get(root)
        if keepers is not None and layer not in keepers:
            violations.append(f"{name}（仅允许 {'/'.join(sorted(keepers))} 层导入）")
    assert not violations, f"{_rel(path)} 越权依赖：\n  " + "\n  ".join(violations)


def test_layer_coverage() -> None:
    """每一层都必须真的存在模块——空目录会让上面两个参数化测试变成空跑。"""
    present = {_layer_of(module) for _, module, _ in COLLECTED}
    missing = set(LAYERS) - present
    assert not missing, f"缺少层: {sorted(missing)}"
