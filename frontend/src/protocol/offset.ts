/**
 * offset 在两个域之间的换算。
 *
 * 存在两个域，是因为协议用两种承载方式表达同一个坐标：
 *
 * - **帧里是 u64**（二进制，8 字节大端）→ `frames.ts` 解出 `bigint`，忠实于字节布局
 * - **应用层是 `number`**（`attached.offset` / `resume` / `ack` 都是 JSON number）
 *
 * JSON 的 number 是 IEEE-754 双精度，**超过 2^53 就不精确**。也就是说这条通道本身承载不了
 * u64 全域——要走到 2^53 字节需要 9 PB 输出，实际到不了，所以这不是缺陷，
 * 但换算必须显式、且越界时抛错：offset 是整套同步机制的坐标，悄悄错位比直接失败更糟。
 *
 * 只有**帧 → 应用层**这一个方向：客户端从不把 offset 写进帧（INPUT 帧不带 offset，
 * `resume` / `ack` 走 JSON）。所以这里没有反向函数——留一个没人调用的转换，
 * 比缺一个更糟：它会让「帧里那个 u64 与本地游标是一回事」这种误解看起来被支持。
 */

/** 应用层的 offset 类型：与非二进制通道（JSON）一致。 */
export type Offset = number;

export class OffsetRangeError extends RangeError {
  override readonly name = 'OffsetRangeError';
}

/** 帧 → 应用层。超出安全整数范围时抛错，而不是静默取近似值。 */
export function offsetToNumber(value: bigint): Offset {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new OffsetRangeError(`offset 超出 JS 安全整数范围: ${value}`);
  }
  return Number(value);
}
