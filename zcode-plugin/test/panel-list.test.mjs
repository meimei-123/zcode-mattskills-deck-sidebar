// 工单 03 缝 2 测试:stub 桥宿主(Node 直跑,不依赖真机)驱动真实页面产物。
// 缝 = dist/ui/panel.html 的内联引导脚本 + 它拉起的 bundle:在假 window/document/parent 里
// 逐字执行,假 callTool/resources 响应由真 dist/server.mjs 对 fixtures 工作区预录
// (响应形状与真机一致,数据源与缝 1 同一批 fixtures)。断言可见 DOM(行数、编号、状态类名、
// 计数条数值)与发出的桥包络。无框架;DOM 桩只实现页面用到的窄接口。
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
    check("rows: 8 行(2 容器 + 6 票)", rows.length === 8, `got ${rows.length}`);

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
    check("rows: closed 票挂 ms-closed", classesOf(rowByKey("#m1-core-board/03")).includes("ms-closed"), rowByKey("#m1-core-board/03")?.className);
    check("rows: closed 地图子票挂 ms-closed", classesOf(rowByKey("#explore-login/02")).includes("ms-closed"));

    const tt = rowByKey("#m1-core-board/01");
    check("rows: 标题文本", byClass(tt, "ms-title")[0]?.textContent === "插件骨架 tracer", byClass(tt, "ms-title")[0]?.textContent);
    const st = byClass(tt, "ms-state-chip")[0];
    check("rows: 状态胶囊中文文案", st?.textContent === "在办", st?.textContent);
    const stClosed = byClass(rowByKey("#explore-login/02"), "ms-state-chip")[0];
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
    check("refresh: 重拉后行仍是 8 行", byClass(host.root, "ms-row").length === 8, String(byClass(host.root, "ms-row").length));

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
await sliceRefresh();

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
