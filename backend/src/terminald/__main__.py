"""命令行入口：`python -m terminald` / `terminald`。

优先级（高 → 低）：命令行参数 > 环境变量 `TERMINALD_*` > `.env` > 代码默认值。
命令行参数**只覆盖显式给出**的项，因此不会把 `Settings` 里的默认值误当成用户意图，
从而不会意外压掉环境变量。
"""

from __future__ import annotations

import argparse
import shlex
import sys
from typing import Any

from . import __version__
from .api import create_app
from .api.security import is_loopback_host
from .config import Settings
from .logs import configure_logging, get_logger

_log = get_logger(__name__)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="terminald",
        description="pywezterm 支撑的持久会话网页终端守护进程",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--version", action="version", version=f"terminald {__version__}")
    parser.add_argument("--host", help="监听地址（只允许回环地址）")
    parser.add_argument("--port", type=int, help="监听端口")
    parser.add_argument("--cols", type=int, help="终端列数（由终端侧决定，客户端不参与）")
    parser.add_argument("--rows", type=int, help="终端行数")
    parser.add_argument("--scrollback", type=int, help="终端模型保留的回溯行数上限")
    parser.add_argument("--shell", help="会话默认命令行，如 --shell 'pwsh.exe -NoLogo'")
    parser.add_argument("--cwd", help="会话默认工作目录")
    parser.add_argument(
        "--host-impl",
        choices=("pywezterm", "fake"),
        help="宿主实现；fake 是测试替身，仅用于联调与自动化测试",
    )
    parser.add_argument("--web-dir", help="前端构建产物目录（默认取包内 web/）")
    parser.add_argument("--journal-mb", type=int, help="输出字节日志内存预算（MiB）")
    parser.add_argument("--log-level", help="日志级别")
    return parser


def settings_from_args(argv: list[str] | None = None) -> Settings:
    """解析命令行并构造配置（不启动服务，便于测试）。"""
    args = build_parser().parse_args(argv)
    overrides: dict[str, Any] = {}

    for name in ("host", "port", "cols", "rows", "scrollback", "cwd", "web_dir", "log_level"):
        value = getattr(args, name)
        if value is not None:
            overrides[name] = value
    if args.shell:
        overrides["shell"] = shlex.split(args.shell)
    if args.host_impl:
        overrides["host_impl"] = args.host_impl
    if args.journal_mb is not None:
        overrides["journal_budget_bytes"] = args.journal_mb * 1024 * 1024

    return Settings(**overrides)


def main(argv: list[str] | None = None) -> int:
    settings = settings_from_args(argv)
    configure_logging(settings.log_level)

    # 无认证 → 必须只监听回环。这里不是“默认值”而是硬约束：把它做成配置项会让
    # 部署时一次手滑就把 shell 暴露到网络上，而这种错误没有任何后续信号。
    if not is_loopback_host(settings.host):
        _log.error(
            "拒绝监听 %s：当前版本没有认证，只能绑定回环地址（127.0.0.1 / ::1 / localhost）",
            settings.host,
        )
        return 2

    # 依赖缺失同样是「没有任何后续信号」的错误：不在这里拦住，服务会照常起来、
    # 照常监听、照常接受连接，直到有人新建会话才失败，而那时它只会变成浏览器上
    # 一条谁也读不懂的提示。宁可现在就退出，把怎么补依赖讲在日志里。
    if settings.host_impl == "pywezterm":
        from .runtime.pywezterm_host import load_error

        problem = load_error()
        if problem is not None:
            _log.error("拒绝启动：宿主实现不可用。\n%s", problem)
            return 2

    import uvicorn  # 延迟导入：--help / 配置解析不需要加载服务器

    config = uvicorn.Config(
        app=create_app(settings),
        host=settings.host,
        port=settings.port,
        log_config=None,  # 日志由 logs.py 统一配置，避免双份格式
        log_level=None,
        # 单进程：会话状态在进程内存里，多 worker 会破坏会话亲和（见 api/app.py）
        workers=1,
        server_header=False,
        date_header=False,
    )
    uvicorn.Server(config).run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
