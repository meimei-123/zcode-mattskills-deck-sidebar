// 工单 02 版本管理页签（69 叶 + 只读三视图）测试。
// 缝 = 对外可观察边界:
//   1) 构建缝:vc 家族 69 叶(两片样式 + 67 叶主块)与追闭的 19 片 shared:vc* 共享层都登记进
//      LEAVES、骨架留标记;标记序是上游 index.ts 的保序子序列,且原位关系成立(vcStyles/
//      vcShellStyles 在 kernel:styles 与 leaf:pixelStyles 之间、shared:vc* 在 refreshBudget 与
//      storePrefs 之间、67 叶在 chainRenderer 与 tabs 之间);
//   2) bundle 内容缝:VersionControlTab/VC_VIEWS/vcTabVisible/vcShellPages/vcStyles/vcFirstScreen
//      等符号在位,host 适配 wf.git* → deck_git,DeckBody 分发 versionControl;无拼接残留、语法过;
//   3) 渲染舱:boot(改口 deck_git 回放真录数据)后页签行四枚(含 panel.tab.versioncontrol);
//      点它 → st.tab==='versionControl' 且改动页出来(分支名/三行文件/KPI 计数/两个分组);
//      切提交历史(两笔提交)、工作树(空态)、回改动;点文件行出补丁行,点提交行出逐文件清单,
//      点清单文件出该提交的补丁 —— 全部经 fake deck_git 的 gitStatus/gitDiff 回包。
//   4) 窄档:ResizeObserver 回调把宽度压到 320 后,vc 根与三视图页签仍在(页内自己让位,不崩)。
//
// 回放数据来源:本工作树 dist/server.mjs 对一次性真 git 仓(两个提交、一条未暂存、一条未跟踪、
// 一个额外分支)的真实录制;只把临时目录名归一成 X:/vc-repo,其余(oid/标题/计数/补丁行)逐字保留。
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
// 回放数据:一次性真 git 仓的 deck_git structuredContent(见文件头)
// ---------------------------------------------------------------------------
const SCREEN = {
  identity: {
    worktreeDisplay: "vc-repo",
    worktreePath: "X:/vc-repo",
    branch: "main",
    detached: false,
    oid: "bcfd5a1363cb0bc96187de532cd345a2f0443a12",
    sync: "no-upstream",
    ahead: 0,
    behind: 0,
    basisMs: null,
  },
  staged: [{ path: "unstaged.txt", origPath: null, staged: true, unstaged: false, change: "added", conflict: false, addedLines: 1, deletedLines: 0 }],
  unstaged: [
    { path: "src.txt", origPath: null, staged: false, unstaged: true, change: "modified", conflict: false, addedLines: 1, deletedLines: 0 },
    { path: "untracked.txt", origPath: null, staged: false, unstaged: true, change: "untracked", conflict: false, addedLines: null, deletedLines: null },
  ],
  stagedCount: 1,
  unstagedCount: 2,
  conflictCount: 0,
  otherWorktrees: [],
  branches: [
    { short: "feature/read-only", oid: "bcfd5a1363cb0bc96187de532cd345a2f0443a12", upstream: null, upstreamGone: false, ahead: 0, behind: 0, current: false },
    { short: "main", oid: "bcfd5a1363cb0bc96187de532cd345a2f0443a12", upstream: null, upstreamGone: false, ahead: 0, behind: 0, current: true },
  ],
  commits: [
    {
      oid: "bcfd5a1363cb0bc96187de532cd345a2f0443a12",
      short: "bcfd5a1",
      author: "Tester",
      email: "t@example.com",
      authorDateMs: 1795178982000,
      commitDateMs: 1795178982000,
      subject: "第二次提交:补充一行",
      parents: ["81de156bb3827dee5ce03727a67b88bc5b0102e8"],
    },
    {
      oid: "81de156bb3827dee5ce03727a67b88bc5b0102e8",
      short: "81de156",
      author: "Tester",
      email: "t@example.com",
      authorDateMs: 1795178981000,
      commitDateMs: 1795178981000,
      subject: "初次提交:建立基线",
      parents: [],
    },
  ],
  repo: { merging: false, rebasing: false, cherryPicking: false, reverting: false, hasCommits: true, bare: false, tier: "full", autocrlf: "false" },
};
// 翻页第二批:两条更早的提交(形状与首屏同款;oid 独立,便于断言行数增加)。
const LOG_PAGE_2 = [
  {
    oid: "31ad0f5c9e2b4a7f8d1c3e5a7b9d0f2a4c6e8b10",
    short: "31ad0f5",
    author: "Tester",
    email: "t@example.com",
    authorDateMs: 1795178980000,
    commitDateMs: 1795178980000,
    subject: "更早的提交:第三笔",
    parents: [],
  },
  {
    oid: "42be1a6d0f3c5b8e9a2d4f6b8c0e1a3d5f7b9c21",
    short: "42be1a6",
    author: "Tester",
    email: "t@example.com",
    authorDateMs: 1795178979000,
    commitDateMs: 1795178979000,
    subject: "更早的提交:第四笔",
    parents: [],
  },
];
// 分支页回包(契约形状,vcBranchShapeOk 要求 contract/version/readAtMs/branches/tags/descriptions 齐)。
const BRANCH_BOARD = {
  ok: true,
  contract: "version-control.branch-board",
  version: 1,
  readAtMs: 1795178982816,
  current: { name: "main" },
  branches: [
    { name: "main", current: true, upstream: "origin/main", ahead: 0, behind: 0 },
    { name: "feature/read-only", current: false, upstream: null, ahead: 0, behind: 0 },
  ],
  tags: [{ name: "v0.4.0", annotated: true }],
  descriptions: {},
  merged: ["main"],
  notMerged: ["feature/read-only"],
  capabilities: { gitVersion: "2.42.0", actions: [] },
};
const DIFF_WORKING = {
  ok: true,
  path: "src.txt",
  lines: [
    { kind: "filehead", text: "diff --git src.txt src.txt" },
    { kind: "filehead", text: "index c0d0fb4..83db48f 100644" },
    { kind: "filehead", text: "--- src.txt" },
    { kind: "filehead", text: "+++ src.txt" },
    { kind: "hunk", text: "@@ -1,2 +1,3 @@" },
    { kind: "context", text: " line1" },
    { kind: "context", text: " line2" },
    { kind: "add", text: "+line3" },
  ],
  truncated: false,
  reason: "ok",
};
const DIFF_COMMIT = {
  rev: "bcfd5a1",
  ok: true,
  files: [{ path: "src.txt", origPath: null, added: 1, deleted: 0 }],
  truncated: false,
  reason: "ok",
};
const DIFF_COMMIT_FILE = {
  rev: "bcfd5a1",
  ok: true,
  path: "src.txt",
  lines: [
    { kind: "filehead", text: "diff --git src.txt src.txt" },
    { kind: "filehead", text: "index a29bdeb..c0d0fb4 100644" },
    { kind: "filehead", text: "--- src.txt" },
    { kind: "filehead", text: "+++ src.txt" },
    { kind: "hunk", text: "@@ -1 +1,2 @@" },
    { kind: "context", text: " line1" },
    { kind: "add", text: "+line2" },
  ],
  truncated: false,
  reason: "ok",
};

// ---------------------------------------------------------------------------
// fake DOM(与 upstream-list / upstream-skills 同款:类/属性/tag 选择器 + 冒泡 click)
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
/** 在 fake 节点上派发一次 click(与上游套件同款:props 通道优先,addEventListener 兜底)。 */
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

// ---------------------------------------------------------------------------
// 切片 1:构建缝 —— 69 叶 + 19 片共享层登记 / 骨架标记原位 / 保序
// ---------------------------------------------------------------------------
const buildUpstream = await import(pathToFileURL(join(ROOT, "build-upstream.mjs")).href);
const VC_STYLE_LEAVES = ["leaf:vcStyles", "leaf:vcShellStyles"];
const VC_MAIN_LEAVES = [
  "leaf:vcText", "leaf:vcFold", "leaf:vcDiff", "leaf:vcCommit", "leaf:vcRows", "leaf:vcWrite",
  "leaf:vcWriteRun", "leaf:vcWriteUi", "leaf:vcWriteOps", "leaf:vcWriteView", "leaf:vcDiffOps",
  "leaf:vcBlocks", "leaf:vcViews", "leaf:vcAiHandoff", "leaf:vcTabVisible", "leaf:vcData", "leaf:vcCache",
  "leaf:vcInView", "leaf:vcFirstScreen", "leaf:vcCapabilityPages", "leaf:vcShellPrimitives", "leaf:vcPalette",
  "leaf:vcCapabilityList", "leaf:vcHistory", "leaf:vcSyncData", "leaf:vcRemoteData", "leaf:vcRemotePage",
  "leaf:vcSyncPage", "leaf:vcMigrateData", "leaf:vcQuery", "leaf:vcQueryView", "leaf:vcCommitOps",
  "leaf:vcCommitPage", "leaf:vcTaskPanel", "leaf:vcBranches", "leaf:vcChangesPage", "leaf:vcStashOps",
  "leaf:vcStashPage", "leaf:vcDiagnostics", "leaf:vcDiagnosticsPage", "leaf:vcUndoOps", "leaf:vcUndoPage",
  "leaf:vcWorktreesData", "leaf:vcWorktreesOps", "leaf:vcWorktreesPage", "leaf:vcMigratePage",
  "leaf:vcClonePage", "leaf:vcSubmodulesData", "leaf:vcSubmodulesOps", "leaf:vcSubmodulesPage",
  "leaf:vcConflictsOps", "leaf:vcConflictsPage", "leaf:vcConfigOps", "leaf:vcConfigPage", "leaf:vcHooksPage",
  "leaf:vcPlatformData", "leaf:vcPlatformPage", "leaf:vcMigrateExport", "leaf:vcRebaseOps", "leaf:vcRebasePage",
  "leaf:vcRewriteOps", "leaf:vcRewritePage", "leaf:vcMaintenanceData", "leaf:vcMaintenancePage",
  "leaf:vcMaintenanceDiag", "leaf:vcShellPages", "leaf:versionControlTab",
];
const VC_SHARED_LEAVES = [
  "shared:vcRules", "shared:vcCommitPlan", "shared:vcCapabilityLedger", "shared:vcCapabilities",
  "shared:vcFirstScreen", "shared:vcSyncActions", "shared:vcSyncRules", "shared:vcMigrateActions",
  "shared:vcStashRules", "shared:vcPlatformInspect", "shared:vcCloneOptions", "shared:vcCloneTicket",
  "shared:vcConfigRules", "shared:vcWorktreeOps", "shared:vcSubmoduleOps", "shared:vcConflictText",
  "shared:vcRewriteOps", "shared:vcRecoveryPoint", "shared:vcMaintenanceOps",
];
{
  eq("vc 家族叶数 = 69(2 样式 + 67 主块)", VC_STYLE_LEAVES.length + VC_MAIN_LEAVES.length, 69);
  const ids = buildUpstream.LEAVES.map((l) => l.id);
  for (const id of [...VC_STYLE_LEAVES, ...VC_MAIN_LEAVES, ...VC_SHARED_LEAVES]) {
    check(`LEAVES 登记 ${id}`, ids.includes(id));
  }
  const skeletonText = readFileSync(join(ROOT, "src", "ui", "upstream", "entry.mjs"), "utf8");
  const skelMarkers = buildUpstream.parseMarkers(skeletonText).map((m) => m.id);
  check(
    "entry.mjs 骨架标记是上游 index.ts 标记序的保序子序列",
    buildUpstream.isSubsequenceOf(skelMarkers, buildUpstream.upstreamMarkerOrder()),
    skelMarkers.join(" → ")
  );
  for (const id of [...VC_STYLE_LEAVES, ...VC_MAIN_LEAVES, ...VC_SHARED_LEAVES]) {
    check(`骨架留了标记 ${id}`, skelMarkers.includes(id));
  }
  const at = (id) => skelMarkers.indexOf(id);
  check(
    "原位:vcStyles 在 kernel:styles 之后、pixelStyles 之前",
    at("kernel:styles") >= 0 && at("kernel:styles") < at("leaf:vcStyles") && at("leaf:vcStyles") < at("leaf:pixelStyles"),
    `styles=${at("kernel:styles")} vcStyles=${at("leaf:vcStyles")} pixelStyles=${at("leaf:pixelStyles")}`
  );
  check(
    "原位:vcShellStyles 在 vcStyles 与 pixelStyles 之间",
    at("leaf:vcStyles") < at("leaf:vcShellStyles") && at("leaf:vcShellStyles") < at("leaf:pixelStyles"),
    `vcStyles=${at("leaf:vcStyles")} vcShellStyles=${at("leaf:vcShellStyles")}`
  );
  check(
    "装配行:styles.insert(VC_STYLE_TEXT) 与 styles.insert(VC_SHELL_STYLE_TEXT) 在",
    /styles\.insert\(VC_STYLE_TEXT\)/.test(skeletonText) && /styles\.insert\(VC_SHELL_STYLE_TEXT\)/.test(skeletonText)
  );
  check(
    "原位:19 片 shared:vc* 在 shared:refreshBudget 之后、kernel:storePrefs 之前且按上游次序",
    at("shared:refreshBudget") < at(VC_SHARED_LEAVES[0]) &&
      VC_SHARED_LEAVES.every((id, i) => i === 0 || at(VC_SHARED_LEAVES[i - 1]) < at(id)) &&
      at(VC_SHARED_LEAVES[VC_SHARED_LEAVES.length - 1]) < at("kernel:storePrefs"),
    VC_SHARED_LEAVES.map((id) => `${id}=${at(id)}`).join(" ")
  );
  check(
    "原位:67 叶在 leaf:chainRenderer 与 leaf:tabs 之间且按上游次序",
    at("leaf:chainRenderer") >= 0 &&
      at("leaf:chainRenderer") < at(VC_MAIN_LEAVES[0]) &&
      VC_MAIN_LEAVES.every((id, i) => i === 0 || at(VC_MAIN_LEAVES[i - 1]) < at(id)) &&
      at(VC_MAIN_LEAVES[VC_MAIN_LEAVES.length - 1]) < at("leaf:tabs"),
    VC_MAIN_LEAVES.map((id) => `${id}=${at(id)}`).join(" ")
  );
  // LEAVES 登记序与骨架标记序对同一份上游次序:vc 主块在 LEAVES 里也必须是逐项递增
  const leafAt = (id) => ids.indexOf(id);
  check(
    "LEAVES 登记序:vc 主块逐项递增且落在 chainRenderer 与 tabs 之间",
    leafAt("leaf:chainRenderer") < leafAt(VC_MAIN_LEAVES[0]) &&
      VC_MAIN_LEAVES.every((id, i) => i === 0 || leafAt(VC_MAIN_LEAVES[i - 1]) < leafAt(id)) &&
      leafAt(VC_MAIN_LEAVES[VC_MAIN_LEAVES.length - 1]) < leafAt("leaf:tabs"),
    VC_MAIN_LEAVES.map((id) => `${id}=${leafAt(id)}`).join(" ")
  );
}

// ---------------------------------------------------------------------------
// 切片 2:bundle 内容缝 —— 符号 / 分发 / 适配 / 残留 / 语法
// ---------------------------------------------------------------------------
const code = existsSync(BUNDLE) ? readFileSync(BUNDLE, "utf8") : "";
check("dist/ui/bundle-1.txt 存在", existsSync(BUNDLE));
if (code) {
  const has = (name, re) => check(`bundle 含 ${name}`, re.test(code));
  has("leaf:versionControlTab(VersionControlTab)", /const VersionControlTab = function/);
  has("leaf:vcViews(VC_VIEWS)", /const VC_VIEWS = /);
  has("leaf:vcTabVisible(vcTabVisible)", /const vcTabVisible = function/);
  has("leaf:vcShellPages(vcRenderTabAt)", /const vcRenderTabAt = function/);
  has("leaf:vcStyles(VC_STYLE_TEXT)", /VC_STYLE_TEXT/);
  has("leaf:vcShellStyles(VC_SHELL_STYLE_TEXT)", /VC_SHELL_STYLE_TEXT/);
  has("leaf:vcFirstScreen(VC_FIRST_SCREEN_PHONE)", /VC_FIRST_SCREEN_PHONE = ["']wf\.gitFirstScreen["']/);
  has("leaf:vcWriteOps(vcWriteOpsOf)", /const vcWriteOpsOf = function/);
  has("leaf:vcBlocks(vcBlocksOf)", /const vcBlocksOf = function/);
  has("shared:vcCapabilityLedger(CAPABILITIES)", /const CAPABILITIES = /);
  has("shared:vcRules(judge)", /function judge\(/);
  // 分发:DeckBody 把 versionControl 交给上游页签组件
  has("DeckBody 分发 versionControl", /st\.tab === ["']versionControl["']/);
  has("DeckBody 挂 VersionControlTab(st, narrow)", /h3?\(VersionControlTab, \{ st: st, narrow: narrow \}|h3?\(VersionControlTab, \{ st, narrow \}/);
  // 宿主适配:wf.git* → deck_git
  check("host 适配:wf.git 前缀路由", /method\.indexOf\(["']wf\.git["']\) === 0/.test(code));
  has("host 适配打 deck_git 且方法名去 wf. 前缀", /callTool\(["']deck_git["'], \{ method: String\(method\)\.slice\(3\)/);
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
// 切片 3:渲染舱 —— 四枚页签 / 改动页 / 历史 / 工作树 / 差异
// ---------------------------------------------------------------------------
let U = null;
const doc = createFakeDom();
const calls = [];
const roEntries = [];
let ResizeObserverCount = 0;
let logPageCalls = 0;
let fakeClient = null;
{
  const { scanWorkspace, thinRow } = await import(pathToFileURL(join(ROOT, "src", "cards.mjs")).href);
  const scan = scanWorkspace(join(ROOT, "test", "fixtures", "u04-list"));
  const tickets = scan.rows.filter((r) => r.type !== "map" && r.type !== "spec");
  const openN = tickets.filter((r) => r.state === "open").length;
  const closedN = tickets.filter((r) => r.state === "closed").length;
  fakeClient = {
    readResource: async (uri) => {
      if (uri.endsWith("workspace.json")) return { contents: [{ text: JSON.stringify({ root: "X:/vc-repo", env: {} }) }] };
      throw new Error("no asset " + uri);
    },
    callTool: async (name, args) => {
      calls.push({ name, args: args || {} });
      if (name === "deck_issue_list") return { structuredContent: { rows: scan.rows.map(thinRow), revision: 1 } };
      if (name === "deck_issue_counts") return { structuredContent: { counts: { open: openN, closed: closedN, total: tickets.length }, revision: 1 } };
      if (name === "deck_issue_list_labels") return { structuredContent: { labels: [], colors: {} } };
      if (name === "deck_git") {
        const m = args.method;
        const a = args.args || {};
        if (m === "gitStatus") return { structuredContent: { ok: true, screen: SCREEN, tier: "full", gitVersion: "git version 2.42.0.windows.2", worktreesNul: true, readAtMs: 1795178982816 } };
        if (m === "gitLog") {
          // 第一次翻页回「还有更早的」,第二次回「没有了」(读数的 allLoaded 由第二次回包收口)。
          logPageCalls++;
          if (logPageCalls === 1) {
            return { structuredContent: { ok: true, commits: LOG_PAGE_2, skip: a.skip, requested: 50, returned: 2, hasMore: true } };
          }
          return { structuredContent: { ok: true, commits: [], skip: a.skip, requested: 50, returned: 0, hasMore: false } };
        }
        if (m === "gitStage") return { structuredContent: { ok: true, staged: (a.paths || []).map((p) => ({ path: p })) } };
        if (m === "gitWriteCheck") return { structuredContent: { ok: true, plan: { mode: "fast-forward" }, ticket: { id: "tk-review-fix", expiresAtMs: Date.now() + 120000 }, remotes: [] } };
        if (m === "gitPull") return { structuredContent: { ok: true, mode: "fast-forward" } };
        if (m === "gitBranches") return { structuredContent: BRANCH_BOARD };
        if (m === "gitMaintenanceRead") return { structuredContent: { ok: true, readAtMs: 1795178982816, objects: [], status: {} } };
        if (m === "gitTaskQuery") return { structuredContent: { ok: true, tasks: [] } };
        if (m === "gitDiff" && a.rev && a.path) return { structuredContent: DIFF_COMMIT_FILE };
        if (m === "gitDiff" && a.rev) return { structuredContent: DIFF_COMMIT };
        if (m === "gitDiff") return { structuredContent: DIFF_WORKING };
        return { structuredContent: { ok: false, error: { kind: "unknown-method", message: "no replay " + m } } };
      }
      throw new Error("no tool " + name);
    },
  };
  // 面板与 vc 页都读 ResizeObserver;回调由测试手动触发(宽度通道)
  class FakeResizeObserver {
    constructor(cb) {
      this.cb = cb;
      this.els = [];
      ResizeObserverCount++;
    }
    observe(el) { this.els.push(el); roEntries.push(this); }
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = FakeResizeObserver;
  if (code) {
    try {
      const win = { innerWidth: 900, innerHeight: 700, addEventListener() {}, removeEventListener() {} };
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
  const byAttr = (name, value) => walk(surface).filter((n) => n.attributes[name] === value);
  const vcRoot = () => qsa(surface, "[data-vc-root]")[0];

  // ---- 四枚页签:vcTabVisible 进闭包后第四枚出现 ----
  const tabsRow = qsa(surface, ".dsws-tabs")[0];
  check("页签行在", !!tabsRow);
  const tabLogs = walk(tabsRow || surface)
    .filter((n) => n.tagName === "BUTTON" && /^panel\.tab\./.test(String(n.attributes["data-log"] || "")))
    .map((n) => n.attributes["data-log"]);
  eq("页签行四枚(上游次序:list/skills/versioncontrol/checks)", tabLogs, ["panel.tab.list", "panel.tab.skills", "panel.tab.versioncontrol", "panel.tab.checks"]);
  check("拉取请求页签仍缺席(prTabVisible 未搬)", !tabBtn("panel.tab.pr"));

  // ---- 点版本管理 → 改动页 ----
  if (st && tabsRow) {
    fireClick(tabBtn("panel.tab.versioncontrol"));
    await tick();
    await settle(60);
    eq("页签壳状态:st.tab = versionControl", st.tab, "versionControl");
    const root = vcRoot();
    check("版本管理根 data-vc-root 在", !!root);
    check("改动页根 data-vc-changes 在", qsa(surface, "[data-vc-changes]").length >= 1);
    check("身份行出分支名 main", textOf(root || surface).includes("main"));
    eq("改动文件行 = 3(1 暂存 + 2 未暂存)", qsa(surface, "[data-vc-file]").length, 3);
    const groups = qsa(surface, "[data-vc-group]").map((g) => g.attributes["data-vc-group"]);
    check("两个分组:已暂存 + 未暂存", groups.includes("staged") && groups.includes("unstaged"), JSON.stringify(groups));
    check("文件路径在(unstaged.txt / src.txt / untracked.txt)", ["unstaged.txt", "src.txt", "untracked.txt"].every((p) => textOf(root || surface).includes(p)));
    check("KPI 计数条:1 已暂存、2 未暂存、0 冲突", textOf(root || surface).includes("1已暂存") && textOf(root || surface).includes("2未暂存") && textOf(root || surface).includes("0存在冲突"));
    eq("三视图页签 = 改动/提交历史/工作树", byAttr("data-vc-view", "changes").length + byAttr("data-vc-view", "commits").length + byAttr("data-vc-view", "worktrees").length, 3);
    check("首屏读取走 deck_git gitStatus", calls.some((c) => c.name === "deck_git" && c.args.method === "gitStatus" && c.args.args && c.args.args.cwd === "X:/vc-repo"), JSON.stringify(calls.filter((c) => c.name === "deck_git")));
    const styleTexts = doc.head.children.map((n) => n.textContent || "");
    check("vcStyles 注入 head([data-vc-root] 皮肤)", styleTexts.some((t) => t.includes("[data-vc-root]")));
    check("vcShellStyles 注入 head([data-vc-shell] 布局)", styleTexts.some((t) => t.includes("[data-vc-shell]")));

    // ---- 切提交历史:两笔提交与标题 ----
    fireClick(byAttr("data-vc-view", "commits")[0]);
    await tick();
    await settle(40);
    eq("提交历史行 = 2", qsa(surface, "[data-vc-commit]").length, 2);
    check("提交标题在(第二次提交:补充一行 / 初次提交:建立基线)", textOf(surface).includes("第二次提交:补充一行") && textOf(surface).includes("初次提交:建立基线"));
    check("短 oid 在(bcfd5a1)", textOf(surface).includes("bcfd5a1"));

    // ---- 提交历史翻页:加载更早 → gitLog 带 skip,行数增加;再加载 → 已全部加载 ----
    const moreBtn = qsa(surface, "[data-vc-more]")[0];
    check("提交历史有「加载更早的提交」入口", !!moreBtn);
    if (moreBtn) {
      const logBefore = calls.filter((c) => c.name === "deck_git" && c.args.method === "gitLog").length;
      fireClick(moreBtn);
      await tick();
      await settle(50);
      const moreCalls = calls.filter((c) => c.name === "deck_git" && c.args.method === "gitLog");
      check("再次调用 deck_git gitLog", moreCalls.length === logBefore + 1, JSON.stringify(moreCalls.slice(-2)));
      const lastCall = moreCalls[moreCalls.length - 1];
      check(
        "gitLog 带 skip(首屏 2 条之后)与 count",
        lastCall && lastCall.args.args && lastCall.args.args.skip === 2 && typeof lastCall.args.args.count === "number",
        JSON.stringify(lastCall && lastCall.args)
      );
      eq("翻页后提交行 = 4", qsa(surface, "[data-vc-commit]").length, 4);
      check("第二批提交标题在(更早的提交:第三笔/第四笔)", textOf(surface).includes("更早的提交:第三笔") && textOf(surface).includes("更早的提交:第四笔"));
      const moreAgain = qsa(surface, "[data-vc-more]")[0];
      check("还有下一批时入口仍在", !!moreAgain);
      if (moreAgain) {
        fireClick(moreAgain);
        await tick();
        await settle(50);
        const moreCalls2 = calls.filter((c) => c.name === "deck_git" && c.args.method === "gitLog");
        check("第二次翻页 skip = 4", moreCalls2[moreCalls2.length - 1]?.args?.args?.skip === 4, JSON.stringify(moreCalls2[moreCalls2.length - 1]?.args));
        eq("没有更多时提交行不减少", qsa(surface, "[data-vc-commit]").length, 4);
        check("hasMore:false 后显示「已全部加载」", textOf(surface).includes("已全部加载"));
      }
    }

    // ---- 切工作树:空态如实说 ----
    fireClick(byAttr("data-vc-view", "worktrees")[0]);
    await tick();
    await settle(40);
    check("工作树视图在(其他工作树 0)", textOf(surface).includes("其他工作树 (0)") || textOf(surface).includes("其他工作树（0）"), textOf(body).slice(0, 200));
    check("工作树空态说明在", textOf(surface).includes("不存在其他工作树"));

    // ---- 回改动页,点文件行看差异 ----
    fireClick(byAttr("data-vc-view", "changes")[0]);
    await tick();
    await settle(40);
    const srcRow = qsa(surface, "[data-vc-file]").find((r) => textOf(r).includes("src.txt"));
    check("src.txt 文件行在", !!srcRow);
    if (srcRow) {
      const inner = walk(srcRow).find((n) => n.attributes["data-press"] === "row" && n !== srcRow);
      check("文件行可点(内层 row 按压层)", !!inner);
      if (inner) {
        fireClick(inner);
        await tick();
        await settle(60);
        check("点文件行发 deck_git gitDiff(带 path)", calls.some((c) => c.name === "deck_git" && c.args.method === "gitDiff" && c.args.args && c.args.args.path === "src.txt" && !c.args.args.rev), JSON.stringify(calls.filter((c) => c.name === "deck_git")));
        eq("补丁行 = 8(4 文件头 + 1 hunk + 3 内容)", qsa(surface, "[data-vc-line]").length, 8);
        check("补丁里有 +line3", textOf(surface).includes("line3"));
      }
    }

    // ---- 改动页写动作:行内暂存 → gitStage → 成功后重读 gitStatus ----
    const closestAttr = (n, attr) => {
      let p = n;
      while (p) {
        if (p.attributes && p.attributes[attr] !== undefined) return p;
        p = p.parentNode;
      }
      return null;
    };
    const stageBtn = qsa(surface, "[data-vc-stage]").find((b) => {
      const row = closestAttr(b, "data-vc-file");
      return row && textOf(row).includes("src.txt");
    });
    check("src.txt 行有暂存入口", !!stageBtn);
    if (stageBtn) {
      const statusBefore = calls.filter((c) => c.name === "deck_git" && c.args.method === "gitStatus").length;
      fireClick(stageBtn);
      await tick();
      await settle(80);
      const gitCalls = calls.filter((c) => c.name === "deck_git");
      const stageIdx = gitCalls.findIndex((c) => c.args.method === "gitStage");
      let statusAfterIdx = -1;
      for (let i = stageIdx + 1; i < gitCalls.length; i++) {
        if (gitCalls[i].args.method === "gitStatus") { statusAfterIdx = i; break; }
      }
      check("点暂存发 gitStage,paths 带 src.txt", stageIdx >= 0 && JSON.stringify(gitCalls[stageIdx].args.args.paths) === JSON.stringify(["src.txt"]), JSON.stringify(gitCalls[stageIdx] && gitCalls[stageIdx].args));
      check("暂存成功后重读 gitStatus(在 gitStage 之后)", stageIdx >= 0 && statusAfterIdx > stageIdx, JSON.stringify(gitCalls.map((c) => c.args.method)));
      check("重读使 gitStatus 调用数 +1", calls.filter((c) => c.name === "deck_git" && c.args.method === "gitStatus").length === statusBefore + 1);
    }

    // ---- 改动页预检分支:拉取 → gitWriteCheck 预检 → 确认卡 → gitPull → 重读 gitStatus ----
    // 上游行内暂存是可逆动作,直接执行、没有预检;带预检的是拉取/推送/提交这一族。
    SCREEN.identity.sync = "tracking";
    SCREEN.identity.ahead = 0;
    SCREEN.identity.behind = 0;
    SCREEN.identity.basisMs = 1795178982816;
    fireClick(byAttr("data-vc-view", "worktrees")[0]);
    await tick();
    fireClick(byAttr("data-vc-view", "changes")[0]);
    await tick();
    await settle(40);
    const pullBtn = byAttr("data-vc-action", "pull").find((n) => n.tagName === "BUTTON");
    check("拉取入口在", !!pullBtn);
    if (pullBtn) {
      check("有上游时拉取入口可点", pullBtn.attributes.disabled === undefined, JSON.stringify(pullBtn.attributes));
      const statusBefore = calls.filter((c) => c.name === "deck_git" && c.args.method === "gitStatus").length;
      fireClick(pullBtn);
      await tick();
      await settle(60);
      const checkCall = calls.find((c) => c.name === "deck_git" && c.args.method === "gitWriteCheck");
      check("拉取先打 gitWriteCheck 预检(op=pull)", !!checkCall && checkCall.args.args.op === "pull", JSON.stringify(checkCall && checkCall.args));
      const confirmOk = qsa(surface, "[data-vc-confirm-ok]")[0];
      check("预检通过后出确认卡", !!qsa(surface, "[data-vc-confirm]")[0] && !!confirmOk);
      if (confirmOk) {
        const gitCallsBefore = calls.filter((c) => c.name === "deck_git").length;
        fireClick(confirmOk);
        await tick();
        await settle(80);
        const after = calls.filter((c) => c.name === "deck_git").slice(gitCallsBefore);
        check("确认后发 gitPull", after.some((c) => c.args.method === "gitPull"), JSON.stringify(after.map((c) => c.args.method)));
        check("拉取成功后重读 gitStatus", after.some((c) => c.args.method === "gitStatus") && calls.filter((c) => c.name === "deck_git" && c.args.method === "gitStatus").length === statusBefore + 1, JSON.stringify(calls.filter((c) => c.name === "deck_git").slice(-4).map((c) => c.args.method)));
      }
    }

    // ---- 点提交行:逐文件清单;再点文件:该提交的补丁 ----
    fireClick(byAttr("data-vc-view", "commits")[0]);
    await tick();
    await settle(40);
    const commitRow = qsa(surface, "[data-vc-commit]")[0];
    check("提交行在", !!commitRow);
    if (commitRow) {
      fireClick(commitRow);
      await tick();
      await settle(60);
      check("提交详情标题在(该提交的变更内容)", textOf(surface).includes("该提交的变更内容"));
      check("提交详情摘要(1 个文件)", textOf(surface).includes("该提交变更了 1 个文件"));
      check("点提交行发 gitDiff(带 rev、不带 path)", calls.some((c) => c.name === "deck_git" && c.args.method === "gitDiff" && c.args.args && c.args.args.rev === SCREEN.commits[0].oid && !c.args.args.path), JSON.stringify(calls.filter((c) => c.name === "deck_git")));
      const commitFileRow = qsa(surface, "[data-vc-file]")[0];
      check("提交详情文件行在", !!commitFileRow);
      if (commitFileRow) {
        const inner = walk(commitFileRow).find((n) => n.attributes["data-press"] === "row" && n !== commitFileRow);
        if (inner) {
          fireClick(inner);
          await tick();
          await settle(60);
          check("点提交文件发 gitDiff(带 rev+path)", calls.some((c) => c.name === "deck_git" && c.args.method === "gitDiff" && c.args.args && c.args.args.rev === SCREEN.commits[0].oid && c.args.args.path === "src.txt"), JSON.stringify(calls.filter((c) => c.name === "deck_git")));
          eq("该提交的补丁行 = 7", qsa(surface, "[data-vc-line]").length, 7);
          check("该提交的补丁里有 +line2", textOf(surface).includes("line2"));
        }
      }
    }

    // ---- 分支页:读 gitBranches 后画分支板 ----
    const vcCall = (phone, args) =>
      fakeClient.callTool("deck_git", { method: String(phone).replace(/^wf\./, ""), args: args || {} }).then((r) => r.structuredContent);
    let branchBoardForSmoke = null;
    check("vc 自检面在(页签/页面壳/分支读数)", !!(U.vc && typeof U.vc.readBranches === "function" && typeof U.vc.renderPageInto === "function"));
    if (U.vc) {
      const branchBefore = calls.filter((c) => c.name === "deck_git" && c.args.method === "gitBranches").length;
      const branchReads = await U.vc.readBranches({}, vcCall, "X:/vc-repo");
      check("读分支页发出 gitBranches", calls.filter((c) => c.name === "deck_git" && c.args.method === "gitBranches").length === branchBefore + 1);
      const board = branchReads && branchReads.branch && branchReads.branch.data;
      branchBoardForSmoke = board || null;
      check("分支读数落库为 ok", branchReads?.branch?.state === "ok" && !!board, JSON.stringify(branchReads?.branch?.error));
      const branchBox = doc.createElement("div");
      doc.body.appendChild(branchBox);
      U.vc.renderPageInto("branch-tags", branchBox, { branchBoard: board, cwd: "X:/vc-repo" });
      await tick();
      await settle(40);
      check("分支页根渲染(data-vc-page=branch-tags)", qsa(branchBox, "[data-vc-root]")[0]?.attributes["data-vc-page"] === "branch-tags");
      check("分支部件渲染(两行分支)", qsa(branchBox, "[data-vc-branch-row]").length === 2);
      check("分支页当前分支是 main", qsa(branchBox, "[data-vc-branch-current]")[0]?.attributes["data-vc-branch-current"] === "main");
      check("分支页动作入口在位(切分支/删除等)", qsa(branchBox, "[data-vc-branch-action]").length >= 2);
    }

    // ---- 管理页开页 smoke:页面注册表逐页渲染,不崩、各画自己的页面根 ----
    if (U.vc) {
      const pages = U.vc.pageIds();
      check("页面注册表有 16 页", pages.length === 16, pages.join(","));
      for (const page of pages) {
        const box = doc.createElement("div");
        doc.body.appendChild(box);
        const before = calls.filter((c) => c.name === "deck_git").length;
        let err = null;
        try {
          U.vc.renderPageInto(page, box, {
            cwd: "X:/vc-repo",
            call: vcCall,
            width: 900,
            branchBoard: page === "branch-tags" ? branchBoardForSmoke : undefined,
          });
          await tick();
          await settle(30);
        } catch (e) {
          err = e;
        }
        const rootNode = qsa(box, "[data-vc-root]")[0];
        check(`管理页 ${page}:渲染不崩`, !err, err && (err.stack || String(err)));
        check(`管理页 ${page}:页面根与页面体在位`, !!rootNode && rootNode.attributes["data-vc-page"] === page && !!qsa(box, "[data-vc-page-body]")[0]);
        // 维护/诊断两页挂载即读(gitMaintenanceRead / gitTaskQuery);其余页在未接数据时只画骨架,不发电话。
        if (page === "maintenance" || page === "diagnostics") {
          const after = calls.filter((c) => c.name === "deck_git").length;
          check(`管理页 ${page}:开页发出读数电话`, after > before, JSON.stringify(calls.filter((c) => c.name === "deck_git").slice(before).map((c) => c.args.method)));
        }
      }
    }

    // ---- 宽档 900:VC 页根在,且没有横向溢出 ----
    for (const ro of roEntries.slice()) {
      try { ro.cb([{ contentRect: { width: 900 } }]); } catch (e) { /* 同上 */ }
    }
    await tick();
    await settle(40);
    const wide = vcRoot();
    check("900 宽下 VC 页根仍在", !!wide);
    if (wide) {
      wide.clientWidth = 900;
      wide.scrollWidth = 900;
      check("900 宽下无横向溢出", wide.scrollWidth <= wide.clientWidth, `scroll=${wide.scrollWidth} client=${wide.clientWidth}`);
    }
    check("900 宽下三视图页签仍在", byAttr("data-vc-view", "changes").length + byAttr("data-vc-view", "commits").length + byAttr("data-vc-view", "worktrees").length === 3);

    // ---- 窄档:宽度通道压到 320,vc 根与三视图页签仍在(页内自己让位) ----
    for (const ro of roEntries.slice()) {
      try { ro.cb([{ contentRect: { width: 320 } }]); } catch (e) { /* 面板的宽度通道失败不影响页内自量 */ }
    }
    await tick();
    await settle(40);
    check("窄档 320 后 vc 根仍在", !!vcRoot());
    check("窄档 320 后三视图页签仍在", byAttr("data-vc-view", "changes").length + byAttr("data-vc-view", "commits").length + byAttr("data-vc-view", "worktrees").length === 3);
    check("窄档后页签行四枚仍在", walk(surface).filter((n) => /^panel\.tab\./.test(String(n.attributes["data-log"] || ""))).length === 4);
  }
}

// ---------------------------------------------------------------------------
// 切片 4(票 03):活动项目切换 → workspace 根跟随 → 版本管理页回到初始视图并取
// 活动项目数据。上游 VersionControlTab 的 cwd 变化复位分支(staleCwd)接住「回初始
// 视图」;vc 读数缓存按 cwd 键控(vcCacheSeedOf/vcCacheSave),不显示上一仓库的缓存。
// 面板补件只有一件事:重取时把活动根与看板数据写回既有 store(refreshActiveProject)。
// ---------------------------------------------------------------------------
{
  const doc2 = createFakeDom();
  const state = { root: "X:/repo-a" }; // 服务端活动根:翻转它 = 模拟已有人切了项目
  const calls2 = [];
  const SCREEN_A = JSON.parse(JSON.stringify(SCREEN));
  const SCREEN_B = JSON.parse(JSON.stringify(SCREEN));
  SCREEN_B.identity.branch = "feature/proj-b";
  SCREEN_B.identity.worktreeDisplay = "repo-b";
  SCREEN_B.commits = [
    {
      oid: "bbbb0f5c9e2b4a7f8d1c3e5a7b9d0f2a4c6e8b10",
      short: "bbbb0f5",
      author: "Tester",
      email: "t@example.com",
      authorDateMs: 1795178983000,
      commitDateMs: 1795178983000,
      subject: "b 仓基线提交",
      parents: [],
    },
  ];
  const client2 = {
    readResource: async (uri) => {
      if (uri.endsWith("workspace.json")) return { contents: [{ text: JSON.stringify({ root: state.root, env: {} }) }] };
      throw new Error("no asset " + uri);
    },
    callTool: async (name, args) => {
      calls2.push({ name, args: args || {} });
      if (name === "deck_issue_list") return { structuredContent: { rows: [], revision: 1 } };
      if (name === "deck_issue_counts") return { structuredContent: { counts: { open: 0, closed: 0, total: 0 }, revision: 1 } };
      if (name === "deck_issue_list_labels") return { structuredContent: { labels: [], colors: {} } };
      if (name === "deck_git") {
        const m = args.method;
        const a = args.args || {};
        const screen = state.root === "X:/repo-b" ? SCREEN_B : SCREEN_A;
        if (m === "gitStatus") return { structuredContent: { ok: true, screen, tier: "full", gitVersion: "git version 2.42.0.windows.2", worktreesNul: true, readAtMs: 1795178982816 } };
        if (m === "gitLog") return { structuredContent: { ok: true, commits: screen.commits, skip: a.skip, requested: 50, returned: screen.commits.length, hasMore: false } };
        if (m === "gitTaskQuery") return { structuredContent: { ok: true, tasks: [] } };
        return { structuredContent: { ok: false, error: { kind: "unknown-method", message: "no replay " + m } } };
      }
      throw new Error("no tool " + name);
    },
  };
  const win2 = { innerWidth: 900, innerHeight: 700, addEventListener() {}, removeEventListener() {} };
  try {
    new Function("window", "document", `"use strict";\n${code}`)(win2, doc2);
    const U2 = win2.MattSkillsUpstream;
    await U2.boot({ client: client2, doc: doc2, fetchData: true });
    await tick();
    const st2 = U2.list.storeOf();
    check("票03: boot 后面板 cwd 是项目 A", st2 && st2.cwd === "X:/repo-a", st2 && st2.cwd);
    const surface2 = doc2.body.children[0];
    const tabBtn2 = walk(surface2).filter((n) => n.attributes["data-log"] === "panel.tab.versioncontrol" && n.tagName === "BUTTON")[0];
    if (st2 && tabBtn2) {
      fireClick(tabBtn2);
      await tick();
      await settle(60);
      check("票03: 版本页在且显示 A 的分支(main)", st2.tab === "versionControl" && textOf(surface2).includes("main"), st2.tab);
      check(
        "票03: 首屏 gitStatus 用 A 的 cwd",
        calls2.some((c) => c.name === "deck_git" && c.args.method === "gitStatus" && c.args.args && c.args.args.cwd === "X:/repo-a"),
        JSON.stringify(calls2.filter((c) => c.name === "deck_git").map((c) => c.args.method))
      );
      // 进到提交历史视图(非初始视图),确认旧仓数据在画面上
      const commitsBtn = walk(surface2).filter((n) => n.attributes["data-vc-view"] === "commits")[0];
      fireClick(commitsBtn);
      await tick();
      await settle(40);
      check("票03: 已在提交历史视图(A 的提交标题在)", qsa(surface2, "[data-vc-commit]").length >= 1 && textOf(surface2).includes("第二次提交:补充一行"), textOf(surface2).slice(0, 120));

      // 服务端活动项目已切到 B(workspace 资源回 B 的根)→ 面板重取
      state.root = "X:/repo-b";
      check("票03: 补件入口在(U2.projects.refreshActiveProject)", typeof U2.projects?.refreshActiveProject === "function", typeof U2.projects?.refreshActiveProject);
      await U2.projects.refreshActiveProject();
      await tick();
      await settle(80);
      check("票03: 重取后 cwd 是项目 B", st2.cwd === "X:/repo-b", st2.cwd);
      check("票03: 仍停在版本管理页签(没有弹回列表)", st2.tab === "versionControl", st2.tab);
      check("票03: 版本页回到初始改动视图(data-vc-changes 在)", qsa(surface2, "[data-vc-changes]").length >= 1);
      check("票03: 上一仓库的提交行已清(不是 A 的缓存)", qsa(surface2, "[data-vc-commit]").length === 0, String(qsa(surface2, "[data-vc-commit]").length));
      check(
        "票03: 重取后 gitStatus 用 B 的 cwd(取活动项目数据)",
        calls2.some((c) => c.name === "deck_git" && c.args.method === "gitStatus" && c.args.args && c.args.args.cwd === "X:/repo-b"),
        JSON.stringify(calls2.filter((c) => c.name === "deck_git" && c.args.method === "gitStatus").map((c) => c.args.args && c.args.args.cwd))
      );
      check("票03: 显示 B 的分支(feature/proj-b)", textOf(surface2).includes("feature/proj-b"), textOf(surface2).slice(0, 160));
      check("票03: A 的提交标题不再显示(不串仓)", !textOf(surface2).includes("第二次提交:补充一行"));
    } else {
      check("票03: boot 后面板 cwd 是项目 A", false, "boot/页签缺失");
    }
  } catch (e) {
    check("票03: 切换重取切片不抛错", false, e && e.stack ? e.stack.split("\n").slice(0, 6).join(" | ") : String(e));
  }
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
