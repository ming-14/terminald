/**
 * 真实浏览器探针：改尺寸（`session.resize` / `resized`）端到端。
 *
 * 单测（`backend/tests/test_resize.py`）证明的是"服务端逻辑自洽"；契约测试
 * （`test_contract_pywezterm.py`）证明"子进程真的看到新尺寸"。这个探针补最后一层：
 * **在真浏览器里，用户点一下之后，画面真的按新网格重排了**。
 *
 * 钉住的四件事：
 *
 * 1. **入口**：顶栏那个尺寸 chip 显示的是服务端的值；点它开弹层、选档位或手输、
 *    非法输入不发请求；已退出的会话不可点。
 * 2. **生效**：服务端、客户端持有的网格、以及 xterm **实际生效**的网格三者一致；
 *    渲染出来的网格像素真的按新列数重算了（不只是换了个数字）。
 * 3. **多客户端**：一个"活过整次改尺寸"的客户端与一个"改完之后才订阅、整段重放"的
 *    客户端，屏幕必须逐行一致——这正是 `docs/resize-plan.md` §3.2 那条 reflow 等价性
 *    在真实 Chrome + 真实 xterm 上的验证。
 * 4. **刷新后位置**：改尺寸会 reflow 缓冲区（行号会变），刷新之后视口还要落在**同一行内容**上。
 *    这一条是 `probe/remember.mjs` 没覆盖的缺口（那里没有改尺寸）。
 *
 * 自带服务器（端口 8809，真实 pywezterm），可重复运行。
 *
 * 用法：`node probe/resize.mjs`
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { chromium } from 'playwright-core';

import { CHROMIUM_ARGS, OUT_DIR, PYTHON, chromiumExecutable } from './env.mjs';
import { screenLines, waitForText } from './screen.mjs';
import { createSession, listSessions, resetSessions, startServer, summarize } from './server.mjs';

/** 由 `main` 在服务起来后赋值；其余函数都通过它访问服务。 */
let BASE = '';
const CHROME = chromiumExecutable();

const LINES = 200;
const ECHO = 'RZ';
/** 默认尺寸来自 config（会话创建时的初值），探针按它对照。 */
const INITIAL = { cols: 120, rows: 30 };

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 打印 `${ECHO}-0001..N` 后挂着不退出的子进程。
 *
 * 行宽 100 列是**刻意的**：比 80 宽、比 120 窄。于是「120 → 80」这次改尺寸会让每一行
 * 折成两行、`baseY` 跟着变——那正是第 4 组要测的"reflow 之后行号变了，刷新还回不回得去"。
 * 短行的话行号根本不变，那条断言会变成近乎恒真。
 */
function lineEcho() {
  return [
    PYTHON,
    '-c',
    `import sys,time\nfor i in range(1,${LINES + 1}):\n`
      + `    sys.stdout.write('${ECHO}-%04d-' % i + 'x' * 90 + '\\r\\n')\n`
      + 'sys.stdout.flush()\ntime.sleep(600)\n',
  ];
}

const debugState = (page) => page.evaluate(() => window.__terminald.debugState());
const chipText = (page) => page.locator('.size-chip').innerText();
const chipDisabled = (page) => page.locator('.size-chip').isDisabled();

async function sessionByName(name) {
  const listed = await listSessions(BASE);
  return listed.find((item) => item.name === name) ?? null;
}

/** 等到服务端报出期望尺寸（resize 走 WS，生效是异步的）。 */
async function waitForServerSize(name, cols, rows, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const session = await sessionByName(name);
    if (session !== null && session.cols === cols && session.rows === rows) return true;
    await sleep(100);
  }
  return false;
}

/** 打开尺寸弹层。 */
async function openPop(page) {
  await page.locator('.size-chip').click();
  await page.waitForSelector('.size-pop', { timeout: 5_000 });
}

/** 点弹层里的某个预设档。 */
async function pickPreset(page, cols, rows) {
  await openPop(page);
  await page.locator('.size-item', { hasText: `${cols} × ${rows}` }).first().click();
}

/** 手输尺寸并点「应用」。 */
async function typeSize(page, cols, rows) {
  await openPop(page);
  const inputs = page.locator('.size-input');
  await inputs.nth(0).fill(String(cols));
  await inputs.nth(1).fill(String(rows));
  await page.locator('.size-submit').click();
}

/** 网格的像素几何 + 终端实际网格（两份独立的真相一起取，便于互相印证）。 */
async function gridGeometry(page) {
  const boxes = await page.evaluate(() => {
    const screen = document.querySelector('.xterm-screen');
    const host = document.querySelector('.term-host');
    if (screen === null || host === null) return null;
    const s = screen.getBoundingClientRect();
    const h = host.getBoundingClientRect();
    return { screenW: s.width, screenH: s.height, hostW: h.width, hostH: h.height };
  });
  return boxes;
}

/**
 * 在一个新页面（新 context，因此 sessionStorage 是干净的）里订阅指定会话。
 *
 * 必须显式点那张会话卡片：新页面没有位置记忆，`sessions` 到了之后它会自动订阅列表里的
 * **第一个**会话——那是另一个会话，等 `debugState().session` 就会一直等不到。
 */
async function openSubscribedPage(browser, sessionId, name) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.xterm-screen', { timeout: 20_000 });
  await page.locator('.session', { hasText: name }).first().click({ timeout: 20_000 });
  await page.waitForFunction(
    (id) => window.__terminald?.debugState?.().session === id,
    sessionId,
    { timeout: 20_000, polling: 250 },
  );
  return { context, page };
}

/**
 * 留证截图。探针的约定是"结论要能被人看一眼复核"，尺寸这种纯视觉的改动尤其如此
 * （落盘目录在 `.probe/`，已 gitignore）。
 */
async function shoot(page, name) {
  const path = join(OUT_DIR, name);
  await page.screenshot({ path });
  console.log(`      截图 -> ${path}`);
}

/** 顶栏 + 弹层那一片的局部截图（全页截图里它只占一角，看不出细节）。 */
async function shootPopover(page, name) {
  const pop = await page.locator('.size-pop').boundingBox();
  const chips = await page.locator('.chips').boundingBox();
  if (pop === null || chips === null) return;
  const left = Math.max(0, Math.min(chips.x, pop.x) - 12);
  const path = join(OUT_DIR, name);
  await page.screenshot({
    path,
    clip: {
      x: left,
      y: 0,
      width: Math.max(chips.x + chips.width, pop.x + pop.width) - left + 12,
      height: pop.y + pop.height + 8,
    },
  });
  console.log(`      截图 -> ${path}`);
}

/**
 * 往历史里滚一段（负值向上）。
 *
 * **必须循环**：xterm 按事件计数滚动，单个大 delta 只滚几行——实测 `wheel(0, -1500)` 一次
 * 只把视口挪了 2~6 行，看起来像"滚了"，但视口其实还贴着底部。
 */
async function scrollUp(page, times = 15) {
  const box = await page.locator('.xterm-screen').boundingBox();
  if (box === null) throw new Error('拿不到 .xterm-screen 的位置');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < times; i += 1) {
    await page.mouse.wheel(0, -200);
    await page.waitForTimeout(25);
  }
  await sleep(300);
}

/**
 * 刷新并等到「位置恢复」已经发生。
 *
 * 等的是**条件**而不是时间：重放结束、视口被放回历史里（`viewportY < baseY`）。
 * 不能等某个标记行的文本——恢复之后视口不在底部，底部那些行本来就看不见；
 * 也不能 sleep，因为"恢复得对不对"才是这一组要断言的东西。
 */
async function reloadAndWaitForRestore(page) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.xterm-screen', { timeout: 20_000 });
  await page.waitForFunction(
    () => {
      const s = window.__terminald?.debugState?.();
      return s !== undefined && s.baseY > 0 && s.viewportY < s.baseY;
    },
    null,
    { timeout: 30_000, polling: 250 },
  );
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const server = await startServer({ port: 8809 });
  BASE = server.base;
  let browser = null;

  try {
    const cleaned = await resetSessions(BASE);
    console.log(`清理已有会话 ${cleaned} 个（${BASE}）`);

    const live = await createSession(BASE, 'rz-live', lineEcho());
    // 一个立刻退出的会话：用来验证"已退出不可改"
    const dead = await createSession(BASE, 'rz-dead', [
      PYTHON,
      '-c',
      "import sys; sys.stdout.write('BYE\\r\\n'); sys.stdout.flush()",
    ]);
    console.log(`会话 live=${live.id} dead=${dead.id}`);
    await sleep(1200);

    browser = await chromium.launch({
      executablePath: CHROME,
      headless: true,
      args: CHROMIUM_ARGS,
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') pageErrors.push(`console.error: ${message.text()}`);
    });
    // 记下客户端实际发出去的帧，但**分成两类精确计数**——总数会被周期性的 `ack` 干扰：
    // - `__sentInputBytes`：二进制帧（= 真正要进 PTY 的输入字节），用来断言"Esc 没漏进终端"；
    // - `__resizeRequests`：`session.resize` 请求，用来断言"非法输入一个请求都没发"。
    await page.addInitScript(() => {
      window.__sentInputBytes = 0;
      window.__resizeRequests = 0;
      const original = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        if (typeof data === 'string') {
          try {
            if (JSON.parse(data).t === 'session.resize') window.__resizeRequests += 1;
          } catch {
            /* 非 JSON 的文本帧不该出现，交给别的断言 */
          }
        } else {
          window.__sentInputBytes += 1;
        }
        return original.call(this, data);
      };
    });

    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.xterm-screen', { timeout: 20_000 });
    await page.waitForFunction(
      (id) => window.__terminald?.debugState?.().session === id,
      live.id,
      { timeout: 20_000, polling: 250 },
    );
    await waitForText(page, `${ECHO}-${String(LINES).padStart(4, '0')}`, 30_000);

    // ---------------------------------------------------------- 1. 入口

    const initial = await debugState(page);
    const initialChip = await chipText(page);
    check(
      'chip 显示的就是服务端交付的尺寸',
      initial.cols === INITIAL.cols &&
        initial.rows === INITIAL.rows &&
        initialChip.includes(`${INITIAL.cols}×${INITIAL.rows}`),
      `chip=${initialChip} state=${initial.cols}×${initial.rows}`,
    );

    await openPop(page);
    await shootPopover(page, 'resize-popover.png');
    const popItems = await page.locator('.size-item').allInnerTexts();
    const currentMarked = await page.locator('.size-item.current').innerText();
    check(
      '弹层列出预设，且当前档位被标出来',
      popItems.length >= 3 && currentMarked.includes(`${INITIAL.cols} × ${INITIAL.rows}`),
      `items=${popItems.length} current=${currentMarked.replace(/\s+/g, ' ')}`,
    );

    const inputBeforeEsc = await page.evaluate(() => window.__sentInputBytes);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.size-pop', { state: 'detached', timeout: 5_000 });
    const inputAfterEsc = await page.evaluate(() => window.__sentInputBytes);
    check(
      'Esc 关掉弹层，且一个输入字节都没漏进终端',
      inputAfterEsc === inputBeforeEsc,
      `二进制输入帧 ${inputBeforeEsc} -> ${inputAfterEsc}`,
    );

    // ---------------------------------------------------------- 2. 生效（预设）

    const gridBefore = await gridGeometry(page);
    const cellBefore = gridBefore.screenW / initial.termCols;
    const before = Date.now();
    await pickPreset(page, 80, 24);
    const sizeOk = await waitForServerSize('rz-live', 80, 24);
    check('选预设后服务端尺寸变了', sizeOk, `耗时 ${Date.now() - before}ms`);
    check('提交后弹层自己收起来', (await page.locator('.size-pop').count()) === 0);

    await page.waitForFunction(
      () => {
        const s = window.__terminald.debugState();
        return s.termCols === 80 && s.termRows === 24;
      },
      null,
      { timeout: 10_000, polling: 100 },
    );

    const after = await debugState(page);
    check(
      '客户端持有的网格 == 服务端说的网格 == xterm 实际生效的网格',
      after.cols === 80 &&
        after.rows === 24 &&
        after.termCols === 80 &&
        after.termRows === 24,
      JSON.stringify({ cols: after.cols, rows: after.rows, termCols: after.termCols, termRows: after.termRows }),
    );
    check('chip 跟着变（值来自服务端，不是本地乐观更新）', (await chipText(page)).includes('80×24'));

    const gridAfter = await gridGeometry(page);
    const cellAfter = gridAfter.screenW / after.termCols;
    check(
      '网格像素按新列数重算了：列数变少 ⇒ 单格变宽（字号跟着网格走，不是只换了个数字）',
      cellAfter > cellBefore + 0.5,
      `单格宽 ${cellBefore.toFixed(2)} → ${cellAfter.toFixed(2)}（列数 120 → 80）`,
    );
    check(
      '网格仍未溢出容器（字号是解出来的，网格恒定铺得进去）',
      gridAfter.screenW <= gridAfter.hostW + 1 && gridAfter.screenH <= gridAfter.hostH + 1,
      `网格 ${gridAfter.screenW.toFixed(0)}×${gridAfter.screenH.toFixed(0)} vs 容器 ${gridAfter.hostW.toFixed(0)}×${gridAfter.hostH.toFixed(0)}`,
    );
    check(
      'xterm 的格子是整数像素（与 render/size.ts 的假设一致）',
      Number.isInteger(Math.round(cellAfter * 100) / 100) && Math.abs(cellAfter - Math.round(cellAfter)) < 0.02,
      `单格宽 ${cellAfter.toFixed(3)}`,
    );
    await shoot(page, 'resize-80x24.png');

    // ---------------------------------------------------------- 2b. 生效（手输 / 非法输入）

    await typeSize(page, 100, 28);
    const typedOk = await waitForServerSize('rz-live', 100, 28);
    check('手输尺寸也能生效', typedOk, '100×28');

    await openPop(page);
    const resizeBeforeBad = await page.evaluate(() => window.__resizeRequests);
    await page.locator('.size-input').nth(0).fill('abc');
    await page.locator('.size-submit').click();
    const warn = await page.locator('.chip.warn').innerText();
    const resizeAfterBad = await page.evaluate(() => window.__resizeRequests);
    check(
      '非法输入就地拦下：不发请求、给出提示、弹层不关',
      resizeAfterBad === resizeBeforeBad &&
        warn.includes('正整数') &&
        (await page.locator('.size-pop').count()) === 1,
      `warn=${warn} session.resize 请求 ${resizeBeforeBad} -> ${resizeAfterBad}`,
    );
    await page.keyboard.press('Escape');
    await page.waitForSelector('.size-pop', { state: 'detached', timeout: 5_000 });
    check('非法输入之后服务端尺寸没变', (await sessionByName('rz-live')).cols === 100);

    // ---------------------------------------------------------- 3. 多客户端逐行一致

    // 先把尺寸改回 80×24，再让第二个客户端订阅 —— 于是它是"改完之后才来、整段重放"的那种
    await pickPreset(page, 80, 24);
    await waitForServerSize('rz-live', 80, 24);
    await page.waitForFunction(
      () => {
        const s = window.__terminald.debugState();
        return s.termCols === 80 && s.termRows === 24;
      },
      null,
      { timeout: 10_000, polling: 100 },
    );

    const second = await openSubscribedPage(browser, live.id, 'rz-live');
    await waitForText(second.page, `${ECHO}-${String(LINES).padStart(4, '0')}`, 30_000);

    const liveLines = await screenLines(page);
    const replayLines = await screenLines(second.page);
    const sameScreen = liveLines.length === replayLines.length && liveLines.every((line, i) => line === replayLines[i]);
    check(
      '活过整次改尺寸的客户端 与 改完之后才订阅的客户端：屏幕逐行一致',
      sameScreen,
      sameScreen
        ? `${liveLines.length} 行`
        : `首个差异 @${liveLines.findIndex((line, i) => line !== replayLines[i])}：` +
          `${JSON.stringify(liveLines.find((line, i) => line !== replayLines[i]))} vs ` +
          `${JSON.stringify(replayLines.find((line, i) => line !== liveLines[i]))}`,
    );

    const replayState = await debugState(second.page);
    check(
      '重放客户端拿到的就是当前尺寸（attached 交付，不需要额外的 resized）',
      replayState.cols === 80 && replayState.rows === 24 && replayState.termCols === 80,
      JSON.stringify({ cols: replayState.cols, rows: replayState.rows, termCols: replayState.termCols }),
    );

    // ---------------------------------------------------------- 4. 刷新后位置（改尺寸之后）

    // 这一组是 `probe/remember.mjs` 没覆盖的缺口：那里没有改尺寸。位置记忆记的是**行号**
    // （见 `remember.ts`），而 reflow 会改行号 —— 于是它有两种坏法（`docs/resize-plan.md`
    // §4.4 预告、这里实测）：
    //
    // - 缓冲区**变长**时，记下的行号悄悄指向别的内容 ⇒ 刷新落在另一处；
    // - 缓冲区**变短**时，记下的行号可能越过新上界，`#restoreScroll` 的"超出上界就不动"
    //   会直接跳过 ⇒ 位置静默丢失、刷新落到最底部。
    //
    // **用一个全新的会话 + 全新的页面来测**，不在上面那个会话上接着做：那个会话已经被几次
    // 改尺寸折腾过，缓冲区里掺了宿主重绘留下的行，xterm 的重排行为会因此不同（实测：干净
    // 缓冲区下视口绝对行号会被挪动 6 行，掺过的缓冲区下不动）——而"行号被挪动"正是这条
    // 断言有判别力的前提，所以下面把它显式断言成用例前提，而不是指望它自己发生。
    //
    // 断言的落点是「与**没刷新**的那个客户端看到同一处」：reflow 之后视口落在哪一行由
    // xterm 的重排算法决定，我们能保证、也必须保证的是刷新之后回到 live 客户端此刻那一处。
    const mem = await createSession(BASE, 'rz-mem', lineEcho());
    const memPage = await openSubscribedPage(browser, mem.id, 'rz-mem');
    await waitForText(memPage.page, `${ECHO}-${String(LINES).padStart(4, '0')}`, 30_000);

    const visibleMarkers = async (target) => {
      const lines = await screenLines(target);
      return lines.join('\n').match(/RZ-\d{4}/g) ?? [];
    };

    const memBox = await memPage.page.locator('.xterm-screen').boundingBox();
    await memPage.page.mouse.move(memBox.x + memBox.width / 2, memBox.y + memBox.height / 2);
    // 滚进历史（停在底部的话"恢复位置"本来就无事可做）
    await scrollUp(memPage.page, 15);

    const beforeResize = await debugState(memPage.page);
    check(
      '改尺寸之前：视口在历史里，且离底部足够远（用例前提）',
      beforeResize.viewportY + 5 < beforeResize.baseY,
      `viewportY=${beforeResize.viewportY} baseY=${beforeResize.baseY}`,
    );

    // ---- 4a：缓冲区**变长**（120 → 80，100 列宽的行折成两行）
    await pickPreset(memPage.page, 80, 24);
    await memPage.page.waitForFunction(
      () => {
        const s = window.__terminald.debugState();
        return s.termCols === 80 && s.termRows === 24;
      },
      null,
      { timeout: 10_000, polling: 100 },
    );
    const grown = await debugState(memPage.page);
    const grownMarkers = await visibleMarkers(memPage.page);
    check(
      '改尺寸让缓冲区真的重排了（100 列宽的行在 80 列下折行 ⇒ 历史行数变多）',
      grown.baseY > beforeResize.baseY,
      `baseY ${beforeResize.baseY} → ${grown.baseY}`,
    );
    check(
      '用例前提：reflow 挪动了视口的绝对行号（不挪的话下面那条断言会变成恒真）',
      grown.viewportY !== beforeResize.viewportY && grown.viewportY < grown.baseY,
      `viewportY ${beforeResize.viewportY} → ${grown.viewportY}（baseY ${grown.baseY}），可见标记 ${grownMarkers.length} 个`,
    );
    await reloadAndWaitForRestore(memPage.page);
    const grownAfter = await visibleMarkers(memPage.page);
    check(
      '缓冲区变长（reflow 改了行号）之后刷新，仍回到 live 客户端那一处',
      grownAfter.join(',') === grownMarkers.join(','),
      `${grownMarkers.slice(0, 4).join(',')} vs ${grownAfter.slice(0, 4).join(',')}`,
    );

    // ---- 4b：缓冲区**变短**（80 → 120，折行并回去）
    //
    // 先再往历史里滚一段（4a 之后视口离底部很近，而"重放出来的缓冲区可能比 live 的短几行"
    // —— 宿主重绘的补空行在两种布局下行数不同 —— 贴着底部时"目标行恰好撞上新上界"会把恢复
    // 直接跳过。那是另一件事，不该混进这条断言）。
    await scrollUp(memPage.page, 15);
    const beforeShrink = await debugState(memPage.page);
    check(
      '4b 用例前提：视口在历史深处（不是贴着底部，否则断言会被边界情形干扰）',
      beforeShrink.viewportY + 5 < beforeShrink.baseY,
      `viewportY=${beforeShrink.viewportY} baseY=${beforeShrink.baseY}`,
    );

    await pickPreset(memPage.page, 120, 30);
    await memPage.page.waitForFunction(
      () => {
        const s = window.__terminald.debugState();
        return s.termCols === 120 && s.termRows === 30;
      },
      null,
      { timeout: 10_000, polling: 100 },
    );
    const shrunk = await debugState(memPage.page);
    const shrunkMarkers = await visibleMarkers(memPage.page);
    check(
      '反向改尺寸（缓冲区变短）之后视口仍在历史里',
      shrunk.baseY < grown.baseY && shrunk.viewportY < shrunk.baseY && shrunkMarkers.length > 0,
      `baseY ${grown.baseY} → ${shrunk.baseY} viewportY=${shrunk.viewportY} 可见标记 ${shrunkMarkers.length} 个`,
    );
    await reloadAndWaitForRestore(memPage.page);
    const shrunkAfter = await visibleMarkers(memPage.page);
    check(
      '缓冲区变短（记住的行号可能越界）之后刷新，仍回到 live 客户端那一处',
      shrunkAfter.join(',') === shrunkMarkers.join(','),
      `${shrunkMarkers.slice(0, 4).join(',')} vs ${shrunkAfter.slice(0, 4).join(',')}`,
    );
    await memPage.context.close();

    // ---------------------------------------------------------- 5. 已退出不可改

    await page.locator('.session', { hasText: 'rz-dead' }).first().click({ timeout: 20_000 });
    await page.waitForFunction(
      (id) => window.__terminald?.debugState?.().session === id,
      dead.id,
      { timeout: 20_000, polling: 250 },
    );
    await sleep(300);
    check('已退出的会话：尺寸 chip 置灰', await chipDisabled(page));
    const resizeBeforeDead = await page.evaluate(() => window.__resizeRequests);
    await page.locator('.size-chip').click({ force: true });
    await sleep(200);
    check(
      '已退出的会话：点了也开不出弹层、也不发请求',
      (await page.locator('.size-pop').count()) === 0 &&
        (await page.evaluate(() => window.__resizeRequests)) === resizeBeforeDead,
    );

    // ---------------------------------------------------------- 6. 正在看的会话自己退出

    // 上一组测的是「切到已退出的会话」；这条补**不切会话**的那条路径：会话状态是由
    // `sessions` 广播更新的，chip 的置灰必须跟着它走——只靠 `attached` → `#fit()` 那条路
    // 是不够的（会话自己退出不会触发 `attached`）。
    const late = await createSession(BASE, 'rz-late', [
      PYTHON,
      '-c',
      "import sys,time\nsys.stdout.write('RZ-LATE-UP\\r\\n')\nsys.stdout.flush()\ntime.sleep(3)\n",
    ]);
    await page.locator('.session', { hasText: 'rz-late' }).first().click({ timeout: 20_000 });
    await page.waitForFunction(
      (id) => window.__terminald?.debugState?.().session === id,
      late.id,
      { timeout: 20_000, polling: 250 },
    );
    await waitForText(page, 'RZ-LATE-UP', 20_000);
    check('刚订阅时它还在运行：尺寸 chip 可点', !(await chipDisabled(page)), 'rz-late');

    // 等它退出（等的是**状态**，不是时间）：期间不切会话、不刷新
    await page.waitForFunction(
      () => document.querySelector('.size-chip')?.disabled === true,
      null,
      { timeout: 20_000, polling: 200 },
    );
    check('会话自己退出后就地置灰（没切会话、没刷新）', true);
    check(
      '置灰的同时仍停在这个会话上（不是被切走了）',
      (await debugState(page)).session === late.id,
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
