/**
 * scrollback 交付：三个页面对同一会话，各自滚到**滚不动为止**，比对
 *   1) 能否一路滚回最早那一行（scrollback 是否真的交付到浏览器）
 *   2) 三个客户端在顶部看到的每一行是否完全一致（含历史）
 *
 * 自带服务器（端口 8807，真实 pywezterm），可重复运行。
 *
 * 用法：`node probe/scrollback.mjs`
 */

import { chromium } from 'playwright-core';

import { CHROMIUM_ARGS, PYTHON, chromiumExecutable } from './env.mjs';
import { screenLines, waitForText } from './screen.mjs';
import { createSession, resetSessions, startServer, summarize } from './server.mjs';

const CHROME = chromiumExecutable();
const LINES = Number(process.env['PROBE_LINES'] ?? 300);

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const rowsNow = (page) => screenLines(page);

async function open(browser, base, label) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.xterm-screen', { timeout: 20_000 });
  await page.locator('.session', { hasText: 'probe-scrollback' }).first().click({ timeout: 20_000 });
  await waitForText(page, `ROW-${String(LINES).padStart(4, '0')}`, 60_000);
  console.log(`页面 ${label} 已看到最后一行`);
  return { label, page };
}

/** 用滚轮一路往上，直到首行不再变化（或到上限）。 */
async function scrollToVeryTop(entry) {
  const { page } = entry;
  await page.click('.xterm-screen');
  const box = await page.locator('.xterm-screen').boundingBox();
  let previous = '';
  let stable = 0;
  let events = 0;
  for (; events < 400 && stable < 6; events += 1) {
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, -200);
    }
    await page.waitForTimeout(25);
    const rows = await rowsNow(page);
    const key = rows[0] ?? '';
    if (key === previous) stable += 1;
    else stable = 0;
    previous = key;
  }
  return { rows: await rowsNow(page), events };
}

async function main() {
  const server = await startServer({ port: 8807 });
  let browser;
  try {
    await resetSessions(server.base);
    const code = `import sys;w=sys.stdout.write;[w('ROW-%04d-xxxxxxxxxxxxxxxxxxxx\\r\\n' % i) for i in range(1,${LINES + 1})]`;
    await createSession(server.base, 'probe-scrollback', [PYTHON, '-c', code]);

    browser = await chromium.launch({ executablePath: CHROME, headless: true, args: CHROMIUM_ARGS });
    const entries = [];
    entries.push(await open(browser, server.base, 'A'));
    entries.push(await open(browser, server.base, 'B'));
    await new Promise((r) => setTimeout(r, 1500));
    entries.push(await open(browser, server.base, 'C'));

    const tops = [];
    for (const entry of entries) {
      const { rows, events } = await scrollToVeryTop(entry);
      tops.push([entry.label, rows]);
      console.log(
        `${entry.label}: 滚轮 ${events} 次后到顶，首行 = ${JSON.stringify(rows[0])}，末行 = ${JSON.stringify(rows[rows.length - 1])}`,
      );
    }

    const reference = tops[0][1];
    for (const [label, rows] of tops.slice(1)) {
      let diff = '';
      if (rows.length !== reference.length) diff = `行数不同 ${rows.length} vs ${reference.length}`;
      else {
        for (let i = 0; i < rows.length; i += 1) {
          if (rows[i] !== reference[i]) {
            diff = `第 ${i} 行: ${JSON.stringify(rows[i])} vs ${JSON.stringify(reference[i])}`;
            break;
          }
        }
      }
      check(`${label} 顶部历史与 A 逐行一致`, diff === '', diff);
    }

    check(
      '能滚回最早一行 ROW-0001',
      reference.some((r) => r.startsWith('ROW-0001')),
      `首行 = ${JSON.stringify(reference[0])}`,
    );

    // ---- 滚动条：存在、贴右边缘、**能拖**
    //
    // 这三条必须在这里测：xterm v6 的滚动条是懒创建 + 自动淡入淡出的（VS Code 那套），
    // 只有在真有 scrollback 且滚动过之后才看得见；同时也只能在这里测，因为只有这个探针
    // 会造出 300 行 scrollback。
    const pageA = entries[0].page;
    const bar = await pageA.evaluate(() => {
      const host = document.querySelector('.term-host')?.getBoundingClientRect();
      const element = document.querySelector('.xterm-scrollable-element > .scrollbar.vertical');
      const slider = element?.querySelector(':scope > .slider');
      if (!host || !element || !slider) return null;
      const barRect = element.getBoundingClientRect();
      const sliderRect = slider.getBoundingClientRect();
      return {
        size: `${barRect.width}×${barRect.height}`,
        gapRight: host.right - barRect.right,
        sliderHeight: sliderRect.height,
        sliderPoint: { x: sliderRect.left + sliderRect.width / 2, y: sliderRect.top + sliderRect.height / 2 },
      };
    });
    if (bar === null) {
      check('滚动条存在（拖得动才是真滚动条）', false, '找不到 .xterm-scrollable-element > .scrollbar.vertical > .slider');
    } else {
      check('滚动条存在', true, `尺寸 ${bar.size}，拇指高 ${bar.sliderHeight}`);
      check('滚动条贴右边缘（不被网格余量顶进来）', Math.abs(bar.gapRight) <= 1, `距 host 右缘 ${bar.gapRight.toFixed(1)}px`);

      const before = await pageA.evaluate(() => window.__terminald.debugState().viewportY);
      await pageA.mouse.move(bar.sliderPoint.x, bar.sliderPoint.y);
      await pageA.mouse.down();
      await pageA.mouse.move(bar.sliderPoint.x, bar.sliderPoint.y + 80, { steps: 10 });
      await pageA.mouse.up();
      await pageA.waitForTimeout(200);
      const after = await pageA.evaluate(() => window.__terminald.debugState().viewportY);
      check('拖动滚动条拇指真的改变视口位置', after > before, `viewportY ${before} → ${after}`);
    }
  } finally {
    await browser?.close();
    server.stop();
  }
  process.exitCode = summarize(results);
}

await main();
