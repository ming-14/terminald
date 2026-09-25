"""把仓库里的长期依赖 `vendor/pywezterm/` 接进 `sys.path`。

pywezterm 不安装（不在 PyPI 上），包体就在仓库的 `vendor/` 里。要求每个启动方式都记得
带 `PYTHONPATH` 是把正确性押在调用者的记忆上：漏了就只有一个离根因很远的运行期症状
（新建会话时弹一条环境错误）。所以由程序自己找。

从**本文件的位置**逐级向上，而不是看 cwd：服务可能从任意目录被拉起，cwd 不可信；
而本文件的位置在任何安装形态下都能向上走回仓库根。
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

#: 依赖的导入名，也是它在 vendor/ 下的目录名
PACKAGE = "pywezterm"

#: 已经接过的目录（幂等：重复调用不该让 sys.path 变长）
_attached: Path | None = None


def find() -> Path | None:
    """定位 vendor 目录；找不到返回 None（不抛异常）。"""
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "vendor"
        if (candidate / PACKAGE / "__init__.py").is_file():
            return candidate
    return None


def attach() -> Path | None:
    """把 vendor 目录接进 `sys.path`（幂等）；返回接上的目录，找不到返回 None。

    插到末尾：真有人 pip 装了同名包时那份优先，仓库里这份是兜底。
    """
    global _attached
    if _attached is not None:
        return _attached

    directory = find()
    if directory is None:
        return None

    # 用规范化形式比较：pytest 的 pythonpath 留下的是 <backend>/../vendor，文本不同
    # 但指向同一处，只比字符串就会重复追加一条。
    resolved = os.path.realpath(directory)
    if not any(os.path.realpath(entry) == resolved for entry in sys.path if entry):
        sys.path.append(str(directory))
    _attached = directory
    return directory


__all__ = ["PACKAGE", "attach", "find"]
