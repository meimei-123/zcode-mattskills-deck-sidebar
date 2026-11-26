// m7 票 02 缝测试:后端判定(会话手选 > 锚文件 > 默认本地 Markdown)、
// deck_backend_use 切换与两项预检、deck_project_list / deck_project_use 的 backend 块。
// 沿用 server-project 的 startServer + rpc 会话形状:只断言工具回包,不 import 服务端内部模块。
// 假 gh 只往日志追加一行,用来证明「提示位判断不出站」(零调用)。
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // zcode-plugin/
const FIX_MIXED = join(ROOT, "test", "fixtures", "mixed");

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

/** 进程环境:按 extraEnv 落值(undefined = 删掉,含 PATH/Path 这类大小写变体,Windows 上会并存)。 */
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

/** 起一个指向指定工作区根的 server 会话,交回 call/rpc/stop(与 server-project 同形状)。
 *  子进程用 process.execPath 绝对路径起:把 PATH 换空的用例不依赖 PATH 解析。 */
async function startServer(workspaceRoot, extraEnv = {}) {
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

/** 临时工作区目录(停服务时连根删净)。 */
function makeWorkspace(prefix, base) {
  const dir = join(base || mkdtempSync(join(tmpdir(), prefix)), "ws");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 项目根的 .git/config 远端(目录形态;不用真 git,测试离线)。 */
function writeGitConfig(root, url) {
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(
    join(root, ".git", "config"),
    `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
    "utf8"
  );
}

/** 锚文件(docs/agents/issue-tracker.md):标题行 + 一段无关正文。 */
function writeAnchor(root, heading) {
  mkdirSync(join(root, "docs", "agents"), { recursive: true });
  writeFileSync(join(root, "docs", "agents", "issue-tracker.md"), `${heading}\n\n正文。\n`, "utf8");
}

function writeRegistry(homeRoot, projects) {
  mkdirSync(join(homeRoot, ".deck"), { recursive: true });
  writeFileSync(join(homeRoot, ".deck", "projects.json"), JSON.stringify({ version: 1, projects }, null, 2), "utf8");
}

/** 假 gh:一次调用就往日志追加一行(退 1);票 02 的任何路径都不该起它。 */
function writeFakeGh(dir) {
  const p = join(dir, "fake-gh.mjs");
  writeFileSync(
    p,
    `import { appendFileSync } from "node:fs";\nconst log = process.env.ZCODE_FAKE_GH_LOG;\nif (log) appendFileSync(log, JSON.stringify({ argv: process.argv.slice(2) }) + "\\n");\nprocess.exit(1);\n`,
    "utf8"
  );
  return p;
}

/** PATH 换成一个空目录(不放 gh,也不让 git 被解析到)。 */
function emptyPathDir(base) {
  const dir = join(base, "empty-bin");
  mkdirSync(dir, { recursive: true });
  return dir;
}

const backendOf = (r) => r.result?.structuredContent?.active?.backend || null;
const textOf = (r) => String(r.result?.content?.[0]?.text || "");
const samePath = (a, b) => {
  try {
    return realpathSync.native(a) === realpathSync.native(b);
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// 切片 B:手选压过锚文件(双向)。锚文件写 GitHub,先手选 markdown;再手选回来。
// 切 GitHub 需要假 gh + 项目根 .git 远端(票面的两项预检)。
// ---------------------------------------------------------------------------
async function sliceSessionWins() {
  const base = mkdtempSync(join(tmpdir(), "deck-backend-session-"));
  const ws = makeWorkspace("", base);
  writeGitConfig(ws, "git@github.com:owner/name.git");
  writeAnchor(ws, "# Issue tracker: GitHub");
  const fakeGh = writeFakeGh(base);
  const env = { PATH: emptyPathDir(base), ZCODE_GH_PATH: fakeGh, ZCODE_FAKE_GH_LOG: join(base, "gh.log") };
  const s = await startServer(ws, env);
  try {
    const before = backendOf(await s.call("deck_project_list", {}));
    check("手选前: 锚文件 GitHub → github / anchor,repo.name=owner/name",
      before && before.id === "github" && before.source === "anchor" && before.repo?.name === "owner/name" &&
        before.repo?.url === "https://github.com/owner/name" && before.writable === null && before.hint === null,
      JSON.stringify(before));

    const toMd = await s.call("deck_backend_use", { backend: "markdown" });
    const md = backendOf(toMd);
    check("手选: 先切 markdown 成功,回包 active.backend = markdown / session",
      !toMd.result?.isError && md && md.id === "markdown" && md.source === "session", JSON.stringify(md || toMd.result || toMd.error));
    check("手选: markdown 下远端在 GitHub → 提示位为真",
      typeof md?.hint === "string" && md.hint.length > 0, String(md?.hint));
    const listed = backendOf(await s.call("deck_project_list", {}));
    check("手选: 下一次 list 仍是 markdown / session(手选压过锚文件)",
      listed && listed.id === "markdown" && listed.source === "session", JSON.stringify(listed));

    const toGh = await s.call("deck_backend_use", { backend: "github" });
    const gh = backendOf(toGh);
    check("反向: 再切 github 成功,回包 active.backend = github / session",
      !toGh.result?.isError && gh && gh.id === "github" && gh.source === "session", JSON.stringify(gh || toGh.result || toGh.error));
    check("反向: 仓库短名与地址解析出来",
      gh?.repo?.name === "owner/name" && gh?.repo?.url === "https://github.com/owner/name", JSON.stringify(gh?.repo));
    check("反向: 人话摘要带新后端与仓库名",
      /GitHub/.test(textOf(toGh)) && /owner\/name/.test(textOf(toGh)), textOf(toGh));
    const listed2 = backendOf(await s.call("deck_project_list", {}));
    check("反向: 下一次 list 是 github / session",
      listed2 && listed2.id === "github" && listed2.source === "session", JSON.stringify(listed2));
  } finally {
    await s.stop();
    rmSync(base, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 切片 C:手选按项目根记 —— 两个项目互不干扰,deck_project_use 切到谁就报谁的后端。
// ---------------------------------------------------------------------------
async function slicePerRoot() {
  const base = mkdtempSync(join(tmpdir(), "deck-backend-roots-"));
  const home = makeWorkspace("", base);
  const projA = join(base, "proj-a");
  const projB = join(base, "proj-b");
  mkdirSync(projA, { recursive: true });
  mkdirSync(projB, { recursive: true });
  writeGitConfig(projA, "https://github.com/alpha/repo-a.git");
  writeAnchor(projA, "# Issue tracker: GitHub");
  writeRegistry(home, [
    { name: "alpha", path: projA },
    { name: "beta", path: projB }, // 无 .git、无锚文件:默认本地
  ]);
  const fakeGh = writeFakeGh(base);
  const env = { PATH: emptyPathDir(base), ZCODE_GH_PATH: fakeGh, ZCODE_FAKE_GH_LOG: join(base, "gh.log") };
  const s = await startServer(home, env);
  try {
    const useA = await s.call("deck_project_use", { name: "alpha" });
    const aAnchor = backendOf(useA);
    check("按根: 切到 alpha 后回包带 alpha 的后端(github / anchor)",
      !useA.result?.isError && aAnchor?.id === "github" && aAnchor?.source === "anchor" &&
        aAnchor?.repo?.name === "alpha/repo-a", JSON.stringify(aAnchor || useA.result || useA.error));

    const aMd = await s.call("deck_backend_use", { backend: "markdown" });
    check("按根: alpha 手选 markdown → session", backendOf(aMd)?.source === "session" && backendOf(aMd)?.id === "markdown",
      JSON.stringify(backendOf(aMd)));

    const useB = await s.call("deck_project_use", { name: "beta" });
    const bBackend = backendOf(useB);
    check("按根: 切到 beta 不受 alpha 手选影响(markdown / default,repo=null,hint=null)",
      !useB.result?.isError && bBackend?.id === "markdown" && bBackend?.source === "default" &&
        bBackend?.repo === null && bBackend?.hint === null, JSON.stringify(bBackend || useB.result || useB.error));

    const backA = await s.call("deck_project_use", { name: "alpha" });
    check("按根: 切回 alpha,手选还在(markdown / session)",
      backendOf(backA)?.id === "markdown" && backendOf(backA)?.source === "session", JSON.stringify(backendOf(backA)));

    const aGh = await s.call("deck_backend_use", { backend: "github" });
    check("按根: alpha 再切 github → github / session",
      backendOf(aGh)?.id === "github" && backendOf(aGh)?.source === "session", JSON.stringify(backendOf(aGh)));

    const useB2 = await s.call("deck_project_use", { name: "beta" });
    check("按根: 再切 beta 仍是默认本地(alpha 的 github 手选不影响 beta)",
      backendOf(useB2)?.id === "markdown" && backendOf(useB2)?.source === "default", JSON.stringify(backendOf(useB2)));

    const backA2 = await s.call("deck_project_use", { name: "alpha" });
    check("按根: 切回 alpha 仍是 github / session",
      backendOf(backA2)?.id === "github" && backendOf(backA2)?.source === "session", JSON.stringify(backendOf(backA2)));
  } finally {
    await s.stop();
    rmSync(base, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 切片 D:新会话复位 —— 同一个工作区再起一个 server 进程,手选不继承。
// ---------------------------------------------------------------------------
async function sliceSessionReset() {
  const base = mkdtempSync(join(tmpdir(), "deck-backend-reset-"));
  const ws = makeWorkspace("", base);
  writeGitConfig(ws, "https://github.com/owner/name");
  writeAnchor(ws, "# Issue tracker: GitHub");
  const fakeGh = writeFakeGh(base);
  const env = { PATH: emptyPathDir(base), ZCODE_GH_PATH: fakeGh, ZCODE_FAKE_GH_LOG: join(base, "gh.log") };
  const first = await startServer(ws, env);
  try {
    const r = await first.call("deck_backend_use", { backend: "markdown" });
    check("复位: 第一个会话手选 markdown 成功", backendOf(r)?.source === "session", JSON.stringify(backendOf(r)));
  } finally {
    await first.stop();
  }
  const second = await startServer(ws, env);
  try {
    const b = backendOf(await second.call("deck_project_list", {}));
    check("复位: 新会话不继承手选,回到锚文件判定(github / anchor)",
      b && b.id === "github" && b.source === "anchor", JSON.stringify(b));
  } finally {
    await second.stop();
    rmSync(base, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 切片 E:非法后端名 —— 明确报错并列出可用值,不改当前后端。
// ---------------------------------------------------------------------------
async function sliceInvalidName() {
  const base = mkdtempSync(join(tmpdir(), "deck-backend-invalid-"));
  const ws = makeWorkspace("", base);
  const s = await startServer(ws);
  try {
    const tools = (await s.rpc("tools/list", {})).result?.tools || [];
    const tool = tools.find((t) => t.name === "deck_backend_use");
    check("工具声明: deck_backend_use 在 tools/list 里,backend 必填",
      !!tool && Array.isArray(tool.inputSchema?.required) && tool.inputSchema.required.includes("backend"),
      JSON.stringify(tool?.inputSchema));
    const bad = await s.call("deck_backend_use", { backend: "gitlab" });
    check("非法名: gitlab 是工具级错误,列出 markdown、github",
      bad.result?.isError === true && /markdown/.test(textOf(bad)) && /github/.test(textOf(bad)), textOf(bad));
    const empty = await s.call("deck_backend_use", {});
    check("非法名: 缺 backend 是工具级错误", empty.result?.isError === true, textOf(empty));
    const after = backendOf(await s.call("deck_project_list", {}));
    check("非法名: 当前后端没被改(仍是默认 markdown)",
      after?.id === "markdown" && after?.source === "default", JSON.stringify(after));
  } finally {
    await s.stop();
    rmSync(base, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 切片 F:切 GitHub 的两项本地预检 —— 缺 gh 拒、缺仓库拒(都不写状态),两项都过才切。
// ---------------------------------------------------------------------------
async function slicePreflight() {
  const base = mkdtempSync(join(tmpdir(), "deck-backend-preflight-"));
  const emptyBin = emptyPathDir(base);
  const fakeGh = writeFakeGh(base);

  // F1:gh 解析不到(ZCODE_GH_PATH 指不存在路径,PATH 换成空目录)。
  {
    const ws = join(base, "ws-nogh");
    mkdirSync(ws, { recursive: true });
    writeGitConfig(ws, "https://github.com/owner/name.git");
    const s = await startServer(ws, {
      PATH: emptyBin,
      ZCODE_GH_PATH: join(base, "nowhere", "gh.exe"),
      ZCODE_FAKE_GH_LOG: join(base, "gh-nogh.log"),
    });
    try {
      const r = await s.call("deck_backend_use", { backend: "github" });
      check("预检: 没有 gh 时切 GitHub 被拒,说明怎么装/指路 ZCODE_GH_PATH",
        r.result?.isError === true && /gh/.test(textOf(r)) && /ZCODE_GH_PATH/.test(textOf(r)), textOf(r));
      const b = backendOf(await s.call("deck_project_list", {}));
      check("预检: 没有 gh 时后端没被改(仍 markdown,不是 session)",
        b?.id === "markdown" && b?.source !== "session", JSON.stringify(b));
    } finally {
      await s.stop();
    }
  }

  // F2:gh 在,但工作区没有 .git(解析不出仓库)。
  {
    const ws = join(base, "ws-norepo");
    mkdirSync(ws, { recursive: true });
    const s = await startServer(ws, {
      PATH: emptyBin,
      ZCODE_GH_PATH: fakeGh,
      ZCODE_FAKE_GH_LOG: join(base, "gh-norepo.log"),
    });
    try {
      const r = await s.call("deck_backend_use", { backend: "github" });
      check("预检: 解析不出仓库时切 GitHub 被拒,说明远端没指向 github.com",
        r.result?.isError === true && /仓库/.test(textOf(r)) && /github\.com/.test(textOf(r)), textOf(r));
      const b = backendOf(await s.call("deck_project_list", {}));
      check("预检: 解析不出仓库时后端没被改(仍 markdown / default)",
        b?.id === "markdown" && b?.source === "default", JSON.stringify(b));
      const log = join(base, "gh-norepo.log");
      check("预检: 判断仓库不出站(假 gh 零调用)",
        !existsSync(log) || readFileSync(log, "utf8") === "", existsSync(log) ? readFileSync(log, "utf8") : "(无日志)");
    } finally {
      await s.stop();
    }
  }

  // F3:两项都满足 → 切换成功。
  {
    const ws = join(base, "ws-ok");
    mkdirSync(ws, { recursive: true });
    writeGitConfig(ws, "git@github.com:owner/name.git");
    const s = await startServer(ws, {
      PATH: emptyBin,
      ZCODE_GH_PATH: fakeGh,
      ZCODE_FAKE_GH_LOG: join(base, "gh-ok.log"),
    });
    try {
      const r = await s.call("deck_backend_use", { backend: "github" });
      const b = backendOf(r);
      check("预检: 两项都过 → 切换成功(github / session)",
        !r.result?.isError && b?.id === "github" && b?.source === "session", JSON.stringify(b || r.result || r.error));
      check("预检: 成功回包 repo.name=owner/name",
        b?.repo?.name === "owner/name" && b?.repo?.url === "https://github.com/owner/name", JSON.stringify(b?.repo));
      const listed = backendOf(await s.call("deck_project_list", {}));
      check("预检: 成功回包与 list 同一份形状(下一次 list 也是 github / session)",
        listed?.id === "github" && listed?.source === "session" && listed?.repo?.name === "owner/name",
        JSON.stringify(listed));
    } finally {
      await s.stop();
    }
  }

  rmSync(base, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 切片 G:提示位 —— 远端在 GitHub 而当前本地时 hint 为真;这条判断不出站(假 gh 零调用)。
// ---------------------------------------------------------------------------
async function sliceHint() {
  const base = mkdtempSync(join(tmpdir(), "deck-backend-hint-"));
  const ws = makeWorkspace("", base);
  writeGitConfig(ws, "https://github.com/owner/name.git");
  const log = join(base, "gh.log");
  const s = await startServer(ws, {
    PATH: emptyPathDir(base),
    ZCODE_GH_PATH: writeFakeGh(base),
    ZCODE_FAKE_GH_LOG: log,
  });
  try {
    const b1 = backendOf(await s.call("deck_project_list", {}));
    check("提示位: 本地 Markdown + 远端在 GitHub → hint 非空,repo 仍为 null",
      b1?.id === "markdown" && b1?.source === "default" && typeof b1?.hint === "string" && b1.hint.length > 0 &&
        b1?.repo === null, JSON.stringify(b1));
    backendOf(await s.call("deck_project_list", {}));
    check("提示位: 连续两次清单都不出站(假 gh 零调用)",
      !existsSync(log) || readFileSync(log, "utf8") === "", existsSync(log) ? readFileSync(log, "utf8") : "(无日志)");
  } finally {
    await s.stop();
    rmSync(base, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 切片 H:回归 —— 本地 Markdown 项目除 active.backend 外字段照旧;读工具回包不出现 backend 键。
// ---------------------------------------------------------------------------
async function sliceRegression() {
  const s = await startServer(FIX_MIXED);
  try {
    const r = await s.call("deck_project_list", {});
    const sc = r.result?.structuredContent || {};
    check("回归: 清单回包顶层字段照旧(ok/active/home/projects/warnings/registry/note)",
      JSON.stringify(Object.keys(sc).sort()) ===
        JSON.stringify(["active", "home", "note", "ok", "projects", "registry", "warnings"]),
      JSON.stringify(Object.keys(sc)));
    check("回归: 活动项目只多 backend 一块(name/path/isHome 照旧)",
      JSON.stringify(Object.keys(sc.active || {}).sort()) === JSON.stringify(["backend", "isHome", "name", "path"]) &&
        sc.active?.name === "mixed" && sc.active?.isHome === true && samePath(sc.active?.path, FIX_MIXED),
      JSON.stringify(sc.active));
    check("回归: registry/warnings/projects 照旧",
      sc.registry?.status === "missing" && sc.registry?.error === null && Array.isArray(sc.warnings) && sc.warnings.length === 0 &&
        sc.projects?.length === 1 && sc.projects[0]?.isHome === true, JSON.stringify(sc.registry));

    const use = await s.call("deck_project_use", { name: "mixed" });
    check("回归: deck_project_use 回包也带 backend(markdown / default)",
      !use.result?.isError && backendOf(use)?.id === "markdown" && backendOf(use)?.source === "default",
      JSON.stringify(backendOf(use)));

    const lr = await s.call("deck_issue_list", {});
    const lsc = lr.result?.structuredContent || {};
    check("回归: deck_issue_list 行数照旧(8 行)", lsc.rows?.length === 8, `got ${lsc.rows?.length}`);
    check("回归: deck_issue_list 回包不出现 backend 键", !JSON.stringify(lsc).includes('"backend"'));

    const firstKey = lsc.rows?.[0]?.key;
    const gr = await s.call("deck_issue_get", { key: firstKey });
    const gsc = gr.result?.structuredContent || {};
    check("回归: deck_issue_get 回包不出现 backend 键",
      !gr.result?.isError && !!gsc.card && !JSON.stringify(gsc).includes('"backend"'), JSON.stringify(gsc.card?.key));

    const cr = await s.call("deck_issue_counts", {});
    const csc = cr.result?.structuredContent || {};
    check("回归: deck_issue_counts 回包不出现 backend 键,open 数照旧(4)",
      !cr.result?.isError && csc.counts?.open === 4 && !JSON.stringify(csc).includes('"backend"'),
      JSON.stringify(csc.counts));
  } finally {
    await s.stop();
  }
}

// ---------------------------------------------------------------------------
// 切片 I:worktree 形态 —— .git 是指针文件,顺 gitdir:/commondir 读真实 config 也能解析仓库。
// ---------------------------------------------------------------------------
async function sliceWorktreePointer() {
  const base = mkdtempSync(join(tmpdir(), "deck-backend-worktree-"));
  const ws = makeWorkspace("", base);
  const mainGit = join(base, "main", ".git");
  const wtGit = join(mainGit, "worktrees", "wt");
  mkdirSync(wtGit, { recursive: true });
  writeFileSync(join(mainGit, "config"), `[remote "origin"]\n\turl = git@github.com:ptr/repo.git\n`, "utf8");
  writeFileSync(join(wtGit, "commondir"), "../..", "utf8");
  writeFileSync(join(ws, ".git"), `gitdir: ${wtGit}\n`, "utf8"); // .git 是文件,不是目录
  const log = join(base, "gh.log");
  const s = await startServer(ws, {
    PATH: emptyPathDir(base),
    ZCODE_GH_PATH: writeFakeGh(base),
    ZCODE_FAKE_GH_LOG: log,
  });
  try {
    const b = backendOf(await s.call("deck_project_list", {}));
    check("worktree: .git 是指针文件也算有仓库(本地 Markdown 下 hint 非空)",
      b?.id === "markdown" && typeof b?.hint === "string" && b.hint.length > 0, JSON.stringify(b));
    const r = await s.call("deck_backend_use", { backend: "github" });
    check("worktree: 顺 gitdir/commondir 读到远端(切 github 后 repo.name=ptr/repo)",
      !r.result?.isError && backendOf(r)?.repo?.name === "ptr/repo", JSON.stringify(backendOf(r) || r.result || r.error));
  } finally {
    await s.stop();
    rmSync(base, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 切片 A:默认本地 + 锚文件三种标题(不分大小写)+ GitLab 按本地走 + 每次调用现读。
// ---------------------------------------------------------------------------
async function sliceDefaultAndAnchor() {
  const base = mkdtempSync(join(tmpdir(), "deck-backend-anchor-"));
  const ws = makeWorkspace("", base);
  const s = await startServer(ws);
  try {
    // a. 没有锚文件、没有 .git:默认本地 Markdown。
    const r = await s.call("deck_project_list", {});
    const b = backendOf(r);
    check(
      "默认: active.backend = 本地 Markdown / default / 无仓库 / 无提示",
      b && b.id === "markdown" && b.source === "default" && b.repo === null && b.writable === null && b.hint === null,
      JSON.stringify(b || r.result || r.error)
    );
    check(
      "默认: backend 就在活动项目块里(name/path/isHome 照旧)",
      r.result?.structuredContent?.active?.name === "ws" && samePath(r.result?.structuredContent?.active?.path, ws) === true &&
        r.result?.structuredContent?.active?.isHome === true,
      JSON.stringify(r.result?.structuredContent?.active)
    );

    // 仓库里的测试夹具会继承父仓远端 —— 必须证明锚在项目根自己的 .git 上。
    const outside = await startServer(FIX_MIXED);
    try {
      const rb = backendOf(await outside.call("deck_project_list", {}));
      check(
        "默认: 仓库内的夹具目录不继承父仓 GitHub 远端(repo=null, hint=null)",
        rb && rb.id === "markdown" && rb.source === "default" && rb.repo === null && rb.hint === null,
        JSON.stringify(rb)
      );
    } finally {
      await outside.stop();
    }

    // b. 三种标题各判对;github 锚文件无仓库时 repo 仍是 null(仓库留给后续票接)。
    writeAnchor(ws, "# Issue tracker: GitHub");
    let b1 = backendOf(await s.call("deck_project_list", {}));
    check("锚文件: `# Issue tracker: GitHub` → github / anchor",
      b1 && b1.id === "github" && b1.source === "anchor", JSON.stringify(b1));

    writeAnchor(ws, "# Issue tracker: Local Markdown");
    let b2 = backendOf(await s.call("deck_project_list", {}));
    check("锚文件: `# Issue tracker: Local Markdown` → markdown / anchor",
      b2 && b2.id === "markdown" && b2.source === "anchor", JSON.stringify(b2));

    writeAnchor(ws, "# Issue tracker: markdown");
    let b3 = backendOf(await s.call("deck_project_list", {}));
    check("锚文件: `# Issue tracker: markdown` → markdown / anchor",
      b3 && b3.id === "markdown" && b3.source === "anchor", JSON.stringify(b3));

    writeAnchor(ws, "# ISSUE TRACKER: GITHUB");
    let b4 = backendOf(await s.call("deck_project_list", {}));
    check("锚文件: 大小写变体也认(`# ISSUE TRACKER: GITHUB` → github / anchor)",
      b4 && b4.id === "github" && b4.source === "anchor", JSON.stringify(b4));

    writeAnchor(ws, "# Issue tracker: GitLab");
    let b5 = backendOf(await s.call("deck_project_list", {}));
    check("锚文件: GitLab → 按本地 markdown 走 / anchor",
      b5 && b5.id === "markdown" && b5.source === "anchor", JSON.stringify(b5));
    check("锚文件: GitLab 的 hint 说明本版不支持",
      typeof b5?.hint === "string" && /GitLab/.test(b5.hint) && /不支持/.test(b5.hint), String(b5?.hint));

    // 只认一级标题:正文出现关键词不算声明;二级标题也不算。
    writeAnchor(ws, "## Issue tracker: GitHub");
    let b6 = backendOf(await s.call("deck_project_list", {}));
    check("锚文件: 二级标题不算声明 → 默认 markdown / default",
      b6 && b6.id === "markdown" && b6.source === "default", JSON.stringify(b6));
    mkdirSync(join(ws, "docs", "agents"), { recursive: true });
    writeFileSync(join(ws, "docs", "agents", "issue-tracker.md"), "我们用 GitHub Issues,也会敲 gh issue。\n", "utf8");
    let b7 = backendOf(await s.call("deck_project_list", {}));
    check("锚文件: 正文只需关键词不兜底 → 默认 markdown / default",
      b7 && b7.id === "markdown" && b7.source === "default", JSON.stringify(b7));

    // 每次调用现读:删掉锚文件即回默认。
    rmSync(join(ws, "docs", "agents", "issue-tracker.md"));
    let b8 = backendOf(await s.call("deck_project_list", {}));
    check("锚文件: 每次调用现读,删掉后回默认 markdown / default",
      b8 && b8.id === "markdown" && b8.source === "default", JSON.stringify(b8));
  } finally {
    await s.stop();
    rmSync(base, { recursive: true, force: true });
  }
}

await sliceDefaultAndAnchor();
await sliceSessionWins();
await slicePerRoot();
await sliceSessionReset();
await sliceInvalidName();
await slicePreflight();
await sliceHint();
await sliceRegression();
await sliceWorktreePointer();

console.log(failures === 0 ? `\n全部通过(${checks} 项断言)` : `\n${failures} 项失败(${checks} 项断言)`);
process.exit(failures === 0 ? 0 : 1);
