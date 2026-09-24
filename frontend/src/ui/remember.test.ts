/**
 * `SessionMemory` 的测试。
 *
 * 这里能测、也值得测的是**降级与脏数据**两条：往返写入不出错是显然的，而
 * 「存储不可用时终端还能不能用」「键里是别的东西时会不会把视口带到一个荒谬的位置」
 * 只有真的造出来才知道。
 *
 * `app.ts` 里的接线（什么时候记、什么时候恢复）不在这里测：那部分依赖真实 xterm 的
 * 缓冲区与滚动行为，用假实现测它只会测到我自己的假设。它由真实浏览器探针
 * `probe/remember.mjs` 负责。
 */

import { describe, expect, it } from 'vitest';

import {
  ACTIVE_SESSION_KEY,
  SCROLL_KEY_PREFIX,
  SessionMemory,
  pickInitialSession,
  type MemoryStorage,
} from './remember.js';

/** 内存实现，行为与真 `sessionStorage` 一致（键值都是字符串）。 */
function fakeStorage(initial: Record<string, string> = {}): MemoryStorage & {
  readonly map: Map<string, string>;
} {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

describe('会话记忆', () => {
  it('往返：写进去的会话 id 能读回来', () => {
    const storage = fakeStorage();
    const memory = new SessionMemory(storage);
    expect(memory.available).toBe(true);
    expect(memory.activeSession()).toBeNull();
    memory.setActiveSession('s2f1a');
    expect(memory.activeSession()).toBe('s2f1a');
    expect(storage.map.get(ACTIVE_SESSION_KEY)).toBe('s2f1a');
    memory.forgetActiveSession();
    expect(memory.activeSession()).toBeNull();
  });

  it('滚动位置按会话分别记，互不串台', () => {
    const storage = fakeStorage();
    const memory = new SessionMemory(storage);
    memory.setScroll('s1', 412);
    memory.setScroll('s2', 7);
    expect(memory.scroll('s1')).toBe(412);
    expect(memory.scroll('s2')).toBe(7);
    expect(storage.map.get(`${SCROLL_KEY_PREFIX}s1`)).toBe('412');
    memory.forgetScroll('s1');
    expect(memory.scroll('s1')).toBeNull();
    expect(memory.scroll('s2')).toBe(7);
  });

  it('负数 / 非整数 / 空串不写进存储（写了也只会让下次读到荒谬的值）', () => {
    const memory = new SessionMemory(fakeStorage());
    memory.setScroll('s1', -1);
    memory.setScroll('s1', 1.5);
    memory.setScroll('s1', Number.NaN);
    expect(memory.scroll('s1')).toBeNull();
    memory.setActiveSession('');
    expect(memory.activeSession()).toBeNull();
  });

  it('脏数据当成「没有记忆」，不抛异常', () => {
    const memory = new SessionMemory(
      fakeStorage({
        [`${SCROLL_KEY_PREFIX}s1`]: '不是数字',
        [`${SCROLL_KEY_PREFIX}s2`]: '-3',
        [`${SCROLL_KEY_PREFIX}s3`]: '9007199254740993', // 超出安全整数
        [`${SCROLL_KEY_PREFIX}s4`]: '128',
        [ACTIVE_SESSION_KEY]: '',
      }),
    );
    expect(memory.scroll('s1')).toBeNull();
    expect(memory.scroll('s2')).toBeNull();
    expect(memory.scroll('s3')).toBeNull();
    expect(memory.scroll('s4')).toBe(128);
    expect(memory.scroll('没记过的会话')).toBeNull();
    expect(memory.activeSession()).toBeNull();
  });

  it('存储不可用时全部降级为「没有记忆」，且写入不抛', () => {
    const memory = new SessionMemory(null);
    expect(memory.available).toBe(false);
    expect(memory.activeSession()).toBeNull();
    expect(memory.scroll('s1')).toBeNull();
    expect(() => {
      memory.setActiveSession('s1');
      memory.setScroll('s1', 10);
      memory.forgetScroll('s1');
      memory.clearSession('s1');
    }).not.toThrow();
    expect(memory.activeSession()).toBeNull();
  });

  it('存储自己在抛（配额满 / 隐私模式）时也不影响调用方', () => {
    const hostile: MemoryStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
    };
    const memory = new SessionMemory(hostile);
    expect(() => {
      memory.setActiveSession('s1');
      memory.setScroll('s1', 10);
      memory.clearSession('s1');
    }).not.toThrow();
    expect(memory.activeSession()).toBeNull();
    expect(memory.scroll('s1')).toBeNull();
  });

  it('关会话时连同「当前会话」一起清掉，但不动别的会话', () => {
    const storage = fakeStorage();
    const memory = new SessionMemory(storage);
    memory.setActiveSession('s1');
    memory.setScroll('s1', 30);
    memory.setScroll('s2', 40);
    memory.clearSession('s1');
    expect(memory.activeSession()).toBeNull();
    expect(memory.scroll('s1')).toBeNull();
    expect(memory.scroll('s2')).toBe(40);

    memory.setActiveSession('s2');
    memory.clearSession('s1'); // 关的不是当前会话
    expect(memory.activeSession()).toBe('s2');
  });
});

describe('首屏会话选择', () => {
  const items = [{ id: 's1' }, { id: 's2' }, { id: 's3' }];

  it('记得的那个还在 → 用它（不是列表第一个）', () => {
    expect(pickInitialSession(items, 's3')).toBe('s3');
  });

  it('记得的那个已经不存在 → 回退到第一个', () => {
    expect(pickInitialSession(items, 's9')).toBe('s1');
  });

  it('没有记忆 → 第一个', () => {
    expect(pickInitialSession(items, null)).toBe('s1');
  });

  it('列表为空 → 不选（不能凭空造一个 id）', () => {
    expect(pickInitialSession([], 's1')).toBeNull();
    expect(pickInitialSession([], null)).toBeNull();
  });
});
