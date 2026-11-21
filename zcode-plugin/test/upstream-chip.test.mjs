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
//      放宽还原。
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
  const doc = createFakeDom();
  const state = { root: "X:/home", list: listReply };
  const calls = [];
  const reads = [];
  const useCalls = [];
  let releaseUse = null;
  const useMode = opts.useMode || "hold"; // hold=挂起等测试放行;reject=回 isError;ok=立即成功
  const client = {
    readResource: async (uri) => {
      reads.push({ uri, root: state.root });
      if (uri.endsWith("workspace.json")) return { contents: [{ text: JSON.stringify({ root: state.root, env: {} }) }] };
      throw new Error("no asset " + uri);
    },
    sendMessage: async () => ({ ok: true }),
    callTool: async (name, args) => {
      calls.push({ name, args: args || {} });
      if (name === "deck_project_list") return { structuredContent: state.list };
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
    U, doc, surface, calls, reads, useCalls, state,
    st: U.list.storeOf(),
    chip: () => qsa(surface, "[data-deck-chip]")[0] || null,
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
  };
}

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
// 切片 2:无清单 —— 头部与现在完全一致,无 chip
// ---------------------------------------------------------------------------
{
  const t = await bootChipPanel(LIST_MISSING);
  check("票04缺清单: 面板照常渲染(store 在)", !!(t.st && t.st.snapshot));
  check("票04缺清单: 无 chip", !t.chip(), t.chip() && textOf(t.chip()));
  const head = qsa(t.surface, ".dsws-head")[0];
  check("票04缺清单: 头部在", !!head);
  eq("票04缺清单: head 子元素只有标题一件", head ? head.children.length : -1, 1);
  eq("票04缺清单: head 里 span 数不变", qsa(head || t.surface, "span").length, 1);
  check("票04缺清单: 页签行照常", qsa(t.surface, ".dsws-tabs").length === 1);
  check("票04缺清单: 启动取过一次清单", t.calls.some((c) => c.name === "deck_project_list"));
}

// ---------------------------------------------------------------------------
// 切片 3:有清单(含坏条目)—— chip 显示活动项目名;展开层 home 第一、有效项可点、坏条目 warning 附末尾
// ---------------------------------------------------------------------------
{
  const t = await bootChipPanel(LIST_WITH_BAD);
  const chip = t.chip();
  check("票04有清单: chip 在", !!chip);
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
  check("票04有清单: warning 行附在末尾(pop 最后一个子节点)", pop && warns[0] === pop.children[pop.children.length - 1]);
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
  await t.openPop();
  eq("票04切换: 干净清单两枚可点项", t.items().length, 2);

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

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
