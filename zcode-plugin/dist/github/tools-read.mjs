// src/github/tools-read.mjs —— GitHub 后端的五个读工具(票 03)。
//
// 回包沿用本地形状(workspaceRoot/revision/rows/counts/card/...),按 design.md D 增补 GitHub 语义:
//   - key 是不补零的议题号,effortId 空串,url 是议题网页地址;拉取请求不进看板。
//   - 列表两分支:无 cursor 走整表(开闭一起、≤500,状态/标签/类型/keys 在内存筛),
//     有 cursor 走按页(服务端筛 state/labels,创建时间倒序,每页固定 50;keys/type 在页内再筛)。
//   - 详情按十进制偏移翻评论(commentsFirst 缺省 50,夹 1..200;commentsAfter 是偏移串),
//     回包带 commentCount 与 commentsPage{hasNextPage,endCursor}(面板票 07 直接消费这个名字)。
//   - 计数:三个数信房间;胶囊口径由已取回的开放行算。新鲜度由变更探测驱动(票 05):
//     每拍先 probeGithub(限速、退避、force 都在 probe.mjs);探测没变/没到点就回缓存,
//     有更新才重新发 counts + list 两笔(面板 5 秒一拍不能每拍问 GitHub)。
//   - 标签色表:仓库真色叠内置色板(同名覆盖),规范标签名单不变;按根在会话内缓存。
//   - 地图子票:房间 listSubIssues,回包形状不变,拿不全时照旧带 capped/missing。
import { computeCounts } from "../cards.mjs";
import { countsCacheOf, revisionOf, setCountsCache } from "./state.mjs";
import { countsOf, errorOf, keyOf, thinRowOf, ticketItemOf } from "./rows.mjs";
import { roomFor } from "./room.mjs";
import { probeGithub } from "./probe.mjs";

const COMMENTS_MAX = 200;
const COMMENTS_DEFAULT = 50;
const PAGE_LIMIT = 50;

function okReply(text, structuredContent) {
  return { content: [{ type: "text", text }], structuredContent };
}

/** 统一失败回包:人话进 content,三段式(不重新判档)进 structuredContent.error。 */
function failReply(error) {
  return {
    content: [{ type: "text", text: error.text }],
    isError: true,
    structuredContent: { ok: false, error: { kind: error.kind, message: error.message, raw: error.raw } },
  };
}

function failRaw(text, kind, raw) {
  return failReply(errorOf({ kind, message: text, raw: raw === undefined ? "" : raw }));
}

/** 房间不可用(仓库解析不出来)时的失败回包。 */
function roomFailure(room) {
  return failReply(errorOf(room.error));
}

function normState(raw) {
  const s = String(raw === undefined || raw === null ? "all" : raw).trim().toLowerCase();
  return s === "open" || s === "closed" ? s : "all";
}

function normLabels(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const v of raw) {
    const name = String(v === undefined || v === null ? "" : v).trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

function normKeys(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const v of raw) {
    const k = keyOf(v);
    if (k !== null && !out.includes(k)) out.push(k);
  }
  return out;
}

/** 页内/整表共用的内存筛:标签 AND、类型、keys。房间的整表过滤认 state/type/keys 但不认 labels。 */
function applyLocalFilter(rows, { labels, type, keys }) {
  let out = rows;
  if (type) out = out.filter((r) => r.type === type);
  if (keys.length) out = out.filter((r) => keys.includes(String(r.key)));
  if (labels.length) {
    out = out.filter((r) => {
      const names = (r.labels || []).map((l) => String((l && l.name) || ""));
      return labels.every((want) => names.includes(want));
    });
  }
  return out;
}

/** 房间 Issue[] → 薄行(拉取请求一律丢掉;房间在整表路径会把 PR 混进同一个池子)。 */
function thinRowsOf(issues) {
  return (Array.isArray(issues) ? issues : []).filter((i) => i && i.isPullRequest !== true).map(thinRowOf);
}

function summarizeListBody(rows, partial, nextCursor) {
  const open = rows.filter((r) => r.state === "open").length;
  const bits = [`共 ${rows.length} 条 GitHub 议题(开放 ${open} · 已关闭 ${rows.length - open})。`];
  if (partial) bits.push("这份列表不全(截断或走了降级通道),计数请看 deck_issue_counts。");
  if (nextCursor) bits.push("还有下一页,用 nextCursor 接着取。");
  const first = rows.slice(0, 5).map((r) => `#${r.key} ${r.title}`);
  if (first.length) bits.push(first.join("、") + (rows.length > first.length ? " …" : ""));
  return bits.join("\n");
}

// ---------------------------------------------------------------------------
// deck_issue_list
// ---------------------------------------------------------------------------
export async function issueList(args, ctx) {
  const a = args && typeof args === "object" ? args : {};
  const state = normState(a.state);
  const type = a.type === "issue" || a.type === "map" || a.type === "spec" ? a.type : "";
  const labels = normLabels(a.labels);
  const keys = normKeys(a.keys);
  // 分支开关是「cursor 这个参数在不在」,不是它真不真:面板第一页按上游口径传 cursor:''。
  const hasCursor = Object.prototype.hasOwnProperty.call(a, "cursor") && a.cursor !== undefined && a.cursor !== null;
  const cursor = typeof a.cursor === "string" ? a.cursor.trim() : "";

  const room = await roomFor(ctx.root);
  if (room.error) return roomFailure(room);

  const filter = {};
  if (state !== "all") filter.state = state;
  if (type) filter.type = type;
  if (keys.length) filter.keys = keys;
  if (labels.length) filter.labels = labels;

  if (hasCursor) {
    // 分页分支:游标原样回传;服务端筛 state/labels,页内再筛 type/keys。
    const res = await room.backend.listPage(room.repoRef, filter, { cursor, limit: PAGE_LIMIT }, room.ctx);
    if (!res || res.ok !== true) return failReply(errorOf(res && res.error));
    let rows = thinRowsOf(res.data && res.data.items);
    rows = applyLocalFilter(rows, { labels: [], type, keys });
    const sc = {
      workspaceRoot: ctx.root,
      revision: revisionOf(ctx.root),
      empty: false,
      units: [],
      counts: computeCounts(rows),
      total: typeof (res.data && res.data.total) === "number" ? res.data.total : rows.length,
      rows,
      nextCursor: (res.data && res.data.nextCursor) || null,
      partial: false,
    };
    return okReply(summarizeListBody(rows, false, sc.nextCursor), sc);
  }

  const res = await room.backend.list(room.repoRef, filter, room.ctx);
  if (!res || res.ok !== true) return failReply(errorOf(res && res.error));
  let rows = thinRowsOf(res.data);
  rows = applyLocalFilter(rows, { labels, type, keys });
  const partial = res.truncated === true || res.fallback === "rest";
  const sc = {
    workspaceRoot: ctx.root,
    revision: revisionOf(ctx.root),
    empty: false,
    units: [],
    counts: computeCounts(rows),
    total: rows.length,
    rows,
    partial,
  };
  return okReply(summarizeListBody(rows, partial, null), sc);
}

// ---------------------------------------------------------------------------
// deck_issue_get
// ---------------------------------------------------------------------------
function commentsFirstOf(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return COMMENTS_DEFAULT;
  return Math.max(1, Math.min(COMMENTS_MAX, Math.floor(n)));
}

/** 偏移游标:十进制非负整数;缺省/空串算 0;其它回 null(调用方回可读错误,不猜)。 */
function commentsAfterOf(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return 0;
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) return null;
  return Number(s);
}

export async function issueGet(args, ctx) {
  const a = args && typeof args === "object" ? args : {};
  const key = keyOf(a.key);
  if (key === null) {
    return failRaw(`key 必须是 GitHub 议题号(如 12 或 04),收到「${a.key === undefined ? "" : a.key}」。`, "parse", a.key === undefined ? "" : a.key);
  }
  const first = commentsFirstOf(a.commentsFirst);
  const offset = commentsAfterOf(a.commentsAfter);
  if (offset === null) {
    return failRaw(`commentsAfter 只接受十进制偏移(非负整数),收到「${a.commentsAfter}」。`, "parse", a.commentsAfter);
  }
  const room = await roomFor(ctx.root);
  if (room.error) return roomFailure(room);

  // 偏移口径(协调约定):want = min(offset + first, 200),房间按 want 把评论取够再归一化;
  // 归一化会丢掉 GraphQL 的 pageInfo,所以本仓不返回原生游标,只用偏移。
  const want = Math.min(offset + first, COMMENTS_MAX);
  const opts = { comments: { first: want } };
  if (offset > 0) opts.comments.after = String(offset); // 原样交给房间(房间当前不读 after;偏移由下面切片实现)
  const res = await room.backend.get(room.repoRef, key, opts, room.ctx);
  if (!res || res.ok !== true) return failReply(errorOf(res && res.error));

  const src = res.data && typeof res.data === "object" ? res.data : {};
  const all = Array.isArray(src.comments) ? src.comments : [];
  const nodes = offset >= COMMENTS_MAX ? [] : all.slice(offset);
  const card = { ...src, comments: nodes };
  const commentCount = typeof src.commentCount === "number" ? src.commentCount : null;
  const endCursor = String(offset + nodes.length);
  const hasNextPage = commentCount !== null ? offset + nodes.length < Math.min(commentCount, COMMENTS_MAX) : nodes.length === first;
  const sc = { workspaceRoot: ctx.root, card, commentsPage: { hasNextPage, endCursor } };

  const labelNames = (Array.isArray(card.labels) ? card.labels : []).map((l) => String((l && l.name) || "")).filter(Boolean);
  const facts = [`#${key} ${card.title || ""}`, `(${card.state || ""}`, labelNames.length ? `,标签:${labelNames.join("/")}` : "", nodes.length ? `,本页 ${nodes.length} 条评论` : "", commentCount !== null ? `,共 ${commentCount} 条评论` : "", ")"];
  let text = facts.join("");
  if (offset >= COMMENTS_MAX) text += "\n本版评论只翻到前 200 条。";
  else if (hasNextPage) text += `\n还有更多评论:用 commentsAfter="${endCursor}" 接着取。`;
  return okReply(text, sc);
}

// ---------------------------------------------------------------------------
// deck_issue_counts
// ---------------------------------------------------------------------------
function countsReply(root, value, note) {
  const { counts, partial } = countsOf(value.rowsOpen, value.counts, value.partial);
  const sc = { workspaceRoot: root, revision: revisionOf(root), empty: false, counts, partial };
  const parts = [
    `共 ${counts.total} 条 GitHub 议题(开放 ${counts.open} · 已关闭 ${counts.closed})。`,
    `可接 ${counts.frontier} · 占用 ${counts.occupied} · 认领 ${counts.claimed} · 阻塞 ${counts.blocked} · 故障 ${counts.bug} · 诊断 ${counts.triage}`,
    `(另有地图 ${counts.maps}、规格 ${counts.specs} 个容器)`,
  ];
  if (partial) parts.push("这份开放列表不全(截断或走了降级通道),胶囊口径按已取回的行算。");
  const text = parts.join(" ");
  return okReply(note ? `${text}\n${note}` : text, sc);
}

export async function issueCounts(args, ctx) {
  const a = args && typeof args === "object" ? args : {};
  // 限速只有探测这一处:每拍先问 probeGithub,它决定这一拍要不要出站。
  const probe = await probeGithub(ctx.root, { force: a.force === true });
  const cached = countsCacheOf(ctx.root);
  if (probe.error) {
    if (cached) return countsReply(ctx.root, cached, "这次没探到远端,显示的是上次的计数。");
    return failReply(errorOf(probe.error));
  }
  // 缓存有且本轮没发现更新(或没到点没探)→ 直接回缓存,不再出站。
  if (cached && probe.changed !== true) return countsReply(ctx.root, cached);
  const room = await roomFor(ctx.root);
  if (room.error) return roomFailure(room);
  // 两笔:计数信后端(只数工单),开放行用来算胶囊口径。counts 失败就整体失败、不动旧缓存。
  const cRes = await room.backend.counts(room.repoRef, undefined, room.ctx);
  if (!cRes || cRes.ok !== true) return failReply(errorOf(cRes && cRes.error));
  const lRes = await room.backend.list(room.repoRef, { state: "open" }, room.ctx);
  if (!lRes || lRes.ok !== true) return failReply(errorOf(lRes && lRes.error));
  const rowsOpen = thinRowsOf(lRes.data);
  const value = {
    atMs: Date.now(),
    counts: cRes.data,
    rowsOpen,
    partial: lRes.truncated === true || lRes.fallback === "rest",
  };
  setCountsCache(ctx.root, value);
  return countsReply(ctx.root, value);
}

// ---------------------------------------------------------------------------
// deck_issue_list_labels
// ---------------------------------------------------------------------------
// 按项目根的会话内缓存:面板翻开标签面板时不会每次都起 gh。
const labelCache = new Map();

function labelsReply(palette, colors) {
  const canonical = (palette && Array.isArray(palette.canonical) ? palette.canonical : []).slice();
  const sc = { labels: canonical, colors };
  return okReply(`规范标签 ${canonical.length} 枚:${canonical.join("、")};仓库标签色 ${Object.keys(colors).length} 枚(仓库真色覆盖内置同名色,hex 无 # 前缀)。`, sc);
}

export async function issueListLabels(args, ctx) {
  const hit = labelCache.get(ctx.root);
  if (hit) return labelsReply(ctx.palette, hit);
  const room = await roomFor(ctx.root);
  if (room.error) return roomFailure(room);
  const res = await room.backend.listLabels(room.repoRef, room.ctx);
  if (!res || res.ok !== true) return failReply(errorOf(res && res.error));
  const colors = { ...((ctx.palette && ctx.palette.colors) || {}) };
  for (const item of Array.isArray(res.data) ? res.data : []) {
    const name = String((item && item.name) || "");
    if (!name) continue;
    const color = String((item && item.color) || "").replace(/^#/, "").toLowerCase();
    if (color) colors[name] = color;
  }
  labelCache.set(ctx.root, colors);
  return labelsReply(ctx.palette, colors);
}

// ---------------------------------------------------------------------------
// deck_map_tickets
// ---------------------------------------------------------------------------
export async function mapTickets(args, ctx) {
  const a = args && typeof args === "object" ? args : {};
  const key = keyOf(a.key);
  if (key === null) {
    return failRaw(`key 必须是 GitHub 议题号(如 12 或 01),收到「${a.key === undefined ? "" : a.key}」。`, "parse", a.key === undefined ? "" : a.key);
  }
  const room = await roomFor(ctx.root);
  if (room.error) return roomFailure(room);
  const res = await room.backend.listSubIssues(room.repoRef, key, undefined, room.ctx);
  if (!res || res.ok !== true) return failReply(errorOf(res && res.error));
  const data = res.data && typeof res.data === "object" ? res.data : {};
  const items = (Array.isArray(data.items) ? data.items : []).filter((i) => i && i.isPullRequest !== true).map(ticketItemOf);
  const closed = items.filter((i) => i.state === "CLOSED").length;
  const sc = {
    ok: true,
    key,
    items,
    stats: { total: items.length, open: items.length - closed, closed },
    total: typeof data.total === "number" ? data.total : items.length,
    fetched: typeof data.fetched === "number" ? data.fetched : items.length,
    capped: data.capped === true,
    missing: typeof data.missing === "number" ? Math.max(0, Math.floor(data.missing)) : 0,
  };
  let text = `地图 #${key}:${sc.stats.total} 张子票(已关闭 ${closed} 张)。`;
  if (sc.capped) text += "子票太多,只取回了前一批(见 fetched);";
  if (sc.missing > 0) text += `还有 ${sc.missing} 张没取回(总数 ${sc.total}、取回 ${sc.fetched})。`;
  return okReply(text, sc);
}
