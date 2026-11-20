// 工单 01(0.3.1 响应式宽度通道与宽侧重排)测试。
// 缝 = 对外可观察边界:
//   1) 构建缝:本票不改 LEAVES —— bundle 仍过 vm.Script、无拼接标记/锚点残留;响应式接缝
//      (页签折叠机 / surface 覆盖样式)在 bundle 里;
//   2) 主视图缝:boot 真渲染后注入 fake ResizeObserver 改面板根宽度 → narrow 档生效
//      (行内主按钮 narrow-icon + 文字 span 收掉),宽档还原;
//   3) 折叠机缝:页签按 data-priority 从大到小 collapsed、data-tabs-level 与折叠数一致;
//      RO / window resize / document.fonts.ready 三路各触发一次;
//   4) 不重挂缝:改宽只经宽度状态重渲 —— 面板根节点身份不变、surface 下仍一个面板、
//      boot 走过的工具调用次数不增、RO 观察者/窗口监听不随重渲增长;
//   5) 详情顶栏缝:顶栏溢出时逐字变短(是 data-full 的前缀),放宽后还原(useIssueDetailFold 自持);
//   6) 宽侧缝:内容随容器铺满(0.3.2 起撤掉 460 上限 —— 真机反馈内容锁窄不跟侧边栏),
//      样式只动布局,不含字号/色卡/圆角/底色覆盖。
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
// fake DOM(照 upstream-list 舱模式;本套件多加两件真 DOM 语义:
//   - textContent 读写(textContent 的 setter 真替换子树,折叠机逐字改字才能观察到);
//   - dataset(折叠机用 el.dataset.priority / t.dataset.tabsLevel,写读都落到 data-* 属性)。
// ---------------------------------------------------------------------------
const ATTR_KEY_RE = /[A-Z]/g;
function dataKeyOf(k) {
  return "data-" + String(k).replace(ATTR_KEY_RE, (m) => "-" + m.toLowerCase());
}
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
  // 真 DOM 语义:textContent 读=子树文本拼接,写=整段替换子树(折叠机逐字改字靠它)
  Object.defineProperty(node, "textContent", {
    get: () => (node.nodeType === 3 ? node.data : walk(node).filter((n) => n.nodeType === 3).map((n) => n.data).join("")),
    set: (v) => {
      if (node.nodeType === 3) {
        node.data = String(v);
        return;
      }
      node.children = [];
      const text = v === null || v === undefined ? "" : String(v);
      if (text === "") return;
      const t = createFakeNode(3, "");
      t.ownerDocument = node.ownerDocument;
      t.data = text;
      t.parentNode = node;
      node.children.push(t);
    },
  });
  // data-* 属性视图(折叠机读写:data-priority 读、data-tabs-level 写)
  Object.defineProperty(node, "dataset", {
    get: () =>
      new Proxy(
        {},
        {
          get: (_, k) => node.attributes[dataKeyOf(k)],
          set: (_, k, v) => {
            node.attributes[dataKeyOf(k)] = String(v);
            return true;
          },
          has: (_, k) => dataKeyOf(k) in node.attributes,
        }
      ),
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
    if (i < segs.length - 1) layer = layer.flatMap((n) => walk(n).filter((c) => c !== n && c.nodeType === 1));
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
  // 真 DOM 语义:head/body 是 document 的子节点(document.querySelectorAll 才看得到面板子树;
  // P1-2 的 fitAllTags 走 document 级查询,旧假 DOM 只挂了 body 引用、没挂进树里)。
  doc.appendChild(doc.head);
  doc.appendChild(doc.body);
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
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const flush = async () => {
  await tick();
  await tick();
  await settle();
};

// ---------------------------------------------------------------------------
// fake ResizeObserver(可注入):记下谁在被观察,测试按元素派发宽度。
// ---------------------------------------------------------------------------
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
  unobserve(el) {
    const i = this.targets.indexOf(el);
    if (i >= 0) this.targets.splice(i, 1);
  }
  disconnect() {
    this.targets.length = 0;
  }
}
const observersOf = (el) => roInstances.filter((r) => r.targets.includes(el));
function fireRO(el, width, height) {
  const list = observersOf(el).slice();
  for (const ro of list) ro.cb([{ target: el, contentRect: { width, height: height || 600 } }], ro);
  return list.length;
}

// ---------------------------------------------------------------------------
// fake window:记 resize 监听,测试可派发(页签折叠机与详情折叠机都挂这一路)
// ---------------------------------------------------------------------------
const winListeners = {};
const win = {
  innerWidth: 800,
  innerHeight: 600,
  addEventListener(t, fn) {
    (winListeners[t] = winListeners[t] || []).push(fn);
  },
  removeEventListener(t, fn) {
    const a = winListeners[t] || [];
    const i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  },
};
function fireWindowResize() {
  for (const fn of (winListeners.resize || []).slice()) fn({ type: "resize" });
}
const resizeListenerCount = () => (winListeners.resize || []).length;

// ---------------------------------------------------------------------------
// 切片 1:构建缝 —— 本票不改 LEAVES,bundle 仍过语法门禁,响应式接缝在产物里
// ---------------------------------------------------------------------------
const buildUpstream = await import(pathToFileURL(join(ROOT, "build-upstream.mjs")).href);
check("build-upstream.LEAVES 可读", Array.isArray(buildUpstream.LEAVES) && buildUpstream.LEAVES.length > 0);
const code = existsSync(BUNDLE) ? readFileSync(BUNDLE, "utf8") : "";
check("dist/ui/bundle-1.txt 存在", existsSync(BUNDLE));
if (code) {
  const has = (name, re) => check(`bundle 含 ${name}`, re.test(code));
  has("页签折叠机(querySelectorAll [data-priority])", /querySelectorAll\(\s*["']\[data-priority\]["']\s*\)/);
  has("页签折叠机(dataset.tabsLevel 回写)", /dataset\.tabsLevel/);
  has("页签折叠机(测量期 dsws-no-anim)", /dsws-no-anim/);
  has("surface 覆盖样式(#dsws-surface)", /#dsws-surface/);
  check("内容不设 460 上限(0.3.2 起随容器铺满)", !/max-width:\s*460px/.test(code));
  has("宽度通道(面板根 ResizeObserver → setDw)", /setDw/);
  check("bundle 无拼接标记残留", !/\(spliced by build\)/.test(code));
  check("bundle 无锚点残留", !/@splice-anchor/.test(code));
  check("bundle 无模块级 import/export", !/^[^\S\r\n]*import[\s{"'*]/m.test(code) && !/^[^\S\r\n]*export\s/m.test(code));
  try {
    new vm.Script(code);
    check("bundle 语法过(vm.Script)", true);
  } catch (e) {
    check("bundle 语法过(vm.Script)", false, e.message);
  }
}

// ---------------------------------------------------------------------------
// 切片 2..7:主视图舱 —— u05-detail fixture 同时覆盖列表行与详情路径
//   列表:map 容器 + 01 开票(needs-info/认领)+ 02 被阻塞 + 03 已关闭
// ---------------------------------------------------------------------------
const { scanWorkspace, thinRow } = await import(pathToFileURL(join(ROOT, "src", "cards.mjs")).href);
const scan = scanWorkspace(join(ROOT, "test", "fixtures", "u05-detail"));
const LABEL_PALETTE = {
  labels: ["needs-triage", "needs-info", "ready-for-agent", "ready-for-human", "wontfix"],
  colors: {
    bug: "d73a4a",
    "needs-triage": "fbca04",
    "needs-info": "5319e7",
    "ready-for-agent": "0e8a16",
    "ready-for-human": "b60205",
    wontfix: "ffffff",
    "wayfinder:map": "8b5cf6",
  },
};
const toolCalls = [];
const doc = createFakeDom();
let resolveFonts = null;
doc.fonts = { ready: new Promise((r) => { resolveFonts = r; }) };
// ResizeObserver 必须在 bundle 求值前就位(闭包求值期的自由变量解析到全局)
globalThis.ResizeObserver = FakeResizeObserver;

let U = null;
{
  const fakeClient = {
    readResource: async (uri) => {
      if (uri.endsWith("workspace.json")) return { contents: [{ text: JSON.stringify({ root: "X:/t01", env: {} }) }] };
      throw new Error("no asset " + uri);
    },
    sendMessage: async () => ({ ok: true }),
    callTool: async (name, args) => {
      toolCalls.push({ name, args: args || {} });
      if (name === "deck_issue_list") return { structuredContent: { rows: scan.rows.map(thinRow), revision: 1 } };
      if (name === "deck_issue_counts")
        return {
          structuredContent: {
            counts: {
              open: scan.rows.filter((r) => r.type === "issue" && r.state === "open").length,
              closed: scan.rows.filter((r) => r.type === "issue" && r.state === "closed").length,
              total: scan.rows.filter((r) => r.type === "issue").length,
            },
            revision: 1,
          },
        };
      if (name === "deck_issue_list_labels") return { structuredContent: LABEL_PALETTE };
      if (name === "deck_issue_get") {
        const eff = String(args.key).includes("/") ? String(args.key).split("/")[0] : "";
        const inner = String(args.key).split("/").pop().replace(/^0+(?=\d)/, "");
        const card = scan.rows.find((r) => String(r.effortId) === eff && String(r.key) === inner);
        if (!card) return { isError: true, content: [{ type: "text", text: "no card " + args.key }] };
        return { structuredContent: { workspaceRoot: "X:/t01", card } };
      }
      throw new Error("no tool " + name);
    },
  };
  if (code) {
    try {
      new Function("window", "document", `"use strict";\n${code}`)(win, doc);
      U = win.MattSkillsUpstream;
      await U.boot({ client: fakeClient, doc, fetchData: true });
      await flush();
      check("boot({fetchData:true}) 成功且壳已挂载", doc.body.children.length >= 1);
    } catch (e) {
      check("boot({fetchData:true}) 成功", false, e && e.stack ? e.stack.split("\n").slice(0, 6).join(" | ") : String(e));
    }
  }
}

if (U) {
  const surface = doc.body.children[0];
  const panelOf = () => qsa(surface, ".dsws-panel");
  const tabsRowOf = () => qsa(surface, ".dsws-tabs")[0];
  const rowsOf = () => qsa(surface, ".dsws-aggrow");
  const primaryBtns = () => rowsOf().flatMap((r) => qsa(r, ".dsws-btn.primary"));
  const labelSpanIn = (btn) => qsa(btn, "span").filter((s) => textOf(s).trim() !== "")[0] || null;
  const st = U.list.storeOf();
  check("store 就绪(接驳后非空)", !!(st && st.snapshot));
  check("surface 根在(#dsws-surface)", surface && surface.attributes.id === "dsws-surface");

  // ---- 宽档基线(初值 460) ----
  const panel0 = panelOf()[0];
  check("面板根 dsws-panel 在", !!panel0);
  check("宽档基线:surface 下只有一个面板根", panelOf().length === 1);
  check("宽档基线:面板根不含 dsws-narrow", panel0 && !String(panel0.attributes["class"]).includes("dsws-narrow"));
  const rowsBase = rowsOf().length;
  check("宽档基线:列表行已渲染", rowsBase > 0, String(rowsBase));
  const btnsBase = primaryBtns();
  check("宽档基线:行内主按钮存在", btnsBase.length > 0, String(btnsBase.length));
  check("宽档基线:主按钮都不带 narrow-icon", btnsBase.length > 0 && btnsBase.every((b) => !String(b.attributes["class"]).includes("narrow-icon")));
  check("宽档基线:主按钮带文字 span", btnsBase.length > 0 && btnsBase.every((b) => !!labelSpanIn(b)));
  const kpiRow = qsa(surface, '[data-list-head="kpi"]')[0];
  check("宽档基线:KPI 行在", !!kpiRow);

  // ---- 切片:document.fonts.ready 这一路触发页签折叠 ----
  // fake 容器的可用宽 300:590px 内容需收「环境检查(8)→技能(7)→版本管理(5)」三档后放得下,
  // 590 - 3×100 = 290 <= 301(每折一档少 100px,模拟真实 max-width 动画收字)
  const tabsRow = tabsRowOf();
  check("页签行在(.dsws-tabs)", !!tabsRow);
  if (tabsRow) {
    tabsRow.clientWidth = 300;
    Object.defineProperty(tabsRow, "scrollWidth", {
      configurable: true,
      get() {
        const collapsed = qsa(this, "[data-priority].collapsed").length;
        return 590 - 100 * collapsed;
      },
    });
    // 抹掉挂载时折叠机写的档位与折叠类,只留 fonts.ready 一路来证明它真触发
    delete tabsRow.attributes["data-tabs-level"];
    for (const el of qsa(tabsRow, "[data-priority]")) el.classList.remove("collapsed");
    const fontsTriggered = typeof resolveFonts === "function";
    check("document.fonts.ready 是待兑现的 deferred(证明下面这一次由它触发)", fontsTriggered);
    if (fontsTriggered) {
      resolveFonts();
      await flush();
    }
    eq("fonts.ready 触发折叠:data-tabs-level = 3", tabsRow.attributes["data-tabs-level"], "3");
    const collapsedNow = () => qsa(tabsRow, "[data-priority].collapsed").map((el) => el.attributes["data-priority"]);
    eq("折叠集合按 priority 降序 = 8 环境检查 → 7 技能 → 5 版本管理", collapsedNow().sort((a, b) => Number(b) - Number(a)), ["8", "7", "5"]);
    check("优先级最高(8 环境检查)先收", collapsedNow().includes("8"));
    check("右侧入口(2 新建需求 / 1 +bug)不让位", !collapsedNow().includes("2") && !collapsedNow().includes("1"));
  }

  // ---- 切片:window resize 这一路触发,放宽后全部还原 ----
  if (tabsRow) {
    tabsRow.clientWidth = 800;
    fireWindowResize();
    await flush();
    eq("window resize 触发:折叠清零(data-tabs-level = 0)", tabsRow.attributes["data-tabs-level"], "0");
    eq("window resize 触发:无 collapsed 残留", qsa(tabsRow, "[data-priority].collapsed").length, 0);
  }

  // ---- 切片:ResizeObserver 宽通道 → 窄档生效 ----
  const roObservers0 = observersOf(panel0).length;
  check("面板根被 ResizeObserver 观察(单次挂载,不随重渲增长)", roObservers0 >= 1, String(roObservers0));
  const resizeListeners0 = resizeListenerCount();
  const leafListCalls0 = toolCalls.filter((c) => c.name === "deck_issue_list").length;
  const fired = fireRO(panel0, 300);
  check("向面板根派发 ResizeObserver 宽度 300(至少一个观察者)", fired >= 1);
  await flush();
  const panelNarrow = panelOf()[0];
  check("窄档:面板根挂 dsws-narrow", panelNarrow && String(panelNarrow.attributes["class"]).includes("dsws-narrow"));
  const btnsNarrow = primaryBtns();
  check("窄档:行内主按钮仍全在", btnsNarrow.length === btnsBase.length, `${btnsNarrow.length}/${btnsBase.length}`);
  check("窄档:行内主按钮带 narrow-icon", btnsNarrow.length > 0 && btnsNarrow.every((b) => String(b.attributes["class"]).includes("narrow-icon")));
  check("窄档:主按钮文字 span 收掉(只剩图标)", btnsNarrow.every((b) => !labelSpanIn(b)), JSON.stringify(btnsNarrow.map((b) => textOf(b)).slice(0, 4)));
  check("窄档:KPI 行仍在", !!qsa(surface, '[data-list-head="kpi"]')[0]);
  check("窄档:列表行仍在", rowsOf().length === rowsBase, `${rowsOf().length}/${rowsBase}`);

  // 窄档下把页签行可用宽也压到 300:window resize 一路要把三档收起来(拖动即时生效)
  if (tabsRow) {
    tabsRow.clientWidth = 300;
    fireWindowResize();
    await flush();
    eq("窄档 + window resize:页签收三档", tabsRow.attributes["data-tabs-level"], "3");
  }

  // ---- 切片:不重挂 —— 改宽只经宽度状态重渲 ----
  check("不重挂:surface 下仍只有一个面板根", panelOf().length === 1);
  check("不重挂:面板根节点身份未变(同一 DOM 对象)", panelOf()[0] === panel0);
  check("不重挂:页签仍是列表(st.tab = list)", st && st.tab === "list", st && String(st.tab));
  eq("不重挂:boot 的 deck_issue_list 调用次数未增", toolCalls.filter((c) => c.name === "deck_issue_list").length, leafListCalls0);
  eq("不重挂:面板根 RO 观察者数未增", observersOf(panel0).length, roObservers0);
  eq("不重挂:窗口 resize 监听数未增(无重挂/无泄漏)", resizeListenerCount(), resizeListeners0);

  // ---- 切片:宽回来全部还原 ----
  fireRO(panel0, 800);
  await flush();
  check("宽档还原:面板根 dsws-narrow 已摘", !String(panelOf()[0].attributes["class"]).includes("dsws-narrow"));
  const btnsWide = primaryBtns();
  check("宽档还原:主按钮 narrow-icon 消失", btnsWide.every((b) => !String(b.attributes["class"]).includes("narrow-icon")));
  check("宽档还原:主按钮文字 span 回来", btnsWide.length > 0 && btnsWide.every((b) => !!labelSpanIn(b)));
  if (tabsRow) {
    tabsRow.clientWidth = 800;
    fireWindowResize();
    await flush();
    eq("宽档还原:页签折叠清零", tabsRow.attributes["data-tabs-level"], "0");
  }
  check("宽档还原后:面板根节点身份仍未变", panelOf()[0] === panel0);

  // ---- P1-2:宽度拍补标签重排(fitAllTags 指纹不含宽度,拖宽拖窄后 +N 要重算) ----
  {
    const tagsRows = qsa(surface, ".dsws-tags");
    check("标签行在(.dsws-tags)", tagsRows.length > 0, String(tagsRows.length));
    const tagsRow = tagsRows[0];
    const more = tagsRow ? qsa(tagsRow, ".dsws-more")[0] : null;
    check("标签行带 +N 计数芯片(.dsws-more)", !!more);
    if (tagsRow && more) {
      // fixture 每行只有 1 颗标签,量不出 +N:补 4 颗可量宽度(40px)的标签模拟多标签行。
      for (let i = 0; i < 4; i++) {
        const chip = createFakeNode(1, "span");
        chip.className = "dsws-chip";
        chip.ownerDocument = doc;
        Object.defineProperty(chip, "offsetWidth", { configurable: true, get: () => 40 });
        tagsRow.appendChild(chip);
      }
      for (const c of qsa(tagsRow, ".dsws-chip")) {
        if (c !== more) Object.defineProperty(c, "offsetWidth", { configurable: true, get: () => 40 });
      }
      Object.defineProperty(more, "offsetWidth", { configurable: true, get: () => 30 });
      const hiddenChips = () => qsa(tagsRow, ".dsws-chip:not(.dsws-more)").filter((c) => c.style.display === "none").length;

      tagsRow.clientWidth = 200;
      fireRO(panel0, 800);
      eq("宽档宽度拍:多标签行收 2 颗进 +N", more.textContent, "+2");
      eq("宽档宽度拍:隐藏 2 颗标签", hiddenChips(), 2);

      tagsRow.clientWidth = 60;
      fireRO(panel0, 300);
      check("窄档宽度拍:+N 变大", Number(String(more.textContent).slice(1)) > 2, more.textContent);
      eq("窄档宽度拍:隐藏 4 颗标签", hiddenChips(), 4);

      tagsRow.clientWidth = 200;
      fireRO(panel0, 800);
      eq("宽度还原:+N 回退到 +2", more.textContent, "+2");
      eq("宽度还原:隐藏数回退到 2", hiddenChips(), 2);
      await flush();
    }
  }

  // ---- 切片:详情顶栏逐字折叠(useIssueDetailFold 自持;改宽后触发 + 还原) ----
  U.list.rowHelpers.setActiveIssue(st, 1, "dogfood-detail");
  await flush();
  await flush();
  {
    const topbar = qsa(surface, "[data-detail-topbar]")[0];
    check("详情顶栏在(data-detail-topbar)", !!topbar);
    const backOf = () => qsa(surface, "[data-detail-back-text]")[0];
    const back = backOf();
    check("顶栏返回字 span 在(data-detail-back-text)", !!back);
    const full = back && back.getAttribute("data-full");
    check("顶栏返回字有 data-full(全量串)", !!full && full.length > 0, String(full));
    check("宽态顶栏显示全量串", back && back.textContent === full, back && back.textContent);

    if (topbar && back && full) {
      // 顶栏溢出:可用 180,内容 640 → 逐档从尾部裁字
      topbar.clientWidth = 180;
      topbar.scrollWidth = 640;
      fireWindowResize();
      await flush();
      const shortText = backOf() ? backOf().textContent : "";
      check("窄态顶栏逐字变短(与 data-full 不同)", shortText !== full, `${shortText} / ${full}`);
      check("窄态顶栏是 data-full 的前缀(尾部裁字、不放省略号)", full.startsWith(shortText), `${shortText} / ${full}`);
      check("窄态顶栏更短", shortText.length < full.length, `${shortText.length}/${full.length}`);

      // 放宽 → 还原
      const topbarNow = qsa(surface, "[data-detail-topbar]")[0];
      if (topbarNow) {
        topbarNow.clientWidth = 1200;
        topbarNow.scrollWidth = 640;
        fireWindowResize();
        await flush();
        const backNow = backOf();
        check("放宽后顶栏还原全量串", backNow && backNow.textContent === full, backNow && backNow.textContent);
      } else {
        check("放宽后顶栏仍在", false);
      }
    }
  }

  // ---- 切片:宽侧上限与布局-only 样式文本 ----
  const styleTexts = doc.head.children.map((n) => n.textContent || "");
  check("上游 STYLE_TEXT 仍在 head(面板令牌族未被替换)", styleTexts.some((t) => t.includes(".dsws-panel{position:fixed")));
  const responsive = styleTexts.find((t) => t.includes("#dsws-surface"));
  check("响应式接缝样式插入 head(#dsws-surface)", !!responsive);
  if (responsive) {
    check("surface 撑满容器(height:100%)", /#dsws-surface\{[^}]*height:100%/.test(responsive) || /html,body,#dsws-surface\{height:100%\}/.test(responsive), responsive.slice(0, 200));
    check("面板根改为静态满幅(position:static + width/height 100%)", /\.dsws-panel\{[^}]*position:static/.test(responsive) && /\.dsws-panel\{[^}]*width:100%/.test(responsive) && /\.dsws-panel\{[^}]*height:100%/.test(responsive), responsive.slice(0, 400));
    check("seam 中间层 box 拉伸(height:100%)", /#dsws-surface > div\{[^}]*height:100%/.test(responsive), responsive.slice(0, 400));
    check("内容随容器铺满:行/KPI/正文根不再设宽上限(0.3.2)", !/max-width/.test(responsive), responsive);
    check("布局动、字号不动:样式文本无 font-size 覆盖", !/font-size/i.test(responsive));
    check("颜色/圆角/底色不动:样式文本无 color/background/border-radius", !/(?:^|[;{\s])(?:color|background|border-radius)\s*:/.test(responsive), responsive);
  }
  check("改宽未影响 surface 唯一性(收尾)", qsa(surface, ".dsws-panel").length === 1);
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
