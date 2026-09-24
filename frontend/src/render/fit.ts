/**
 * 把求解结果应用到 xterm，并**实测校正**。
 *
 * 为什么需要校正一环：`solveLayout` 用的是我们自己量出来的「单格宽 ÷ 字号」，而 xterm 内部
 * 有它自己的字符度量与取整方式。两者理论上应该一致，实际会因为字体回退、亚像素舍入、
 * `lineHeight` 的取整方式而差一点点。差一点点在 120 列的网格上就是可见的溢出或裁切。
 *
 * 所以流程是「求解 → 应用 → 量渲染结果 → 不满足就退一档重来」，有界循环。校正发生时把
 * 次数与差值报出来，而不是悄悄修掉——那说明模型与真实度量不一致，值得知道。
 */

import { solveLayout, type Layout } from './size.js';

/** 校正时每轮退多少字号。与吸附步进一致，保证字号始终落在 0.5 的整数倍上。 */
const CORRECTION_STEP = 0.5;
const MAX_ATTEMPTS = 8;

/**
 * fitTerminal 只用到 xterm 的这几个成员，抽出来是为了能注入替身做测试。
 *
 * 三个 option 声明为可选，是为了兼容 xterm 的 `ITerminalOptions`（它们都是可选的）；
 * 本模块只写入不读取，所以可选不影响正确性。
 */
export interface FitTerminalLike {
  readonly options: {
    fontSize?: number;
    lineHeight?: number;
    letterSpacing?: number;
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
  readonly minFontSize?: number;
}

export interface FitResult {
  readonly ok: boolean;
  readonly layout: Layout | null;
  /** 为了不溢出而额外退让的次数；0 表示模型与实测一致 */
  readonly corrections: number;
  /** 最终渲染尺寸与容器的差值（正数表示溢出） */
  readonly overflow: { width: number; height: number };
  readonly reason?: string;
}

const EPS = 0.5; // 允许半个像素的取整误差

/**
 * 求解并应用布局。返回 `ok=false` 时表示容器装不下这个网格（字号会低于下限）。
 *
 * 注意这里**不做**「把 cols/rows 改成容器装得下的值」这种事：网格尺寸是终端侧定的，
 * 前端无权改。装不下就是装不下，由调用方去提示。
 */
export function fitTerminal(
  host: { readonly clientWidth: number; readonly clientHeight: number },
  term: FitTerminalLike,
  options: FitOptions,
): FitResult {
  const {
    cols,
    rows,
    cellAspect,
    measureScreen,
    snapStep = CORRECTION_STEP,
    minFontSize = 6,
  } = options;

  const containerW = host.clientWidth;
  const containerH = host.clientHeight;

  let maxFontSize: number | undefined;
  let lastLayout: Layout | null = null;
  let lastOverflow = { width: Number.NaN, height: Number.NaN };
  let corrections = 0;
  let reason: string | undefined;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const layout = solveLayout({
      containerW,
      containerH,
      cols,
      rows,
      cellAspect,
      snapStep,
      minFontSize,
      ...(maxFontSize === undefined ? {} : { maxFontSize }),
    });
    if (layout === null) {
      reason = '容器装不下这个网格（字号会低于下限）';
      break;
    }
    lastLayout = layout;

    term.options.fontSize = layout.fontSize;
    term.options.lineHeight = layout.lineHeight;
    term.options.letterSpacing = layout.letterSpacing;
    // 网格尺寸由终端侧决定，所以我们显式设定，而不是让 xterm 去 fit 容器
    term.resize(cols, rows);

    const screen = measureScreen();
    lastOverflow = {
      width: screen.width - containerW,
      height: screen.height - containerH,
    };
    if (lastOverflow.width <= EPS && lastOverflow.height <= EPS) {
      return {
        ok: true,
        layout,
        corrections,
        overflow: { width: Math.max(0, lastOverflow.width), height: Math.max(0, lastOverflow.height) },
      };
    }

    // 渲染结果比算出来的大 → 退一档字号重来。用 maxFontSize 把下限带进下一轮求解，
    // 否则同样的输入会解出同样的字号，循环原地打转。
    corrections += 1;
    const next = layout.fontSize - CORRECTION_STEP;
    if (next < minFontSize) {
      reason = '实测渲染尺寸持续溢出，字号已到下限';
      break;
    }
    maxFontSize = next;
  }

  return {
    ok: false,
    layout: lastLayout,
    corrections,
    overflow: {
      width: Math.max(0, lastOverflow.width),
      height: Math.max(0, lastOverflow.height),
    },
    // 循环耗尽也必须给原因：调用方要据此提示，沉默的失败等于没失败
    reason: reason ?? `连续 ${MAX_ATTEMPTS} 次校正后仍然溢出`,
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
