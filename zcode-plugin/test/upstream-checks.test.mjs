// 工单 03 环境检查页签测试:链快照渲染、重检重扫、失败步修复动作。
// 缝 = 对外可观察边界:
//   1) 构建缝:leaf:chainRenderer / leaf:checksTab 登记进 LEAVES、骨架留标记、
//      标记序仍是上游 index.ts 的保序子序列(chainRenderer 在 tabs 之前、checksTab 在 listTab 之后);
//   2) bundle 内容缝:ChecksTab / chainSteps / CHAIN_EVENT_REASONS / createActionDispatcher /
//      checkShowTitle / nowStr / refreshAll 在、wf.chain·wf.detect 宿主适配在、无拼接残留、语法过;
//   3) 主视图缝:boot → 点「环境检查」页签 → 链快照 6 行(每步 .dsws-ccard + data-state 四态)、
//      标题/描述可见、头部 env.title 的 N/M 计数与 fake 链一致、U06 占位消失;
//   4) 重检缝:点「重新检查」→ fake 工具再打一次(带 force)→ 返回变更后的链 → 面板跟着变;
//   5) 动作缝:失败步的 inject-prompt 主修复按钮 → 上游 inject → sendMessage(与详情动作栏同桥)。
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
// fake DOM(与 upstream-list 同款:类/属性/tag 选择器 + 冒泡 click + Preact props 通道;
// clientWidth/scrollWidth 恒 0 —— 检查页不依赖宽度测量)
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
/** 在 fake 节点上派发一次 click(Preact 把 on* 事件直接挂节点 addEventListener)。 */
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
  let anc = node.parentNode;
  while (anc) {
    for (const fn of collect(anc).slice()) fn.call(anc, Object.assign({}, ev, { currentTarget: anc }));
    anc = anc.parentNode;
  }
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = () => new Promise((r) => setTimeout(r, 40));

// ---------------------------------------------------------------------------
// 切片 1:构建缝 —— 两叶登记 / 骨架标记 / 标记序(含与 tabs、listTab 的相对位置)
// ---------------------------------------------------------------------------
const buildUpstream = await import(pathToFileURL(join(ROOT, "build-upstream.mjs")).href);
{
  const ids = buildUpstream.LEAVES.map((l) => l.id);
  for (const id of ["leaf:chainRenderer", "leaf:checksTab"]) {
    check(`LEAVES 登记 ${id}`, ids.includes(id));
  }
  const skeletonText = readFileSync(join(ROOT, "src", "ui", "upstream", "entry.mjs"), "utf8");
  const skelMarkers = buildUpstream.parseMarkers(skeletonText).map((m) => m.id);
  for (const id of ["leaf:chainRenderer", "leaf:checksTab"]) {
    check(`骨架留了标记 ${id}`, skelMarkers.includes(id));
  }
  check(
    "entry.mjs 骨架标记是上游 index.ts 标记序的保序子序列",
    buildUpstream.isSubsequenceOf(skelMarkers, buildUpstream.upstreamMarkerOrder()),
    skelMarkers.join(" → ")
  );
  const at = (id) => skelMarkers.indexOf(id);
  check("chainRenderer 标记在 tabs 之前(上游标记序)", at("leaf:chainRenderer") >= 0 && at("leaf:chainRenderer") < at("leaf:tabs"), `chainRenderer=${at("leaf:chainRenderer")} tabs=${at("leaf:tabs")}`);
  check("checksTab 标记在 listTab 之后(上游标记序)", at("leaf:checksTab") > at("leaf:listTab"), `checksTab=${at("leaf:checksTab")} listTab=${at("leaf:listTab")}`);
}

// ---------------------------------------------------------------------------
// 切片 2:bundle 内容缝 —— 视图符号 / 宿主适配 / 拼接残留 / 语法
// ---------------------------------------------------------------------------
const code = existsSync(BUNDLE) ? readFileSync(BUNDLE, "utf8") : "";
check("dist/ui/bundle-1.txt 存在", existsSync(BUNDLE));
if (code) {
  const has = (name, re) => check(`bundle 含 ${name}`, re.test(code));
  has("leaf:checksTab(ChecksTab 组件)", /const ChecksTab = /);
  has("leaf:chainRenderer(checkShowTitle)", /const checkShowTitle = function/);
  has("kernel:probeChain(chainSteps)", /const chainSteps = /);
  has("CHAIN_EVENT_REASONS(链事件原因)", /CHAIN_EVENT_REASONS/);
  has("createActionDispatcher(动作分发)", /function createActionDispatcher|createActionDispatcher = function/);
  has("装配段 nowStr(loadChain 成功路径用)", /const nowStr = /);
  has("装配段 refreshAll(重新检查)", /const refreshAll = function/);
  has("宿主适配 wf.chain → deck_env_check", /wf\.chain/);
  has("宿主适配 wf.detect → deck_env_check", /wf\.detect/);
  has("工具电话 deck_env_check", /deck_env_check/);
  check("U06 检查页占位已撤(checks 分支挂 ChecksTab)", /ChecksTab, \{ st(?:: st)? \}/.test(code));
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
// 切片 3-5:主视图 / 重检 / 动作 —— boot 用 fake client 喂两条链
// ---------------------------------------------------------------------------
// fake 链 v1:六步覆盖四态(done/current/fail/pending);current 那步带 inject-prompt 修复动作。
const stepOf = (id, status, fallback, desc, actions) => ({
  id,
  status,
  show: { fallback, desc },
  actions: actions || [],
  blockedBy: null,
});
const CHAIN_A = {
  steps: [
    stepOf("env:bridge", "done", "工具桥在线", "ZCode 工具桥在线"),
    stepOf("scratch:workspace", "current", "工作区已初始化", "缺 .scratch/ 工单目录", [
      { type: "inject-prompt", label: "初始化看板", prompt: "请初始化看板并建卡" },
    ]),
    stepOf("scratch:cards", "fail", "卡片可读", "有 1 张卡片文件读不动"),
    stepOf("env:watch", "pending", "监听在线", "还在挂监听"),
    stepOf("env:skills", "done", "技能根可读", "可读技能根:1 个"),
    stepOf("git:repo", "done", "工作区是 git 仓库", "工作区根有 .git"),
  ],
  currentIndex: 1,
  failedIndex: 1,
  doneCount: 3,
  applicableCount: 6,
  totalCount: 6,
  chainState: "hasCurrent",
  version: "1",
};
// fake 链 v2:用户重检后 scratch:cards 修好 → fail 变 done,计数 4/6。
const CHAIN_B = {
  steps: CHAIN_A.steps.map((s) => (s.id === "scratch:cards" ? stepOf("scratch:cards", "done", "卡片可读", "共 9 张卡全部可读") : s)),
  currentIndex: 1,
  failedIndex: 1,
  doneCount: 4,
  applicableCount: 6,
  totalCount: 6,
  chainState: "hasCurrent",
  version: "1",
};
// fake 链 v3:检查页可见拍自己再扫一次后,监听那步也变绿 → 计数 5/6。
const CHAIN_C = {
  steps: CHAIN_B.steps.map((s) => (s.id === "env:watch" ? stepOf("env:watch", "done", "监听在线", "fs.watch 已挂上(可见拍重扫)") : s)),
  currentIndex: 1,
  failedIndex: 1,
  doneCount: 5,
  applicableCount: 6,
  totalCount: 6,
  chainState: "hasCurrent",
  version: "1",
};

// ---------------------------------------------------------------------------
// P1-1:检查页可见拍 —— boot 前把全局 setInterval/clearInterval 换成可控桩。
// 桩记下每一次注册(间隔、回调、是否已被 clearInterval 清掉);fire() 遵循浏览器语义:
// 已清掉的拍不再派发回调(测试「离页后旧回调再跑不触发工具」靠它)。
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

let U = null;
const doc = createFakeDom();
const chainCalls = [];
const messages = [];
let currentChain = CHAIN_A;
let chainDelayMs = 0;
{
  const LABEL_PALETTE = { labels: [], colors: { bug: "d73a4a" } };
  const fakeClient = {
    readResource: async (uri) => {
      if (uri.endsWith("workspace.json")) return { contents: [{ text: JSON.stringify({ root: "X:/u03", env: {} }) }] };
      throw new Error("no asset " + uri);
    },
    callTool: async (name, args) => {
      if (name === "deck_issue_list") return { structuredContent: { rows: [], revision: 1 } };
      if (name === "deck_issue_counts") return { structuredContent: { counts: { open: 0, closed: 0, total: 0 }, revision: 1 } };
      if (name === "deck_issue_list_labels") return { structuredContent: LABEL_PALETTE };
      if (name === "deck_env_check") {
        chainCalls.push({ name, args: args || {} });
        const snap = currentChain;
        if (chainDelayMs) await new Promise((r) => setTimeout(r, chainDelayMs));
        return { structuredContent: { ok: true, snapshot: snap, checkedAt: "2026-11-20T00:00:00.000Z" } };
      }
      throw new Error("no tool " + name);
    },
    sendMessage: async (text) => {
      messages.push(String(text));
      return { ok: true };
    },
  };
  if (code) {
    try {
      const win = { innerWidth: 800, innerHeight: 600, addEventListener() {}, removeEventListener() {} };
      new Function("window", "document", `"use strict";\n${code}`)(win, doc);
      U = win.MattSkillsUpstream;
      await U.boot({ client: fakeClient, doc, fetchData: true });
      await tick();
      check("boot({fetchData:true}) 成功且壳已挂载", doc.body.children.length >= 1);
    } catch (e) {
      check("boot({fetchData:true}) 成功", false, e && e.stack ? e.stack.split("\n").slice(0, 6).join(" | ") : String(e));
    }
  }
}

if (U) {
  const surface = doc.body.children[0]; // #dsws-surface
  const body = qsa(surface, ".dsws-body")[0];
  const st = U.list ? U.list.storeOf() : null;
  const tabBtn = (log) => walk(surface).filter((n) => n.attributes["data-log"] === log && n.tagName === "BUTTON")[0];

  // ---- 点「环境检查」页签:st.tab 切换 + 首次链取数(force=false) ----
  check("环境检查页签按钮在(panel.tab.checks)", !!tabBtn("panel.tab.checks"));
  // 0.6.1 起面板挂载时另有一枚同节奏的清单状态拍,所以检查页可见拍按「点开检查页时新注册」
  // 来认,不按节奏认 —— 认错拍会把清单重取当成检查重扫。
  const intervalsBeforeChecks = intervals.length;
  fireClick(tabBtn("panel.tab.checks"));
  await settle();
  eq("页签壳状态:st.tab = checks", st && st.tab, "checks");
  check("打开检查页触发一次链取数", chainCalls.length === 1, String(chainCalls.length));
  check("打开检查页这一次不带 force(缓存优先)", chainCalls[0] && chainCalls[0].args.force !== true, JSON.stringify(chainCalls[0] && chainCalls[0].args));
  check("链快照落进 st.chainSnapshot", !!(st && st.chainSnapshot && Array.isArray(st.chainSnapshot.steps)));
  check("st.chainLoadedAt 已写入(nowStr 守卫)", !!(st && typeof st.chainLoadedAt === "string" && st.chainLoadedAt.length > 0), st && st.chainLoadedAt);

  // ---- 链快照渲染:每步一行 .dsws-ccard + data-state(四态) + 标题/描述可见 ----
  const cards = () => qsa(surface, ".dsws-ccard");
  eq("链快照行数 = 6(每个检查项一行)", cards().length, 6);
  const states = cards().map((n) => n.attributes["data-state"]);
  eq("data-state 四态齐(done/current/fail/pending)", states, ["done", "current", "fail", "pending", "done", "done"]);
  for (const s of CHAIN_A.steps) {
    const row = cards().find((n) => textOf(n).includes(s.show.fallback));
    check(`行「${s.show.fallback}」可见且带描述`, !!row && textOf(row).includes(s.show.desc), row ? textOf(row) : "缺行");
  }
  const headText = textOf(qsa(surface, ".dsws-body")[0]);
  check("头部 env.title 的 N/M 与链一致(环境检查 3/6)", headText.includes("环境检查 3/6"), headText.slice(0, 120));
  check("检查页占位「U06+ 搬入」不再出现", !headText.includes("U06"), headText.slice(0, 120));
  check("「重新检查」按钮在(check.recheck)", !!tabBtn("check.recheck") || !!walk(surface).find((n) => n.attributes["data-log"] === "check.recheck"));

  // ---- 重检:按钮 → refreshAll → 工具再打一次(带 force)→ 面板跟着变 ----
  currentChain = CHAIN_B;
  chainDelayMs = 25; // 让「转圈」在断言点可见(fake 工具慢一拍返回)
  const recheck = walk(surface).find((n) => n.attributes["data-log"] === "check.recheck");
  check("重检前 st.refreshing 为假", !st.refreshing, String(st.refreshing));
  if (recheck) fireClick(recheck);
  await tick();
  check("点「重新检查」后按钮进入转圈态(st.refreshing 驱动)", st.refreshing === true, String(st.refreshing));
  await settle();
  check("重检真实重扫:工具被再次调用", chainCalls.length === 2, String(chainCalls.length));
  check("重检这一次带 force", chainCalls[1] && chainCalls[1].args.force === true, JSON.stringify(chainCalls[1] && chainCalls[1].args));
  eq("面板跟着变:scratch:cards 旧 fail 变 done", cards().map((n) => n.attributes["data-state"]), ["done", "current", "done", "pending", "done", "done"]);
  check("头部计数跟着变(环境检查 4/6)", textOf(qsa(surface, ".dsws-body")[0]).includes("环境检查 4/6"));
  check("重检收尾 st.refreshing 归假", !st.refreshing, String(st.refreshing));

  // ---- 失败/待办步的 inject-prompt 主修复按钮:点上经 ui/message 桥发进对话 ----
  const fixBtn = walk(surface).find((n) => n.attributes["data-log"] === "check.fix.1");
  check("current 步带主修复按钮(check.fix.1)", !!fixBtn);
  check("主修复按钮文案取动作 label(初始化看板)", fixBtn && textOf(fixBtn).includes("初始化看板"), fixBtn && textOf(fixBtn));
  const sentBefore = messages.length;
  if (fixBtn) fireClick(fixBtn);
  await settle();
  check("点修复按钮经 sendMessage 发进对话(与详情动作栏同桥)", messages.length === sentBefore + 1, String(messages.length));
  check("发出去的是动作 prompt 原文", messages[messages.length - 1] && messages[messages.length - 1].includes("请初始化看板并建卡"), JSON.stringify(messages[messages.length - 1]));

  // ---- 链渲染没有恢复九格 wf.status 视图:页面上不该出现九格/状态格目录 ----
  check("没有恢复九格视图(wf.status 目录格)", qsa(surface, ".dsws-check-grid").length === 0 && !headText.includes("wf.status"));

  // ---- P1-1:检查页可见拍 —— 页签可见时每 5 秒自问一次真实重扫,离页即停 ----
  const tickInterval = intervals.slice(intervalsBeforeChecks).find((it) => it.ms === 5000);
  check("打开检查页注册 5 秒可见拍(setInterval 5000ms)", !!tickInterval, JSON.stringify(intervals.slice(intervalsBeforeChecks).map((it) => ({ ms: it.ms, cleared: it.cleared }))));
  check("可见拍注册后未被清掉(页签仍在 checks)", !!tickInterval && !tickInterval.cleared);

  // 页面隐藏时这一拍跳过测量/重扫
  doc.visibilityState = "hidden";
  const callsBeforeHidden = chainCalls.length;
  if (tickInterval) tickInterval.fire();
  await settle();
  check("document.visibilityState=hidden 时这一拍不触发重扫", chainCalls.length === callsBeforeHidden, `${callsBeforeHidden} → ${chainCalls.length}`);
  doc.visibilityState = "visible";

  // 改 fake 链状态 → 手动跑一拍 → 面板跟着变(本地 Markdown 下每拍真重扫,与 0.6.1 一致;
  // GitHub 后端才改成缓存优先,那一路由 upstream-backend 套件的切片 6b 守)
  currentChain = CHAIN_C;
  const callsBeforeTick = chainCalls.length;
  if (tickInterval) tickInterval.fire();
  await settle();
  check("可见拍触发真实重扫(fake 工具被再次调用)", chainCalls.length === callsBeforeTick + 1, `${callsBeforeTick} → ${chainCalls.length}`);
  check("可见拍这一次带 force(绕本地缓存)", chainCalls[chainCalls.length - 1] && chainCalls[chainCalls.length - 1].args.force === true, JSON.stringify(chainCalls[chainCalls.length - 1] && chainCalls[chainCalls.length - 1].args));
  eq("可见拍重扫后面板跟着变(六步状态)", cards().map((n) => n.attributes["data-state"]), ["done", "current", "done", "done", "done", "done"]);
  check("可见拍重扫后头部计数 5/6", textOf(qsa(surface, ".dsws-body")[0]).includes("环境检查 5/6"), textOf(qsa(surface, ".dsws-body")[0]).slice(0, 120));

  // 切回列表:effect 收尾 clearInterval,旧回调再跑也不再触发工具
  fireClick(tabBtn("panel.tab.list"));
  await settle();
  eq("切回列表:st.tab = list", st && st.tab, "list");
  check("切回列表清除可见拍(clearInterval 被调)", !!tickInterval && tickInterval.cleared === true, JSON.stringify(tickInterval && { ms: tickInterval.ms, cleared: tickInterval.cleared }));
  const callsAfterLeave = chainCalls.length;
  if (tickInterval) tickInterval.fire();
  await settle();
  check("离页后旧回调不再触发重扫", chainCalls.length === callsAfterLeave, `${callsAfterLeave} → ${chainCalls.length}`);
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
