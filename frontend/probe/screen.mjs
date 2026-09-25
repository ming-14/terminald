/**
 * 探针怎么看屏幕：**文本从模型取，像素从截图取**。
 *
 * 为什么要有这一层：前端换成了 WebGL 渲染器（见 `src/ui/app.ts`），它会 dispose 掉 DomRenderer，
 * 而 `.xterm-rows` 正是 DomRenderer 的元素——换完之后 DOM 里**没有**任何屏幕文本。
 * 原先六个探针各自写一遍 `document.querySelector('.xterm-rows')`，现在统一走这里；
 * 两件事因此有了唯一的实现：文本取自 `debugState().screenLines`，像素取自元素截图。
 *
 * 边界必须记住：`screenLines`/`screenText` 读的是**模型里的文本**，它不证明那段文字被画到了
 * 像素上——只证明「字节被解析进了缓冲区」。像素那一层由另外两处守：`probe/glyphs.mjs`
 * （逐格数空洞，管方块与盒线的绘制）和 `smoke.mjs` 里的 `countNonBackground`（管「屏幕上确实
 * 有东西，不是一片底色」）。加断言时别把这两层混起来说。
 */

/** 视口每行文本（右端空白已裁）；下标即视口行号（0 = 视口顶行）。 */
export async function screenLines(page) {
  return await page.evaluate(() => window.__terminald.debugState().screenLines);
}

/** 整屏文本，行间用 `\n` 连接。 */
export async function screenText(page) {
  return (await screenLines(page)).join('\n');
}

/**
 * 等屏幕上出现某个标记；超时抛错。
 *
 * `polling: 250` 而不是默认的 rAF：默认会在每一帧调用一次 `debugState()`，而它每次都要把
 * 整个视口拼成文本（30 行 × 每秒 60 次）。等待本来就以「秒」计，250ms 的粒度足够。
 *
 * 默认 60s：多数调用点等的是真实 PTY 吐出来的历史回放，给宽一点；需要更早失败就显式传 timeout。
 */
export async function waitForText(page, marker, timeout = 60_000) {
  await page.waitForFunction(
    (needle) =>
      (window.__terminald?.debugState?.().screenLines ?? []).some((line) => line.includes(needle)),
    marker,
    { timeout, polling: 250 },
  );
}

/**
 * 含标记的**最后一个**行号（视口 0 起），没有则 -1。
 *
 * 与原先从 DOM 行容器**倒着**找的行为一致：同一个标记可能出现多次（提示符每轮都有），
 * 而调用方要的是最近那一次的行号。
 */
export async function rowIndexOf(page, marker) {
  const lines = await screenLines(page);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].includes(marker)) return i;
  }
  return -1;
}

/**
 * 数元素截图里「非终端底色」的像素数。
 *
 * 这是**像素级**的判据：它不看模型、也不看 DOM，只看屏幕上真的有什么颜色。用途是给
 * 「文本类断言已经改成读模型」这件事兜底——否则整轮验证里没有任何一条能证明画面被画出来了。
 *
 * `target` 收两种：选择器字符串（截该元素），或 `{ clip }`（截页面上的一个矩形，用于只
 * 关心某一行时把光标之类无关的东西排除在外）。
 *
 * 在页面内解码再统计，不把像素传回 node：一张 1200×600 的图是 288 万个字节，序列化开销比
 * 统计本身大得多，而 node 侧没有内置 PNG 解码（`.probe/read-pixels.mjs` 当初也是绕回浏览器解的）。
 */
export async function countNonBackground(page, target, options = {}) {
  const background = options.background ?? (await terminalBackground(page));
  const tolerance = options.tolerance ?? 8;
  const shot =
    typeof target === 'string'
      ? await page.locator(target).screenshot()
      : await page.screenshot({ clip: target.clip });
  return await page.evaluate(
    async ({ b64, background, tolerance }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      let backgroundPixels = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (
          Math.abs(data[i] - background[0]) <= tolerance &&
          Math.abs(data[i + 1] - background[1]) <= tolerance &&
          Math.abs(data[i + 2] - background[2]) <= tolerance
        ) {
          backgroundPixels += 1;
        }
      }
      const total = data.length / 4;
      return {
        width: bitmap.width,
        height: bitmap.height,
        total,
        background: backgroundPixels,
        nonBackground: total - backgroundPixels,
      };
    },
    { b64: shot.toString('base64'), background, tolerance },
  );
}

/**
 * 终端底色，从页面的 `--term-bg` 读。
 *
 * 不在这里写死一份：这个色值已经同时存在于 `style.css` 的 CSS 变量与 `app.ts` 的
 * `THEME.background`（两处重复），探针再抄一份就是第三处——主题一改，断言会开始对着
 * 一片空白通过。
 *
 * 读不到就**抛错**而不是退回默认值：静默用错颜色，等于把断言变成恒真的。
 */
async function terminalBackground(page) {
  const rgb = await page.evaluate(() => {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--term-bg').trim();
    const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(raw);
    return hex === null ? null : [1, 2, 3].map((i) => parseInt(hex[i], 16));
  });
  if (rgb === null) {
    throw new Error('读不到 --term-bg（样式没加载，或这个变量被改名了）——无法判定「非底色像素」');
  }
  return rgb;
}
