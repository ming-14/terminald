/**
 * 多客户端同步：三个页面对同一会话的逐行比对（含“输出进行中接入”的新客户端）。
 *
 * 三个页面订阅同一个会话：
 *   A、B —— 输出还在进行时就订阅（一个先、一个后，覆盖「整段重放 + 实时续接」的混合时序）
 *   C —— 等一切结束后再订阅（等价于「刷新页面 / 新开一个网页」）
 *
 * 比对的是**每一行可见屏幕的文本**（逐行 = 逐格文本粒度）、scrollback 的滚动几何、
 * 以及滚到顶时最早那批历史行。任何一个不相同，就说明「完全同步」不成立。
 *
 * 自带服务器（端口 8806，真实 pywezterm），可重复运行。
 *
 * 用法：`node probe/multi-client.mjs`
 */

import { chromium } from 'playwright-core';

import { PYTHON, chromiumExecutable } from './env.mjs';
import { createSession, resetSessions, startServer, summarize } from './server.mjs';

const CHROME = chromiumExecutable();
const LINES = Number(process.env['PROBE_LINES'] ?? 3000);

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** 等两帧，让渲染追上 DOM。 */
const RAF2 = `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`;

/** 可见屏幕的逐行文本（行 = xterm 的物理行）。 */
async function screenRows(page) {
  return await page.evaluate(`(async () => {
    const viewport = document.querySelector('.xterm-viewport');
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
    await ${RAF2};
    const rows = document.querySelector('.xterm-rows');
    return rows ? [...rows.children].map((row) => row.textContent ?? '') : null;
  })()`);
}

/**
 * 滚到顶：最早那批 scrollback 行的逐行文本。
 *
 * **不能用 `viewport.scrollTop = 0`**（这就是这里的第一个错）：xterm v6 的滚动条是它自己那套
 * `Scrollable`，`.xterm-viewport` 的 `scrollHeight === clientHeight`，程序化赋值根本不会滚，
 * 于是「滚到顶后三客户端逐行一致」实际比的是三张底屏——**恒真**。
 *
 * 也不能靠「反复发滚轮」：Chromium 把每次滑轮的 delta 钳到 ~40px，3000 行要上千次。
 * 所以先真滚一下把滚动条唤出来，再把它的拇指拖到轨道顶端。
 */
async function topRows(page) {
  await page.click('.xterm-screen');
  const box = await page.locator('.xterm-screen').boundingBox();
  if (box) {
    // 先真滚一下：滚动条是自动淡入淡出的，淡出时 `pointer-events: none`，拖不住
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -40);
    await page.waitForTimeout(60);
  }

  // 拖拇指到轨道顶端，一步到位。
  // 不用「反复发滚轮」：Chromium 把每次滚轮的 delta 钳到 ~40px，3000 行要上千次。
  const bar = await page.evaluate(() => {
    const element = document.querySelector('.xterm-scrollable-element > .scrollbar.vertical');
    const slider = element?.querySelector(':scope > .slider');
    if (!element || !slider) return null;
    const barRect = element.getBoundingClientRect();
    const sliderRect = slider.getBoundingClientRect();
    return { top: barRect.top, x: sliderRect.left + sliderRect.width / 2, y: sliderRect.top + sliderRect.height / 2 };
  });
  if (bar !== null) {
    await page.mouse.move(bar.x, bar.y);
    await page.mouse.down();
    await page.mouse.move(bar.x, bar.top + 2, { steps: 20 });
    await page.mouse.up();
    await page.waitForTimeout(150);
  }

  return await page.evaluate(`(async () => {
    await ${RAF2};
    const rows = document.querySelector('.xterm-rows');
    return rows ? [...rows.children].map((row) => row.textContent ?? '') : null;
  })()`);
}

/**
 * 历史深度：`baseY` 是**已经滚出去的行数**，也就是这个客户手里有多少 scrollback。
 *
 * 这里原来量的是 `.xterm-viewport` 的 `scrollHeight / clientHeight`——而它们的值恒为
 * 「容器高 = 容器高」（见上），所以那条「滚动区几何一致」也是恒真的。真正能区分
 * 「谁少拿了一段历史」的是 `baseY`。
 */
async function historyDepth(page) {
  return await page.evaluate(() => {
    const state = window.__terminald.debugState();
    return { baseY: state.baseY, scrollback: state.scrollback };
  });
}

function firstDiff(a, b) {
  if (a === null || b === null) return '拿不到行数据';
  if (a.length !== b.length) return `行数不同 ${a.length} vs ${b.length}`;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return `第 ${i} 行不同: ${JSON.stringify(a[i].trim())} vs ${JSON.stringify(b[i].trim())}`;
    }
  }
  return '';
}

async function main() {
  const server = await startServer({ port: 8806 });
  const BASE = server.base;
  await resetSessions(BASE);
  const code = `import sys;w=sys.stdout.write;[w('SYNC-%04d-abcdefghijklmnopqrstuvwxyz0123456789\\r\\n' % i) for i in range(1,${LINES + 1})]`;
  const session = await createSession(BASE, 'probe-multi-client', [PYTHON, '-c', code]);
  console.log(`会话 ${session.id}：${LINES} 行输出（${BASE}）`);
  const marker = `SYNC-${String(LINES).padStart(4, '0')}`;

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const pages = [];
  try {
    const openPage = async (label) => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
      });
      await page.goto(BASE, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.xterm-screen', { timeout: 20_000 });
      await page.locator('.session', { hasText: 'probe-multi-client' }).first().click({ timeout: 20_000 });
      return { label, page, errors };
    };

    pages.push(await openPage('A'));
    await new Promise((r) => setTimeout(r, 250));
    pages.push(await openPage('B')); // 输出进行中订阅：整段重放 + 实时续接

    for (const { label, page } of pages) {
      await page.waitForFunction(
        (m) => (document.querySelector('.xterm-rows')?.textContent ?? '').includes(m),
        marker,
        { timeout: 90_000 },
      );
      console.log(`客户端 ${label} 已看到最后一行 ${marker}`);
    }
    await new Promise((r) => setTimeout(r, 1500));

    // 第三个页面：此时输出早已结束 —— 等价于「刷新页面 / 新开网页」
    pages.push(await openPage('C(新客户端)'));
    await pages[2].page.waitForFunction(
      (m) => (document.querySelector('.xterm-rows')?.textContent ?? '').includes(m),
      marker,
      { timeout: 90_000 },
    );
    console.log('客户端 C(新客户端) 已看到最后一行');
    await new Promise((r) => setTimeout(r, 800));

    const screens = [];
    const tops = [];
    const histories = [];
    for (const entry of pages) {
      screens.push([entry.label, await screenRows(entry.page)]);
      histories.push([entry.label, await historyDepth(entry.page)]);
      tops.push([entry.label, await topRows(entry.page)]);
    }

    const baseScreen = screens[0][1];
    const baseTop = tops[0][1];
    // 这条是「上面那些断言不是恒真的」的证据：滚到顶之后首行必须是**最早那一行**。
    check(
      'A 真的滚到了最早一行（否则顶部比对是恒真的）',
      (baseTop?.[0] ?? '').startsWith('SYNC-0001'),
      `A 顶部首行 = ${JSON.stringify((baseTop?.[0] ?? '').trim())}`,
    );
    const baseHistory = histories[0][1];
    console.log(`A 底部屏首行: ${JSON.stringify((baseScreen?.[0] ?? '').trim())}`);
    console.log(`A 滚到顶首行: ${JSON.stringify((baseTop?.[0] ?? '').trim())}`);
    console.log(`A 历史深度: ${JSON.stringify(baseHistory)}`);

    for (const [label, rows] of screens.slice(1)) {
      check(`${label} 的可见屏幕与 A 逐行一致`, firstDiff(baseScreen, rows) === '', firstDiff(baseScreen, rows));
    }
    for (const [label, rows] of tops.slice(1)) {
      check(`${label} 的 scrollback 顶部与 A 逐行一致`, firstDiff(baseTop, rows) === '', firstDiff(baseTop, rows));
    }
    for (const [label, history] of histories.slice(1)) {
      check(
        `${label} 手上的历史行数与 A 相同（没少拿一段 scrollback）`,
        JSON.stringify(history) === JSON.stringify(baseHistory),
        `${JSON.stringify(history)} vs ${JSON.stringify(baseHistory)}`,
      );
    }
    for (const { label, errors } of pages) {
      check(`客户端 ${label} 无 JS 错误`, errors.length === 0, errors.slice(0, 2).join(' | '));
    }
  } finally {
    await browser.close();
    server.stop();
  }

  process.exitCode = summarize(results);
}

await main();
