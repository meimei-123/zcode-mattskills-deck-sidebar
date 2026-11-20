// 工单 04 缝:版本管理第二组电话(分支·工作树·贮藏)在真 git 仓上的契约。
//
// 三段:
//   A. 分支与标签:gitBranches 读一次取全;gitBranchCheck → gitBranchWrite 逐 op 验收
//      create/switch/rename/delete/upstream/tag-create/tag-delete,每个 op 一条成功 + 拒绝用例。
//   B. 工作树:gitWorktreeCheck → gitWorktreeRun 的 add/list/remove/prune;目标路径边界;
//      在新建工作树里真做一次提交与切分支。
//   C. 贮藏:gitStashCheck → gitStash 的 push/list/apply/pop/drop,apply 冲突的诚实失败,
//      丢弃后「最近丢弃」记录与 restore。
//   另加:坏参数、过期票(可控时钟)、越界路径各一条;最后经 deck_git 走一遍 MCP 路由。
//
// 期望值独立于实现:来自工单 04 的验收条目、上游动作枚举与 git 自身行为(真实分支名/标签/工作树清单/贮藏列表)。
// 测试用 mkdtemp + git init 的一次性仓库,结束删除;不碰用户仓库。
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** 一次性真仓:main 分支上一条 base 提交(a.txt)。 */
function makeRepo(prefix = "t04-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-b", "main");
  git("config", "user.email", "t04@example.com");
  git("config", "user.name", "T04 Tester");
  git("config", "core.autocrlf", "false");
  writeFileSync(join(dir, "a.txt"), "one\n", "utf8");
  git("add", "a.txt");
  git("commit", "-m", "base");
  return {
    dir,
    git,
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  };
}

const scOf = (reply) => reply?.result?.structuredContent || {};

/** 经 deck_git 的 MCP stdio 会话(与既有 server 套件同模式)。 */
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
  return { call, stop };
}

/** 预检 → 凭票执行 的一次往返;返回 {check, write}。 */
async function checkWrite(call, checkMethod, writeMethod, args, extraWrite = {}) {
  const c = await call(checkMethod, args);
  const writeArgs = { ...args, ...extraWrite };
  if (c?.ticket?.id) writeArgs.ticketId = c.ticket.id;
  return { check: c, write: await call(writeMethod, writeArgs) };
}

let seq = 0;
const rid = (tag) => `r${++seq}-${tag}`;

async function sliceBranches() {
  if (!existsSync(DIST_GIT)) {
    check("branches: dist/git.mjs 可 import", false);
    return;
  }
  const repo = makeRepo();
  const bare = mkdtempSync(join(tmpdir(), "t04-bare-"));
  execFileSync("git", ["init", "--bare", bare], { encoding: "utf8" });
  const { createGitBridge } = await import(pathToFileURL(DIST_GIT).href);
  const bridge = createGitBridge({ workspaceRoot: repo.dir, env: process.env });
  const call = (m, a = {}) => bridge.call(m, a);
  try {
    // 读一次取全
    const board = await call("gitBranches");
    check(
      "branches: gitBranches 契约名/当前分支/能力片",
      board.ok === true &&
        board.contract === "version-control.branch-board" &&
        board.current?.name === "main" &&
        board.branches?.some((b) => b.name === "main" && b.current === true) &&
        board.capabilities?.tier === "full",
      JSON.stringify(board.error || { current: board.current, tier: board.capabilities?.tier })
    );
    const opNames = (board.capabilities?.actions || []).map((a) => a.op);
    check(
      "branches: 能力片列出九个写动作",
      ["create", "switch", "rename", "delete", "upstream", "tag-create", "tag-delete"].every((op) => opNames.includes(op)),
      JSON.stringify(opNames)
    );

    // create 成功
    const created = await checkWrite(call, "gitBranchCheck", "gitBranchWrite", { op: "create", name: "feat-a" }, { requestId: rid("create") });
    check("branches: create 预检 allow 并签票", created.check.ok === true && created.check.decision?.verdict === "allow" && !!created.check.ticket?.id, JSON.stringify(created.check));
    check("branches: create 执行成功且回包带分支名", created.write.ok === true && created.write.branch === "feat-a", JSON.stringify(created.write));
    check("branches: create 后真实 HEAD 在 feat-a", repo.git("rev-parse", "--abbrev-ref", "HEAD").trim() === "feat-a");

    // create 拒绝:重名
    const dup = await call("gitBranchCheck", { op: "create", name: "main" });
    check(
      "branches: 重名创建被拦(branch-exists)",
      dup.ok === false && dup.error?.kind === "blocked" && dup.reason === "branch-exists",
      JSON.stringify(dup)
    );
    // create 拒绝:坏名
    const badName = await call("gitBranchCheck", { op: "create", name: "bad name" });
    check(
      "branches: 坏分支名被拒(bad-branch-name)",
      badName.ok === false && badName.error?.kind === "args" && badName.reason === "bad-branch-name",
      JSON.stringify(badName)
    );

    // switch 成功(回到 main)
    const switched = await checkWrite(call, "gitBranchCheck", "gitBranchWrite", { op: "switch", name: "main" }, { requestId: rid("switch") });
    check("branches: switch 预检 allow", switched.check.ok === true && switched.check.decision?.verdict === "allow", JSON.stringify(switched.check));
    check("branches: switch 执行后真实 HEAD 回 main", switched.write.ok === true && repo.git("rev-parse", "--abbrev-ref", "HEAD").trim() === "main", JSON.stringify(switched.write));
    // switch 拒绝:分支不存在
    const noBranch = await call("gitBranchCheck", { op: "switch", name: "no-such-branch" });
    check(
      "branches: 切到不存在的分支被拦(branch-missing)",
      noBranch.ok === false && noBranch.error?.kind === "blocked" && noBranch.reason === "branch-missing",
      JSON.stringify(noBranch)
    );

    // rename 成功
    const renamed = await checkWrite(call, "gitBranchCheck", "gitBranchWrite", { op: "rename", from: "feat-a", to: "feat-b" }, { requestId: rid("rename") });
    check("branches: rename 执行成功", renamed.write.ok === true && renamed.write.from === "feat-a" && renamed.write.to === "feat-b", JSON.stringify(renamed.write));
    const namesAfterRename = repo.git("branch", "--list", "--format=%(refname:short)").split(/\r?\n/).filter(Boolean);
    check("branches: rename 后真实分支名为 feat-b", namesAfterRename.includes("feat-b") && !namesAfterRename.includes("feat-a"), JSON.stringify(namesAfterRename));
    // rename 拒绝:改到已存在名字
    const renameDup = await call("gitBranchCheck", { op: "rename", from: "feat-b", to: "main" });
    check(
      "branches: 改名撞名被拦(branch-exists)",
      renameDup.ok === false && renameDup.error?.kind === "blocked" && renameDup.reason === "branch-exists",
      JSON.stringify(renameDup)
    );

    // delete 成功:需要确认;未确认先拒
    const delCheck = await call("gitBranchCheck", { op: "delete", name: "feat-b" });
    check(
      "branches: delete 预检 allow 且要求确认",
      delCheck.ok === true && delCheck.confirmRequired === true && delCheck.scene?.merged === true,
      JSON.stringify(delCheck)
    );
    const noConfirm = await call("gitBranchWrite", { op: "delete", name: "feat-b", ticketId: delCheck.ticket?.id, requestId: rid("del-noconfirm") });
    check(
      "branches: 未确认的 delete 被拒(need-confirm)",
      noConfirm.ok === false && noConfirm.error?.kind === "need-confirm" && noConfirm.reason === "need-confirm",
      JSON.stringify(noConfirm)
    );
    const delWrite = await call("gitBranchWrite", {
      op: "delete",
      name: "feat-b",
      ticketId: delCheck.ticket?.id,
      requestId: rid("del"),
      confirmed: true,
    });
    check("branches: delete 确认后执行成功", delWrite.ok === true && delWrite.branch === "feat-b", JSON.stringify(delWrite));
    check("branches: delete 后真实分支已消失", repo.git("branch", "--list", "--format=%(refname:short)").split(/\r?\n/).filter(Boolean).includes("feat-b") === false);
    // delete 拒绝:当前分支
    const delCurrent = await call("gitBranchCheck", { op: "delete", name: "main" });
    check(
      "branches: 删当前分支被拦(cannot-delete-current)",
      delCurrent.ok === false && delCurrent.error?.kind === "blocked" && delCurrent.reason === "cannot-delete-current",
      JSON.stringify(delCurrent)
    );
    // delete 拒绝:未并入且未 force
    repo.git("branch", "feat-unmerged");
    repo.git("switch", "feat-unmerged");
    writeFileSync(join(repo.dir, "u.txt"), "u\n", "utf8");
    repo.git("add", "u.txt");
    repo.git("commit", "-m", "unmerged work");
    repo.git("switch", "main");
    const delUnmerged = await call("gitBranchCheck", { op: "delete", name: "feat-unmerged" });
    check(
      "branches: 删未并入分支被拦(branch-not-merged)",
      delUnmerged.ok === false && delUnmerged.error?.kind === "blocked" && delUnmerged.reason === "branch-not-merged",
      JSON.stringify(delUnmerged)
    );

    // upstream:先清空再从上游设置一遍
    repo.git("remote", "add", "origin", bare);
    repo.git("push", "-u", "origin", "main");
    repo.git("branch", "--unset-upstream", "main");
    const up = await checkWrite(call, "gitBranchCheck", "gitBranchWrite", { op: "upstream", branch: "main", upstream: "origin/main" }, { requestId: rid("upstream") });
    check("branches: upstream 预检 allow", up.check.ok === true && up.check.decision?.verdict === "allow", JSON.stringify(up.check));
    check(
      "branches: upstream 执行后真实配置指向 origin/main",
      up.write.ok === true && repo.git("config", "--get", "branch.main.remote").trim() === "origin" && repo.git("config", "--get", "branch.main.merge").trim() === "refs/heads/main",
      JSON.stringify(up.write)
    );
    const board2 = await call("gitBranches");
    check("branches: gitBranches 读到刚才设置的上游", board2.branches?.some((b) => b.name === "main" && b.upstream === "origin/main"), JSON.stringify(board2.branches));
    // upstream 拒绝:坏写法
    const badUp = await call("gitBranchCheck", { op: "upstream", branch: "main", upstream: "originmain" });
    check(
      "branches: 坏上游写法被拒(bad-upstream)",
      badUp.ok === false && badUp.error?.kind === "args" && badUp.reason === "bad-upstream",
      JSON.stringify(badUp)
    );

    // tag-create 成功
    const headOid = repo.git("rev-parse", "HEAD").trim();
    const tag = await checkWrite(call, "gitBranchCheck", "gitBranchWrite", { op: "tag-create", name: "v1", mode: "light" }, { requestId: rid("tag") });
    check("branches: tag-create 执行成功", tag.write.ok === true && tag.write.tag === "v1", JSON.stringify(tag.write));
    check(
      "branches: 真实标签 v1 指向 HEAD 且为轻量标签",
      repo.git("rev-parse", "refs/tags/v1").trim() === headOid && repo.git("cat-file", "-t", "v1").trim() === "commit",
      repo.git("cat-file", "-t", "v1").trim()
    );
    const board3 = await call("gitBranches");
    check("branches: gitBranches 读到标签 v1", board3.tags?.some((t) => t.name === "v1" && t.oid === headOid), JSON.stringify(board3.tags));
    // tag-create 拒绝:重名
    const tagDup = await call("gitBranchCheck", { op: "tag-create", name: "v1", mode: "light" });
    check(
      "branches: 重名标签被拦(tag-exists)",
      tagDup.ok === false && tagDup.error?.kind === "blocked" && tagDup.reason === "tag-exists",
      JSON.stringify(tagDup)
    );

    // tag-delete 成功:同样要确认
    const tagDelCheck = await call("gitBranchCheck", { op: "tag-delete", name: "v1" });
    check("branches: tag-delete 预检 allow 且要求确认", tagDelCheck.ok === true && tagDelCheck.confirmRequired === true, JSON.stringify(tagDelCheck));
    const tagDel = await call("gitBranchWrite", { op: "tag-delete", name: "v1", ticketId: tagDelCheck.ticket?.id, requestId: rid("tagdel"), confirmed: true });
    check("branches: tag-delete 执行成功", tagDel.ok === true, JSON.stringify(tagDel));
    check("branches: 真实标签已删除", repo.git("tag", "--list").trim() === "");
    // tag-delete 拒绝:标签不存在
    const tagMissing = await call("gitBranchCheck", { op: "tag-delete", name: "v-no" });
    check(
      "branches: 删不存在的标签被拒",
      tagMissing.ok === false && tagMissing.error?.kind === "args" && tagMissing.reason === "branch-missing",
      JSON.stringify(tagMissing)
    );
  } finally {
    rmSync(bare, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    repo.cleanup();
  }
}

async function sliceWorktrees() {
  if (!existsSync(DIST_GIT)) {
    check("worktrees: dist/git.mjs 可 import", false);
    return;
  }
  const repo = makeRepo();
  const { createGitBridge } = await import(pathToFileURL(DIST_GIT).href);
  const bridge = createGitBridge({ workspaceRoot: repo.dir, env: process.env });
  const call = (m, a = {}) => bridge.call(m, a);
  const wtPath = join(repo.dir, "wt-one");
  const wt2 = join(repo.dir, "wt-two");
  try {
    // add
    const addCheck = await call("gitWorktreeCheck", { op: "add", path: wtPath });
    check(
      "worktrees: add 预检 allow 并签票",
      addCheck.ok === true && addCheck.decision?.decision === "allow" && !!addCheck.ticket?.id,
      JSON.stringify(addCheck)
    );
    const addRun = await call("gitWorktreeRun", { op: "add", path: wtPath, ticketId: addCheck.ticket?.id, requestId: rid("wt-add"), confirm: true });
    check(
      "worktrees: add 执行成功(state=done)",
      addRun.ok === true && addRun.result?.state === "done",
      JSON.stringify(addRun)
    );
    check("worktrees: add 后目录真实存在", existsSync(wtPath));
    // list:首屏工作树片就是列表视图的数据源
    const screen = await call("gitFirstScreen");
    const others = screen.firstScreen?.slices?.worktrees?.data?.others || [];
    check(
      "worktrees: 列表片包含新建工作树",
      screen.firstScreen?.slices?.worktrees?.state === "ok" && others.some((r) => String(r.path).replace(/\\/g, "/").toLowerCase().endsWith("/wt-one")),
      JSON.stringify(others)
    );
    const listCheck = await call("gitWorktreeCheck", { op: "list" });
    check(
      "worktrees: list 预检可读且不签票(计划是 git worktree list)",
      listCheck.ok === true && listCheck.ticket === null && listCheck.plan?.cmd === "git worktree list",
      JSON.stringify(listCheck)
    );
    // 在新工作树里做一次提交与切分支
    writeFileSync(join(wtPath, "b.txt"), "two\n", "utf8");
    execFileSync("git", ["add", "b.txt"], { cwd: wtPath });
    execFileSync("git", ["commit", "-m", "worktree commit"], { cwd: wtPath, encoding: "utf8" });
    execFileSync("git", ["switch", "-c", "wt-branch"], { cwd: wtPath, encoding: "utf8" });
    check(
      "worktrees: 工作树里能提交并切分支",
      execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: wtPath, encoding: "utf8" }).trim() === "wt-branch" &&
        repo.git("branch", "--list", "--format=%(refname:short)").split(/\r?\n/).includes("wt-branch"),
      repo.git("branch", "--list", "--format=%(refname:short)")
    );
    // remove
    const rmCheck = await call("gitWorktreeCheck", { op: "remove", path: wtPath });
    check("worktrees: remove 预检 allow", rmCheck.ok === true && rmCheck.decision?.decision === "allow", JSON.stringify(rmCheck));
    const rmRun = await call("gitWorktreeRun", { op: "remove", path: wtPath, ticketId: rmCheck.ticket?.id, requestId: rid("wt-rm"), confirm: true });
    check("worktrees: remove 执行成功", rmRun.ok === true && rmRun.result?.state === "done", JSON.stringify(rmRun));
    check("worktrees: remove 后目录已清掉", existsSync(wtPath) === false);
    const screen2 = await call("gitFirstScreen");
    check(
      "worktrees: 移除后列表片不再包含它",
      (screen2.firstScreen?.slices?.worktrees?.data?.others || []).length === 0,
      JSON.stringify(screen2.firstScreen?.slices?.worktrees?.data?.others)
    );
    // remove 拒绝:不在清单里的路径
    const rmMissing = await call("gitWorktreeCheck", { op: "remove", path: join(repo.dir, "no-such-wt") });
    check(
      "worktrees: 移除未登记路径被拦(worktree-not-listed)",
      rmMissing.ok === true && rmMissing.decision?.decision === "block" && (rmMissing.decision?.reasons || []).includes("worktree-not-listed"),
      JSON.stringify(rmMissing)
    );

    // prune:先 add 第二个工作树,再把目录手删,清单里留下可清理登记项
    const add2 = await checkWrite(call, "gitWorktreeCheck", "gitWorktreeRun", { op: "add", path: wt2 }, { requestId: rid("wt-add2"), confirm: true });
    check("worktrees: 第二个工作树 add 成功", add2.write.ok === true, JSON.stringify(add2.write));
    rmSync(wt2, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    const pruneCheck = await call("gitWorktreeCheck", { op: "prune" });
    const pruneEntries = pruneCheck.plan?.pruneEntries || [];
    check(
      "worktrees: prune 预检列出待清理登记项",
      pruneCheck.ok === true && pruneCheck.decision?.decision === "allow" && pruneEntries.some((e) => String(e.path).replace(/\\/g, "/").toLowerCase().endsWith("/wt-two")),
      JSON.stringify(pruneCheck)
    );
    const pruneRun = await call("gitWorktreeRun", { op: "prune", ticketId: pruneCheck.ticket?.id, requestId: rid("wt-prune"), confirm: true });
    check("worktrees: prune 执行成功", pruneRun.ok === true && pruneRun.result?.state === "done", JSON.stringify(pruneRun));
    check(
      "worktrees: prune 后真实清单只剩主工作树",
      repo.git("worktree", "list", "--porcelain").trim().split(/\r?\n\r?\n/).filter(Boolean).length === 1,
      repo.git("worktree", "list", "--porcelain")
    );
    const pruneAgain = await call("gitWorktreeCheck", { op: "prune" });
    check(
      "worktrees: 再查 prune 已无待清理项(nothing-to-prune)",
      pruneAgain.ok === true && (pruneAgain.decision?.reasons || []).includes("nothing-to-prune"),
      JSON.stringify(pruneAgain)
    );

    // 边界:目标在工作区根外
    const outside = mkdtempSync(join(tmpdir(), "t04-outside-"));
    try {
      const outCheck = await call("gitWorktreeCheck", { op: "add", path: join(outside, "x") });
      check(
        "worktrees: 越界目标回 boundary",
        outCheck.ok === false && outCheck.error?.kind === "boundary",
        JSON.stringify(outCheck)
      );
      check("worktrees: boundary 人话写明工作区根内", /只能在工作区根内/.test(outCheck.error?.message || ""), outCheck.error?.message);
    } finally {
      rmSync(outside, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  } finally {
    repo.cleanup();
  }
}

async function sliceStash() {
  if (!existsSync(DIST_GIT)) {
    check("stash: dist/git.mjs 可 import", false);
    return;
  }
  const repo = makeRepo();
  const { createGitBridge } = await import(pathToFileURL(DIST_GIT).href);
  const bridge = createGitBridge({ workspaceRoot: repo.dir, env: process.env });
  const call = (m, a = {}) => bridge.call(m, a);
  try {
    // push
    writeFileSync(join(repo.dir, "a.txt"), "one\nstashed\n", "utf8");
    writeFileSync(join(repo.dir, "new.txt"), "untracked\n", "utf8");
    const pushCheck = await call("gitStashCheck", { op: "push", message: "my stash" });
    check(
      "stash: push 预检签票且现场有改动",
      pushCheck.ok === true && !!pushCheck.ticket?.id && pushCheck.facts?.hasChanges === true,
      JSON.stringify(pushCheck)
    );
    const pushed = await call("gitStash", { op: "push", message: "my stash", ticketId: pushCheck.ticket?.id, requestId: rid("s-push") });
    check(
      "stash: push 执行成功且列表多一条",
      pushed.ok === true && pushed.entries?.length === 1 && /my stash/.test(pushed.entries[0]?.subject || ""),
      JSON.stringify(pushed)
    );
    // push(7.1)只收已跟踪改动;未跟踪文件按上游口径仍留在工作区。
    check("stash: push 后已跟踪改动已入贮藏", repo.git("status", "--porcelain").trim() === "?? new.txt", repo.git("status", "--porcelain"));
    rmSync(join(repo.dir, "new.txt"), { force: true });

    // list(读动作不签票,直接走 gitStash)
    const listed = await call("gitStash", { op: "list" });
    check(
      "stash: list 读到刚才那条(选择器与提交号)",
      listed.ok === true && listed.entries?.length === 1 && listed.entries[0].selector === "stash@{0}" && /^[0-9a-f]{40}$/.test(listed.entries[0].oid || ""),
      JSON.stringify(listed)
    );
    const oid1 = listed.entries[0].oid;
    check("stash: list 的提交号与 git 自身一致", repo.git("rev-parse", "refs/stash").trim() === oid1);

    // apply 冲突:同一文件改成不同内容并提交,再把贮藏贴回去
    writeFileSync(join(repo.dir, "a.txt"), "one\nother\n", "utf8");
    repo.git("add", "a.txt");
    repo.git("commit", "-m", "conflict base");
    const applyCheck = await call("gitStashCheck", { op: "apply", selector: "stash@{0}" });
    check("stash: apply 预检签票", applyCheck.ok === true && !!applyCheck.ticket?.id, JSON.stringify(applyCheck));
    const applied = await call("gitStash", { op: "apply", selector: "stash@{0}", ticketId: applyCheck.ticket?.id, requestId: rid("s-apply") });
    check(
      "stash: 冲突时 apply 诚实失败(ok:false 且带错误原因)",
      applied.ok === false && !!applied.error?.kind,
      JSON.stringify(applied)
    );
    check(
      "stash: 冲突真实落在工作区(UU)",
      /^UU a\.txt$/m.test(repo.git("status", "--porcelain")),
      repo.git("status", "--porcelain")
    );
    repo.git("reset", "--hard");
    repo.git("stash", "drop"); // apply 不删记录;先清掉冲突用例留下的第一条,后面的单条断言才成立

    // pop 成功:再存一条,弹出后工作区回来、列表清空
    writeFileSync(join(repo.dir, "a.txt"), "one\npopped\n", "utf8");
    const push2 = await checkWrite(call, "gitStashCheck", "gitStash", { op: "push", message: "pop stash" }, { requestId: rid("s-push2") });
    check("stash: 第二条 push 成功", push2.write.ok === true && push2.write.entries?.length === 1, JSON.stringify(push2.write));
    const popCheck = await call("gitStashCheck", { op: "pop", selector: "stash@{0}" });
    check("stash: pop 预检签票", popCheck.ok === true && !!popCheck.ticket?.id, JSON.stringify(popCheck));
    const popped = await call("gitStash", { op: "pop", selector: "stash@{0}", ticketId: popCheck.ticket?.id, requestId: rid("s-pop") });
    check("stash: pop 执行成功且列表清空", popped.ok === true && popped.entries?.length === 0, JSON.stringify(popped));
    check("stash: pop 后改动真实回到工作区", readFileSync(join(repo.dir, "a.txt"), "utf8") === "one\npopped\n");
    repo.git("reset", "--hard");

    // drop:留下「最近丢弃」记录
    writeFileSync(join(repo.dir, "a.txt"), "one\ndrop me\n", "utf8");
    const push3 = await checkWrite(call, "gitStashCheck", "gitStash", { op: "push", message: "drop stash" }, { requestId: rid("s-push3") });
    const droppedOid = push3.write.entries?.[0]?.oid;
    check("stash: 第三条 push 成功", push3.write.ok === true && /^[0-9a-f]{40}$/.test(droppedOid || ""), JSON.stringify(push3.write));
    const dropCheck = await call("gitStashCheck", { op: "drop", selector: "stash@{0}" });
    check("stash: drop 预检签票", dropCheck.ok === true && !!dropCheck.ticket?.id, JSON.stringify(dropCheck));
    const dropped = await call("gitStash", { op: "drop", selector: "stash@{0}", ticketId: dropCheck.ticket?.id, requestId: rid("s-drop") });
    check(
      "stash: drop 执行成功且列表清空",
      dropped.ok === true && dropped.entries?.length === 0 && dropped.dropped?.[0]?.oid === droppedOid,
      JSON.stringify(dropped)
    );
    check(
      "stash: drop 回包带最近丢弃记录(同提交号)",
      Array.isArray(dropped.recent) && dropped.recent.some((r) => r.oid === droppedOid && r.byOp === "drop"),
      JSON.stringify(dropped.recent)
    );
    check("stash: drop 后真实贮藏列表为空", repo.git("stash", "list").trim() === "");

    // restore:凭票把最近丢弃的记录挂回去
    const restoreCheck = await call("gitStashCheck", { op: "restore", oid: droppedOid, subject: "On main: drop stash" });
    check("stash: restore 预检签票", restoreCheck.ok === true && !!restoreCheck.ticket?.id, JSON.stringify(restoreCheck));
    const restored = await call("gitStash", {
      op: "restore",
      oid: droppedOid,
      subject: "On main: drop stash",
      ticketId: restoreCheck.ticket?.id,
      requestId: rid("s-restore"),
    });
    check(
      "stash: restore 把同一条记录挂回(提交号一致、最近丢弃清空)",
      restored.ok === true && restored.entries?.[0]?.oid === droppedOid && (restored.recent || []).length === 0,
      JSON.stringify(restored)
    );

    // 拒绝:坏选择器 / 不存在的选择器 / 坏动作 / 没有票
    const badSelector = await call("gitStashCheck", { op: "apply", selector: "stash@{-1}" });
    check(
      "stash: 坏选择器被拒(selector)",
      badSelector.ok === false && badSelector.error?.kind === "selector",
      JSON.stringify(badSelector)
    );
    const missingSelector = await call("gitStashCheck", { op: "apply", selector: "stash@{9}" });
    check(
      "stash: 不存在的贮藏记录被拒(stash-missing)",
      missingSelector.ok === false && missingSelector.error?.kind === "stash-missing",
      JSON.stringify(missingSelector)
    );
    // 未知贮藏动作:上游预检不校验动作名(会签一张注定失败的票),写层必须诚实拒绝且不动仓库。
    const badOpCheck = await call("gitStashCheck", { op: "no-such-op" });
    const badOp = await call("gitStash", { op: "no-such-op", ticketId: badOpCheck.ticket?.id, requestId: rid("s-badop") });
    check(
      "stash: 未知动作在执行层被拒(usage)",
      badOp.ok === false && badOp.error?.kind === "usage",
      JSON.stringify(badOp)
    );
    const noTicket = await call("gitStash", { op: "drop", selector: "stash@{0}", requestId: rid("s-noticket") });
    check(
      "stash: 写动作缺票被拒",
      noTicket.ok === false && noTicket.error?.kind === "confirm" && noTicket.error?.reason === "ticket-missing",
      JSON.stringify(noTicket)
    );
  } finally {
    repo.cleanup();
  }
}

async function sliceGuardsAndRouting() {
  if (!existsSync(DIST_GIT)) return;
  const repo = makeRepo();
  const { createGitBridge } = await import(pathToFileURL(DIST_GIT).href);
  try {
    // 坏参数:缺动作名
    const bridge = createGitBridge({ workspaceRoot: repo.dir, env: process.env });
    const noName = await bridge.call("gitBranchCheck", { op: "create" });
    check(
      "guards: 分支预检缺名字被拒(bad-branch-name)",
      noName.ok === false && noName.error?.kind === "args" && noName.reason === "bad-branch-name",
      JSON.stringify(noName)
    );
    const badReq = await bridge.call("gitWorktreeRun", { op: "list", requestId: "bad request" });
    check(
      "guards: 工作树执行坏请求号被拒(bad-request)",
      badReq.ok === false && badReq.error?.kind === "bad-request",
      JSON.stringify(badReq)
    );

    // 过期票:可控时钟把时间推过 120 秒有效期
    let clock = Date.now();
    const timed = createGitBridge({ workspaceRoot: repo.dir, env: process.env, now: () => clock });
    const expCheck = await timed.call("gitBranchCheck", { op: "create", name: "expired-branch" });
    check("guards: 过期票用例先拿到一张票", expCheck.ok === true && !!expCheck.ticket?.id, JSON.stringify(expCheck));
    clock += 121000;
    const expired = await timed.call("gitBranchWrite", {
      op: "create",
      name: "expired-branch",
      ticketId: expCheck.ticket?.id,
      requestId: rid("expired"),
    });
    check(
      "guards: 过期票被执行层拒绝(ticket-expired)",
      expired.ok === false && expired.error?.kind === "blocked" && expired.reason === "ticket-expired",
      JSON.stringify(expired)
    );
    check(
      "guards: 过期票不落任何副作用(分支没建出来)",
      repo.git("branch", "--list", "--format=%(refname:short)").split(/\r?\n/).filter(Boolean).includes("expired-branch") === false
    );

    // 现场变了:预检后 HEAD 前移,执行必须零进程拒绝
    const live = createGitBridge({ workspaceRoot: repo.dir, env: process.env });
    const staleCheck = await live.call("gitBranchCheck", { op: "create", name: "late-branch" });
    check("guards: 现场变更用例先拿到一张票", staleCheck.ok === true && !!staleCheck.ticket?.id, JSON.stringify(staleCheck));
    writeFileSync(join(repo.dir, "late.txt"), "late\n", "utf8");
    repo.git("add", "late.txt");
    repo.git("commit", "-m", "late commit");
    const stale = await live.call("gitBranchWrite", {
      op: "create",
      name: "late-branch",
      ticketId: staleCheck.ticket?.id,
      requestId: rid("stale"),
    });
    check(
      "guards: 预检后 HEAD 变了 → target-changed",
      stale.ok === false && stale.error?.kind === "blocked" && stale.reason === "target-changed",
      JSON.stringify(stale)
    );
    check(
      "guards: 现场变更不落副作用(分支没建出来)",
      repo.git("branch", "--list", "--format=%(refname:short)").split(/\r?\n/).filter(Boolean).includes("late-branch") === false
    );
  } finally {
    repo.cleanup();
  }

  // 经 deck_git 的 MCP 路由:同一条预检票在服务进程内跨调用有效
  const repo2 = makeRepo();
  const s = await startServer(repo2.dir);
  try {
    const c = await s.call("deck_git", { method: "gitBranchCheck", args: { op: "create", name: "via-mcp" } });
    const csc = scOf(c);
    check("routing: deck_git 调 gitBranchCheck 成功并签票", csc.ok === true && !!csc.ticket?.id, JSON.stringify(csc));
    const w = await s.call("deck_git", {
      method: "gitBranchWrite",
      args: { op: "create", name: "via-mcp", ticketId: csc.ticket?.id, requestId: "mcp-create" },
    });
    const wsc = scOf(w);
    check("routing: deck_git 调 gitBranchWrite 成功", wsc.ok === true && wsc.branch === "via-mcp", JSON.stringify(wsc));
    check("routing: deck_git 写后真实分支存在", repo2.git("branch", "--list", "--format=%(refname:short)").split(/\r?\n/).includes("via-mcp"));
    const outside = mkdtempSync(join(tmpdir(), "t04-mcp-out-"));
    try {
      const b = await s.call("deck_git", { method: "gitWorktreeCheck", args: { op: "add", path: join(outside, "x") } });
      check("routing: deck_git 越界工作树目标回 boundary", scOf(b).ok === false && scOf(b).error?.kind === "boundary", JSON.stringify(scOf(b)));
    } finally {
      rmSync(outside, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  } finally {
    await s.stop();
    repo2.cleanup();
  }
}

if (!existsSync(DIST_SERVER) || !existsSync(DIST_GIT)) {
  console.error("FAIL - 先跑 node build.mjs(dist/server.mjs 或 dist/git.mjs 不存在)");
  process.exit(1);
}
for (const [name, fn] of [
  ["branches", sliceBranches],
  ["worktrees", sliceWorktrees],
  ["stash", sliceStash],
  ["guards/routing", sliceGuardsAndRouting],
]) {
  try {
    await fn();
  } catch (e) {
    failures++;
    console.error(`FAIL - ${name} 套件异常 :: ` + (e && e.stack ? e.stack : e));
  }
}

if (failures > 0) {
  console.error(`\n${failures} 条断言失败`);
  process.exit(1);
}
console.log("\nserver-git-refs: 全部断言通过");
