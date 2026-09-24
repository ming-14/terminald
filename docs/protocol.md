# 协议

前后端共用的**唯一真源**在 `backend/src/terminald/protocol/`：

- `frames.py` —— 二进制帧编解码
- `messages.py` —— 控制消息（pydantic 模型）
- `vectors/basic.json` —— 共享测试向量（前后端各跑一遍）
- `../__init__.py` —— `PROTOCOL_VERSION`

前端必须在 `frontend/src/protocol/` 里逐字节复刻 `frames.ts`，并用同一份 `vectors/basic.json`
跑编解码测试。任何一侧漂移都会在测试里红。

## 1. 两种帧形态

一条 WebSocket 连接上只有两种消息，靠 opcode 区分，负载里不做多路复用：

| 形态 | 内容 |
|---|---|
| 二进制帧 | 终端字节流（帧格式见下） |
| 文本帧 | 控制消息（JSON） |

**每条二进制消息可以串接多个帧**（服务端一次发送多段输出时避免一条一个小消息，客户端一次
`send` 多段输入同理）。因此每个帧自带长度前缀，格式是自定界的：

```
FRAME = 长度(u32 大端) | tag(u8) | [offset(u64 大端)] | payload
```

`长度` 覆盖 `tag + [offset] + payload`（不含长度字段自身，最少 1）。

| tag | 名称 | 方向 | offset | payload |
|---|---|---|---|---|
| `0x01` | OUTPUT | S→C | 有 | 输出字节；**payload 首个字节在日志中的绝对偏移** |
| `0x02` | INPUT | C→S | 无 | 客户端已按当前模式编码好的输入字节 |
| `0x03` | SNAPSHOT | S→C | 有 | 模型渲染的重建字节；应用后客户端即对齐到该 offset |

offset 是整个同步机制的坐标：客户端据此上报已确认位置，服务端据此补断档，双方据此判定
落后与不一致。OUTPUT 与 SNAPSHOT 必须带它，INPUT 不需要。

非法/截断的帧**抛错，不静默跳过**。静默跳过会让双方状态悄然分叉——那正是这套协议要避免的事。
服务端遇到帧解析失败会以 `1002` 关闭连接（字节流已错位，继续读只会放大混乱）。

单帧上限 64 MiB（防御性）。

## 2. 控制消息

控制消息是带 `t` 判别标签的 JSON，`extra="forbid"`——字段拼错在边界立刻暴露，而不是变成线上
一个静默失效的功能。

### C → S

| `t` | 字段 | 说明 |
|---|---|---|
| `hello` | `protocol`、`client` | 握手，首条消息必须是它 |
| `attach` | `session`、`resume?` | 订阅；`resume` 是客户端**已应用到本地终端**的偏移，`null` 表示全新客户端 |
| `detach` | — | 结束订阅但保留连接（切回列表页） |
| `resync` | `session`、`offset` | 请求重新对齐（落后或本地状态可疑时） |
| `ack` | `offset` | 确认「已解析到 offset 之前的全部字节」 |
| `focus` | `focused` | 窗口聚焦变化（服务端聚合后转发给应用） |
| `session.create` | `name?`、`argv?`、`cwd?` | 新建并自动订阅 |
| `session.list` | — | 请求会话列表 |
| `session.close` | `session` | 关闭会话 |
| `session.rename` | `session`、`name` | 重命名 |

**没有** `resize` / `mouse` / `paste` 三类消息，理由：

- 无 resize（**两个方向都没有**）：尺寸由终端侧在会话创建时决定（见 architecture §4）。
  当前没有任何“终端侧改尺寸”的代码路径，所以也没有对应的下行消息——真要加时才加，
  不留占位面（见 audit.md A7）。
- 无 mouse：鼠标编码由 xterm.js 依据应用开启的追踪模式完成，结果与键盘一样走 INPUT 帧；
  应用未接管鼠标时由前端本地做选择/链接，服务端无需知情
- 无 paste：bracketed paste 的包裹由知道该模式的一方（xterm.js）完成，同样落到 INPUT 帧

### S → C

| `t` | 字段 | 说明 |
|---|---|---|
| `hello_ok` | `protocol`、`server` | 握手通过 |
| `attached` | `session`、`cols`、`rows`、`scrollback`、`offset`、`resumed` | 订阅完成。`cols`/`rows`/`scrollback` 是**终端侧属性**，一并交付；`resumed=true` 表示无损对齐，`false` 表示走了模型快照重建 |
| `meta` | `session`、`title`、`cwd`、`progress_label`、`progress_value` | 会话元数据（来自终端模型的 OSC 解析） |
| `exited` | `session`、`code` | 子进程退出（**会话不销毁**） |
| `sessions` | `items` | 会话列表 |
| `behind` | `session`、`offset`、`reason` | 该客户端已落后：增量停止发送，请发起 `resync` |
| `input_hold` | `session`、`paused` | 输入方向流控：`true` = 本端排队不要再发，`false` = 已排水，原序补发（见 §3「输入流控」） |
| `error` | `code`、`message` | 错误（`code` 通常是领域错误类名） |

`attached` 一次交齐三个终端侧属性（`cols` / `rows` / `scrollback`）：它们决定客户端如何渲染与
保留历史，客户端**无权修改**，也不该自己猜。`scrollback` 尤其不能不传——否则前端只能写死一个数
去和服务端配置对齐，那是个会漂移的常数。

`attached.resumed` 的含义是**这次对齐是否无损**，不是「是不是老客户端」：

- `true`：字节级对齐（补断档，或全新客户端从 0 整段重放）
- `false`：日志已裁剪到断点之前，只能下发模型快照——唯一有损的路径

客户端不需要因此改变行为（两种情况后续都从 `offset` 续接），它的用途是可观测性：
无损对齐与有损重建应该被分开计数。

`offset` 是**客户端从那一刻开始解析字节**的位置，因此它必须是一个解析状态干净的点：

- 无损对齐时它就是服务端当时已产出的字节数（`journal.end_offset`）；
- 有损重建时它可能**早于**该字节数——如果日志末尾正卡在一个残缺的转义序列或多字节
  UTF-8 字符里，对齐点会回退到那个序列/字符的起点，因为交付给客户端的是「快照 + 从
  对齐点起的字节」，从残缺位置开始解析会让客户端把参数尾字节（`3m` 之类）当普通文本
  画到屏幕上。两种情况下 `SNAPSHOT.offset` 都等于 `attached.offset`。

客户端据此实现的两件事（都在参考前端里）：重放结束后恢复刷新前的视口位置；以及
「已解析到 `offset`」的 `ack` 推进服务端的推送窗口。

## 3. 时序

### 握手

```
C: 文本 hello{protocol:1}
S: 文本 hello_ok{protocol:1}
C: 文本 session.list          ← 客户端主动要一次初始列表
S: 文本 sessions{items:[...]}
```

版本不符时服务端回 `error{code:"protocol_mismatch"}` 并以 `1002` 关闭。
首条消息不是 `hello` 视为协议违例。连上却不发 `hello` 会在 10s 后断开（避免半开连接堆积）。
握手前的二进制帧直接丢弃，绝不当作输入。

**`session.list` 必须由客户端主动发**：服务端只在会话增删改时**广播**列表，不推初始快照。
少了这一步，刷新页面后侧栏永远是空的。

来源校验不通过时**不 accept**，让 Starlette 以 HTTP 403 拒绝升级。

### 订阅（无损）

```
C: 文本 attach{session, resume:null}
S: 文本 attached{session, cols, rows, offset:end, resumed:true}
S: 二进制 OUTPUT(0, ...) OUTPUT(n, ...) ...    ← 从 0 或从 resume 补齐到 end
```

`attached` **必须先于流字节入队**：客户端要先知道 cols/rows 与对齐点，再应用字节。
`sender` 保证同一连接 FIFO，所以顺序成立。

### 订阅（有损：走模型快照）

```
C: 文本 attach{session, resume:N}          （N < journal.start_offset）
S: 文本 attached{..., offset:对齐点, resumed:false}   ← 可能是 end，也可能是末尾残缺序列的起点
S: 文本 meta{session, title, cwd, ...}
S: 二进制 SNAPSHOT(end, RIS + 模式恢复 + scrollback 重放 + 可见区重绘)
```

`meta` 在快照之前下发，让 UI 在内容到达前就有标题可用。

### 重新同步

`Resync` **一律整段重建**，不做增量尝试。原因：此刻传输层可能已经交给 socket 一批旧增量，
服务端无法知道客户端还会收到多少。单条连接发送是 FIFO，所以「旧增量先到、快照后到」必然成立，
快照覆盖一切——这是可证明的收敛，不是碰运气。

服务端在重建前会丢弃该客户端 outbox 里尚未发出的负载，避免旧增量与新快照交错。

### 落后

```
S: 文本 behind{session, offset:cursor, reason:"trimmed"}
C: 文本 resync{session, offset:<自己知道的偏移>}
```

`behind` 只在**客户端游标落后到日志已裁剪的位置**时发出（发送水位导致的暂停不发它）。
它是「落后」这个状态的显式化——协议绝不允许静默少发一段字节。

### 流控

```
S: 二进制 OUTPUT ...            ← 按游标补齐，到发送队列水位 / 解析窗口就停
C: 文本 ack{offset}             ← 客户端已渲染到这里
S: 二进制 OUTPUT ...            ← 从游标续补
```

两道限制都在**每客户端**身上：慢客户端绝不阻塞广播路径上的其他人。

`ack` 不是可选的礼貌回执，而是**实时推送窗口的解锁信号**：发送队列水位只能限制「已交给 socket、
还没写完」的字节，管不到客户端已经吃下的字节，所以服务端还会限制「已交给 socket、客户端还没渲染完」
的字节——最多推到 `acked + push_ahead_bytes`，越过就停手等 `ack`（见 architecture §6.1）。

所以客户端应当**及时 ack**（官方 flowcontrol 建议的做法：按字节数或时间取先到者，在 write 回调里确认）。
服务端对**从未 ack 过**的客户端回落为“不加窗口”（一直推）：不会 ack 的实现不会被停在一个永远
解不开的窗口上，代价是它的未解析积压只能靠它自己控。

### 输入流控（客户端 → PTY）

输出方向是「服务端推、客户端跟不上」；输入方向正好相反——是**客户端灌得比 PTY 写得快**
（典型场景：往一个不读 stdin 的程序里粘贴一大段文本）。协议用同一条思路处理：**让产生
数据的这一端停下来**，而不是让服务端无限缓冲，也不是下沉到传输层。

```
C: 二进制 INPUT ...                       ← 正常发送
S: 文本 input_hold{session, paused:true}  ← 服务端写队列到高水位（只发一次）
C: （本端按序排队，不再发送；控制消息不受影响）
S: 文本 input_hold{session, paused:false} ← 写队列已回落到低水位
C: 二进制 INPUT ...                       ← 排队的内容按原序补发
```

三条约束：

1. **不丢字节**。水位只决定「发送方还能不能继续发」，字节一旦入队就一定会被写到 PTY。
   客户端排队的内容在放行后按到达顺序补发；它自己的队列有上限（默认 16 MiB），越限时
   丢弃**最新**的字节并显式报错——丢了多少、为什么丢必须能被上层看见。
2. **控制面不堵**。`detach`、`session.close`、`focus` 永远可发。这正是本方案不停读接收
   循环（内核级背压）的原因：那条路会把同一条连接上的控制消息一起堵住，而且对端在暂停
   期间断开时服务端无从察觉（uvicorn 只把 disconnect 放进队列，不会取消 app 任务）。
3. **越限即断开**。服务端已明确暂缓过，对端仍灌到硬上限（默认 16 MiB）说明它在违约：
   回 `error{code:"input_overflow"}` 并以 `1009` 关闭。已收下的字节不丢，仍会被写完。
4. **补发必须分批**（客户端义务）。硬上限看的是服务端写队列的**瞬时**深度，而“放行”只表示
   队列已回落到低水位；一次把整队倒出去等于给队列加上整队那么多字节，于是**完全守规矩的
   客户端也会被当成违约**。实测（本端积压 4.75 MiB、硬上限 4 MiB）：一次倒出 →
   `input_overflow` + `1009`，输入被截断；每次 1 MiB 分批 → 零错误、字节逐字节一致。
   客户端应当：每批 ≤ 1 MiB（远小于任何合理的硬上限）、**过大的段要切开**、剩下的靠一个
   短定时器继续推（这样服务端高水位比本端批量小时会重新下发暂缓，比本端批量大时也不会
   把尾巴永远卡在本地），并且**积压未清空时新输入一律入队**（否则补发途中的按键会插到
   积压前面）。

阈值关系由配置校验强制（`input_low_bytes ≤ input_high_bytes`、`input_hard_bytes ≥ 2 ×
input_high_bytes`）：差的不是「大于还是等于」，而是有没有给**在途帧**留出空间——客户端收到
暂缓之前已经发出的帧仍在路上，`hard` 贴得太近会让守规矩的客户端被当成违约。

`paused:false` 只会发给**确实被暂缓过**的客户端，而且每次暂缓只配一次放行（滞回）：
没有这两条，连续输出会把控制面刷爆，或者让前端的状态机凭空多一分不确定性。
`input_hold` 带 `session` 字段，是因为客户端切换订阅时旧会话的放行**不能**把新会话的输入
提前倒出去。

## 4. 共享测试向量

`protocol/vectors/basic.json` 是前后端共同契约，包含：

| 段 | 内容 |
|---|---|
| `output_frames` / `snapshot_frames` / `input_frames` | 帧编解码的字节级期望值（hex 小写无空格） |
| `batched` | 一条消息串接多帧 |
| `control_messages` | 控制消息的 `json` 形态（目前覆盖 `hello`/`attach`/`attached`/`behind`/`input_hold` 等 6 种） |

每个控制消息向量**只在一个方向上合法**（`hello`/`attach` 是 C→S，`attached`/`behind` 是 S→C），
所以两个解析器里恰好一个能成功——这本身就是方向约束的断言。

`version` 字段必须等于 `PROTOCOL_VERSION`。

### 4.1 字段形状（`vectors/shapes.json`）

`basic.json` 钉的是「帧怎么排、这几种消息的 JSON 长什么样」；**每条下行消息有哪些字段、什么类型**
由另一份文件钉：`protocol/vectors/shapes.json`。

- 它由后端模型**生成**（`messages.py::server_message_shapes()`），不是手写的；
- 前端 `messages.ts` 里那套校验器（`SHAPES` / `SESSION_INFO_SHAPE`）允许手写，但必须与它一致；
- 两侧各有一条测试：后端断言「重新生成的结果 == 文件」，前端断言「自己的表 == 文件」。
  所以**改了模型不重新生成**（后端红）、**改了前端不同步**（前端红）都会被抳下。

为什么需要它：前端对每一条下行消息都做**严格**校验（字段类型错、多一个字段都拒收）。
若只靠 `basic.json` 的 6 种消息守契约，剩下的 12 种里后端动一个字段就会当场丢消息，
而两边各自手抄一份比对方重写一遍还容易把同一个误解写两遍。

重新生成（改了 `messages.py` 里的模型后）：

```bash
cd backend
PYTHONPATH=src ./.venv/Scripts/python.exe -c "import json;from terminald.protocol.messages import server_message_shapes;print(json.dumps(server_message_shapes(), ensure_ascii=False, indent=2, sort_keys=True))" > src/terminald/protocol/vectors/shapes.json
```

（新生成的文件会丢掉文件头那句 `$comment` 说明，记得补回去。）

## 5. 错误处理

| 情况 | 服务端行为 |
|---|---|
| 控制消息 JSON 非法 / 字段不合法 | 回 `error{code:"bad_message"}`，连接保留 |
| 领域错误（如 `SessionNotFound`） | 回 `error{code:<类名>}`，连接保留 |
| 控制消息超过 1 MiB | 回 `error{code:"too_large"}` 并以 `1009` 关闭 |
| 二进制帧解析失败 | 以 `1002` 关闭（字节流已错位） |
| 已暂缓仍越过输入硬上限 | 回 `error{code:"input_overflow"}` 并以 `1009` 关闭（见 §3「输入流控」） |
| 协议版本不符 | 回 `error{code:"protocol_mismatch"}` 并以 `1002` 关闭 |
| `Host`/`Origin` 非回环 | 不 accept，HTTP 403 |

关闭码：`1000` 正常、`1002` 协议错误、`1008` 策略拒绝（来源/握手超时）、`1009` 消息过大。

连接结束前服务端会**显式**发出关闭帧，不依赖 ASGI 服务器在应用返回后收尾。
