// 工单 08 缝 1 测试:真实 fs.watch 链路(Node 直跑 dist/server.mjs 的 tools/call)。
// 工作区是临时目录(拷贝 fixtures 后真实改盘),断言:
//   - counts/list 响应携带数据修订号 revision,文件改动后 revision 递增、无改动稳定;
//   - 防抖合并窗内的多次改动合并成一次修订;
//   - counts「卡片文件读不动」语义按监听状态分派(在线整体拒绝 / 离线静默跳过);
//   - 断链(监听目录被整删)后退避重连,监听重新在线。
// 发条经 ZCODE_REFRESH_* 环境收短(缺省数值另由 slice 0 对照 port-notes 断言),不睡真 1.2s/4s。
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as watchMod from "../dist/watch.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // zcode-plugin/
const FIXTURES = join(ROOT, "test", "fixtures");
const DEBOUNCE = 80; // 收短的合并窗(缺省 1200,见 refresh-constants.md syncDirtyProbeDebounceMs)
const GRID = 160; // 收短的同步栅格(缺省 4000,syncPollGridMs)

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`ok - ${name}`);
  else {
    failures++;
    console.error(`FAIL - ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 轮询断言条件(每 40ms 取一次 counts 的 structuredContent,直到满足或超时)。 */
async function untilCounts(s, pred, timeoutMs = 4000) {
  const t0 = Date.now();
  for (;;) {
    const r = await s.call("deck_issue_counts", {});
    const sc = r.result?.structuredContent;
    if (sc && pred(sc)) return sc;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(40);
  }
}

/** 起一个指向指定工作区根的 server 会话(同 server-read 模式);envExtra 收短发条。 */
async function startServer(workspaceRoot, envExtra = {}) {
  const child = spawn(process.execPath, [join(ROOT, "dist", "server.mjs")], {
    stdio: ["pipe", "pipe", "inherit"],
    env: {
      ...process.env,
      ZCODE_WORKSPACE_ROOT: workspaceRoot,
      ZCODE_REFRESH_DEBOUNCE_MS: String(DEBOUNCE),
      ZCODE_REFRESH_GRID_MS: String(GRID),
      ...envExtra,
    },
  });
  let buf = "";
  const pending = new Map();
  let nextId = 1;
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, resolve);
      send({ jsonrpc: "2.0", id, method, params });
      setTimeout(() => reject(new Error(`timeout waiting ${method}`)), 8000);
    });
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const call = (name, args = {}) => rpc("tools/call", { name, arguments: args });
  const stop = async () => {
    child.stdin.end();
    await new Promise((r) => child.on("exit", r));
  };
  return { call, rpc, stop };
}

/** 拷一份 fixture 到临时目录(测试里真实改盘,不动入库 fixtures)。 */
function mkws(fixture) {
  const dir = mkdtempSync(join(tmpdir(), `t08-${fixture}-`));
  cpSync(join(FIXTURES, fixture), dir, { recursive: true });
  return dir;
}
const cleanup = (ws) => rmSync(ws, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// 切片 0:缺省发条对照 port-notes refresh-constants.md(独立真源,不测实现自证)
// ---------------------------------------------------------------------------
function sliceConstants() {
  const d = watchMod.REFRESH_DEFAULTS;
  check("watch: 缺省合并窗 1200ms(syncDirtyProbeDebounceMs)", d.debounceMs === 1200, String(d.debounceMs));
  check("watch: 缺省同步栅格 4000ms(syncPollGridMs)", d.gridMs === 4000, String(d.gridMs));
  check("watch: 缺省退避阶梯 8s→30s→2min→5min(chainBackoffMs)",
    JSON.stringify(d.backoffMs) === JSON.stringify([8000, 30000, 120000, 300000]),
    JSON.stringify(d.backoffMs));
}

// ---------------------------------------------------------------------------
// 切片 1:counts/list 携带 revision;文件改动后 revision 恰好 +1 且数据跟上;无改动稳定
// ---------------------------------------------------------------------------
async function sliceRevision() {
  if (!existsSync(join(ROOT, "dist", "watch.mjs"))) {
    check("revision: dist/watch.mjs 可导入", false);
    return;
  }
  const ws = mkws("mixed");
  const s = await startServer(ws);
  try {
    const c1 = await s.call("deck_issue_counts", {});
    const sc1 = c1.result?.structuredContent || {};
    check("revision: counts 携带 revision(整数,首态 1)", Number.isInteger(sc1.revision) && sc1.revision === 1,
      JSON.stringify(sc1.revision));
    const l1 = await s.call("deck_issue_list", {});
    check("revision: list 携带同值 revision",
      l1.result?.structuredContent?.revision === sc1.revision,
      JSON.stringify(l1.result?.structuredContent?.revision));

    writeFileSync(join(ws, ".scratch", "m1-core-board", "issues", "05-新卡.md"), "# 05: 新卡\n\nStatus: open\n");
    const bumped = await untilCounts(s, (sc) => sc.revision > 1 && sc.counts?.total === 7);
    check("revision: 文件改动后 revision 递增且数据跟上(票 6→7)", !!bumped,
      JSON.stringify(bumped && { rev: bumped.revision, total: bumped.counts?.total }));

    await sleep(GRID * 4);
    const c2 = await s.call("deck_issue_counts", {});
    check("revision: 无后续改动不再递增", c2.result?.structuredContent?.revision === 2,
      JSON.stringify(c2.result?.structuredContent?.revision));
    check("revision: 改动内容可读(list 含新卡)", (await s.call("deck_issue_list", { keys: ["05"] })).result?.structuredContent?.rows?.[0]?.title === "新卡");
  } finally {
    await s.stop();
    cleanup(ws);
  }
}

// ---------------------------------------------------------------------------
// 切片 2:防抖合并窗——窗内两次改动合并成一次修订(期间不发请求,让监听自己走完防抖+栅格)
// ---------------------------------------------------------------------------
async function sliceMerge() {
  const ws = mkws("mixed");
  const s = await startServer(ws);
  try {
    const base = (await s.call("deck_issue_counts", {})).result?.structuredContent?.revision;
    writeFileSync(join(ws, ".scratch", "m1-core-board", "issues", "06-a.md"), "# 06: 甲\n");
    writeFileSync(join(ws, ".scratch", "m1-core-board", "issues", "07-b.md"), "# 07: 乙\n");
    await sleep(DEBOUNCE + GRID * 4);
    const after = (await s.call("deck_issue_counts", {})).result?.structuredContent;
    check("merge: 合并窗内两次改动合并成一次修订(票 6→8)",
      after?.revision === base + 1 && after?.counts?.total === 8,
      JSON.stringify(after && { rev: after.revision, total: after.counts?.total }));
  } finally {
    await s.stop();
    cleanup(ws);
  }
}

// ---------------------------------------------------------------------------
// 切片 3:counts「卡片文件读不动」语义分派(工单 02 遗留,上游口径)。
//   坏票 = issues/ 下一个叫 NN-*.md 的目录(readFileSync 必抛 EISDIR,跨平台稳定)。
//   在线(监听挂得上)→ counts 整体拒绝(不给偏小的数),list 仍静默跳过。
// ---------------------------------------------------------------------------
async function sliceRejectOnline() {
  const ws = mkws("mixed");
  mkdirSync(join(ws, ".scratch", "m1-core-board", "issues", "06-读不动.md")); // spawn 前就有 → 监听在线
  const s = await startServer(ws);
  try {
    const c = await s.call("deck_issue_counts", {});
    check("counts(在线): 卡片文件读不动 → 整体拒绝(isError + 中文说明)",
      c.result?.isError === true && /读不动/.test(c.result?.content?.[0]?.text || "") && /整体拒绝/.test(c.result?.content?.[0]?.text || ""),
      JSON.stringify(c.result?.isError && c.result?.content?.[0]?.text));
    const l = await s.call("deck_issue_list", {});
    check("counts(在线): list 永远静默跳过坏票(8 行)",
      !l.result?.isError && l.result?.structuredContent?.rows?.length === 8,
      JSON.stringify(l.result?.structuredContent?.rows?.length));
  } finally {
    await s.stop();
    cleanup(ws);
  }
}

// ---------------------------------------------------------------------------
// 切片 4:离线回落——spawn 时无 .scratch(监听挂不上,退避压到 20s 内不会重试):
//   离线窗口内读不动的票回落静默跳过;revision 由请求探测兜底前进(降级新鲜度)。
// ---------------------------------------------------------------------------
async function sliceOfflineSkip() {
  const ws = mkdtempSync(join(tmpdir(), "t08-offline-"));
  const s = await startServer(ws, { ZCODE_REFRESH_BACKOFF_MS: "20000" });
  try {
    mkdirSync(join(ws, ".scratch", "demo", "issues"), { recursive: true });
    writeFileSync(join(ws, ".scratch", "demo", "issues", "01-好票.md"), "# 01: 好票\n");
    mkdirSync(join(ws, ".scratch", "demo", "issues", "02-读不动.md"));
    const c = await s.call("deck_issue_counts", {});
    const sc = c.result?.structuredContent || {};
    check("counts(离线): 读不动回落静默跳过,不整体拒绝且只计可读票",
      !c.result?.isError && sc.counts?.total === 1,
      JSON.stringify(c.result?.isError || sc.counts));
    check("counts(离线): revision 由请求探测兜底前进(初扫空=1 → 有票=2)",
      sc.revision === 2, JSON.stringify(sc.revision));
  } finally {
    await s.stop();
    cleanup(ws);
  }
}

// ---------------------------------------------------------------------------
// 切片 5:断链退避重连——监听目录被整删(断链→退避),重建后重挂在线;
//   在线与否用分派语义行为断言(补坏票后 counts 回到整体拒绝 = 已重新在线)。
// ---------------------------------------------------------------------------
async function sliceReconnect() {
  const ws = mkws("mixed");
  const s = await startServer(ws, { ZCODE_REFRESH_BACKOFF_MS: "400,400" });
  try {
    check("reconnect: 起点在线(有票)", (await s.call("deck_issue_counts", {})).result?.structuredContent?.counts?.total === 6);
    rmSync(join(ws, ".scratch"), { recursive: true, force: true }); // 断链:监听目录整删
    const gone = await untilCounts(s, (sc) => sc.empty === true);
    check("reconnect: 目录删除后 counts 给空态不炸", !!gone, JSON.stringify(gone));

    mkdirSync(join(ws, ".scratch", "re", "issues"), { recursive: true });
    writeFileSync(join(ws, ".scratch", "re", "issues", "01-重建.md"), "# 01: 重建\n");
    await sleep(1500); // 退避 400/400 重挂 + 防抖 + 栅格
    const rebuilt = (await s.call("deck_issue_counts", {})).result?.structuredContent;
    check("reconnect: 退避重挂后新工作区跟上(票=1)", rebuilt?.counts?.total === 1, JSON.stringify(rebuilt?.counts));

    mkdirSync(join(ws, ".scratch", "re", "issues", "02-读不动.md"));
    const c = await s.call("deck_issue_counts", {});
    check("reconnect: 重新在线后 counts 语义回到整体拒绝(分派按监听状态走)",
      c.result?.isError === true && /整体拒绝/.test(c.result?.content?.[0]?.text || ""),
      JSON.stringify(c.result?.isError));
  } finally {
    await s.stop();
    cleanup(ws);
  }
}

await sliceConstants();
await sliceRevision();
await sliceMerge();
await sliceRejectOnline();
await sliceOfflineSkip();
await sliceReconnect();

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
