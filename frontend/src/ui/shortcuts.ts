/**
 * 快捷键扩展：把四个**浏览器级**交互从 xterm 的默认行为里接管过来。
 *
 * ## 为什么要接管（读 xterm v6 源码 + 实测确认的现状，见 `docs/audit.md` A12）
 *
 * xterm 的 `_keyDown` 在 `triggerDataEvent` 之后会 `cancel(ev, true)`，也就是
 * `preventDefault() + stopPropagation()`。这带来三个反直觉的后果：
 *
 * | 交互 | 现状 |
 * |---|---|
 * | Ctrl+C（有选区） | 先发 `0x03`（打断前台进程），再把浏览器自己的复制掐掉 → **只打断、不复制** |
 * | Ctrl+V | 发 `0x16`（^V 字面量）并把浏览器粘贴掐掉 → **往 PTY 塞一个 ^V，什么也粘不进来** |
 * | F11 | 走键盘映射表的 `case 122` → 往 PTY 塞 `\x1b[23~`（在 cmd.exe 里就是可见乱码） |
 * | 右键 | xterm **不** preventDefault，只把隐藏 textarea 挪到鼠标位置 → 原生菜单照弹，复制要用户自己点 |
 *
 * ## 接管点：`attachCustomKeyEventHandler`
 *
 * 它在 xterm 处理之前运行，返回 `false` 就能阻止 xterm 发字节，而且**不会** preventDefault。
 * 这正是关键：想让浏览器干的（Ctrl+V 的原生粘贴、Ctrl+C 的原生复制）就什么都不做地放行；
 * 不想让浏览器干的（F11、有选区时的右键菜单）再显式 `preventDefault()`。
 *
 * ## 剪贴板：只走浏览器自己的 copy 事件，不用 Clipboard API
 *
 * 复制**不**调用 `navigator.clipboard.writeText`，而是让浏览器执行它自己的复制命令：
 *
 * - Ctrl+C：不 preventDefault → 浏览器的复制命令照常执行 → 派发 `copy` 事件
 * - 右键：preventDefault 掉原生菜单后，用 `document.execCommand('copy')` 请求同一条命令
 *
 * 两条路都汇到同一个 `copy` 事件，而事件里的 `clipboardData` 由 **xterm 自己的**
 * `copyHandler` 用它的选区填充（`xterm.element` 上就挂着这个监听器）。于是：
 *
 * - **不需要任何权限**：`clipboardData.setData` 没有权限模型（`writeText` 有，实测在
 *   没有授权时会被拒——`docs/audit.md` A12 记了这组对照）
 * - **同步**：没有「await 期间选区被换掉」这类时序问题
 * - **不做两遍**：写剪贴板这件事由 xterm 实现一次，我们只是在旁边决定「什么时候让它发生」
 *
 * 代价写在明面上：`execCommand` 已被标记为废弃（浏览器仍支持，且它是唯一免权限的
 * 「以程序方式触发复制」手段）。换来的是「在任何环境里都成立、且能被自动化证明」。
 *
 * ## 与既有设计的一致性
 *
 * - **失败必须可见**：复制命令被拒、全屏被拒都会回调 `onFailure`，不静默失败
 * - **不进协议**：这四条全是浏览器本地行为，一个字节都不上行，多客户端语义不受影响
 *
 * 纯逻辑 + 依赖注入，零 DOM 依赖，所以能在 node 环境的 vitest 里直接驱动。
 */

/** 只取判定需要的那几个字段，避免依赖 DOM 类型，也让单测能直接构造对象。 */
export interface ShortcutKeyEvent {
  readonly type: string;
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  preventDefault(): void;
}

export interface ShortcutMouseEvent {
  preventDefault(): void;
}

export interface ShortcutCopyEvent {
  /** `copy` 事件里的剪贴板句柄；浏览器拒绝复制时它是 null。 */
  readonly clipboardData: unknown;
}

export type ShortcutAction =
  /** 切换浏览器全屏（吞掉 `\x1b[23~`，并阻止浏览器自己再切一次）。 */
  | 'fullscreen'
  /** 复制 xterm 选区（吞掉 `0x03`，复制本身交给浏览器自己的命令）。 */
  | 'copy'
  /** 放行给浏览器的原生粘贴（只吞掉 `0x16`，不阻止任何东西）。 */
  | 'paste'
  /** 交回 xterm 默认处理。 */
  | 'pass';

/** 主修饰键（Ctrl 或 macOS 的 Cmd）单独按下，不叠加 Shift/Alt。 */
function isPlainChord(event: ShortcutKeyEvent): boolean {
  return (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey;
}

/**
 * 按键 → 动作。纯函数，一张表，没有副作用。
 *
 * `pass` 与 `paste` 的区别不是「管不管」，而是**要不要吞掉 xterm 会发的那个字节**：
 * 两者都不 preventDefault，区别只在返回值。
 */
export function decideKeyAction(event: ShortcutKeyEvent, hasSelection: boolean): ShortcutAction {
  if (event.type !== 'keydown') return 'pass';

  const key = event.key.toLowerCase();
  if (isPlainChord(event)) {
    if (key === 'c') return hasSelection ? 'copy' : 'pass';
    // 无选区时 Ctrl+C 必须原样是 SIGINT：`pass` 让 xterm 继续发 0x03
    if (key === 'v') return 'paste';
  }
  if (event.key === 'F11' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
    return 'fullscreen';
  }
  return 'pass';
}

/** 终端侧只需这两件事（xterm 的 `Terminal` 天然满足）。 */
export interface ShortcutTerminal {
  hasSelection(): boolean;
  clearSelection(): void;
}

export interface FullscreenControl {
  isActive(): boolean;
  enter(): Promise<void>;
  exit(): Promise<void>;
}

export interface ClipboardControl {
  /**
   * 请求浏览器执行一次复制命令（会派发 `copy` 事件，由终端把选区写进 `clipboardData`）。
   * 返回浏览器是否接受了这条命令。
   */
  requestCopy(): boolean;
}

export interface ShortcutsOptions {
  readonly terminal: ShortcutTerminal;
  readonly fullscreen: FullscreenControl;
  readonly clipboard: ClipboardControl;
  /** 失败必须可见。这一层只负责说「失败了、为什么」，不决定显示成什么样。 */
  readonly onFailure: (message: string) => void;
}

export class Shortcuts {
  readonly #options: ShortcutsOptions;

  constructor(options: ShortcutsOptions) {
    this.#options = options;
  }

  /**
   * 接进 `term.attachCustomKeyEventHandler`。
   *
   * 返回 `false` 的语义是「xterm 不要处理这个键」。**不** preventDefault 是刻意的：
   * 复制与粘贴都要靠浏览器的默认动作（原生复制命令、原生粘贴）。
   */
  handleKeyDown(event: ShortcutKeyEvent): boolean {
    switch (decideKeyAction(event, this.#options.terminal.hasSelection())) {
      case 'fullscreen':
        // 阻止浏览器自己的 F11：否则「浏览器切一次 + 我们再 requestFullscreen 一次」
        // 等于两次切换，用户看到的是一点反应都没有。
        event.preventDefault();
        void this.#toggleFullscreen();
        return false;
      case 'copy':
        // 只吞掉 0x03。不 preventDefault → 浏览器的复制命令照常执行 →
        // `copy` 事件 → xterm 把选区写进 clipboardData（免权限、同步）。
        return false;
      case 'paste':
        // 只吞掉 0x16。不 preventDefault → 粘贴事件 → xterm 的 handlePasteEvent
        //（bracketed paste 等转换由它负责）。
        return false;
      case 'pass':
      default:
        return true;
    }
  }

  /**
   * 接进终端的 `copy` 事件（必须挂在**终端容器**上，冒泡顺序才晚于 xterm 自己的监听器）。
   *
   * 复制真的发生了 → 选区的使命完成，清掉它。这一条同时覆盖三条路径：Ctrl+C、
   * 有选区时的右键、以及用户从原生菜单里点的 Copy。
   */
  handleCopy(event: ShortcutCopyEvent): void {
    if (event.clipboardData === null || event.clipboardData === undefined) {
      this.#options.onFailure('复制失败：浏览器未提供剪贴板');
      return;
    }
    this.#options.terminal.clearSelection();
  }

  /**
   * 接进终端容器的 `contextmenu`。
   *
   * 有选区：不弹原生菜单，直接请求一次复制（Windows Terminal 的手感）。
   * 无选区：完全放行——原生菜单里的「粘贴」是有用的入口，不该被我们吞掉。
   */
  handleContextMenu(event: ShortcutMouseEvent): void {
    if (!this.#options.terminal.hasSelection()) return;
    event.preventDefault();
    // 清选区交给随之而来的 `copy` 事件（`handleCopy`）：只有复制**成功**了才清。
    if (!this.#options.clipboard.requestCopy()) {
      this.#options.onFailure('复制失败：浏览器拒绝了复制命令');
    }
  }

  async #toggleFullscreen(): Promise<void> {
    try {
      if (this.#options.fullscreen.isActive()) {
        await this.#options.fullscreen.exit();
      } else {
        await this.#options.fullscreen.enter();
      }
    } catch (error) {
      // 全屏会因缺少用户手势而失败（requestFullscreen 的常见拒绝理由），必须说出来
      const reason = error instanceof Error ? error.message : String(error);
      this.#options.onFailure(`全屏切换失败：${reason}`);
    }
  }
}
