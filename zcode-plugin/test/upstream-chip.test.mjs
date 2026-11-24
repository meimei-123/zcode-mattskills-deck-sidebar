// 票 04 头部项目 chip 测试。
// 缝 = 对外可观察边界(面板 bundle 缝:fake DOM + stub client 回放 deck_project_list /
// deck_project_use;断言只打 DOM 可见状态与发出的 callTool 参数):
//   1) 内容缝:bundle 带 chip 挂点与工具缝(deck_project_list / deck_project_use /
//      refreshActiveProject 复用),无拼接残留、语法过;
//   2) 无清单(registry.status=missing):头部与现在完全一致 —— 无 chip、head 里只有标题 span;
//   3) 有清单:chip 显示活动项目名;展开层 home-repo 第一(data-home=true)、有效项目可点、
//      被跳过条目以 warning 行附在末尾(不可点、带原因);
//   4) 清单损坏:chip 挂警告态(dsws-pchip-warn),展开层顶部有错误说明,可用项只剩 home;
//   5) 点击有效项:发 deck_project_use({name});在途 chip 挂 dsws-pchip-busy 且禁点
//      (不叠第二发);成功后 chip 显示新活动项目、整体重取发车(看板 list/counts 重拉、
//      workspace 根重读、新 active 高亮);
//   6) 切换被拒(deck_project_use 回 isError):chip 不变、busy 退场、展开层人话错误行内可见;
//   7) 窄档:ResizeObserver 宽度压到 300 → chip 只留活动项目名(caret 与展开层根路径收掉),
//      放宽还原;
//   8) 切到非 home 项目后点检查页签:链按新项目根重取(stub 收到 deck_env_check,
//      快照落进 store —— ADR-0003「三页跟随」里检查页那一页的缝断言);
//   9) deck_project_list 失败(回包 isError/桥异常):警告态 chip 可见、展开层人话错误;
//      只有服务端明确 registry.status === "missing" 才隐藏。
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // zcode-plugin/
const BUNDLE = join(ROOT, "dist", "ui", "bundle-1.txt");

let failures = 0;
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
// fake DOM(照 upstream-versioncontrol 舱模式:类/属性/tag 选择器 + 冒泡 click)
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
    return c;
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

// fake ResizeObserver(宽度通道由测试派发)
const roInstances = [];
class FakeResizeObserver {
  constructor(cb) {
    this.cb = cb;
    this.targets = [];
    roInstances.push(this);
  }
  observe(el) {
    if (!this.targets.includes(el)) this.targets.push(el);
  }
  unobserve() {}
  disconnect() {
    this.targets.length = 0;
  }
}
const observersOf = (el) => roInstances.filter((r) => r.targets.includes(el));
function fireRO(el, width) {
  const list = observersOf(el).slice();
  for (const ro of list) ro.cb([{ target: el, contentRect: { width, height: 600 } }], ro);
  return list.length;
}

// ---------------------------------------------------------------------------
// 回放数据:deck_project_list / deck_project_use 的 structuredContent(server 端
// registryState 形状;路径/名字是回放值,逐字对应服务端契约)
// ---------------------------------------------------------------------------
const HOME = { name: "home", path: "X:/home", isHome: true };
const LIST_MISSING = {
  ok: true,
  active: { name: "home", path: "X:/home", isHome: true },
  home: HOME,
  projects: [{ ...HOME, valid: true }],
  warnings: [],
  registry: { status: "missing", path: "X:/home/.deck/projects.json", error: null },
};
const LIST_CLEAN = {
  ok: true,
  active: { name: "home", path: "X:/home", isHome: true },
  home: HOME,
  projects: [
    { ...HOME, valid: true },
    { name: "forge", path: "X:/forge", isHome: false, valid: true },
  ],
  warnings: [],
  registry: { status: "ok", path: "X:/home/.deck/projects.json", error: null },
};
const LIST_WITH_BAD = {
  ok: true,
  active: { name: "home", path: "X:/home", isHome: true },
  home: HOME,
  projects: [
    { ...HOME, valid: true },
    { name: "forge", path: "X:/forge", isHome: false, valid: true },
    { name: "bad", path: "X:/gone", isHome: false, valid: false, reason: "路径不存在" },
  ],
  warnings: ["第 3 条(bad)路径不存在,已跳过"],
  registry: { status: "ok", path: "X:/home/.deck/projects.json", error: null },
};
const LIST_BROKEN = {
  ok: true,
  active: { name: "home", path: "X:/home", isHome: true },
  home: HOME,
  projects: [{ ...HOME, valid: true }],
  warnings: [],
  registry: { status: "broken", path: "X:/home/.deck/projects.json", error: "JSON 解析失败:Unexpected token } in JSON" },
};
// 活动项目是非 home 项目、清单里有两条被跳过(票 02:修正入口免项目前言 + 跳过条目名并列)
const LIST_TWO_BAD_FORGE_ACTIVE = {
  ok: true,
  active: { name: "forge", path: "X:/forge", isHome: false },
  home: HOME,
  projects: [
    { ...HOME, valid: true },
    { name: "forge", path: "X:/forge", isHome: false, valid: true },
    { name: "bad", path: "X:/gone", isHome: false, valid: false, reason: "路径不存在" },
    { name: "dup", path: "X:/dup", isHome: false, valid: false, reason: "名字「dup」与已有项目重名" },
  ],
  warnings: ["第 3 条(bad)路径不存在,已跳过", "第 4 条(dup)名字「dup」与已有项目重名,已跳过"],
  registry: { status: "ok", path: "X:/home/.deck/projects.json", error: null },
};
const USE_OK_FORGE = {
  ok: true,
  active: { name: "forge", path: "X:/forge", isHome: false },
  home: HOME,
  projects: [
    { ...HOME, valid: true },
    { name: "forge", path: "X:/forge", isHome: false, valid: true },
  ],
  warnings: [],
  registry: { status: "ok", path: "X:/home/.deck/projects.json", error: null },
  note: null,
};
const USE_REJECTED = {
  isError: true,
  content: [
    {
      type: "text",
      text: "切换被拒:版本管理页还有未确认的危险 git 动作(预检签票未结)。请先在版本管理页确认执行,或取消后等票据过期(最多 120 秒),再切换项目。",
    },
  ],
};

// boot 助手:一份 bundle 代码 + 一份 fake DOM + 一份 stub client,回放面板所需工具。
async function bootChipPanel(listReply, opts = {}) {
  const intervalsAtBoot = intervals.length;
  const doc = createFakeDom();
  const state = { root: opts.root || "X:/home", list: listReply };
  const calls = [];
  const reads = [];
  const useCalls = [];
  const sent = []; // sendMessage 实参(票 02:清单入口发进对话的文本)
  let releaseUse = null;
  let holdList = false; // 票 02:把下一次 deck_project_list 的回包挂起,演「上一拍未回」
  let releaseList = null;
  const useMode = opts.useMode || "hold"; // hold=挂起等测试放行;reject=回 isError;ok=立即成功
  const client = {
    readResource: async (uri) => {
      reads.push({ uri, root: state.root });
      if (uri.endsWith("workspace.json")) return { contents: [{ text: JSON.stringify({ root: state.root, env: {} }) }] };
      throw new Error("no asset " + uri);
    },
    sendMessage: async (text) => {
      sent.push(String(text == null ? "" : text));
      return { ok: true };
    },
    callTool: async (name, args) => {
      calls.push({ name, args: args || {} });
      if (name === "deck_project_list") {
        if (opts.listMode === "error") {
          return { isError: true, content: [{ type: "text", text: "读取 .deck/projects.json 失败:权限被拒" }] };
        }
        if (opts.listMode === "throw") throw new Error("工具桥断了");
        if (holdList) {
          holdList = false;
          return new Promise((resolve) => {
            releaseList = resolve;
          });
        }
        return { structuredContent: state.list };
      }
      if (name === "deck_project_use") {
        useCalls.push(args || {});
        if (useMode === "reject") return USE_REJECTED;
        if (useMode === "ok") {
          state.root = "X:/forge";
          return { structuredContent: USE_OK_FORGE };
        }
        return new Promise((resolve) => {
          releaseUse = resolve;
        });
      }
      // deck_env_check 照 upstream-checks 套件的 stub 形状回一份最小链快照(切片 8 用;
      // 其余切片不点检查页,不受影响)
      if (name === "deck_env_check") {
        return {
          structuredContent: {
            ok: true,
            snapshot: { steps: [], currentIndex: 0, failedIndex: -1, doneCount: 0, applicableCount: 0, totalCount: 0, chainState: "done", version: "1" },
            checkedAt: "2026-11-21T00:00:00.000Z",
          },
        };
      }
      if (name === "deck_issue_list") return { structuredContent: { rows: [], revision: 1 } };
      if (name === "deck_issue_counts") return { structuredContent: { counts: { open: 0, closed: 0, total: 0 }, revision: 1 } };
      if (name === "deck_issue_list_labels") return { structuredContent: { labels: [], colors: {} } };
      throw new Error("no tool " + name);
    },
  };
  const win = { innerWidth: 900, innerHeight: 700, addEventListener() {}, removeEventListener() {} };
  new Function("window", "document", `"use strict";\n${code}`)(win, doc);
  const U = win.MattSkillsUpstream;
  await U.boot({ client, doc, fetchData: true });
  await flush();
  const surface = doc.body.children[0];
  return {
    U, doc, surface, calls, reads, useCalls, sent, state,
    st: U.list.storeOf(),
    chip: () => qsa(surface, "[data-deck-chip]")[0] || null,
    entry: () => qsa(surface, "[data-deck-chip-entry]")[0] || null,
    fix: () => qsa(surface, "[data-deck-chip-fix]")[0] || null,
    chipName: () => {
      const n = qsa(surface, "[data-deck-chip-name]")[0];
      return n ? textOf(n) : null;
    },
    pop: () => qsa(surface, "[data-deck-chip-pop]")[0] || null,
    items: () => qsa(surface, "[data-deck-chip-item]"),
    itemOf: (name) => qsa(surface, "[data-deck-chip-item]").find((n) => n.getAttribute("data-name") === name) || null,
    openPop: async () => {
      fireClick(qsa(surface, "[data-deck-chip]")[0]);
      await flush();
    },
    releaseUse: (reply) => {
      const r = releaseUse;
      releaseUse = null;
      if (r) r(reply);
    },
    holdNextList: () => {
      holdList = true;
    },
    releaseList: () => {
      const r = releaseList;
      releaseList = null;
      if (r) r({ structuredContent: state.list });
    },
    listCalls: () => calls.filter((c) => c.name === "deck_project_list"),
    intervalsAtBoot,
    // 本面板的清单刷新拍(只认 boot 之后注册的)
    curChipTick: () => tickSince(intervalsAtBoot),
    fireChipTick: async () => {
      const rec = tickSince(intervalsAtBoot);
      if (rec) rec.fire();
      await flush();
    },
  };
}

// ---------------------------------------------------------------------------
// 票 02:清单状态刷新拍 —— boot 前把全局 setInterval/clearInterval 换成可控桩(照
// upstream-checks 舱模式)。桩记下每一次注册;fire() 遵循浏览器语义,已清除的拍不再派发回调。
// ---------------------------------------------------------------------------
const intervals = [];
let intervalSeq = 0;
globalThis.setInterval = function (fn, ms) {
  const rec = {
    id: ++intervalSeq,
    ms,
    cleared: false,
    fire() {
      if (!rec.cleared) return fn();
      return undefined;
    },
  };
  intervals.push(rec);
  return rec.id;
};
globalThis.clearInterval = function (id) {
  const rec = intervals.find((r) => r.id === id);
  if (rec) rec.cleared = true;
};
// intervals 是整个文件共享的累积数组:每个切片各 boot 一只新面板,旧面板的 effect 从不收尾,它们
// 注册的拍都还「没被清」。所以认拍只认本面板 boot 之后注册的 —— 按节奏全表找会认到前面切片
// 留下的检查页可见拍(同为 5000ms),把检查重扫当成清单重取,或者反过来。
const tickSince = (from) => intervals.slice(from).filter((r) => r.ms === 5000 && !r.cleared).slice(-1)[0] || null;

// ---------------------------------------------------------------------------
// 切片 1:内容缝 —— chip 挂点与工具缝在 bundle 里
// ---------------------------------------------------------------------------
const code = existsSync(BUNDLE) ? readFileSync(BUNDLE, "utf8") : "";
check("dist/ui/bundle-1.txt 存在", existsSync(BUNDLE));
if (code) {
  const has = (name, re) => check(`bundle 含 ${name}`, re.test(code));
  has("chip 挂点(data-deck-chip)", /data-deck-chip/);
  has("chip 数据缝 deck_project_list", /callTool\(["']deck_project_list["']/);
  has("chip 切换缝 deck_project_use", /callTool\(["']deck_project_use["']/);
  has("清单入口(data-deck-chip-entry)", /data-deck-chip-entry/);
  has("修正入口(data-deck-chip-fix)", /data-deck-chip-fix/);
  has("清单入口的首行技能名 /setup-home-repo", /\/setup-home-repo/);
  check("bundle 没有 .deck 文件监听(无 FileSystemObserver)", !/FileSystemObserver/.test(code));
  has("切换成功走整体重取 refreshActiveProject", /refreshActiveProject\(\)/);
  check("bundle 无拼接标记残留", !/\(spliced by build\)/.test(code));
  check("bundle 无锚点残留", !/@splice-anchor/.test(code));
  try {
    new vm.Script(code);
    check("bundle 语法过(vm.Script)", true);
  } catch (e) {
    check("bundle 语法过(vm.Script)", false, e.message);
  }
}
globalThis.ResizeObserver = FakeResizeObserver;

// ---------------------------------------------------------------------------
// 切片 2:无清单 —— 没有 chip,chip 位置换成清单入口(票 02 起:头部不再与上游逐字一致,
// 0.6.1 规格「面板入口」;head 里 span 数不变靠入口文案是裸文本节点保住)。入口的发话、
// 在途与窄档见切片 10–13。
// ---------------------------------------------------------------------------
{
  const t = await bootChipPanel(LIST_MISSING);
  check("票04缺清单: 面板照常渲染(store 在)", !!(t.st && t.st.snapshot));
  check("票04缺清单: 无 chip", !t.chip(), t.chip() && textOf(t.chip()));
  const head = qsa(t.surface, ".dsws-head")[0];
  check("票04缺清单: 头部在", !!head);
  const entry = t.entry();
  check("票02入口: 无清单时 chip 位置有清单入口(data-deck-chip-entry)", !!entry);
  check("票02入口: 是 button(可聚焦可点)", !!entry && entry.tagName === "BUTTON");
  eq("票02入口: 文案是「＋ 项目」", entry ? textOf(entry) : null, "＋ 项目");
  eq("票02入口: title 是全文案", entry ? entry.getAttribute("title") : null, "＋ 项目");
  eq("票02入口: aria-label 是全文案", entry ? entry.getAttribute("aria-label") : null, "＋ 项目");
  check(
    "票02入口: 低强调度(挂 dsws-pchipentry,不挂警告态)",
    !!entry && String(entry.attributes["class"]).includes("dsws-pchipentry") && !String(entry.attributes["class"]).includes("dsws-pchip-warn"),
    entry && entry.attributes["class"]
  );
  check("票02入口: 落在 chip 的位置(与 chip 同一个 data-deck-chip-wrap)", !!entry && !!entry.parentNode && entry.parentNode.getAttribute("data-deck-chip-wrap") === "");
  check("票02入口: 平时可点(未禁用、不在途)", !!entry && entry.attributes.disabled === undefined && !String(entry.attributes["class"]).includes("dsws-pchip-busy"));
  eq("票04缺清单: head 子元素是标题与清单入口两件(0.6.0 时为只有标题一件)", head ? head.children.length : -1, 2);
  check("票04缺清单: 标题仍是 head 的第一件", !!head && head.children[0] === qsa(head, ".dsws-mtitle")[0]);
  eq("票04缺清单: head 里 span 数不变", qsa(head || t.surface, "span").length, 1);
  check("票04缺清单: 页签行照常", qsa(t.surface, ".dsws-tabs").length === 1);
  check("票02入口: 入口不在页签行里(不挤占页签行)", qsa(qsa(t.surface, ".dsws-tabs")[0] || t.surface, "[data-deck-chip-entry]").length === 0);
  check("票04缺清单: 启动取过一次清单", t.calls.some((c) => c.name === "deck_project_list"));
}

// ---------------------------------------------------------------------------
// 切片 3:有清单(含坏条目)—— chip 显示活动项目名;展开层 home 第一、有效项可点、坏条目 warning 附末尾
// ---------------------------------------------------------------------------
{
  const t = await bootChipPanel(LIST_WITH_BAD);
  const chip = t.chip();
  check("票04有清单: chip 在", !!chip);
  check("票02入口: 有清单时入口不渲染(头部只有 chip)", !t.entry());
  check("票04有清单: 是 button 语义(可 Tab 聚焦)", chip && chip.tagName === "BUTTON");
  eq("票04有清单: chip 显示活动项目名 home", t.chipName(), "home");
  check("票04有清单: 有被跳过条目 → 警告态", chip && String(chip.attributes["class"]).includes("dsws-pchip-warn"));
  check("票04有清单: 平时展开层收起", !t.pop());

  await t.openPop();
  const pop = t.pop();
  check("票04有清单: 点 chip 出展开层", !!pop);
  const items = t.items();
  eq("票04有清单: 有效项两枚(home + forge)", items.length, 2);
  eq("票04有清单: home-repo 第一", items[0] && items[0].getAttribute("data-name"), "home");
  eq("票04有清单: home 带 isHome 标记", items[0] && items[0].getAttribute("data-home"), "true");
  eq("票04有清单: 第二项是 forge", items[1] && items[1].getAttribute("data-name"), "forge");
  const warns = qsa(pop, "[data-deck-chip-warnrow]");
  eq("票04有清单: 坏条目 warning 行一枚", warns.length, 1);
  check("票04有清单: warning 行带原因(路径不存在)", warns[0] && textOf(warns[0]).includes("路径不存在"));
  check("票04有清单: warning 行仍附在全部可点项之后(pop 倒数第二个子节点;0.6.0 时为最后一个)", pop && warns[0] === pop.children[pop.children.length - 2]);
  check("票04有清单: 坏条目不是可点项(没有 data-name=bad 的 item)", !t.itemOf("bad"));
  check("票04有清单: 当前活动项 home 带高亮标记", items[0] && String(items[0].attributes["class"]).includes("dsws-pchip-active") && textOf(items[0]).includes("✓"));
  check("票04有清单: 宽档展开项带根路径", qsa(pop, "[data-deck-chip-path]").length >= 2);

  // 展开层可再点收起
  fireClick(t.chip());
  await flush();
  check("票04有清单: 再点 chip 收起展开层", !t.pop());
}

// ---------------------------------------------------------------------------
// 切片 4:清单损坏 —— chip 警告态仍可展开看到错误说明,可用项只剩 home
// ---------------------------------------------------------------------------
{
  const t = await bootChipPanel(LIST_BROKEN);
  const chip = t.chip();
  check("票04损坏: chip 在(清单存在但坏了也显示)", !!chip);
  check("票02入口: 清单损坏时头部没有入口(修正入口在展开层里)", !t.entry());
  check("票04损坏: 警告态(dsws-pchip-warn)", chip && String(chip.attributes["class"]).includes("dsws-pchip-warn"));
  eq("票04损坏: 活动项目回退显示 home", t.chipName(), "home");
  await t.openPop();
  const pop = t.pop();
  const errs = qsa(pop, "[data-deck-chip-error]");
  check("票04损坏: 展开层有错误说明", errs.length >= 1 && textOf(errs[0]).includes("JSON 解析失败"), errs.length && textOf(errs[0]));
  eq("票04损坏: 可点项只剩 home", t.items().length, 1);
  eq("票04损坏: 没有 warning 行(broken 只有整份错误)", qsa(pop, "[data-deck-chip-warnrow]").length, 0);
}

// ---------------------------------------------------------------------------
// 切片 5:点击有效项切换 —— 发 deck_project_use({name});在途加载态;成功后整体重取
// ---------------------------------------------------------------------------
{
  const t = await bootChipPanel(LIST_CLEAN);
  const chip = t.chip();
  check("票04切换: chip 在且无警告态", !!chip && !String(chip.attributes["class"]).includes("dsws-pchip-warn"));
  check("票02入口: 干净清单没有入口", !t.entry());
  await t.openPop();
  eq("票04切换: 干净清单两枚可点项", t.items().length, 2);
  check("票02修正: 清单完好无警告时展开层没有修正入口", !t.fix());

  const listCallsBefore = t.calls.filter((c) => c.name === "deck_issue_list").length;
  const readsBefore = t.reads.length;
  fireClick(t.itemOf("forge"));
  await flush();
  eq("票04切换: 发 deck_project_use 且 name=forge", t.useCalls, [{ name: "forge" }]);
  check("票04切换: 在途挂加载态(dsws-pchip-busy)", t.chip() && String(t.chip().attributes["class"]).includes("dsws-pchip-busy"));
  eq("票04切换: 在途 aria-busy=true", t.chip() && t.chip().getAttribute("aria-busy"), "true");

  // 在途禁点:再点同一项与 chip 本体都不叠第二发
  fireClick(t.itemOf("forge"));
  fireClick(t.chip());
  await flush();
  eq("票04切换: 在途点击不叠发(useCalls 仍 1)", t.useCalls.length, 1);
  check("票04切换: 在途点击不展开/收起错乱(popover 仍在)", !!t.pop());

  // 放行成功回包:服务端活动根已翻到 forge(workspace.json 跟着回新根)
  t.state.root = "X:/forge";
  t.releaseUse({ structuredContent: USE_OK_FORGE });
  await flush();
  eq("票04切换: 完成后 chip 显示新活动项目 forge", t.chipName(), "forge");
  check("票04切换: 加载态退场", t.chip() && !String(t.chip().attributes["class"]).includes("dsws-pchip-busy"));
  eq("票04切换: aria-busy 复位", t.chip() && t.chip().getAttribute("aria-busy"), "false");
  check(
    "票04切换: 整体重取发车(list 在 use 之后重拉)",
    t.calls.filter((c) => c.name === "deck_issue_list").length === listCallsBefore + 1,
    JSON.stringify(t.calls.map((c) => c.name))
  );
  check("票04切换: 计数也重拉(counts 在 use 之后)", t.calls.some((c) => c.name === "deck_issue_counts"));
  check("票04切换: workspace 根重读且是新根", t.reads.length === readsBefore + 1 && t.reads[t.reads.length - 1].root === "X:/forge", JSON.stringify(t.reads));
  eq("票04切换: store cwd 跟到新项目", t.st.cwd, "X:/forge");
  const forgeItem = t.itemOf("forge");
  check("票04切换: 展开层新活动项高亮(✓ forge)", forgeItem && String(forgeItem.attributes["class"]).includes("dsws-pchip-active") && textOf(forgeItem).includes("✓"));
  check("票04切换: 旧活动项高亮已摘", t.itemOf("home") && !String(t.itemOf("home").attributes["class"]).includes("dsws-pchip-active"));

  // ---- 窄档(切片 7,复用同一舱):chip 只留名字,caret 与展开层根路径收掉 ----
  const panel = qsa(t.surface, ".dsws-panel")[0];
  check("票04窄档: 面板根被 ResizeObserver 观察", observersOf(panel).length >= 1);
  fireRO(panel, 300);
  await flush();
  check("票04窄档: 面板根挂 dsws-narrow", panel && String(panel.attributes["class"]).includes("dsws-narrow"));
  check("票04窄档: chip 仍在", !!t.chip());
  eq("票04窄档: 只显示活动项目名", t.chipName(), "forge");
  eq("票04窄档: caret 收掉", qsa(t.surface, "[data-deck-chip-caret]").length, 0);
  check("票04窄档: 展开层项仍在(名字可点)", t.items().length === 2);
  eq("票04窄档: 展开层根路径收掉", qsa(t.surface, "[data-deck-chip-path]").length, 0);
  check("票04窄档: 页签行不受挤占(四枚页签仍在)", walk(t.surface).filter((n) => /^panel\.tab\./.test(String(n.attributes["data-log"] || ""))).length === 4);
  fireRO(panel, 800);
  await flush();
  eq("票04窄档: 放宽还原 caret(数量 1)", qsa(t.surface, "[data-deck-chip-caret]").length, 1);
  eq("票04窄档: 放宽还原根路径", qsa(t.surface, "[data-deck-chip-path]").length, 2);
}

// ---------------------------------------------------------------------------
// 切片 6:切换被拒 —— chip 不变、busy 退场、展开层人话错误可见
// ---------------------------------------------------------------------------
{
  const t = await bootChipPanel(LIST_CLEAN, { useMode: "reject" });
  await t.openPop();
  fireClick(t.itemOf("forge"));
  await flush();
  eq("票04拒绝: 发过一次 deck_project_use", t.useCalls.length, 1);
  eq("票04拒绝: chip 仍显示原活动项目", t.chipName(), "home");
  check("票04拒绝: 加载态退场", t.chip() && !String(t.chip().attributes["class"]).includes("dsws-pchip-busy"));
  const pop = t.pop();
  const errs = pop ? qsa(pop, "[data-deck-chip-error]") : [];
  check("票04拒绝: 展开层人话错误(危险动作被拒)", errs.length >= 1 && textOf(errs[errs.length - 1]).includes("未确认的危险 git 动作"), errs.length && textOf(errs[errs.length - 1]));
  const listCalls = t.calls.filter((c) => c.name === "deck_issue_list").length;
  eq("票04拒绝: 被拒不触发整体重取(list 不重拉)", listCalls, 1);
}

// ---------------------------------------------------------------------------
// 切片 8:切换到非 home 项目后,检查页路径重取 —— 链按活动项目根重组(ADR-0003
// 「列表、版本管理、环境检查三页跟随」里检查页那一页的面板缝断言):切到 forge
// 后点检查页签,stub 收到 deck_env_check 且链快照落进 store。
// ---------------------------------------------------------------------------
{
  const t = await bootChipPanel(LIST_CLEAN, { useMode: "ok" });
  await t.openPop();
  fireClick(t.itemOf("forge"));
  await flush();
  eq("票04检查页跟随: 切到 forge 后 chip 显示 forge", t.chipName(), "forge");
  const envCalls = () => t.calls.filter((c) => c.name === "deck_env_check");
  eq("票04检查页跟随: 切换本身不发链取数", envCalls().length, 0);
  const checksBtn = walk(t.surface).filter((n) => n.attributes["data-log"] === "panel.tab.checks" && n.tagName === "BUTTON")[0];
  check("票04检查页跟随: 检查页签按钮在", !!checksBtn);
  fireClick(checksBtn);
  await flush();
  eq("票04检查页跟随: 检查页发车一次 deck_env_check", envCalls().length, 1);
  check("票04检查页跟随: 链快照落进 store(重取被触发)", !!(t.st.chainSnapshot && Array.isArray(t.st.chainSnapshot.steps)), JSON.stringify(t.st.chainSnapshot));
}

// ---------------------------------------------------------------------------
// 切片 9:deck_project_list 失败 —— 警告态 chip 可见(人话错误在展开层),只有
// 服务端明确 registry.status === "missing"(这个工作区没有清单)才隐藏。
// ---------------------------------------------------------------------------
{
  const t = await bootChipPanel(LIST_CLEAN, { listMode: "error" });
  const chip = t.chip();
  check("票04清单失败: 回包 isError 时 chip 可见(不再静默隐藏)", !!chip);
  check("票04清单失败: 警告态(dsws-pchip-warn)", chip && String(chip.attributes["class"]).includes("dsws-pchip-warn"));
  eq("票04清单失败: 活动项目身份未到手时显示占位", t.chipName(), "未知");
  await t.openPop();
  const pop = t.pop();
  const errs = pop ? qsa(pop, "[data-deck-chip-error]") : [];
  check("票04清单失败: 展开层人话错误(读取失败+原因)", errs.length >= 1 && textOf(errs[0]).includes("项目清单读取失败") && textOf(errs[0]).includes("权限被拒"), errs.length ? textOf(errs[0]) : "无错误行");
  eq("票04清单失败: 没有可点项目(清单没到手)", t.items().length, 0);

  const t2 = await bootChipPanel(LIST_CLEAN, { listMode: "throw" });
  const chip2 = t2.chip();
  check("票04清单失败: 桥异常时 chip 同样可见警告态", !!chip2 && String(chip2.attributes["class"]).includes("dsws-pchip-warn"));
  await t2.openPop();
  const errs2 = t2.pop() ? qsa(t2.pop(), "[data-deck-chip-error]") : [];
  check("票04清单失败: 桥异常的原因也上墙", errs2.length >= 1 && textOf(errs2[0]).includes("工具桥断了"), errs2.length ? textOf(errs2[0]) : "无错误行");

  const t3 = await bootChipPanel(LIST_MISSING);
  check("票04清单失败: registry 明确 missing 才隐藏 chip", !t3.chip());
}

// ---------------------------------------------------------------------------
// 切片 10(票 02):点入口 → 发进对话的文本。首行是技能名 /setup-home-repo,其后带工作区根、
// 清单路径与现状;活动项目是 home-repo,不带项目前言。期望值是独立字面量(照 0.6.1 规格
// 「面板入口」一节写,不从实现抄)。
// ---------------------------------------------------------------------------
{
  const t = await bootChipPanel(LIST_MISSING);
  fireClick(t.entry());
  await flush();
  eq("票02发话: 点入口恰好发一条", t.sent.length, 1);
  eq(
    "票02发话: 全文 = 首行技能名 + 工作区根 + 清单路径 + 现状(尚不存在) + 先给候选表等确认 + 验证到 warnings 为空",
    t.sent[0],
    "/setup-home-repo\n工作区根：X:/home\n清单路径：X:/home/.deck/projects.json\n现状：清单尚不存在。\n先给一张候选项目表等我确认，确认之后再写清单文件；写完用 deck_project_list 验证，直到 warnings 为空。"
  );
  eq("票02发话: 首行是 /setup-home-repo", (t.sent[0] || "").split("\n")[0], "/setup-home-repo");
  check("票02发话: 不带项目前言", !(t.sent[0] || "").includes("以下操作都在该项目内进行"));
}

// ---------------------------------------------------------------------------
// 切片 11(票 02):修正入口 —— 清单损坏、warnings 非空两种情况下,展开层末行有
// 「让 agent 修正清单」,发与头部入口同一段 prompt(只有现状一行不同)。活动项目是非 home
// 项目时,修正入口的话不带项目前言(它改的是 home-repo 的清单,不是那个项目);同一状态下
// 普通动作照旧带前言。
// ---------------------------------------------------------------------------
const entryPrompt = (state) =>
  [
    "/setup-home-repo",
    "工作区根：X:/home",
    "清单路径：X:/home/.deck/projects.json",
    "现状：" + state,
    "先给一张候选项目表等我确认，确认之后再写清单文件；写完用 deck_project_list 验证，直到 warnings 为空。",
  ].join("\n");
{
  // 清单损坏
  const t = await bootChipPanel(LIST_BROKEN);
  check("票02修正: 损坏时修正入口不常驻(收在展开层里)", !t.fix());
  await t.openPop();
  const fix = t.fix();
  check("票02修正: 清单损坏 → 展开层有修正入口(data-deck-chip-fix)", !!fix);
  check("票02修正: 是 button", !!fix && fix.tagName === "BUTTON");
  eq("票02修正: 文案是「让 agent 修正清单」", fix ? textOf(fix) : null, "让 agent 修正清单");
  check("票02修正: 在展开层末行(pop 最后一个子节点,错误说明之后)", !!fix && fix === t.pop().children[t.pop().children.length - 1]);
  fireClick(fix);
  await flush();
  eq("票02修正: 损坏时发话恰好一条", t.sent.length, 1);
  eq("票02修正: 损坏时全文(现状 = 已损坏并附解析错误)", t.sent[0], entryPrompt("清单已损坏，解析错误是「JSON 解析失败:Unexpected token } in JSON」。"));
}
{
  // warnings 非空,活动项目是 home-repo
  const t = await bootChipPanel(LIST_WITH_BAD);
  await t.openPop();
  const warns = qsa(t.pop(), "[data-deck-chip-warnrow]");
  check("票02修正: 有跳过条目 → 展开层有修正入口", !!t.fix());
  check("票02修正: 修正入口排在 warning 行之后", warns.length === 1 && !!t.fix() && warns[0].parentNode === t.fix().parentNode && warns[0].nextSibling === t.fix());
  fireClick(t.fix());
  await flush();
  eq("票02修正: 有跳过条目时全文(现状 = 有几条被跳过并附条目名)", t.sent[0], entryPrompt("清单里有 1 条被跳过：bad。"));
}
{
  // warnings 非空,活动项目是非 home 项目:修正入口免前言,普通动作仍带前言
  const t = await bootChipPanel(LIST_TWO_BAD_FORGE_ACTIVE);
  await t.openPop();
  fireClick(t.fix());
  await flush();
  eq("票02修正: 非home活动时首行仍是 /setup-home-repo", (t.sent[0] || "").split("\n")[0], "/setup-home-repo");
  check("票02修正: 非home活动时不带项目前言", !(t.sent[0] || "").includes("以下操作都在该项目内进行"), t.sent[0]);
  eq("票02修正: 两条被跳过时全文(条目名并列)", t.sent[0], entryPrompt("清单里有 2 条被跳过：bad、dup。"));
  t.st.injector("认领 04");
  await flush();
  eq("票02修正: 同一状态下普通动作照旧带项目前言", t.sent[1], "项目：forge（X:/forge）；以下操作都在该项目内进行。\n认领 04");
}

// ---------------------------------------------------------------------------
// 切片 12(票 02):清单状态的自动感知 —— 清单状态跟着一条刷新拍重取,每拍至多一次
// deck_project_list。本仓面板没有看板周期刷新可挂(旧层的 counts 轮询随 U06 删除),所以
// 清单状态自成一拍;面板只认 deck_project_list 的回包,不为 .deck 加文件监听。清单落盘 → chip
// 冒出来,清单被删 → 入口回来,清单损坏 → 修正入口出现,都不用重开面板。
// ---------------------------------------------------------------------------
{
  const t = await bootChipPanel(LIST_MISSING);
  eq("票02刷新: 面板起来那一次清单读取", t.listCalls().length, 1);
  const tick = t.curChipTick();
  check("票02刷新: 面板挂载即注册清单刷新拍(5000ms)", !!tick && tick.ms === 5000, JSON.stringify(intervals.slice(t.intervalsAtBoot).map((r) => ({ ms: r.ms, cleared: r.cleared }))));
  check("票02刷新: (前置)本切片 boot 之前已经有别的面板留下的 5000ms 拍 —— 认拍必须按 boot 之后来", t.intervalsAtBoot > 0, String(t.intervalsAtBoot));
  eq("票02刷新: 没到拍不重取", t.listCalls().length, 1);

  // 这一拍不挑页签
  const tabBtn = (id) => walk(t.surface).filter((n) => n.attributes["data-log"] === "panel.tab." + id && n.tagName === "BUTTON")[0];
  fireClick(tabBtn("skills"));
  await flush();
  check("票02刷新: 这一拍不挑页签(切到技能页仍在)", !!(tick && !tick.cleared && t.curChipTick() === tick));
  fireClick(tabBtn("list"));
  await flush();

  // 清单落盘:stub 的回包从 missing 变 ok;下一拍之前面板照旧
  t.state.list = LIST_CLEAN;
  check("票02刷新: 清单落盘后、下一拍之前,头部还是入口", !!t.entry() && !t.chip());
  eq("票02刷新: 落盘本身不触发读取(面板不监听 .deck)", t.listCalls().length, 1);
  await t.fireChipTick();
  eq("票02刷新: 一拍恰好一次 deck_project_list", t.listCalls().length, 2);
  check("票02刷新: 清单出现后 chip 冒出来", !!t.chip() && t.chipName() === "home");
  check("票02刷新: 入口同时消失", !t.entry());
  check("票02刷新: 冒出来的 chip 平时收起", !t.pop());

  // 展开着、清单没变、过了一拍:展开层不该自己收起(用户正看着项目列表)。收起只发生在
  // 清单身份变了的时候(出现/被删/损坏),见下。
  await t.openPop();
  check("票02刷新: (前置)chip 展开着", !!t.pop());
  await t.fireChipTick();
  check("票02刷新: 清单没变时展开层不会自己收起", !!t.pop());
  await t.fireChipTick();
  check("票02刷新: 连过两拍展开层仍然开着", !!t.pop());

  // 展开着的 chip:清单被删 → chip 消失、入口回来;清单再出现时不会自己弹开
  check("票02刷新: (前置)chip 已展开", !!t.pop());
  t.state.list = LIST_MISSING;
  await t.fireChipTick();
  check("票02刷新: 清单被删后 chip 消失", !t.chip());
  check("票02刷新: 清单被删后入口回来", !!t.entry() && textOf(t.entry()) === "＋ 项目");
  t.state.list = LIST_BROKEN;
  await t.fireChipTick();
  check("票02刷新: chip 再出现时是收起的(展开态不跨清单留存)", !!t.chip() && !t.pop());
  await t.openPop();
  check("票02刷新: 清单损坏后展开层出现修正入口", !!t.fix());

  // 页面隐藏:这一拍不取;回可见照常
  const before = t.listCalls().length;
  t.doc.visibilityState = "hidden";
  await t.fireChipTick();
  eq("票02刷新: 页面隐藏时这一拍不取", t.listCalls().length, before);
  t.doc.visibilityState = "visible";
  await t.fireChipTick();
  eq("票02刷新: 页面回可见后照常取", t.listCalls().length, before + 1);
}
{
  // 上一拍没回:后续拍不叠发
  const t = await bootChipPanel(LIST_MISSING);
  t.holdNextList();
  await t.fireChipTick(); // 这一拍的读取挂起未回
  await t.fireChipTick();
  await t.fireChipTick();
  eq("票02刷新: 上一拍未回时后续拍不叠发(一个周期内至多一次)", t.listCalls().length, 2);
  t.releaseList();
  await flush();
  await t.fireChipTick();
  eq("票02刷新: 上一拍落定后下一拍照常取", t.listCalls().length, 3);
}
{
  // 点击在途不叠发:点了入口之后、这一拍刷新落定之前,再点不发;放行后能再点
  const t = await bootChipPanel(LIST_MISSING);
  const clickAgain = async () => {
    fireClick(t.entry());
    await flush();
  };
  await clickAgain();
  eq("票02在途: 第一次点击发一条", t.sent.length, 1);
  const entry = t.entry();
  check("票02在途: 点击后入口进入在途(挂 dsws-pchip-busy)", !!entry && String(entry.attributes["class"]).includes("dsws-pchip-busy"), entry && entry.attributes["class"]);
  eq("票02在途: 点击后入口禁点", entry ? entry.attributes.disabled : null, "true");
  eq("票02在途: aria-busy 置真", entry ? entry.getAttribute("aria-busy") : null, "true");
  await clickAgain();
  await clickAgain();
  eq("票02在途: 刷新落定前连点不叠发", t.sent.length, 1);
  // 点入口时相位重新对齐:旧的那一枚拍被清掉,新的一枚从点击起算
  // 只数本面板 boot 之后注册的(intervals 是全文件共享的累积数组,见 tickSince)
  const mine = intervals.slice(t.intervalsAtBoot);
  const live = mine.filter((r) => r.ms === 5000 && !r.cleared);
  eq("票02在途: 点击后在跑的 5000ms 拍只有一枚(旧的已清)", live.length, 1);
  eq("票02在途: 点击确实重新挂了拍(注册数 2 = boot 一枚 + 点击一枚)", mine.filter((r) => r.ms === 5000).length, 2);
  await t.fireChipTick();
  eq("票02在途: 这一拍落定后放行(入口不再在途)", t.entry() ? t.entry().attributes.disabled : "gone", undefined);
  check("票02在途: 放行后不挂在途样式", !!t.entry() && !String(t.entry().attributes["class"]).includes("dsws-pchip-busy"));
  await clickAgain();
  eq("票02在途: 放行后能再点", t.sent.length, 2);
}
{
  // 发送失败:没有请求在路上,立刻放行
  const t = await bootChipPanel(LIST_MISSING);
  t.st.injector = function () { return Promise.reject(new Error("桥断了")); };
  await flush();
  fireClick(t.entry());
  await flush();
  await flush();
  eq("票02在途: 发送失败后入口已放行", t.entry() ? t.entry().attributes.disabled : "gone", undefined);
  check("票02在途: 发送失败后不挂在途样式", !!t.entry() && !String(t.entry().attributes["class"]).includes("dsws-pchip-busy"));
}
{
  // 修正入口与头部入口是同一个在途口径
  const t = await bootChipPanel(LIST_BROKEN);
  await t.openPop();
  fireClick(t.fix());
  await flush();
  eq("票02在途: 修正入口点击发一条", t.sent.length, 1);
  eq("票02在途: 修正入口随后禁点", t.fix() ? t.fix().attributes.disabled : null, "true");
  fireClick(t.fix());
  await flush();
  eq("票02在途: 修正入口在途不叠发", t.sent.length, 1);
}
{
  // 在途的修正入口 × 切项目:点了修正入口之后、那一拍到来之前,用户又点了展开层里的项目。
  // 切项目在途时刷新拍整拍跳过,在途入口等的那次「落定」就不会来;切完之后入口必须自己
  // 放行,不能一直禁点到面板卸载。
  const t = await bootChipPanel(LIST_TWO_BAD_FORGE_ACTIVE);
  t.state.root = "X:/forge";
  await t.openPop();
  fireClick(t.fix());
  await flush();
  eq("票02在途×切换: (前置)修正入口点击发一条", t.sent.length, 1);
  eq("票02在途×切换: (前置)修正入口在途", t.fix() ? t.fix().attributes.disabled : null, "true");
  fireClick(t.itemOf("home")); // 切项目,deck_project_use 挂起(stub 默认 hold)
  await flush();
  check("票02在途×切换: (前置)切项目在途", !!t.chip() && String(t.chip().attributes["class"]).includes("dsws-pchip-busy"), t.chip() && t.chip().attributes["class"]);
  await t.fireChipTick(); // 切换在途:这一拍整拍跳过
  t.state.root = "X:/home";
  t.state.list = { ...LIST_TWO_BAD_FORGE_ACTIVE, active: { ...HOME }, note: null };
  t.releaseUse({ structuredContent: { ...LIST_TWO_BAD_FORGE_ACTIVE, active: { ...HOME }, note: null } });
  await flush();
  await flush();
  eq("票02在途×切换: 切换完成后 chip 是 home", t.chipName(), "home");
  eq("票02在途×切换: 切换完成后修正入口已放行(没有一直禁点)", t.fix() ? t.fix().attributes.disabled : null, undefined);
  fireClick(t.fix());
  await flush();
  eq("票02在途×切换: 放行后修正入口能再点", t.sent.length, 2);
}

// ---------------------------------------------------------------------------
// 切片 13(票 02):回退跟随 —— 刷新拍发现活动项目根变了(清单被手改,当前项目被移出),
// 面板跟着整体重取,并把说明亮出来。只换 chip 不换看板会出现「chip 显示 home、列表还是
// 旧项目的卡」,此时点写操作服务端已按 home 解析,会落到 home 的同号卡上。
// ---------------------------------------------------------------------------
const LIST_FORGE_ACTIVE = {
  ok: true,
  active: { name: "forge", path: "X:/forge", isHome: false },
  home: HOME,
  projects: [
    { ...HOME, valid: true },
    { name: "forge", path: "X:/forge", isHome: false, valid: true },
  ],
  warnings: [],
  registry: { status: "ok", path: "X:/home/.deck/projects.json", error: null },
  note: null,
};
{
  // 变体一:这一拍自己触发落定,服务端在回包里带了说明
  const t = await bootChipPanel(LIST_FORGE_ACTIVE, { root: "X:/forge" });
  eq("票02回退: (前置)活动项目是 forge", t.chipName(), "forge");
  eq("票02回退: (前置)面板的工作区根是 forge", t.st.workspaceRoot, "X:/forge");
  const listCallsBefore = t.calls.filter((c) => c.name === "deck_issue_list").length;
  t.state.root = "X:/home"; // workspace.json 资源的 root 现算为活动项目根,跟着回 home
  t.state.list = {
    ...LIST_CLEAN,
    projects: [{ ...HOME, valid: true }], // forge 被从清单里删掉了
    note: "活动项目「forge」已不在项目清单里(被移出或改名),回退到 home-repo。",
  };
  await t.fireChipTick();
  eq("票02回退: chip 换成 home", t.chipName(), "home");
  eq("票02回退: 面板的工作区根跟回 home", t.st.workspaceRoot, "X:/home");
  check("票02回退: 看板数据整体重取(deck_issue_list 再取了一次)",
    t.calls.filter((c) => c.name === "deck_issue_list").length === listCallsBefore + 1,
    JSON.stringify({ before: listCallsBefore, after: t.calls.filter((c) => c.name === "deck_issue_list").length }));
  check("票02回退: 说明自动打开展开层(不悄悄换项目)", !!t.pop());
  const errs = qsa(t.pop() || t.surface, "[data-deck-chip-error]");
  check("票02回退: 展开层里有说明", errs.length === 1 && textOf(errs[0]).includes("已不在项目清单里"), errs.map(textOf).join(" | "));
  // 说明只在这一刻有效:之后的清单回包是正常的(没有回退),再过一拍说明就该撤。
  // 否则每 5 秒的刷新拍都带着一句过期的「已回退」,挂到用户切换一次项目为止。
  t.state.list = { ...LIST_CLEAN, projects: [{ ...HOME, valid: true }], note: null };
  await t.fireChipTick();
  check("票02回退: 下一拍清单正常后说明撤掉", !qsa(t.surface, "[data-deck-chip-error]").some((n) => textOf(n).includes("已不在项目清单里")),
    qsa(t.surface, "[data-deck-chip-error]").map(textOf).join(" | "));
  eq("票02回退: 说明撤掉后 chip 仍是 home(没有跟着变)", t.chipName(), "home");
}
{
  // 变体二:说明已被别的调用带走(agent 改完清单后按技能收尾先调过 deck_project_list),
  // 这一拍只看到根变了、note 为空;上一个项目已不在清单里 → 面板用自己知道的事实说
  const t = await bootChipPanel(LIST_FORGE_ACTIVE, { root: "X:/forge" });
  t.state.root = "X:/home";
  t.state.list = { ...LIST_CLEAN, projects: [{ ...HOME, valid: true }], note: null };
  await t.fireChipTick();
  eq("票02回退: note 为空时 chip 同样换回 home", t.chipName(), "home");
  check("票02回退: note 为空时仍给出说明(上一个项目已不在清单里)", !!t.pop() && textOf(qsa(t.pop(), "[data-deck-chip-error]")[0] || {}).includes("已不在项目清单里"));
}
{
  // 变体三:根没变(清单内容变了、活动项目没动)→ 不重取看板、不说明
  const t = await bootChipPanel(LIST_FORGE_ACTIVE, { root: "X:/forge" });
  const listCallsBefore = t.calls.filter((c) => c.name === "deck_issue_list").length;
  t.state.list = LIST_TWO_BAD_FORGE_ACTIVE; // 多了两条被跳过的,活动项目仍是 forge
  await t.fireChipTick();
  eq("票02回退: 根没变时 chip 仍是 forge", t.chipName(), "forge");
  eq("票02回退: 根没变时不重取看板", t.calls.filter((c) => c.name === "deck_issue_list").length, listCallsBefore);
  check("票02回退: 根没变时展开层没有回退说明", !qsa(t.surface, "[data-deck-chip-error]").some((n) => textOf(n).includes("回退")));
}
{
  // 变体四:清单整份坏掉 → 说明用清单读不出来那句
  const t = await bootChipPanel(LIST_FORGE_ACTIVE, { root: "X:/forge" });
  t.state.root = "X:/home";
  t.state.list = { ...LIST_BROKEN, note: null };
  await t.fireChipTick();
  eq("票02回退: 清单损坏时 chip 换回 home", t.chipName(), "home");
  const errs = qsa(t.pop() || t.surface, "[data-deck-chip-error]");
  check("票02回退: 清单损坏时说明点名清单读不出来", errs.some((n) => textOf(n).includes("项目清单读不出来")), errs.map(textOf).join(" | "));
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
