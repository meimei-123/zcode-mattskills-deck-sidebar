// 票 03 缝测试:deck_git 跟随活动项目(读电话换根、cwd 与目标路径边界按活动根、
// 危险动作哨兵挡切换、无 .git 的无仓态、workspace 资源回活动根)。
// 形状照 server-git*.test.mjs:mkdtemp + git init 真仓,ZCODE_WORKSPACE_ROOT 指向
// home 临时根、清单指到另外两个临时目录(一个 git 仓、一个无 git 目录)。
// 断言只打工具回包;期望值来自票 03 验收条目与 git 自身行为,不拿实现回算实现。
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // zcode-plugin/
const DIST_SERVER = join(ROOT, "dist", "server.mjs");

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`ok - ${name}`);
  else {
    failures++;
    console.error(`FAIL - ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

const short = (v, n = 400) => {
  try {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s === undefined ? String(v) : s.slice(0, n);
  } catch {
    return String(v);
  }
};

/** 起一个指向指定工作区根的 server 会话(server-read 同形状)。 */
async function startServer(workspaceRoot, extraEnv = {}) {
  const child = spawn(process.execPath, [DIST_SERVER], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, ZCODE_WORKSPACE_ROOT: workspaceRoot, ...extraEnv },
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
  const readResource = (uri) => rpc("resources/read", { uri });
  const stop = async () => {
    child.stdin.end();
    await new Promise((r) => child.on("exit", r));
  };
  return { call, rpc, readResource, stop };
}

/** 真 git 仓(mkdtemp + git init -b main + 身份);git() 跑测试自己的核对面。 */
function makeRepo(dir, branch = "main") {
  mkdirSync(dir, { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-b", branch);
  git("config", "user.email", "t03p@example.com");
  git("config", "user.name", "T03P Tester");
  git("config", "core.autocrlf", "false");
  return git;
}

/** deck_git 的结构化回包。 */
const scOf = (reply) => reply?.result?.structuredContent || {};

function writeRegistry(homeRoot, projects) {
  mkdirSync(join(homeRoot, ".deck"), { recursive: true });
  writeFileSync(join(homeRoot, ".deck", "projects.json"), JSON.stringify({ version: 1, projects }, null, 2), "utf8");
}

// ---------------------------------------------------------------------------
// 切片 1+2:deck_git 读电话作用于活动项目仓库;cwd 与目标路径边界按活动根判定,
// 旧根(home-repo)路径被拒,越界错误形状(kind=boundary)不变。
// ---------------------------------------------------------------------------
async function sliceFollowActive() {
  const base = mkdtempSync(join(tmpdir(), "t03-git-follow-"));
  const homeRoot = join(base, "home");
  const projA = join(base, "proj-a");
  const gitHome = makeRepo(homeRoot);
  writeFileSync(join(homeRoot, "home.txt"), "home\n", "utf8");
  gitHome("add", "-A");
  gitHome("commit", "-m", "home 基线");
  gitHome("checkout", "-b", "home-side");

  const gitA = makeRepo(projA);
  writeFileSync(join(projA, "alpha.txt"), "alpha\n", "utf8");
  gitA("add", "-A");
  gitA("commit", "-m", "alpha 基线");
  gitA("checkout", "-b", "feature/alpha");
  // 留一处工作区改动:gitDiff 有真实补丁行可比(alpha.txt 第二行)
  writeFileSync(join(projA, "alpha.txt"), "alpha\nalpha-2\n", "utf8");

  writeRegistry(homeRoot, [{ name: "alpha", path: projA }]);

  const s = await startServer(homeRoot);
  try {
    // 未切换:deck_git 读 home-repo(home-side 分支)
    const before = scOf(await s.call("deck_git", { method: "gitStatus", args: {} }));
    check(
      "跟随: 未切换时 gitStatus 读 home-repo(home-side)",
      before.ok === true && before.screen?.identity?.branch === "home-side",
      short(before.error || before.screen?.identity)
    );

    const use = await s.call("deck_project_use", { name: "alpha" });
    check("跟随: 切到 alpha 成功", !use.result?.isError && use.result?.structuredContent?.active?.name === "alpha", short(use.result || use.error));

    // 切换后:同一批读电话读 alpha 仓(feature/alpha 分支、alpha 提交)
    const status = scOf(await s.call("deck_git", { method: "gitStatus", args: {} }));
    check(
      "跟随: 切换后 gitStatus 读活动项目(feature/alpha)",
      status.ok === true && status.screen?.identity?.branch === "feature/alpha",
      short(status.error || status.screen?.identity)
    );
    const log = scOf(await s.call("deck_git", { method: "gitLog", args: {} }));
    check(
      "跟随: gitLog 读活动项目的提交(alpha 基线)",
      log.ok === true && (log.commits || []).some((c) => c.subject === "alpha 基线") &&
        !(log.commits || []).some((c) => c.subject === "home 基线"),
      short(log.error || log.commits)
    );
    const diff = scOf(await s.call("deck_git", { method: "gitDiff", args: { path: "alpha.txt" } }));
    check(
      "跟随: gitDiff 按活动仓解析仓内路径(alpha.txt 可见)",
      diff.ok === true && Array.isArray(diff.lines) && diff.lines.length > 0,
      short(diff.error || diff.lines?.slice(0, 2))
    );
    const missing = scOf(await s.call("deck_git", { method: "gitDiff", args: { path: "home.txt" } }));
    check(
      "跟随: 活动仓里没有 home.txt(不是旧仓的文件)",
      !(missing.ok === true && Array.isArray(missing.lines) && missing.lines.some((l) => /home/.test(String(l.text)))),
      short(missing.lines?.slice(0, 2))
    );

    // 边界按活动根:旧根(home-repo)cwd 被拒,形状 kind=boundary 不变
    const oldCwd = scOf(await s.call("deck_git", { method: "gitStatus", args: { cwd: homeRoot } }));
    check(
      "边界: 旧根路径作 cwd 被拒(kind=boundary)",
      oldCwd.ok === false && oldCwd.error?.kind === "boundary" && typeof oldCwd.error?.message === "string",
      short(oldCwd.error)
    );
    const outsideCwd = scOf(await s.call("deck_git", { method: "gitStatus", args: { cwd: base } }));
    check(
      "边界: 活动根之外(base)同样被拒",
      outsideCwd.ok === false && outsideCwd.error?.kind === "boundary",
      short(outsideCwd.error)
    );
    // 目标路径字段同口径:clone 目标指旧根 → boundary(边界检查先于任何 git 执行)
    const oldTarget = scOf(
      await s.call("deck_git", { method: "gitCloneCheck", args: { dir: join(homeRoot, "target"), url: "https://example.invalid/x.git" } })
    );
    check(
      "边界: 目标路径指旧根被拒(gitCloneCheck.dir)",
      oldTarget.ok === false && oldTarget.error?.kind === "boundary",
      short(oldTarget.error)
    );
    // 切回 home-repo:读电话回到本仓,cwd 边界跟着回到 home 根
    const back = await s.call("deck_project_use", { name: "home" });
    check("跟随: 切回 home-repo 成功", !back.result?.isError, short(back.result || back.error));
    const backStatus = scOf(await s.call("deck_git", { method: "gitStatus", args: {} }));
    check(
      "跟随: 切回后 gitStatus 读 home-repo",
      backStatus.ok === true && backStatus.screen?.identity?.branch === "home-side",
      short(backStatus.error || backStatus.screen?.identity)
    );
    const backCwd = scOf(await s.call("deck_git", { method: "gitStatus", args: { cwd: projA } }));
    check(
      "边界: 切回后旧活动根(projA)作 cwd 被拒",
      backCwd.ok === false && backCwd.error?.kind === "boundary",
      short(backCwd.error)
    );
  } finally {
    await s.stop();
    rmSync(base, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 切片 4:活动项目没有 .git —— 版本页数据面回现有无仓态(gitFirstScreen ok + 各片
// err/not-repo;gitStatus 结构化 not-repo),不是工具级错误。
// ---------------------------------------------------------------------------
async function sliceNoRepo() {
  const base = mkdtempSync(join(tmpdir(), "t03-git-norepo-"));
  const homeRoot = join(base, "home");
  const plain = join(base, "plain");
  const gitHome = makeRepo(homeRoot); // home 是真仓:无仓与否只取决于活动项目,不取决于工作区
  mkdirSync(join(plain, ".scratch"), { recursive: true }); // 项目根没有 .git 是正常状态
  writeRegistry(homeRoot, [{ name: "plain", path: plain }]);
  const s = await startServer(homeRoot);
  try {
    const homeStatus = scOf(await s.call("deck_git", { method: "gitStatus", args: {} }));
    check("无仓: 未切换时 gitStatus 读到 home 仓", homeStatus.ok === true, short(homeStatus));
    const use = await s.call("deck_project_use", { name: "plain" });
    check("无仓: 能切到没有 .git 的项目", !use.result?.isError, short(use.result || use.error));
    const reply = await s.call("deck_git", { method: "gitStatus", args: {} });
    const status = scOf(reply);
    check(
      "无仓: gitStatus 回结构化 not-repo(不是 isError)",
      !reply.result?.isError && status.ok === false && status.error?.kind === "not-repo",
      short(status)
    );
    const first = scOf(await s.call("deck_git", { method: "gitFirstScreen", args: {} }));
    const ws = first.firstScreen?.slices?.workspace;
    check(
      "无仓: gitFirstScreen ok,工作区片 err/not-repo(现有无仓态)",
      first.ok === true && ws?.state === "err" && ws?.error?.kind === "not-repo",
      short(first.firstScreen?.slices?.workspace)
    );
  } finally {
    await s.stop();
    rmSync(base, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 切片 5:workspace 资源(ui://…/workspace.json)的 root 跟随活动项目
// (版本页 cwd 的取数来源);env.ZCODE_WORKSPACE_ROOT 恒为宿主注入的 home 根。
// ---------------------------------------------------------------------------
const WORKSPACE_URI = "ui://zcode-mattpocock-skills-deck/workspace.json";
async function sliceWorkspaceResource() {
  const base = mkdtempSync(join(tmpdir(), "t03-git-res-"));
  const homeRoot = join(base, "home");
  const projA = join(base, "proj-a");
  mkdirSync(homeRoot, { recursive: true });
  mkdirSync(projA, { recursive: true });
  writeRegistry(homeRoot, [{ name: "alpha", path: projA }]);
  const s = await startServer(homeRoot);
  try {
    const before = JSON.parse((await s.readResource(WORKSPACE_URI)).result?.contents?.[0]?.text || "{}");
    check(
      "资源: 默认 root 是 home-repo",
      before.root === homeRoot || before.root?.replace(/\//g, "\\") === homeRoot,
      short(before)
    );
    check(
      "资源: env.ZCODE_WORKSPACE_ROOT 仍是宿主注入值",
      before.env?.ZCODE_WORKSPACE_ROOT === homeRoot,
      short(before.env)
    );
    await s.call("deck_project_use", { name: "alpha" });
    const after = JSON.parse((await s.readResource(WORKSPACE_URI)).result?.contents?.[0]?.text || "{}");
    check(
      "资源: 切换后 root 是活动项目根",
      after.root === projA || after.root?.replace(/\//g, "\\") === projA,
      short(after)
    );
  } finally {
    await s.stop();
    rmSync(base, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 切片 3:版本页有未确认的危险 git 动作(预检签票已发、还没凭票执行)时,deck_project_use
// 拒绝并说明;凭票执行(确认)之后可切。取消在面板侧只是关掉确认卡、服务端无电话可发,
// 哨兵随票据自身过期失效(上游票期 120 秒)——这是与上游口径一致的自然回落,见 server 注释。
// ---------------------------------------------------------------------------
async function sliceDangerGate() {
  const base = mkdtempSync(join(tmpdir(), "t03-git-danger-"));
  const homeRoot = join(base, "home");
  const projA = join(base, "proj-a");
  const gitHome = makeRepo(homeRoot);
  gitHome("commit", "--allow-empty", "-m", "home 基线");
  const gitA = makeRepo(projA);
  writeFileSync(join(projA, "alpha.txt"), "alpha\n", "utf8");
  gitA("add", "-A");
  gitA("commit", "-m", "alpha 基线");
  writeFileSync(join(projA, "new.txt"), "pending\n", "utf8"); // 未跟踪改动,预检有东西可查
  writeRegistry(homeRoot, [{ name: "alpha", path: projA }]);
  const s = await startServer(homeRoot);
  try {
    await s.call("deck_project_use", { name: "alpha" });

    // 真实 pending 态:改动域预检签票(真仓、真票,不经注入)
    const chk = scOf(await s.call("deck_git", { method: "gitChangesCheck", args: { op: "stage-file", path: "new.txt" } }));
    check(
      "危险: gitChangesCheck 预检 ok 且带票",
      chk.ok === true && typeof chk.ticket?.id === "string" && typeof chk.ticket?.expiresAtMs === "number",
      short(chk.error || chk.ticket)
    );

    // 有未确认危险动作:切换被拒且说明原因
    const refused = await s.call("deck_project_use", { name: "home" });
    const refusedText = refused.result?.content?.[0]?.text || "";
    check(
      "危险: 切换被拒(isError)且点名未确认动作/确认或过期",
      refused.result?.isError === true && /确认/.test(refusedText) && /危险|git/.test(refusedText),
      short(refused.result || refused.error)
    );
    // 拒绝不是空口:活动项目没变
    const still = (await s.call("deck_project_list", {})).result?.structuredContent || {};
    check("危险: 被拒后活动项目没变(仍在 alpha)", still.active?.name === "alpha", short(still.active));

    // 切到当前活动项目本身是幂等 noop,不受哨兵影响(根没动,危险动作不换仓)
    const noop = await s.call("deck_project_use", { name: "alpha" });
    check("危险: 切到当前项目本身(幂等 noop)不挡", !noop.result?.isError, short(noop.result || noop.error));

    // 确认(凭票执行)之后可切
    const done = scOf(
      await s.call("deck_git", {
        method: "gitChangesWrite",
        args: { op: "stage-file", path: "new.txt", ticketId: chk.ticket?.id, requestId: "t03-danger-1", confirm: true },
      })
    );
    check("危险: 凭票执行(暂存)成功", done.ok === true, short(done.error || done));
    const allowed = await s.call("deck_project_use", { name: "home" });
    check("危险: 确认后可切回 home-repo", !allowed.result?.isError && allowed.result?.structuredContent?.active?.isHome === true, short(allowed.result || allowed.error));
    // 真仓核对:暂存落在了 alpha 仓,home 仓没有这个文件(.deck/ 是清单,本就不在暂存里)
    check(
      "危险: 暂存落在活动仓(alpha),不是 home",
      gitA("status", "--porcelain").includes("A  new.txt") && !gitHome("status", "--porcelain").includes("new.txt"),
      short(gitHome("status", "--porcelain"))
    );
  } finally {
    await s.stop();
    rmSync(base, { recursive: true, force: true });
  }
}

const slices = [sliceFollowActive, sliceNoRepo, sliceWorkspaceResource, sliceDangerGate];
for (const one of slices) {
  try {
    await one();
  } catch (e) {
    failures++;
    console.error(`FAIL - 切片抛错 ${one.name} :: ${e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : e}`);
  }
}
console.log(failures === 0 ? "all pass" : `${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
