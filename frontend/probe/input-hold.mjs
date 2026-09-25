/**
 * 真实浏览器探针：输入背压在**浏览器里**到底长什么样。
 *
 * 单测用的是假 socket（状态机对了），服务端的探针用的是裸 WS 客户端（协议对了）。这里补的是
 * 中间那一层没验过的东西：真 xterm 的 onData → 真前端 → 真 WS；暂缓真的可见吗？暂缓期间
 * 本端真的在排队而不是在发吗？被暂缓住的那条连接**不拖累控制面**吗？
 *
 * 自带服务器（端口 8801，真实 pywezterm + 小水位），所以可以直接构造：
 *
 * - 会话 `held`：子进程把 stdin 切到 VT 输入模式后**每 4 KiB 睡 50 ms**（≈ 80 KiB/s）。
 *   往它粘贴一大块 → 服务端写队列排不出去 → 下发 `input_hold{paused:true}`，而且会
 *   稳定持续（用「完全不读 stdin」反而不可靠：ConPTY 自己的输入缓冲会先吞掉几 MiB，
 *   队列随之排水、正常放行——实测踩过）。
 * - 会话 `other`：真 shell，用来证明“一个会话被暂缓住”不影响整个应用。
 *
 * 用法：`node probe/input-hold.mjs`（会自己起服务、自己清会话、结束杀掉服务）。
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { chromium } from 'playwright-core';

import { CHROMIUM_ARGS, OUT_DIR, SHELL, PYTHON, chromiumExecutable } from './env.mjs';
import { waitForText } from './screen.mjs';
import { createSession, resetSessions, startServer, summarize } from './server.mjs';

const COMSPEC = SHELL;

/** 由 `main` 在服务起来后赋值；其余函数都通过它访问服务。 */
let BASE = '';
const CHROME = chromiumExecutable();

/**
 * 粘贴量：远大于服务端高水位（64 KiB）。
 *
 * 真正常约束的不是高水位，而是**子进程的排水速率**：`held` 的慢读子进程每秒只吃掉
 * 约 80 KiB，所以几 MiB 能让写队列在采样窗口内稳稳高于低水位（16 KiB）。
 *
 * 为什么是 4 MiB 而不是“够用就好”的 2 MiB：ConPTY 自己还有一层输入缓冲，实测它会
 * 把整段粘贴**一次吞掉**——那时服务端队列随之排水、正常放行，暂缓窗口在断言开始前就
 * 结束了（就是同一条用例偶发假红的原因）。缓冲量级是 MiB 级的，所以压得比它大。
 * 上界由服务端 `TERMINALD_INPUT_HARD_BYTES`（本探针设成 8 MiB）兜着。
 */
const PASTE_BYTES = 4 * 1024 * 1024;

/**
 * `held` 会话的子进程：把控制台切到 VT 输入模式（关掉行缓冲/回显），然后以约 80 KiB/s
 * 的速度吃掉输入。这样背压是**稳定的**：服务端写队列卡在高水位之上，暂缓状态可以被稳定观测。
 */
const SLOW_READER = [
  '-c',
  [
    'import ctypes, sys, time',
    'k = ctypes.WinDLL("kernel32")',
    'k.SetConsoleMode(k.GetStdHandle(-10), 0x0200)  # ENABLE_VIRTUAL_TERMINAL_INPUT',
    'while True:',
    '    chunk = sys.stdin.buffer.read(4096)',
    '    if not chunk:',
    '        break',
    '    time.sleep(0.05)',
  ].join('\n'),
];


const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isHeld = (page) =>
  page.evaluate(() => window.__terminald?.debugState?.().inputHeld === true);

/**
 * 确认「此刻确实被暂缓」，必要时再压一批把它顶过高水位。
 *
 * 这个前提必须在使用它的动作**紧邻处**确认，不能只在前面某一步确认过：暂缓窗口的长度
 * 取决于服务端写队列的排水速度，而那个速度里含 ConPTY 自己的缓冲（见 `PASTE_BYTES`）。
 * 它偶发地在十几毫秒里就把整段粘贴吞掉并放行——那种情况下客户端把随后的输入发出去是
 * **正确行为**，而断言会假红。重试而不是放宽断言：先确保前提成立，再去断言结论。
 */
async function ensureHeld(page, chunk, attempts = 4) {
  for (let i = 0; i < attempts; i += 1) {
    if (await isHeld(page)) return true;
    await page.keyboard.insertText(chunk);
    await page
      .waitForFunction(
        () => window.__terminald?.debugState?.().inputHeld === true,
        null,
        { timeout: 10_000 },
      )
      .catch(() => {});
  }
  return await isHeld(page);
}

//: 二进制帧的字节大小含 5 字节帧头（长度 u32 + tag u8），所以“18 字节负载”在日志里是 23
const FRAME_HEADER = 5;
/** 记录发出去的帧序号（**未过滤**的数组下标——拿过滤后的计数去切原数组会数错，踩过）。 */
const sentCount = (page) => page.evaluate(() => window.__sentFrames.length);
/** 取某个序号之后发出的二进制帧（含帧头大小）。 */
const binarySince = (page, before) =>
  page.evaluate(
    (index) =>
      window.__sentFrames
        .slice(index)
        .filter((frame) => frame.kind === 'binary')
        .map((frame) => ({ payload: frame.size - 5, size: frame.size })),
    before,
  );

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const server = await startServer({
    port: 8801,
    // 小水位：让背压在这个探针的时间尺度内稳定可观测
    env: {
      TERMINALD_INPUT_HIGH_BYTES: '65536',
      TERMINALD_INPUT_LOW_BYTES: '16384',
      TERMINALD_INPUT_HARD_BYTES: '8388608',
    },
  });
  BASE = server.base;
  let browser;
  try {
    await resetSessions(BASE);
    // held 先建：应用会先订阅它（列表里的第一个）
    const held = await createSession(BASE, 'held', [PYTHON, ...SLOW_READER]);
    const other = await createSession(BASE, 'other', [COMSPEC]);
    console.log(`会话 held=${held.id} other=${other.id}`);

    browser = await chromium.launch({ executablePath: CHROME, headless: true, args: CHROMIUM_ARGS });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') pageErrors.push(`console.error: ${message.text()}`);
    });
    // 记下客户端发出去的帧：用来断言“暂缓期间本端真的没有再发输入”
    await page.addInitScript(() => {
      window.__sentFrames = [];
      const original = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        if (typeof data === 'string') {
          window.__sentFrames.push({ kind: 'text', data });
        } else {
          const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer ?? data);
          window.__sentFrames.push({ kind: 'binary', size: bytes.byteLength });
        }
        return original.call(this, data);
      };
    });

    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.xterm-screen', { timeout: 20_000 });

    // ---- 订阅 held
    const card = page.locator('.session', { hasText: 'held' }).first();
    await card.click();
    await page.waitForFunction(
      () => window.__terminald?.debugState?.().session === new URLSearchParams(location.search).get('s'),
      null,
      { timeout: 5_000 },
    ).catch(() => {});
    const debugState = () => page.evaluate(() => window.__terminald?.debugState?.() ?? null);
    await page.waitForFunction(
      () => (window.__terminald?.debugState?.().session ?? null) !== null,
      null,
      { timeout: 10_000 },
    );
    const attachedTo = (await debugState()).session;
    check('已订阅 held 会话', attachedTo === held.id, `session=${attachedTo}`);

    // ---- 粘贴一大块：远超服务端高水位
    // 必须先把焦点交给终端：xterm 的输入走它自己的隐藏 textarea，
    // `insertText` 只会送给**当前聚焦**的元素（不聚焦就是 0 帧，实测踩过）。
    await page.locator('.xterm-screen').click();
    await page.waitForFunction(
      () => document.activeElement?.classList.contains('xterm-helper-textarea') === true,
      null,
      { timeout: 5_000 },
    );
    check('终端取得输入焦点', true);
    const paste = 'P'.repeat(PASTE_BYTES);
    const beforePaste = await sentCount(page);
    await page.keyboard.insertText(paste);
    await sleep(200); // 让 xterm 把这段文字走完 onData（insertText 的返回早于它的处理）
    const pasteSent = await binarySince(page, beforePaste);
    const pasteBytes = pasteSent.reduce((sum, frame) => sum + frame.payload, 0);
    check(
      '粘贴经 xterm → WS 发出（二进制帧）',
      pasteBytes >= PASTE_BYTES,
      `${pasteSent.length} 帧，负载共 ${pasteBytes} 字节`,
    );

    // ---- 服务端暂缓下来（held 会话不读 stdin，所以不会被很快放行）
    await page.waitForFunction(
      () => window.__terminald?.debugState?.().inputHeld === true,
      null,
      { timeout: 15_000 },
    );
    const state = await debugState();
    check('服务端暂缓已下发', state.inputHeld === true);
    const chips = await page.$$eval('.chips .chip', (nodes) => nodes.map((n) => n.textContent ?? ''));
    check('顶栏显示“输入排队中”', chips.some((c) => c.includes('输入排队中')), JSON.stringify(chips));

    // ---- 暂缓期间继续输入：必须排在本端，一字节都不许发出去
    // 先解一个前提：此刻仍然被暂缓。它可能在上一条断言与这里之间已经放行——那时下面的
    // 断言没有意义（客户端发出去才是对的），所以这里重新压一次并把它变成一条明说的断言。
    const heldBeforeTyping = await ensureHeld(page, 'z'.repeat(1024 * 1024));
    check(
      '开始采样前仍处于暂缓（否则「排在本端」这条断言无从谈起）',
      heldBeforeTyping,
      heldBeforeTyping ? '' : '重压之后仍然被放行：ConPTY 吃掉了整段粘贴',
    );

    const beforeTyping = await sentCount(page);
    const queued = 'queued-input-while-held';
    await page.keyboard.insertText(queued);
    // 采样状态变化轨迹：如果是“放行→又暂缓”，状态会跳，而默认它应该一直是 held
    const timeline = [];
    for (let i = 0; i < 8; i += 1) {
      const snapshot = await debugState();
      timeline.push(`${snapshot.inputHeld ? 'held' : 'free'}:${snapshot.heldInputBytes}`);
      await sleep(50);
    }
    const afterTyping = await binarySince(page, beforeTyping);
    const held2 = await debugState();
    check(
      '暂缓期间的输入没有发出去（排在本端）',
      afterTyping.length === 0 && held2.inputHeld === true,
      `新发 ${afterTyping.length} 帧${afterTyping.length ? `（负载 ${afterTyping.map((f) => f.payload).join(',')}）` : ''}，` +
        `heldInputBytes=${held2.heldInputBytes}，状态轨迹=${timeline.join(' ')}`,
    );
    check('本端确实在排队', held2.heldInputBytes >= queued.length, `${held2.heldInputBytes} 字节`);
    await page.screenshot({ path: join(OUT_DIR, 'input-hold.png') });

    // ---- 控制面：一个会话被暂缓住，不影响切换会话与在新会话里工作
    await page.locator('.session', { hasText: 'other' }).first().click();
    await page.waitForFunction(
      (id) => window.__terminald?.debugState?.().session === id,
      other.id,
      { timeout: 10_000 },
    );
    check('被暂缓期间可以切换会话（控制面没被堵住）', true);
    const afterSwitch = await debugState();
    check(
      '切会话时丢掉上个订阅排队的输入（它无法在新会话里补发）',
      afterSwitch.heldInputBytes === 0 && afterSwitch.inputHeld === false,
      `held=${afterSwitch.inputHeld} 排队=${afterSwitch.heldInputBytes} 字节`,
    );

    await page.locator('.xterm-screen').click();
    await page.keyboard.insertText('echo PROBE_HOLD_OK\r');
    await waitForText(page, 'PROBE_HOLD_OK', 20_000);
    check('被暂缓期间新会话的键盘输入仍然有效', true);

    const finalState = await debugState();
    const allFrames = await page.evaluate(() =>
      window.__sentFrames.map((f) => (f.kind === 'binary' ? `bin:${f.size}` : f.data)),
    );
    console.log(`  帧序列：${allFrames.join(' ')}`);
    console.log(
      `  最终状态：connection=${finalState.connection} 会话=${String(finalState.session)} held=${finalState.inputHeld}`,
    );
    check('连接始终为 ready', finalState.connection === 'ready', String(finalState.connection));
    check('页面无 JS 错误', pageErrors.length === 0, pageErrors.join(' | '));
  } finally {
    if (browser) await browser.close();
    server.stop();
  }

  process.exitCode = summarize(results);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
