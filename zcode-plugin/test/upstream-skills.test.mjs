// 工单 02 技能页签（目录 + 文档详情）测试。
// 缝 = 对外可观察边界:
//   1) 构建缝:技能页九叶(样式/数据表/页签本体/详情家族六件)登记进 LEAVES、骨架留标记、
//      标记序仍是上游 index.ts 的保序子序列,且原位关系成立(pixelStyles 在 styles 与 locale
//      之间、mattSkills 在 locale 与 trackerConstants 之间、技能家族在 listTab 之后);
//   2) bundle 内容缝:SkillsTab/PixelSkillList/PixelSkillDetailModal/pixelOpenDetail/SKILLS/
//      PIXEL_STYLE_TEXT 在位,host 适配 skill.readDoc → deck_skill_doc,无拼接残留、语法过;
//   3) 主视图缝:boot({fetchData:true}) 后点「技能」页签 → 上游 27 行目录(行上 /name、
//      skilldesc 词条、推荐行标记),「U06+ 搬入」占位消失;点行 → loading 文案 → fake 工具
//      回 md → markdown 正文;关闭 → 列表回来且筛选状态原样;读失败横幅 + 重试可恢复;
//   4) 工具面契约由 server-read.test.mjs 的同名切片看守(本套件只断渲染侧消费口径)。
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
// fake DOM(与 upstream-list/upstream-detail 同款:类/属性/tag 选择器 + 冒泡 click)
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
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 切片 1:构建缝 —— 技能页九叶登记 / 骨架标记原位 / 保序子序列
// ---------------------------------------------------------------------------
const buildUpstream = await import(pathToFileURL(join(ROOT, "build-upstream.mjs")).href);
const SKILL_LEAVES = [
  "leaf:pixelStyles",
  "shared:mattSkills",
  "leaf:skillsTab",
  "leaf:pixelContents",
  "leaf:pixelMarkdown",
  "leaf:pixelSkillRow",
  "leaf:pixelSkillList",
  "leaf:pixelSkillDetailModal",
  "leaf:pixelSkillOps",
];
{
  const ids = buildUpstream.LEAVES.map((l) => l.id);
  for (const id of SKILL_LEAVES) check(`LEAVES 登记 ${id}`, ids.includes(id));

  const skeletonText = readFileSync(join(ROOT, "src", "ui", "upstream", "entry.mjs"), "utf8");
  const skelMarkers = buildUpstream.parseMarkers(skeletonText).map((m) => m.id);
  check(
    "entry.mjs 骨架标记是上游 index.ts 标记序的保序子序列",
    buildUpstream.isSubsequenceOf(skelMarkers, buildUpstream.upstreamMarkerOrder()),
    skelMarkers.join(" → ")
  );
  for (const id of SKILL_LEAVES) check(`骨架留了标记 ${id}`, skelMarkers.includes(id));

  const at = (id) => skelMarkers.indexOf(id);
  check(
    "原位:pixelStyles 在 kernel:styles 之后、kernel:localeData 之前",
    at("kernel:styles") >= 0 && at("kernel:styles") < at("leaf:pixelStyles") && at("leaf:pixelStyles") < at("kernel:localeData"),
    `styles=${at("kernel:styles")} pixelStyles=${at("leaf:pixelStyles")} localeData=${at("kernel:localeData")}`
  );
  check(
    "原位:mattSkills 在 kernel:locale 之后、shared:trackerConstants 之前",
    at("kernel:locale") < at("shared:mattSkills") && at("shared:mattSkills") < at("shared:trackerConstants"),
    `locale=${at("kernel:locale")} mattSkills=${at("shared:mattSkills")} trackerConstants=${at("shared:trackerConstants")}`
  );
  check(
    "原位:技能家族按上游次序排在 leaf:listTab 之后",
    at("leaf:listTab") < at("leaf:skillsTab") &&
      at("leaf:skillsTab") < at("leaf:pixelContents") &&
      at("leaf:pixelContents") < at("leaf:pixelMarkdown") &&
      at("leaf:pixelMarkdown") < at("leaf:pixelSkillRow") &&
      at("leaf:pixelSkillRow") < at("leaf:pixelSkillList") &&
      at("leaf:pixelSkillList") < at("leaf:pixelSkillDetailModal") &&
      at("leaf:pixelSkillDetailModal") < at("leaf:pixelSkillOps"),
    SKILL_LEAVES.map((id) => `${id}=${at(id)}`).join(" ")
  );
  check("标记后的装配行 styles.insert(PIXEL_STYLE_TEXT) 在", /styles\.insert\(PIXEL_STYLE_TEXT\)/.test(skeletonText));
}

// ---------------------------------------------------------------------------
// 切片 2:bundle 内容缝 —— 符号 / 数据缝 / 残留 / 语法
// ---------------------------------------------------------------------------
const code = existsSync(BUNDLE) ? readFileSync(BUNDLE, "utf8") : "";
check("dist/ui/bundle-1.txt 存在", existsSync(BUNDLE));
if (code) {
  const has = (name, re) => check(`bundle 含 ${name}`, re.test(code));
  has("leaf:pixelStyles(PIXEL_STYLE_TEXT)", /PIXEL_STYLE_TEXT/);
  has("样式接缝 styles.insert(PIXEL_STYLE_TEXT)", /styles\.insert\(PIXEL_STYLE_TEXT\)/);
  has("shared:mattSkills(SKILLS)", /const SKILLS = SKILLS_DATA/);
  has("shared:mattSkills(MATT_SKILL_PROBE_NAMES)", /MATT_SKILL_PROBE_NAMES/);
  has("leaf:skillsTab(SkillsTab)", /const SkillsTab = /);
  has("leaf:pixelContents(PixelContents)", /const PixelContents = function/);
  has("leaf:pixelMarkdown(PixelMarkdown)", /const PixelMarkdown = function/);
  has("leaf:pixelMarkdown(pixelDocHeadings)", /const pixelDocHeadings = function/);
  has("leaf:pixelSkillRow(PixelSkillRow)", /const PixelSkillRow = function/);
  has("leaf:pixelSkillList(PixelSkillList)", /const PixelSkillList = function/);
  has("leaf:pixelSkillDetailModal(PixelSkillDetailModal)", /const PixelSkillDetailModal = function/);
  has("leaf:pixelSkillOps(pixelOpenDetail)", /const pixelOpenDetail = function/);
  has("leaf:pixelSkillOps(pixelRetryDetail)", /const pixelRetryDetail = function/);
  check("骨架屏常驻(PixelSkeleton/SKILL_SKELETON_DELAY_MS)", /PixelSkeleton/.test(code) && /SKILL_SKELETON_DELAY_MS/.test(code));
  // 数据缝:上游电话仍在,适配层把它接到 deck_skill_doc,file 参数不伪造
  has("上游电话 host.call('skill.readDoc')", /host\.call\(['"]skill\.readDoc['"]/);
  has("host 适配 method === 'skill.readDoc'", /method === ["']skill\.readDoc["']/);
  has("host 适配打 deck_skill_doc", /callTool\(["']deck_skill_doc["']/);
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
// 切片 3:主视图缝 —— 技能页签目录 / 详情取数 / 失败重试 / 关闭保状态
// ---------------------------------------------------------------------------
const DOC_MD = ["# 技能正文", "", "这是技能正文的第一段。", "", "## 小节一", "", "这是小节里的第二段。"].join("\n");
const docResponse = (name) => ({ structuredContent: { ok: true, name, md: DOC_MD, path: "X:/skills/" + name + "/SKILL.md", source: "workspace" } });
let U = null;
const doc = createFakeDom();
const toolCalls = [];
const docCalls = [];
let docBehavior = "hold"; // hold | ok | fail
let pendingDoc = null;
{
  const { scanWorkspace, thinRow } = await import(pathToFileURL(join(ROOT, "src", "cards.mjs")).href);
  const scan = scanWorkspace(join(ROOT, "test", "fixtures", "u04-list"));
  const tickets = scan.rows.filter((r) => r.type !== "map" && r.type !== "spec");
  const openN = tickets.filter((r) => r.state === "open").length;
  const closedN = tickets.filter((r) => r.state === "closed").length;
  const LABEL_PALETTE = {
    labels: ["needs-triage", "needs-info", "ready-for-agent", "ready-for-human", "wontfix"],
    colors: { bug: "d73a4a", "needs-triage": "fbca04", "ready-for-agent": "0e8a16", wontfix: "ffffff" },
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
      if (name === "deck_skill_doc") {
        docCalls.push(args || {});
        if (docBehavior === "fail") throw new Error("bridge down");
        if (docBehavior === "hold") return new Promise((r) => { pendingDoc = r; });
        return docResponse(args.name);
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
}

if (U) {
  const surface = doc.body.children[0]; // #dsws-surface
  const body = qsa(surface, ".dsws-body")[0];
  const st = U.list ? U.list.storeOf() : null;
  check("list.storeOf() 给出已接驳的 store", !!(st && st.snapshot));

  const tabBtn = (log) => walk(surface).filter((n) => n.attributes["data-log"] === log && n.tagName === "BUTTON")[0];
  const byLog = (log) => walk(surface).filter((n) => n.attributes["data-log"] === log)[0];
  const rowTexts = () => qsa(surface, ".pixel-skillrow").map((r) => textOf(r));

  // ---- 点「技能」页签 → 上游 27 行目录 ----
  fireClick(tabBtn("panel.tab.skills"));
  await tick();
  await settle();
  eq("页签壳状态:st.tab = skills", st.tab, "skills");
  check("技能页签根 .pixel-tab 在", !!qsa(body, ".pixel-tab")[0]);
  const skillRows = qsa(surface, ".pixel-skillrow");
  eq("技能目录 27 行(上游 SKILLS 静态目录)", skillRows.length, 27);
  check("行上编号 /ask-matt 在", rowTexts().some((t) => t.includes("/ask-matt")));
  check("末项 /writing-for-agents 在", rowTexts().some((t) => t.includes("/writing-for-agents")));
  check("skilldesc 词条渲染(tr 取值:技能路由器)", textOf(surface).includes("技能路由器：不知道该用哪个 skill 时问它"));
  const recRow = skillRows.find((r) => textOf(r).includes("/ask-matt"));
  check("推荐行带 rec 标记与星标", !!recRow && String(recRow.attributes["class"]).includes("rec") && textOf(recRow).includes("★"));
  check("技能页内容不再是 U06 占位", !textOf(body).includes("U06"));
  eq("目录行每行都有一颗详情按钮", walk(surface).filter((n) => /^pixel\.btn\.sd\.skillrow\.detail\./.test(String(n.attributes["data-log"] || ""))).length, 27);

  // ---- 开详情:loading 文案 → fake 工具回 md → markdown 正文 ----
  // 开详情前的筛选状态(上游 st 自持;关详情后必须原样)
  st.stateFilter = "closed";
  st.lblFilters = ["bug"];
  const askDetail = byLog("pixel.btn.sd.skillrow.detail.ask-matt");
  check("ask-matt 行详情按钮在", !!askDetail);
  fireClick(askDetail);
  await tick();
  await settle();
  eq("详情阶段 = loading(st.pixelDetail.phase)", st.pixelDetail && st.pixelDetail.phase, "loading");
  check("加载中文案出现(正在取文件…)", textOf(body).includes("正在取文件"));
  check("详情标题渲染 /ask-matt", textOf(body).includes("/ask-matt"));
  check("取数走 deck_skill_doc 且只带 name", docCalls.length === 1 && docCalls[0].name === "ask-matt" && docCalls[0].file === undefined, JSON.stringify(docCalls));
  // fake 工具回正文
  pendingDoc(docResponse("ask-matt"));
  await tick();
  await settle();
  await tick();
  eq("详情阶段 = ready", st.pixelDetail && st.pixelDetail.phase, "ready");
  check("markdown 一级标题渲染(技能正文)", textOf(body).includes("技能正文"));
  check("markdown 段落渲染(第一段)", textOf(body).includes("这是技能正文的第一段。"));
  check("markdown 二级标题进目录/正文(小节一)", textOf(body).includes("小节一"));
  check("正文段落二在(布局未丢段)", textOf(body).includes("这是小节里的第二段。"));

  // ---- 关闭详情 → 列表回来,筛选状态原样 ----
  const closeBtn = byLog("pixel.btn.sd.detail.close");
  check("详情关闭按钮在", !!closeBtn);
  fireClick(closeBtn);
  await tick();
  await settle();
  eq("关闭后回到列表(27 行)", qsa(surface, ".pixel-skillrow").length, 27);
  eq("关闭后 st.tab 仍是 skills", st.tab, "skills");
  eq("关闭后 stateFilter 原样", st.stateFilter, "closed");
  eq("关闭后 lblFilters 原样", st.lblFilters, ["bug"]);
  check("关闭后 st.pixelDetail 清空", !st.pixelDetail, JSON.stringify(st.pixelDetail));

  // ---- 失败 + 重试:第一次 reject → 横幅+重试;点重试 → 成功恢复 ----
  docBehavior = "fail";
  const wayDetail = byLog("pixel.btn.sd.skillrow.detail.wayfinder");
  check("wayfinder 行详情按钮在", !!wayDetail);
  fireClick(wayDetail);
  await tick();
  await settle();
  await tick();
  check("读失败横幅文案(sd.fail)", textOf(body).includes("没能读到这一篇的原文"));
  const retryBtn = byLog("pixel.btn.banner.retry") || byLog("pixel.btn.sd.detail.retry");
  check("失败后可重试(横幅/底栏重试按钮)", !!retryBtn);
  const callsBeforeRetry = docCalls.length;
  docBehavior = "ok";
  fireClick(retryBtn);
  await tick();
  await settle();
  await tick();
  check("重试真的再打了一次 deck_skill_doc", docCalls.length === callsBeforeRetry + 1, `before=${callsBeforeRetry} after=${docCalls.length}`);
  check("重试后正文恢复", textOf(body).includes("这是技能正文的第一段。"));
  eq("重试后阶段回到 ready", st.pixelDetail && st.pixelDetail.phase, "ready");
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
