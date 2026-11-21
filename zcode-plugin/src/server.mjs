// MattSkills MCP 服务(工单 01 骨架 + 工单 02 只读工具 + 工单 06 写工具):stdio JSON-RPC 握手
// + panel.html 资源供给 + deck_issue_list / deck_issue_get / deck_issue_counts 三个读工具
// (上游契约 list/get/counts 的直翻)+ deck_issue_list_labels(规范标签与内置色表,纯常量)
// + deck_map_tickets(地图子票按需取,上游 wf.mapTickets 的等价物)
// + create/update/setLabels/comment/close/reopen 六件写工具,
// 返回结构化结果 + 中文人话摘要。零依赖;工作区根取宿主注入的 ZCODE_WORKSPACE_ROOT。
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { scanWorkspace, computeCounts, findCardByScan, thinRow } from "./cards.mjs";
import { commentIssue, updateStatusIssue, closeIssue, reopenIssue, setLabelsIssue, createIssue } from "./write.mjs";
import { createDeckWatch, refreshFromEnv } from "./watch.mjs";
import { buildEnvChain, summarizeEnvCheck } from "./env-check.mjs";
import { readSkillDoc } from "./skill-doc.mjs";
import { mapTicketsFor } from "./map-tickets.mjs";
import { readRegistry, resolveActive } from "./registry.mjs";
import { createGitBridge } from "./git-entry.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_NAME = "zcode-mattpocock-skills-deck";
const VERSION = "0.1.0";
const PANEL_URI = `ui://${PLUGIN_NAME}/panel.html`;
const PANEL_MIME = "text/html;profile=mcp-app";
// 面板次级资产(bundle-*.txt / assets.json):资源模板 + 白名单 + 大小上限
// (ui-host.md,同 excalidraw 惯例:JS 段故意 .txt 后缀,资源通道只搬文本)。
const ASSET_PREFIX = `ui://${PLUGIN_NAME}/assets/`;
const ASSET_RE = /^(bundle-\d+\.txt|assets\.json)$/;
const ASSET_LIMIT = 8 * 1024 * 1024;
// 工单 U01:上游面板壳的 uiWorkspace 垫片数据源 —— 服务端注入的静态工作区根
// (env 同现有 server 的注入口径)。上游 client 在 DSH 有宿主工作区服务,这里用
// 一条只读资源把同样的形状递给 bundle 的 seam(panel.html boot 经桥拉回)。
const WORKSPACE_URI = `ui://${PLUGIN_NAME}/workspace.json`;

// 规范标签(docs/agents/triage-labels.md,与上游 canonical-labels.ts 一字不差)与
// 内置标签色表(上游 defaultLabelPalette 直拷;旧 UI 的两份同值副本已随 ms-* 层删除,
// 本表是唯一副本),deck_issue_list_labels 原样返回这两份。
const CANONICAL_LABELS = ["needs-triage", "needs-info", "ready-for-agent", "ready-for-human", "wontfix"];
const LABEL_COLORS = {
  "bug": "d73a4a",
  "needs-triage": "fbca04",
  "needs-info": "5319e7",
  "ready-for-agent": "0e8a16",
  "ready-for-human": "b60205",
  "wontfix": "ffffff",
  "wayfinder:map": "8b5cf6",
  "wayfinder:research": "0ea5e9",
  "wayfinder:prototype": "f59e0b",
  "wayfinder:grilling": "9d7cd8",
  "wayfinder:task": "10b981",
};

const reply = (id, result) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
const fail = (id, code, message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);

/** 宿主注入的工作区根(manifest env 的 ${ZCODE_PROJECT_DIR});没给回落进程当前目录。 */
function workspaceRoot() {
  return String(process.env.ZCODE_WORKSPACE_ROOT || process.cwd());
}

// 工单 08:`.scratch/` 监听 + 数据修订号(发条见 watch.mjs;测试经 ZCODE_REFRESH_* 收短)。
const deckWatch = createDeckWatch(workspaceRoot(), refreshFromEnv(process.env));

// 票 01:活动项目进程内状态 —— 只存清单里的名字,null = home-repo。新会话复位,
// 不持久化;每次工具调用经 readRegistry 现读清单再解析根(同名项改路径自然指新路径)。
let activeProjectName = null;

const TOOLS = [
  {
    name: "deck_issue_list",
    description:
      "列出当前工作区 .scratch/ 下的全部卡片(规格/地图容器行 + 工单行),返回薄行(不含正文与评论全文)。可用 state/labels/type/keys 过滤;labels 为 AND 精确匹配。响应携带数据修订号 revision(与 deck_issue_counts 同值)。",
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string", enum: ["open", "closed", "all"], description: "只列哪种状态,缺省 all" },
        labels: { type: "array", items: { type: "string" }, description: "必须同时带上的标签(AND),缺省不过滤" },
        type: { type: "string", enum: ["issue", "map", "spec"], description: "只要哪一类,缺省全部" },
        keys: { type: "array", items: { type: "string" }, description: "批量按编号取" },
      },
    },
  },
  {
    name: "deck_issue_get",
    description:
      "读一张卡的全文(含正文与评论时间线)。key 用两位编号(01/1 都认,补零),退化卡身份带目录前缀(目录/文件名);同号多卡时取目录序第一张。",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string", description: "卡编号或退化身份,如 01 或 demo/03-撞号卡" } },
      required: ["key"],
    },
  },
  {
    name: "deck_issue_counts",
    description:
      "当前工作区各口径计数:open/closed/total 与面板胶囊口径(可接=frontier、占用、认领、阻塞、故障=bug、诊断=needs-triage)。空工作区返回 0 与 empty 标志,不是错误。响应携带数据修订号 revision;.scratch 监听在线时,卡片文件读不动则整体拒绝(不给偏小的数),离线降级为静默跳过。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "deck_issue_list_labels",
    description:
      "返回规范标签五枚(needs-triage、needs-info、ready-for-agent、ready-for-human、wontfix,口径见 docs/agents/triage-labels.md)与内置 11 色标签色表(hex 无 # 前缀,与面板色表同源)。纯常量查询,不读工作区;给卡打标签与配色展示都按这份。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "deck_map_tickets",
    description:
      "取一张地图/规格的全部子票(含已关闭,含已关闭容器的子票),并给出总数与完成数。key 是容器编号(本地 00),同号容器在不同工作单元里是两张时用 effortId 指定;回包与面板地图详情页的取数契约同形({ok,key,items,stats,total,fetched,capped,missing})。",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "地图/规格编号(本地为 00)" },
        effortId: { type: "string", description: "工作单元目录名(.scratch/ 下);同号地图有多张时必填" },
      },
      required: ["key"],
    },
  },
  {
    name: "deck_issue_create",
    description:
      "建一张工单票:在 .scratch/<effort>/issues/ 下取下一个空闲编号,写 NN-slug.md(标题转 slug,中文保留)。文件头带 DSH-CREATED 与 DSH-ISSUE-KIND: ticket,正文为 impl 票形状(# NN: 标题 + **Status:** open + 可选 **Labels:**)。写回纪律:只产生新文件,不动任何既有卡。",
    inputSchema: {
      type: "object",
      properties: {
        effort: { type: "string", description: "工作单元目录名(.scratch/ 下),如 m1-core-board;不存在会连目录一起建" },
        title: { type: "string", description: "卡标题(必填,进 H1 与文件名 slug)" },
        body: { type: "string", description: "正文(markdown,可空)" },
        labels: { type: "array", items: { type: "string" }, description: "初始标签名单(可空)" },
      },
      required: ["effort", "title"],
    },
  },
  {
    name: "deck_issue_update",
    description:
      "改一张卡的状态行(只动那一行,正文永不重排)。值原样写进 Status 行(加粗/裸写法随原文件);resolved/completed/closed/done 读回计为 closed,其余为 open。已是同值时是幂等 noop,不写盘。",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "卡编号或退化身份;同号多卡必须带目录前缀(如 m1-core-board/01)" },
        status: { type: "string", description: "状态行的新值,如 ready-for-agent / claimed / in-progress" },
        expectedUpdatedAt: { type: "string", description: "乐观并发:上次看到的卡 updatedAt(ISO);对不上拒绝写" },
      },
      required: ["key", "status"],
    },
  },
  {
    name: "deck_issue_set_labels",
    description:
      "整份替换一张卡的标签行(只动那一行/那条 DSH-LABELS 注释)。有可见 Labels 行改可见行;只有 DSH-LABELS 注释改注释(清空删行);两处都有则两处一起改。同值时幂等 noop,不写盘。",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "卡编号或退化身份;同号多卡必须带目录前缀" },
        labels: { type: "array", items: { type: "string" }, description: "新标签全名单(空数组 = 清空标签)" },
        expectedUpdatedAt: { type: "string", description: "乐观并发:上次看到的卡 updatedAt(ISO);对不上拒绝写" },
      },
      required: ["key", "labels"],
    },
  },
  {
    name: "deck_issue_comment",
    description:
      "给一张卡追加评论:块格式 `### 谁 — ISO时间`,追加到 ## Comments 段尾;无该段则在文末新建。只追加,正文与既有评论一字不动。actor 缺省 local。",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "卡编号或退化身份;同号多卡必须带目录前缀" },
        body: { type: "string", description: "评论正文(markdown,可多行)" },
        actor: { type: "string", description: "评论者名字,缺省 local" },
        expectedUpdatedAt: { type: "string", description: "乐观并发:上次看到的卡 updatedAt(ISO);对不上拒绝写" },
      },
      required: ["key", "body"],
    },
  },
  {
    name: "deck_issue_close",
    description:
      "关一张卡:状态行改 closed(只动那一行);给了 reason 则把原因追加为一条评论(末条同文不重复)。已关的卡再关是幂等 noop。",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "卡编号或退化身份;同号多卡必须带目录前缀" },
        reason: { type: "string", description: "关闭原因(可空;给则记为一条评论)" },
        actor: { type: "string", description: "原因评论的署名,缺省 local" },
        expectedUpdatedAt: { type: "string", description: "乐观并发:上次看到的卡 updatedAt(ISO);对不上拒绝写" },
      },
      required: ["key"],
    },
  },
  {
    name: "deck_issue_reopen",
    description:
      "重开一张卡:状态行改 ready-for-agent(只动那一行)。已开的卡再开是幂等 noop。",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "卡编号或退化身份;同号多卡必须带目录前缀" },
        expectedUpdatedAt: { type: "string", description: "乐观并发:上次看到的卡 updatedAt(ISO);对不上拒绝写" },
      },
      required: ["key"],
    },
  },
  {
    name: "deck_skill_doc",
    description:
      "读本机技能目录里的 SKILL.md 原文:按 工作区 .zcode/skills → ~/.zcode/skills → ~/.agents/skills → 插件内置 skills 的顺序找 <name>/SKILL.md,同名先命中。成功返回 markdown 正文与绝对路径(ok:true);找不到回 ok:false(不是错误)。file 参数本批不支持,给了回 ok:false。只读,不写盘。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "技能名(目录名),如 ask-matt" },
        file: { type: "string", description: "技能内文件引用(本批不支持;给了会回 ok:false)" },
      },
      required: ["name"],
    },
  },
  {
    name: "deck_env_check",
    description:
      "环境检查:按本地真实事实组装检查链快照(工作区有无 .scratch/、卡片可读、监听在线、工具桥通、技能根可读、是否 git 仓),返回链步骤(状态/标题/原因/修复动作)与计数。只读,不写盘;每次调用都按当前状态重新扫描。force=true 表示用户亲手重检(语义标记,不回错)。",
    inputSchema: {
      type: "object",
      properties: {
        force: { type: "boolean", description: "true = 用户亲手点「重新检查」;工具每次都真扫,本字段只表达调用意图" },
      },
    },
  },
  {
    name: "deck_git",
    description:
      "版本管理页签的 git 数据面:上游全部 wf.git* 电话(约 60 余条,以方法表为准)经此一条工具路由;路径限制在工作区根内;只读与写操作都在此。method 是电话名(如 gitStatus/gitFirstScreen/gitLog),args 必须是对象,原样转给该电话;回包形状与上游一致({ok,...} 或 {ok:false,error:{kind,message}})。",
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string", description: "git 电话方法名,如 gitStatus" },
        args: { type: "object", description: "该电话的参数对象(原样转给上游;cwd 缺省为工作区根)" },
      },
      required: ["method"],
    },
  },
  {
    name: "deck_project_list",
    description:
      "列出项目清单(home-repo 根 .deck/projects.json,现读现算):活动项目、home-repo 与全部条目(name/path/isHome/valid;被跳过的条目带原因)、warnings 与清单状态(存在/路径/解析错误)。没有清单文件时只有 home-repo。切换活动项目用 deck_project_use。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "deck_project_use",
    description:
      "切换活动项目:只接受清单里的名字(不区分大小写),切到 home-repo 是幂等 noop;切换只影响之后的调用。活动项目被移出清单或改名后,下一次工具调用自动回退 home-repo 并在回包中说明。返回切换后的活动项目与同一份清单状态。",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "项目名(清单条目的 name;缺省名取目录名)" } },
      required: ["name"],
    },
  },
];

/** 卡的显示标签:#effort/编号(根级无目录前缀);退化身份的 key 已带目录前缀,不重复拼。 */
function displayKey(card) {
  const key = String(card.key || "");
  if (key.includes("/")) return `#${key}`;
  return `#${card.effortId ? `${card.effortId}/` : ""}${key}`;
}

function labelNames(card) {
  return Array.isArray(card.labels) ? card.labels.map((l) => String(l.name || "")) : [];
}

function summarizeList(sc) {
  if (sc.empty) return "此工作区还没有 .scratch/ 工单目录,先跑 /setup-matt-pocock-skills 或 /to-tickets 建卡。";
  const c = sc.counts;
  const openTitles = sc.rows
    .filter((r) => r.state === "open")
    .slice(0, 5)
    .map((r) => `${displayKey(r)} ${r.title}`);
  const more = sc.rows.filter((r) => r.state === "open").length - openTitles.length;
  const lines = [
    `共 ${sc.rows.length} 张卡(容器 ${c.maps + c.specs} / 票 ${c.total},open ${c.open} · closed ${c.closed})。`,
  ];
  if (openTitles.length) lines.push(openTitles.join("、") + (more > 0 ? ` …(另有 ${more} 张 open)` : ""));
  return lines.join("\n");
}

function summarizeGet(card) {
  const labels = labelNames(card);
  const bits = [displayKey(card), card.title, `(${card.state}${labels.length ? `,标签:${labels.join("/")}` : ""},${card.comments.length} 条评论)`];
  return bits.join(" ");
}

function summarizeCounts(sc) {
  if (sc.empty) return "此工作区还没有 .scratch/ 工单目录,先跑 /setup-matt-pocock-skills 或 /to-tickets 建卡。";
  const c = sc.counts;
  return `共 ${c.total} 张票:可接 ${c.frontier} · 占用 ${c.occupied} · 阻塞 ${c.blocked} · 故障 ${c.bug} · 诊断 ${c.triage} · 已关闭 ${c.closed}(另有地图 ${c.maps}、规格 ${c.specs} 个容器)`;
}

/** deck_skill_doc(工单 02):读本机技能目录里的 SKILL.md 原文。与 .scratch 数据面无关,
 *  先于扫描/监听返回(工作区读不动也不该挡技能页)。错误分层:名字不合法/读盘异常 →
 *  isError;技能不存在 → ok:false + reason=missing(上游画缺文说明,不是错误)。 */
function handleSkillDoc(a, root) {
  const name = String(a.name === undefined || a.name === null ? "" : a.name).trim();
  if (a.file !== undefined && a.file !== null && String(a.file) !== "") {
    return {
      content: [{ type: "text", text: "file 参数本批不支持:只读技能的 SKILL.md 原文,没有随包文件引用链。" }],
      structuredContent: { ok: false, name, reason: "unsupported" },
    };
  }
  let res;
  try {
    res = readSkillDoc({ name }, { workspaceRoot: root, env: process.env });
  } catch (e) {
    return { content: [{ type: "text", text: `读技能 ${name || "(空名)"} 的原文时出错:${e && e.message ? e.message : String(e)}` }], isError: true };
  }
  if (!res || res.ok !== true) {
    if (res && res.reason === "invalid") {
      return { content: [{ type: "text", text: `技能名不合法:${res.message}(只认目录名,不许 /、\\、..、绝对路径)。` }], isError: true };
    }
    return {
      content: [{ type: "text", text: `本机技能目录里找不到 ${name} 的 SKILL.md(找过 工作区/.zcode/skills、~/.zcode/skills、~/.agents/skills、插件内置 skills)。` }],
      structuredContent: { ok: false, name, reason: "missing" },
    };
  }
  const bytes = Buffer.byteLength(res.md, "utf8");
  return {
    content: [{ type: "text", text: `已读 ${res.name} 的技能原文(${res.path},${bytes} 字节,来源:${res.source})。` }],
    structuredContent: res,
  };
}

// 工单 01:版本管理 git 数据面。bridge 模块级懒初始化,绑定工作区根(换根时重建);
// 只暴露上游 createVersionControl() 回包里的 handleGit*(tickets 表与 runGitCommand 不对外)。
let gitBridge = null;
let gitBridgeRoot = "";
function deckGitBridge(root) {
  if (!gitBridge || gitBridgeRoot !== root) {
    gitBridge = createGitBridge({ workspaceRoot: root, env: process.env });
    gitBridgeRoot = root;
  }
  return gitBridge;
}

/** deck_git 回包:handler 的 {ok,...} 原样进 structuredContent;未知方法/边界/执行失败都是人话。 */
function deckGitReply(method, result) {
  if (result && result.ok === true) {
    return { content: [{ type: "text", text: `git 方法 ${method} 已执行。` }], structuredContent: result };
  }
  const error = result && result.error && typeof result.error === "object" ? result.error : {};
  const why = error.message || "没有给出原因";
  return {
    content: [{ type: "text", text: `git 方法 ${method || "(空)"} 失败:${why}` }],
    structuredContent: result,
  };
}

/** deck_git:一条工具路由全部 git 电话。工具级异常(装配失败)才 isError;电话失败按结构化回包。 */
function handleDeckGit(a) {
  const method = String(a.method === undefined || a.method === null ? "" : a.method).trim();
  let pending;
  try {
    pending = deckGitBridge(workspaceRoot()).call(method, a.args);
  } catch (e) {
    return {
      content: [{ type: "text", text: `git 能力初始化失败:${e && e.message ? e.message : String(e)}` }],
      isError: true,
    };
  }
  return Promise.resolve(pending).then(
    (result) => deckGitReply(method, result),
    (e) => ({
      content: [{ type: "text", text: `git 方法 ${method || "(空)"} 执行出错:${e && e.message ? e.message : String(e)}` }],
      isError: true,
    })
  );
}

// ---- 票 01:项目清单与活动项目(deck_project_list / deck_project_use) ----

/** 清单回包的活动/清单状态形状(list 与 use 同一份)。 */
function registryState(reg, active) {
  return {
    ok: true,
    active: { name: active.name, path: active.root, isHome: active.isHome },
    home: { name: reg.home.name, path: reg.home.path, isHome: true },
    projects: [{ ...reg.home }, ...reg.projects],
    warnings: reg.warnings,
    registry: { status: reg.status, path: reg.file, error: reg.error },
  };
}

/** 清单回包的中文摘要:活动项目 + 清单规模 + warnings/broken 全部可见(不只写日志)。 */
function registrySummary(reg, active, head) {
  const lines = [head];
  if (reg.status === "missing") lines.push("没有 .deck/projects.json,项目只有 home-repo。");
  else {
    const skipped = reg.projects.filter((p) => !p.valid).length;
    const avail = reg.projects.length - skipped + 1; // home-repo 恒可用
    lines.push(`清单共 ${avail} 个可用项目(home-repo 第一${skipped > 0 ? `,另有 ${skipped} 条被跳过` : ""})。`);
  }
  for (const w of reg.warnings) lines.push(`警告:${w}`);
  if (reg.status === "broken") lines.push(`清单读不出来:${reg.error};已按单根(home-repo)处理。`);
  if (active.note) lines.push(active.note);
  return lines.join("\n");
}

function handleProjectList(reg, active) {
  const sc = { ...registryState(reg, active), note: active.note || null };
  const head = `活动项目:${active.name}(${active.root})。`;
  return { content: [{ type: "text", text: registrySummary(reg, active, head) }], structuredContent: sc };
}

/** deck_project_use:只认清单里的名字;切 home-repo 是幂等 noop;坏名字明确报错并列可用名,不猜。 */
function handleProjectUse(a, reg) {
  const wanted = String(a.name === undefined || a.name === null ? "" : a.name).trim();
  if (!wanted) {
    return { content: [{ type: "text", text: "缺少 name:请给项目清单里的名字(deck_project_list 可看全量)。" }], isError: true };
  }
  const useReply = (active, head) => ({
    content: [{ type: "text", text: registrySummary(reg, active, head) }],
    structuredContent: { ...registryState(reg, active), note: null },
  });
  if (wanted.toLowerCase() === reg.home.name.toLowerCase()) {
    activeProjectName = null; // 回 home-repo:幂等 noop
    return useReply({ root: reg.home.path, name: reg.home.name, isHome: true, note: null }, `活动项目已设为 home-repo(${reg.home.name})。`);
  }
  const hit = reg.projects.find((p) => p.valid && p.name.toLowerCase() === wanted.toLowerCase());
  if (!hit) {
    const available = [reg.home.name, ...reg.projects.filter((p) => p.valid).map((p) => p.name)].join("、");
    const why = reg.status === "broken" ? `清单读不出来(${reg.error}),暂时只有 home-repo。` : "";
    return { content: [{ type: "text", text: `没有叫「${wanted}」的项目,不能猜。可用的项目:${available}。${why}` }], isError: true };
  }
  activeProjectName = hit.name;
  return useReply({ root: hit.path, name: hit.name, isHome: false, note: null }, `活动项目已切到 ${hit.name}(${hit.path})。`);
}

// 活动项目回退说明:只在真回退时附加;home-repo/无清单时读工具回包与原来逐字一致。
function withActiveNote(sc, active) {
  return active.note ? { ...sc, active: { name: active.name, path: active.root, isHome: active.isHome }, note: active.note } : sc;
}
function activeNoteSuffix(active) {
  return active.note ? `\n${active.note}` : "";
}

/** 工具实现:全部走同一次扫描,返回 {content, structuredContent} 或 {content, isError}。 */
function handleCall(name, args) {
  const a = args && typeof args === "object" ? args : {};
  const homeRoot = workspaceRoot();
  // 版本管理 git 数据面先于 .scratch 扫描分派:.scratch 坏掉不挡 git(工单 01)。
  // 票 01 范围:git 桥仍绑工作区根;随活动项目重根是后续票。
  if (name === "deck_git") return handleDeckGit(a);
  // 技能原文与 .scratch 数据面无关:在扫描之前分派(只读技能根;技能根与项目无关,不随活动项目)。
  if (name === "deck_skill_doc") return handleSkillDoc(a, homeRoot);

  // 票 01:入口解析活动项目 —— 清单现读现算,捕获-后用(deck_project_use 只影响之后的调用)。
  const reg = readRegistry(homeRoot);
  const active = resolveActive(reg, activeProjectName);
  if (active.note) activeProjectName = null; // 回退即落定:清单是唯一信任边界,失效选择就地清掉

  if (name === "deck_project_list") return handleProjectList(reg, active);
  if (name === "deck_project_use") return handleProjectUse(a, reg);

  const scanRoot = active.isHome ? homeRoot : active.root;
  const scan = scanWorkspace(scanRoot);
  deckWatch.observe(scan); // 请求即探测:签名变了推进 revision(监听离线时的降级新鲜度)

  if (name === "deck_issue_list") {
    let rows = scan.rows;
    const state = String(a.state === undefined || a.state === null ? "all" : a.state).trim().toLowerCase();
    if (state === "open" || state === "closed") rows = rows.filter((r) => r.state === state);
    if (a.type) rows = rows.filter((r) => r.type === a.type);
    const wanted = Array.isArray(a.labels)
      ? a.labels.map((s) => String(s).trim()).filter(Boolean)
      : [];
    if (wanted.length) {
      rows = rows.filter((r) => {
        const names = labelNames(r);
        return wanted.every((w) => names.includes(w));
      });
    }
    if (Array.isArray(a.keys) && a.keys.length) {
      const keys = a.keys.map(String);
      rows = rows.filter((r) => keys.includes(r.key));
    }
    const sc = {
      workspaceRoot: scanRoot,
      revision: deckWatch.state().revision,
      empty: scan.empty,
      units: scan.units.map((u) => ({ effortId: u.effortId, kind: u.kind, legacy: u.legacy })),
      counts: computeCounts(scan.rows),
      total: rows.length,
      rows: rows.map(thinRow),
    };
    return { content: [{ type: "text", text: summarizeList({ ...sc, rows: sc.rows }) + activeNoteSuffix(active) }], structuredContent: withActiveNote(sc, active) };
  }

  if (name === "deck_issue_get") {
    const key = String(a.key === undefined || a.key === null ? "" : a.key).trim();
    if (!key) return { content: [{ type: "text", text: "缺少 key:请给卡编号(如 01)或退化身份(如 demo/03-撞号卡)。" }], isError: true };
    const card = findCardByScan(scan, key);
    if (!card) {
      return { content: [{ type: "text", text: `找不到卡 ${key}:这个工作区没有这张卡(现有 ${scan.rows.length} 张,可先 deck_issue_list 看全量)。` + activeNoteSuffix(active) }], isError: true };
    }
    const sc = { workspaceRoot: scanRoot, card };
    return { content: [{ type: "text", text: summarizeGet(card) + activeNoteSuffix(active) }], structuredContent: withActiveNote(sc, active) };
  }

  if (name === "deck_map_tickets") {
    const res = mapTicketsFor(scan, a);
    if (res.ok !== true) {
      return { content: [{ type: "text", text: String((res.error && res.error.message) || "地图子票没取到") + activeNoteSuffix(active) }], isError: true };
    }
    return {
      content: [{ type: "text", text: `地图 ${res.key}:${res.stats.total} 张子票(已关闭 ${res.stats.closed} 张)。` + activeNoteSuffix(active) }],
      structuredContent: withActiveNote(res, active),
    };
  }

  if (name === "deck_issue_counts") {
    // 卡片文件读不动的分派(工单 02 遗留):监听在线按上游「整体拒绝」(不给偏小的数);
    // 离线是降级态,回落静默跳过(list 永远静默跳过)。
    if (deckWatch.state().online && Array.isArray(scan.unreadable) && scan.unreadable.length) {
      const rel = scan.unreadable.map((p) => relative(scanRoot, p)).join("、");
      return {
        content: [
          { type: "text", text: `有 ${scan.unreadable.length} 张卡片文件读不动(${rel}),counts 整体拒绝:不给偏小的数。可先 deck_issue_list 看可读部分,修复文件后会自动跟上。` + activeNoteSuffix(active) },
        ],
        isError: true,
      };
    }
    const counts = computeCounts(scan.rows);
    const sc = { workspaceRoot: scanRoot, revision: deckWatch.state().revision, empty: scan.empty, counts };
    return { content: [{ type: "text", text: summarizeCounts(sc) + activeNoteSuffix(active) }], structuredContent: withActiveNote(sc, active) };
  }

  if (name === "deck_issue_list_labels") {
    const sc = { labels: CANONICAL_LABELS, colors: LABEL_COLORS };
    return {
      content: [{ type: "text", text: `规范标签 ${CANONICAL_LABELS.length} 枚:${CANONICAL_LABELS.join("、")};内置标签色 ${Object.keys(LABEL_COLORS).length} 枚(与面板色表同源,hex 无 # 前缀)。` }],
      structuredContent: sc,
    };
  }

  // ---- 工单 03:环境检查链(链快照唯一渲染;按本地真实事实组装,不造假) ----
  if (name === "deck_env_check") {
    // scan 是 handleCall 顶部现扫的这一次(每个请求都重扫 —— 「真重扫」不是 force 才有的分支);
    // 活动项目在内时本工具仍按工作区根(home-repo)组链,自扫一次(票 01 范围:环境检查
    // 随活动项目走是后续票)。force 只表达调用意图(用户亲手点「重新检查」),非布尔按未传处理。
    const force = a.force === true;
    const envScan = active.isHome ? scan : scanWorkspace(homeRoot);
    const snapshot = buildEnvChain(homeRoot, { scan: envScan, watchOnline: deckWatch.state().online, env: process.env });
    const summary = summarizeEnvCheck(snapshot);
    return {
      content: [{ type: "text", text: force ? `已按当前状态重扫。${summary}` : summary }],
      structuredContent: { ok: true, snapshot, checkedAt: new Date().toISOString() },
    };
  }

  // ---- 工单 06:写工具六件套(全部走 write.mjs 的单写者队列;返回 Promise) ----
  // 票 01 范围:写仍作用于工作区根(home-repo);随活动项目路由是后续票。
  if (name === "deck_issue_comment") {
    return commentIssue(homeRoot, a.key, { body: a.body, actor: a.actor, expectedUpdatedAt: a.expectedUpdatedAt }).then((res) => finishWrite(homeRoot, res, name));
  }
  if (name === "deck_issue_update") {
    return updateStatusIssue(homeRoot, a.key, { status: a.status, expectedUpdatedAt: a.expectedUpdatedAt }).then((res) => finishWrite(homeRoot, res, name));
  }
  if (name === "deck_issue_close") {
    return closeIssue(homeRoot, a.key, { reason: a.reason, actor: a.actor, expectedUpdatedAt: a.expectedUpdatedAt }).then((res) => finishWrite(homeRoot, res, name));
  }
  if (name === "deck_issue_reopen") {
    return reopenIssue(homeRoot, a.key, { expectedUpdatedAt: a.expectedUpdatedAt }).then((res) => finishWrite(homeRoot, res, name));
  }
  if (name === "deck_issue_set_labels") {
    return setLabelsIssue(homeRoot, a.key, { labels: a.labels, expectedUpdatedAt: a.expectedUpdatedAt }).then((res) => finishWrite(homeRoot, res, name));
  }
  if (name === "deck_issue_create") {
    return createIssue(homeRoot, { effort: a.effort, title: a.title, body: a.body, labels: a.labels }).then((res) => finishWrite(homeRoot, res, name));
  }

  return { content: [{ type: "text", text: `未知工具 ${name}` }], isError: true };
}

/** 写操作收尾:失败透人话;成功主动喂 watch 一次新扫描(revision 立即前进,不等 fs.watch 防抖/栅格)。 */
function finishWrite(root, res, name) {
  if (!res || res.ok === false) {
    return { content: [{ type: "text", text: (res && res.message) || `写操作 ${name} 失败` }], isError: true };
  }
  try {
    deckWatch.observe(scanWorkspace(root)); // 写后主动失效:面板下一拍 counts 就能看到新 revision
  } catch {}
  const card = res.card;
  // 可寻址 key(与 get 同口径):正常票带目录前缀;退化身份的 key 自带前缀不重复拼。
  const addrKey = card ? (String(card.key).includes("/") ? card.key : card.effortId ? `${card.effortId}/${card.key}` : card.key) : undefined;
  return {
    content: [{ type: "text", text: res.message || "已写入。" }],
    structuredContent: { ok: true, changed: !!res.changed, revision: deckWatch.state().revision, key: addrKey, card },
  };
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.id === undefined) return; // 通知无需应答
  switch (m.method) {
    case "initialize":
      return reply(m.id, {
        protocolVersion: m.params?.protocolVersion || "2025-06-18",
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: PLUGIN_NAME, version: VERSION },
      });
    case "ping":
      return reply(m.id, {});
    case "tools/list":
      return reply(m.id, { tools: TOOLS });
    case "tools/call":
      // 写工具(工单 06)返回 Promise(单写者队列),读工具仍是同步结果;统一 then 收口。
      try {
        return Promise.resolve(handleCall(m.params?.name, m.params?.arguments)).then(
          (r) => reply(m.id, r),
          (e) => reply(m.id, { content: [{ type: "text", text: `处理 ${m.params?.name} 时出错:${e && e.message ? e.message : String(e)}` }], isError: true })
        );
      } catch (e) {
        return reply(m.id, { content: [{ type: "text", text: `读工作区时出错:${e && e.message ? e.message : String(e)}` }], isError: true });
      }
    case "resources/list":
      return reply(m.id, {
        resources: [
          { uri: PANEL_URI, name: "MattSkills panel", mimeType: PANEL_MIME },
          { uri: WORKSPACE_URI, name: "MattSkills workspace", mimeType: "application/json" },
        ],
      });
    case "resources/read": {
      const uri = String(m.params?.uri || "");
      if (uri === WORKSPACE_URI) {
        // 静态工作区根(运行时现算,不落盘):root 与 env 同 manifest 注入口径
        return reply(m.id, {
          contents: [
            {
              uri: WORKSPACE_URI,
              mimeType: "application/json",
              text: JSON.stringify({
                root: workspaceRoot(),
                plugin: PLUGIN_NAME,
                version: VERSION,
                env: { ZCODE_WORKSPACE_ROOT: process.env.ZCODE_WORKSPACE_ROOT || "" },
              }),
            },
          ],
        });
      }
      if (uri === PANEL_URI) {
        return reply(m.id, {
          contents: [{ uri: PANEL_URI, mimeType: PANEL_MIME, text: readFileSync(join(HERE, "ui", "panel.html"), "utf8") }],
        });
      }
      if (uri.startsWith(ASSET_PREFIX)) {
        const name = uri.slice(ASSET_PREFIX.length);
        if (!ASSET_RE.test(name)) return fail(m.id, -32002, `invalid_resource: Unknown UI asset ${name}`);
        let text;
        try {
          text = readFileSync(join(HERE, "ui", name), "utf8");
        } catch {
          return fail(m.id, -32002, `resource not found: ${uri}`);
        }
        if (Buffer.byteLength(text, "utf8") > ASSET_LIMIT) return fail(m.id, -32002, "resource_too_large: Asset exceeds limit");
        return reply(m.id, {
          contents: [{ uri, mimeType: name.endsWith(".json") ? "application/json" : "text/plain", text }],
        });
      }
      return fail(m.id, -32002, `resource not found: ${uri}`);
    }
    default:
      return fail(m.id, -32601, `method not found: ${m.method}`);
  }
}).on("close", () => {
  deckWatch.stop();
  process.exit(0);
});
