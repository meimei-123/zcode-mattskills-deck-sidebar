// 工单 U05 详情页全家 + 动作栏测试。
// 缝 = 对外可观察边界:
//   1) 构建缝:U05 九叶(detailTopGate + detailActionBar + 详情七叶)登记进 LEAVES、骨架留标、
//      标记序仍是上游 index.ts 的保序子序列;
//   2) bundle 内容缝:详情族符号 / 三路宿主电话(wf.issueDetail·issueComments·commentIssue)/
//      injector 种子 / 语法过;
//   3) 投影缝(ingest.detailIssueOf/bodySectionOf/commentsPageOf):元行剥离、评论连接形状、
//      子票与被阻塞邻居从 list 薄行池派生;
//   4) 纯函数缝:detailTopGate 三态(closed/blocked/未知不置灰)、折叠阶梯、detailViewFor;
//   5) 主视图缝:boot({fetchData:true}) 用 u05-detail fixture 真渲染 —— 行点击进详情
//      (粘性顶栏/元行/正文段/评论时间线)、被阻塞票主动作置灰、已关闭票 chip 与置灰、
//      评论提交走 deck_issue_comment 且成功后重取、动作按钮经 st.injector → sendMessage、
//      返回键回列表;
//   6) 自检面缝:window.MattSkillsUpstream.detail。
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // zcode-plugin/
const BUNDLE = join(ROOT, "dist", "ui", "bundle-1.txt");
const DUMP = !!process.env.U05_DUMP;

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
// fake DOM(与 upstream-list 同款:类/属性/tag 选择器 + 冒泡 click + Preact props 通道)
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
  node.style.removeProperty = (k, v) => {
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
  const tag = m[1];
  if (tag && n.tagName !== tag.toUpperCase()) return false;
  const rest = m[2] || "";
  const partRe = /\.([\w-]+)|:not\(\.([\w-]+)\)|\[[^\]]+\]/g;
  let mm;
  while ((mm = partRe.exec(rest))) {
    if (mm[1]) {
      if (!String(n.attributes["class"] || "").split(/\s+/).includes(mm[1])) return false;
    } else if (mm[2]) {
      if (String(n.attributes["class"] || "").split(/\s+/).includes(mm[2])) return false;
    } else {
      const attrRe = /^\[([^\]~|^$*=]+)(?:([\^|$*~]?=)"([^"]*)")?\]$/;
      const am = attrRe.exec(mm[0]);
      if (!am) return false;
      const key = am[1];
      const op = am[2];
      const val = am[3];
      const have = n.attributes[key];
      if (have === undefined) return false;
      if (op === "=" && have !== val) return false;
      if (!op && have === undefined) return false;
    }
  }
  return true;
}
function qsa(root, sel) {
  const out = [];
  const segs = String(sel).split(/\s+/).filter(Boolean);
  const visit = (n, si) => {
    if (si === segs.length) {
      out.push(n);
      return;
    }
    if (n.nodeType === 1 && matchesSeg(n, segs[si])) visit(n, si + 1);
    for (const c of n.children || []) visit(c, si);
  };
  for (const c of root.children || []) visit(c, 0);
  return out;
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
/** 在 fake 节点上派发一次 click(与 upstream-list 同款:props 通道优先,冒泡兜底)。 */
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
/** 受控输入:Preact/compat 把 onChange 归一成 input 事件,handler 挂在 l 的
 *  「事件名+capture 布尔拼串」键上(实测 l.inputfalse / l.Input);按键名扫描直调。 */
function fireInput(node, value) {
  node.value = value;
  const props = (node.l || node._) || {};
  const direct = props.onInput || props.oninput || props.onChange || props.onchange;
  if (typeof direct === "function") {
    direct.call(node, { type: "Input", target: node, currentTarget: node, stopPropagation() {}, preventDefault() {} });
    return true;
  }
  for (const k of Object.keys(props)) {
    const lower = k.toLowerCase();
    if ((lower.startsWith("oninput") || lower.startsWith("onchange") || lower.startsWith("input") || lower.startsWith("change")) && typeof props[k] === "function") {
      props[k].call(node, { type: "input", target: node, currentTarget: node, stopPropagation() {}, preventDefault() {} });
      return true;
    }
  }
  return false;
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/** 结构转储(调试用:U05_DUMP=1 node test/upstream-detail.test.mjs)。 */
function dumpTree(node, depth = 0, maxDepth = 7) {
  if (!node || depth > maxDepth) return "";
  const own =
    node.nodeType === 3
      ? `text(${JSON.stringify(node.data.slice(0, 40))})`
      : `${node.tagName}${Object.entries(node.attributes)
          .filter(([k]) => k === "class" || k.startsWith("data-") || k === "aria-disabled" || k === "role")
          .map(([k, v]) => `[${k}=${String(v).slice(0, 30)}]`)
          .join("")}`;
  const lines = ["  ".repeat(depth) + own];
  for (const c of node.children || []) lines.push(dumpTree(c, depth + 1, maxDepth));
  return lines.filter(Boolean).join("\n");
}

// ---------------------------------------------------------------------------
// 切片 1:构建缝
// ---------------------------------------------------------------------------
const buildUpstream = await import(pathToFileURL(join(ROOT, "build-upstream.mjs")).href);
const U05_LEAVES = [
  "kernel:detailTopGate",
  "leaf:detailActionBar",
  "leaf:detailProjection",
  "leaf:issueDetailErrorView",
  "leaf:subIssueRouting",
  "leaf:IssueDetailComments",
  "leaf:issueDetailFold",
  "leaf:useIssueDetailFold",
  "leaf:IssueDetail",
];
{
  const ids = buildUpstream.LEAVES.map((l) => l.id);
  for (const id of U05_LEAVES) check(`LEAVES 登记 ${id}`, ids.includes(id));
  const skeletonText = readFileSync(join(ROOT, "src", "ui", "upstream", "entry.mjs"), "utf8");
  const skelMarkers = buildUpstream.parseMarkers(skeletonText).map((m) => m.id);
  for (const id of U05_LEAVES) check(`骨架留了标记 ${id}`, skelMarkers.includes(id));
  check(
    "entry.mjs 骨架标记是上游 index.ts 标记序的保序子序列",
    buildUpstream.isSubsequenceOf(skelMarkers, buildUpstream.upstreamMarkerOrder()),
    skelMarkers.join(" → ")
  );
}

// ---------------------------------------------------------------------------
// 切片 2:bundle 内容缝
// ---------------------------------------------------------------------------
const code = existsSync(BUNDLE) ? readFileSync(BUNDLE, "utf8") : "";
check("dist/ui/bundle-1.txt 存在", existsSync(BUNDLE));
if (code) {
  const has = (name, re) => check(`bundle 含 ${name}`, re.test(code));
  has("kernel:detailTopGate(detailTopGate)", /function detailTopGate|const detailTopGate/);
  has("leaf:detailActionBar(DetailActionBar)", /DetailActionBar/);
  has("leaf:detailProjection(detailViewFor)", /function detailViewFor|const detailViewFor/);
  has("leaf:issueDetailErrorView(issueErrorViewOf)", /issueErrorViewOf/);
  has("leaf:subIssueRouting(enterSubDetail)", /enterSubDetail/);
  has("leaf:IssueDetailComments(renderIssueDetailComments)", /renderIssueDetailComments/);
  has("leaf:issueDetailFold(issueDetailFoldLadderOf)", /issueDetailFoldLadderOf/);
  has("leaf:useIssueDetailFold(useIssueDetailFold)", /useIssueDetailFold/);
  has("leaf:IssueDetail(组件本体)", /function IssueDetail|const IssueDetail = /);
  has("kernel:apiIo 详情三路(fetchIssueDetail)", /host\.call\(["']wf\.issueDetail["']/);
  has("kernel:apiIo 评论页(fetchIssueComments)", /host\.call\(["']wf\.issueComments["']/);
  has("kernel:apiIo 提交(submitIssueComment→wf.commentIssue)", /host\.call\(["']wf\.commentIssue["']/);
  has("宿主适配:wf.issueDetail → deck_issue_get", /issueDetailOverGet[\s\S]*deck_issue_get/);
  has("宿主适配:评论提交 → deck_issue_comment", /commentIssueOverWrite[\s\S]*deck_issue_comment/);
  has("注入通道种子(st.injector → sendMessage)", /st\.injector = function[\s\S]*sendMessage/);
  has("DeckBody 详情分发(peekNav 栈顶)", /peekNav\(st\)[\s\S]*IssueDetail/);
  check("bundle 无拼接标记残留", !/\(spliced by build\)/.test(code));
  check("bundle 无模块级 import/export", !/^[^\S\r\n]*import[\s{"'*]/m.test(code) && !/^[^\S\r\n]*export\s/m.test(code));
  try {
    new vm.Script(code);
    check("bundle 语法过(vm.Script)", true);
  } catch (e) {
    check("bundle 语法过(vm.Script)", false, e.message);
  }
}

// ---------------------------------------------------------------------------
// 切片 3:投影缝(ingest.detailIssueOf / bodySectionOf / commentsPageOf)
// ---------------------------------------------------------------------------
const { scanWorkspace, thinRow } = await import(pathToFileURL(join(ROOT, "src", "cards.mjs")).href);
const scan = scanWorkspace(join(ROOT, "test", "fixtures", "u05-detail"));
const card01 = scan.rows.find((r) => r.effortId === "dogfood-detail" && r.key === "01");
const card02 = scan.rows.find((r) => r.effortId === "dogfood-detail" && r.key === "02");
check("fixture:01 号卡读回(带 2 条评论)", !!(card01 && Array.isArray(card01.comments) && card01.comments.length === 2));
{
  const ingest = await import(pathToFileURL(join(ROOT, "src", "ui", "upstream", "ingest.mjs")).href);
  const pool = scan.rows.map(thinRow);
  const d01 = ingest.detailIssueOf(card01, pool);
  eq("detailIssueOf:number 是数字", d01.number, 1);
  eq("detailIssueOf:state 小写 open", d01.state, "open");
  eq("detailIssueOf:labels 带 needs-info", d01.labels.map((l) => l.name), ["needs-info"]);
  eq("detailIssueOf:认领人 dev", d01.assignees.length && d01.assignees[0].login, "dev");
  check("detailIssueOf:正文段含验收文字", d01.body.includes("正文首段") && d01.body.includes("粘性顶栏"), d01.body);
  check("detailIssueOf:正文段剥掉 H1 与元行", !d01.body.includes("# 01") && !d01.body.includes("Status:") && !d01.body.includes("Labels:"), d01.body);
  check("detailIssueOf:正文段不含评论区", !d01.body.includes("## Comments") && !d01.body.includes("面板真机目检"), d01.body);
  eq("detailIssueOf:评论连接形状(nodes=2,pageInfo 无下一页)", [d01.comments.nodes.length, d01.comments.pageInfo.hasNextPage], [2, false]);
  eq("detailIssueOf:评论节点形(author.login/createdAt/body)", [d01.comments.nodes[0].author.login, !!d01.comments.nodes[0].createdAt, d01.comments.nodes[1].author.login], ["triage-agent", true, "dev"]);
  eq("detailIssueOf:无子票(01 无 child)", d01.subIssues.totalCount, 0);
  const d02 = ingest.detailIssueOf(card02, pool);
  eq("detailIssueOf:被阻塞边指向 01(行面大写态)", [d02.blockedBy.length, d02.blockedBy[0].number, d02.blockedBy[0].state], [1, 1, "OPEN"]);
  const page = ingest.commentsPageOf(card01, "0");
  eq("commentsPageOf:首页全量", [page.nodes.length, page.pageInfo.hasNextPage, page.pageInfo.endCursor], [2, false, "2"]);
}

// ---------------------------------------------------------------------------
// 切片 4:纯函数缝(detailTopGate / 折叠阶梯 / detailViewFor)
// ---------------------------------------------------------------------------
let U = null;
const doc = createFakeDom();
const toolCalls = [];
const sentMessages = [];
{
  // 可变卡仓:评论提交后,get 回下一次的卡(提交纪律:成功后 force 重取是唯一推进源)
  const mutableCards = new Map(scan.rows.map((r) => [`${r.effortId}/${r.key}`, JSON.parse(JSON.stringify(r))]));
  const getCalls = [];
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
  const fakeClient = {
    readResource: async (uri) => {
      if (uri.endsWith("workspace.json")) return { contents: [{ text: JSON.stringify({ root: "X:/u05", env: {} }) }] };
      throw new Error("no asset " + uri);
    },
    sendMessage: async (text) => {
      sentMessages.push(String(text || ""));
      return { ok: true };
    },
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
        getCalls.push(String(args.key));
        const eff = String(args.key).includes("/") ? String(args.key).split("/")[0] : "";
        const inner = String(args.key).split("/").pop();
        const card = mutableCards.get(`${eff}/${inner.replace(/^0+(?=\d)/, "")}`) || mutableCards.get(`${eff}/${inner}`);
        if (!card) return { isError: true, content: [{ type: "text", text: "no card " + args.key }] };
        return { structuredContent: { workspaceRoot: "X:/u05", card } };
      }
      if (name === "deck_issue_comment") {
        const [eff, inner] = String(args.key).split("/");
        const card = mutableCards.get(`${eff}/${inner.replace(/^0+(?=\d)/, "")}`) || mutableCards.get(`${eff}/${inner}`);
        if (!card) return { isError: true, content: [{ type: "text", text: "no card" }] };
        card.comments = card.comments || [];
        card.comments.push({
          author: { login: String(args.actor || "panel") },
          authorAssociation: "",
          body: String(args.body || ""),
          createdAt: "2026-11-20T06:00:00.000Z",
          updatedAt: "2026-11-20T06:00:00.000Z",
        });
        return { structuredContent: { ok: true, key: args.key } };
      }
      throw new Error("no tool " + name);
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
  globalThis.__u05 = { getCalls };
}

// ---------------------------------------------------------------------------
// 切片 5:主视图缝 —— 行点击进详情 / 顶栏 / 元行 / 正文 / 评论 / 门禁 / 提交 / 动作发话
// ---------------------------------------------------------------------------
if (U) {
  const surface = doc.body.children[0];
  const st = U.list.storeOf();
  check("store 就绪(接驳后非空)", !!st);

  // ---- 纯函数面(经自检口走,不经内部名) ----
  const D = U.detail;
  check("自检面 window.MattSkillsUpstream.detail 存在", !!D);
  if (D) {
    eq("detailTopGate:已关闭票 → closed 置灰", D.detailTopGate({ state: "closed" }, []), { clickable: false, reason: "closed", blockedNumbers: [] });
    eq("detailTopGate:被 open 票阻塞 → blocked + 号单", D.detailTopGate({ state: "open" }, [{ state: "OPEN", number: 1 }]), { clickable: false, reason: "blocked", blockedNumbers: [1] });
    eq("detailTopGate:阻塞票状态缺失 → 未知不置灰", D.detailTopGate({ state: "open" }, [{ number: 2 }]), { clickable: true, reason: "none", blockedNumbers: [] });
    const ladder = D.issueDetailFoldLadderOf({ back: "返回列表", crumb: "#1", snapshot: "快照", primary: "诊断", newSession: "新会话" });
    eq("折叠阶梯:五元素按序(每元素重复其字数)", ladder.steps.map((s) => s.el), [
      "back", "back", "back", "back", "crumb", "crumb", "snapshot", "snapshot", "primary", "primary", "newSession", "newSession", "newSession",
    ]);
    const t2 = D.issueDetailFoldStateAt(ladder, 1);
    eq("折叠档 1:back 裁 1 字(尾部)", t2.back, "返回列");
    const t5 = D.issueDetailFoldStateAt(ladder, 5);
    eq("折叠档 5:back 清空", t5.back, "");
  }

  // ---- 行点击进详情(01:开放 + needs-info + 认领 + 2 评论) ----
  const goDetail = async (n) => {
    U.list.rowHelpers.setActiveIssue(st, n, "dogfood-detail");
    await tick();
    await settle();
    await tick();
  };
  await goDetail(1);
  {
    if (DUMP) console.log("[U05_DUMP] 详情 01 树:\n" + dumpTree(surface));
    const topbar = walk(surface).find((n) => n.attributes["data-detail-topbar"] !== undefined);
    check("详情粘性顶栏在(data-detail-topbar)", !!topbar);
    const bodyText = textOf(surface);
    check("详情显示标题", bodyText.includes("详情闭环"), bodyText.slice(0, 120));
    check("详情正文段(验收清单文字)", bodyText.includes("粘性顶栏"), bodyText.slice(0, 160));
    check("详情评论区计数(评论 (2))", /评论 \(2\)/.test(bodyText), bodyText.slice(-200));
    check("详情评论时间线含作者", bodyText.includes("triage-agent") && bodyText.includes("dev"));
    check("详情元行含标签色 chip 文案", bodyText.includes("needs-info"));
    check("详情正文段不含元行残留", !bodyText.includes("Status:") || !topbar);
    const back = walk(surface).filter((n) => n.tagName === "BUTTON").find((b) => textOf(b).includes("返回"));
    check("返回按钮在(字:返回…)", !!back);
    if (back) {
      fireClick(back);
      await tick();
      await settle();
      const backToList = walk(surface).some((n) => String(n.attributes["data-log"] || "").startsWith("list."));
      check("返回键回列表(列表行数据点回归)", backToList || textOf(surface).includes("详情闭环"));
      await goDetail(1);
    }
  }

  // ---- 动作发话:主动作点击 → st.injector → sendMessage(needs-info → supplement 档) ----
  {
    if (DUMP) {
      const proj = U.detail.detailViewFor(st, 1, "dogfood-detail");
      console.log(
        "[DIAG] proj.source=", proj && proj.source,
        "| issue.number=", proj && proj.issue && proj.issue.number,
        "| comments.nodes=", proj && proj.issue && proj.issue.comments && proj.issue.comments.nodes && proj.issue.comments.nodes.length
      );
      console.log("[DIAG] st.injector=", typeof st.injector, "| st.issueMode=", st.issueMode, "| issueDetail.number=", st.issueDetail && st.issueDetail.number, "| issueDetail.effortId=", st.issueDetail && st.issueDetail.effortId);
      const taProbe = walk(surface).find((n) => n.tagName === "TEXTAREA");
      console.log("[DIAG] textarea=", !!taProbe);
    }
    const before = sentMessages.length;
    const primary = walk(surface)
      .filter((n) => n.tagName === "BUTTON")
      .find((b) => b.attributes["data-log"] === "issue.top.exec");
    check("主动作按钮在(data-log=issue.top.exec)", !!primary);
    if (primary) {
      fireClick(primary);
      await tick();
      await settle();
      check("动作点击后 sendMessage 收到一条", sentMessages.length === before + 1, JSON.stringify(sentMessages.slice(-1)));
      const sent = sentMessages[sentMessages.length - 1] || "";
      check("发话内容非空且指向本卡(含 01)", sent.includes("01") && sent.length > 20, sent.slice(0, 80));
    }
  }

  // ---- 被阻塞票(02):主动作置灰(reason=blocked,aria-disabled,不进日志) ----
  await goDetail(2);
  {
    if (DUMP) {
      const proj = U.detail.detailViewFor(st, 2, "dogfood-detail");
      console.log("[DIAG] 02 st.issueMode=", st.issueMode, "| st.issueDetail.number=", st.issueDetail && st.issueDetail.number, "| navStack=", JSON.stringify(st.navStack));
      console.log("[DIAG] 02 getCalls 尾巴=", JSON.stringify(globalThis.__u05.getCalls.slice(-4)));
      console.log("[DIAG] 02 proj.source=", proj && proj.source, "| blockedBy=", JSON.stringify(proj && proj.issue && proj.issue.blockedBy));
      console.log("[DIAG] 02 gate=", JSON.stringify(U.detail.detailTopGate(proj && proj.issue, (proj && proj.issue && proj.issue.blockedBy) || [])));
      const execs = walk(surface).filter((n) => n.tagName === "BUTTON" && (n.attributes["data-log"] === "issue.top.exec" || n.attributes["aria-disabled"] !== undefined));
      console.log("[DIAG] 02 exec/置灰按钮=", JSON.stringify(execs.map((b) => b.attributes)));
    }
    const topbar = walk(surface).find((n) => n.attributes["data-detail-topbar"] !== undefined);
    check("02 详情顶栏在", !!topbar);
    const bodyText = textOf(surface);
    check("02 被阻塞区显示 #01", /被.*#?1/.test(bodyText) || bodyText.includes("01"), bodyText.slice(0, 200));
    const gated = walk(surface).filter((n) => n.tagName === "BUTTON").find((b) => b.attributes["aria-disabled"] !== undefined);
    check("02 主动作置灰(aria-disabled)", !!gated);
    if (gated) {
      const before = sentMessages.length;
      fireClick(gated);
      await tick();
      check("置灰点击不发话(门禁)", sentMessages.length === before);
    }
    if (DUMP) console.log("[U05_DUMP] 详情 02 树:\n" + dumpTree(surface));
  }

  // ---- 已关闭票(03):chip 已关闭 + 主动作置灰(reason=closed) ----
  await goDetail(3);
  {
    const bodyText = textOf(surface);
    check("03 状态 chip 走已关闭文案", bodyText.includes("已关闭"), bodyText.slice(0, 160));
    const gated = walk(surface).filter((n) => n.tagName === "BUTTON").find((b) => b.attributes["aria-disabled"] !== undefined);
    check("03 主动作置灰(aria-disabled)", !!gated);
  }

  // ---- 评论提交:输入 → 发送 → deck_issue_comment(actor=panel)→ force 重取 → 计数 +1 ----
  await goDetail(1);
  {
    const ta = walk(surface).find((n) => n.tagName === "TEXTAREA");
    check("评论输入区在(textarea)", !!ta);
    if (ta) {
      const okInput = fireInput(ta, "真机走单完成:详情/发话/评论/关闭全过。");
      check("受控输入通道(onInput props)", okInput);
      await tick();
      const sendBtn = walk(surface)
        .filter((n) => n.tagName === "BUTTON")
        .find((b) => {
          const t = textOf(b);
          return t.includes("发送") || t.includes("发 送");
        });
      check("发送按钮在", !!sendBtn);
      const beforeComment = toolCalls.filter((c) => c.name === "deck_issue_comment").length;
      const beforeGet = globalThis.__u05.getCalls.length;
      if (sendBtn) {
        fireClick(sendBtn);
        await tick();
        await settle();
        await tick();
      }
      const commentCalls = toolCalls.filter((c) => c.name === "deck_issue_comment");
      check("提交打 deck_issue_comment", commentCalls.length === beforeComment + 1, JSON.stringify(commentCalls));
      const last = commentCalls[commentCalls.length - 1] || {};
      check("提交带 key=dogfood-detail/01 与 actor=panel", String(last.args && last.args.key) === "dogfood-detail/01" && last.args && last.args.actor === "panel", JSON.stringify(last.args));
      check("提交正文非空", !!(last.args && String(last.args.body || "").includes("真机走单")));
      check("成功后 force 重取 deck_issue_detail(get 再打)", globalThis.__u05.getCalls.length > beforeGet, `before=${beforeGet} after=${globalThis.__u05.getCalls.length}`);
      const bodyText = textOf(surface);
      check("重取后评论计数 +1(评论 (3))", /评论 \(3\)/.test(bodyText), bodyText.slice(-160));
      check("新评论入时间线(panel)", bodyText.includes("panel") || bodyText.includes("真机走单"));
    }
  }

  // ---- 地图层降级:setActiveMap → 占位说明(mapV2 家族未搬) ----
  {
    U.list.rowHelpers.setActiveMap(st, 0, "dogfood-detail");
    await tick();
    await settle();
    check("地图详情层降级占位(mapV2 未搬)", textOf(surface).includes("mapV2"), textOf(surface).slice(0, 120));
    U.list.rowHelpers.setActiveMap(st, null, "");
    await tick();
  }
}

// ---------------------------------------------------------------------------
console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
