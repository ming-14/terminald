/**
 * 真实浏览器探针：字符**画得对不对**——方块与盒线连没连起来、中文还能不能画。
 *
 * 为什么需要它：前端把 DOM 渲染器换成了 WebGL 渲染器（见 `src/ui/app.ts`），理由是方块/盒线
 * 字符由终端自绘几何、会填满整个字符格；而我们的行高是固定 1.3 倍（`render/size.ts`），
 * 格子比字体字形高，交给字体画就必然留缝。这条收益是**纯视觉的**——单测、类型检查、
 * 甚至「内容有没有渲染出来」都测不出它。所以只能读像素。
 *
 * 做法：让一个子进程打印固定的图案（3 行 × 8 列的 `█`、一行 8 个 `─`、一行 4 个双宽中文），
 * 把 `.xterm-screen` 截下来，在页面里解码成像素，然后数：
 * - 实心块内部不是前景色的像素（自绘几何必须为 0，字体字形必然大于 0）；
 * - 盒线线心上的断点（必须为 0——线端缩进格子就会断）；
 * - 中文那一行的墨迹范围（4 个双宽字应占满 8 个格子：换渲染器后回退字体走的是另一条
 *   取字路径，这条同时守住「画得出来」和「宽度还是双宽」）。
 *
 * 另跑一个**对照组**：把 `getContext('webgl2')` 打成 null，逼前端退回 DOM 渲染器。
 * 它承担两件事：① 证明方块那条断言不是恒真的（对照组必须数出缝）；② 顺带验证
 * `app.ts` 里那条回退真的会生效（不是写了个永远走不到的分支）。
 *
 * 自带服务器（端口 8808，真实 pywezterm），可重复运行；两张对照截图落在 `frontend/.probe/`。
 *
 * 用法：`node probe/glyphs.mjs`
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { chromium } from 'playwright-core';

import { CHROMIUM_ARGS, OUT_DIR, PYTHON, chromiumExecutable } from './env.mjs';
import { createSession, resetSessions, startServer, summarize } from './server.mjs';

const CHROME = chromiumExecutable();

/** 图案尺寸（字符格）：3 行 8 列的实心块 + 一行 8 个横线 + 一行 4 个双宽中文。 */
const BLOCK_COLS = 8;
const BLOCK_ROWS = 3;
/** 横线所在的行（0 起）：块占 0–2，第 3 行是空行，第 4 行是横线，第 5 行是中文。 */
const LINE_ROW = 4;
const CJK_ROW = 5;
/** 中文那行的文本：4 个双宽字 = 8 个字符格。 */
const CJK_TEXT = '中文宽度';

/**
 * 「图案到位」的墨像素门槛。
 *
 * 满墨量由图案算得出（8 列 × 3 行格子，实测约 3600 px），这里只要**大部分**墨到了就算到位：
 * 它只是「可以开始断言」的信号，不是断言本身，所以不必等齐。
 */
const ARRIVAL_INK = 1000;

/** 留证截图的取景：网格左上角起的一块，够放下整个图案（最宽 8 格 = 64 CSS px）外加一圈背景。 */
const SHOT_W = 320;
const SHOT_H = 200;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/**
 * 让子进程打印图案然后挂住不退。
 *
 * 走 `sys.stdout.buffer` 直接写字节、不经过 `str` 编码：Windows 控制台的默认编码不保证是
 * UTF-8，用 `sys.stdout.write('█')` 有概率直接抛 `UnicodeEncodeError`——那种失败看起来会像
 * 「前端没渲染」，排查方向完全错。
 *
 * 颜色用 24 位真彩而不是 SGR 31：真彩不经过调色板，画出来就是 (255,0,0)，断言里不用去猜
 * 主题把红色调成了什么。
 */
const PATTERN_SCRIPT = [
  'import sys, time',
  'w = sys.stdout.buffer',
  "w.write(b'\\x1b[2J\\x1b[H\\x1b[38;2;255;0;0m')",
  `for _ in range(${BLOCK_ROWS}):`,
  `    w.write(('\u2588' * ${BLOCK_COLS}).encode('utf-8') + b'\\r\\n')`,
  "w.write(b'\\r\\n')",
  `w.write(('\u2500' * ${BLOCK_COLS}).encode('utf-8') + b'\\r\\n')`,
  `w.write('${CJK_TEXT}'.encode('utf-8') + b'\\r\\n')`,
  'w.flush()',
  'time.sleep(300)',
].join('\n');

/**
 * 截 `.xterm-screen` 并在**页面里**解码、统计，只把几个数字带回来。
 *
 * 为什么不把像素数组传回 node：网格是 960×600，二百多万个字节，序列化过去的开销比统计本身
 * 大得多，而且 node 侧没有内置 PNG 解码（`.probe/read-pixels.mjs` 当初也是绕回浏览器解的）。
 *
 * 字符格尺寸由**图片自身**推出（`图宽 / cols`），不依赖 dpr、也不依赖我们对布局的推算：
 * 网格元素的尺寸就是 `cols × cellW`，所以拿图片宽度除列数是自洽的，取整误差不累积。
 */
async function measure(page, cols, rows) {
  const shot = await page.locator('.xterm-screen').screenshot();
  return await page.evaluate(
    async ({ b64, cols, rows, blockCols, blockRows, lineRow, cjkRow }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);

      const cellW = bitmap.width / cols;
      const cellH = bitmap.height / rows;

      // 「是墨」= 明显偏红，不写成「等于 (255,0,0)」：盒线是**描边**（canvas 2D stroke +
      // 抗锯齿），中心行也可能只有七成覆盖率；而底色是一组固定的暗值，两者不会混。
      const isInk = (x, y) => {
        const i = (y * bitmap.width + x) * 4;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        return r > 60 && r > 2 * g && r > 2 * b;
      };

      // 实心块区域：从格子边界往里缩 1px，避开图案最外圈的背景，但**保留内部的格子边界**
      // （缝就出在那里，缩掉就等于不测了）。
      const bx0 = 1;
      const bx1 = Math.floor(blockCols * cellW) - 2;
      const by0 = 1;
      const by1 = Math.floor(blockRows * cellH) - 2;

      let blockInk = 0;
      let blockHoles = 0;
      // 逐行统计，把「缝在哪一行」也带回来：只有总数的话，红了也不知道是横缝还是竖缝
      const holesPerRow = [];
      for (let y = by0; y <= by1; y += 1) {
        let rowHoles = 0;
        for (let x = bx0; x <= bx1; x += 1) {
          if (isInk(x, y)) blockInk += 1;
          else rowHoles += 1;
        }
        holesPerRow.push(rowHoles);
        blockHoles += rowHoles;
      }

      // 横线：先在这一行里找出墨最多的那条扫描线（线心），再沿它数断点
      const lineX1 = Math.floor(blockCols * cellW) - 1;
      const ly0 = Math.floor(lineRow * cellH);
      const ly1 = Math.floor((lineRow + 1) * cellH) - 1;
      let centerY = ly0;
      let centerInk = -1;
      for (let y = ly0; y <= ly1; y += 1) {
        let count = 0;
        for (let x = 1; x < lineX1; x += 1) {
          if (isInk(x, y)) count += 1;
        }
        if (count > centerInk) {
          centerInk = count;
          centerY = y;
        }
      }
      let lineHoles = 0;
      for (let x = 1; x < lineX1; x += 1) {
        if (!isInk(x, centerY)) lineHoles += 1;
      }

      // 中文行：4 个双宽字应从第 0 格铺到第 8 格。这里只量墨迹的横向范围（不逐个认字形），
      // 宽度若是按单宽算的，右缘会落在 4 格附近而不是 8 格——那正是要抓的错。
      const cj0 = Math.floor(cjkRow * cellH);
      const cj1 = Math.floor((cjkRow + 1) * cellH) - 1;
      let cjkInk = 0;
      let cjkLeft = -1;
      let cjkRight = -1;
      for (let y = cj0; y <= cj1; y += 1) {
        for (let x = 0; x < bitmap.width; x += 1) {
          if (!isInk(x, y)) continue;
          cjkInk += 1;
          if (cjkLeft < 0 || x < cjkLeft) cjkLeft = x;
          if (x > cjkRight) cjkRight = x;
        }
      }

      return {
        image: { w: bitmap.width, h: bitmap.height },
        cell: { w: cellW, h: cellH },
        blockInk,
        blockHoles,
        holesPerRow,
        lineCenterY: centerY,
        lineCenterInk: centerInk,
        lineHoles,
        cjkInk,
        cjkLeft,
        cjkRight,
      };
    },
    {
      b64: shot.toString('base64'),
      cols,
      rows,
      blockCols: BLOCK_COLS,
      blockRows: BLOCK_ROWS,
      lineRow: LINE_ROW,
      cjkRow: CJK_ROW,
    },
  );
}

/** 打开页面、订阅会话、等图案到位。`disableWebgl` 用来跑对照组。 */
async function openTerminal(browser, base, { disableWebgl }) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const diagnostics = { pageErrors: [], warnings: [], badResponses: [] };
  page.on('pageerror', (error) => diagnostics.pageErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') diagnostics.pageErrors.push(`console.error: ${message.text()}`);
    if (message.type() === 'warning') diagnostics.warnings.push(message.text());
  });
  page.on('response', (response) => {
    if (response.status() >= 400) diagnostics.badResponses.push(`${response.status()} ${response.url()}`);
  });

  if (disableWebgl) {
    // 让 addon 在建 WebglRenderer 时拿到 null —— 与「显卡/驱动不支持」是同一条路径
    await page.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
        if (typeof type === 'string' && type.startsWith('webgl')) return null;
        return original.call(this, type, ...rest);
      };
    });
  }

  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.xterm-screen', { timeout: 20_000 });
  await page.locator('.session').first().click({ timeout: 20_000 });
  // 等到「连接就绪」再谈内容到没到。这一步也只读诊断快照，不碰 DOM 里的文本——
  // WebGL 渲染器下 DOM 里根本没有文本（见下面那条断言）。
  await page.waitForFunction(() => window.__terminald?.debugState?.().connection === 'ready', null, {
    timeout: 20_000,
  });
  const size = await page.evaluate(() => window.__terminald.debugState());
  const grid = { cols: size.cols ?? 120, rows: size.rows ?? 30 };

  // 图案到位：轮询截图直到实心块区域出现足够多的墨。用像素当到达信号，与断言同一把尺子。
  const deadline = Date.now() + 20_000;
  let arrivalInk = 0;
  while (Date.now() < deadline) {
    arrivalInk = (await measure(page, grid.cols, grid.rows)).blockInk;
    if (arrivalInk > ARRIVAL_INK) break;
    await page.waitForTimeout(300);
  }
  return { page, diagnostics, grid, arrivalInk };
}

/** 截「图案那一块」留证。取景从网格元素的左上角起算，不用页面原点（那里是侧栏）。 */
async function shotPattern(page, path) {
  const box = await page.locator('.xterm-screen').boundingBox();
  if (box === null) return;
  await page.screenshot({ path, clip: { x: box.x, y: box.y, width: SHOT_W, height: SHOT_H } });
}

/** 把一次测量的关键数字打成一行，红了的时候不用再去翻截图。 */
function logMeasure(label, m) {
  console.log(
    `  ${label} 图片 ${m.image.w}×${m.image.h} 格子 ${m.cell.w.toFixed(2)}×${m.cell.h.toFixed(2)}` +
      ` 块内墨=${m.blockInk} 空洞=${m.blockHoles}` +
      ` 盒线线心 y=${m.lineCenterY} 该行墨=${m.lineCenterInk} 断点=${m.lineHoles}` +
      ` 中文墨=${m.cjkInk} 横跨 x ${m.cjkLeft}→${m.cjkRight}`,
  );
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const server = await startServer({ port: 8808 });
  const BASE = server.base;
  const cleaned = await resetSessions(BASE);
  console.log(`清理已有会话 ${cleaned} 个（${BASE}）`);

  await createSession(BASE, 'probe-glyphs', [PYTHON, '-c', PATTERN_SCRIPT]);

  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: CHROMIUM_ARGS });
  try {
    // ---- 主组：WebGL 渲染器
    const main = await openTerminal(browser, BASE, { disableWebgl: false });
    const { cols, rows } = main.grid;
    console.log(`网格 ${cols}×${rows}；主组到达时块内墨像素 ${main.arrivalInk}（门槛 ${ARRIVAL_INK}）`);

    // 渲染器身份：WebGL 渲染器挂 canvas 层，并且**不建** DOM 行容器（它替换掉的是 DomRenderer，
    // 后者 dispose 时会把 `.xterm-rows` 从 DOM 里摘掉）。这条断言是给后面几个探针看的：
    // 谁再想用 `.xterm-rows` 读屏幕文本，就会撞在这里。
    const dom = await main.page.evaluate(() => ({
      canvases: document.querySelectorAll('.xterm-screen canvas').length,
      rowContainers: document.querySelectorAll('.xterm-rows').length,
    }));
    check('WebGL 渲染器在跑（canvas 层存在）', dom.canvases >= 1, `canvas=${dom.canvases}`);
    check(
      'DOM 行容器已被移除（它归 DomRenderer 所有）',
      dom.rowContainers === 0,
      `.xterm-rows=${dom.rowContainers}`,
    );
    check('图案已画到屏幕上', main.arrivalInk > ARRIVAL_INK, `块内墨像素 ${main.arrivalInk}`);

    const webgl = await measure(main.page, cols, rows);
    logMeasure('主组', webgl);
    check(
      `${BLOCK_ROWS} 行 × ${BLOCK_COLS} 列实心块内部无空洞（竖叠与横排都连）`,
      webgl.blockHoles === 0,
      `空洞 ${webgl.blockHoles} px，逐行 ${JSON.stringify(webgl.holesPerRow)}`,
    );
    check(`盒线（─ × ${BLOCK_COLS}）线心无断点`, webgl.lineHoles === 0, `断点 ${webgl.lineHoles} px`);
    check(
      `中文（${CJK_TEXT}）画出来了`,
      webgl.cjkInk > 100,
      `墨 ${webgl.cjkInk} px`,
    );
    // 双宽判据：墨迹右缘应落在第 8 格附近（差半格以内）。按单宽算会落在第 4 格附近。
    const cjkExpected = CJK_TEXT.length * 2 * webgl.cell.w;
    check(
      `中文按双宽占 ${CJK_TEXT.length * 2} 个格子`,
      webgl.cjkRight + 1 > cjkExpected - 0.5 * webgl.cell.w &&
        webgl.cjkRight + 1 <= cjkExpected + 1,
      `右缘 ${webgl.cjkRight + 1}px，期望 ≈ ${cjkExpected.toFixed(1)}px`,
    );
    await shotPattern(main.page, join(OUT_DIR, 'glyphs-webgl.png'));
    check(
      '主组无 JS 错误',
      main.diagnostics.pageErrors.length === 0,
      main.diagnostics.pageErrors.slice(0, 3).join(' | '),
    );
    check(
      '主组无失败请求',
      main.diagnostics.badResponses.length === 0,
      main.diagnostics.badResponses.slice(0, 3).join(' | '),
    );
    check(
      '主组没走回退路径（没有 WebGL 不可用的告警）',
      !main.diagnostics.warnings.some((w) => w.includes('WebGL 渲染器不可用')),
      main.diagnostics.warnings.slice(0, 2).join(' | '),
    );

    // ---- 对照组：拿不到 WebGL2 → 退回 DOM 渲染器
    const control = await openTerminal(browser, BASE, { disableWebgl: true });
    const controlDom = await control.page.evaluate(() => ({
      canvases: document.querySelectorAll('.xterm-screen canvas').length,
      rowContainers: document.querySelectorAll('.xterm-rows').length,
    }));
    check(
      '对照组：拿不到 WebGL2 时确实退回 DOM 渲染器',
      controlDom.rowContainers >= 1 && controlDom.canvases === 0,
      `canvas=${controlDom.canvases} .xterm-rows=${controlDom.rowContainers}`,
    );
    check(
      '对照组：回退时发出了可观测的告警（不是静默）',
      control.diagnostics.warnings.some((w) => w.includes('WebGL 渲染器不可用')),
      control.diagnostics.warnings.slice(0, 2).join(' | '),
    );

    const fallback = await measure(control.page, cols, rows);
    logMeasure('对照组', fallback);
    check(
      '对照组：字体字形确实留缝（证明上面那条断言不是恒真的）',
      fallback.blockHoles > 0,
      `空洞 ${fallback.blockHoles} px，逐行 ${JSON.stringify(fallback.holesPerRow)}`,
    );
    await shotPattern(control.page, join(OUT_DIR, 'glyphs-dom.png'));

    console.log(`\n截图: ${join(OUT_DIR, 'glyphs-webgl.png')}`);
    console.log(`      ${join(OUT_DIR, 'glyphs-dom.png')}`);
  } finally {
    await browser.close();
    server.stop();
  }

  return summarize(results);
}

process.exitCode = await main();
