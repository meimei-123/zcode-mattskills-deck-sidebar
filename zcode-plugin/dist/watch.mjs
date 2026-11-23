// MattSkills 新鲜度(工单 08):`.scratch/` 递归监听 + 数据修订号(revision)。
// 数值口径取上游 config/intervals.yaml(见 port-notes/refresh-constants.md):
//   syncDirtyProbeDebounceMs = 1200(脏事件合并窗)、syncPollGridMs = 4000(重算对齐的同步栅格)、
//   backoff.chainBackoffMs = 8s→30s→2min→5min(断链重试阶梯,任何一步有进展立刻回第一档)。
// 实现自持:fs.watch 事件驱动 + 栅格重算,不搬宿主轮询机制。
// revision 语义:数据签名(全部薄行的 JSON)变化才 +1;监听离线时由请求方喂 observe()
// 兜底推进(降级新鲜度,面板轮询 counts 即驱动)。发条可经 ZCODE_REFRESH_* 环境收短(测试用)。
import { existsSync, watch } from "node:fs";
import { join } from "node:path";
import { scanWorkspace, thinRow } from "./cards.mjs";

export const REFRESH_DEFAULTS = {
  debounceMs: 1200,
  gridMs: 4000,
  backoffMs: [8000, 30000, 120000, 300000],
};

/** 环境覆盖(只认正整数;缺省一律用 REFRESH_DEFAULTS,不在此写第二个数字)。 */
export function refreshFromEnv(env = process.env) {
  const int = (name) => {
    const v = String(env[name] || "").trim();
    return /^\d+$/.test(v) && Number(v) > 0 ? Number(v) : undefined;
  };
  const out = {};
  const debounceMs = int("ZCODE_REFRESH_DEBOUNCE_MS");
  const gridMs = int("ZCODE_REFRESH_GRID_MS");
  if (debounceMs !== undefined) out.debounceMs = debounceMs;
  if (gridMs !== undefined) out.gridMs = gridMs;
  const ladder = String(env.ZCODE_REFRESH_BACKOFF_MS || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s) && Number(s) > 0)
    .map(Number);
  if (ladder.length) out.backoffMs = ladder;
  return { ...REFRESH_DEFAULTS, ...out };
}

/** 数据签名:全部薄行的 JSON(薄行含 mtime 派生的 updatedAt,时间戳变了也算数据变)。 */
export function signatureOf(scan) {
  return JSON.stringify(((scan && scan.rows) || []).map(thinRow));
}

/**
 * 工作区数据监听:维护 revision,暴露 state()/observe()/stop()。
 *   observe(scan)  外部(请求路径)喂一次扫描,签名变了就推进 revision——离线时的兜底探测。
 *   state()        → { revision, online },handleCall 携带/分派用。
 */
export function createDeckWatch(root, opts = {}) {
  const cfg = { ...REFRESH_DEFAULTS, ...(opts || {}) };
  const scratch = join(String(root || "."), ".scratch");
  // 起步 revision(票 02):换根重建时由调用方传入旧值,保证跨实例单调;
  // 缺省 0,初扫照旧把首态推到 1。切换 = 旧值 + 初扫必推进一次 = 恰好 +1。
  let revision = Math.max(0, Math.floor(Number(opts && opts.startRevision) || 0));
  let online = false;
  let lastSig = null;
  let watcher = null;
  let stopped = false;
  let backoffIdx = 0;
  let debounceT = null;
  let gridT = null;
  let retryT = null;

  function observe(scan) {
    const sig = signatureOf(scan);
    if (sig !== lastSig) {
      lastSig = sig;
      revision += 1;
    }
  }

  function markDirty() {
    if (debounceT) clearTimeout(debounceT);
    debounceT = setTimeout(onDebounced, cfg.debounceMs);
  }

  function onDebounced() {
    debounceT = null;
    if (stopped || gridT) return; // 已在等栅格:后续事件并入这一次重算
    gridT = setTimeout(onGrid, cfg.gridMs - (Date.now() % cfg.gridMs));
  }

  function onGrid() {
    gridT = null;
    if (stopped) return;
    observe(scanWorkspace(root));
  }

  function dropWatch() {
    if (watcher) {
      try {
        watcher.close();
      } catch {}
      watcher = null;
    }
    online = false;
    if (!stopped && !retryT) scheduleRetry();
  }

  function scheduleRetry() {
    const wait = cfg.backoffMs[Math.min(backoffIdx, cfg.backoffMs.length - 1)];
    backoffIdx += 1; // 有进展(重新挂上)立刻回第一档
    retryT = setTimeout(() => {
      retryT = null;
      if (!stopped) startWatch();
    }, wait);
  }

  function startWatch() {
    if (stopped) return;
    if (!existsSync(scratch)) return scheduleRetry();
    try {
      watcher = watch(scratch, { recursive: true }, onWatchEvent);
    } catch {
      return scheduleRetry();
    }
    watcher.on("error", () => dropWatch());
    online = true;
    backoffIdx = 0;
    markDirty(); // 离线期间可能已变:重挂即补一次重算
  }

  function onWatchEvent() {
    if (stopped) return;
    if (!existsSync(scratch)) return dropWatch(); // 监听目录本身被删/改名:句柄作废,进退避
    markDirty();
  }

  try {
    observe(scanWorkspace(root)); // 初扫:签名非空即首态,revision 从 1 起
  } catch {}
  startWatch();

  return {
    state() {
      return { revision, online };
    },
    observe,
    stop() {
      stopped = true;
      for (const t of [debounceT, gridT, retryT]) if (t) clearTimeout(t);
      debounceT = gridT = retryT = null;
      if (watcher) {
        try {
          watcher.close();
        } catch {}
        watcher = null;
      }
      online = false;
    },
  };
}
