/**
 * WebSocket 客户端 —— 握手、订阅、输入、两个方向的流控、落后重同步、断线续传。
 *
 * ## 输入方向的背压：排队在本端
 *
 * 服务端写队列到高水位时会下发 `input_hold{paused:true}`，此时 `sendInput` 不再发出，
 * 而是按序排进本端队列；收到 `paused:false` 后原序补发。这样服务端不会无限缓冲，
 * 也不需要停读接收循环（停读会把同一条连接上的控制消息一起堵住），而字节一个不丢。
 *
 * ### 补发必须**分批**，而且新输入要排在积压后面
 *
 * 放行不等于“可以把整队一次倒出去”：服务端的硬上限会看瞬时队列深度，一次性倒出多少
 * 字节就是给它的队列加多少字节。全量倒出的客户端**完全守规矩**却会被当成违约而断开
 * （实测：暂缓后一次倒出 8 MiB、硬上限 4 MiB → `input_overflow` + 1009，输入被截断）。
 * 默认配置下同样可达（本端队列上限 16 MiB == 服务端 `input_hard_bytes` 默认值 16 MiB）。
 *
 * 所以每次放行只送出 `heldFlushBytes`（默认 1 MiB，远小于任何合理的硬上限），并且
 * **过大的一段会被切开**——用户的粘贴在本端就是一大块字节，不切就等于没限速。剩下的部分
 * 用 `heldFlushIntervalMs`（默认 50ms）的进度定时器继续送：服务端高水位比本端批量小的时候
 * 它会再次下发暂缓（本端立即停手），比本端批量大时也不会把尾巴永远卡在本地。
 *
 * 只要积压非空，新输入就**一律入队**而不是直接发出——否则用户在补发过程中按下的键
 * 会插到积压前面，破坏 PTY 的字节序。
 *
 * 队列有上限（`heldInputMaxBytes`）：超过时上报错误并**只保留先到的部分**。
 * 这里不做静默丢字节——丢了多少、为什么丢，必须能被上层看见。
 *
 * ## 两条 offset 是分开的，这是这个文件的重点
 *
 * - `expectedOffset`：**下一个期望收到的**输出偏移。它同时是本端的本地状态，重连时原样
 *   作为 `attach.resume` 发回去——「刷新 / 断线都不丢」的全部机制就是它。
 * - `parsedOffset`：**已交给 xterm 并解析完**的偏移。由 `markParsed()` 推进，是 `ack` 的内容，
 *   也是服务端放开流控的依据。
 *
 * 两者之差 = 「在路上 / 还在 xterm 写缓冲里」的字节数。把它们混成一个值，就会出现
 * 「服务端以为你已经解析完」而实际还在排队——慢客户端上的静默丢字节就是这么来的。
 *
 * ## 为什么不是「收到就 ack」
 *
 * `ack` 表示「已解析」，而 xterm 的 `write()` 是异步的：只有在 write 回调里 ack 才是真的。
 * 又不能每批都 ack（一条消息一次回程太贵），所以按「字节数或时间取先到者」节流，
 * 与 xterm.js 官方 flowcontrol 指南给的做法一致。
 *
 * ## 可测性
 *
 * socket 与定时器都从构造参数注入，因此这里的状态机（offset 推进、连续性校验、
 * behind→resync、退避重连）可以在 node 里用假 socket / 假时钟完整测出来。
 */

import { FrameError, FrameTag, encodeInput, iterFrames } from '../protocol/frames.js';
import {
  MessageError,
  ack as encodeAck,
  attach as encodeAttach,
  focus as encodeFocus,
  hello as encodeHello,
  parseServerMessage,
  sessionList as encodeSessionList,
  resync as encodeResync,
  type Attached,
  type Behind,
  type InputHold,
  type ServerMessage,
} from '../protocol/messages.js';
import { offsetToNumber, type Offset } from '../protocol/offset.js';

export type ConnectionState = 'idle' | 'connecting' | 'ready' | 'reconnecting' | 'closed';

/** 只用到的那几个 WebSocket 成员，抽出来是为了能注入假 socket。 */
export interface SocketLike {
  binaryType: string;
  readyState: number;
  send(data: string | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((data: unknown) => void) | null;
}

export interface ClientHandlers {
  /** 连接状态变化。`detail` 给人看（例如「有损重建」「第 3 次重连」）。 */
  onState(state: ConnectionState, detail?: string): void;
  /**
   * 收到一段输出字节。`endOffset` 是这段字节**之后**的偏移——调用方应把它交给 xterm，
   * 并在 write 回调里调用 `markParsed(endOffset)`。
   */
  onOutput(chunk: Uint8Array, endOffset: Offset): void;
  /** 其他服务端消息（会话列表、元数据、退出……）。 */
  onMessage(message: ServerMessage): void;
  /** 协议层面的错误（帧非法、连续性被破坏）。 */
  onError(error: Error): void;
}

export interface ClientOptions {
  readonly url: string;
  /** 自述标签，仅用于服务端日志/列表展示。 */
  readonly label?: string;
  readonly createSocket?: (url: string) => SocketLike;
  readonly now?: () => number;
  readonly schedule?: (fn: () => void, ms: number) => unknown;
  readonly cancel?: (handle: unknown) => void;
  /** 累计多少字节未 ack 就发一次（节流下限之一）。 */
  readonly ackBytes?: number;
  /** 距上次 ack 最多多久发一次（节流下限之二）。 */
  readonly ackIntervalMs?: number;
  readonly backoffInitialMs?: number;
  readonly backoffMaxMs?: number;
  /**
   * 服务端暂缓输入期间，本端最多缓存多少字节。
   *
   * 这个上限不是“优化”：没有它，一个对端不读 stdin 的会话会让浏览器把用户的粘贴
   * 全部吃进内存。超过上限时报错（不静默丢字节），并丢弃**最新**的字节。
   */
  readonly heldInputMaxBytes?: number;
  /** 每次放行最多补发多少字节（必须显著小于服务端的 `input_hard_bytes`）。 */
  readonly heldFlushBytes?: number;
  /** 补发未完时，多久推进下一批（保证服务端不再下发暂缓时也能把尾巴送完）。 */
  readonly heldFlushIntervalMs?: number;
}

/** `WebSocket.OPEN`。不直接引用全局常量是为了让假 socket 也能用。 */
const SOCKET_OPEN = 1;

const DEFAULTS = {
  ackBytes: 256 * 1024,
  ackIntervalMs: 300,
  backoffInitialMs: 300,
  backoffMaxMs: 8_000,
  heldInputMaxBytes: 16 * 1024 * 1024,
  heldFlushBytes: 1024 * 1024,
  heldFlushIntervalMs: 50,
} as const;

function defaultCreateSocket(url: string): SocketLike {
  const socket = new WebSocket(url);
  // 不设成 arraybuffer 的话二进制帧会以 Blob 到达，没法同步解析
  socket.binaryType = 'arraybuffer';
  const wrapper: SocketLike = {
    get binaryType() {
      return socket.binaryType;
    },
    set binaryType(value: string) {
      // 浏览器侧只接受 'blob' | 'arraybuffer'，而 SocketLike 放宽成 string
      socket.binaryType = value as BinaryType;
    },
    get readyState() {
      return socket.readyState;
    },
    send: (data) => {
      socket.send(data as string);
    },
    close: (code, reason) => {
      socket.close(code, reason);
    },
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
  };
  socket.onopen = () => wrapper.onopen?.();
  socket.onclose = () => wrapper.onclose?.();
  socket.onerror = () => wrapper.onerror?.();
  socket.onmessage = (event: MessageEvent) => wrapper.onmessage?.(event.data);
  return wrapper;
}

export class TerminalClient {
  readonly #url: string;
  readonly #label: string;
  readonly #handlers: ClientHandlers;
  readonly #createSocket: (url: string) => SocketLike;
  readonly #now: () => number;
  readonly #schedule: (fn: () => void, ms: number) => unknown;
  readonly #cancel: (handle: unknown) => void;
  readonly #ackBytes: number;
  readonly #ackIntervalMs: number;
  readonly #backoffInitialMs: number;
  readonly #backoffMaxMs: number;
  readonly #heldInputMaxBytes: number;
  readonly #heldFlushBytes: number;
  readonly #heldFlushIntervalMs: number;

  #socket: SocketLike | null = null;
  #state: ConnectionState = 'idle';
  #session: string | null = null;
  #attempt = 0;
  #retryHandle: unknown = null;
  #ackHandle: unknown = null;
  #disposed = false;

  /** 下一个期望收到的输出偏移（= 本地状态，重连时作为 resume 上报）。 */
  #expectedOffset: Offset = 0;
  /** 已解析（已交给 xterm 且回调已触发）的偏移。 */
  #parsedOffset: Offset = 0;
  /** 上次 ack 出去的偏移，用来判断是否值得再发一次。 */
  #ackedOffset: Offset = 0;
  /** 上一次发出 ack 的时刻，用于时间阈值节流。 */
  #lastAckIssuedAt = 0;
  /**
   * 本端是否已经有本地终端状态。
   *
   * 必须与「offset 恰好是 0」区分开：全新页面应该上报 `resume: null`（服务端记为
   * fresh_truncated），而「续传但断点落在 0」是另一回事（resume_trimmed）。两者行为一致，
   * 但可观测性完全不同——合成一个值会让「刷新到底丢没丢」这件事查不出来。
   */
  #hasLocalState = false;
  /**
   * 是否在等 `attached`。
   *
   * 切换会话时会置位：在 `attached` 到达之前收到的 OUTPUT 属于**上一个订阅**（当时已经
   * 在路上）。它们绝不能应用——否则会落到新会话的屏幕上，或者因为偏移不连续而被误判成
   * 协议错误。服务端保证 `attached` 先于字节入队，所以「等 attached」是一个确定的边界。
   */
  #awaitingAttach = false;
  /**
   * 服务端是否正要求本端暂缓发送输入。
   *
   * 与 `#heldInput` 分开：前者是「服务端说过停」，后者是「本端实际排了多少」——
   * 排到上限需要报错，而“还没排任何东西”是正常状态。
   */
  #inputHeld = false;
  /** 暂缓期间在本端排队的输入，**按到达顺序**，放行时原序补发。 */
  #heldInput: Uint8Array[] = [];
  #heldInputBytes = 0;
  /** 正在推进补发批次时，新输入入队后靠它继续往前送。 */
  #flushHandle: unknown = null;

  constructor(handlers: ClientHandlers, options: ClientOptions) {
    this.#handlers = handlers;
    this.#url = options.url;
    this.#label = options.label ?? '';
    this.#createSocket = options.createSocket ?? defaultCreateSocket;
    this.#now = options.now ?? (() => Date.now());
    this.#schedule =
      options.schedule ?? ((fn, ms) => setTimeout(fn, ms) as unknown);
    this.#cancel = options.cancel ?? ((handle) => clearTimeout(handle as number));
    this.#ackBytes = options.ackBytes ?? DEFAULTS.ackBytes;
    this.#ackIntervalMs = options.ackIntervalMs ?? DEFAULTS.ackIntervalMs;
    this.#backoffInitialMs = options.backoffInitialMs ?? DEFAULTS.backoffInitialMs;
    this.#backoffMaxMs = options.backoffMaxMs ?? DEFAULTS.backoffMaxMs;
    this.#heldInputMaxBytes = options.heldInputMaxBytes ?? DEFAULTS.heldInputMaxBytes;
    // 下界 1：0 会让补发循环永远推不动（"送 0 字节"仍然非空），表现为一个 50ms 的空转定时器
    this.#heldFlushBytes = Math.max(1, options.heldFlushBytes ?? DEFAULTS.heldFlushBytes);
    this.#heldFlushIntervalMs = options.heldFlushIntervalMs ?? DEFAULTS.heldFlushIntervalMs;
  }

  // ------------------------------------------------------------ 只读状态

  get state(): ConnectionState {
    return this.#state;
  }

  get session(): string | null {
    return this.#session;
  }

  /** 下一个期望收到的偏移；重连时上报的就是它。 */
  get expectedOffset(): Offset {
    return this.#expectedOffset;
  }

  /** 服务端是否正要求本端暂缓发送输入（UI 据此提示“输入排队中”）。 */
  get inputHeld(): boolean {
    return this.#inputHeld;
  }

  /** 本端正在排队的输入字节数。 */
  get heldInputBytes(): number {
    return this.#heldInputBytes;
  }

  // ------------------------------------------------------------ 生命周期

  /** 建立连接（自动重连由内部负责，失败不会抛）。 */
  connect(): void {
    if (this.#disposed || this.#state === 'connecting' || this.#state === 'ready') return;
    this.#openSocket();
  }

  /** 断开且不再重连。 */
  close(): void {
    this.#disposed = true;
    this.#clearRetry();
    this.#clearAckTimer();
    // 浏览器里 `close()` 会异步触发 onclose，但假 socket 与“主动关闭”路径不该依赖它
    this.#dropHeldInput();
    const socket = this.#socket;
    this.#socket = null;
    this.#setState('closed');
    socket?.close(1000, '客户端主动关闭');
  }

  // ------------------------------------------------------------ 会话

  /**
   * 订阅会话。
   *
   * 切换到**另一个**会话时必须重置本地偏移：每个会话有自己的 offset 空间，拿上一个会话的
   * 偏移去续传会得到一个荒谬的断点。
   */
  attach(session: string, resume?: Offset | null): void {
    if (session !== this.#session) this.#resetLocalState();
    this.#session = session;
    this.#awaitingAttach = true;
    if (resume !== undefined) {
      this.#hasLocalState = resume !== null;
      if (resume !== null) {
        this.#expectedOffset = resume;
        this.#parsedOffset = resume;
        this.#ackedOffset = resume;
      }
    }
    const value = this.#hasLocalState ? this.#expectedOffset : null;
    this.#send(encodeAttach(session, value));
  }

  detach(): void {
    this.#session = null;
    this.#awaitingAttach = false;
    this.#resetLocalState();
    this.#send(JSON.stringify({ t: 'detach' }));
  }

  #resetLocalState(): void {
    this.#clearAckTimer();
    // 排队中的输入属于**上一个订阅**：它还没送达服务端，也无法在切换会话后补发
    this.#dropHeldInput();
    this.#hasLocalState = false;
    this.#expectedOffset = 0;
    this.#parsedOffset = 0;
    this.#ackedOffset = 0;
  }

  /** 上报窗口是否聚焦（服务端会跨客户端聚合后再决定要不要告诉应用）。 */
  reportFocus(focused: boolean): void {
    this.#send(encodeFocus(focused));
  }

  /**
   * 发送一条控制消息（文本帧）。
   *
   * 用于本类没有专门封装的动作（建会话 / 关会话 / 改会话名）。消息本身一律由
   * `protocol/messages.ts` 的构造器生成，别处不要手拼 JSON。
   */
  sendControl(text: string): void {
    this.#send(text);
  }

  /**
   * 把输入字节（xterm 已按当前模式编码好）发给服务端。
   *
   * 服务端暂缓期间不发出，而是排进本端队列（见类注释）。**积压还没送完时也一样入队**：
   * 直接发出会让新按键插到积压前面，破坏字节序。
   * **控制消息不走这里**：暂缓只针对输入洪流，关会话 / detach 之类的操作必须随时能发出去。
   */
  sendInput(data: Uint8Array): void {
    if (data.byteLength === 0) return;
    if (this.#inputHeld || this.#heldInput.length > 0) {
      this.#holdInput(data);
      return;
    }
    this.#send(encodeInput(data));
  }

  #holdInput(data: Uint8Array): void {
    if (this.#heldInputBytes + data.byteLength > this.#heldInputMaxBytes) {
      // 不静默丢：把“丢了、丢了多少、为什么丢”交给上层。
      // 丢弃的是**最新**的字节：先到的部分保持完整，放行后就一定能按序送达。
      this.#handlers.onError(
        new Error(
          `输入排队超过上限 ${formatBytes(this.#heldInputMaxBytes)}，已丢弃最新 ${formatBytes(
            data.byteLength,
          )}（对端未读取 stdin？）`,
        ),
      );
      return;
    }
    this.#heldInput.push(data);
    this.#heldInputBytes += data.byteLength;
  }

  /**
   * 补发一批积压的输入（最多 `heldFlushBytes`，过大的段会被切开）。
   *
   * 先出队再发送：发送过程中若连接断开，`#send` 会丢弃，队列必须已经出队，否则
   * 同一批字节下一次放行会被再发一遍（重复输入比少输入更难排查）。
   */
  #flushHeldInput(): void {
    this.#clearFlushTimer();
    let budget = this.#heldFlushBytes;
    while (budget > 0) {
      const head = this.#heldInput[0];
      if (head === undefined) break;
      const take = Math.min(head.byteLength, budget);
      // 只取走真正要发的那一段，剩下的留在队头继续等（粘贴进来的是一整块大字节，
      // 不切开的话“分批”就只是个说法）
      if (take === head.byteLength) this.#heldInput.shift();
      else this.#heldInput[0] = head.subarray(take);
      this.#heldInputBytes -= take;
      budget -= take;
      this.#send(encodeInput(head.subarray(0, take)));
    }
    if (this.#heldInput.length === 0) return;
    // 还没送完：靠进度定时器往前推。服务端若再次下发暂缓，这里会停手并等下一次放行。
    this.#flushHandle = this.#schedule(() => {
      this.#flushHandle = null;
      if (this.#inputHeld) return;
      this.#flushHeldInput();
    }, this.#heldFlushIntervalMs);
  }

  #clearFlushTimer(): void {
    if (this.#flushHandle !== null) {
      this.#cancel(this.#flushHandle);
      this.#flushHandle = null;
    }
  }

  #dropHeldInput(): void {
    this.#inputHeld = false;
    this.#heldInput = [];
    this.#heldInputBytes = 0;
    this.#clearFlushTimer();
  }

  // ------------------------------------------------------------ 流控

  /**
   * 标记「到 `offset` 为止的字节已解析完成」。只有 xterm 的 write 回调里调用它才是真的，
   * 这也是 `ack` 值得信的原因。
   */
  markParsed(offset: Offset): void {
    if (offset <= this.#parsedOffset) return;
    this.#parsedOffset = offset;
    if (this.#parsedOffset - this.#ackedOffset >= this.#ackBytes) {
      this.#flushAck();
      return;
    }
    if (this.#ackHandle !== null) return;
    const elapsed = this.#now() - this.#lastAckIssuedAt;
    const wait = Math.max(0, this.#ackIntervalMs - elapsed);
    this.#ackHandle = this.#schedule(() => {
      this.#ackHandle = null;
      this.#flushAck();
    }, wait);
  }

  #flushAck(): void {
    this.#clearAckTimer();
    if (this.#parsedOffset <= this.#ackedOffset) return;
    this.#ackedOffset = this.#parsedOffset;
    this.#lastAckIssuedAt = this.#now();
    this.#send(encodeAck(this.#ackedOffset));
  }

  #clearAckTimer(): void {
    if (this.#ackHandle !== null) {
      this.#cancel(this.#ackHandle);
      this.#ackHandle = null;
    }
  }

  // ------------------------------------------------------------ socket

  #openSocket(): void {
    this.#setState(this.#attempt === 0 ? 'connecting' : 'reconnecting', this.#retryDetail());
    let socket: SocketLike;
    try {
      socket = this.#createSocket(this.#url);
    } catch (error) {
      this.#handlers.onError(toError(error));
      this.#scheduleRetry();
      return;
    }
    this.#socket = socket;
    socket.onopen = () => {
      this.#attempt = 0;
      this.#send(encodeHello(this.#label));
    };
    socket.onmessage = (data) => this.#onMessage(data);
    socket.onerror = () => {
      // onerror 之后浏览器一定会给 onclose，重连逻辑统一放在 onclose
    };
    socket.onclose = () => {
      this.#socket = null;
      // 连接没了，排队中的输入就必须丢掉：WebSocket 的 send 没有送达回执，无法区分
      // “发出去了但没到”与“根本没发出”，重发可能造成重复输入。与未连接时丢弃输入
      // 是同一条策略（输入本身不可补发）。
      this.#dropHeldInput();
      if (this.#disposed) return;
      this.#scheduleRetry();
    };
  }

  #onMessage(data: unknown): void {
    if (typeof data === 'string') {
      this.#onControl(data);
      return;
    }
    if (data instanceof ArrayBuffer) {
      this.#onBinary(new Uint8Array(data));
      return;
    }
    if (ArrayBuffer.isView(data)) {
      this.#onBinary(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      return;
    }
    this.#handlers.onError(new Error(`不认识的 WS 负载类型: ${Object.prototype.toString.call(data)}`));
  }

  #onControl(raw: string): void {
    let message: ServerMessage;
    try {
      message = parseServerMessage(raw);
    } catch (error) {
      // 控制消息非法说明两端对协议的理解已经不一致，继续跑只会把状态带偏
      this.#handlers.onError(error instanceof MessageError ? error : new MessageError(String(error)));
      return;
    }

    switch (message.t) {
      case 'hello_ok':
        this.#setState('ready');
        // 服务端只在会话增删改时广播列表，不推初始快照，所以这里主动要一次：
        // 少了它，刷新页面后侧栏永远是空的。
        this.#send(encodeSessionList());
        // 重连时按需自动续传（首次连接由调用方 attach）
        if (this.#session !== null) {
          this.#send(encodeAttach(this.#session, this.#hasLocalState ? this.#expectedOffset : null));
        }
        break;

      case 'attached':
        this.#onAttached(message);
        break;

      case 'behind':
        this.#onBehind(message);
        break;

      case 'input_hold':
        this.#onInputHold(message);
        break;

      default:
        break;
    }
    this.#handlers.onMessage(message);
  }

  #onAttached(message: Attached): void {
    this.#awaitingAttach = false;
    if (message.session !== this.#session) {
      // 服务端**主动**换订阅：新建会话时它把创建者直接 attach 上去，本端并没有发过 attach。
      // 此时本地的 offset 属于上一个会话，而两个会话的 offset 空间不相干——不重建基线的话，
      // 新会话的第一帧（从 0 起）会被当成「OUTPUT 帧不连续」丢掉，终端的表现是**永远刷不出来**
      // （真实浏览器探针里就是这样：新建会话后屏幕还停在旧内容上）。
      // 基线归零也正好对应服务端在这个分支上会从 0 补字节（它按 `resume=null` 的客户端对待我们）。
      this.#session = message.session;
      this.#resetLocalState();
    }
    if (message.resumed) {
      // 无损对齐：服务端会从我们上报的断点开始补，本地偏移**不动**
      return;
    }
    // 有损重建：随后会来一条 SNAPSHOT，应用它之后本端即对齐到 attached.offset。
    // 快照自带 RIS，会重置终端，所以这里不需要手动清屏。
    this.#expectedOffset = message.offset;
    this.#parsedOffset = message.offset;
    this.#handlers.onState('ready', '已重建（断点前内容不可恢复）');
  }

  #onBehind(message: Behind): void {
    // 落后是显式状态：服务端已停止推送，本端整段重建。
    // 上报本地已知偏移，服务端会回 attached(resumed=false) + SNAPSHOT。
    this.#send(encodeResync(message.session, this.#expectedOffset));
    this.#handlers.onState('ready', '内容已过期，正在重建');
  }

  #onInputHold(message: InputHold): void {
    if (message.session !== this.#session) {
      // 过期订阅的暂缓/放行：既不能让它把新会话的输入冻住，也不能让它把新会话
      // 排队中的输入提前倒出去。
      return;
    }
    if (message.paused) {
      this.#inputHeld = true;
      // 停手：进度定时器也不许再往前送
      this.#clearFlushTimer();
      return;
    }
    this.#inputHeld = false;
    this.#flushHeldInput();
  }

  #onBinary(message: Uint8Array): void {
    let frames;
    try {
      frames = [...iterFrames(message)];
    } catch (error) {
      this.#handlers.onError(error instanceof FrameError ? error : new Error(String(error)));
      return;
    }

    if (this.#awaitingAttach) {
      // 上个订阅的残留字节：丢掉，不应用也不报错（见 #awaitingAttach 的说明）
      return;
    }

    for (const frame of frames) {
      if (frame.tag === FrameTag.INPUT) {
        // 服务端不该给客户端发 INPUT
        this.#handlers.onError(new FrameError('服务端发出了 INPUT 帧'));
        return;
      }
      const offset = offsetToNumber(frame.offset ?? 0n);
      if (frame.tag === FrameTag.SNAPSHOT) {
        // 快照取代本地画面：之后本端就是「从 offset 开始」的新生客户端
        this.#expectedOffset = offset;
        this.#parsedOffset = offset;
        this.#ackedOffset = offset;
        this.#lastAckIssuedAt = this.#now();
        this.#hasLocalState = true;
        this.#handlers.onOutput(frame.payload, offset);
        continue;
      }

      // OUTPUT：必须与本地游标首尾相接，否则两端状态已经分叉
      if (offset !== this.#expectedOffset) {
        this.#handlers.onError(
          new FrameError(`OUTPUT 帧不连续: 期望 ${this.#expectedOffset}，收到 ${offset}`),
        );
        this.#send(encodeResync(this.#session ?? '', this.#expectedOffset));
        return;
      }
      const end = offset + frame.payload.byteLength;
      this.#expectedOffset = end;
      this.#hasLocalState = true;
      this.#handlers.onOutput(frame.payload, end);
    }
  }

  #send(payload: string | ArrayBufferView): void {
    const socket = this.#socket;
    if (socket === null || socket.readyState !== SOCKET_OPEN) {
      // 未连接时丢弃：输入本身无法补发（服务端没收到就是没收到），
      // 而 ack / resume 在重连后会用最新值重发，丢掉不损失正确性。
      return;
    }
    socket.send(payload);
  }

  // ------------------------------------------------------------ 重连

  #retryDetail(): string {
    return this.#attempt === 0 ? '' : `第 ${this.#attempt} 次重连`;
  }

  #scheduleRetry(): void {
    if (this.#disposed) return;
    this.#attempt += 1;
    const ceiling = Math.min(this.#backoffMaxMs, this.#backoffInitialMs * 2 ** (this.#attempt - 1));
    // 加抖动：多个页面同时断线时避免一起重连
    const delay = Math.round(ceiling * (0.5 + Math.random() * 0.5));
    this.#setState('reconnecting', `第 ${this.#attempt} 次重连 · ${delay}ms`);
    this.#clearRetry();
    this.#retryHandle = this.#schedule(() => {
      this.#retryHandle = null;
      if (!this.#disposed) this.#openSocket();
    }, delay);
  }

  #clearRetry(): void {
    if (this.#retryHandle !== null) {
      this.#cancel(this.#retryHandle);
      this.#retryHandle = null;
    }
  }

  #setState(state: ConnectionState, detail?: string): void {
    if (this.#state === state && detail === undefined) return;
    this.#state = state;
    this.#handlers.onState(state, detail);
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** 人类可读的字节数（只用于提示文案）。UI 与本模块共用同一份，避免两处各写一遍。 */
export function formatBytes(count: number): string {
  if (count < 1024) return `${count} B`;
  if (count < 1024 * 1024) return `${(count / 1024).toFixed(1)} KB`;
  return `${(count / (1024 * 1024)).toFixed(1)} MB`;
}
