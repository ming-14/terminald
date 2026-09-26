/**
 * 尺寸控制的决策逻辑（纯函数；碰 DOM 的部分留在 `app.ts`）。
 *
 * 抽出来的理由与 `remember.ts` / `shortcuts.ts` 一样：这里两条判断都有明确的真值表
 * （按钮该不该置灰、手输的算不算数），而它们埋在 DOM 装配里就只能靠浏览器探针覆盖——
 * 那些是端到端的证据，代价高、覆盖不到边角输入。
 */

import type { SessionStatus } from '../protocol/messages.js';

/**
 * 尺寸弹层里的预设。
 *
 * 三个"常见终端"档，够用且不用记；要别的档位走手输。**不**做成"按窗口自动适应"：
 * 网格尺寸由终端侧决定、浏览器可视面积不参与（`docs/architecture.md` §4），
 * 所以这里给的是几个**固定的网格**，窗口大小只影响字号。
 */
export const SIZE_PRESETS: readonly (readonly [number, number])[] = [
  [80, 24],
  [120, 30],
  [160, 40],
];

export interface SizeChipState {
  /** chip 上显示的文字。 */
  readonly text: string;
  readonly disabled: boolean;
  readonly title: string;
}

/**
 * 顶栏那个尺寸 chip 的状态。
 *
 * 三条：还没拿到网格（未订阅）显示占位；会话不在运行就置灰；其余情况可点。
 * 已退出不可改的理由是尺寸要落到 PTY 上才有意义（进程都没了）——所以在这里置灰，
 * 而不是让用户点一下、再收到一条服务端错误。
 */
export function sizeChipState(
  size: { readonly cols: number; readonly rows: number } | null,
  status: SessionStatus | null,
): SizeChipState {
  const disabled = size === null || status !== 'running';
  return {
    text: size === null ? '—' : `${size.cols}×${size.rows}`,
    disabled,
    title: disabled ? '会话未在运行，尺寸不可改' : '更改终端尺寸',
  };
}

/**
 * 解析手输的两个输入框；给不出两个正整数就返回 `null`（由调用方提示）。
 *
 * 这里**只**判"是不是一个正整数"，**不判上下界**：上下界（`SESSION_COLS_MIN` 等）是协议层
 * 的事实，前端抄一份只会多一个会漂移的常量——与 `#rename` 对名字长度是同一条纪律。
 * 越界由服务端用 `error` 拒回，而那条消息本来就会显示成提示。
 *
 * 拦住的是另一种东西：空串、`abc`、`12.5`、`1e3`、`12abc`、`0`、`-4` 这些**根本不是尺寸**的
 * 输入——发出去只会白等一个必然失败的往返，还会在界面上闪一下错误。
 */
export function parseSizeInput(
  colsText: string,
  rowsText: string,
): { readonly cols: number; readonly rows: number } | null {
  const cols = toPositiveInt(colsText);
  const rows = toPositiveInt(rowsText);
  if (cols === null || rows === null) return null;
  return { cols, rows };
}

function toPositiveInt(text: string): number | null {
  // 不用 `Number.parseInt`：它会把 `12abc` 解成 12、把 `1e3` 解成 1、把 `12.5` 解成 12，
  // 也就是把"用户打错了"悄悄当成一个合法尺寸。整串必须是数字（允许两端空白）。
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}
