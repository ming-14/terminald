"""`runtime/vendor.py`：长期依赖由**程序自己找**，不靠调用者记得配 `PYTHONPATH`。

定位从本文件的位置往上走，因此与 cwd 无关——服务从仓库根起、从 `backend/` 起、
用系统 Python 起还是 venv 起，都应当是同一个结果。这里把这件事钉住。
"""

from __future__ import annotations

import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

from terminald.runtime import vendor

REPO_ROOT = Path(__file__).resolve().parents[2]


def test_find_locates_the_repo_vendor_dir() -> None:
    assert vendor.find() == REPO_ROOT / "vendor"


def test_attach_is_idempotent(monkeypatch: pytest.MonkeyPatch) -> None:
    """重复 attach 不该让 `sys.path` 无限变长。"""
    monkeypatch.setattr(vendor, "_attached", None)
    first = vendor.attach()
    after_first = len(sys.path)
    second = vendor.attach()
    assert first == second
    assert len(sys.path) == after_first


def test_attach_recognizes_an_equivalent_existing_entry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """已经以另一种写法在 `sys.path` 里时，不该再加一条指向同一处的项。

    pytest 的 `pythonpath = ["../vendor"]` 留下的是 `<backend>/../vendor`，
    文本上与定位结果不同但指向同一目录——只看字符串会重复追加。
    """
    monkeypatch.setattr(vendor, "_attached", None)
    sys.path.append(str(REPO_ROOT / "backend" / ".." / "vendor"))
    try:
        before = len(sys.path)
        assert vendor.attach() == REPO_ROOT / "vendor"
        assert len(sys.path) == before
    finally:
        sys.path.pop()


def test_locate_works_from_another_cwd_and_without_pythonpath() -> None:
    """换一个 cwd、不带 vendor 的 PYTHONPATH，仍然要能定位——这才是这条机制的意义。

    子进程里只给 `src/`（否则连 terminald 都导不到），vendor 必须靠自己找。
    """
    code = textwrap.dedent(
        """
        from terminald.runtime import vendor
        print("FOUND", vendor.attach())
        import pywezterm
        print("IMPORT", pywezterm.__file__)
        """
    )
    env = {
        "PATH": os.environ.get("PATH", ""),
        "SYSTEMROOT": os.environ.get("SYSTEMROOT", ""),
        "PYTHONPATH": str(REPO_ROOT / "backend" / "src"),
    }
    result = subprocess.run(
        [sys.executable, "-c", code],
        cwd=str(REPO_ROOT.parent),  # 故意从仓库之外的一个目录起
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 0, result.stderr
    assert f"FOUND {REPO_ROOT / 'vendor'}" in result.stdout
    assert "IMPORT" in result.stdout


def test_vendor_dir_actually_contains_the_package() -> None:
    """`vendor/` 里那份必须是**可导入的包**，而不只是一个同名目录。"""
    assert (REPO_ROOT / "vendor" / vendor.PACKAGE / "__init__.py").is_file()
