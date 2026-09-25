# 审计报告

审计日期：2026-09-22（首轮缺陷）、2026-09-24（第二轮：清理与验证层）、2026-09-25（第三轮：交付前清理）、2026-09-25（第四轮：测试同步纪律）｜ 范围：`backend/`、`frontend/`、`docs/`、`vendor/` ｜ 方式：读代码 + 跑测试 + 真实 PTY/真实浏览器探针

三层验证都做了，结论如下。全部缺陷（A1–A13）已修复并**各自留下一条能在 CI 里跑的回归**，对照表见文末
§3；当时用的一次性取证脚本（`backend/.audit/*.py`）已完成使命、**已删除**，文中的实测数字是它们留下的结论。
仓库里长期保留的是两类真正值得跑的验证：`backend/tests/`（含 `-m contract` 的真 ConPTY 用例）与
`frontend/probe/`（真 Chromium 探针，见 `frontend/probe/README.md`）。

第二轮（2026-09-24）审的是**验证本身**：探针里的恒真断言、写死的本机路径、各自的服务器副本、
以及「共享契约只覆盖了 6/18 种消息」这个洞。发现的都是**测试层缺陷**（A1–A13 的产品代码没有再出新问题），
记在 §2.7；这一轮同样把它们修完并验证了「测试真的能红」。

第三轮（2026-09-25）是交付前的清理：死代码与陈旧引用、两个入口不一致的校验、
源文件里被嵌入的不可见控制字节，以及一条**偶发假红**的探针。发现与处置记在 §2.8。

第四轮（2026-09-25）审的是**测试怎么等**：默认套件里用固定睡眠当同步手段的地方全部换成
具名栅栏，并把这条纪律做成会红的测试。发现与处置记在 §2.9——§2.7.1 那条未能归因的偶发红，
其机制类别（“等到的不是事件，而是时间”）也随之从套件里消失。

---

## 0. 先说通过的部分

| 项 | 结果 |
|---|---|
| 后端测试（默认） | `328 passed, 32 skipped`（10 秒内跑完；零固定睡眠，见 §2.9） |
| 后端契约测试（真实 pywezterm + ConPTY） | `TERMINALD_CONTRACT=1 pytest -m contract` → **32 passed**（含 A13 拆除路径与输入字节保真两条回归） |
| `ruff check .` / `ruff format --check .` | 通过（无告警、49 文件已格式化） |
| `mypy src` | 通过（31 个源文件） |
| `tsc --noEmit` | 通过 |
| `vitest run` | 115 passed（6 个测试文件，含前后端字段形状契约） |
| 浏览器探针（7 个，均自带服务器，`npm run probe:all` 合计 93 项） | smoke 23/23、multi-client 10/10、scrollback 6/6、remember 19/19、input-hold 13/13、shortcuts 19/19、conpty-alt-screen 3/3 |
| **刷新后位置不丢** | 真实 Chromium：刷新后仍在那一个会话、视口回到刷新前那一行、那一屏逐行一致（`probe/remember.mjs`，19/19） |
| **四个浏览器级交互** | 真实 Chromium + 真 ConPTY：F11 全屏且不污染终端输入、Ctrl+C 有选区才复制又不断进程、Ctrl+V 真把剪贴板送进终端、有选区右键直接复制（`probe/shortcuts.mjs`，19/19；无头与可视两种模式都过） |
| **多客户端逐行一致** | 真实 Chromium 三客户端（两个在输出中订阅、一个结束后订阅）：底部屏幕逐行相同、滚到顶的历史逐行相同、`ROW-0001` 可达 |
| **scrollback 真的交付到浏览器** | 300 行输出后可一路滚回最早一行（142 次滚轮），三客户端顶部 30 行完全一致 |
| 会话生命周期 | 0 客户端存活、进程退出不销毁、刷新整段重放，行为与设计一致 |

两点澄清（都曾经是设计阶段的悬念，实测已排除）：

1. **ConPTY 会把折行写成硬换行**。`\x1b[?7h` 下 200 列的长行经 ConPTY 后原始字节里出现 5 个 `\r\n`（见探针输出），模型里的 `wrapped` 位因此恒为 `False`。也就是说「快照重建丢 wrap 语义」在 Windows/ConPTY 路径上不成立——两端解析的是同一份带硬换行的字节。（直接 `feed` 不经过 ConPTY 时 `wrapped` 位是正确的，说明这是 ConPTY 的行为而不是绑定或模型的缺陷。）
2. **`.xterm-viewport.scrollTop` 不是 xterm.js v6 的滚动入口**。v6 的滚动由 `.xterm-scrollable-element` / 内部 scrollTop 承担，`viewport.scrollHeight - clientHeight` 恒为 0。第一轮探针据此误判「浏览器里没有 scrollback」，用小步滚轮复核后推翻。**今后任何涉及滚动的探针/代码都不要用 `.xterm-viewport.scrollTop`。**

   这句话写下来了，两个探针却仍在违反它（§2.7 V1/V2）：`multi-client.mjs` 用程序化 `scrollTop` 做了两次
   实际没滚动的“滚动比对”，`smoke.mjs` 量`.xterm-viewport` 来断言“滚动条贴右边缘”。两条都是恒真的。
   现已改成真滚动：拖 v6 自己那条滚动条的拇指（同时也证明了它**存在、贴右边缘、拖得动**）。

---

## 1. 缺陷清单

| 编号 | 严重度 | 一句话 | 状态 |
|---|---|---|---|
| A1 | **严重** | 客户端输入走事件循环的阻塞写：一次大粘贴冻结**整个服务**（实测 15.7 s） | ✅ 已修（单一写者） |
| A2 | **严重** | 重建快照是撕裂读，且对齐点落在快照之后：客户端同时拿到空洞与重复 | ✅ 已修（模型单线程所有者） |
| A3 | 中 | 首条消息不是 `hello`（或 JSON 非法）时异常逃出 WS 端点：没有干净关闭码、没有 `error` 消息，只留下服务端 traceback | ✅ 已修（`bad_hello` + 1002） |
| A4 | 中 | `Ack` 通路空转：`acked_offset` 从不参与任何决策，文档却称它是「落后判定与日志裁剪的依据」。**而实测证明它本该管的那件事真的会发生**：客户端未解析积压无上界（4 MiB 输出 → 4 MiB 积压） | ✅ 已修（接成实时推送窗口） |
| A5 | 中 | 文档 §9 的 GIL 结论与代码相反，且正是这条错误结论让 A1 一直存在 | ✅ 已修（文档与注释） |
| A6 | 中低 | 同一个 PTY 有两个写者（读线程写应答 + 写线程写输入），且应答写会阻塞读循环 | ✅ 已修（唯一写者） |
| A7 | 低 | 死协议面：`Sized`、`Bell` 服务端从不发送；`Outbox.behind` 无人读 | ✅ 已删（连同那个派生的 `behind` 标志） |
| A8 | 低 | 刷新后总会落到**列表里的第一个会话**，不是刚才在看的那个 | ✅ 已修（Tab 级记忆） |
| A9 | 低 | 刷新后视口滚动位置不恢复（当初设计说要存） | ✅ 已修（同上，含 alt-screen 例外） |
| A10 | 中 | 输入方向写队列无界：一次超大粘贴会让内存随输入量增长，且没有任何机制让发送方停下来 | ✅ 已修（协作式暂缓 + 硬上限） |
| A11 | **中** | **新建会话这条路**（服务端主动 attach，不经过侧栏点击）有两个独立缺陷：前端订阅基线没重建 → 新会话的输出**被判成不连续后全部丢弃**（终端永远刷不出来）；应用没清屏 → 旧会话内容与新会话输出混在一屏 | ✅ 已修（客户端重建基线 + 应用清屏） |
| A12 | **中** | 四个浏览器级交互全都不对：**Ctrl+V 根本不粘贴**（只往 PTY 塞一个 `0x16`）、Ctrl+C 有选区只打断不复制、F11 把 `\x1b[23~` 塞进 PTY、有选区时右键不复制 | ✅ 已修（快捷键扩展，`ui/shortcuts.ts`） |
| A13 | **严重** | 拆除路径让整个服务冻住（A1 的同一类错误的第二个入口）：`DELETE /api/sessions/{id}` → `Pty.close()` → `ClosePseudoConsole` 等子进程树释放控制台，实测**普通子进程 5 ms、控制台被孙进程握着 298 s**；**而绑定层的 `close()` 不释放 GIL**，于是这不是「某个线程慢」，是**整个解释器停摆** | ✅ 已修（Job Object 终止整棵树 + 拆除两阶段，见 A13 一节） |

---

## A1（严重，已修）输入阻塞事件循环 —— 一次大粘贴冻结整个服务

**现象（实测）**：对一个「子进程不读 stdin」的会话发 4 MiB 输入，同一事件循环上的另一个 HTTP 请求（`GET /api/healthz`）从 **0 ms 涨到 18953 ms**；`ws.send` 本身只用了 31 ms（说明卡在服务端处理，不是网络）。影响面是**整个进程**：其他会话的输出扇出、其他客户端的发送、全部 HTTP 接口，全部停摆 19 秒。

```bash
cd backend
./.venv/Scripts/python.exe -m terminald --port 8765 --host-impl pywezterm   # 另开一个终端
./.venv/Scripts/python.exe .audit/input_block.py   # 一次性脚本，已删除；结论由 `pytest -q -k blocked_write` 守
# 基线 healthz 延迟: 0.0 ms
# ws.send 本身返回用了 31.0 ms
#   healthz #0: 18953 ms      ← 整个服务在此期间无法响应
```

**根因**：`Hub.handle_input` → `Session.write_input` → `SessionHost.write` → `Pty.write`，而 `Pty.write` 是**阻塞调用**，它是在事件循环线程上被执行的。GIL 已经放掉了（绑定层 `Pty::write` 里的 `py.detach`，源码在 `reference/pywezterm/wezterm/pywezterm/src/pty.rs`），但**放掉 GIL 并不能让调用线程自己走开**——事件循环线程仍然卡在这一个调用里，于是所有会话的读、所有客户端的发送全部停摆。仓库自己的文档里量过这个量级：ConPTY 下「1 MB ≈ 4s、8 MB ≈ 30s」。

**现成的解法就在仓库里**：`SessionRunner` 有一个专用写线程（`runner.py:_write_loop` + `submit_input`），但 `grep -rn "submit_input" backend/src` 显示**没有任何调用点**。

**修法（已落地）**：输入不再经 `Session` 直写 PTY，而是统一走该会话的写线程——它成为**唯一写者**（客户端输入、模型应答、焦点应答共一条 FIFO）。`Session.write_input` 已删除，避免留下第二条可被误用的写路径。

**验证**（`backend/.audit/a1_write_isolation.py`，**一次性脚本、已删**；真实 ConPTY + 独立线程监视循环心跳）：

```bash
cd backend
./.venv/Scripts/python.exe .audit/a1_write_isolation.py   # 已删除；见 §3 的回归
# handle_input 用了 0.0 ms | 循环最大停滞 32.0 ms | 写线程已开始=True 仍在阻塞=True
# >>> 判定：通过 —— 阻塞被限制在写线程里，事件循环保持毫秒级心跳。
```

真实服务级复核（`backend/.audit/input_block.py`，与审计时同一个构造；原来这里是 `healthz #0 = 18953 ms`）：

```bash
cd backend
./.venv/Scripts/python.exe -m terminald --port 8765 --host-impl pywezterm   # 另开终端
./.venv/Scripts/python.exe .audit/input_block.py   # 一次性脚本，已删除；结论由 `pytest -q -k blocked_write` 守
# 基线 healthz 延迟: 0.0 ms
# 发送 4.0 MiB 输入…   ws.send 本身返回用了 32.0 ms
#   healthz #0: 15 ms         ← 修复前是 18953 ms
# 从发送到事件循环恢复响应：0.0 s
```

回归测试：`tests/test_hub.py::test_blocked_write_never_stalls_the_event_loop`（用 `BlockingHost` 把「写阻塞」变成可断言状态，并证明阻塞期间循环仍能服务其他客户端）。

---

## A2（严重，已修）重建快照是「撕裂读」，且对齐点落在快照之后

**一句因果链**：模型在**读线程**里被喂，日志与快照/对齐在**事件循环**里做，两者之间没有任何同步——于是重建路径同时踩中两个缺陷：快照本身是撕裂的，且对齐点比快照内容还早。

```
读线程： pty.read → term.feed(data) ──→ 模型位置随时推进（feed 期间还占着 GIL）
事件循环： 桥消费 → journal.append(data) → 需要时渲染快照、登记对齐点
```

**缺陷 1：`snapshot()` 是撕裂读。** `PyweztermHost.snapshot()` 是**多步**渲染：`mode_restore_seq` → `render_scrollback` → `render_ansi`，每一步都各自重新读取活着的模型（`term.rs` 里每次调用各自取锁）。三步之间读线程继续 `feed`，滚动区与可见区就取自**不同时刻的模型状态**，中间出现空洞。

**缺陷 2：对齐点比快照内容更早。** 重建路径（`Hub._attach` 的 `Rebuild` 分支与 `Hub._on_resync`）取 `end = journal.end_offset` 作为对齐点，而 `journal.end` 落后于模型位置（≥ 桥积压，再加上渲染期间读线程的推进）。客户端被对齐到 `end` 后，服务端从 `end` 补发原始字节——快照已经画过的内容被再画一遍。

**复现（真实 pywezterm + ConPTY，一次典型运行）**：

```bash
cd backend
./.venv/Scripts/python.exe .audit/rebuild_torn.py   # 已删除；结论由 `TERMINALD_CONTRACT=1 pytest -m contract -k rebuild` 守
# 快照前：pump=65653 journal.end=65653 模型最后一行=N2261 桥深度=0
# 快照后：journal.end=65653 模型 feed 总字节=73845 对齐点=65653
# 快照=83842 字节、2261 个 marker；可见区最后一行=N2544
# 快照滚动区末尾=N2237，可见区首行=N2521 → 空洞 283 行
# 对齐点对应行=N2262；快照可见区最后一行=N2544 → 快照把对齐点之后的 282 行先画了一遍
```

一组数字正好串成链条：attach 时模型与日志是对齐的（都是 65653，模型在第 N2261 行）；快照渲染期间读线程又喂进一个 8 KiB 块（模型 73845）；`render_scrollback` 还在旧状态下画到 N2237，`render_ansi` 已经在新状态下从 N2521 画起 → 中间 **283 行丢失**；而客户端对齐在 N2262，于是 N2262..N2544 这 **282 行又被补发一次**。

**影响**：日志被裁剪后的刷新/重同步（最需要「内容不消失」的那条路径）会得到一份**既有空洞、又重叠**的历史：真实内容缺一段，缺的那段又被画在错误的位置上。这不是显示瑕疵，是内容真源的交付错误。

（早先的 `rebuild_skew.py` 只检测到「重叠」，漏掉了撕裂这一半——它的交集判据太弱：只要后续字节足够长，任何快照 marker 都会与之相交。新探针 `rebuild_torn.py` 直接量三个位置，机制才完整。）

**为什么 201 条单测 + 浏览器测试都没抓到**：FakeHost 没有终端模型（`pump` 只搬运队列、`snapshot()` 只回最近字节），所以「模型超前 / 撕裂」这一类缺陷在 fake 宿主上**不可能复现**；真实宿主的契约测试只覆盖了「快照与整条字节流最终一致」的静态场景，没有并发压力。

**根因（设计层）**：文档声称「所有会话状态只在事件循环线程上改动」，但**终端模型是例外**——它在读线程被改，却在事件循环被快照/元数据/焦点读写，没有任何同步或所有权约束。这与 A1/A6 是同一类错误：**跨线程共享的可变/阻塞资源没有单一所有者**。

**最优修法：让模型只属于事件循环线程（单线程所有者），不加锁。**

- 宿主端口拆成 `read()`（读线程：只 `Pty.read`）与 `ingest()`（事件循环：`feed` + `drain_written`，返回要回写 PTY 的应答）；
- `journal.append` 与 `host.ingest` 在 `Hub._ingest_output` 里**相邻执行**（同线程、中间无 await）→ `模型位置 == journal.end_offset` 恒成立，快照与对齐点天然同源；多步渲染也就不再有并发可乘之机；
- 应答不再由读线程直接写 PTY，而是与客户端输入共用写线程队列（一并解决 A6）；
- 把不变量做成可执行的：契约测试断言 `host.fed_offset == journal.end_offset`，以及「快照滚动区末尾 + 1 == 可见区首行」。

**为什么不选「保留当前分工 + 记录 fed_offset + 加锁」**：那需要把 `feed` 与**整段多步快照渲染**放进同一把锁，并新增第二个偏移坐标（fed 与 journal 两套），状态与失效面都更大；而「把解析留在读线程」的收益在 GIL 下接近于零——`feed` 期间本来就占着 GIL，循环的 Python 代码一样跑不了。

**修法（已落地）**：端口按线程归属重切——`read()`（读线程）/ `ingest()`+`set_focus()`+`snapshot()`+`metadata()`（事件循环，模型的唯一所有者）/ `write()`（写线程，唯一写者）；`Hub._ingest_output` 里 `host.ingest(data)` 与 `journal.append(data)` 相邻执行。

**验证**（`backend/.audit/rebuild_torn.py`，**一次性脚本、已删**；真实 ConPTY，强制裁剪后接新客户端）：

```bash
cd backend
./.venv/Scripts/python.exe .audit/rebuild_torn.py   # 已删除；结论由 `TERMINALD_CONTRACT=1 pytest -m contract -k rebuild` 守
# 快照前：fed=65595 journal.end=65595 差=0 字节 模型最后一行=N2259 桥深度=0
# 快照渲染时：fed=65595 journal.end=65595 差=0 字节（应为 0）
# 快照=83781 字节、2259 个 marker；行号连续=True 范围=N1..N2259
# 对齐点=65595（对应行=N2260）| 快照可见区最后一行=N2259 | 快照与补发字节重叠 0 行
# 被重复绘制的行数=0（应为 0）
# >>> 判定：通过 —— 快照是原子的（模型与日志同源），且与补发字节无缝衔接。
```

回归测试：`tests/test_contract_pywezterm.py` 的两条契约用例（`test_model_and_journal_stay_aligned_under_flood`、`test_rebuild_after_trim_has_no_hole_and_no_overlap`）。

---

## A3（中，已修）首条消息非法时异常逃出端点

> 已在 §2.4 记录修法与取证。

```bash
cd backend
# 服务已在 8765 运行时：
curl -s -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  http://127.0.0.1:8765/ws   # 建链后用任意 WS 客户端发首帧 {"t":"attach","session":"x"}
# 期望：收到 {"t":"error","code":"ProtocolViolation",...} 再被以 1002 关闭
# 实际：连接被直接掐断（ASGI 层因未处理异常关闭），服务端日志多一条 traceback
```

复现：连上 `/ws` 后把 `{"t":"attach","session":"x"}` 当首条消息发出。

- `api/ws.py:_read_hello` 会 `raise ProtocolViolation`（JSON 非法时是 `MessageError`）；
- 端点只 `except WebSocketDisconnect / TimeoutError`，**这两类都没接**；
- 结果：异常冒到 ASGI 层，客户端看到的是非正常关闭，既没有 `Failure(code=...)` 也没有关闭原因，服务端留下一条 traceback。

`this.#onControl` 那侧的处理是对的，所以这只影响握手期。**修复**：在端点里捕获这两个异常 → `_send_control(Failure(...))` + `_close(WS_PROTOCOL_ERROR/WS_REJECTED)`（工具函数都已存在），并在 `test_api.py` 加两条用例。

---

## A4（中，已修）`Ack` 通路空转 —— 而它本该管的那件事真的会发生

`grep` 显示 `acked_offset` 只被**写**（`note_ack` / `reset_ack`），**没有任何地方读它**。真正在起作用的流控是「`next_push_offset` 游标 + outbox 水位 + `on_drained`」，而文档与注释在描述另一套机制（`docs/architecture.md` §6 表格、`core/client.py` 注释都说它是「落后判定与日志裁剪的依据」——代码里裁剪只看预算）。

**但“删掉它”是错的**：我为这件事写了取证脚本（`backend/.audit/unacked_backlog.py`），把「哪个机制在限制什么」量了一遍：

```
产出总量        : 4.0 MiB（客户端只在新数据到达时才 ack，链路上没有断点）
日志预算        : 256 KiB
已推送 - 已确认 : 峰值 4064.0 KiB —— **远高于日志预算**
Behind 下发次数 : 0
```

即：“socket 很快、渲染很慢”的客户端（内核 TCP 缓冲照常收下）能让服务端把**整条流**推出去，
而 `acked` 停在 0。**未解析积压跟的是输出总量，不是日志预算**（我上一轮以为“日志预算已经把积压限在 8 MiB”，错了）：
发送队列水位只能限制「已交给 socket、还没写完」的字节，它**看不见客户端已经吃下的字节**。慢渲染的
浏览器于是可以在内核/渲染进程里攒出任意大的未解析缓冲——这正是 xterm.js flowcontrol 文档要求服务端用 ack 控制推送的原因。

**修法（接通，而不是删）**：实时推送多一道窗口 `push_ahead_bytes`（默认 2 MiB）。

| 位置 | 改动 |
|---|---|
| `config.py` | 新增 `push_ahead_bytes`（必须 ≥ 一个分片） |
| `core/client.py` | `acked_offset` 注释更正为“窗口依据（**不是**裁剪依据）”；新增 `ack_seen`（收到过至少一次真正推进的 `Ack`） |
| `hub._push_client` | 两道互相独立的限制：发送队列水位 + 解析窗口；越过窗口就停手 |
| `hub._on_ack` | 不再是“顺手重试”，而是**唯一**的解锁信号（`on_drained` 管不到客户端渲染到哪） |
| `tests/test_push_window.py` | 4 条：窗口生效且 ack 后继续推、不会 ack 的客户端不被限流、窗口卡住者降级到 `Behind`+重建、配置校验 |

修复后同一构造（窗口 256 KiB、客户端每 1 MiB ack 一次）：

```
首次 ack 之前   : 积压涨到 96.0 KiB（窗口只对“证明过会 ack”的客户端生效）
窗口生效之后    : 峰值 256.0 KiB（上界 = 窗口 + 一个分片）
Behind 下发次数 : 0
```

两个刻意的边界：窗口**只对证明过会 ack 的客户端生效**（否则不会 ack 的实现会被停在一个永远解不开的
窗口上）；窗口加日志预算必须明显大于客户端的 ack 节奏，否则被卡住的客户端会被裁剪追上、进入
`Behind`→重建的循环（我在探针里拿“预算≈窗口”的配置真的复现到这个循环——它是正确但昂贵的收敛）。

---

## A5（中）文档 §9 的 GIL 结论与代码相反（并且它是 A1 的成因）

`docs/architecture.md` §9 尾注写着：

> `Pty.write` 在**放掉 GIL** 之后才做阻塞写 … **放进独立线程也救不了，因为 GIL 不是线程能绕开的。**

前半句与代码一致（`pty.rs:327` 的 `py.detach`），**后半句是错的**：既然写的时候 GIL 已经放掉，独立线程完全能把阻塞与事件循环解耦。当前之所以还会冻住服务，**恰恰是因为事件循环线程自己在做这个阻塞调用**（A1）。这条结论把唯一正确的修法判了死刑，才留下 A1 + 那个从未被接线的写线程。**修复**：改写这段并指向写线程。

---

## A6（中低）同一个 PTY 有两个写者

- 读线程：`PyweztermHost.pump()` 里把终端模型对应用的应答 `pty.write(responses)`（`pywezterm_host.py:84`）；
- 写线程：`SessionRunner._write_loop` 写客户端输入。

两个线程并发写同一个 master fd，字节序无法保证（应答可能与用户输入交错）；更要紧的是**应答写会阻塞读循环**：一旦子进程不读输入、而模型又要回写较大应答，读线程就停在写里 → 没人读 stdout → 子进程阻塞 → 潜在死锁。**修复**：A1/A2 的那次改造里顺手统一成「唯一写者 = 写线程队列」，应答也走队列；`set_focus` 里的那处 `pty.write(responses)` 同理。

---

## A7（低）死协议面

`Sized`、`Bell` 在 `protocol/messages.py` 里定义、在 `frontend/src/ui/app.ts` 与 `protocol/messages.ts` 里都有处理分支，但**服务端从不发送**：

- `sized` 是为「终端侧改尺寸」预留的，当前尺寸固定，没有发送点；
- `bell` 不需要单独消息——`\x07` 本来就在原始字节流里，xterm.js 会自己处理。

`Outbox.behind` 同样无人读（`Outbox.would_exceed` 在用，`behind` 不用）。按仓库自己的规则（不留兼容/预留面），建议删掉这三处。

**最终处置（已做，见 §2.5）**：`Sized`、`Bell` 一并删除（连同前端的处理分支、类型表、测试与文档），
`Outbox.behind` 连同那个派生出来的 `_behind` 标志一起删掉。`sized` 没有保留成“未启用项”：
它连一个发送点都不存在——给不存在的功能留消息面，正是这条审计要销掉的东西；真做改尺寸时再加。

---

## A8（低，已修）刷新后总落到「第一个会话」

`app.ts` 在收到 `sessions` 时只在 `#activeSession === null` 时选中 `sessions[0]`，并且**没有任何地方持久化当前会话 id**。多会话场景下 F5 会落到列表第一个会话——内容不会丢，但不是你刚才那个。

**修复时踩到的那个坑确实存在**：可以把会话 id 存进 `sessionStorage` 并在刷新后用它 `attach`，但**必须用 `resume: null`（整段重放）**，不能带上刷新前的 offset——新页面的 xterm 是空的，按 offset 续传只会得到一屏空白。这条正好是「两个 offset 分开」设计的边界，所以新模块（`remember.ts`）干脆**不提供任何记 offset 的入口**，让那个错误写法没有落点。

**最终做法（见 §2.6）**：会话 id 存 `sessionStorage`（**Tab 级**：多客户端是这个项目的核心场景，用 `localStorage` 会让一个标签页的切换改掉另一个标签页的记忆），首屏用 `pickInitialSession(列表, 记忆)` 选会话——记忆里的那个可能已被关掉/服务端重启过，所以必须拿列表校验一遍再回退到第一个。

---

## A9（低，已修）刷新后视口滚动位置不恢复

设计阶段说过「客户端把 viewport 的 scrollTop 一起存」，实现里没有。当前刷新后停在底部（和大多数终端一致），不算缺陷，只是与当初的承诺不符。

**落点选在公开 API 上**：v6 的滚动位置不在 `.xterm-viewport` 上（见第 0 节第 2 条），所以只读 `term.buffer.active.viewportY / baseY`，只写 `term.scrollToLine()`（内部是 `scrollTop = line × 行高`，越界会被浏览器钳到两端）。

**什么时候恢复是确定的，不是猜的**：`attached.offset` 是本次订阅的重放终点（服务端保证 `attached` 先于字节），所以「已解析偏移 ≥ 它」就等于「重放字节全部进了 xterm」。比这更早滚动没有意义（缓冲区还没那么长），更晚则要先回答「输出流什么时候停」——那没有答案，shell 随时可能再吐一行。用户自己动手（输入 / 滚轮 / 鼠标）就放弃恢复。

**两条刻意的边界**：停在底部**不记**位置（“跟随输出”本来就是默认行为，记下来只会让下次刷新多做一次无意义的滚动）；备用屏（`?1049h`）里既**不记也不恢复**——它没有 scrollback，行号一退出就整个失效。

> **平台事实**（`docs/architecture.md` §12 的表里本来就有这一行）：Win10 的 ConPTY 会把子进程的 `\x1b[?1049h` 吃掉，所以第二条边界**在那台机器上无法端到端验证**。本轮给它补了一个对照组探针（当时的 `probe/conpty-alt-screen.mjs`，§2.6），并且把探针里那条本来会“恒真”的断言换成断言平台事实——代码保留这条保护是为了平台无关的正确性（Linux/pty 与会转发该序列的 ConPTY 版本），但“在这里验证过”这句话不成立，就不写。

> **复核补充（2026-09-25）**：宿主换成随包侧载的 OpenConsole 之后 `\x1b[?1049h` **会**到达客户端
> （逐条实测见 `probe/conpty-modes.mjs`，它取代了上段那个只看一条序列的探针），所以这条边界现在
> **可以**端到端验证了。上段「无法验证」的说明只在宿主是系统 conhost 时成立——这也是为什么
> `probe/conpty-modes.mjs` 要把宿主转译的 23 条事实都钉住：宿主一换，结论就变。

---

## A11（中，已修）新建会话这条路：终端永远刷不出来 + 旧内容不清屏

这是修 A8/A9 的浏览器探针顺手撞出来的，两个**独立**的缺陷叠在同一条路径上（服务端主动 attach，即点击 `+` 新建会话）：

**a) 前端订阅基线没重建 → 新会话的输出全部被丢弃。** 服务端在 `session.create` 时会把创建者直接 attach 上去，并推 `attached` + 新会话的字节（offset 从 0 重新起算）；而前端 `TerminalClient` 的本地偏移还停在**上一个会话**的末尾，它只是把这条 `attached` 当作“自己请求的那次订阅的回应”。于是新会话的第一帧 `offset=0` 触发 `OUTPUT 帧不连续` 检查 → 报协议错误、整条流被丢弃。**用户看到的是：新建会话后终端一直不刷新，敲键盘也没反应**（TCP 层一切正常，所以只有探针能抓到）。

**b) 应用没清屏 → 两个会话的内容混在一屏。** 清屏只发生在侧栏点击那条路径（`#select`）。新建会话不经过它，于是旧会话的可见屏与 scrollback 原样留着，新 shell 的横幅和提示符直接画在上面。

**两个都不能只修一个**：只修 (a) 会得到一个“能交互但屏幕上是旧内容”的会话；只修 (b) 会得到一块干净但永远死的屏。探针里两条断言各自能独立地把对应的一半照出来（§2.6）。

---

## A13（严重，已修）拆除一个会话可以冻结整个服务——A1 的第二个入口

**怎么发现的**：跑浏览器探针时撞上一个「收 TCP 连接但永不回话、CPU 又不涨」的服务端。
CPU 平、事件循环不响应 = **被同步调用挡住**（而不是死循环），所以顺着 A1 的那条原则去找
「谁在事件循环上做阻塞调用」——写入路径已经修过，**拆除路径从来没被审过**。

**现象（当时的一次性探针，已删；数字保留）**：

| 量法 | 结果 |
|---|---|
| 真服务 + 心跳线程（每 50 ms 打一次 `GET /api/healthz`），对比删除两种会话 | **对照**（普通 `cmd.exe`）：DELETE ×3，心跳最差 **25 ms**、零超时；**实验**（`cmd /c start /b ping -t`）：DELETE ×3，心跳**成片超时 15 次**，而且这一轮之后服务端**再也没恢复** |
| 不经服务、不看事件循环，直接给绑定层计时 `pty.close()` | 普通子进程 **0.005 s**；控制台被孙进程握着时 **87.96 s / 236.74 s / 297.99 s**（不同轮次，图的就是“无上界”） |

**第一轮修法无效，而这一点是量出来的**。先按 A1 的结论把拆除挪出事件循环（`asyncio.to_thread(runner.stop)`）
——**服务照样冻死**。于是不再猜，直接问「挪走为什么没用」：

| 量法 | 对照（普通子进程） | 实验（孙进程握着控制台） |
|---|---|---|
| 后台线程调 `close()`，主线程量自己的调度间隔 | `close()` 0.006 s，主线程最差间隔 **0.000 s** | `close()` **236.740 s**，主线程最差间隔 **236.734 s** |

两个数字相等，结论就只有一个：**绑定层的 `close()` 不释放 GIL**（`pywezterm/src/pty.rs` 的
`fn close(&self)` 既没有 `py.detach`，也不接受 `py` 参数）。持着 GIL 的 C 调用阻塞时，**任何**
Python 线程都跑不了——所以「把它挪到别的线程」根本不可能修好它。

**根因（两层，必须都拆掉）**：

```
DELETE /api/sessions/{id}
  → Registry.close()            ← ① 在事件循环上（FastAPI 处理器里同步调用）
    → session.host.close()
      → PyweztermHost.close → pywezterm `Pty.close()`
        → child.kill() + cancel_reader_thread() + ClosePseudoConsole()
```

② 那一次 `ClosePseudoConsole` 会等 conhost 退出（= 等最后一批控制台客户端断开），而
`child.kill()` **只杀直接子进程**：`cmd /c start /b ping -t ...` 这类写法留下的孙进程仍然握着控制台。
于是「一个普通用户随时会造出来的子进程结构」就让这次调用无界等待，而它**同时**占着 GIL。
`close_all()`（应用退出）走的是同一条路。

影响面与 A1 一模一样：其他会话的输出扇出、其他客户端的收发、全部 HTTP 接口一起停摆，
时长由子进程树的寿命决定。会话数越多越容易撞上。

**一个反直觉的细节**：同样“孙进程活着”的两种造法里，只有 `cmd /c start /b <控制台程序>`
复现得出来（不做树终止时 `close()` 等 **297.99 s**）；换成「父进程活着、`subprocess.Popen` 起孙进程」
反倒 6 ms 就返回。回归测试因此**必须用前一种造法**，否则是一条恒绿的假回归——我先写错过一次。

**修法（两层各自根治，而不是把阻塞搬个地方）**：

| 层 | 做法 |
|---|---|
| ① 拆除阶段化 | `Hub` 把拆除拆成同步的 `_detach_session`（摘除 runner/bridge/pump + 从注册表摘除）与 `asyncio.to_thread` 里的 `_release_session`；摘除**先**做并立即广播会话列表，其他客户端不必陪一个正在拆除的会话等。`Registry.detach()` 与 `Registry.close()` 分开，后者明确只允许在线程里调用 |
| ② 让那次等待不发生 | `runtime/winjob.py`（新）：把会话子进程纳入一个 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的 Job Object（绑定层为此专门暴露了 `child_handle()`，注释写的是「Job 注册用」），关闭前先 `TerminateJobObject` 终止**整棵树**，控制台没有客户端之后 `ClosePseudoConsole` 立即返回。实测 `TerminateJobObject` 1 ms、之后 `close()` 1 ms |

为什么不做成「关不掉就放弃」：进程树杀不掉时，那次调用**持着 GIL**，丢弃线程也救不了——解释器
仍然停摆。所以唯一正确的做法是让阻塞不再发生；纳管失败时宁可让会话创建失败（`PyweztermHost._adopt`
只在子进程**已经退出**时才容忍失败），也不静默降级。

**回归（三条，各自钉住修法的一个环节）**：

| 测试 | 钉住什么 |
|---|---|
| `tests/test_host_teardown.py::test_process_tree_is_terminated_before_the_console_is_closed` | 顺序契约：`adopt` → `terminate` → `pty.close` → `tree.close`，且 `close()` 幂等（无需真 PTY） |
| `tests/test_host_teardown.py::test_terminate_kills_grandchildren` | `WinJob.terminate()` 真的杀掉孙进程（真实进程树，Windows） |
| `tests/test_host_teardown.py::test_adoption_failure_*` | 纳管失败的处置策略：子进程活着时失败必须抛，已退出时容忍 |
| `tests/test_hub.py::test_blocked_close_never_stalls_the_event_loop` | 拆除期间事件循环仍服务其他客户端；摘除发生在阻塞释放**之前**（去掉 `to_thread` 即红） |
| `tests/test_api.py::test_deleting_a_session_does_not_freeze_http` | 用户看到的那个症状：DELETE 悬在释放上时其他 HTTP 请求照常被服务 |
| `tests/test_contract_pywezterm.py::test_closing_a_session_kills_the_tree_and_stays_bounded` | 真 ConPTY：`close_session` 有界（<5 s，原来 88–298 s）且循环未被饿死 |

---

## A12（中，已修）四个交互在浏览器里都不是「能用」的状态：Ctrl+V 根本不粘贴

这一组不是后端缺陷，而是**浏览器与 xterm 默认行为的冲突**：单测不可能发现（它没有键盘），
只有真实浏览器 + 真实 PTY 探针才看得见。

**现象（当时那个一次性探针（现已并进 `probe/shortcuts.mjs`）的修前基线，12 项里 6 项红）**：

| 交互 | 修前实测 |
|---|---|
| F11 | 页面收到 keydown ✓，但 `\x1b[23~` 被塞进 PTY（十六进制 `1b5b32337e`） |
| Ctrl+C（无选区） | 发 `0x03` ✓（这条**必须**保持，否则终端不可用） |
| Ctrl+C（有选区） | 仍发 `0x03`（打断前台进程），而且 `copy` 事件 **0 次** → 剪贴板里还是哨兵值，**复制根本没发生** |
| Ctrl+V | 只发出 `0x16`（^V 字面量），`paste` 事件 **0 次** → **什么也粘不进去**，还往 shell 里塞了个 ^V |
| 右键（有选区） | `contextmenu` 没有被 preventDefault → 原生菜单照弹，「复制」要用户自己点 |

**根因（读 xterm v6 源码 + 实测确认）**：`CoreBrowserTerminal._keyDown` 在
`coreService.triggerDataEvent()` **之后**无条件调用 `cancel(ev, true)`，而 `cancel` 就是
`ev.preventDefault() + ev.stopPropagation()`。于是 Ctrl+C / Ctrl+V 不只是「发一个控制字节」，
它们同时把**浏览器自己的复制/粘贴**掐掉了：

- `Keyboard.evaluateKeyboardEvent` 的 `default` 分支里，`ctrlKey && !shift && !alt && !meta`
  → `String.fromCharCode(keyCode - 64)`：Ctrl+C = `0x03`、Ctrl+V = `0x16`（两个字节都真的发了）
- F11 在同一张映射表里是 `case 122` → `\x1b[23~`
- 右键：xterm 注册了 `contextmenu` 处理，但它**不** preventDefault —— 只把隐藏 textarea
  挪到鼠标位置并聚焦（`moveTextAreaUnderMouseCursor`），好让原生菜单里的 Copy/Paste 生效

**修法**：接管点只有 `attachCustomKeyEventHandler`（在 xterm 处理之前运行；返回 `false` 阻止
发字节，而且**不会** preventDefault），落点是 `frontend/src/ui/shortcuts.ts`：

| 交互 | 实现 |
|---|---|
| F11 | `preventDefault()`（阻止浏览器自己也切一次，否则两次切换在用户看来是「一点反应都没有」）+ `requestFullscreen()` / `exitFullscreen()`；返回 `false` 吞掉 `\x1b[23~` |
| Ctrl+C 无选区 | 原样 `pass` → xterm 继续发 `0x03`（**SIGINT 不能被扩展吃掉**） |
| Ctrl+C 有选区 | 返回 `false` 吞掉 `0x03`，**不** preventDefault → 浏览器自己的复制命令照常执行 |
| Ctrl+V | 返回 `false` 吞掉 `0x16`，**不** preventDefault → 原生粘贴 → xterm 自己的 `handlePasteEvent`（bracketed paste 等转换归它） |
| 右键（有选区） | `preventDefault()`（不弹原生菜单）+ `document.execCommand('copy')` → 同一条 `copy` 事件 |
| 右键（无选区） | 完全放行（原生菜单里的「粘贴」是有用的入口） |

「复制之后取消选区」只在一处发生：容器的 `copy` 监听器（挂在 `.term-host` 上，冒泡顺序保证
它晚于 xterm 挂在 `.xterm` 上的监听器，也就是「剪贴板已经写好」之后）。Ctrl+C、右键、原生菜单
里的 Copy 三条路径因此共用同一个后置动作。

**复制为什么不用 `navigator.clipboard.writeText`（第一版设计被实测推翻）**：第一版用
`writeText`，在无头与**可视** Chromium 下都收到 `NotAllowedError: Write permission denied`
（探针不显式授权时）——它**依赖权限**，而且在自动化里验不了（要授权才能跑，断言就成了假绿）。
改成「让浏览器执行它自己的复制命令」之后，写剪贴板由 xterm 挂在 `.xterm` 上的 `copy` 监听器
完成（`clipboardData.setData` **没有权限模型**），免权限、同步，也不需要我们自己读选区文本。
代价写在明面上：`execCommand` 已被标记废弃（浏览器仍支持，而且它是唯一免权限的
「以程序方式触发一次复制」的手段）。

**验证**：

| 检查 | 结果 |
|---|---|
| `node probe/shortcuts.mjs`（真 Chromium + 真 ConPTY + 真 WS） | **19/19**（修前 6 项红） |
| `PROBE_HEADED=1 node probe/shortcuts.mjs`（可视模式） | **19/19**（含 `Fullscreen API 生效`） |
| `tsc --noEmit` / `vitest run` | 通过 / **114 passed**（新增 22 条：决策真值表 + 副作用顺序 + 三条边界） |
| 回归 `probe/smoke.mjs` / `probe/multi-client.mjs` / `probe/scrollback.mjs` / `probe/remember.mjs` / `probe/input-hold.mjs` | 23/23、10/10、6/6、19/19、13/13 |

> 这几行里的探针名是这一轮结束时（第二轮合并之后）的名字：`.audit-*` 那些一次性副本已在
> 那一轮并进常驻探针，`browser-probe`/`two-clients`/`scroll4` 也已改名。数字后来随探针
> 补断言而变，**当前值以 §0 的表为准**。

**三条「测错了东西」也记下来**（这类错最容易变成假结论）：

1. 探针把「产品代码有没有调 `writeText`」当成断言，却在 `page.evaluate` 里清零计数器，
   而探针**自己**的搭台写入正好落在测量窗口内 → 数出 1 次、误判成产品代码在调。
   把清零挪到哨兵写完之后才对。
2. 「F11 之后是不是真的全屏」第一版用 `window.outerHeight >= screen.height` 判定：无头模式
   没有浏览器 chrome（恒等），可视模式下 DPI 缩放又让 `outer`（888）大于 `screen`（800）——
   **两种情况下它都恒为真**，是个永远不会红的断言。改成只认 `document.fullscreenElement`，
   几何量只打印不判定。
3. 选区从第 2 列开始拖，剪贴板里拿到的是缺了开头两个字符的残词（`ORTCUT-PROBE-...`），
   断言 `includes('SHORTCUT-PROBE')` 因此假红。从第 0 列开始选才是完整行。

---

## 2. 修复顺序与状态

1. ✅ **A1 + A2 + A6**：按「单线程所有者 + 唯一写者」一次改造完成（见 §2.1）。
2. ✅ **A10**：输入背压——协作式暂缓 + 硬上限（见 §2.2）。
3. ✅ **A3**：握手期异常收敛到 `bad_hello` + 1002（见 §2.4）。
4. ✅ **A4**：`Ack` 接成实时推送窗口（见 §2.3 上方 A4 一节）；✅ **A7**：死协议面删除（见 §2.5）。
5. ✅ **A8 / A9 / A11**：前端位置记忆、滚动位置恢复、新建会话路径（见 §2.6）。
6. ✅ **重建对齐点的残留项**：对齐点吸附到解析状态干净的位置（见 §2.6 末尾）。
7. ✅ **A12**：四个浏览器级交互的接管（见 A12 一节）。

## 2.1 本轮修复记录

**原则**：终端模型只有一个所有者（事件循环线程），PTY 只有一个写者（写线程）；并发正确性靠线程归属而不是加锁。

| 文件 | 改动 |
|---|---|
| `core/ports.py` | 端口按线程归属重切：`read` / `ingest` / `set_focus` / `snapshot` / `metadata` / `write`，新增 `fed_offset` 与线程归属表 |
| `runtime/pywezterm_host.py` | `pump()` 拆成 `read()` + `ingest()`（`ingest` 返回模型应答并累加 `fed_offset`）；`set_focus()` 返回应答；任何方法都不再“既读输出又写 PTY” |
| `runtime/fake_host.py` | 测试替身同步拆分；DSR 应答改由 `ingest()` 返回（与真实模型一致） |
| `runtime/runner.py` | 读线程只 `read()`；客户端输入与宿主应答统一经写线程（唯一写者）；更正“持 GIL 阻塞写”的错误注释 |
| `service/hub.py` | `handle_input` 与 `_apply_focus` 统一经 `_submit_write`；`_ingest_output` 里 `ingest` 与 `journal.append` 相邻执行 |
| `core/session.py` | 删除 `Session.write_input`（不留第二条可被误用的写路径） |
| `docs/architecture.md` | §9 更正 GIL 结论 + 写入线程归属表与两条不变量；§3.2 / §12 同步 |
| `tests/` | 新增 A1 回归（`BlockingHost`）与两条契约不变量用例；`FakeHost` 驱动方式同步 |

**验证**：

| 检查 | 结果 |
|---|---|
| `ruff check .` / `ruff format --check .` | 全绿 |
| `mypy src` | 30 个源文件无问题 |
| `pytest -q` | 202 passed, 30 skipped |
| `TERMINALD_CONTRACT=1 pytest -q -m contract` | 30 passed（含两条新不变量） |

下面三行是当时的**一次性取证脚本**（已删）留下的数字，保留作为机制证据；它们的结论现在由 §3 的回归守住：

| 当时的取证脚本 | 结果 |
|---|---|
| `.audit/a1_write_isolation.py` | `handle_input 0.0 ms / 循环最大停滞 32 ms / 写线程仍阻塞` → 通过 |
| `.audit/input_block.py`（真实服务） | 发 4 MiB 输入后 `healthz #0 = 15 ms`（原为 18953 ms） |
| `.audit/rebuild_torn.py` | 快照行号连续 N1..N2259、与补发字节重叠 0 行、对齐点紧接快照 → 通过 |

**当时的残留（现已修，见 §2.6 末）**：

- 重建路径的对齐点原本是 `journal.end_offset`，它可能落在某个转义序列**中间**；此时补发字节的**首几个字节**会被新建客户端的解析器当成普通文本（`\x1b[38;5` 里的 `3` `8` `;` `5` 就是四个可见字符）。当时记下的修法是吸附到 `journal.safe_offset_at_or_after()`——实际做的比那一句话要严：见 `Journal.replay_offset()`。

## 2.2 A10 修复记录：输入方向背压

**问题**：`SessionRunner` 的写队列是一个无 `maxsize` 的 `queue.Queue`，`Hub.handle_input` 无条件入队，接收循环从不看积压。结果是「一次超大粘贴的字节全部进内存」，只有 PTY 的写入速度在限制它。

**两条候选路，选了一条：**

| 方案 | 控制面 | 对端断开 | 字节 |
|---|---|---|---|
| 水位到了就**停读接收循环**（内核级背压，关 TCP 窗口） | ❌ 同一条连接上的 `detach` / 关会话 / 焦点上报一起被堵住——而子进程不读 stdin 时暂停可能持续很久，正是用户最需要关掉这个会话的时候 | ❌ uvicorn 只把 `disconnect` 放进队列、不会取消 app 任务，我们不再调用 `receive()` 就永远看不到它：任务、FD、订阅表条目一起泄着，而它仍参与焦点聚合与补流 | 不丢 |
| **协作式暂缓**（采纳）：写队列按字节计量 + 双水位 + 硬上限，到水位下发 `InputHold`，发送方在本端排队 | ✅ 全程可用 | ✅ 连接照常收尾 | 不丢 |

| 文件 | 改动 |
|---|---|
| `config.py` | `input_high_bytes` / `input_low_bytes` / `input_hard_bytes`，并把两条不等式钉在启动边界（`low ≤ high`、`hard ≥ 2 × high`） |
| `runtime/runner.py` | `submit_input` 返回 `InputVerdict`（`ACCEPTED` / `HOLD` / `OVERFLOW`）；`submit_response` 只入队不判定；`_release` 带滞回位（只在**穿过**低水位那一次回调） |
| `protocol/messages.py` | 新增 `InputHold{session, paused}`（S→C） |
| `service/hub.py` | `handle_input` 下发暂缓（**只发一次**）；写线程经 `call_soon_threadsafe` 回到循环上的 `_release_input` 放行；`detach` / 拆除时清标志 |
| `api/ws.py` | 越限 → `error{code:"input_overflow"}` + `1009` 显式断开（已收下的字节照旧写完） |
| `frontend/src/net/client.ts` | 暂缓期间本端按序排队、放行原序补发、超上限报错并丢弃**最新**字节、断开/切会话时清空 |
| `frontend/src/ui/app.ts` | 顶栏 chip 显示「输入排队中 · N」，订阅成功时归零 |
| `tests/` + `docs/` | 新增 `test_input_backpressure.py`、`test_api.py::test_ignoring_input_hold_closes…`、前端 5 条用例；`docs/protocol.md` §3「输入流控」、`docs/architecture.md` §5.1 |

**验证**：

| 检查 | 结果 |
|---|---|
| `pytest -q` | 210 passed |
| `TERMINALD_CONTRACT=1 pytest -m contract` | 30 passed |
| `vitest run` | 77 passed（含新增 5 条：排队/放行/上限/跨订阅隔离/断线清空） |
| `.audit/input_flow_real.py`（**一次性脚本、已删**；真实 uvicorn + 真实 ConPTY） | 场景 A：2 MiB 输入、8 次暂缓/8 次放行、首次暂缓时已发 262144 字节；被暂缓期间 `healthz = 0 ms`、`session.list` 回程 62 ms；子进程回执 `GOT 2097152 e540eed2079b75b4`（与客户端构造的 sha256 一致 → 顺序、不丢、不重）；场景 B：单帧 5 MiB → `error{code:input_overflow}` + 关闭码 1009；场景 C：一次倒出 4.75 MiB → 被误杀（见 §2.3），分批补发 → 零错误 + `GOT 5242880 d46da16bcca9f8a0` |
| `.audit/conpty_bigwrite.py`（隔离实验：不经 Hub） | ConPTY 输入侧吞吐 = **~190 KiB/s**，与 `write()` 分块大小无关（64 KiB / 256 KiB / 1 MiB 均 ~43–46 s / 8 MiB），且**不丢字节**（详表见 `docs/architecture.md` §12.1） |
| `.audit/handshake_errors.py`（真服务） | A3：非法首消息得到 `bad_hello` + 1002，日志 0 traceback（修前：什么都没有 + 1006，4 条 ASGI 异常） |
| `.audit/unacked_backlog.py`（进程内） | A4：4 MiB 输出、无窗口时未确认积压峰值 4064 KiB；加上 256 KiB 窗口后降到 256 KiB |

**过程中被探针推翻了两次的自以为是的结论**（记录备查）：

1. 第一版探针用 `bytes(range(256))` 当负载，子进程读到 **0 字节**——不是背压有问题，而是那个负载里含 `^C`/`^D`，而**控制台当时处于 cooked + echo 模式**（实测能在回显里看到 `^A^B`）：控制字符被 Windows 控制台的行编辑器吃掉/解释成 EOF。改成 `SetConsoleMode(..., ENABLE_VIRTUAL_TERMINAL_INPUT)`（全屏 TUI 会做的事）后才有意义。**测终端程序必须在原始模式下测**，否则量到的是控制台行编辑器。
2. 第一版 `control_roundtrip` 用固定时长的 `pump(2.0)` 去量回程，量到的是**自己的观察窗口**（2016 ms），不是服务端延迟；改成「等到真的收到 `sessions` 消息」后是 62 ms。
3. 第一版把“子进程 30s 内没打出回执”当成了丢字节。隔离实验（`.audit/conpty_bigwrite.py`）证明：ConPTY 输入侧只有 ~190 KiB/s，8 MiB 要 ~44 s 才走得完，而当时我把 8 MiB 的完成窗口设成了 30 s。**“慢”和“丢”必须用能分辨两者的实验分开量**。

## 2.3 我自己引入的那个洞：硬上限会误杀守规矩的客户端

A10 的第一版（服务端双水位 + 硬上限 + “客户端在本端排队”）**有一个设计洞，而且是探针先发现的**：
“放行”只表示服务端队列已回落到低水位，但硬上限量的是**瞬时**深度——于是“暂缓就停、放行才发”的
客户端只要在放行那一刻把整队一次倒出去，就会在完全合规的情况下被判定违约。

| 实验（`.audit/input_flow_real.py` 场景 C，本端积压 4.75 MiB、硬上限 4 MiB） | 结果 |
|---|---|
| 一次倒出整队（当时前端的做法） | `error{code:input_overflow}` + `1009`，**输入被截断** |
| 每次 1 MiB 分批补发（修复后的做法） | 6 个暂缓/放行来回、零错误、`GOT 5242880 d46da16bcca9f8a0` 字节一致 |

默认配置下同样可达：客户端的排队上限（16 MiB）恰好等于 `input_hard_bytes` 的默认值 16 MiB。

**修法**（客户端侧，协议不变）：

| 位置 | 改动 |
|---|---|
| `frontend/src/net/client.ts` | `#flushHeldInput` 每次最多送 `heldFlushBytes`（默认 1 MiB），**过大的段会切开**（否则“分批”对一整块粘贴毫无意义）；剩下的靠 `heldFlushIntervalMs`（默认 50ms）的进度定时器继续推；再次暂缓立即停掉定时器；**积压非空时新输入一律入队**（否则补发途中的按键会插到积压前面，破坏字节序） |
| `docs/protocol.md` §3 | 把“补发必须分批”写成**客户端义务**（连同四个必守点） |
| `docs/architecture.md` §5.2 | 说明为什么硬上限看的是瞬时深度，以及实测数据 |
| `frontend/src/net/client.test.ts` | 新增 3 条：分批 + 切开、积压未清时新输入排队尾、补发中再次暂缓立即停手 |

### 2.3.1 浏览器里真的就是这样（13/13）

`frontend/probe/input-hold.mjs`（真 Chromium + 真服务 + 真 PTY，自带服务器）：
往一个**从不读 stdin** 的会话粘贴 256 KiB →

| 断言 | 结果 |
|---|---|
| 粘贴经 xterm → WS 发出 | 1 帧、负载 262144 字节 |
| 服务端暂缓已下发 + 顶栏显示“输入排队中” | `inputHeld=true`、chip=`输入排队中 · 0 B` |
| 暂缓期间敲键盘 | **新发 0 帧**，`heldInputBytes=23`，8 次采样均为 `held:23` |
| 被暂缓住时切会话、在新会话里干活 | 切换成功、`echo PROBE_HOLD_OK` 回显正常（**控制面没被堵**） |
| 切会话时丢掉上个订阅排队的输入 | `held=false / 排队=0`（它无法在新会话里补发） |
| 连接状态 / 页面错误 | 始终 `ready` / 无 JS 错误 |

写这个探针时又拿自己的测量误差当了一回“产品缺陷”：第一版把「已经发出去的帧数」按**过滤后的下标**去切**未过滤**的数组，于是把粘贴那一帧重复计数成了“暂缓期间还在发”；另一次则把帧字节数（含 5 字节帧头）当成负载，于是 18 字节的 `echo …\r` 看起来像 23 字节的排队内容。两个都是探针的错——**探针自己也要被它自己的断言审一遍**（现在探针会把整条帧序列打印出来）。

## 2.4 A3 修复记录：握手期的异常不再逃出端点

取证脚本 `backend/.audit/handshake_errors.py`（真服务、逐种非法首消息）。修复前：

| 首条消息 | 客户端实际看到 | 服务端日志 |
|---|---|---|
| `{"t":"session.list"}` | 什么都没收到，关闭码 **1006**（TCP 硬断） | 1 条 ASGI traceback |
| `{oops`（JSON 非法） | 同上 | 同上 |
| `{}` / 字段类型错 / 多字段 | 同上 | 同上 |

5 次连接共 **4 条 `Exception in ASGI application` + 7 条 traceback**。根因：`_read_hello` 会抛
`ProtocolViolation`（首条不是 hello）与 `MessageError`（JSON/字段非法），而端点只捕获了
`WebSocketDisconnect` 与 `TimeoutError`。

修复后同一脚本：每种情况都拿到 `error{code:"bad_hello"}` + 关闭码 **1002**（原因「握手不合法」），
服务端日志 **0 条 traceback**。回归测试：`tests/test_api.py` 里参数化的 5 条（含 `extra=forbid` 的多字段用例）。

## 2.5 A7 修复记录：删掉死协议面

“要么接通，要么删掉”的第三选择（保留并标注“未启用”）也被排除了：`sized` **连一个发送点都不存在**，
给不存在的功能留消息面正是这条审计要销掉的东西。做法：

| 面 | 处置 |
|---|---|
| `Sized` | 从 `protocol/messages.py`（类、联合类型、`__all__`）、`messages.ts`（接口、联合、类型表）、`app.ts` 的处理分支、`docs/protocol.md` 的表与 §2 说明一并删除 |
| `Bell` | 同上。它本来就冗余：`\x07` 就在原始字节流里，xterm.js 自己会处理 |
| `Outbox.behind` | 连同那个派生出来的 `_behind` 标志一起删除。水位判断只保留一处结论源（`pending_bytes` + `would_exceed`），不再把同一个事实存两份 |
| 测试 | `test_protocol.py` 的 `test_sized_is_not_client_initiated` 改为“两个方向都不存在尺寸消息”；`frames.test.ts` 里借 `bell` 验证 `extra=forbid` 的用例改用 `behind`；`test_outbox.py` 里两条断言 `behind` 标志的用例换成断言 `pending_bytes` / `would_exceed` |

## 2.6 A8 / A9 / A11 修复记录：刷新后的「位置」

**原则**：「刷新不丢」有两层——**内容**不丢由服务端的字节日志负责（新客户端整段重放），**位置**不丢（刚才在看哪个会话、视口停在哪一行）属于这一端，服务端不知道也无需知道。

| 文件 | 改动 |
|---|---|
| `frontend/src/ui/remember.ts`（新） | `SessionMemory`：Tab 级存储（`sessionStorage`）+ **只记会话 id，不记 offset** + 所有存储异常降级成「没有记忆」；`pickInitialSession()` 用列表校验记忆里的 id 再回退到第一个 |
| `frontend/src/ui/remember.test.ts`（新） | 11 条：往返、按会话分开记、脏数据（非数字/负数/超大整数/空串）当成没记忆、存储不可用与**存储自己在抛**（配额满/隐私模式）时不影响调用方、关会话时清两个键 |
| `frontend/src/ui/app.ts` | 首屏用记忆选会话；`onScroll` 记位置（底部不记、备用屏不记、重放过程中不记）；重放终点（`attached.offset`）后 `scrollToLine` 恢复；用户动手/断线/切会话放弃恢复；**新建会话路径先清屏**；`debugState()` 暴露 `viewportY/baseY/altScreen` 供探针断言 |
| `frontend/src/net/client.ts` | 服务端**主动**换订阅（会话 id 与本地不一致）时重建基线：清排队输入、重置两个 offset 到新会话的 0 点。不重建就会被自己的“不连续”检查丢掉整条新流（A11a） |
| `frontend/src/net/client.test.ts` | 新增一条：服务端主动换订阅后新会话的字节正常应用、不再报不连续 |
| `backend/src/terminald/core/journal.py` | `replay_offset()`：重建对齐点必须是**解析状态干净**的位置（残缺转义序列或多字节 UTF-8 都回退到其起点）；`safe_offset_at_or_after()` 同样加入 UTF-8 边界（裁剪不得把一个字符劈成两半） |
| `backend/src/terminald/service/hub.py` | 重建路径（`_attach` 的非续传分支与 `_on_resync`）改用 `replay_offset()` 作为对齐点与快照偏移 |
| `backend/tests/test_journal.py` | 新增 6 条：裁剪不劈字符（含切点正好在边界上的对照）、末尾干净时对齐点不变、残缺序列/残缺字符时回退、不回退到裁剪点之前 |
| `backend/tests/test_hub.py` | 新增一条端到端：末尾卡在 `\x1b[38;5` 时重建 → 对齐点回到序列起点、整段残缺序列作为原始字节补发；补全序列后两个客户端逐字节收敛 |

**验证**：

| 检查 | 结果 |
|---|---|
| `pytest -q` | 225 passed, 30 skipped |
| `TERMINALD_CONTRACT=1 pytest -q -m contract` | 30 passed（重建用例的断言改为 `attached.offset == journal.replay_offset() ≤ journal.end_offset`） |
| `ruff check .` / `ruff format --check .` / `mypy src` | 全绿 |
| `tsc --noEmit` / `vitest run` | 通过 / **92 passed** |
| `node probe/remember.mjs`（真 Chromium + 真 ConPTY） | **19/19**：刷新后仍是原会话、视口行号逐字节回到同一行、那一屏逐行一致；停在底部时刷新不会被拽回中间；切会话不遗留上个会话的 scrollback；新建会话清屏且可交互 |
| `node probe/conpty-alt-screen.mjs`（对照组） | 3/3：同一子进程走管道时 `\x1b[?1049h` 在、走 ConPTY 时不在 |

**A/B 证据（证明两半都是“载荷”而不是“顺手改的”）**：探针跑到这一轮之前，两组独立实验各自的失败现象是：只修 (b) 不清屏不管基线 → `新建的会话可交互` 超时（新会话刷不出来）；只修 (a) 不管清屏 → `新建会话后屏幕已清空` 拿到 `SB-0121`（旧会话内容）。两个方向都实测过，不是从代码里推的。

**平台事实的对照组**（`docs/architecture.md` §12 的表里已有这一行，本轮补的是可复现的对照实验）：ConPTY 不把子进程的 `\x1b[?1049h` 转给终端。同一个子进程、同一段代码，走管道时序列原样在（33 字节），走 ConPTY 时不在，取而代之是 ConPTY 自己的重绘（`\x1b[H` + 逐行 `\x1b[K`）。这条对照也纠正了探针里一个本来会很唬人的“绿灯”：在 Win10 上“备用屏里滚动不写位置记忆”永远为真（根本进不去备用屏），那种断言等于没测。

**重建对齐点（A11 之外的残留项）**：现在交付给客户端的「快照 + 从对齐点起的字节」一定从**解析状态干净**的位置开始。回退的那几个字节不会重复绘制——快照本来就没把残缺序列/字符的效果画进去（残缺就没有效果），所以是补全。`docs/architecture.md` §6 的不变量已同步。

---

## 2.7 第二轮（2026-09-24）：清理与验证层审计

第二轮没有在 A1–A13 的产品代码里找到新缺陷（那些回归全部仍绿）。找到的都是**验证层自己的缺陷**——
它们的共同危害比产品缺陷更难发现：**红的测试看起来是绿的**。

| 编号 | 一句话 | 为何危险 | 状态 |
|---|---|---|---|
| V1 | `multi-client.mjs` 的「滚到顶后三客户端逐行一致」是**恒真**的：用 `viewport.scrollTop = 0` 滚动，而它根本滚不动（见 §0 桥清 2），于是它比的是三张**底屏**——和上一条断言重复 | 看上去“多客户端连历史都同步”，实际连「能不能滚回去」都没测 | ✅ 已修：拖滚动条拇指到顶 + 新增一条“真的到了 SYNC-0001”的前提断言；另把“滚动区几何一致”换成 `baseY`（真实历史行数）比对 |
| V2 | `smoke.mjs` 的「滚动条贴右边缘」量的是 `.xterm-viewport`——滚动条不在那儿，而那个元素的右缘永远等于容器右缘 | 同类的假绿；换任何布局都不会红 | ✅ 已修：改到 `scrollback.mjs`，量真滚动条（存在 + 贴边 + **拖得动**，三条都验） |
| V3 | `scrollback.mjs` 的失败不返回非零退出码（只打印 FAIL） | `probe:all` 与 CI 会把红当绿；另外三个探针各自手写收尾，口径不一 | ✅ 已修：统一 `summarize(results)` |
| V4 | 探针里写死了**本机用户名**与 Playwright 的**具体 Chromium 修订号**，落盘目录还取 `process.cwd()` | 换台机器就跑不动（而跑不动很容易被当成“过了”）；用户名也不该进仓库 | ✅ 已修：`probe/env.mjs` 由文件位置推导一切，只允许用环境变量覆盖，定位不到就吵 |
| V5 | 六个探针各自复制了一份 `startServer`；`conpty-alt-screen` 与 `shortcuts` **默认端口相同**；`smoke`/`multi-client`/`scrollback` 直接用 8765 并会**先清空会话** | 验证工具反过来破坏工作现场（把开发者手上的会话全删了）；两个探针不能同时跑 | ✅ 已修：`probe/server.mjs`（选空闲端口、拉起、带出 stderr、统一的会话工具）；**每个探针独占端口且自带服务器**，不再碰 8765 |
| V6 | `vectors/basic.json` 只覆盖 **6/18** 种控制消息的 JSON 形态，而前端对**每一条**下行消息都做严格校验（多余字段直接报错）——剩下 12 种的字段形状只能靠两边手抄 | 后端动一个字段（而前端不知道）会当场丢消息，且没有任何测试会红 | ✅ 已修：新增**生成的** `vectors/shapes.json`（后端模型 → 前端逐字比对），两侧各一条测试，并验证了两侧**都能红** |

### V1 / V2 是怎么发现的

不是靠读代码，而是靠**看日志里的具体数字**：`multi-client.mjs` 输出「A 滚到顶首行 = SYNC-2972」——
而末行是 SYNC-3000，算下来那一屏恰好是**底部那一屏**。一个数字不对劲就顺着查到了机制。

### V6 的验证（测试本身的判别力）

| 被人为制造的漂移 | 预期 | 实测 |
|---|---|---|
| 给后端 `Meta` 加一个字段、不重新生成 | 后端红 | ✅ `test_server_message_shapes_match_shared_contract` FAILED |
| 偷偷给 `shapes.json` 的 `input_hold` 加一个字段 | 两侧都红 | ✅ 后端 FAILED + 前端 `字段形状与后端生成的契约逐字一致` FAILED |

“测试能不能红”必须真的试一次——这正是 V1/V2 教给这一轮的教训。

### 2.7.1 一条未复现的失败（开放项，不是已修项）

**观测**：在 `git add -A`（刚对 328 个文件算过哈希，含 5 MB wheel 与 22 MB 上游源码）之后
立即跑默认套件，得到 `1 failed, 233 passed, 32 skipped`。

**为什么叫“未复现”**：当场我把输出截成了 `tail -1`，于是**失败用例的名字丢了**。
之后又跑了 **16 轮全绿**（其中 8 轮刻意加了磁盘 I/O 与进程创建压力），复现不出来。

**候选（默认套件里仅有的几处壁钟上界，不能证明是谁）**：

| 位置 | 上界 | 为什么可能受环境影响的 |
|---|---|---|
| `tests/test_host_teardown.py`（真进程树） | `wait_until(..., 10.0)` / `parent.wait(timeout=5)` | 要等一个 Python 子进程启动并写 pid 文件；机器忙时冷启动可能超 |
| `tests/support.py` 的两扇闸 | `gate.wait(timeout=10.0)` | 闸本意是“无限等待直到测试放行”，上界只是防死锁 |
| `tests/test_push_window.py` | `wait_for(..., timeout=10)` | 同类轮询 |
| `tests/test_api.py` | `deleter.join(timeout=10)` | 同上 |

**下次再遇到就这么做**（这条也是这轮自己的教训）：

```bash
./.venv/Scripts/python.exe -m pytest -q --tb=short 2>&1 | tee /tmp/pytest.log   # 不要把输出截成 tail -1
```

在拿到用例名之前，不把它归因于任何一条测试（“大概是那个”在审计里等于没查）。

**第三轮的后续（2026-09-25）**：按上面那条命令又跑了 **13 轮全绿**（持续 CPU 占用 +
反复拷贝 5 MB wheel 的磁盘压力），仍然没复现出套件里的那条红——它**至今未被归因**，
所以这一节仍然只是一个观察记录，不是已修项。

但那条命令兑现了它的价值，只是兑现在了探针层：同一轮里 `probe/input-hold.mjs` 出现了
**同类的偶发红**（5 次里红 1 次），而且这次拿到了名字与现场，机制已查清并修好，见 §2.8。

**第四轮的处置（2026-09-25，§2.9）**：既然“等到的不是事件而是时间”是这一类失败的共同机制，
第四轮把默认套件里的固定睡眠整个移除了——`settle()` 及其 46 处调用点已不存在，
套件里“150ms 够不够”不再是任何一条用例的前提。

同轮还抓到了**同类但不同因**的一条：`test_input_backpressure.py` 把“字节写完了”当成放行的栅栏，
而放行要经 `call_soon_threadsafe` 再转一圈（§2.9 D5）。它在同一负载下 **10 轮红 2**，修后 20 轮全绿。
本条（§2.7.1）那条丢名字的红**仍然无法证明**是不是它——这条用例从来没有用过 `settle`，
所以在当时也以完全相同的方式暴露着，只能说它是**真实存在且已捕获的候选**。

教训也补上一句：这一轮我又把一次失败输出截成了 `tail -1`（名字再次丢掉），导致找它多花了十几轮实验。
**跑套件时不要截尾部**，这条已经从“建议”变成“吃过一次亏”。

---

## 2.8 第三轮（2026-09-25）：交付前清理

这一轮的目标不是找新缺陷，而是把「交付状态」逐项过一遍：死代码、陈旧引用、
两个入口之间不一致的约束、嵌在源码里的不可见字节、以及文档里的数字。
产品缺陷一条（C1）；其余是脏东西与不一致。

| 编号 | 一句话 | 处置 |
|---|---|---|
| C1 | `probe/input-hold.mjs` 偶发假红：服务端暂缓窗口的长度里含 **ConPTY 自己的输入缓冲**，它有时会把 2 MiB 粘贴一次吞掉 → 队列排水 → 正常放行。随后客户端把输入发出去是**正确的**，而“暂缓期间不发一帧”的断言假红（实测 5 次里红 1 次，轨迹 `free:0 …`） | ✅ 已修：粘贴量提到 4 MiB（压过那层缓冲），并在采样前**重新确认前提**（必要时再压一批，有界重试），截图移出采样窗口。9 轮全绿（修前 5 轮红 1） |
| C2 | 会话名的约束只在 REST 侧（`max_length=64`），WebSocket 侧完全无界：同一个操作两个入口各说各话，而且名字会广播给所有客户端 | ✅ 已修：上界收到协议层（`SESSION_NAME_MAX`，1..64），两个入口共用；新增 5 条回归 |
| C3 | 越界的 `Ack`（确认了没发给它的字节）会被记账，等于把该客户端的流控整个关掉（`cursor - acked` 永远到不了窗口） | ✅ 已修：不记账 + 留 warning；新增 1 条回归 |
| C4 | 死代码：`frontend/src/protocol/offset.ts` 的 `offsetToBigInt` 无人调用（客户端从不把 offset 写进帧） | ✅ 已删（连同反向转换的说明） |
| C5 | 未完成的入口：协议里的 `session.rename` 后端与 Hub 都有实现和测试，**前端没有任何入口**——在前端是个没人能触发的死面 | ✅ 已补：侧栏双击卡片重命名；`probe/smoke.mjs` 新增一条断言（侧栏与服务端都改了名） |
| C6 | 源码里嵌了**不可见的 ESC/BEL 字节**（`app.ts` 的焦点序列、契约测试的两条断言、`architecture.md` 一处正文）：编辑器看不见，任何文本处理都可能弄丢，而代价是那条规则静默失效 | ✅ 已改成 `\u001b` / `\x1b` 转义（字节层面完全等价） |
| C7 | 陈旧的引用与注释：`scan.py` 的用法示例指向不存在的 `Journal.record_spans`；`runner.py` 写着“配置强制 `hard > high`”（实际是 `≥ 2 × high`）；`dom.ts` 指向不存在的 `docs/guides/security.md`；`app.ts` 里字体栈的说明错位到焦点序列头上；`vendor/README.md` 里写着一个不存在的内部技能名；**另一个项目的名字出现在两处**（`vendor/README.md` 与 `vendor/pywezterm-upstream/AGENTS.md`，后者的本意恰恰是“不要提及它”） | ✅ 已逐条改正/改名（外项目名字全库清零） |
| C8 | `probe:all` 是一条 `&&` 链：第一个红的探针会把后面五个全部吃掉，而文档说的是“全部七个探针” | ✅ 已改为 `probe/all.mjs`（全部跑完再汇总退出码）；实测七个全部执行（185s） |
| C9 | 收尾：`SessionMemory.available`、`--journal-mb` 等少数面重新过了一遍 | 都**在用**（`available` 有测试、`--journal-mb` 有测试且是启动期唯一需要调的配额），保留不动 |

**验证**（第三轮结束时全量重跑）：

| 检查 | 结果 |
|---|---|
| `ruff check` / `ruff format --check` / `mypy` | 全绿 / 48 文件 / 31 源文件 |
| `pytest -q` | **240 passed, 32 skipped** |
| `TERMINALD_CONTRACT=1 pytest -q -m contract` | **32 passed** |
| `tsc --noEmit` / `vitest run` | 通过 / **115 passed** |
| `npm run probe:all`（七个探针，全部跑完再汇总） | **93 项全过**（smoke 23、multi-client 10、scrollback 6、remember 19、input-hold 13、shortcuts 19、conpty-alt 3） |
| `node probe/input-hold.mjs` ×9（C1 的判别力） | 9 轮全绿（修前 5 轮红 1） |

C1 这条也把 §2.7.1 的结论补完整了：**未复现的那条 pytest 红仍未被归因**，但“把输出完整留下来”
这个习惯确实在探针层抓住了一条同类问题——而且抓住之后它就不再是“偶发”，是有机制、有判别力、能回归的。

---

## 2.9 第四轮（2026-09-25）：测试同步纪律

这一轮只做一件事：把默认套件里「靠时间猜」的等待全部换成「等真实条件」，并让这条纪律可执行。
起因是 §2.7.1——那条未能归因的红，其机制候选里有一样比“某条用例超时”更根本的东西：
`tests/support.py` 的 `settle()`（固定 `asyncio.sleep(0.15)`）被当成同步原语，用在 **46 处**。

| 编号 | 一句话 | 为何危险 | 处置 |
|---|---|---|---|
| D1 | 相当一部分 `settle()` 压在**否定断言**前面（“应用不该收到焦点序列”“解除订阅后不该再收到内容”） | 写线程是异步的：不等待时“真的写了”也还没写出去，断言照样绿。**假绿比假红更坏**——它安静地失去判别力 | ✅ 新增 `writes_drained()` 写栅栏：`pending_bytes` 只在 `host.write()` **返回之后**才扣减，因此归零就等于“此前入队的每一次写都已落到宿主” |
| D2 | 其余的是纯浪费：每轮白等约 6.6s，而真正在等流水线的只有 2 处（推送窗口那两条） | 用固定时长表达“等它做完”，机器的快慢就直接改写结论 | ✅ 换成 `feed()` 输出栅栏：`_ingest_output` 是**一段没有 await 的原子步**（喂模型 → 追加日志 → 裁剪 → 推给每个订阅者），所以“日志偏移已推进”一旦可观察，推送就已发生 |
| D3 | 失败信息为零：`wait_for` 超时只抛“等待条件超时” | 分不清“没发生”和“还没发生”——与 §2.7.1 丢掉用例名是同一个教训 | ✅ 超时报出**判定点的源码位置**与已等待时长；栅栏还带上目标值（如“输出并入日志（目标 offset=1234）”） |
| D4 | 这条纪律只写在注释里 | 下一轮又会有人写 `sleep(0.1)`，因为它“看起来更稳” | ✅ `tests/test_sync_discipline.py`：固定睡眠（`sleep(0)` 除外）会红；栅栏所依赖的原子性不变量也会红（15 个控制面函数不是协程且无 await、`EXITED` 分支无 await、`_release()` 在 `host.write()` 返回之后） |
| D5 | `test_input_backpressure.py` 等的是**错的东西**：“字节写完了”不等于“客户端被放行了”——放行经 `call_soon_threadsafe` 回到事件循环，而 `drain_until_quiet()` 是同步的、给不出那一圈 | 机器忙时断言看到 0 条放行（而不是 1 条）——以“什么都没收到”的形式失败 | ✅ 栅栏改成“该客户端已被放行”（`input_held is False`；`_release_input` 先清标志再 `_send`，中间无 await）；同一负载下 **20 轮 0 红（修前 10 轮红 2）** |

D5 是在 §2.9 的验证阶段**抓出来的**，不是读代码看出来的：把默认套件按文件拆开、每个文件在同一负载下连跑 10 轮，
只有 `test_input_backpressure.py` 红了（2/10）：`test_input_hold_pauses_sender_without_dropping_bytes`。
它与我本轮的改动无关（这个文件从未用过 `settle`），是一条**本来就存在**的、与 §2.7.1 同类的偶发红。
两条都指向同一个教训：**不要把“A 做完了”当成“B 也做完了”的栅栏**（B 的完成需要事件循环再转一圈）。

遗留的重复脚手架一并收掉：`test_api.py` 自己抄了一份 `wait_until`（行为与 `support.py` 的那份不同——连失败信息都没有，现已统一），并在一条日志偏移栅栏之后又 `time.sleep(0.1)`。

### 怎么证明它真的有效（而不是“看着更整齐”）

用 `git worktree` 把**旧提交**（含 46 处 `settle()`）取到 `/tmp`，与当前工作树在**同样条件**下跑同一套用例：

| 人为制造的条件 | 旧套件（46 处固定睡眠） | 新套件（零固定睡眠） |
|---|---|---|
| 无（基线） | 240 passed / 17.1s | **259 passed / 10.5s** |
| 把等待降为 0（= 机器在每次等待里都被抢占） | **2 failed** | 没有这个旋钮可拧 |
| 每次 `read()` +60ms | 240 passed / 23.1s | 259 passed / 41.4s |
| 每次 `read()` +120ms（≈ 旧上界 150ms 的 8 倍） | **1 failed**（`test_live_push_stops_at_the_window_and_resumes_on_ack`） | **259 passed** |

后两行就是问题的定义：旧套件的余量是一个**常数**（150/200ms），顶穿它就红；新套件等的是条件，
默认上界 3s（`wait_for` 的 timeout，个别用例按需放宽到 10s），而且失败时会说出**是哪个条件、在哪一行**。

**为什么“每次读取慢 60ms”没让旧套件红**：旧用例量的是“游标 vs 当前日志末尾”，而日志末尾一直在长，
慢一点反而更容易满足 `cursor < end` 这类断言——换句话说，它在慢这一侧靠的是运气，而不是靠等待。
这也解释了为什么那条未归因的红只在**快**的方向（`settle` 被抢占到没等到）出现。

**一个诚实的代价**：被人为拖慢时，新套件反而更慢（41s vs 23s），因为它真的在等每一段输出做完，
而不是睡完就走。这与产品里的取舍同源：**宁可多等，也不要一个不知道自己测了什么的结果。**

### 新纪律的判别力（逐条试过）

| 人为制造的违反 | 预期 | 实测 |
|---|---|---|
| 往 `tests/` 放一个 `await asyncio.sleep(0.05)` | 红 | ✅ `test_no_fixed_sleeps_outside_polling_helpers` FAILED（指出文件:行） |
| 把 `Hub._ingest_output` 改成协程 | 红 | ✅ `test_control_plane_effects_are_complete_on_return[_ingest_output]` FAILED |
| 写线程卡在闸上时，写栅栏会不会提前放行 | 必须仍在等 | ✅ `test_writes_drained_waits_for_a_gated_write`（先 `turn()` 证明栅栏确实跑过一步，再断言未放行） |
| 把 `_release()` 挪到 `host.write()` 之前、`finally` 留空 | 红 | ✅ `test_write_fence_counts_a_write_only_after_it_landed` FAILED |
| 让 `_release()` 先通知（`_on_drained`）再扣减计数 | 红 | ✅ `test_write_fence_alone_does_not_prove_the_client_was_released` FAILED（报“等待写线程排空输入队列超时”——写栅栏不再独立于放行通知） |

### 复核补充（2026-09-25，第四轮交付前）

复核第四轮自己的产出时抓到两条**记录与代码不一致**，都在 D5 那次修改的旁边：

| 编号 | 一句话 | 处置 |
|---|---|---|
| D6 | `writes_drained()` 的 docstring 说这条不变量由“`test_hub.py::test_writes_drained_waits_for_a_gated_write` **与** `test_sync_discipline.py`（调用顺序）”钉住，但纪律测试当时**完全没有看** `runner.py`——那条“写栅栏的依据”只在代码里，没有被机器盯住 | ✅ 补 `test_write_fence_counts_a_write_only_after_it_landed`（扫 AST：`host.write()` 的 `try` 必须有非空 `finally` 调用 `_release()`）。违反注入见上表 |
| D7 | D5 的修复方向是对的，但**没有留下判别力**：把 D5 的 `wait_for(input_held is False)` 删掉，原来的断言（“按写栅栏去判断放行”）在任何负载下都只会**继续绿**——修复本身不可回归 | ✅ 补 `test_write_fence_alone_does_not_prove_the_client_was_released`：用一道闸把放行通知压后（与 `BlockingHost.write_gate` 同一手法），确定性地展示“写栅栏已满足而客户端仍被暂缓”，把 D5 的教训变成能红的用例 |

同轮清理：`tests/support.py` 的模块 docstring 把四个栅栏写成了“三个”；`docs/audit.md` 本节的
“上界 3s”未说明那是**默认值**（推送窗口两条按需放宽到 10s）；`frontend/probe/README.md` 的探针表
被一段说明文字劈成两半（`shortcuts.mjs` / `conpty-alt-screen.mjs` 两行会渲染成字面文本）
——三处均已改正。`test_input_backpressure.py` 里判断“有没有放行”的列表推导抄了两份，
收成一个 `release_notices()`；“把队列压到高水位”的 4 行前置步骤也收成 `fill_to_high_water()`。

这两条的性质与 D1–D5 不同：它们不是产品缺陷，是**审计记录比代码更乐观**——docstring 声称某处
被机器盯住，实际没有。所以处置也只有一个方向：让那句话变成真的，或者把它删掉。

### 为什么这几条栅栏是成立的

每一条都对应管道上一个真实存在的观察点，而不是“估计够久了”：

- **输出**：`_ingest_output` 无 await ⇒ 日志偏移可观察时，推送已发生（含裁剪与水位判定）；
- **写入**：`_release()` 在 `host.write()` 返回之后才扣减在途计数 ⇒ 计数归零即写入已完成；
- **控制面**：`handle_message` 的分发是同步调用 ⇒ `await` 返回时副作用已完成。

三条都是**代码结构**上的性质，所以由 `tests/test_sync_discipline.py` 扫 AST 盯着（控制面 15 个函数、
`_pump_loop` 的 `ProcessExited` 分支、`_write_loop` 的 `host.write()` → `finally` 扣减）；它们一旦被改掉，
红的是那条纪律测试，而不是 46 处断言在某台忙机器上偶发失败。

验证（第四轮及其复核结束时全量重跑）：`ruff check` / `ruff format --check` 全绿（49 文件）；`mypy` 全绿（31 源文件）；
`pytest -q` = **261 passed, 32 skipped**（第四轮修完时 259，复核补的 2 条见上；11s）；
`TERMINALD_CONTRACT=1 pytest -q -m contract` = **32 passed**（43–77s，波动来自真实 ConPTY 子进程的启动，与本轮无关）。
前端未改动。

复核补的两条都做过违反注入（结果见判别力表）。另外把 D5 涉及的三个文件——`test_input_backpressure.py`、
`test_push_window.py`、`test_hub.py`——在改动前后各连跑 **15 轮**（修前 34 passed、修后 35 passed），零红。

---

## 2.10 第五轮（2026-09-25）：依赖不该靠人记，错误文案不该给人看内部细节

起因是一条被贴出来的界面提示：

> 服务端错误：未找到 pywezterm。它是仓库里的长期依赖 vendor/pywezterm/（不安装）：把仓库的 vendor/ 加进 PYTHONPATH（见 backend/README.md 的「运行」一节）（HostUnavailable）

它把两件事做错了，而两件事的根是同一个：**层没分清**。

### 问题一：仓库自带的依赖，却要求调用者记得配环境变量

pywezterm 是仓库的长持依赖（`vendor/pywezterm/`），但要让它可导入，得由**启动命令**带上
`PYTHONPATH=../vendor`。漏了也不会有人拦：服务照常起来、照常监听、照常接受 WebSocket，
直到有人点「+」才失败，而那时只表现为浏览器上一条离根因很远的提示。

**修法**：`runtime/vendor.py` 从包自身的位置向上找到仓库里的 `vendor/` 并接进 `sys.path`。
用 venv 还是系统 Python、从哪个目录起，都不需要任何环境变量。

配套地，`__main__.main()` 加了**启动自检**：`host_impl == "pywezterm"` 时先确认依赖可导入，
失败就打印「怎么补依赖」并退出码 2——与已有的「只绑回环地址」那条同构，都是**没有任何
后续信号**的错误，必须在启动那一刻拒绝，而不是留到运行期。

> 排查过程中的一次误判也记下来：最初把「用系统 Python 起的进程」当成了用户的启动方式，
> 据此断言「你没带 PYTHONPATH」。实际那是用系统 Python 另起的第二个实例（连包都导不到），
> 真正服务着 8765 的是 venv 起的那个。**结论必须来自进程树而不是单条命令行。**
> 误判本身没有影响修法——「依赖不该靠外部配置」依然成立——但归因错了一次。

### 问题二：`Failure` 的正文是一段运维备注，不是一句报错

`Failure(code, message)` 直接取 `type(exc).__name__` 与 `str(exc)`，于是报错正文变成了
「未找到 pywezterm。它是仓库里的长期依赖 vendor/pywezterm/（不安装）：把仓库的 vendor/
加进 PYTHONPATH（见 backend/README.md 的「运行」一节）」，后面还挂一个「（HostUnavailable）」。
三个毛病：把处置说明当正文、把人指向他够不着的地方（README 章节、服务端日志）、
以及拼接痕迹（末尾那个类名）。另外 `SessionNotFound` 没有自定义 `__init__`，
`str(exc)` 是空串 —— 用户看到的是一条**空白**提示。

**修法**：`core/errors.py` 里每个错误带三层信息，受众不同、不得混用：

| 字段 | 受众 | 内容 |
|---|---|---|
| `code` | 客户端 / 排查 | 稳定 snake_case 标识，**不是**类名的镜像（类名会随重构改名，它是协议的一部分） |
| `user_message` | 浏览器前面的使用者 | **一句话**，只说发生了什么。不写处置说明，不写「详情见…」 |
| `str(exc)` | 服务端日志 / REST detail | 技术细节（偏移、会话 id、导入错误原文），要多长有多长 |

前端 `app.ts` 同步改掉两处：协议 `error` 只显示服务端给的 `message`（`code` 只进控制台），
客户端自身的诊断错误（`onError`）不再把原始消息直出。
（`onError` 那条文案里保留了「详情见浏览器控制台」——控制台是使用者自己按 F12 就能打开的，
与「详情见服务端日志」不是一回事。）

### 守门

| 防止的退化 | 守门测试 |
|---|---|
| 依赖又要靠 `PYTHONPATH` | `tests/test_vendor.py`（5 条：能定位、幂等、换 cwd 与不带 vendor 路径仍定位） |
| 启动自检被删 / 误伤 `fake` 宿主 | `tests/test_config.py`（缺失→退出 2；`fake` 不该被拦） |
| `code` 退化成类名、改名破坏协议 | `tests/test_error_messages.py`（snake_case、已知 code 写死对照、不等于类名） |
| 正文又变成一段运维备注 | 同上：禁用词正则 + **字数与句号数上限** + 禁止「详情见…」 |
| 正文承诺了没做的事 | 同上：出现「正在/即将/会自动」必须登记在 `KNOWN_FULFILLED_PROMISES` 里 |

后三条同时套在 `api/ws.py` 那五条**传输层**文案上（`WS_MESSAGE_NAMES`）：它们不挂在
领域错误类上，只按类遍历会漏掉。

这三条是对着旧文案反向验过的（`未找到 pywezterm。它是仓库里的长期依赖…` 103 字、
`…详情见服务端日志。` 命中「详情见」、`…正在重新载入。` 命中「正在」），不是恒真断言。

顺带删掉一处**不可达**的错误处理：`api/ws.py` 的 `_dispatch_control` 曾在
`hub.handle_message` 外面再接一层 `except TerminaldError`，而 `Hub.handle_message`
内部已经兜住了——那层永远进不去；万一哪天 hub 那层被去掉，它还会**重复下发**同一条
`Failure`。

### 验证

`pytest -q` = **328 passed, 32 skipped**；`TERMINALD_CONTRACT=1 pytest -q -m contract` = **32 passed**；
`ruff check` / `ruff format --check` / `mypy src` 全绿（32 个源文件）；
前端 `tsc --noEmit` 通过、`vitest run` **117 passed**、`npm run probe:all` 8/8。

---

## 3. 缺陷 → 回归测试对照

一次性取证脚本（`backend/.audit/*.py`）已随缺陷修复删除；每一项结论现在都由**能在 CI 里跑的**
测试或探针守住。想复现某条结论，跑下面对应的那一条即可。

| 缺陷 | 守住它的回归 | 怎么跑 |
|---|---|---|
| A1 输入阻塞事件循环 | `tests/test_hub.py::test_blocked_write_never_stalls_the_event_loop`（`BlockingHost` 把「写阻塞」变成可断言状态） | `pytest -q -k blocked_write` |
| A2 重建快照撕裂 / 对齐点错位 | `tests/test_contract_pywezterm.py::test_model_and_journal_stay_aligned_under_flood`、`::test_rebuild_after_trim_has_no_hole_and_no_overlap`（真 ConPTY：行号连续、与补发字节零重叠） | `TERMINALD_CONTRACT=1 pytest -q -m contract -k 'aligned or rebuild'` |
| A3 握手期异常逃出端点 | `tests/test_api.py::test_bad_hello_is_rejected_with_a_diagnosable_failure`（5 种非法首消息参数化，断言 `bad_hello` + 1002） | `pytest -q -k bad_hello` |
| A4 `Ack` 空转 / 未确认积压无上界 | `tests/test_push_window.py`（4 条：窗口生效、越大越停手、`Ack` 推进、落后升级为重建） | `pytest -q tests/test_push_window.py` |
| A6 同一 PTY 两个写者 | 线程归属表 + `tests/test_layering.py`，行为面由 A1 的写线程用例覆盖 | `pytest -q -k blocked` |
| A7 死协议面 | `tests/test_protocol.py`（两个方向都不存在尺寸消息）、`tests/test_outbox.py`（只留 `pending_bytes`/`would_exceed`） | `pytest -q tests/test_protocol.py tests/test_outbox.py` |
| A8 / A9 / A11 刷新后的「位置」 | `probe/remember.mjs`（19/19）+ `tests/test_journal.py`（裁剪不劈字符等 6 条） | `node probe/remember.mjs` |
| A10 输入方向背压 | `tests/test_input_backpressure.py`（4 条）、`tests/test_contract_pywezterm.py::test_input_reaches_the_child_byte_identical`（真 ConPTY 上子进程自己算 sha256）、`probe/input-hold.mjs`（13/13） | `pytest -q tests/test_input_backpressure.py` / `node probe/input-hold.mjs` |
| A12 四个浏览器级交互 | `probe/shortcuts.mjs`（19/19；`PROBE_HEADED=1` 用可视浏览器再跑一遍）+ `src/ui/shortcuts.test.ts`（22 条决策真值表与副作用顺序） | `npm run probe:all` / `npx vitest run` |
| A13 拆除冻结整个服务 | `tests/test_host_teardown.py`（6 条：顺序契约、真进程树终止、纳管失败策略）、`tests/test_hub.py::test_blocked_close_never_stalls_the_event_loop`、`tests/test_api.py::test_deleting_a_session_does_not_freeze_http`、`tests/test_contract_pywezterm.py::test_closing_a_session_kills_the_tree_and_stays_bounded` | `pytest -q tests/test_host_teardown.py` / `TERMINALD_CONTRACT=1 pytest -q -m contract -k tree` |
| 多客户端逐行同步 | `tests/test_hub.py`（`Endpoint` 强制 offset 首尾相接）+ `probe/multi-client.mjs`（10/10，含“真的滚到了最早一行”的前提断言）、`probe/scrollback.mjs`（6/6，含滚动条存在/贴边/可拖） | `node probe/multi-client.mjs` |
| 前后端字段形状漂移（V6） | `tests/test_protocol.py::test_server_message_shapes_match_shared_contract` + `src/protocol/frames.test.ts::字段形状与后端生成的契约逐字一致`（两侧都引用同一份 `vectors/shapes.json`） | `pytest -q -k shapes` / `npx vitest run src/protocol` |
| 等错东西（D5/D7：“写完了”≠“放行了”） | `tests/test_input_backpressure.py::test_input_hold_pauses_sender_without_dropping_bytes`（栅栏改成 `input_held is False`）+ `::test_write_fence_alone_does_not_prove_the_client_was_released`（反向：把通知压后，写栅栏满足而放行没到） | `pytest -q tests/test_input_backpressure.py` |
| 固定睡眠当同步（D1–D4） | `tests/test_sync_discipline.py`（1 条禁固定睡眠 + 15 条控制面同步性 + 1 条 `EXITED` 原子性 + 1 条写栅栏依据 + 1 条豁免名单防僵化）与 `tests/test_hub.py::test_writes_drained_waits_for_a_gated_write` | `pytest -q -k 'sleep or control_plane or process_exit or write_fence or writes_drained or exemption'`（22 条） |

`probe/` 下**七个探针全部自带服务器**（各自独占一个端口，从 8801 起、被占用就往上找，跑完自己收掉），
所以它们可以在你正用着 8765 的时候跑，**不会碰你的会话**；想打到已有服务上就设 `PROBE_BASE`（那时会先清空会话）。
完整清单（含每个探针证明什么、端口、环境变量）见 `frontend/probe/README.md`。
