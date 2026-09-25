"""错误文案的纪律：报错正文是**一句话**，不是一段运维备注。

曾经真出过事：`Failure` 直接拿 `type(exc).__name__` 与 `str(exc)`，于是正文变成了
「未找到 pywezterm。它是仓库里的长期依赖 vendor/pywezterm/（不安装）：把仓库的
vendor/ 加进 PYTHONPATH（见 backend/README.md 的「运行」一节）」；而 `SessionNotFound`
没有自定义 `__init__`，`str(exc)` 是空串，用户看到的是一条空白提示。

守三条：`code` 稳定且不等于类名；`user_message` 短、不含内部标识、不指向别处、
不承诺没做的事；`str(exc)` 留作技术细节。

同一套约束也套在 `api/ws.py` 那几条**传输层**文案上——它们同样是弹给使用者的，
只是不挂在领域错误类上，容易漏查。
"""

from __future__ import annotations

import re

import pytest

from terminald.core.errors import TerminaldError

#: 协议承诺的 `code`。写死在这里是**故意**的：改名就是破坏协议兼容性，必须有人确认。
EXPECTED_CODES: dict[str, str] = {
    "SessionNotFound": "session_not_found",
    "SessionNameConflict": "session_name_conflict",
    "JournalTrimmed": "journal_trimmed",
    "OffsetAhead": "offset_ahead",
    "HostUnavailable": "host_unavailable",
    "ProtocolViolation": "protocol_violation",
}

#: 不允许出现在给使用者看的文案里的东西（大小写不敏感）
BANNED_PATTERNS: tuple[str, ...] = (
    r"pythonpath",
    r"sys\.path",
    r"vendor",
    r"reference",
    r"\.py\b",
    r"\.pyd\b",
    r"\.dll\b",
    r"\.exe\b",
    r"readme",
    r"traceback",
    r"exception",
    r"import",
    r"module",
    r"httpexception",
    r"[/\\]",  # 路径分隔符
)

#: 把人指向别处的词。报错正文里写「详情见服务端日志」跟写「见 README 的「运行」一节」
#: 是同一件事：接收者够不着那个地方，这句话对他等于没说。
POINTER_WORDS: tuple[str, ...] = (
    "详情见",
    "详见",
    "参见",
    "见服务",
    "查看日志",
    "查日志",
    "日志",
)

#: 承诺了某个动作的措辞。**必须**有代码真的会去做那件事，否则这句话是假的。
#: 「正在重新载入」曾经就是假的：前端收到 `error` 只显示提示，没有任何重载分支。
PROMISE_WORDS: tuple[str, ...] = ("正在", "即将", "已自动", "会自动")

#: 报错正文的长度上限（中文字符计）。报错是**一句话**，不是一段处置说明。
MAX_MESSAGE_CHARS = 24

_SNAKE = re.compile(r"^[a-z][a-z0-9_]*$")


def _all_errors() -> list[type[TerminaldError]]:
    """含基类在内——基类的兜底文案也会真的显示给用户，不能漏查。"""
    found: list[type[TerminaldError]] = [TerminaldError]
    stack: list[type[TerminaldError]] = [TerminaldError]
    while stack:
        current = stack.pop()
        for child in current.__subclasses__():
            found.append(child)
            stack.append(child)
    return found


def _instantiate(cls: type[TerminaldError]) -> TerminaldError:
    """按各错误的构造签名造一个实例（只为拿到 `str(exc)` 与 `user_message`）。"""
    table: dict[str, tuple[object, ...]] = {
        "SessionNotFound": ("s1",),
        "SessionNameConflict": ("name",),
        "JournalTrimmed": (10, 20),
        "OffsetAhead": (30, 40),
        "HostUnavailable": (),
        "ProtocolViolation": ("细节",),
    }
    return cls(*table.get(cls.__name__, ()))


def test_all_errors_have_stable_code() -> None:
    for cls in _all_errors():
        code = getattr(cls, "code", None)
        assert isinstance(code, str), f"{cls.__name__} 缺少 code"
        assert _SNAKE.match(code), f"{cls.__name__}.code 不是 snake_case: {code!r}"
        # 类名作 code 意味着重构改名会破坏协议，这正是要杜绝的退化
        assert code != cls.__name__.lower(), f"{cls.__name__}.code 退化成了类名"


def test_known_codes_are_unchanged() -> None:
    """协议兼容性：已知的 `code` 一个都不许变。"""
    for name, code in EXPECTED_CODES.items():
        cls = next((c for c in _all_errors() if c.__name__ == name), None)
        assert cls is not None, f"领域错误 {name} 消失了"
        assert cls.code == code, f"{name}.code 从 {code} 变成了 {cls.code}"


#: 已知的「这句话承诺了一个系统真的会去做的动作」。写死是为了让假承诺必须被显式登记：
#: 想加一句「正在…」，就得同时给出做那件事的代码位置，并把它写进这张表。
KNOWN_FULFILLED_PROMISES: frozenset[str] = frozenset()

#: `api/ws.py` 里那些**传输层**的 `Failure.message`：不挂在领域错误类上，容易漏查，
#: 但它们同样是弹给使用者的。
WS_MESSAGE_NAMES: tuple[str, ...] = (
    "BAD_HELLO_MESSAGE",
    "PROTOCOL_MISMATCH_MESSAGE",
    "BAD_MESSAGE_MESSAGE",
    "TOO_LARGE_MESSAGE",
    "INPUT_OVERFLOW_MESSAGE",
)


def _user_facing_messages() -> list[tuple[str, str]]:
    """所有会弹给使用者的文案，形如 `(来源, 文案)`。"""
    from terminald.api import ws as ws_module

    return [(c.__name__, c.user_message) for c in _all_errors()] + [
        (f"ws.{name}", getattr(ws_module, name)) for name in WS_MESSAGE_NAMES
    ]


_MESSAGES = _user_facing_messages()
_MESSAGE_IDS = [where for where, _ in _MESSAGES]


@pytest.mark.parametrize(("where", "message"), _MESSAGES, ids=_MESSAGE_IDS)
def test_message_has_no_internal_details(where: str, message: str) -> None:
    assert message.strip(), f"{where} 是空的"
    lowered = message.lower()
    for pattern in BANNED_PATTERNS:
        assert not re.search(pattern, lowered), (
            f"{where} 暴露了内部细节（命中 {pattern!r}）：{message!r}"
        )


@pytest.mark.parametrize(("where", "message"), _MESSAGES, ids=_MESSAGE_IDS)
def test_message_points_nowhere(where: str, message: str) -> None:
    for word in POINTER_WORDS:
        assert word not in message, f"{where} 把人指向了别处（{word}）：{message!r}"


@pytest.mark.parametrize(("where", "message"), _MESSAGES, ids=_MESSAGE_IDS)
def test_message_makes_no_unfulfilled_promise(where: str, message: str) -> None:
    for word in PROMISE_WORDS:
        if word in message:
            assert message in KNOWN_FULFILLED_PROMISES, (
                f"{where} 承诺了「{word}」，但没有代码会去做它：{message!r}"
            )


@pytest.mark.parametrize(("where", "message"), _MESSAGES, ids=_MESSAGE_IDS)
def test_message_is_one_short_sentence(where: str, message: str) -> None:
    """报错是一句话，不是一段处置说明。"""
    assert len(message) <= MAX_MESSAGE_CHARS, (
        f"{where} 有 {len(message)} 字（上限 {MAX_MESSAGE_CHARS}）：{message!r}"
    )
    assert message.count("。") <= 1, f"{where} 不止一句：{message!r}"


@pytest.mark.parametrize("cls", _all_errors(), ids=lambda c: c.__name__)
def test_user_message_is_not_the_log_detail(cls: type[TerminaldError]) -> None:
    exc = _instantiate(cls)
    assert exc.user_message != str(exc) or not str(exc), (
        f"{cls.__name__} 把技术细节原样当成了用户文案：{str(exc)!r}"
    )


def test_base_class_has_a_usable_fallback() -> None:
    """基类必须有非空兜底值：漏写 `user_message` 的子类不该让用户看到空白提示。"""
    assert isinstance(TerminaldError.code, str) and TerminaldError.code
    assert isinstance(TerminaldError.user_message, str) and TerminaldError.user_message
