// MattSkills MCP 服务(工单 01 骨架 + 工单 02 只读工具 + 工单 06 写工具):stdio JSON-RPC 握手
// + panel.html 资源供给 + deck_issue_list / deck_issue_get / deck_issue_counts 三个读工具
// (上游契约 list/get/counts 的直翻)+ deck_issue_list_labels(规范标签与内置色表,纯常量)
// + create/update/setLabels/comment/close/reopen 六件写工具,
// 返回结构化结果 + 中文人话摘要。零依赖;工作区根取宿主注入的 ZCODE_WORKSPACE_ROOT。
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { scanWorkspace, computeCounts, findCardByScan, thinRow } from "./cards.mjs";
import { commentIssue, updateStatusIssue, closeIssue, reopenIssue, setLabelsIssue, createIssue } from "./write.mjs";
import { createDeckWatch, refreshFromEnv } from "./watch.mjs";
import { readSkillDoc } from "./skill-doc.mjs";

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

/** 工具实现:全部走同一次扫描,返回 {content, structuredContent} 或 {content, isError}。 */
function handleCall(name, args) {
  const a = args && typeof args === "object" ? args : {};
  const root = workspaceRoot();
  // 技能原文与 .scratch 数据面无关:在扫描之前分派(本工具只读技能根)。
  if (name === "deck_skill_doc") return handleSkillDoc(a, root);
  const scan = scanWorkspace(root);
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
      workspaceRoot: root,
      revision: deckWatch.state().revision,
      empty: scan.empty,
      units: scan.units.map((u) => ({ effortId: u.effortId, kind: u.kind, legacy: u.legacy })),
      counts: computeCounts(scan.rows),
      total: rows.length,
      rows: rows.map(thinRow),
    };
    return { content: [{ type: "text", text: summarizeList({ ...sc, rows: sc.rows }) }], structuredContent: sc };
  }

  if (name === "deck_issue_get") {
    const key = String(a.key === undefined || a.key === null ? "" : a.key).trim();
    if (!key) return { content: [{ type: "text", text: "缺少 key:请给卡编号(如 01)或退化身份(如 demo/03-撞号卡)。" }], isError: true };
    const card = findCardByScan(scan, key);
    if (!card) {
      return { content: [{ type: "text", text: `找不到卡 ${key}:这个工作区没有这张卡(现有 ${scan.rows.length} 张,可先 deck_issue_list 看全量)。` }], isError: true };
    }
    const sc = { workspaceRoot: root, card };
    return { content: [{ type: "text", text: summarizeGet(card) }], structuredContent: sc };
  }

  if (name === "deck_issue_counts") {
    // 卡片文件读不动的分派(工单 02 遗留):监听在线按上游「整体拒绝」(不给偏小的数);
    // 离线是降级态,回落静默跳过(list 永远静默跳过)。
    if (deckWatch.state().online && Array.isArray(scan.unreadable) && scan.unreadable.length) {
      const rel = scan.unreadable.map((p) => relative(root, p)).join("、");
      return {
        content: [
          { type: "text", text: `有 ${scan.unreadable.length} 张卡片文件读不动(${rel}),counts 整体拒绝:不给偏小的数。可先 deck_issue_list 看可读部分,修复文件后会自动跟上。` },
        ],
        isError: true,
      };
    }
    const counts = computeCounts(scan.rows);
    const sc = { workspaceRoot: root, revision: deckWatch.state().revision, empty: scan.empty, counts };
    return { content: [{ type: "text", text: summarizeCounts(sc) }], structuredContent: sc };
  }

  if (name === "deck_issue_list_labels") {
    const sc = { labels: CANONICAL_LABELS, colors: LABEL_COLORS };
    return {
      content: [{ type: "text", text: `规范标签 ${CANONICAL_LABELS.length} 枚:${CANONICAL_LABELS.join("、")};内置标签色 ${Object.keys(LABEL_COLORS).length} 枚(与面板色表同源,hex 无 # 前缀)。` }],
      structuredContent: sc,
    };
  }

  // ---- 工单 06:写工具六件套(全部走 write.mjs 的单写者队列;返回 Promise) ----
  if (name === "deck_issue_comment") {
    return commentIssue(root, a.key, { body: a.body, actor: a.actor, expectedUpdatedAt: a.expectedUpdatedAt }).then((res) => finishWrite(root, res, name));
  }
  if (name === "deck_issue_update") {
    return updateStatusIssue(root, a.key, { status: a.status, expectedUpdatedAt: a.expectedUpdatedAt }).then((res) => finishWrite(root, res, name));
  }
  if (name === "deck_issue_close") {
    return closeIssue(root, a.key, { reason: a.reason, actor: a.actor, expectedUpdatedAt: a.expectedUpdatedAt }).then((res) => finishWrite(root, res, name));
  }
  if (name === "deck_issue_reopen") {
    return reopenIssue(root, a.key, { expectedUpdatedAt: a.expectedUpdatedAt }).then((res) => finishWrite(root, res, name));
  }
  if (name === "deck_issue_set_labels") {
    return setLabelsIssue(root, a.key, { labels: a.labels, expectedUpdatedAt: a.expectedUpdatedAt }).then((res) => finishWrite(root, res, name));
  }
  if (name === "deck_issue_create") {
    return createIssue(root, { effort: a.effort, title: a.title, body: a.body, labels: a.labels }).then((res) => finishWrite(root, res, name));
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
