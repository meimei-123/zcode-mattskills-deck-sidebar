// src/github/probe.mjs —— GitHub 变更探测(票 05):限速、连续失败加倍退避、强制探测。
//
// 面板照旧每 5 秒一拍读一次计数;GitHub 后端的限速只有这一处:
//   - 基础间隔 base = ZCODE_GITHUB_PROBE_MS(缺省 60000;非法回落缺省)。
//   - 当前间隔 interval = min(base * 2^failures, 300000):连续失败加倍,5 分钟封顶;
//     成功一次 failures=0,立即回到基础间隔。
//   - 距上次探测不到 interval 且没带 force → checked:false、不出站。
//   - 到点(或 force):先记探测时刻(按开始算),问「更新时间晚于上次同步的议题有几条」——
//     走房间的分页读取(带 since 窗口、limit 1);有更新才推进修订号并失效计数缓存。
// 探测态(lastProbeAtMs / failures / lastSyncAtMs)存在 state.mjs,按项目根真实路径键控。
// 日志:ZCODE_GH_DEBUG=1 时打一行 JSON,只记结论,不记命令行。
import { bumpRevision, invalidateCounts, probeStateOf, setProbeState } from "./state.mjs";
import { roomFor } from "./room.mjs";

const PROBE_DEFAULT_MS = 60000;
const PROBE_MAX_MS = 300000;

/** 基础探测间隔(毫秒);非法值回落缺省。 */
export function probeBaseMs() {
  const v = Number(process.env.ZCODE_GITHUB_PROBE_MS);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : PROBE_DEFAULT_MS;
}

/** 当前间隔:连续失败一次翻一倍,5 分钟封顶(base 本身超过封顶时也按封顶算)。 */
function intervalOf(failures) {
  const base = probeBaseMs();
  const exp = Math.max(0, Math.floor(Number(failures) || 0));
  return Math.min(base * 2 ** exp, PROBE_MAX_MS);
}

function debugOn() {
  return String(process.env.ZCODE_GH_DEBUG || "") === "1";
}

function logProbe(checked, changed, failures, force) {
  if (!debugOn()) return;
  try {
    // 一行一条:探测是否发生、远端是否变、当前连续失败次数、是否强制。
    process.stderr.write(`${JSON.stringify({ event: "probe", checked, changed, failures, force })}\n`);
  } catch {}
}

/** 房间失败 → 票面要的三段式(不在这里重新判档)。 */
function errorOf(like) {
  const src = like && typeof like === "object" ? like : { message: String(like === undefined || like === null ? "" : like) };
  return {
    kind: typeof src.kind === "string" && src.kind ? src.kind : "parse",
    message: String(src.message || ""),
    raw: typeof src.raw === "string" ? src.raw : String(src.message || ""),
  };
}

/**
 * 探一次远端有没有更新。
 *   force=true 只跳过「间隔未到」这一道,链路其余一样(同样推进探测时刻、成功时清零失败数)。
 * 返回 {checked, changed, error?};不出站时 checked:false。
 */
export async function probeGithub(root, opts = {}) {
  const force = opts && opts.force === true;
  const st = probeStateOf(root);
  const now = Date.now();
  if (!force && now - st.lastProbeAtMs < intervalOf(st.failures)) {
    return { checked: false, changed: false };
  }
  // 探测时刻按开始算(探测本身可能耗时;面板下一拍按这个时刻判间隔)。
  const next = { ...st, lastProbeAtMs: now };
  setProbeState(root, next);

  let failures = st.failures;
  try {
    const room = await roomFor(root);
    if (room.error) {
      failures += 1;
      next.failures = failures;
      setProbeState(root, next);
      logProbe(true, false, failures, force);
      return { checked: true, changed: false, error: errorOf(room.error) };
    }
    // 有上次成功的时刻才带时间窗;第一次探测没有窗口,按整表问「有几条」。
    const filter = st.lastSyncAtMs ? { since: new Date(st.lastSyncAtMs).toISOString() } : undefined;
    const res = await room.backend.listPage(room.repoRef, filter, { limit: 1 }, room.ctx);
    if (!res || res.ok !== true) {
      failures += 1;
      next.failures = failures;
      setProbeState(root, next);
      logProbe(true, false, failures, force);
      return { checked: true, changed: false, error: errorOf(res && res.error) };
    }
    next.failures = 0;
    next.lastSyncAtMs = now;
    setProbeState(root, next);
    const total = res.data && typeof res.data.total === "number" ? res.data.total : 0;
    const changed = total > 0;
    if (changed) {
      bumpRevision(root);
      invalidateCounts(root);
    }
    logProbe(true, changed, 0, force);
    return { checked: true, changed };
  } catch (e) {
    // 房间的失败通常是返回值;异常也不许绕过失败计数(否则退避会失效)。
    failures += 1;
    next.failures = failures;
    setProbeState(root, next);
    logProbe(true, false, failures, force);
    return { checked: true, changed: false, error: errorOf(e) };
  }
}
