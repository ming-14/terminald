/**
 * 尺寸求解的测试。
 *
 * 核心断言有三条：**绝不溢出**、**永远给得出一份布局**（字号没有下限，容器再小也只是字号
 * 更小，不存在「装不下」这个结果）、**格子比例恒定**（同一网格在任何容器下解出的格子宽高比
 * 只差像素取整——这是「锁比例」的核心不变量）。剩下的是吸附、留白、单调性这些可观察的行为。
 */

import { describe, expect, it } from 'vitest';

import { LINE_HEIGHT, solveLayout, type Layout, type LayoutInput } from './size.js';

const BASE: LayoutInput = {
  containerW: 1120,
  containerH: 560,
  cols: 120,
  rows: 30,
  cellAspect: 0.6,
};

function solve(overrides: Partial<LayoutInput> = {}): Layout {
  return solveLayout({ ...BASE, ...overrides });
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
  [120, 90],
  [10, 8],
];

describe('solveLayout', () => {
  it('绝不溢出容器（含吸附模式）', () => {
    for (const [w, h] of CONTAINERS) {
      for (const snapStep of [0, 0.5, 1]) {
        const layout = solveLayout({ ...BASE, containerW: w, containerH: h, snapStep });
        expect(layout.usedW).toBeLessThanOrEqual(w + EPS);
        expect(layout.usedH).toBeLessThanOrEqual(h + EPS);
        expect(layout.padX).toBeGreaterThanOrEqual(-EPS);
        expect(layout.padY).toBeGreaterThanOrEqual(-EPS);
      }
    }
  });

  it('格子宽高比恒定：换容器只该差像素取整', () => {
    // 「锁比例」的核心。先前那版会把余量塞进字距与行高去铺满窗口，同一个 120×30 在不同
    // 窗口下格子宽÷字号能从 0.62 漂到 0.90；现在格子的比例就是 cellAspect : LINE_HEIGHT，
    // 与字号无关。
    const ratios = CONTAINERS.map(([w, h]) => {
      const layout = solveLayout({ ...BASE, containerW: w, containerH: h, snapStep: 0 });
      return layout.cellW / layout.cellH;
    });
    const min = Math.min(...ratios);
    const max = Math.max(...ratios);
    expect(max - min).toBeLessThan(1e-9);
    expect(min).toBeCloseTo(BASE.cellAspect / LINE_HEIGHT, 12);
  });

  it('行高是固定值，不随容器变化', () => {
    for (const [w, h] of CONTAINERS) {
      const layout = solveLayout({ ...BASE, containerW: w, containerH: h });
      expect(layout.lineHeight).toBe(LINE_HEIGHT);
    }
    // 只有显式传入才换得掉它
    expect(solve({ lineHeight: 1.5 }).lineHeight).toBe(1.5);
  });

  it('网格占用与留白自洽', () => {
    for (const [w, h] of CONTAINERS) {
      const layout = solveLayout({ ...BASE, containerW: w, containerH: h });
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

  it('非受限轴拿到的是留白，而不是被拉长的间距', () => {
    const layout = solve({ containerW: 1600, containerH: 560, snapStep: 0 });
    expect(layout.bindingAxis).toBe('height');
    expect(layout.padY).toBeLessThan(1);
    expect(layout.padX).toBeGreaterThan(100);
  });

  it('容器变大时字号单调不减', () => {
    let previous = 0;
    for (let w = 700; w <= 2000; w += 10) {
      const layout = solveLayout({ ...BASE, containerW: w, containerH: 900 });
      expect(layout.fontSize).toBeGreaterThanOrEqual(previous);
      previous = layout.fontSize;
    }
  });

  it('容器极小也照常解出字号，只是字号更小', () => {
    // 曾经这里返回 null（"装不下"）。网格尺寸由终端侧定死、前端无权改，
    // 所以字号是唯一的因变量：容器小就字号小，没有放弃这一说。
    const small = solve({ containerW: 120, containerH: 90 });
    expect(small.fontSize).toBeGreaterThan(0);
    expect(small.usedW).toBeLessThanOrEqual(120 + EPS);
    expect(small.usedH).toBeLessThanOrEqual(90 + EPS);

    const tiny = solve({ containerW: 10, containerH: 8 });
    expect(tiny.fontSize).toBeGreaterThan(0);
    expect(tiny.usedW).toBeLessThanOrEqual(10 + EPS);
    expect(tiny.usedH).toBeLessThanOrEqual(8 + EPS);
  });

  it('容器小到不足一个吸附步进时不会产出 0 字号', () => {
    // 向下吸附会把 0.14px 取成 0，而 0 字号什么都渲染不出来 —— 此时退回未吸附的值。
    const layout = solve({ containerW: 10, containerH: 8, snapStep: 0.5 });
    expect(layout.fontSize).toBeGreaterThan(0);
    expect(layout.usedW).toBeLessThanOrEqual(10 + EPS);
  });

  it('参数非法时抛错（cols/rows/cellAspect/容器尺寸）', () => {
    expect(() => solveLayout({ ...BASE, cols: 0 })).toThrow(RangeError);
    expect(() => solveLayout({ ...BASE, rows: -1 })).toThrow(RangeError);
    expect(() => solveLayout({ ...BASE, cellAspect: 0 })).toThrow(RangeError);
    expect(() => solveLayout({ ...BASE, cellAspect: Number.NaN })).toThrow(RangeError);
    // 容器尺寸非正是调用方的编程错误：连画布都没有，不该返回一个假布局
    expect(() => solveLayout({ ...BASE, containerW: 0 })).toThrow(RangeError);
    expect(() => solveLayout({ ...BASE, containerH: -1 })).toThrow(RangeError);
  });

  it('典型窗口下的取值符合直觉（Cascadia Mono 比例 0.6）', () => {
    const layout = solve({ containerW: 1120, containerH: 560 });
    // 高度受限：560 / 30 / 1.3 ≈ 14.36 → 吸附到 14.0
    expect(layout.fontSize).toBeCloseTo(14, 6);
    // 行高固定 → 网格高 = 30 × 14 × 1.3 = 546，比容器矮 14px，这 14px 变成上下留白
    expect(layout.usedH).toBeCloseTo(546, 6);
    expect(layout.padY).toBeCloseTo(7, 6);
    // 单格宽 = 14 × 0.6 = 8.4，网格宽 1008，余下 112px 居中留白
    expect(layout.cellW).toBeCloseTo(8.4, 6);
    expect(layout.padX).toBeCloseTo(56, 6);
  });
});
