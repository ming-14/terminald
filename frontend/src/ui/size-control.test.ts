import { describe, expect, it } from 'vitest';

import { SIZE_PRESETS, parseSizeInput, sizeChipState } from './size-control.js';

describe('sizeChipState', () => {
  it('还没拿到网格时显示占位，且不可点', () => {
    // 未订阅 / attached 还没到：此时没有可改的尺寸，点开弹层也没有内容可填
    const state = sizeChipState(null, 'running');
    expect(state.text).toBe('—');
    expect(state.disabled).toBe(true);
  });

  it('会话已退出时置灰（即使网格已知）', () => {
    // 尺寸要落到 PTY 上才有意义（进程都没了）。置灰而不是让用户点一下再吃一条服务端错误。
    const state = sizeChipState({ cols: 120, rows: 30 }, 'exited');
    expect(state.text).toBe('120×30');
    expect(state.disabled).toBe(true);
    expect(state.title).toContain('不可改');
  });

  it('运行中可点，文字就是当前网格', () => {
    const state = sizeChipState({ cols: 80, rows: 24 }, 'running');
    expect(state.text).toBe('80×24');
    expect(state.disabled).toBe(false);
    expect(state.title).toBe('更改终端尺寸');
  });

  it('会话列表里找不到这个会话时也不可点（status 为 null）', () => {
    // 「有网格但没有会话条目」是可能的：`attached` 先到、`sessions` 后到。
    // 那一刻不该让用户改——改的是列表里的会话，而它还不知道在不在。
    expect(sizeChipState({ cols: 100, rows: 30 }, null).disabled).toBe(true);
  });
});

describe('parseSizeInput', () => {
  it('接受纯数字，并容忍两端空白', () => {
    expect(parseSizeInput('120', '30')).toEqual({ cols: 120, rows: 30 });
    expect(parseSizeInput('  120  ', '\t30\n')).toEqual({ cols: 120, rows: 30 });
  });

  it.each([
    ['空串', '', '30'],
    ['另一侧空串', '120', ''],
    ['非数字', 'abc', '30'],
    ['小数', '12.5', '30'],
    ['科学计数', '1e3', '30'],
    ['尾随垃圾', '12abc', '30'],
    ['零', '0', '30'],
    ['负数', '-4', '30'],
    ['正号', '+4', '30'],
    ['超出安全整数', '99999999999999999999', '30'],
  ])('拒绝：%s', (_why, cols, rows) => {
    // 这些都不是"尺寸"。挡住它们，是为了不发一个必然失败的往返、也不在界面上闪一下错误。
    // 注意 `1e3`/`12abc` 这类：`Number.parseInt` 会把它们解成合法的整数，所以这里不吃 parseInt。
    expect(parseSizeInput(cols, rows)).toBeNull();
  });

  it('**不**判上下界：那是协议层的事实，由服务端拒', () => {
    // 这条是**刻意**的行为，不是遗漏。前端复制一份边界面（SESSION_COLS_MIN 等）会多一个
    // 会漂移的常量，与 `#rename` 对名字长度是同一条纪律：越界由服务端用 error 拒回，
    // 而那条消息本来就会显示成提示。
    expect(parseSizeInput('1', '1')).toEqual({ cols: 1, rows: 1 });
    expect(parseSizeInput('9999', '9999')).toEqual({ cols: 9999, rows: 9999 });
  });
});

describe('SIZE_PRESETS', () => {
  it('是三个互不相同的正整数档位', () => {
    expect(SIZE_PRESETS).toHaveLength(3);
    const seen = new Set<string>();
    for (const [cols, rows] of SIZE_PRESETS) {
      expect(Number.isInteger(cols) && cols > 0).toBe(true);
      expect(Number.isInteger(rows) && rows > 0).toBe(true);
      seen.add(`${cols}x${rows}`);
    }
    expect(seen.size).toBe(SIZE_PRESETS.length);
  });
});
