/**
 * 探针共用的路径与外部工具定位。
 *
 * 为什么要有这一层：探针原先各自写死了 `C:/Users/<用户名>/...` 与 Playwright 的
 * 具体修订目录（`chromium-1234`）。前者把本机用户名叫进了仓库、也让探针**换台机器就跑不动**；
 * 后者在 Playwright 升级后直接失效。两者都不是断言的一部分，却会让整套端到端验证在
 * 别人的机器上静默失效。
 *
 * 因此这里一律从**本文件位置**推导仓库布局，只允许用环境变量覆盖：
 *
 * - `PROBE_HOME`：仓库根目录（默认由本文件位置推两级）
 * - `PYTHON`：用来当「受控子进程 / 起服务」的解释器（默认后端虚拟环境里的那个）
 * - `PROBE_CHROME`：Chromium 可执行文件（默认在 `ms-playwright` 下找最新的那份）
 * - `PROBE_OUT`：截图等落盘产物的目录（默认 `frontend/.probe`，已在 .gitignore 里）
 *
 * 定位不到 Chromium 时**直接抛错并说清怎么修**，而不是静默回退到别的浏览器——
 * 探针的全部价值就在于「它真的跑过」，跑不起来的探针必须吵。
 */

import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROBE_DIR = dirname(fileURLToPath(import.meta.url));

/** 仓库根目录。 */
export const REPO_ROOT = resolve(process.env['PROBE_HOME'] ?? join(PROBE_DIR, '..', '..'));
/** 前端目录（探针驱动的是它构建出来、再由后端托管的产物）。 */
export const FRONTEND_DIR = join(REPO_ROOT, 'frontend');
/** 后端目录（`python -m terminald` 的落点）。 */
export const BACKEND_DIR = join(REPO_ROOT, 'backend');

const IS_WINDOWS = process.platform === 'win32';

/** 虚拟环境的解释器（POSIX 与 Windows 的布局不同，探针要能跨平台跑）。 */
export const PYTHON =
  process.env['PYTHON'] ??
  join(BACKEND_DIR, '.venv', IS_WINDOWS ? 'Scripts' : 'bin', IS_WINDOWS ? 'python.exe' : 'python');

/**
 * 探针自己要拿来当会话入口的 shell。
 *
 * 这里**必须**给一个确定的值，不能靠后端猜：探针要以它构造 argv（`cmd /c ...` 与
 * `sh -c ...` 的参数形状不同），让后端用自己的平台默认值就等于放弃跨平台。
 */
export const SHELL =
  process.env['COMSPEC'] ?? (IS_WINDOWS ? 'cmd.exe' : (process.env['SHELL'] ?? '/bin/sh'));

/**
 * 启动 Chromium 的公共参数。
 *
 * `--enable-unsafe-swiftshader`：无头 Chromium 默认没有 GPU，`getContext('webgl2')` 直接返回
 * null。而前端的渲染器就搭在 WebGL2 上（见 `src/ui/app.ts`），拿不到上下文时它会**静默退回**
 * DOM 渲染器——探针照旧跑得起来，但测的是另一条渲染路径，于是方块/盒线那几条断言会假绿。
 * 所以这条参数不是优化，是让探针真的测到它想测的那条路（探针默认只收 `console.error`，
 * 这条回退只发 `console.warn`，不会被自动拦住——见 `probe/glyphs.mjs` 的对照组）。
 *
 * 只提供值，不替各探针启动浏览器：启动参数留在各自的 `chromium.launch()` 里看得见。
 */
export const CHROMIUM_ARGS = ['--enable-unsafe-swiftshader'];

/** 用 `SHELL` 跑一条一次性命令的完整 argv（Windows 与 POSIX 的开关不同）。 */
export function shellCommand(command) {
  return [SHELL, IS_WINDOWS ? '/c' : '-c', command];
}

/** 截图等产物的落盘目录。放在 frontend 下而不是 cwd，才能被 .gitignore 稳稳兜住。 */
export const OUT_DIR = process.env['PROBE_OUT'] ?? join(FRONTEND_DIR, '.probe');

/**
 * Playwright 的 Chromium 可执行文件。
 *
 * 目录名带修订号（`chromium-1234`），写死会在升级后失效，所以扫一遍取**存在的**那个。
 * 同时兼容 Windows（`chrome-win64`）与 POSIX（`chrome-linux`）两种布局。
 */
export function chromiumExecutable() {
  const override = process.env['PROBE_CHROME'];
  if (override) return override;

  const root = join(
    process.env['LOCALAPPDATA'] ?? join(process.env['HOME'] ?? '', '.cache'),
    'ms-playwright',
  );
  const relative = IS_WINDOWS
    ? join('chrome-win64', 'chrome.exe')
    : join('chrome-linux', 'chrome');

  const candidates = existsSync(root)
    ? readdirSync(root)
        .filter((name) => name.startsWith('chromium-'))
        .sort((a, b) => Number(b.split('-')[1] ?? 0) - Number(a.split('-')[1] ?? 0))
        .map((name) => join(root, name, relative))
        .filter(existsSync)
    : [];

  const found = candidates[0];
  if (found === undefined) {
    throw new Error(
      `找不到 Playwright 的 Chromium（在 ${root} 下）。` +
        '装一个（npx playwright install chromium），或用 PROBE_CHROME 指定可执行文件。',
    );
  }
  return found;
}
