// 票 02 缝测试:写路径、监听与环境检查跟随活动项目。
// 沿用 server-project / server-write / live-refresh 的会话形状:spawn dist/server.mjs,
// 临时根 mkdtemp(结束删净),断言只打工具回包与磁盘文件,不 import 服务端内部模块。
//   - W1:六件写工具写活动项目,home-repo 逐字不动;摘要带项目名(仅非 home 时)。
//   - W2:监听随切换停旧挂新;revision 单调且切换恰好 +1;旧根编辑不再推进。
//   - W3:新根无 .scratch → 监听不挂,counts 轮询兜底推进 revision。
//   - W4:deck_env_check 的 scratch/cards/watch/git 步随活动根;技能步锚 home-repo。
//   - W5:退避重试取消,旧根 watcher 不复活。
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // zcode-plugin/
const DEBOUNCE = 80; // 收短的合并窗(缺省 1200)
const GRID = 160; // 收短的同步栅格(缺省 4000)

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`ok - ${name}`);
  else {
    failures++;
    console.error(`FAIL - ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 起一个指向指定工作区根的 server 会话(收短发条);交回 call/rpc/stop。 */
async function startServer(workspaceRoot, extraEnv = {}) {
  const child = spawn(process.execPath, [join(ROOT, "dist", "server.mjs")], {
    stdio: ["pipe", "pipe", "inherit"],
    env: {
      ...process.env,
      ZCODE_WORKSPACE_ROOT: workspaceRoot,
      ZCODE_REFRESH_DEBOUNCE_MS: String(DEBOUNCE),
      ZCODE_REFRESH_GRID_MS: String(GRID),
      ...extraEnv,
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

/** 一张最小工单卡:.scratch/<effort>/issues/NN-slug.md。 */
function writeCard(projectRoot, effort, n, slug, title) {
  mkdirSync(join(projectRoot, ".scratch", effort, "issues"), { recursive: true });
  writeFileSync(join(projectRoot, ".scratch", effort, "issues", `${n}-${slug}.md`), `# ${n}: ${title}\n\n**Status:** open\n\n正文。\n`, "utf8");
}

function writeRegistry(homeRoot, projects) {
  mkdirSync(join(homeRoot, ".deck"), { recursive: true });
  writeFileSync(join(homeRoot, ".deck", "projects.json"), JSON.stringify({ version: 1, projects }, null, 2), "utf8");
}

/** .scratch/ 全树快照:相对路径 → 文件内容(逐字比对 home 不被误写)。 */
function snapshotTree(rootDir) {
  const out = {};
  const walk = (dir, rel) => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${f.name}` : f.name;
      if (f.isDirectory()) walk(join(dir, f.name), r);
      else out[r] = readFileSync(join(dir, f.name), "utf8");
    }
  };
  walk(join(rootDir, ".scratch"), "");
  return out;
}

/** 轮询 counts 直到谓词满足或超时(返回最后一次 sc,超时返回 null)。 */
async function untilCounts(s, pred, timeoutMs = 3000) {
  const t0 = Date.now();
  for (;;) {
    const sc = (await s.call("deck_issue_counts", {})).result?.structuredContent;
    if (sc && pred(sc)) return sc;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(40);
  }
}

// ---------------------------------------------------------------------------
// W1:六件写工具落活动项目;home-repo 逐字不动;摘要带项目名(仅活动 ≠ home)。
// ---------------------------------------------------------------------------
async function sliceWrites() {
  const base = mkdtempSync(join(tmpdir(), "deck-proj-write-"));
  const homeRoot = join(base, "home");
  const projA = join(base, "proj-a");
  for (const p of [homeRoot, projA]) mkdirSync(p, { recursive: true });
  writeCard(homeRoot, "m1", "01", "home-card", "home 卡");
  writeCard(projA, "alpha", "01", "alpha-card", "alpha 卡");
  writeCard(projA, "alpha", "02", "alpha-2", "alpha 二号");
  writeRegistry(homeRoot, [{ name: "alpha", path: projA }]);

  const s = await startServer(homeRoot);
  try {
    // 未切换(home):评论一次,摘要与现状同形(不带项目名前缀)。
    const homeBefore = await s.call("deck_issue_comment", { key: "m1/01", body: "还在 home。" });
    const homeText = homeBefore.result?.content?.[0]?.text || "";
    check("W1: home 模式评论无错误", !homeBefore.result?.isError, homeText);
    check("W1: home 模式摘要逐字同形(已在 # 开头,无项目名前缀)",
      homeText.startsWith("已在 #") && !homeText.includes("项目"), homeText);
    const homeSnap = snapshotTree(homeRoot);

    // 切到 alpha。
    const use = await s.call("deck_project_use", { name: "alpha" });
    check("W1: 切换成功", !use.result?.isError, JSON.stringify(use.result || use.error));

    // 1) 评论 → projA 的卡
    const c = await s.call("deck_issue_comment", { key: "alpha/01", body: "写到活动项目。" });
    const cText = c.result?.content?.[0]?.text || "";
    check("W1: 评论应答无错误", !c.result?.isError, cText);
    check("W1: 评论摘要带项目名前缀", cText.startsWith("项目 alpha:") && /#alpha\/01/.test(cText), cText);
    const cDisk = readFileSync(join(projA, ".scratch", "alpha", "issues", "01-alpha-card.md"), "utf8");
    check("W1: 评论落在活动项目的卡片文件", cDisk.includes("### local — ") && cDisk.includes("写到活动项目。"), cDisk.slice(-120));

    // 2) 状态 → projA
    const u = await s.call("deck_issue_update", { key: "alpha/01", status: "claimed" });
    check("W1: 改状态无错误且摘要带项目名",
      !u.result?.isError && (u.result?.content?.[0]?.text || "").startsWith("项目 alpha:"), u.result?.content?.[0]?.text);
    check("W1: 状态行改在活动项目文件", readFileSync(join(projA, ".scratch", "alpha", "issues", "01-alpha-card.md"), "utf8").includes("**Status:** claimed"));

    // 3) 标签 → projA(+ 同值 noop 摘要也带项目名)
    const l = await s.call("deck_issue_set_labels", { key: "alpha/01", labels: ["bug"] });
    check("W1: 打标签无错误且摘要带项目名",
      !l.result?.isError && (l.result?.content?.[0]?.text || "").startsWith("项目 alpha:"), l.result?.content?.[0]?.text);
    check("W1: 标签写在活动项目文件(无可见行 → DSH-LABELS 注释)", readFileSync(join(projA, ".scratch", "alpha", "issues", "01-alpha-card.md"), "utf8").includes("<!-- DSH-LABELS: bug -->"));
    const lNoop = await s.call("deck_issue_set_labels", { key: "alpha/01", labels: ["bug"] });
    check("W1: noop 摘要同样带项目名",
      lNoop.result?.structuredContent?.changed === false && (lNoop.result?.content?.[0]?.text || "").startsWith("项目 alpha:"), lNoop.result?.content?.[0]?.text);

    // 4) 关门(带原因)→ 5) 重开 → projA
    const cl = await s.call("deck_issue_close", { key: "alpha/02", reason: "收工。" });
    check("W1: 关门无错误且摘要带项目名",
      !cl.result?.isError && (cl.result?.content?.[0]?.text || "").startsWith("项目 alpha:"), cl.result?.content?.[0]?.text);
    const clDisk = readFileSync(join(projA, ".scratch", "alpha", "issues", "02-alpha-2.md"), "utf8");
    check("W1: 关门改的是活动项目文件(状态 closed + 原因评论)", clDisk.includes("**Status:** closed") && clDisk.includes("收工。"), clDisk);
    const ro = await s.call("deck_issue_reopen", { key: "alpha/02" });
    check("W1: 重开无错误且摘要带项目名",
      !ro.result?.isError && (ro.result?.content?.[0]?.text || "").startsWith("项目 alpha:"), ro.result?.content?.[0]?.text);
    check("W1: 重开写在活动项目文件", readFileSync(join(projA, ".scratch", "alpha", "issues", "02-alpha-2.md"), "utf8").includes("**Status:** ready-for-agent"));

    // 6) 建票 → projA(.scratch/alpha/issues 下一个编号)
    const cr = await s.call("deck_issue_create", { effort: "alpha", title: "活动项目新票", labels: ["needs-triage"] });
    const crText = cr.result?.content?.[0]?.text || "";
    check("W1: 建票无错误且摘要带项目名", !cr.result?.isError && crText.startsWith("项目 alpha:"), crText);
    check("W1: 新票文件落在活动项目", existsSync(join(projA, ".scratch", "alpha", "issues", "03-活动项目新票.md")), "");

    // 失败路径摘要也带项目名(错目标在结果里就能看见)。
    const miss = await s.call("deck_issue_update", { key: "99", status: "open" });
    check("W1: 失败摘要带项目名且点名活动项目",
      miss.result?.isError === true && /项目 alpha:/.test(miss.result?.content?.[0]?.text || ""), miss.result?.content?.[0]?.text);

    // home-repo 逐字不变:快照逐一比对 + 没有新文件。
    const homeAfter = snapshotTree(homeRoot);
    const sameKeys = Object.keys(homeAfter).length === Object.keys(homeSnap).length &&
      Object.keys(homeSnap).every((k) => homeAfter[k] === homeSnap[k]);
    check("W1: home-repo 的 .scratch 逐字不动(内容与文件集全同)", sameKeys,
      JSON.stringify({ before: Object.keys(homeSnap).length, after: Object.keys(homeAfter).length }));

    // 切回 home:摘要回到现状逐字同形。
    await s.call("deck_project_use", { name: "home" });
    const homeBack = await s.call("deck_issue_comment", { key: "m1/01", body: "回 home 再评。" });
    const hbText = homeBack.result?.content?.[0]?.text || "";
    check("W1: 切回 home 后摘要恢复现状(无项目名前缀)", !homeBack.result?.isError && hbText.startsWith("已在 #") && !hbText.includes("项目"), hbText);
    check("W1: 切回 home 后评论落回本仓文件", readFileSync(join(homeRoot, ".scratch", "m1", "issues", "01-home-card.md"), "utf8").includes("回 home 再评。"));
  } finally {
    await s.stop();
    rmSync(base, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// W2:监听随切换停旧挂新。revision 单调;切换本身恰好推进 +1(票 02 口径:新实例
// 从旧 revision 起步,初扫必推进一次);旧根编辑不再推进,新根编辑推进。
// ---------------------------------------------------------------------------
async function sliceWatchFollow() {
  const base = mkdtempSync(join(tmpdir(), "deck-proj-watch-"));
  const homeRoot = join(base, "home");
  const projA = join(base, "proj-a");
  for (const p of [homeRoot, projA]) mkdirSync(p, { recursive: true });
  writeCard(homeRoot, "m1", "01", "home-card", "home 卡");
  writeCard(projA, "alpha", "01", "alpha-card", "alpha 卡");
  writeRegistry(homeRoot, [{ name: "alpha", path: projA }]);

  const s = await startServer(homeRoot);
  try {
    const revAt = async () => (await s.call("deck_issue_counts", {})).result?.structuredContent?.revision;
    const r0 = await revAt();
    check("W2: 起点在线,revision 是整数(首态 1)", r0 === 1, JSON.stringify(r0));

    const use = await s.call("deck_project_use", { name: "alpha" });
    check("W2: 切换成功", !use.result?.isError, JSON.stringify(use.result || use.error));
    const r1 = await revAt();
    check("W2: 切换本身恰好推进 +1(旧根停、新根挂上即成新首态)", r1 === r0 + 1, `${r0} → ${r1}`);
    check("W2: revision 单调不减", r1 >= r0, `${r0} → ${r1}`);

    // 旧根(home)编辑:监听已停,revision 不再推进。
    writeCard(homeRoot, "m1", "02", "home-2", "home 二号");
    await sleep(DEBOUNCE + GRID * 4);
    const r2 = await revAt();
    check("W2: 旧根编辑不推进 revision", r2 === r1, `${r1} → ${r2}`);

    // 新根(alpha)编辑:防抖 + 栅格后推进。
    writeCard(projA, "alpha", "02", "alpha-2", "alpha 二号");
    const bumped = await untilCounts(s, (sc) => sc.revision === r1 + 1 && sc.counts?.total === 2);
    check("W2: 新根编辑推进 revision 且数据跟上(票 1→2)", !!bumped, JSON.stringify(bumped && { rev: bumped.revision, total: bumped.counts?.total }));

    // 切回 home:再 +1;alpha(已成旧根)编辑不再推进。
    await s.call("deck_project_use", { name: "home" });
    const r3 = await revAt();
    check("W2: 切回 home 也是 +1", r3 === r1 + 2, `${r1 + 1} → ${r3}`);
    writeCard(projA, "alpha", "03", "alpha-3", "alpha 三号");
    await sleep(DEBOUNCE + GRID * 4);
    const r4 = await revAt();
    check("W2: 回 home 后旧根(alpha)编辑不再推进", r4 === r3, `${r3} → ${r4}`);
    const rows = (await s.call("deck_issue_list", {})).result?.structuredContent?.rows || [];
    check("W2: 读侧跟着活动根(home 两张)", rows.length === 2 && rows.every((r) => r.effortId === "m1"), JSON.stringify(rows.map((r) => r.effortId)));
  } finally {
    await s.stop();
    rmSync(base, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// W3:新根没有 .scratch —— 监听不挂(离线语义照旧),counts 轮询兜底推进 revision。
// 退避压到 60s,窗口内监听必然不在线:推进只能来自 counts 的请求探测。
// ---------------------------------------------------------------------------
async function sliceOfflineRoot() {
  const base = mkdtempSync(join(tmpdir(), "deck-proj-offline-"));
  const homeRoot = join(base, "home");
  const bareRoot = join(base, "bare");
  for (const p of [homeRoot, bareRoot]) mkdirSync(p, { recursive: true });
  writeCard(homeRoot, "m1", "01", "home-card", "home 卡");
  writeRegistry(homeRoot, [{ name: "bare", path: bareRoot }]);

  const s = await startServer(homeRoot, { ZCODE_REFRESH_BACKOFF_MS: "60000" });
  const envStep = async (id) =>
    ((await s.call("deck_env_check", {})).result?.structuredContent?.snapshot?.steps || []).find((x) => x.id === id);
  try {
    await s.call("deck_project_use", { name: "bare" });
    const c = await s.call("deck_issue_counts", {});
    const sc = c.result?.structuredContent || {};
    check("W3: 切到无 .scratch 的根,counts 给空态不报错",
      !c.result?.isError && sc.empty === true && sc.counts?.total === 0, JSON.stringify(sc.counts || c.result?.content));
    check("W3: 切换本身推进 revision(空根的首态)", sc.revision === 2, JSON.stringify(sc.revision));
    check("W3: 监听不挂(env:watch 非在线)", (await envStep("env:watch"))?.status !== "done", JSON.stringify(await envStep("env:watch")));

    // counts 轮询兜底:新根建卡后,离线窗口内 revision 也跟着前进。
    writeCard(bareRoot, "fresh", "01", "first", "第一张");
    const bumped = await untilCounts(s, (sc) => sc.revision === 3 && sc.counts?.total === 1);
    check("W3: counts 轮询兜底推进 revision 且数据跟上", !!bumped, JSON.stringify(bumped && { rev: bumped.revision, total: bumped.counts?.total }));
  } finally {
    await s.stop();
    rmSync(base, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// W4:deck_env_check 的 scratch/cards/watch/git 步随活动根;技能步锚 home-repo 不随项目。
// 假 HOME 收窄用户级技能根:home 有 .zcode/skills(可读),活动项目没有 —— 技能步
// 必须仍按 home 判(不假报活动项目状态);git:repo 随活动根翻转。
// ---------------------------------------------------------------------------
async function sliceEnvFollow() {
  const base = mkdtempSync(join(tmpdir(), "deck-proj-env-"));
  const homeRoot = join(base, "home");
  const projA = join(base, "proj-a");
  for (const p of [homeRoot, projA]) mkdirSync(p, { recursive: true });
  writeCard(homeRoot, "m1", "01", "home-card", "home 卡");
  writeCard(projA, "alpha", "01", "alpha-card", "alpha 卡");
  writeCard(projA, "alpha", "02", "alpha-2", "alpha 二号");
  mkdirSync(join(homeRoot, ".git"), { recursive: true });
  mkdirSync(join(homeRoot, ".zcode", "skills"), { recursive: true });
  writeRegistry(homeRoot, [{ name: "alpha", path: projA }]);

  const fakeHome = join(base, "fakehome");
  mkdirSync(fakeHome, { recursive: true });
  const fakeHomeEnv = { HOME: fakeHome, USERPROFILE: fakeHome, HOMEDRIVE: "", HOMEPATH: "" };

  const s = await startServer(homeRoot, fakeHomeEnv);
  const stepsOf = async () => (await s.call("deck_env_check", {})).result?.structuredContent?.snapshot?.steps || [];
  const stepOf = (steps, id) => steps.find((x) => x.id === id) || {};
  try {
    let steps = await stepsOf();
    check("W4: home 模式 git:repo done", stepOf(steps, "git:repo").status === "done", JSON.stringify(stepOf(steps, "git:repo")));
    check("W4: home 模式技能步 done 且点名工作区技能根",
      stepOf(steps, "env:skills").status === "done" && String(stepOf(steps, "env:skills").show?.desc || "").includes("工作区 .zcode/skills"),
      JSON.stringify(stepOf(steps, "env:skills")));
    check("W4: home 模式卡片步按本仓(1 张)", /1 张/.test(String(stepOf(steps, "scratch:cards").show?.desc || "")), JSON.stringify(stepOf(steps, "scratch:cards")));

    await s.call("deck_project_use", { name: "alpha" });
    steps = await stepsOf();
    check("W4: 切换后 git:repo 反映活动根(无 .git,非 done)",
      stepOf(steps, "git:repo").status !== "done" && /没有 \.git/.test(String(stepOf(steps, "git:repo").show?.desc || "")),
      JSON.stringify(stepOf(steps, "git:repo")));
    check("W4: 切换后卡片步按活动根(2 张全可读)",
      stepOf(steps, "scratch:cards").status === "done" && /2 张/.test(String(stepOf(steps, "scratch:cards").show?.desc || "")),
      JSON.stringify(stepOf(steps, "scratch:cards")));
    check("W4: 切换后监听步在线(新根挂上)", stepOf(steps, "env:watch").status === "done", JSON.stringify(stepOf(steps, "env:watch")));
    check("W4: 技能步仍锚 home-repo(done,不随项目假掉)",
      stepOf(steps, "env:skills").status === "done" && String(stepOf(steps, "env:skills").show?.desc || "").includes("工作区 .zcode/skills"),
      JSON.stringify(stepOf(steps, "env:skills")));

    await s.call("deck_project_use", { name: "home" });
    steps = await stepsOf();
    check("W4: 切回 home 后 git:repo 恢复 done", stepOf(steps, "git:repo").status === "done", JSON.stringify(stepOf(steps, "git:repo")));
    check("W4: 切回 home 后卡片步恢复本仓计数", /1 张/.test(String(stepOf(steps, "scratch:cards").show?.desc || "")), JSON.stringify(stepOf(steps, "scratch:cards")));
  } finally {
    await s.stop();
    rmSync(base, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// W5:切换时取消待执行的退避重试 —— 旧根 .scratch 被删(离线、退避挂起)时切换,
// 之后旧根重建并编辑也不推进 revision;新根监听在线、编辑照常推进。
// (重试定时器的取消是 stop() 的结构保证;接缝上钉的是用户可见后果:revision 只随活动根走。)
// ---------------------------------------------------------------------------
async function sliceBackoffCancel() {
  const base = mkdtempSync(join(tmpdir(), "deck-proj-backoff-"));
  const homeRoot = join(base, "home");
  const projA = join(base, "proj-a");
  for (const p of [homeRoot, projA]) mkdirSync(p, { recursive: true });
  writeCard(homeRoot, "m1", "01", "home-card", "home 卡");
  writeCard(projA, "alpha", "01", "alpha-card", "alpha 卡");
  writeRegistry(homeRoot, [{ name: "alpha", path: projA }]);

  const s = await startServer(homeRoot, { ZCODE_REFRESH_BACKOFF_MS: "400,400" });
  const envStep = async (id) =>
    ((await s.call("deck_env_check", {})).result?.structuredContent?.snapshot?.steps || []).find((x) => x.id === id);
  const revAt = async () => (await s.call("deck_issue_counts", {})).result?.structuredContent?.revision;
  try {
    // 旧根 .scratch 整删 → 旧监听断链进退避(重试挂起)。
    rmSync(join(homeRoot, ".scratch"), { recursive: true, force: true });
    const t0 = Date.now();
    let wentOffline = false;
    while (Date.now() - t0 < 2500) {
      if ((await envStep("env:watch"))?.status !== "done") { wentOffline = true; break; }
      await sleep(60);
    }
    check("W5: 旧根断链后监听离线(退避挂起)", wentOffline, JSON.stringify(await envStep("env:watch")));

    const rBefore = await revAt();
    const use = await s.call("deck_project_use", { name: "alpha" });
    check("W5: 切换成功", !use.result?.isError, JSON.stringify(use.result || use.error));
    const rAfter = await revAt();
    check("W5: 切换仍恰好 +1(重试被取消,不叠加推进)", rAfter === rBefore + 1, `${rBefore} → ${rAfter}`);

    await sleep(1200); // 旧实例若有未取消的重试,此窗口内必然已到期
    // 旧根重建并编辑:复活也绝不推进 revision。
    writeCard(homeRoot, "revived", "01", "revived", "不该出现的票");
    await sleep(DEBOUNCE + GRID * 4);
    const rStable = await revAt();
    check("W5: 旧根重建/编辑不推进 revision(watcher 不复活)", rStable === rAfter, `${rAfter} → ${rStable}`);
    check("W5: 新根监听在线(env:watch done)", (await envStep("env:watch"))?.status === "done", JSON.stringify(await envStep("env:watch")));

    writeCard(projA, "alpha", "02", "alpha-2", "alpha 二号");
    const bumped = await untilCounts(s, (sc) => sc.revision === rAfter + 1 && sc.counts?.total === 2);
    check("W5: 新根编辑照常推进", !!bumped, JSON.stringify(bumped && { rev: bumped.revision, total: bumped.counts?.total }));
  } finally {
    await s.stop();
    rmSync(base, { recursive: true, force: true });
  }
}

await sliceWrites();
await sliceWatchFollow();
await sliceOfflineRoot();
await sliceEnvFollow();
await sliceBackoffCancel();

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
