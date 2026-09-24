/**
 * 极小的 DOM 助手。
 *
 * 存在的理由不是「少打字」，而是**把 `innerHTML` 从代码库里彻底排除掉**：终端数据是
 * 不可信输入（`docs/architecture.md` §10 的安全边界就是按「terminal to HTML/JS 攻击向量」
 * 这一侧处理的），而 `textContent` 是唯一不会被误用成解析 HTML 的写法。所有文本一律走
 * `text()`；需要结构就建元素。
 */

export interface ElementOptions {
  readonly class?: string;
  readonly text?: string;
  readonly title?: string;
  readonly attrs?: Readonly<Record<string, string>>;
  readonly children?: readonly Node[];
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.class !== undefined) node.className = options.class;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.title !== undefined) node.title = options.title;
  for (const [name, value] of Object.entries(options.attrs ?? {})) {
    node.setAttribute(name, value);
  }
  for (const child of options.children ?? []) node.appendChild(child);
  return node;
}

/** 把节点的全部子节点替换为给定内容（同样不使用 innerHTML）。 */
export function replace(parent: Element, ...children: readonly Node[]): void {
  parent.replaceChildren(...children);
}

/** 设置文本并返回节点，便于链式写法。 */
export function setText(node: Element, text: string): void {
  node.textContent = text;
}
