/**
 * 尺寸求解的测试。
 *
 * 核心断言只有一条：**绝不溢出**。剩下的是吸附、钳位、单调性这些可观察的行为。
 * 输入用的都是接近真实的数字（120×30 网格、0.6 的等宽比例、常见窗口尺寸）。
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_LETTER_SPACING,
  MAX_LINE_HEIGHT,
  MIN_LINE_HEIGHT,
  solveLayout,
  type Layout,
  type LayoutInput,
} from './size.js';

const BASE: LayoutInput = {
  containerW: 1120,
  containerH: 560,
  cols: 120,
  rows: 30,
  cellAspect: 0.6,
};

function solve(overrides: Partial<LayoutInput> = {}): Layout {
  const result = solveLayout({ ...BASE, ...overrides });
  if (result === null) throw new Error('期望求解成功，实际返回 null');
  return result;
}

const EPS = 1e-9;

/** 一组覆盖真实窗口形态的尺寸，含极扁、极高、极小、极大。 */
const CONTAINERS: ReadonlyArray<readonly [number, number]> = [
  [1120, 560],
  [700, 300],
  [1600, 900],
  [1000, 700],
  [1440, 420],
  [3840, 1000],
  [420, 900],
  [1280, 800],
  [800, 600],
  [320, 200],
];

describe('solveLayout', () => {
  it('绝不溢出容器（含吸附模式）', () => {
    for (const [w, h] of CONTAINERS) {
      for (const snapStep of [0, 0.5, 1]) {
        const layout = solveLayout({ ...BASE, containerW: w, containerH: h, snapStep });
        if (layout === null) continue;
        expect(layout.usedW).toBeLessThanOrEqual(w + EPS);
        expect(layout.usedH).toBeLessThanOrEqual(h + EPS);
        expect(layout.padX).toBeGreaterThanOrEqual(-EPS);
        expect(layout.padY).toBeGreaterThanOrEqual(-EPS);
      }
    }
  });

  it('网格占用与留白自洽', () => {
    for (const [w, h] of CONTAINERS) {
      const layout = solveLayout({ ...BASE, containerW: w, containerH: h });
      if (layout === null) continue;
      expect(layout.usedW + layout.padX * 2).toBeCloseTo(w, 6);
      expect(layout.usedH + layout.padY * 2).toBeCloseTo(h, 6);
      expect(layout.cellW * BASE.cols).toBeCloseTo(layout.usedW, 6);
      expect(layout.cellH * BASE.rows).toBeCloseTo(layout.usedH, 6);
    }
  });

  it('0.5px 吸附：只向下取整，且不越界', () => {
    // 1120×560 下上限是 14.359…，吸附后应落到 14.0
    const layout = solve({ containerW: 1120, containerH: 560, snapStep: 0.5 });
    expect(layout.snapped).toBe(true);
    expect(layout.fontSize).toBeCloseTo(14, 9);

    const unSnapped = solve({ snapStep: 0 });
    expect(unSnapped.fontSize).toBeGreaterThanOrEqual(layout.fontSize);
    expect(unSnapped.snapped).toBe(false);
  });

  it('吸附后的字号一定是步进的整数倍', () => {
    for (let w = 700; w <= 1600; w += 7) {
      const layout = solveLayout({ ...BASE, containerW: w, snapStep: 0.5 });
      if (layout === null) continue;
      const steps = layout.fontSize / 0.5;
      expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-6);
    }
  });

  it('受限轴：连续模式下该轴基本无余量', () => {
    const wide = solve({ containerW: 1600, containerH: 900, snapStep: 0 });
    expect(wide.bindingAxis).toBe('width');
    expect(wide.padX).toBeLessThan(1);

    const tall = solve({ containerW: 1120, containerH: 560, snapStep: 0 });
    expect(tall.bindingAxis).toBe('height');
    expect(tall.padY).toBeLessThan(1);
  });

  it('吸附会在受限轴上留下「吸附代价」的余量，且不超过一个步进', () => {
    // 这是选 0.5px 吸附的必然代价：字号被向下取整，受限轴于是多出余量。
    // 上界推导：字号最多减少一个步进 → 该轴最多少用 cols × step × cellAspect。
    const layout = solve({ containerW: 1600, containerH: 900, snapStep: 0.5 });
    expect(layout.bindingAxis).toBe('width');
    const slackBound = BASE.cols * 0.5 * BASE.cellAspect;
    expect(layout.padX).toBeGreaterThan(0);
    expect(layout.padX).toBeLessThanOrEqual(slackBound);

    // 非受限轴（高度）在两种模式下都被行高精确吸收
    expect(layout.padY).toBeLessThan(1);
  });

  it('行高倍数被钳在合法区间', () => {
    // 极扁容器 → 行高倍数被压到下限
    const flat = solve({ containerW: 1600, containerH: 300, snapStep: 0 });
    expect(flat.lineHeight).toBeGreaterThanOrEqual(MIN_LINE_HEIGHT);
    // 极高容器 → 被钳到上限，剩下的高度变成留白
    const tall = solve({ containerW: 800, containerH: 2000, snapStep: 0 });
    expect(tall.lineHeight).toBeLessThanOrEqual(MAX_LINE_HEIGHT);
  });

  it('字距是整数且不超过上限', () => {
    for (const [w, h] of CONTAINERS) {
      const layout = solveLayout({ ...BASE, containerW: w, containerH: h });
      if (layout === null) continue;
      expect(Number.isInteger(layout.letterSpacing)).toBe(true);
      expect(layout.letterSpacing).toBeGreaterThanOrEqual(0);
      expect(layout.letterSpacing).toBeLessThanOrEqual(MAX_LETTER_SPACING);
    }
  });

  it('容器变大时字号单调不减', () => {
    let previous = 0;
    for (let w = 700; w <= 2000; w += 10) {
      const layout = solveLayout({ ...BASE, containerW: w, containerH: 900 });
      expect(layout).not.toBeNull();
      expect(layout!.fontSize).toBeGreaterThanOrEqual(previous);
      previous = layout!.fontSize;
    }
  });

  it('容器装不下时返回 null，而不是把字号压到看不清', () => {
    expect(solveLayout({ ...BASE, containerW: 60, containerH: 20 })).toBeNull();
    expect(solveLayout({ ...BASE, containerW: 0, containerH: 0 })).toBeNull();
  });

  it('参数非法时抛错（cols/rows/cellAspect）', () => {
    expect(() => solveLayout({ ...BASE, cols: 0 })).toThrow(RangeError);
    expect(() => solveLayout({ ...BASE, rows: -1 })).toThrow(RangeError);
    expect(() => solveLayout({ ...BASE, cellAspect: 0 })).toThrow(RangeError);
    expect(() => solveLayout({ ...BASE, cellAspect: Number.NaN })).toThrow(RangeError);
  });

  it('典型窗口下的取值符合直觉（Cascadia Mono 比例 0.6）', () => {
    const layout = solve({ containerW: 1120, containerH: 560 });
    // 高度受限：560 / 30 / 1.3 ≈ 14.36 → 吸附到 14.0
    expect(layout.fontSize).toBeCloseTo(14, 6);
    // 行高精确铺满高度
    expect(layout.usedH).toBeCloseTo(560, 6);
    // 宽度有余量：1120/120 = 9.333，单格 8.4 → 字距 0，剩余居中
    expect(layout.letterSpacing).toBe(0);
    expect(layout.padX).toBeGreaterThan(0);
  });
});
