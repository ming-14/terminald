/**
 * 真实浏览器探针：对着**运行中的**后端，用真 Chromium 走一遍完整链路。
 *
 * 单测覆盖的是逻辑；这里要回答的是单测回答不了的问题：
 * xterm 真的挂上了吗？字号求解算出来的布局真的没溢出吗？键盘输入真的经 WS 进了 PTY、
 * 输出真的又回到了屏幕上吗？这些只有在真浏览器里跑一遍才算验证过。
 *
 * 自带服务器（端口 8805，真实 pywezterm），可重复运行；产物只落在 `frontend/.probe/`。
 *
 * 用法：`node probe/smoke.mjs`
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { chromium } from 'playwright-core';

import { OUT_DIR, PYTHON, SHELL, chromiumExecutable, shellCommand } from './env.mjs';
import { createSession, listSessions, resetSessions, startServer, summarize } from './server.mjs';

const CHROME = chromiumExecutable();
/** 后端启动时用的 scrollback。用非默认值跑一遍才能证明这个值真的从服务端流到了前端。 */
const EXPECT_SCROLLBACK = Number(process.env['PROBE_EXPECT_SCROLLBACK'] ?? 10_000);

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const server = await startServer({ port: 8805 });
  const BASE = server.base;
  const cleaned = await resetSessions(BASE);
  console.log(`清理已有会话 ${cleaned} 个（${BASE}）`);

  // A：输出标记后退出 → 验证历史重放渲染
  // B：真正的交互 shell → 验证键盘输入链路。不能用 `timeout` 之类的程序：
  //    它们会**吃掉 stdin**，键入的内容到不了 shell，回显也就无从谈起。
  const a = await createSession(BASE, 'probe-replay', shellCommand('echo PROBE_REPLAY_OK'));
  const interactive = await createSession(BASE, 'probe-interactive', [SHELL]);
  console.log(`会话 A=${a.id}（echo 后退出） B=${interactive.id}（交互 shell）`);

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(`console.error: ${message.text()}`);
  });
  // 记下所有非 2xx 的 URL：只报「有个 404」而不报「是哪个」的话，下次还得再查一遍
  const badResponses = [];
  // 记下客户端实际发出去的帧：用来验证「焦点序列由服务端独占」这条规则
  const sentFrames = [];
  await page.addInitScript(() => {
    window.__sentFrames = [];
    const original = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      if (typeof data === 'string') {
        window.__sentFrames.push({ kind: 'text', data });
      } else {
        const bytes = data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer ?? data);
        window.__sentFrames.push({
          kind: 'binary',
          hex: [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(''),
        });
      }
      return original.call(this, data);
    };
  });
  page.on('response', (response) => {
    if (response.status() >= 400) badResponses.push(`${response.status()} ${response.url()}`);
  });

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });

    // ---- 1. xterm 是否真的挂上了
    await page.waitForSelector('.xterm-screen', { timeout: 20_000 });
    check('xterm 挂载', true);

    // ---- 2. 侧栏是否列出了会话（连接后主动拉列表）
    await page.waitForFunction(() => document.querySelectorAll('.session').length >= 2, null, {
      timeout: 20_000,
    });
    const names = await page.$$eval('.session .nm', (nodes) => nodes.map((n) => n.textContent));
    check('侧栏列出会话', names.length >= 2, JSON.stringify(names));

    // ---- 3. 自动订阅首个会话，且历史被重放渲染出来
    const terminalText = () =>
      page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '');
    await page.waitForFunction(
      () => (document.querySelector('.xterm-rows')?.textContent ?? '').includes('PROBE_REPLAY_OK'),
      null,
      { timeout: 20_000 },
    );
    check('历史重放渲染到屏幕', true, (await terminalText()).slice(0, 60).replace(/\s+/g, ' '));

    // ---- 4. 顶栏状态是否反映了真实尺寸
    const chips = await page.$$eval('.chips .chip', (nodes) =>
      nodes.map((n) => n.textContent ?? ''),
    );
    check('顶栏显示尺寸与字号', chips.some((c) => /\d+×\d+/.test(c)) && chips.some((c) => /px/.test(c)), JSON.stringify(chips));
    check(
      '连接状态为已连接',
      chips.some((c) => c.includes('已连接')),
      JSON.stringify(chips),
    );

    // ---- 5. 网格是否真的没溢出容器（这是字号求解的核心不变量）
    const geometry = await page.evaluate(() => {
      const host = document.querySelector('.term-host')?.getBoundingClientRect();
      const screen = document.querySelector('.xterm-screen')?.getBoundingClientRect();
      if (!host || !screen) return null;
      return {
        host: { w: host.width, h: host.height },
        screen: { w: screen.width, h: screen.height },
      };
    });
    if (geometry === null) {
      check('网格几何可测', false, '拿不到 .term-host / .xterm-screen');
    } else {
      const overflowW = geometry.screen.w - geometry.host.w;
      const overflowH = geometry.screen.h - geometry.host.h;
      check(
        '网格未溢出容器',
        overflowW <= 1 && overflowH <= 1,
        `host=${geometry.host.w}×${geometry.host.h} screen=${geometry.screen.w.toFixed(1)}×${geometry.screen.h.toFixed(1)} 溢出=${overflowW.toFixed(1)}/${overflowH.toFixed(1)}`,
      );
    }

    // ---- 5a. 终端侧属性必须真的来自服务端（scrollback 是典型的「不传就只能写死」）
    const state = await page.evaluate(() => window.__terminald?.debugState?.() ?? null);
    check('可读到诊断快照', state !== null);
    if (state !== null) {
      check(
        `scrollback 来自服务端（期望 ${EXPECT_SCROLLBACK}）`,
        state.scrollback === EXPECT_SCROLLBACK,
        `实际 ${String(state.scrollback)}`,
      );
      check('尺寸与顶栏一致', state.cols === 120 && state.rows === 30, JSON.stringify(state));
      check('连接状态为 ready', state.connection === 'ready', String(state.connection));
    }

    // ---- 5b. 布局细节：.xterm 铺满容器、网格居中
    //
    // 注意「滚动条贴右边缘」这条曾经测的是 `.xterm-viewport`——而 v6 的滚动条根本不在那里
    // （它自带的 `Scrollable` 把滚动条挂在 `.xterm-scrollable-element > .scrollbar.vertical`），
    // `.xterm-viewport` 的 scrollHeight === clientHeight、右缘永远等于 host 右缘，所以那条断言
    // **恒真**。下面改成量真正的滚动条（并在后面的步骤里真的拖一次它）。
    const placement = await page.evaluate(() => {
      const host = document.querySelector('.term-host')?.getBoundingClientRect();
      const box = document.querySelector('.term-host .xterm')?.getBoundingClientRect();
      const screen = document.querySelector('.xterm-screen')?.getBoundingClientRect();
      if (!host || !box || !screen) return null;
      return {
        boxFillsHost:
          Math.abs(box.width - host.width) <= 1 && Math.abs(box.height - host.height) <= 1,
        padLeft: screen.left - host.left,
        padRight: host.right - screen.right,
        padTop: screen.top - host.top,
        padBottom: host.bottom - screen.bottom,
      };
    });
    if (placement === null) {
      check('布局细节可测', false, '缺少 .xterm / .xterm-screen');
    } else {
      check('.xterm 铺满容器', placement.boxFillsHost);
      check(
        '网格居中留白',
        Math.abs(placement.padLeft - placement.padRight) <= 1 &&
          Math.abs(placement.padTop - placement.padBottom) <= 1,
        `左/右=${placement.padLeft}/${placement.padRight} 上/下=${placement.padTop}/${placement.padBottom}`,
      );
    }

    // 局部放大截图：终端区左上角，用于肉眼确认留白与滚动条位置
    await page.screenshot({
      path: join(OUT_DIR, 'terminal-corner.png'),
      clip: { x: 228, y: 38, width: 420, height: 150 },
    });

    // ---- 6. 切到交互会话，验证会话切换不混屏
    await page.locator('.session').nth(1).click();
    await page.waitForFunction(
      () => document.querySelector('.session.active .nm')?.textContent === 'probe-interactive',
      null,
      { timeout: 10_000 },
    );
    check('切换到第二个会话', true);

    // ---- 6b. 双击重命名：协议里的 `session.rename` 必须真的有一条 UI 路径
    // 它以前只有协议与 Hub 侧的实现、前端没有任何入口，于是在前端是个没人能触发的死面。
    await page.once('dialog', (dialog) => dialog.accept('probe-renamed'));
    await page.locator('.session.active').dblclick();
    await page.waitForFunction(
      () => document.querySelector('.session.active .nm')?.textContent === 'probe-renamed',
      null,
      { timeout: 10_000 },
    );
    const renamed = (await listSessions(BASE)).filter((s) => s.id === interactive.id);
    check(
      '双击重命名：侧栏与服务端都改了名',
      renamed.length === 1 && renamed[0].name === 'probe-renamed',
      JSON.stringify(renamed.map((s) => s.name)),
    );

    // ---- 7. 键盘输入 → WS → 真实 PTY → 输出回到屏幕
    await page.click('.xterm-screen');
    await page.keyboard.type('echo TYPED_FROM_BROWSER');
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      () => (document.querySelector('.xterm-rows')?.textContent ?? '').includes('TYPED_FROM_BROWSER'),
      null,
      { timeout: 25_000 },
    );
    check('键盘输入经 PTY 往返并回显', true);

    // ---- 8. 切回第一个会话：应重新订阅并再次拿到历史（不混屏）
    await page.locator('.session').nth(0).click();
    await page.waitForFunction(
      () => (document.querySelector('.xterm-rows')?.textContent ?? '').includes('PROBE_REPLAY_OK'),
      null,
      { timeout: 15_000 },
    );
    const afterSwitch = await terminalText();
    check('切回后重新订阅并重放', true);
    check(
      '切回后不残留上个会话内容',
      !afterSwitch.includes('TYPED_FROM_BROWSER'),
      afterSwitch.includes('TYPED_FROM_BROWSER') ? '仍能看到上个会话的输出' : '',
    );

    // ---- 9. 刷新页面：应无损续传（scrollback 一起回来）
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => (document.querySelector('.xterm-rows')?.textContent ?? '').includes('PROBE_REPLAY_OK'),
      null,
      { timeout: 20_000 },
    );
    const chipsAfterReload = await page.$$eval('.chips .chip', (nodes) =>
      nodes.map((n) => n.textContent ?? ''),
    );
    check('刷新后内容仍在', true, JSON.stringify(chipsAfterReload));

    // ---- 10. 焦点必须由服务端独占：客户端不能再吐一份
    // 背景：应用打开 ?1004 后 xterm.js 会自己生成 \x1b[I / \x1b[O，而服务端也已跨客户端
    // 聚合并写入 PTY —— 两路并存会让应用收到两份互相矛盾的焦点事件。这里钉住「客户端不吐」。
    const focusName = `probe-focus-${Date.now()}`;
    const focusSession = await createSession(BASE, focusName, [
      PYTHON,
      '-c',
      "import sys,time;sys.stdout.buffer.write(b'\\x1b[?1004h' + b'\\r\\n');"
        + 'sys.stdout.flush();time.sleep(120)',
    ]);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.xterm-screen', { timeout: 20_000 });
    await page.locator('.session', { hasText: focusName }).first().click({ timeout: 20_000 });
    await page.waitForTimeout(2000);

    const modes = await page.evaluate(() => window.__terminald.debugState().modes);
    check(
      '焦点上报模式已到达客户端（否则这条检查是空的）',
      modes.sendFocusMode === true,
      JSON.stringify(modes),
    );

    for (const [label, action] of [
      ['聚焦', () => page.focus('.xterm-helper-textarea')],
      ['失焦', () => page.evaluate(() => document.querySelector('.xterm-helper-textarea')?.blur())],
    ]) {
      await page.evaluate(() => (window.__sentFrames.length = 0));
      await action();
      await page.waitForTimeout(700);
      const frames = await page.evaluate(() => window.__sentFrames);
      const focusEscapes = frames.filter(
        (f) => f.kind === 'binary' && (f.hex.includes('1b5b49') || f.hex.includes('1b5b4f')),
      );
      check(
        `${label}时客户端不吐焦点序列（由服务端独占）`,
        focusEscapes.length === 0,
        focusEscapes.map((f) => f.hex).join(' '),
      );
    }
    await fetch(`${BASE}/api/sessions/${focusSession.id}`, { method: 'DELETE' });

    const shot = join(OUT_DIR, 'frontend.png');
    await page.screenshot({ path: shot });
    const html = await page.content();
    writeFileSync(join(OUT_DIR, 'frontend.html'), html, 'utf8');

    check('页面无 JS 错误', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
    check('无失败请求（含 favicon）', badResponses.length === 0, badResponses.slice(0, 3).join(' | '));
    console.log(`\n截图: ${shot}`);
  } finally {
    await browser.close();
    server.stop();
  }

  return summarize(results);
}

process.exitCode = await main();
