"""进程配置。

所有可调项集中在此，通过环境变量 `TERMINALD_*` 或 `.env` 覆盖。

设计约束（来自需求对齐）：
- **终端尺寸由终端侧决定**：`cols` / `rows` 是终端自身属性，浏览器可视面积永远
  不参与。这里给出的是**会话创建时**的初值；运行期可以由用户经前端显式变更
  （`session.resize`，见 `docs/architecture.md` §4），但那个入口收的也是"网格尺寸"，
  同样与窗口像素无关。
- 仅监听回环地址：当前不做认证，暴露到回环之外等于把 shell 交给任何能访问该端口的人。
"""

from __future__ import annotations

import os
import shlex
from functools import lru_cache
from typing import Literal

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from .protocol.messages import SESSION_COLS_MIN, SESSION_ROWS_MIN, SESSION_SIZE_MAX


def _default_shell() -> list[str]:
    """平台默认 shell，可通过 `TERMINALD_SHELL` 覆盖。"""
    if os.name == "nt":
        comspec = os.environ.get("COMSPEC", r"C:\Windows\System32\cmd.exe")
        return [comspec]
    return [os.environ.get("SHELL", "/bin/sh")]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="TERMINALD_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="forbid",
        frozen=True,
    )

    # ---- 网络 -------------------------------------------------------------
    host: str = "127.0.0.1"
    port: int = Field(default=8765, ge=1, le=65535)

    # ---- 终端 -------------------------------------------------------------
    # 边界来自协议层（`SESSION_*`）：创建初值与运行期变更（`session.resize`）必须
    # 用**同一组**上下界，否则会出现「配置允许 1 列、变更接口拒绝 1 列」这类分歧。
    cols: int = Field(default=120, ge=SESSION_COLS_MIN, le=SESSION_SIZE_MAX)
    rows: int = Field(default=30, ge=SESSION_ROWS_MIN, le=SESSION_SIZE_MAX)
    scrollback: int = Field(default=10_000, ge=0)
    shell: list[str] = Field(default_factory=_default_shell)
    cwd: str | None = None

    # ---- 会话与同步 -------------------------------------------------------
    # 输出字节日志的内存预算；超预算后从头裁剪（裁剪点对齐到转义序列边界）
    journal_budget_bytes: int = Field(default=8 * 1024 * 1024, ge=64 * 1024)
    # 每客户端发送队列高水位：触及它就停下不再往外推（客户端游标与日志会保证不丢字节）
    # 初值按 xterm.js 写缓冲（50MB 硬上限 / 5–35MB/s 吞吐）标定，需实测复核
    outbox_high_bytes: int = Field(default=4 * 1024 * 1024, ge=64 * 1024)
    # 单次补流分片大小（避免一次性塞爆 xterm.js 写缓冲）
    attach_chunk_bytes: int = Field(default=64 * 1024, ge=1024)
    # 客户端「已渲染」点之前允许多少字节在途（**仅对会 ack 的客户端生效**，见
    # docs/architecture.md §6）。它是**实时推送**的窗口：越过就停手，等 `Ack` 把窗口
    # 往前推。附加与重建的补齐不受它约束（那时 acked 已对齐，`cursor - acked` 为负）。
    # 没有它，服务端能推多远只看客户端还接不接——实测 4 MiB 输出可以攒成 4 MiB
    # 未解析积压，与日志预算无关（回归见 tests/test_push_window.py，
    # 原始测量记录在 docs/audit.md A4）。
    push_ahead_bytes: int = Field(default=2 * 1024 * 1024, ge=1024)
    # 输入方向（客户端 → PTY）的水位：在途字节超过 high 就通知该客户端“暂缓发送”，
    # 回落到 low 再放行。写队列本身**不再无界**：`hard` 是硬上限，越线的连接按协议
    # 违例显式断开（见 docs/protocol.md §3「输入流控」）。
    input_high_bytes: int = Field(default=1024 * 1024, ge=1024)
    input_low_bytes: int = Field(default=256 * 1024, ge=0)
    input_hard_bytes: int = Field(default=16 * 1024 * 1024, ge=4096)

    # ---- 宿主实现 ---------------------------------------------------------
    # pywezterm：真实实现（默认）；fake：仅供测试与前端联调的测试替身
    host_impl: Literal["pywezterm", "fake"] = "pywezterm"

    # ---- 前端静态资源 -----------------------------------------------------
    web_dir: str | None = None  # 默认取包内 terminald/web

    # ---- 日志 -------------------------------------------------------------
    log_level: str = "INFO"

    @field_validator("shell", mode="before")
    @classmethod
    def _split_shell(cls, value: object) -> object:
        """允许用单个字符串（含空格）配置命令行。"""
        if isinstance(value, str):
            return shlex.split(value)
        return value

    @model_validator(mode="after")
    def _check_flow_control(self) -> Settings:
        """把流控参数之间的不等式关系钉在配置边界上。

        这些关系错了不会报错，只会静默退化：`attach_chunk > high` 会让单次补流分片大到
        一次就顶到水位；`push_ahead < attach_chunk` 会让推进单位从窗口退化成单个分片，
        窗口失去意义；`input_low > input_high` 会让「解除暂缓」的判定永远不成立
        （客户端被永久停发）。它们都只会表现为“莫名其妙卡住”，所以在启动时就拒绝。
        """
        if self.attach_chunk_bytes > self.outbox_high_bytes:
            raise ValueError("attach_chunk_bytes 不能大于 outbox_high_bytes")
        if self.push_ahead_bytes < self.attach_chunk_bytes:
            # 窗口比一个分片还小的话，推进的单位就变成了分片而不是窗口，水位失去意义
            raise ValueError("push_ahead_bytes 不能小于 attach_chunk_bytes")
        if self.input_low_bytes > self.input_high_bytes:
            raise ValueError("input_low_bytes 不能大于 input_high_bytes")
        if self.input_hard_bytes < 2 * self.input_high_bytes:
            # hard 与 high 之间必须留出余量，而且余量必须至少是一个完整的 high：
            # 客户端收到“暂缓”之前已经发出去的帧仍在路上（它们会把在途字节推过 high），
            # 单次粘贴也可能是一整帧、量级就是 MB。只要求 `hard > high` 是不够的——
            # 差一个字节的配置会让守规矩的客户端被当成违约而断开。
            raise ValueError("input_hard_bytes 至少要是 input_high_bytes 的两倍（给在途帧留余量）")
        return self


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """进程级单例（测试可用 get_settings.cache_clear() 重置）。"""
    return Settings()
