/**
 * 平台事实探针：**ConPTY 不会把子进程的备用屏幕请求转给终端**。
 *
 * 起因是给「滚动位置记忆」写备用屏保护时，浏览器探针里 `debugState().altScreen` 一直是
 * false，而同一屏上的文本已经渲染出来了。两种可能：字节里根本没有这个序列，或者到了但
 * 被别的东西重置掉了。这个探针用**对照组**把「有没有」定死：
 *
 * 1. **管道**（没有 ConPTY）：同一个子进程、同一段代码，`\x1b[?1049h` 原样出现在字节流里
 *    —— 所以那个序列确实是子进程写的，不是它没写、也不是被 Python 吃掉了；
 * 2. **ConPTY**（走真实服务 + 裸 WS）：同一个子进程，字节流里**没有**这个序列，取而代之
 *    是 ConPTY 自己的重绘（`\x1b[H` + 逐行 `\x1b[K`）—— 也就是说，控制台自己切了缓冲区，
 *    终端这边从头到尾留在主缓冲区。
 *
 * 影响（写进 `docs/audit.md` 的平台小节）：在这台机器（Windows 10 19045）上，
 * 客户端**不可能**进入备用缓冲区，因此前端那条备用屏保护无法端到端验证；它保留是为了
 * 平台无关的正确性（Linux/pty，以及会转发该序列的 ConPTY 版本），但「在这里验证过」
 * 这句话是不成立的。
 *
 * 用法：`node probe/conpty-alt-screen.mjs`（自带服务器，端口 8804）
 */

import { spawn } from 'node:child_process';

import { PYTHON } from './env.mjs';
import { createSession, resetSessions, startServer, summarize } from './server.mjs';

const NEEDLE = Buffer.from('\x1b[?1049h', 'latin1');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const code = [
  'import sys,time',
  "sys.stdout.write('ALT-BEFORE\\r\\n')",
  "sys.stdout.write('\\x1b[?1049h')",
  "sys.stdout.write('ALT-AFTER\\r\\n')",
  'sys.stdout.flush()',
  'time.sleep(600)',
].join('\n');

/** 对照组：不经过 ConPTY，直接读子进程的 stdout。 */
function readThroughPipe() {
  return new Promise((resolve) => {
    const child = spawn(PYTHON, ['-c', code], { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    setTimeout(() => {
      child.kill();
      resolve(Buffer.concat(chunks));
    }, 2000);
  });
}

/** 实验组：走真实服务 + 真实 ConPTY，从裸 WS 上收字节。 */
async function readThroughConpty({ base }) {
  await resetSessions(base);
  const created = await createSession(base, 'conpty-alt', [PYTHON, '-c', code]);
  await sleep(2000);

  const collected = [];
  const socket = new WebSocket(`${base.replace('http', 'ws')}/ws`);
  socket.binaryType = 'arraybuffer';
  socket.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') collected.push(Buffer.from(event.data));
  });
  await new Promise((resolve) => socket.addEventListener('open', resolve));
  socket.send(JSON.stringify({ t: 'hello', protocol: 1, client: 'probe-conpty-alt' }));
  await sleep(500);
  socket.send(JSON.stringify({ t: 'attach', session: created.id, resume: null }));
  await sleep(2500);
  socket.close();
  // 帧头（长度 u32 + tag u8）会散在中间，但 8 字节的序列不会被 64 KiB 的分片切开，
  // 所以直接在整段里找即可
  return Buffer.concat(collected);
}

async function main() {
  const piped = await readThroughPipe();
  console.log(`对照组（管道）${piped.length} 字节：${JSON.stringify(piped.toString('latin1').slice(0, 120))}`);
  const inPipe = piped.includes(NEEDLE);
  check('子进程确实写了 \\x1b[?1049h（管道里能看到）', inPipe, `管道里${inPipe ? '有' : '没有'}`);

  const server = await startServer({ port: 8804 });
  try {
    const conpty = await readThroughConpty(server);
    console.log(`实验组（ConPTY）${conpty.length} 字节，前 240 字节：`);
    console.log(JSON.stringify(conpty.toString('latin1').slice(0, 240)));
    const inConpty = conpty.includes(NEEDLE);
    check(
      '终端侧收到的那条字节流里**没有** \\x1b[?1049h（ConPTY 吃掉了）',
      !inConpty,
      `ConPTY 流里${inConpty ? '有' : '没有'}`,
    );
    check(
      '同一对标记（切换前后各一行）都在，说明丢的只是那个模式切换',
      conpty.includes(Buffer.from('ALT-BEFORE')) && conpty.includes(Buffer.from('ALT-AFTER')),
      '',
    );
  } finally {
    server.stop();
  }

  process.exitCode = summarize(results);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
