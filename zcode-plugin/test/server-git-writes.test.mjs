// 工单 03 缝 2 测试:改动 / 提交 / 同步三组真电话,在本机真 git 仓(mkdtemp)上逐条验收。
//
// 覆盖面:
//   ① 改动域:gitChangesCheck → gitChangesWrite 的暂存 / 撤回暂存 / 丢弃(单文件、多文件、逐块),票据绑定与过期;
//   ② 提交域:gitCommitForm(身份/模板/上一条)、gitWriteCheck → gitCommit(消息与文件集)、重放、坏计划、过期票;
//   ③ 同步域:gitSyncCheck → gitSyncWrite 的 fetch / pull / push,本地 bare 仓做 origin,断言前进/落后与远端状态;
//      另含坏远端(路径删掉)的诚实失败、非交互环境(pre-push 钩子读环境)、缺确认与坏参数;
//   ④ 路径边界与 deck_git 路由(起 dist/server.mjs,经一条工具走完一次写闭合)。
// 期望值来自工单验收条目与 git 自身行为(harness 另起 git 命令核对),不拿实现回算实现。
// 临时目录结束即删;进程内有挂起的命令预算计时器,收尾用 process.exit 结束,避免空等。
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

const short = (v, n = 400) => {
  try {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s === undefined ? String(v) : s.slice(0, n);
  } catch {
    return String(v);
  }
};

/** 真 git 命令(测试自己的核对面,不经过被测代码)。 */
function gitIn(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
}
/** 仓库路径交给 git 当远端/克隆源:统一正斜杠,免得 Windows 反斜杠在 argv 里变形。 */
const asGitPath = (p) => String(p).replace(/\\/g, "/");

/** 造一个空工作区目录(mkdtemp),所有仓库都放在它下面(路径边界要求)。 */
function makeWorkspace() {
  return mkdtempSync(join(tmpdir(), "t03-vc-writes-"));
}

/** 建仓并写本仓身份;返回目录。 */
function initRepo(dir, email = "t03@example.com", name = "T03 Tester") {
  mkdirSync(dir, { recursive: true });
  gitIn(dir, "init", "-b", "main");
  gitIn(dir, "config", "user.email", email);
  gitIn(dir, "config", "user.name", name);
  // 关掉换行转换:测试按写下去的字节比内容,平台的默认值不该参与。
  gitIn(dir, "config", "core.autocrlf", "false");
  return dir;
}

/** 一次提交(测试夹具用;被测的提交走 gitWriteCheck → gitCommit)。 */
function commitAll(dir, message) {
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-m", message);
}

/** 落一个钩子脚本(git 在 Windows 上也用自带 sh 跑钩子);把指定环境变量写进 outFile。 */
function writeHook(repo, hookName, outFile, names) {
  const dir = join(repo, ".git", "hooks");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, hookName);
  const lines = names.map((n) => `echo "${n}=$${n}"`);
  writeFileSync(file, "#!/bin/sh\n{ " + lines.join("; ") + `; } > "${asGitPath(outFile)}"\nexit 0\n`, "utf8");
  try {
    chmodSync(file, 0o755);
  } catch {
    /* Windows 上 chmod 可能无效;git for Windows 仍会按文件存在执行钩子 */
  }
  return file;
}

/** gitStatus 的屏幕读数。 */
async function statusOf(bridge, cwd) {
  const r = await bridge.call("gitStatus", { cwd });
  return r.ok === true ? r.screen : null;
}

/** 轮询长任务直到离开 running;返回 { task, ms }(查不到时 task 为 null)。 */
async function pollTask(bridge, taskId, budgetMs = 30000) {
  if (typeof taskId !== "string" || taskId === "") return { task: null, ms: 0 };
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    const q = await bridge.call("gitTaskQuery", {});
    const one = (q.tasks || []).find((x) => x && x.taskId === taskId);
    if (one && one.state !== "running") return { task: one, ms: Date.now() - t0 };
    await new Promise((r) => setTimeout(r, 150));
  }
  return { task: null, ms: Date.now() - t0 };
}

// ---- 改动域:gitChangesCheck → gitChangesWrite ------------------------------------------------
async function sliceChanges(bridge, ws) {
  const cwd = initRepo(join(ws, "change-repo"));
  writeFileSync(join(cwd, "a.txt"), "a1\na2\n", "utf8");
  writeFileSync(join(cwd, "b.txt"), "b1\n", "utf8");
  writeFileSync(join(cwd, "c.txt"), "c1\n", "utf8");
  const hunkLines = Array.from({ length: 40 }, (_, i) => `line${i + 1}`);
  writeFileSync(join(cwd, "hunk.txt"), hunkLines.join("\n") + "\n", "utf8");
  commitAll(cwd, "base");

  // 1) 单文件暂存:check 拿票 → write 带票
  writeFileSync(join(cwd, "new.txt"), "hello\n", "utf8");
  const sc = await bridge.call("gitChangesCheck", { cwd, op: "stage-file", path: "new.txt" });
  check("changes: stage-file 预检 ok", sc.ok === true, short(sc.error || sc));
  check(
    "changes: 票据形状 id/checkedAtMs/expiresAtMs/op",
    typeof sc.ticket?.id === "string" &&
      sc.ticket.id.length > 0 &&
      typeof sc.ticket.checkedAtMs === "number" &&
      sc.ticket.expiresAtMs > sc.ticket.checkedAtMs &&
      sc.ticket.op === "stage-file",
    short(sc.ticket)
  );
  check("changes: 计划绑定 stage-file/new.txt", sc.plan?.op === "stage-file" && sc.plan?.paths?.[0] === "new.txt", short(sc.plan));
  const sw = await bridge.call("gitChangesWrite", {
    cwd,
    op: "stage-file",
    path: "new.txt",
    ticketId: sc.ticket?.id,
    requestId: "changes-stage-1",
    confirm: true,
  });
  check("changes: stage-file 执行 ok", sw.ok === true, short(sw.error || sw));
  check("changes: 写后回读屏幕里 new.txt 已暂存", (sw.screen?.staged || []).some((f) => f.path === "new.txt"), short(sw.screen?.staged));
  check("changes: git 自身看到 A  new.txt", gitIn(cwd, "status", "--porcelain").includes("A  new.txt"), gitIn(cwd, "status", "--porcelain"));

  // 1b) 同一个 requestId 再问一次:改动写层回 {ok, reused, result},不再执行第二条写命令
  const swReplay = await bridge.call("gitChangesWrite", {
    cwd,
    op: "stage-file",
    path: "new.txt",
    ticketId: sc.ticket?.id,
    requestId: "changes-stage-1",
    confirm: true,
  });
  check(
    "changes: 同 requestId 回放 reused=true 且带上次结果",
    swReplay.ok === true && swReplay.reused === true && swReplay.result?.changed?.op === "stage-file",
    short(swReplay)
  );

  // 2) 单文件撤回暂存
  const uc = await bridge.call("gitChangesCheck", { cwd, op: "unstage", path: "new.txt" });
  check("changes: unstage 预检 ok", uc.ok === true, short(uc.error || uc));
  const uw = await bridge.call("gitChangesWrite", {
    cwd,
    op: "unstage",
    path: "new.txt",
    ticketId: uc.ticket?.id,
    requestId: "changes-unstage-1",
    confirm: true,
  });
  check("changes: unstage 执行 ok", uw.ok === true, short(uw.error || uw));
  check("changes: 撤回后暂存区没有 new.txt", !(uw.screen?.staged || []).some((f) => f.path === "new.txt"), short(uw.screen?.staged));
  check("changes: 撤回后 new.txt 回到未跟踪", (uw.screen?.unstaged || []).some((f) => f.path === "new.txt" && f.change === "untracked"), short(uw.screen?.unstaged));

  // 3) 单文件丢弃
  writeFileSync(join(cwd, "a.txt"), "a1\nDISCARD-ME\n", "utf8");
  const dc = await bridge.call("gitChangesCheck", { cwd, op: "discard-file", path: "a.txt" });
  check("changes: discard-file 预检 ok 且绑定 restore/checkout 档", dc.ok === true && (dc.plan?.mode === "restore" || dc.plan?.mode === "checkout"), short(dc.error || dc.plan));
  const dw = await bridge.call("gitChangesWrite", {
    cwd,
    op: "discard-file",
    path: "a.txt",
    ticketId: dc.ticket?.id,
    requestId: "changes-discard-1",
    confirm: true,
  });
  check("changes: discard-file 执行 ok", dw.ok === true, short(dw.error || dw));
  check("changes: 丢弃后 a.txt 内容回到 HEAD", readFileSync(join(cwd, "a.txt"), "utf8") === "a1\na2\n", short(readFileSync(join(cwd, "a.txt"), "utf8")));

  // 4) 多文件暂存(stage-all):两个已跟踪文件一起进暂存区
  rmSync(join(cwd, "new.txt"), { force: true });
  writeFileSync(join(cwd, "a.txt"), "a1\na2 changed\n", "utf8");
  writeFileSync(join(cwd, "b.txt"), "b1 changed\n", "utf8");
  const ac = await bridge.call("gitChangesCheck", { cwd, op: "stage-all" });
  check("changes: stage-all 预检 ok", ac.ok === true, short(ac.error || ac));
  const aw = await bridge.call("gitChangesWrite", { cwd, op: "stage-all", ticketId: ac.ticket?.id, requestId: "changes-stageall-1", confirm: true });
  const stagedNames = (aw.screen?.staged || []).map((f) => f.path).sort();
  check("changes: stage-all 后两个文件都在暂存区", aw.ok === true && stagedNames.join(",") === "a.txt,b.txt", short({ err: aw.error, stagedNames }));
  check(
    "changes: git 自身看到两个文件已暂存",
    gitIn(cwd, "diff", "--cached", "--name-only").trim().split("\n").sort().join(",") === "a.txt,b.txt",
    gitIn(cwd, "diff", "--cached", "--name-only")
  );

  // 5) 逐个撤回暂存(两个文件两张票),最后暂存区空
  let lastUnstage = null;
  const unstagePaths = ["a.txt", "b.txt"];
  for (let i = 0; i < unstagePaths.length; i += 1) {
    const p = unstagePaths[i];
    const c1 = await bridge.call("gitChangesCheck", { cwd, op: "unstage", path: p });
    lastUnstage = await bridge.call("gitChangesWrite", { cwd, op: "unstage", path: p, ticketId: c1.ticket?.id, requestId: "changes-unstage-bulk-" + i, confirm: true });
  }
  check(
    "changes: 两个文件都撤回暂存后暂存区为空",
    lastUnstage?.ok === true && !!lastUnstage.screen && (lastUnstage.screen.staged || []).length === 0,
    short({ err: lastUnstage?.error, screen: lastUnstage?.screen })
  );

  // 6) 多文件丢弃(discard-all):两个已跟踪文件的未暂存改动一起复原
  check("changes: 丢弃前两个文件都有未暂存改动", (lastUnstage?.screen?.unstaged || []).filter((f) => ["a.txt", "b.txt"].includes(f.path)).length === 2, short(lastUnstage?.screen?.unstaged));
  const dac = await bridge.call("gitChangesCheck", { cwd, op: "discard-all" });
  check("changes: discard-all 预检 ok", dac.ok === true, short(dac.error || dac));
  const daw = await bridge.call("gitChangesWrite", { cwd, op: "discard-all", ticketId: dac.ticket?.id, requestId: "changes-discardall-1", confirm: true });
  check("changes: discard-all 执行 ok", daw.ok === true, short(daw.error || daw));
  check(
    "changes: 丢弃全部后 a.txt / b.txt 都回到 HEAD",
    readFileSync(join(cwd, "a.txt"), "utf8") === "a1\na2\n" && readFileSync(join(cwd, "b.txt"), "utf8") === "b1\n",
    short({ a: readFileSync(join(cwd, "a.txt"), "utf8"), b: readFileSync(join(cwd, "b.txt"), "utf8") })
  );

  // 7) 逐块暂存:只把第一块写进索引,第二块留在工作区
  const changed = hunkLines.slice();
  changed[1] = "line2 CHANGED";
  changed[37] = "line38 CHANGED";
  writeFileSync(join(cwd, "hunk.txt"), changed.join("\n") + "\n", "utf8");
  const hc = await bridge.call("gitChangesCheck", { cwd, op: "stage-hunks", path: "hunk.txt", hunkIndex: 0 });
  check("changes: stage-hunks 预检 ok 且带补丁摘要", hc.ok === true && typeof hc.plan?.patchDigest === "string", short(hc.error || hc.plan));
  const hw = await bridge.call("gitChangesWrite", { cwd, op: "stage-hunks", path: "hunk.txt", hunkIndex: 0, ticketId: hc.ticket?.id, requestId: "changes-hunks-1", confirm: true });
  const cachedDiff = gitIn(cwd, "diff", "--cached", "--", "hunk.txt");
  const workDiff = gitIn(cwd, "diff", "--", "hunk.txt");
  check("changes: 逐块暂存执行 ok(临时补丁文件路径可用)", hw.ok === true, short(hw.error || hw));
  check("changes: 索引里只有第一块(line2 已暂存)", cachedDiff.includes("+line2 CHANGED"), short(cachedDiff));
  check("changes: 索引里没有第二块(line38 未暂存)", !cachedDiff.includes("line38 CHANGED"), short(cachedDiff));
  check("changes: 工作区仍保留第二块(line38 未暂存)", workDiff.includes("+line38 CHANGED") && !workDiff.includes("line2 CHANGED"), short(workDiff));

  // 8) 票据绑定:预检之后工作树变了,执行必须拒成 target-changed,且不写
  writeFileSync(join(cwd, "c.txt"), "c1 changed\n", "utf8");
  const stale = await bridge.call("gitChangesCheck", { cwd, op: "stage-file", path: "c.txt" });
  check("changes: 变更前预检 ok", stale.ok === true, short(stale.error || stale));
  gitIn(cwd, "add", "c.txt"); // 预检之后、执行之前,从别处把这块改动先暂存了
  const staleWrite = await bridge.call("gitChangesWrite", {
    cwd,
    op: "stage-file",
    path: "c.txt",
    ticketId: stale.ticket?.id,
    requestId: "changes-stale-1",
    confirm: true,
  });
  check(
    "changes: 预检后现场变了 → 诚实拒绝 target-changed",
    staleWrite.ok === false && staleWrite.error?.reason === "target-changed",
    short(staleWrite)
  );

  // 9) 坏参数:不认识的 op、越出仓库的路径
  const badOp = await bridge.call("gitChangesCheck", { cwd, op: "no-such-op" });
  check("changes: 坏 op 回 args/bad-target", badOp.ok === false && badOp.error?.kind === "args" && badOp.error?.reason === "bad-target", short(badOp));
  const badPath = await bridge.call("gitChangesCheck", { cwd, op: "stage-file", path: "../escape.txt" });
  check("changes: 越界路径回 args/bad-path", badPath.ok === false && badPath.error?.kind === "args" && badPath.error?.reason === "bad-path", short(badPath));

  // 10) 票据协议:动作不符 / 票号缺失
  writeFileSync(join(cwd, "d.txt"), "d\n", "utf8");
  const dTicket = await bridge.call("gitChangesCheck", { cwd, op: "stage-file", path: "d.txt" });
  const mismatch = await bridge.call("gitChangesWrite", {
    cwd,
    op: "unstage",
    path: "d.txt",
    ticketId: dTicket.ticket?.id,
    requestId: "changes-mismatch-1",
    confirm: true,
  });
  check(
    "changes: 拿暂存票去撤回暂存 → ticket-op-mismatch",
    mismatch.ok === false && mismatch.error?.reason === "ticket-op-mismatch",
    short(mismatch)
  );
  const noTicket = await bridge.call("gitChangesWrite", { cwd, op: "stage-file", path: "d.txt", ticketId: "", requestId: "" });
  check("changes: 缺票号 → ticket-missing", noTicket.ok === false && noTicket.error?.reason === "ticket-missing", short(noTicket));

  // 11) 路径边界
  const outside = mkdtempSync(join(tmpdir(), "t03-vc-outside-"));
  try {
    const bd = await bridge.call("gitChangesCheck", { cwd: outside, op: "stage-file", path: "x.txt" });
    check("changes: 越界 cwd 回 boundary", bd.ok === false && bd.error?.kind === "boundary", short(bd));
    check("changes: boundary 人话写明只能在工作区根内", /只能在工作区根内/.test(bd.error?.message || ""), short(bd.error?.message));
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
}

// ---- 提交域:gitCommitForm / gitWriteCheck → gitCommit ----------------------------------------
async function sliceCommit(bridge, ws, cacheDir) {
  const cwd = initRepo(join(ws, "commit-repo"));
  writeFileSync(join(cwd, ".gitmessage"), "提交模板第一行\n请写清动机\n", "utf8");
  writeFileSync(join(cwd, "x.txt"), "x1\n", "utf8");
  writeFileSync(join(cwd, "y.txt"), "y1\n", "utf8");
  gitIn(cwd, "config", "commit.template", ".gitmessage");
  commitAll(cwd, "first commit");

  // 1) 表单读取:身份 / 模板 / 上一条提交
  const form = await bridge.call("gitCommitForm", { cwd });
  check("commit: gitCommitForm ok", form.ok === true, short(form.error || form));
  check("commit: 表单读到本仓身份", form.identity?.name === "T03 Tester" && form.identity?.email === "t03@example.com", short(form.identity));
  check("commit: 表单读到提交模板全文", form.template?.configured === true && form.template?.text?.includes("提交模板第一行") && form.template?.problem === "", short(form.template));
  check("commit: 表单读到上一条提交(可用且主题一致)", form.amend?.available === true && form.amend?.subject === "first commit", short(form.amend));
  check("commit: 表单带追加签名行", /Signed-off-by: T03 Tester <t03@example.com>/.test(form.trailer || ""), short(form.trailer));

  // 2) 多文件暂存 → 预检 → 提交
  writeFileSync(join(cwd, "x.txt"), "x1\nx2\n", "utf8");
  writeFileSync(join(cwd, "y.txt"), "y1\ny2\n", "utf8");
  const staged = await bridge.call("gitStage", { cwd, paths: ["x.txt", "y.txt"] });
  check("commit: gitStage 多文件暂存 ok", staged.ok === true && (staged.staged || []).length === 2, short(staged.error || staged));
  const headBefore = gitIn(cwd, "rev-parse", "HEAD").trim();
  const message = "t03: 两个文件一起提交";
  const plan = { mode: "staged", target: "", skipHooks: false, sign: false, signoff: false };
  const wc = await bridge.call("gitWriteCheck", { cwd, op: "commit", plan, message });
  check("commit: gitWriteCheck ok 且判定 allow", wc.ok === true && wc.decision?.verdict === "allow", short(wc.error || wc));
  check("commit: 预检票绑 commit 动作", wc.ticket?.op === "commit" && typeof wc.ticket?.id === "string", short(wc.ticket));
  const cm = await bridge.call("gitCommit", { cwd, ticketId: wc.ticket?.id, requestId: "commit-1", message, plan });
  check("commit: gitCommit ok 且 committed", cm.ok === true && cm.committed === true && cm.mode === "staged", short(cm.error || cm));
  check("commit: HEAD 前进了", typeof cm.headAfter === "string" && cm.headAfter.length > 0 && cm.headAfter !== cm.headBefore && cm.headBefore === headBefore, short({ before: cm.headBefore, after: cm.headAfter, headBefore }));

  // 3) 提交后:历史多一条、暂存区干净、文件集正确
  const log = await bridge.call("gitLog", { cwd });
  check("commit: gitLog 多一条且标题为这次消息", log.ok === true && log.commits?.length === 2 && log.commits[0]?.subject === message, short(log.commits?.map((c) => c.subject)));
  const after = await statusOf(bridge, cwd);
  check("commit: 提交后暂存区干净", after && (after.staged || []).length === 0, short(after?.staged));
  check("commit: 提交后工作区也干净", after && (after.unstaged || []).length === 0, short(after?.unstaged));
  const names = gitIn(cwd, "show", "--name-only", "--format=", "HEAD").trim().split("\n").sort();
  check("commit: 这次提交的文件集含 x.txt 与 y.txt", names.join(",") === "x.txt,y.txt", short(names));

  // 4) 同一个 requestId 再问一次:上游写层直接回上次那份结论(不另加 reused 标记,也不再执行)
  const replay = await bridge.call("gitCommit", { cwd, ticketId: wc.ticket?.id, requestId: "commit-1", message, plan });
  check(
    "commit: 同 requestId 回放上次结论(同一 headAfter)",
    replay.ok === true && replay.committed === true && replay.headAfter === cm.headAfter,
    short(replay)
  );
  const logAfterReplay = await bridge.call("gitLog", { cwd });
  check("commit: 回放不再产生提交", logAfterReplay.commits?.length === 2, short(logAfterReplay.commits?.length));

  // 5) 坏计划:缺吸收目标,零 git 进程
  const badPlan = await bridge.call("gitCommit", { cwd, ticketId: "whatever", requestId: "commit-badplan", message: "x", plan: { mode: "fixup", target: "" } });
  check(
    "commit: fixup 缺目标 → need-commit-target(参数错,非挂起)",
    badPlan.ok === false && badPlan.error?.kind === "args" && badPlan.error?.reason === "need-commit-target",
    short(badPlan)
  );

  // 6) 空说明:先有暂存内容,再被说明校验挡住
  writeFileSync(join(cwd, "z.txt"), "z1\n", "utf8");
  const zStage = await bridge.call("gitStage", { cwd, paths: ["z.txt"] });
  check("commit: 为说明校验暂存 z.txt", zStage.ok === true, short(zStage.error || zStage));
  const emptyMsg = await bridge.call("gitWriteCheck", { cwd, op: "commit", plan, message: "   " });
  check("commit: 空说明 → empty-message", emptyMsg.ok === false && emptyMsg.error?.reason === "empty-message", short(emptyMsg));

  // 7) 过期票:时间推过 TTL(120 秒),执行必须回 ticket-expired 且 HEAD 不动
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  try {
    const expBridge = await import(pathToFileURL(DIST_GIT).href).then((m) => m.createGitBridge({ workspaceRoot: ws, env: BASE_ENV, cacheDir }));
    const expCheck = await expBridge.call("gitWriteCheck", { cwd, op: "commit", plan, message: "不该落地的提交" });
    check("commit: 过期用例的预检 ok", expCheck.ok === true && typeof expCheck.ticket?.id === "string", short(expCheck.error || expCheck));
    offset = 121000; // 越过 config/ttl.yaml 的 ticketTtlMs(120000)
    const expCommit = await expBridge.call("gitCommit", { cwd, ticketId: expCheck.ticket?.id, requestId: "commit-expired-1", message: "不该落地的提交", plan });
    check(
      "commit: 过期票 → ticket-expired(参数门先拒,零写命令)",
      expCommit.ok === false && expCommit.error?.kind === "args" && expCommit.error?.reason === "ticket-expired",
      short(expCommit)
    );
  } finally {
    Date.now = realNow;
  }
  check("commit: 过期票那次没有产生提交", gitIn(cwd, "log", "--format=%s").trim().split("\n").length === 2, gitIn(cwd, "log", "--format=%s"));

  // 8) 路径边界
  const outside = mkdtempSync(join(tmpdir(), "t03-vc-cout-"));
  try {
    const bd = await bridge.call("gitCommitForm", { cwd: outside });
    check("commit: 越界 cwd 回 boundary", bd.ok === false && bd.error?.kind === "boundary", short(bd));
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
}

// ---- 同步域:gitSyncCheck → gitSyncWrite(fetch / pull / push) ---------------------------------
async function sliceSync(bridge, ws, cacheDir) {
  const origin = join(ws, "origin.git");
  mkdirSync(origin, { recursive: true });
  gitIn(origin, "init", "--bare", "-b", "main");
  const cwd = initRepo(join(ws, "sync-repo"));
  writeFileSync(join(cwd, "a.txt"), "base\n", "utf8");
  commitAll(cwd, "base");
  gitIn(cwd, "remote", "add", "origin", asGitPath(origin));
  gitIn(cwd, "push", "-u", "origin", "main");
  const salt = String(Date.now()).slice(-7);
  const rid = (tag) => `t03-${salt}-${tag}`;

  // 非交互环境:pre-push 钩子把 git 进程实际拿到的三个开关记下来
  const hookOut = join(ws, "push-hook-env.txt");
  writeHook(cwd, "pre-push", hookOut, ["GIT_EDITOR", "GIT_TERMINAL_PROMPT", "GIT_ASKPASS"]);

  // 1) 本地领先一条 → push(带票、带确认)
  writeFileSync(join(cwd, "a.txt"), "base\nlocal\n", "utf8");
  gitIn(cwd, "commit", "-am", "local ahead");
  const localHead = gitIn(cwd, "rev-parse", "HEAD").trim();
  const before = await statusOf(bridge, cwd);
  check("sync: push 前分支为 main 且领先 1", before?.identity?.branch === "main" && before?.identity?.ahead === 1 && before?.identity?.behind === 0, short(before?.identity));
  const pc = await bridge.call("gitSyncCheck", { cwd, action: "push", localBranch: "main", branch: "main" });
  check("sync: push 预检 ok 且要确认", pc.ok === true && pc.confirmRequired === true, short(pc.error || { decision: pc.decision, confirm: pc.confirmRequired }));
  check("sync: push 票据形状与票面目标", typeof pc.ticket?.id === "string" && pc.plan?.action === "push" && /origin\/main/.test(pc.plan?.targetText || ""), short({ ticket: pc.ticket, plan: pc.plan }));
  const pw = await bridge.call("gitSyncWrite", { cwd, ticketId: pc.ticket?.id, action: "push", requestId: rid("push"), confirmed: true });
  check("sync: push 执行 ok 且起了 push 长任务", pw.ok === true && pw.task?.op === "push" && typeof pw.task?.taskId === "string", short(pw.error || pw.task));
  const pushDone = await pollTask(bridge, pw.task?.taskId);
  check("sync: push 任务成功退出", pushDone.task?.conclusion === "succeeded" && pushDone.task?.exitCode === 0, short(pushDone.task));
  check("sync: push 后远端 main 与本地一致", gitIn(origin, "rev-parse", "main").trim() === localHead, short({ origin: gitIn(origin, "rev-parse", "main"), local: localHead }));
  const afterPush = await statusOf(bridge, cwd);
  check("sync: push 后领先归零", afterPush?.identity?.ahead === 0, short(afterPush?.identity));
  const hookEnv = existsSync(hookOut) ? readFileSync(hookOut, "utf8") : "";
  check("sync: pre-push 钩子看到 GIT_EDITOR=false", /^GIT_EDITOR=false$/m.test(hookEnv), hookEnv || "(钩子没跑)");
  check("sync: pre-push 钩子看到 GIT_TERMINAL_PROMPT=0", /^GIT_TERMINAL_PROMPT=0$/m.test(hookEnv), hookEnv || "(钩子没跑)");
  check("sync: pre-push 钩子看到 GIT_ASKPASS=false", /^GIT_ASKPASS=false$/m.test(hookEnv), hookEnv || "(钩子没跑)");

  // 2) 同一 requestId 回放:不再起第二条任务
  const pushReplay = await bridge.call("gitSyncWrite", { cwd, ticketId: pc.ticket?.id, action: "push", requestId: rid("push"), confirmed: true });
  check("sync: 同 requestId 回放 reused=true", pushReplay.ok === true && pushReplay.reused === true, short(pushReplay));

  // 3) 另一份克隆把远端推前一条 → fetch 后本地落后 1
  const clone = join(ws, "sync-clone");
  gitIn(ws, "clone", asGitPath(origin), clone);
  gitIn(clone, "config", "user.email", "clone@example.com");
  gitIn(clone, "config", "user.name", "Clone Tester");
  writeFileSync(join(clone, "b.txt"), "remote\n", "utf8");
  commitAll(clone, "remote ahead");
  gitIn(clone, "push", "origin", "main");
  const remoteHead = gitIn(origin, "rev-parse", "main").trim();
  const stale = await statusOf(bridge, cwd);
  check("sync: 未 fetch 时本地还不知道落后(behind 0)", stale?.identity?.behind === 0, short(stale?.identity));
  const fc = await bridge.call("gitSyncCheck", { cwd, action: "fetch", remote: "origin" });
  check("sync: fetch 预检 ok", fc.ok === true && fc.confirmRequired === true, short(fc.error || fc));
  const fw = await bridge.call("gitSyncWrite", { cwd, ticketId: fc.ticket?.id, action: "fetch", requestId: rid("fetch"), confirmed: true });
  check("sync: fetch 执行 ok 且起了 fetch 长任务", fw.ok === true && fw.task?.op === "fetch", short(fw.error || fw.task));
  const fetchDone = await pollTask(bridge, fw.task?.taskId);
  check("sync: fetch 任务成功退出", fetchDone.task?.conclusion === "succeeded" && fetchDone.task?.exitCode === 0, short(fetchDone.task));
  const afterFetch = await statusOf(bridge, cwd);
  check("sync: fetch 后落后 1(领先 0)", afterFetch?.identity?.behind === 1 && afterFetch?.identity?.ahead === 0, short(afterFetch?.identity));

  // 4) 同步域的 pull:预检签票成立;执行层 argv 把「origin/main」当成仓库地址,
  //    这是上游 task-protocol 的既有缺陷(记录不修)。这里断言它是诚实失败、不挂起。
  const pc2 = await bridge.call("gitSyncCheck", { cwd, action: "pull-ff-only", upstream: "origin/main" });
  check("sync: pull 预检 ok 且计划为 ff-only", pc2.ok === true && pc2.plan?.taskArgs?.mode === "ff-only" && typeof pc2.ticket?.id === "string", short(pc2.error || pc2.plan));
  const startedAt = Date.now();
  const lw = await bridge.call("gitSyncWrite", { cwd, ticketId: pc2.ticket?.id, action: "pull-ff-only", requestId: rid("syncpull"), confirmed: true });
  const pullWriteMs = Date.now() - startedAt;
  check("sync: pull 执行回包 ok 且起了 pull 长任务", lw.ok === true && lw.task?.op === "pull", short(lw.error || lw.task));
  check("sync: pull 执回包没有挂起(<15s)", pullWriteMs < 15000, String(pullWriteMs));
  const pullDone = await pollTask(bridge, lw.task?.taskId);
  check(
    "sync: pull 任务诚实失败且点名 origin/main 不是仓库(上游 argv 缺陷)",
    pullDone.task?.conclusion === "failed" &&
      pullDone.task?.failureKind === "non-zero" &&
      typeof pullDone.task?.exitCode === "number" &&
      pullDone.task.exitCode > 0 &&
      /does not appear to be a git repository/.test(pullDone.task?.failureLine || ""),
    short(pullDone.task)
  );
  check("sync: pull 失败没有挂起(<30s)", pullDone.ms < 30000, String(pullDone.ms));
  const stillBehind = await statusOf(bridge, cwd);
  check("sync: pull 失败后本地没有动(仍落后 1)", stillBehind?.identity?.behind === 1 && gitIn(cwd, "rev-parse", "HEAD").trim() === localHead, short(stillBehind?.identity));

  // 5) 写域的 pull(按配置的上游,argv 是 git pull --ff-only):本地真的跟上远端
  const lc = await bridge.call("gitWriteCheck", { cwd, op: "pull" });
  check("sync: 写域 pull 预检 ok 且目标为 origin/main", lc.ok === true && lc.plan?.upstream === "origin/main", short(lc.error || lc.plan));
  const lp = await bridge.call("gitPull", { cwd, ticketId: lc.ticket?.id, requestId: rid("legacypull") });
  check("sync: 写域 pull ok 且快进", lp.ok === true && lp.mode === "fast-forward" && lp.headAfter === remoteHead, short(lp.error || lp));
  check("sync: pull 后本地取回远端那条提交(b.txt 出现、HEAD 一致)", existsSync(join(cwd, "b.txt")) && gitIn(cwd, "rev-parse", "HEAD").trim() === remoteHead, short({ head: gitIn(cwd, "rev-parse", "HEAD"), remoteHead }));
  const caught = await statusOf(bridge, cwd);
  check("sync: pull 后落后归零", caught?.identity?.behind === 0 && caught?.identity?.ahead === 0, short(caught?.identity));

  // 6) 需要确认的动作不带 confirmed:true → need-confirm,零进程
  writeFileSync(join(cwd, "c.txt"), "local\n", "utf8");
  commitAll(cwd, "local again");
  const nc = await bridge.call("gitSyncCheck", { cwd, action: "push", localBranch: "main", branch: "main" });
  check("sync: 再一次 push 预检 ok", nc.ok === true, short(nc.error || nc));
  const unconfirmed = await bridge.call("gitSyncWrite", { cwd, ticketId: nc.ticket?.id, action: "push", requestId: rid("noconfirm") });
  check(
    "sync: 不带 confirmed → need-confirm",
    unconfirmed.ok === false && unconfirmed.error?.kind === "need-confirm" && unconfirmed.reason === "need-confirm",
    short(unconfirmed)
  );
  const confirmed = await bridge.call("gitSyncWrite", { cwd, ticketId: nc.ticket?.id, action: "push", requestId: rid("confirm"), confirmed: true });
  const confirmDone = await pollTask(bridge, confirmed.task?.taskId);
  check("sync: 确认后同一张票可以推送成功", confirmed.ok === true && confirmDone.task?.conclusion === "succeeded", short({ err: confirmed.error, task: confirmDone.task }));

  // 7) 坏远端:bare 路径删掉后 fetch,任务必须快速失败并带 git 原话,不许挂起
  const broken = join(ws, "broken.git");
  mkdirSync(broken, { recursive: true });
  gitIn(broken, "init", "--bare", "-b", "main");
  gitIn(cwd, "remote", "add", "broken", asGitPath(broken));
  rmSync(broken, { recursive: true, force: true });
  const bc = await bridge.call("gitSyncCheck", { cwd, action: "fetch", remote: "broken" });
  check("sync: 坏远端预检仍 ok(现场判定不联网)", bc.ok === true, short(bc.error || bc));
  const badStarted = Date.now();
  const bw = await bridge.call("gitSyncWrite", { cwd, ticketId: bc.ticket?.id, action: "fetch", requestId: rid("broken"), confirmed: true });
  const badWriteMs = Date.now() - badStarted;
  check("sync: 坏远端执行回包 ok 且起了任务", bw.ok === true && typeof bw.task?.taskId === "string", short(bw.error || bw.task));
  check("sync: 坏远端执行回包没有挂起(<15s)", badWriteMs < 15000, String(badWriteMs));
  const badDone = await pollTask(bridge, bw.task?.taskId);
  check(
    "sync: 坏远端任务诚实失败(非零退出,带 git 原话)",
    badDone.task?.conclusion === "failed" &&
      badDone.task?.failureKind === "non-zero" &&
      badDone.task?.exitCode === 128 &&
      /does not appear to be a git repository/.test(badDone.task?.failureLine || ""),
    short(badDone.task)
  );
  check("sync: 坏远端失败没有挂起(<30s)", badDone.ms < 30000, String(badDone.ms));

  // 8) 坏参数 / 缺 cwd / 越界 cwd
  const badAction = await bridge.call("gitSyncCheck", { cwd, action: "merge-now" });
  check("sync: 不认识的同步动作 → bad-target/unknown-action", badAction.ok === false && badAction.error?.kind === "bad-target" && badAction.reason === "unknown-action", short(badAction));
  const badCwdType = await bridge.call("gitSyncCheck", { cwd: 42, action: "fetch" });
  check("sync: 非字符串 cwd → bad-args(不崩)", badCwdType.ok === false && badCwdType.error?.kind === "bad-args", short(badCwdType));
  const outside = mkdtempSync(join(tmpdir(), "t03-vc-sout-"));
  try {
    const bd = await bridge.call("gitSyncCheck", { cwd: outside, action: "fetch", remote: "origin" });
    check("sync: 越界 cwd 回 boundary", bd.ok === false && bd.error?.kind === "boundary", short(bd));
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }

  // 9) 长任务记录只落缓存目录,不落工作区/仓库
  check("sync: 任务记录落在 cacheDir", existsSync(join(cacheDir, "vc-task-events__tasks.json")), existsSync(cacheDir) ? readdirSync(cacheDir).join(",") : "(cacheDir 不存在)");
  check("sync: 工作区根没有任务记录文件", !existsSync(join(ws, "vc-task-events__tasks.json")));
  check("sync: 仓库根没有任务记录文件", !existsSync(join(cwd, "vc-task-events__tasks.json")));
}

// ---- 路由:起 dist/server.mjs,经 deck_git 走完一次写闭合 -------------------------------------
async function sliceServerRoute(ws) {
  const cwd = initRepo(join(ws, "server-repo"));
  writeFileSync(join(cwd, "s.txt"), "s1\n", "utf8");
  commitAll(cwd, "server base");
  writeFileSync(join(cwd, "s.txt"), "s1\ns2\n", "utf8");

  const child = spawn(process.execPath, [DIST_SERVER], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, ZCODE_WORKSPACE_ROOT: ws },
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
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
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
      setTimeout(() => reject(new Error("timeout waiting " + method)), 20000).unref?.();
    });
  const call = (name, args) => rpc("tools/call", { name, arguments: args });
  const sc = (reply) => reply?.result?.structuredContent || {};
  try {
    await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t03", version: "0" } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });

    const form = await call("deck_git", { method: "gitCommitForm", args: { cwd } });
    check("route: deck_git gitCommitForm 回结构化结果", form.result?.isError !== true && sc(form).ok === true && sc(form).identity?.email === "t03@example.com", short(sc(form)));

    const stage = sc(await call("deck_git", { method: "gitStage", args: { cwd, paths: ["s.txt"] } }));
    check("route: deck_git gitStage ok", stage.ok === true, short(stage));
    const wc = sc(await call("deck_git", { method: "gitWriteCheck", args: { cwd, op: "commit", plan: { mode: "staged" }, message: "server route commit" } }));
    check("route: deck_git gitWriteCheck ok", wc.ok === true && typeof wc.ticket?.id === "string", short(wc));
    const cm = sc(await call("deck_git", { method: "gitCommit", args: { cwd, ticketId: wc.ticket?.id, requestId: "route-1", message: "server route commit", plan: { mode: "staged" } } }));
    check("route: deck_git gitCommit ok", cm.ok === true && cm.committed === true, short(cm));
    const log = sc(await call("deck_git", { method: "gitLog", args: { cwd } }));
    check(
      "route: 经工具提交后 gitLog 两条且最新标题一致",
      log.ok === true && log.commits?.length === 2 && log.commits[0]?.subject === "server route commit",
      short(log.commits?.map((x) => x.subject))
    );

    const outside = mkdtempSync(join(tmpdir(), "t03-vc-rout-"));
    try {
      const bad = await call("deck_git", { method: "gitChangesCheck", args: { cwd: outside, op: "stage-file", path: "x.txt" } });
      check("route: deck_git 越界 cwd 回 boundary(非工具级错误)", bad.result?.isError !== true && sc(bad).ok === false && sc(bad).error?.kind === "boundary", short(sc(bad)));
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    child.stdin.end();
    const exit = new Promise((r) => child.on("exit", r));
    const paused = new Promise((r) => {
      const t = setTimeout(r, 3000);
      if (t.unref) t.unref();
    });
    await Promise.race([exit, paused]);
    try {
      child.kill();
    } catch {
      /* 已经退出 */
    }
  }
}

// ---- 入口 ------------------------------------------------------------------------------------
const BASE_ENV = {
  ...process.env,
  // 故意把继承环境里的交互开关设成「会问人」的样子:下游必须自己覆盖成非交互值。
  GIT_EDITOR: "/t03/editor-that-must-not-run",
  GIT_TERMINAL_PROMPT: "1",
  GIT_ASKPASS: "/t03/askpass-that-must-not-run",
};

if (!existsSync(DIST_GIT) || !existsSync(DIST_SERVER)) {
  console.error("FAIL - 先跑 node build.mjs(dist/git.mjs 或 dist/server.mjs 不存在)");
  process.exit(1);
}
const { createGitBridge } = await import(pathToFileURL(DIST_GIT).href);
const ws = makeWorkspace();
const cacheDir = join(ws, ".vc-cache");
const bridge = createGitBridge({ workspaceRoot: ws, env: BASE_ENV, cacheDir });
try {
  await sliceChanges(bridge, ws);
  await sliceCommit(bridge, ws, cacheDir);
  await sliceSync(bridge, ws, cacheDir);
  await sliceServerRoute(ws);
} catch (e) {
  failures++;
  console.error("FAIL - 套件异常 :: " + (e && e.stack ? e.stack : e));
} finally {
  rmSync(ws, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} 条断言失败`);
  process.exit(1);
}
console.log("\nserver-git-writes: 全部断言通过");
// 上游命令预算计时器(20s/120s)还在事件循环里;断言已全部结束,直接收尾,不为它们空等。
process.exit(0);
