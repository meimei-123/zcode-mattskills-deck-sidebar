// MattSkills MCP 服务(工单 01 骨架 + 工单 02 只读工具):stdio JSON-RPC 握手 + panel.html 资源供给
// + deck_issue_list / deck_issue_get / deck_issue_counts 三个工具(上游契约 list/get/counts 的直翻,
// 返回结构化结果 + 中文人话摘要)。零依赖;工作区根取宿主注入的 ZCODE_WORKSPACE_ROOT。
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { scanWorkspace, computeCounts, findCardByScan, thinRow } from "./cards.mjs";
import { createDeckWatch, refreshFromEnv } from "./watch.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_NAME = "zcode-mattpocock-skills-deck";
const VERSION = "0.1.0";
const PANEL_URI = `ui://${PLUGIN_NAME}/panel.html`;
const PANEL_MIME = "text/html;profile=mcp-app";
// 面板次级资产(panel.css / bundle-*.txt / assets.json):资源模板 + 白名单 + 大小上限
// (ui-host.md,同 excalidraw 惯例:JS 段故意 .txt 后缀,资源通道只搬文本)。
const ASSET_PREFIX = `ui://${PLUGIN_NAME}/assets/`;
const ASSET_RE = /^(panel\.css|bundle-\d+\.txt|assets\.json)$/;
const ASSET_LIMIT = 8 * 1024 * 1024;

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
      "当前工作区各口径计数:open/closed/total 与面板胶囊口径(可接=frontier、占用、认领、阻塞、故障=bug、诊断=needs-triage)。空工作区返回 0 与 empty 标志,不是错误。响应携带数据修订号 revision;.scratch 监听在线时,票文件读不动则整体拒绝(不给偏小的数),离线降级为静默跳过。",
    inputSchema: { type: "object", properties: {} },
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

/** 工具实现:全部走同一次扫描,返回 {content, structuredContent} 或 {content, isError}。 */
function handleCall(name, args) {
  const a = args && typeof args === "object" ? args : {};
  const root = workspaceRoot();
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
    // 票文件读不动的分派(工单 02 遗留):监听在线按上游「整体拒绝」(不给偏小的数);
    // 离线是降级态,回落静默跳过(list 永远静默跳过)。
    if (deckWatch.state().online && Array.isArray(scan.unreadable) && scan.unreadable.length) {
      const rel = scan.unreadable.map((p) => relative(root, p)).join("、");
      return {
        content: [
          { type: "text", text: `有 ${scan.unreadable.length} 张票文件读不动(${rel}),counts 整体拒绝:不给偏小的数。可先 deck_issue_list 看可读部分,修复文件后会自动跟上。` },
        ],
        isError: true,
      };
    }
    const counts = computeCounts(scan.rows);
    const sc = { workspaceRoot: root, revision: deckWatch.state().revision, empty: scan.empty, counts };
    return { content: [{ type: "text", text: summarizeCounts(sc) }], structuredContent: sc };
  }

  return { content: [{ type: "text", text: `未知工具 ${name}` }], isError: true };
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
      try {
        return reply(m.id, handleCall(m.params?.name, m.params?.arguments));
      } catch (e) {
        return reply(m.id, { content: [{ type: "text", text: `读工作区时出错:${e && e.message ? e.message : String(e)}` }], isError: true });
      }
    case "resources/list":
      return reply(m.id, {
        resources: [{ uri: PANEL_URI, name: "MattSkills panel", mimeType: PANEL_MIME }],
      });
    case "resources/read": {
      const uri = String(m.params?.uri || "");
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
