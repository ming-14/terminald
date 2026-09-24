/**
 * 快捷键扩展的单测（node 环境，无 DOM）。
 *
 * 这里钉住的是**决策**与**谁去干**，尤其是三条不能错的边界：
 *
 * 1. 无选区时 Ctrl+C 必须原样交给 xterm（否则 SIGINT 就没了，终端不可用）
 * 2. Ctrl+C / Ctrl+V 都不能被 preventDefault（否则浏览器自己的复制、粘贴被掐掉）
 * 3. 复制失败时不能清选区（清掉 = 把用户选中的内容弄丢了）
 */

import { describe, expect, it, vi } from 'vitest';

import {
  Shortcuts,
  decideKeyAction,
  type ClipboardControl,
  type FullscreenControl,
  type ShortcutKeyEvent,
  type ShortcutMouseEvent,
  type ShortcutTerminal,
} from './shortcuts.js';

/** 造一个键事件。默认是「按下了某个普通键」。 */
function keyEvent(overrides: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent {
  return {
    type: 'keydown',
    key: 'a',
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault: vi.fn(),
    ...overrides,
  };
}

interface Harness {
  readonly shortcuts: Shortcuts;
  readonly failures: string[];
  readonly enter: ReturnType<typeof vi.fn>;
  readonly exit: ReturnType<typeof vi.fn>;
  readonly requestCopy: ReturnType<typeof vi.fn>;
  readonly clearSelection: ReturnType<typeof vi.fn>;
  readonly copied: string[];
  setSelection(hasSelection: boolean): void;
}

function makeHarness(
  options: {
    hasSelection?: boolean;
    copyCommandAccepted?: boolean;
    fullscreenActive?: boolean;
    fullscreenFails?: string;
  } = {},
): Harness {
  let selection = options.hasSelection ?? false;
  const failures: string[] = [];
  const copied: string[] = [];

  const terminal: ShortcutTerminal = {
    hasSelection: () => selection,
    clearSelection: vi.fn(() => {
      selection = false;
      copied.push('cleared');
    }),
  };
  const requestCopy = vi.fn(() => {
    if (options.copyCommandAccepted === false) return false;
    // 真实浏览器会在这里派发 `copy` 事件；测试里直接调用回调，等价
    copied.push('copy-event');
    return true;
  });
  const clipboard: ClipboardControl = { requestCopy };
  const enter = vi.fn(() =>
    options.fullscreenFails === undefined
      ? Promise.resolve()
      : Promise.reject(new Error(options.fullscreenFails)),
  );
  const exit = vi.fn(() => Promise.resolve());
  const fullscreen: FullscreenControl = {
    isActive: () => options.fullscreenActive === true,
    enter,
    exit,
  };

  return {
    shortcuts: new Shortcuts({
      terminal,
      fullscreen,
      clipboard,
      onFailure: (message) => failures.push(message),
    }),
    failures,
    enter,
    exit,
    requestCopy,
    clearSelection: terminal.clearSelection as ReturnType<typeof vi.fn>,
    copied,
    setSelection: (value) => {
      selection = value;
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('decideKeyAction', () => {
  it('无选区时 Ctrl+C 交回 xterm（SIGINT 不能被扩展吃掉）', () => {
    expect(decideKeyAction(keyEvent({ key: 'c', ctrlKey: true }), false)).toBe('pass');
  });

  it('有选区时 Ctrl+C 变成复制', () => {
    expect(decideKeyAction(keyEvent({ key: 'c', ctrlKey: true }), true)).toBe('copy');
  });

  it('Ctrl+V 一律是粘贴（与有没有选区无关）', () => {
    expect(decideKeyAction(keyEvent({ key: 'v', ctrlKey: true }), false)).toBe('paste');
    expect(decideKeyAction(keyEvent({ key: 'v', ctrlKey: true }), true)).toBe('paste');
  });

  it('macOS 的 Cmd+C / Cmd+V 等价', () => {
    expect(decideKeyAction(keyEvent({ key: 'c', metaKey: true }), true)).toBe('copy');
    expect(decideKeyAction(keyEvent({ key: 'v', metaKey: true }), false)).toBe('paste');
  });

  it('带 Shift / Alt 的组合不接管（Ctrl+Shift+C 是 Linux 习惯、AltGr 是输入法）', () => {
    expect(decideKeyAction(keyEvent({ key: 'c', ctrlKey: true, shiftKey: true }), true)).toBe(
      'pass',
    );
    expect(decideKeyAction(keyEvent({ key: 'v', ctrlKey: true, shiftKey: true }), true)).toBe(
      'pass',
    );
    expect(decideKeyAction(keyEvent({ key: 'c', ctrlKey: true, altKey: true }), true)).toBe('pass');
  });

  it('单独的 F11 是全屏；带修饰键的 F11 不是', () => {
    expect(decideKeyAction(keyEvent({ key: 'F11' }), false)).toBe('fullscreen');
    expect(decideKeyAction(keyEvent({ key: 'F11', ctrlKey: true }), false)).toBe('pass');
    expect(decideKeyAction(keyEvent({ key: 'F11', shiftKey: true }), false)).toBe('pass');
  });

  it('keypress / keyup 不参与（只在 keydown 上决策，避免同一组合处理两次）', () => {
    expect(decideKeyAction(keyEvent({ type: 'keypress', key: 'c', ctrlKey: true }), true)).toBe(
      'pass',
    );
    expect(decideKeyAction(keyEvent({ type: 'keyup', key: 'v', ctrlKey: true }), true)).toBe('pass');
  });

  it('大小写不敏感（CapsLock 下 key 是 C）', () => {
    expect(decideKeyAction(keyEvent({ key: 'C', ctrlKey: true }), true)).toBe('copy');
  });

  it('普通键一律放行', () => {
    expect(decideKeyAction(keyEvent({ key: 'Enter' }), false)).toBe('pass');
    expect(decideKeyAction(keyEvent({ key: 'c' }), true)).toBe('pass');
  });
});

describe('Shortcuts 键盘路径', () => {
  it('无选区 Ctrl+C：一个字节都不碰，交回 xterm 发 0x03', () => {
    const harness = makeHarness();
    const event = keyEvent({ key: 'c', ctrlKey: true });

    expect(harness.shortcuts.handleKeyDown(event)).toBe(true);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(harness.requestCopy).not.toHaveBeenCalled();
  });

  it('有选区 Ctrl+C：吞掉 0x03，但**不**阻止浏览器自己的复制命令', () => {
    const harness = makeHarness({ hasSelection: true });
    const event = keyEvent({ key: 'c', ctrlKey: true });

    expect(harness.shortcuts.handleKeyDown(event)).toBe(false);
    // 这条是本设计的核心：preventDefault 会掐掉浏览器的 copy，
    // 而剪贴板正是由那次 copy（xterm 的 copyHandler）写的。
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(harness.requestCopy).not.toHaveBeenCalled();
  });

  it('Ctrl+V：吞掉 0x16 但**不**阻止浏览器粘贴', () => {
    const harness = makeHarness();
    const event = keyEvent({ key: 'v', ctrlKey: true });

    expect(harness.shortcuts.handleKeyDown(event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('F11：阻止浏览器自己再切一次，并且真的切换全屏', async () => {
    const harness = makeHarness();
    const event = keyEvent({ key: 'F11' });

    expect(harness.shortcuts.handleKeyDown(event)).toBe(false);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    await flush();

    expect(harness.enter).toHaveBeenCalledTimes(1);
    expect(harness.exit).not.toHaveBeenCalled();
  });

  it('F11：已经在全屏时就退出全屏', async () => {
    const harness = makeHarness({ fullscreenActive: true });
    harness.shortcuts.handleKeyDown(keyEvent({ key: 'F11' }));
    await flush();

    expect(harness.exit).toHaveBeenCalledTimes(1);
    expect(harness.enter).not.toHaveBeenCalled();
  });

  it('F11：全屏被拒绝时报可见错误（常见的「没有用户手势」）', async () => {
    const harness = makeHarness({ fullscreenFails: 'Permissions check failed' });
    harness.shortcuts.handleKeyDown(keyEvent({ key: 'F11' }));
    await flush();

    expect(harness.failures).toEqual(['全屏切换失败：Permissions check failed']);
  });

  it('普通键与 keyup 一律交回 xterm', () => {
    const harness = makeHarness({ hasSelection: true });
    expect(harness.shortcuts.handleKeyDown(keyEvent({ key: 'Enter' }))).toBe(true);
    expect(
      harness.shortcuts.handleKeyDown(keyEvent({ type: 'keyup', key: 'c', ctrlKey: true })),
    ).toBe(true);
  });
});

describe('Shortcuts 复制事件路径', () => {
  it('复制真的发生 → 清掉选区（这就是成功的反馈）', () => {
    const harness = makeHarness({ hasSelection: true });
    harness.shortcuts.handleCopy({ clipboardData: {} });

    expect(harness.clearSelection).toHaveBeenCalledTimes(1);
    expect(harness.failures).toEqual([]);
  });

  it('浏览器没给剪贴板句柄 → 报可见错误，且**不清**选区', () => {
    const harness = makeHarness({ hasSelection: true });
    harness.shortcuts.handleCopy({ clipboardData: null });

    expect(harness.failures).toEqual(['复制失败：浏览器未提供剪贴板']);
    expect(harness.clearSelection).not.toHaveBeenCalled();
  });

  it('复制之后分区被重新选上，也不影响这条路径（无异步窗口）', () => {
    const harness = makeHarness({ hasSelection: true });
    harness.setSelection(true);
    harness.shortcuts.handleCopy({ clipboardData: {} });

    expect(harness.clearSelection).toHaveBeenCalledTimes(1);
  });
});

describe('Shortcuts 右键路径', () => {
  it('无选区：完全放行（原生菜单里的「粘贴」是有用的入口）', () => {
    const harness = makeHarness();
    const event: ShortcutMouseEvent = { preventDefault: vi.fn() };

    harness.shortcuts.handleContextMenu(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(harness.requestCopy).not.toHaveBeenCalled();
  });

  it('有选区：不弹原生菜单，请求一次复制', () => {
    const harness = makeHarness({ hasSelection: true });
    const event: ShortcutMouseEvent = { preventDefault: vi.fn() };

    harness.shortcuts.handleContextMenu(event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(harness.requestCopy).toHaveBeenCalledTimes(1);
    expect(harness.failures).toEqual([]);
  });

  it('有选区但浏览器拒绝了复制命令：报可见错误', () => {
    const harness = makeHarness({ hasSelection: true, copyCommandAccepted: false });
    harness.shortcuts.handleContextMenu({ preventDefault: vi.fn() });

    expect(harness.failures).toEqual(['复制失败：浏览器拒绝了复制命令']);
  });
});
