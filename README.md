# 网页终端

浏览器里的持久会话终端。后端用 **pywezterm**（wezterm 的 PTY 引擎 + 终端模型库化为 Python
扩展）维护会话，前端用 xterm.js v6 + TypeScript 渲染；多会话、多客户端、刷新与切换都不丢内容。

不经过任何中转服务：后端只监听回环地址，前端由后端同源托管。

## 现状

| 部分 | 状态 |
|---|---|
| `backend/` | 已完成。`ruff` + `ruff format` + `mypy --strict` + `pytest` 四道全绿（261 通过 + 32 个真实宿主契约测试） |
| `frontend/` | 已完成。`tsc --strict` + 117 个 vitest + 八个真实浏览器探针（共 107 项断言）全通过 |
| `docs/` | `architecture.md`、`protocol.md`、`design/frontend-draft.html`、`audit.md`（四轮审计报告：产品缺陷 A1–A13、验证层缺陷 V1–V6、交付前清理 C1–C9、测试同步纪律 D1–D7）已就位 |
| `vendor/` | 本地 wheel 与上游源码副本已就位 |

后端已验证到「真实 ConPTY 子进程 → 输出字节 → WS 客户端 → 浏览器渲染」的完整往返；
前端另有真 Chromium 探针覆盖挂载、布局、会话切换、键盘输入往返、刷新续传。

## 仓库结构

```
backend/    后端（FastAPI + WebSocket + pywezterm），见 backend/README.md
frontend/   前端（xterm.js v6 + TS + Vite），见 frontend/README.md
docs/       架构与协议说明、前端设计稿
vendor/     pywezterm 的本地 wheel（PyPI 上没有）与上游源码副本
reference/  只读参考资料（xterm.js 文档、pywezterm 源码与库测试）——不进版本控制
.research/  只读调研材料（tmux / ttyd 源码）——不进版本控制
```

## 快速开始

前置：Python 3.11+、Node.js 20+。

```bash
# 后端
cd backend
python -m venv .venv
./.venv/Scripts/python.exe -m pip install ../vendor/wheels/pywezterm-0.1.0-cp38-abi3-win_amd64.whl
./.venv/Scripts/python.exe -m pip install -e ".[dev]"

# 前端（构建产物直接写进后端包内）
cd ../frontend
npm install
npm run build

# 跑起来
cd ../backend
./.venv/Scripts/python.exe -m terminald --port 8765
```

打开 <http://127.0.0.1:8765/>，点侧栏标题栏右侧的 `+` 新建一个会话。接口文档在 `/api/docs`。

```bash
# 后端测试
cd backend
./.venv/Scripts/python.exe -m pytest              # 默认套件（fake 宿主）
./.venv/Scripts/python.exe -m pytest -m contract  # 真实 PTY 契约测试

# 前端测试 + 真实浏览器探针（探针自带服务器，不需要你先起后端）
cd ../frontend
npm test
npm run probe:all
```

POSIX 上把 `./.venv/Scripts/python.exe` 换成 `./.venv/bin/python`。细节见
[`backend/README.md`](backend/README.md) 与 [`frontend/README.md`](frontend/README.md)。

## 核心设计

三条决定其余一切的选择：

1. **内容真源是原始输出字节流，不是终端的渲染结果。** 客户端按 offset 订阅，新客户端整段重放
   即与「从头就在的客户端」逐字节相同——冷状态（备用屏、字符集、tab stops、键盘栈）随字节流
   被重新执行而一并还原，不需要逐个状态保存与恢复。
2. **`cols`/`rows` 由终端侧决定，浏览器可视面积不参与。** 前端反过来根据可用像素求字号。
   于是多客户端不存在尺寸分歧，「逐格一致」是构造出来的而不是对齐出来的。
3. **慢客户端只会被暂停，绝不会丢字节。** 服务端按每客户端游标补齐日志；只有游标落到已裁剪
   区间时，才发显式 `behind` 要求重同步。那之外唯一的路径就是模型快照重建，也是整套机制里
   唯一有保真损耗的路径。

细节（含已知边界与未解问题）见 [`docs/architecture.md`](docs/architecture.md) 与
[`docs/protocol.md`](docs/protocol.md)。

## 约定

- 依赖方向 `api → service → runtime → core → protocol` 单向，由 AST 扫描测试强制
- 只有 `runtime` 能碰 `pywezterm`，只有 `api` 能碰 web 框架
- 同一套能力不做两遍：输入编码归前端，会话与同步语义归后端
- 禁止降级、兼容、缓解方案；有取舍就摆出来，不偷偷降规格
