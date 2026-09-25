# vendor/ — 长期依赖

本目录只放**本项目长期持有、运行时真正加载的东西**。

## `pywezterm/` —— 唯一的运行时依赖，**不安装**

pywezterm（pyo3/abi3 扩展）的**包目录**，直接放在这里供导入：

```
pywezterm.pyd      绑定层（Pty / Terminal / Mux …）
conpty.dll         ConPTY 侧载 DLL（Windows x64）
OpenConsole.exe    ConPTY 侧载宿主（与 conpty.dll 必须同目录）
__init__.py
```

- **不 `pip install`**：`backend/.venv` 里没有它。运行与测试时把本目录的上一层（`vendor/`）
  加进 `PYTHONPATH` 即可 —— 手动起服务见 `backend/README.md` 的「运行」一节，pytest 由
  `backend/pyproject.toml` 的 `pythonpath` 自动带上，浏览器探针由 `probe/server.mjs` 注入。
- 目录名必须是 `pywezterm`（就是导入名），且 **`conpty.dll` / `OpenConsole.exe` 必须与
  `pywezterm.pyd` 同目录**：加载器按 `<包目录>/conpty.dll` 找侧载 DLL，找不到就静默回落
  系统 conhost，那样"wezterm 自带的 OpenConsole 宿主"就等于没启用。
- 平台限制：**仅 Windows x86_64 + CPython ≥3.8（abi3）**。Linux/WSL 需从源码重建。

## 其它东西在哪

| 东西 | 位置 | 说明 |
|---|---|---|
| 上层 pywezterm 仓库 | `reference/pywezterm/` | **带 `.git` 的克隆**（origin → `ming-14/pywezterm`），改动直接在里面 commit / push |
| 上游源码快照 | `reference/pywezterm-upstream/` | 早先的无 `.git` 副本，留作存档 |
| 最早拿到的只读源码 | `reference/pywezterm-main/` | 最原始那一份（同样没有 `.git`，且 `wezterm/` 是裁剪过的） |
| 构建出的 wheel | `reference/wheels/` | 存档；**不再纳入版本控制**（运行依赖现在是上面的包目录） |

`reference/` 在根 `.gitignore` 里（只读参考资料，不进版本控制）。

## 新克隆的仓库里怎么拿到这份依赖

`vendor/pywezterm/`（以及 `reference/`）都在 gitignore 里 ⇒ **新克隆下来是空的**，两步补上：

```bash
cd <仓库根>
git clone https://github.com/ming-14/pywezterm reference/pywezterm   # 上层仓库（带 .git）
cd reference/pywezterm && python BUILD.py                            # 需 Rust + VS C++ 工作负载
# 产物 target/wheels/pywezterm-*.whl 解包后，里面的 pywezterm/ 就是 vendor/pywezterm/ 的内容
```

上游 `reference/pywezterm-upstream/AGENTS.md` 里的两条约束仍然有效，必须遵守：

1. **禁止修改** `wezterm/` 下的原 wezterm crates（`wezterm-char-props`、`wezterm-dynamic`、
   `wezterm-escape-parser`、`wezterm-input-types`、`wezterm-surface`、`bidi`、`color-types`、
   `filedescriptor`、`pty`、`term`、`termwiz`、`vtparse`、`wezterm-blob-leases`、`wezterm-cell`、
   `Cargo.lock`、`Cargo.toml`、`LICENSE.md`、`target`）。确需修改时把变更记录写回该 `AGENTS.md`。
   `wezterm/pywezterm/` 是绑定层本体，可自由修改。
2. 该副本是独立项目，**不得提及本项目的名字**。

## 重建 wheel（仅在改动绑定时才做）

在 `reference/pywezterm/` 里构建，然后把产出的包目录覆盖到 `vendor/pywezterm/`：

```bash
cd reference/pywezterm
python BUILD.py --wheel-dir target/wheels      # 需 Rust(rustup) + VS C++ 工作负载
# 产物 target/wheels/pywezterm-*.whl 解包后的 pywezterm/ 就是 vendor/pywezterm/ 的内容
```

Cargo 走镜像时用**临时注入**（`CARGO_*` / `GIT_CONFIG_*` 环境变量，或命令行 `--config`），
用完即失；**不得改全局配置**（`~/.cargo/config.toml` 是这台机器上所有项目共用的，
不属于本仓库，改了就等于把构建方式写进了别人的环境）。
