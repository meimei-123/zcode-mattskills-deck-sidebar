// src/github/state.mjs —— 按项目根真实路径键控的进程内状态(票 02)。
//
// 手选与修订号都只活在 MCP 服务进程内:新会话复位,不持久化(与活动项目同一口径)。
// 键用 realpathSync.native 归一(junction/符号链接/大小写差异指向同一目录只算一处),
// realpath 失败时退回 resolve 的字面路径。
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

const choices = new Map(); // 真实路径 → "markdown" | "github"
const revisions = new Map(); // 真实路径 → 数据修订号(初始 0)
// 票 03:计数缓存 —— {atMs, counts, rowsOpen, partial}。新鲜度由票 05 的变更探测决定:
// 探测没发现更新就回缓存,发现更新就失效重取。写成功(票 04)也直接失效。
const countsCaches = new Map(); // 真实路径 → 缓存值
// 票 04:仓库写权限缓存(每个项目根问一次,成功/只读/未知都记)。
// 形如 {known:true, push, triage, atMs};问不出来时 {known:false, push:null, triage:null, atMs}。
// 票 06 的「重新检查」用 clearPerm 清掉重问;票 05 的探测可复用这份结论。
const perms = new Map(); // 真实路径 → 权限缓存
// 票 05:变更探测的进程内状态,每个项目根一份:
//   lastProbeAtMs 上次探测时刻(按探测开始算;0 = 还没探过,第一拍就会真探)
//   failures      连续失败次数(间隔按 2^failures 加倍,成功一次清零)
//   lastSyncAtMs  上次探测成功的时刻(下一次探测的 since 窗口起点;0 = 还没有窗口)
const probes = new Map(); // 真实路径 → 探测态

function keyOf(root) {
  const raw = resolve(String(root || ""));
  try {
    return realpathSync.native(raw);
  } catch {
    return raw;
  }
}

/** 本会话手选的后端(未选或值不认识回 null,判定回落到锚文件/默认)。 */
export function choiceOf(root) {
  const id = choices.get(keyOf(root));
  return id === "markdown" || id === "github" ? id : null;
}

/** 记本会话手选。调用方负责校验值。 */
export function setChoice(root, id) {
  choices.set(keyOf(root), String(id));
}

/** 数据修订号(初始 0;票 04 写成功、票 05 探测发现远端更新时推进)。 */
export function revisionOf(root) {
  const r = revisions.get(keyOf(root));
  return typeof r === "number" ? r : 0;
}

/** 推进修订号并返回新值。 */
export function bumpRevision(root) {
  const next = revisionOf(root) + 1;
  revisions.set(keyOf(root), next);
  return next;
}

/** 读计数缓存(没有就 null)。调用方负责按 TTL 判新鲜。 */
export function countsCacheOf(root) {
  return countsCaches.get(keyOf(root)) || null;
}

/** 写计数缓存(形状 {atMs, counts, rowsOpen, partial};字段含义见 tools-read.mjs)。 */
export function setCountsCache(root, value) {
  countsCaches.set(keyOf(root), value);
}

/** 失效计数缓存(票 04 写成功用;删除比清零更不容易把「旧数」当成新数)。 */
export function invalidateCounts(root) {
  countsCaches.delete(keyOf(root));
}

/**
 * 读仓库写权限缓存(没问过回 null)。
 * 值:`{known:true, push:boolean, triage:boolean, atMs}` 或 `{known:false, push:null, triage:null, atMs}`。
 */
export function permOf(root) {
  return perms.get(keyOf(root)) || null;
}

/** 记一次权限结论(成功/只读/未知都记;调用方负责按 known 判语义)。 */
export function setPerm(root, value) {
  perms.set(keyOf(root), value);
}

/** 清掉权限缓存(票 06 的「重新检查」用:下一次写会重新问仓库)。 */
export function clearPerm(root) {
  perms.delete(keyOf(root));
}

/** 读探测态(没探过回全零;调用方拿副本,改完经 setProbeState 写回)。 */
export function probeStateOf(root) {
  const hit = probes.get(keyOf(root));
  if (!hit) return { lastProbeAtMs: 0, failures: 0, lastSyncAtMs: 0 };
  return { ...hit };
}

/** 写探测态(字段做一次归一:时刻是非负数,失败次数是非负整数)。 */
export function setProbeState(root, value) {
  const src = value && typeof value === "object" ? value : {};
  const at = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : 0);
  probes.set(keyOf(root), {
    lastProbeAtMs: at(src.lastProbeAtMs),
    failures: at(src.failures),
    lastSyncAtMs: at(src.lastSyncAtMs),
  });
}
