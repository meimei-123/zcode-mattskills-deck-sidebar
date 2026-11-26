// test/markdown-frozen.test.mjs —— 一条总断言:没有启用 GitHub 的项目,全部工具回包
// (除 deck_project_list / deck_project_use 的 active.backend 块)与 0.6.1 逐字一致。
// 规格「保真与兼容」:本地 Markdown 后端的行为不许因 0.7.0 的 GitHub 后端改动分毫。
//
// 为什么存一份黄金文件,而不是测试里并排跑两版:
//   0.6.1 的 dist 只在发布提交里,测试要离线、单命令可跑,所以把 0.6.1 的回包规范化后
//   存进 test/fixtures/markdown-0.6.1.golden.json;平时只跑当前 dist,与黄金文件比。
//
// 黄金文件怎么重新录制(换机器可重放;只在换基准时做):
//   1. 取出 0.6.1 的基线 dist:
//        git -C <仓库根> archive 908343b zcode-plugin/dist | tar -x -C <临时目录>/base061
//   2. 用基线服务重录(会覆盖黄金文件):
//        node test/markdown-frozen.test.mjs --record <临时目录>/base061/zcode-plugin/dist/server.mjs
//   3. 平时跑:node test/markdown-frozen.test.mjs
//   录制日期 2026-11-26;基线提交 908343b(0.6.1),录制机器 win32 / Node v24.15.0。
//
// 规范化(只这几样,其余一个字符都不许差,含键序、文案、isError 与 content[0].text):
//   - 工作区根路径 → <WS>;ISO 时间戳 → <ISO>;键名 revision 的值 → <REV>;checkedAt → <AT>;
//   - deck_project_list / deck_project_use 的 structuredContent.active.backend 整块删掉 ——
//     这是两个版本之间唯一允许的差异。
//
// 工作区固定用 test/fixtures/mixed 的副本:无 .git、无 .deck、无技能根(假 HOME 与空插件根
// 把 env:skills 收窄成同一句),所以环境检查与项目清单的回包与机器无关。
// 调用顺序固定(写操作会改卡片状态,后一次调用依赖前一次的结果)。
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // zcode-plugin/
const GOLDEN = join(ROOT, "test", "fixtures", "markdown-0.6.1.golden.json");
const FIXTURE = join(ROOT, "test", "fixtures", "mixed");

// 固定的临时坐标:两次录制/核对看到的路径一模一样,<WS> 替换才精确。
const BASE = join(tmpdir(), "m7-markdown-frozen");
const WS = join(BASE, "ws");
const FAKE_HOME = join(BASE, "home");
const FAKE_PLUGIN_ROOT = join(BASE, "plugin");

// 调用脚本(顺序固定)。写操作夹在中间,读回放最后,确认写后的状态也逐字一致。
const CALLS = [
  { label: "list 全量", name: "deck_issue_list", args: {} },
  { label: "list open", name: "deck_issue_list", args: { state: "open" } },
  { label: "list keys 过滤", name: "deck_issue_list", args: { keys: ["m1-core-board/01", "explore-login/map"] } },
  { label: "get 01", name: "deck_issue_get", args: { key: "01" } },
  { label: "get 1(不补零)", name: "deck_issue_get", args: { key: "1" } },
  { label: "counts", name: "deck_issue_counts", args: {} },
  { label: "list_labels", name: "deck_issue_list_labels", args: {} },
  { label: "map_tickets", name: "deck_map_tickets", args: { key: "00", effortId: "m1-core-board" } },
  { label: "project_list", name: "deck_project_list", args: {} },
  { label: "create", name: "deck_issue_create", args: { effort: "frozen-check", title: "冻结对照:新建一张", body: "黄金对照用。\n", labels: ["needs-triage"] } },
  { label: "comment", name: "deck_issue_comment", args: { key: "frozen-check/01", body: "冻结对照:一条评论。" } },
  { label: "update status", name: "deck_issue_update", args: { key: "frozen-check/01", status: "in-progress" } },
  { label: "set_labels", name: "deck_issue_set_labels", args: { key: "frozen-check/01", labels: ["bug", "ready-for-agent"] } },
  { label: "close(reason)", name: "deck_issue_close", args: { key: "frozen-check/01", reason: "冻结对照:走完即关。" } },
  { label: "reopen", name: "deck_issue_reopen", args: { key: "frozen-check/01" } },
  { label: "get 写后读回", name: "deck_issue_get", args: { key: "frozen-check/01" } },
  { label: "env_check", name: "deck_env_check", args: {} },
];

/** 每次跑之前把工作区恢复成夹具副本(写操作会改它),假 HOME 与空插件根保持空。 */
function resetWorkspace() {
  rmSync(BASE, { recursive: true, force: true });
  mkdirSync(BASE, { recursive: true });
  cpSync(FIXTURE, WS, { recursive: true });
  mkdirSync(FAKE_HOME, { recursive: true });
  mkdirSync(FAKE_PLUGIN_ROOT, { recursive: true });
}

/** 起一个服务会话,按 CALLS 顺序调用,交回每条调用的 result(JSON-RPC 回包的 result)。 */
async function runScript(serverPath) {
  if (!existsSync(serverPath)) throw new Error(`服务入口不存在:${serverPath}`);
  resetWorkspace();
  const env = {
    ...process.env,
    ZCODE_WORKSPACE_ROOT: WS,
    ZCODE_PLUGIN_ROOT: FAKE_PLUGIN_ROOT,
    HOME: FAKE_HOME,
    USERPROFILE: FAKE_HOME,
    HOMEDRIVE: "",
    HOMEPATH: "",
  };
  // 本测试只走本地 Markdown:把 gh 相关旋钮清掉,机器上装没装 gh 都不影响结果。
  delete env.ZCODE_GH_PATH;
  delete env.ZCODE_GH_DEBUG;
  delete env.ZCODE_GITHUB_PROBE_MS;

  const child = spawn(process.execPath, [serverPath], { stdio: ["pipe", "pipe", "inherit"], env });
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
      setTimeout(() => reject(new Error(`timeout waiting ${method}`)), 15000);
    });

  const results = [];
  try {
    await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "frozen", version: "0" } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    for (const c of CALLS) {
      const msg = await rpc("tools/call", { name: c.name, arguments: c.args });
      results.push(msg.result === undefined ? { __rpcError: msg.error } : msg.result);
    }
  } finally {
    child.stdin.end();
    await new Promise((r) => child.on("exit", r));
  }
  return results;
}

/** 深拷 + 规范化。键名命中的值整体替换;字符串里的路径与 ISO 时间替换成占位符。 */
function normalize(value, wsRoot) {
  const wsRe = new RegExp(wsRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  const isoRe = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
  const walk = (v, key) => {
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v)) {
        if (k === "revision") out[k] = "<REV>";
        else if (k === "checkedAt") out[k] = "<AT>";
        else out[k] = walk(v[k], k);
      }
      // 唯一允许的差异:活动项目多出来的 backend 块(规格「保真与兼容」)。
      if (out.active && typeof out.active === "object" && "backend" in out.active) delete out.active.backend;
      return out;
    }
    if (typeof v === "string") {
      // 大小写不敏感地替换工作区根:Windows 上 realpath 可能改动盘符/目录名的大小写。
      return v.replace(wsRe, "<WS>").replace(isoRe, "<ISO>");
    }
    return v;
  };
  return walk(value, null);
}

const failures = [];
function check(name, cond, detail = "") {
  if (cond) console.log(`ok - ${name}`);
  else {
    failures.push(name);
    console.error(`FAIL - ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

function firstDiff(a, b) {
  const sa = typeof a === "string" ? a : JSON.stringify(a);
  const sb = typeof b === "string" ? b : JSON.stringify(b);
  if (sa === sb) return "";
  let i = 0;
  while (i < sa.length && i < sb.length && sa[i] === sb[i]) i++;
  const from = Math.max(0, i - 120);
  return `\n  黄金:…${sa.slice(from, i + 240)}\n  当前:…${sb.slice(from, i + 240)}`;
}

const recordIdx = process.argv.indexOf("--record");
const currentServer = join(ROOT, "dist", "server.mjs");

if (recordIdx >= 0) {
  const baseServer = process.argv[recordIdx + 1];
  if (!baseServer) {
    console.error("用法:node test/markdown-frozen.test.mjs --record <0.6.1 的 dist/server.mjs>");
    process.exit(2);
  }
  console.log(`录制基线回包:${baseServer}`);
  const raw = await runScript(baseServer);
  const results = raw.map((r) => normalize(r, WS));
  writeFileSync(
    GOLDEN,
    JSON.stringify({ base: "0.6.1", commit: "908343b", recordedAt: "2026-11-26", calls: CALLS.map((c) => ({ name: c.name, args: c.args })), results }, null, 2) + "\n"
  );
  console.log(`已写 ${GOLDEN}(${results.length} 条回包)`);
  process.exit(0);
}

if (!existsSync(GOLDEN)) {
  console.error(`缺少黄金文件 ${GOLDEN};按文件头注释用 0.6.1 的基线 dist 录制一次。`);
  process.exit(1);
}
const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
check("黄金文件的调用脚本与当前一致(加/改调用必须重录)", JSON.stringify(golden.calls) === JSON.stringify(CALLS.map((c) => ({ name: c.name, args: c.args }))));

const actual = (await runScript(currentServer)).map((r) => normalize(r, WS));
check(`回包条数与黄金一致(${golden.results.length})`, actual.length === golden.results.length, `黄金 ${golden.results.length} / 当前 ${actual.length}`);
for (let i = 0; i < CALLS.length; i++) {
  const want = golden.results[i];
  const got = actual[i];
  const same = JSON.stringify(want) === JSON.stringify(got);
  check(`逐字一致:${CALLS[i].label}(${CALLS[i].name})`, same, same ? "" : firstDiff(want, got));
}

console.log(failures.length === 0 ? "\n全部通过" : `\n${failures.length} 项失败`);
process.exit(failures.length === 0 ? 0 : 1);
