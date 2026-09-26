# 前端

xterm.js v6 + TypeScript + Vite。构建产物直接落到 `../backend/src/terminald/web/`，由后端同源托管
（不需要 CORS、不需要代理、不需要把端口编进产物）。

## 环境与命令

```bash
cd frontend
npm install

npm run dev        # 开发服务器（需要在后端跑起来时才有数据；开发时用 vite 代理或直接访问后端）
npm run typecheck  # tsc --noEmit，strict
npm test           # vitest
npm run build      # typecheck + 构建到 backend/src/terminald/web/
npm run probe      # 真实浏览器端到端探针（自带服务器，不碰你手上的会话）
npm run probe:all  # 全部九个探针（约 4 分钟，逐个跑完再汇总退出码）
```

探针驱动的是**构建产物**，所以改完前端要先 `npm run build` 再跑探针。

侧栏的三个交互：单击订阅一个会话、**双击卡片重命名**（走协议里的 `session.rename`，名字的
长度边界由服务端判定）、点 `×` 关闭。

## 目录

```
src/
  protocol/   帧编解码、控制消息、offset 换算 —— 与后端 protocol/ 逐字节一致
  net/        WS 客户端：握手、订阅、流控回执、落后重同步、断线续传
  render/     尺寸求解（纯函数）+ 实测校正 + DOM 度量
  ui/         布局装配、深色主题、DOM 助手、位置记忆（remember.ts）、快捷键扩展（shortcuts.ts）、
              尺寸控制的决策逻辑（size-control.ts，纯函数）
probe/        真实浏览器探针（真 Chromium，走完整链路）
```

## 渲染器：WebGL + 自绘字形（`ui/app.ts`）

`open()` 之后挂的是 `@xterm/addon-webgl`，不是默认的 DOM 渲染器。理由只有一个但很硬：
**方块与盒线字符只有非 DOM 渲染器才会自绘几何、填满整个字符格**（U+2500–257F 盒线、
U+2580–259F 方块、U+E0A0–E0BF powerline）。而我们的行高是固定 1.3 倍（见 `render/size.ts`），
格子比字体字形高——交给字体画，竖着叠两个 `█` 必然留一条横缝。同一图案实测：自绘 0 空洞、
字体字形 620 px 空洞（两组数字与截图见 `probe/glyphs.mjs`）。

两条连带影响，改前端时要知道：

- **DOM 里没有屏幕文本了。** 换渲染器会把 DomRenderer dispose 掉，而 `.xterm-rows` 正是它的元素，
  于是「读 DOM 文本」那套取数口全部失效。屏幕文本改从 `debugState().screenLines` 读
  （`probe/screen.mjs` 是唯一入口）；像素那一层由 `probe/glyphs.mjs` 与 smoke 的非底色像素数守。
  两者别混着说：**「进了缓冲区」不等于「画到了屏幕上」**。
- **拿不到 WebGL2 时会退回 DOM 渲染器**（`app.ts` 接住了 addon 的抛错并发告警，不是静默）。
  所以探针必须带 `--enable-unsafe-swiftshader`（`probe/env.mjs` 的 `CHROMIUM_ARGS`）：无头
  Chromium 默认拿不到 WebGL2，少了它测的就是另一条渲染路径。

## 快捷键扩展：四个浏览器级交互（`ui/shortcuts.ts`）

F11 / Ctrl+C / Ctrl+V / 右键都是**浏览器与 xterm 默认行为的冲突**，不是应用逻辑：xterm 在发完
控制字节后会 `preventDefault + stopPropagation`，于是 Ctrl+V 只塞一个 `0x16` 而根本不粘贴、
Ctrl+C 有选区也只打断不复制、F11 会往 PTY 里塞 `\x1b[23~`。

接管点是 `attachCustomKeyEventHandler`（返回 `false` 阻止 xterm 发字节，且**不会** preventDefault），
所以两件本来就该由浏览器做的事（原生粘贴、原生复制）只是「不再被掐掉」，而不是被重写一遍。
现状、根因与实测数字见 `docs/audit.md` A12 与 `docs/architecture.md` §11.2。

`npm run probe:all` 会依次跑 `probe/` 下全部九个探针（各练什么、占用哪个端口、有哪几个
环境变量见 `probe/README.md`）；单独跑某一个，例如 `node probe/shortcuts.mjs`
（`PROBE_HEADED=1` 用可视浏览器跑同一组）。

**每个探针自带服务器**（各自独占一个端口，跑完自行收掉），所以可以并行跑、也可以在
你正用着 8765 的时候跑——它不会碰你的会话。要打到已有服务上就设 `PROBE_BASE`。
路径与工具定位全在 `probe/env.mjs`（由文件位置推导，不写死任何本机路径）。

## 改尺寸：顶栏那个尺寸 chip（`ui/app.ts`、`ui/size-control.ts`）

顶栏显示 `120×30` 的那个 chip 是**可点的**：它就是改尺寸的入口。弹层里给三个常用档位
（80×24 / 120×30 / 160×40）和一对可手输的输入框。

四条要点：

- **网格是输入、字号是输出**：改尺寸改的是 `cols`/`rows` 这两个数（上行 `session.resize`），
  不是字号。所以这里**不用** `addon-fit`——它做的是反方向（窗口 → 算网格 → `term.resize`）。
- **显示的值恒来自服务端**（`attached` / `resized`），**不做乐观更新**：这条操作真的可能失败
  （会话恰好被关掉、越界被拒），界面先动就会造出「界面说改了、实际没改」的假状态——
  与切会话时「先读记忆再清屏」同一个道理。
- **上下界不在这里判**：那是协议层的事实（`SESSION_COLS_MIN` 等），前端抄一份只会多一个会
  漂移的常量；前端只拦「根本不是尺寸」的输入（空、非数字、小数、`1e3`、`12abc`、`0`……），
  见 `size-control.ts` 与它的单测。
- 收到 `resized` 之后做两件事：`term.resize(cols, rows)`（由 `fitTerminal` 带着做）与
  **重记一次位置**——改尺寸会让 xterm 按新宽度重排缓冲区，行号跟着变
  （见 `docs/architecture.md` §11.1 的第四条决定）。

已退出的会话不可改（尺寸要落到 PTY 上才有意义），chip 会置灰且点不开。
端到端由 `probe/resize.mjs` 守着，含「活过整次改尺寸的客户端」与「改完之后才订阅的客户端」
**逐行一致**这条。

## 三条硬约束

1. **`cols`/`rows` 由终端侧决定**（`attached` 消息），运行期只由用户经前端的尺寸 chip 显式
   变更（`session.resize`，见上）。前端只求一个让网格铺满容器的字号——字号是因变量。
   `render/size.ts` 是纯函数，`render/fit.ts` 负责应用后**实测校正**（xterm 的内部度量与
   我们的模型可能差一点，差一点在 120 列上就是可见的溢出）。
2. **终端数据一律不可信**：所有文本走 `textContent`，代码库里没有 `innerHTML`；
   OSC 8 链接只放行 `http(s)` 且必须按住修饰键；禁 CDN、禁运行时下发 JS。
3. **连接与同步状态是可见的**：无损续传 / 重连中 / 待重同步 / 已重建（有损）分开呈现，
   「刷新丢了一截」必须能被解释，而不是变成用户眼里的随机丢失。

## 协议镜像：同一份向量与形状，不是复制品

`vite.config.ts` 把两个别名指到**后端的原件**：

- `@protocol-vectors` → `protocol/vectors/basic.json`（帧布局与 6 种消息的 JSON 形态）；
- `@protocol-shapes` → `protocol/vectors/shapes.json`（**每条**下行消息的字段形状，由后端模型生成）。

任何一侧改了字节布局或字段，前端测试立刻红。`src/protocol/messages.ts` 里的 `SHAPES` 是手写的，
它存在的意义是“把契约写清楚”，但**它必须等于 `shapes.json`**——那条比对在 `frames.test.ts` 里。

**帧里的 offset 是 u64，用 `bigint`**：JSON 的 number 是双精度，超过 2^53 就不精确，而向量里
就有一条 > 2^53 的用例。应用层要的 `number` 由 `protocol/offset.ts` 在边界上一次性换算，
越界直接抛错而不是悄悄截断。

## 探针（`npm run probe`）

单测覆盖逻辑，探针回答单测回答不了的问题：xterm 真的挂上了吗？字号求解真的没溢出吗？
键盘输入真的经 WS 进了 PTY、输出又回到屏幕了吗？

它用真 Chromium 走完整链路，自带一个后端：

- xterm 挂载、侧栏会话名正确、历史重放进入屏幕缓冲
- **标记那一行真的被画在了屏幕上**（数那一行的非底色像素）：WebGL 渲染器下 DOM 里没有文本，
  「进了缓冲区」与「画出来了」是两层，这条专门守后者
- 网格未溢出容器、`.xterm` 铺满、网格居中留白
- 会话切换不混屏、切回后重新订阅
- 键盘输入 → WS → 真实 PTY → 回显到屏幕（回显同样读模型文本，见 `probe/screen.mjs`）
- 刷新页面后内容仍在（无损续传）
- 无 JS 错误、无失败请求

**滚动条**不再由这个探针断言：xterm v6 的滚动条在 `.xterm-scrollable-element` 里、还是懒创建 + 自动淡出，
只有真有 scrollback 的探针才看得见它——那三条（存在 / 贴右边缘 / **拖得动**）在 `probe/scrollback.mjs` 里。

浏览器可执行文件自动在 `ms-playwright` 下找**最新**那份（不写死修订号），可用 `PROBE_CHROME` 覆盖；
`PROBE_BASE` 覆盖后端地址；`PROBE_OUT` 覆盖截图输出目录；定位不到 Chromium 会直接报错并告诉你怎么装。

> 探针只碰它自己起的服务与自己创建/删除的会话与截图，不碰仓库文件，也不会动你手上那个服务。
