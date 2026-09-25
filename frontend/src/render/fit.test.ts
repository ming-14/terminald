/**
 * 求解 + 实测校正的测试。
 *
 * 关键用例是「xterm 实际比模型大一点点」——这正是需要校正那一环的原因，
 * 而它只能靠假造一个偏大的度量来复现。
 *
 * 这里**没有失败态**：字号没有下限，容器再小也会得到一份布局，所以断言里不会出现
 * ok / reason 这类字段。字距也不在接口里了——格子宽度就该等于字符宽度本身。
 */

import { describe, expect, it } from 'vitest';

import { fitTerminal, type FitTerminalLike } from './fit.js';

interface FakeTerminal extends FitTerminalLike {
  readonly applied: Array<{ fontSize: number; lineHeight: number }>;
  readonly resized: Array<{ cols: number; rows: number }>;
}

/**
 * 假 xterm：渲染出来的尺寸 = 字号 × 单格比例 × 网格数 × 一个「度量偏差」系数。
 * 偏差系数 != 1 就是在模拟「我们的模型和它的内部取整不一致」。
 */
function fakeTerminal(bias: { width: number; height: number }, cellAspect = 0.6) {
  // 与 FitTerminalLike 一致：这两个 option 是可选的（xterm 的实际类型就是这样）
  const options: { fontSize?: number; lineHeight?: number } = {
    fontSize: 14,
    lineHeight: 1.3,
  };
  const applied: FakeTerminal['applied'] = [];
  const resized: FakeTerminal['resized'] = [];

  const current = () => ({
    fontSize: options.fontSize ?? 0,
    lineHeight: options.lineHeight ?? 1,
  });

  const term: FakeTerminal = {
    options,
    resize: (cols, rows) => {
      // 记下「以当前字号渲染了一帧」，用于断言缩小的过程
      applied.push({ ...current() });
      resized.push({ cols, rows });
    },
    applied,
    resized,
  };

  const measure = (cols: number, rows: number) => {
    const { fontSize, lineHeight } = current();
    return {
      width: fontSize * cellAspect * cols * bias.width,
      height: fontSize * lineHeight * rows * bias.height,
    };
  };

  return { term, measure };
}

const HOST = { clientWidth: 1120, clientHeight: 560 };

const OPTIONS = { cols: 120, rows: 30, cellAspect: 0.6 };

describe('fitTerminal', () => {
  it('模型与实测一致时一次成功、无需校正', () => {
    const { term, measure } = fakeTerminal({ width: 1, height: 1 });
    const result = fitTerminal(HOST, term, {
      ...OPTIONS,
      measureScreen: () => measure(120, 30),
    });

    expect(result.corrections).toBe(0);
    expect(result.overflow.width).toBeLessThanOrEqual(0.5);
    expect(result.overflow.height).toBeLessThanOrEqual(0.5);
    expect(term.applied).toHaveLength(1);
    // 网格尺寸由终端侧决定，前端显式设定
    expect(term.resized).toEqual([{ cols: 120, rows: 30 }]);
  });

  it('实测比模型高时按实测比例缩小字号，几轮内收敛且不溢出', () => {
    const { term, measure } = fakeTerminal({ width: 1.0, height: 1.06 });
    const result = fitTerminal(HOST, term, {
      ...OPTIONS,
      measureScreen: () => measure(120, 30),
    });

    expect(result.corrections).toBeGreaterThan(0);
    expect(result.overflow.height).toBeLessThanOrEqual(0.5);
    // 每一次尝试都应用过一次字号
    expect(term.applied).toHaveLength(result.corrections + 1);
    // 字号逐次下降且保持 0.5 的整数倍
    for (let i = 1; i < term.applied.length; i += 1) {
      const previous = term.applied[i - 1]?.fontSize ?? 0;
      const current = term.applied[i]?.fontSize ?? 0;
      expect(current).toBeLessThan(previous);
      expect(Math.abs(current * 2 - Math.round(current * 2))).toBeLessThan(1e-9);
    }
  });

  it('只写字号与行高，不碰字距', () => {
    const { term, measure } = fakeTerminal({ width: 1, height: 1 });
    fitTerminal(HOST, term, { ...OPTIONS, measureScreen: () => measure(120, 30) });
    // 接口里根本没有 letterSpacing 这个成员：格子宽度必须等于字符宽度本身
    expect(Object.keys(term.options).sort()).toEqual(['fontSize', 'lineHeight']);
  });

  it('偏在非受限轴上不会引发无谓校正（宽度本就有余量）', () => {
    const { term, measure } = fakeTerminal({ width: 1.06, height: 1.0 });
    const result = fitTerminal(HOST, term, {
      ...OPTIONS,
      measureScreen: () => measure(120, 30),
    });
    expect(result.corrections).toBe(0);
  });

  it('度量偏差大到 3 倍时仍收敛，不靠「退到下限就放弃」的出口', () => {
    const { term, measure } = fakeTerminal({ width: 1, height: 3 });
    const result = fitTerminal(HOST, term, {
      ...OPTIONS,
      measureScreen: () => measure(120, 30),
    });

    expect(result.overflow.height).toBeLessThanOrEqual(0.5);
    // 有界循环：尝试次数不超过上限
    expect(term.applied.length).toBeLessThanOrEqual(8);
  });

  it('容器极小时照样给出正字号布局，没有失败状态', () => {
    const { term, measure } = fakeTerminal({ width: 1, height: 1 });
    const result = fitTerminal({ clientWidth: 50, clientHeight: 20 }, term, {
      ...OPTIONS,
      measureScreen: () => measure(120, 30),
    });

    expect(result.layout.fontSize).toBeGreaterThan(0);
    expect(result.overflow.width).toBeLessThanOrEqual(0.5);
    expect(result.overflow.height).toBeLessThanOrEqual(0.5);
    expect(term.applied.length).toBeGreaterThan(0);
  });

  it('容器小到不足一个吸附步进时也不会产出 0 字号', () => {
    const { term, measure } = fakeTerminal({ width: 1, height: 1 });
    const result = fitTerminal({ clientWidth: 10, clientHeight: 8 }, term, {
      ...OPTIONS,
      measureScreen: () => measure(120, 30),
    });

    expect(result.layout.fontSize).toBeGreaterThan(0);
  });

  it('量不到渲染尺寸时视为不溢出（不因为拿不到 DOM 就判失败）', () => {
    const { term } = fakeTerminal({ width: 1, height: 1 });
    const result = fitTerminal(HOST, term, {
      ...OPTIONS,
      measureScreen: () => ({ width: 0, height: 0 }),
    });
    expect(result.corrections).toBe(0);
  });
});
