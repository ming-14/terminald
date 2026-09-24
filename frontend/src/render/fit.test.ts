/**
 * 求解 + 实测校正的测试。
 *
 * 关键用例是「xterm 实际比模型大一点点」——这正是需要校正那一环的原因，
 * 而它只能靠假造一个偏大的度量来复现。
 */

import { describe, expect, it } from 'vitest';

import { fitTerminal, type FitTerminalLike } from './fit.js';

interface FakeTerminal extends FitTerminalLike {
  readonly applied: Array<{ fontSize: number; lineHeight: number; letterSpacing: number }>;
  readonly resized: Array<{ cols: number; rows: number }>;
}

/**
 * 假 xterm：渲染出来的尺寸 = 字号 × 单格比例 × 网格数 × 一个「度量偏差」系数。
 * 偏差系数 != 1 就是在模拟「我们的模型和它的内部取整不一致」。
 */
function fakeTerminal(bias: { width: number; height: number }, cellAspect = 0.6) {
  // 与 FitTerminalLike 一致：三个 option 是可选的（xterm 的实际类型就是这样）
  const options: { fontSize?: number; lineHeight?: number; letterSpacing?: number } = {
    fontSize: 14,
    lineHeight: 1.3,
    letterSpacing: 0,
  };
  const applied: FakeTerminal['applied'] = [];
  const resized: FakeTerminal['resized'] = [];

  const current = () => ({
    fontSize: options.fontSize ?? 0,
    lineHeight: options.lineHeight ?? 1,
    letterSpacing: options.letterSpacing ?? 0,
  });

  const term: FakeTerminal = {
    options,
    resize: (cols, rows) => {
      // 记下「以当前字号渲染了一帧」，用于断言退让过程
      applied.push({ ...current() });
      resized.push({ cols, rows });
    },
    applied,
    resized,
  };

  const measure = (cols: number, rows: number) => {
    const { fontSize, lineHeight, letterSpacing } = current();
    return {
      width: (fontSize * cellAspect + letterSpacing) * cols * bias.width,
      height: fontSize * lineHeight * rows * bias.height,
    };
  };

  return { term, measure };
}

const HOST = { clientWidth: 1120, clientHeight: 560 };

describe('fitTerminal', () => {
  it('模型与实测一致时一次成功、无需校正', () => {
    const { term, measure } = fakeTerminal({ width: 1, height: 1 });
    const result = fitTerminal(HOST, term, {
      cols: 120,
      rows: 30,
      cellAspect: 0.6,
      measureScreen: () => measure(120, 30),
    });

    expect(result.ok).toBe(true);
    expect(result.corrections).toBe(0);
    expect(result.overflow.width).toBeLessThanOrEqual(0.5);
    expect(result.overflow.height).toBeLessThanOrEqual(0.5);
    expect(term.applied).toHaveLength(1);
    // 网格尺寸由终端侧决定，前端显式设定
    expect(term.resized).toEqual([{ cols: 120, rows: 30 }]);
  });

  it('实测比模型高时逐档退让，直到不再溢出', () => {
    // 1120×560 下 120×30 是**高度受限**的（字号被高度卡到 14），所以要让高度偏大才会溢出：
    // 14 × 1.3333 × 30 = 560 正好铺满，偏 6% 就是 593.6，超出 33.6px。
    const { term, measure } = fakeTerminal({ width: 1.0, height: 1.06 });
    const result = fitTerminal(HOST, term, {
      cols: 120,
      rows: 30,
      cellAspect: 0.6,
      measureScreen: () => measure(120, 30),
    });

    expect(result.ok).toBe(true);
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

  it('偏在非受限轴上不会引发无谓校正（宽度本就有余量）', () => {
    const { term, measure } = fakeTerminal({ width: 1.06, height: 1.0 });
    const result = fitTerminal(HOST, term, {
      cols: 120,
      rows: 30,
      cellAspect: 0.6,
      measureScreen: () => measure(120, 30),
    });
    expect(result.ok).toBe(true);
    expect(result.corrections).toBe(0);
  });

  it('度量偏差过大时给出明确失败原因，而不是死循环', () => {
    // 高度偏差 3 倍：退到上限次数也装不下
    const { term, measure } = fakeTerminal({ width: 1, height: 3 });
    const result = fitTerminal(HOST, term, {
      cols: 120,
      rows: 30,
      cellAspect: 0.6,
      measureScreen: () => measure(120, 30),
    });

    expect(result.ok).toBe(false);
    expect(typeof result.reason).toBe('string');
    expect(result.reason).not.toBe('');
    // 有界循环：尝试次数不超过上限
    expect(term.applied.length).toBeLessThanOrEqual(8);
  });

  it('字号退到下限时以「下限」为原因失败', () => {
    const { term, measure } = fakeTerminal({ width: 1, height: 3 });
    const result = fitTerminal(HOST, term, {
      cols: 120,
      rows: 30,
      cellAspect: 0.6,
      // 下限设得足够高，使得第一次退让就触底
      minFontSize: 13.5,
      measureScreen: () => measure(120, 30),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('下限');
    // 会先试到下限那一档，发现仍溢出才放弃 —— 所以是 2 次而不是 1 次
    expect(term.applied.at(-1)?.fontSize).toBe(13.5);
    expect(term.applied.length).toBeLessThanOrEqual(3);
  });

  it('容器装不下时直接失败并给出原因', () => {
    const { term, measure } = fakeTerminal({ width: 1, height: 1 });
    const result = fitTerminal(
      { clientWidth: 50, clientHeight: 20 },
      term,
      {
        cols: 120,
        rows: 30,
        cellAspect: 0.6,
        measureScreen: () => measure(120, 30),
      },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('装不下');
    expect(term.applied).toHaveLength(0);
  });

  it('量不到渲染尺寸时视为不溢出（不因为拿不到 DOM 就判失败）', () => {
    const { term } = fakeTerminal({ width: 1, height: 1 });
    const result = fitTerminal(HOST, term, {
      cols: 120,
      rows: 30,
      cellAspect: 0.6,
      measureScreen: () => ({ width: 0, height: 0 }),
    });
    expect(result.ok).toBe(true);
    expect(result.corrections).toBe(0);
  });
});
