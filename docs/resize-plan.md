# resize：调研与实现方案

目标：**尺寸可以由前端（用户）指定与变更**，而不是只在启动时由配置定死。

本文只写调研结论与方案，不含实现。所有事实都来自实测（脚本在 §8），不是读代码的印象。
**§5 的四件事需要你定**，定完再动代码。

---

## 1. 一句话结论

- **pywezterm 不需要改上游**：`Pty.resize(cols, rows)` / `Pty.get_size()` / `Terminal.resize(cols, rows)`
  都已存在且有测试（`tests/test_pty.py::test_pty_write_resize_exit`、`tests/test_term.py::test_resize_cursor_bind`）。
- 方案骨架：尺寸仍是**会话级属性**（不是每客户端一份），新增两条协议消息
  （上行 `session.resize`、下行 `resized`），Hub 在**事件循环的原子临界区**里做
  「`Pty.resize` → `Terminal.resize` → 登记尺寸变更点 → 广播」，前端收到 `resized` 后
  `term.resize()` 并重跑字号求解（`fitTerminal` 本来就是这个动作）。
- 真正需要设计的**不是「怎么改尺寸」**（两侧都是现成 API），而是下面 §3 的两条机制：
  **宿主会自己吐重绘**、以及**尺寸变更必须落在字节流的正确位置上**。

---

## 2. 两侧现有能力（实测）

### 2.1 pywezterm 绑定层

| API | 语义 | 实测 |
|---|---|---|
| `Pty.resize(cols, rows)` | 底层 `ResizePseudoConsole` | 调用耗时 **0.02–0.16 ms**；期间心跳线程最大停顿 ≤ 1.5 ms ⇒ **不占 GIL、不等待控制台**，可以放在事件循环上 |
| `Pty.get_size()` | → `(cols, rows)` | resize 后立即反映新值 |
| `Terminal.resize(cols, rows)` | wezterm 的 rewrap（含**锚顶语义**：内容锚顶、光标绑定文本行） | 10k 行 scrollback 下 **9.0 ms**（5k→4.7、1k→1.4）；期间心跳 ≤ 1.0 ms ⇒ 纯 CPU、放掉 GIL |

**子进程确实收到新尺寸**（这条是整个功能的地基）：在真 ConPTY 上起一个周期性
`GetConsoleScreenBufferInfo` 的子进程，`resize(100, 30)` 之后它自己报出
`CHILD-SIZE-CHANGED -> 100x30`。

参考实现在同仓库的 `wezterm/pywezterm/src/mux.rs::resize`（多分屏宿主），它写明了
resize 的**锁序**（先锁 terminal 再 `master.resize`）与「重建时要跳过宿主重绘」——
那正是 §3.1 要处理的东西。`reference/pywezterm` 工作区干净、已推送（HEAD `cee1c85`）。

### 2.2 xterm.js 6.0.0

- `term.resize(cols, rows)` 存在，**下限被钳到 `MINIMUM_COLS=2` / `MINIMUM_ROWS=1`**
  （实测 `resize(1,1)` → 2×1、`resize(0,0)` → 2×1；无上限，5000 照收）。
  ⇒ 服务端的合法区间必须 ≥ 这两个下限，否则「服务端以为 1 列、客户端渲染 2 列」会静默不一致。
- **reflow（重排）是开着的**。`get _isReflowEnabled()` 的实现是：

  ```js
  windowsPty.buildNumber
    ? (hasScrollback && backend === 'conpty' && buildNumber >= 21376)
    : (hasScrollback && !windowsMode)
  ```

  我们传的是 `windowsPty: { backend: 'conpty' }`（`src/ui/app.ts:209`，**没有 `buildNumber`**）
  ⇒ 走第二分支 ⇒ 有 scrollback、非 windowsMode ⇒ **启用**。
  ⚠ 维护提醒：哪天给 `windowsPty` 补上 `buildNumber`，判定会切到第一分支
  （`< 21376` 直接**关掉** reflow），客户端就不再自己重排了。这条要写进代码注释。
- **`CSI 8 ; rows ; cols t` 对我们是惰性的**：xterm 的 `windowOptions` 默认 `{}`，
  且 6.0.0 的 `CSI t` 分支只有 14/16/18/22/23，**没有 case 8**。
  实测单独喂 `\x1b[8;30;100t` 后 cols/rows 不变、90 个 A 仍按 80 列折行。
  ⇒ 宿主重绘里那句「窗口尺寸报告」不会和我们的尺寸控制打架。
- 我们前端**目前不监听 `onResize`**（`grep` 无命中），所以 `term.resize()` 不会自反馈成一次上行请求。

---

## 3. 必须处理的两条机制

### 3.1 resize 会让宿主自己往 PTY 里吐一段重绘

`Pty.resize(100,30)` 之后从 PTY 读到的**第一段字节**（真 ConPTY，253 字节，原样）：

```
\x1b[?25l \x1b[8;30;100t \x1b[H
<宿主缓冲区的可见区重绘： CHILD-UP console=80x24\x1b[K\r\n …>
\x1b[K\r\n ×27                    ← 把剩余行补空
\x1b[4;1H \x1b[?25h
```

**空对照**（子进程什么都不写）也有，形态不同（152 字节）：

```
\x1b[?25l \x1b[2J \x1b[m \x1b[H + 29×\r\n + \x1b[H + OSC 0(标题) + \x1b[?25h
```

两条结论：

1. **它是宿主自发的**（空对照也有），不是子进程的输出；
2. **形态随宿主版本与缓冲内容变**（上面两种都是「同一台机器、同一版侧载 OpenConsole」），
   所以**依赖它的形状就是在依赖一个实现细节**。

它是 ConPTY 这个「终端模拟器」对我们这块屏幕做的一次**整体重绘**（含 `\x1b[?25l`/`\x1b[?25h`
包夹、可能含 `\x1b[2J`、结尾把剩余行补空）。它会进入我们的 journal —— 这是我们**唯一**
无法回避的新输入。两种处置见 §5 决策 3。

### 3.2 reflow 等价性：「先窄喂再变宽」≈「一开始就按新宽度喂」

这条决定「**刷新整段重放**」在 resize 之后还成不成立。

| 引擎 | 方法 | 结果 |
|---|---|---|
| wezterm 模型 | 80×24 喂 40 行 → resize 120×30 → 再喂尾巴，对比一开始就 120×30 | **内容集合完全一致**；差别只是 scrollback 与可见区怎么切（前者 scrollback 多留 5 行、可见区底部多 5 行空行） |
| xterm（真 Chromium） | 同上，比 `buffer.active` 逐行 | **前 32 行逐行一致**（差异从第 32 行起，是尾部空行；length 37 vs 32） |

两侧都是「按新宽度重排」，**内容一致**；差异是**可见区留白与光标位置**，而且
**两侧在这件事上行为相同**（都保持光标所在行、把空行留在底部）。
⇒ 「按当前尺寸重放」在 resize 之后依然成立到今天同等的程度。

---

## 4. 方案

### 4.1 协议（`protocol/messages.py`、`docs/protocol.md`）

| 消息 | 方向 | 形状 | 说明 |
|---|---|---|---|
| `session.resize` | C → S | `{session, cols, rows}` | 与 `session.rename` 同一族 |
| `resized` | S → C | `{session, cols, rows}` | 尺寸真的变了才发；**必须按 offset 有序插入**（见 4.2） |

- 边界只定义一处：协议里加 `SESSION_COLS_MIN = 2` / `SESSION_ROWS_MIN = 1`（xterm 的下限，实测）
  与 `SESSION_SIZE_MAX = 1000`（沿用 config 现有上界）；WS 与 REST（若有）共用，
  照 `SESSION_NAME_MAX` 的先例。
- `Attached` **不变**（本来就带 `cols`/`rows`/`scrollback`）：新客户端与重连客户端都从这里拿当前尺寸。
- `server_message_shapes()` 要加 `resized`，否则前端形状契约（`vectors/shapes.json`）会红 —— 那是对的。
- 记一笔：A7 曾把死协议面 `Sized` 删掉，理由是「真要加时才加，不留占位面」。**现在就是那个时候**；
  命名用 `resized`（与 `attached`/`exited` 同族的过去式），不复活 `Sized`。
- 入口**只走 WebSocket**，不做 REST 镜像：`session.rename` 先例如此，而 `api/schemas.py` 的原则是
  「不依赖会话实时状态的操作才走 REST」——resize 要广播给所有订阅者，是实时操作。

### 4.2 顺序：`resized` 不能「立刻 push」

`_push_client` 只把字节推到 `acked_offset + push_ahead_bytes`。若该客户端此刻有积压，
它的游标还没到日志末尾——此刻 `_send(resized)` 会**插到积压字节之前**，
客户端就会「先改尺寸、再收到按旧尺寸产生的那批字节」。

做法：`Client` 加 `pending_resize: (offset, cols, rows) | None`，
由 `_push_client` 在**游标越过那个 offset 时**发送（与字节流顺序一致）。
连续多次变更只保留**最早**的那一条：客户端只要在消费「那之前的一批字节」之前换好尺寸就够了。
`reset_subscription()` 里要清掉它。

### 4.3 后端改动清单

| 文件 | 改动 |
|---|---|
| `core/ports.py` | `SessionHost` 加 `resize(cols, rows) -> None`，注明**只允许事件循环线程**（与 `ingest`/`snapshot` 同组） |
| `runtime/pywezterm_host.py` | `resize()` = `self._pty.resize(...)` + `self._term.resize(...)`（顺序同 `mux.rs`） |
| `core/session.py` | `cols`/`rows` 可写；加一个 `resize(cols, rows)` 把两者一起改，避免只改一个留下不一致状态 |
| `core/client.py` | 新增 `pending_resize` 字段并纳入 `reset_subscription()` |
| `service/hub.py` | `resize_session(session_id, cols, rows)`：校验 → `host.resize` → `session.resize` → 给每个订阅者登记 `pending_resize` → `_push_client` → `_publish_sessions()`。**方法内无 await**（与 `_attach`/`_detach_session` 同一套原子性纪律） |
| `protocol/messages.py` | 两条消息、上下行 union、`server_message_shapes()`、边界常量 |
| `runtime/fake_host.py` | 实现 `resize`（测试替身必须与真宿主同形） |
| `config.py` | cols/rows 的边界改成引用协议常量（现在是各写一份 `ge=1, le=1000`） |
| `docs/architecture.md` §4/§11、`docs/protocol.md` | §4 现在写着「两个方向都没有 resize 消息」——必须重写；§11 补「尺寸可变更后字号求解的输入从哪来」 |
| `api/schemas.py` 的注释 | 那句「有意没有 cols/rows：终端尺寸由终端侧决定，客户端不参与」要补上新的语境（**创建时**仍不收，变更走 WS） |

### 4.4 前端改动清单

| 文件 | 改动 |
|---|---|
| `src/protocol/messages.ts` / `frames.ts` | 加 `resized` 的形状校验器（与后端生成的 `shapes.json` 逐字一致） |
| `src/net/client.ts` | 暴露 `session.resize` 上行 |
| `src/ui/app.ts` | 收到 `resized` → 更新持有的 cols/rows → `fitTerminal`（它内部会 `term.resize` 并重解字号）；`attached` 走同一条路径 |
| `src/ui/app.ts`(`debugState`) | 补 `cols`/`rows`，探针要能断言尺寸真的变了 |
| **UI 入口** | 见 §5 决策 2 |
| `src/ui/remember.ts` | ⚠ 刷新后恢复视口是按行号/行文本记的，**resize 会改变行号**。必须重跑 `probe/remember.mjs` 并补一条「resize 之后刷新仍回到那一行」的断言（现在只覆盖「刷新回到原行」） |

---

## 5. 四点决策（**已定**，判据：「最终显示结果与 wezterm 完全一致」）

用户在 Q1/Q2 直接指定，Q3/Q4 交给我按上述判据定。四条如下。

### 决策 1：尺寸的作用域 = **会话级**

尺寸是会话属性：任一客户端改了，同一会话的所有客户端一起变，服务端 PTY 与所有客户端始终同一尺寸。
保住「多客户端逐格一致」。不做每客户端独立尺寸（那要尺寸协商 + padding，等于推翻 §4）。

### 决策 2：谁算 cols/rows = **用户显式设置**（浏览器窗口不参与）

顶栏给一个尺寸控制：预设 80×24 / 120×30 / 160×40 + 手输 `cols×rows`，发给服务端。
不放「按窗口自动算」那条路（那会让窗口参与尺寸，动摇 §4 与字号是因变量这个方向）。
UI 稿见 §9。

### 决策 3：宿主重绘 = **原样放行**

依据（判据的直接推论）：**wezterm 是终端，它把从 PTY 收到的字节全部渲染，不做任何过滤**。
「识别并丢弃宿主重绘」那套逻辑只存在于 **pywezterm 的 `mux.rs`**（那是这个绑定里另做的一个
多分屏宿主，不是 wezterm 的行为），拿它当依据就等于让我们的显示偏离 wezterm。

放行后，我们这一侧的每一步都与 wezterm 同构：同一份字节流 → 同一个终端模型 → 同样的渲染。
反过来，一旦过滤，**我们的模型就会与 wezterm 的模型收到不同的字节** —— 那时"显示一致"从
构造上就不成立，只能靠猜哪些字节该丢、而形态又随宿主版本变（实测过两种）。

已知代价（实测，接受）：每次 resize 给 scrollback 多 1 行空白；宿主缓冲为空时那段会先 `\x1b[2J`
（那时屏幕本来就空）。这两条都是 wezterm 在 Windows 上同样会经历的，不是我们引入的偏差。

### 决策 4：应用请求改尺寸（`CSI 8 ; h ; w t`）= **不支持**（保持与 wezterm 一致）

wezterm 源码写得很直白（`wezterm/term/src/terminalstate/mod.rs:2108`）：

```rust
Window::ResizeWindowCells { .. } => {
    // We don't allow the application to change the window size; that's
    // up to the user!
}
```

它与我们现状也逐条吻合：xterm 对这个序列惰性（`windowOptions` 默认 `{}`、6.0.0 无 case 8），
wezterm 模型也不改自己的尺寸。所以「尺寸只有用户能改」——**这正是 wezterm 的语义**。
（注意别与 `CSI 18 t` 混淆：那是应用**查询**尺寸，xterm 与 wezterm 都回一句
`CSI 8;rows;colst`，两端行为本来就一致，什么也不用做。）

### 顺带查到的一条"已经对齐"的事实

绑定层构造 `Terminal` 时**无条件**调用 `enable_conpty_quirks()`（`term.rs:418`），
而 wezterm 的 `Screen::resize` 里 `resize_preserves_scrollback = is_conpty`（注释：*"On Windows,
the PTY layer doesn't play well with a mutable scrollback, frequently moving the cursor up too high
and erasing portions of the screen."*）。⇒ resize 后的光标与 scrollback 语义，我们**本来就在走
wezterm 在 Windows 上走的那条分支**，不需要额外对齐。

> 遗留的一条**验证项**（不是决策）：客户端 xterm 的 reflow 与模型（wezterm）的 rewrap 是两套实现。
> 实测「内容一致、只差尾部空行」，但要在 §6 的探针里把它钉成断言（存活客户端 vs 重放客户端逐行比对、
> 以及客户端 scrollback vs 模型 scrollback）。若真出现分歧，手边就有一个开关：给 `windowsPty`
> 补 `buildNumber` 会切到 xterm 的第一分支（`buildNumber>=21376` 才开 reflow）——**改这里之前先读
> 上面 §2.2 的注释提醒**。


---

## 6. 验证计划（三层都要能红）

| 层 | 内容 |
|---|---|
| 后端单测（fake 宿主） | 边界校验（含下限 2×1）；`resized` **只在该客户端游标越过变更点时才下发**（有积压时不许提前，反向用例）；同尺寸幂等（不发消息）；多订阅者都收到；`session.resize` 与 `attached` 的尺寸一致 |
| 契约测试（真 PTY + ConPTY） | resize 后**子进程自己报出新尺寸**（照 `size_child` 的做法查 `GetConsoleScreenBufferInfo`）；resize 后 `fed_offset == journal.end_offset` 仍成立；连续 resize 不丢内容 |
| 探针（真 Chromium + 真后端） | 新 `probe/resize.mjs`：改尺寸 → 客户端 cols/rows 与服务端一致、渲染网格像素与新 cols/rows 吻合（`render/size.ts` 的字号解）；**存活客户端与重放客户端逐行一致**；resize 之后**刷新仍回到原行**（补 `remember` 的缺口） |

---

## 7. 明确不做

- 不做每客户端独立尺寸（除非决策 1 选 B）。
- 不改上游 pywezterm（不需要）。
- 不做尺寸持久化：重启回到配置默认值（与今天一致，会话本来就不落盘）。
- 不顺手做「字号用户可调」——那是另一个功能，与尺寸求解的输入输出方向都不同。

---

## 8. 这次调研用的脚本（临时目录，不入库）

`%TEMP%\pwz-probe\`（Windows 的临时目录；**不写死本机用户名**，这是仓库既有的一条纪律
——`probe/env.mjs` 当初就是因为写死了用户名与 Chromium 修订号才被改成从文件位置推导）：

| 脚本 | 测什么 |
|---|---|
| `a_terminal_resize.py` / `a2_dump.py` | wezterm 模型的 resize 语义（reflow、scrollback 边界、光标锚定） |
| `b_pty_resize.py` + `size_child.py` / `silent_child.py` | 真 ConPTY：子进程是否收到新尺寸、宿主重绘的原样字节、GIL 停顿 |
| `b23_repaint.py` | 空对照、以及重绘喂进模型的后果 |
| `d_real_burst.py` | 抓到真实重绘并喂进模型对照 |
| `e_cost.py` | `Pty.resize` / `Terminal.resize` 的耗时与 GIL |
| `c_xterm_resize.mjs` / `c2_csi8.mjs` / `f_min.mjs` | 真 Chromium 里 xterm 的 reflow 等价性、`CSI 8` 是否惰性、尺寸下限 |

这些只是取证脚本（与 `docs/audit.md` 里的 `.audit/` 同一性质）；结论最终由 §6 的测试与探针守住。

---

## 9. UI：尺寸控制（设计稿，待你点头再动代码）

放在**顶栏右侧**（会话标题那一行），因为在哪个会话上操作是清楚的、也不用先展开侧栏；
侧栏卡片右键菜单里再放一份快捷项（与重命名同一处）。

```
┌──────────────────────────────────────────────────────────────────────────┐
│  会话 3 · zsh                                            120×30 ▾        │  ← 触发器：始终显示当前尺寸
└──────────────────────────────────────────────────────────────────────────┘
                                                            ┌────────────────┐
                                                            │ 宽 × 高（列/行）│
                                                            │ ○ 80 × 24      │
                                                            │ ● 120 × 30     │  ← 当前值打点
                                                            │ ○ 160 × 40     │
                                                            │ ─────────────  │
                                                            │ 自定义 [120]×[30] │
                                                            │        [ 应用 ] │
                                                            └────────────────┘
```

行为约定：

- 触发器上的数字**来自服务端**（`attached` / `resized`），不是前端记的；所有客户端显示同一个值；
- 只有 `running` 的会话可改（`exited` 时触发器禁用）；
- 提交后**不做乐观更新**：等 `resized` 回来再变（改尺寸会影响服务端 PTY，前端先改会造出
  「界面说改了、实际没改」的假状态）；期间触发器显示进行中（转圈或置灰）；
- 手输框**不判上下界**：那是协议层的事实（`2 ≤ cols ≤ 1000`、`1 ≤ rows ≤ 1000`），
  由服务端用 `error` 拒回并显示成提示；前端只拦「根本不是尺寸」的输入（空、小数、`1e3`…），
  抄一份边界只会多一个会漂移的常量（与重命名对名字长度同一条纪律）；
- 快捷键 `Ctrl+Shift+R` 打开这个弹层（与既有快捷键族一致，且不占用终端输入——按 §11.2 的约定，
  只接管浏览器级交互）。**⚠ 这条实现时去掉了，理由见 §10.3**。

> 这只是**控制项**，不是布局改版：终端区仍然按「固定网格 + 字号求解」渲染，字号仍是唯一的因变量。

---

## 10. 落地结果（实现后回填）

方案按上面四条决策实现完毕。改动落点：

| 层 | 文件 |
|---|---|
| 协议 | `protocol/messages.py`（`session.resize` / `resized` + `SESSION_COLS_MIN`/`ROWS_MIN`/`SIZE_MAX`）、`vectors/shapes.json`（重新生成）、`docs/protocol.md` §2/§3 |
| 后端 | `core/ports.py`（`SessionHost.resize`）、`core/session.py`（`Session.resize`）、`core/client.py`（`pending_resizes`）、`runtime/pywezterm_host.py`、`runtime/fake_host.py`、`service/hub.py`（`resize_session` + `_flush_pending_resize`）、`config.py`（边界改为引用协议常量） |
| 前端 | `protocol/messages.ts`（`Resized` + 形状 + `sessionResize`）、`ui/size-control.ts`（新，纯函数）、`ui/app.ts`（尺寸 chip → 按钮 + 弹层、`resized` 分支、`debugState` 补 `termCols/termRows`）、`style.css` |
| 测试 | `tests/test_resize.py`（8 条：通路/幂等/顺序/错误路径）、`tests/test_protocol.py`（边界与形状）、`tests/test_contract_pywezterm.py::test_resize_reaches_the_child_process`、`src/ui/size-control.test.ts`（17 条）、`probe/resize.mjs`（25 项，端口 8809） |
| 文档 | `docs/architecture.md` §4/§4.1/§11/§11.1/§15、`docs/protocol.md`、两个 README |

### 10.1 计划里预告的缺口确实存在，并已修掉

§4.4 那条"位置记忆按行号记，而 resize 会改行号"是**真的**，实测两个方向都会坏（都记在
`probe/resize.mjs` 里）：

- 缓冲区**变长**（120 → 80，折行变多）时，记住的绝对行号悄悄指向别的内容 ⇒ 刷新落在另一处。
  实测：live 客户端在 `RZ-0071`，不修的话刷新落到 `RZ-0068`。
- 缓冲区**变短**时，记住的行号可能越过新上界，`#restoreScroll` 的"超出上界就不动"直接跳过
  ⇒ 位置静默丢失。

修法是**改尺寸之后立刻重记一次位置**（`ui/app.ts` 的 `resized` 分支），记的是 xterm 重排之后
的位置，也就是 live 客户端此刻看着的那一处。`probe/resize.mjs` 有两条**用例前提**断言
（"reflow 挪动了视口行号"、"视口在历史深处"）保证那条断言不是恒真的；去掉修复后它精确报红
（红/绿两边都跑过）。

顺带确认：**停在底部**（跟随输出，最常见的情形）改尺寸完全正常——改完仍在底部，刷新也在底部，
不写记忆。

### 10.2 与 wezterm 一致这一条，落到了实处

- 宿主重绘**原样放行**（决策 3），于是我们的模型与 wezterm 收到同一份字节。
- 绑定层的 `enable_conpty_quirks()` 生效 ⇒ `Screen::resize` 走 `is_conpty` 分支，与 wezterm
  在 Windows 上同一条路径。
- 应用改尺寸**不支持**（决策 4），与 wezterm 的 `ResizeWindowCells` 分支逐字一致。
- 真浏览器里验过：**"活过整次改尺寸的客户端"与"改完之后才订阅、整段重放"的客户端屏幕逐行
  一致**。这就是 §3.2 那条 reflow 等价性在真实运行环境里的落点。

### 10.3 一处与 UI 稿的偏差

稿子里写了 `Ctrl+Shift+R` 打开弹层，**实现时去掉了**：那是浏览器的硬刷新
（Chrome/Edge/Firefox 都是），而这个应用本身就是终端——把它接管掉等于拿掉用户手上的应急出口。
入口就用顶栏那个 chip（它同时显示当前尺寸，位置本来就对），另外弹层支持 Esc 与点外面关闭。


