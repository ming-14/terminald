/**
 * 二进制帧编解码 —— 与后端 `terminald/protocol/frames.py` **逐字节一致**。
 *
 * 真源在后端；这个文件是它的镜像。字节布局一处不同，`frames.test.ts` 跑同一份
 * `vectors/basic.json` 就会红。
 *
 * ```
 * FRAME = 长度(u32 大端) | tag(u8) | [offset(u64 大端)] | payload
 * ```
 *
 * `长度` 覆盖 `tag + [offset] + payload`（不含长度字段自身，最少 1）。
 * 一条 WebSocket 二进制消息可以串接多个帧。
 *
 * offset 用 `bigint` 承载：线上就是 u64，而 JSON 的 number 是双精度，超过 2^53 表达不精确。
 * 帧这一层必须忠实于字节布局（共享向量里就有 > 2^53 的用例），应用层要的 number 由
 * `offset.ts` 的转换函数在边界上一次性换算——换算处带越界检查，绝不静默截断。
 */

export const MAX_FRAME_BYTES = 64 * 1024 * 1024;
export const MAX_OFFSET = (1n << 64n) - 1n;

const LEN_BYTES = 4;
const TAG_BYTES = 1;
const OFFSET_BYTES = 8;

// 用普通 enum 而不是 const enum：`isolatedModules` 下 const enum 不被支持（单文件转译
// 无法内联），而 esbuild 也不会为它做常量折叠。
export enum FrameTag {
  OUTPUT = 0x01,
  INPUT = 0x02,
  SNAPSHOT = 0x03,
}

const OFFSET_BEARING: ReadonlySet<FrameTag> = new Set([FrameTag.OUTPUT, FrameTag.SNAPSHOT]);

export class FrameError extends Error {
  override readonly name = 'FrameError';
}

export interface DecodedFrame {
  readonly tag: FrameTag;
  /** OUTPUT / SNAPSHOT 有，INPUT 为 null */
  readonly offset: bigint | null;
  /** 指向原消息的视图，不复制 */
  readonly payload: Uint8Array;
}

// --------------------------------------------------------------- 编码

function encode(tag: FrameTag, payload: Uint8Array, offset: bigint | null): Uint8Array {
  const bearing = OFFSET_BEARING.has(tag);
  if (bearing) {
    if (offset === null) throw new FrameError(`${tagName(tag)} 帧必须带 offset`);
    if (offset < 0n || offset > MAX_OFFSET) {
      throw new FrameError(`offset 越界: ${offset}`);
    }
  } else if (offset !== null) {
    throw new FrameError(`${tagName(tag)} 帧不接受 offset`);
  }

  const length = TAG_BYTES + (bearing ? OFFSET_BYTES : 0) + payload.byteLength;
  if (length > MAX_FRAME_BYTES) throw new FrameError(`帧过大: ${length}`);

  const out = new Uint8Array(LEN_BYTES + length);
  const view = new DataView(out.buffer);
  view.setUint32(0, length, false);
  out[LEN_BYTES] = tag;
  if (bearing) {
    view.setBigUint64(LEN_BYTES + TAG_BYTES, offset as bigint, false);
  }
  out.set(payload, LEN_BYTES + TAG_BYTES + (bearing ? OFFSET_BYTES : 0));
  return out;
}

/** OUTPUT 帧：日志中 `[offset, offset+len(payload))` 的输出字节。 */
export function encodeOutput(offset: bigint, payload: Uint8Array): Uint8Array {
  return encode(FrameTag.OUTPUT, payload, offset);
}

/** SNAPSHOT 帧：模型重建字节，应用后对齐到 `offset`。 */
export function encodeSnapshot(offset: bigint, payload: Uint8Array): Uint8Array {
  return encode(FrameTag.SNAPSHOT, payload, offset);
}

/** INPUT 帧：客户端已按当前模式编码好的输入字节。 */
export function encodeInput(payload: Uint8Array): Uint8Array {
  return encode(FrameTag.INPUT, payload, null);
}

// --------------------------------------------------------------- 解码

function tagName(tag: number): string {
  switch (tag) {
    case FrameTag.OUTPUT:
      return 'OUTPUT';
    case FrameTag.INPUT:
      return 'INPUT';
    case FrameTag.SNAPSHOT:
      return 'SNAPSHOT';
    default:
      return `0x${tag.toString(16)}`;
  }
}

/**
 * 解析整条消息，逐个产出帧。
 *
 * 非法/截断的帧**抛错，绝不静默跳过**：静默跳过会让两端状态悄然分叉，
 * 而那正是这套协议存在的意义所在。
 */
export function* iterFrames(message: Uint8Array): Generator<DecodedFrame> {
  const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
  const total = message.byteLength;
  let pos = 0;

  while (pos < total) {
    if (total - pos < LEN_BYTES + TAG_BYTES) {
      throw new FrameError(`帧头被截断: 剩余 ${total - pos} 字节`);
    }
    const length = view.getUint32(pos, false);
    const tagByte = view.getUint8(pos + LEN_BYTES);
    pos += LEN_BYTES + TAG_BYTES;

    if (length < 1 || pos + length - 1 > total) {
      throw new FrameError(`帧长度非法: ${length}（剩余 ${total - pos + 1}）`);
    }
    if (
      tagByte !== FrameTag.OUTPUT &&
      tagByte !== FrameTag.INPUT &&
      tagByte !== FrameTag.SNAPSHOT
    ) {
      throw new FrameError(`未知帧标签: 0x${tagByte.toString(16)}`);
    }
    const tag = tagByte as FrameTag;

    let offset: bigint | null = null;
    if (OFFSET_BEARING.has(tag)) {
      if (length < TAG_BYTES + OFFSET_BYTES) {
        throw new FrameError(`${tagName(tag)} 帧长度不足以容纳 offset: ${length}`);
      }
      offset = view.getBigUint64(pos, false);
      pos += OFFSET_BYTES;
    }

    const consumed = TAG_BYTES + (offset === null ? 0 : OFFSET_BYTES);
    const payload = message.subarray(pos, pos + length - consumed);
    pos += length - consumed;
    yield { tag, offset, payload };
  }
}

/** 解析消息中全部 INPUT 帧的负载。 */
export function decodeInput(message: Uint8Array): Uint8Array[] {
  const payloads: Uint8Array[] = [];
  for (const frame of iterFrames(message)) {
    if (frame.tag !== FrameTag.INPUT) {
      throw new FrameError(`不是 INPUT 帧: ${tagName(frame.tag)}`);
    }
    payloads.push(frame.payload);
  }
  return payloads;
}

/** 解析**恰好一个** OUTPUT 帧（测试与简单场景用）。 */
export function decodeOutput(message: Uint8Array): { offset: bigint; payload: Uint8Array } {
  const frames = [...iterFrames(message)];
  const first = frames[0];
  if (frames.length !== 1 || first === undefined) {
    throw new FrameError(`期望恰好一个帧，实得 ${frames.length} 个`);
  }
  if (first.tag !== FrameTag.OUTPUT || first.offset === null) {
    throw new FrameError(`不是 OUTPUT 帧: ${tagName(first.tag)}`);
  }
  return { offset: first.offset, payload: first.payload };
}
