/**
 * 前端入口。
 *
 * 只做三件事：引入样式、取挂载点、把 App 建起来。任何业务逻辑都不该出现在这里。
 */

// xterm.js 自带样式必须先于我们的样式加载：我们的 .term-host 定位是建立在
// xterm 自己的布局之上的（它把 .xterm 设成 absolute）。
import '@xterm/xterm/css/xterm.css';
import './style.css';

import { App } from './ui/app.js';

const root = document.getElementById('app');
if (root === null) {
  throw new Error('缺少 #app 挂载点（index.html 与本文件不匹配）');
}

const app = new App(root);

// 便于在浏览器控制台里查状态；生产构建时这个引用也只是多一个全局变量，不影响渲染
Object.defineProperty(window, '__terminald', { value: app, configurable: true });
