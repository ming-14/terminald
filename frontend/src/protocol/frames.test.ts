/**
 * 协议层测试：帧编解码、共享向量、控制消息方向约束。
 *
 * `vectors/basic.json` 是**前后端的共同契约**，而且这份文件是**引用**后端的原件
 * （见 `vite.config.ts` 的 `@protocol-vectors` 别名），不是复制品。任何一侧改了字节布局，
 * 这里立刻红——这比在两边各写一遍「期望值」可靠，因为人写两边的时候很可能把同一个误解
 * 写两遍。
 *
 * 用例用 `for` 循环展开而不是 `it.each`：向量文件是 JSON，元素类型只能声明成接口，
 * 走 `it.each` 会把回调参数类型擦成联合体，反而更容易写错。
 */

import vectorsJson from '@protocol-vectors';
import { describe, expect, it } from 'vitest';

import {
  FrameError,
  FrameTag,
  MAX_OFFSET,
  decodeInput,
  decodeOutput,
  encodeInput,
  encodeOutput,
  encodeSnapshot,
  iterFrames,
} from './frames.js';
import {
  CLIENT_MESSAGE_TYPES,
  MessageError,
  PROTOCOL_VERSION,
  SHAPES,
  SESSION_INFO_SHAPE,
  ack,
  attach,
  hello,
  parseServerMessage,
} from './messages.js';
import shapesJson from '@protocol-shapes';

interface Why {
  readonly why: string;
}
interface OffsetCase extends Why {
  /** u64 用十进制字符串表达：JSON number 承载不了 > 2^53 的值 */
  readonly offset: string;
  readonly payload_utf8: string;
  readonly hex: string;
}
interface InputCase extends Why {
  readonly payload_utf8: string;
  readonly hex: string;
}
interface BatchedCase extends Why {
  readonly hex: string;
}
interface ControlCase extends Why {
  readonly json: Record<string, unknown>;
}

const vectors = vectorsJson as unknown as {
  readonly version: number;
  readonly output_frames: readonly OffsetCase[];
  readonly snapshot_frames: readonly OffsetCase[];
  readonly input_frames: readonly InputCase[];
  readonly batched: readonly BatchedCase[];
  readonly control_messages: readonly ControlCase[];
};

const encoder = new TextEncoder();

function hex(value: string): Uint8Array {
  const clean = value.trim();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const isClientType = (type: string): boolean =>
  (CLIENT_MESSAGE_TYPES as readonly string[]).includes(type);

// --------------------------------------------------------------- 共享向量

describe('共享向量（与后端同一份文件）', () => {
  it('协议版本与向量版本一致', () => {
    expect(PROTOCOL_VERSION).toBe(vectors.version);
  });

  for (const testCase of vectors.output_frames) {
    it(`OUTPUT 帧往返：${testCase.why}`, () => {
      const payload = encoder.encode(testCase.payload_utf8);
      const raw = encodeOutput(BigInt(testCase.offset), payload);
      expect(toHex(raw)).toBe(testCase.hex);

      const decoded = decodeOutput(raw);
      expect(decoded.offset).toBe(BigInt(testCase.offset));
      expect([...decoded.payload]).toEqual([...payload]);
    });
  }

  for (const testCase of vectors.snapshot_frames) {
    it(`SNAPSHOT 帧与 OUTPUT 同布局、不同 tag：${testCase.why}`, () => {
      const payload = encoder.encode(testCase.payload_utf8);
      const raw = encodeSnapshot(BigInt(testCase.offset), payload);
      expect(toHex(raw)).toBe(testCase.hex);

      const frames = [...iterFrames(raw)];
      expect(frames).toHaveLength(1);
      expect(frames[0]?.tag).toBe(FrameTag.SNAPSHOT);
      expect(frames[0]?.offset).toBe(BigInt(testCase.offset));
      expect([...(frames[0]?.payload ?? [])]).toEqual([...payload]);
    });
  }

  for (const testCase of vectors.input_frames) {
    it(`INPUT 帧：${testCase.why}`, () => {
      const payload = encoder.encode(testCase.payload_utf8);
      expect(toHex(encodeInput(payload))).toBe(testCase.hex);
      expect(decodeInput(hex(testCase.hex)).map((p) => [...p])).toEqual([[...payload]]);
    });
  }

  for (const testCase of vectors.batched) {
    it(`一条消息串接多帧：${testCase.why}`, () => {
      const frames = [...iterFrames(hex(testCase.hex))];
      expect(frames.map((f) => [f.tag, f.offset, [...f.payload]])).toEqual([
        [FrameTag.OUTPUT, 0n, [...encoder.encode('hi')]],
        [FrameTag.INPUT, null, [...encoder.encode('x')]],
      ]);
    });
  }

  for (const testCase of vectors.control_messages) {
    it(`控制消息只在一个方向上合法：${testCase.why}`, () => {
      const text = JSON.stringify(testCase.json);
      const type = testCase.json['t'];
      expect(typeof type).toBe('string');

      // 每个向量**只在一个方向上合法**，所以两个方向里恰好一个能成功——
      // 这本身就是方向约束的断言（与后端 test_protocol.py 同构）。
      if (isClientType(type as string)) {
        expect(() => parseServerMessage(text)).toThrow(MessageError);
      } else {
        expect(parseServerMessage(text)).toEqual(testCase.json);
      }
    });
  }
});

// --------------------------------------------------------------- 帧边界

describe('帧边界', () => {
  it('offset 边界值往返一致（含 u64 全域端点）', () => {
    const offsets = [
      0n,
      1n,
      255n,
      65535n,
      (1n << 32n) - 1n,
      1n << 32n,
      BigInt(Number.MAX_SAFE_INTEGER),
      72623859790382856n,
      MAX_OFFSET,
    ];
    for (const offset of offsets) {
      expect(decodeOutput(encodeOutput(offset, encoder.encode('x'))).offset).toBe(offset);
    }
  });

  it('offset 越界时抛错而不是截断', () => {
    expect(() => encodeOutput(-1n, new Uint8Array())).toThrow(FrameError);
    expect(() => encodeOutput(MAX_OFFSET + 1n, new Uint8Array())).toThrow(FrameError);
  });

  it('空消息不产生帧，也不是错误', () => {
    expect([...iterFrames(new Uint8Array())]).toEqual([]);
  });

  const full = encodeOutput(0n, encoder.encode('he'));
  const malformed: ReadonlyArray<readonly [string, Uint8Array]> = [
    ['长度为 0', new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x01])],
    ['未知标签', new Uint8Array([0x00, 0x00, 0x00, 0x02, 0x7f, 0x00])],
    ['OUTPUT 帧长度不足以容纳 offset', new Uint8Array([0x00, 0x00, 0x00, 0x05, 0x01, 0, 0, 0, 0, 0, 0, 0])],
    ['声明的负载长度超过实际字节数（截断一字节）', full.subarray(0, full.byteLength - 1)],
    ['帧头被截断（只剩 4 字节）', full.subarray(0, 4)],
    ['两帧中第二帧被截断', new Uint8Array([...full, ...full.subarray(0, full.byteLength - 1)])],
  ];

  for (const [why, raw] of malformed) {
    it(`非法帧必须抛错而不是静默跳过：${why}`, () => {
      expect(() => [...iterFrames(raw)]).toThrow(FrameError);
    });
  }

  it('payload 是视图而不是拷贝（大块输出直接透传，不做额外复制）', () => {
    const raw = encodeOutput(0n, new Uint8Array(32));
    const frame = [...iterFrames(raw)][0];
    expect(frame?.payload.buffer).toBe(raw.buffer);
    expect(frame?.payload.byteLength).toBe(32);
  });
});

// --------------------------------------------------------------- 控制消息

describe('控制消息', () => {
  it('字段形状与后端生成的契约逐字一致', () => {
    // 三方对齐：后端 `server_message_shapes()` 生成 shapes.json，这里逐字比。
    // 少了这条，后端改字段而前端不知道时，前端会按“多余字段是错误”把整条消息丢掉。
    const contract = shapesJson as unknown as Record<string, Record<string, string>>;
    const expected: Record<string, Record<string, string>> = {
      ...contract,
      // 会话摘要嵌在 sessions 里，后端把它单独列成 session_info，前端也是单独一份
      session_info: contract['session_info'] ?? {},
    };
    delete (expected as Record<string, unknown>)['$comment'];

    const actual: Record<string, Record<string, string>> = {
      ...SHAPES,
      session_info: { ...SESSION_INFO_SHAPE },
    };
    expect(actual).toEqual(expected);
  });

  it('未知字段被拒绝（对齐后端 extra=forbid）', () => {
    expect(() =>
      parseServerMessage('{"t":"behind","session":"s1","offset":0,"reason":"x","extra":1}'),
    ).toThrow(MessageError);
  });

  it('缺失必需字段被拒绝', () => {
    expect(() => parseServerMessage('{"t":"attached","session":"s1"}')).toThrow(MessageError);
  });

  it('未知消息类型被拒绝', () => {
    expect(() => parseServerMessage('{"t":"nope"}')).toThrow(MessageError);
  });

  it('非对象或坏 JSON 被拒绝', () => {
    expect(() => parseServerMessage('[]')).toThrow(MessageError);
    expect(() => parseServerMessage('{')).toThrow(MessageError);
  });

  it('sessions.status 只接受 running / exited', () => {
    const ok = JSON.stringify({
      t: 'sessions',
      items: [
        {
          id: 's1',
          name: 'n',
          cols: 80,
          rows: 24,
          status: 'running',
          created_at: 'x',
          pid: null,
          cwd: null,
          title: null,
        },
      ],
    });
    expect(parseServerMessage(ok).t).toBe('sessions');
    expect(() => parseServerMessage(ok.replace('"running"', '"weird"'))).toThrow(MessageError);
  });

  it('构造出的客户端消息字段与后端契约一致', () => {
    expect(JSON.parse(hello('web'))).toEqual({ t: 'hello', protocol: 1, client: 'web' });
    expect(JSON.parse(attach('s1', null))).toEqual({ t: 'attach', session: 's1', resume: null });
    expect(JSON.parse(attach('s1', 4096))).toEqual({ t: 'attach', session: 's1', resume: 4096 });
    expect(JSON.parse(ack(12))).toEqual({ t: 'ack', offset: 12 });
  });

  it('客户端消息被服务端解析器拒绝（方向约束）', () => {
    for (const text of [hello('web'), attach('s1', null), ack(0)]) {
      expect(() => parseServerMessage(text)).toThrow(MessageError);
    }
  });
});
