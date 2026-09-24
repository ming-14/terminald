# vendor/ — 第三方与上游副本

本目录存放**项目自身依赖的第三方产物**与**上游源码副本**。`reference/` 是只读参考资料
（已 gitignore），任何本项目需要长期持有的东西都必须复制到这里。

---

## `wheels/pywezterm-0.1.0-cp38-abi3-win_amd64.whl`

**唯一的运行时依赖**：pywezterm（pyo3/abi3 扩展，内含 `pywezterm.pyd` + Windows 侧载
ConPTY 二进制 `conpty/conpty.dll`、`conpty/OpenConsole.exe`）。

- 来源：`reference/` 下的原始 wheel（只读参考资料，不进版本控制）
- 平台限制：**仅 Windows x86_64 + CPython ≥3.8（abi3）**。Linux/WSL 上需从源码重建（见下）。
- 安装方式：只装进项目本地虚拟环境，不动全局 Python
  ```
  python -m venv .venv
  .venv/Scripts/python -m pip install vendor/wheels/pywezterm-0.1.0-cp38-abi3-win_amd64.whl
  ```

## `pywezterm-upstream/`

pywezterm 上游源码树的**未修改副本**，用于日后重建 wheel（例如需要给绑定层新增
accessor 时）。

**为什么必须留副本**：`reference/pywezterm-main` 内**没有 `.git`**，也没有任何指向
上游仓库的地址，`wezterm/` 下的 crates 是**裁剪过的** vendored 快照。一旦
`reference/` 被清理，这套源码就**不可复现**——它是唯一副本。

- 来源：`reference/pywezterm-main` 的**源码**拷贝（22MB，只含源码）
- **不含构建缓存**：曾经构建 wheel 时留下的 `target/`（1.3 GB，cargo 产物）已删除并加入
  `.gitignore`；重建时会重新生成，与上游源码的可复现性无关。
- 内容：
  - `pywezterm/` —— Python 包外壳（`__init__.py`）
  - `wezterm/pywezterm/` —— **绑定层本体**（可自由修改；这是本项目自己的代码）
  - `wezterm/` 其余目录 —— **vendored 上游 wezterm crates，禁止修改**
  - `tests/` —— 库级测试，即绑定层的**行为契约**，可作为本项目后端的环境验证用例
  - `BUILD.py` / `pyproject.toml` —— maturin 构建脚本
- 上游 `AGENTS.md` 里的两条约束仍然有效，必须遵守：
  1. **禁止修改** `wezterm/` 下的原 wezterm crates（`wezterm-char-props`、`wezterm-dynamic`、
     `wezterm-escape-parser`、`wezterm-input-types`、`wezterm-surface`、`bidi`、`color-types`、
     `filedescriptor`、`pty`、`term`、`termwiz`、`vtparse`、`wezterm-blob-leases`、`wezterm-cell`、
     `Cargo.lock`、`Cargo.toml`、`LICENSE.md`、`target`）。确需修改时把变更记录写回该 `AGENTS.md`。
  2. 该副本是独立项目，**不得提及本项目的名字**（它来自另一个上下文，两边的关系不该写进任何一边）。

### 重建 wheel（目前**不需要**，仅在将来改动绑定时才做）

需额外安装 Rust 工具链（当前环境只有 maturin，**没有 cargo/rustc**）：

```
# 依赖：Rust(rustup) + Visual Studio C++ 桌面工作负载（vcvars64.bat）
python BUILD.py --config Release --wheel-dir target/wheels
```

Cargo 走镜像时用**临时注入**（`CARGO_*` / `GIT_CONFIG_*` 环境变量，或命令行 `--config`），
用完即失；**不得改全局配置**（`~/.cargo/config.toml` 是这台机器上所有项目共用的，
不属于本仓库，改了就等于把构建方式写进了别人的环境）。
