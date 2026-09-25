"""配置与入口测试。

配置错误的特征是**不报错、只是静默退化**，所以能在启动时拒绝的关系全部在这里钉死。
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from terminald.__main__ import build_parser, main, settings_from_args
from terminald.config import Settings


def test_shell_string_is_split() -> None:
    settings = Settings(shell="pwsh.exe -NoLogo")
    assert settings.shell == ["pwsh.exe", "-NoLogo"]


def test_terminal_size_defaults_are_terminal_side_only() -> None:
    """配置里**没有**任何来自客户端的尺寸项：cols/rows 是终端自身属性。"""
    settings = Settings()
    assert (settings.cols, settings.rows) == (120, 30)
    assert "resize" not in Settings.model_fields


def test_attach_chunk_larger_than_high_is_rejected() -> None:
    with pytest.raises(ValidationError):
        Settings(outbox_high_bytes=4096, attach_chunk_bytes=8192)


def test_input_low_above_high_is_rejected() -> None:
    """输入水位关系错了不会报错，只会让“放行”永远不发生（客户端被永久暂缓）。"""
    with pytest.raises(ValidationError):
        Settings(input_high_bytes=4096, input_low_bytes=8192)


def test_input_hard_must_leave_room_above_high() -> None:
    """`hard` 与 `high` 贴得太近会让守规矩的客户端被误判违约（在途帧仍在路上）。

    余量要求是“至少一个完整的 high”，所以 `hard = high` 与 `hard = high + 1` 都必须被拒——
    差的不是等于还是大于，而是有没有真正留出在途帧的空间。
    """
    for hard in (64 * 1024, 64 * 1024 + 1):
        with pytest.raises(ValidationError):
            Settings(input_high_bytes=64 * 1024, input_low_bytes=0, input_hard_bytes=hard)
    assert Settings(input_high_bytes=64 * 1024, input_low_bytes=0, input_hard_bytes=2 * 64 * 1024)


def test_unknown_setting_is_rejected() -> None:
    with pytest.raises(ValidationError):
        Settings(nope=True)  # type: ignore[call-arg]


@pytest.mark.parametrize(
    ("argv", "expected"),
    [
        (["--cols", "100"], {"cols": 100}),
        (["--port", "9000"], {"port": 9000}),
        (["--shell", "pwsh.exe -NoLogo"], {"shell": ["pwsh.exe", "-NoLogo"]}),
        (["--host-impl", "fake"], {"host_impl": "fake"}),
        (["--journal-mb", "2"], {"journal_budget_bytes": 2 * 1024 * 1024}),
    ],
)
def test_cli_overrides_are_applied(argv: list[str], expected: dict[str, object]) -> None:
    settings = settings_from_args(argv)
    for key, value in expected.items():
        assert getattr(settings, key) == value


def test_cli_does_not_clobber_env_provided_values(monkeypatch: pytest.MonkeyPatch) -> None:
    """未显式给出的参数不得覆盖环境变量——否则命令行会把 env 配置无声压掉。"""
    monkeypatch.setenv("TERMINALD_COLS", "77")
    settings = settings_from_args(["--port", "9001"])
    assert settings.cols == 77
    assert settings.port == 9001


def test_parser_exposes_host_impl_choices() -> None:
    actions = {action.dest: action for action in build_parser()._actions}
    assert set(actions["host_impl"].choices or ()) == {"pywezterm", "fake"}  # type: ignore[attr-defined]


# ---------------------------------------------------------------- 启动自检

#: 依赖缺失属于「没有任何后续信号」的错误：不拦住的话服务会照常起来、照常监听，
#: 直到有人新建会话才失败，而那时它只会变成浏览器上一条读不懂的提示。


def test_startup_refuses_when_host_dependency_is_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "terminald.runtime.pywezterm_host.load_error", lambda: "缺少 pywezterm（测试注入）"
    )
    # 返回 2 而不是起服务；这条一旦退化成「照常启动」，下面这行就会挂住或返回 0
    assert main(["--host-impl", "pywezterm"]) == 2


def test_startup_self_check_is_skipped_for_fake_host(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`fake` 是测试替身，它不依赖原生扩展，不该被启动自检拦住。"""
    consulted: list[str] = []

    def _boom() -> str:
        consulted.append("called")
        return "不应该被调用"

    monkeypatch.setattr("terminald.runtime.pywezterm_host.load_error", _boom)
    # 真正起服务会绑端口；只关心自检有没有拦它，所以把 run 换成空操作
    monkeypatch.setattr("uvicorn.Server.run", lambda self: None)

    assert main(["--host-impl", "fake"]) == 0
    assert consulted == []
