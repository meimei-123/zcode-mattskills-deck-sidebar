// 工单 03 缝 2 测试:stub 桥宿主(Node 直跑,不依赖真机)驱动真实页面产物。
// 缝 = dist/ui/panel.html 的内联引导脚本 + 它拉起的 bundle:在假 window/document/parent 里
// 逐字执行,假 callTool/resources 响应由真 dist/server.mjs 对 fixtures 工作区预录
// (响应形状与真机一致,数据源与缝 1 同一批 fixtures)。断言可见 DOM(行数、编号、状态类名、
// 计数条数值)与发出的桥包络。无框架;DOM 桩只实现页面用到的窄接口。
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // zcode-plugin/
const FIXTURES = join(ROOT, "test", "fixtures");
const PLUGIN_NAME = "zcode-mattpocock-skills-deck";
const ASSETS_BASE = `ui://${PLUGIN_NAME}/assets/`;

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`ok - ${name}`);
  else {
    failures++;
    console.error(`FAIL - ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// DOM 桩:页面只用 createElement / className / textContent / setAttribute /
// append/appendChild/replaceChildren / style 属性 / getElementById,桩就只实现这些。
// script 元素进 body 时同步求值(真 DOM 的 <script> 注入语义),样式元素只挂树。
// ---------------------------------------------------------------------------
let docForScripts = null; // makeStubHost 设置;<script> 进 body 时同步求值(真 DOM 注入语义)

class El {
  constructor(tag) {
    this.tagName = tag === "#text" ? "#text" : String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.style = {};
    this.className = "";
    this._text = "";
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
  // 事件面(工单 04 起页面用标准 addEventListener('click'),桩补齐窄接口)
  addEventListener(type, fn) {
    (this._listeners ??= {})[type] ??= [];
    this._listeners[type].push(fn);
  }
  removeEventListener(type, fn) {
    const list = this._listeners?.[type];
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }
  click() {
    for (const fn of [...(this._listeners?.click || [])]) {
      fn({ type: "click", currentTarget: this, preventDefault() {}, stopPropagation() {} });
    }
  }
}

/** 树遍历断言助手:深度优先收集满足谓词的节点。 */
function findAll(node, pred, out = []) {
  if (!node) return out;
  if (pred(node)) out.push(node);
  for (const c of node.children || []) findAll(c, pred, out);
  return out;
}
const byClass = (root, cls) => findAll(root, (n) => typeof n.className === "string" && n.className.split(/\s+/).includes(cls));
const byAttr = (root, k, v) => findAll(root, (n) => n.getAttribute && n.getAttribute(k) === v);
const classesOf = (n) => (n ? String(n.className || "").split(/\s+/) : []);

// ---------------------------------------------------------------------------
// 真 server 会话(响应预录源):spawn dist/server.mjs 指向 fixture 工作区
// ---------------------------------------------------------------------------
async function startServer(workspaceRoot) {
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
//   tools/call         → 转发给真 server(fixtures 预录的工具响应);failTools 时回协议错
// opts.holdTools 为 true 时挂起 tools/call 不应答(驱动「加载中」态断言)。
// ---------------------------------------------------------------------------
function makeStubHost({ server, failTools = false, holdTools = false } = {}) {
  let holding = holdTools; // releaseTools() 放行后被挂起的 tools/call
  const messageListeners = [];
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
      if (type === "message") messageListeners.push(fn);
    },
    removeEventListener(type, fn) {
      const i = messageListeners.indexOf(fn);
      if (i >= 0) messageListeners.splice(i, 1);
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
    if (failTools && msg.method === "tools/call") {
      dispatch({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "stub: 工具调用失败" } });
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
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, label, timeoutMs = 5000) {
  const t0 = Date.now();
  for (;;) {
    if (cond()) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(20);
  }
}

// ---------------------------------------------------------------------------
// 切片 A:引导五步 + 桥包络(panel.html 是小引导页,经 __pluginClient 拉真 UI 资产)
// ---------------------------------------------------------------------------
async function sliceBootstrap() {
  const server = await startServer(join(FIXTURES, "mixed"));
  try {
    const host = makeStubHost({ server });
    check("bootstrap: dist/ui/panel.html 存在内联引导脚本", host.script.length > 50, String(host.script.length));
    check("bootstrap: panel.html 骨架带 #root 初始加载文案", /正在加载/.test(host.root.textContent), host.root.textContent);
    host.start();
    const okRender = await until(() => byClass(host.root, "ms-row").length > 0, "rows render");
    check("bootstrap: 引导脚本拉起应用并渲染出卡片行", okRender, host.root.textContent.slice(0, 120));

    const methods = host.sent.map((m) => m.method);
    check("bootstrap: 先 ui/initialize 握手", methods[0] === "ui/initialize", JSON.stringify(methods));
    check("bootstrap: 经 readResource 拉 assets.json", host.sent.some((m) => m.method === "resources/read" && m.params?.uri === `${ASSETS_BASE}assets.json`),
      JSON.stringify(host.sent.map((m) => m.params?.uri || m.method)));
    check("bootstrap: 经 readResource 拉 panel.css", host.sent.some((m) => m.method === "resources/read" && m.params?.uri === `${ASSETS_BASE}panel.css`));
    check("bootstrap: 经 readResource 拉 bundle(bundle-*.txt)", host.sent.some((m) => m.method === "resources/read" && /bundle-\d+\.txt$/.test(m.params?.uri || "")));
    check("bootstrap: 包络是 JSON-RPC 2.0 且带递增 id", host.sent.every((m) => m.jsonrpc === "2.0" && Number.isInteger(m.id)));
    check("bootstrap: 应用真实调用 deck_issue_counts", host.sent.some((m) => m.method === "tools/call" && m.params?.name === "deck_issue_counts"));
    check("bootstrap: 应用真实调用 deck_issue_list", host.sent.some((m) => m.method === "tools/call" && m.params?.name === "deck_issue_list"));

    const style = findAll(host.doc.head, (n) => n.tagName === "STYLE")[0];
    check("bootstrap: panel.css 以 <style> 注入", !!style && /\.ms-/.test(style.textContent || ""), String((style?.textContent || "").slice(0, 60)));
    check("bootstrap: bundle 以 <script> 注入并执行", typeof host.win.MattSkillsPanel === "object" || typeof host.win.MattSkillsPanel === "function");
  } finally {
    await server.stop();
  }
}

// ---------------------------------------------------------------------------
// 切片 B:卡片行列表(行数 / 编号 / 状态类名 / 三段排序)
//   mixed 期望(独立于实现,来自 fixtures 手工盘点):
//   8 行 = 探索地图容器(explore-login/00) + 规格容器(m1-core-board/00) + 6 张票;
//   三段排序:地图 → 规格 → 普通票,组内编号升序;closed 行挂 ms-closed。
// ---------------------------------------------------------------------------
async function sliceRows() {
  const server = await startServer(join(FIXTURES, "mixed"));
  try {
    const host = makeStubHost({ server });
    host.start();
    await until(() => byClass(host.root, "ms-row").length > 0, "rows render");

    const rows = byClass(host.root, "ms-row");
    check("rows: 默认态 6 行(2 容器 + 4 open 票,closed 折叠)", rows.length === 6, `got ${rows.length}`);

    check("rows: 三段排序——第一行是地图容器", !!rows[0] && classesOf(rows[0]).includes("ms-kind-map"), rows[0]?.className);
    check("rows: 三段排序——第二行是规格容器", !!rows[1] && classesOf(rows[1]).includes("ms-kind-spec"), rows[1]?.className);

    const nums = rows.map((r) => byClass(r, "ms-num")[0]?.textContent || "");
    check("rows: 编号徽标带目录前缀(#effort/编号)",
      nums[0] === "#explore-login/00" && nums.includes("#m1-core-board/01") && nums.includes("#explore-login/03"),
      JSON.stringify(nums));
    const issueNums = nums.slice(2).map((t) => parseInt((t.match(/(\d+)\s*$/) || [0, 0])[1], 10));
    check("rows: 票组内编号升序", issueNums.every((v, i) => i === 0 || v >= issueNums[i - 1]), JSON.stringify(issueNums));

    const rowByKey = (k) => rows.find((r) => (byClass(r, "ms-num")[0]?.textContent || "") === k);
    check("rows: open 票挂 ms-open", classesOf(rowByKey("#m1-core-board/01")).includes("ms-open"), rowByKey("#m1-core-board/01")?.className);
    // 工单 04 起 closed 票默认折叠:展开折叠行后再断言 closed 行与状态类
    check("rows: 默认态 closed 票不在列表", !rowByKey("#m1-core-board/03") && !rowByKey("#explore-login/02"));
    const fold = byClass(host.root, "ms-closed-fold")[0];
    check("rows: 折叠行「已关闭 (2)」可见", !!fold && /已关闭 \(2\)/.test(fold.textContent || ""), fold?.textContent);
    fold?.click();
    await until(() => byClass(host.root, "ms-row").length === 8, "fold expands");
    const rowsAll = byClass(host.root, "ms-row");
    check("rows: 折叠展开后 8 行(含 2 张 closed 票)", rowsAll.length === 8, `got ${rowsAll.length}`);
    const rowByKeyAll = (k) => rowsAll.find((r) => (byClass(r, "ms-num")[0]?.textContent || "") === k);
    check("rows: closed 票挂 ms-closed", classesOf(rowByKeyAll("#m1-core-board/03")).includes("ms-closed"), rowByKeyAll("#m1-core-board/03")?.className);
    check("rows: closed 地图子票挂 ms-closed", classesOf(rowByKeyAll("#explore-login/02")).includes("ms-closed"));

    const tt = rowByKey("#m1-core-board/01");
    check("rows: 标题文本", byClass(tt, "ms-title")[0]?.textContent === "插件骨架 tracer", byClass(tt, "ms-title")[0]?.textContent);
    const st = byClass(tt, "ms-state-chip")[0];
    check("rows: 状态胶囊中文文案", st?.textContent === "在办", st?.textContent);
    const stClosed = byClass(rowByKeyAll("#explore-login/02"), "ms-state-chip")[0];
    check("rows: closed 状态胶囊文案", stClosed?.textContent === "已关闭", stClosed?.textContent);
  } finally {
    await server.stop();
  }
}

// ---------------------------------------------------------------------------
// 切片 C:计数胶囊条(九条口径 + KPI 三枚色值)
//   mixed 期望值与缝 1 sliceCounts 同源(fixtures 手工盘点):
//   可接1 进行中4 占用3 已认领1 被阻塞2 故障1 诊断3 已关闭2 全部6;
//   KPI 色值按 list-page.md:可接 #4ade80 / 占用 #f0883e / 已关闭 #52525b。
// ---------------------------------------------------------------------------
async function sliceCounts() {
  const server = await startServer(join(FIXTURES, "mixed"));
  try {
    const host = makeStubHost({ server });
    host.start();
    await until(() => byClass(host.root, "ms-pill").length > 0, "pills render");

    const pills = byClass(host.root, "ms-pill");
    check("counts: 九条口径", pills.length === 9, `got ${pills.length}`);
    const expected = {
      frontier: "可接 1", open: "进行中 4", occupied: "占用 3", claimed: "已认领 1",
      blocked: "被阻塞 2", bug: "故障 1", triage: "诊断 3", closed: "已关闭 2", total: "全部 6",
    };
    for (const [k, v] of Object.entries(expected)) {
      const p = byAttr(host.root, "data-key", k)[0];
      check(`counts: ${k} → “${v}”`, p?.textContent === v, JSON.stringify(p?.textContent));
    }
    check("counts: KPI 可接 #4ade80", byAttr(host.root, "data-key", "frontier")[0]?.getAttribute("data-color") === "#4ade80");
    check("counts: KPI 占用 #f0883e", byAttr(host.root, "data-key", "occupied")[0]?.getAttribute("data-color") === "#f0883e");
    check("counts: KPI 已关闭 #52525b", byAttr(host.root, "data-key", "closed")[0]?.getAttribute("data-color") === "#52525b");
  } finally {
    await server.stop();
  }
}

// ---------------------------------------------------------------------------
// 切片 D:加载中(holdTools 挂起工具应答的转折)/ 加载失败 / 空工作区引导态
// ---------------------------------------------------------------------------
async function sliceStates() {
  // 加载中:资产照常应答,tools/call 挂起 → 页面停在加载态;放行后出看板
  {
    const server = await startServer(join(FIXTURES, "mixed"));
    try {
      const host = makeStubHost({ server, holdTools: true });
      host.start();
      const loadingShown = await until(() => byClass(host.root, "ms-loading").length > 0, "loading state");
      check("states: 加载中态可见", loadingShown, host.root.textContent.slice(0, 80));
      check("states: 加载中不预渲染行", byClass(host.root, "ms-row").length === 0);
      await host.releaseTools();
      const rendered = await until(() => byClass(host.root, "ms-row").length > 0, "rows after release");
      check("states: 应答回来后渲染看板", rendered, host.root.textContent.slice(0, 80));
    } finally {
      await server.stop();
    }
  }
  // 加载失败:桥回协议错 → 错误态(标题 + 消息),不残留加载态
  {
    const server = await startServer(join(FIXTURES, "mixed"));
    try {
      const host = makeStubHost({ server, failTools: true });
      host.start();
      const errShown = await until(() => byClass(host.root, "ms-error").length > 0, "error state");
      check("states: 加载失败态可见", errShown, host.root.textContent.slice(0, 80));
      check("states: 失败标题中文", byClass(host.root, "ms-error-title")[0]?.textContent === "看板加载失败",
        byClass(host.root, "ms-error-title")[0]?.textContent);
      check("states: 失败带桥错误消息", /stub: 工具调用失败/.test(byClass(host.root, "ms-error-detail")[0]?.textContent || ""),
        byClass(host.root, "ms-error-detail")[0]?.textContent);
      check("states: 失败后无行", byClass(host.root, "ms-row").length === 0);
    } finally {
      await server.stop();
    }
  }
  // 空工作区:延续引导态(标题/技能指引/提示),不回演示数据
  for (const fixture of ["empty-scratch", "no-scratch"]) {
    const server = await startServer(join(FIXTURES, fixture));
    try {
      const host = makeStubHost({ server });
      host.start();
      const guideShown = await until(() => byClass(host.root, "ms-empty").length > 0, "guide state");
      check(`states(${fixture}): 空工作区引导态`, guideShown, host.root.textContent.slice(0, 80));
      check(`states(${fixture}): 引导标题`, byClass(host.root, "ms-empty-title")[0]?.textContent === "还没有工单");
      const codes = findAll(host.root, (n) => n.tagName === "CODE").map((n) => n.textContent);
      check(`states(${fixture}): 引导指向建卡技能`,
        codes.includes("/setup-matt-pocock-skills") && codes.includes("/to-tickets"), JSON.stringify(codes));
      check(`states(${fixture}): 引导不渲染行与计数条`,
        byClass(host.root, "ms-row").length === 0 && byClass(host.root, "ms-pill").length === 0);
    } finally {
      await server.stop();
    }
  }
}

// ---------------------------------------------------------------------------
// 切片 E:基础卡面细节(标签色点走内置 11 色表 / 占用标记)+ broken 坏卡容忍
// ---------------------------------------------------------------------------
async function sliceFace() {
  const server = await startServer(join(FIXTURES, "mixed"));
  try {
    const host = makeStubHost({ server });
    host.start();
    await until(() => byClass(host.root, "ms-row").length > 0, "rows render");
    const rows = byClass(host.root, "ms-row");
    const rowByKey = (k) => rows.find((r) => r.getAttribute("data-num") === k);

    const m101 = rowByKey("#m1-core-board/01");
    const bug = byClass(m101, "ms-label")[0];
    check("face: bug 标签色点 #d73a4a(内置色表)", byClass(m101, "ms-label-dot")[0]?.getAttribute("data-color") === "#d73a4a",
      byClass(m101, "ms-label-dot")[0]?.getAttribute("data-color"));
    check("face: 标签 chip 带名字", bug?.textContent === "bug", bug?.textContent);
    const m102 = rowByKey("#m1-core-board/02");
    check("face: needs-triage 标签色点 #fbca04", byClass(m102, "ms-label-dot")[0]?.getAttribute("data-color") === "#fbca04",
      byClass(m102, "ms-label-dot")[0]?.getAttribute("data-color"));

    const e01 = rowByKey("#explore-login/01");
    check("face: 认领行挂占用标记(已认领)", byClass(e01, "ms-mark-claimed").length === 1 && byClass(e01, "ms-mark-claimed")[0]?.textContent === "已认领",
      e01?.className);
    check("face: 认领行没有阻塞标记", byClass(e01, "ms-mark-blocked").length === 0);
    const m102Blocked = byClass(m102, "ms-mark-blocked")[0];
    check("face: 被阻塞行挂占用标记(被阻塞)", m102Blocked?.textContent === "被阻塞");
    check("face: 阻塞行挂 ms-blocked 类", classesOf(m102).includes("ms-blocked"), m102?.className);
    check("face: explore/03 被阻塞", byClass(rowByKey("#explore-login/03"), "ms-mark-blocked").length === 1);
    check("face: 可接行(m1/01)无占用标记", byClass(m101, "ms-mark").length === 0);
  } finally {
    await server.stop();
  }
}

// 坏卡容忍:broken fixture 的退化身份/无标题降级照样渲染成行,不炸面板
async function sliceBroken() {
  const server = await startServer(join(FIXTURES, "broken"));
  try {
    const host = makeStubHost({ server });
    host.start();
    const shown = await until(() => byClass(host.root, "ms-row").length > 0, "rows render");
    check("broken: 面板渲染不炸", shown, host.root.textContent.slice(0, 80));
    const rows = byClass(host.root, "ms-row");
    check("broken: 6 行(无容器行,notes.md 不算)", rows.length === 6, `got ${rows.length}`);
    const nums = rows.map((r) => r.getAttribute("data-num"));
    check("broken: 退化身份编号带目录前缀",
      nums.includes("#demo/03-dup-number") && nums.includes("#demo/手写卡"), JSON.stringify(nums));
    const noTitle = rows.find((r) => r.getAttribute("data-num") === "#demo/02");
    check("broken: 无标题卡降级文件名作标题", byClass(noTitle, "ms-title")[0]?.textContent === "02-无标题",
      byClass(noTitle, "ms-title")[0]?.textContent);
    check("broken: broken 计数条也有九条", byClass(host.root, "ms-pill").length === 9);
    check("broken: 断链阻塞行挂被阻塞标记",
      byClass(rows.find((r) => r.getAttribute("data-num") === "#demo/04"), "ms-mark-blocked").length === 1);
  } finally {
    await server.stop();
  }
}

// ---------------------------------------------------------------------------
// 切片 F:PixelCards 纯函数(工单 04)——色表/档位/对比度罩纱/容器三态。
// 期望值独立于实现手算(port-notes/pixel-cards.md 公式 + WCAG 亮度逐通道推导):
//   fbca04 lum 0.6277 / d73a4a 0.1797 / 10b981 0.3640 / b60205 0.1000 / 5319e7 0.0830 /
//   0ea5e9 0.3289 / 9d7cd8 0.2655 / f59e0b 0.4390 / 1D4ED8 0.1067 / 8b5cf6 0.1980 /
//   0e8a16 0.1833;d73a4a 与 8b5cf6、0e8a16 落进双阈值罩纱带。
// ---------------------------------------------------------------------------
const Cards = await (async () => {
  await import(pathToFileURL(join(ROOT, "src", "ui", "cards.mjs")).href);
  return globalThis.MattSkillsCards;
})();

function sliceCardsPure() {
  check("pure: 模块挂 globalThis.MattSkillsCards", !!Cards && typeof Cards === "object");

  const colors = Cards.CARD_ACTION_COLORS;
  check("pure: 动作色表十档 hex 无 # 前缀(pixel-cards.md §1)",
    colors.diagnose === "fbca04" && colors.fix === "d73a4a" && colors.execute === "10b981" &&
    colors.claim === "b60205" && colors.supplement === "5319e7" && colors.research === "0ea5e9" &&
    colors.grill === "9d7cd8" && colors.proto === "f59e0b" && colors.map === "8b5cf6" && colors.block === "a3231a",
    JSON.stringify(colors));

  const style = Cards.CARD_ACTION_STYLE;
  const styleExpect = {
    diagnose: ["needs-triage", "chat", false], fix: ["bug", "hammer", false],
    execute: ["wayfinder:task", "play", false], claim: ["ready-for-human", "play", false],
    supplement: ["needs-info", "play", false], research: ["wayfinder:research", "search", true],
    grill: ["wayfinder:grilling", "chat", true], proto: ["wayfinder:prototype", "proto", true],
    implement: ["implement", "hammer", false],
  };
  for (const [k, [colorKey, icon, hollow]] of Object.entries(styleExpect)) {
    const s = style[k] || {};
    check(`pure: ${k} 档 {colorKey:${colorKey}, icon:${icon}, hollow:${hollow}}`,
      s.colorKey === colorKey && s.icon === icon && s.hollow === hollow, JSON.stringify(s));
  }

  check("pure: cardLum 白=1 黑=0", Cards.cardLum("ffffff") === 1 && Cards.cardLum("000000") === 0);
  check("pure: cardLum 灰 808080≈0.2159(WCAG 手算)", Math.abs(Cards.cardLum("808080") - 0.2159) < 0.0004,
    String(Cards.cardLum("808080")));
  check("pure: cardLum # 前缀容忍", Cards.cardLum("#808080") === Cards.cardLum("808080"));

  check("pure: cardInkOn 黄 fbca04 → 深墨 #1c1004", Cards.cardInkOn("fbca04") === "#1c1004", Cards.cardInkOn("fbca04"));
  check("pure: cardInkOn 红 d73a4a → 深墨 #1c1004", Cards.cardInkOn("d73a4a") === "#1c1004", Cards.cardInkOn("d73a4a"));
  check("pure: cardInkOn 紫 5319e7 → 米白 #fff9ec", Cards.cardInkOn("5319e7") === "#fff9ec", Cards.cardInkOn("5319e7"));
  check("pure: cardInkOn 蓝 1D4ED8 → 米白 #fff9ec", Cards.cardInkOn("1D4ED8") === "#fff9ec", Cards.cardInkOn("1D4ED8"));

  check("pure: cardBoostOn 地图紫 8b5cf6 命中罩纱带", Cards.cardBoostOn("8b5cf6") === true);
  check("pure: cardBoostOn 压线绿 0e8a16 命中罩纱带", Cards.cardBoostOn("0e8a16") === true);
  check("pure: cardBoostOn 红 d73a4a 命中罩纱带", Cards.cardBoostOn("d73a4a") === true);
  check("pure: cardBoostOn 黄 fbca04 不标(深字达标)", Cards.cardBoostOn("fbca04") === false);
  check("pure: cardBoostOn 紫 5319e7 不标(白字达标)", Cards.cardBoostOn("5319e7") === false);

  check("pure: cardColorOf 先查页面色表再查档位兜底",
    Cards.cardColorOf("needs-triage", {}, "diagnose") === "fbca04" &&
    Cards.cardColorOf("needs-triage", { "needs-triage": "abc123" }, "diagnose") === "abc123" &&
    Cards.cardColorOf("zzz", {}, "execute") === "10b981",
    "");

  check("pure: 容器身份色 CONTAINER_ACCENT(container-view.ts)",
    Cards.CONTAINER_ACCENT.map === "#c084fc" && Cards.CONTAINER_ACCENT.spec === "#1D4ED8",
    JSON.stringify(Cards.CONTAINER_ACCENT));
  const cnc = Cards.containerNumberColor;
  check("pure: 容器徽章三态 done 绿 #3fb950 / empty 橙 #f59e0b",
    cnc("map", "done") === "#3fb950" && cnc("spec", "done") === "#3fb950" &&
    cnc("map", "empty") === "#f59e0b" && cnc("spec", "empty") === "#f59e0b");
  check("pure: 容器徽章 open 态 map 紫 / spec 贵族蓝",
    cnc("map", "open") === "#8b5cf6" && cnc("spec", "open") === "#1D4ED8");

  // 档位判定(action-prompts.md 十档阶梯,标签口径;无标签=诊断):
  const mk = (labels, extra = {}) => ({ type: "issue", labels: (labels || []).map((name) => ({ name })), ...extra });
  const kindCases = [
    [mk([]), "diagnose"], [mk(["needs-triage"]), "diagnose"],
    [mk(["ready-for-human"]), "claim"], [mk(["needs-info"]), "supplement"],
    [mk(["bug"]), "fix"], [mk(["wayfinder:grilling"]), "grill"],
    [mk(["wayfinder:research"]), "research"], [mk(["wayfinder:prototype"]), "proto"],
    [mk(["wayfinder:task"]), "execute"], [mk(["ready-for-agent"]), "implement"],
    [mk(["自定义杂项"]), "execute"],
    // 优先序:无标签+needs-info 同现仍先诊断;bug 与 ready-for-human 同现取接手
    [mk(["needs-info", "needs-triage"]), "diagnose"], [mk(["bug", "ready-for-human"]), "claim"],
  ];
  for (const [row, want] of kindCases) {
    check(`pure: rowActionKind [${row.labels.map((l) => l.name).join(",") || "无标签"}] → ${want}`,
      Cards.rowActionKind(row) === want, Cards.rowActionKind(row));
  }
}

// ---------------------------------------------------------------------------
// 切片 G:PixelCards 卡面(工单 04)——cards fixture(十档票 + 三态容器)驱动缝 2,
// 断言编号徽章(实心/空心/罩纱标记)、容器角标与三态徽章、结案章、图钉、脚注、
// 状态角标、标签墨块(实心底 + cardInkOn 字色)。色值断言来自纯函数切片的手算表。
// ---------------------------------------------------------------------------
async function slicePixelFace() {
  const server = await startServer(join(FIXTURES, "cards"));
  try {
    const host = makeStubHost({ server });
    host.start();
    await until(() => byClass(host.root, "ms-row").length > 0, "rows render");
    const rows0 = byClass(host.root, "ms-row");
    check("face: cards fixture 默认 13 行(2 容器 + 10 open 票,11 号 closed 折叠)", rows0.length === 13, `got ${rows0.length}`);
    byClass(host.root, "ms-closed-fold")[0]?.click(); // 展开关闭票折叠区,让 11 号进列表
    await until(() => byClass(host.root, "ms-row").length === 14, "fold expands");
    const rows = byClass(host.root, "ms-row");
    const rowByKey = (k) => rows.find((r) => r.getAttribute("data-num") === k);
    check("face: cards fixture 展开后 14 行(2 容器 + 12 票)", rows.length === 14, `got ${rows.length}`);

    // 编号徽章——实心档:底=动作色,字=cardInkOn,罩纱带挂 data-cd-boost
    const solid = (k) => byClass(rowByKey(k), "ms-num")[0];
    check("face: diagnose(#cardsdemo/01)实心徽章 底#fbca04 字#1c1004",
      solid("#cardsdemo/01")?.style.background === "#fbca04" && solid("#cardsdemo/01")?.style.color === "#1c1004",
      JSON.stringify(solid("#cardsdemo/01")?.style));
    check("face: fix(#cardsdemo/02)实心徽章 底#d73a4a 字#1c1004 挂罩纱标记",
      solid("#cardsdemo/02")?.style.background === "#d73a4a" && solid("#cardsdemo/02")?.style.color === "#1c1004" &&
      solid("#cardsdemo/02")?.getAttribute("data-cd-boost") === "1",
      JSON.stringify(solid("#cardsdemo/02")?.style));
    check("face: claim(#cardsdemo/03)实心徽章 底#b60205 字#fff9ec",
      solid("#cardsdemo/03")?.style.background === "#b60205" && solid("#cardsdemo/03")?.style.color === "#fff9ec");
    check("face: implement(#cardsdemo/08)实心徽章 底#1d4ed8(规格身份色)字#fff9ec",
      solid("#cardsdemo/08")?.style.background === "#1d4ed8" && solid("#cardsdemo/08")?.style.color === "#fff9ec");
    check("face: 黄卡(#cardsdemo/01)不挂罩纱标记", solid("#cardsdemo/01")?.getAttribute("data-cd-boost") === "");

    // 编号徽章——空心档(research/grill/proto):描线款类 cd-nonum line,边=主色,无底色
    const hollowBadge = (k) => byClass(rowByKey(k), "ms-num")[0];
    for (const [k, hex] of [["#cardsdemo/05", "#0ea5e9"], ["#cardsdemo/06", "#9d7cd8"], ["#cardsdemo/07", "#f59e0b"]]) {
      const b = hollowBadge(k);
      check(`face: 空心徽章 ${k} 挂 cd-nonum line 边${hex} 无底色`,
        classesOf(b).includes("cd-nonum") && classesOf(b).includes("line") &&
        b.style.borderColor === hex && !b.style.background,
        `${b?.className} :: ${JSON.stringify(b?.style)}`);
      check(`face: 空心徽章 ${k} 不挂罩纱标记`, b?.getAttribute("data-cd-boost") === "");
    }

    // 行主色标记
    check("face: 行挂 data-cd-act 主色(fix #d73a4a)", rowByKey("#cardsdemo/02")?.getAttribute("data-cd-act") === "#d73a4a",
      rowByKey("#cardsdemo/02")?.getAttribute("data-cd-act"));

    // 容器角标 + 三态徽章
    const mapRow = rowByKey("#cardsdemo/00");
    const mapChip = byClass(mapRow, "dsws-chip-container")[0];
    check("face: 地图容器角标 dsws-chip-m + 文案「地图」+ 身份色#c084fc",
      classesOf(mapChip).includes("dsws-chip-m") && mapChip?.textContent === "地图" && mapChip?.style.color === "#c084fc",
      `${mapChip?.className} :: ${mapChip?.textContent}`);
    const specRow = rowByKey("#specdemo/00");
    const specChip = byClass(specRow, "dsws-chip-container")[0];
    check("face: 规格容器角标 dsws-chip-s + 文案「规格」+ 身份色#1D4ED8",
      classesOf(specChip).includes("dsws-chip-s") && specChip?.textContent === "规格" && specChip?.style.color === "#1D4ED8",
      `${specChip?.className} :: ${specChip?.textContent}`);
    check("face: 地图容器(有 open 子票)徽章 open 态#8b5cf6", byClass(mapRow, "ms-num")[0]?.style.background === "#8b5cf6");
    check("face: 规格容器(无子票)徽章 empty 态#f59e0b", byClass(specRow, "ms-num")[0]?.style.background === "#f59e0b");

    // 结案章(closed 票)
    const seal = byClass(rowByKey("#cardsdemo/11"), "cd-sealcn")[0];
    check("face: 结案章「结案」底#a3231a 字#fff9ec",
      seal?.textContent === "结案" && seal?.style.background === "#a3231a" && seal?.style.color === "#fff9ec",
      JSON.stringify(seal?.style));

    // 图钉:open 圆图钉 / closed 胶带
    check("face: open 票圆图钉 #c0392b", byClass(rowByKey("#cardsdemo/01"), "cd-pin")[0]?.style.background === "#c0392b");
    check("face: closed 票胶带图钉", byClass(rowByKey("#cardsdemo/11"), "cd-pin-tape").length === 1);

    // 脚注(被阻塞红字行)
    const note = byClass(rowByKey("#cardsdemo/12"), "cd-note")[0];
    check("face: 被阻塞票红色脚注「被 1 挡住」", note?.textContent === "被 1 挡住", note?.textContent);
    check("face: 无阻塞票无脚注", byClass(rowByKey("#cardsdemo/01"), "cd-note").length === 0);

    // 状态角标:bug→BUG 三角;占用→在办;可接→可接;closed 非 bug 无角标
    check("face: bug 票角标「BUG」", byClass(rowByKey("#cardsdemo/02"), "cd-corner")[0]?.textContent === "BUG");
    check("face: closed bug 票保留 BUG 角标", byClass(rowByKey("#cardsdemo/11"), "cd-corner").length === 1);
    check("face: 可接票角标「可接」", byClass(rowByKey("#cardsdemo/01"), "cd-ckj")[0]?.textContent === "可接");
    check("face: 被阻塞票角标「在办」", byClass(rowByKey("#cardsdemo/12"), "cd-ckb")[0]?.textContent === "在办");
    check("face: closed 非 bug 票无状态角标", byClass(rowByKey("#specdemo/00"), "cd-ckj").length === 0);

    // 标签墨块:真实标签色实心底 + cardInkOn 字色 + 罩纱标记;色点结构保留
    const bugChip = byClass(rowByKey("#cardsdemo/02"), "ms-label")[0];
    check("face: bug 标签墨块实心底#d73a4a 字#1c1004 挂罩纱",
      bugChip?.style.background === "#d73a4a" && bugChip?.style.color === "#1c1004" &&
      bugChip?.getAttribute("data-cd-boost") === "1",
      JSON.stringify(bugChip?.style));
    const triChip = byClass(rowByKey("#cardsdemo/01"), "ms-label")[0];
    check("face: needs-triage 标签墨块#fbca04 字#1c1004 不挂罩纱",
      triChip?.style.background === "#fbca04" && triChip?.style.color === "#1c1004" &&
      triChip?.getAttribute("data-cd-boost") === "");
    const researchChip = byClass(rowByKey("#cardsdemo/05"), "ms-label")[0];
    check("face: wayfinder:research 标签墨块#0ea5e9 字#1c1004",
      researchChip?.style.background === "#0ea5e9" && researchChip?.style.color === "#1c1004");
    check("face: 标签色点保留(T03 结构)", byClass(rowByKey("#cardsdemo/02"), "ms-label-dot")[0]?.getAttribute("data-color") === "#d73a4a");
  } finally {
    await server.stop();
  }
}

// ---------------------------------------------------------------------------
// 切片 H:视图投影纯函数(工单 04)——状态分桶/占用口径/标签 OR/容器行不过标签筛/三段排序。
// 数据形状与 deck_issue_list 薄行一致,期望值手工盘点。
// ---------------------------------------------------------------------------
function sliceViewPure() {
  const V = Cards;
  const mk = (key, effortId, extra = {}) => ({
    key, effortId, type: "issue", title: `t-${key}`, state: "open",
    labels: [], blockedBy: [], ...extra,
  });
  const rows = [
    mk("00", "e1", { type: "map" }),
    mk("00", "s1", { type: "spec" }),
    mk("01", "e1", { labels: [{ name: "bug" }] }),
    mk("02", "e1", { labels: [{ name: "needs-triage" }], blockedBy: [{ key: "01", state: "open" }] }),
    mk("03", "e1", { state: "closed", labels: [{ name: "bug" }] }),
    mk("04", "e1", { assignees: [{ login: "dev" }] }),
    mk("05", "e1", { blockedBy: [{ key: "99" }] }), // 断链 → 安全阻塞
  ];
  const numsOf = (out) => out.map((r) => `${r.effortId}/${r.key}`);

  let v = V.applyView(rows, { state: "all", labels: [] });
  check("view: all 态 open 行含容器,不含 closed",
    v.openRows.length === 6 && v.closedRows.length === 1 && v.openRows.some((r) => r.type === "map"),
    JSON.stringify({ open: numsOf(v.openRows), closed: numsOf(v.closedRows) }));

  v = V.applyView(rows, { state: "blocked", labels: [] });
  check("view: blocked 筛选 = 占用口径(认领或被 open 阻塞),不含容器与 closed",
    numsOf(v.openRows).join(",") === "e1/02,e1/04,e1/05", JSON.stringify(numsOf(v.openRows)));

  v = V.applyView(rows, { state: "frontier", labels: [] });
  check("view: frontier = 非占用 open 票", numsOf(v.openRows).join(",") === "e1/01", JSON.stringify(numsOf(v.openRows)));

  v = V.applyView(rows, { state: "closed", labels: [] });
  check("view: closed 筛选只给 closed 票,容器不进",
    v.openRows.length === 0 && numsOf(v.closedRows).join(",") === "e1/03",
    JSON.stringify({ open: numsOf(v.openRows), closed: numsOf(v.closedRows) }));

  v = V.applyView(rows, { state: "all", labels: ["bug"] });
  check("view: 标签 OR 命中 bug(open 可见,closed 分桶仍被收),容器行不过标签筛",
    numsOf(v.openRows).join(",") === "e1/00,s1/00,e1/01" && numsOf(v.closedRows).join(",") === "e1/03",
    JSON.stringify({ open: numsOf(v.openRows), closed: numsOf(v.closedRows) }));

  v = V.applyView(rows, { state: "all", labels: ["needs-triage"] });
  check("view: 选 needs-triage 时无标签行也显示",
    numsOf(v.openRows).join(",") === "e1/00,s1/00,e1/02,e1/04,e1/05", JSON.stringify(numsOf(v.openRows)));

  v = V.applyView(rows, { state: "all", labels: ["bug", "needs-triage"] });
  check("view: 多标签 OR", numsOf(v.openRows).length === 6, JSON.stringify(numsOf(v.openRows)));

  // 排序:三段容器固定,组内 number desc 反转票组
  const sorted = V.sortViewRows(rows, "number", -1);
  const sortedNums = sorted.filter((r) => r.type !== "map" && r.type !== "spec").map((r) => r.key);
  check("view: number 降序反转票组", sortedNums.join(",") === "05,04,03,02,01", JSON.stringify(sortedNums));
  check("view: 容器段序不随排序变(map→spec)",
    sorted.slice(0, 2).map((r) => r.type).join(",") === "map,spec", sorted.slice(0, 2).map((r) => r.type).join(","));

  // 标签目录与点击记忆四键排序(次数降序→最近点击降序→频次降序→名称序)
  const cat = V.labelCatalog(rows);
  check("view: 标签目录频次正确", cat.get("bug") === 2 && cat.get("needs-triage") === 1, JSON.stringify([...cat]));
  const chips = V.sortLabelChips(cat, {});
  check("view: 无点击记忆时按频次降序", chips[0].name === "bug", JSON.stringify(chips));
  const clicks = { "needs-triage": { n: 2, ts: 100 }, bug: { n: 1, ts: 90 } };
  check("view: 点击次数优先于频次", V.sortLabelChips(cat, clicks)[0].name === "needs-triage",
    JSON.stringify(V.sortLabelChips(cat, clicks)));
  const clicks2 = { "needs-triage": { n: 1, ts: 100 }, bug: { n: 1, ts: 200 } };
  check("view: 同次数比最近点击", V.sortLabelChips(cat, clicks2)[0].name === "bug",
    JSON.stringify(V.sortLabelChips(cat, clicks2)));
}

// ---------------------------------------------------------------------------
// 切片 I:筛选行三组 chips 与关闭票折叠(工单 04,缝 2 交互)。
// mixed 期望:默认 6 open 行 + 折叠「已关闭 (2)」;blocked=占用 3 行;frontier=可接 1 行;
// 标签 OR;+N 展开(cards fixture 10 个标签);点击记忆;排序翻转。
// ---------------------------------------------------------------------------
async function sliceFilterClosed() {
  const server = await startServer(join(FIXTURES, "mixed"));
  try {
    const host = makeStubHost({ server });
    host.start();
    await until(() => byClass(host.root, "ms-row").length > 0, "rows render");

    // 筛选行三组结构
    const states = byAttr(host.root, "data-state", "all").concat(
      ["open", "closed", "blocked", "frontier"].flatMap((k) => byAttr(host.root, "data-state", k))
    );
    check("filter: 状态组五颗 chips", states.length === 5, `got ${states.length}`);
    check("filter: 默认选中 all", classesOf(states[0]).includes("is-on"), states[0]?.className);
    check("filter: 状态选中墨块紫色(#c084fc 字/紫底紫边)",
      states[0]?.style.color === "#c084fc" && states[0]?.style.background === "rgba(188,140,255,.18)" &&
      states[0]?.style.borderColor === "rgba(188,140,255,.6)",
      JSON.stringify(states[0]?.style));
    const sorts = ["updatedAt", "createdAt", "number", "title"].flatMap((k) => byAttr(host.root, "data-sort", k));
    check("filter: 排序组四颗 chips", sorts.length === 4, `got ${sorts.length}`);
    const sortNum = byAttr(host.root, "data-sort", "number")[0];
    check("filter: 默认排序编号升序(↑)", classesOf(sortNum).includes("is-on") && /编号\s*↑/.test(sortNum?.textContent || ""),
      sortNum?.textContent);
    check("filter: 排序选中墨块蓝色(#58a6ff 字/蓝底蓝边)",
      sortNum?.style.color === "#58a6ff" && sortNum?.style.background === "rgba(88,166,255,.16)" &&
      sortNum?.style.borderColor === "rgba(88,166,255,.55)",
      JSON.stringify(sortNum?.style));
    check("filter: 标签组有「全部」chip", byClass(host.root, "ms-chip-all").length === 1);
    check("filter: 标签 chips 用真实色(bug #d73a4a)",
      byAttr(host.root, "data-label", "bug")[0]?.style.color === "#d73a4a",
      JSON.stringify(byAttr(host.root, "data-label", "bug")[0]?.style));

    // 状态过滤
    byAttr(host.root, "data-state", "closed")[0]?.click();
    await until(() => byClass(host.root, "ms-row").length === 2, "closed filter");
    let nums = byClass(host.root, "ms-row").map((r) => r.getAttribute("data-num"));
    check("filter: closed 态只显已关闭票(2 行,无容器;编号升序 e/02 在前)",
      nums.join(",") === "#explore-login/02,#m1-core-board/03", JSON.stringify(nums));
    check("filter: closed 态无折叠行", byClass(host.root, "ms-closed-fold").length === 0);

    byAttr(host.root, "data-state", "blocked")[0]?.click();
    await until(() => byClass(host.root, "ms-row").length === 3, "blocked filter");
    nums = byClass(host.root, "ms-row").map((r) => r.getAttribute("data-num"));
    check("filter: blocked 态=占用口径(e/01、m1/02、e/03,编号升序)",
      nums.join(",") === "#explore-login/01,#m1-core-board/02,#explore-login/03",
      JSON.stringify(nums));

    byAttr(host.root, "data-state", "frontier")[0]?.click();
    await until(() => byClass(host.root, "ms-row").length === 1, "frontier filter");
    check("filter: frontier 态只剩可接票 m1/01",
      byClass(host.root, "ms-row")[0]?.getAttribute("data-num") === "#m1-core-board/01");

    // 标签 OR + 无标签行规则(回到 all 态)
    byAttr(host.root, "data-state", "all")[0]?.click();
    await until(() => byClass(host.root, "ms-row").length === 6, "back to all");
    byAttr(host.root, "data-label", "bug")[0]?.click();
    await until(() => byClass(host.root, "ms-row").length === 3, "bug filter"); // map 容器 + m1/01(spec 容器? 见下)
    nums = byClass(host.root, "ms-row").map((r) => r.getAttribute("data-num"));
    check("filter: 标签 bug 命中 m1/01,容器行保留,closed 票仍折叠",
      nums.join(",") === "#explore-login/00,#m1-core-board/00,#m1-core-board/01", JSON.stringify(nums));
    byAttr(host.root, "data-label", "needs-triage")[0]?.click();
    await until(() => byClass(host.root, "ms-row").length === 6, "bug+triage filter");
    nums = byClass(host.root, "ms-row").map((r) => r.getAttribute("data-num"));
    check("filter: bug OR needs-triage(无标签行也算 needs-triage)",
      nums.includes("#m1-core-board/02") && nums.includes("#explore-login/01") && nums.includes("#explore-login/03"),
      JSON.stringify(nums));
    byClass(host.root, "ms-chip-all")[0]?.click(); // 全部 = 清空
    await until(() => byClass(host.root, "ms-row").length === 6, "label clear");

    // 排序翻转:点同键(number)→ desc,票组首张变 03
    byAttr(host.root, "data-sort", "number")[0]?.click();
    await until(() => {
      const first = byClass(host.root, "ms-row")[2];
      return first?.getAttribute("data-num") === "#explore-login/03";
    }, "number desc");
    check("filter: 同键点击翻转排序(编号降序,票组首张 #explore-login/03)",
      byClass(host.root, "ms-row")[2]?.getAttribute("data-num") === "#explore-login/03");
    check("filter: 翻转后选中项尾标 ↓", /编号\s*↓/.test(byAttr(host.root, "data-sort", "number")[0]?.textContent || ""),
      byAttr(host.root, "data-sort", "number")[0]?.textContent);

    // 空结果:frontier + needs-triage → 无匹配行,居中灰字
    byAttr(host.root, "data-state", "frontier")[0]?.click();
    byAttr(host.root, "data-label", "needs-triage")[0]?.click();
    await until(() => byClass(host.root, "ms-row").length === 0, "empty result");
    check("filter: 无匹配时空态文案", byClass(host.root, "ms-none")[0]?.textContent === "没有匹配的工单",
      byClass(host.root, "ms-none")[0]?.textContent);
  } finally {
    await server.stop();
  }

  // +N 展开与点击记忆(cards fixture:10 个标签,默认 4 颗)
  {
    const server = await startServer(join(FIXTURES, "cards"));
    try {
      const host = makeStubHost({ server });
      host.start();
      await until(() => byClass(host.root, "ms-row").length > 0, "rows render");
      let labelChips = byClass(host.root, "ms-chip-label").filter((n) => n.getAttribute("data-label") !== "");
      check("filter: 标签默认只显 4 颗", labelChips.length === 4, `got ${labelChips.length}`);
      check("filter: 无点击时按频次排(bug 3 张排第一)", labelChips[0]?.getAttribute("data-label") === "bug",
        labelChips.map((n) => n.getAttribute("data-label")).join(","));
      const more = byClass(host.root, "ms-chip-more")[0];
      check("filter: 超出给 +6", more?.textContent === "+6", more?.textContent);

      // 点击记忆:needs-triage ×2 → 排到第一
      byAttr(host.root, "data-label", "needs-triage")[0]?.click();
      byAttr(host.root, "data-label", "needs-triage")[0]?.click(); // 再点一次=取消选择但记忆仍在
      labelChips = byClass(host.root, "ms-chip-label").filter((n) => n.getAttribute("data-label") !== "");
      check("filter: 点击记忆次数优先(needs-triage 置顶)",
        labelChips[0]?.getAttribute("data-label") === "needs-triage",
        labelChips.map((n) => n.getAttribute("data-label")).join(","));

      more?.click();
      await until(() => byClass(host.root, "ms-chip-more")[0]?.textContent === "收起", "expand");
      labelChips = byClass(host.root, "ms-chip-label").filter((n) => n.getAttribute("data-label") !== "");
      check("filter: 展开后全显 10 颗 + 收起", labelChips.length === 10, `got ${labelChips.length}`);
      check("filter: 展开后仍保持记忆排序", labelChips[0]?.getAttribute("data-label") === "needs-triage");
      byClass(host.root, "ms-chip-more")[0]?.click();
      await until(() => byClass(host.root, "ms-chip-more")[0]?.textContent === "+6", "collapse");
      check("filter: 收起回 4 颗 + +6",
        byClass(host.root, "ms-chip-label").filter((n) => n.getAttribute("data-label") !== "").length === 4);
    } finally {
      await server.stop();
    }
  }
}

// 切片 F(工单 08):实时刷新 —— 可见时按间隔轮询 counts 的 revision,变化才重拉列表;
//   document 不可见暂停,转回可见恢复;强刷钩子 refresh() 不依赖 revision 变化。
//   stub 侧用 server 代理接管 deck_issue_counts 应答的 revision(喂失效信号),数据本身不变。
// ---------------------------------------------------------------------------
async function sliceRefresh() {
  const server = await startServer(join(FIXTURES, "mixed"));
  let feed = 1; // counts 应答携带的 revision 由测试接管(真值来自服务端监听,缝 1 已测)
  const proxied = {
    rpc: async (method, params) => {
      const r = await server.rpc(method, params);
      if (!r.error && method === "tools/call" && params?.name === "deck_issue_counts" && r.result?.structuredContent) {
        r.result.structuredContent.revision = feed;
      }
      return r;
    },
    stop: () => server.stop(),
  };
  const host = makeStubHost({ server: proxied });
  host.start();
  await until(() => byClass(host.root, "ms-row").length > 0, "rows render");
  // 引导页用缺省发条(5s);这里重挂快发条驱动轮询(真宿主不受影响)
  host.win.MattSkillsPanel.boot({ client: host.win.__pluginClient, doc: host.doc, root: host.root, pollMs: 100 });
  await until(() => byClass(host.root, "ms-row").length > 0, "rows render after reboot");
  const listCalls = () => host.sent.filter((m) => m.method === "tools/call" && m.params?.name === "deck_issue_list").length;
  const countsCalls = () => host.sent.filter((m) => m.method === "tools/call" && m.params?.name === "deck_issue_counts").length;
  try {
    const base = listCalls();
    const countsBase = countsCalls();
    await sleep(450); // ≥4 个轮询格
    check("refresh: revision 不变只轮 counts、不重拉列表", listCalls() === base, `${base} -> ${listCalls()}`);
    check("refresh: 可见时轮询在跑", countsCalls() >= countsBase + 3, `${countsBase} -> ${countsCalls()}`);

    feed = 2;
    const pulled = await until(() => listCalls() > base, "list re-pulled on revision change", 2000);
    check("refresh: revision 变化 → 重拉列表", pulled, `${base} -> ${listCalls()}`);
    await sleep(300);
    check("refresh: 重拉一次后按新 revision 稳住(不循环)", listCalls() === base + 1, `${base} -> ${listCalls()}`);
    check("refresh: 重拉后列表照常渲染(T04 起默认 6 行,closed 折叠)", byClass(host.root, "ms-row").length === 6, String(byClass(host.root, "ms-row").length));

    host.doc.hidden = true;
    const countsAtHide = countsCalls();
    const listAtHide = listCalls();
    await sleep(450);
    check("refresh: 不可见暂停轮询(不空耗)", countsCalls() === countsAtHide && listCalls() === listAtHide,
      `counts ${countsAtHide} -> ${countsCalls()}, list ${listAtHide} -> ${listCalls()}`);
    host.doc.hidden = false;
    feed = 3;
    const resumed = await until(() => listCalls() > listAtHide, "list re-pulled after resume", 2000);
    check("refresh: 转回可见恢复轮询并跟上失效信号", resumed, `${listAtHide} -> ${listCalls()}`);

    feed = 3; // revision 与面板已知一致:下一轮 tick 不重拉
    const beforeHook = listCalls();
    await sleep(250);
    check("refresh: revision 未变不重拉(钩子前置)", listCalls() === beforeHook, `${beforeHook} -> ${listCalls()}`);
    host.win.MattSkillsPanel.refresh();
    const hooked = await until(() => listCalls() > beforeHook, "list re-pulled by refresh hook", 1500);
    check("refresh: 强刷钩子立即重拉(写操作/动作后调,T06/T07)", hooked, `${beforeHook} -> ${listCalls()}`);
  } finally {
    if (host.win.MattSkillsPanel && typeof host.win.MattSkillsPanel.stopPolling === "function") host.win.MattSkillsPanel.stopPolling();
    await server.stop();
  }
}

await sliceBootstrap();
await sliceRows();
await sliceCounts();
await sliceStates();
await sliceFace();
await sliceBroken();
sliceCardsPure();
await slicePixelFace();
sliceViewPure();
await sliceFilterClosed();
await sliceRefresh();

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
