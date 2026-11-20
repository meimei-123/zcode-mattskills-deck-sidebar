// 工单 01 缝 1 测试:deck_git 工具面契约 + 真 git 临时仓上的读电话。
// 两段:
//   ① Node 直跑 dist/server.mjs 的 tools/list / tools/call(声明、未知方法、cwd 边界、坏 args 不崩);
//   ② mkdtemp + git init 的真仓(本机 git),经同一条工具断言首屏/状态/历史/差异/分支,
//      并直连 dist/git.mjs 的 bridge 验方法表与目标路径边界。测试结束删临时目录。
// 期望值独立于实现:来自工单 01 的验收条目与 git 自身行为(分支名/提交标题/补丁行)。
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // zcode-plugin/
const DIST_SERVER = join(ROOT, "dist", "server.mjs");
const DIST_GIT = join(ROOT, "dist", "git.mjs");

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`ok - ${name}`);
  else {
    failures++;
    console.error(`FAIL - ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

/** 起一个指向临时工作区的 server 会话(同既有套件的 stdio JSON-RPC 模式)。 */
async function startServer(workspaceRoot) {
  const child = spawn(process.execPath, [DIST_SERVER], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, ZCODE_WORKSPACE_ROOT: workspaceRoot },
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
      setTimeout(() => reject(new Error(`timeout waiting ${method}`)), 20000);
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

/** 临时真仓(mkdtemp + git init -b main + 身份);返回 {dir, git, cleanup}。 */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "t01-vc-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-b", "main");
  git("config", "user.email", "t01@example.com");
  git("config", "user.name", "T01 Tester");
  // 测试仓不需要仓库级属性;关掉 autocrlf 提示,免得平台默认值影响路径比较。
  git("config", "core.autocrlf", "false");
  return { dir, git, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** deck_git 的结构化回包。 */
const scOf = (reply) => reply?.result?.structuredContent || {};

async function sliceContract() {
  if (!existsSync(DIST_SERVER)) {
    check("contract: dist/server.mjs 可跑", false);
    return;
  }
  const repo = makeRepo();
  const s = await startServer(repo.dir);
  try {
    const tools = await s.rpc("tools/list", {});
    const list = tools.result?.tools || [];
    const tool = list.find((t) => t.name === "deck_git");
    check("contract: tools/list 声明 deck_git", !!tool, JSON.stringify(list.map((t) => t.name)));
    check(
      "contract: deck_git 入参 schema(method 必填,args 对象)",
      tool?.inputSchema?.type === "object" &&
        tool.inputSchema.required?.includes("method") &&
        tool.inputSchema.properties?.method?.type === "string" &&
        tool.inputSchema.properties?.args?.type === "object",
      JSON.stringify(tool?.inputSchema)
    );
    check("contract: 描述写清版本管理数据面与路径边界", /版本管理/.test(tool?.description || "") && /工作区根内/.test(tool?.description || ""));

    const unknown = await s.call("deck_git", { method: "gitNoSuchPhone" });
    const usc = scOf(unknown);
    check("contract: 未知方法回 unknown-method(非工具级错误)", !unknown.result?.isError && usc.ok === false && usc.error?.kind === "unknown-method", JSON.stringify(usc));
    check("contract: 未知方法的人话带方法名", /未知 git 方法/.test(usc.error?.message || "") && /gitNoSuchPhone/.test(usc.error?.message || ""), usc.error?.message);

    const missing = await s.call("deck_git", {});
    const msc = scOf(missing);
    check("contract: 缺 method 不崩,回 unknown-method", !missing.result?.isError && msc.ok === false && msc.error?.kind === "unknown-method", JSON.stringify(msc));

    const outside = mkdtempSync(join(tmpdir(), "t01-outside-"));
    try {
      const bad = await s.call("deck_git", { method: "gitStatus", args: { cwd: outside } });
      const bsc = scOf(bad);
      check("contract: cwd 越界回 boundary(非工具级错误)", !bad.result?.isError && bsc.ok === false && bsc.error?.kind === "boundary", JSON.stringify(bsc));
      check("contract: boundary 人话写明只能在工作区根内", /只能在工作区根内/.test(bsc.error?.message || ""), bsc.error?.message);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }

    const badArgs = await s.call("deck_git", { method: "gitStatus", args: "not-an-object" });
    const basc = scOf(badArgs);
    check(
      "contract: 字符串 args 回 bad-args(结构化人话,不静默当空对象)",
      !badArgs.result?.isError && basc.ok === false && basc.error?.kind === "bad-args" && basc.error?.message === "args 必须是对象。",
      JSON.stringify(basc)
    );
    const arrayArgs = await s.call("deck_git", { method: "gitStatus", args: [] });
    check("contract: 数组 args 回 bad-args", scOf(arrayArgs).ok === false && scOf(arrayArgs).error?.kind === "bad-args", JSON.stringify(scOf(arrayArgs)));
    const nullArgs = await s.call("deck_git", { method: "gitStatus", args: null });
    check("contract: null args 回 bad-args", scOf(nullArgs).ok === false && scOf(nullArgs).error?.kind === "bad-args", JSON.stringify(scOf(nullArgs)));

    const badCwd = await s.call("deck_git", { method: "gitStatus", args: { cwd: 42 } });
    check("contract: 非字符串 cwd 回人话错误,不崩", !badCwd.result?.isError && scOf(badCwd).ok === false && /cwd/.test(scOf(badCwd).error?.message || ""), JSON.stringify(scOf(badCwd)));
  } finally {
    await s.stop();
    repo.cleanup();
  }
}

async function sliceBoundaryAndSpawn() {
  if (!existsSync(DIST_GIT)) {
    check("boundary: dist/git.mjs 可 import", false);
    return;
  }
  const { createGitBridge } = await import(pathToFileURL(DIST_GIT).href);
  const root = mkdtempSync(join(tmpdir(), "t01-boundary-"));
  const outside = mkdtempSync(join(tmpdir(), "t01-boundary-outside-"));
  try {
    mkdirSync(join(root, "..foo"));
    // Node 在 Windows 上用 junction 不需要管理员权限;junction 指向根外,词法路径看起来仍在根内。
    const link = join(root, "link-out");
    symlinkSync(outside, link, "junction");
    const bridge = createGitBridge({ workspaceRoot: root, env: process.env });

    const junctionCwd = await bridge.call("gitStatus", { cwd: link });
    check(
      "boundary: cwd 经根内 junction 指到根外 → boundary",
      junctionCwd.ok === false && junctionCwd.error?.kind === "boundary",
      JSON.stringify(junctionCwd)
    );
    const junctionTarget = await bridge.call("gitCloneCheck", { dir: join(link, "target"), url: "https://example.invalid/x.git" });
    check(
      "boundary: 目标路径经 junction 指到根外(即使尚不存在) → boundary",
      junctionTarget.ok === false && junctionTarget.error?.kind === "boundary",
      JSON.stringify(junctionTarget)
    );
    const dotdotName = await bridge.call("gitCloneCheck", { dir: join(root, "..foo", "target"), url: "https://example.invalid/x.git" });
    check(
      "boundary: 合法目录名 ..foo 不误判越界",
      !(dotdotName.ok === false && dotdotName.error?.kind === "boundary"),
      JSON.stringify(dotdotName)
    );
    const insideMissing = await bridge.call("gitCloneCheck", { dir: join(root, "new-dir"), url: "https://example.invalid/x.git" });
    check(
      "boundary: 根内尚不存在的目标按最近已存在祖先判定,不误判",
      !(insideMissing.ok === false && insideMissing.error?.kind === "boundary"),
      JSON.stringify(insideMissing)
    );

    // 工作区根内不存在的 cwd:边界放行,但 spawn 起不来 git → 必须是 spawn 档,不是 parse。
    const spawnBad = await bridge.call("gitStatus", { cwd: join(root, "missing-cwd") });
    check(
      "spawn: cwd 不存在时回 error.kind=spawn(确认装了 git 那一档)",
      spawnBad.ok === false && spawnBad.error?.kind === "spawn",
      JSON.stringify(spawnBad)
    );
    check(
      "spawn: 人话写明起不了 git 进程",
      /起不了 git 进程/.test(spawnBad.error?.message || ""),
      spawnBad.error?.message
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
}

async function sliceRealRepo() {
  if (!existsSync(DIST_GIT)) {
    check("real: dist/git.mjs 可 import", false);
    return;
  }
  const repo = makeRepo();
  const s = await startServer(repo.dir);
  try {
    // 首屏:分支 + 仓库状态片可读(git 版本决定的 tier 也在)
    const first = await s.call("deck_git", { method: "gitFirstScreen", args: {} });
    const fsc = scOf(first);
    const ws = fsc.firstScreen?.slices?.workspace;
    check("real: gitFirstScreen ok", !first.result?.isError && fsc.ok === true, JSON.stringify(fsc.error || fsc));
    check(
      "real: 首屏工作区片为 ok,带分支与仓库状态",
      ws?.state === "ok" && ws.data?.identity?.branch === "main" && typeof ws.data?.repo?.tier === "string",
      JSON.stringify(ws)
    );
    check("real: 首屏历史片为空仓零提交", fsc.firstScreen?.slices?.history?.state === "ok" && fsc.firstScreen.slices.history.data.commits.length === 0,
      JSON.stringify(fsc.firstScreen?.slices?.history));

    // 未跟踪文件:首屏之后新写,gitStatus 必须看得到
    writeFileSync(join(repo.dir, "untracked.txt"), "hello\n", "utf8");
    const status = await s.call("deck_git", { method: "gitStatus", args: {} });
    const st = scOf(status);
    const entry = (st.screen?.unstaged || []).find((f) => f.path === "untracked.txt");
    check("real: gitStatus ok 且分支为 main", st.ok === true && st.screen?.identity?.branch === "main", JSON.stringify(st.error || st.screen?.identity));
    check("real: gitStatus 看到未跟踪文件", !!entry && entry.change === "untracked", JSON.stringify(st.screen?.unstaged));

    // 写路径(凭据安全出口垫片):暂存一个文件,状态里必须变成 staged
    const staged = scOf(await s.call("deck_git", { method: "gitStage", args: { paths: ["untracked.txt"] } }));
    check("real: gitStage 成功(写路径垫片可用)", staged.ok === true, JSON.stringify(staged.error || staged));
    const st2 = scOf(await s.call("deck_git", { method: "gitStatus", args: {} }));
    check("real: 暂存后 gitStatus 看到 staged", st2.ok === true && (st2.screen?.staged || []).some((f) => f.path === "untracked.txt"), JSON.stringify(st2.screen?.staged));

    // 空仓历史 → 一次提交后条数变化
    const log0 = scOf(await s.call("deck_git", { method: "gitLog", args: {} }));
    check("real: gitLog 空仓零条", log0.ok === true && log0.commits?.length === 0 && log0.hasMore === false, JSON.stringify(log0));

    repo.git("add", "untracked.txt");
    repo.git("commit", "-m", "first");
    const log1 = scOf(await s.call("deck_git", { method: "gitLog", args: {} }));
    check("real: gitLog 一次提交后一条且标题正确", log1.ok === true && log1.commits?.length === 1 && log1.commits[0]?.subject === "first", JSON.stringify(log1));

    // 已跟踪文件改动 → 补丁行里有新增内容
    writeFileSync(join(repo.dir, "untracked.txt"), "hello\nworld\n", "utf8");
    const diff = scOf(await s.call("deck_git", { method: "gitDiff", args: { path: "untracked.txt" } }));
    check("real: gitDiff 对已跟踪文件改动给 patch", diff.ok === true && diff.reason === "ok" && Array.isArray(diff.lines) && diff.lines.length > 0, JSON.stringify(diff));
    check("real: patch 里有 +world 行", (diff.lines || []).some((l) => String(l.text || "").includes("+world")), JSON.stringify(diff.lines?.slice(0, 6)));

    // 分支表
    const branches = scOf(await s.call("deck_git", { method: "gitBranches", args: {} }));
    check(
      "real: gitBranches 列出当前分支 main",
      branches.ok === true && branches.current?.name === "main" && (branches.branches || []).some((b) => b.name === "main"),
      JSON.stringify(branches.error || { current: branches.current, names: (branches.branches || []).map((b) => b.name) })
    );

    // 直连 bridge:方法表只含 handleGit* 派生名,tickets/runGitCommand 不外露;目标路径边界
    const { createGitBridge } = await import(pathToFileURL(DIST_GIT).href);
    const bridge = createGitBridge({ workspaceRoot: repo.dir, env: process.env });
    check("bridge: 方法表含 gitStatus/gitFirstScreen/gitLog/gitDiff/gitBranches", ["gitStatus", "gitFirstScreen", "gitLog", "gitDiff", "gitBranches"].every((m) => bridge.methods.includes(m)), JSON.stringify(bridge.methods));
    check("bridge: 不暴露 runGitCommand 与 tickets 表", !bridge.methods.includes("runGitCommand") && !bridge.methods.includes("writeTickets") && !bridge.methods.includes("branchTickets"), JSON.stringify(bridge.methods));
    check("bridge: 方法名唯一", bridge.methods.length === new Set(bridge.methods).size);

    const cloneOutside = join(tmpdir(), "t01-clone-outside-" + process.pid);
    const cb = await bridge.call("gitCloneCheck", { dir: cloneOutside });
    check("bridge: 克隆目标目录越界回 boundary", cb.ok === false && cb.error?.kind === "boundary", JSON.stringify(cb));
    const inside = join(repo.dir, "clone-target");
    const cb2 = await bridge.call("gitCloneCheck", { dir: inside, url: "https://example.invalid/x.git" });
    check("bridge: 工作区根内的克隆目标不进边界分支", !(cb2.ok === false && cb2.error?.kind === "boundary"), JSON.stringify(cb2.error || { ok: cb2.ok }));
  } finally {
    await s.stop();
    repo.cleanup();
  }
}

if (!existsSync(DIST_SERVER)) {
  console.error("FAIL - 先跑 node build.mjs(dist/server.mjs 不存在)");
  process.exit(1);
}
await sliceContract().catch((e) => {
  failures++;
  console.error("FAIL - contract 套件异常 :: " + (e && e.stack ? e.stack : e));
});
await sliceBoundaryAndSpawn().catch((e) => {
  failures++;
  console.error("FAIL - boundary/spawn 套件异常 :: " + (e && e.stack ? e.stack : e));
});
await sliceRealRepo().catch((e) => {
  failures++;
  console.error("FAIL - real 套件异常 :: " + (e && e.stack ? e.stack : e));
});

if (failures > 0) {
  console.error(`\n${failures} 条断言失败`);
  process.exit(1);
}
console.log("\nserver-git: 全部断言通过");
