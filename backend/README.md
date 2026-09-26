# terminald —— 后端

pywezterm（PTY + 终端模型）支撑的持久会话网页终端守护进程。前端通过 WebSocket 订阅字节流，
服务端持有会话、输出日志与同步语义。

## 分层

依赖方向严格单向，由 `tests/test_layering.py` 扫 AST 强制执行（不是靠自觉）：

```
api ──→ service ──→ runtime ──→ core ──→ protocol
```

| 层 | 职责 | 硬约束 |
|---|---|---|
| `protocol` | 帧格式、控制消息模型、前后端共享测试向量 | 只依赖标准库 + pydantic |
| `core` | 领域逻辑：日志、订阅对齐、流控队列、会话 | **不** import `pywezterm` / `fastapi`；零外部依赖 |
| `runtime` | 宿主适配（PTY + 终端模型）与线程/桥 | **只有这一层**可以 import `pywezterm` |
| `service` | `Hub`：把领域对象、线程、协议帧缝起来 | 传输无关；不 import `fastapi` |
| `api` | HTTP + WebSocket 边界 | **只有这一层**可以 import `fastapi` / `starlette` / `uvicorn` |

`core` / `protocol` 也不得依赖 `config`，这样它们能在任何配置下被单测。

## 环境装配

pywezterm **不在 PyPI 上**，也**不安装**：它是仓库里的长期依赖，包目录在 `../vendor/pywezterm/`。

**不需要配 `PYTHONPATH`**：`runtime/vendor.py` 会从包自身的位置向上找到仓库里的 `vendor/`
并接进 `sys.path`，因此用哪个解释器（venv 或系统 Python）、从哪个目录起都一样。
（pytest 另由 `pyproject.toml` 的 `pythonpath = ["src", "../vendor"]` 带上，见「跑测试」。）

依赖真的缺失时，服务**拒绝启动**并退出码 2，日志里给出怎么补依赖；不会起来一个
照常监听、却建不出会话的进程。

```bash
cd backend

# 1. 建虚拟环境
python -m venv .venv

# 2. 装本项目与开发依赖（pywezterm 不装，见下）
./.venv/Scripts/python.exe -m pip install -e ".[dev]"
#   POSIX 上是 ./.venv/bin/python
```

> `pyproject.toml` 的 `dependencies` 里刻意**没有** pywezterm——写进去会让 `pip install -e .`
> 因为找不到 PyPI 包而失败。它的包体在 `../vendor/pywezterm/`，由 `runtime/vendor.py`
> 在运行时接进 `sys.path`（测试另有 `pythonpath = ["src", "../vendor"]` 兜住）。

### 前端构建产物

后端在 `src/terminald/web/` 找前端构建产物。该目录由 `frontend/` 构建写入，**不进版本控制**
（见根 `.gitignore`）。构建产物不存在时 `/` 会返回一个提示页，`/api/*` 与 `/ws` 照常可用。

## 跑测试

```bash
# 默认套件：全部跑在 fake 宿主上，无需原生扩展、无需网络
./.venv/Scripts/python.exe -m pytest

# 真实宿主的契约测试（起真实 ConPTY 子进程，默认不跑）
./.venv/Scripts/python.exe -m pytest -m contract
#   等价写法：TERMINALD_CONTRACT=1 ./.venv/Scripts/python.exe -m pytest
```

默认套件跑在 `FakeHost` 上，它的**线程归属**与真实适配器一致（`read()` 只在读线程、
`ingest()` 只在事件循环、`write()` 只在唯一写者），因此订阅、补流、裁剪、重同步、流控、
焦点聚合这些行为都能在没有 PTY 的前提下被确定性测出来。`-m contract` 补的是
「真实 PTY + 终端模型接上之后还成立」那一层。

## 质量门

四道一起过才算通过：

```bash
./.venv/Scripts/python.exe -m ruff check .
./.venv/Scripts/python.exe -m ruff format --check .
./.venv/Scripts/python.exe -m mypy          # strict
./.venv/Scripts/python.exe -m pytest
```

`pytest` 配了全局 `timeout = 60`：用例里大量「等某个条件成立」，条件永不成立时应当**失败**
而不是永久挂住。

### 测试怎么等（同步纪律）

**不要用固定睡眠等异步效果。** 机器一被抢占，`sleep(0.15)` 等到的就不是事件而是时间，
于是“等它做完”变成“猜它做完了”：忙的时候假红；而在**否定断言**（“应用不该收到 X”
“解除订阅后不该再收到内容”）前面更糟——真发生了也还没发生完，断言照样绿，安静地失去判别力。

要等就用具名栅栏（都在 `tests/support.py`）：

| 栅栏 | 等到什么 |
|---|---|
| `feed(hub, sid, data)` | 喂进去的字节已并入日志（`_ingest_output` 是原子步，因此推送决策也已发生） |
| `writes_drained(hub, sid)` | 此前提交给写线程的字节已真正落到宿主（写否定断言前的必备步骤） |
| `wait_for(predicate)` | 任意可观察条件；超时会报出**判定点源码位置**与已等待时长 |
| `turn()` | 事件循环把此刻已排队的回调跑完一轮（“已经跑过”而非“过了多久”） |

`await asyncio.sleep(0)` 是唯一允许的 sleep：它是“让出一轮”，不承载任何正确性；
等待真实操作系统事件的 contract 用例（进程启动/控制台附着/进程退出）豁免——
那里没有可观察的内部状态可以做成栅栏。

这条纪律由 `tests/test_sync_discipline.py` 机器化执行：固定睡眠会红；同时它还盯住栅栏赖以成立的
三条不变量（控制面函数不是协程且内部无 await、`EXITED` 分支无 await、`_release()` 在
`host.write()` 返回之后扣减）。完整的机制与证据（含旧套件 vs 新套件在人为拖慢下的对照）
见 `docs/audit.md` §2.9。

## 运行

```bash
# 真实宿主（默认）。pywezterm 由程序自己从 vendor/ 找到，不需要 PYTHONPATH
./.venv/Scripts/python.exe -m terminald --port 8765
#   系统 Python 一样可以：python -m terminald --port 8765

# 只接受回环地址：当前版本没有认证，绑到其它地址会被拒绝启动
```

配置优先级（高 → 低）：命令行参数 > 环境变量 `TERMINALD_*` > `.env` > 代码默认值。
命令行**只覆盖显式给出**的项，因此不会把默认值误当用户意图、压掉环境变量。

常用项：

| 配置 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `cols` / `rows` | `TERMINALD_COLS` / `TERMINALD_ROWS` | 120 / 30 | **会话创建时**的尺寸；运行期由用户经前端的尺寸 chip 变更（`session.resize`）。浏览器可视面积从不参与 |
| `scrollback` | `TERMINALD_SCROLLBACK` | 10000 | 终端模型保留的回溯行数上限 |
| `shell` | `TERMINALD_SHELL` | 平台默认 | 支持带空格的整串，如 `pwsh.exe -NoLogo` |
| `journal_budget_bytes` | `TERMINALD_JOURNAL_BUDGET_BYTES` | 8 MiB | 输出字节日志内存预算，超预算从头裁剪 |
| `outbox_high_bytes` | `TERMINALD_OUTBOX_HIGH_BYTES` | 4 MiB | 每客户端发送队列高水位 |
| `host_impl` | `TERMINALD_HOST_IMPL` | `pywezterm` | `fake` 仅用于测试与联调 |

`scrollback` 必须与前端 xterm.js 的 `scrollback` 选项一致，否则两侧对「历史有多长」的
理解不同。

## 目录

```
src/terminald/
  protocol/    帧编解码、控制消息、转义序列边界扫描、共享测试向量
  core/        日志、订阅对齐决策、出站队列、会话、注册表、端口定义
  runtime/     宿主工厂、pywezterm 适配器、fake 宿主、读/写线程、线程桥
  service/     Hub
  api/         ASGI 装配、REST、WebSocket、来源校验
tests/         分层测试 / 单测 / Hub 行为测试 / 传输层测试 / 输入背压与推送窗口 / 契约测试
```

设计取舍与协议细节见 `docs/architecture.md` 与 `docs/protocol.md`。
