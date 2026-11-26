// src/github/rows.mjs —— GitHub 议题的投影与错误人话(票 03)。
//
// 三件事:
//   thinRowOf(issue)   房间归一后的 Issue → 列表薄行(字段与本地 cards.thinRow 同名同口径)。
//   ticketItemOf(issue) 地图子票行(与 src/map-tickets.mjs 的 ticketItemOf 同形状;state 大写)。
//   errorOf(errorLike) 房间失败 {kind,message,raw} → {kind,message,raw,text};档位只用房间给的 kind,
//                      本文件不重新判档;text 是本仓自己写的中文摘要(上游原文留在 raw/message 里)。
//   countsOf(rows, backendCounts, partial) 胶囊口径由行算,open/closed/total 换成后端三个数。
//
// 口径提醒(design.md D):key 是不补零的议题号、effortId 是空串、state/type 房间已归一(小写/小写),
// 这里不再转;拉取请求由调用方先丢掉。
import { computeCounts } from "../cards.mjs";
import { progressOf } from "../map-tickets.mjs";

/** 房间 Issue → 薄行。空值照本地口径:数组给 [],parentKey/closedAt 给 null,commentCount 不知道就省略。 */
export function thinRowOf(issue) {
  const src = issue && typeof issue === "object" ? issue : {};
  const row = {
    key: String(src.key == null ? "" : src.key),
    effortId: "",
    type: src.type,
    title: src.title,
    state: src.state,
    labels: (Array.isArray(src.labels) ? src.labels : []).map((l) => ({ name: String((l && l.name) || ""), color: String((l && l.color) || "") })),
    assignees: (Array.isArray(src.assignees) ? src.assignees : []).map((a) => ({ login: String((a && a.login) || "") })),
    blockedBy: (Array.isArray(src.blockedBy) ? src.blockedBy : []).map((r) => ({ key: String((r && r.key) || "") })),
    parentKey: src.parentKey == null ? null : String(src.parentKey),
    createdAt: String(src.createdAt || ""),
    updatedAt: String(src.updatedAt || ""),
    closedAt: src.closedAt == null ? null : String(src.closedAt),
    url: String(src.url || ""),
  };
  // 本地薄行恒带 commentCount;GitHub 的列表查询不带评论连接,缺就省略(不拿 0 冒充当过总数)。
  if (typeof src.commentCount === "number" && Number.isFinite(src.commentCount)) row.commentCount = Math.floor(src.commentCount);
  return row;
}

/** 地图子票行:与本地 map-tickets.ticketItemOf 同形状(state 大写、blockedByRefs、claimedBy、number、progress)。 */
export function ticketItemOf(issue) {
  const src = issue && typeof issue === "object" ? issue : {};
  const blockers = Array.isArray(src.blockedBy) ? src.blockedBy : [];
  const out = {
    key: String(src.key == null ? "" : src.key),
    effortId: "",
    type: src.type,
    title: src.title,
    state: String(src.state || "").toUpperCase(),
    labels: Array.isArray(src.labels) ? src.labels : [],
    url: String(src.url || ""),
    parentKey: src.parentKey == null ? null : String(src.parentKey),
    blockedBy: blockers.map((ref) => String((ref && ref.key) || ref)),
    blockedByRefs: blockers
      .map((ref) => {
        if (!ref || typeof ref !== "object" || ref.key == null) return { key: String(ref) };
        const one = { key: String(ref.key) };
        if (ref.title != null && String(ref.title) !== "") one.title = String(ref.title);
        if (ref.state != null && String(ref.state) !== "") one.state = String(ref.state);
        return one;
      })
      .filter((ref) => ref.key !== "" && ref.key !== "undefined" && ref.key !== "null"),
    createdAt: String(src.createdAt || ""),
    updatedAt: String(src.updatedAt || ""),
    closedAt: src.closedAt == null ? null : String(src.closedAt),
    progress: progressOf(src.body),
  };
  const number = Number.parseInt(String(src.key), 10);
  if (Number.isFinite(number)) out.number = number;
  const assignees = Array.isArray(src.assignees) ? src.assignees : [];
  out.claimedBy = assignees.length ? String((assignees[0] && assignees[0].login) || "") : "";
  if (assignees.length) out.assignees = assignees;
  return out;
}

/** "04" / 4 / "effort/04" → "4";非数字回 null(调用方据此回可读错误,不猜)。 */
export function keyOf(raw) {
  const s = String(raw === undefined || raw === null ? "" : raw).trim();
  if (!s) return null;
  const tail = s.slice(s.lastIndexOf("/") + 1);
  if (!/^\d+$/.test(tail)) return null;
  return String(Number(tail));
}

// 八档里前四档是本仓要翻成人话的(环境/登录/限流/网络);其余带上游原文为主。
const GUIDES = {
  env: "没装 gh(GitHub CLI),或它不在 PATH 里。装好 GitHub CLI 并加进 PATH,或用环境变量 ZCODE_GH_PATH 指向 gh 可执行文件,然后重启 ZCode。",
  auth: "GitHub 没有登录,或登录已经失效。先在终端运行 gh auth login 完成登录,再重试。",
  "rate-limit": "被 GitHub 限流了,过一会儿再试;连续重试只会一直撞限流。",
  network: "连不上 GitHub(网络不通或请求超时)。确认网络可用后再试。",
};

/**
 * 房间失败 → {kind, message, raw, text}。
 * kind 原样用房间给的(不在这里重新判档);text 是工具回包里给人看的那句话。
 */
export function errorOf(errorLike) {
  const src = errorLike && typeof errorLike === "object" ? errorLike : { message: String(errorLike == null ? "" : errorLike) };
  const kind = typeof src.kind === "string" && src.kind ? src.kind : "parse";
  const message = String(src.message || "");
  const raw = typeof src.raw === "string" && src.raw ? src.raw : message;
  const guide = GUIDES[kind];
  let text;
  if (guide) text = message ? `${guide}\n上游原文:${message}` : guide;
  else if (kind === "not-found") text = message || raw || "GitHub 上找不到这个资源(议题或仓库)。";
  else if (kind === "parse") text = message ? `GitHub 回包读不懂:${message}` : "GitHub 回包读不懂。";
  else if (kind === "conflict") text = message ? `写前置校验没过:${message}` : "写前置校验没过。";
  else if (kind === "unsupported") text = message ? `这个后端不支持这次操作:${message}` : "这个后端不支持这次操作。";
  else text = message || "GitHub 读取出错。";
  return { kind, message, raw, text };
}

/** 计数:胶囊口径由已取回的行算,open/closed/total 换成后端三个数(后端权威);partial 原样带。 */
export function countsOf(rows, backendCounts, partial) {
  const counts = computeCounts(Array.isArray(rows) ? rows : []);
  if (backendCounts && typeof backendCounts.open === "number" && typeof backendCounts.closed === "number" && typeof backendCounts.total === "number") {
    counts.open = backendCounts.open;
    counts.closed = backendCounts.closed;
    counts.total = backendCounts.total;
  }
  return { counts, partial: partial === true };
}
