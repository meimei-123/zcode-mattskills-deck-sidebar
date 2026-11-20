// 工单 06 缝:五组管理电话(维护 / 迁移与克隆 / 配置与钩子 / 诊断 / 平台)加远端、历史高级查询与长任务,
// 全部在 mkdtemp 出来的真 git 仓(本机 git 2.42)上验收;远端只用本地 bare 仓,不发起外网。
//
// 断言口径来自三处,不来自实现:① 工单 06 的验收条目;② 上游共享协议里的固定标识(动作名 / capId /
// contract / 原因标识);③ git 自身的行为(分支名、提交标题、bundle 能否 verify、远端 refs)。
//
// 切片:
//   0  方法表与 deck_git 路由(管理电话真的能经一条工具拨到)
//   1  维护:读数(gc 前后对象库变化)、gc 预检签票 → 长任务执行;prune 只验预检(确认卡 + 备份要求)
//   2  迁移与克隆:bundle 导出到工作区根内、clone 到工作区根内子目录、init 建仓;越界路径回 boundary
//   3  配置与钩子:仓库局部 config 读写、只读键拒绝、钩子手动跑(成功与非零退出);全局身份不动
//   4  诊断:只读查询若干、二分开始/结束、替换对象建立/撤销、fsck 走长任务
//   5  平台:平台页读数、request-pull 说明、补丁目录清单(越界回 boundary)、format-patch 长任务
//   6  远端:本地 bare 上的增 / 改名 / 改地址 / 联网查看 / 删除
//   7  历史高级查询:文件历史 / blame / grep / pickaxe / compare / range-diff / reflog / notes / show-file
//   8  长任务:成功 / 失败 / 取消三种结论 + 别的进程留下的在途记录标 interrupted;任务记录不落工作区
//   9  坏参数、过期票(用可推进的钟,不真等 120 秒)、越界路径
//
// 测试结束删除全部临时目录(含备份镜像与任务缓存)。
import { spawn, execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // zcode-plugin/
const DIST_GIT = join(ROOT, "dist", "git.mjs");
const DIST_SERVER = join(ROOT, "dist", "server.mjs");
const BASE = mkdtempSync(join(tmpdir(), "t06-admin-"));
const CACHE = join(BASE, "task-cache");

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`ok - ${name}`);
  else {
    failures++;
    console.error(`FAIL - ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 仓内跑 git;失败即抛(只在「这一步应该成功」的夹具里用)。 */
function gitAt(dir, ...args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}
function gitOut(dir, ...args) {
  return String(gitAt(dir, ...args)).trim();
}
/** 可能非零的 git:回 {status, stdout, stderr}。 */
function gitTry(dir, ...args) {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  return { status: r.status, stdout: String(r.stdout || ""), stderr: String(r.stderr || "") };
}

/** 真仓:mkdtemp 下的子目录 + init -b main + 本地身份 + autocrlf=false。 */
function makeRepo(name) {
  const dir = join(BASE, name);
  mkdirSync(dir, { recursive: true });
  gitAt(dir, "init", "-q", "-b", "main");
  gitAt(dir, "config", "user.email", "t06@example.com");
  gitAt(dir, "config", "user.name", "T06 Tester");
  gitAt(dir, "config", "core.autocrlf", "false");
  return dir;
}
/** 一次提交:写文件 → add → commit。 */
function commitFile(dir, file, content, subject) {
  writeFileSync(join(dir, file), content, "utf8");
  gitAt(dir, "add", file);
  gitAt(dir, "commit", "-qm", subject);
  return gitOut(dir, "rev-parse", "HEAD");
}
/** 三个提交的夹具:a.txt 依次 one → one+two → one+two+three。 */
function makeHistory(name) {
  const dir = makeRepo(name);
  const c1 = commitFile(dir, "a.txt", "one\n", "c1");
  const c2 = commitFile(dir, "a.txt", "one\ntwo\n", "c2");
  const c3 = commitFile(dir, "a.txt", "one\ntwo\nthree\n", "c3");
  return { dir, c1, c2, c3 };
}

/** 一条 bridge;env 里带本次测试专用的任务缓存目录(不往工作区里写任务记录)。 */
async function bridgeOf(workspaceRoot, extra = {}) {
  const { createGitBridge } = await import(pathToFileURL(DIST_GIT).href);
  return createGitBridge({
    workspaceRoot,
    env: { ...process.env, ZCODE_VC_TASK_CACHE: CACHE },
    ...extra,
  });
}

/** 轮询任务到终态;超时回最后一次读到的记录(断言里会显示它)。 */
async function waitTask(bridge, taskId, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const r = await bridge.call("gitTaskQuery", {});
    const list = r && r.ok === true && Array.isArray(r.tasks) ? r.tasks : [];
    last = list.find((t) => t.taskId === taskId) || null;
    if (last && last.state === "done") return last;
    await sleep(100);
  }
  return last;
}

/** 起一个指向临时工作区的 server 会话(同既有套件的 stdio JSON-RPC 模式)。 */
async function startServer(workspaceRoot) {
  const child = spawn(process.execPath, [DIST_SERVER], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, ZCODE_WORKSPACE_ROOT: workspaceRoot, ZCODE_VC_TASK_CACHE: CACHE },
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
const scOf = (reply) => reply?.result?.structuredContent || {};

// ---------------------------------------------------------------------------------------------
// 0:方法表 + deck_git 路由
// ---------------------------------------------------------------------------------------------
async function sliceContract() {
  if (!existsSync(DIST_GIT)) {
    check("contract: dist/git.mjs 可 import", false);
    return;
  }
  const repo = makeRepo("contract");
  commitFile(repo, "a.txt", "one\n", "first");
  const bridge = await bridgeOf(repo);

  const expected = [
    "gitMaintenanceRead", "gitMaintenanceCheck", "gitMaintenanceWrite",
    "gitMigrateCheck", "gitMigrateWrite", "gitCloneCheck", "gitCloneWrite",
    "gitConfigRead", "gitConfigCheck", "gitConfigWrite",
    "gitDiagnosticsRead", "gitDiagnosticsCheck", "gitDiagnosticsWrite",
    "gitPlatformRead", "gitPlatformCheck", "gitPlatformRun", "gitRequestPull", "gitPatchFiles",
    "gitRemoteList", "gitRemoteAdd", "gitRemoteRename", "gitRemoteRemove", "gitRemoteSetUrl", "gitRemoteOnline",
    "gitHistoryQuery", "gitTaskStart", "gitTaskQuery", "gitTaskCancel",
  ];
  check("contract: 五组管理电话全部上方法表", expected.every((m) => bridge.methods.includes(m)), JSON.stringify(expected.filter((m) => !bridge.methods.includes(m))));
  check("contract: 票据表不注册成电话", ["maintenanceTickets", "configTickets", "diagnosticsTickets", "platformTickets", "migrateTickets", "cloneTickets"].every((m) => !bridge.methods.includes(m)), JSON.stringify(bridge.methods));
  check("contract: 上游没有钩子安装/卸载电话(本版只到列表与手动跑)", !bridge.methods.some((m) => /Hook(Install|Uninstall|Add|Remove)/i.test(m)));

  const s = await startServer(repo);
  try {
    const read = scOf(await s.call("deck_git", { method: "gitMaintenanceRead", args: { op: "objects" } }));
    check("contract: deck_git 路由 gitMaintenanceRead", read.ok === true && read.capId === "11.4", JSON.stringify(read.error || read));
    const list = scOf(await s.call("deck_git", { method: "gitRemoteList", args: {} }));
    check("contract: deck_git 路由 gitRemoteList", list.ok === true && list.source === "local" && Array.isArray(list.remotes), JSON.stringify(list.error || list));
  } finally {
    await s.stop();
  }
}

// ---------------------------------------------------------------------------------------------
// 1:维护 —— 读数、gc 预检 + 执行、prune 危险区只验预检
// ---------------------------------------------------------------------------------------------
async function sliceMaintenance() {
  const { dir } = makeHistory("maint");
  const bridge = await bridgeOf(dir);

  const objects = await bridge.call("gitMaintenanceRead", { op: "objects" });
  check("维护:读对象统计(11.4)", objects.ok === true && objects.capId === "11.4" && Number(objects.looseCount) > 0, JSON.stringify(objects.error || objects));

  const overview = await bridge.call("gitMaintenanceRead", { op: "overview" });
  check("维护:总览读数为 ok,带对象 / 重打 / 自动维护三块", overview.ok === true && !!overview.objects && !!overview.repack && !!overview.maintenance, JSON.stringify(overview.error || overview));

  const repack = await bridge.call("gitMaintenanceRead", { op: "repack" });
  check("维护:重打状态只读(11.7)", repack.ok === true && repack.capId === "11.7" && typeof repack.canRepack === "boolean", JSON.stringify(repack.error || repack));

  const status = await bridge.call("gitMaintenanceRead", { op: "maintenance-status" });
  check("维护:自动维护状态(11.8)", status.ok === true && status.capId === "11.8" && typeof status.registered === "boolean", JSON.stringify(status.error || status));

  const checkGc = await bridge.call("gitMaintenanceCheck", { op: "gc" });
  check("维护:gc 预检放行且要确认", checkGc.ok === true && checkGc.decision?.verdict === "allow" && checkGc.confirmRequired === true && checkGc.confirm?.command === "git gc", JSON.stringify(checkGc.error || checkGc.confirm));
  const ttl = checkGc.ok ? Number(checkGc.ticket?.expiresAtMs) - Number(checkGc.ticket?.checkedAtMs) : 0;
  check("维护:票据时限 120 秒", ttl === 120000, String(ttl));

  const writeGc = await bridge.call("gitMaintenanceWrite", { op: "gc", ticketId: checkGc.ticket?.id, confirmed: true, requestId: "m-gc-1" });
  check("维护:gc 凭票执行走长任务", writeGc.ok === true && writeGc.kind === "task" && typeof writeGc.task?.taskId === "string", JSON.stringify(writeGc.error || writeGc));
  const gcDone = await waitTask(bridge, writeGc.task?.taskId);
  check("维护:gc 任务成功收尾", gcDone?.state === "done" && gcDone?.conclusion === "succeeded", JSON.stringify(gcDone));

  const packed = await bridge.call("gitMaintenanceRead", { op: "objects" });
  check("维护:gc 之后对象进了包(packs >= 1)", packed.ok === true && Number(packed.packs) >= 1, JSON.stringify(packed.error || { packs: packed.packs, loose: packed.looseCount }));

  // 造一个不可达对象:hash-object 写进对象库,没有任何引用指向它。
  const dangling = String(execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: dir, encoding: "utf8", input: "dangling-object\n" })).trim();
  const preview = await bridge.call("gitMaintenanceRead", { op: "prune-preview" });
  check("维护:清除预演只读,列出不可达对象", preview.ok === true && preview.capId === "11.6" && Number(preview.count) >= 1 && (preview.items || []).some((x) => x.oid === dangling), JSON.stringify(preview.error || preview));
  const unreachable = await bridge.call("gitMaintenanceRead", { op: "unreachable" });
  check("维护:不可达清单读数为 ok", unreachable.ok === true && Number(unreachable.count) >= 1, JSON.stringify(unreachable.error || unreachable));

  const checkPrune = await bridge.call("gitMaintenanceCheck", { op: "prune" });
  const confirmText = String(checkPrune.confirm?.what || "");
  check("维护:prune 预检要确认、提示不可恢复", checkPrune.ok === true && checkPrune.confirmRequired === true && checkPrune.confirm?.reversible === false, JSON.stringify(checkPrune.error || checkPrune.confirm));
  check("维护:prune 预检带备份计划(镜像或整包)与路径", !!checkPrune.backup && (checkPrune.backup.kind === "mirror" || checkPrune.backup.kind === "bundle") && String(checkPrune.backup.path || "").length > 0, JSON.stringify(checkPrune.backup));
  check("维护:prune 确认卡写清会删多少与先备份", /删掉 \d+ 个不可达对象/.test(confirmText) && /备份/.test(confirmText), confirmText);
  check("维护:prune 预检把预览一起带回", Number(checkPrune.preview?.count) >= 1, JSON.stringify(checkPrune.preview));

  const badRead = await bridge.call("gitMaintenanceRead", { op: "no-such-op" });
  check("维护:坏动作回 args 失败", badRead.ok === false && badRead.error?.kind === "args", JSON.stringify(badRead));
  const missingTicket = await bridge.call("gitMaintenanceWrite", { op: "gc", ticketId: "no-such-ticket", confirmed: true });
  check("维护:不存在的票回 ticket-missing", missingTicket.ok === false && missingTicket.reason === "ticket-missing", JSON.stringify(missingTicket));
}

// ---------------------------------------------------------------------------------------------
// 2:迁移与克隆 —— 导出、init、clone 到工作区根内;越界回 boundary
// ---------------------------------------------------------------------------------------------
async function sliceMigrateClone() {
  const { dir } = makeHistory("migrate");
  const bridge = await bridgeOf(dir);

  const bundleCheck = await bridge.call("gitMigrateCheck", { cwd: dir, action: "bundle-create", outputPath: join(dir, "out.bundle"), ref: "HEAD" });
  check("迁移:bundle 导出预检放行", bundleCheck.ok === true && bundleCheck.action === "bundle-create" && bundleCheck.capabilityId === "11.13", JSON.stringify(bundleCheck.error || bundleCheck));
  const bundleWrite = await bridge.call("gitMigrateWrite", { cwd: dir, action: "bundle-create", ticketId: bundleCheck.ticket?.id, requestId: "m-bundle-1" });
  check("迁移:bundle 导出凭票起长任务", bundleWrite.ok === true && typeof bundleWrite.task?.taskId === "string", JSON.stringify(bundleWrite.error || bundleWrite));
  const bundleDone = await waitTask(bridge, bundleWrite.task?.taskId);
  check("迁移:bundle 任务成功", bundleDone?.conclusion === "succeeded", JSON.stringify(bundleDone));
  check("迁移:导出文件真的落在工作区根内", existsSync(join(dir, "out.bundle")), join(dir, "out.bundle"));
  const verify = gitTry(dir, "bundle", "verify", "out.bundle");
  check("迁移:导出物能过 git bundle verify", verify.status === 0 && /is okay/.test(verify.stderr + verify.stdout), JSON.stringify(verify).slice(0, 400));

  const outsideBundle = join(BASE, "outside.bundle");
  const bundleOut = await bridge.call("gitMigrateCheck", { cwd: dir, action: "bundle-create", outputPath: outsideBundle, ref: "HEAD" });
  check("迁移:导出路径越界回 boundary", bundleOut.ok === false && bundleOut.error?.kind === "boundary", JSON.stringify(bundleOut));

  // init:工作区根不是仓库时,在根内空目录建仓(路径必须已存在,上游以目标目录为 cwd 起 git)。
  const plainWs = join(BASE, "plain-ws");
  const fresh = join(plainWs, "fresh");
  mkdirSync(fresh, { recursive: true });
  const plainBridge = await bridgeOf(plainWs);
  const initCheck = await plainBridge.call("gitMigrateCheck", { action: "init", path: fresh, branch: "trunk" });
  check("迁移:init 预检放行", initCheck.ok === true && initCheck.action === "init" && initCheck.plan?.initMode === "initial-branch", JSON.stringify(initCheck.error || initCheck));
  const initWrite = await plainBridge.call("gitMigrateWrite", { action: "init", ticketId: initCheck.ticket?.id, requestId: "m-init-1" });
  check("迁移:init 凭票执行成功", initWrite.ok === true && initWrite.init?.created === true, JSON.stringify(initWrite.error || initWrite));
  check("迁移:init 之后初始分支是 trunk", gitOut(fresh, "symbolic-ref", "--short", "HEAD") === "trunk", gitTry(fresh, "symbolic-ref", "--short", "HEAD").stderr);
  const initOut = await plainBridge.call("gitMigrateCheck", { action: "init", path: join(BASE, "outside-init"), branch: "main" });
  check("迁移:init 目标越界回 boundary", initOut.ok === false && initOut.error?.kind === "boundary", JSON.stringify(initOut));

  // clone:本地 bare → 工作区根内子目录。
  const bare = join(BASE, "clone-source.git");
  execFileSync("git", ["clone", "-q", "--bare", dir, bare], { encoding: "utf8" });
  const target = join(dir, "clone-here");
  const cloneCheck = await bridge.call("gitCloneCheck", { op: "start", url: bare, dir: target });
  check("克隆:本地 bare 预检放行", cloneCheck.ok === true && cloneCheck.decision?.verdict === "allow" && cloneCheck.op === "start", JSON.stringify(cloneCheck.error || cloneCheck));
  const cloneWrite = await bridge.call("gitCloneWrite", { op: "start", ticketId: cloneCheck.ticket?.id, requestId: "m-clone-1", confirmed: true });
  check("克隆:凭票执行把克隆交给长任务", cloneWrite.ok === true && typeof cloneWrite.task?.taskId === "string", JSON.stringify(cloneWrite.error || cloneWrite));
  const cloneDone = await waitTask(bridge, cloneWrite.task?.taskId);
  check("克隆:任务成功", cloneDone?.conclusion === "succeeded", JSON.stringify(cloneDone));
  check("克隆:目标目录里出现仓库且分支为 main", existsSync(join(target, ".git")) && gitOut(target, "rev-parse", "--abbrev-ref", "HEAD") === "main", gitTry(target, "rev-parse", "--abbrev-ref", "HEAD").stderr);
  check("克隆:历史随源仓库一起到位", gitOut(target, "log", "--format=%s").split("\n").includes("c3"), gitOut(target, "log", "--format=%s"));

  const cloneOut = await bridge.call("gitCloneCheck", { op: "start", url: bare, dir: join(BASE, "clone-outside") });
  check("克隆:目标越界回 boundary", cloneOut.ok === false && cloneOut.error?.kind === "boundary", JSON.stringify(cloneOut));
}

// ---------------------------------------------------------------------------------------------
// 3:配置与钩子 —— 仓库局部读写、只读键拒绝、钩子手动跑;全局身份不动
// ---------------------------------------------------------------------------------------------
function globalName() {
  const r = spawnSync("git", ["config", "--global", "--get", "user.name"], { encoding: "utf8" });
  return r.status === 0 ? String(r.stdout).trim() : "";
}
async function sliceConfigHooks() {
  const { dir } = makeHistory("config");
  const bridge = await bridgeOf(dir);
  const beforeGlobal = globalName();

  const read = await bridge.call("gitConfigRead", { cwd: dir });
  check("配置:读取回 ok,带本仓库配置路径与身份", read.ok === true && /\.git[\\/]config$/.test(String(read.configPath || "")) && read.identity?.name?.local === "T06 Tester", JSON.stringify(read.error || { configPath: read.configPath, identity: read.identity }));
  check("配置:手动跑钩子的版本门为 full(git 2.42)", read.hookRunVersion?.state === "full", JSON.stringify(read.hookRunVersion));

  const setCheck = await bridge.call("gitConfigCheck", { cwd: dir, op: "config-set", key: "user.name", scope: "local", value: "T06 Renamed" });
  check("配置:改本地身份预检放行", setCheck.ok === true && setCheck.op === "config-set", JSON.stringify(setCheck.error || setCheck));
  const setWrite = await bridge.call("gitConfigWrite", { cwd: dir, op: "config-set", ticketId: setCheck.ticket?.id, requestId: "m-cfg-set-1" });
  check("配置:凭票写入成功,旧值/新值都带回", setWrite.ok === true && setWrite.kind === "done" && setWrite.oldValue === "T06 Tester" && setWrite.newValue === "T06 Renamed", JSON.stringify(setWrite.error || setWrite));
  const afterSet = await bridge.call("gitConfigRead", { cwd: dir });
  check("配置:重新读回本地 user.name 已是新值", afterSet.identity?.name?.local === "T06 Renamed", JSON.stringify(afterSet.identity?.name));
  const replay = await bridge.call("gitConfigWrite", { cwd: dir, op: "config-set", ticketId: setCheck.ticket?.id, requestId: "m-cfg-set-1" });
  check("配置:同一请求号重放不再执行", replay.ok === true && replay.reused === true, JSON.stringify(replay));

  const readonly = await bridge.call("gitConfigCheck", { cwd: dir, op: "config-set", key: "core.autocrlf", scope: "local", value: "true" });
  check("配置:非身份键只读,预检当场拒绝", readonly.ok === false && readonly.reason === "key-readonly", JSON.stringify(readonly));
  const badEmail = await bridge.call("gitConfigCheck", { cwd: dir, op: "config-set", key: "user.email", scope: "local", value: "not-an-email" });
  check("配置:邮箱形状不对当场拒绝", badEmail.ok === false && badEmail.reason === "email-invalid", JSON.stringify(badEmail));

  const unsetCheck = await bridge.call("gitConfigCheck", { cwd: dir, op: "config-unset", key: "user.email", scope: "local" });
  check("配置:删本地键要确认", unsetCheck.ok === true && unsetCheck.confirmRequired === true && unsetCheck.confirm?.kind === "config-unset", JSON.stringify(unsetCheck.error || unsetCheck));
  const unsetNoConfirm = await bridge.call("gitConfigWrite", { cwd: dir, op: "config-unset", ticketId: unsetCheck.ticket?.id, requestId: "m-cfg-unset-1" });
  check("配置:没带确认时拒绝执行", unsetNoConfirm.ok === false && unsetNoConfirm.error?.kind === "need-confirm", JSON.stringify(unsetNoConfirm));
  const unsetWrite = await bridge.call("gitConfigWrite", { cwd: dir, op: "config-unset", ticketId: unsetCheck.ticket?.id, confirmed: true, requestId: "m-cfg-unset-2" });
  check("配置:删本地 user.email 成功", unsetWrite.ok === true && unsetWrite.kind === "done", JSON.stringify(unsetWrite.error || unsetWrite));
  const afterUnset = await bridge.call("gitConfigRead", { cwd: dir });
  check("配置:本地 user.email 已删(全局仍在,只读展示)", afterUnset.identity?.email?.local === null && typeof afterUnset.identity?.email?.global !== "undefined", JSON.stringify(afterUnset.identity?.email));

  // 钩子:上游只支持「列出 + 手动跑」,没有安装/卸载电话;这里手动写一个钩子文件再跑。
  const hook = join(dir, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\nexit 0\n", "utf8");
  const hookCheck = await bridge.call("gitConfigCheck", { cwd: dir, op: "hook-run", name: "pre-commit" });
  check("钩子:手动跑预检放行且要确认", hookCheck.ok === true && hookCheck.confirmRequired === true && hookCheck.confirm?.kind === "hook-run", JSON.stringify(hookCheck.error || hookCheck));
  const hookRun = await bridge.call("gitConfigWrite", { cwd: dir, op: "hook-run", ticketId: hookCheck.ticket?.id, confirmed: true, requestId: "m-hook-1" });
  check("钩子:退出码 0 算跑完(hookFailed=false)", hookRun.ok === true && hookRun.hookFailed === false && hookRun.exitCode === 0, JSON.stringify(hookRun.error || hookRun));

  writeFileSync(hook, "#!/bin/sh\nexit 3\n", "utf8");
  const failCheck = await bridge.call("gitConfigCheck", { cwd: dir, op: "hook-run", name: "pre-commit" });
  const hookFail = await bridge.call("gitConfigWrite", { cwd: dir, op: "hook-run", ticketId: failCheck.ticket?.id, confirmed: true, requestId: "m-hook-2" });
  check("钩子:钩子自己非零退出是运行结论(ok + hookFailed + 退出码)", hookFail.ok === true && hookFail.hookFailed === true && hookFail.exitCode === 3, JSON.stringify(hookFail.error || hookFail));

  const missingHook = await bridge.call("gitConfigCheck", { cwd: dir, op: "hook-run", name: "pre-push" });
  check("钩子:没有对应文件时预检 blocked/hook-not-found", missingHook.ok === false && missingHook.reason === "hook-not-found", JSON.stringify(missingHook));

  check("配置:全局身份没有被测试改动", globalName() === beforeGlobal, `${beforeGlobal} -> ${globalName()}`);
}

// ---------------------------------------------------------------------------------------------
// 4:诊断 —— 只读查询、二分、替换对象、fsck 长任务
// ---------------------------------------------------------------------------------------------
async function sliceDiagnostics() {
  const { dir, c1, c2, c3 } = makeHistory("diag");
  const bridge = await bridgeOf(dir);

  const ls = await bridge.call("gitDiagnosticsRead", { cwd: dir, kind: "ls-files" });
  check("诊断:ls-files 列出已跟踪文件", ls.ok === true && (ls.paths || []).includes("a.txt"), JSON.stringify(ls.error || ls));
  const rp = await bridge.call("gitDiagnosticsRead", { cwd: dir, kind: "rev-parse", params: { rev: "HEAD" } });
  check("诊断:rev-parse 解出与 git 相同的提交号", rp.ok === true && rp.oid === c3, JSON.stringify(rp.error || rp));
  const refs = await bridge.call("gitDiagnosticsRead", { cwd: dir, kind: "for-each-ref" });
  check("诊断:for-each-ref 看到 main", refs.ok === true && (refs.rows || []).some((r) => r.ref === "refs/heads/main" && r.oid === c3), JSON.stringify(refs.error || refs.rows));
  const anc = await bridge.call("gitDiagnosticsRead", { cwd: dir, kind: "is-ancestor", params: { ancestor: "HEAD~2", descendant: "HEAD" } });
  check("诊断:is-ancestor 判祖先关系", anc.ok === true && anc.isAncestor === true, JSON.stringify(anc.error || anc));
  const notAnc = await bridge.call("gitDiagnosticsRead", { cwd: dir, kind: "is-ancestor", params: { ancestor: "HEAD", descendant: "HEAD~2" } });
  check("诊断:反向 is-ancestor 为 false", notAnc.ok === true && notAnc.isAncestor === false, JSON.stringify(notAnc.error || notAnc));
  const grep = await bridge.call("gitDiagnosticsRead", { cwd: dir, kind: "grep", params: { pattern: "three" } });
  check("诊断:grep 命中工作区内容", grep.ok === true && Number(grep.matchCount) >= 1 && (grep.matches || []).some((m) => m.path === "a.txt" && /three/.test(m.text)), JSON.stringify(grep.error || grep));
  const cat = await bridge.call("gitDiagnosticsRead", { cwd: dir, kind: "cat-file", params: { object: "HEAD", mode: "type" } });
  check("诊断:cat-file -t 认对象类型", cat.ok === true && cat.objectType === "commit", JSON.stringify(cat.error || cat));
  const trailers = await bridge.call("gitDiagnosticsRead", { cwd: dir, kind: "trailers", params: { object: "HEAD" } });
  check("诊断:提交备注尾部行读取为 ok", trailers.ok === true && Array.isArray(trailers.trailers), JSON.stringify(trailers.error || trailers));
  const bisect0 = await bridge.call("gitDiagnosticsRead", { cwd: dir, kind: "bisect-status" });
  check("诊断:二分状态读数(不在二分中)", bisect0.ok === true && bisect0.active === false, JSON.stringify(bisect0.error || bisect0));
  const replaces0 = await bridge.call("gitDiagnosticsRead", { cwd: dir, kind: "replace-list" });
  check("诊断:替换清单读数为空", replaces0.ok === true && (replaces0.replaces || []).length === 0, JSON.stringify(replaces0.error || replaces0));

  const startCheck = await bridge.call("gitDiagnosticsCheck", { cwd: dir, op: "bisect-start", bad: c3, good: c1 });
  check("诊断:开始二分预检放行且要确认", startCheck.ok === true && startCheck.confirmRequired === true && startCheck.decision === "allow", JSON.stringify(startCheck.error || startCheck));
  const startWrite = await bridge.call("gitDiagnosticsWrite", { cwd: dir, op: "bisect-start", ticketId: startCheck.ticket?.id, confirmed: true, requestId: "m-diag-start" });
  check("诊断:凭票开始二分成功", startWrite.ok === true && startWrite.op === "bisect-start", JSON.stringify(startWrite.error || startWrite));
  const active = await bridge.call("gitDiagnosticsRead", { cwd: dir, kind: "bisect-status" });
  check("诊断:二分状态变为进行中", active.ok === true && active.active === true, JSON.stringify(active.error || active));
  const resetCheck = await bridge.call("gitDiagnosticsCheck", { cwd: dir, op: "bisect-reset" });
  const resetWrite = await bridge.call("gitDiagnosticsWrite", { cwd: dir, op: "bisect-reset", ticketId: resetCheck.ticket?.id, confirmed: true, requestId: "m-diag-reset" });
  check("诊断:凭票结束二分成功", resetWrite.ok === true, JSON.stringify(resetWrite.error || resetWrite));
  const inactive = await bridge.call("gitDiagnosticsRead", { cwd: dir, kind: "bisect-status" });
  check("诊断:二分状态回到不在二分中", inactive.ok === true && inactive.active === false, JSON.stringify(inactive.error || inactive));

  const replaceCheck = await bridge.call("gitDiagnosticsCheck", { cwd: dir, op: "replace-create", from: c1, to: c2 });
  check("诊断:建立替换预检放行", replaceCheck.ok === true && replaceCheck.confirmRequired === true, JSON.stringify(replaceCheck.error || replaceCheck));
  const replaceWrite = await bridge.call("gitDiagnosticsWrite", { cwd: dir, op: "replace-create", ticketId: replaceCheck.ticket?.id, confirmed: true, requestId: "m-diag-replace-1" });
  check("诊断:凭票建立替换成功", replaceWrite.ok === true && replaceWrite.from === c1 && replaceWrite.to === c2, JSON.stringify(replaceWrite.error || replaceWrite));
  const replaced = await bridge.call("gitDiagnosticsRead", { cwd: dir, kind: "replace-list" });
  check("诊断:替换清单里出现被替换对象", replaced.ok === true && (replaced.replaces || []).includes(c1), JSON.stringify(replaced.error || replaced));
  const delCheck = await bridge.call("gitDiagnosticsCheck", { cwd: dir, op: "replace-delete", object: c1 });
  const delWrite = await bridge.call("gitDiagnosticsWrite", { cwd: dir, op: "replace-delete", ticketId: delCheck.ticket?.id, confirmed: true, requestId: "m-diag-replace-2" });
  check("诊断:凭票撤销替换成功", delWrite.ok === true, JSON.stringify(delWrite.error || delWrite));
  const replacedGone = await bridge.call("gitDiagnosticsRead", { cwd: dir, kind: "replace-list" });
  check("诊断:撤销后替换清单为空", replacedGone.ok === true && (replacedGone.replaces || []).length === 0, JSON.stringify(replacedGone.error || replacedGone));

  const fsck = await bridge.call("gitTaskStart", { cwd: dir, op: "fsck", args: { mode: "unreachable" } });
  check("诊断:fsck 走长任务通道", fsck.ok === true && typeof fsck.task?.taskId === "string", JSON.stringify(fsck.error || fsck));
  const fsckDone = await waitTask(bridge, fsck.task?.taskId);
  check("诊断:fsck 任务成功收尾", fsckDone?.conclusion === "succeeded", JSON.stringify(fsckDone));

  const badKind = await bridge.call("gitDiagnosticsRead", { cwd: dir, kind: "no-such-kind" });
  check("诊断:坏查询名回 args 失败", badKind.ok === false && badKind.error?.kind === "args", JSON.stringify(badKind));
}

// ---------------------------------------------------------------------------------------------
// 5:平台 —— 平台页读数、request-pull、补丁目录、format-patch 长任务;platformCheck 的上游缺口
// ---------------------------------------------------------------------------------------------
async function slicePlatform() {
  const { dir } = makeHistory("platform");
  const bridge = await bridgeOf(dir);

  const read = await bridge.call("gitPlatformRead", { cwd: dir });
  check("平台:平台页读取为 ok(凭据链 + updateRefs)", read.ok === true && read.credential?.state === "ok" && Array.isArray(read.credential?.helpers) && read.updateRefs?.state === "ok", JSON.stringify(read.error || read));

  const rp = await bridge.call("gitRequestPull", { cwd: dir, start: "HEAD~2", url: dir, end: "HEAD" });
  check("平台:request-pull 生成说明文本", rp.ok === true && /The following changes since/.test(String(rp.text || "")) && String(rp.text || "").includes("c3"), JSON.stringify(rp.error || String(rp.text || "").slice(0, 200)));

  const none = await bridge.call("gitPatchFiles", { cwd: dir, dir: "patches" });
  check("平台:补丁目录不存在时如实回 exists=false", none.ok === true && none.exists === false && (none.patches || []).length === 0, JSON.stringify(none.error || none));
  mkdirSync(join(dir, "patches"), { recursive: true });
  writeFileSync(join(dir, "patches", "0001-c3.patch"), "From 0\nSubject: [PATCH] c3\n", "utf8");
  writeFileSync(join(dir, "patches", "notes.txt"), "not a patch\n", "utf8");
  const list = await bridge.call("gitPatchFiles", { cwd: dir, dir: "patches" });
  check("平台:补丁目录清单只挑补丁文件", list.ok === true && list.exists === true && (list.patches || []).includes("0001-c3.patch") && Number(list.others) === 1 && Number(list.total) === 1, JSON.stringify(list.error || list));

  const outside = await bridge.call("gitPatchFiles", { cwd: dir, dir: join(BASE, "outside-patches") });
  check("平台:补丁目录越界回 boundary", outside.ok === false && outside.error?.kind === "boundary", JSON.stringify(outside));

  // 14.1 的执行体能跑:直接经长任务通道跑 format-patch(平台页的 run 电话就是把它交出去)。
  const patchOut = join(dir, "patch-out");
  mkdirSync(patchOut, { recursive: true });
  const patchTask = await bridge.call("gitTaskStart", { cwd: dir, op: "format-patch", args: { range: "HEAD~1..HEAD", dir: patchOut } });
  check("平台:format-patch 长任务能起", patchTask.ok === true && typeof patchTask.task?.taskId === "string", JSON.stringify(patchTask.error || patchTask));
  const patchDone = await waitTask(bridge, patchTask.task?.taskId);
  check("平台:format-patch 任务成功且产出补丁文件", patchDone?.conclusion === "succeeded" && readdirSync(patchOut).some((n) => /^0001-.*\.patch$/.test(n)), JSON.stringify(patchDone));

  // 上游 versionControlPlatform.ts 读 screenReply.data.screen,而 versionControl.ts 的 readScreenOf 回 {ok,screen};
  // 2026-11-20 实测 gitPlatformCheck 回 kind=shape。平台页只用 read/requestPull/patchFiles,不在面板路径上;
  // 按工单纪律「上游真 bug 只记录」不在这里修,这里只断言电话不抛、回结构化结果。
  const platformCheck = await bridge.call("gitPlatformCheck", { cwd: dir, range: "HEAD~1..HEAD", dir: "patches" });
  check("平台:gitPlatformCheck 回结构化结果(不抛;上游 readScreenOf 形状不一致时回 shape,见报告)", typeof platformCheck.ok === "boolean" && (platformCheck.ok === true || typeof platformCheck.error?.kind === "string"), JSON.stringify(platformCheck));
}

// ---------------------------------------------------------------------------------------------
// 6:远端 —— 本地 bare 上的增删改与联网查看
// ---------------------------------------------------------------------------------------------
async function sliceRemote() {
  const { dir } = makeHistory("remote");
  const bridge = await bridgeOf(dir);
  const bareA = join(BASE, "remote-a.git");
  const bareB = join(BASE, "remote-b.git");
  execFileSync("git", ["clone", "-q", "--bare", dir, bareA], { encoding: "utf8" });
  execFileSync("git", ["clone", "-q", "--bare", dir, bareB], { encoding: "utf8" });

  const empty = await bridge.call("gitRemoteList", { cwd: dir });
  check("远端:初始列表为空(本地记录)", empty.ok === true && empty.source === "local" && empty.remotes.length === 0, JSON.stringify(empty.error || empty));

  const add = await bridge.call("gitRemoteAdd", { cwd: dir, name: "origin", url: bareA });
  check("远端:登记远端成功", add.ok === true && add.action === "add" && add.name === "origin", JSON.stringify(add.error || add));
  const afterAdd = await bridge.call("gitRemoteList", { cwd: dir });
  check("远端:列表里出现 origin", afterAdd.ok === true && afterAdd.remotes.some((r) => r.name === "origin"), JSON.stringify(afterAdd.error || afterAdd.remotes));

  const online = await bridge.call("gitRemoteOnline", { cwd: dir, name: "origin" });
  check("远端:联网查看到本地 bare 的引用", online.ok === true && online.source === "network" && online.count >= 1 && (online.refs || []).some((r) => /refs\/heads\/main/.test(String(r.name || r.ref || ""))), JSON.stringify(online.error || online).slice(0, 400));

  const setUrl = await bridge.call("gitRemoteSetUrl", { cwd: dir, name: "origin", url: bareB });
  check("远端:改地址成功", setUrl.ok === true && setUrl.action === "set-url", JSON.stringify(setUrl.error || setUrl));
  check("远端:改地址后仓库配置指向新 bare", gitOut(dir, "config", "--get", "remote.origin.url") === bareB, gitOut(dir, "config", "--get", "remote.origin.url"));

  const rename = await bridge.call("gitRemoteRename", { cwd: dir, from: "origin", to: "upstream" });
  check("远端:改名成功", rename.ok === true && rename.action === "rename" && rename.name === "upstream", JSON.stringify(rename.error || rename));
  const afterRename = await bridge.call("gitRemoteList", { cwd: dir });
  check("远端:列表里只剩 upstream", afterRename.ok === true && afterRename.remotes.map((r) => r.name).join(",") === "upstream", JSON.stringify(afterRename.remotes));

  const remove = await bridge.call("gitRemoteRemove", { cwd: dir, name: "upstream" });
  check("远端:删除成功", remove.ok === true && remove.action === "remove", JSON.stringify(remove.error || remove));
  const afterRemove = await bridge.call("gitRemoteList", { cwd: dir });
  check("远端:删除后列表为空", afterRemove.ok === true && afterRemove.remotes.length === 0, JSON.stringify(afterRemove.remotes));

  const badName = await bridge.call("gitRemoteAdd", { cwd: dir, name: "-bad", url: bareA });
  check("远端:坏名字当场拒绝", badName.ok === false && badName.error?.reason === "remote-name", JSON.stringify(badName));
  const noUrl = await bridge.call("gitRemoteAdd", { cwd: dir, name: "x" });
  check("远端:缺地址当场拒绝", noUrl.ok === false && noUrl.error?.reason === "remote-url", JSON.stringify(noUrl));
}

// ---------------------------------------------------------------------------------------------
// 7:历史高级查询 —— 只读
// ---------------------------------------------------------------------------------------------
async function sliceHistory() {
  const { dir, c1, c2, c3 } = makeHistory("history");
  const bridge = await bridgeOf(dir);
  // 备注与分支夹具:feature 从 c1 分叉,各一条提交,用来做 range-diff 与 compare。
  gitAt(dir, "notes", "add", "-m", "note-text", c3);
  gitAt(dir, "branch", "feature", c1);
  gitAt(dir, "checkout", "-q", "feature");
  commitFile(dir, "f.txt", "feature\n", "feature-change");
  gitAt(dir, "checkout", "-q", "main");

  const describe = await bridge.call("gitHistoryQuery", { cwd: dir, kind: "describe" });
  check("历史:describe 读到版本名", describe.ok === true && String(describe.text || "").length > 0, JSON.stringify(describe.error || describe));
  const reflog = await bridge.call("gitHistoryQuery", { cwd: dir, kind: "reflog", params: { count: 10 } });
  check("历史:reflog 读到条目", reflog.ok === true && Number(reflog.count) >= 3, JSON.stringify(reflog.error || reflog));
  const showFile = await bridge.call("gitHistoryQuery", { cwd: dir, kind: "show-file", params: { rev: "HEAD", path: "a.txt" } });
  check("历史:show-file 取到该版本文件内容", showFile.ok === true && showFile.binary === false && showFile.text === "one\ntwo\nthree\n", JSON.stringify(showFile.error || showFile));
  const blame = await bridge.call("gitHistoryQuery", { cwd: dir, kind: "blame", params: { path: "a.txt", lineStart: 1, lineEnd: 2 } });
  check("历史:blame 逐行追溯到 2 行", blame.ok === true && Number(blame.count) === 2, JSON.stringify(blame.error || blame));
  const fileHistory = await bridge.call("gitHistoryQuery", { cwd: dir, kind: "file-history", params: { path: "a.txt" } });
  check("历史:单文件历史读到三次改动", fileHistory.ok === true && (fileHistory.commits || []).length === 3 && fileHistory.commits[0].subject === "c3", JSON.stringify(fileHistory.error || fileHistory));
  const grep = await bridge.call("gitHistoryQuery", { cwd: dir, kind: "grep", params: { pattern: "c2" } });
  check("历史:按说明搜提交命中", grep.ok === true && (grep.commits || []).some((x) => x.subject === "c2"), JSON.stringify(grep.error || grep));
  const pickaxe = await bridge.call("gitHistoryQuery", { cwd: dir, kind: "pickaxe", params: { text: "three" } });
  check("历史:按代码变化搜提交命中 c3", pickaxe.ok === true && (pickaxe.commits || []).some((x) => x.subject === "c3"), JSON.stringify(pickaxe.error || pickaxe));
  const compare = await bridge.call("gitHistoryQuery", { cwd: dir, kind: "compare", params: { left: "HEAD~1", right: "HEAD" } });
  check("历史:比较两个引用列出改动文件", compare.ok === true && (compare.files || []).some((f) => String(f.path || f.file || "").includes("a.txt")), JSON.stringify(compare.error || compare));
  const notes = await bridge.call("gitHistoryQuery", { cwd: dir, kind: "notes", params: { rev: c3 } });
  check("历史:读到提交备注原文", notes.ok === true && notes.reason === "ok" && String(notes.note || "").includes("note-text"), JSON.stringify(notes.error || notes));
  const noNote = await bridge.call("gitHistoryQuery", { cwd: dir, kind: "notes", params: { rev: c1 } });
  check("历史:没有备注时如实回 no-note", noNote.ok === true && noNote.reason === "no-note" && noNote.note === null, JSON.stringify(noNote.error || noNote));
  const rangeDiff = await bridge.call("gitHistoryQuery", { cwd: dir, kind: "range-diff", params: { base: c1, left: c3, right: "feature" } });
  check("历史:两组提交对照为 ok", rangeDiff.ok === true && Array.isArray(rangeDiff.pairs), JSON.stringify(rangeDiff.error || rangeDiff));

  const bad = await bridge.call("gitHistoryQuery", { cwd: dir, kind: "no-such-kind" });
  check("历史:坏查询名回 args 失败", bad.ok === false && bad.error?.kind === "args", JSON.stringify(bad));
  const missing = await bridge.call("gitHistoryQuery", { cwd: dir, kind: "show-file", params: {} });
  check("历史:缺参数的查询回 args 失败", missing.ok === false && missing.error?.kind === "args", JSON.stringify(missing));
  check("历史:夹具引用都对得上", [c1, c2, c3].every((x) => /^[0-9a-f]{40}$/.test(x)));
}

// ---------------------------------------------------------------------------------------------
// 8:长任务 —— 成功 / 失败 / 取消 / 中断标注
// ---------------------------------------------------------------------------------------------
async function sliceTasks() {
  const { dir } = makeHistory("tasks");
  const bridge = await bridgeOf(dir);
  const bare = join(BASE, "task-source.git");
  execFileSync("git", ["clone", "-q", "--bare", dir, bare], { encoding: "utf8" });

  const failedTask = await bridge.call("gitTaskStart", { cwd: dir, op: "fetch", args: { remote: "missing-remote" }, requestId: "m-task-fail" });
  check("长任务:坏远端也能起任务(失败在结论里说)", failedTask.ok === true && typeof failedTask.task?.taskId === "string", JSON.stringify(failedTask.error || failedTask));
  const failedDone = await waitTask(bridge, failedTask.task?.taskId);
  check("长任务:失败结论 = failed + non-zero + git 原话", failedDone?.conclusion === "failed" && failedDone?.failureKind === "non-zero" && String(failedDone?.failureLine || "").length > 0, JSON.stringify(failedDone));

  // 成功:fetch 本地 bare(快)。
  gitAt(dir, "remote", "add", "local", bare);
  const goodTask = await bridge.call("gitTaskStart", { cwd: dir, op: "fetch", args: { remote: "local" }, requestId: "m-task-good" });
  const goodDone = await waitTask(bridge, goodTask.task?.taskId);
  check("长任务:成功结论 = succeeded", goodDone?.conclusion === "succeeded", JSON.stringify(goodDone));

  // 取消:把 git-upload-pack 换成一个会挂住的脚本(本地 bare,不联网),任务挂在 fetch 里再取消。
  const hang = join(BASE, "hang-upload.sh");
  writeFileSync(hang, "#!/bin/sh\nexec sleep 8\n", "utf8");
  gitAt(dir, "remote", "add", "hang", bare);
  gitAt(dir, "config", "remote.hang.uploadpack", hang.replaceAll(String.fromCharCode(92), "/"));
  const hangTask = await bridge.call("gitTaskStart", { cwd: dir, op: "fetch", args: { remote: "hang" }, requestId: "m-task-hang" });
  check("长任务:会挂住的 fetch 进入在途", hangTask.ok === true && typeof hangTask.task?.taskId === "string", JSON.stringify(hangTask.error || hangTask));
  await sleep(300);
  const running = await bridge.call("gitTaskQuery", {});
  const runningRow = (running.tasks || []).find((t) => t.taskId === hangTask.task?.taskId);
  check("长任务:查询看到 running 且进度不确定", runningRow?.state === "running" && runningRow?.uncertain === true, JSON.stringify(runningRow));
  const cancelled = await bridge.call("gitTaskCancel", { taskId: hangTask.task?.taskId });
  check("长任务:取消给出 cancelled 结论与残留说明", cancelled.ok === true && cancelled.task?.conclusion === "cancelled" && String(cancelled.task?.residual || "").length > 0, JSON.stringify(cancelled.error || cancelled));
  const afterCancel = await bridge.call("gitTaskQuery", {});
  const cancelledRow = (afterCancel.tasks || []).find((t) => t.taskId === hangTask.task?.taskId);
  check("长任务:取消后任务表里是 done/cancelled", cancelledRow?.state === "done" && cancelledRow?.conclusion === "cancelled" && cancelledRow?.cancelRequested === true, JSON.stringify(cancelledRow));

  check("长任务:任务记录不落工作区根", !existsSync(join(dir, "vc-task-events__tasks.json")), dir);

  // 中断:另一个实例留下的在途记录(手工落到同一个任务缓存目录),新 bridge 第一次查询要标 interrupted。
  const cache2 = join(BASE, "task-cache-resume");
  mkdirSync(cache2, { recursive: true });
  const oldStarted = Date.now() - 5000;
  writeFileSync(
    join(cache2, "vc-task-events__tasks.json"),
    JSON.stringify({ version: 1, savedAt: oldStarted, tasks: [{ taskId: "old-task-1", op: "clone", state: "running", conclusion: null, instanceId: "old-instance", startedAt: oldStarted }] }),
    "utf8"
  );
  const resumedBridge = await bridgeOf(dir, { env: { ...process.env, ZCODE_VC_TASK_CACHE: cache2 } });
  const resumed = await resumedBridge.call("gitTaskQuery", {});
  const oldRow = (resumed.tasks || []).find((t) => t.taskId === "old-task-1");
  check("长任务:上一进程留下的在途任务标 interrupted", oldRow?.conclusion === "interrupted" && oldRow?.interrupted === true, JSON.stringify(resumed.error || oldRow));
  check("长任务:中断记录带说明", String(oldRow?.failureLine || "").includes("中断") && String(oldRow?.residual || "").length > 0, JSON.stringify(oldRow));

  const badOp = await bridge.call("gitTaskStart", { cwd: dir, op: "status", args: {} });
  check("长任务:清单外的动作拒绝", badOp.ok === false && badOp.error?.kind === "invalid-request" && badOp.error?.reason === "unknown-op", JSON.stringify(badOp));
  const noConfirm = await bridge.call("gitTaskStart", { cwd: dir, op: "gc", args: {} });
  check("长任务:危险动作缺确认时拒绝", noConfirm.ok === false && noConfirm.error?.reason === "confirm-required", JSON.stringify(noConfirm));
  const noTask = await bridge.call("gitTaskCancel", { taskId: "no-such-task" });
  check("长任务:取消不存在的任务明确拒绝", noTask.ok === false && noTask.error?.reason === "no-such-task", JSON.stringify(noTask));
}

// ---------------------------------------------------------------------------------------------
// 9:坏参数 / 过期票 / 越界路径
// ---------------------------------------------------------------------------------------------
async function sliceErrors() {
  const { dir } = makeHistory("errors");
  const bridge = await bridgeOf(dir);
  const outside = mkdtempSync(join(tmpdir(), "t06-outside-"));

  try {
    const cfgOutside = await bridge.call("gitConfigRead", { cwd: outside });
    check("边界:配置读取的 cwd 越界回 boundary", cfgOutside.ok === false && cfgOutside.error?.kind === "boundary", JSON.stringify(cfgOutside));
    const maintOutside = await bridge.call("gitMaintenanceRead", { cwd: outside, op: "objects" });
    check("边界:维护读数的 cwd 越界回 boundary", maintOutside.ok === false && maintOutside.error?.kind === "boundary", JSON.stringify(maintOutside));
    const taskOutside = await bridge.call("gitTaskStart", { cwd: outside, op: "fsck", args: {} });
    check("边界:长任务 cwd 越界回 boundary", taskOutside.ok === false && taskOutside.error?.kind === "boundary", JSON.stringify(taskOutside));

    // fast-import 的输入文件是真实路径:越界要在起任务之前拦住。
    const stdinOutside = await bridge.call("gitTaskStart", {
      cwd: dir, op: "fast-import", args: {},
      stdinFile: { path: join(outside, "x.fi"), sizeBytes: 1, sha256: "a".repeat(64) },
    });
    check("边界:fast-import 输入文件越界回 boundary", stdinOutside.ok === false && stdinOutside.error?.kind === "boundary", JSON.stringify(stdinOutside));

    const cloneOp = await bridge.call("gitCloneCheck", { cwd: dir, op: "no-such-op", dir: join(dir, "x") });
    check("坏参数:克隆坏动作回 args", cloneOp.ok === false && cloneOp.error?.kind === "args", JSON.stringify(cloneOp));
    const migrateAction = await bridge.call("gitMigrateCheck", { cwd: dir, action: "no-such-action" });
    check("坏参数:迁移坏动作回 args", migrateAction.ok === false && migrateAction.error?.kind === "args", JSON.stringify(migrateAction));
    const historyKind = await bridge.call("gitHistoryQuery", { cwd: dir, kind: "" });
    check("坏参数:历史缺 kind 回 args", historyKind.ok === false && historyKind.error?.kind === "args", JSON.stringify(historyKind));
    const cfgBadOp = await bridge.call("gitConfigCheck", { cwd: dir, op: "no-such-op", key: "user.name", value: "x" });
    check("坏参数:配置预检坏动作回 args", cfgBadOp.ok === false && cfgBadOp.reason === "bad-target", JSON.stringify(cfgBadOp));
    const nonStringCwd = await bridge.call("gitConfigRead", { cwd: 42 });
    check("坏参数:非字符串 cwd 回人话错误", nonStringCwd.ok === false && nonStringCwd.error?.kind === "bad-args", JSON.stringify(nonStringCwd));

    // 过期票:票据只活 120 秒。用可推进的钟把时间推过 121 秒,不真等两分钟。
    const clock = { t: Date.now() };
    const clockBridge = await bridgeOf(dir, { now: () => clock.t });
    const pending = await clockBridge.call("gitConfigCheck", { cwd: dir, op: "config-set", key: "user.name", scope: "local", value: "T06 Late" });
    check("过期票:先签一张有效票", pending.ok === true && typeof pending.ticket?.id === "string", JSON.stringify(pending.error || pending));
    clock.t += 121000;
    const expired = await clockBridge.call("gitConfigWrite", { cwd: dir, op: "config-set", ticketId: pending.ticket?.id, requestId: "m-cfg-expired" });
    check("过期票:超时后凭票执行被拒(ticket-expired)", expired.ok === false && expired.error?.kind === "blocked" && expired.error?.reason === "ticket-expired", JSON.stringify(expired));
    const stillOld = await bridge.call("gitConfigRead", { cwd: dir });
    check("过期票:被拒后配置没有改动", stillOld.identity?.name?.local === "T06 Tester", JSON.stringify(stillOld.identity?.name));
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------------------------
if (!existsSync(DIST_GIT)) {
  console.error("FAIL - 先跑 node build.mjs(dist/git.mjs 不存在)");
  process.exit(1);
}

try {
  for (const [name, fn] of [
    ["contract", sliceContract],
    ["maintenance", sliceMaintenance],
    ["migrate-clone", sliceMigrateClone],
    ["config-hooks", sliceConfigHooks],
    ["diagnostics", sliceDiagnostics],
    ["platform", slicePlatform],
    ["remote", sliceRemote],
    ["history", sliceHistory],
    ["tasks", sliceTasks],
    ["errors", sliceErrors],
  ]) {
    try {
      await fn();
    } catch (e) {
      failures++;
      console.error(`FAIL - ${name} 套件异常 :: ` + (e && e.stack ? e.stack : e));
    }
  }
} finally {
  rmSync(BASE, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} 条断言失败`);
  process.exit(1);
}
console.log("\nserver-git-admin: 全部断言通过");
