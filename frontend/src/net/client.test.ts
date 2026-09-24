/**
 * 客户端状态机的测试。
 *
 * 这里测的是**最容易悄悄错位的那部分**：本地偏移怎么推进、`ack` 什么时候发、
 * `behind` 怎么触发重建、重连时上报什么偏移。socket 与时钟都是假的，所以时序完全确定。
 */

import { describe, expect, it } from 'vitest';

import { decodeInput, encodeOutput, encodeSnapshot } from '../protocol/frames.js';
import type { ServerMessage } from '../protocol/messages.js';

import {
  TerminalClient,
  type ClientHandlers,
  type ClientOptions,
  type ConnectionState,
  type SocketLike,
} from './client.js';

const encoder = new TextEncoder();

/** 假 socket：记录发出的所有负载，并允许测试侧伪造服务端事件。 */
class FakeSocket implements SocketLike {
  binaryType = 'arraybuffer';
  readyState = 0;
  sent: Array<string | ArrayBufferView> = [];
  closed: { code: number | undefined; reason: string | undefined } | null = null;

  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((data: unknown) => void) | null = null;

  send(data: string | ArrayBufferView): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.readyState = 3;
  }

  // ---- 测试驱动 ----

  accept(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  /** 服务端发文本帧。 */
  deliverText(text: string): void {
    this.onmessage?.(text);
  }

  /** 服务端发二进制帧。 */
  deliverBinary(message: Uint8Array): void {
    this.onmessage?.(message.buffer.slice(0, message.byteLength) as ArrayBuffer);
  }

  drop(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  /** 解析出所有发出去的文本控制消息。 */
  sentText(): Record<string, unknown>[] {
    return this.sent
      .filter((item): item is string => typeof item === 'string')
      .map((text) => JSON.parse(text) as Record<string, unknown>);
  }

  lastText(): Record<string, unknown> | undefined {
    return this.sentText().at(-1);
  }
}

interface Harness {
  readonly client: TerminalClient;
  readonly socket: FakeSocket;
  readonly states: Array<{ state: ConnectionState; detail?: string }>;
  readonly outputs: Array<{ text: string; endOffset: number }>;
  readonly messages: ServerMessage[];
  readonly errors: Error[];
  /** 把待执行的定时器都跑掉（退避重连、ack 节流）。 */
  flush(ms: number): void;
}

function harness(options: Partial<ClientOptions> = {}): Harness {
  const socket = new FakeSocket();
  const states: Harness['states'] = [];
  const outputs: Harness['outputs'] = [];
  const messages: ServerMessage[] = [];
  const errors: Error[] = [];

  // 假时钟：schedule 只是入队，由 flush 统一推进
  let clock = 0;
  const queue: Array<{ at: number; fn: () => void }> = [];

  const handlers: ClientHandlers = {
    onState: (state, detail) => {
      states.push(detail === undefined ? { state } : { state, detail });
    },
    onOutput: (chunk, endOffset) => {
      outputs.push({ text: new TextDecoder().decode(chunk), endOffset });
    },
    onMessage: (message) => messages.push(message),
    onError: (error) => errors.push(error),
  };

  const client = new TerminalClient(handlers, {
    url: 'ws://127.0.0.1:8765/ws',
    label: 'test',
    createSocket: () => socket,
    now: () => clock,
    schedule: (fn, ms) => {
      const handle = { at: clock + ms, fn };
      queue.push(handle);
      return handle;
    },
    cancel: (handle) => {
      const index = queue.indexOf(handle as { at: number; fn: () => void });
      if (index >= 0) queue.splice(index, 1);
    },
    ackBytes: 100,
    ackIntervalMs: 300,
    ...options,
  });

  return {
    client,
    socket,
    states,
    outputs,
    messages,
    errors,
    flush(ms: number) {
      clock += ms;
      const due = queue.filter((item) => item.at <= clock);
      for (const item of due) {
        queue.splice(queue.indexOf(item), 1);
        item.fn();
      }
    },
  };
}

const helloOk = JSON.stringify({ t: 'hello_ok', protocol: 1, server: 'terminald' });

/** 把发出去的二进制负载里面的 INPUT 帧内容按顺序读出来。 */
function sentInputs(socket: FakeSocket): string[] {
  const decoder = new TextDecoder();
  return socket.sent
    .filter((item): item is ArrayBufferView => typeof item !== 'string')
    .flatMap((item) =>
      decodeInput(new Uint8Array(item.buffer, item.byteOffset, item.byteLength)).map((payload) =>
        decoder.decode(payload),
      ),
    );
}

function inputHold(session: string, paused: boolean): string {
  return JSON.stringify({ t: 'input_hold', session, paused });
}
const attached = (resumed: boolean, offset: number): string =>
  JSON.stringify({
    t: 'attached',
    session: 's1',
    cols: 120,
    rows: 30,
    scrollback: 10_000,
    offset,
    resumed,
  });

describe('TerminalClient · 握手与订阅', () => {
  it('连上后发 hello，收到 hello_ok 才算 ready', () => {
    const h = harness();
    h.client.connect();
    expect(h.states[0]?.state).toBe('connecting');

    h.socket.accept();
    expect(h.socket.lastText()).toEqual({ t: 'hello', protocol: 1, client: 'test' });

    h.socket.deliverText(helloOk);
    expect(h.client.state).toBe('ready');
    expect(h.states.some((s) => s.state === 'ready')).toBe(true);
    // 服务端不推初始列表，客户端必须主动要一次，否则刷新后侧栏是空的
    expect(h.socket.sentText()).toContainEqual({ t: 'session.list' });
  });

  it('全新客户端上报 resume=null；续传客户端上报本地已收到的偏移', () => {
    const fresh = harness();
    fresh.client.connect();
    fresh.socket.accept();
    fresh.socket.deliverText(helloOk);
    fresh.client.attach('s1');
    // 全新页面**必须**上报 null（不是 0）：服务端据此把「全新」与「续传但断点在 0」分开计数
    expect(fresh.socket.lastText()).toEqual({ t: 'attach', session: 's1', resume: null });

    const resumed = harness();
    resumed.client.connect();
    resumed.socket.accept();
    resumed.socket.deliverText(helloOk);
    resumed.client.attach('s1');
    // 协议保证 `attached` 先于字节，所以必须先给它（否则字节会被当作上个订阅的残留丢弃）
    resumed.socket.deliverText(attached(true, 0));
    expect(resumed.client.expectedOffset).toBe(0);

    resumed.socket.deliverBinary(encodeOutput(0n, encoder.encode('hello')));
    expect(resumed.client.expectedOffset).toBe(5);

    // 断线重连：有本地状态了，所以要上报已收到的 5，而不是 null
    resumed.socket.drop();
    resumed.flush(10_000);
    resumed.socket.accept();
    resumed.socket.deliverText(helloOk);
    expect(resumed.socket.lastText()).toEqual({ t: 'attach', session: 's1', resume: 5 });
  });

  it('等 attached 期间丢弃上个订阅的残留字节', () => {
    const h = harness();
    h.client.connect();
    h.socket.accept();
    h.socket.deliverText(helloOk);
    h.client.attach('s1');
    h.socket.deliverText(attached(true, 0));
    h.socket.deliverBinary(encodeOutput(0n, encoder.encode('aaa')));

    // 切到 s2：此后到达的 OUTPUT 属于 s1，必须丢弃
    h.client.attach('s2');
    h.socket.deliverBinary(encodeOutput(3n, encoder.encode('stale')));
    expect(h.outputs.map((o) => o.text)).toEqual(['aaa']);
    expect(h.errors).toEqual([]);

    // s2 的 attached 之后才恢复应用
    h.socket.deliverText(
      JSON.stringify({
        t: 'attached',
        session: 's2',
        cols: 120,
        rows: 30,
        scrollback: 10_000,
        offset: 0,
        resumed: true,
      }),
    );
    h.socket.deliverBinary(encodeOutput(0n, encoder.encode('bbb')));
    expect(h.outputs.map((o) => o.text)).toEqual(['aaa', 'bbb']);
  });

  it('服务端主动换订阅（新建会话）时重建基线，而不是把新会话的字节判成不连续', () => {
    const h = harness();
    h.client.connect();
    h.socket.accept();
    h.socket.deliverText(helloOk);
    h.client.attach('s1');
    h.socket.deliverText(attached(true, 0));
    h.socket.deliverBinary(encodeOutput(0n, encoder.encode('aaaaa')));
    expect(h.client.expectedOffset).toBe(5);

    // 新建会话：本端没有发过 attach，服务端直接把它推上来（offset 从 0 重新起算）
    h.socket.deliverText(
      JSON.stringify({
        t: 'attached',
        session: 's2',
        cols: 120,
        rows: 30,
        scrollback: 10_000,
        offset: 0,
        resumed: true,
      }),
    );
    h.socket.deliverBinary(encodeOutput(0n, encoder.encode('bb')));
    expect(h.errors).toEqual([]);
    expect(h.outputs.map((o) => o.text)).toEqual(['aaaaa', 'bb']);
    expect(h.client.session).toBe('s2');
    expect(h.client.expectedOffset).toBe(2);
  });

  it('切换到另一个会话会重置本地偏移（每个会话有自己的 offset 空间）', () => {
    const h = harness();
    h.client.connect();
    h.socket.accept();
    h.socket.deliverText(helloOk);

    h.client.attach('s1');
    h.socket.deliverText(attached(true, 0));
    h.socket.deliverBinary(encodeOutput(0n, encoder.encode('abcdef')));
    expect(h.client.expectedOffset).toBe(6);

    h.client.attach('s2');
    expect(h.socket.lastText()).toEqual({ t: 'attach', session: 's2', resume: null });
    expect(h.client.expectedOffset).toBe(0);
  });
});

describe('TerminalClient · OUTPUT 偏移推进', () => {
  it('逐帧推进本地偏移，并把字节交给上层', () => {
    const h = harness();
    h.client.connect();
    h.socket.accept();
    h.socket.deliverText(helloOk);

    h.socket.deliverBinary(encodeOutput(0n, encoder.encode('abc')));
    h.socket.deliverBinary(encodeOutput(3n, encoder.encode('def')));
    expect(h.outputs.map((o) => o.text)).toEqual(['abc', 'def']);
    expect(h.outputs.map((o) => o.endOffset)).toEqual([3, 6]);
    expect(h.client.expectedOffset).toBe(6);
    expect(h.errors).toEqual([]);
  });

  it('一条消息里串接多帧也能正确推进', () => {
    const h = harness();
    h.client.connect();
    h.socket.accept();
    h.socket.deliverText(helloOk);

    const a = encodeOutput(0n, encoder.encode('ab'));
    const b = encodeOutput(2n, encoder.encode('cd'));
    const joined = new Uint8Array(a.byteLength + b.byteLength);
    joined.set(a, 0);
    joined.set(b, a.byteLength);
    h.socket.deliverBinary(joined);

    expect(h.outputs.map((o) => o.endOffset)).toEqual([2, 4]);
    expect(h.client.expectedOffset).toBe(4);
  });

  it('偏移不连续时报错并要求重同步，而不是继续应用', () => {
    const h = harness();
    h.client.connect();
    h.socket.accept();
    h.socket.deliverText(helloOk);

    h.socket.deliverBinary(encodeOutput(0n, encoder.encode('abc')));
    h.socket.deliverBinary(encodeOutput(99n, encoder.encode('xyz'))); // 空洞

    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]?.message).toContain('不连续');
    expect(h.socket.lastText()).toEqual({ t: 'resync', session: '', offset: 3 });
    // 坏帧没有被应用
    expect(h.outputs.map((o) => o.text)).toEqual(['abc']);
  });

  it('SNAPSHOT 把本地偏移直接对齐到它声明的偏移', () => {
    const h = harness();
    h.client.connect();
    h.socket.accept();
    h.socket.deliverText(helloOk);

    h.socket.deliverText(attached(false, 4096));
    expect(h.client.expectedOffset).toBe(4096);

    h.socket.deliverBinary(encodeSnapshot(4096n, encoder.encode('rebuild')));
    expect(h.outputs.at(-1)?.endOffset).toBe(4096);
    expect(h.client.expectedOffset).toBe(4096);
    expect(h.errors).toEqual([]);
  });

  it('有损重建会在状态里说明（可观测性，不是静默）', () => {
    const h = harness();
    h.client.connect();
    h.socket.accept();
    h.socket.deliverText(helloOk);
    h.socket.deliverText(attached(false, 100));
    expect(h.states.some((s) => s.detail?.includes('已重建'))).toBe(true);
  });

  it('服务端发 INPUT 帧属于协议违例', () => {
    const h = harness();
    h.client.connect();
    h.socket.accept();
    h.socket.deliverText(helloOk);
    h.socket.deliverBinary(new Uint8Array([0x00, 0x00, 0x00, 0x02, 0x02, 0x78]));
    expect(h.errors[0]?.message).toContain('INPUT');
  });
});

describe('TerminalClient · 流控回执', () => {
  it('ack 只在 markParsed 之后发（收到 ≠ 解析完）', () => {
    const h = harness();
    h.client.connect();
    h.socket.accept();
    h.socket.deliverText(helloOk);
    h.socket.deliverBinary(encodeOutput(0n, encoder.encode('x'.repeat(500))));

    // 字节到了，但上层还没解析
    expect(h.socket.sentText().some((m) => m['t'] === 'ack')).toBe(false);

    h.client.markParsed(500);
    expect(h.socket.lastText()).toEqual({ t: 'ack', offset: 500 });
  });

  it('未达字节阈值时不立刻 ack，等时间阈值到', () => {
    const h = harness();
    h.client.connect();
    h.socket.accept();
    h.socket.deliverText(helloOk);
    h.socket.deliverBinary(encodeOutput(0n, encoder.encode('ab')));

    h.client.markParsed(2);
    expect(h.socket.sentText().some((m) => m['t'] === 'ack')).toBe(false);

    h.flush(300);
    expect(h.socket.lastText()).toEqual({ t: 'ack', offset: 2 });
  });

  it('累计未 ack 字节超过阈值立刻 ack，不等时间', () => {
    const h = harness();
    h.client.connect();
    h.socket.accept();
    h.socket.deliverText(helloOk);
    h.socket.deliverBinary(encodeOutput(0n, encoder.encode('z'.repeat(200))));

    h.client.markParsed(200);
    expect(h.socket.lastText()).toEqual({ t: 'ack', offset: 200 });
  });

  it('ack 单调推进，不重复发同一个偏移', () => {
    const h = harness();
    h.client.connect();
    h.socket.accept();
    h.socket.deliverText(helloOk);
    h.socket.deliverBinary(encodeOutput(0n, encoder.encode('z'.repeat(200))));
    h.client.markParsed(200);
    h.client.markParsed(200);
    h.client.markParsed(100);
    expect(h.socket.sentText().filter((m) => m['t'] === 'ack')).toEqual([
      { t: 'ack', offset: 200 },
    ]);
  });
});

describe('TerminalClient · 输入流控（服务端暂缓，本端排队）', () => {
  /** 连上、握手、订阅 s1（已无损对齐）。 */
  function subscribed(options: Partial<ClientOptions> = {}): Harness {
    const h = harness(options);
    h.client.connect();
    h.socket.accept();
    h.socket.deliverText(helloOk);
    h.client.attach('s1');
    h.socket.deliverText(attached(true, 0));
    return h;
  }

  it('暂缓期间输入在本端按序排队，放行后原序补发', () => {
    const h = subscribed();
    h.client.sendInput(encoder.encode('abc'));
    expect(sentInputs(h.socket)).toEqual(['abc']);

    h.socket.deliverText(inputHold('s1', true));
    expect(h.client.inputHeld).toBe(true);

    h.client.sendInput(encoder.encode('d'));
    h.client.sendInput(encoder.encode('ef'));
    // 暂缓生效后一个字节都不再发出，全排在本端
    expect(sentInputs(h.socket)).toEqual(['abc']);
    expect(h.client.heldInputBytes).toBe(3);

    h.socket.deliverText(inputHold('s1', false));
    expect(h.client.inputHeld).toBe(false);
    expect(h.client.heldInputBytes).toBe(0);
    // 原序补发，且**不重复**已经发出去的那一段
    expect(sentInputs(h.socket)).toEqual(['abc', 'd', 'ef']);
  });

  it('暂缓只针对输入，控制消息照常发出（控制面不能被堵住）', () => {
    const h = subscribed();
    h.socket.deliverText(inputHold('s1', true));
    h.client.sendInput(encoder.encode('x'));

    h.client.sendControl(JSON.stringify({ t: 'session.list' }));
    h.client.detach();
    expect(h.socket.sentText().map((m) => m['t'])).toEqual([
      'hello',
      'session.list',
      'attach',
      'session.list',
      'detach',
    ]);
  });

  it('排队超过上限时报错并丢弃最新字节，先到的部分保持完整', () => {
    const h = subscribed({ heldInputMaxBytes: 8 });
    h.socket.deliverText(inputHold('s1', true));

    h.client.sendInput(encoder.encode('12345'));
    h.client.sendInput(encoder.encode('6789')); // 5 + 4 > 8 → 丢弃

    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]?.message).toContain('上限');
    expect(h.client.heldInputBytes).toBe(5);

    h.socket.deliverText(inputHold('s1', false));
    // 丢的是最新的那段；先到的原样送出（不静默丢、也不把队列倒序）
    expect(sentInputs(h.socket)).toEqual(['12345']);
  });

  it('暂缓属于特定订阅：旧会话的放行不能把新会话的输入倒出去', () => {
    const h = subscribed();
    h.socket.deliverText(inputHold('s1', true));
    h.client.sendInput(encoder.encode('old'));
    expect(h.client.heldInputBytes).toBe(3);

    // 切会话：排队中的输入属于上一个订阅，必须一起丢掉
    h.client.attach('s2');
    expect(h.client.inputHeld).toBe(false);
    expect(h.client.heldInputBytes).toBe(0);

    h.socket.deliverText(
      JSON.stringify({
        t: 'attached',
        session: 's2',
        cols: 120,
        rows: 30,
        scrollback: 10_000,
        offset: 0,
        resumed: true,
      }),
    );
    h.client.sendInput(encoder.encode('new'));
    expect(sentInputs(h.socket)).toEqual(['new']);

    // s1 迟到的那条放行：既不能冻住 s2，也不能把 s1 的残留送进 s2 的 PTY
    h.socket.deliverText(inputHold('s1', false));
    expect(h.client.inputHeld).toBe(false);
    expect(sentInputs(h.socket)).toEqual(['new']);
  });

  it('放行后**分批**补发，过大的段会被切开（一次倒出会被服务端当成违约）', () => {
    const h = subscribed({ heldFlushBytes: 4, heldFlushIntervalMs: 100 });
    h.socket.deliverText(inputHold('s1', true));
    h.client.sendInput(encoder.encode('0123456789'));
    expect(h.client.heldInputBytes).toBe(10);

    h.socket.deliverText(inputHold('s1', false));
    expect(sentInputs(h.socket)).toEqual(['0123']); // 只送出第一批
    expect(h.client.heldInputBytes).toBe(6);

    // 剩下的靠进度定时器推进（服务端不再下发暂缓时也要能送完）
    h.flush(100);
    expect(sentInputs(h.socket)).toEqual(['0123', '4567']);
    h.flush(100);
    expect(sentInputs(h.socket)).toEqual(['0123', '4567', '89']);
    expect(h.client.heldInputBytes).toBe(0);
  });

  it('积压未清空时新输入排队尾，不插到前面（PTY 的字节序）', () => {
    const h = subscribed({ heldFlushBytes: 2, heldFlushIntervalMs: 100 });
    h.socket.deliverText(inputHold('s1', true));
    h.client.sendInput(encoder.encode('ABCDEF'));
    h.socket.deliverText(inputHold('s1', false));
    expect(sentInputs(h.socket)).toEqual(['AB']);

    // 补发还在进行中，用户又敲了键：直接发出去会插到 CDEF 前面
    h.client.sendInput(encoder.encode('zz'));
    expect(sentInputs(h.socket)).toEqual(['AB']);

    h.flush(100);
    h.flush(100);
    h.flush(100);
    expect(sentInputs(h.socket).join('')).toBe('ABCDEFzz');
    expect(h.client.heldInputBytes).toBe(0);
  });

  it('补发途中的再次暂缓会立即停手，等下一次放行才继续', () => {
    const h = subscribed({ heldFlushBytes: 2, heldFlushIntervalMs: 100 });
    h.socket.deliverText(inputHold('s1', true));
    h.client.sendInput(encoder.encode('ABCDEF'));
    h.socket.deliverText(inputHold('s1', false));
    expect(sentInputs(h.socket)).toEqual(['AB']);

    h.socket.deliverText(inputHold('s1', true));
    h.flush(500); // 进度定时器不得往前送
    expect(sentInputs(h.socket)).toEqual(['AB']);

    h.socket.deliverText(inputHold('s1', false));
    expect(sentInputs(h.socket)).toEqual(['AB', 'CD']);
  });

  it('断线时丢弃排队中的输入（WS 没有送达回执，重发会造成重复输入）', () => {
    const h = subscribed({ backoffInitialMs: 100, backoffMaxMs: 200 });
    h.socket.deliverText(inputHold('s1', true));
    h.client.sendInput(encoder.encode('queued'));
    expect(h.client.heldInputBytes).toBe(6);

    h.socket.drop();
    expect(h.client.heldInputBytes).toBe(0);
    expect(h.client.inputHeld).toBe(false);

    h.flush(100);
    h.socket.accept();
    h.socket.deliverText(helloOk);
    // 重连后不会被“补发”上一轮排队的字节
    expect(sentInputs(h.socket)).toEqual([]);
  });
});

describe('TerminalClient · 落后与重连', () => {
  it('behind 触发 resync，并带上本地已知偏移', () => {
    const h = harness();
    h.client.connect();
    h.socket.accept();
    h.socket.deliverText(helloOk);
    h.client.attach('s1');
    h.socket.deliverText(attached(true, 0));
    h.socket.deliverBinary(encodeOutput(0n, encoder.encode('abc')));

    h.socket.deliverText(
      JSON.stringify({ t: 'behind', session: 's1', offset: 3, reason: 'trimmed' }),
    );
    expect(h.socket.lastText()).toEqual({ t: 'resync', session: 's1', offset: 3 });
    expect(h.states.some((s) => s.detail?.includes('正在重建'))).toBe(true);
  });

  it('断线后退避重连，重连时用本地偏移续传（这就是「刷新不丢」的机制）', () => {
    const h = harness({ backoffInitialMs: 100, backoffMaxMs: 400 });
    h.client.connect();
    h.socket.accept();
    h.socket.deliverText(helloOk);
    h.client.attach('s1');
    h.socket.deliverText(attached(true, 0));
    h.socket.deliverBinary(encodeOutput(0n, encoder.encode('abcdef')));
    expect(h.client.expectedOffset).toBe(6);

    h.socket.drop();
    expect(h.client.state).toBe('reconnecting');
    expect(h.states.at(-1)?.detail).toContain('第 1 次重连');

    h.flush(100);
    h.socket.accept();
    h.socket.deliverText(helloOk);
    // 重连后自动重新订阅，且上报本地偏移 6 → 服务端只补断档
    expect(h.socket.lastText()).toEqual({ t: 'attach', session: 's1', resume: 6 });
  });

  it('重连间隔按指数退避并封顶', () => {
    const h = harness({ backoffInitialMs: 100, backoffMaxMs: 200 });
    h.client.connect();
    h.socket.accept();
    h.socket.deliverText(helloOk);

    const attempt = (): number => {
      const detail = h.states.at(-1)?.detail ?? '';
      return Number(/第 (\d+) 次重连/.exec(detail)?.[1] ?? 0);
    };

    h.socket.drop();
    expect(attempt()).toBe(1);
    h.flush(100);
    h.socket.drop();
    expect(attempt()).toBe(2);
    h.flush(200);
    h.socket.drop();
    expect(attempt()).toBe(3);
    // 退避已被封顶：下一次仍在 200ms 内
    h.flush(200);
    h.socket.accept();
    h.socket.deliverText(helloOk);
    expect(h.client.state).toBe('ready');
  });

  it('主动 close 后不再重连', () => {
    const h = harness();
    h.client.connect();
    h.socket.accept();
    h.socket.deliverText(helloOk);

    h.client.close();
    expect(h.client.state).toBe('closed');
    expect(h.socket.closed?.code).toBe(1000);

    h.socket.drop();
    h.flush(10_000);
    expect(h.client.state).toBe('closed');
  });

  it('控制消息非法时报错但不崩', () => {
    const h = harness();
    h.client.connect();
    h.socket.accept();
    h.socket.deliverText(helloOk);
    h.socket.deliverText('{"t":"nope"}');
    expect(h.errors).toHaveLength(1);
    expect(h.client.state).toBe('ready');
  });

  it('未连接时发送输入被静默丢弃（不抛异常）', () => {
    const h = harness();
    h.client.connect();
    expect(() => h.client.sendInput(encoder.encode('x'))).not.toThrow();
    expect(h.socket.sent).toHaveLength(0);
  });

  it('不认识的负载类型上报错误', () => {
    const h = harness();
    h.client.connect();
    h.socket.accept();
    h.socket.deliverText(helloOk);
    h.socket.onmessage?.(12345);
    expect(h.errors[0]?.message).toContain('不认识的 WS 负载类型');
  });
});
