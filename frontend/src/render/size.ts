/**
 * 尺寸求解：把一个固定的 `cols × rows` 网格放进可变的容器。
 *
 * 这是本项目前端唯一「数学」的地方，所以它被写成**纯函数**：输入容器尺寸与实测的单格比例，
 * 输出字号。DOM 相关的测量只有 `measureCellAspect` 一个薄封装。
 *
 * ## 为什么字号是因变量
 *
 * `cols` / `rows` 由终端侧决定（见 `docs/architecture.md` §4），浏览器可视面积**永不**参与。
 * 于是前端的任务不是「让终端去适应窗口」，而是「求一个放得进容器的字号」。字号是结果，
 * 不是输入。
 *
 * ## 格子比例恒定，余量留白
 *
 * **一格 = 字符本身，不掺任何间距。** 宽度用实测的「单格宽 ÷ 字号」，高度用固定的行高
 * 倍数——两者都不随容器变化。理由：终端是要拿来比较的界面，同一个 `cols × rows` 在任何
 * 窗口下都该长得一模一样。
 *
 * 这里**不**做「把余量塞进字距或行高来铺满窗口」那套：那样会让字符的间距忽宽忽窄，同一个
 * 120×30 在大窗口和小窗口里看着像两种字体（实测过：格子宽 ÷ 字号在 0.62~0.90 之间漂）。
 * 代价是容器宽高比与网格宽高比对不上时只能留白（居中）——刻意如此，字形比例优先于铺满。
 *
 * ## 求解顺序
 *
 * 1. 两个方向上各算一个字号上限：`W / (cols × 单格宽/字号)` 与 `H / (rows × 行高倍数)`
 * 2. 取较小者——它决定哪个轴是**受限轴**，另一轴必然有余量
 * 3. 吸附（可选）：**只向下**取到步进的整数倍。向上取会让 `cols × 单格宽 > W` 直接溢出
 * 4. 余量居中留白
 *
 * 不变量：`usedW <= containerW` 且 `usedH <= containerH`，永远不溢出；且任意两个容器下解出
 * 的格子宽高比之差不超过一个像素的取整误差。
 */

/** 字号吸附步进（px）。 */
export const SNAP_STEP = 0.5;

/**
 * 行高倍数。**固定值**，不随容器变化——它决定格子的高宽比，而比例必须恒定。
 * 取 1.3：再小字符会被上下切掉，再大行与行之间显得断开。
 */
export const LINE_HEIGHT = 1.3;

export interface LayoutInput {
  readonly containerW: number;
  readonly containerH: number;
  readonly cols: number;
  readonly rows: number;
  /** 单格宽 ÷ 字号。必须**实测**，不同字体的比例不同，猜不得。 */
  readonly cellAspect: number;
  readonly snapStep?: number;
  /** 行高倍数；默认 `LINE_HEIGHT`。留出入口只是为了让测试能固定它。 */
  readonly lineHeight?: number;
  /**
   * 字号上限。实测校正时用它把字号压到「实测溢出比例算出的新上限」，
   * 否则同样的输入会解出同样的字号，校正循环原地打转。
   */
  readonly maxFontSize?: number;
}

export interface Layout {
  readonly fontSize: number;
  readonly lineHeight: number;
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

/** 向下吸附到 0 时退回原值：0 字号渲染不出任何东西。 */
function positiveOr(value: number, fallback: number): number {
  return value > 0 ? value : fallback;
}

/**
 * 求解布局。
 *
 * **永远返回一个布局。** 网格尺寸由终端侧定死（见模块头注释），前端无权改，所以这里不
 * 做「放不下就放弃」这种事：字号是唯一的因变量，容器再小也只是字号跟着小下去，网格始终
 * 完整地放得进去。容器尺寸非正属于调用方的编程错误（连画布都没有），抛错而不是返回一个
 * 假布局去骗渲染层。
 */
export function solveLayout(input: LayoutInput): Layout {
  const {
    containerW,
    containerH,
    cols,
    rows,
    cellAspect,
    snapStep = SNAP_STEP,
    lineHeight = LINE_HEIGHT,
    maxFontSize,
  } = input;

  if (cols <= 0 || rows <= 0) throw new RangeError('cols / rows 必须为正');
  if (!Number.isFinite(cellAspect) || cellAspect <= 0) {
    throw new RangeError(`cellAspect 必须为正有限数: ${cellAspect}`);
  }
  if (containerW <= 0 || containerH <= 0) {
    throw new RangeError(`容器尺寸必须为正: ${containerW}×${containerH}`);
  }

  const fsByWidth = containerW / (cols * cellAspect);
  const fsByHeight = containerH / (rows * lineHeight);

  let fontSize = Math.min(fsByWidth, fsByHeight);
  const snapped = snapStep > 0;
  const floorToStep = (value: number): number =>
    snapStep > 0 ? Math.floor(value / snapStep) * snapStep : value;
  if (snapped) {
    // 只向下吸附：向上会让网格宽/高超过容器，直接溢出。
    // 容器小到不足一个步进时取整会得到 0，而 0 字号什么都渲染不出来，退回原值。
    fontSize = positiveOr(floorToStep(fontSize), fontSize);
  }
  if (maxFontSize !== undefined) {
    // 压上限时同样向下对齐到步进，保持「字号总是步进的整数倍」这个性质
    fontSize = Math.min(fontSize, positiveOr(floorToStep(maxFontSize), maxFontSize));
  }

  const cellW = fontSize * cellAspect;
  const cellH = fontSize * lineHeight;
  const usedW = cellW * cols;
  const usedH = cellH * rows;

  return {
    fontSize,
    lineHeight,
    cellW,
    cellH,
    usedW,
    usedH,
    padX: Math.max(0, containerW - usedW) / 2,
    padY: Math.max(0, containerH - usedH) / 2,
    bindingAxis: fsByWidth <= fsByHeight ? 'width' : 'height',
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
