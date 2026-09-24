/**
 * 探针共用的「自带服务器」，以及会话管理的小工具。
 *
 * 为什么必须自带，而不是共用 `127.0.0.1:8765`：探针开始前要清空会话列表（同名会话会 409），
 * 拿它去打开发者正在跑的那个服务，就会把人家手里的会话全删掉——**验证工具反过来破坏工作现场**。
 * 再说共用一个端口也意味着两个探针不能并行跑。所以每个探针自带一个独立端口的服务，
 * 跑完保证收掉。
 *
 * 端口策略：先用探针自己声明的默认端口，被占了就往上找一个空闲的（最多 20 个）。
 * 于是「两个探针恰好声明了同一个端口」不会再变成偶发失败。
 *
 * 想打到已有的服务上（比如手工排查）：设 `PROBE_BASE`，此时**不**另起进程。
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';

import { BACKEND_DIR, PYTHON } from './env.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 找一个空闲端口：先试 `desired`，被占用就往上试，最多 `tries` 个。 */
async function freePort(desired, tries = 20) {
  for (let port = desired; port < desired + tries; port += 1) {
    const available = await new Promise((resolve) => {
      const probe = createServer();
      probe.once('error', () => resolve(false));
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    if (available) return port;
  }
  throw new Error(`从 ${desired} 起连续 ${tries} 个端口都被占用`);
}

/**
 * 起一个真实后端。
 *
 * @param {object} options
 * @param {number} options.port 期望端口（被占用时自动往上找）
 * @param {Record<string, string>} [options.env] 额外环境变量（例如小水位的背压参数）
 * @returns {Promise<{base: string, port: number, stop: () => void}>}
 */
export async function startServer({ port, env = {} }) {
  const override = process.env['PROBE_BASE'];
  if (override !== undefined) {
    // 打到已有服务上：不另起进程，也不要去杀它。
    return { base: override, port: Number(new URL(override).port), stop: () => {} };
  }

  const chosen = await freePort(port);
  const base = `http://127.0.0.1:${chosen}`;
  const child = spawn(PYTHON, ['-m', 'terminald', '--port', String(chosen)], {
    cwd: BACKEND_DIR,
    env: {
      ...process.env,
      PYTHONPATH: join(BACKEND_DIR, 'src'),
      TERMINALD_HOST_IMPL: 'pywezterm',
      TERMINALD_LOG_LEVEL: 'WARNING',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // 留一份 stderr 尾巴：起不来的时候，「等超时了」这种报错等于没说，得带上服务端自己的话。
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr = (stderr + String(chunk)).slice(-2000);
  });
  // 服务进程如果自己退了，没必要再等满 30 秒。
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !exited) {
    try {
      if ((await fetch(`${base}/api/healthz`)).ok) {
        return {
          base,
          port: chosen,
          stop: () => {
            child.kill();
          },
        };
      }
    } catch {
      /* 还没起来 */
    }
    await sleep(200);
  }

  child.kill();
  throw new Error(
    `服务端没起来（端口 ${chosen}）${exited ? '，进程已退出' : ''}` +
      (stderr === '' ? '' : `\n--- 服务端 stderr ---\n${stderr}`),
  );
}

/** 列出会话。 */
export async function listSessions(base) {
  return await (await fetch(`${base}/api/sessions`)).json();
}

/** 清空会话（探针要重复跑，同名会 409；也保证脚本开始时状态未知也无所谓）。 */
export async function resetSessions(base) {
  const listed = await listSessions(base);
  for (const session of listed) {
    await fetch(`${base}/api/sessions/${session.id}`, { method: 'DELETE' });
  }
  return listed.length;
}

/** 新建会话。 */
export async function createSession(base, name, argv) {
  const response = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, argv }),
  });
  if (!response.ok) throw new Error(`建会话失败 ${response.status}: ${await response.text()}`);
  return await response.json();
}

/** 探针的统一收尾：关闭浏览器、杀掉服务，并且把「第几项失败」打印出来返回退出码。 */
export function summarize(results) {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n共 ${results.length} 项，失败 ${failed.length} 项`);
  return failed.length === 0 ? 0 : 1;
}
