// 工单 05 缝:改写/变基/冲突/子模块四组危险电话在真 git 仓上的契约。
//
// 真仓纪律:mkdtemp + git init(本机 git),子模块源用本地 bare 仓;每个用例一个一次性仓,
// 结束(含断言失败)统一删临时目录;危险动作只在临时仓里跑。经 dist/git.mjs 的 bridge 逐条拨电话,
// 断言只读外部可观察行为:回包里的 ok/reason/ticket/recovery/task,以及 git 自己的状态与工作区文件。
//
// filter-repo 两分支:用 PATH 前置的假 git-filter-repo 决定「不可用(退出 1)/可用(报版本并成功)」,
// 两种都在本机可复现;可用分支断言「先落备份、再起长任务」,不可用分支断言上游的 tool-missing 诚实错误。
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // zcode-plugin/
const DIST_GIT = join(ROOT, "dist", "git.mjs");

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`ok - ${name}`);
  else {
    failures++;
    console.error(`FAIL - ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

const TEMPS = [];
function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  TEMPS.push(dir);
  return dir;
}
function track(path) {
  TEMPS.push(path);
  return path;
}
function rmrf(path) {
  try { rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch (e) { /* 清理失败不掩盖断言 */ }
}
function cleanupAll() {
  while (TEMPS.length > 0) rmrf(TEMPS.pop());
}

/** 一次性真仓:mkdtemp + git init -b main + 身份;返回 git 包装(输出已 trim)与独立缓存目录。 */
function makeRepo(prefix) {
  const dir = tmp(prefix);
  const cacheDir = tmp(prefix + "cache-");
  const raw = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const git = (...args) => String(raw(...args)).trim();
  git("init", "-b", "main");
  git("config", "user.email", "t05@example.com");
  git("config", "user.name", "T05 Tester");
  git("config", "core.autocrlf", "false");
  git("config", "protocol.file.allow", "always");
  return { dir, cacheDir, git, raw, bridge: null };
}

/** 给仓库接一条 bridge(可注入 PATH/now)。同一仓可重建,票据表随之新建。 */
function bridgeOf(repo, opts = {}) {
  const bridge = createGitBridge({
    workspaceRoot: repo.dir,
    env: opts.env || process.env,
    now: opts.now,
    cacheDir: repo.cacheDir,
  });
  repo.bridge = bridge;
  repo.call = (method, args) => bridge.call(method, { cwd: repo.dir, ...args });
  return bridge;
}

/** 三提交基线:a.txt / b.txt / c.txt。 */
function baseRepo(prefix) {
  const r = makeRepo(prefix);
  writeFileSync(join(r.dir, "a.txt"), "line1\nline2\nline3\n");
  r.git("add", "a.txt");
  r.git("commit", "-m", "one");
  writeFileSync(join(r.dir, "b.txt"), "b1\n");
  r.git("add", "b.txt");
  r.git("commit", "-m", "two");
  writeFileSync(join(r.dir, "c.txt"), "c1\n");
  r.git("add", "c.txt");
  r.git("commit", "-m", "three");
  return r;
}

/** 同一行冲突:feature 与 main 都改 a.txt 第二行。返回 base/main/feature 的提交号。 */
function conflictRepo(prefix) {
  const r = makeRepo(prefix);
  writeFileSync(join(r.dir, "a.txt"), "line1\nline2\nline3\n");
  r.git("add", "a.txt");
  r.git("commit", "-m", "base");
  const baseOid = r.git("rev-parse", "HEAD");
  r.git("checkout", "-b", "feature");
  writeFileSync(join(r.dir, "a.txt"), "line1\nFEATURE\nline3\n");
  r.git("commit", "-am", "feature edit");
  const featureOid = r.git("rev-parse", "HEAD");
  r.git("checkout", "main");
  writeFileSync(join(r.dir, "a.txt"), "line1\nMAIN\nline3\n");
  r.git("commit", "-am", "main edit");
  const mainOid = r.git("rev-parse", "HEAD");
  return { r, baseOid, featureOid, mainOid };
}

/** 变基撞冲突:topic 与 main 都改 a.txt 同一行,topic 当前检出。 */
function rebaseConflictRepo(prefix) {
  const x = baseRepo(prefix);
  const baseOid = x.git("rev-parse", "HEAD~1");
  x.git("checkout", "-b", "topic", baseOid);
  writeFileSync(join(x.dir, "a.txt"), "line1\nTOPIC\nline3\n");
  x.git("commit", "-am", "topic edit");
  const topicOid = x.git("rev-parse", "HEAD");
  x.git("checkout", "main");
  writeFileSync(join(x.dir, "a.txt"), "line1\nMAIN2\nline3\n");
  x.git("commit", "-am", "main edit");
  x.git("checkout", "topic");
  return { x, baseOid, topicOid };
}

/** 假 git-filter-repo:kind=no 退出 1(模拟缺席);kind=yes 报版本、其余参数成功退出。 */
function fakeFilterRepo(kind) {
  const dir = tmp(kind === "yes" ? "t05-filter-yes-" : "t05-filter-no-");
  const script = join(dir, "git-filter-repo");
  writeFileSync(
    script,
    kind === "yes"
      ? "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'git-filter-repo 2.38.0'; exit 0; fi\nexit 0\n"
      : "#!/bin/sh\nexit 1\n"
  );
  try { chmodSync(script, 0o755); } catch (e) { /* Windows 不靠执行位 */ }
  return dir;
}

/** 轮询任务到 done;超时回 null。 */
async function waitTask(repo, taskId) {
  for (let i = 0; i < 200; i += 1) {
    const q = await repo.call("gitTaskQuery", {});
    const task = (q.tasks || []).find((t) => t.taskId === taskId);
    if (task && task.state === "done") return task;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

const isHexOid = (v) => /^[0-9a-f]{40,64}$/.test(String(v || ""));

// ---------------------------------------------------------------------------
// 切片 1:历史改写五条动作(恢复点、恢复、说明、拣选)
// ---------------------------------------------------------------------------
async function undoSlice() {
  // reset-soft:HEAD 退回上一提交,改动留在暂存区
  {
    const r = baseRepo("t05-undo-soft-");
    bridgeOf(r);
    const before = r.git("rev-parse", "HEAD");
    const c = await r.call("gitUndoCheck", { op: "reset-soft", target: "HEAD~1" });
    check("undo/reset-soft:预检 ok 且不危险", c.ok === true && c.danger === false && c.contract === "version-control.undo-check", JSON.stringify(c.error || c));
    check("undo/reset-soft:计划解析到提交号并给出 reset --soft 一步", isHexOid(c.plan?.targetOid) && c.steps?.length === 1 && c.steps[0][0] === "reset" && c.steps[0][1] === "--soft", JSON.stringify(c.steps));
    const w = await r.call("gitUndoWrite", { op: "reset-soft", target: "HEAD~1", ticketId: c.ticket.id, requestId: "undo-soft-1" });
    check("undo/reset-soft:凭票执行 ok 且 HEAD 到目标", w.ok === true && w.after?.headOid === c.plan.targetOid && w.before?.headOid === before, JSON.stringify(w.error || w));
    const status = r.git("status", "--porcelain");
    check("undo/reset-soft:c.txt 落在暂存区", /^A\s+c\.txt$/m.test(status), status);
  }

  // reset-mixed:HEAD 退回,改动落回工作区
  {
    const r = baseRepo("t05-undo-mixed-");
    bridgeOf(r);
    const c = await r.call("gitUndoCheck", { op: "reset-mixed", target: "HEAD~1" });
    check("undo/reset-mixed:预检 ok", c.ok === true, JSON.stringify(c.error || c));
    const w = await r.call("gitUndoWrite", { op: "reset-mixed", target: "HEAD~1", ticketId: c.ticket.id, requestId: "undo-mixed-1" });
    check("undo/reset-mixed:凭票执行 ok", w.ok === true && w.after?.headOid === c.plan.targetOid, JSON.stringify(w.error || w));
    const status = r.git("status", "--porcelain");
    check("undo/reset-mixed:c.txt 回到未跟踪工作区", /^\?\?\s+c\.txt$/m.test(status), status);
  }

  // reset-hard:恢复点在危险动作前给出,按恢复点能真的还原
  {
    const r = baseRepo("t05-undo-hard-");
    bridgeOf(r);
    const before = r.git("rev-parse", "HEAD");
    const c = await r.call("gitUndoCheck", { op: "reset-hard", target: "HEAD~1" });
    check("undo/reset-hard:预检标危险并带恢复点", c.ok === true && c.danger === true && c.recovery?.kind === "reset-hard" && c.recovery?.required === true, JSON.stringify(c.error || c.recovery));
    check("undo/reset-hard:恢复点记下旧 HEAD、丢弃计数与移出提交数", c.recovery?.restore?.headOid === before && c.recovery?.discard?.files >= 1 && c.recovery?.commits === 1, JSON.stringify(c.recovery));
    const w = await r.call("gitUndoWrite", { op: "reset-hard", target: "HEAD~1", ticketId: c.ticket.id, requestId: "undo-hard-1" });
    check("undo/reset-hard:凭票执行 ok 且回包带回同一恢复点", w.ok === true && w.after?.headOid === c.plan.targetOid && w.recovery?.restore?.headOid === before, JSON.stringify(w.error || w));
    check("undo/reset-hard:工作区干净且 c.txt 已消失", r.git("status", "--porcelain") === "" && !existsSync(join(r.dir, "c.txt")));
    r.git("reset", "-q", "--hard", w.recovery.restore.headOid);
    check("undo/reset-hard:按恢复点 reset 回危险动作前的 HEAD", r.git("log", "--format=%s", "-1") === "three" && existsSync(join(r.dir, "c.txt")));
  }

  // revert:两步(反向改动进索引 + 自己提交),默认说明来自目标提交标题
  {
    const r = baseRepo("t05-undo-revert-");
    bridgeOf(r);
    const before = r.git("rev-parse", "HEAD");
    const c = await r.call("gitUndoCheck", { op: "revert", target: "HEAD" });
    check("undo/revert:预检给出两步与默认说明", c.ok === true && c.steps?.length === 2 && c.plan?.message === 'Revert "three"' && c.defaultMessage === 'Revert "three"', JSON.stringify(c.error || { plan: c.plan, steps: c.steps }));
    const w = await r.call("gitUndoWrite", { op: "revert", target: "HEAD", message: c.plan.message, ticketId: c.ticket.id, requestId: "undo-revert-1" });
    check("undo/revert:凭票执行两步都完成", w.ok === true && w.stepsDone === 2 && w.after?.headOid !== before, JSON.stringify(w.error || w));
    check("undo/revert:新提交标题是默认还原说明", r.git("log", "--format=%s", "-1") === 'Revert "three"');
  }

  // cherry-pick:按给的目标提交号拣选;已在历史里的提交被预检拒掉
  {
    const r = baseRepo("t05-undo-pick-");
    bridgeOf(r);
    r.git("checkout", "-b", "side", "HEAD~1");
    writeFileSync(join(r.dir, "side.txt"), "side\n");
    r.git("add", "side.txt");
    r.git("commit", "-m", "side commit");
    const sideOid = r.git("rev-parse", "HEAD");
    r.git("checkout", "main");
    const c = await r.call("gitUndoCheck", { op: "cherry-pick", commits: sideOid });
    check("undo/cherry-pick:预检把提交解析成提交号并拼一条命令", c.ok === true && c.plan?.commits?.[0]?.oid === sideOid && c.steps?.[0]?.[0] === "cherry-pick", JSON.stringify(c.error || c.plan));
    const w = await r.call("gitUndoWrite", { op: "cherry-pick", commits: sideOid, ticketId: c.ticket.id, requestId: "undo-pick-1" });
    check("undo/cherry-pick:凭票执行 ok 且新提交落地", w.ok === true && w.stepsDone === 1 && r.git("log", "--format=%s", "-1") === "side commit", JSON.stringify(w.error || w));
    const dup = await r.call("gitUndoCheck", { op: "cherry-pick", commits: ["HEAD"] });
    check("undo/cherry-pick:已在历史里的提交被预检拒(commit-already-present)", dup.ok === false && dup.error?.kind === "blocked" && dup.error?.reason === "commit-already-present", JSON.stringify(dup.error || dup));
  }

  // 坏参数:不认识的动作
  {
    const r = baseRepo("t05-undo-bad-");
    bridgeOf(r);
    const bad = await r.call("gitUndoCheck", { op: "reset-nope", target: "HEAD" });
    check("undo:不认识的动作回 usage/unknown-op", bad.ok === false && bad.error?.kind === "usage" && bad.error?.reason === "unknown-op", JSON.stringify(bad.error || bad));
  }
}

// ---------------------------------------------------------------------------
// 切片 2:过期票 + 路径边界(now 注入模拟 120 秒票据时限)
// ---------------------------------------------------------------------------
async function ticketAndBoundarySlice() {
  const r = baseRepo("t05-expiry-");
  let fakeNow = Date.now();
  bridgeOf(r, { now: () => fakeNow });
  const c = await r.call("gitUndoCheck", { op: "reset-soft", target: "HEAD~1" });
  check("过期票:预检签出 120 秒票", c.ok === true && c.ticket?.expiresAtMs - c.ticket?.checkedAtMs === 120000, JSON.stringify(c.ticket));
  fakeNow += 121000;
  const before = r.git("rev-parse", "HEAD");
  const w = await r.call("gitUndoWrite", { op: "reset-soft", target: "HEAD~1", ticketId: c.ticket.id, requestId: "expired-1" });
  check("过期票:执行回 stale/ticket-expired,零命令", w.ok === false && w.error?.kind === "stale" && w.error?.reason === "ticket-expired" && r.git("rev-parse", "HEAD") === before, JSON.stringify(w.error || w));

  const outside = tmp("t05-outside-");
  const out = await r.call("gitUndoCheck", { cwd: outside, op: "reset-soft", target: "HEAD~1" });
  check("路径边界:cwd 越界回 boundary", out.ok === false && out.error?.kind === "boundary", JSON.stringify(out.error || out));
  check("路径边界:人话写明只能在工作区根内", /只能在工作区根内/.test(out.error?.message || ""), out.error?.message);
}

// ---------------------------------------------------------------------------
// 切片 3:整仓重写 —— 只读预览 / 签票 / filter-repo 缺席与可用两分支
// ---------------------------------------------------------------------------
async function rewriteSlice() {
  // 缺席:预览可用,预检在签票前就拦住(tool-missing),执行不会挂起
  {
    const r = baseRepo("t05-rewrite-no-");
    bridgeOf(r, { env: { ...process.env, PATH: fakeFilterRepo("no") + delimiter + (process.env.PATH || "") } });
    const pv = await r.call("gitRewritePreview", { plan: { form: "remove-paths", paths: ["a.txt"] } });
    check("rewrite/缺席:只读预览 ok 且给出计数与命令原文", pv.ok === true && pv.preview?.counts?.commits === 3 && pv.preview?.counts?.matchedCommits === 1 && /filter-repo --force --invert-paths --path a\.txt/.test(pv.preview?.command || ""), JSON.stringify(pv.error || pv.preview));
    const before = r.git("rev-parse", "HEAD");
    const ck = await r.call("gitRewriteCheck", { plan: { form: "remove-paths", paths: ["a.txt"] } });
    check("rewrite/缺席:预检回 blocked/tool-missing 且不签票", ck.ok === false && ck.error?.kind === "blocked" && ck.reason === "tool-missing" && ck.decision?.verdict === "block" && !ck.ticket, JSON.stringify(ck.error || ck));
    check("rewrite/缺席:现场如实报 filterRepoAvailable=false", ck.scene?.filterRepoAvailable === false && ck.filterRepoVersion === "", JSON.stringify(ck.scene));
    const run = await r.call("gitRewriteRun", { ticketId: "missingticket1", requestId: "rewrite-missing-1", confirmed: true });
    check("rewrite/缺席:无票执行回 ticket-missing(不静默/不挂起)", run.ok === false && run.error?.reason === "ticket-missing", JSON.stringify(run.error || run));
    check("rewrite/缺席:预览与预检都没动 HEAD", r.git("rev-parse", "HEAD") === before);
  }

  // 可用:预检签票 + 备份点;执行先落备份再起 filter-repo 长任务
  {
    const r = baseRepo("t05-rewrite-yes-");
    bridgeOf(r, { env: { ...process.env, PATH: fakeFilterRepo("yes") + delimiter + (process.env.PATH || "") } });
    const ck = await r.call("gitRewriteCheck", { plan: { form: "remove-paths", paths: ["a.txt"] } });
    check("rewrite/可用:预检 ok、要确认、带强制备份计划", ck.ok === true && ck.confirmRequired === true && ck.backup?.required === true && String(ck.backup?.path || "") !== "", JSON.stringify(ck.error || { backup: ck.backup, decision: ck.decision }));
    check("rewrite/可用:现场报 filterRepoAvailable=true", ck.scene?.filterRepoAvailable === true, JSON.stringify(ck.scene));
    track(ck.backup.path);
    const rw = await r.call("gitRewriteRun", { ticketId: ck.ticket.id, requestId: "rewrite-yes-1", confirmed: true });
    check("rewrite/可用:执行先备份后起任务(steps=[backup,task])", rw.ok === true && Array.isArray(rw.steps) && rw.steps[0] === "backup" && rw.steps[1] === "task", JSON.stringify(rw.error || rw));
    check("rewrite/可用:备份点落在磁盘上且大小可读", rw.ok === true && existsSync(ck.backup.path) && rw.backup?.bytes > 0, JSON.stringify(rw.backup));
    check("rewrite/可用:长任务拿到 filter-repo 任务号", rw.task?.ok === true && !!rw.task?.task?.taskId && rw.task?.task?.op === "filter-repo", JSON.stringify(rw.task));
    const done = await waitTask(r, rw.task.task.taskId);
    check("rewrite/可用:滤器长任务跑完(succeeded)", done?.conclusion === "succeeded" && done?.exitCode === 0, JSON.stringify(done));
    const replay = await r.call("gitRewriteRun", { ticketId: ck.ticket.id, requestId: "rewrite-yes-1", confirmed: true });
    check("rewrite/可用:同一 requestId 重放回同一份结果(reused)", replay.ok === true && replay.reused === true, JSON.stringify(replay));
    check("rewrite/可用:任务记录不落进仓库工作区", !existsSync(join(r.dir, "vc-task-events__tasks.json")), readdirSync(r.dir).join(","));
  }
}

// ---------------------------------------------------------------------------
// 切片 4:变基待办 —— 只读窗口 / 重排改写 / 撞冲突后的继续、跳过、中止
// ---------------------------------------------------------------------------
async function rebaseSlice() {
  // 无冲突 rebase-todo:重排里带一条 reword,走临时待办 + GIT_SEQUENCE_EDITOR
  {
    const r = baseRepo("t05-rebase-todo-");
    bridgeOf(r);
    const st = await r.call("gitRebaseRead", { op: "rebase-state" });
    check("rebase:rebase-state 只读 ok 且当前可变基", st.ok === true && st.state === null && st.canRebase === true, JSON.stringify(st.error || st));
    const win = await r.call("gitRebaseRead", { op: "rebase-window", base: "HEAD~2" });
    check("rebase:rebase-window 读出两条待办(旧到新)", win.ok === true && win.commitCount === 2 && win.commits?.[0]?.subject === "two" && win.commits?.[1]?.subject === "three", JSON.stringify(win.error || win.commits));
    const rows = win.commits.map((one, i) => (i === 1 ? { oid: one.oid, action: "reword", message: "renamed three" } : { oid: one.oid, action: "pick" }));
    const c = await r.call("gitRebaseCheck", { op: "rebase-todo", base: "HEAD~2", rows });
    check("rebase:rebase-todo 预检 ok 且把窗口行收进计划", c.ok === true && c.plan?.rows?.length === 2 && c.plan?.rows?.[1]?.action === "reword" && c.extra?.windowCount === 2, JSON.stringify(c.error || c.plan));
    const w = await r.call("gitRebaseWrite", { op: "rebase-todo", base: "HEAD~2", rows, ticketId: c.ticket.id, requestId: "rebase-todo-1", confirmed: true });
    check("rebase:rebase-todo 凭票执行 ok 且回到干净状态", w.ok === true && w.conflicted === false && w.state === null, JSON.stringify(w.error || w));
    check("rebase:改说明的提交标题落地", r.git("log", "--format=%s", "-3") === "renamed three\ntwo\none", r.git("log", "--format=%s", "-3"));
  }

  // rebase-onto 撞冲突 → 跳过
  {
    const { x, baseOid } = rebaseConflictRepo("t05-rebase-skip-");
    bridgeOf(x);
    const range = await x.call("gitRebaseRead", { op: "rebase-onto-range", oldBase: baseOid, newBase: "main" });
    check("rebase:rebase-onto-range 读出搬走 1 条、新基座带来 2 条", range.ok === true && range.movedCount === 1 && range.incomingCount === 2, JSON.stringify(range.error || { moved: range.movedCount, incoming: range.incomingCount }));
    const c = await x.call("gitRebaseCheck", { op: "rebase-onto", oldBase: baseOid, newBase: "main" });
    check("rebase:rebase-onto 预检 ok 并签票", c.ok === true && !!c.ticket?.id, JSON.stringify(c.error || c));
    const w = await x.call("gitRebaseWrite", { op: "rebase-onto", oldBase: baseOid, newBase: "main", ticketId: c.ticket.id, requestId: "rebase-skip-1", confirmed: true });
    check("rebase:onto 撞冲突如实回 conflicted 且 state=rebase", w.ok === true && w.conflicted === true && w.state === "rebase", JSON.stringify(w.error || w));
    const st = await x.call("gitRebaseRead", { op: "rebase-state" });
    check("rebase:冲突中读状态为 rebase 且不可再变基", st.ok === true && st.state === "rebase" && st.canRebase === false, JSON.stringify(st.error || st));
    const list = await x.call("gitConflicts", { op: "conflict-list" });
    check("rebase:冲突清单看得到同一行冲突", list.ok === true && list.state === "rebase" && list.conflictCount === 1 && list.conflicts?.[0]?.path === "a.txt", JSON.stringify(list.error || list));
    const sc = await x.call("gitConflictCheck", { op: "op-skip" });
    check("rebase:op-skip 预检签票且计划带 state=rebase", sc.ok === true && sc.plan?.state === "rebase" && !!sc.ticket?.id, JSON.stringify(sc.error || sc));
    const sw = await x.call("gitConflictWrite", { op: "op-skip", ticketId: sc.ticket.id, requestId: "rebase-skip-2", confirmed: true });
    check("rebase:op-skip 执行 ok 且回到干净状态", sw.ok === true && sw.state === null && sw.conflictCount === 0, JSON.stringify(sw.error || sw));
    check("rebase:跳过之后 topic edit 不在历史里", !x.git("log", "--format=%s").includes("topic edit"), x.git("log", "--format=%s"));
  }

  // rebase-onto 撞冲突 → 中止回操作前
  {
    const { x, baseOid, topicOid } = rebaseConflictRepo("t05-rebase-abort-");
    bridgeOf(x);
    const c = await x.call("gitRebaseCheck", { op: "rebase-onto", oldBase: baseOid, newBase: "main" });
    const w = await x.call("gitRebaseWrite", { op: "rebase-onto", oldBase: baseOid, newBase: "main", ticketId: c.ticket.id, requestId: "rebase-abort-1", confirmed: true });
    check("rebase:中止用例先撞出冲突", w.ok === true && w.conflicted === true, JSON.stringify(w.error || w));
    const ac = await x.call("gitConflictCheck", { op: "op-abort" });
    const aw = await x.call("gitConflictWrite", { op: "op-abort", ticketId: ac.ticket.id, requestId: "rebase-abort-2", confirmed: true });
    check("rebase:op-abort 执行 ok 且回到干净状态", aw.ok === true && aw.state === null && aw.conflictCount === 0, JSON.stringify(aw.error || aw));
    check("rebase:中止后 HEAD 回到操作前的 topic 提交", x.git("rev-parse", "HEAD") === topicOid, `${x.git("rev-parse", "HEAD")} != ${topicOid}`);
  }

  // rebase-onto 撞冲突 → 解决后继续
  {
    const { x, baseOid } = rebaseConflictRepo("t05-rebase-continue-");
    bridgeOf(x);
    const c = await x.call("gitRebaseCheck", { op: "rebase-onto", oldBase: baseOid, newBase: "main" });
    await x.call("gitRebaseWrite", { op: "rebase-onto", oldBase: baseOid, newBase: "main", ticketId: c.ticket.id, requestId: "rebase-continue-1", confirmed: true });
    writeFileSync(join(x.dir, "a.txt"), "line1\nMERGED\nline3\n");
    x.git("add", "a.txt");
    const cc = await x.call("gitConflictCheck", { op: "op-continue" });
    check("rebase:op-continue 预检在冲突已解决后签票", cc.ok === true && cc.plan?.state === "rebase", JSON.stringify(cc.error || cc));
    const cw = await x.call("gitConflictWrite", { op: "op-continue", ticketId: cc.ticket.id, requestId: "rebase-continue-2", confirmed: true });
    check("rebase:op-continue 执行 ok 且变基完成", cw.ok === true && cw.state === null && cw.conflictCount === 0, JSON.stringify(cw.error || cw));
    const log = x.git("log", "--format=%s");
    check("rebase:继续后 topic edit 与 main edit 都在历史里", log.includes("topic edit") && log.includes("main edit"), log);
  }

  // 坏参数:基座写成上跳路径
  {
    const r = baseRepo("t05-rebase-bad-");
    bridgeOf(r);
    const bad = await r.call("gitRebaseCheck", { op: "rebase-onto", oldBase: "../evil", newBase: "main" });
    check("rebase:坏基座回 args/bad-target", bad.ok === false && bad.error?.kind === "args" && bad.reason === "bad-target", JSON.stringify(bad.error || bad));
  }
}

// ---------------------------------------------------------------------------
// 切片 5:冲突向导 —— 清单/视图/选边/整份保存/标记已解决/继续/中止
// ---------------------------------------------------------------------------
async function startMerge(repo) {
  const c = await repo.call("gitConflictCheck", { op: "merge", target: "feature" });
  check("冲突:merge 预检 ok 且带确认卡", c.ok === true && c.confirm?.kind === "merge" && !!c.ticket?.id, JSON.stringify(c.error || c));
  const w = await repo.call("gitConflictWrite", { op: "merge", target: "feature", ticketId: c.ticket.id, requestId: "merge-" + Math.random().toString(36).slice(2), confirmed: true });
  check("冲突:merge 执行 ok 且如实报冲突", w.ok === true && w.conflicted === true && w.state === "merge" && w.conflictCount === 1, JSON.stringify(w.error || w));
  return w;
}

async function conflictSlice() {
  // 选边(ours) + 标记已解决 + 继续
  {
    const { r } = conflictRepo("t05-conflict-side-");
    bridgeOf(r);
    await startMerge(r);
    const list = await r.call("gitConflicts", { op: "conflict-list" });
    check("冲突:清单列出未合并路径、阶段与分类", list.ok === true && list.conflictCount === 1 && list.conflicts?.[0]?.path === "a.txt" && list.conflicts?.[0]?.kind === "both-changed" && list.conflicts?.[0]?.textKind === "text", JSON.stringify(list.error || list));
    const view = await r.call("gitConflicts", { op: "conflict-view", path: "a.txt" });
    check("冲突:视图按块切开并带两边内容", view.ok === true && view.hunkCount === 1 && /<<<<<<<[^\n]*\nMAIN\n=======\nFEATURE\n>>>>>>>/.test(view.text || ""), JSON.stringify(view.error || { hunks: view.hunks, text: view.text }));
    const tc = await r.call("gitConflictCheck", { op: "take-side", path: "a.txt", side: "ours" });
    check("冲突:take-side 预检 ok", tc.ok === true && !!tc.ticket?.id, JSON.stringify(tc.error || tc));
    const tw = await r.call("gitConflictWrite", { op: "take-side", path: "a.txt", side: "ours", ticketId: tc.ticket.id, requestId: "conflict-side-1", confirmed: true });
    check("冲突:选当前边后冲突清零、状态仍是 merge", tw.ok === true && tw.state === "merge" && tw.conflictCount === 0, JSON.stringify(tw.error || tw));
    const text = readFileSync(join(r.dir, "a.txt"), "utf8");
    check("冲突:工作区文件落地为当前边内容", text.includes("MAIN") && !text.includes("FEATURE"), text);
    const cc = await r.call("gitConflictCheck", { op: "op-continue" });
    const cw = await r.call("gitConflictWrite", { op: "op-continue", ticketId: cc.ticket.id, requestId: "conflict-side-2", confirmed: true });
    check("冲突:继续后合并完成(state=null)", cw.ok === true && cw.state === null, JSON.stringify(cw.error || cw));
    check("冲突:合并提交落地", /^Merge branch 'feature'/.test(r.git("log", "--format=%s", "-1")), r.git("log", "--format=%s", "-1"));
  }

  // 整份保存 + 标记已解决 + 继续
  {
    const { r } = conflictRepo("t05-conflict-save-");
    bridgeOf(r);
    await startMerge(r);
    const resolved = "line1\nRESOLVED\nline3\n";
    const sc = await r.call("gitConflictCheck", { op: "save-file", path: "a.txt", text: resolved });
    check("冲突:save-file 预检把旧/新内容摘要写进计划", sc.ok === true && /^[0-9a-f]{16}$/.test(sc.plan?.textDigest || "") && /^[0-9a-f]{16}$/.test(sc.plan?.oldDigest || ""), JSON.stringify(sc.error || sc.plan));
    const sw = await r.call("gitConflictWrite", { op: "save-file", path: "a.txt", text: resolved, ticketId: sc.ticket.id, requestId: "conflict-save-1", confirmed: true });
    check("冲突:整份保存写回工作区且无残留标记", sw.ok === true && sw.saved === true && sw.markerClean === true, JSON.stringify(sw.error || sw));
    check("冲突:保存后的文件内容就是面板文本", readFileSync(join(r.dir, "a.txt"), "utf8") === resolved, readFileSync(join(r.dir, "a.txt"), "utf8"));
    const mc = await r.call("gitConflictCheck", { op: "mark-resolved", path: "a.txt" });
    const mw = await r.call("gitConflictWrite", { op: "mark-resolved", path: "a.txt", ticketId: mc.ticket.id, requestId: "conflict-save-2", confirmed: true });
    check("冲突:标记已解决后冲突清零", mw.ok === true && mw.state === "merge" && mw.conflictCount === 0, JSON.stringify(mw.error || mw));
    const cc = await r.call("gitConflictCheck", { op: "op-continue" });
    const cw = await r.call("gitConflictWrite", { op: "op-continue", ticketId: cc.ticket.id, requestId: "conflict-save-3", confirmed: true });
    check("冲突:整份保存后合并完成", cw.ok === true && cw.state === null, JSON.stringify(cw.error || cw));
  }

  // 取消:中止合并回操作前
  {
    const { r } = conflictRepo("t05-conflict-abort-");
    bridgeOf(r);
    const before = r.git("rev-parse", "HEAD");
    await startMerge(r);
    const ac = await r.call("gitConflictCheck", { op: "op-abort" });
    const aw = await r.call("gitConflictWrite", { op: "op-abort", ticketId: ac.ticket.id, requestId: "conflict-abort-1", confirmed: true });
    check("冲突:op-abort 执行 ok 且回到干净状态", aw.ok === true && aw.state === null && aw.conflictCount === 0, JSON.stringify(aw.error || aw));
    check("冲突:中止后 HEAD 与工作区都回到合并前", r.git("rev-parse", "HEAD") === before && readFileSync(join(r.dir, "a.txt"), "utf8").includes("MAIN"), r.git("status", "--porcelain"));
  }

  // 票据门:危险确认缺失 / 票不存在(merge 本身不要求确认;abort 是危险动作,要 confirmed)
  {
    const { r } = conflictRepo("t05-conflict-ticket-");
    bridgeOf(r);
    await startMerge(r);
    const before = r.git("rev-parse", "HEAD");
    const c = await r.call("gitConflictCheck", { op: "op-abort" });
    const noConfirm = await r.call("gitConflictWrite", { op: "op-abort", ticketId: c.ticket.id, requestId: "conflict-ticket-1" });
    check("冲突:危险确认缺失回 need-confirm 且不执行", noConfirm.ok === false && noConfirm.error?.kind === "need-confirm" && r.git("rev-parse", "HEAD") === before, JSON.stringify(noConfirm.error || noConfirm));
    const badTicket = await r.call("gitConflictWrite", { op: "op-abort", ticketId: "nosuchticket", requestId: "conflict-ticket-2", confirmed: true });
    check("冲突:不存在的票回 ticket-missing", badTicket.ok === false && badTicket.error?.reason === "ticket-missing", JSON.stringify(badTicket.error || badTicket));
  }
}

// ---------------------------------------------------------------------------
// 切片 6:子模块 —— 本地 bare 仓做源;add/init/update/sync/deinit 与长任务
// ---------------------------------------------------------------------------
async function submoduleSlice() {
  const src = makeRepo("t05-sub-src-");
  writeFileSync(join(src.dir, "lib.txt"), "lib v1\n");
  src.git("add", "lib.txt");
  src.git("commit", "-m", "lib one");
  const bare = tmp("t05-sub-bare-");
  execFileSync("git", ["init", "--bare", "-b", "main", bare], { encoding: "utf8" });
  const url = pathToFileURL(bare).href;
  src.git("remote", "add", "origin", url);
  src.git("push", "origin", "main");

  const parent = makeRepo("t05-sub-parent-");
  writeFileSync(join(parent.dir, "root.txt"), "root\n");
  parent.git("add", "root.txt");
  parent.git("commit", "-m", "root one");
  bridgeOf(parent, { env: { ...process.env, GIT_ALLOW_PROTOCOL: "file" } });

  check("子模块:bridge 暴露本票 15 条电话且不暴露票表", ["gitUndoCheck", "gitUndoWrite", "gitRewritePreview", "gitRewriteCheck", "gitRewriteRun", "gitRebaseRead", "gitRebaseCheck", "gitRebaseWrite", "gitConflicts", "gitConflictCheck", "gitConflictWrite", "gitSubmodules", "gitSubmoduleCheck", "gitSubmoduleWrite", "gitSubmoduleTask"].every((m) => parent.bridge.methods.includes(m)) && !parent.bridge.methods.some((m) => /Tickets$/.test(m)), JSON.stringify(parent.bridge.methods));

  // add:预检签票 → 长任务通道 → 轮询到 succeeded
  const ac = await parent.call("gitSubmoduleCheck", { op: "add", path: "vendor/lib", url });
  check("子模块:add 预检 allow、要确认、带 submodule-add 任务", ac.ok === true && ac.decision === "allow" && ac.confirmRequired === true && ac.task?.op === "submodule-add" && !!ac.ticket?.id, JSON.stringify(ac.error || ac));
  const aw = await parent.call("gitSubmoduleTask", { op: "add", ticketId: ac.ticket.id, requestId: "sub-add-1", confirmed: true });
  check("子模块:add 走长任务通道并返回任务号", aw.ok === true && !!aw.task?.taskId && aw.task?.op === "submodule-add", JSON.stringify(aw.error || aw));
  const addDone = await waitTask(parent, aw.task.taskId);
  check("子模块:add 长任务 succeeded", addDone?.conclusion === "succeeded" && addDone?.exitCode === 0, JSON.stringify(addDone));
  check("子模块:add 后 .gitmodules 与工作区文件都落地", existsSync(join(parent.dir, ".gitmodules")) && existsSync(join(parent.dir, "vendor/lib/lib.txt")));
  parent.git("add", ".gitmodules", "vendor/lib");
  parent.git("commit", "-m", "add submodule");

  const board = await parent.call("gitSubmodules", {});
  check("子模块:读数面板看到 1 个已初始化子模块", board.ok === true && board.counts?.total === 1 && board.counts?.initialized === 1 && board.rows?.[0]?.path === "vendor/lib" && board.rows?.[0]?.state === "clean", JSON.stringify(board.error || { counts: board.counts, rows: board.rows }));

  // sync(凭票写)
  const sc = await parent.call("gitSubmoduleCheck", { op: "sync", path: "vendor/lib" });
  check("子模块:sync 预检不拦", sc.ok === true && sc.decision !== "block" && !!sc.ticket?.id, JSON.stringify(sc.error || sc));
  const sw = await parent.call("gitSubmoduleWrite", { op: "sync", path: "vendor/lib", ticketId: sc.ticket.id, requestId: "sub-sync-1", confirmed: true });
  check("子模块:sync 凭票执行 ok 且 argv 正确", sw.ok === true && (sw.argv || []).includes("sync"), JSON.stringify(sw.error || sw));

  // deinit(凭票写):工作区收走,登记保留
  const dc = await parent.call("gitSubmoduleCheck", { op: "deinit", path: "vendor/lib" });
  check("子模块:deinit 预检不拦", dc.ok === true && dc.decision !== "block" && !!dc.ticket?.id, JSON.stringify(dc.error || dc));
  const dw = await parent.call("gitSubmoduleWrite", { op: "deinit", path: "vendor/lib", ticketId: dc.ticket.id, requestId: "sub-deinit-1", confirmed: true });
  check("子模块:deinit 凭票执行 ok 且工作区文件消失", dw.ok === true && !existsSync(join(parent.dir, "vendor/lib/lib.txt")) && existsSync(join(parent.dir, ".gitmodules")), JSON.stringify(dw.error || dw));

  // init(长任务):重新初始化并检出
  const ic = await parent.call("gitSubmoduleCheck", { op: "init", path: "vendor/lib" });
  check("子模块:init 预检带 submodule-init 任务", ic.ok === true && ic.task?.op === "submodule-init" && !!ic.ticket?.id, JSON.stringify(ic.error || ic));
  const iw = await parent.call("gitSubmoduleTask", { op: "init", ticketId: ic.ticket.id, requestId: "sub-init-1", confirmed: true });
  const initDone = iw.ok ? await waitTask(parent, iw.task.taskId) : null;
  check("子模块:init 长任务 succeeded 且文件回来", initDone?.conclusion === "succeeded" && existsSync(join(parent.dir, "vendor/lib/lib.txt")), JSON.stringify(initDone || iw));

  // update 到记录的提交(长任务)
  const uc = await parent.call("gitSubmoduleCheck", { op: "recorded", path: "vendor/lib" });
  check("子模块:recorded 预检带 submodule-update 任务", uc.ok === true && uc.task?.op === "submodule-update" && !!uc.ticket?.id, JSON.stringify(uc.error || uc));
  const uw = await parent.call("gitSubmoduleTask", { op: "recorded", ticketId: uc.ticket.id, requestId: "sub-update-1", confirmed: true });
  const updateDone = uw.ok ? await waitTask(parent, uw.task.taskId) : null;
  check("子模块:recorded 长任务 succeeded", updateDone?.conclusion === "succeeded", JSON.stringify(updateDone || uw));

  // 批量菜单:fetch(固定菜单,只认菜单号)
  const fc = await parent.call("gitSubmoduleCheck", { op: "fetch", batch: true });
  check("子模块:批量 fetch 预检带 submodule-fetch 任务", fc.ok === true && fc.task?.op === "submodule-fetch" && !!fc.ticket?.id, JSON.stringify(fc.error || fc));
  const fw = await parent.call("gitSubmoduleTask", { op: "fetch", ticketId: fc.ticket.id, requestId: "sub-fetch-1", confirmed: true });
  const fetchDone = fw.ok ? await waitTask(parent, fw.task.taskId) : null;
  check("子模块:批量 fetch 长任务 succeeded", fetchDone?.conclusion === "succeeded", JSON.stringify(fetchDone || fw));

  // 任务库不落仓库工作区,而是落在注入的缓存目录
  check("子模块:任务记录落在缓存目录、不在仓库工作区", !existsSync(join(parent.dir, "vc-task-events__tasks.json")) && existsSync(join(parent.cacheDir, "vc-task-events__tasks.json")), JSON.stringify({ repo: readdirSync(parent.dir), cache: readdirSync(parent.cacheDir) }));

  // 坏参数:上跳路径;坏票:不存在的票
  const badPath = await parent.call("gitSubmoduleCheck", { op: "add", path: "../evil", url });
  check("子模块:上跳路径回 invalid/path-bad 且不签票", badPath.ok === false && badPath.error?.reason === "path-bad" && !badPath.ticket, JSON.stringify(badPath.error || badPath));
  const badTicket = await parent.call("gitSubmoduleTask", { op: "add", ticketId: "nosuchticket", requestId: "sub-bad-1", confirmed: true });
  check("子模块:坏票回 ticket-missing", badTicket.ok === false && badTicket.error?.reason === "ticket-missing", JSON.stringify(badTicket.error || badTicket));
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
if (!existsSync(DIST_GIT)) {
  console.error("FAIL - 先跑 node build.mjs(dist/git.mjs 不存在)");
  process.exit(1);
}
const { createGitBridge } = await import(pathToFileURL(DIST_GIT).href);

const slices = [
  ["历史改写", undoSlice],
  ["过期票与路径边界", ticketAndBoundarySlice],
  ["整仓重写", rewriteSlice],
  ["变基待办", rebaseSlice],
  ["冲突向导", conflictSlice],
  ["子模块", submoduleSlice],
];
for (const [name, fn] of slices) {
  try {
    await fn();
  } catch (e) {
    failures++;
    console.error(`FAIL - ${name} 套件异常 :: ${e && e.stack ? e.stack : e}`);
  } finally {
    cleanupAll();
  }
}

if (failures > 0) {
  console.error(`\n${failures} 条断言失败`);
  process.exit(1);
}
console.log("\nserver-git-history: 全部断言通过");
