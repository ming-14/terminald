"""共享 fixture。

原则：默认走 **fake 宿主**，让 core/service/api 的整条链路可以在没有 pywezterm、
没有真实 PTY、没有网络的前提下被确定性测出来。真实宿主只在 `contract` 标记的
测试里使用（`pytest -m contract` 单独跑）。
"""

from __future__ import annotations

import os
import sys
from collections.abc import AsyncIterator
from pathlib import Path

import pytest

# 允许测试之间 `import support`
sys.path.insert(0, str(Path(__file__).resolve().parent))

from support import make_settings
from terminald.config import Settings
from terminald.runtime import make_host_factory
from terminald.service.hub import Hub


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    """`contract` 用例默认不跑。

    它们要起真实 ConPTY 子进程，比 fake 宿主慢两个数量级，而且依赖本地装好的原生扩展；
    放在默认套件里会让「快速回归」失去意义。显式用 `-m contract` 或
    `TERMINALD_CONTRACT=1` 才会执行——留一个环境变量是因为 CI 里让 `-m` 与其它
    `-m` 选择叠加不方便。
    """
    if os.environ.get("TERMINALD_CONTRACT") or "contract" in (config.option.markexpr or ""):
        return
    skip = pytest.mark.skip(
        reason="contract 用例：用 `-m contract` 或 TERMINALD_CONTRACT=1 显式启用"
    )
    for item in items:
        if "contract" in item.keywords:
            item.add_marker(skip)


@pytest.fixture
def settings() -> Settings:
    return make_settings()


@pytest.fixture
async def hub(settings: Settings) -> AsyncIterator[Hub]:
    instance = Hub(settings, make_host_factory(settings.host_impl))
    try:
        yield instance
    finally:
        await instance.stop()
