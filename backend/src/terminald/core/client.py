"""客户端（一个 WebSocket 连接）在服务端的全部状态。

刻意保持很小：客户端**不是**内容的持有者，只是某个会话的一个订阅者。
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field

from .outbox import Outbox


@dataclass(slots=True)
class Client:
    """一条连接。字段全部由服务层在消息处理中维护。"""

    id: str
    outbox: Outbox
    #: 出站唤醒：服务层 push 帧后置位；传输层据此把 outbox 排空并发送。
    #: 用它而不是让服务层直接 await 发送，是为了让服务层保持**同步**——
    #: 同步意味着“决策 + 登记 + 投递”在一次事件循环 tick 内完成，天然原子。
    wakeup: asyncio.Event = field(default_factory=asyncio.Event)
    session_id: str | None = None
    #: 该客户端**下一个需要收到的**输出偏移（服务端流控游标）。
    #:
    #: 与 `acked_offset` 的区别是这套机制的核心：`next_push_offset` 由服务端推进，
    #: 表示“已经发给它了”；`acked_offset` 由客户端上报，表示“已经渲染完了”。
    #: 拥塞时前者停下、后者继续追，两者之间的差就是路上还有多少字节。
    next_push_offset: int = 0
    #: 客户端已确认“解析到”的输出偏移。**实时推送窗口的唯一依据**：服务端最多推到
    #: `acked_offset + settings.push_ahead_bytes`，越过就停手，等下一次 `Ack`（见
    #: `hub._push_client`）。它**不是**日志裁剪的依据——裁剪只看预算，由 `Behind` 收敛。
    acked_offset: int = 0
    #: 该连接是否**证明过**自己会 ack（收到过至少一次真正推进的 `Ack`）。
    #:
    #: 窗口只对这样的客户端生效：不会 ack 的实现（第三方客户端、或者 ack 还没到）保持
    #: 旧行为—— 一直推，而不是停在一个永远不会被解开的窗口上。
    ack_seen: bool = False
    #: 该连接的窗口是否聚焦（多客户端聚合在 Session 里做）
    focused: bool = False
    #: 是否已通知过 Behind（避免重复）
    behind_notified: bool = False
    #: 输入是否已被暂缓（已下发 `InputHold(paused=true)`，等待队列排空后放行）。
    #:
    #: 这是**每客户端**的状态，而不是每会话：同一个会话的多个客户端里，只有真正把
    #: 写队列灌满的那一个需要在本端排队（其他人没发东西，凭什么让他们停）。
    input_held: bool = False
    closed: bool = False
    #: 自述信息（仅用于列表展示/日志）
    label: str = ""

    def note_ack(self, offset: int) -> bool:
        """记录确认偏移（单调不回退）。返回是否实际推进。"""
        if offset <= self.acked_offset:
            return False
        self.acked_offset = offset
        self.ack_seen = True
        return True

    def reset_ack(self, offset: int) -> None:
        """重建/重放后把确认基线设到对齐点（这是同一次对齐的一部分）。"""
        self.acked_offset = offset
        self.behind_notified = False

    def reset_subscription(self) -> None:
        """解除订阅：本端与上一个会话相关的所有状态一起清掉。

        输入暂缓必须清：它描述的是**上一个会话**的写队列，留着会让新会话的输入
        被无声地按旧状态处理。
        """
        self.session_id = None
        self.next_push_offset = 0
        self.input_held = False
        self.reset_ack(0)


__all__ = ["Client"]
