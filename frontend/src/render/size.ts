/**
 * 尺寸求解：把固定的 `cols × rows` 网格铺进可变的容器。
 *
 * 这是本项目前端唯一「数学」的地方，所以它被写成**纯函数**：输入容器尺寸与实测的单格比例，
 * 输出字号 / 行高倍数 / 字距。DOM 相关的测量只有 `measureCellAspect` 一个薄封装。
 *
 * ## 为什么字号是因变量
 *
 * `cols` / `rows` 由终端侧决定（见 `docs/architecture.md` §4），浏览器可视面积**永不**参与。
 * 于是前端的任务不是「让终端去适应窗口」，而是「求一个让网格铺满的字号」。字号是结果，
 * 不是输入。
 *
 * ## 求解顺序
 *
 * 1. 两个方向上各算一个字号上限：`W / (cols × 单格宽/字号)` 与 `H / (rows × 名义行高)`
 * 2. 取较小者——它决定哪个轴是**受限轴**，另一轴必然有余量
 * 3. 吸附（可选）：**只向下**取到步进的整数倍。向上取会让 `cols × 单格宽 > W` 直接溢出
 * 4. 受限轴：行高倍数精确解出 `H / (rows × fontSize)`，但钳在 `[min, max]`
 *    —— 无限拉大行高只会让字看起来是断开的
 * 5. 另一轴：把余量放进整数像素的字距里（xterm 的 `letterSpacing` 只吃整数），有上限
 * 6. 剩下的余量居中留白。**不拉伸字形**
 *
 * 不变量：`usedW <= containerW` 且 `usedH <= containerH`，永远不溢出。
 */

/** 名义行高倍数：估第一个字号上限时用的初始值。 */
export const NOMINAL_LINE_HEIGHT = 1.3;
/** 行高倍数的合法区间：再小会切字，再大显得断开。 */
export const MIN_LINE_HEIGHT = 1.05;
export const MAX_LINE_HEIGHT = 1.6;
/** 字号吸附步进（px）。 */
export const SNAP_STEP = 0.5;
/** 字距上限（px）：超过这个值字符之间就明显脱节了。 */
export const MAX_LETTER_SPACING = 4;

export interface LayoutInput {
  readonly containerW: number;
  readonly containerH: number;
  readonly cols: number;
  readonly rows: number;
  /** 单格宽 ÷ 字号。必须**实测**，不同字体的比例不同，猜不得。 */
  readonly cellAspect: number;
  readonly snapStep?: number;
  readonly nominalLineHeight?: number;
  readonly minLineHeight?: number;
  readonly maxLineHeight?: number;
  readonly maxLetterSpacing?: number;
  /** 允许的最小字号；低于它认为容器装不下，返回 null */
  readonly minFontSize?: number;
  /**
   * 字号上限。实测校正时用它把字号压到「上一轮再退一档」，
   * 否则同样的输入会解出同样的字号，校正循环原地打转。
   */
  readonly maxFontSize?: number;
}

export interface Layout {
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly letterSpacing: number;
  readonly cellW: number;
  readonly cellH: number;
  readonly usedW: number;
  readonly usedH: number;
  /** 居中留白 */
  readonly padX: number;
  readonly padY: number;
  /** 哪根轴卡住了字号 */
  readonly bindingAxis: 'width' | 'height';
  readonly snapped: boolean;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/**
 * 求解布局。容器装不下（字号会低于 `minFontSize`）时返回 `null`，
 * 由调用方决定怎么提示——不要偷偷把字号压到看不清。
 */
export function solveLayout(input: LayoutInput): Layout | null {
  const {
    containerW,
    containerH,
    cols,
    rows,
    cellAspect,
    snapStep = SNAP_STEP,
    nominalLineHeight = NOMINAL_LINE_HEIGHT,
    minLineHeight = MIN_LINE_HEIGHT,
    maxLineHeight = MAX_LINE_HEIGHT,
    maxLetterSpacing = MAX_LETTER_SPACING,
    minFontSize = 6,
    maxFontSize,
  } = input;

  if (cols <= 0 || rows <= 0) throw new RangeError('cols / rows 必须为正');
  if (!Number.isFinite(cellAspect) || cellAspect <= 0) {
    throw new RangeError(`cellAspect 必须为正有限数: ${cellAspect}`);
  }
  if (containerW <= 0 || containerH <= 0) return null;

  const fsByWidth = containerW / (cols * cellAspect);
  const fsByHeight = containerH / (rows * nominalLineHeight);

  let fontSize = Math.min(fsByWidth, fsByHeight);
  const snapped = snapStep > 0;
  const floorToStep = (value: number): number =>
    snapStep > 0 ? Math.floor(value / snapStep) * snapStep : value;
  if (snapped) {
    // 只向下吸附：向上会让网格宽/高超过容器，直接溢出
    fontSize = floorToStep(fontSize);
  }
  if (maxFontSize !== undefined) {
    // 压上限时同样向下对齐到步进，保持「字号总是步进的整数倍」这个性质
    fontSize = Math.min(fontSize, floorToStep(maxFontSize));
  }
  if (fontSize < minFontSize) return null;

  const bindingAxis: 'width' | 'height' = fsByWidth <= fsByHeight ? 'width' : 'height';

  const lineHeight = clamp(containerH / rows / fontSize, minLineHeight, maxLineHeight);
  const letterSpacing = clamp(
    Math.floor(containerW / cols - fontSize * cellAspect),
    0,
    maxLetterSpacing,
  );

  const cellW = fontSize * cellAspect + letterSpacing;
  const cellH = fontSize * lineHeight;
  const usedW = cellW * cols;
  const usedH = cellH * rows;

  return {
    fontSize,
    lineHeight,
    letterSpacing,
    cellW,
    cellH,
    usedW,
    usedH,
    padX: Math.max(0, containerW - usedW) / 2,
    padY: Math.max(0, containerH - usedH) / 2,
    bindingAxis,
    snapped,
  };
}

/**
 * 实测「单格宽 ÷ 字号」。
 *
 * 必须实测：不同字体、不同平台、不同 DPI 下这个比例都不同，用 0.6 之类的经验值会让网格
 * 差出好几列。做法是放一个不可见的探针元素，按 100px 字号量出多个字符的宽度再折算
 * ——大字号测量能把亚像素误差摊薄。
 *
 * **不要用 `font` 简写属性**：它包含 `font-size`，写在后面会把 100px 覆盖成别的值，
 * 于是量出来的比例整体偏小若干倍（真踩过：探针实际以 14px 渲染，比例量成 0.080，
 * 被 `isPlausibleCellAspect` 拦下）。所以这里只用长属性。
 *
 * 这是整个模块里唯一碰 DOM 的函数，逻辑简单到不值得造假 DOM 去测；它的**合理性**由一个
 * 上界检查兜住（见 `isPlausibleCellAspect`），并由浏览器探针端到端验证。
 */
export function measureCellAspect(
  doc: Document,
  fontFamily: string,
  sample = 'MMMMMMMMMM',
): number {
  const probe = doc.createElement('span');
  probe.textContent = sample;
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  probe.style.whiteSpace = 'pre';
  probe.style.left = '-9999px';
  probe.style.top = '0';
  // 与 xterm 的默认渲染保持一致：正常字重、正常字形
  probe.style.fontWeight = '400';
  probe.style.fontStyle = 'normal';
  probe.style.fontSize = `${PROBE_FONT_SIZE_PX}px`;
  probe.style.lineHeight = '1';
  probe.style.fontFamily = fontFamily;

  doc.body.appendChild(probe);
  try {
    const width = probe.getBoundingClientRect().width;
    return width / sample.length / PROBE_FONT_SIZE_PX;
  } finally {
    probe.remove();
  }
}

/** 测量用的字号：大一点可以把亚像素舍入误差摊薄。 */
export const PROBE_FONT_SIZE_PX = 100;

/**
 * 实测比例是否落在可信区间。
 *
 * 等宽字体的单格宽/字号经验上在 0.4–0.8 之间（CJK 全角字体偏大）。落在区间外说明探针
 * 没量到东西（字体没加载、元素未插入 DOM、被 CSS 隐藏成 0 尺寸……），此时**必须报警而不是
 * 拿一个荒谬的值去算字号**——否则会静默算出一个离谱的布局。
 */
export function isPlausibleCellAspect(aspect: number): boolean {
  return Number.isFinite(aspect) && aspect >= 0.35 && aspect <= 1.2;
}
