/**
 * 应用装配：侧栏（会话列表）+ 顶栏（会话状态）+ 终端区。
 *
 * 布局与状态表现见 `docs/design/frontend-draft.html`。四条设计约束在这里落地：
 *
 * 1. `cols`/`rows` 由终端侧给出（`attached` 消息），前端只负责求解字号把它铺进容器
 * 2. 终端数据一律不可信：所有文本走 `textContent`，从不拼 HTML
 * 3. 连接与同步状态是**可见**的：无损续传 / 重连中 / 待重同步 / 已重建（有损）分开呈现
 * 4. 「刷新不丢」除了内容（服务端日志）还包括**位置**：这个标签页上次看的会话与视口
 *    行号记在 `sessionStorage` 里（见 `remember.ts`），不在服务端
 */

import { Terminal } from '@xterm/xterm';

import {
  TerminalClient,
  formatBytes,
  type ClientHandlers,
  type ConnectionState,
} from '../net/client.js';
import {
  sessionClose,
  sessionCreate,
  sessionRename,
  type ServerMessage,
  type SessionInfo,
} from '../protocol/messages.js';
import { measureRenderedScreen, fitTerminal } from '../render/fit.js';
import { isPlausibleCellAspect, measureCellAspect } from '../render/size.js';
import { el, replace, setText } from './dom.js';
import { SessionMemory, pickInitialSession } from './remember.js';
import { Shortcuts } from './shortcuts.js';

/**
 * xterm.js 在焦点上报模式（DECSET 1004）下自己生成的两个序列；服务端也会写一份，故滤掉。
 *
 * 写成 `\u001b` 转义而不是把 ESC 字节直接嵌进源码：后者在编辑器里是**看不见的**，
 * 任何做文本处理的工具（grep、格式化、行尾规约）都可能把它弄丢或改成别的字节，
 * 而代价是这条「滤掉焦点序列」的规则静默失效。
 */
const FOCUS_IN = '\u001b[I';
const FOCUS_OUT = '\u001b[O';

/**
 * 字体栈只用系统字体（项目禁 CDN）。等宽 CJK 字体排在前面：CJK 宽度算错会直接把整屏
 * 布局带偏，所以优先选确定等宽的（Cascadia Mono 属于 Windows Terminal 自带）。
 *
 * 这个栈同时用于「渲染」和「度量」两处（`Terminal` 选项与 `measureCellAspect`），
 * 必须是同一个常量——两处不一致的话，量出来的单格宽就不是实际渲染的单格宽，
 * 字号求解会整体偏掉。
 */
const MONO_STACK =
  '"Cascadia Mono", "Cascadia Code", Consolas, "Sarasa Mono SC", "Noto Sans Mono CJK SC", "Microsoft YaHei Mono", monospace';

/** 深色单主题。ANSI 16 色按 GitHub Dark 系调过，保证亮色在深底上可辨。 */
const THEME = {
  background: '#0a0d12',
  foreground: '#ccd3dc',
  cursor: '#e6edf3',
  cursorAccent: '#0a0d12',
  selectionBackground: '#2b3a4d',
  black: '#484f58',
  red: '#ff7b72',
  green: '#3fb950',
  yellow: '#d29922',
  blue: '#58a6ff',
  magenta: '#bc8cff',
  cyan: '#39c5cf',
  white: '#b1bac4',
  brightBlack: '#6e7681',
  brightRed: '#ffa198',
  brightGreen: '#56d364',
  brightYellow: '#e3b341',
  brightBlue: '#79c0ff',
  brightMagenta: '#d2a8ff',
  brightCyan: '#56d4dd',
  brightWhite: '#f0f6fc',
} as const;

interface SessionCard {
  readonly node: HTMLDivElement;
  readonly name: HTMLDivElement;
  readonly sub: HTMLDivElement;
}

export class App {
  readonly #root: HTMLElement;
  readonly #host: HTMLDivElement;
  readonly #notice: HTMLDivElement;
  readonly #list: HTMLDivElement;
  readonly #footCount: HTMLSpanElement;
  readonly #titleNode: HTMLSpanElement;
  readonly #cwdNode: HTMLSpanElement;
  readonly #chipSize: HTMLSpanElement;
  readonly #chipFont: HTMLSpanElement;
  readonly #chipConn: HTMLSpanElement;
  readonly #chipClients: HTMLSpanElement;
  readonly #chipInput: HTMLSpanElement;
  /** 一次性操作的结果（复制/全屏失败）。与 `#notice` 的分工见 `#notify`。 */
  readonly #chipStatus: HTMLSpanElement;

  readonly #term: Terminal;
  readonly #client: TerminalClient;

  #sessions: SessionInfo[] = [];
  #cards = new Map<string, SessionCard>();
  #inputHoldText = '';
  #notifyHandle: number | null = null;
  #emptyHint: HTMLDivElement | null = null;
  #activeSession: string | null = null;
  #canonicalSize: { cols: number; rows: number } | null = null;
  #cellAspect: number | null = null;
  #connection: ConnectionState = 'idle';
  #resizeObserver: ResizeObserver | null = null;
  #fitHandle: number | null = null;

  /** 本标签页的位置记忆：当前会话 + 各会话的滚动行。 */
  readonly #memory: SessionMemory;
  /**
   * 待恢复的视口行。非 null 期间**不记录**滚动位置：重放过程中的滚动是副作用，
   * 不是用户的选择。
   */
  #pendingScroll: number | null = null;
  /** 本次订阅的重放终点（`attached.offset`）：已解析偏移越过它 = 重放字节已全部进 xterm。 */
  #attachTarget: number | null = null;

  constructor(root: HTMLElement) {
    this.#root = root;
    this.#memory = new SessionMemory();

    // ---- DOM ----
    const sidebar = el('div', { class: 'sidebar' });
    const sideHead = el('div', { class: 'side-head' });
    const brand = el('div', { class: 'brand', text: 'terminald' });
    brand.appendChild(el('span', { text: ' · 本机' }));
    const btnNew = el('button', { class: 'btn-new', text: '+', title: '新建会话' });
    btnNew.addEventListener('click', () => this.#newSession());
    sideHead.append(brand, btnNew);

    this.#list = el('div', { class: 'session-list' });
    const sideFoot = el('div', { class: 'side-foot' });
    this.#footCount = el('span', { text: '0 个会话' });
    const footClients = el('span', { text: '' });
    sideFoot.append(this.#footCount, footClients);
    sidebar.append(sideHead, this.#list, sideFoot);

    const topbar = el('div', { class: 'topbar' });
    const btnToggle = el('button', { class: 'toggle-sidebar', text: '☰', title: '折叠侧栏' });
    btnToggle.addEventListener('click', () => {
      this.#root.classList.toggle('sidebar-collapsed');
      this.#scheduleFit();
    });
    this.#titleNode = el('span', { class: 'title', text: '未选择会话' });
    this.#cwdNode = el('span', { class: 'cwd', text: '' });
    const chips = el('div', { class: 'chips' });
    this.#chipSize = el('span', { class: 'chip mono', text: '—' });
    this.#chipFont = el('span', { class: 'chip mono', text: '—' });
    this.#chipConn = el('span', { class: 'chip', text: '连接中' });
    this.#chipClients = el('span', { class: 'chip', text: '0 客户端' });
    // 输入方向的背压是**可见**状态：服务端暂缓时，用户的按键会先排在本端。
    // 不提示的话，终端看起来就像卡住了（而它其实一切正常）。
    this.#chipInput = el('span', {
      class: 'chip info hidden',
      title: '服务端暂缓接收输入：字节已在本端按序排队，放行后原序补发',
    });
    this.#chipStatus = el('span', { class: 'chip warn hidden' });
    chips.append(
      this.#chipSize,
      this.#chipFont,
      this.#chipInput,
      this.#chipStatus,
      this.#chipConn,
      this.#chipClients,
    );
    topbar.append(btnToggle, this.#titleNode, this.#cwdNode, chips);

    this.#host = el('div', { class: 'term-host' });
    this.#notice = el('div', { class: 'notice', text: '正在连接…' });
    this.#host.appendChild(this.#notice);

    replace(root, sidebar, topbar, this.#host);

    // ---- 终端 ----
    this.#term = new Terminal({
      // 起步值，随后由 fitTerminal 依据服务端给的真实尺寸改写
      cols: 120,
      rows: 30,
      // scrollback 不在这里定：它由服务端的 `attached` 交付（终端侧属性，客户端无权决定）。
      // 这里用 xterm 自己的默认值起步，`attached` 一到就被替换掉。
      fontFamily: MONO_STACK,
      fontSize: 14,
      lineHeight: 1.3,
      letterSpacing: 0,
      theme: THEME,
      cursorBlink: true,
      // 前后端同机（后端只监听回环），所以浏览器的 OS 就是服务端的 OS。
      // 不设它的话 ConPTY 下的滚动历史会被 xterm 的启发式规则算错。
      windowsPty: { backend: 'conpty' },
      linkHandler: {
        // 终端输出是不可信输入：只放行 http(s)，且必须按住修饰键才打开
        // `uri` 是 OSC 8 链接的目标（可能和显示文本不同），所以按不可信输入校验
        activate: (event, uri) => {
          if (!/^https?:\/\//i.test(uri)) {
            console.warn('拒绝打开非 http(s) 链接:', uri);
            return;
          }
          if (!(event.ctrlKey || event.metaKey)) return;
          window.open(uri, '_blank', 'noopener,noreferrer');
        },
        allowNonHttpProtocols: false,
      },
    });
    // ---- 快捷键扩展 ----
    // 这四个交互（F11 / Ctrl+C / Ctrl+V / 右键）都不是应用的逻辑，而是**浏览器与 xterm
    // 默认行为之间的冲突**：xterm 会边发控制字节边把浏览器自己的复制粘贴掐掉。
    // 接管点、为什么这么接、以及每条行为的现状，都在 `shortcuts.ts` 里。
    const shortcuts = new Shortcuts({
      terminal: {
        hasSelection: () => this.#term.hasSelection(),
        clearSelection: () => this.#term.clearSelection(),
      },
      // 全屏用 API 而不是依赖浏览器的 F11：浏览器自己的全屏在 iframe/PWA 里不一定存在，
      // 而且它不提供任何「成功了没有」的信号。
      fullscreen: {
        isActive: () => document.fullscreenElement !== null,
        enter: () => document.documentElement.requestFullscreen(),
        exit: () => document.exitFullscreen(),
      },
      // 复制**不**用 `navigator.clipboard.writeText`：那条路要权限（没有授权时会被拒），
      // 而 `execCommand('copy')` 只是请求浏览器执行它自己的复制命令，免权限、同步，
      // 真正的写入由 xterm 挂在 `.xterm` 上的 `copy` 监听器完成（见 `shortcuts.ts` 顶部说明）。
      clipboard: { requestCopy: () => document.execCommand('copy') },
      onFailure: (message) => this.#notify(message),
    });
    this.#term.attachCustomKeyEventHandler((event) => shortcuts.handleKeyDown(event));
    this.#host.addEventListener('contextmenu', (event) => shortcuts.handleContextMenu(event));
    // 挂在容器上（而不是 `.xterm`）：冒泡顺序让它晚于 xterm 自己的 copy 监听器，
    // 也就是「剪贴板已经写好」之后才清选区。
    this.#host.addEventListener('copy', (event) => shortcuts.handleCopy(event));

    this.#term.open(this.#host);
    // 让 .xterm 自己铺满容器：xterm 会按网格把 .xterm 设成「网格那么大」，于是一旦容器比
    // 网格宽，滚动条（.xterm-viewport 自带 overflow-y: scroll）就会悬在离右边缘 90 多像素的
    // 位置。铺满之后滚动条贴右边缘，网格则单独居中（见 #placeGrid）。
    this.#placeTerminalBox();

    // ---- 网络 ----
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    this.#client = new TerminalClient(this.#handlers(), {
      url,
      label: `web/${navigator.platform}`,
    });
    // 窗口聚焦变化上报：服务端会跨客户端聚合成一个布尔量再告诉应用
    window.addEventListener('focus', () => this.#client.reportFocus(true));
    window.addEventListener('blur', () => this.#client.reportFocus(false));

    // 输入：xterm 已按应用下发的模式编码好，服务端只转发
    this.#term.onData((data) => {
      // **焦点序列由服务端独占**：应用打开 `?1004` 后，xterm.js 会自己生成
      // `\u001b[I` / `\u001b[O` 经 onData 送出来，而服务端已经跨客户端聚合过一份并写入 PTY
      // （Hub._apply_focus → host.set_focus）。两边都发 → 应用收到两份互相矛盾的焦点事件，
      // 正好是当初设计服务端聚合要避免的（真实浏览器探针实测确认过这一点）。
      // 所以这里必须滤掉，而不是让两路并存。
      //
      // 取舍：粘贴一段恰好是这两个字节序列的文本会被丢掉。这是刻意的——
      // 「粘贴原始焦点序列」远不如「焦点状态正确」重要。
      if (data === FOCUS_IN || data === FOCUS_OUT) return;
      this.#cancelScrollRestore();
      this.#client.sendInput(new TextEncoder().encode(data));
      this.#renderInputHold();
    });
    // 二进制事件（少数鼠标上报）按文档要求原样透传
    this.#term.onBinary((data) => {
      const bytes = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i += 1) bytes[i] = data.charCodeAt(i) & 0xff;
      this.#cancelScrollRestore();
      this.#client.sendInput(bytes);
      this.#renderInputHold();
    });
    // 滚动位置：只记用户**停留**的地方（停在底部 = 跟随输出，无需记忆）
    this.#term.onScroll(() => this.#rememberScroll());
    // 自己动了手就放弃恢复：重放还没结束时把视口拽回刷新前的位置很唐突
    this.#host.addEventListener('wheel', () => this.#cancelScrollRestore(), { passive: true });
    this.#host.addEventListener('mousedown', () => this.#cancelScrollRestore());
    // 窗口尺寸变化 → 重新求解字号
    this.#resizeObserver = new ResizeObserver(() => this.#scheduleFit());
    this.#resizeObserver.observe(this.#host);

    this.#client.connect();
  }

  #handlers(): ClientHandlers {
    return {
      onState: (state, detail) => {
        this.#connection = state;
        // 断线/重连时放弃恢复：重放不再保证会发生，留着这个标志只会一直压住滚动记录
        if (state !== 'ready') this.#cancelScrollRestore();
        this.#renderConnection(state, detail);
        // 连接状态变化可能同时清掉了输入排队（断线时排队内容一律丢弃）
        this.#renderInputHold();
      },
      onOutput: (chunk, endOffset) => {
        // 只有 write 回调里才算「已解析」——ack 表达的就是这件事
        this.#term.write(chunk, () => {
          this.#client.markParsed(endOffset);
          this.#restoreScroll(endOffset);
        });
      },
      onMessage: (message) => this.#onMessage(message),
      onError: (error) => {
        console.error('终端客户端错误:', error);
        this.#showNotice(`协议错误：${error.message}`);
      },
    };
  }

  #onMessage(message: ServerMessage): void {
    switch (message.t) {
      case 'sessions':
        this.#sessions = [...message.items];
        this.#renderSessions();
        if (this.#activeSession === null) {
          // 刷新后回到这个标签页上次那个会话（可能已经不存在 → 回退到列表第一个）。
          // 只用 id：**不能**带上刷新前的 offset——新页面的 xterm 是空的，
          // 按旧 offset 续传只会得到一屏空白（见 remember.ts）。
          const target = pickInitialSession(this.#sessions, this.#memory.activeSession());
          if (target !== null) this.#select(target);
        }
        break;

      case 'attached': {
        // 这条路径**不经过** `#select`：新建会话时服务端直接把创建者 attach 上去。
        // 会话变了就先清屏，否则上一个会话的内容会和新会话的输出混在一屏
        // （`reset()` 连 scrollback 一起丢，切换会话因此不会留下上一个会话的历史）。
        // 重连续传时会话 id 不变，因此不会走到这里——那正是不能清屏的情况。
        const switching = this.#activeSession !== message.session;
        this.#activeSession = message.session;
        if (switching) {
          this.#pendingScroll = this.#memory.scroll(message.session);
          this.#term.reset();
        }
        this.#memory.setActiveSession(message.session);
        // 本次订阅的字节会一直推到重放终点；已解析偏移越过它就可以恢复视口了
        this.#attachTarget = message.offset;
        this.#canonicalSize = { cols: message.cols, rows: message.rows };
        // 必须在流字节之前落到终端上：`attached` 一定先于二进制帧到达（服务端保证顺序）
        this.#term.options.scrollback = message.scrollback;
        this.#notice.classList.add('hidden');
        // 订阅切换会重置本端状态（排队中的输入一并丢掉），提示条必须跟着归零，
        // 否则它会挂着上一个会话的“输入排队中 · 12 KB”留在屏幕上。
        this.#renderInputHold();
        this.#fit();
        this.#renderSessions();
        break;
      }

      case 'meta': {
        const session = this.#sessions.find((item) => item.id === message.session);
        if (session !== undefined) {
          const updated: SessionInfo = {
            ...session,
            title: message.title,
            cwd: message.cwd,
          };
          this.#sessions = this.#sessions.map((item) =>
            item.id === message.session ? updated : item,
          );
          this.#renderSessions();
        }
        if (message.session === this.#activeSession) {
          setText(this.#titleNode, message.title ?? this.#activeSession);
          setText(this.#cwdNode, message.cwd ?? '');
        }
        break;
      }

      case 'input_hold':
        this.#renderInputHold();
        break;

      case 'error':
        // 服务端错误不能只落在控制台里：它往往解释了“刚才那一下为什么没反应”
        // （例如输入越限，服务端随即断开）。提示会在下一次成功订阅时清掉。
        console.error(`服务端错误 ${message.code}: ${message.message}`);
        this.#showNotice(`服务端错误：${message.message}（${message.code}）`);
        break;

      default:
        break;
    }
  }

  // ------------------------------------------------------------ 会话

  #newSession(): void {
    this.#sendControl(sessionCreate());
  }

  #select(session: string): void {
    if (session === this.#activeSession) return;
    this.#activeSession = session;
    this.#canonicalSize = null;
    this.#notice.textContent = '正在订阅会话…';
    this.#notice.classList.remove('hidden');
    // 先读记忆再清屏：`reset()` 会丢掉整个缓冲区（含 scrollback，见 BufferSet.reset），
    // 因此它也会触发一次滚动事件——顺序反了的话，「还没有历史可滚」会把刚要恢复的位置抹掉。
    this.#pendingScroll = this.#memory.scroll(session);
    // 清掉上一个会话的画面与历史：新会话会从 offset 0 重放，旧内容不清会混在一起。
    // 上个订阅在途的字节由客户端丢弃（见 TerminalClient#awaitingAttach）。
    this.#term.reset();
    // 这次订阅会整段重放（新订阅一律 resume=null）；重放终点由 `attached.offset` 给出，
    // 到了那一刻再把视口放回刷新前那一行
    this.#attachTarget = null;
    this.#memory.setActiveSession(session);
    const info = this.#sessions.find((item) => item.id === session);
    setText(this.#titleNode, info?.title ?? info?.name ?? session);
    setText(this.#cwdNode, info?.cwd ?? '');
    this.#client.attach(session);
    // 切会话会把排队中的输入清掉（它属于上一个会话），提示也要跟着消失
    this.#renderInputHold();
    this.#renderSessions();
  }

  #close(session: string): void {
    // 会话没了，它的位置记忆也就没用了（id 不会再出现，留着只是垃圾）
    this.#memory.clearSession(session);
    this.#sendControl(sessionClose(session));
  }

  /**
   * 重命名当前会话。
   *
   * 名字的边界（1..`SESSION_NAME_MAX`）**不在这里重复一遍**：那是协议侧的事实，
   * 前端抄一份只会多一个会漂移的常量。越界由服务端以 `error{bad_message}` 拒回，
   * 而那条消息本来就会显示成提示（见 `#onMessage` 的 `error` 分支）。
   */
  #rename(session: string): void {
    const current = this.#sessions.find((item) => item.id === session)?.name ?? '';
    const next = window.prompt('会话名称', current)?.trim() ?? '';
    if (next === '' || next === current) return;
    this.#sendControl(sessionRename(session, next));
  }

  #sendControl(text: string): void {
    this.#client.sendControl(text);
  }

  // ------------------------------------------------------------ 渲染

  /**
   * 渲染侧栏。
   *
   * **复用节点**而不是每次整段重建：`sessions` / `meta` 消息会频繁到达，整段重建会让
   * 正在进行的点击/hover 失效（真实浏览器探针里就是这么暴露出来的：点第二个会话时
   * 元素已经被换掉了）。所以这里只更新变化的部分，顺序用 appendChild 的重排语义来对齐。
   */
  #renderSessions(): void {
    const alive = new Set<string>();

    for (const info of this.#sessions) {
      alive.add(info.id);
      let card = this.#cards.get(info.id);
      if (card === undefined) {
        card = this.#createCard(info);
        this.#cards.set(info.id, card);
      }
      this.#updateCard(card, info);
      // appendChild 对已存在的子节点是「移动」，所以这一步同时完成排序
      this.#list.appendChild(card.node);
    }

    for (const [id, card] of [...this.#cards]) {
      if (!alive.has(id)) {
        card.node.remove();
        this.#cards.delete(id);
      }
    }

    if (this.#sessions.length === 0) {
      if (this.#emptyHint === null) {
        this.#emptyHint = el('div', { class: 'session', text: '还没有会话，点右上角 + 新建' });
        this.#list.appendChild(this.#emptyHint);
      }
    } else if (this.#emptyHint !== null) {
      this.#emptyHint.remove();
      this.#emptyHint = null;
    }

    setText(this.#footCount, `${this.#sessions.length} 个会话`);
  }

  #createCard(info: SessionInfo): SessionCard {
    const dot = el('span', { class: 'dot' });
    const name = el('div', { class: 'nm' });
    const sub = el('div', { class: 'sub' });
    const body = el('div', { class: 'body' });
    body.append(name, sub);

    const closeBtn = el('button', { class: 'close', text: '×', title: '关闭会话' });
    closeBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      this.#close(info.id);
    });

    const node = el('div', { class: 'session' });
    node.append(dot, body, closeBtn);
    node.addEventListener('click', () => this.#select(info.id));
    // 重命名：双击卡片就地改名。协议侧早就有了 `session.rename`（后端与 Hub 都有测试），
    // 缺的只是这个入口——没有它，那条消息在前端就是个没人能触发的死面。
    node.addEventListener('dblclick', () => this.#rename(info.id));

    return { node, name, sub };
  }

  #updateCard(card: SessionCard, info: SessionInfo): void {
    const title = info.title ?? info.name;
    if (card.name.textContent !== title) setText(card.name, title);
    const sub =
      info.status === 'exited'
        ? `已退出 · ${info.cwd ?? info.name}`
        : (info.cwd ?? `${info.cols}×${info.rows}`);
    if (card.sub.textContent !== sub) setText(card.sub, sub);
    card.node.classList.toggle('active', info.id === this.#activeSession);
    card.node.classList.toggle('exited', info.status === 'exited');
  }

  /**
   * 顶部提示浮层：断线、服务端错误、尺寸装不下这类“必须让人看见”的信息。
   *
   * 只负责显示。清掉它的是**重新订阅成功**那条路径（见 `#notice.classList.add('hidden')`
   * 的调用点）：提示在问题解决之前不该自己消失。
   */
  #showNotice(text: string): void {
    this.#notice.textContent = text;
    this.#notice.classList.remove('hidden');
  }

  /**
   * 一次性操作的结果提示（复制、全屏失败这类），几秒后自己消失。
   *
   * 与 `#notice` 分工：`#notice` 表达的是「问题解决之前不该消失的状态」（断线、尺寸装不下）；
   * 这里是一次动作的结果，看过就该走。**成功不提示**——选区消失本身就是反馈，
   * 而失败必须说出来（`navigator.clipboard.writeText` 会在文档失焦时被拒）。
   */
  #notify(text: string): void {
    setText(this.#chipStatus, text);
    this.#chipStatus.classList.remove('hidden');
    if (this.#notifyHandle !== null) window.clearTimeout(this.#notifyHandle);
    this.#notifyHandle = window.setTimeout(() => {
      this.#notifyHandle = null;
      this.#chipStatus.classList.add('hidden');
      setText(this.#chipStatus, '');
    }, 4000);
  }

  /**
   * 渲染输入暂缓提示。
   *
   * 只在**文案变化**时动 DOM：暂缓状态变化时它会被调用，而它要写的那个节点在每次
   * 尺寸重算时都会被重排——让无变化的写入穿透进去是没有意义的开销。
   */
  #renderInputHold(): void {
    const text = this.#client.inputHeld
      ? `输入排队中 · ${formatBytes(this.#client.heldInputBytes)}`
      : '';
    if (text === this.#inputHoldText) return;
    this.#inputHoldText = text;
    this.#chipInput.classList.toggle('hidden', text === '');
    setText(this.#chipInput, text);
  }

  // ------------------------------------------------------------ 位置记忆

  /**
   * 记录视口停留的行。
   *
   * **停在底部不记**：「跟随输出」是默认行为，刷新后自然还在底部；把它记下来只会让恢复
   * 逻辑多做一次无意义的滚动，并且把一个“没有信息”的状态写进存储。
   */
  #rememberScroll(): void {
    const session = this.#activeSession;
    if (session === null || this.#pendingScroll !== null) return;
    const buffer = this.#term.buffer.active;
    // 备用屏幕（vim / htop 这类全屏程序）没有 scrollback 可言，行号在退出时就整个失效了
    if (buffer.type !== 'normal') return;
    // 还没有可滚动的历史（刚 reset 过、或重放还没到）：这一刻的位置没有信息量，
    // 不能拿它去覆盖已有的记忆。
    if (buffer.baseY === 0) return;
    if (buffer.viewportY < buffer.baseY) this.#memory.setScroll(session, buffer.viewportY);
    else this.#memory.forgetScroll(session);
  }

  /** 放弃本次恢复（用户自己动了手，或连接状态不再是 ready）。 */
  #cancelScrollRestore(): void {
    this.#pendingScroll = null;
  }

  /**
   * 重放结束后把视口送回刷新前那一屏。
   *
   * 触发点是**确定的**：`attached.offset` 是本次订阅的重放终点（服务端保证 `attached`
   * 先于字节到达），所以「已解析偏移 ≥ 它」就等于「重放字节全部进了 xterm」。比这更早
   * 的滚动没有意义（缓冲区还没那么长），更晚则要先回答「输出流什么时候停」——那没有
   * 答案，shell 随时可能再吐一行。
   *
   * 故意**不**做「每块都逼近目标」式恢复：那等于在重放期间持续和用户抢滚动条。
   */
  #restoreScroll(parsedOffset: number): void {
    const target = this.#pendingScroll;
    if (target === null) return;
    const attachAt = this.#attachTarget;
    if (attachAt === null || parsedOffset < attachAt) return;
    this.#pendingScroll = null;
    const buffer = this.#term.buffer.active;
    if (buffer.type !== 'normal') return;
    // 服务端的日志有预算、会被裁剪，所以重放出来的缓冲区可能比刷新前短。目标行超出上界时
    // 什么都不做（此刻视口本来就在底部，而“留在底部”是可接受的落点）——
    // 而不是把它钳到顶：那会把用户扔到最老的输出上。
    if (target >= buffer.baseY) return;
    this.#term.scrollToLine(target);
  }

  #renderConnection(state: ConnectionState, detail?: string): void {
    const chip = this.#chipConn;
    chip.className = 'chip';
    switch (state) {
      case 'idle':
      case 'connecting':
        chip.classList.add('warn');
        setText(chip, '连接中…');
        break;
      case 'ready':
        chip.classList.add(detail === undefined ? 'ok' : 'warn');
        setText(chip, detail ?? '已连接');
        break;
      case 'reconnecting':
        chip.classList.add('warn');
        setText(chip, detail ?? '重连中…');
        break;
      case 'closed':
        chip.classList.add('bad');
        setText(chip, '已断开');
        break;
    }
  }

  // ------------------------------------------------------------ 尺寸

  /**
   * 让 `.xterm` 铺满容器、并把网格（`.xterm-screen`）居中。
   *
   * 这两件事必须分开做：`.xterm` 里同时装着网格和滚动条。把整个 `.xterm` 居中会把滚动条
   * 也一起挪进去（实测就是这样：网格 960 宽、容器 1052，滚动条悬在中间），所以只居中网格，
   * 滚动条跟着容器走。
   */
  #placeTerminalBox(): void {
    const box = this.#term.element;
    if (box === undefined) return;
    // 覆盖 xterm 写进来的行内宽高（同属性后写的赢）
    box.style.width = '100%';
    box.style.height = '100%';
  }

  #placeGrid(screenWidth: number, screenHeight: number): void {
    const box = this.#term.element;
    if (box === undefined) return;
    const screen = box.querySelector<HTMLElement>('.xterm-screen');
    if (screen === null) return;
    const left = Math.max(0, Math.round((this.#host.clientWidth - screenWidth) / 2));
    const top = Math.max(0, Math.round((this.#host.clientHeight - screenHeight) / 2));
    screen.style.left = `${left}px`;
    screen.style.top = `${top}px`;
  }

  #scheduleFit(): void {
    if (this.#fitHandle !== null) cancelAnimationFrame(this.#fitHandle);
    this.#fitHandle = requestAnimationFrame(() => {
      this.#fitHandle = null;
      this.#fit();
    });
  }

  #fit(): void {
    if (this.#canonicalSize === null) return;
    const { cols, rows } = this.#canonicalSize;
    if (this.#host.clientWidth === 0 || this.#host.clientHeight === 0) return;

    // 单格比例只量一次（字体不变则比例不变）。量不到可信值时必须报警，
    // 否则会拿一个荒谬的比例去算字号，静默算出一屏错布局。
    if (this.#cellAspect === null) {
      const measured = measureCellAspect(document, MONO_STACK);
      if (!isPlausibleCellAspect(measured)) {
        this.#notice.textContent = `字体度量异常（单格/字号 = ${measured.toFixed(3)}）。\n请检查等宽字体是否可用。`;
        this.#notice.classList.remove('hidden');
        return;
      }
      this.#cellAspect = measured;
    }

    const result = fitTerminal(this.#host, this.#term, {
      cols,
      rows,
      cellAspect: this.#cellAspect,
      measureScreen: () => measureRenderedScreen(this.#term.element),
    });

    setText(this.#chipSize, `${cols}×${rows}`);
    if (result.layout !== null) {
      setText(this.#chipFont, `${result.layout.fontSize.toFixed(1)}px`);
    }

    if (!result.ok) {
      this.#notice.textContent = `窗口装不下 ${cols}×${rows} 的终端网格。\n请放大窗口，或调小服务端的 --cols/--rows。`;
      this.#notice.classList.remove('hidden');
      return;
    }
    this.#notice.classList.add('hidden');
    // 居中要按**实测**的渲染尺寸算，不能按模型算出来的 usedW——两者可能差一两个像素
    const rendered = measureRenderedScreen(this.#term.element);
    this.#placeGrid(rendered.width, rendered.height);
    if (result.corrections > 0) {
      // 校正发生了说明「我们的度量」与「xterm 的度量」有出入，值得知道而不是悄悄咽掉
      console.info(
        `尺寸校正 ${result.corrections} 次：渲染尺寸比模型大，已退让字号`,
        result.overflow,
      );
    }
  }

  /**
   * 只读诊断快照：浏览器控制台与真实浏览器探针都用它读取**真实生效**的值。
   *
   * 存在的理由是这类值没法从 DOM 上看出来——比如 `scrollback` 只影响能往回滚多远，
   * 断言它只能读出来比。对外只暴露数据，不暴露可变引用。
   */
  debugState(): {
    session: string | null;
    cols: number | null;
    rows: number | null;
    scrollback: number | undefined;
    fontSize: number | undefined;
    connection: ConnectionState;
    /** 视口顶行与底部行（缓冲区绝对行号）：滚动位置恢复的断言点。 */
    viewportY: number;
    baseY: number;
    /** 备用屏幕是否生效（备用屏没有 scrollback，位置记忆不适用）。 */
    altScreen: boolean;
    modes: Record<string, unknown>;
    /** 服务端是否正要求本端暂缓发送输入（与顶栏 chip 同一个来源）。 */
    inputHeld: boolean;
    /** 暂缓期间在本端排队的字节数。 */
    heldInputBytes: number;
    /** 是否选中了终端文本（快捷键扩展的分支点，也是「复制后选区消失」的断言点）。 */
    hasSelection: boolean;
    /** 选区文本长度。 */
    selectionLength: number;
  } {
    const modes = this.#term.modes;
    const buffer = this.#term.buffer.active;
    return {
      session: this.#activeSession,
      cols: this.#canonicalSize?.cols ?? null,
      rows: this.#canonicalSize?.rows ?? null,
      scrollback: this.#term.options.scrollback,
      fontSize: this.#term.options.fontSize,
      connection: this.#connection,
      viewportY: buffer.viewportY,
      baseY: buffer.baseY,
      altScreen: buffer.type === 'alternate',
      inputHeld: this.#client.inputHeld,
      heldInputBytes: this.#client.heldInputBytes,
      hasSelection: this.#term.hasSelection(),
      selectionLength: this.#term.getSelection().length,
      // 前端真实生效的模式。它是**独立的一份真相**（xterm.js 自己解析出来的），
      // 因此可以用来和服务端的状态对照——模式决定输入编码，两侧不一致就是真 bug。
      modes: {
        sendFocusMode: modes.sendFocusMode,
        mouseTrackingMode: modes.mouseTrackingMode,
        applicationCursorKeysMode: modes.applicationCursorKeysMode,
        bracketedPasteMode: modes.bracketedPasteMode,
        insertMode: modes.insertMode,
        originMode: modes.originMode,
        wraparoundMode: modes.wraparoundMode,
        synchronizedOutputMode: modes.synchronizedOutputMode,
      },
    };
  }

  dispose(): void {
    this.#resizeObserver?.disconnect();
    this.#client.close();
    this.#term.dispose();
  }
}

