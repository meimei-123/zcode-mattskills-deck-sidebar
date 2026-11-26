// 工单 U04 列表页全家 + 页签壳 + KPI 头测试。
// 缝 = 对外可观察边界:
//   1) 构建缝:U04 叶子(列表页全家 + 页签壳)与追闭的 kernel/shared 叶子都登记进 LEAVES、
//      骨架留了标记、标记序仍是上游 index.ts 的保序子序列;
//   2) bundle 内容缝:视图叶子符号在、U03 卡面临时挂点已撤、宿主适配与桩在位、语法过;
//   3) 主视图缝:boot({fetchData:true}) 用 u04-list fixture(五个工作单元:容器三态 +
//      被阻塞子票 + 已认领票 + 已关闭票)真渲染 —— dsws-* 结构(页签/KPI/筛选/三段列表/
//      关闭票折叠/容器行三态)、筛选交互改变行集、KPI 与 kernel counts 对拍;
//   4) 翻页缝:关闭票折叠展开 → loadIssuePage → 上游 fetchIssuesPage → 宿主适配
//      wf.issuesPage → deck_issue_list(我们 list 工具口径的客户端分页);
//   5) 自检面缝:window.MattSkillsUpstream.list(U05 视图层的接口:ListTab/useTabsRow/
//      storeOf/renderInto)。
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
// fake DOM:U03 版之上补列表页要的最小查询面(class 选择器 + :not 链 + 属性选择器 +
// tag 选择器,作用于 document 与任意子树)与 clientWidth/scrollWidth(折叠测量读到 0)。
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
  // 最小选择器:空格分隔的后代段,每段 = tag? + (.cls | :not(.cls) | [attr="v"])+
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
  // Preact 注册的事件名保留原大小写(listeners.Click),兜底两种键;并模拟冒泡逐层触发
  // Preact 事件工厂:this.l[type + 捕获位] 取 handler;假 DOM 注册时保留原大小写(Click),
  // 真浏览器 addEventListener 大小写不敏感、事件 type 是小写 —— 假环境直接按注册名发
  ev.type = "Click";
  const handlerOf = (n) => {
    const props = (n && (n.l || n._)) || null;
    return props && (props.onClick || props.onclick) ? props.onClick || props.onclick : null;
  };
  const direct = handlerOf(node);
  if (typeof direct === "function") return direct.call(node, ev);
  // 兜底:传统 addEventListener 注册(旧 UI 与原生件)
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

// ---------------------------------------------------------------------------
// 切片 1:构建缝 —— U04 叶子登记 / 骨架标记序
// ---------------------------------------------------------------------------
const buildUpstream = await import(pathToFileURL(join(ROOT, "build-upstream.mjs")).href);
const U04_KERNEL_LEAVES = [
  "kernel:backendList",
  "kernel:link",
  "kernel:healthCheck",
  "kernel:promptsBackend",
  "kernel:config",
  "kernel:log",
  "kernel:storePrefs",
  "kernel:storeSnapshot",
  "kernel:workRouteOwn",
  "kernel:rowActions",
  "kernel:probeChain",
  "kernel:probeSnapshotHelpers",
  "kernel:router",
  "kernel:entryCard",
  "kernel:entryChoice",
  "kernel:apiNewSession",
  "kernel:apiIo",
  "kernel:actions",
];
const U04_SHARED_LEAVES = ["shared:namingTitles", "shared:refreshBudget"];
const U04_VIEW_LEAVES = [
  "leaf:tabs",
  "leaf:truthLines",
  "leaf:fallbackMark",
  "leaf:workRouteTable",
  "leaf:md",
  "leaf:ticket",
  "leaf:stateKind",
  "leaf:ticketRow",
  "leaf:tagsFit",
  "leaf:pop",
  "leaf:noRepoCard",
  "leaf:setupCard",
  "leaf:ListTabClosed",
  "leaf:ListTabRow",
  "leaf:listFilterRow",
  "leaf:mdEffortRow",
  "leaf:listTab",
];
{
  const ids = buildUpstream.LEAVES.map((l) => l.id);
  for (const id of [...U04_KERNEL_LEAVES, ...U04_SHARED_LEAVES, ...U04_VIEW_LEAVES]) {
    check(`LEAVES 登记 ${id}`, ids.includes(id));
  }
  const skeletonText = readFileSync(join(ROOT, "src", "ui", "upstream", "entry.mjs"), "utf8");
  const skelMarkers = buildUpstream.parseMarkers(skeletonText).map((m) => m.id);
  check(
    "entry.mjs 骨架标记是上游 index.ts 标记序的保序子序列",
    buildUpstream.isSubsequenceOf(skelMarkers, buildUpstream.upstreamMarkerOrder()),
    skelMarkers.join(" → ")
  );
  for (const id of [...U04_KERNEL_LEAVES, ...U04_SHARED_LEAVES, ...U04_VIEW_LEAVES]) {
    check(`骨架留了标记 ${id}`, skelMarkers.includes(id));
  }
}

// ---------------------------------------------------------------------------
// 切片 2:bundle 内容缝 —— 视图叶子符号 / 临时挂点已撤 / 适配与桩 / 语法
// ---------------------------------------------------------------------------
const code = existsSync(BUNDLE) ? readFileSync(BUNDLE, "utf8") : "";
check("dist/ui/bundle-1.txt 存在", existsSync(BUNDLE));
if (code) {
  const has = (name, re) => check(`bundle 含 ${name}`, re.test(code));
  // 列表页全家
  has("leaf:tabs(useTabsRow)", /useTabsRow/);
  has("leaf:truthLines(truthNoticeLines)", /truthNoticeLines/);
  has("leaf:fallbackMark(FallbackMark)", /FallbackMark/);
  has("leaf:workRouteTable(WORK_ROUTE_TABLE_FIELD)", /WORK_ROUTE_TABLE_FIELD/);
  has("leaf:md(MD_LINK_RE)", /MD_LINK_RE/);
  has("leaf:ticket(tProgressBar)", /tProgressBar/);
  has("leaf:stateKind(prStateKind)", /prStateKind/);
  has("leaf:ticketRow(TicketRow)", /TicketRow/);
  has("leaf:tagsFit(fitAllTags)", /fitAllTags/);
  has("leaf:pop(showPop)", /showPop/);
  has("leaf:noRepoCard(NoRepoCard)", /NoRepoCard/);
  has("leaf:setupCard(SetupLayoutCard)", /SetupLayoutCard/);
  has("leaf:ListTabClosed(closedPagesNode)", /closedPagesNode/);
  has("leaf:ListTabRow(listIssueRow)", /listIssueRow/);
  has("leaf:listFilterRow(listFilterRowNode)", /listFilterRowNode/);
  has("leaf:mdEffortRow(mdEffortRowNode)", /mdEffortRowNode/);
  has("leaf:listTab(ListTab 组件)", /const ListTab = /);
  // 追闭的 kernel 叶子(代表性符号)
  has("kernel:rowActions(mkRowAction)", /mkRowAction/);
  has("kernel:link(issueUrlFor)", /issueUrlFor/);
  has("kernel:storePrefs(setActiveIssue/listPrefs)", /setActiveIssue/);
  has("kernel:storeSnapshot(emit/sub 真源)", /const sub = \(st, f3\)/);
  has("kernel:router(newBugWayfinderText)", /newBugWayfinderText/);
  has("kernel:entryChoice(EntryChooser)", /const EntryChooser/);
  has("kernel:apiIo(fetchIssuesPage 上游真源)", /host\.call\(["']wf\.issuesPage["']/);
  has("kernel:probeChain(chainSteps)", /const chainSteps/);
  has("kernel:probeSnapshotHelpers(hexA/darken)", /const hexA/);
  has("shared:namingTitles(newSessionTitleNew)", /newSessionTitleNew/);
  has("shared:refreshBudget(freshnessLevel)", /function freshnessLevel|const freshnessLevel/);
  has("shared:timeConfig 全量(truthLines 的 PATCH_MERGE_WINDOW_MS)", /PATCH_MERGE_WINDOW_MS/);
  has("shared:timeConfig 全量(ListTabRow 的 COPY_FLASH_MS)", /COPY_FLASH_MS/);
  // U03 卡面临时挂点已撤
  check("U03 临时挂点(demoCardsNodes)已撤", !/demoCardsNodes/.test(code));
  // 宿主适配与桩(本仓装配段,带工单记号)
  has("宿主适配 host(wf.issuesPage → deck_issue_list)", /ZCode 宿主适配/);
  has("桩 snapFresh(U04 数据面 = boot/ingest)", /const snapFresh = function|U04 桩.*snapFresh|snapFresh.*U04 桩/s);
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
// 切片 3:主视图缝 —— boot({fetchData:true}) → 页签壳 + KPI + 筛选 + 三段列表
// ---------------------------------------------------------------------------
let U = null;
const doc = createFakeDom();
const toolCalls = [];
const sentMessages = []; // 体检按钮点击 → st.injector → sendMessage 的实参
{
  const { scanWorkspace, thinRow } = await import(pathToFileURL(join(ROOT, "src", "cards.mjs")).href);
  const { mapTicketsFor } = await import(pathToFileURL(join(ROOT, "src", "map-tickets.mjs")).href);
  const scan = scanWorkspace(join(ROOT, "test", "fixtures", "u04-list"));
  // 计数基准 = 非容器票(真 server computeCounts 口径:容器不进 total/open/closed)
  const tickets = scan.rows.filter((r) => r.type !== "map" && r.type !== "spec");
  const openN = tickets.filter((r) => r.state === "open").length;
  const closedN = tickets.filter((r) => r.state === "closed").length;
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
      "wayfinder:research": "0ea5e9",
      "wayfinder:prototype": "f59e0b",
      "wayfinder:grilling": "9d7cd8",
      "wayfinder:task": "10b981",
    },
  };
  const fakeClient = {
    readResource: async (uri) => {
      if (uri.endsWith("workspace.json")) return { contents: [{ text: JSON.stringify({ root: "X:/u04", env: {} }) }] };
      throw new Error("no asset " + uri);
    },
    callTool: async (name, args) => {
      toolCalls.push({ name, args: args || {} });
      if (name === "deck_issue_list") return { structuredContent: { rows: scan.rows.map(thinRow), revision: 1 } };
      if (name === "deck_issue_counts") return { structuredContent: { counts: { open: openN, closed: closedN, total: tickets.length }, revision: 1 } };
      if (name === "deck_issue_list_labels") return { structuredContent: LABEL_PALETTE };
      // M4:地图详情页进页必问的电话 —— 直接走真解析器(src/map-tickets.mjs),不手搓回包;
      // 契约形状由 server-map 套件看守,这里要的是「页面吃到真形状也能画对」。
      if (name === "deck_map_tickets") return { structuredContent: mapTicketsFor({ rows: scan.rows }, args) };
      throw new Error("no tool " + name);
    },
    sendMessage: async (text) => {
      sentMessages.push(String(text));
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
  // 期望值独立来源:fixture 行面(scanWorkspace)
  globalThis.__u04 = { openN, closedN, total: tickets.length };
}

if (U) {
  const surface = doc.body.children[0]; // #dsws-surface
  const panel = qsa(surface, ".dsws-panel")[0];
  check("面板壳 dsws-panel 在", !!panel);
  const st = U.list ? U.list.storeOf() : null;
  check("list.storeOf() 给出已接驳的 store(有 snapshot)", !!(st && st.snapshot));

  // ---- 页签壳:useTabsRow 的三枚常驻页签 + 能力门控页签缺席 + 列表页签选中 ----
  const tabsRow = qsa(surface, ".dsws-tabs")[0];
  check("页签行 dsws-ink-host 在(tabs 壳)", !!tabsRow);
  if (tabsRow) {
    const tabBtn = (log) => walk(tabsRow).filter((n) => n.attributes["data-log"] === log && n.tagName === "BUTTON")[0];
    for (const id of ["panel.tab.list", "panel.tab.skills", "panel.tab.checks", "panel.tab.versioncontrol"]) {
      check(`页签 ${id} 在`, !!tabBtn(id));
    }
    check("拉取请求页签缺席(能力门控:prTabVisible 未搬,typeof 守卫走缺省)", !tabBtn("panel.tab.pr"));
    const listTab = tabBtn("panel.tab.list");
    check("列表页签选中(dsws-tab on)", listTab && String(listTab.attributes["class"]).includes("on"));
    check("新建需求入口在(panel.newwayfinder)", !!walk(tabsRow).find((n) => n.attributes["data-log"] === "panel.newwayfinder"));
    check("+ bug 入口在(panel.newbug)", !!walk(tabsRow).find((n) => n.attributes["data-log"] === "panel.newbug"));
    check("入口浮层宿主 EntryChooser 挂进页签行(上游 #1297:无条件挂一份)", textOf(tabsRow) !== null && walk(tabsRow).length > 0);
  }

  // ---- KPI 头:三枚读数与 kernel 对拍(期望值 = fixture 行面独立清点) ----
  const kpiRow = qsa(surface, '[data-list-head="kpi"]')[0];
  check("KPI 行在(data-list-head=kpi)", !!kpiRow);
  if (st) {
    const mm = (st.snapshot.maps || []).find((m) => String(m.effortId) === "dogfood-test");
    const t02 = mm && mm.tickets && mm.tickets.find((x) => String(x.key) === "02");
    const open = U.kernel.openIssuesOf(st);
    const r02 = open.find((x) => String(x.effortId) === "dogfood-test" && String(x.key) === "02");
  }
  if (kpiRow && st) {
    const { openN, closedN } = globalThis.__u04;
    // 占用 = open 行里 isOccupied(已认领或有 open 阻塞者):dogfood-test/02(被 01 阻塞)+ m2/02(认领 dev)
    const kpiText = textOf(kpiRow);
    check(`KPI 可接 = ${openN - 2}(后端 open ${openN} − 占用 2)`, kpiText.includes(`${openN - 2} 可接`), kpiText);
    check("KPI 阻塞 = 2(被阻塞 1 + 已认领 1)", kpiText.includes("2 阻塞"), kpiText);
    check(`KPI 已关闭 = ${closedN}(counts 契约)`, kpiText.includes(`${closedN} 已关闭`), kpiText);
    // 对拍:同一 st 上 kernel 口径重算
    const open = U.kernel.openIssuesOf(st);
    const occ = open.filter((x) => U.kernel.isOccupied(st, x)).length;
    const dc = U.kernel.deckCountsOf(st, false);
    eq("kernel 对拍:openIssuesOf 条数(面板池含 4 个开放容器,上游 KPI 靠 deck.counts 兜底)", open.length, openN + 4);
    eq("kernel 对拍:占用数", occ, 2);
    eq("kernel 对拍:deckCounts closed", dc && dc.closed, closedN);
    eq("kernel 对拍:KPI 可接投影", dc ? Math.max(0, dc.open - occ) : null, openN - 2);

    // ---- 体检按钮(上游 #685):KPI 行右端的门 / 件数 / 点击注入 ----
    // 门的三条判据全读现成数据:当前后端身份、快照里已有关联仓库、后端声明了体检科目。
    // 本地 markdown 后端在 ingest 的 backendModules 里声明了 prompts.healthCheck(科目原文
    // 照搬上游 rooms/markdown),三条才都成立 —— 这也是与上游按钮像素对齐的最后一环。
    check("healthCheckVisible:本地 markdown 后端点亮体检按钮", U.kernel.healthCheckVisible(st) === true);
    check(
      "没声明体检科目 → 整颗不渲染",
      U.kernel.healthCheckVisible(Object.assign({}, st, { backendModules: [{ id: "markdown", capabilities: {} }] })) === false
    );
    check(
      "没关联仓库(snapshot.repository 缺)→ 整颗不渲染",
      U.kernel.healthCheckVisible(Object.assign({}, st, { snapshot: Object.assign({}, st.snapshot, { repository: null }) })) === false
    );
    check(
      "没绑定后端(selection 缺)→ 整颗不渲染",
      U.kernel.healthCheckVisible(Object.assign({}, st, { selection: null, snapshot: Object.assign({}, st.snapshot, { selection: null }) })) === false
    );
    // 件数口径 #678:未关闭 + 不是地图/规格 + 不在任何地图的子票里。
    // fixture 独立清点:只有 m2-planning 的 01/02 是开放孤儿票(其余开放票都挂在容器下)。
    const hcBtn = walk(kpiRow).find((n) => n.tagName === "BUTTON" && n.attributes["data-log"] === "list.healthcheck");
    check("体检按钮在 KPI 行(list.healthcheck)", !!hcBtn);
    check("体检件数 = 2(两张开放孤儿票)", hcBtn ? textOf(hcBtn).includes("体检 2") : false, hcBtn ? textOf(hcBtn) : "");
    eq("kernel 件数与 fixture 清点一致", U.kernel.healthCheckCountOf(st), 2);
    // 点击:走「+ 新建需求」同一条开新会话路(seam 的 sessions.create 缺席 → 与行级
    // 「新会话」按钮同口径,回落注入当前对话);提示词 = 体检总纲 + 当前后端科目。
    if (hcBtn) {
      const before = sentMessages.length;
      fireClick(hcBtn);
      await tick();
      check("点体检发话恰好一条", sentMessages.length === before + 1, `+${sentMessages.length - before}`);
      const txt = sentMessages[sentMessages.length - 1] || "";
      check("注入的是体检总纲(## 体检（把游离的开放票归位）)", txt.includes("## 体检（把游离的开放票归位）"));
      check("总纲带上本地后端科目(文件级游离/断链判据)", txt.includes("本后端的票就是工作区里的文件") && txt.includes("断链"));
      check("模板占位符已填净(无 {subject})", !txt.includes("{subject}"));
    }
  }

  // ---- 筛选行:状态/排序/标签三组 + 墨块宿主 ----
  const filterRow = qsa(surface, ".dsws-ink-host").find((n) => n !== tabsRow);
  check("筛选行在(dsws-ink-host)", !!filterRow);
  if (filterRow) {
    const chip = (log) => walk(filterRow).filter((n) => n.attributes["data-log"] === log)[0];
    for (const k of ["all", "open", "closed", "blocked", "frontier"]) {
      check(`状态筛选 ${k} 在`, !!chip(`list.filter.state.${k}`));
    }
    for (const k of ["updatedAt", "createdAt", "number", "title"]) {
      check(`排序筛选 ${k} 在`, !!chip(`list.filter.sort.${k}`));
    }
    check("标签组「全部」在", walk(filterRow).some((n) => textOf(n) === "全部" && n.attributes["data-press"] === "chip"));
    check("标签 bug 药丸在(fixture 有 bug 标签)", walk(filterRow).some((n) => textOf(n) === "bug"));
    const numberChip = chip("list.filter.sort.number");
    check("默认排序档「编号」选中(墨块 on)", numberChip && String(numberChip.attributes["class"]).includes("dsws-ink-on"), numberChip && numberChip.attributes["class"]);
  }

  // ---- md 目录签行(五工作单元 → multiEffort) ----
  const mdRow = walk(surface).find((n) => textOf(n).includes("dogfood-test") && n.attributes["data-press"] === "chip");
  check("md 目录签行在(dogfood-test 选项)", !!mdRow);

  // ---- 三段列表:容器(地图 3 + 规格 1)→ 普通开票 5;关闭票折叠行 ----
  const body = qsa(surface, ".dsws-body")[0];
  // 行数口径:<details> 折叠区的 closed 行常驻 DOM(上游行为);开票行数只数折叠子树之外的行
  const foldEl = walk(surface).find((n) => n.tagName === "DETAILS");
  const inFold = (n) => { let c = n; while (c) { if (c === foldEl) return true; c = c.parentNode; } return false; };
  const rows = qsa(surface, ".dsws-aggrow").filter((r) => !inFold(r));
  const rowsNow = () => {
    const foldNow = walk(surface).find((n) => n.tagName === "DETAILS");
    const inNow = (n) => { let c = n; while (c) { if (c === foldNow) return true; c = c.parentNode; } return false; };
    return qsa(surface, ".dsws-aggrow").filter((r) => !inNow(r));
  };
  eq("开票行数(默认 all:地图 3 + 规格 1 + 普通 5)", rows.length, 9);
  const containerRows = rows.filter((r) => String(r.style.borderLeft || "").startsWith("3px solid"));
  eq("容器行数(左边框 3px accent)", containerRows.length, 4);
  const ringTexts = rows.map((r) => {
    const ring = qsa(r, ".dsws-ring")[0];
    return ring ? textOf(qsa(ring, ".dsws-ring-txt")[0] || ring) : "";
  });
  check("在办地图圆环 1/3(dogfood-test:3 子票 1 关)", ringTexts.includes("1/3"), JSON.stringify(ringTexts));
  check("全关地图圆环 2/2(dogfood-done)", ringTexts.includes("2/2"), JSON.stringify(ringTexts));
  check("规格圆环 0/1(dogfood-spec)", ringTexts.includes("0/1"), JSON.stringify(ringTexts));
  // 容器三态主按钮:空态=检查(橙)、全关=完成(绿)、在办=执行;规格在办=执行
  const btnTextOf = (row) => {
    const btns = walk(row).filter((n) => n.tagName === "BUTTON" && n.attributes["class"] && String(n.attributes["class"]).includes("primary"));
    return btns.map((b) => textOf(b));
  };
  const rowByTitle = (t) => rows.find((r) => textOf(r).includes(t));
  const mapDoing = rowByTitle("列表页搬入地图");
  const mapDone = rowByTitle("kernel 域搬入");
  const mapEmpty = rowByTitle("详情页侦查");
  const specDoing = rowByTitle("面板保真度规格");
  check("在办地图主按钮 = 执行", mapDoing && btnTextOf(mapDoing).some((t) => t.includes("执行")), mapDoing && JSON.stringify(btnTextOf(mapDoing)));
  check("全关地图主按钮 = 完成", mapDone && btnTextOf(mapDone).some((t) => t.includes("完成")), mapDone && JSON.stringify(btnTextOf(mapDone)));
  check("空态地图主按钮 = 检查", mapEmpty && btnTextOf(mapEmpty).some((t) => t.includes("检查")), mapEmpty && JSON.stringify(btnTextOf(mapEmpty)));
  check("在办规格主按钮 = 执行", specDoing && btnTextOf(specDoing).some((t) => t.includes("执行")), specDoing && JSON.stringify(btnTextOf(specDoing)));
  // 被阻塞药丸(dogfood-test/02 被 #01 阻塞)
  const blockedRow = rows.find((r) => textOf(r).includes("工具数据接上游状态机"));
  check("被阻塞行有 dsws-blocked 药丸", blockedRow && qsa(blockedRow, ".dsws-blocked").length === 1);
  // 已认领行的作者头像环(m2/02 claimed dev)
  const claimedRow = rows.find((r) => textOf(r).includes("U05 详情页"));
  check("已认领行有作者头像(16px 圆;上游无 avatarUrl 时渲同尺寸圆 span)", claimedRow && walk(claimedRow).some((n) => ((n.tagName === "IMG" && n.attributes.src) || n.tagName === "SPAN") && String(n.style.width) === "16px" && String(n.style.borderRadius) === "50%"));
  // 关闭票折叠行(默认 all + 有关闭票)
  const fold = walk(surface).find((n) => n.attributes["data-log"] === "list.fold.closed");
  check("关闭票折叠行在(list.fold.closed)", !!fold);
  if (fold) {
    const { closedN } = globalThis.__u04;
    check(`折叠行文案「已关闭 ${closedN}(已加载 0)」`, textOf(fold).includes(`已关闭 ${closedN}`), textOf(fold));
  }

  // ---- 交互:状态筛选切「已关闭」→ 关闭票列表出现(翻页通路接 deck_issue_list) ----
  if (filterRow) {
    // 现查版 chip:重渲替换节点后,旧闭包节点上的监听已被 Preact 卸除,点击会静默失效
    const chip = (log) => walk(surface).filter((n) => n.attributes["data-log"] === log)[0];
    const stateClosed = chip("list.filter.state.closed");
    if (stateClosed.l)    fireClick(stateClosed);
    await new Promise((r) => setTimeout(r, 30));
    if (U.kernel && typeof U.kernel.emit === "function") { U.kernel.emit(st); await new Promise((r) => setTimeout(r, 60)); }
    const closedRows = qsa(surface, ".dsws-aggrow");
    const { closedN } = globalThis.__u04;
    check(`切「已关闭」后行集变成关闭票(${closedN} 行)`, closedRows.length === closedN, String(closedRows.length));
    check("已关闭行带「已关闭」chip(map.subClosed)", closedRows.every((r) => textOf(r).includes("已关闭")));
    // 翻页缝:closed 6 行 < 上游页大小,本视图不触发 loadIssuePage(上游行为:翻页只在行数吃满页时发)——
    // host 适配 wf.issuesPage→deck_issue_list 的契约由骨架段 bundle 断言与 issuesPageOverList 源头保障。
    // 切回「全部」
    fireClick(chip("list.filter.state.all"));
    await new Promise((r) => setTimeout(r, 30));
    eq("切回「全部」恢复开票 9 行(开票行,不含折叠常驻)", rowsNow().length, 9);

    // ---- 交互:标签多选(OR)→ 已选标签过滤条 + 行集变化 ----
    const bugPill = walk(surface).find((n) => /^list\.filter\.label\./.test(String(n.attributes["data-log"] || "")) && textOf(n) === "bug"); // 现查:陈旧节点的监听会被 Preact 卸除
    fireClick(bugPill);
    await tick();
    const filterActive = walk(surface).find((n) => n.attributes["data-log"] === "list.filter.clear");
    check("已选标签过滤条出现(清除药丸)", !!filterActive);
    eq("bug 标签过滤后开票行集 = 1(骨架 tracer;容器不受标签筛,上游口径)", rowsNow().filter((r) => !String(r.style.borderLeft || "").startsWith("3px solid")).length, 1);
    // 点击记忆:labelClicks 记了 bug
    const lc = U.list && U.list.labelClicksOf ? U.list.labelClicksOf() : null;
    eq("点击记忆 labelClicks.bug.n = 1(闭包级内存表,上游口径)", lc && lc.bug && lc.bug.n, 1);
    fireClick(filterActive); // 清除
    await tick();
    eq("清除标签过滤恢复 9 行(开票行)", rowsNow().length, 9);

    // ---- 交互:排序翻转(点同键,编号 ↑/↓) ----
    const numberChip = chip("list.filter.sort.number");
    fireClick(numberChip);
    await tick();
    check("排序翻转后方向标记出现在药丸文本(↑/↓)", /↑|↓/.test(textOf(numberChip)), textOf(numberChip));
  }

  // ---- 页签切换:技能页签是真目录(工单 02 起)、切回列表(壳保序) ----
  if (tabsRow) {
    const tabBtn = (log) => walk(tabsRow).filter((n) => n.attributes["data-log"] === log && n.tagName === "BUTTON")[0];
    fireClick(tabBtn("panel.tab.skills"));
    await tick();
    if (st) eq("页签壳状态:st.tab = skills", st.tab, "skills");
    else check("页签壳状态:st.tab = skills", false, "st 缺席");
    check("技能页签渲染上游技能目录(占位已撤)",
      qsa(surface, ".pixel-skillrow").length === 27 && !textOf(body).includes("U06"),
      `rows=${qsa(surface, ".pixel-skillrow").length} text=${textOf(body).slice(0, 40)}`);
    fireClick(tabBtn("panel.tab.list"));
    await tick();
    eq("切回列表恢复三段列表(开票行)", rowsNow().length, 9);

    // ---- 工单 04 收口:pr 无能力兜底 ----
    // 本地后端没有 PR 能力,prTabVisible 缺席 → 页签不渲染;状态若落到 pr,分发必须回列表
    // 真视图(上游 Dock.ts 同款),不能落回占位。借上游 emit(setActiveIssue 清空导航)重画。
    if (st) {
      st.tab = "pr";
      U.list.rowHelpers.setActiveIssue(st, null);
      await tick();
      await new Promise((r) => setTimeout(r, 30)); // 等合批重画落定
      eq("pr 状态保留(无能力不静默改写 st.tab)", st.tab, "pr");
      check("pr 无能力时渲染回列表真视图(KPI 行在)", qsa(surface, '[data-list-head="kpi"]').length >= 1);
      check("pr 兜底不出占位文案(无 U06+ 搬入)", !textOf(body).includes("U06+ 搬入"));
      check("pr 兜底行集仍是开票 9 行", rowsNow().length === 9, String(rowsNow().length));
      st.tab = "list";
      U.list.rowHelpers.setActiveIssue(st, null);
      await tick();
    }
  }

  // ---- 样式:上游 STYLE_TEXT 仍在 head(令牌族) ----
  const styleTexts = doc.head.children.map((n) => n.textContent || "");
  check("STYLE_TEXT(--dsw-* 令牌族)仍在 head", styleTexts.some((t) => t.includes("dsws-panel")));

  // ---------------------------------------------------------------------------
  // 切片 M4:地图详情页 —— 点容器行进 MapDetailV2Page、按需取数、卡片流、返回
  // ---------------------------------------------------------------------------
  {
    // dogfood-test 地图:3 张子票 1 张已关;快照只装开子票(01/02),已关闭那张靠取数补
    const mapRow = walk(surface).find(
      (n) => n.attributes["data-log"] === "list.row.00" && textOf(n).includes("列表页搬入地图")
    );
    check("地图行可点(list.row.00 且标题在)", !!mapRow);
    if (mapRow) {
      fireClick(mapRow);
      await tick();
      await new Promise((r) => setTimeout(r, 40));
      const page = qsa(surface, ".m2v2-page")[0];
      check("点地图行渲染 MapDetailV2Page(.m2v2-page)", !!page);
      if (page) {
        const pageText = textOf(page);
        check("详情页标题在(.m2v2-title)", qsa(page, ".m2v2-title").length >= 1 && pageText.includes("列表页搬入地图"));
        check("档案区「本图 3 张子票（已关闭 1 张）」", /本图 3 张子票（已关闭 1 张）/.test(pageText), pageText.slice(0, 160));
        check("档案区渲染地图目的地(## Destination)", pageText.includes("把上游列表页搬进 ZCode 面板"), pageText.slice(0, 240));
        check("卡片流存在(.m2v2-flow)", qsa(page, ".m2v2-flow").length >= 1);
        check("快照外的已关闭子票经按需取数补进页里(面板壳上线)", pageText.includes("面板壳上线"), pageText.slice(0, 400));
        const mtCall = toolCalls.filter((c) => c.name === "deck_map_tickets").pop();
        check(
          "取数电话 wf.mapTickets → deck_map_tickets(key=00, effortId=dogfood-test)",
          !!mtCall && mtCall.args.key === "00" && mtCall.args.effortId === "dogfood-test",
          JSON.stringify(mtCall && mtCall.args)
        );
        // 档案区:点整块进这张地图自己的 issue 详情页(导航栈压一层),返回回地图页
        const archive = walk(surface).find((n) => n.attributes["data-log"] === "mapv2.archive.open");
        check("档案区可点(mapv2.archive.open)", !!archive);
        if (archive) {
          fireClick(archive);
          await tick();
          await new Promise((r) => setTimeout(r, 40));
          check("点档案进地图自己的详情页(issue.top.back 在)", !!walk(surface).find((n) => n.attributes["data-log"] === "issue.top.back"));
          check("进入票详情后地图页卸掉", qsa(surface, ".m2v2-page").length === 0);
          const issueBack = walk(surface).find((n) => n.attributes["data-log"] === "issue.top.back");
          if (issueBack) {
            fireClick(issueBack);
            await tick();
            await new Promise((r) => setTimeout(r, 40));
            check("从票详情返回地图详情页(.m2v2-page 回)", qsa(surface, ".m2v2-page").length >= 1);
          }
        }
        // 返回:顶栏返回键弹栈回列表
        const back = walk(page).find((n) => n.attributes["data-log"] === "map.top.back");
        check("顶栏返回键在(map.top.back)", !!back);
        if (back) {
          fireClick(back);
          await tick();
          await new Promise((r) => setTimeout(r, 40));
          check("返回后回列表(KPI 行在)", qsa(surface, '[data-list-head="kpi"]').length >= 1);
          check("返回后详情页卸掉", qsa(surface, ".m2v2-page").length === 0);
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 切片 5:自检面缝 —— U.list(U05 视图层接口)
  // ---------------------------------------------------------------------------
  const L = U.list;
  check("MattSkillsUpstream.list 存在", !!L);
  if (L) {
    for (const k of ["ListTab", "useTabsRow", "storeOf", "renderInto"]) {
      check(`list.${k} 在`, L[k] !== undefined);
    }
    // renderInto:把 ListTab 挂到任意容器(U05 详情页等复用同一挂法)
    const box = doc.createElement("div");
    doc.body.appendChild(box);
    try {
      L.renderInto(L.ListTab, box, { st, narrow: false });
      await tick();
      check("list.renderInto(ListTab) 渲染出 KPI 行", qsa(box, '[data-list-head="kpi"]').length >= 1);
    } catch (e) {
      check("list.renderInto(ListTab) 可用", false, String(e && e.message));
    }
  }
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
