/**
 * 真实浏览器探针：刷新之后，**位置**还在不在。
 *
 * 「刷新不丢」有两层，前面几个探针只钉住了第一层（内容不丢：服务端日志整段重放）。
 * 这个探针补第二层——刷新前你在看哪个会话、视口停在哪一行：
 *
 * - `sessionStorage` 里记的会话 id 真的被用上了吗（不然 F5 会把你扔到列表第一个会话）？
 * - 滚动位置恢复得**一样**吗（不是「有个位置就行」）？
 * - 停在底部时刷新，会不会被硬拽到中间？
 * - 备用屏幕（`?1049h`）里滚动，会不会写下一个毫无意义的位置？
 * - 顺手复核两条与「切会话不混屏」绑在一起的既有行为：切会话不留上一个会话的
 *   scrollback，以及**新建会话**这条路（它不经过侧栏点击）也要先清屏。
 *
 * 自带服务器（端口 8802，真实 pywezterm），可重复运行：开始前清掉已有会话。
 *
 * 用法：`node probe/remember.mjs`
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { chromium } from 'playwright-core';

import { CHROMIUM_ARGS, OUT_DIR, PYTHON, chromiumExecutable } from './env.mjs';
import { screenLines, waitForText } from './screen.mjs';
import { createSession, resetSessions, startServer, summarize } from './server.mjs';

/** 由 `main` 在服务起来后赋值；其余函数都通过它访问服务。 */
let BASE = '';
const CHROME = chromiumExecutable();

const LINES = 400;
const ACTIVE_SESSION_KEY = 'terminald.active-session';
const SCROLL_KEY_PREFIX = 'terminald.scroll.';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 打印 `${tag}-0001..N` 后挂着不退出的子进程（scrollback 的内容来源）。 */
function lineEcho(tag) {
  return [
    PYTHON,
    '-c',
    `import sys,time\nfor i in range(1,${LINES + 1}):\n    sys.stdout.write('${tag}-%04d\\r\\n' % i)\n`
      + 'sys.stdout.flush()\ntime.sleep(600)\n',
  ];
}

/** 进入备用屏幕的全屏程序：没有 scrollback 可言。 */
function altScreen() {
  return [
    PYTHON,
    '-c',
    "import sys,time\nsys.stdout.write('\\x1b[?1049h')\n"
      + "sys.stdout.write('ALT-SCREEN-UP\\r\\n')\nsys.stdout.flush()\ntime.sleep(600)\n",
  ];
}

const rowsNow = (page) => screenLines(page);
const debugState = (page) => page.evaluate(() => window.__terminald.debugState());
const storage = (page) =>
  page.evaluate(() => ({ ...window.sessionStorage }));

/** 点侧栏里名字为 name 的会话卡片。 */
async function selectSession(page, name) {
  await page.locator('.session', { hasText: name }).first().click({ timeout: 20_000 });
}

// 屏幕文本的读取与等待统一在 `screen.mjs`：WebGL 渲染器下 DOM 里已经没有文本可取

/** 在终端上滚轮滚动（负值 = 往上翻历史）。 */
async function wheel(page, delta, times = 1) {
  const box = await page.locator('.xterm-screen').boundingBox();
  if (box === null) throw new Error('拿不到 .xterm-screen 的位置');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < times; i += 1) {
    await page.mouse.wheel(0, delta);
    await page.waitForTimeout(25);
  }
  await page.waitForTimeout(150);
}

/** 一路往上滚到顶，返回首个可见行（探针页用于比对历史）。 */
async function scrollToTop(page) {
  let previous = '';
  let stable = 0;
  for (let events = 0; events < 200 && stable < 4; events += 1) {
    await wheel(page, -200);
    const rows = await rowsNow(page);
    const key = rows[0] ?? '';
    if (key === previous) stable += 1;
    else stable = 0;
    previous = key;
  }
  return await rowsNow(page);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const server = await startServer({ port: 8802 });
  BASE = server.base;
  let browser = null;

  try {
    await resetSessions(BASE);

    const a = await createSession(BASE, 'rm-a', lineEcho('SA'));
    const b = await createSession(BASE, 'rm-b', lineEcho('SB'));
    const c = await createSession(BASE, 'rm-c', lineEcho('SC'));
    console.log(`会话 a=${a.id} b=${b.id} c=${c.id}`);
    await sleep(1500);

    browser = await chromium.launch({ executablePath: CHROME, headless: true, args: CHROMIUM_ARGS });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') pageErrors.push(`console.error: ${message.text()}`);
    });

    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.xterm-screen', { timeout: 20_000 });
    await page.waitForFunction(() => document.querySelectorAll('.session').length >= 3, null, {
      timeout: 20_000,
    });

    // ---- 1. 没有记忆时：落在列表第一个会话（这是既有的、正确的默认行为）
    await waitForText(page, `SA-${String(LINES).padStart(4, '0')}`);
    const first = await debugState(page);
    check('首次进入落在列表第一个会话', first.session === a.id, String(first.session));

    // ---- 2. 切到第三个会话 → 记忆里立刻是它
    await selectSession(page, 'rm-c');
    await waitForText(page, `SC-${String(LINES).padStart(4, '0')}`);
    const storedAfterSwitch = await storage(page);
    check(
      '切换会话后，本标签页记住了它',
      storedAfterSwitch[ACTIVE_SESSION_KEY] === c.id,
      `${String(storedAfterSwitch[ACTIVE_SESSION_KEY])} vs ${c.id}`,
    );

    // ---- 3. 用户往上翻一段历史 → 位置被记下来（停在底部时不记）
    check(
      '停在底部时**不**写滚动位置（跟随输出无需记忆）',
      storedAfterSwitch[`${SCROLL_KEY_PREFIX}${c.id}`] === undefined,
      String(storedAfterSwitch[`${SCROLL_KEY_PREFIX}${c.id}`]),
    );
    await page.click('.xterm-screen');
    await wheel(page, -200, 12);
    const before = await debugState(page);
    const rowsBefore = await rowsNow(page);
    const storedScrolled = await storage(page);
    check(
      '往上翻之后视口确实不在底部了（否则这条检查是空的）',
      before.viewportY < before.baseY,
      `viewportY=${before.viewportY} baseY=${before.baseY}`,
    );
    check(
      '滚动位置被记进了本标签页',
      storedScrolled[`${SCROLL_KEY_PREFIX}${c.id}`] === String(before.viewportY),
      `${String(storedScrolled[`${SCROLL_KEY_PREFIX}${c.id}`])} vs ${before.viewportY}`,
    );

    // ---- 4. 刷新：会话与滚动位置都要回来
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.xterm-screen', { timeout: 20_000 });
    const restored = await (async () => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const state = await debugState(page);
        if (state.session === c.id && state.baseY > 0) return state;
        await sleep(200);
      }
      return await debugState(page);
    })();
    check('刷新后仍在原来那个会话', restored.session === c.id, String(restored.session));
    check(
      '刷新后视口回到刷新前那一行',
      restored.viewportY === before.viewportY,
      `刷新前 ${before.viewportY} → 刷新后 ${restored.viewportY}（baseY=${restored.baseY}）`,
    );
    const rowsAfter = await rowsNow(page);
    check(
      '刷新后屏幕上那一屏逐行一致',
      rowsAfter.length === rowsBefore.length && rowsAfter.every((row, i) => row === rowsBefore[i]),
      `首行 ${JSON.stringify(rowsBefore[0])} → ${JSON.stringify(rowsAfter[0])}`,
    );
    await page.screenshot({ path: join(OUT_DIR, 'remember-restored.png') });

    // ---- 5. 滚回底部再刷新：应留在底部，而不是被拽回中间
    await wheel(page, 200, 60);
    const atBottom = await debugState(page);
    check(
      '滚轮下滑回到最底',
      atBottom.viewportY === atBottom.baseY,
      `viewportY=${atBottom.viewportY} baseY=${atBottom.baseY}`,
    );
    const storedAtBottom = await storage(page);
    check(
      '回到最底后，记忆被清掉（下次刷新不该再回到中间）',
      storedAtBottom[`${SCROLL_KEY_PREFIX}${c.id}`] === undefined,
      String(storedAtBottom[`${SCROLL_KEY_PREFIX}${c.id}`]),
    );
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.xterm-screen', { timeout: 20_000 });
    await waitForText(page, `SC-${String(LINES).padStart(4, '0')}`);
    const afterBottomReload = await debugState(page);
    check(
      '停在底部时刷新仍停在底部',
      afterBottomReload.viewportY === afterBottomReload.baseY,
      `viewportY=${afterBottomReload.viewportY} baseY=${afterBottomReload.baseY}`,
    );

    // ---- 6. 切会话不混屏：新会话的历史里不能出现上一个会话的内容
    await selectSession(page, 'rm-b');
    await waitForText(page, `SB-${String(LINES).padStart(4, '0')}`);
    const topRows = await scrollToTop(page);
    check(
      '切会话后能滚回**本会话**最早一行',
      (topRows[0] ?? '').startsWith('SB-0001'),
      JSON.stringify(topRows[0]),
    );
    check(
      '切会话后历史里没有上一个会话的残留',
      !topRows.some((row) => row.includes('SA-')),
      topRows.find((row) => row.includes('SA-')) ?? '',
    );

    // ---- 7. 新建会话这条路不经过侧栏点击，也必须先清屏
    await wheel(page, 200, 60);
    await page.locator('.btn-new').click();
    const deadline = Date.now() + 20_000;
    let created = await debugState(page);
    while (Date.now() < deadline && created.session === b.id) {
      await sleep(200);
      created = await debugState(page);
    }
    await sleep(1500); // 让新 shell 打出提示符
    const rowsAfterCreate = await rowsNow(page);
    check('新建会话后已切到新会话', created.session !== b.id, String(created.session));
    check(
      '新建会话后屏幕已清空（没有上一个会话的内容）',
      !rowsAfterCreate.some((row) => row.startsWith('SB-')),
      rowsAfterCreate.find((row) => row.startsWith('SB-')) ?? rowsAfterCreate.join(' | ').slice(0, 80),
    );
    // 新会话必须真的可用，不能只是“看起来清了”
    await page.click('.xterm-screen');
    await page.keyboard.insertText('echo REMEMBER_NEW_OK\r');
    await waitForText(page, 'REMEMBER_NEW_OK', 30_000);
    check('新建的会话可交互', true);

    // ---- 8. 备用屏幕：侧载宿主会转发 `?1049h`，所以**现在可达**
    //
    // 前端的滚动位置记忆对备用屏是关掉的（备用屏没有 scrollback，行号一退出就失效）。
    // 这条曾经测不了：系统 conhost 把子进程的 `?1049h` 吃掉，终端永远进不了备用缓冲区，
    // 于是「备用屏里不写记忆」的断言**恒真**。2026-09-25 侧载 OpenConsole 生效后这个序列会
    // 到达客户端（逐条实测见 `probe/conpty-modes.mjs`），所以这里换成钉住前提本身：
    // 客户端确实进了备用缓冲区 —— 前提不成立时，后面那条保护就无从谈起。
    const alt = await createSession(BASE, 'rm-alt', altScreen());
    await selectSession(page, 'rm-alt');
    await waitForText(page, 'ALT-SCREEN-UP');
    const altState = await debugState(page);
    check(
      '请求备用屏的会话让客户端进了备用缓冲区（宿主转发了 ?1049h，见 probe/conpty-modes.mjs）',
      altState.altScreen,
      `altScreen=${String(altState.altScreen)} session=${String(altState.session)}`,
    );
    check(
      '请求备用屏的会话仍能正常订阅与渲染',
      altState.session === alt.id && altState.connection === 'ready',
      JSON.stringify(altState),
    );

    check('页面无 JS 错误', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  } finally {
    if (browser !== null) await browser.close();
    server.stop();
  }

  process.exitCode = summarize(results);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
