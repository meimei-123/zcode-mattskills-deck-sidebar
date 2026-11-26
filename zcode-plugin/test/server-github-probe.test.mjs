// m7 票 05 缝测试:GitHub 后端的变更探测(限速、时间窗、退避、强制、计数缓存)与
// 本地 Markdown 的新鲜度回归(监听在 GitHub 项目下不挂、切回 markdown 能重新挂上)。
//
// 缝:真服务进程(dist/server.mjs)+ 假 gh(test/fixtures/fake-gh.mjs,经 ZCODE_GH_PATH 递入)。
// 断言只打工具回包与假 gh 调用日志;不 import 服务端内部模块。工作区是临时目录,结束删净。
// 计时:ZCODE_GITHUB_PROBE_MS 收短到 500ms。本机(Windows)起一次假 gh 约 100ms,
// 一拍 counts(探测 + counts + 整表列表)约 300ms;再短会让「同一拍内第二次调用」跨过
// 窗口而假红,所以断言全部用「至少/至多」+ 余量,不比对毫秒。
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { baseState, makeFakeGh, makeWorkspace } from "./gh-harness.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // zcode-plugin/
const ANCHOR_GITHUB = "# Issue tracker: GitHub\n\n本仓的票在 GitHub Issues 上。\n";
const BASE = 500; // 收短的探测基础间隔(缺省 60000)
const GAP = BASE + 250; // 等过一拍的睡眠,多给余量

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** 起一个指向指定工作区根的 server 会话(与 server-github-read 同形状)。 */
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

const callText = (c) => c.argv.join(" ");
/** 分页读取(探测与列表分页共用同一条查询):按创建时间排序的那条。 */
const isPageCall = (c) => callText(c).includes("orderBy:{field:CREATED_AT");
/** 带时间窗(since 参数)的分页读取 —— 只有「上次成功探测之后」的探测才会带。 */
const isWindowedProbe = (c) => isPageCall(c) && c.argv.some((a) => String(a).startsWith("since="));
/** 计数查询(两个 totalCount)。 */
const isCountsCall = (c) => callText(c).includes("openIssues:");
/** 整表列表查询(按更新时间排序,探测不走这条)。 */
const isWholeListCall = (c) => callText(c).includes("orderBy:{field:UPDATED_AT");

/**
 * 假 gh 的仓库状态:更新时间固定在 2020 年(过去)。
 * 探测问的是「更新时间晚于上次同步」,夹具日期若在机器时钟之后会永远算有更新,测试就假红。
 */
function stateFor({ counts } = {}) {
  const st = baseState();
  const repo = st.repos["owner/name"];
  repo.issues.forEach((it, idx) => {
    it.createdAt = `2020-01-0${idx + 1}T00:00:00Z`;
    it.updatedAt = "2020-02-01T00:00:00Z";
    it.closedAt = it.state === "CLOSED" ? "2020-02-02T00:00:00Z" : null;
  });
  if (counts) repo.counts = counts;
  return st;
}

function samePath(a, b) {
  try {
    return realpathSync.native(a) === realpathSync.native(b);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// a. 写成功推进修订号:写前后各读一次 counts,写入回包的 revision 比之前大
// ---------------------------------------------------------------------------
async function sliceWriteBumpsRevision() {
  const ws = makeWorkspace({ repo: "owner/name", anchor: ANCHOR_GITHUB });
  const gh = makeFakeGh({ state: stateFor() });
  const s = await startServer(ws.root, { ...gh.env, ZCODE_GITHUB_PROBE_MS: String(BASE) });
  try {
    const before = sc(await s.call("deck_issue_counts", {}));
    check("a. 写前 counts 正常(没有 error 块)", !before.error && !!before.counts, JSON.stringify(before.error));
    check("a. 首次探测(还没有时间窗)把已有议题算作一次更新,revision 从 0 起跳", before.revision >= 1, String(before.revision));
    const beforeOpen = before.counts.open;
    const beforeClosed = before.counts.closed;

    const closed = await s.call("deck_issue_close", { key: "4", reason: "completed" });
    check("a. 关闭议题成功", !isErr(closed) && sc(closed).ok === true, textOf(closed).slice(0, 200));
    check(
      "a. 写入回包的 revision 比之前大",
      Number.isInteger(sc(closed).revision) && sc(closed).revision > before.revision,
      JSON.stringify({ before: before.revision, write: sc(closed).revision })
    );

    const after = sc(await s.call("deck_issue_counts", {}));
    check("a. 写后 counts 的 revision 不小于写入回包(面板下一拍能看出变化)", after.revision >= sc(closed).revision, JSON.stringify({ counts: after.revision, write: sc(closed).revision }));
    check(
      "a. 写后计数跟着变(开放少一张、已关闭多一张)",
      after.counts.open === beforeOpen - 1 && after.counts.closed === beforeClosed + 1,
      JSON.stringify({ before: { open: beforeOpen, closed: beforeClosed }, after: after.counts })
    );
  } finally {
    await s.stop();
    gh.cleanup();
    ws.cleanup();
  }
}

// ---------------------------------------------------------------------------
// b. 限速:不到间隔零出站;到点恰好一条带时间窗的分页查询
// ---------------------------------------------------------------------------
async function sliceRateLimit() {
  const ws = makeWorkspace({ repo: "owner/name", anchor: ANCHOR_GITHUB });
  const gh = makeFakeGh({ state: stateFor() });
  const s = await startServer(ws.root, { ...gh.env, ZCODE_GITHUB_PROBE_MS: String(BASE) });
  try {
    const first = sc(await s.call("deck_issue_counts", {}));
    check("b. 第一拍计数正常", !!first.counts && !first.error, JSON.stringify(first.error));
    const firstCalls = gh.calls();
    check("b. 第一拍真探了一次(还没有时间窗,不带 since)", firstCalls.filter(isPageCall).length === 1 && firstCalls.filter(isWindowedProbe).length === 0, JSON.stringify(firstCalls.map(callText).slice(0, 6)));
    check("b. 第一拍取了两笔计数来源(计数 + 整表列表)", firstCalls.filter(isCountsCall).length === 1 && firstCalls.filter(isWholeListCall).length >= 1, JSON.stringify(firstCalls.map(callText).slice(0, 6)));

    // 用 force 重新锚定探测时刻:force 那拍只出站一条探测(缓存命中,不重取计数)。
    const anchorN = gh.calls().length;
    const forced = sc(await s.call("deck_issue_counts", { force: true }));
    const forcedCalls = gh.calls().slice(anchorN);
    check("b. force 拍只出站一条探测,且带时间窗", forcedCalls.length === 1 && isWindowedProbe(forcedCalls[0]), JSON.stringify(forcedCalls.map(callText)));
    check("b. force 拍回缓存,没有重取计数", isCountsCall(forcedCalls[0]) === false && forced.counts.total === first.counts.total, JSON.stringify({ n: forcedCalls.length, total: forced.counts.total }));

    await sleep(GAP);
    const dueN = gh.calls().length;
    const due = sc(await s.call("deck_issue_counts", {}));
    const dueCalls = gh.calls().slice(dueN);
    check("b. 到了间隔恰好发一条带时间窗的分页查询", dueCalls.length === 1 && isWindowedProbe(dueCalls[0]), JSON.stringify(dueCalls.map(callText)));
    check("b. 没有更新时不重取计数", due.counts.total === forced.counts.total && due.revision === forced.revision, JSON.stringify({ total: due.counts.total, revision: due.revision }));

    const gateN = gh.calls().length;
    const gated = sc(await s.call("deck_issue_counts", {}));
    check("b. 不到间隔的连续 counts 零新增 gh 调用", gh.calls().length === gateN, `${gh.calls().length} vs ${gateN}`);
    check("b. 限速拍回的是缓存(数与 revision 同上一拍)", gated.counts.total === due.counts.total && gated.revision === due.revision, JSON.stringify({ total: gated.counts.total, revision: gated.revision }));
  } finally {
    await s.stop();
    gh.cleanup();
    ws.cleanup();
  }
}

// ---------------------------------------------------------------------------
// c. 远端有更新 → revision 推进;没有更新 → revision 不变
// ---------------------------------------------------------------------------
async function sliceRemoteChange() {
  const ws = makeWorkspace({ repo: "owner/name", anchor: ANCHOR_GITHUB });
  const gh = makeFakeGh({ state: stateFor() });
  const s = await startServer(ws.root, { ...gh.env, ZCODE_GITHUB_PROBE_MS: String(BASE) });
  try {
    const first = sc(await s.call("deck_issue_counts", {}));
    const r1 = first.revision;

    // 远端改一张票:把它的 updatedAt 改成「现在」(晚于上次成功探测的时刻)。
    gh.patch((st) => {
      const issue = st.repos["owner/name"].issues.find((i) => i.number === 5);
      issue.updatedAt = new Date().toISOString();
    });
    await sleep(GAP);
    const changeN = gh.calls().length;
    const changed = sc(await s.call("deck_issue_counts", {}));
    const changeCalls = gh.calls().slice(changeN);
    check("c. 远端有更新:探测后的 revision 推进", changed.revision > r1, JSON.stringify({ before: r1, after: changed.revision }));
    check("c. 远端有更新:探测带时间窗且只探一条", changeCalls.filter(isPageCall).length === 1 && changeCalls.filter(isWindowedProbe).length === 1, JSON.stringify(changeCalls.map(callText)));
    check("c. 远端有更新:计数缓存失效、重新取了一笔", changeCalls.filter(isCountsCall).length === 1, JSON.stringify(changeCalls.map(callText)));

    const r2 = changed.revision;
    await sleep(GAP);
    const stableN = gh.calls().length;
    const stable = sc(await s.call("deck_issue_counts", {}));
    const stableCalls = gh.calls().slice(stableN);
    check("c. 没有更新:revision 不变(不重画)", stable.revision === r2, JSON.stringify({ before: r2, after: stable.revision }));
    check("c. 没有更新:只出站一条探测,不重取计数", stableCalls.length === 1 && isWindowedProbe(stableCalls[0]), JSON.stringify(stableCalls.map(callText)));
  } finally {
    await s.stop();
    gh.cleanup();
    ws.cleanup();
  }
}

// ---------------------------------------------------------------------------
// d. 连续失败:探测间隔加倍、失败期间不推进修订号;成功一次恢复基础间隔
//    退避只管探测(分页查询)。探测被限速时没缓存,票面口径是仍尝试取计数(会失败);
//    所以这里数「探测次数」,不数全部 gh 调用。
// ---------------------------------------------------------------------------
async function sliceBackoff() {
  const ws = makeWorkspace({ repo: "owner/name", anchor: ANCHOR_GITHUB });
  const gh = makeFakeGh({ state: stateFor() });
  const s = await startServer(ws.root, { ...gh.env, ZCODE_GITHUB_PROBE_MS: String(BASE) });
  const probes = () => gh.calls().filter(isPageCall).length;
  try {
    // 进入限流:第一次探测就失败,且没有缓存 → 回错误(不编数)。
    gh.patch((st) => {
      st.fail = "ratelimit";
    });
    const first = await s.call("deck_issue_counts", {});
    check("d. 限流首拍回错误(没有缓存不编数)", isErr(first) && (sc(first).error || {}).kind === "rate-limit", JSON.stringify(sc(first).error));
    check("d. 限流首拍人话提到限流", /限流|过于频繁/.test(textOf(first)), textOf(first).slice(0, 200));
    const p1 = probes();
    check("d. 限流首拍探了一次", p1 === 1, String(p1));

    // 立即再拍:失败一次后探测间隔已翻倍到 2*BASE,这一拍不再探测。
    await s.call("deck_issue_counts", {});
    check("d. 失败一次后,基础间隔内不再探测(间隔已翻倍)", probes() === p1, `${probes()} vs ${p1}`);

    // 等过 2*BASE:第二次失败(间隔下次变 4*BASE)。
    await sleep(2 * BASE + 220);
    await s.call("deck_issue_counts", {});
    check("d. 等过 2*BASE 才又探测(第二次失败)", probes() === p1 + 1, `${probes()} vs ${p1 + 1}`);
    const p2 = probes();

    // 第二次失败后,2*BASE 已经不够(要 4*BASE)—— 证明间隔随失败加倍。
    await sleep(2 * BASE + 100);
    await s.call("deck_issue_counts", {});
    check("d. 第二次失败后 2*BASE 不够了(间隔加到 4*BASE)", probes() === p2, `${probes()} vs ${p2}`);

    // 补足 4*BASE:第三次失败。
    await sleep(2 * BASE + 250);
    await s.call("deck_issue_counts", {});
    check("d. 等过 4*BASE 才第三次探测", probes() === p2 + 1, `${probes()} vs ${p2 + 1}`);

    // 恢复:force 成功一次 → 失败数清零、间隔回基础档、修订号只推进这一次。
    gh.patch((st) => {
      st.fail = null;
    });
    const recovered = sc(await s.call("deck_issue_counts", { force: true }));
    check("d. 恢复后一拍成功并重建缓存", !!recovered.counts && !recovered.error, JSON.stringify(recovered.error));
    check("d. 失败期间修订号没推进(恢复后恰好是首次成功的 +1)", recovered.revision === 1, String(recovered.revision));

    const recoverN = gh.calls().length;
    await s.call("deck_issue_counts", {});
    check("d. 恢复后立即再拍仍按基础间隔限速", gh.calls().length === recoverN, `${gh.calls().length} vs ${recoverN}`);
    await sleep(GAP);
    const afterN = gh.calls().length;
    await s.call("deck_issue_counts", {});
    check("d. 恢复基础间隔:等过一拍就又探一次", gh.calls().length === afterN + 1, `${gh.calls().length} vs ${afterN + 1}`);

    // 探测失败但有缓存:回缓存并注明这次没探到远端。
    gh.patch((st) => {
      st.fail = "ratelimit";
    });
    const cachedReply = await s.call("deck_issue_counts", { force: true });
    check("d. 探测失败但有缓存:不回错误、回上次的计数", !isErr(cachedReply) && sc(cachedReply).counts.total === recovered.counts.total, textOf(cachedReply).slice(0, 200));
    check("d. 探测失败有缓存时人话注明没探到远端", /没探到远端/.test(textOf(cachedReply)), textOf(cachedReply).slice(0, 200));
  } finally {
    await s.stop();
    gh.cleanup();
    ws.cleanup();
  }
}

// ---------------------------------------------------------------------------
// e. force:间隔内也真探一次,并推进探测时刻
// ---------------------------------------------------------------------------
async function sliceForce() {
  const ws = makeWorkspace({ repo: "owner/name", anchor: ANCHOR_GITHUB });
  const gh = makeFakeGh({ state: stateFor() });
  const s = await startServer(ws.root, { ...gh.env, ZCODE_GITHUB_PROBE_MS: String(BASE) });
  try {
    const first = sc(await s.call("deck_issue_counts", {}));
    const n = gh.calls().length;
    const forced = sc(await s.call("deck_issue_counts", { force: true }));
    const forcedCalls = gh.calls().slice(n);
    check("e. 间隔内 force 也真探一次(正好一条)", forcedCalls.length === 1 && isWindowedProbe(forcedCalls[0]), JSON.stringify(forcedCalls.map(callText)));
    check("e. force 拍回的是缓存", forced.counts.total === first.counts.total && forced.revision === first.revision, JSON.stringify({ total: forced.counts.total, revision: forced.revision }));

    const n2 = gh.calls().length;
    await s.call("deck_issue_counts", {});
    check("e. force 推进了探测时刻:下一拍不带 force 又回到限速", gh.calls().length === n2, `${gh.calls().length} vs ${n2}`);
    await sleep(GAP);
    const n3 = gh.calls().length;
    await s.call("deck_issue_counts", {});
    check("e. 过了一个基础间隔才又能探", gh.calls().length === n3 + 1, `${gh.calls().length} vs ${n3 + 1}`);
  } finally {
    await s.stop();
    gh.cleanup();
    ws.cleanup();
  }
}

// ---------------------------------------------------------------------------
// f. 计数缓存:探测无变化不出站、计数与 revision 不变;有变化重新取数
// ---------------------------------------------------------------------------
async function sliceCountsCache() {
  const ws = makeWorkspace({ repo: "owner/name", anchor: ANCHOR_GITHUB });
  const gh = makeFakeGh({ state: stateFor({ counts: { open: 7, closed: 5 } }) });
  const s = await startServer(ws.root, { ...gh.env, ZCODE_GITHUB_PROBE_MS: String(BASE) });
  try {
    const first = sc(await s.call("deck_issue_counts", {}));
    check("f. 计数信后端(7 开放 / 5 关闭)", first.counts.open === 7 && first.counts.closed === 5 && first.counts.total === 12, JSON.stringify(first.counts));
    const n = gh.calls().length;
    const second = sc(await s.call("deck_issue_counts", {}));
    check("f. 探测无变化时第二次不出站", gh.calls().length === n, `${gh.calls().length} vs ${n}`);
    check("f. 第二次回缓存:计数与 revision 都与上次相同", second.counts.open === 7 && second.counts.total === 12 && second.revision === first.revision, JSON.stringify({ counts: second.counts, revision: second.revision }));

    // 远端改数 + 改一张票的更新时间 → 探测发现变化,计数重新取。
    gh.patch((st) => {
      st.repos["owner/name"].counts = { open: 20, closed: 2 };
      st.repos["owner/name"].issues.find((i) => i.number === 5).updatedAt = new Date().toISOString();
    });
    await sleep(GAP);
    const changed = sc(await s.call("deck_issue_counts", {}));
    check("f. 探测有变化时重新取数(数字跟着变)", changed.counts.open === 20 && changed.counts.closed === 2 && changed.counts.total === 22, JSON.stringify(changed.counts));
    check("f. 探测有变化时 revision 推进", changed.revision > first.revision, JSON.stringify({ before: first.revision, after: changed.revision }));

    const n2 = gh.calls().length;
    const again = sc(await s.call("deck_issue_counts", {}));
    check("f. 变化后再拍又走缓存(零新增调用)", gh.calls().length === n2 && again.counts.open === 20, `${gh.calls().length} vs ${n2}`);
  } finally {
    await s.stop();
    gh.cleanup();
    ws.cleanup();
  }
}

// ---------------------------------------------------------------------------
// g. 本地 Markdown 不变:写卡片后 revision 照旧推进,counts 回包与现状一致
// ---------------------------------------------------------------------------
async function sliceMarkdownRegression() {
  const ws = makeWorkspace({ repo: "owner/name", anchor: null, cards: [{ effort: "demo", n: "01", slug: "one", title: "第一张" }] });
  const gh = makeFakeGh({ state: stateFor() });
  const s = await startServer(ws.root, {
    ...gh.env,
    ZCODE_GITHUB_PROBE_MS: String(BASE),
    ZCODE_REFRESH_DEBOUNCE_MS: "80",
    ZCODE_REFRESH_GRID_MS: "160",
  });
  try {
    const first = sc(await s.call("deck_issue_counts", {}));
    check("g. markdown counts 键集与现状一致", JSON.stringify(Object.keys(first).sort()) === JSON.stringify(["counts", "empty", "revision", "workspaceRoot"]), JSON.stringify(Object.keys(first).sort()));
    check("g. markdown 计数正常(1 张开放)", first.counts.total === 1 && first.counts.open === 1, JSON.stringify(first.counts));

    const created = await s.call("deck_issue_create", { effort: "demo", title: "第二张" });
    check("g. 写卡片成功", !isErr(created) && sc(created).ok === true, textOf(created).slice(0, 200));

    const after = sc(await s.call("deck_issue_counts", {}));
    check("g. 写卡片后 revision 照旧推进", Number.isInteger(after.revision) && after.revision > first.revision, JSON.stringify({ before: first.revision, after: after.revision }));
    check("g. 写卡片后计数跟着变(2 张)", after.counts.total === 2 && after.counts.open === 2, JSON.stringify(after.counts));
    check("g. markdown 全程零 gh 调用", gh.calls().length === 0, JSON.stringify(gh.calls().map(callText)));
  } finally {
    await s.stop();
    gh.cleanup();
    ws.cleanup();
  }
}

// ---------------------------------------------------------------------------
// h. 切到 GitHub 项目再切回 markdown:监听复位没把 ensureWatch 卡死
// ---------------------------------------------------------------------------
async function sliceProjectSwitchWatch() {
  const base = mkdtempSync(join(tmpdir(), "m7-probe-switch-"));
  const homeRoot = join(base, "home");
  const ghRoot = join(base, "ghproj");
  const mdRoot = join(base, "mdproj");
  for (const p of [homeRoot, ghRoot, mdRoot]) mkdirSync(p, { recursive: true });
  const writeCard = (root, effort, n, slug, title) => {
    mkdirSync(join(root, ".scratch", effort, "issues"), { recursive: true });
    writeFileSync(join(root, ".scratch", effort, "issues", `${n}-${slug}.md`), `# ${n}: ${title}\n\n**Status:** open\n\n正文。\n`, "utf8");
  };
  writeCard(homeRoot, "m1", "01", "home-card", "home 卡");
  writeCard(mdRoot, "m1", "01", "md-card", "md 卡");
  mkdirSync(join(homeRoot, ".deck"), { recursive: true });
  writeFileSync(join(homeRoot, ".deck", "projects.json"), JSON.stringify({ version: 1, projects: [{ name: "ghproj", path: ghRoot }, { name: "mdproj", path: mdRoot }] }, null, 2), "utf8");
  mkdirSync(join(ghRoot, ".git"), { recursive: true });
  writeFileSync(
    join(ghRoot, ".git", "config"),
    `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = https://github.com/owner/name.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
    "utf8"
  );
  mkdirSync(join(ghRoot, "docs", "agents"), { recursive: true });
  writeFileSync(join(ghRoot, "docs", "agents", "issue-tracker.md"), ANCHOR_GITHUB, "utf8");

  const gh = makeFakeGh({ state: stateFor() });
  const s = await startServer(homeRoot, {
    ...gh.env,
    ZCODE_GITHUB_PROBE_MS: String(BASE),
    ZCODE_REFRESH_DEBOUNCE_MS: "80",
    ZCODE_REFRESH_GRID_MS: "160",
  });
  try {
    const home1 = sc(await s.call("deck_issue_counts", {}));
    check("h. home(markdown) counts 正常", home1.counts.total === 1 && Number.isInteger(home1.revision), JSON.stringify(home1.counts));

    const useGh = sc(await s.call("deck_project_use", { name: "ghproj" }));
    check("h. 切到 GitHub 项目", useGh.active && useGh.active.backend && useGh.active.backend.id === "github", JSON.stringify(useGh.active && useGh.active.backend));
    check("h. GitHub 项目下没有建 .scratch(不扫不挂监听)", !existsSync(join(ghRoot, ".scratch")), join(ghRoot, ".scratch"));

    const ghCounts = sc(await s.call("deck_issue_counts", {}));
    check("h. GitHub 项目的 counts 走远端(4 张票)", ghCounts.counts && ghCounts.counts.total === 4 && samePath(ghCounts.workspaceRoot, ghRoot), JSON.stringify({ total: ghCounts.counts && ghCounts.counts.total, root: ghCounts.workspaceRoot }));
    check("h. GitHub 项目的计数真的出站了", gh.calls().length > 0, String(gh.calls().length));

    // 切到 markdown 项目(命中「按名字切项目」分支):监听重新挂上。
    const useMd = sc(await s.call("deck_project_use", { name: "mdproj" }));
    check("h. 切到 markdown 项目", useMd.active && useMd.active.backend && useMd.active.backend.id === "markdown", JSON.stringify(useMd.active && useMd.active.backend));
    const md1 = sc(await s.call("deck_issue_counts", {}));
    check("h. markdown 项目的 counts/revision 仍工作", md1.counts.total === 1 && Number.isInteger(md1.revision) && samePath(md1.workspaceRoot, mdRoot), JSON.stringify({ counts: md1.counts, revision: md1.revision }));
    const before = md1.revision;
    await s.call("deck_issue_create", { effort: "m1", title: "mdproj 新卡" });
    const md2 = sc(await s.call("deck_issue_counts", {}));
    check("h. 监听真的挂上了(写卡片后 revision 推进、计数跟着变)", md2.revision > before && md2.counts.total === 2, JSON.stringify({ before, after: md2.revision, total: md2.counts.total }));

    // 回 home(命中「切 home」分支):监听跟着换回 home 根。
    const useHome = sc(await s.call("deck_project_use", { name: "home" }));
    check("h. 切回 home", useHome.active && useHome.active.backend && useHome.active.backend.id === "markdown", JSON.stringify(useHome.active && useHome.active.backend));
    const home2 = sc(await s.call("deck_issue_counts", {}));
    check("h. home 的 counts 恢复(1 张票,revision 在场)", home2.counts.total === 1 && Number.isInteger(home2.revision), JSON.stringify({ counts: home2.counts, revision: home2.revision }));

    // handleBackendUse 切到 markdown 后,下一次 markdown 工具调用经 ensureWatch 挂上。
    // 当前活动项目是 home;先切到 ghproj 并手选 markdown,再读一次 counts。
    await s.call("deck_project_use", { name: "ghproj" });
    const useMdBackend = sc(await s.call("deck_backend_use", { backend: "markdown" }));
    check("h. deck_backend_use 把 GitHub 项目切成 markdown", useMdBackend.active && useMdBackend.active.backend && useMdBackend.active.backend.id === "markdown", JSON.stringify(useMdBackend.active && useMdBackend.active.backend));
    const ghAsMd = sc(await s.call("deck_issue_counts", {}));
    check("h. 切 backend 后下一次 markdown 调用能读(监听挂上、0 张票不报错)", ghAsMd.counts && ghAsMd.counts.total === 0 && Number.isInteger(ghAsMd.revision), JSON.stringify({ counts: ghAsMd.counts, revision: ghAsMd.revision, error: ghAsMd.error }));
  } finally {
    await s.stop();
    gh.cleanup();
    rmSync(base, { recursive: true, force: true });
  }
}

await sliceWriteBumpsRevision();
await sliceRateLimit();
await sliceRemoteChange();
await sliceBackoff();
await sliceForce();
await sliceCountsCache();
await sliceMarkdownRegression();
await sliceProjectSwitchWatch();

console.log(failures === 0 ? `\n全部通过(${checks} 项断言)` : `\n${failures} 项失败(${checks} 项断言)`);
process.exit(failures === 0 ? 0 : 1);
