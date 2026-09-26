/**
 * 依次跑完全部探针，**中途失败不停下**，最后汇总退出码。
 *
 * 为什么需要这样一层：以前 `probe:all` 是一条 `&&` 链，第一个红的探针会把它后面几个
 * 全部吃掉——于是「全部探针都跑过了」这句话在失败时是不成立的，而一次几分钟的回归只换来
 * 一个失败信息，修完再跑又可能撞上下一个。这里把每一份结果一次性收集起来
 * （探针个数会变，所以下面一律用 `PROBES.length` 说事，不写死数字）。
 *
 * 退出码：任何一个探针失败 → 1（CI 与 `npm run probe:all` 都不会把红当绿）。
 * 每个探针各自起服务、各自收尾，所以这里只负责顺序与汇总。
 *
 * 用法：`node probe/all.mjs`（等价于 `npm run probe:all`）
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROBE_DIR = dirname(fileURLToPath(import.meta.url));

/** 顺序与 `probe/README.md` 的表一致；全部跑完，不做短路。 */
const PROBES = [
  'smoke',
  'glyphs',
  'multi-client',
  'scrollback',
  'remember',
  'resize',
  'input-hold',
  'shortcuts',
  'conpty-modes',
];

const failed = [];
const started = Date.now();

for (const name of PROBES) {
  console.log(`\n──────── ${name} ────────`);
  const result = spawnSync(process.execPath, [join(PROBE_DIR, `${name}.mjs`)], {
    stdio: 'inherit',
  });
  if (result.status !== 0) failed.push(name);
}

const seconds = ((Date.now() - started) / 1000).toFixed(0);
if (failed.length === 0) {
  console.log(`\n全部 ${PROBES.length} 个探针通过（${seconds}s）`);
} else {
  console.log(`\n${failed.length}/${PROBES.length} 个探针失败：${failed.join('、')}（${seconds}s）`);
}
process.exitCode = failed.length === 0 ? 0 : 1;
