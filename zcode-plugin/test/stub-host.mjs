// 缝 2 共享测试架(工单 03 起抽公共):stub 桥宿主 + DOM 桩 + 真 server 会话预录。
// 面板测试(panel-list/panel-detail)共用同一份桩,断言助手与包络捕获从这里拿。
// DOM 桩只实现页面用到的窄接口;工单 05 起补三件事:元素事件(click 驱动交互)、
// window 通用事件(resize 驱动折叠重算)、scrollWidth/clientWidth 可覆写(fold 的 fits 判定)。
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // zcode-plugin/

// ---------------------------------------------------------------------------
// DOM 桩:页面只用 createElement / className / textContent / setAttribute /
// append/appendChild/replaceChildren / style 属性 / getElementById / addEventListener,
// 桩就只实现这些。script 元素进 body 时同步求值(真 DOM 的 <script> 注入语义)。
// ---------------------------------------------------------------------------
let docForScripts = null; // makeStubHost 设置;<script> 进 body 时同步求值(真 DOM 注入语义)

export class El {
  constructor(tag) {
    this.tagName = tag === "#text" ? "#text" : String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.style = {};
    this.className = "";
    this._text = "";
    this._listeners = new Map(); // type → [fn];交互驱动(click)与 resize 都走这里
  }
  get id() {
    return this.attributes.get("id") || "";
  }
  get textContent() {
    // 真 DOM 里文本是子文本节点;桩同语义:own 文本进 #text 子节点,getter 只拼子树
    if (this.tagName === "#text") return this._text;
    return this.children.map((c) => c.textContent).join("");
  }
  set textContent(v) {
    this.children = [];
    this._text = String(v ?? "");
    if (this._text) {
      const t = new El("#text");
      t._text = this._text;
      this.children.push(t);
    }
  }
  setAttribute(k, v) {
    this.attributes.set(String(k), String(v));
    if (k === "class") this.className = String(v);
    if (k === "id") this.attributes.set("id", String(v));
  }
  getAttribute(k) {
    return this.attributes.has(String(k)) ? this.attributes.get(String(k)) : "";
  }
  removeAttribute(k) {
    this.attributes.delete(String(k));
  }
  appendChild(n) {
    if (typeof n === "string") {
      // 真 DOM 的 append/appendChild 收字符串会包成文本节点,桩保持同语义
      const t = new El("#text");
      t.textContent = n;
      n = t;
    }
    n.parentNode = this;
    this.children.push(n);
    if (docForScripts && this === docForScripts.body && n.tagName === "SCRIPT" && n._text) docForScripts.runScript(n._text);
    return n;
  }
  append(...ns) {
    for (const n of ns) this.appendChild(n);
  }
  replaceChildren(...ns) {
    this.children = [];
    for (const n of ns) this.appendChild(n);
  }
  addEventListener(type, fn) {
    const k = String(type);
    if (!this._listeners.has(k)) this._listeners.set(k, []);
    this._listeners.get(k).push(fn);
  }
  removeEventListener(type, fn) {
    const arr = this._listeners.get(String(type));
    const i = arr ? arr.indexOf(fn) : -1;
    if (i >= 0) arr.splice(i, 1);
  }
  dispatchEvent(evt) {
    const e = evt || {};
    if (!e.target) e.target = this;
    e.currentTarget ??= this;
    e.preventDefault ??= () => {};
    e.stopPropagation ??= () => {};
    for (const fn of [...(this._listeners.get(String(e.type)) || [])]) fn(e);
    return true;
  }
  /** 测试侧合成点击:按注册序派发 click 监听(真 DOM 语义子集,不做冒泡)。 */
  click() {
    this.dispatchEvent({ type: "click" });
  }
  remove() {
    const p = this.parentNode;
    if (!p) return;
    const i = p.children.indexOf(this);
    if (i >= 0) p.children.splice(i, 1);
    this.parentNode = null;
  }
}

/** 树遍历断言助手:深度优先收集满足谓词的节点。 */
export function findAll(node, pred, out = []) {
  if (!node) return out;
  if (pred(node)) out.push(node);
  for (const c of node.children || []) findAll(c, pred, out);
  return out;
}
export const byClass = (root, cls) => findAll(root, (n) => typeof n.className === "string" && n.className.split(/\s+/).includes(cls));
export const byAttr = (root, k, v) => findAll(root, (n) => n.getAttribute && n.getAttribute(k) === v);
export const classesOf = (n) => (n ? String(n.className || "").split(/\s+/) : []);

// ---------------------------------------------------------------------------
// 真 server 会话(响应预录源):spawn dist/server.mjs 指向 fixture 工作区
// ---------------------------------------------------------------------------
export async function startServer(workspaceRoot) {
  const child = spawn(process.execPath, [join(ROOT, "dist", "server.mjs")], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, ZCODE_WORKSPACE_ROOT: workspaceRoot },
  });
  let buf = "";
  const pending = new Map();
  let nextId = 1;
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, resolve);
      send({ jsonrpc: "2.0", id, method, params });
      setTimeout(() => reject(new Error(`timeout waiting ${method}`)), 5000);
    });
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const stop = async () => {
    child.stdin.end();
    await new Promise((r) => child.on("exit", r));
  };
  return { rpc, stop };
}

// ---------------------------------------------------------------------------
// stub 桥宿主:假 window/document + 假宿主窗口。页面发 postMessage → 这里应答:
//   ui/initialize      → 宿主自己应答(空能力)
//   resources/read     → 转发给真 server(dist/ui 资产)
//   tools/call         → 转发给真 server(fixtures 预录的工具响应);failTools 回协议错;
//                        failNames 只让名单内的工具失败(驱动「列表成功、get 失败」)
// holdTools 为 true 时挂起 tools/call 不应答(驱动「加载中」态断言);
// holdToolsNow() 让挂起从某一刻才开始(先进列表、再挂住 get)。
// ---------------------------------------------------------------------------
export function makeStubHost({ server, failTools = false, holdTools = false, failNames = null } = {}) {
  let holding = holdTools; // releaseTools() 放行后被挂起的 tools/call
  const failSet = failNames instanceof Set ? failNames : null;
  const messageListeners = [];
  const winListeners = new Map(); // type → [fn];window 级通用事件(resize 等)
  const sent = [];
  const heldTools = [];
  const parent = {
    postMessage(msg) {
      sent.push(msg);
      queueMicrotask(() => respond(msg));
    },
  };
  const win = {
    parent,
    addEventListener(type, fn) {
      const k = String(type);
      if (k === "message") messageListeners.push(fn);
      else {
        if (!winListeners.has(k)) winListeners.set(k, []);
        winListeners.get(k).push(fn);
      }
    },
    removeEventListener(type, fn) {
      const k = String(type);
      if (k === "message") {
        const i = messageListeners.indexOf(fn);
        if (i >= 0) messageListeners.splice(i, 1);
      } else {
        const arr = winListeners.get(k);
        const i = arr ? arr.indexOf(fn) : -1;
        if (i >= 0) arr.splice(i, 1);
      }
    },
  };
  function dispatch(data) {
    for (const fn of [...messageListeners]) fn({ source: parent, data, origin: "stub://host" });
  }
  async function respond(msg) {
    if (!msg || msg.jsonrpc !== "2.0" || msg.id === undefined) return;
    if (msg.method === "ui/initialize") {
      dispatch({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2026-01-26", hostInfo: { name: "stub-host", version: "0" }, hostCapabilities: {}, hostContext: {} } });
      return;
    }
    if (msg.method === "tools/call" && (failTools || (failSet && failSet.has(msg.params?.name)))) {
      dispatch({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: `stub: 工具调用失败(${msg.params?.name})` } });
      return;
    }
    if (holding && msg.method === "tools/call") {
      heldTools.push(msg);
      return;
    }
    try {
      const r = await server.rpc(msg.method, msg.params);
      dispatch({ jsonrpc: "2.0", id: msg.id, ...(r.error ? { error: r.error } : { result: r.result }) });
    } catch (e) {
      dispatch({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: String(e && e.message ? e.message : e) } });
    }
  }

  // DOM:骨架从真 panel.html 里抠出来(#root 与初始文案不另行捏造)
  const panelPath = join(ROOT, "dist", "ui", "panel.html");
  const html = existsSync(panelPath) ? readFileSync(panelPath, "utf8") : "";
  const rootMatch = /<div id="root"([^>]*)>([^<]*)<\/div>/.exec(html);
  const scriptMatch = /<script>([\s\S]*?)<\/script>/.exec(html);
  const head = new El("head");
  const body = new El("body");
  const root = new El("div");
  root.setAttribute("id", "root");
  for (const attr of /([a-zA-Z-]+)="([^"]*)"/g.exec(rootMatch?.[1] || "") ? [rootMatch[1]] : []) {
    const m = /([a-zA-Z-]+)="([^"]*)"/.exec(attr);
    if (m && m[1] !== "id") root.setAttribute(m[1], m[2]);
  }
  root.textContent = rootMatch ? rootMatch[2] : "";
  body.appendChild(root);
  const doc = {
    head,
    body,
    createElement: (tag) => new El(tag),
    createTextNode: (t) => {
      const n = new El("#text");
      n.textContent = t;
      return n;
    },
    getElementById(id) {
      return findAll(body, (n) => n.id === id)[0] || null;
    },
    runScript(text) {
      new Function("window", "document", `"use strict";\n${text}`).call(win, win, doc);
    },
  };
  docForScripts = doc;
  return {
    win, doc, root, sent, heldTools, html, script: scriptMatch ? scriptMatch[1] : "",
    /** 点火:执行 panel.html 的内联引导脚本(真机上是 HTML 解析即执行)。 */
    start() {
      doc.runScript(this.script);
    },
    /** 放行被 holdTools 挂起的 tools/call(驱动加载中→就绪的转折)。 */
    async releaseTools() {
      holding = false;
      for (const msg of heldTools.splice(0)) await respond(msg);
    },
    /** 从此刻起挂起 tools/call(先进列表、再卡住详情取数)。 */
    holdToolsNow() {
      holding = true;
    },
    /** 合成 window resize(驱动折叠重算等 resize 监听)。 */
    fireResize() {
      for (const fn of [...(winListeners.get("resize") || [])]) fn({ type: "resize", target: win });
    },
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(cond, label, timeoutMs = 5000) {
  const t0 = Date.now();
  for (;;) {
    if (cond()) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(20);
  }
}
