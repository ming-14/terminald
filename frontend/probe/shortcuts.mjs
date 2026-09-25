/**
 * 真实浏览器探针：快捷键扩展的四条行为，在**真 Chromium + 真 WS + 真 ConPTY** 下到底成立不成立。
 *
 * 为什么要先测再做：这四条里有三条的「现状」不是想当然的那样，读 xterm 源码得到的是
 * 反直觉的结论，必须实测确认：
 *
 * - xterm 的 `_keyDown` 在 `triggerDataEvent` 之后会 `cancel(ev, true)`，也就是
 *   `preventDefault + stopPropagation`。所以 Ctrl+C / Ctrl+V 不只是「发一个控制字节」，
 *   它们同时还**掐掉了浏览器自己的复制/粘贴**。于是「Ctrl+V 不粘贴」和
 *   「Ctrl+C 不复制」都是**真的**，不是错觉。
 * - F11 在 xterm 里是 `\x1b[23~`（`case 122`），也就是说按 F11 会往 PTY 里塞一串转义序列。
 * - 右键：xterm 注册了 `contextmenu` 处理器，但它**不** preventDefault，只是把隐藏 textarea
 *   挪到鼠标位置并聚焦（`moveTextAreaUnderMouseCursor`），好让原生菜单的 Copy/Paste 生效。
 *
 * 这个探针按**目标行为**断言，所以在实现之前它应该是红的——那正是「问题存在」的证据；
 * 实现在 `src/ui/shortcuts.ts`；修前的基线（6/12 红）记录在 `docs/audit.md` A12。
 *
 * 自带服务器（端口 8803，真实 pywezterm + cmd.exe），可重复运行。
 * 剪贴板会被写入测试标记，运行前保存、结束后还原。
 *
 * 用法：`node probe/shortcuts.mjs`
 *      `PROBE_HEADED=1 node probe/shortcuts.mjs`  额外看浏览器自己的 F11 全屏
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { chromium } from 'playwright-core';

import { CHROMIUM_ARGS, OUT_DIR, SHELL, chromiumExecutable } from './env.mjs';
import { rowIndexOf, waitForText } from './screen.mjs';
import { createSession, resetSessions, startServer, summarize } from './server.mjs';

const COMSPEC = SHELL;
const HEADED = process.env['PROBE_HEADED'] === '1';
const CHROME = chromiumExecutable();

/** 由 `main` 在服务起来后赋值；其余函数都通过它访问服务。 */
let BASE = '';

const MARKER = 'SHORTCUT-PROBE-LINE-1234567890';
const PASTE = 'PASTED-BY-CTRL-V-0987654321';
/** 选区：从第 0 列选到标记行末尾之后（起点不能落在词中间，否则剪贴板里就是残缺的词）。 */
const SELECT_FROM_COL = 0;
const SELECT_TO_COL = 52;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 客户端发出去的帧（十六进制），以及页面收到的键盘/右键事件（含最终 defaultPrevented）。 */
const INIT_SCRIPT = () => {
  window.__sentFrames = [];
  const original = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    if (typeof data === 'string') {
      window.__sentFrames.push({ kind: 'text', data });
    } else {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer ?? data);
      window.__sentFrames.push({
        kind: 'binary',
        size: bytes.byteLength,
        hex: [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(''),
      });
    }
    return original.call(this, data);
  };

  // 事件在 window 捕获阶段记录（早于 xterm 的处理器），再用一个宏任务回读最终状态：
  // 这样即使 xterm 在目标节点上 stopPropagation，我们也能读到它到底有没有 preventDefault。
  // 产品代码**不该**碰 `navigator.clipboard.writeText`（那条路要权限，实测没有授权时会被拒）。
  // 计数它，就能证明复制真的走的是浏览器自己的 copy 事件。
  window.__writeTextCalls = 0;
  const clipboard = navigator.clipboard;
  if (clipboard) {
    const originalWrite = clipboard.writeText.bind(clipboard);
    clipboard.writeText = (text) => {
      window.__writeTextCalls += 1;
      return originalWrite(text);
    };
  }

  window.__domEvents = [];
  for (const type of ['keydown', 'contextmenu', 'copy', 'paste']) {
    window.addEventListener(
      type,
      (event) => {
        const record = {
          type,
          key: event.key,
          ctrl: event.ctrlKey,
          shift: event.shiftKey,
          button: 'button' in event ? event.button : null,
          preventDefaulted: false,
        };
        window.__domEvents.push(record);
        setTimeout(() => {
          record.preventDefaulted = event.defaultPrevented;
        }, 0);
      },
      true,
    );
  }
};

/** 所有二进制帧的负载（含 5 字节帧头），拼成一个 hex 串便于查找控制字节。 */
const binaryHex = (page, since) =>
  page.evaluate(
    (index) =>
      window.__sentFrames
        .slice(index)
        .filter((frame) => frame.kind === 'binary')
        .map((frame) => frame.hex.slice(10)), // 去掉 5 字节帧头
    since,
  );

const frameCount = (page) => page.evaluate(() => window.__sentFrames.length);
const eventCount = (page) => page.evaluate(() => window.__domEvents.length);
const eventsSince = (page, index, type) =>
  page.evaluate(
    ([from, wanted]) => window.__domEvents.slice(from).filter((event) => event.type === wanted),
    [index, type],
  );

/** 在屏幕上按住鼠标拖一段，制造真实选区（xterm 的选区只有 canvas 渲染，没有 DOM 可查）。 */
async function dragSelect(page, fromCol, toCol, row) {
  const box = await page.locator('.xterm-screen').boundingBox();
  if (box === null) throw new Error('拿不到 .xterm-screen 的位置');
  const debug = await page.evaluate(() => window.__terminald?.debugState?.() ?? null);
  if (debug === null) throw new Error('拿不到 debugState');
  const cellW = box.width / debug.cols;
  const cellH = box.height / debug.rows;
  const y = box.y + cellH * (row + 0.5);
  await page.mouse.move(box.x + cellW * (fromCol + 0.5), y);
  await page.mouse.down();
  await page.mouse.move(box.x + cellW * (toCol + 0.5), y, { steps: 8 });
  await page.mouse.up();
}

const readClipboard = (page) => page.evaluate(() => navigator.clipboard.readText());
const writeClipboard = (page, text) =>
  page.evaluate((value) => navigator.clipboard.writeText(value), text);

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const server = await startServer({ port: 8803 });
  BASE = server.base;
  let browser;
  try {
    await resetSessions(BASE);
    await createSession(BASE, 'shortcuts', [COMSPEC]);
    console.log(`会话已建立（${COMSPEC}）${HEADED ? '，浏览器可视模式' : ''}`);

    browser = await chromium.launch({ executablePath: CHROME, headless: !HEADED, args: CHROMIUM_ARGS });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    // 读权限是探针自己要的（回读剪贴板验证）；写权限只是**搭台**用的（往剪贴板放测试标记）。
    // 它不会让被测行为变成假绿：产品代码根本不调 `writeText`（下面有断言钉住这一点），
    // 剪贴板的真正写入由浏览器自己的 copy 事件完成，而 `clipboardData.setData` 没有权限模型。
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') pageErrors.push(`console.error: ${message.text()}`);
    });
    await page.addInitScript(INIT_SCRIPT);

    const savedClipboard = { text: null };
    try {
      await page.goto(BASE, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.xterm-screen', { timeout: 20_000 });
      await page.locator('.xterm-screen').click();
      await page.waitForFunction(
        () => document.activeElement?.classList.contains('xterm-helper-textarea') === true,
        null,
        { timeout: 5_000 },
      );

      // 先把用户的剪贴板存起来，探针结束还原（它会被我们写测试标记覆盖）
      savedClipboard.text = await readClipboard(page).catch(() => null);

      // 搭台检查：探针自己能不能把测试标记放进剪贴板（它用 writeText，有授权）
      const staged = await writeClipboard(page, 'PROBE-STAGE-CHECK')
        .then(() => readClipboard(page))
        .catch(() => null);
      check('探针能把测试标记放进剪贴板（后面的粘贴检查依赖它）', staged === 'PROBE-STAGE-CHECK');


      // 让屏幕上出现一行已知文本，供选区使用
      await page.keyboard.type(`echo ${MARKER}`);
      await page.keyboard.press('Enter');
      await waitForText(page, MARKER, 10_000);
      const line = await rowIndexOf(page, 'SHORTCUT-PROBE-LINE');
      check('已知文本行已进入屏幕缓冲（选区可定位）', line >= 0, `第 ${line} 行`);

      // ------------------------------------------------------------------ A. F11
      let before = await frameCount(page);
      let events = await eventCount(page);
      await page.keyboard.press('F11');
      await sleep(400);
      const f11Events = await eventsSince(page, events, 'keydown');
      const f11Frames = await binaryHex(page, before);
      check(
        'F11 到达页面（否则这条行为无从谈起）',
        f11Events.some((event) => event.key === 'F11'),
        JSON.stringify(f11Events.map((event) => event.key)),
      );
      check(
        'F11 不把 \\x1b[23~ 塞进 PTY',
        !f11Frames.some((hex) => hex.includes('1b5b32337e')),
        f11Frames.join(',') || '无字节',
      );
      const fullscreen = await page.evaluate(() => ({
        element: document.fullscreenElement !== null,
        inner: window.innerHeight,
        outer: window.outerHeight,
        screen: window.screen.height,
      }));
      // 只认 Fullscreen API：几何量在这里**不可用**——无头模式没有浏览器 chrome（`outer` 恒等于
      // `screen`），可视模式下 DPI 缩放又会让 `outer > screen`（实测 888 > 800），两种情况下
      // 「outer ≥ screen」都恒为真。用它会得到一个永远不会红的断言。
      // 几何量只打印不判定：它只是给出「浏览器自己的 F11 有没有再切一次」的旁证。
      check('F11 后 Fullscreen API 生效', fullscreen.element, JSON.stringify(fullscreen));
      console.log(
        `      （几何旁证：inner=${fullscreen.inner} outer=${fullscreen.outer} screen=${fullscreen.screen}，` +
          `可视模式下 outer 明显小于 screen 就说明浏览器没有自己的全屏）`,
      );

      // ------------------------------------------------------- B. Ctrl+C（无选区）
      before = await frameCount(page);
      await page.keyboard.press('Control+c');
      await sleep(250);
      const ctrlCNoSelection = await binaryHex(page, before);
      check(
        '无选区时 Ctrl+C 仍然发 0x03（SIGINT 不能被扩展吃掉）',
        ctrlCNoSelection.some((hex) => hex.includes('03')),
        ctrlCNoSelection.join(',') || '无字节',
      );

      // ------------------------------------------------------- C. Ctrl+C（有选区）
      // 先放一个哨兵值：复制真的发生过才会被覆盖（否则「剪贴板里正好有」也能骗过断言）。
      await writeClipboard(page, 'CLIPBOARD-SENTINEL-BEFORE-COPY');
      // ⚠ 计数器必须在**哨兵写完之后**清零：探针自己那次 writeText 会落在测量窗口里
      //（第一版就是被这个坑到的：明明产品代码没调，却数出 1 次）。
      await page.evaluate(() => {
        window.__writeTextCalls = 0;
      });
      events = await eventCount(page);
      before = await frameCount(page);
      await dragSelect(page, SELECT_FROM_COL, SELECT_TO_COL, line);
      await sleep(120);
      await page.keyboard.press('Control+c');
      await sleep(400);
      const ctrlCWithSelection = await binaryHex(page, before);
      const copiedText = await readClipboard(page);
      const copyEvents = await eventsSince(page, events, 'copy');
      check(
        '有选区时 Ctrl+C 不再发 0x03',
        !ctrlCWithSelection.some((hex) => hex.includes('03')),
        ctrlCWithSelection.join(',') || '无字节',
      );
      check(
        '有选区时 Ctrl+C 把选区文本放进剪贴板',
        copiedText.includes('SHORTCUT-PROBE'),
        JSON.stringify(copiedText.trim().slice(0, 60)),
      );
      const afterCopy = await page.evaluate(() => window.__terminald?.debugState?.() ?? null);
      check(
        '有选区时 Ctrl+C 之后选区消失（这就是复制成功的反馈）',
        afterCopy?.hasSelection === false,
        `hasSelection=${String(afterCopy?.hasSelection)}`,
      );
      const writeTextCalls = await page.evaluate(() => window.__writeTextCalls);
      check(
        '复制走的是浏览器自己的 copy 事件（产品代码一次 writeText 都没调）',
        writeTextCalls === 0,
        `writeText 调用 ${writeTextCalls} 次`,
      );
      console.log(
        `      （copy 事件 ${copyEvents.length} 次，preventDefault=${copyEvents.map((e) => e.preventDefaulted).join('/') || '—'}）`,
      );

      // ------------------------------------------------------------- D. Ctrl+V
      await writeClipboard(page, PASTE);
      events = await eventCount(page);
      before = await frameCount(page);
      await page.keyboard.press('Control+v');
      await sleep(500);
      const ctrlVFrames = await binaryHex(page, before);
      const pasteEvents = await eventsSince(page, events, 'paste');
      const ctrlVText = ctrlVFrames.join('');
      check(
        'Ctrl+V 不把 0x16（^V）塞进 PTY',
        !ctrlVFrames.some((hex) => hex.includes('16')),
        ctrlVFrames.join(',') || '无字节',
      );
      check(
        'Ctrl+V 把剪贴板文本送进终端',
        ctrlVText.includes(Buffer.from(PASTE, 'utf8').toString('hex')),
        `paste 事件 ${pasteEvents.length} 次；发出 ${ctrlVText.length / 2} 字节`,
      );

      // -------------------------------------------------------------- E. 右键
      events = await eventCount(page);
      await writeClipboard(page, 'CLIPBOARD-SENTINEL-BEFORE-RIGHTCLICK');
      await dragSelect(page, SELECT_FROM_COL, SELECT_TO_COL, line);
      await sleep(120);
      const selectedBeforeClick = await page.evaluate(
        () => window.__terminald?.debugState?.() ?? null,
      );
      check(
        '右键之前选区确实存在（否则这条检查是空的）',
        selectedBeforeClick?.hasSelection === true,
        `hasSelection=${String(selectedBeforeClick?.hasSelection)}`,
      );
      await page.mouse.click(600, 400, { button: 'right' });
      await sleep(300);
      const menuEvents = await eventsSince(page, events, 'contextmenu');
      check(
        '有选区时右键被 preventDefault（原生菜单不弹，复制由我们做）',
        menuEvents.length > 0 && menuEvents.every((event) => event.preventDefaulted),
        JSON.stringify(menuEvents.map((event) => event.preventDefaulted)),
      );
      const rightClickClipboard = await readClipboard(page);
      const afterRightClick = await page.evaluate(() => window.__terminald?.debugState?.() ?? null);
      check(
        '有选区时右键把选区文本放进剪贴板',
        rightClickClipboard.includes('SHORTCUT-PROBE'),
        JSON.stringify(rightClickClipboard.trim().slice(0, 60)),
      );
      check(
        '有选区时右键之后选区消失',
        afterRightClick?.hasSelection === false,
        `hasSelection=${String(afterRightClick?.hasSelection)}`,
      );

      // ------------------------------------------------- 无选区右键：必须放行原生菜单
      await page.locator('.xterm-screen').click();
      await sleep(150);
      events = await eventCount(page);
      await page.mouse.click(600, 400, { button: 'right' });
      await sleep(300);
      const menuNoSelection = await eventsSince(page, events, 'contextmenu');
      check(
        '无选区时右键照常走原生菜单（不被吞掉）',
        menuNoSelection.length > 0 && menuNoSelection.every((event) => !event.preventDefaulted),
        JSON.stringify(menuNoSelection.map((event) => event.preventDefaulted)),
      );

      // ------------------------------------- F. 选区状态（「复制后清选区」的断言点）
      const selectionState = await page.evaluate(
        () => window.__terminald?.debugState?.() ?? null,
      );
      check(
        '诊断快照暴露选区状态（否则「取消选区」无从断言）',
        selectionState !== null && typeof selectionState.hasSelection === 'boolean',
        JSON.stringify(selectionState && { hasSelection: selectionState.hasSelection }),
      );

      check('页面无 JS 错误', pageErrors.length === 0, pageErrors.join(' | '));

      await page.screenshot({ path: join(OUT_DIR, 'shortcuts.png') });
    } finally {
      if (savedClipboard.text !== null && savedClipboard.text !== undefined) {
        await writeClipboard(page, savedClipboard.text).catch(() => {});
      }
      await context.close().catch(() => {});
    }
  } finally {
    await browser?.close().catch(() => {});
    server.stop();
  }

  process.exitCode = summarize(results);
}

await main();
