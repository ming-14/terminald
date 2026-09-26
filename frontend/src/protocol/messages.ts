/**
 * 控制消息（文本帧 / JSON）—— 与后端 `terminald/protocol/messages.py` 一致。
 *
 * 后端用 pydantic 严格校验（`extra="forbid"`），这里手写等价校验：字段拼错必须在边界立刻
 * 暴露，而不是变成一个静默失效的功能。手写而不是引入 zod 之类的依赖——消息只有 20 种、
 * 字段类型只有 5 种，多一个运行时依赖不划算。
 *
 * 方向是不对称的：`ClientMessage` 只由本端构造（不需要解析），`ServerMessage` 只由本端解析
 * （不需要构造）。因此下面只实现「解析服务端消息 + 构造客户端消息」两条路径。
 */

/** 协议版本：与 `vectors/basic.json` 的 `version` 必须一致（由测试断言）。 */
export const PROTOCOL_VERSION = 1;

export class MessageError extends Error {
  override readonly name = 'MessageError';
}

export type SessionStatus = 'running' | 'exited';

export interface SessionInfo {
  readonly id: string;
  readonly name: string;
  readonly cols: number;
  readonly rows: number;
  readonly status: SessionStatus;
  readonly created_at: string;
  readonly pid: number | null;
  readonly cwd: string | null;
  readonly title: string | null;
}

export interface HelloOk {
  readonly t: 'hello_ok';
  readonly protocol: number;
  readonly server: string;
}

/**
 * 订阅成功。`offset` 是**本次对齐完成处**的偏移，客户端据此设置下一帧基线。
 *
 * `resumed` 的含义是**这次对齐是否无损**，而不是「是不是老客户端」：
 * `true` = 字节级对齐；`false` = 日志已裁剪到断点之前，只能靠模型快照重建（唯一有损路径）。
 * 客户端不需要因此改变行为（两种情况后续都从 `offset` 续接），它的用途是**可观测性**：
 * 无损对齐与有损重建应该被分开计数、分开提示。
 *
 * `cols` / `rows` / `scrollback` 都是**终端侧属性**，由服务端一并交付——客户端无权修改，
 * 也不该自己猜。`scrollback` 不传的话前端只能写死一个数去和服务端配置对齐，那会漂移。
 */
export interface Attached {
  readonly t: 'attached';
  readonly session: string;
  readonly cols: number;
  readonly rows: number;
  readonly scrollback: number;
  readonly offset: number;
  readonly resumed: boolean;
}

/**
 * 会话尺寸已变更（下行）。
 *
 * **它在流里的位置是有意义的**：服务端保证本端先收到「按旧尺寸产生的全部字节」、再收到
 * 这一条、之后才是新尺寸的字节（服务端的 `Client.pending_resizes` + `_push_client` 保证）。
 * 所以收到它就照做——`term.resize(cols, rows)`，再重跑字号求解。
 *
 * 消息本身不携带任何重绘字节：xterm 会在 resize 时按新宽度重排自己的缓冲区（这是它内置的
 * reflow，见 `app.ts` 里 `windowsPty` 的注释）。真正的重建路径只有一条——日志被裁剪后的
 * `SNAPSHOT`。
 */
export interface Resized {
  readonly t: 'resized';
  readonly session: string;
  readonly cols: number;
  readonly rows: number;
}

export interface Meta {
  readonly t: 'meta';
  readonly session: string;
  readonly title: string | null;
  readonly cwd: string | null;
  readonly progress_label: string;
  readonly progress_value: number | null;
}

export interface Exited {
  readonly t: 'exited';
  readonly session: string;
  readonly code: number;
}

export interface Sessions {
  readonly t: 'sessions';
  readonly items: readonly SessionInfo[];
}

/**
 * 服务端告知该客户端已落后：增量已停止发送，请发起 Resync。
 *
 * 这是「绝不静默丢弃字节」的落点——落后是**显式状态**，不是静默丢失。
 */
export interface Behind {
  readonly t: 'behind';
  readonly session: string;
  readonly offset: number;
  readonly reason: string;
}

export interface Failure {
  readonly t: 'error';
  readonly code: string;
  readonly message: string;
}

/**
 * 输入方向的流控：服务端要求本客户端**暂缓/恢复**发送输入。
 *
 * 收到 `paused: true` 后，输入必须在本端按序排队，等服务端放行（`paused: false`）
 * 再原序补发——字节一个不丢。为什么不是服务端停读：停读会把同一条连接上的控制面
 * （detach、关闭会话、焦点上报）一起堵住，而且对端在暂停期间断开时服务端无从察觉。
 *
 * `session` 必须校验：切换会话后到达的旧暂缓/放行不得影响新订阅。
 */
export interface InputHold {
  readonly t: 'input_hold';
  readonly session: string;
  readonly paused: boolean;
}

export type ServerMessage =
  | HelloOk
  | Attached
  | Resized
  | Meta
  | Exited
  | Sessions
  | Behind
  | InputHold
  | Failure;

/** 服务端消息里 `t` 的取值集合；用于判别与错误信息。 */
export const SERVER_MESSAGE_TYPES = [
  'hello_ok',
  'attached',
  'resized',
  'meta',
  'exited',
  'sessions',
  'behind',
  'input_hold',
  'error',
] as const;

/** 客户端消息里 `t` 的取值集合；与后端 `test_protocol.py::_CLIENT_MESSAGE_TYPES` 对应。 */
export const CLIENT_MESSAGE_TYPES = [
  'hello',
  'attach',
  'detach',
  'resync',
  'ack',
  'focus',
  'session.create',
  'session.list',
  'session.close',
  'session.rename',
  'session.resize',
] as const;

// --------------------------------------------------------------- 校验

export type Kind =
  | 'str'
  | 'int'
  | 'bool'
  | 'str|null'
  | 'int|null'
  | 'sessionInfo'
  | 'sessionInfo[]';

export type Shape = Readonly<Record<string, Kind>>;

/**
 * 会话摘要的字段形状。与 `SHAPES` 一样必须与后端模型一致——`vectors/shapes.json` 是
 * 那份事实，`frames.test.ts` 里逐字比对（生成命令写在该文件的 `$comment` 里）。
 */
export const SESSION_INFO_SHAPE: Shape = {
  id: 'str',
  name: 'str',
  cols: 'int',
  rows: 'int',
  status: 'str',
  created_at: 'str',
  pid: 'int|null',
  cwd: 'str|null',
  title: 'str|null',
};

/**
 * 每种服务端消息的字段形状。
 *
 * 手写一份在这里是**刻意**的：它比 setter 更直接地表达了「哪些字段、什么类型、多一个都不行」。
 * 但它会漂移，所以 `frames.test.ts` 拿后端生成的 `vectors/shapes.json` 逐字比对——
 * 两边同时改错才会漏过。
 */
export const SHAPES: Readonly<Record<string, Shape>> = {
  hello_ok: { protocol: 'int', server: 'str' },
  attached: {
    session: 'str',
    cols: 'int',
    rows: 'int',
    scrollback: 'int',
    offset: 'int',
    resumed: 'bool',
  },
  resized: {
    session: 'str',
    cols: 'int',
    rows: 'int',
  },
  meta: {
    session: 'str',
    title: 'str|null',
    cwd: 'str|null',
    progress_label: 'str',
    progress_value: 'int|null',
  },
  exited: { session: 'str', code: 'int' },
  sessions: { items: 'sessionInfo[]' },
  behind: { session: 'str', offset: 'int', reason: 'str' },
  input_hold: { session: 'str', paused: 'bool' },
  error: { code: 'str', message: 'str' },
};

function checkValue(key: string, kind: Kind, value: unknown): string | null {
  switch (kind) {
    case 'str':
      return typeof value === 'string' ? null : `${key}: 期望字符串，得到 ${typeof value}`;
    case 'int':
      return typeof value === 'number' && Number.isInteger(value)
        ? null
        : `${key}: 期望整数，得到 ${String(value)}`;
    case 'bool':
      return typeof value === 'boolean' ? null : `${key}: 期望布尔值，得到 ${String(value)}`;
    case 'str|null':
      return value === null || typeof value === 'string'
        ? null
        : `${key}: 期望字符串或 null，得到 ${typeof value}`;
    case 'int|null':
      return value === null || (typeof value === 'number' && Number.isInteger(value))
        ? null
        : `${key}: 期望整数或 null，得到 ${String(value)}`;
    case 'sessionInfo': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return `${key}: 期望会话对象`;
      }
      return checkShape(key, SESSION_INFO_SHAPE, value as Record<string, unknown>);
    }
    case 'sessionInfo[]': {
      if (!Array.isArray(value)) return `${key}: 期望会话数组`;
      for (const [index, item] of value.entries()) {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) {
          return `${key}[${index}]: 期望会话对象`;
        }
        const problem = checkShape(`${key}[${index}]`, SESSION_INFO_SHAPE, item as Record<string, unknown>);
        if (problem !== null) return problem;
      }
      return null;
    }
  }
}

function checkShape(prefix: string, shape: Shape, value: Record<string, unknown>): string | null {
  for (const key of Object.keys(shape)) {
    const kind = shape[key];
    if (kind === undefined) continue;
    const problem = checkValue(`${prefix}.${key}`, kind, value[key]);
    if (problem !== null) return problem;
  }
  // 与后端 `extra="forbid"` 对齐：多出来的字段是错误，不是可以忽略的噪声
  const allowed = new Set([...Object.keys(shape), 't']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return `${prefix}: 未知字段 ${key}`;
  }
  return null;
}

/** 解析一条服务端控制消息；非法输入抛 `MessageError`。 */
export function parseServerMessage(raw: string): ServerMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new MessageError(`非法 JSON: ${String(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new MessageError('控制消息必须是 JSON 对象');
  }
  const record = parsed as Record<string, unknown>;
  const type = record['t'];
  if (typeof type !== 'string') throw new MessageError('控制消息缺少字符串字段 t');

  const shape = SHAPES[type];
  if (shape === undefined) {
    if ((CLIENT_MESSAGE_TYPES as readonly string[]).includes(type)) {
      throw new MessageError(`${type} 是客户端消息，服务端不该下发`);
    }
    throw new MessageError(`未知消息类型: ${type}`);
  }
  const problem = checkShape(type, shape, record);
  if (problem !== null) throw new MessageError(problem);

  const message = parsed as ServerMessage;
  if (message.t === 'sessions') {
    for (const item of message.items) {
      if (item.status !== 'running' && item.status !== 'exited') {
        throw new MessageError(`sessions.status 非法: ${String(item.status)}`);
      }
    }
  }
  return message;
}

// --------------------------------------------------------------- 客户端消息构造

export function hello(client: string): string {
  return JSON.stringify({ t: 'hello', protocol: PROTOCOL_VERSION, client });
}

/** 订阅会话。`resume` 是本端**已应用到终端**的偏移；全新客户端传 `null`。 */
export function attach(session: string, resume: number | null): string {
  return JSON.stringify({ t: 'attach', session, resume });
}

export function detach(): string {
  return JSON.stringify({ t: 'detach' });
}

export function resync(session: string, offset: number): string {
  return JSON.stringify({ t: 'resync', session, offset });
}

/** 确认「已解析到 offset 之前的全部字节」，服务端据此放开流控。 */
export function ack(offset: number): string {
  return JSON.stringify({ t: 'ack', offset });
}

export function focus(focused: boolean): string {
  return JSON.stringify({ t: 'focus', focused });
}

export function sessionCreate(name: string | null = null, argv: string[] | null = null, cwd: string | null = null): string {
  return JSON.stringify({ t: 'session.create', name, argv, cwd });
}

export function sessionList(): string {
  return JSON.stringify({ t: 'session.list' });
}

export function sessionClose(session: string): string {
  return JSON.stringify({ t: 'session.close', session });
}

export function sessionRename(session: string, name: string): string {
  return JSON.stringify({ t: 'session.rename', session, name });
}

/**
 * 请求变更会话尺寸。
 *
 * 边界（`SESSION_COLS_MIN` / `SESSION_ROWS_MIN` / `SESSION_SIZE_MAX`）**不在这里重复一遍**：
 * 那是协议侧的事实，前端抄一份只会多一个会漂移的常量（与 `session.rename` 的名字长度同一个道理）。
 * 越界由服务端拒回，而那条消息本来就会显示成提示（见 `app.ts` 的 `error` 分支）。
 */
export function sessionResize(session: string, cols: number, rows: number): string {
  return JSON.stringify({ t: 'session.resize', session, cols, rows });
}
