// 票 07 后端 chip 测试(0.7.0 GitHub 后端)。
// 缝 = 面板 bundle 缝:读 dist/ui/bundle-1.txt 求值 + 假 DOM + 假 client;断言只打
// DOM 可见状态、发进对话的文本与 callTool 的参数/次数。
// 覆盖:
//   1) 内容缝:后端 chip / deck_backend_use / deck_env_check / 展开层挂点在 bundle 里;
//   2) chip 四态:默认 markdown、提示(hint)、警告(五种原因)、在途;
//   3) 点选切换:发 deck_backend_use;成功后整体重取、清导航与详情缓存;被拒原因留在展开层;
//   4) 「让 agent 写进锚文件」:首行点明目标文件与标题行;
//   5) 清单回包的 backend 变了才重取,没变不重取;
//   6) 刷新拍:GitHub 每拍一次计数 + 一次检查块;在途不叠发;隐藏不取;回可见先强制探测;
//   7) 电话:列表带游标/不传页大小;详情不再并取整张列表;评论带游标与条数;写键不补零;
//   8) 注入前言:GitHub 项目恰好多一行,home 只有后端行;
//   9) 首屏取数失败:面板照常起、chip 警告态、列表区有原因;
//  10) 本地 markdown 回归:KPI/列表/详情键补零与 0.6.1 一致。
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // zcode-plugin/
const BUNDLE = join(ROOT, "dist", "ui", "bundle-1.txt");

let failures = 0;
let checks = 0;
function check(name, cond, detail = "") {
  checks++;
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
// fake DOM(与 upstream-chip 同款:类/属性/tag 选择器 + 冒泡 click + Preact props 通道)
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
    value: "",
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
  node.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 320, height: 40 });
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
      layer = layer.flatMap((n) => walk(n).filter((c) => c !== n && c.nodeType === 1));
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
  // visibilitychange 可派发(前台强制探测用)
  const docListeners = {};
  doc.addEventListener = (t, fn) => {
    (docListeners[t] = docListeners[t] || []).push(fn);
  };
  doc.removeEventListener = (t, fn) => {
    const a = docListeners[t] || [];
    const i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  };
  doc.__fireVisibility = () => {
    for (const fn of (docListeners.visibilitychange || []).slice()) fn({ type: "visibilitychange" });
  };
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
/** 受控输入(与 upstream-detail 同款:先改值再派发;Preact 内部事件键形如 inputfalse)。 */
function fireInput(node, value) {
  node.value = value;
  const props = (node && (node.l || node._)) || {};
  const direct = props.onInput || props.oninput || props.onChange || props.onchange;
  if (typeof direct === "function") {
    direct.call(node, { type: "Input", currentTarget: node, target: node, stopPropagation() {}, preventDefault() {} });
    return true;
  }
  for (const k of Object.keys(props)) {
    const lower = k.toLowerCase();
    if ((lower.startsWith("oninput") || lower.startsWith("onchange") || lower.startsWith("input") || lower.startsWith("change")) && typeof props[k] === "function") {
      props[k].call(node, { type: "input", currentTarget: node, target: node, stopPropagation() {}, preventDefault() {} });
      return true;
    }
  }
  return false;
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const flush = async () => {
  await tick();
  await tick();
  await settle(60);
};

// 可控定时器(清单状态刷新拍):fire() 遵循浏览器语义,已清除的拍不再派发
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
const tickSince = (from) => intervals.slice(from).filter((r) => r.ms === 5000 && !r.cleared).slice(-1)[0] || null;

// 假 ResizeObserver(窄档:面板根挂上后由测试派发宽度;与 upstream-chip 同款)
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
globalThis.ResizeObserver = FakeResizeObserver;
const observersOf = (el) => roInstances.filter((r) => r.targets.includes(el));
function fireRO(el, width) {
  const list = observersOf(el).slice();
  for (const ro of list) ro.cb([{ target: el, contentRect: { width, height: 600 } }], ro);
  return list.length;
}

const code = existsSync(BUNDLE) ? readFileSync(BUNDLE, "utf8") : "";
check("dist/ui/bundle-1.txt 存在", existsSync(BUNDLE));

// ---------------------------------------------------------------------------
// 切片 1:内容缝
// ---------------------------------------------------------------------------
if (code) {
  const has = (name, re) => check(`bundle 含 ${name}`, re.test(code));
  has("后端 chip 挂点(data-deck-backend-chip)", /data-deck-backend-chip/);
  has("后端展开层(data-deck-backend-pop)", /data-deck-backend-pop/);
  has("切换缝 deck_backend_use", /callTool\(["']deck_backend_use["']/);
  has("检查块 deck_env_check", /callTool\(["']deck_env_check["']/);
  has("锚文件动作(data-deck-backend-anchor)", /data-deck-backend-anchor/);
  has("去环境检查(data-deck-backend-checks)", /data-deck-backend-checks/);
  has("切换错误行(data-deck-backend-error)", /data-deck-backend-error/);
  has("四态样式类(dsws-bchip-warn)", /dsws-bchip-warn/);
  has("四态样式类(dsws-bchip-busy)", /dsws-bchip-busy/);
  has("四态样式类(dsws-bchip-hint)", /dsws-bchip-hint/);
  has("基础样式复用(后端 chip 与项目 chip 同一套按钮底)", /\[data-deck-chip\],\[data-deck-backend-chip\]\{display:inline-flex/);
  has("锚文件标题行(issue tracker: GitHub)", /# Issue tracker: GitHub/);
  check("bundle 无拼接标记残留", !/\(spliced by build\)/.test(code));
  check("bundle 无锚点残留", !/@splice-anchor/.test(code));
  try {
    new vm.Script(code);
    check("bundle 语法过(vm.Script)", true);
  } catch (e) {
    check("bundle 语法过(vm.Script)", false, e.message);
  }
}

// ---------------------------------------------------------------------------
// 回放数据:deck_project_list / deck_project_use 的 structuredContent
// ---------------------------------------------------------------------------
const HOME = { name: "home", path: "X:/home", isHome: true };
const MD_DEFAULT = { id: "markdown", source: "default", repo: null, writable: null, hint: null };
const MD_HINT = { id: "markdown", source: "default", repo: null, writable: null, hint: "项目远端是 GitHub,可以切到 GitHub 议题" };
const GH_ANCHOR = { id: "github", source: "anchor", repo: { name: "owner/name", url: "https://github.com/owner/name" }, writable: true, hint: null };
const GH_READONLY = { id: "github", source: "anchor", repo: { name: "owner/name", url: "https://github.com/owner/name" }, writable: false, hint: null };
const GH_NO_REPO = { id: "github", source: "anchor", repo: null, writable: null, hint: null };
const GH_SESSION = { id: "github", source: "session", repo: { name: "owner/name", url: "https://github.com/owner/name" }, writable: null, hint: null };
const listOf = (backend, opts = {}) => {
  const home = opts.activeHome !== false;
  const active = home
    ? { name: "home", path: "X:/home", isHome: true, backend }
    : { name: "forge", path: "X:/forge", isHome: false, backend };
  return {
    ok: true,
    active,
    home: HOME,
    projects: [HOME, { name: "forge", path: "X:/forge", isHome: false, valid: true }],
    warnings: [],
    registry: { status: "ok", path: "X:/home/.deck/projects.json", error: null },
  };
};
const GH_ROWS = [
  { key: "12", effortId: "", type: "issue", title: "GitHub 的一张票", state: "open", labels: [{ name: "bug", color: "d73a4a" }], assignees: [{ login: "octocat", kind: "user" }], parentKey: null, blockedBy: [], url: "https://github.com/owner/name/issues/12", commentCount: 60 },
  { key: "13", effortId: "", type: "issue", title: "另一张", state: "open", labels: [], assignees: [], parentKey: null, blockedBy: [], url: "https://github.com/owner/name/issues/13" },
];
const MD_ROWS = [
  { key: "01", effortId: "demo", type: "issue", title: "本地第一张", state: "open", labels: [], assignees: [], parentKey: null, blockedBy: [] },
  { key: "02", effortId: "demo", type: "issue", title: "本地第二张", state: "closed", labels: [], assignees: [], parentKey: null, blockedBy: [] },
];
const emptySnapshot = () => ({ steps: [], currentIndex: 0, failedIndex: -1, doneCount: 0, applicableCount: 0, totalCount: 0, chainState: "done", version: "1", isComplete: true });
const envSnapshotOf = (checkId, desc) => ({
  steps: [{ id: checkId, status: "fail", show: { fallback: checkId, desc }, actions: [], blockedBy: null }],
  currentIndex: 0,
  failedIndex: 0,
  doneCount: 0,
  applicableCount: 7,
  totalCount: 7,
  chainState: "hasCurrent",
  blockingCheck: checkId,
  hasBlockingFailure: true,
  isComplete: false,
  version: "1",
});
const countsOfRows = (rows) => {
  const tickets = rows.filter((r) => r.type !== "map" && r.type !== "spec");
  const open = tickets.filter((r) => r.state === "open").length;
  const closed = tickets.filter((r) => r.state === "closed").length;
  return { open, closed, total: tickets.length };
};

// ---------------------------------------------------------------------------
// boot 助手:一份 bundle + 一份 fake DOM + 一份假 client
// ---------------------------------------------------------------------------
async function bootPanel(opts = {}) {
  const intervalsAtBoot = intervals.length;
  const doc = createFakeDom();
  const sent = [];
  const calls = [];
  const useCalls = [];
  const getCalls = [];
  const commentCalls = [];
  const envCalls = [];
  const state = {
    root: opts.root || "X:/home",
    projectReply: opts.projectList || (() => listOf(opts.backend || MD_DEFAULT)),
    rows: opts.rows || [],
    pageRows: opts.pageRows || opts.rows || [],
    nextCursor: opts.nextCursor === undefined ? null : opts.nextCursor,
    total: opts.total,
    revision: opts.revision === undefined ? 1 : opts.revision,
    partial: opts.partial === true,
    counts: opts.counts || null,
    listThrow: opts.listThrow || "",
    listError: opts.listError || "",
    env: opts.env || null,
    envError: opts.envError || "",
    useMode: opts.useMode || "ok",
    useReply: opts.useReply || null,
    useRoot: opts.useRoot || "",
    getError: opts.getError || "",
    getPage: opts.getPage || null,
    holdCounts: false,
  };
  state.releaseCounts = null;
  let releaseUse = null;

  const countsNow = () => state.counts || countsOfRows(state.rows);
  const client = {
    readResource: async (uri) => {
      if (uri.endsWith("workspace.json")) return { contents: [{ text: JSON.stringify({ root: state.root, env: {} }) }] };
      throw new Error("no asset " + uri);
    },
    sendMessage: async (text) => {
      sent.push(String(text == null ? "" : text));
      return { ok: true };
    },
    callTool: async (name, args) => {
      const a = args && typeof args === "object" ? args : {};
      calls.push({ name, args: a });
      if (name === "deck_project_list") return { structuredContent: state.projectReply() };
      if (name === "deck_issue_list") {
        if (state.listThrow) throw new Error(state.listThrow);
        if (state.listError) return { isError: true, content: [{ type: "text", text: state.listError }] };
        // 分页分支由「cursor 参数在不在」决定(与 server 同口径)
        if (Object.prototype.hasOwnProperty.call(a, "cursor")) {
          return {
            structuredContent: {
              rows: state.pageRows,
              nextCursor: state.nextCursor,
              total: state.total === undefined ? state.pageRows.length : state.total,
              revision: state.revision,
              counts: countsOfRows(state.pageRows),
              partial: false,
              empty: false,
              units: [],
            },
          };
        }
        return {
          structuredContent: {
            rows: state.rows,
            revision: state.revision,
            counts: countsOfRows(state.rows),
            partial: state.partial,
            empty: false,
            units: [],
          },
        };
      }
      if (name === "deck_issue_counts") {
        if (state.holdCounts) {
          state.holdCounts = false;
          return new Promise((resolve) => {
            state.releaseCounts = resolve;
          });
        }
        return { structuredContent: { counts: countsNow(), revision: state.revision } };
      }
      if (name === "deck_issue_list_labels") return { structuredContent: { labels: [], colors: {} } };
      if (name === "deck_env_check") {
        envCalls.push(a);
        if (state.envError) return { isError: true, content: [{ type: "text", text: state.envError }] };
        return { structuredContent: { ok: true, snapshot: state.env || emptySnapshot(), checkedAt: "2026-11-26T00:00:00.000Z" } };
      }
      if (name === "deck_backend_use") {
        useCalls.push(a);
        if (state.useMode === "reject") {
          return { isError: true, content: [{ type: "text", text: "切换被拒:找不到 gh 可执行文件(没装 GitHub CLI,或没在 PATH 里)。" }] };
        }
        if (state.useMode === "hold") {
          return new Promise((resolve) => {
            releaseUse = resolve;
          });
        }
        if (state.useRoot) state.root = state.useRoot;
        return { structuredContent: state.useReply };
      }
      if (name === "deck_issue_get") {
        getCalls.push(a);
        if (state.getError) return { isError: true, content: [{ type: "text", text: state.getError }] };
        const key = String(a.key || "");
        const after = typeof a.commentsAfter === "string" ? a.commentsAfter : "";
        if (typeof state.getPage === "function") {
          const page = state.getPage(key, after, a);
          return { structuredContent: { workspaceRoot: state.root, card: page.card, commentsPage: page.pageInfo } };
        }
        // 默认:从行面拼一张卡(无评论)
        const row = state.rows.find((r) => String(r.key) === key) || { key, effortId: "", type: "issue", title: "票 " + key, state: "open", labels: [], blockedBy: [] };
        const card = Object.assign({}, row, { body: "正文 " + key, comments: [] });
        return { structuredContent: { workspaceRoot: state.root, card, commentsPage: { hasNextPage: false, endCursor: "0" } } };
      }
      if (name === "deck_issue_comment") {
        commentCalls.push(a);
        return { structuredContent: { ok: true, comment: { author: { login: "panel" }, body: a.body, createdAt: "2026-11-26T00:00:00.000Z" } } };
      }
      throw new Error("no tool " + name);
    },
  };
  const win = { innerWidth: 900, innerHeight: 700, addEventListener() {}, removeEventListener() {} };
  new Function("window", "document", `"use strict";\n${code}`)(win, doc);
  const U = win.MattSkillsUpstream;
  await U.boot({ client, doc, fetchData: true });
  await flush();
  await flush();
  const surface = doc.body.children[0];
  const q = (sel) => qsa(surface, sel);
  const t = {
    U,
    doc,
    surface,
    sent,
    calls,
    useCalls,
    getCalls,
    commentCalls,
    envCalls,
    state,
    st: U.list.storeOf(),
    chip: () => q("[data-deck-backend-chip]")[0] || null,
    pop: () => q("[data-deck-backend-pop]")[0] || null,
    item: (id) => q("[data-deck-backend-item]").find((n) => n.getAttribute("data-id") === id) || null,
    items: () => q("[data-deck-backend-item]"),
    anchor: () => q("[data-deck-backend-anchor]")[0] || null,
    checksBtn: () => q("[data-deck-backend-checks]")[0] || null,
    errRow: () => q("[data-deck-backend-error]")[0] || null,
    warnRow: () => q("[data-deck-backend-warnrow]")[0] || null,
    hintRow: () => q("[data-deck-backend-hintrow]")[0] || null,
    chipText: () => {
      const n = t.chip() ? qsa(t.chip(), "[data-deck-backend-name]")[0] : null;
      return n ? textOf(n) : null;
    },
    open: async () => {
      fireClick(t.chip());
      await flush();
    },
    fireTick: async () => {
      const rec = tickSince(intervalsAtBoot);
      if (rec) rec.fire();
      await flush();
    },
    releaseUse: (reply) => {
      const r = releaseUse;
      releaseUse = null;
      if (r) r(reply);
    },
    releaseCounts: (reply) => {
      const r = state.releaseCounts;
      state.releaseCounts = null;
      if (r) r(reply || { structuredContent: { counts: countsNow(), revision: state.revision } });
    },
    listCalls: () => calls.filter((c) => c.name === "deck_issue_list"),
    countsCalls: () => calls.filter((c) => c.name === "deck_issue_counts"),
    intervalsAtBoot,
  };
  return t;
}

// ---------------------------------------------------------------------------
// 切片 2:chip 四态 —— 默认 markdown / 提示 / 警告(五种) / 在途
// ---------------------------------------------------------------------------
{
  const t = await bootPanel({ projectList: () => listOf(MD_DEFAULT), rows: MD_ROWS });
  const chip = t.chip();
  check("chip: 默认 markdown 显示「本地 Markdown」", !!chip && t.chipText() === "本地 Markdown", t.chipText());
  check("chip: 普通态不挂 warn/hint/busy", !!chip && !/dsws-bchip-(warn|hint|busy)/.test(String(chip.attributes["class"])), chip && chip.attributes["class"]);
  check("chip: 是 button(可聚焦可点)", !!chip && chip.tagName === "BUTTON");
  await t.open();
  const pop = t.pop();
  check("chip: 点开出展开层(data-deck-backend-pop)", !!pop);
  eq("chip: 展开层两行(本地 Markdown + GitHub)", t.items().length, 2);
  const mdItem = t.item("markdown");
  const ghItem = t.item("github");
  check("chip: 当前项 markdown 打勾并高亮", !!mdItem && String(mdItem.attributes["class"]).includes("dsws-pchip-active") && textOf(mdItem).includes("✓"));
  check("chip: 另一项 GitHub 不打勾", !!ghItem && !String(ghItem.attributes["class"]).includes("dsws-pchip-active"));
  check("chip: 默认 markdown 没有「写进锚文件」动作", !t.anchor());

  // 窄档:文案收成「本地」,仍可开展开层并点项
  const panel = qsa(t.surface, ".dsws-panel")[0];
  check("chip 窄档: 面板根被 ResizeObserver 观察", observersOf(panel).length >= 1);
  fireRO(panel, 300);
  await flush();
  eq("chip 窄档: 文案收成「本地」", t.chipText(), "本地");
  check("chip 窄档: caret 收掉", qsa(t.surface, "[data-deck-backend-caret]").length === 0);
  check("chip 窄档: chip 仍在且可点", !!t.chip() && t.chip().attributes.disabled === undefined);
  eq("chip 窄档: 展开层仍开着且两项可点", t.items().length, 2);
  fireClick(t.chip());
  await flush();
  check("chip 窄档: 再点收起", !t.pop());
  fireClick(t.chip());
  await flush();
  eq("chip 窄档: 收起后仍可点开", t.items().length, 2);
  fireRO(panel, 800);
  await flush();
  eq("chip 窄档: 放宽还原文案", t.chipText(), "本地 Markdown");
}
{
  // GitHub 行:仓库短名 + 可写 / 只读
  const t = await bootPanel({ projectList: () => listOf(GH_ANCHOR), rows: GH_ROWS });
  await t.open();
  const repoLine = t.item("github") ? qsa(t.item("github"), "[data-deck-backend-repo]")[0] : null;
  check("chip 展开层: GitHub 行显示 owner/name 与「可写」", !!repoLine && textOf(repoLine).includes("owner/name") && textOf(repoLine).includes("可写"), repoLine && textOf(repoLine));
}
{
  const t = await bootPanel({ projectList: () => listOf(GH_READONLY), rows: GH_ROWS });
  await t.open();
  const repoLine = t.item("github") ? qsa(t.item("github"), "[data-deck-backend-repo]")[0] : null;
  check("chip 展开层: writable=false 显示「只读」", !!repoLine && textOf(repoLine).includes("只读"), repoLine && textOf(repoLine));
}
{
  const t = await bootPanel({ projectList: () => listOf(MD_HINT), rows: MD_ROWS });
  const chip = t.chip();
  check("chip 提示态: 远端在 GitHub 时挂 dsws-bchip-hint", !!chip && String(chip.attributes["class"]).includes("dsws-bchip-hint"), chip && chip.attributes["class"]);
  await t.open();
  check("chip 提示态: 展开层写提示句", !!t.hintRow() && textOf(t.hintRow()).includes("项目远端是 GitHub"), t.hintRow() && textOf(t.hintRow()));
}
{
  const t = await bootPanel({ projectList: () => listOf(GH_NO_REPO), rows: GH_ROWS });
  const chip = t.chip();
  check("chip 警告态: 没有关联仓库 → dsws-bchip-warn", !!chip && String(chip.attributes["class"]).includes("dsws-bchip-warn"), chip && chip.attributes["class"]);
  eq("chip 警告态: 文案仍是 GitHub", t.chipText(), "GitHub");
  await t.open();
  check("chip 警告态: 展开层原因「没有关联仓库」", !!t.warnRow() && textOf(t.warnRow()).includes("没有关联仓库"), t.warnRow() && textOf(t.warnRow()));
}
{
  const t = await bootPanel({ projectList: () => listOf(GH_ANCHOR), rows: GH_ROWS, env: envSnapshotOf("gh:installed", "找不到 gh 可执行文件") });
  const chip = t.chip();
  check("chip 警告态: gh:installed → dsws-bchip-warn", !!chip && String(chip.attributes["class"]).includes("dsws-bchip-warn"));
  await t.open();
  check("chip 警告态: 展开层「没装 gh」", !!t.warnRow() && textOf(t.warnRow()).includes("没装 gh"), t.warnRow() && textOf(t.warnRow()));
  check("chip 警告态: 展开层有「去环境检查」按钮", !!t.checksBtn() && textOf(t.checksBtn()).includes("去环境检查"));
  fireClick(t.checksBtn());
  await flush();
  eq("chip 警告态: 去环境检查切到检查页", t.st.tab, "checks");
}
{
  const t = await bootPanel({ projectList: () => listOf(GH_ANCHOR), rows: GH_ROWS, env: envSnapshotOf("gh:authed", "GitHub CLI 没登录") });
  await t.open();
  check("chip 警告态: gh:authed → 「没登录」", !!t.warnRow() && textOf(t.warnRow()).includes("没登录"), t.warnRow() && textOf(t.warnRow()));
}
{
  const t = await bootPanel({ projectList: () => listOf(GH_ANCHOR), rows: GH_ROWS, env: envSnapshotOf("gh:repoAccess", "GitHub 上找不到这个仓库(地址不对,或当前账号没有访问权限)") });
  await t.open();
  const txt = t.warnRow() ? textOf(t.warnRow()) : "";
  check("chip 警告态: gh:repoAccess → 「仓库访问不到」+该步原因", txt.includes("仓库访问不到") && txt.includes("找不到这个仓库"), txt);
}
{
  const t = await bootPanel({ projectList: () => listOf(GH_ANCHOR), rows: GH_ROWS, envError: "环境检查工具桥断了" });
  await t.open();
  check("chip 警告态: 检查块取数失败也进警告(原因可见)", !!t.warnRow() && textOf(t.warnRow()).includes("环境检查工具桥断了"), t.warnRow() && textOf(t.warnRow()));
}
{
  // 在途:切后端期间 chip 挂 busy、禁点
  const t = await bootPanel({ projectList: () => listOf(MD_DEFAULT), rows: GH_ROWS, useMode: "hold" });
  await t.open();
  fireClick(t.item("github"));
  await flush();
  const chip = t.chip();
  check("chip 在途态: 切换中转 dsws-bchip-busy", !!chip && String(chip.attributes["class"]).includes("dsws-bchip-busy"), chip && chip.attributes["class"]);
  eq("chip 在途态: aria-busy 为真", chip && chip.getAttribute("aria-busy"), "true");
  t.releaseUse({ structuredContent: listOf(GH_ANCHOR) });
  await flush();
}

// ---------------------------------------------------------------------------
// 切片 3:点选切换 —— 发 deck_backend_use;成功后整体重取、清导航与详情缓存
// ---------------------------------------------------------------------------
{
  const t = await bootPanel({ projectList: () => listOf(MD_DEFAULT), rows: GH_ROWS, useMode: "hold" });
  // 先摆出「用户正看着一张票」的现场(走上游动作,把详情自带的取数先跑完),再量切换带来的重取
  t.U.list.rowHelpers.setActiveIssue(t.st, 12, "");
  t.st.issueDetail = { number: 12, title: "旧详情" };
  t.st.navStack = [{ kind: "issue", n: 12, effortId: "" }];
  await flush();
  const listsBefore = t.listCalls().length;
  const countsBefore = t.countsCalls().length;
  await t.open();
  fireClick(t.item("github"));
  await flush();
  eq("切换: 发 deck_backend_use({backend:'github'})", t.useCalls, [{ backend: "github" }]);
  check("切换: 在途期间 chip 禁点(busy)", !!t.chip() && String(t.chip().attributes["class"]).includes("dsws-bchip-busy"));
  // 回包:后端已翻成 GitHub(与 deck_project_list 同一份形状)
  t.state.projectReply = () => listOf(GH_ANCHOR);
  t.releaseUse({ structuredContent: listOf(GH_ANCHOR) });
  await flush();
  await flush();
  eq("切换: 成功后 chip 显示 GitHub", t.chipText(), "GitHub");
  check("切换: 加载态退场", !!t.chip() && !String(t.chip().attributes["class"]).includes("dsws-bchip-busy"));
  check("切换: 整体重取(deck_issue_list 再拉一次)", t.listCalls().length === listsBefore + 1, `${listsBefore} → ${t.listCalls().length}`);
  check("切换: 不走 deck_project_use(切后端不是切项目)", !t.calls.some((c) => c.name === "deck_project_use"));
  check("切换: 计数也重拉", t.countsCalls().length > countsBefore);
  eq("切换: 导航栈清空", t.st.navStack, []);
  eq("切换: 详情缓存清空", t.st.issueDetail, null);
  eq("切换: 当前票清空", t.st.activeIssue, null);
}
{
  // 被拒:原因留在展开层,chip 与数据不变
  const t = await bootPanel({ projectList: () => listOf(MD_DEFAULT), rows: GH_ROWS, useMode: "reject" });
  await t.open();
  fireClick(t.item("github"));
  await flush();
  eq("切换被拒: 发过一次 deck_backend_use", t.useCalls.length, 1);
  eq("切换被拒: chip 仍是本地 Markdown", t.chipText(), "本地 Markdown");
  check("切换被拒: 展开层出现 data-deck-backend-error", !!t.errRow());
  check("切换被拒: 原因行是服务端人话", !!t.errRow() && textOf(t.errRow()).includes("找不到 gh 可执行文件"), t.errRow() && textOf(t.errRow()));
  check("切换被拒: 加载态退场", !!t.chip() && !String(t.chip().attributes["class"]).includes("dsws-bchip-busy"));
}

// ---------------------------------------------------------------------------
// 切片 4:「让 agent 写进锚文件」——首行点明目标文件与标题行
// ---------------------------------------------------------------------------
{
  const t = await bootPanel({ projectList: () => listOf(GH_SESSION), rows: GH_ROWS });
  await t.open();
  const anchor = t.anchor();
  check("锚文件动作: 手选生效时有「让 agent 写进锚文件」", !!anchor && textOf(anchor).includes("写进锚文件"), anchor && textOf(anchor));
  fireClick(anchor);
  await flush();
  eq("锚文件动作: 恰好发一条进对话", t.sent.length, 1);
  const first = (t.sent[0] || "").split("\n")[0];
  check("锚文件动作: 首行含 <项目根>/docs/agents/issue-tracker.md", first.includes("X:/home/docs/agents/issue-tracker.md"), first);
  check("锚文件动作: 首行含要写的标题行 # Issue tracker: GitHub", first.includes("# Issue tracker: GitHub"), first);
  check("锚文件动作: 正文提到只认一级标题与 deck_project_list 验证", (t.sent[0] || "").includes("一级标题") && (t.sent[0] || "").includes("deck_project_list"), t.sent[0]);
}

// ---------------------------------------------------------------------------
// 切片 5:清单回包驱动 —— backend 变了才重取,没变不重取
// ---------------------------------------------------------------------------
{
  const t = await bootPanel({ projectList: () => listOf(MD_DEFAULT), rows: GH_ROWS });
  eq("清单跟随: (前置)启动是本地 Markdown", t.chipText(), "本地 Markdown");
  const listsAfterBoot = t.listCalls().length;
  t.state.projectReply = () => listOf(GH_ANCHOR);
  await t.fireTick();
  eq("清单跟随: backend 从 markdown 变 github → chip 翻成 GitHub", t.chipText(), "GitHub");
  check("清单跟随: 后端变了才整体重取(deck_issue_list +1)", t.listCalls().length === listsAfterBoot + 1, `${listsAfterBoot} → ${t.listCalls().length}`);
  const listsAfterChange = t.listCalls().length;
  await t.fireTick();
  await t.fireTick();
  eq("清单跟随: backend 没变 → 不重取(两拍 deck_issue_list 不变)", t.listCalls().length, listsAfterChange);
}

// ---------------------------------------------------------------------------
// 切片 6:刷新拍 —— GitHub 每拍计数 + 检查块;在途不叠发;隐藏不取;回可见强制探测
// ---------------------------------------------------------------------------
{
  const t = await bootPanel({ projectList: () => listOf(GH_ANCHOR), rows: GH_ROWS });
  const countsBefore = t.countsCalls().length;
  const envBefore = t.envCalls.length;
  await t.fireTick();
  eq("刷新拍: GitHub 每拍读一次计数", t.countsCalls().length, countsBefore + 1);
  eq("刷新拍: 每拍额外拉一次检查块(不带 force)", t.envCalls.length, envBefore + 1);
  eq("刷新拍: 检查块请求不带 force(走服务端缓存)", t.envCalls[t.envCalls.length - 1], {});
}
{
  // 在途不叠发:第一次 counts 挂起,再触发一拍不发第二发
  const t = await bootPanel({ projectList: () => listOf(GH_ANCHOR), rows: GH_ROWS });
  const countsBefore = t.countsCalls().length;
  t.state.holdCounts = true;
  await t.fireTick();
  const held = t.countsCalls().length;
  eq("刷新拍: (前置)第一拍 counts 发出并挂起", held, countsBefore + 1);
  await t.fireTick();
  await t.fireTick();
  eq("刷新拍: 上一拍未回时后续拍不叠发 counts", t.countsCalls().length, held);
  t.releaseCounts();
  await flush();
}
{
  const t = await bootPanel({ projectList: () => listOf(GH_ANCHOR), rows: GH_ROWS });
  // 隐藏:这一拍不取
  const before = t.countsCalls().length;
  t.doc.visibilityState = "hidden";
  await t.fireTick();
  eq("刷新拍: 页面隐藏时这一拍不取 counts", t.countsCalls().length, before);
  eq("刷新拍: 页面隐藏时也不拉检查块", t.envCalls.filter((a) => a && a.force === true).length, 0);
  // 回可见:先发带 force 的计数,再走一拍
  t.doc.visibilityState = "visible";
  t.doc.__fireVisibility();
  await flush();
  const after = t.countsCalls().slice(before);
  check("刷新拍: 转回可见先发一次计数", after.length >= 1, String(after.length));
  eq("刷新拍: 这一次带 force:true(跳过限速尽快补上)", after[0] && after[0].args, { force: true });
}

// ---------------------------------------------------------------------------
// 切片 6b:检查页 5 秒拍 —— 缓存优先(不带 force);只有「重新检查」才真重探
// 规格「环境检查」:这四步会出站,结果按探测间隔缓存;检查页的 5 秒拍读到的是缓存,
// 只有「重新检查」才真重探。实现口径:可见拍 chainEventRefresh(..., false)。
// ---------------------------------------------------------------------------
{
  const t = await bootPanel({ projectList: () => listOf(GH_ANCHOR), rows: GH_ROWS });
  // 切到检查页签 → 注册检查页可见拍(页签变化触发 effect 重挂,新拍排在清单拍之后)
  const tabBtn = walk(t.surface).find((n) => n.attributes["data-log"] === "panel.tab.checks" && n.tagName === "BUTTON");
  check("检查页拍: (前置)环境检查页签按钮在", !!tabBtn);
  if (tabBtn) fireClick(tabBtn);
  await flush();
  eq("检查页拍: (前置)st.tab = checks", t.st.tab, "checks");
  // 打开页签那一次链取数是缓存优先语义(不带 force)
  const envAtOpen = t.envCalls.length;
  check("检查页拍: 打开页签这一次不带 force", envAtOpen >= 1 && t.envCalls[envAtOpen - 1].force !== true, JSON.stringify(t.envCalls[envAtOpen - 1]));
  const countsBeforeTicks = t.countsCalls().length;
  // 连续两拍:5 秒拍读缓存,不重探
  await t.fireTick();
  await t.fireTick();
  eq("检查页拍: (前置)这枚 5 秒拍是检查页可见拍(不碰清单计数)", t.countsCalls().length, countsBeforeTicks);
  const tickCalls = t.envCalls.slice(envAtOpen);
  check("检查页拍: 连续两拍都不带 force(缓存优先)", tickCalls.every((a) => a.force !== true), JSON.stringify(tickCalls));
  eq("检查页拍: 读到缓存,不重探(零出站)", tickCalls.length, 0);
  // 「重新检查」仍真重探:带 force
  const recheck = walk(t.surface).find((n) => n.attributes["data-log"] === "check.recheck");
  check("检查页拍: 重检按钮在(check.recheck)", !!recheck);
  if (recheck) fireClick(recheck);
  await flush();
  await flush();
  const forced = t.envCalls.slice(envAtOpen).filter((a) => a.force === true);
  check("检查页拍: 点「重新检查」带 force:true(真重探)", forced.length >= 1, JSON.stringify(t.envCalls.slice(envAtOpen)));
}

// ---------------------------------------------------------------------------
// 切片 7:电话(GitHub)—— 列表游标/页大小、详情不并取列表、评论游标、写键不补零
// ---------------------------------------------------------------------------
{
  const t = await bootPanel({
    projectList: () => listOf(GH_ANCHOR),
    rows: GH_ROWS,
    pageRows: GH_ROWS,
    nextCursor: "50",
    total: 120,
    getPage: (key, after) => {
      const all = Array.from({ length: 60 }, (_, i) => ({
        id: "c" + i,
        author: { login: "u" + (i % 3) },
        authorAssociation: "NONE",
        body: "评论 " + i,
        createdAt: "2026-11-01T00:00:00Z",
        updatedAt: "2026-11-01T00:00:00Z",
      }));
      const off = Math.max(0, parseInt(after, 10) || 0);
      const nodes = all.slice(off, off + 50);
      const card = {
        key,
        effortId: "",
        type: "issue",
        title: "GitHub 的一张票",
        state: "open",
        labels: [{ name: "bug", color: "d73a4a" }],
        assignees: [{ login: "octocat" }],
        author: { login: "octocat" },
        body: "GitHub 议题正文。",
        url: "https://github.com/owner/name/issues/" + key,
        createdAt: "2026-11-01T00:00:00Z",
        updatedAt: "2026-11-02T00:00:00Z",
        closedAt: null,
        blockedBy: [],
        commentCount: 60,
        comments: nodes,
      };
      return { card, pageInfo: { hasNextPage: off + nodes.length < 60, endCursor: String(off + nodes.length) } };
    },
  });
  // 列表翻页:第一页带 cursor:"" 与 state,不传 limit(页大小由服务端固定 50)
  await t.U.kernel.loadIssuePage(t.st, { view: "list" });
  await flush();
  const firstPage = t.listCalls()[t.listCalls().length - 1];
  eq("电话列表: GitHub 第一页传 cursor:''(不传 limit)", firstPage && firstPage.args, { state: "closed", cursor: "" });
  await t.U.kernel.loadIssuePage(t.st, { view: "list", next: true });
  await flush();
  const secondPage = t.listCalls()[t.listCalls().length - 1];
  eq("电话列表: 下一页原样回传服务端游标", secondPage && secondPage.args, { state: "closed", cursor: "50" });

  // 详情:只打一次 deck_issue_get,带 commentsFirst,不再并取整张列表
  const listsBefore = t.listCalls().length;
  const getsBefore = t.getCalls.length;
  t.U.list.rowHelpers.setActiveIssue(t.st, 12, "");
  await flush();
  await settle(60);
  eq("电话详情: 只打一次 deck_issue_get", t.getCalls.length - getsBefore, 1);
  eq("电话详情: key 不补零且带 commentsFirst", t.getCalls[t.getCalls.length - 1], { key: "12", commentsFirst: 50 });
  eq("电话详情: 不再并取整张列表(deck_issue_list 不增)", t.listCalls().length, listsBefore);
  check("电话详情: 详情页渲染正文", textOf(t.surface).includes("GitHub 议题正文"), textOf(t.surface).slice(0, 120));

  // 评论翻页:带 commentsAfter 与条数
  const more = walk(t.surface).find((n) => n.attributes["data-log"] === "detail.cmt.more");
  check("电话评论: 有「加载更多」按钮(hasNextPage)", !!more);
  if (more) {
    fireClick(more);
    await flush();
    await settle(80);
  }
  const moreCall = t.getCalls[t.getCalls.length - 1] || null;
  check("电话评论: 发 deck_issue_get 带 commentsAfter 与条数", !!moreCall && moreCall.key === "12" && moreCall.commentsAfter === "50" && moreCall.commentsFirst === 50, JSON.stringify(moreCall));

  // 评论提交:键不补零(12,不是 12 之外再补零)
  const ta = walk(t.surface).find((n) => n.tagName === "TEXTAREA");
  check("电话评论: 输入区在(textarea)", !!ta);
  if (ta) {
    fireInput(ta, "真机走单:GitHub 写了评论。");
    await tick();
    const sendBtn = walk(t.surface).find((n) => n.attributes["data-log"] === "issue.comment.send");
    check("电话评论: 发送按钮在(issue.comment.send)", !!sendBtn);
    if (sendBtn) {
      fireClick(sendBtn);
      await flush();
      await settle(80);
    }
  }
  const write = t.commentCalls[t.commentCalls.length - 1] || null;
  eq("电话写: key 不补零(12,不是 012)且 actor=panel", write && { key: write.key, actor: write.actor }, { key: "12", actor: "panel" });
  check("电话写: 正文非空", !!(write && String(write.body || "").includes("真机走单")));
}

// ---------------------------------------------------------------------------
// 切片 8:注入前言 —— GitHub 项目恰好多一行;home 只有后端行;markdown 保持原样
// ---------------------------------------------------------------------------
{
  const t = await bootPanel({ projectList: () => listOf(GH_ANCHOR, { activeHome: false }), root: "X:/forge", rows: GH_ROWS });
  t.st.injector("执行 12");
  await flush();
  eq(
    "前言: GitHub 非 home 项目 = 项目行 + 后端行 + 正文",
    t.sent[0],
    "项目：forge（X:/forge）；以下操作都在该项目内进行。\n后端：GitHub（owner/name）；议题用本插件的 deck_* 工具读写\n执行 12"
  );
  const twice = "项目：forge（X:/forge）；以下操作都在该项目内进行。\n后端：GitHub（owner/name）；议题用本插件的 deck_* 工具读写\n执行 12";
  t.st.injector(twice);
  await flush();
  eq("前言: 已带前言不叠加", t.sent[1], twice);
}
{
  const t = await bootPanel({ projectList: () => listOf(GH_ANCHOR), rows: GH_ROWS });
  t.st.injector("执行 12");
  await flush();
  eq("前言: GitHub home-repo 只有后端行", t.sent[0], "后端：GitHub（owner/name）；议题用本插件的 deck_* 工具读写\n执行 12");
}
{
  const t = await bootPanel({ projectList: () => listOf(MD_DEFAULT, { activeHome: false }), root: "X:/forge", rows: MD_ROWS });
  t.st.injector("执行 01");
  await flush();
  eq("前言: markdown 非 home 项目只有项目行", t.sent[0], "项目：forge（X:/forge）；以下操作都在该项目内进行。\n执行 01");
}
{
  const t = await bootPanel({ projectList: () => listOf(MD_DEFAULT), rows: MD_ROWS });
  t.st.injector("执行 01");
  await flush();
  eq("前言: markdown home-repo 不加前言", t.sent[0], "执行 01");
}

// ---------------------------------------------------------------------------
// 切片 9:首屏取数失败 —— 面板照常起、chip 警告态、列表区有原因,不留空壳
// ---------------------------------------------------------------------------
{
  const t = await bootPanel({ projectList: () => listOf(GH_ANCHOR), listThrow: "工具桥断了" });
  check("首屏失败: 面板照常渲染(.dsws-panel)", qsa(t.surface, ".dsws-panel").length >= 1);
  check("首屏失败: 列表壳在(KPI 行)", qsa(t.surface, '[data-list-head="kpi"]').length >= 1);
  const chip = t.chip();
  check("首屏失败: chip 在且警告态", !!chip && String(chip.attributes["class"]).includes("dsws-bchip-warn"), chip && chip.attributes["class"]);
  await t.open();
  const warn = t.warnRow() ? textOf(t.warnRow()) : "";
  check("首屏失败: 展开层原因「上次取数失败」+原文", warn.includes("上次取数失败") && warn.includes("工具桥断了"), warn);
  check("首屏失败: 列表区有取数失败提示(上游 errFull/truth 文案)", textOf(t.surface).includes("刷新失败"), textOf(t.surface).slice(0, 200));
  check("首屏失败: 不是空白壳(必须有落地的可见文本)", textOf(t.surface).trim().length > 0);
}
{
  const t = await bootPanel({ projectList: () => listOf(GH_ANCHOR), listError: "没装 gh(找不到可执行文件)" });
  const chip = t.chip();
  check("首屏失败: 工具回 isError 也进警告态", !!chip && String(chip.attributes["class"]).includes("dsws-bchip-warn"));
  await t.open();
  check("首屏失败: 原因文案上墙", !!t.warnRow() && textOf(t.warnRow()).includes("没装 gh"), t.warnRow() && textOf(t.warnRow()));
}

// ---------------------------------------------------------------------------
// 切片 10:本地 markdown 回归 —— 与 0.6.1 一致(唯一可见变化是头部多一枚 chip)
// ---------------------------------------------------------------------------
{
  const t = await bootPanel({ projectList: () => listOf(MD_DEFAULT), rows: MD_ROWS });
  eq("回归: chip 显示「本地 Markdown」", t.chipText(), "本地 Markdown");
  check("回归: KPI 行在", qsa(t.surface, '[data-list-head="kpi"]').length >= 1);
  const rows = qsa(t.surface, ".dsws-aggrow");
  const fold = walk(t.surface).find((n) => n.tagName === "DETAILS");
  const inFold = (n) => {
    let c = n;
    while (c) {
      if (c === fold) return true;
      c = c.parentNode;
    }
    return false;
  };
  eq("回归: 开票行数 = 1(01 open;02 closed 进折叠区)", rows.filter((r) => !inFold(r)).length, 1);
  const getsBefore = t.getCalls.length;
  t.U.list.rowHelpers.setActiveIssue(t.st, 1, "demo");
  await flush();
  await settle(60);
  const lastGet = t.getCalls[t.getCalls.length - 1] || null;
  eq("回归: 详情电话仍补零(demo/01)", lastGet && lastGet.key, "demo/01");
  check("回归: 详情电话确实发了", t.getCalls.length > getsBefore);
}

// ---------------------------------------------------------------------------
// 切片 11:数据接驳 —— 后端块不再写死,列表不全如实标
// ---------------------------------------------------------------------------
{
  const t = await bootPanel({ projectList: () => listOf(MD_DEFAULT), rows: MD_ROWS });
  const k = { planDeckCounts: t.U.kernel.planDeckCounts, rowCountsOf: t.U.kernel.rowCountsOf };
  const gh = t.U.ingest.ingestSnapshot(
    {
      rows: GH_ROWS,
      counts: { open: 2, closed: 0, total: 2 },
      workspaceRoot: "X:/repo",
      labels: null,
      backend: { id: "github", repoName: "owner/name", repoUrl: "https://github.com/owner/name" },
    },
    k
  );
  eq("接驳: GitHub 仓库身份来自后端", gh.snapshot.repository, {
    backend: "github",
    name: "owner/name",
    refId: "owner/name",
    url: "https://github.com/owner/name",
    path: "X:/repo",
  });
  eq("接驳: selection 翻成 github", gh.selection.backendId, "github");
  eq("接驳: backendModules 只有 github 一项且无 PR 能力", gh.backendModules, [{ id: "github", capabilities: { pullRequests: false } }]);
  const md = t.U.ingest.ingestSnapshot({ rows: MD_ROWS, counts: null, workspaceRoot: "X:/repo", labels: null }, k);
  eq("接驳: 不给 backend 时逐字保持本地口径", md.snapshot.repository, { backend: "markdown", name: "repo", refId: "", path: "X:/repo" });
  eq("接驳: 默认 selection 仍是 markdown", md.selection.backendId, "markdown");
  eq("接驳: 默认 backendModules 只有 markdown 一项", md.backendModules, [{ id: "markdown", capabilities: { pullRequests: false } }]);
  const part = t.U.ingest.ingestSnapshot(
    { rows: MD_ROWS, counts: null, workspaceRoot: "X:/repo", labels: null, backend: { id: "github", repoName: "o/n", repoUrl: "" }, partial: true },
    k
  );
  eq("接驳: 列表不全 → deck.partial 为真(不全的行面不当完整枚举)", part.snapshot.deck.partial, true);
}

console.log(failures === 0 ? `\n全部通过(${checks} 项断言)` : `\n${failures} 项失败(共 ${checks} 项断言)`);
process.exit(failures === 0 ? 0 : 1);
