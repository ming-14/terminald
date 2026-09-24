/**
 * Tab 级记忆：刷新后回到**你刚才那个会话、那一屏**。
 *
 * 「刷新不丢」在这个项目里有两层含义，这里只管第二层：
 *
 * 1. **内容不丢**——服务端的字节日志负责（新客户端整段重放，见 `docs/architecture.md`）；
 * 2. **位置不丢**——刷新后落在哪个会话、视口停在哪一行。没有第 2 层，F5 之后内容确实都在，
 *    但你被扔回列表第一个会话的底部。这层状态天然属于**这一端**：服务端不知道也无需知道。
 *
 * ## 为什么是 sessionStorage，不是 localStorage
 *
 * 它是 **Tab 级**的。多客户端是这个项目的核心场景：同一个终端会被好几个标签页同时控制。
 * 换成 localStorage 的话，「在 A 标签页切到会话 3」会把 B 标签页记着的会话一起改掉——
 * 于是 B 刷新后被带到一个它从没订阅过的会话上。sessionStorage 的语义正好是
 * 「这个标签页上次在看什么」。
 *
 * ## 只记 id，绝不记 offset
 *
 * 会话 id 可以带上，**偏移量不行**：刷新后的 xterm 是空的，按刷新前的 offset 续传只会得到
 * 一屏空白——那正是 `attach.resume = null`（整段重放）的含义。这里刻意不提供任何
 * 「记住 offset」的入口，让那个错误写法没有落点。
 *
 * ## 记忆不可用时必须**照常工作**
 *
 * 隐私模式、沙箱 iframe、被策略禁用的存储都会让 `sessionStorage` 直接抛错。记忆是增强而不是
 * 功能，所以这里一律降级成「没有记忆」并保持可读写不抛异常；刻意**不**退化成内存实现——
 * 那会让它看起来在工作、刷新后却静默失效，反而更难查。
 */

/** 只需要这三个方法；因此测试可以注入一个假实现，而浏览器里直接给 `sessionStorage`。 */
export interface MemoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 当前标签页在看的会话。 */
export const ACTIVE_SESSION_KEY = 'terminald.active-session';
/** 单个会话的滚动位置前缀（键是 `前缀 + 会话 id`）。 */
export const SCROLL_KEY_PREFIX = 'terminald.scroll.';

/** 取浏览器的 `sessionStorage`；取不到（或访问就抛）返回 null。 */
export function browserStorage(): MemoryStorage | null {
  try {
    // 取属性本身就可能抛 SecurityError（沙箱 iframe），所以判断放在 try 里面
    const storage = globalThis.sessionStorage;
    return storage === undefined || storage === null ? null : storage;
  } catch {
    return null;
  }
}

export class SessionMemory {
  readonly #storage: MemoryStorage | null;

  constructor(storage: MemoryStorage | null = browserStorage()) {
    this.#storage = storage;
  }

  /** 记忆是否真的落到了存储上（诊断用：不可用时 UI 不该假装记得住）。 */
  get available(): boolean {
    return this.#storage !== null;
  }

  /** 上次在这个标签页里订阅的会话；没有则 null。 */
  activeSession(): string | null {
    const raw = this.#read(ACTIVE_SESSION_KEY);
    return raw === null || raw === '' ? null : raw;
  }

  setActiveSession(session: string): void {
    if (session === '') return;
    this.#write(ACTIVE_SESSION_KEY, session);
  }

  forgetActiveSession(): void {
    this.#remove(ACTIVE_SESSION_KEY);
  }

  /**
   * 该会话上次停留的滚动行（缓冲区内的绝对行号）；没有记忆则为 null。
   *
   * 脏数据一律当成「没有记忆」而不是报错：这个键可能来自旧版本、被别的东西写过、或者
   * 读到一半被截断。滚动位置恢复得对不对最多影响观感，为此炸掉整个终端是荒唐的。
   */
  scroll(session: string): number | null {
    const raw = this.#read(SCROLL_KEY_PREFIX + session);
    if (raw === null) return null;
    const line = Number(raw);
    if (!Number.isSafeInteger(line) || line < 0) return null;
    return line;
  }

  setScroll(session: string, line: number): void {
    if (!Number.isSafeInteger(line) || line < 0) return;
    this.#write(SCROLL_KEY_PREFIX + session, String(line));
  }

  forgetScroll(session: string): void {
    this.#remove(SCROLL_KEY_PREFIX + session);
  }

  /** 会话被关掉：两个键都该清掉（否则同一个会话 id 再出现时会“继承”上一条命的位置）。 */
  clearSession(session: string): void {
    this.forgetScroll(session);
    if (this.activeSession() === session) this.forgetActiveSession();
  }

  #read(key: string): string | null {
    if (this.#storage === null) return null;
    try {
      return this.#storage.getItem(key);
    } catch {
      // 读也可能抛（配额/安全策略）；读不到就是没有记忆
      return null;
    }
  }

  #write(key: string, value: string): void {
    if (this.#storage === null) return;
    try {
      this.#storage.setItem(key, value);
    } catch {
      // 配额满 / 存储被禁用：记不住就算了，绝不能让「记位置」这种次要功能影响开终端
    }
  }

  #remove(key: string): void {
    if (this.#storage === null) return;
    try {
      this.#storage.removeItem(key);
    } catch {
      // 同上
    }
  }
}

/**
 * 首屏该订阅哪个会话：优先**这个标签页上次那个**，否则列表第一个。
 *
 * 记忆里的会话可能已经不存在了（被关掉、服务端重启过），所以必须拿列表校验一遍——
 * 不回退的话，刷新后会订阅一个不存在的会话并收到 `session_not_found`。
 */
export function pickInitialSession(
  items: readonly { readonly id: string }[],
  remembered: string | null,
): string | null {
  if (remembered !== null) {
    const hit = items.find((item) => item.id === remembered);
    if (hit !== undefined) return hit.id;
  }
  return items[0]?.id ?? null;
}
