import { fileURLToPath } from 'node:url';

// 用 vitest/config 的 defineConfig：它扩展了 vite 的类型，`test` 段才有类型检查
import { defineConfig } from 'vitest/config';

/**
 * 构建产物直接落到后端包内，由后端的 StaticFiles 同源托管。
 *
 * 这样做的收益是一整类问题的消失：不需要 CORS、不需要开发代理、不需要把后端端口编进
 * 前端产物里。代价是构建会写入 backend/ 目录，所以 `emptyOutDir` 必须显式打开
 * （outDir 在 root 之外时 Vite 默认拒绝清空）。
 */
const WEB_DIR = fileURLToPath(new URL('../backend/src/terminald/web', import.meta.url));

/**
 * 协议测试向量**只有一份**，在 `backend/src/terminald/protocol/vectors/basic.json`。
 *
 * 前端不复制一份，直接引用：复制出来就意味着两边可以悄悄漂移，而「谁抄错了」这种 bug
 * 只有靠测试才发现得了——那就干脆让它不可能漂移。任何一侧改了字节布局，前端测试立刻红。
 */
const VECTORS = fileURLToPath(
  new URL('../backend/src/terminald/protocol/vectors/basic.json', import.meta.url),
);

/**
 * 控制消息的字段形状契约（同样是后端生成的单一事实）。
 *
 * `basic.json` 钉的是「字节怎么排、几种消息的 JSON 长什么样」；这份钉的是「**每条**下行
 * 消息有哪些字段、什么类型」。前者只覆盖了 6 种消息，剩下 12 种的字段形状原先只能靠两边
 * 手抄——而前端对每条消息都做严格校验，后端动一个字段而前端不知道就会当场丢消息。
 */
const SHAPES = fileURLToPath(
  new URL('../backend/src/terminald/protocol/vectors/shapes.json', import.meta.url),
);

export default defineConfig({
  resolve: {
    alias: { '@protocol-vectors': VECTORS, '@protocol-shapes': SHAPES },
  },
  server: {
    // 开发服务器需要读 frontend/ 之外的向量文件
    fs: { allow: ['..'] },
  },
  build: {
    outDir: WEB_DIR,
    emptyOutDir: true,
    // 产物要给浏览器直接执行，不做 SSR 之类的分割
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
