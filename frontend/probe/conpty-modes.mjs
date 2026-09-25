/**
 * 平台事实探针：**宿主（ConPTY 实现）会把子进程的哪些模式序列转给客户端**。
 *
 * 这台机器上的宿主是随包侧载的 OpenConsole（`vendor/pywezterm/OpenConsole.exe`，见
 * `docs/architecture.md` §12）—— 它比系统 conhost 新，转译行为也不同：备用屏现在**会**
 * 到达客户端，而 `?7l`/`4h` 这类反而被它自己消化掉了。
 *
 * 为什么要一张会红的表：客户端能不能收到鼠标模式、能不能进备用屏，取决于**宿主**而不是
 * 我们。换宿主（例如侧载失效回落到系统 conhost）时，这张表必须跟着变，否则
 * `docs/architecture.md` §12 与前端那条备用屏保护就会变成"看起来验过、其实早就不成立"。
 *
 * 实测方式（三层，缺一层结论就不成立）：
 * 1. **管道**：同一个子进程、同一段代码——所有序列都在，证明"子进程确实写了"；
 * 2. **子进程批**：走真实服务 + 真实 ConPTY，从裸 WS 上收字节，逐条看它在不在；
 * 3. **空会话**：什么都不写的子进程——宿主自己启动时就会发几条（`?1004h`、`?9001h`），
 *    不能把它们算成"转发了子进程的"。
 *
 * 另有一条**标记行**断言：每条序列后面跟一行 `MKnn`，必须 23/23 都在。子进程在 ConPTY
 * 就绪前写的行会被整段丢掉（实测丢过前 8 行），少了这条，"序列不在流里"就可能是采集
 * 假象而不是被吞。
 *
 * 用法：`node probe/conpty-modes.mjs`（自带服务器，端口 8804）
 */

import { spawn } from 'node:child_process';

import { PYTHON } from './env.mjs';
import { createSession, resetSessions, startServer, summarize } from './server.mjs';

/**
 * 逐条实测的结果（2026-09-25，宿主 = 侧载 OpenConsole）。
 *
 * - `forward`：子进程写的序列出现在客户端收到的字节流里
 * - `swallow`：不在（宿主自己消化了）
 * - `host`：宿主自己启动时也会发，无法与"转发"区分
 */
const CASES = [
  { seq: '\x1b[?1000h', label: '鼠标追踪 1000（X10）', verdict: 'swallow' },
  { seq: '\x1b[?1002h', label: '鼠标追踪 1002（按钮事件）', verdict: 'swallow' },
  { seq: '\x1b[?1003h', label: '鼠标追踪 1003（任意事件）', verdict: 'swallow' },
  { seq: '\x1b[?1005h', label: 'UTF-8 鼠标编码', verdict: 'swallow' },
  { seq: '\x1b[?1006h', label: 'SGR 鼠标编码', verdict: 'swallow' },
  { seq: '\x1b[?1015h', label: 'URXVT 鼠标编码', verdict: 'forward' },
  { seq: '\x1b[?1016h', label: 'SGR 像素坐标', verdict: 'forward' },
  { seq: '\x1b[?1h', label: 'DECCKM 应用光标键', verdict: 'swallow' },
  { seq: '\x1b[?6h', label: '原点模式', verdict: 'swallow' },
  { seq: '\x1b[?7l', label: '自动换行关', verdict: 'swallow' },
  { seq: '\x1b[?12h', label: '光标闪烁', verdict: 'forward' },
  { seq: '\x1b[?25l', label: '隐藏光标', verdict: 'forward' },
  { seq: '\x1b[?45h', label: '反向换行', verdict: 'forward' },
  { seq: '\x1b[?66h', label: '应用键盘', verdict: 'swallow' },
  { seq: '\x1b[?1004h', label: '焦点上报', verdict: 'host' },
  { seq: '\x1b[?2004h', label: 'bracketed paste', verdict: 'forward' },
  { seq: '\x1b[?2026h', label: '同步输出', verdict: 'forward' },
  { seq: '\x1b[?1049h', label: '备用屏（1049）', verdict: 'forward' },
  { seq: '\x1b[?1047h', label: '备用屏（1047）', verdict: 'forward' },
  { seq: '\x1b[?47h', label: '备用屏（47）', verdict: 'forward' },
  { seq: '\x1b[?9001h', label: 'win32 输入模式', verdict: 'host' },
  { seq: '\x1b[4h', label: '插入模式（SM 4）', verdict: 'swallow' },
  { seq: '\x1b[20h', label: 'LNM 换行（SM 20）', verdict: 'swallow' },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const marker = (index) => `MK${String(index).padStart(2, '0')}`;

/** 子进程：等宿主就绪后逐条写出「序列 + 标记行」，每条之间留一点间隔。 */
const BATCH_CODE = [
  'import sys,time',
  'w = sys.stdout.buffer',
  // 先等控制台就绪：就绪前写的行会被整段丢掉（实测丢过前 8 行），那会让判定失真
  'time.sleep(1.5)',
  ...CASES.flatMap(({ seq }, index) => [
    `w.write(${JSON.stringify(seq)}.encode('latin1'))`,
    `w.write(b'${marker(index)}\\r\\n')`,
    'w.flush()',
    'time.sleep(0.05)',
  ]),
  'time.sleep(600)',
].join('\n');

/** 空会话：什么都不写，只用来看宿主自己启动时发了什么。 */
const EMPTY_CODE = 'import time\ntime.sleep(600)';

/** 对照组：不经过 ConPTY，直接读子进程的 stdout。 */
function readThroughPipe() {
  return new Promise((resolve) => {
    const child = spawn(PYTHON, ['-c', BATCH_CODE], { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    // 窗口要够长：子进程自己要等 1.5s，再加 23 × 50ms
    setTimeout(() => {
      child.kill();
      resolve(Buffer.concat(chunks));
    }, 4500);
  });
}

/** 实验组：走真实服务 + 真实 ConPTY，从裸 WS 上收字节。 */
async function readThroughConpty(base, name, pyCode) {
  await resetSessions(base);
  const created = await createSession(base, name, [PYTHON, '-c', pyCode]);
  await sleep(2500);

  const collected = [];
  const socket = new WebSocket(`${base.replace('http', 'ws')}/ws`);
  socket.binaryType = 'arraybuffer';
  socket.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') collected.push(Buffer.from(event.data));
  });
  await new Promise((resolve) => socket.addEventListener('open', resolve));
  socket.send(JSON.stringify({ t: 'hello', protocol: 1, client: 'probe-conpty-modes' }));
  await sleep(500);
  socket.send(JSON.stringify({ t: 'attach', session: created.id, resume: null }));
  await sleep(3500);
  socket.close();
  // 帧头（长度 u32 + tag u8）会散在中间，但 8 字节以内的序列不会被 64 KiB 的分片切开，
  // 所以直接在整段里找即可
  return Buffer.concat(collected);
}

async function main() {
  const piped = await readThroughPipe();
  const server = await startServer({ port: 8804 });
  try {
    const batch = await readThroughConpty(server.base, 'conpty-modes', BATCH_CODE);
    const empty = await readThroughConpty(server.base, 'conpty-modes-empty', EMPTY_CODE);
    console.log(
      `管道 ${piped.length} 字节 / 子进程批 ${batch.length} 字节 / 空会话 ${empty.length} 字节\n`,
    );

    const written = CASES.filter(({ seq }) => piped.includes(Buffer.from(seq, 'latin1')));
    check(
      '子进程确实写下了全部序列（管道对照，缺一条结论就不成立）',
      written.length === CASES.length,
      `${written.length}/${CASES.length} 在管道里`,
    );

    const missingMarkers = CASES.map((_, index) => marker(index)).filter(
      (m) => !batch.includes(Buffer.from(m)),
    );
    check(
      `标记行 ${CASES.length}/${CASES.length} 都在（否则"不在流里"可能只是采集假象）`,
      missingMarkers.length === 0,
      missingMarkers.length === 0 ? '' : `缺 ${missingMarkers.join(' ')}`,
    );

    for (const { seq, label, verdict } of CASES) {
      const needle = Buffer.from(seq, 'latin1');
      const inBatch = batch.includes(needle);
      const inEmpty = empty.includes(needle);
      const actual = inBatch && inEmpty ? 'host' : inBatch ? 'forward' : 'swallow';
      const expected =
        verdict === 'forward' ? '转发到客户端' : verdict === 'swallow' ? '被宿主吞掉' : '宿主自发';
      check(
        `${label} ${JSON.stringify(seq)}：${expected}`,
        actual === verdict,
        actual === verdict ? '' : `实测是 ${actual}`,
      );
    }
  } finally {
    server.stop();
  }

  process.exitCode = summarize(results);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
