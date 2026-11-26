// m7 票 06 缝测试:环境检查的 GitHub 七步链(git:repo → gh:remote → gh:installed →
// gh:authed → gh:repoAccess → env:bridge → env:skills),以及本地 Markdown 六步链的回归。
//
// 缝:真服务进程(dist/server.mjs)+ 假 gh(test/fixtures/fake-gh.mjs,经 ZCODE_GH_PATH 递入)。
// 断言只打工具回包与假 gh 调用日志;不 import 服务端内部模块。工作区与假 HOME 都是临时目录,
// 结束删净。技能根用假 HOME 收窄(只留 ~/.zcode/skills 一处可读),判定可复现。
// 探测间隔经 ZCODE_GITHUB_PROBE_MS 收短;检查页的 TTL 与探测间隔同一档,缓存断言靠它。
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { baseState, makeFakeGh, makeWorkspace } from "./gh-harness.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // zcode-plugin/
const ANCHOR_GITHUB = "# Issue tracker: GitHub\n\n本仓的票在 GitHub Issues 上。\n";
const BASE = 500; // 收短的探测/检查缓存间隔(缺省 60000)
const GITHUB_IDS = ["git:repo", "gh:remote", "gh:installed", "gh:authed", "gh:repoAccess", "env:bridge", "env:skills"];
const MARKDOWN_IDS = ["scratch:workspace", "scratch:cards", "env:watch", "env:bridge", "env:skills", "git:repo"];

let failures = 0;
let checks = 0;
function check(name, cond, detail = "") {
  checks++;
  if (cond) console.log(`ok - ${name}`);
  else {
    failures++;
    console.error(`FAIL - ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

/** 进程环境:按 extraEnv 落值(undefined = 删掉;Windows 上 PATH/Path 并存,大小写变体一并清)。 */
function buildEnv(workspaceRoot, extraEnv = {}) {
  const env = { ...process.env };
  for (const [k, v] of Object.entries(extraEnv)) {
    for (const kk of Object.keys(env)) {
      if (kk !== k && kk.toLowerCase() === k.toLowerCase()) delete env[kk];
    }
    if (v === undefined) delete env[k];
    else env[k] = String(v);
  }
  env.ZCODE_WORKSPACE_ROOT = workspaceRoot;
  return env;
}

/** 起一个指向指定工作区根的 server 会话(与 server-github-probe 同形状)。 */
async function startServer(workspaceRoot, extraEnv = {}, rpcTimeoutMs = 20000) {
  const child = spawn(process.execPath, [join(ROOT, "dist", "server.mjs")], {
    stdio: ["pipe", "pipe", "inherit"],
    env: buildEnv(workspaceRoot, extraEnv),
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
  const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, resolve);
      send({ jsonrpc: "2.0", id, method, params });
      setTimeout(() => reject(new Error(`timeout waiting ${method}`)), rpcTimeoutMs);
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

const resultOf = (msg) => (msg && msg.result) || {};
const sc = (msg) => resultOf(msg).structuredContent || {};
const textOf = (msg) => String(((resultOf(msg).content || [])[0] || {}).text || "");
const isErr = (msg) => resultOf(msg).isError === true;
const stepOf = (snapshot, id) => ((snapshot && snapshot.steps) || []).find((s) => s.id === id);
const idsOf = (snapshot) => ((snapshot && snapshot.steps) || []).map((s) => s.id);
const statusOf = (snapshot) => Object.fromEntries(((snapshot && snapshot.steps) || []).map((s) => [s.id, s.status]));

const callText = (c) => (Array.isArray(c.argv) ? c.argv.join(" ") : "");
/** 变更探测走分页读取(创建时间倒序);它是「强制探测」的唯一可见痕迹。 */
const isProbeCall = (c) => callText(c).includes("orderBy:{field:CREATED_AT");

/** 假 HOME:只留 ~/.zcode/skills 一处可读,技能步的判定不依赖本机安装。 */
function makeHome() {
  const dir = mkdtempSync(join(tmpdir(), "m7-envcheck-home-"));
  mkdirSync(join(dir, ".zcode", "skills"), { recursive: true });
  return {
    dir,
    env: { HOME: dir, USERPROFILE: dir, HOMEDRIVE: "", HOMEPATH: "" },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** 无 .git 的工作区:只放锚文件(用来验证「无关联仓库」停在哪一步)。 */
function makeNoGitWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "m7-envcheck-nogit-"));
  mkdirSync(join(root, "docs", "agents"), { recursive: true });
  writeFileSync(join(root, "docs", "agents", "issue-tracker.md"), ANCHOR_GITHUB, "utf8");
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** 假 gh 的仓库状态:可选覆盖 permissions/auth(其余字段用夹具默认值)。 */
function stateFor({ permissions, auth } = {}) {
  const st = baseState();
  if (permissions !== undefined) st.repos["owner/name"].permissions = permissions;
  if (auth !== undefined) st.auth = auth;
  return st;
}

// ---------------------------------------------------------------------------
// a + j. 全好:七步 id/顺序一字不差、全 done、repoAccess 写「可写」、allDone;
//        GitHub 项目下不扫 .scratch(没有 .scratch 也全绿)
// ---------------------------------------------------------------------------
async function sliceAllGood() {
  const ws = makeWorkspace({ repo: "owner/name", anchor: ANCHOR_GITHUB });
  const home = makeHome();
  const gh = makeFakeGh({ state: stateFor() });
  const s = await startServer(ws.root, { ...home.env, ...gh.env, ZCODE_GITHUB_PROBE_MS: String(BASE) });
  try {
    const r = await s.call("deck_env_check", {});
    const body = sc(r);
    const snap = body.snapshot || {};
    check("a. 应答无错误(ok:true + snapshot + checkedAt)", !isErr(r) && body.ok === true && !!snap && typeof body.checkedAt === "string", textOf(r).slice(0, 200));
    check("a. 七步 id 与顺序一字不差", JSON.stringify(idsOf(snap)) === JSON.stringify(GITHUB_IDS), JSON.stringify(idsOf(snap)));
    check("a. 七步全部 done", ((snap.steps || []).every((x) => x.status === "done")), JSON.stringify(statusOf(snap)));
    check("a. 每步形状齐(id/status/show/actions/blockedBy)", (snap.steps || []).every((x) => typeof x.id === "string" && ["done", "current", "fail", "pending"].includes(x.status) && x.show && typeof x.show.fallback === "string" && typeof x.show.desc === "string" && Array.isArray(x.actions) && x.blockedBy === null), JSON.stringify(snap.steps));
    const access = stepOf(snap, "gh:repoAccess");
    check("a. gh:repoAccess 描述写「可写」", /可写/.test(String(access && access.show && access.show.desc)), JSON.stringify(access));
    check("a. 链状态 allDone(7/7,currentIndex null)", snap.chainState === "allDone" && snap.doneCount === 7 && snap.totalCount === 7 && snap.currentIndex === null && snap.isComplete === true, JSON.stringify({ state: snap.chainState, done: snap.doneCount, ci: snap.currentIndex, complete: snap.isComplete }));
    check("a. 人话摘要 7/7 全绿", /环境检查 7\/7 全绿/.test(textOf(r)), textOf(r).slice(0, 120));

    // j:GitHub 后端不扫 .scratch —— 没有这个目录也能七步全绿,而且不会被建出来。
    check("j. GitHub 项目没有 .scratch 也七步全绿", !existsSync(join(ws.root, ".scratch")) && snap.chainState === "allDone", JSON.stringify({ scratch: existsSync(join(ws.root, ".scratch")), state: snap.chainState }));
    check("j. 检查后仍然没有 .scratch(不写盘)", !existsSync(join(ws.root, ".scratch")), join(ws.root, ".scratch"));
  } finally {
    await s.stop();
    gh.cleanup();
    home.cleanup();
    ws.cleanup();
  }
}

// ---------------------------------------------------------------------------
// b. 只读仓库:repoAccess 写「只读」,清单的 backend.writable === false
// ---------------------------------------------------------------------------
async function sliceReadonly() {
  const ws = makeWorkspace({ repo: "owner/name", anchor: ANCHOR_GITHUB });
  const home = makeHome();
  const gh = makeFakeGh({ state: stateFor({ permissions: { push: false, triage: false } }) });
  const s = await startServer(ws.root, { ...home.env, ...gh.env, ZCODE_GITHUB_PROBE_MS: String(BASE) });
  try {
    const snap = sc(await s.call("deck_env_check", {})).snapshot || {};
    const access = stepOf(snap, "gh:repoAccess");
    check("b. repoAccess 描述写「只读」", access && access.status === "done" && /只读/.test(String(access.show.desc)), JSON.stringify(access));
    const list = sc(await s.call("deck_project_list", {}));
    check("b. 清单 backend.writable === false", list.active && list.active.backend && list.active.backend.writable === false, JSON.stringify(list.active && list.active.backend));
  } finally {
    await s.stop();
    gh.cleanup();
    home.cleanup();
    ws.cleanup();
  }
}

// ---------------------------------------------------------------------------
// c. 权限问不出来:描述写「未知」,不写成可写(清单 writable 仍是 null)
// ---------------------------------------------------------------------------
async function slicePermUnknown() {
  const ws = makeWorkspace({ repo: "owner/name", anchor: ANCHOR_GITHUB });
  const home = makeHome();
  // permissions:null → `gh api repos/O/N --jq .permissions` 回 null,房间按「问不出来」处理。
  const gh = makeFakeGh({ state: stateFor({ permissions: null }) });
  const s = await startServer(ws.root, { ...home.env, ...gh.env, ZCODE_GITHUB_PROBE_MS: String(BASE) });
  try {
    const snap = sc(await s.call("deck_env_check", {})).snapshot || {};
    const access = stepOf(snap, "gh:repoAccess");
    const desc = String((access && access.show && access.show.desc) || "");
    check("c. repoAccess 描述写「未知」", access && access.status === "done" && /未知/.test(desc), JSON.stringify(access));
    check("c. 描述不写「可写」", !/可写/.test(desc), desc);
    const list = sc(await s.call("deck_project_list", {}));
    check("c. 清单 writable 仍是 null(不冒充可写)", list.active && list.active.backend && list.active.backend.writable === null, JSON.stringify(list.active && list.active.backend));
  } finally {
    await s.stop();
    gh.cleanup();
    home.cleanup();
    ws.cleanup();
  }
}

// ---------------------------------------------------------------------------
// d. 没装 gh:gh:installed 停住、之后全 pending;动作 prompt 含 gh --version / PATH /
//    ZCODE_GH_PATH,且不含 DSH;全程零 gh 调用
// ---------------------------------------------------------------------------
async function sliceNoGh() {
  const ws = makeWorkspace({ repo: "owner/name", anchor: ANCHOR_GITHUB });
  const home = makeHome();
  const gh = makeFakeGh({ state: stateFor() });
  const missing = join(ws.root, "definitely-not-gh.exe");
  const s = await startServer(ws.root, {
    ...home.env,
    ...gh.env,
    ZCODE_GH_PATH: missing,
    PATH: "",
    ZCODE_GITHUB_PROBE_MS: String(BASE),
  });
  try {
    const snap = sc(await s.call("deck_env_check", {})).snapshot || {};
    check("d. gh:installed 停在 current", statusOf(snap)["gh:installed"] === "current", JSON.stringify(statusOf(snap)));
    check("d. gh:installed 之后全 pending", ["gh:authed", "gh:repoAccess", "env:bridge", "env:skills"].every((id) => statusOf(snap)[id] === "pending"), JSON.stringify(statusOf(snap)));
    const step = stepOf(snap, "gh:installed");
    const prompt = String((step && step.actions && step.actions[0] && step.actions[0].prompt) || "");
    check("d. 动作 prompt 同时含 gh --version、PATH、ZCODE_GH_PATH", /gh --version/.test(prompt) && /PATH/.test(prompt) && /ZCODE_GH_PATH/.test(prompt), prompt);
    check("d. 动作 prompt 不含 DSH", !/DSH/.test(prompt), prompt);
    check("d. 阻塞判定落在 gh:installed", snap.blockingCheck === "gh:installed" && snap.chainState === "hasCurrent", JSON.stringify({ b: snap.blockingCheck, s: snap.chainState }));
    check("d. 没装 gh 全程零调用", gh.calls().length === 0, JSON.stringify(gh.calls().map(callText)));
  } finally {
    await s.stop();
    gh.cleanup();
    home.cleanup();
    ws.cleanup();
  }
}

// ---------------------------------------------------------------------------
// e. 没登录:gh:authed 停住、repoAccess 及之后 pending;prompt 含 gh auth login,不含 DSH
// ---------------------------------------------------------------------------
async function sliceNotAuthed() {
  const ws = makeWorkspace({ repo: "owner/name", anchor: ANCHOR_GITHUB });
  const home = makeHome();
  const gh = makeFakeGh({ state: stateFor({ auth: "missing" }) });
  const s = await startServer(ws.root, { ...home.env, ...gh.env, ZCODE_GITHUB_PROBE_MS: String(BASE) });
  try {
    const snap = sc(await s.call("deck_env_check", {})).snapshot || {};
    check("e. gh:installed done、gh:authed current", statusOf(snap)["gh:installed"] === "done" && statusOf(snap)["gh:authed"] === "current", JSON.stringify(statusOf(snap)));
    check("e. gh:repoAccess 及之后全 pending", ["gh:repoAccess", "env:bridge", "env:skills"].every((id) => statusOf(snap)[id] === "pending"), JSON.stringify(statusOf(snap)));
    const step = stepOf(snap, "gh:authed");
    const prompt = String((step && step.actions && step.actions[0] && step.actions[0].prompt) || "");
    check("e. 动作 prompt 含 gh auth login", /gh auth login/.test(prompt), prompt);
    check("e. 动作 prompt 不含 DSH", !/DSH/.test(prompt), prompt);
    check("e. 阻塞判定落在 gh:authed", snap.blockingCheck === "gh:authed", JSON.stringify(snap.blockingCheck));
  } finally {
    await s.stop();
    gh.cleanup();
    home.cleanup();
    ws.cleanup();
  }
}

// ---------------------------------------------------------------------------
// f. 无关联仓库(工作区没有 .git):gh:remote 停住、之后 pending,hint 说清原因
// ---------------------------------------------------------------------------
async function sliceNoRepo() {
  const ws = makeNoGitWorkspace();
  const home = makeHome();
  const gh = makeFakeGh({ state: stateFor() });
  const s = await startServer(ws.root, { ...home.env, ...gh.env, ZCODE_GITHUB_PROBE_MS: String(BASE) });
  try {
    const snap = sc(await s.call("deck_env_check", {})).snapshot || {};
    const st = statusOf(snap);
    check("f. gh:remote 停在 fail", st["gh:remote"] === "fail", JSON.stringify(st));
    check("f. gh:remote 之后全 pending", ["gh:installed", "gh:authed", "gh:repoAccess", "env:bridge", "env:skills"].every((id) => st[id] === "pending"), JSON.stringify(st));
    const remote = stepOf(snap, "gh:remote");
    const hint = String((remote && remote.show && remote.show.hint) || "");
    const desc = String((remote && remote.show && remote.show.desc) || "");
    check("f. 原因写在 desc(没关联 GitHub 仓库)", /GitHub/.test(desc) && /(关联|仓库)/.test(desc), desc);
    check("f. hint 给出下一步(指针/重新检查)", hint.length > 0 && /(origin|重新检查)/.test(hint), hint);
    check("f. 停在 gh:remote", snap.blockingCheck === "gh:remote" && snap.chainState === "hasCurrent", JSON.stringify({ b: snap.blockingCheck, s: snap.chainState }));
    check("f. 没到出站那几步(零 gh 调用)", gh.calls().length === 0, JSON.stringify(gh.calls().map(callText)));
  } finally {
    await s.stop();
    gh.cleanup();
    home.cleanup();
    ws.cleanup();
  }
}

// ---------------------------------------------------------------------------
// g. 仓库访问不到:gh:repoAccess 停住并给原因
// ---------------------------------------------------------------------------
async function sliceNoAccess() {
  const ws = makeWorkspace({ repo: "owner/name", anchor: ANCHOR_GITHUB });
  const home = makeHome();
  const gh = makeFakeGh({ state: stateFor() });
  gh.patch((st) => {
    st.fail = "notfound";
  });
  const s = await startServer(ws.root, { ...home.env, ...gh.env, ZCODE_GITHUB_PROBE_MS: String(BASE) });
  try {
    const snap = sc(await s.call("deck_env_check", {})).snapshot || {};
    const st = statusOf(snap);
    check("g. gh:installed/gh:authed done、gh:repoAccess fail", st["gh:installed"] === "done" && st["gh:authed"] === "done" && st["gh:repoAccess"] === "fail", JSON.stringify(st));
    check("g. gh:repoAccess 之后全 pending", ["env:bridge", "env:skills"].every((id) => st[id] === "pending"), JSON.stringify(st));
    const access = stepOf(snap, "gh:repoAccess");
    const desc = String((access && access.show && access.show.desc) || "");
    const hint = String((access && access.show && access.show.hint) || "");
    check("g. 原因点名仓库与「访问不到」", /访问不到/.test(desc) && /owner\/name/.test(desc), desc);
    check("g. hint 给出下一步", hint.length > 0 && /重新检查/.test(hint), hint);
    check("g. 停在 gh:repoAccess", snap.blockingCheck === "gh:repoAccess", JSON.stringify(snap.blockingCheck));
  } finally {
    await s.stop();
    gh.cleanup();
    home.cleanup();
    ws.cleanup();
  }
}

// ---------------------------------------------------------------------------
// h. 缓存与强制:间隔内连调两次 → 假 gh 零新增调用;force → 重新出站并触发一次强制探测
//    (修订号推进);修复假 gh 状态后 force → 对应步骤转 done;force 写缓存,紧接着读走缓存
// ---------------------------------------------------------------------------
async function sliceCacheAndForce() {
  const ws = makeWorkspace({ repo: "owner/name", anchor: ANCHOR_GITHUB });
  const home = makeHome();
  const gh = makeFakeGh({ state: stateFor({ auth: "missing" }) });
  const s = await startServer(ws.root, { ...home.env, ...gh.env, ZCODE_GITHUB_PROBE_MS: String(BASE) });
  try {
    const first = sc(await s.call("deck_env_check", {}));
    check("h. 首次检查:没登录停在 gh:authed", statusOf(first.snapshot)["gh:authed"] === "current", JSON.stringify(statusOf(first.snapshot)));
    check("h. 首次检查真出站了", gh.calls().length > 0, String(gh.calls().length));

    const n1 = gh.calls().length;
    const second = sc(await s.call("deck_env_check", {}));
    check("h. 间隔内第二次走缓存:零新增 gh 调用", gh.calls().length === n1, `${gh.calls().length} vs ${n1}`);
    check("h. 缓存回包带 cached:true 且 checkedAt 不变", second.cached === true && second.checkedAt === first.checkedAt, JSON.stringify({ cached: second.cached, a: first.checkedAt, b: second.checkedAt }));

    // 修好登录态:force 应重新出站、恰好触发一次强制探测,并让 gh:authed 转 done。
    gh.patch((st) => {
      st.auth = "ok";
    });
    const beforeList = sc(await s.call("deck_issue_list", {}));
    const rev0 = typeof beforeList.revision === "number" ? beforeList.revision : -1;
    check("h. force 之前探测还没跑过(revision 0)", rev0 === 0, String(rev0));

    const n2 = gh.calls().length;
    const forced = sc(await s.call("deck_env_check", { force: true }));
    const forcedCalls = gh.calls().slice(n2);
    check("h. force 重新出站", forcedCalls.length > 0, String(forcedCalls.length));
    check("h. force 触发了一次强制探测(分页读取恰好一条)", forcedCalls.filter(isProbeCall).length === 1, JSON.stringify(forcedCalls.map(callText)));
    check("h. 修复后 gh:authed 转 done", statusOf(forced.snapshot)["gh:authed"] === "done", JSON.stringify(statusOf(forced.snapshot)));
    check("h. force 回包 cached:false", forced.cached === false, JSON.stringify(forced.cached));

    const afterList = sc(await s.call("deck_issue_list", {}));
    check("h. 强制探测推进了修订号(看板被顺手刷新)", typeof afterList.revision === "number" && afterList.revision > rev0, JSON.stringify({ before: rev0, after: afterList.revision }));

    const n3 = gh.calls().length;
    const afterForce = sc(await s.call("deck_env_check", {}));
    check("h. force 重建的快照进了缓存(紧接着读零出站)", gh.calls().length === n3 && afterForce.cached === true, JSON.stringify({ calls: gh.calls().length, n3, cached: afterForce.cached }));
  } finally {
    await s.stop();
    gh.cleanup();
    home.cleanup();
    ws.cleanup();
  }
}

// ---------------------------------------------------------------------------
// i. 本地 Markdown 回归:deck_env_check 仍是六步,回包与现状一致,且零 gh 调用
// ---------------------------------------------------------------------------
async function sliceMarkdownRegression() {
  const ws = makeWorkspace({ repo: "owner/name", anchor: null, cards: [{ effort: "demo", n: "01", slug: "one", title: "第一张" }] });
  const home = makeHome();
  const gh = makeFakeGh({ state: stateFor() });
  const s = await startServer(ws.root, { ...home.env, ...gh.env, ZCODE_GITHUB_PROBE_MS: String(BASE) });
  try {
    const r = await s.call("deck_env_check", {});
    const body = sc(r);
    const snap = body.snapshot || {};
    check("i. 本地链仍是六步且顺序不变", JSON.stringify(idsOf(snap)) === JSON.stringify(MARKDOWN_IDS), JSON.stringify(idsOf(snap)));
    check("i. 本地回包键集与现状一致(ok/snapshot/checkedAt)", JSON.stringify(Object.keys(body).sort()) === JSON.stringify(["checkedAt", "ok", "snapshot"]), JSON.stringify(Object.keys(body).sort()));
    check("i. 本地六步全绿", snap.chainState === "allDone" && snap.doneCount === 6, JSON.stringify({ state: snap.chainState, done: snap.doneCount }));
    check("i. 本地链零 gh 调用", gh.calls().length === 0, JSON.stringify(gh.calls().map(callText)));
  } finally {
    await s.stop();
    gh.cleanup();
    home.cleanup();
    ws.cleanup();
  }
}

await sliceAllGood();
await sliceReadonly();
await slicePermUnknown();
await sliceNoGh();
await sliceNotAuthed();
await sliceNoRepo();
await sliceNoAccess();
await sliceCacheAndForce();
await sliceMarkdownRegression();

console.log(failures === 0 ? `\n全部通过(${checks} 项断言)` : `\n${failures} 项失败(${checks} 项断言)`);
process.exit(failures === 0 ? 0 : 1);
