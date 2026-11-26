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
import { backendStateOf, backendSummary } from "./github/backend.mjs";
import { dispatchGithub } from "./github/dispatch.mjs";
import { resolveGhPath } from "./github/gh-path.mjs";
import { resolveRepoLocal } from "./github/repo.mjs";
import { setChoice } from "./github/state.mjs";

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
// 票 02:监听随活动项目 —— 单例可重建;换根时 stop 旧(清定时器含退避重试、关旧 watcher,
// 旧根不再推进)、新建挂新根;新实例从旧 revision 起步,初扫必推进一次 = 切换恰好 +1。
let deckWatch = createDeckWatch(workspaceRoot(), refreshFromEnv(process.env));
let deckWatchRoot = workspaceRoot();
function ensureWatch(root) {
  if (root === deckWatchRoot) return;
  const prevRevision = deckWatch.state().revision;
  deckWatch.stop();
  deckWatch = createDeckWatch(root, { ...refreshFromEnv(process.env), startRevision: prevRevision });
  deckWatchRoot = root;
}

/** 票 02/05/07:`.scratch/` 监听跟着目标根的后端走 —— GitHub 根不挂监听(停掉并把监听根
 *  复位成空串,之后切回 markdown 时 ensureWatch 才能重新挂上);markdown 目标照旧 ensureWatch。
 *  deck_project_use 与 deck_backend_use 共用这一处(两个入口都能把活动根翻成 GitHub)。 */
function settleWatch(targetRoot) {
  if (backendStateOf(targetRoot).id === "github") {
    deckWatch.stop();
    deckWatchRoot = "";
    return;
  }
  ensureWatch(targetRoot);
}

// 票 01:活动项目进程内状态 —— 只存清单里的名字,null = home-repo。新会话复位,
// 不持久化;每次工具调用经 readRegistry 现读清单再解析根(同名项改路径自然指新路径)。
let activeProjectName = null;

// 票 03:危险动作哨兵 —— 版本管理页有「预检签票已发、还没凭票执行」的写域动作时,
// deck_project_use 拒绝切换,免得确认卡里的 push/reset 落到另一个仓库(spec 用户故事 19)。
//
// 为什么在 server 层记哨兵:上游签票状态住在 vc 家族的票据表(writeTickets/changesTickets
// 等闭包 Map,versionControlCheck.ts 发票、versionControlWrite.ts 核票)里;桥(git-entry.mjs)
// 的对外面只有 handleGit* 派生的电话,票据表不进方法表、电话回包也只带单张票 —— 从桥的
// 既有电话查不到整表。所以按宿主垫片外的最小口径记:
//   · 记入 —— deck_git 回包带票(result.ticket.id 且带 expiresAtMs)时,把哨兵推到该票自己
//     的到期时刻(上游票期 = TICKET_TTL_MS,config/timeouts.yaml 的 120 秒,即「确认窗口」);
//     缺 expiresAtMs 时退同值兜底。
//   · 结清 —— args.ticketId 非空的电话(全部凭票执行档)无论成败都清零:票据已被赎回或
//     已作废,这个动作不再算「未确认」。
//   · 取消在面板侧只是关掉确认卡、不发任何电话,服务端看不到;这条路径由票据过期自然
//     结清(与上游「票过期即作废」同一口径,最多一个票期后恢复可切)。
// 按 gitRootOf 字符串键控:哨兵只对签票时的那个活动根生效,换根后互不影响。
const dangerUntil = new Map();
const TICKET_TTL_MS = 120000;
function dangerArm(root, result) {
  if (!result || result.ok !== true) return;
  const t = result.ticket;
  if (!t || typeof t.id !== "string" || !t.id) return;
  const exp = Number(t.expiresAtMs);
  const until = Number.isFinite(exp) && exp > 0 ? exp : Date.now() + TICKET_TTL_MS;
  dangerUntil.set(root, Math.max(dangerUntil.get(root) || 0, until));
}
function dangerSettle(root, args) {
  if (args && typeof args === "object" && typeof args.ticketId === "string" && args.ticketId !== "") {
    dangerUntil.set(root, 0);
  }
}
function dangerLive(root) {
  return (dangerUntil.get(root) || 0) > Date.now();
}

const TOOLS = [
  {
    name: "deck_issue_list",
    description:
      "列出当前工作区 .scratch/ 下的全部卡片(规格/地图容器行 + 工单行),返回薄行(不含正文与评论全文)。可用 state/labels/type/keys 过滤;labels 为 AND 精确匹配。响应携带数据修订号 revision(与 deck_issue_counts 同值)。后端是 GitHub 时列出该项目远端仓库的议题(拉取请求不出现):不带 cursor 是整表(开闭一起、最多 500 条,截断或降级时 partial 为真);带 cursor 是按页(每页 50 条,回 nextCursor 与 total,游标原样回传)。",
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string", enum: ["open", "closed", "all"], description: "只列哪种状态,缺省 all" },
        labels: { type: "array", items: { type: "string" }, description: "必须同时带上的标签(AND),缺省不过滤" },
        type: { type: "string", enum: ["issue", "map", "spec"], description: "只要哪一类,缺省全部" },
        keys: { type: "array", items: { type: "string" }, description: "批量按编号取" },
        cursor: { type: "string", description: "GitHub 后端的分页游标:上一页回的 nextCursor 原样传入;缺省是整表读取" },
      },
    },
  },
  {
    name: "deck_issue_get",
    description:
      "读一张卡的全文(含正文与评论时间线)。key 用两位编号(01/1 都认,补零),退化卡身份带目录前缀(目录/文件名);同号多卡时取目录序第一张。后端是 GitHub 时 key 是议题号(补不补零都认),评论分页按十进制偏移:commentsFirst 缺省 50(上限 200)、commentsAfter 是上一页回的偏移,回包带评论总数与 commentsPage{hasNextPage,endCursor}(本版只翻到前 200 条)。",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "卡编号或退化身份,如 01 或 demo/03-撞号卡" },
        commentsFirst: { type: "number", description: "GitHub 后端:这一页要几条评论,缺省 50,夹在 1..200" },
        commentsAfter: { type: "string", description: "GitHub 后端:评论分页的十进制偏移串,取 commentsPage.endCursor 原样回传;缺省 0" },
      },
      required: ["key"],
    },
  },
  {
    name: "deck_issue_counts",
    description:
      "当前工作区各口径计数:open/closed/total 与面板胶囊口径(可接=frontier、占用、认领、阻塞、故障=bug、诊断=needs-triage)。空工作区返回 0 与 empty 标志,不是错误。响应携带数据修订号 revision;.scratch 监听在线时,卡片文件读不动则整体拒绝(不给偏小的数),离线降级为静默跳过。",
    inputSchema: {
      type: "object",
      properties: {
        force: { type: "boolean", description: "GitHub 后端:面板回到前台或环境检查点「重新检查」时置 true,跳过探测限速真探一次;本地 Markdown 忽略" },
      },
    },
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
    name: "deck_map_link",
    description:
      "GitHub 后端:把议题挂到地图下或摘到根(parentKey),加/改阻塞边(blockedBy,阻塞它的那几张票号)。自环与成环会被拒、不落盘。至少给 parentKey 或 blockedBy 其中一个;local Markdown 后端不支持本工具(请直接改卡片正文的 Blocked by 行)。",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "被挂/被加边的议题号(如 12 或 04)" },
        parentKey: { type: ["string", "null"], description: "挂到这张地图/规格的议题号下;null = 摘到根" },
        blockedBy: { type: "array", items: { type: "string" }, description: "阻塞它的那几张票号;整份替换现有阻塞边" },
      },
      required: ["key"],
    },
  },
  {
    name: "deck_issue_create",
    description:
      "建一张工单票。本地 Markdown:在 .scratch/<effort>/issues/ 下取下一个空闲编号,写 NN-slug.md(标题转 slug,中文保留),effort 必填;文件头带 DSH-CREATED 与 DSH-ISSUE-KIND: ticket。GitHub 后端:在项目远端仓库建议题,effort 没有意义会被忽略(摘要里会说明),可以带 parentKey(建出来就挂在地图下)与 idempotencyKey(同一个键重试只建一张,两次拿到同一个号)。写回纪律:两个后端都只产生新票,不动既有票。",
    inputSchema: {
      type: "object",
      properties: {
        effort: { type: "string", description: "工作单元目录名(.scratch/ 下),如 m1-core-board;不存在会连目录一起建。只对本地 Markdown 有意义,GitHub 后端忽略" },
        title: { type: "string", description: "卡/议题标题(必填,进 H1 与文件名 slug)" },
        body: { type: "string", description: "正文(markdown,可空)" },
        labels: { type: "array", items: { type: "string" }, description: "初始标签名单(可空)" },
        parentKey: { type: "string", description: "GitHub 后端:建出来就挂在这张地图/规格的议题号下(本地 Markdown 忽略)" },
        idempotencyKey: { type: "string", description: "GitHub 后端:幂等键;同一个键重试只建一张、两次拿到同一个号(本地 Markdown 忽略)" },
      },
      required: ["title"],
    },
  },
  {
    name: "deck_issue_update",
    description:
      "改一张卡的状态行(只动那一行,正文永不重排)。值原样写进 Status 行(加粗/裸写法随原文件);resolved/completed/closed/done 读回计为 closed,其余为 open。已是同值时是幂等 noop,不写盘。GitHub 后端:status=claimed 把当前登录人加进认领人(不顶掉已有的);关闭类的值会关议题;其它状态值明确拒绝并指路;可选 assignees(登录名数组,@me 是当前登录人)整份替换认领人。",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "卡编号或退化身份;同号多卡必须带目录前缀(如 m1-core-board/01);GitHub 后端是议题号" },
        status: { type: "string", description: "状态行的新值,如 ready-for-agent / claimed / in-progress;GitHub 后端只认 claimed 与关闭类值(与 assignees 至少给一个)" },
        assignees: { type: "array", items: { type: "string" }, description: "GitHub 后端:认领人登录名数组(整份替换;@me 是当前登录人);本地 Markdown 忽略" },
        expectedUpdatedAt: { type: "string", description: "乐观并发:上次看到的卡 updatedAt(ISO);对不上拒绝写" },
      },
      required: ["key"],
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
      "环境检查:按本地真实事实组装检查链快照(本地 Markdown 六步:工作区有无 .scratch/、卡片可读、监听在线、工具桥通、技能根可读、是否 git 仓;活动项目是 GitHub 时七步:本地 git、仓库关联、gh 安装、登录、仓库访问、工具桥、技能根),返回链步骤(状态/标题/原因/修复动作)与计数。只读,不写盘;本地链每次调用都按当前状态重新扫描。force=true 表示用户亲手点「重新检查」:GitHub 链跳过缓存、真重探一遍并强制探测一次;本地链只表达调用意图。",
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
  {
    name: "deck_backend_use",
    description:
      "切换活动项目的议题后端:只认 markdown(本地 Markdown 卡片)与 github(GitHub 议题)。只影响当前会话,按项目根的真实路径记,新会话复位(回到锚文件或默认)。切到 github 前做两项本地预检(gh 可解析、项目根能解析出 GitHub 仓库),不过就拒绝并说明,不切换。成功回包与 deck_project_list 同一份形状。",
    inputSchema: {
      type: "object",
      properties: { backend: { type: "string", description: "markdown | github" } },
      required: ["backend"],
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

/** deck_git:一条工具路由全部 git 电话,作用于活动项目仓库(票 03)。工具级异常(装配失败)
 *  才 isError;电话失败按结构化回包。活动项目回退时说明附在人话尾部、结构化回包带 note
 *  (仅回退时;home/无清单回包与原来逐字一致)。 */
function handleDeckGit(a, root, active) {
  const method = String(a.method === undefined || a.method === null ? "" : a.method).trim();
  dangerSettle(root, a.args); // 凭票执行档(ticketId 非空)先结清哨兵,成败另说
  let pending;
  try {
    pending = deckGitBridge(root).call(method, a.args);
  } catch (e) {
    return {
      content: [{ type: "text", text: `git 能力初始化失败:${e && e.message ? e.message : String(e)}` }],
      isError: true,
    };
  }
  const settle = (reply, result) => {
    if (result && typeof result === "object") dangerArm(root, result); // 带票回包:确认窗口开始
    if (!active || !active.note) return reply;
    return {
      content: [{ type: "text", text: reply.content[0].text + activeNoteSuffix(active) }],
      structuredContent: withActiveNote(reply.structuredContent, active),
    };
  };
  return Promise.resolve(pending).then(
    (result) => settle(deckGitReply(method, result), result),
    (e) => ({
      content: [{ type: "text", text: `git 方法 ${method || "(空)"} 执行出错:${e && e.message ? e.message : String(e)}` }],
      isError: true,
    })
  );
}

// ---- 票 01:项目清单与活动项目(deck_project_list / deck_project_use) ----

/** 清单回包的活动/清单状态形状(list 与 use 同一份)。
 *  票 02:活动项目多一块 backend(后端 id、来源、仓库、可写、提示)。 */
function registryState(reg, active) {
  return {
    ok: true,
    active: { name: active.name, path: active.root, isHome: active.isHome, backend: active.backend },
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

/** deck_project_use:只认清单里的名字;切 home-repo 是幂等 noop;坏名字明确报错并列可用名,不猜。
 *  版本管理页有未确认的危险 git 动作时拒绝真正的切换(票 03;切到当前项目本身是幂等
 *  noop,根没动,不挡)。票 02:落定分支(含 home 幂等)重挂监听;拒绝分支不落定,不重挂。
 *  票 05:目标根是 GitHub 后端时不挂 .scratch 监听 —— 停掉并把监听根复位成空串,
 *  之后切回 markdown 时 ensureWatch 才能重新挂上;markdown 目标照旧 ensureWatch。 */
function handleProjectUse(a, reg, active, activeGitRoot, homeRoot) {
  const wanted = String(a.name === undefined || a.name === null ? "" : a.name).trim();
  if (!wanted) {
    return { content: [{ type: "text", text: "缺少 name:请给项目清单里的名字(deck_project_list 可看全量)。" }], isError: true };
  }
  // 票 02:回包带目标项目根的后端结论(与 list 同一份形状)。
  const useReply = (next, head) => {
    const sc = { ...registryState(reg, { ...next, backend: backendStateOf(next.root) }), note: null };
    return { content: [{ type: "text", text: registrySummary(reg, next, head) }], structuredContent: sc };
  };
  const activeIsHome = active ? active.isHome : true;
  // noop = 目标就是当前活动项目(名字同,或都是 home-repo):根没动,危险哨兵不挡。
  const toHome = wanted.toLowerCase() === reg.home.name.toLowerCase();
  const noop = toHome ? activeIsHome : !activeIsHome && active.name.toLowerCase() === wanted.toLowerCase();
  if (!noop && dangerLive(activeGitRoot)) {
    return {
      content: [
        {
          type: "text",
          text: `切换被拒:版本管理页还有未确认的危险 git 动作(预检签票未结)。请先在版本管理页确认执行,或取消后等票据过期(最多 ${Math.round(TICKET_TTL_MS / 1000)} 秒),再切换项目。`,
        },
      ],
      isError: true,
    };
  }
  if (toHome) {
    activeProjectName = null; // 回 home-repo:幂等 noop
    settleWatch(homeRoot); // 票 02/05:监听跟着切(已在 home 根上是 noop;home 是 GitHub 后端则不挂)
    return useReply({ root: reg.home.path, name: reg.home.name, isHome: true, note: null }, `活动项目已设为 home-repo(${reg.home.name})。`);
  }
  const hit = reg.projects.find((p) => p.valid && p.name.toLowerCase() === wanted.toLowerCase());
  if (!hit) {
    const available = [reg.home.name, ...reg.projects.filter((p) => p.valid).map((p) => p.name)].join("、");
    const why = reg.status === "broken" ? `清单读不出来(${reg.error}),暂时只有 home-repo。` : "";
    return { content: [{ type: "text", text: `没有叫「${wanted}」的项目,不能猜。可用的项目:${available}。${why}` }], isError: true };
  }
  activeProjectName = hit.name;
  settleWatch(hit.path); // 票 02/05:切换落定时停旧挂新(markdown)或不挂(GitHub),取消待执行的退避重试
  return useReply({ root: hit.path, name: hit.name, isHome: false, note: null }, `活动项目已切到 ${hit.name}(${hit.path})。`);
}

/** deck_backend_use(票 02):按名字切活动项目的后端。只认 markdown / github。
 *  切 github 前两项本地预检(gh 可解析、项目根能解析出 GitHub 仓库),不过就拒绝:
 *  不写 state、不改任何东西。登录态与网络留给环境检查(票 06)。
 *  成功回包与 deck_project_list 同一份形状(registryState + note:null)。
 *  票 07:切换落定后按新后端停/挂 .scratch 监听(与 deck_project_use 同一条 settleWatch);
 *  三条拒绝带结构化回包 {ok:false,error:{kind,message,raw}},人话照旧进 content。 */
function handleBackendUse(a, reg, active) {
  const wanted = String(a.backend === undefined || a.backend === null ? "" : a.backend).trim().toLowerCase();
  const reject = (text, kind) => ({
    content: [{ type: "text", text }],
    isError: true,
    structuredContent: { ok: false, error: { kind, message: text, raw: "" } },
  });
  if (wanted !== "markdown" && wanted !== "github") {
    return reject(`后端只支持 markdown、github;收到「${wanted || "(空)"}」。可用值:markdown、github。`, "parse");
  }
  if (wanted === "github") {
    if (!resolveGhPath(process.env)) {
      return reject(
        "切换被拒:找不到 gh 可执行文件(没装 GitHub CLI,或没在 PATH 里)。先装 GitHub CLI 并加进 PATH,或用环境变量 ZCODE_GH_PATH 指向 gh.exe 的绝对路径,然后重启 ZCode。",
        "env"
      );
    }
    if (!resolveRepoLocal(active.root)) {
      return reject(
        `切换被拒:项目根 ${active.root} 的远端解析不出 GitHub 仓库(origin 没指向 github.com)。先把项目根接到一个 GitHub 仓库,再切到 GitHub 后端。`,
        "not-found"
      );
    }
  }
  setChoice(active.root, wanted);
  settleWatch(active.root);
  const backend = backendStateOf(active.root);
  return {
    content: [
      {
        type: "text",
        text: `已切换:${backendSummary(active.root, backend)}。只影响本会话,新会话按锚文件或默认重新判定。`,
      },
    ],
    structuredContent: { ...registryState(reg, { ...active, backend }), note: null },
  };
}

// 活动项目回退说明:只在真回退时附加;home-repo/无清单时读工具回包与原来逐字一致。
function withActiveNote(sc, active) {
  return active.note
    ? {
        ...sc,
        active: { name: active.name, path: active.root, isHome: active.isHome, backend: active.backend },
        note: active.note,
      }
    : sc;
}
function activeNoteSuffix(active) {
  return active.note ? `\n${active.note}` : "";
}

// 票 03:git 桥根按活动项目取。home-repo 仍用宿主注入的原样路径(与旧口径逐字一致,
// 边界回包里出现的根路径不变);非 home 用清单解析出的项目根。桥缓存按这个字符串换根重建。
function gitRootOf(active, homeRoot) {
  return active.isHome ? homeRoot : active.root;
}

/** 工具实现:全部走同一次扫描,返回 {content, structuredContent} 或 {content, isError}。 */
function handleCall(name, args) {
  const a = args && typeof args === "object" ? args : {};
  const homeRoot = workspaceRoot();

  // 票 01:入口解析活动项目 —— 清单现读现算,捕获-后用(deck_project_use 只影响之后的调用)。
  const reg = readRegistry(homeRoot);
  const active = resolveActive(reg, activeProjectName);
  if (active.note) activeProjectName = null; // 回退即落定:清单是唯一信任边界,失效选择就地清掉
  // 票 02:后端结论每次调用现算(锚文件现读、手选读进程内状态);清单回包与回退说明共用同一份。
  active.backend = backendStateOf(active.root);

  // 版本管理 git 数据面先于 .scratch 扫描分派:.scratch 坏掉不挡 git(工单 01)。
  // 票 03:桥根随活动项目(home 仍用宿主注入的原样路径)。
  if (name === "deck_git") return handleDeckGit(a, gitRootOf(active, homeRoot), active);
  // 技能原文与 .scratch 数据面无关:在扫描之前分派(只读技能根;技能根与项目无关,不随活动项目)。
  if (name === "deck_skill_doc") return handleSkillDoc(a, homeRoot);

  if (name === "deck_project_list") return handleProjectList(reg, active);
  // 票 02 + 票 03:use 带活动项目与 git 根(危险哨兵键控)与 home 根(监听重挂)。
  if (name === "deck_project_use") return handleProjectUse(a, reg, active, gitRootOf(active, homeRoot), homeRoot);
  // 票 02:后端手选(全局;只影响当前会话,按项目根真实路径记)。
  if (name === "deck_backend_use") return handleBackendUse(a, reg, active);

  // 票 03:GitHub 后端先把本插件负责的工具名交给 dispatch.mjs(五个读工具 + 尚未接的写工具)。
  // GitHub 项目不扫 .scratch、不挂监听 —— 所以这一段必须在 ensureWatch/scanWorkspace 之前。
  if (active.backend && active.backend.id === "github") {
    return dispatchGithub(name, a, {
      root: active.isHome ? homeRoot : active.root,
      backend: active.backend,
      active,
      // 票 06:环境检查的技能步锚 home-repo(技能根不随项目);force 只对 deck_env_check 有意义。
      homeRoot,
      force: a.force === true,
      // 规范标签名单与内置色表只有一份(本文件顶部),经这里递给 GitHub 的标签工具。
      palette: { canonical: CANONICAL_LABELS, colors: LABEL_COLORS },
    });
  }

  const scanRoot = active.isHome ? homeRoot : active.root;
  ensureWatch(scanRoot); // 活动根变了(含失效回退到 home-repo)→ 停旧挂新
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
    // 票 02:链随活动项目组 —— scratch/cards/watch/git 四步按活动根,技能步锚工作区根
    // (home-repo,技能根不随项目)。force 只表达调用意图(用户亲手点「重新检查」),非布尔按未传处理。
    const force = a.force === true;
    const snapshot = buildEnvChain(scanRoot, { scan, watchOnline: deckWatch.state().online, env: process.env, skillRoot: homeRoot });
    const summary = summarizeEnvCheck(snapshot);
    return {
      content: [{ type: "text", text: force ? `已按当前状态重扫。${summary}` : summary }],
      structuredContent: { ok: true, snapshot, checkedAt: new Date().toISOString() },
    };
  }

  // ---- 工单 06:写工具六件套(全部走 write.mjs 的单写者队列;返回 Promise) ----
  // 票 02:写落活动项目(scanRoot;活动项目是 home-repo 时与原来逐字一致)。
  if (name === "deck_issue_comment") {
    return commentIssue(scanRoot, a.key, { body: a.body, actor: a.actor, expectedUpdatedAt: a.expectedUpdatedAt }).then((res) => finishWrite(scanRoot, res, name, active));
  }
  if (name === "deck_issue_update") {
    return updateStatusIssue(scanRoot, a.key, { status: a.status, expectedUpdatedAt: a.expectedUpdatedAt }).then((res) => finishWrite(scanRoot, res, name, active));
  }
  if (name === "deck_issue_close") {
    return closeIssue(scanRoot, a.key, { reason: a.reason, actor: a.actor, expectedUpdatedAt: a.expectedUpdatedAt }).then((res) => finishWrite(scanRoot, res, name, active));
  }
  if (name === "deck_issue_reopen") {
    return reopenIssue(scanRoot, a.key, { expectedUpdatedAt: a.expectedUpdatedAt }).then((res) => finishWrite(scanRoot, res, name, active));
  }
  if (name === "deck_issue_set_labels") {
    return setLabelsIssue(scanRoot, a.key, { labels: a.labels, expectedUpdatedAt: a.expectedUpdatedAt }).then((res) => finishWrite(scanRoot, res, name, active));
  }
  if (name === "deck_issue_create") {
    return createIssue(scanRoot, { effort: a.effort, title: a.title, body: a.body, labels: a.labels }).then((res) => finishWrite(scanRoot, res, name, active));
  }
  if (name === "deck_map_link") {
    const text = "本地 Markdown 看板不支持用工具挂图/加阻塞边；请直接改卡片正文的 `Blocked by` 行。";
    return {
      content: [{ type: "text", text }],
      isError: true,
      structuredContent: { ok: false, error: { kind: "unsupported", message: text, raw: "" } },
    };
  }

  return { content: [{ type: "text", text: `未知工具 ${name}` }], isError: true };
}

/** 写摘要的活动项目名前缀(票 02):仅活动项目不是 home-repo 时包一层;home-repo 逐字不变。 */
function withProjectName(message, active) {
  return active && !active.isHome ? `项目 ${active.name}:${message}` : message;
}

/** 写操作收尾:失败透人话;成功主动喂 watch 一次新扫描(revision 立即前进,不等 fs.watch 防抖/栅格)。 */
function finishWrite(root, res, name, active) {
  if (!res || res.ok === false) {
    return { content: [{ type: "text", text: withProjectName((res && res.message) || `写操作 ${name} 失败`, active) }], isError: true };
  }
  try {
    // 写后主动失效:面板下一拍 counts 就能看到新 revision。根仅与监听根一致时才喂
    // (写排队期间发生切换的话,这次写属于旧根 —— 不许推进新根的 revision)。
    if (root === deckWatchRoot) deckWatch.observe(scanWorkspace(root));
  } catch {}
  const card = res.card;
  // 可寻址 key(与 get 同口径):正常票带目录前缀;退化身份的 key 自带前缀不重复拼。
  const addrKey = card ? (String(card.key).includes("/") ? card.key : card.effortId ? `${card.effortId}/${card.key}` : card.key) : undefined;
  return {
    content: [{ type: "text", text: withProjectName(res.message || "已写入。", active) }],
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
        // 工作区根(运行时现算,不落盘):票 03 起 root 为活动项目根(面板版本页 cwd 的取数
        // 来源,切换后跟着走);env.ZCODE_WORKSPACE_ROOT 仍是宿主注入的 home 根(home-repo 身份)。
        // 无清单时活动项目就是 home-repo,root 与旧口径逐字一致。
        const reg = readRegistry(workspaceRoot());
        const active = resolveActive(reg, activeProjectName);
        return reply(m.id, {
          contents: [
            {
              uri: WORKSPACE_URI,
              mimeType: "application/json",
              text: JSON.stringify({
                root: gitRootOf(active, workspaceRoot()),
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
