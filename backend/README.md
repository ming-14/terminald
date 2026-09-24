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

pywezterm **不在 PyPI 上**，它是仓库 `vendor/wheels/` 里的本地 wheel，所以**必须先装 wheel、
再装本项目** —— 反过来装必然失败。

```bash
cd backend

# 1. 建虚拟环境
python -m venv .venv

# 2. 先装本地 wheel（Windows / Python 3.11+，abi3）
./.venv/Scripts/python.exe -m pip install ../vendor/wheels/pywezterm-0.1.0-cp38-abi3-win_amd64.whl
#   POSIX 上是 ./.venv/bin/python

# 3. 再装本项目与开发依赖
./.venv/Scripts/python.exe -m pip install -e ".[dev]"
```

> 第 2 步不能省。`pyproject.toml` 的 `dependencies` 里刻意**没有** pywezterm——写进去会让
> `pip install -e .` 因为找不到 PyPI 包而失败。

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

默认套件里 `FakeHost` 实现的 `pump()` 语义（读 → 喂模型 → 回写模型应答 → 返回原始输出）
与真实适配器一致，因此订阅、补流、裁剪、重同步、流控、焦点聚合这些行为都能在没有 PTY
的前提下被确定性测出来。`-m contract` 补的是「真实 PTY + 终端模型接上之后还成立」那一层。

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

## 运行

```bash
# 真实宿主（默认）
./.venv/Scripts/python.exe -m terminald --port 8765

# 只接受回环地址：当前版本没有认证，绑到其它地址会被拒绝启动
```

配置优先级（高 → 低）：命令行参数 > 环境变量 `TERMINALD_*` > `.env` > 代码默认值。
命令行**只覆盖显式给出**的项，因此不会把默认值误当用户意图、压掉环境变量。

常用项：

| 配置 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `cols` / `rows` | `TERMINALD_COLS` / `TERMINALD_ROWS` | 120 / 30 | 终端尺寸由**终端侧**决定，客户端不参与 |
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
