/**
 * 把求解结果应用到 xterm，并**实测校正**。
 *
 * 为什么需要校正一环：`solveLayout` 用的是我们自己量出来的「单格宽 ÷ 字号」，而 xterm 内部
 * 有它自己的字符度量与取整方式。两者理论上应该一致，实际会因为字体回退、亚像素舍入、
 * `lineHeight` 的取整方式而差一点点。差一点点在 120 列的网格上就是可见的溢出或裁切。
 *
 * 校正的做法是**按实测的溢出比例直接求新字号**，而不是一档一档地退：网格尺寸与字号近似
 * 线性，所以 `新字号 = 旧字号 × min(容器宽 / 网格宽, 容器高 / 网格高)` 基本一轮就落到目标
 * 上。有限轮数只用来兜住取整留下的尾巴。
 *
 * **这里没有「装不下」这种结果。** 字号没有下限，容器小就只是字号跟着小，网格始终完整地
 * 铺在里面；所以对外只报「最终布局 + 校正次数」，不存在成功与失败之分。
 */

import { solveLayout, type Layout } from './size.js';

/** 校正轮数上限。按比例缩放通常一两轮收敛，这里只兜住取整造成的尾巴。 */
const MAX_ATTEMPTS = 8;

/**
 * 缩放失效时的强制退让比例。
 *
 * 取整会把「按比例缩出来的字号」顶回原值（量出来的网格尺寸是整数像素，缩完可能仍落在
 * 同一档），那样循环就不推进了。此时强制按比例退一点，保证每一轮都在往小的方向走。
 */
const FORCE_STEP = 0.95;

/**
 * fitTerminal 只用到 xterm 的这几个成员，抽出来是为了能注入替身做测试。
 *
 * 两个 option 声明为可选，是为了兼容 xterm 的 `ITerminalOptions`（它们都是可选的）；
 * 本模块只写入不读取，所以可选不影响正确性。
 */
export interface FitTerminalLike {
  readonly options: {
    fontSize?: number;
    lineHeight?: number;
  };
  resize(cols: number, rows: number): void;
}

export interface FitOptions {
  readonly cols: number;
  readonly rows: number;
  /** 单格宽 ÷ 字号，实测值 */
  readonly cellAspect: number;
  /** 量「渲染出来的网格」的实际像素尺寸 */
  readonly measureScreen: () => { width: number; height: number };
  readonly snapStep?: number;
}

export interface FitResult {
  readonly layout: Layout;
  /** 为贴合实测而缩小字号的次数；0 表示模型与实测一致 */
  readonly corrections: number;
  /** 最终渲染尺寸与容器的差值（正数表示溢出；收敛后两轴都是 0） */
  readonly overflow: { width: number; height: number };
}

const EPS = 0.5; // 允许半个像素的取整误差

/**
 * 求解并应用到终端。
 *
 * 网格尺寸由终端侧决定，前端无权改（见 `size.ts` 模块头注释），所以这里的输入只有容器
 * 尺寸：容器多小都会返回一个布局，只是字号更小。
 */
export function fitTerminal(
  host: { readonly clientWidth: number; readonly clientHeight: number },
  term: FitTerminalLike,
  options: FitOptions,
): FitResult {
  const { cols, rows, cellAspect, measureScreen, snapStep } = options;

  const containerW = host.clientWidth;
  const containerH = host.clientHeight;

  const solve = (maxFontSize?: number): Layout =>
    solveLayout({
      containerW,
      containerH,
      cols,
      rows,
      cellAspect,
      ...(snapStep === undefined ? {} : { snapStep }),
      ...(maxFontSize === undefined ? {} : { maxFontSize }),
    });

  let layout = solve();
  let corrections = 0;
  let overflow = { width: Number.NaN, height: Number.NaN };

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    term.options.fontSize = layout.fontSize;
    term.options.lineHeight = layout.lineHeight;
    // 字距不动它：格子宽度就该等于字符宽度本身，掺间距会让字形比例随窗口漂（见 size.ts）
    // 网格尺寸由终端侧决定，所以我们显式设定，而不是让 xterm 去 fit 容器
    term.resize(cols, rows);

    const screen = measureScreen();
    overflow = {
      width: screen.width - containerW,
      height: screen.height - containerH,
    };
    // 量不到渲染尺寸时 screen 是 0，差值必然为负，同样从这里收敛退出
    if (overflow.width <= EPS && overflow.height <= EPS) break;

    corrections += 1;
    const scale = Math.min(containerW / screen.width, containerH / screen.height);
    const scaled = layout.fontSize * scale;
    // 缩放没能把字号推下去（被取整顶回来了）就强制退让，保证循环一定在推进
    const capped = scaled < layout.fontSize - 1e-6 ? scaled : layout.fontSize * FORCE_STEP;
    layout = solve(capped);
  }

  return {
    layout,
    corrections,
    // 余量对调用方没有意义，只报实际超出的部分
    overflow: {
      width: Math.max(0, overflow.width),
      height: Math.max(0, overflow.height),
    },
  };
}

/** 从 xterm 的 DOM 里量渲染出来的网格尺寸；量不到就退回 0（视为不溢出）。 */
export function measureRenderedScreen(element: HTMLElement | undefined): {
  width: number;
  height: number;
} {
  const screen = element?.querySelector<HTMLElement>('.xterm-screen');
  if (screen === null || screen === undefined) return { width: 0, height: 0 };
  const rect = screen.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
}
