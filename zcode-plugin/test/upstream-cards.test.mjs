// 工单 U03 视觉小件 + 卡片家族测试。
// 缝 = 对外可观察边界:
//   1) 构建缝:build-upstream 拼接机制(leaf:tip 的中央时间参数 import 剥除、LEAVES 登记、
//      骨架标记是上游 index.ts 标记序的保序子序列);
//   2) bundle 内容缝:dist/ui/bundle-1.txt 含全部视觉叶子、无标记/锚点残留、语法过;
//   3) 卡面缝:boot(工具桥)后,壳 body 的装配段用 ingest 后的真实数据渲染 m1-core-board 的
//      一张 PixelIssueCard 与一张 PixelMapCard —— 类名、内联色值、罩纱标记对照上游源码与
//      中央色表手工摘录(独立真源,不从实现反推);
//   4) 自检面缝:window.MattSkillsUpstream.cards(三张大卡 + 小件 + 主题 + renderInto 挂载)
//      —— U04 视图层拿卡与挂列表的接口。
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
// fake DOM:preact render 需要的最小节点面(appendChild/insertBefore/removeChild/
// firstChild/nextSibling/parentNode、setAttribute、style.setProperty、事件挂接、
// ownerDocument)。只服务渲染树断言,不模拟布局。
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
  return node;
}
function createFakeDom() {
  const doc = createFakeNode(9, "#document");
  doc.createElement = (tag) => {
    const n = createFakeNode(1, tag);
    n.ownerDocument = doc;
    return n;
  };
  // SVG 节点与普通元素同面(preact 对两者只走同一组节点操作;属性全走 setAttribute)
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
  return doc;
}
/** 深度先序遍历收集节点。 */
function walk(node, out = []) {
  if (!node) return out;
  out.push(node);
  for (const c of node.children || []) walk(c, out);
  return out;
}
/** 按 class 词匹配(等价 querySelectorAll('.x') 的最简形态)。 */
function qsa(root, cls) {
  return walk(root).filter((n) => String(n.attributes["class"] || "").split(/\s+/).includes(cls));
}
function textOf(node) {
  return walk(node)
    .filter((n) => n.nodeType === 3)
    .map((n) => n.data)
    .join("");
}

// ---------------------------------------------------------------------------
// 切片 1:构建缝 —— LEAVES 登记 / 标记序 / time-config import 剥除
// ---------------------------------------------------------------------------
const buildUpstream = await import(pathToFileURL(join(ROOT, "build-upstream.mjs")).href);
{
  const U03_LEAVES = [
    "shared:timeConfig",
    "kernel:portal",
    "kernel:icons",
    "leaf:chips",
    "leaf:tipPlace",
    "leaf:hoverTip",
    "leaf:tip",
    "leaf:ticketBadge",
    "leaf:openFolder",
    "leaf:liquidInk",
    "leaf:pixelBtn",
    "leaf:pixelDot",
    "leaf:pixelNum",
    "leaf:pixelStateIcon",
    "leaf:pixelSeal",
    "leaf:pixelSkeleton",
    "leaf:pixelBanner",
    "leaf:pixelStatusLine",
    "leaf:cardsTheme",
    "leaf:cardsStyles",
    "leaf:cardPin",
    "leaf:cardTitle",
    "leaf:cardNo",
    "leaf:cardTags",
    "leaf:cardNote",
    "leaf:cardFoot",
    "leaf:cardStamp",
    "leaf:blockedChrome",
    "leaf:cardBtns",
    "leaf:mapDots",
    "leaf:cardHead",
    "leaf:issueCard",
    "leaf:issueMapCard",
    "leaf:mapCard",
  ];
  const ids = buildUpstream.LEAVES.map((l) => l.id);
  for (const id of U03_LEAVES) check(`LEAVES 登记 ${id}`, ids.includes(id));

  // 骨架标记序 = 上游标记序的保序子序列(spliceSkeleton 会对账,这里直断便宜版)
  const skeletonText = readFileSync(join(ROOT, "src", "ui", "upstream", "entry.mjs"), "utf8");
  const skelMarkers = buildUpstream.parseMarkers(skeletonText).map((m) => m.id);
  check(
    "entry.mjs 骨架标记是上游 index.ts 标记序的保序子序列",
    buildUpstream.isSubsequenceOf(skelMarkers, buildUpstream.upstreamMarkerOrder()),
    skelMarkers.join(" → ")
  );
  for (const id of U03_LEAVES) check(`骨架留了标记 ${id}`, skelMarkers.includes(id));

  // leaf:tip 真源带中央时间参数 import:拼接机制要把它剥掉(上游 stripTimeConfigRefs 同款)
  const tipSrc = readFileSync(join(ROOT, "..", "src", "client", "views", "primitives", "Tip.ts"), "utf8");
  let tipFrag = null;
  let tipErr = "";
  try {
    tipFrag = buildUpstream.stripTsToSpliceable(tipSrc, { source: "Tip.ts" });
  } catch (e) {
    tipErr = String((e && e.message) || e);
  }
  check("stripTsToSpliceable(Tip.ts) 不再因 time-config import 报错", tipFrag !== null, tipErr);
  if (tipFrag) {
    check("Tip.ts 拼接片段无 import 残留", !/(^|\n)\s*import[\s{"'*]/.test(tipFrag));
    check("Tip.ts 拼接片段仍引用时间常量名(值由 timeConfig 片段提供)", tipFrag.includes("TIP_SHOW_DELAY_MS"));
  }
}

// ---------------------------------------------------------------------------
// 切片 2:bundle 内容 —— 叶子搬入清单、time-config 常量、语法门禁
// ---------------------------------------------------------------------------
const code = existsSync(BUNDLE) ? readFileSync(BUNDLE, "utf8") : "";
{
  check("dist/ui/bundle-1.txt 存在", existsSync(BUNDLE));
  if (code) {
    const has = (name, re) => check(`bundle 含 ${name}`, re.test(code));
    has("leaf:chips(TypeChip)", /TypeChip/);
    has("leaf:tipPlace(computeTipPlace)", /computeTipPlace/);
    has("leaf:hoverTip(HoverTip)", /HoverTip/);
    has("leaf:tip(Tip 预设)", /const Tip = function/);
    has("leaf:ticketBadge(ticketBadgeOf)", /ticketBadgeOf/);
    has("leaf:openFolder(openFolderAt)", /openFolderAt/);
    has("leaf:liquidInk(LIQUID_INK_CLASS)", /LIQUID_INK_CLASS/);
    has("leaf:pixelBtn(PixelBtn)", /PixelBtn/);
    has("leaf:pixelDot(PixelDot)", /PixelDot/);
    has("leaf:pixelNum(PixelNum)", /PixelNum/);
    has("leaf:pixelStateIcon(PixelStateIcon)", /PixelStateIcon/);
    has("leaf:pixelSeal(PixelSeal)", /PixelSeal/);
    has("leaf:pixelSkeleton(PixelSkeleton)", /PixelSkeleton/);
    has("leaf:pixelBanner(PixelBanner)", /PixelBanner/);
    has("leaf:pixelStatusLine(PixelStatusLine)", /PixelStatusLine/);
    has("leaf:cardsTheme(CARD_ACTION_COLORS)", /CARD_ACTION_COLORS/);
    has("leaf:cardsStyles(PIXEL_CARDS_STYLE_TEXT)", /PIXEL_CARDS_STYLE_TEXT/);
    has("leaf:cardNo(cd-nonum)", /cd-nonum/);
    has("leaf:blockedChrome(cd-bseal)", /cd-bseal/);
    has("leaf:mapDots(cd-grid2)", /cd-grid2/);
    has("leaf:issueCard(PixelIssueCard)", /PixelIssueCard/);
    has("leaf:issueMapCard(PixelIssueMapCard)", /PixelIssueMapCard/);
    has("leaf:mapCard(PixelMapCard)", /PixelMapCard/);
    has("kernel:portal(portalTop)", /portalTop/);
    has("kernel:icons(Ic)", /const Ic =/);
    has("shared:timeConfig(TIP_SHOW_DELAY_MS = 400,值源 config/intervals.yaml)", /TIP_SHOW_DELAY_MS = 400/);
    has("shared:timeConfig(TIP_HIDE_DELAY_MS = 160)", /TIP_HIDE_DELAY_MS = 160/);
    has("TYPE_ICON 装配行(上游 index.ts 原文,esbuild 归一引号)", /const TYPE_ICON = \{ research: (['"])search\1/);
    has("卡皮肤插入(styles.insert(PIXEL_CARDS_STYLE_TEXT))", /styles\.insert\(PIXEL_CARDS_STYLE_TEXT\)/);
    check("bundle 无拼接标记残留", !/\(spliced by build\)/.test(code));
    check("bundle 无锚点残留", !/@splice-anchor/.test(code));
    check("bundle 无模块级 import/export", !/\bimport\s*["']/.test(code) && !/^[^\S\r\n]*export\s/m.test(code));
    try {
      new vm.Script(code);
      check("bundle 语法过(vm.Script)", true);
    } catch (e) {
      check("bundle 语法过(vm.Script)", false, e.message);
    }
  }
}

// ---------------------------------------------------------------------------
// 切片 3:卡面缝 —— boot(工具桥) → 壳 body 渲染 m1-core-board 的两张卡
// ---------------------------------------------------------------------------
let U = null;
const doc = createFakeDom();
{
  const { scanWorkspace, computeCounts, thinRow } = await import(pathToFileURL(join(ROOT, "src", "cards.mjs")).href);
  const scan = scanWorkspace(join(ROOT, "test", "fixtures", "mixed"));
  // m1-core-board 的行(规格 00 + 子票 01/02/03):票卡画 01,地图卡画规格容器
  const m1 = scan.rows.filter((r) => r.effortId === "m1-core-board");
  const m1Counts = { open: 2, closed: 1, total: 3 };
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
      if (uri.endsWith("workspace.json")) return { contents: [{ text: JSON.stringify({ root: "X:/ws", env: {} }) }] };
      throw new Error("no asset " + uri);
    },
    callTool: async (name) => {
      if (name === "deck_issue_list") return { structuredContent: { rows: m1.map(thinRow), revision: 1 } };
      if (name === "deck_issue_counts") return { structuredContent: { counts: m1Counts, revision: 1 } };
      if (name === "deck_issue_list_labels") return { structuredContent: LABEL_PALETTE };
      throw new Error("no tool " + name);
    },
  };
  if (code) {
    try {
      const win = { innerWidth: 800, innerHeight: 600, addEventListener() {}, removeEventListener() {} };
      new Function("window", "document", `"use strict";\n${code}`)(win, doc);
      U = win.MattSkillsUpstream;
      await U.boot({ client: fakeClient, doc, fetchData: true });
      check("boot(工具桥)成功且壳已挂载", doc.body.children.length >= 1);
    } catch (e) {
      check("boot(工具桥)成功", false, e && e.stack ? e.stack.split("\n").slice(0, 5).join(" | ") : String(e));
    }
  }
}
if (U) {
  const surface = doc.body.children[0]; // #dsws-surface
  const cards = qsa(surface, "cd-card");
  check("壳 body 装配段渲染出卡(至少两张)", cards.length >= 2, String(cards.length));

  // ---- PixelIssueCard(m1 子票 01:open + bug 标签 → action=fix,BUG 角标) ----
  const issueCard = cards.find((c) => String(c.attributes["class"]).startsWith("cd-card") && !String(c.attributes["class"]).includes("mapcard"));
  if (!issueCard) {
    check("找到 m1 票卡(cd-card)", false, JSON.stringify(cards.map((c) => c.attributes["class"])));
  } else {
    eq("票卡容器类名(open 票无 old/closed/dim)", issueCard.attributes["class"], "cd-card");
    check("票卡主色令牌 --cd-act=#d73a4a(fix→bug 色表)", issueCard.style["--cd-act"] === "#d73a4a", JSON.stringify(issueCard.style));
    eq("图钉小件(cd-pin)", qsa(issueCard, "cd-pin").length, 1);
    const corner = qsa(issueCard, "cd-corner");
    eq("BUG 角标(bugCorner)一枚", corner.length, 1);
    check("角标文字 card.bug=BUG(zh 词表)", textOf(corner[0]) === "BUG", textOf(corner[0]));
    const noBadge = qsa(issueCard, "cd-nonum")[0];
    check("编号徽章底色 #d73a4a(中央色表 bug)", noBadge.style.background === "#d73a4a", JSON.stringify(noBadge.style));
    // 墨色与罩纱为手推例(cardInkOn/cardBoostOn 对 #d73a4a 的取值:白字对比 4.57<4.6、
    // 深字 4.08<4.5 → 加罩纱;墨色走深墨 #1c1004(4.59≥4.57 压线))
    eq("编号徽章墨色 #1c1004(cardInkOn 手推)", noBadge.style.color, "#1c1004");
    eq("编号徽章罩纱标记 data-cd-boost=1(cardBoostOn 手推)", noBadge.attributes["data-cd-boost"], "1");
    const chips = qsa(issueCard, "cd-chip");
    eq("标签墨块一枚(bug)", chips.length, 1);
    check("标签墨块底色 #d73a4a(色板)", chips[0].style.background === "#d73a4a", JSON.stringify(chips[0].style));
    eq("标签墨块文字", textOf(chips[0]), "bug");
    const btns = qsa(issueCard, "cd-abtn");
    eq("四颗动作按钮", btns.length, 4);
    const mainBtn = btns.find((b) => String(b.attributes["data-log"] || "").endsWith(".main"));
    check("主按钮底色随卡主色 #d73a4a", mainBtn && mainBtn.style.background === "#d73a4a", mainBtn && JSON.stringify(mainBtn.style));
    const foot = qsa(issueCard, "cd-ft")[0];
    check("页脚左侧词条 card.updated=更新 …(zh 词表)", /^更新 /.test(textOf(foot)), textOf(foot));
    eq("标题两行钳制(cd-tt)", qsa(issueCard, "cd-tt").length, 1);
    eq("未被阻塞:无红封条/暗层", qsa(issueCard, "cd-bseal").length + qsa(issueCard, "cd-dimveil").length, 0);
  }

  // ---- PixelMapCard(m1 规格容器 00:open,墙格 c/f/b 排序,图例,读出槽) ----
  const mapCard = cards.find((c) => String(c.attributes["class"]).includes("mapcard"));
  if (!mapCard) {
    check("找到 m1 地图卡(cd-card mapcard)", false, JSON.stringify(cards.map((c) => c.attributes["class"])));
  } else {
    eq("地图卡类名", mapCard.attributes["class"], "cd-card mapcard");
    eq("大头针(kind=big → cd-pin big)", qsa(mapCard, "cd-pin")[0].attributes["class"], "cd-pin big");
    const hd = qsa(mapCard, "cd-hd")[0];
    eq("地图卡头编号是 b 元素文本 #00(上游源码:cd-hd 内 b)", textOf(hd.children.find((n) => n.tagName === "B")), "#00");
    const st = qsa(mapCard, "cd-st")[0];
    eq("开图状态徽章 cd-st open(在办)", [st.attributes["class"], textOf(st)], ["cd-st open", "在办"]);
    const wall = qsa(mapCard, "cd-wall")[0];
    // 墙格按 DOT_RANK c<f<w<b 排序:03(closed)→01(open)→02(blocked)
    eq("墙格四态色点(DOT_RANK 排序 c→f→b)", wall.children.map((i) => i.attributes["class"]), ["c", "f", "b"]);
    eq("图例四枚(可接/被阻塞/已认领/已关闭)", qsa(mapCard, "cd-legend")[0].children.length, 4);
    check("图例文字(zh 词表)", /可接/.test(textOf(qsa(mapCard, "cd-legend")[0])), textOf(qsa(mapCard, "cd-legend")[0]));
    check("读出槽 idle 文案 card.readoutIdle", textOf(qsa(mapCard, "cd-readout")[0]).includes("把鼠标放到点上"), textOf(qsa(mapCard, "cd-readout")[0]));
    eq("地图卡标题 h3", qsa(mapCard, "cd-card")[0].children.filter((n) => n.tagName === "H3").length, 1);
  }

  // ---- styleSheets:深浅两套令牌随主题切换(两份样式单都插入 head) ----
  const styleTexts = doc.head.children.map((n) => n.textContent || "");
  const cardsStyle = styleTexts.find((t) => t.includes("--cd-frame"));
  check("PIXEL_CARDS_STYLE_TEXT 已插入 head(卡皮肤)", !!cardsStyle);
  if (cardsStyle) {
    check("深色缺省令牌(:root --cd-*)", /^:root\{--cd-frame:#3a2c14/.test(cardsStyle));
    check("浅色覆盖(body:not([data-ds-dark-theme]) .cd-card 换一套 --cd-*)", /body:not\(\[data-ds-dark-theme\]\) \.cd-card\{--cd-frame:#3a2c14;--cd-card:#f6f1e6/.test(cardsStyle));
    check("浅色焦点环回落宿主 --dsw-focus-ring-color 令牌", cardsStyle.includes("var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#58a6ff))"));
  }
  const dswStyle = styleTexts.find((t) => t.includes("--dsw-alias-bg-layer-2") || t.includes("dsws-panel"));
  check("STYLE_TEXT(--dsw-* 令牌族)仍在 head", !!dswStyle);

  // ---------------------------------------------------------------------------
  // 切片 4:自检面缝 —— U.cards(U04 视图层接口):拿卡 + renderInto 挂任意容器
  // ---------------------------------------------------------------------------
  const C = U.cards;
  check("MattSkillsUpstream.cards 存在", !!C);
  if (C) {
    for (const k of ["PixelIssueCard", "PixelIssueMapCard", "PixelMapCard", "theme", "widgets", "renderInto"]) {
      check(`cards.${k} 在`, C[k] !== undefined);
    }
    for (const fn of ["cardColorOf", "cardInkOn", "cardBoostOn"]) {
      check(`cards.theme.${fn} 可调`, typeof C.theme[fn] === "function");
    }

    // 阻塞卡(m1 子票 02:被 01 阻塞):dim 暗层 + 两行红封条 + quiet 罩纱(#1401 口径)
    const c2 = doc.createElement("div");
    doc.body.appendChild(c2);
    C.renderInto(C.PixelIssueCard, c2, {
      noText: "02",
      title: "服务端只读路径",
      action: "diagnose",
      closed: false,
      tags: [{ text: "needs-triage", color: "fbca04" }],
      blockedBy: { no: "01", title: "插件骨架 tracer" },
      colorOf: { bug: "d73a4a", "needs-triage": "fbca04" },
      updatedText: "2026-11-19",
    });
    const blockedCard = qsa(c2, "cd-card")[0];
    if (!blockedCard) check("renderInto 渲染出阻塞卡", false);
    else {
      eq("阻塞卡类名 cd-card dim", blockedCard.attributes["class"], "cd-card dim");
      const seal = qsa(blockedCard, "cd-bseal")[0];
      check("红封条第一行 card.blockedSeal=被 #01 阻塞", textOf(seal).startsWith("被 #01 阻塞"), textOf(seal));
      eq("红封条第二行挡路票标题(cd-bseal-t)", textOf(qsa(seal, "cd-bseal-t")[0]), "插件骨架 tracer");
      const veil = qsa(blockedCard, "cd-dimveil")[0];
      eq("有挡路标题时暗层 quiet(只压暗不写字)", [veil.attributes["class"], textOf(veil)], ["cd-dimveil quiet", ""]);
      const noB = qsa(blockedCard, "cd-nonum")[0];
      check("diagnose→needs-triage 色板底 #fbca04", noB.style.background === "#fbca04", JSON.stringify(noB.style));
      // fbca04 是亮黄:白字对比不足、深墨足够 → 深墨、无罩纱(独立判据:黄色显然是浅色)
      eq("亮黄编号徽章墨色深墨 #1c1004", noB.style.color, "#1c1004");
      check("亮黄不罩纱(data-cd-boost 缺席)", noB.attributes["data-cd-boost"] === undefined);
    }

    // 关闭卡(m1 子票 03):old closed + 结案章
    const c3 = doc.createElement("div");
    doc.body.appendChild(c3);
    C.renderInto(C.PixelIssueCard, c3, { noText: "03", title: "面板列表 tracer", action: "execute", closed: true, updatedText: "2026-11-19" });
    const closedCard = qsa(c3, "cd-card")[0];
    eq("关闭卡类名 cd-card old closed", closedCard.attributes["class"], "cd-card old closed");
    eq("结案章 cd-sealcn 文案=结案", textOf(qsa(closedCard, "cd-sealcn")[0]), "结案");
    eq("关闭卡图钉换胶带(cd-tape)", qsa(closedCard, "cd-tape").length, 1);
    // execute 无色板 → 中央色表缺 wayfinder:task → 缺省紫 #8b5cf6(cardColorOf 兜底真源)
    const noC = qsa(closedCard, "cd-nonum")[0];
    eq("execute 缺色板时编号徽章兜底紫 #8b5cf6", noC.style.background, "#8b5cf6");

    // 地图子票卡(S7):open + doing 徽章(#2b62b0 源码字面量)+ 紫编号
    const c4 = doc.createElement("div");
    doc.body.appendChild(c4);
    C.renderInto(C.PixelIssueMapCard, c4, {
      mapNo: "00",
      title: "M1 核心看板",
      open: true,
      kids: 3,
      ready: 1,
      blocked: 1,
      sign: "doing",
      dots: [
        { color: "#3fb950", n: 1 },
        { color: "#d73a4a", n: 1 },
        { color: "#8b5cf6", n: 1 },
      ],
      updatedText: "2026-11-19",
    });
    const s7 = qsa(c4, "cd-card")[0];
    eq("地图子票卡类名 cd-card wide", s7.attributes["class"], "cd-card wide");
    const s7no = qsa(s7, "cd-nonum")[0];
    eq("S7 编号徽章紫底白字(源码字面量)", [s7no.style.background, s7no.style.color], ["#8b5cf6", "#fff"]);
    const sign = qsa(s7, "cd-mstate")[0];
    eq("在办徽章 cd-mstate #2b62b0 在办(容器三态:doing)", [sign.attributes["class"], sign.style.background, textOf(sign)], ["cd-mstate", "#2b62b0", "在办"]);
    const dots = qsa(s7, "cd-grid2")[0];
    eq("缩略点墙按 n 展开(3 格)", dots.children.length, 3);
    eq("点墙内联色", dots.children.map((i) => i.style.background), ["#3fb950", "#d73a4a", "#8b5cf6"]);
    eq("统计条 cd-mstats(子票 3/可接 1/被挡 1)", textOf(qsa(s7, "cd-mstats")[0]).replace(/\s+/g, " ").trim(), "子票 3可接 1被挡 1");
    eq("地图角标 cd-mapcorner 文案 MAP", textOf(qsa(s7, "cd-mapcorner")[0]), "MAP");

    // 容器徽章(TypeChip:map/spec 两型类名按上游 chips)
    const c5 = doc.createElement("div");
    doc.body.appendChild(c5);
    C.renderInto(C.widgets.TypeChip, c5, { type: "map" });
    eq("TypeChip(map) → dsws-chip dsws-chip-m", qsa(c5, "dsws-chip")[0].attributes["class"], "dsws-chip dsws-chip-m");
    const c6 = doc.createElement("div");
    doc.body.appendChild(c6);
    C.renderInto(C.widgets.TypeChip, c6, { type: "spec" });
    eq("TypeChip(spec) → dsws-chip dsws-chip-s", qsa(c6, "dsws-chip")[0].attributes["class"], "dsws-chip dsws-chip-s");

    // 主题纯函数(独立例值:亮黄→深墨;深紫→浅墨)
    eq("theme.cardInkOn(fbca04)=#1c1004", C.theme.cardInkOn("fbca04"), "#1c1004");
    eq("theme.cardInkOn(5319e7)=#fff9ec", C.theme.cardInkOn("5319e7"), "#fff9ec");
    eq("theme.cardColorOf 色板值去 # 前缀", C.theme.cardColorOf("wayfinder:task", { "wayfinder:task": "#10B981" }), "10b981");
  }
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
