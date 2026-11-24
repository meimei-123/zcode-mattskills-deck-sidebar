// 票 05 动作 prompt 的项目前言测试。
// 缝 = 面板 bundle 缝(fake DOM + stub client;断言只打 sendMessage 实参与 DOM 可见状态,
// 经公开缝 U.list.storeOf() 取 st,上游 inject(st, text) 读的正是同一个 st.injector):
//   1) 活动项目 ≠ home-repo:注入文本恰好前置一行「项目:<name>(<root>);以下操作都在该项目内进行。」
//      (全角冒号/括号/分号,<root> 用活动项目根真实路径),其余内容与原文一致;
//   2) 活动项目是 home-repo(清单存在但活动是 home):注入文本逐字一致,没有前言;
//   3) 前言不叠加:同一文本连点两次每次只前置一次;已带前言的文本再进不二次前置;
//   4) 其余文本与上游一致:多行原文逐字保留,不依赖上游模板改动(期望值 = 独立字面量);
//   5) 与 chip 同源:chip 点 deck_project_use 切走/切回后,前言跟着活动项目翻面;
//   6) 内容缝:bundle 里带着前言包装(本仓补件,上游动作模板零改动)。
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // zcode-plugin/
const BUNDLE = join(ROOT, "dist", "ui", "bundle-1.txt");

let failures = 0;
let bootedUpstream = null; // 靴起来的面板的公开对象,留给文件末尾收尾(面板挂载后有常驻定时器)
function check(name, cond, detail = "") {
  if (cond) console.log(`ok - ${name}`);
  else {
    failures++;
    console.error(`FAIL - ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(name, a === b, `actual=${a} expected=${b}`);
}

// ---------------------------------------------------------------------------
// fake DOM(照 upstream-chip 舱模式:类/属性/tag 选择器 + 冒泡 click)
// ---------------------------------------------------------------------------
function createFakeNode(nodeType, name) {
  const node = {
    nodeType,
    tagName: name ? String(name).toUpperCase() : "",
    children: [],
    parentNode: null,
    attributes: {},
    listeners: {},
    data: "",
    innerHTML: "",
    clientWidth: 0,
    scrollWidth: 0,
  };
  node.style = {};
  node.style.setProperty = (k, v) => {
    node.style[k] = v;
  };
  node.style.removeProperty = (k) => {
    delete node.style[k];
  };
  node.appendChild = (c) => {
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = node;
    node.children.push(c);
    return c;
  };
  node.insertBefore = (c, ref) => {
    if (c.parentNode) c.parentNode.removeChild(c);
    const i = ref ? node.children.indexOf(ref) : -1;
    if (i < 0) node.children.push(c);
    else node.children.splice(i, 0, c);
    c.parentNode = node;
    return c;
  };
  node.removeChild = (c) => {
    const i = node.children.indexOf(c);
    if (i >= 0) node.children.splice(i, 1);
    c.parentNode = null;
    return node;
  };
  node.replaceChild = (nu, old) => {
    const i = node.children.indexOf(old);
    if (i >= 0) node.children.splice(i, 1, nu);
    nu.parentNode = node;
    old.parentNode = null;
    return old;
  };
  node.setAttribute = (k, v) => {
    node.attributes[k] = String(v);
  };
  node.removeAttribute = (k) => {
    delete node.attributes[k];
  };
  node.getAttribute = (k) => (k in node.attributes ? node.attributes[k] : null);
  node.addEventListener = (t, fn) => {
    (node.listeners[t] = node.listeners[t] || []).push(fn);
  };
  node.removeEventListener = (t, fn) => {
    const a = node.listeners[t] || [];
    const i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  };
  node.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 40 });
  Object.defineProperty(node, "firstChild", { get: () => node.children[0] || null });
  Object.defineProperty(node, "nextSibling", {
    get: () => {
      if (!node.parentNode) return null;
      const sib = node.parentNode.children;
      const i = sib.indexOf(node);
      return i >= 0 && i + 1 < sib.length ? sib[i + 1] : null;
    },
  });
  Object.defineProperty(node, "className", {
    get: () => node.attributes["class"] || "",
    set: (v) => {
      node.attributes["class"] = String(v);
    },
  });
  Object.defineProperty(node, "classList", {
    get: () => ({
      contains: (c) => String(node.attributes["class"] || "").split(/\s+/).includes(c),
      add: (c) => {
        const list = String(node.attributes["class"] || "").split(/\s+/).filter(Boolean);
        if (!list.includes(c)) list.push(c);
        node.attributes["class"] = list.join(" ");
      },
      remove: (c) => {
        const list = String(node.attributes["class"] || "").split(/\s+/).filter((x) => x && x !== c);
        node.attributes["class"] = list.join(" ");
      },
    }),
  });
  node.querySelectorAll = (sel) => qsa(node, sel);
  node.querySelector = (sel) => qsa(node, sel)[0] || null;
  return node;
}
function matchesSeg(n, seg) {
  if (n.nodeType !== 1) return false;
  const tokenRe = /^([a-zA-Z][\w-]*)?((?:\.[\w-]+|:not\(\.[\w-]+\)|\[[^\]]+\])*)$/;
  const m = tokenRe.exec(seg);
  if (!m) return false;
  if (m[1] && n.tagName !== m[1].toUpperCase()) return false;
  const rest = m[2] || "";
  for (const t of rest.match(/(\.[\w-]+|:not\(\.[\w-]+\)|\[[^\]]+\])/g) || []) {
    if (t.startsWith(".not")) continue;
    if (t.startsWith(":not")) {
      const inner = /\.([\w-]+)\)/.exec(t);
      if (inner && String(n.attributes["class"] || "").split(/\s+/).includes(inner[1])) return false;
      continue;
    }
    if (t.startsWith(".")) {
      if (!String(n.attributes["class"] || "").split(/\s+/).includes(t.slice(1))) return false;
      continue;
    }
    const am = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(t);
    if (!am) return false;
    if (!(am[1] in n.attributes)) return false;
    if (am[2] !== undefined && n.attributes[am[1]] !== am[2]) return false;
  }
  return true;
}
function qsa(root, sel) {
  const segs = String(sel).trim().split(/\s+/).filter(Boolean);
  let layer = walk(root).filter((n) => n.nodeType === 1);
  for (let i = 0; i < segs.length; i++) {
    layer = layer.filter((n) => matchesSeg(n, segs[i]));
    if (i < segs.length - 1) {
      layer = layer.flatMap((n) => walk(n).filter((c) => c !== n && n.nodeType === 1));
    }
  }
  return layer;
}
function createFakeDom() {
  const doc = createFakeNode(9, "#document");
  doc.createElement = (tag) => {
    const n = createFakeNode(1, tag);
    n.ownerDocument = doc;
    return n;
  };
  doc.createElementNS = (ns, tag) => doc.createElement(tag);
  doc.createTextNode = (t) => {
    const n = createFakeNode(3, "");
    n.ownerDocument = doc;
    n.data = t;
    return n;
  };
  doc.createDocumentFragment = () => createFakeNode(11, "#fragment");
  doc.addEventListener = () => {};
  doc.removeEventListener = () => {};
  doc.head = createFakeNode(1, "head");
  doc.body = createFakeNode(1, "body");
  doc.head.ownerDocument = doc;
  doc.body.ownerDocument = doc;
  doc.fonts = null;
  return doc;
}
function walk(node, out = []) {
  if (!node) return out;
  out.push(node);
  for (const c of node.children || []) walk(c, out);
  return out;
}
function textOf(node) {
  return walk(node)
    .filter((n) => n.nodeType === 3)
    .map((n) => n.data)
    .join("");
}
/** 在 fake 节点上派发一次 click(props 通道优先,addEventListener 兜底)。 */
function fireClick(node, extra) {
  const ev = Object.assign(
    {
      stopPropagation() {},
      preventDefault() {},
      currentTarget: node,
      target: node,
      clientX: 0,
      clientY: 0,
    },
    extra || {}
  );
  ev.type = "Click";
  const handlerOf = (n) => {
    const props = (n && (n.l || n._)) || null;
    return props && (props.onClick || props.onclick) ? props.onClick || props.onclick : null;
  };
  const direct = handlerOf(node);
  if (typeof direct === "function") return direct.call(node, ev);
  const collect = (n) => {
    const L = (n && n.listeners) || {};
    return [...(L.click || []), ...(L.Click || [])];
  };
  for (const fn of collect(node).slice()) fn.call(node, ev);
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const flush = async () => {
  await tick();
  await tick();
  await settle(50);
};

// fake ResizeObserver(entry.mjs 有 typeof 守卫,缺席也能跑;提供以贴近真宿主)
class FakeResizeObserver {
  constructor(cb) {
    this.cb = cb;
    this.targets = [];
  }
  observe(el) {
    if (!this.targets.includes(el)) this.targets.push(el);
  }
  unobserve() {}
  disconnect() {
    this.targets.length = 0;
  }
}
globalThis.ResizeObserver = FakeResizeObserver;

// ---------------------------------------------------------------------------
// 回放数据:deck_project_list / deck_project_use 的 structuredContent(server 端
// registryState 形状,与 upstream-chip 舱同一份契约)。
// ---------------------------------------------------------------------------
const HOME = { name: "home", path: "X:/home", isHome: true };
const projectState = (activeName, activePath, activeIsHome) => ({
  ok: true,
  active: { name: activeName, path: activePath, isHome: activeIsHome },
  home: HOME,
  projects: [
    { ...HOME, valid: true },
    { name: "forge", path: "X:/forge", isHome: false, valid: true },
  ],
  warnings: [],
  registry: { status: "ok", path: "X:/home/.deck/projects.json", error: null },
});
const LIST_HOME_ACTIVE = projectState("home", "X:/home", true); // 清单存在,活动项目 = home-repo
const LIST_FORGE_ACTIVE = projectState("forge", "X:/forge", false); // 清单存在,活动项目 = forge(非 home)
const USE_OK = {
  forge: projectState("forge", "X:/forge", false),
  home: projectState("home", "X:/home", true),
};

// boot 助手:一份 bundle 代码 + 一份 fake DOM + 一份 stub client(拦 sendMessage)。
async function bootInjectPanel(listReply) {
  const doc = createFakeDom();
  const sent = [];
  const calls = [];
  const useCalls = [];
  const client = {
    readResource: async (uri) => {
      if (uri.endsWith("workspace.json")) return { contents: [{ text: JSON.stringify({ root: "X:/home", env: {} }) }] };
      throw new Error("no asset " + uri);
    },
    sendMessage: async (text) => {
      sent.push(String(text == null ? "" : text));
      return { ok: true };
    },
    callTool: async (name, args) => {
      calls.push({ name, args: args || {} });
      if (name === "deck_project_list") return { structuredContent: listReply };
      if (name === "deck_project_use") {
        useCalls.push(args || {});
        const hit = USE_OK[args && args.name];
        if (!hit) return { isError: true, content: [{ type: "text", text: "清单里没有这个名字。" }] };
        return { structuredContent: hit };
      }
      if (name === "deck_issue_list") return { structuredContent: { rows: [], revision: 1 } };
      if (name === "deck_issue_counts") return { structuredContent: { counts: { open: 0, closed: 0, total: 0 }, revision: 1 } };
      if (name === "deck_issue_list_labels") return { structuredContent: { labels: [], colors: {} } };
      throw new Error("no tool " + name);
    },
  };
  const win = { innerWidth: 900, innerHeight: 700, addEventListener() {}, removeEventListener() {} };
  const code = existsSync(BUNDLE) ? readFileSync(BUNDLE, "utf8") : "";
  new Function("window", "document", `"use strict";\n${code}`)(win, doc);
  const U = win.MattSkillsUpstream;
  bootedUpstream = U; // 留给文件末尾收尾(U 是块作用域的)
  await U.boot({ client, doc, fetchData: true });
  await flush();
  const surface = doc.body.children[0];
  const chipItem = (name) =>
    qsa(surface, "[data-deck-chip-item]").find((n) => n.getAttribute("data-name") === name) || null;
  return {
    U, doc, surface, sent, calls, useCalls,
    st: U.list.storeOf(),
    chipItem,
    chipBtn: () => qsa(surface, "[data-deck-chip]")[0] || null,
    openPop: async () => {
      if (!qsa(surface, "[data-deck-chip-pop]")[0]) {
        fireClick(qsa(surface, "[data-deck-chip]")[0]);
        await flush();
      }
    },
  };
}

const code = existsSync(BUNDLE) ? readFileSync(BUNDLE, "utf8") : "";
check("dist/ui/bundle-1.txt 存在", existsSync(BUNDLE));

// ---------------------------------------------------------------------------
// 切片 1:活动项目 ≠ home-repo —— 注入恰好一行前言,其余内容与原文一致
// ---------------------------------------------------------------------------
{
  const t = await bootInjectPanel(LIST_FORGE_ACTIVE);
  check("票05非home: store 已接驳", !!(t.st && t.st.snapshot));
  check("票05非home: st.injector 在(sendMessage 桥)", typeof t.st.injector === "function");
  t.st.injector("实施 #03 的修复");
  await flush();
  eq("票05非home: sendMessage 恰好一条", t.sent.length, 1);
  eq(
    "票05非home: 首行是项目前言,其余与原文一致",
    t.sent[0],
    "项目：forge（X:/forge）；以下操作都在该项目内进行。\n实施 #03 的修复"
  );
}

// ---------------------------------------------------------------------------
// 切片 2:活动项目是 home-repo —— 注入文本逐字一致,没有前言
// ---------------------------------------------------------------------------
{
  const t = await bootInjectPanel(LIST_HOME_ACTIVE);
  check("票05home: st.injector 在", typeof t.st.injector === "function");
  t.st.injector("实施 #03 的修复");
  await flush();
  eq("票05home: sendMessage 恰好一条", t.sent.length, 1);
  eq("票05home: 与原文逐字一致,无前言", t.sent[0], "实施 #03 的修复");
  check("票05home: 不含前言字样", !t.sent[0].includes("以下操作都在该项目内进行"));
}

// ---------------------------------------------------------------------------
// 切片 3:前言不叠加 —— 同一文本连点两次每次只前置一次;已带前言的文本不再二次前置
// ---------------------------------------------------------------------------
{
  const t = await bootInjectPanel(LIST_FORGE_ACTIVE);
  const line = "项目：forge（X:/forge）；以下操作都在该项目内进行。";
  t.st.injector("认领 04");
  t.st.injector("认领 04");
  await flush();
  eq("票05不叠加: 连点两次各发一条", t.sent.length, 2);
  eq("票05不叠加: 第一条只前置一次", t.sent[0], line + "\n认领 04");
  eq("票05不叠加: 第二条也只前置一次(没有叠成两行)", t.sent[1], line + "\n认领 04");
  // 已带前言的文本再进(重取/复注路径):不二次前置
  t.st.injector(line + "\n认领 04");
  await flush();
  eq("票05不叠加: 已带前言的文本原样放行", t.sent[2], line + "\n认领 04");
}

// ---------------------------------------------------------------------------
// 切片 4:其余文本与上游一致 —— 多行原文逐字保留(期望值 = 独立字面量,不依赖上游模板)
// ---------------------------------------------------------------------------
{
  const t = await bootInjectPanel(LIST_FORGE_ACTIVE);
  // 已知上游动作模板输出形状:多行 prompt(领取/实施档),此处用独立字面量代表任意上游文本
  const upstreamText = "请实施 m5-project-switch/05:动作 prompt 的项目前言\n状态:claimed\n仓库:X:/forge";
  t.st.injector(upstreamText);
  await flush();
  eq(
    "票05一致: 前言一行 + 多行原文逐字保留",
    t.sent[0],
    "项目：forge（X:/forge）；以下操作都在该项目内进行。\n请实施 m5-project-switch/05:动作 prompt 的项目前言\n状态:claimed\n仓库:X:/forge"
  );
}

// ---------------------------------------------------------------------------
// 切片 5:与 chip 同源 —— deck_project_use 切走/切回,前言跟着活动项目翻面
// ---------------------------------------------------------------------------
{
  const t = await bootInjectPanel(LIST_HOME_ACTIVE);
  t.st.injector("开局");
  await flush();
  eq("票05同源: 切前(home)无前言", t.sent[0], "开局");

  await t.openPop();
  const forge = t.chipItem("forge");
  check("票05同源: chip 展开层有 forge 项", !!forge);
  fireClick(forge);
  await flush();
  eq("票05同源: 发了 deck_project_use({name:forge})", t.useCalls, [{ name: "forge" }]);
  t.st.injector("切到 forge 后认领");
  await flush();
  eq(
    "票05同源: 切走后注入带 forge 前言",
    t.sent[1],
    "项目：forge（X:/forge）；以下操作都在该项目内进行。\n切到 forge 后认领"
  );

  await t.openPop();
  const home = t.chipItem("home");
  fireClick(home);
  await flush();
  eq("票05同源: 切回也发 deck_project_use({name:home})", t.useCalls[1], { name: "home" });
  t.st.injector("切回 home 后认领");
  await flush();
  eq("票05同源: 切回后逐字无前言", t.sent[2], "切回 home 后认领");
}

// ---------------------------------------------------------------------------
// 切片 6:内容缝 —— bundle 带前言包装(本仓补件,上游动作模板零改动)
// ---------------------------------------------------------------------------
if (code) {
  check("bundle 含前言话术(以下操作都在该项目内进行)", code.includes("以下操作都在该项目内进行。"));
  check("bundle 注入收口仍经 sendMessage", /st\.injector = function[\s\S]{0,200}clientRef\.sendMessage/.test(code));
}

if (failures > 0) {
  console.error(`\n${failures} 项失败`);
  process.exit(1);
}
console.log("\n全部通过");
// 0.6.1 起面板挂载后有一枚常驻定时器(清单状态刷新拍),事件循环不会自己清空。靴过面板的
// 进程要显式收尾才退得出去,否则这套会打着「全部通过」一直挂着,把整条测试链卡在这里。
if (bootedUpstream && bootedUpstream.projects && typeof bootedUpstream.projects.unmount === "function") bootedUpstream.projects.unmount();
process.exit(0);
