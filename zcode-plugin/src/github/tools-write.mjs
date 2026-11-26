// src/github/tools-write.mjs —— GitHub 后端的六个写工具 + deck_map_link(票 04)。
//
// 纪律(design.md D / 票面):
//   - 回包与本地 finishWrite 同形状:{ok:true, changed:true, revision, key, card};失败是
//     {content:[{text}], isError:true, structuredContent:{ok:false, error:{kind,message,raw}}}。
//   - 写前权限门:每个项目根第一次写之前问一次 room.backend.getRepoPermissions;既不能推也不能整理
//     就按只读拒绝(一条写命令都不发);问不出来按未知放行,让远端裁决。结论(成功/只读/未知)都缓存,
//     票 06 的「重新检查」用 clearPerm 清掉重问。
//   - 写成功 bumpRevision + invalidateCounts(面板下一拍就能看到新数)。
//   - 摘要带仓库短名与议题号:`项目 owner/name #12: ...`。
//   - 远端失败的人话沿用 rows.errorOf;文末统一提醒「先 deck_issue_get 读回现状再决定重试」。
//   - effort/actor 在 GitHub 下没有意义:忽略并在摘要里说清(actor 不写)。
import { CLOSED_STATUS_WORDS } from "../cards.mjs";
import { bumpRevision, invalidateCounts, permOf, revisionOf, setPerm } from "./state.mjs";
import { errorOf, keyOf } from "./rows.mjs";
import { roomFor } from "./room.mjs";

const RETRY_HINT = "写操作没拿到明确结局:先 deck_issue_get 读回现状,再决定要不要重试(不要直接重发)。";

function okReply(text, structuredContent) {
  return { content: [{ type: "text", text }], structuredContent };
}

function failText(kind, text, message, raw = "") {
  return {
    content: [{ type: "text", text }],
    isError: true,
    structuredContent: { ok: false, error: { kind, message: message || text, raw } },
  };
}

/** 本地校验/拒绝:不是远端写失败,不加「先读回现状」的提醒。 */
function failLocal(kind, message, raw = "") {
  return failText(kind, message, message, raw === undefined || raw === null ? "" : String(raw));
}

/** 远端写失败(含仓库解析失败):人话用 rows.errorOf,文末统一加「先读回现状」。 */
function failRemote(errorLike) {
  const info = errorOf(errorLike);
  return failText(info.kind, `${info.text}\n${RETRY_HINT}`, info.message, info.raw);
}

function permDenied(room) {
  const repo = room.repoRef && room.repoRef.refId ? room.repoRef.refId : "这个仓库";
  const text = `这个仓库对当前账号只读(不能推、也不能整理):${repo}。写请求一律拒绝,没有向 GitHub 发任何写命令。要写请换有写权限的账号,或把工作区指到你有权限的 fork。`;
  return failText("unsupported", text, text);
}

/** 包住一次远端写:失败走 failRemote;成功推进修订号并失效计数缓存。 */
async function runWrite(root, work) {
  const res = await work();
  if (!res || res.ok !== true) return failRemote(res && res.error);
  bumpRevision(root);
  invalidateCounts(root);
  return res;
}

/** 成功回包(与本地 finishWrite 的键一致;card 是写后读回 / 房间写动作返回的 Issue)。 */
function finish(root, key, card, text) {
  return okReply(text, { ok: true, changed: true, revision: revisionOf(root), key: String(key), card: card || null });
}

function summarize(repo, key, what) {
  return `项目 ${repo} #${key}: ${what}`;
}

/** 每个项目根第一次写之前问一次仓库权限;结论(成功/只读/未知)都缓存。只读时回拒绝,其余回 null。 */
async function ensureWritable(room, root) {
  const cached = permOf(root);
  if (cached) {
    if (cached.known === true && !cached.push && !cached.triage) return permDenied(room);
    return null;
  }
  const res = await room.backend.getRepoPermissions(room.repoRef, room.ctx);
  if (res && res.ok === true && res.data && typeof res.data.push === "boolean" && typeof res.data.triage === "boolean") {
    const value = { known: true, push: res.data.push === true, triage: res.data.triage === true, atMs: Date.now() };
    setPerm(root, value);
    if (!value.push && !value.triage) return permDenied(room);
    return null;
  }
  // 问不出来(网络/仓库不可达):按未知处理,放行让远端裁决;这次「未知」也缓存,免得每次写都再问。
  setPerm(root, { known: false, push: null, triage: null, atMs: Date.now() });
  return null;
}

/** 过仓库解析与权限门;返回 {room} 或 {error: 回包}。 */
async function openWrite(ctx) {
  const room = await roomFor(ctx.root);
  if (room.error) return { error: failRemote(room.error) };
  const denied = await ensureWritable(room, ctx.root);
  if (denied) return { error: denied };
  return { room };
}

function parseKeyOf(raw) {
  const key = keyOf(raw);
  if (key === null) return { error: failLocal("parse", `key 必须是 GitHub 议题号(如 12 或 04),收到「${raw === undefined ? "" : raw}」。`, raw) };
  return { key };
}

function expectedOpts(a) {
  const v = a && a.expectedUpdatedAt;
  return typeof v === "string" && v !== "" ? { expectedUpdatedAt: v } : {};
}

/** 标签入参归一:裸串或 {name} 都收,去空去重保序(与本地 normalizeLabelInput 同口径)。 */
function labelNamesOf(raw) {
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  const out = [];
  for (const one of list) {
    const name = String(one && typeof one === "object" ? (one.name ?? "") : (one ?? "")).trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

function isFixedCloseReason(reason) {
  const folded = String(reason || "").toLowerCase().replace(/_/g, " ").replace(/\s+/g, " ").trim();
  return folded === "completed" || folded === "duplicate" || folded === "not planned";
}

// ---------------------------------------------------------------------------
// deck_issue_create
// ---------------------------------------------------------------------------
export async function issueCreate(args, ctx) {
  const a = args && typeof args === "object" ? args : {};
  const title = String(a.title === undefined || a.title === null ? "" : a.title).trim();
  if (!title) return failLocal("parse", "标题不能为空:请给 title 传议题标题。", a.title);
  const opened = await openWrite(ctx);
  if (opened.error) return opened.error;
  const { room } = opened;

  const input = { title };
  if (a.body !== undefined && a.body !== null) input.body = String(a.body);
  const labels = labelNamesOf(a.labels);
  if (labels.length) input.labels = labels;
  if (a.parentKey !== undefined && a.parentKey !== null && String(a.parentKey).trim() !== "") input.parentKey = String(a.parentKey).trim();
  if (typeof a.idempotencyKey === "string" && a.idempotencyKey.trim() !== "") input.idempotencyKey = a.idempotencyKey.trim();

  const res = await runWrite(ctx.root, () => room.backend.create(room.repoRef, input, room.ctx));
  if (res.isError) return res;
  const card = res.data || {};
  const key = String(card.key == null ? "" : card.key);
  const bits = [`已建议题「${title}」`];
  if (labels.length) bits.push(`标签:${labels.join("/")}`);
  if (input.parentKey) bits.push(`挂在地图 #${input.parentKey} 下`);
  if (a.effort !== undefined && a.effort !== null && String(a.effort).trim() !== "") bits.push("effort 对 GitHub 后端无意义,已忽略");
  return finish(ctx.root, key, card, summarize(room.repoRef.refId, key, bits.join(";") + "。"));
}

// ---------------------------------------------------------------------------
// deck_issue_comment
// ---------------------------------------------------------------------------
export async function issueComment(args, ctx) {
  const a = args && typeof args === "object" ? args : {};
  const parsed = parseKeyOf(a.key);
  if (parsed.error) return parsed.error;
  const key = parsed.key;
  const body = String(a.body === undefined || a.body === null ? "" : a.body).trim();
  if (!body) return failLocal("parse", "评论正文不能为空:请给 body 传要发的评论内容。", a.body);
  const opened = await openWrite(ctx);
  if (opened.error) return opened.error;
  const { room } = opened;

  const res = await runWrite(ctx.root, () => room.backend.comment(room.repoRef, key, body, room.ctx));
  if (res.isError) return res;
  // 评论动作回的是 Comment,不是 Issue:再读一次拿回整张票(读不回来也不把写成功改成失败)。
  let card = null;
  try {
    const back = await room.backend.get(room.repoRef, key, {}, room.ctx);
    if (back && back.ok === true) card = back.data;
  } catch {}
  return finish(ctx.root, key, card, summarize(room.repoRef.refId, key, "已发表评论(作者是当前登录账号)。"));
}

// ---------------------------------------------------------------------------
// deck_issue_close
// ---------------------------------------------------------------------------
export async function issueClose(args, ctx) {
  const a = args && typeof args === "object" ? args : {};
  const parsed = parseKeyOf(a.key);
  if (parsed.error) return parsed.error;
  const key = parsed.key;
  const reason = String(a.reason === undefined || a.reason === null ? "" : a.reason).trim();
  const opened = await openWrite(ctx);
  if (opened.error) return opened.error;
  const { room } = opened;

  const res = await runWrite(ctx.root, () => room.backend.close(room.repoRef, key, reason ? { reason } : undefined, room.ctx));
  if (res.isError) return res;
  let how;
  if (!reason) how = "直接关闭(没给原因)";
  else if (isFixedCloseReason(reason)) how = `直接关闭(关闭原因:${reason})`;
  else how = `先评论后关闭(原因已作为评论留档:${reason})`;
  return finish(ctx.root, key, res.data, summarize(room.repoRef.refId, key, `已关闭议题;${how}。`));
}

// ---------------------------------------------------------------------------
// deck_issue_reopen
// ---------------------------------------------------------------------------
export async function issueReopen(args, ctx) {
  const a = args && typeof args === "object" ? args : {};
  const parsed = parseKeyOf(a.key);
  if (parsed.error) return parsed.error;
  const key = parsed.key;
  const opened = await openWrite(ctx);
  if (opened.error) return opened.error;
  const { room } = opened;
  const res = await runWrite(ctx.root, () => room.backend.reopen(room.repoRef, key, room.ctx));
  if (res.isError) return res;
  return finish(ctx.root, key, res.data, summarize(room.repoRef.refId, key, "已重开议题(状态 → open)。"));
}

// ---------------------------------------------------------------------------
// deck_issue_set_labels
// ---------------------------------------------------------------------------
export async function issueSetLabels(args, ctx) {
  const a = args && typeof args === "object" ? args : {};
  const parsed = parseKeyOf(a.key);
  if (parsed.error) return parsed.error;
  const key = parsed.key;
  const names = labelNamesOf(a.labels);
  const opened = await openWrite(ctx);
  if (opened.error) return opened.error;
  const { room } = opened;

  const res = await runWrite(ctx.root, () => room.backend.setLabels(room.repoRef, key, names.map((name) => ({ name })), expectedOpts(a), room.ctx));
  if (res.isError) return res;
  const what = names.length ? `已把议题标签改为 [${names.join(", ")}](覆盖式,与远端差集对齐)。` : "已清空议题标签。";
  return finish(ctx.root, key, res.data, summarize(room.repoRef.refId, key, what));
}

// ---------------------------------------------------------------------------
// deck_issue_update
// ---------------------------------------------------------------------------
function currentLogins(issue) {
  return (Array.isArray(issue && issue.assignees) ? issue.assignees : []).map((x) => String((x && x.login) || x)).filter(Boolean);
}

async function meLogin(room) {
  const me = await room.backend.getCurrentUser(room.repoRef, room.ctx);
  if (!me || me.ok !== true || !me.data || !me.data.login) return { error: failRemote(me && me.error) };
  return { login: String(me.data.login) };
}

export async function issueUpdate(args, ctx) {
  const a = args && typeof args === "object" ? args : {};
  const parsed = parseKeyOf(a.key);
  if (parsed.error) return parsed.error;
  const key = parsed.key;
  const status = String(a.status === undefined || a.status === null ? "" : a.status).trim();
  const hasAssignees = Array.isArray(a.assignees);
  const ignored = [];
  if (a.title !== undefined) ignored.push("title");
  if (a.body !== undefined) ignored.push("body");
  const ignoredNote = ignored.length ? `${ignored.join("/")} 等改正文的字段本版没实现,已忽略。` : "";

  if (!hasAssignees && !status) {
    return failLocal("parse", `没给要改什么:GitHub 后端认 status=claimed(认领)、关闭类的 status,或 assignees(登录名数组)。${ignoredNote}`);
  }

  const opened = await openWrite(ctx);
  if (opened.error) return opened.error;
  const { room } = opened;

  // 分支一:assignees 整份替换(@me 换成当前登录人)。
  if (hasAssignees) {
    let logins = a.assignees.map((v) => String(v === undefined || v === null ? "" : v).trim()).filter(Boolean);
    if (logins.includes("@me")) {
      const me = await meLogin(room);
      if (me.error) return me.error;
      logins = logins.map((l) => (l === "@me" ? me.login : l));
    }
    logins = [...new Set(logins)];
    const res = await runWrite(ctx.root, () => room.backend.setAssignees(room.repoRef, key, logins, expectedOpts(a), room.ctx));
    if (res.isError) return res;
    const what = logins.length ? `已把议题认领人改为 [${logins.join(", ")}](整份替换)。` : "已清空议题认领人。";
    return finish(ctx.root, key, res.data, summarize(room.repoRef.refId, key, what + ignoredNote));
  }

  const folded = status.toLowerCase();

  // 分支二:claimed —— 把当前登录人并进现有认领人,不顶掉别人。
  if (folded === "claimed") {
    const cur = await room.backend.get(room.repoRef, key, {}, room.ctx);
    if (!cur || cur.ok !== true) return failRemote(cur && cur.error);
    const me = await meLogin(room);
    if (me.error) return me.error;
    const existing = currentLogins(cur.data);
    const next = existing.includes(me.login) ? existing : [...existing, me.login];
    const res = await runWrite(ctx.root, () => room.backend.setAssignees(room.repoRef, key, next, expectedOpts(a), room.ctx));
    if (res.isError) return res;
    return finish(ctx.root, key, res.data, summarize(room.repoRef.refId, key, `已认领议题:把 ${me.login} 加进认领人(现有 [${next.join(", ")}],没有顶掉已有认领人)。${ignoredNote}`));
  }

  // 分支三:关闭类的值 —— 先按 expectedUpdatedAt 做一次 get 比对(对不上不写),再关。
  if (CLOSED_STATUS_WORDS.has(folded)) {
    if (a.expectedUpdatedAt !== undefined && a.expectedUpdatedAt !== null && String(a.expectedUpdatedAt) !== "") {
      const cur = await room.backend.get(room.repoRef, key, {}, room.ctx);
      if (!cur || cur.ok !== true) return failRemote(cur && cur.error);
      if (String(cur.data.updatedAt) !== String(a.expectedUpdatedAt)) {
        return failRemote({ kind: "conflict", message: `版本冲突:#${key} 在你上次读取后被改过(expectedUpdatedAt 对不上,现在是 ${cur.data.updatedAt}),本次没有关闭。`, raw: cur.data.updatedAt });
      }
    }
    const res = await runWrite(ctx.root, () => room.backend.close(room.repoRef, key, undefined, room.ctx));
    if (res.isError) return res;
    return finish(ctx.root, key, res.data, summarize(room.repoRef.refId, key, `已关闭议题(status=${status} → closed)。${ignoredNote}`));
  }

  // 其它值:GitHub 议题没有状态行,改了也不生效 —— 明确拒绝并指路。
  return failLocal(
    "unsupported",
    `GitHub 议题没有状态行,status=「${status}」改了也不生效。要认领请用 status=claimed 或 assignees;要关票请用 deck_issue_close;要改标签请用 deck_issue_set_labels。${ignoredNote}`,
    status
  );
}

// ---------------------------------------------------------------------------
// deck_map_link
// ---------------------------------------------------------------------------
export async function mapLink(args, ctx) {
  const a = args && typeof args === "object" ? args : {};
  const parsed = parseKeyOf(a.key);
  if (parsed.error) return parsed.error;
  const key = parsed.key;
  const hasParent = Object.prototype.hasOwnProperty.call(a, "parentKey");
  const hasBlocked = Object.prototype.hasOwnProperty.call(a, "blockedBy");

  if (!hasParent && !hasBlocked) return failLocal("parse", "deck_map_link 至少要给 parentKey(挂图/摘根)或 blockedBy(阻塞边)其中一个。");

  let parentKey = null;
  if (hasParent) {
    if (a.parentKey === null) parentKey = null;
    else if (typeof a.parentKey === "string" || typeof a.parentKey === "number") {
      const v = String(a.parentKey).trim();
      if (!v) return failLocal("parse", "parentKey 只能是议题号,或用 null 摘到根。", a.parentKey);
      parentKey = v;
    } else return failLocal("parse", "parentKey 只能是议题号,或用 null 摘到根。", a.parentKey);
  }

  let blockedList = null;
  if (hasBlocked) {
    if (!Array.isArray(a.blockedBy)) return failLocal("parse", "blockedBy 必须是议题号数组(如 [4, 12])。", a.blockedBy);
    blockedList = [];
    for (const one of a.blockedBy) {
      const k = keyOf(one);
      if (k === null) return failLocal("parse", `blockedBy 只接受议题号(如 4 或 04),收到「${one}」。`, one);
      if (!blockedList.includes(k)) blockedList.push(k);
    }
  }

  const opened = await openWrite(ctx);
  if (opened.error) return opened.error;
  const { room } = opened;

  const sc = { ok: true, key, revision: 0 };
  const bits = [];
  let card = null;

  // 先 parent 再 blocked:parent 失败就停下回报(不吞)。
  if (hasParent) {
    const res = await runWrite(ctx.root, () => room.backend.setParent(room.repoRef, key, parentKey, {}, room.ctx));
    if (res.isError) return res;
    card = res.data || card;
    sc.parent = { ok: true, parentKey };
    bits.push(parentKey === null ? "已把议题摘到根(不再挂在地图下)" : `已把议题挂到地图 #${parentKey} 下`);
  }
  if (hasBlocked) {
    const res = await runWrite(ctx.root, () => room.backend.setBlockedBy(room.repoRef, key, blockedList, {}, room.ctx));
    if (res.isError) return res;
    card = res.data || card;
    sc.blockedBy = { ok: true, list: blockedList };
    bits.push(blockedList.length ? `已把阻塞边改为 [${blockedList.map((k) => `#${k}`).join("、")}]` : "已清空阻塞边");
  }

  sc.revision = revisionOf(ctx.root);
  if (card) sc.card = card;
  return okReply(summarize(room.repoRef.refId, key, bits.join(";") + "。"), sc);
}
