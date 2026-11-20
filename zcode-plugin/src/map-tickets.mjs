// map-tickets.mjs —— 地图子票按需取数(对齐上游宿主电话 wf.mapTickets / src/host/mapTickets.ts 的契约)。
//
// 为什么单独一份:地图详情页(MapDetailV2)进页就问一次「这张图的全部子票」,快照只带开容器的
// 未关闭子票(上游 groupDeck 口径),已关闭的与关地图的子票只能现取。回包形状由 api-io.ts 的
// fetchMapTickets 消费:{ok,key,items,stats,total,fetched,capped,missing};items 每行按上游
// prepareRow 归一大写 state、压 blockedBy 为键串、认领人从 assignees 取第一个。

/** 正文「## 进度」区的当前值:第一条 `- 进度：N%` 记录;没有区或没有记录回 null(不是 0)。
 *  只实现读侧当前值这一小截(上游真源 src/shared/issue-file/src/progress.ts)。 */
export function progressOf(body) {
  const text = String(body || "");
  const head = /^##[ \t]+进度[ \t]*$/m.exec(text);
  if (!head) return null;
  const rest = text.slice(head.index + head[0].length);
  const end = /^##[ \t]+/m.exec(rest);
  const section = end ? rest.slice(0, end.index) : rest;
  const m = /^[ \t]*[-*][ \t]*进度[ \t]*[:：][ \t]*(\d{1,3})[ \t]*%/m.exec(section);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

function errorOf(kind, message) {
  return { ok: false, error: { kind: kind, message: message, raw: "" } };
}

/** 一行卡 → 上游 prepareRow 口径的子票行。 */
function ticketItemOf(card) {
  const out = {
    key: String(card.key),
    effortId: card.effortId,
    type: card.type,
    title: card.title,
    state: String(card.state || "").toUpperCase(),
    labels: Array.isArray(card.labels) ? card.labels : [],
    url: card.url,
    parentKey: card.parentKey,
    blockedBy: Array.isArray(card.blockedBy)
      ? card.blockedBy.map((ref) => (ref && typeof ref === "object" && ref.key != null ? String(ref.key) : String(ref)))
      : [],
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
    closedAt: card.closedAt,
    progress: progressOf(card.body),
  };
  const number = Number.parseInt(String(card.key), 10);
  if (Number.isFinite(number)) out.number = number;
  const assignees = Array.isArray(card.assignees) ? card.assignees : [];
  out.claimedBy = assignees.length ? String((assignees[0] && assignees[0].login) || "") : "";
  if (assignees.length) out.assignees = assignees;
  return out;
}

/**
 * 一张地图/规格的全部子票(含已关闭)。scan 是 scanWorkspace 的结果。
 * args:{key, effortId?};同号容器在不同工作单元里是两张,给了 effortId 就按它查。
 */
export function mapTicketsFor(scan, args) {
  const a = args && typeof args === "object" ? args : {};
  const key = String(a.key === undefined || a.key === null ? "" : a.key).trim();
  if (!key) return errorOf("parse", "缺少地图编号(key)");
  const effortId = a.effortId === undefined || a.effortId === null ? "" : String(a.effortId);
  const rows = Array.isArray(scan && scan.rows) ? scan.rows : [];
  const norm = /^\d+$/.test(key) ? key.padStart(2, "0") : key;
  const effortOf = (r) => String((r && r.effortId) || "");
  const isContainer = (r) => !!r && (r.type === "map" || r.type === "spec");

  // 容器优先:00 是地图/规格的保留编号,但脏工作区里也可能有同名普通票 —— 只认容器。
  const pool = rows.filter((r) => r && String(r.key) === norm && (!effortId || effortOf(r) === effortId));
  const containers = pool.filter(isContainer);
  if (!containers.length) {
    if (!pool.length) return errorOf("parse", "找不到地图 " + (effortId ? effortId + "/" : "") + key);
    return errorOf("parse", String(pool[0].key) + " 不是地图/规格(它是 " + String(pool[0].type) + ")");
  }
  if (containers.length > 1) {
    return errorOf("parse", "同号地图有多张:请带 effortId(如 " + effortOf(containers[0]) + "/" + norm + ")");
  }
  const card = containers[0];

  const items = rows
    .filter((r) => {
      if (!r || r === card) return false;
      if (isContainer(r)) return false;
      if (effortOf(r) !== effortOf(card)) return false;
      return r.parentKey != null && String(r.parentKey) === String(card.key);
    })
    .map(ticketItemOf);
  const closed = items.filter((t) => t.state === "CLOSED").length;
  const stats = { total: items.length, open: items.length - closed, closed: closed };
  return {
    ok: true,
    key: String(card.key),
    items: items,
    stats: stats,
    total: items.length,
    fetched: items.length,
    capped: false,
    missing: 0,
  };
}
