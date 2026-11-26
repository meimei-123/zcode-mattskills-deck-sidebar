// m7 票 03 缝测试:GitHub 后端的读通路(列表整表/分页、详情与评论偏移、计数缓存、标签真色、
// 地图子票、八档错误人话、写工具未接、markdown 回归)。
//
// 缝:真服务进程(dist/server.mjs)+ 假 gh(test/fixtures/fake-gh.mjs,经 ZCODE_GH_PATH 递入)。
// 断言只打工具回包与假 gh 调用日志;不 import 服务端内部模块。工作区是临时目录(带 .git/config 远端),
// 结束删净。探测/计数缓存间隔经 ZCODE_GITHUB_PROBE_MS 收短。
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { baseState, makeFakeGh, makeWorkspace } from "./gh-harness.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // zcode-plugin/
const ANCHOR_GITHUB = "# Issue tracker: GitHub\n\n本仓的票在 GitHub Issues 上。\n";

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

/** 起一个指向指定工作区根的 server 会话(与 server-backend 同形状;rpc 超时按需放宽)。 */
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
const callsWith = (calls, needle) => calls.filter((c) => callText(c).includes(needle));
const rowsByKey = (rows) => Object.fromEntries((rows || []).map((r) => [String(r.key), r]));

/** 造 N 张普通工单(不加地图标签),创建时间递增,编号 1..N;closedEvery>0 时每隔这么多张标成已关闭。 */
function series(count, { repo = "owner/name", closedEvery = 0 } = {}) {
  const issues = [];
  for (let i = 1; i <= count; i++) {
    const closed = closedEvery > 0 && i % closedEvery === 0;
    issues.push({
      number: i,
      title: `票 ${i}`,
      state: closed ? "CLOSED" : "OPEN",
      body: `正文 ${i}`,
      url: `https://github.com/${repo}/issues/${i}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      updatedAt: new Date(Date.UTC(2026, 0, 2, 0, 0, i)).toISOString(),
      closedAt: closed ? new Date(Date.UTC(2026, 0, 3, 0, 0, i)).toISOString() : null,
      labels: [],
      assignees: [],
      author: { login: "octocat" },
      parentKey: null,
      blockedBy: [],
    });
  }
  return issues;
}

function stateWith(count, extra = {}) {
  const state = baseState();
  const repo = state.repos["owner/name"];
  state.repos["owner/name"] = { ...repo, ...extra, issues: series(count, { closedEvery: 10 }), pulls: [], comments: {} };
  return state;
}

// ---------------------------------------------------------------------------
// a. 整表列表:行字段齐全、PR 不出现、过滤两个口径、partial 在截断/降级时为真
// ---------------------------------------------------------------------------
async function sliceListWhole() {
  const ws = makeWorkspace({ repo: "owner/name", anchor: ANCHOR_GITHUB });
  const gh = makeFakeGh({ state: baseState() });
  const s = await startServer(ws.root, { ...gh.env, ZCODE_GITHUB_PROBE_MS: "200" });
  try {
    const res = await s.call("deck_issue_list", {});
    const body = sc(res);
    check("整表: 回包不是错误", !isErr(res), textOf(res).slice(0, 300));
    const rows = body.rows || [];
    const by = rowsByKey(rows);
    check("整表: 四张工单(PM 行被丢掉)", rows.length === 4 && !by["9"], JSON.stringify(rows.map((r) => r.key)));
    const r4 = by["4"] || {};
    const fields = ["key", "effortId", "type", "title", "state", "labels", "assignees", "blockedBy", "parentKey", "updatedAt", "url", "createdAt", "closedAt"];
    check("整表: 薄行字段齐全", fields.every((f) => Object.prototype.hasOwnProperty.call(r4, f)), JSON.stringify(Object.keys(r4)));
    check("整表: key 不补零 / effortId 空串 / type 由标签推出",
      r4.key === "4" && r4.effortId === "" && r4.type === "issue", JSON.stringify({ key: r4.key, effortId: r4.effortId, type: r4.type }));
    check("整表: 标签带 name/color", Array.isArray(r4.labels) && r4.labels.some((l) => l.name === "bug" && l.color === "d73a4a"), JSON.stringify(r4.labels));
    check("整表: 认领人 login", Array.isArray(r4.assignees) && r4.assignees.length === 1 && r4.assignees[0].login === "octocat", JSON.stringify(r4.assignees));
    check("整表: 父子边 parentKey", r4.parentKey === "1", String(r4.parentKey));
    check("整表: 阻塞边带 key", JSON.stringify((by["5"] || {}).blockedBy) === JSON.stringify([{ key: "4" }]), JSON.stringify((by["5"] || {}).blockedBy));
    check("整表: 地图行 type=map", (by["1"] || {}).type === "map", JSON.stringify((by["1"] || {}).type));
    check("整表: revision 在场且从 0 起", body.revision === 0, String(body.revision));
    check("整表: units 为空数组", Array.isArray(body.units) && body.units.length === 0, JSON.stringify(body.units));
    check("整表: counts 在场(行面参考,容器不计入 total)", body.counts && body.counts.total === 3 && body.counts.maps === 1, JSON.stringify(body.counts));
    check("整表: partial 为假", body.partial === false, String(body.partial));
    check("整表: workspaceRoot 指向活动项目根", body.workspaceRoot === ws.root, String(body.workspaceRoot));

    // 过滤:state / labels / type / keys
    let f = sc(await s.call("deck_issue_list", { state: "closed" }));
    check("过滤: state=closed 只回已关闭", (f.rows || []).length === 1 && f.rows[0].key === "6", JSON.stringify((f.rows || []).map((r) => r.key)));
    f = sc(await s.call("deck_issue_list", { labels: ["bug"] }));
    check("过滤: labels 为 AND", (f.rows || []).length === 1 && f.rows[0].key === "4", JSON.stringify((f.rows || []).map((r) => r.key)));
    f = sc(await s.call("deck_issue_list", { type: "map" }));
    check("过滤: type=map", (f.rows || []).length === 1 && f.rows[0].key === "1", JSON.stringify((f.rows || []).map((r) => r.key)));
    f = sc(await s.call("deck_issue_list", { type: "issue" }));
    check("过滤: type=issue", (f.rows || []).length === 3, JSON.stringify((f.rows || []).map((r) => r.key)));
    f = sc(await s.call("deck_issue_list", { keys: ["04", "5"] }));
    check("过滤: keys 接受补零写法", JSON.stringify((f.rows || []).map((r) => r.key).sort()) === JSON.stringify(["4", "5"]), JSON.stringify((f.rows || []).map((r) => r.key)));
    f = sc(await s.call("deck_issue_list", { state: "open", labels: ["bug"], type: "issue", keys: ["4"] }));
    check("过滤: 四项同时生效", (f.rows || []).length === 1 && f.rows[0].key === "4", JSON.stringify((f.rows || []).map((r) => r.key)));

    const calls = gh.calls();
    check("整表: 走的是 graphql 整表查询", callsWith(calls, "states:[OPEN,CLOSED]").length >= 1, JSON.stringify(calls.map(callText).slice(0, 4)));
    check("整表: 没有发写命令", calls.every((c) => !/^issue (create|close|reopen|comment|edit)/.test(callText(c))), JSON.stringify(calls.map(callText)));
  } finally {
    await s.stop();
    gh.cleanup();
    ws.cleanup();
  }
}

async function sliceListTruncatedAndFallback() {
  // 501 张 → 500 上限、partial 为真
  {
    const ws = makeWorkspace({ repo: "owner/name", anchor: ANCHOR_GITHUB });
    const gh = makeFakeGh({ state: stateWith(501) });
    const s = await startServer(ws.root, { ...gh.env, ZCODE_GITHUB_PROBE_MS: "200" });
    try {
      const res = await s.call("deck_issue_list", {});
      const body = sc(res);
      check("截断: 501 张只回 500 行", (body.rows || []).length === 500, String((body.rows || []).length));
      check("截断: partial 为真", body.partial === true, String(body.partial));
    } finally {
      await s.stop();
      gh.cleanup();
      ws.cleanup();
    }
  }
  // GraphQL 主路失败 → REST 降级 → partial 为真、行还在
  {
    const ws = makeWorkspace({ repo: "owner/name", anchor: ANCHOR_GITHUB });
    const gh = makeFakeGh({ state: { ...baseState(), fail: "graphql" } });
    const s = await startServer(ws.root, { ...gh.env, ZCODE_GITHUB_PROBE_MS: "200" });
    try {
      const res = await s.call("deck_issue_list", {});
      const body = sc(res);
      check("降级: 不是错误、行仍在", !isErr(res) && (body.rows || []).length === 4, textOf(res).slice(0, 300));
      check("降级: partial 为真", body.partial === true, String(body.partial));
      check("降级: 真的走了 REST 通道", gh.calls().some((c) => callText(c).includes("repos/owner/name/issues?state=all")), JSON.stringify(gh.calls().map(callText)));
    } finally {
      await s.stop();
      gh.cleanup();
      ws.cleanup();
    }
  }
}

// ---------------------------------------------------------------------------
// b. 分页列表:游标原样回传、每页 ≤50、nextCursor/total、失效游标可读错误、state+keys
// ---------------------------------------------------------------------------
async function sliceListPaged() {
  const ws = makeWorkspace({ repo: "owner/name", anchor: ANCHOR_GITHUB });
  const gh = makeFakeGh({ state: stateWith(120) });
  const s = await startServer(ws.root, { ...gh.env, ZCODE_GITHUB_PROBE_MS: "200" });
  try {
    const p1 = sc(await s.call("deck_issue_list", { cursor: "" }));
    check("分页: 首屏 50 行", (p1.rows || []).length === 50, String((p1.rows || []).length));
    check("分页: total 是后端总数", p1.total === 120, String(p1.total));
    check("分页: nextCursor 原样给出", p1.nextCursor === "50", String(p1.nextCursor));
    check("分页: 创建时间倒序(首行是最后建的)", p1.rows[0].key === "120", String(p1.rows[0].key));

    const p2 = sc(await s.call("deck_issue_list", { cursor: p1.nextCursor }));
    check("分页: 第二页从游标接上", (p2.rows || []).length === 50 && p2.rows[0].key === "70", JSON.stringify((p2.rows || []).slice(0, 2).map((r) => r.key)));
    check("分页: 第二页 nextCursor", p2.nextCursor === "100", String(p2.nextCursor));

    // 假 gh 收到的 first 恒为 50(每页至多 50)
    const pageCalls = gh.calls().filter((c) => callText(c).includes("orderBy:{field:CREATED_AT"));
    check("分页: 每页都按 50 要", pageCalls.length >= 2 && pageCalls.every((c) => callText(c).includes("first=50")), JSON.stringify(pageCalls.map(callText).slice(0, 3)));

    // state 服务端筛 + keys 客户端筛
    const closed = sc(await s.call("deck_issue_list", { cursor: "", state: "closed" }));
    check("分页: state 交服务端筛(closed 时 rows 全 closed)", (closed.rows || []).length === 12 && closed.rows.every((r) => r.state === "closed"), JSON.stringify({ n: (closed.rows || []).length, total: closed.total }));
    check("分页: closed 的 total 也是后端口径(12)", closed.total === 12, String(closed.total));
    const keyed = sc(await s.call("deck_issue_list", { cursor: "", keys: ["120", "119", "1"] }));
    check("分页: keys 在页内再筛", JSON.stringify((keyed.rows || []).map((r) => r.key).sort()) === JSON.stringify(["119", "120"]), JSON.stringify((keyed.rows || []).map((r) => r.key)));

    // 非法游标:可读错误,不崩
    const bad = await s.call("deck_issue_list", { cursor: "bogus-cursor" });
    check("分页: 失效游标回可读错误(不崩)", isErr(bad) && /游标/.test(textOf(bad)), textOf(bad).slice(0, 300));
    check("分页: 失效游标的档位是 not-found", sc(bad).error && sc(bad).error.kind === "not-found", JSON.stringify(sc(bad).error));
  } finally {
    await s.stop();
    gh.cleanup();
    ws.cleanup();
  }
}

// ---------------------------------------------------------------------------
// d. 详情:补不补零都认;commentsFirst/commentsAfter(偏移);commentCount;commentsPage
// ---------------------------------------------------------------------------
async function sliceDetail() {
  const ws = makeWorkspace({ repo: "owner/name", anchor: ANCHOR_GITHUB });
  const gh = makeFakeGh({ state: baseState() });
  const s = await startServer(ws.root, { ...gh.env, ZCODE_GITHUB_PROBE_MS: "200" });
  try {
    const a = sc(await s.call("deck_issue_get", { key: "04" }));
    const b = sc(await s.call("deck_issue_get", { key: "4" }));
    check("详情: 04 与 4 取到同一张", a.card && b.card && a.card.key === "4" && b.card.key === "4", JSON.stringify({ a: a.card && a.card.key, b: b.card && b.card.key }));
    check("详情: 正文与标签都在", a.card && a.card.body === "正文 4" && Array.isArray(a.card.labels) && a.card.labels.length === 2, JSON.stringify(a.card && { body: a.card.body, labels: a.card.labels }));
    const c0 = a.card.comments || [];
    check("详情: 默认 50 条以内的评论全回", c0.length === 3, String(c0.length));
    check("详情: commentCount 是总数", a.card.commentCount === 3, String(a.card.commentCount));
    check("详情: commentsPage 默认游标是偏移量", a.commentsPage && a.commentsPage.endCursor === "3" && a.commentsPage.hasNextPage === false, JSON.stringify(a.commentsPage));

    const two = sc(await s.call("deck_issue_get", { key: "4", commentsFirst: 2 }));
    check("详情: commentsFirst=2 只回两条", (two.card.comments || []).length === 2, String((two.card.comments || []).length));
    check("详情: commentsFirst=2 的 commentsPage", two.commentsPage && two.commentsPage.endCursor === "2" && two.commentsPage.hasNextPage === true, JSON.stringify(two.commentsPage));
    check("详情: 假 gh 收到 comments(first:2)", gh.calls().some((c) => callText(c).includes("comments(first:2)")), JSON.stringify(gh.calls().map(callText)));

    const after = sc(await s.call("deck_issue_get", { key: "4", commentsFirst: 2, commentsAfter: "2" }));
    check("详情: commentsAfter=2 从第三条开始", (after.card.comments || []).length === 1 && after.card.comments[0].body === "第三条", JSON.stringify((after.card.comments || []).map((x) => x.body)));
    check("详情: commentsAfter 后 commentsPage 到底", after.commentsPage && after.commentsPage.endCursor === "3" && after.commentsPage.hasNextPage === false, JSON.stringify(after.commentsPage));
    check("详情: commentCount 不随分页变化", after.card.commentCount === 3, String(after.card.commentCount));

    // 大评论量:commentsFirst=150 → 房间翻页(假 gh 看到 after=100),commentsPage 指到 150
    gh.patch((st) => {
      st.repos["owner/name"].comments[4] = Array.from({ length: 200 }, (_, i) => ({
        id: `c${i + 1}`,
        author: { login: "octocat" },
        body: `评论 ${i + 1}`,
        createdAt: new Date(Date.UTC(2026, 0, 3, 0, 0, i)).toISOString(),
      }));
    });
    gh.clearCalls();
    const big = sc(await s.call("deck_issue_get", { key: "4", commentsFirst: 150 }));
    check("详情: commentsFirst=150 回满 150 条", (big.card.comments || []).length === 150, String((big.card.comments || []).length));
    check("详情: 房间翻页时假 gh 收到 after=100", gh.calls().some((c) => callText(c).includes("after=100")), JSON.stringify(gh.calls().map(callText)));
    check("详情: 150 条时 commentsPage 还有下一页", big.commentsPage && big.commentsPage.endCursor === "150" && big.commentsPage.hasNextPage === true, JSON.stringify(big.commentsPage));
    check("详情: 200 条时 commentCount 是 200", big.card.commentCount === 200, String(big.card.commentCount));

    const mid = sc(await s.call("deck_issue_get", { key: "4", commentsFirst: 50, commentsAfter: "100" }));
    check("详情: 偏移 100 取到第 101..150 条", (mid.card.comments || []).length === 50 && mid.card.comments[0].body === "评论 101", JSON.stringify((mid.card.comments || []).slice(0, 1)));
    check("详情: 偏移 100 的 commentsPage", mid.commentsPage && mid.commentsPage.endCursor === "150" && mid.commentsPage.hasNextPage === true, JSON.stringify(mid.commentsPage));

    const over = sc(await s.call("deck_issue_get", { key: "4", commentsFirst: 50, commentsAfter: "200" }));
    check("详情: 偏移到 200 上限后不再翻", (over.card.comments || []).length === 0 && over.commentsPage.hasNextPage === false, JSON.stringify(over.commentsPage));

    const badKey = await s.call("deck_issue_get", { key: "abc" });
    check("详情: 非数字 key 回可读错误", isErr(badKey) && /议题号/.test(textOf(badKey)), textOf(badKey).slice(0, 200));
  } finally {
    await s.stop();
    gh.cleanup();
    ws.cleanup();
  }
}

// ---------------------------------------------------------------------------
// e. 计数:三个数来自后端、胶囊由开放行算、探测间隔内零新增出站
//    票 05:新鲜度改由变更探测驱动(限速在 probe.mjs)。这里把探测间隔放宽到 1s,
//    让「第一拍之后立即第二拍」落在窗口内;断言意图不变:面板 5 秒一拍不能每拍问 GitHub。
// ---------------------------------------------------------------------------
async function sliceCounts() {
  const ws = makeWorkspace({ repo: "owner/name", anchor: ANCHOR_GITHUB });
  const state = baseState();
  state.repos["owner/name"].counts = { open: 7, closed: 5 }; // 与行面(3 开放/1 关闭)故意不一致
  const gh = makeFakeGh({ state });
  const s = await startServer(ws.root, { ...gh.env, ZCODE_GITHUB_PROBE_MS: "1000" });
  try {
    const first = sc(await s.call("deck_issue_counts", {}));
    check("计数: open/closed/total 信后端", first.counts.open === 7 && first.counts.closed === 5 && first.counts.total === 12, JSON.stringify(first.counts));
    check("计数: 胶囊由开放行算(claimed/blocked/bug/triage)", first.counts.claimed === 1 && first.counts.blocked === 1 && first.counts.bug === 1 && first.counts.triage === 1, JSON.stringify(first.counts));
    check("计数: frontier 由行面算(两条开放工单都占用)", first.counts.frontier === 0 && first.counts.occupied === 2, JSON.stringify(first.counts));
    check("计数: maps 计数", first.counts.maps === 1, String(first.counts.maps));
    check("计数: partial 为假", first.partial === false, String(first.partial));
    // 票 05:首次探测没有时间窗,已有议题会被算作一次「远端有更新」,所以首拍后 revision ≥ 1。
    check("计数: revision 在场且首拍后至少 1", Number.isInteger(first.revision) && first.revision >= 1, String(first.revision));
    const afterFirst = gh.calls().length;
    check("计数: 第一拍真的出站(探测 + 计数 + 开放列表)", afterFirst >= 2, String(afterFirst));

    const second = sc(await s.call("deck_issue_counts", {}));
    check("计数: 探测间隔内第二次零新增 gh 调用", gh.calls().length === afterFirst, `${gh.calls().length} vs ${afterFirst}`);
    check("计数: 探测间隔内第二次拿到同样的数", second.counts.open === 7 && second.counts.total === 12, JSON.stringify(second.counts));

    await new Promise((r) => setTimeout(r, 1150));
    const dueN = gh.calls().length;
    await s.call("deck_issue_counts", {});
    const dueCalls = gh.calls().slice(dueN);
    const windowed = dueCalls.filter((c) => callText(c).includes("orderBy:{field:CREATED_AT") && c.argv.some((a) => String(a).startsWith("since=")));
    check("计数: 过了探测间隔再探一次(带时间窗)", windowed.length === 1, JSON.stringify(dueCalls.map(callText)));
  } finally {
    await s.stop();
    gh.cleanup();
    ws.cleanup();
  }
  // 开放列表撞 500 上限 → 计数仍是后端三个数,但整体标 partial
  {
    const ws = makeWorkspace({ repo: "owner/name", anchor: ANCHOR_GITHUB });
    const gh = makeFakeGh({ state: stateWith(501) });
    const s = await startServer(ws.root, { ...gh.env, ZCODE_GITHUB_PROBE_MS: "200" }, 60000);
    try {
      const res = sc(await s.call("deck_issue_counts", {}));
      check("计数: 开放列表截断时 partial 为真", res.partial === true, String(res.partial));
      check("计数: 截断时三个数仍信后端(451 开放 / 50 关闭)", res.counts.open === 451 && res.counts.closed === 50 && res.counts.total === 501, JSON.stringify(res.counts));
    } finally {
      await s.stop();
      gh.cleanup();
      ws.cleanup();
    }
  }
}

// ---------------------------------------------------------------------------
// f. 标签色表:仓库真色覆盖内置同名色;同会话第二次不出站
// ---------------------------------------------------------------------------
async function sliceLabels() {
  const ws = makeWorkspace({ repo: "owner/name", anchor: ANCHOR_GITHUB });
  const gh = makeFakeGh({ state: baseState() });
  const s = await startServer(ws.root, { ...gh.env, ZCODE_GITHUB_PROBE_MS: "200" });
  try {
    const first = sc(await s.call("deck_issue_list_labels", {}));
    check("标签: 规范名单不变", JSON.stringify(first.labels) === JSON.stringify(["needs-triage", "needs-info", "ready-for-agent", "ready-for-human", "wontfix"]), JSON.stringify(first.labels));
    check("标签: 仓库真色覆盖内置大 bug 色", first.colors.bug === "ff0000", String(first.colors.bug));
    check("标签: 内置色保留", first.colors["ready-for-agent"] === "0e8a16" && first.colors["wayfinder:map"] === "8b5cf6", JSON.stringify(first.colors));
    check("标签: 仓库独有标签也进色表", first.colors["area/ui"] === "112233", String(first.colors["area/ui"]));
    const n = gh.calls().length;
    check("标签: 第一拍出站列标签", n >= 1, String(n));
    const again = sc(await s.call("deck_issue_list_labels", {}));
    check("标签: 同会话第二次零新增 gh 调用", gh.calls().length === n, `${gh.calls().length} vs ${n}`);
    check("标签: 第二次仍是同一份", again.colors.bug === "ff0000", String(again.colors.bug));
  } finally {
    await s.stop();
    gh.cleanup();
    ws.cleanup();
  }
}

// ---------------------------------------------------------------------------
// g. 地图子票:回包形状不变;capped/missing 照房间结果带出
// ---------------------------------------------------------------------------
async function sliceMap() {
  const ws = makeWorkspace({ repo: "owner/name", anchor: ANCHOR_GITHUB });
  const state = baseState();
  state.repos["owner/name"].subIssuesTotal = { 1: 4 }; // 连接声称 4 张,实际只回 2 张 → missing=2
  const gh = makeFakeGh({ state });
  const s = await startServer(ws.root, { ...gh.env, ZCODE_GITHUB_PROBE_MS: "200" });
  try {
    const res = await s.call("deck_map_tickets", { key: "01" });
    const body = sc(res);
    check("地图: 回包不是错误", !isErr(res), textOf(res).slice(0, 300));
    check("地图: 形状 ok/key/items/stats/total/fetched/capped/missing",
      body.ok === true && body.key === "1" && Array.isArray(body.items) && body.stats && body.total === 4 && body.fetched === 2 && body.capped === false && body.missing === 2,
      JSON.stringify({ ok: body.ok, key: body.key, total: body.total, fetched: body.fetched, capped: body.capped, missing: body.missing }));
    const item = (body.items || []).find((i) => i.key === "4") || {};
    check("地图: 行形状同本地(state 大写/blockedByRefs/claimedBy/number)",
      item.state === "OPEN" && item.number === 4 && item.claimedBy === "octocat" && Array.isArray(item.blockedByRefs),
      JSON.stringify({ state: item.state, number: item.number, claimedBy: item.claimedBy }));
    const blocked = (body.items || []).find((i) => i.key === "5") || {};
    check("地图: 阻塞引用带 key", JSON.stringify(blocked.blockedBy) === JSON.stringify(["4"]) && blocked.blockedByRefs[0] && blocked.blockedByRefs[0].key === "4", JSON.stringify({ blockedBy: blocked.blockedBy, refs: blocked.blockedByRefs }));
    check("地图: stats 由回包行算", body.stats.total === 2 && body.stats.open === 2 && body.stats.closed === 0, JSON.stringify(body.stats));

    const bad = await s.call("deck_map_tickets", { key: "nope" });
    check("地图: 非数字 key 回可读错误", isErr(bad) && /议题号/.test(textOf(bad)), textOf(bad).slice(0, 200));
  } finally {
    await s.stop();
    gh.cleanup();
    ws.cleanup();
  }
}

// ---------------------------------------------------------------------------
// h. 错误五档:环境、登录、限流、不存在、网络
// ---------------------------------------------------------------------------
async function sliceErrors() {
  // 没装 gh:ZCODE_GH_PATH 指不存在的路径 + PATH 清空
  {
    const ws = makeWorkspace({ repo: "owner/name", anchor: ANCHOR_GITHUB });
    const s = await startServer(ws.root, { ZCODE_GH_PATH: join(ws.root, "no-such-gh.exe"), PATH: "", Path: "" });
    try {
      const res = await s.call("deck_issue_list", {});
      check("错误 env: isError", isErr(res), textOf(res).slice(0, 200));
      check("错误 env: kind=env", (sc(res).error || {}).kind === "env", JSON.stringify(sc(res).error));
      check("错误 env: 人话提到装 gh 与 ZCODE_GH_PATH", /gh/.test(textOf(res)) && /ZCODE_GH_PATH/.test(textOf(res)), textOf(res).slice(0, 300));
    } finally {
      await s.stop();
      ws.cleanup();
    }
  }
  const cases = [
    ["auth", { auth: "missing" }, /gh auth login/],
    ["rate-limit", { fail: "ratelimit" }, /限流|过于频繁/],
    ["network", { fail: "network" }, /连不上|网络|网/],
    ["not-found", { fail: "notfound" }, /找不到|不存在|not.?found/i],
  ];
  for (const [expectKind, patchState, textRe] of cases) {
    const ws = makeWorkspace({ repo: "owner/name", anchor: ANCHOR_GITHUB });
    const state = baseState();
    Object.assign(state, patchState);
    const gh = makeFakeGh({ state });
    const s = await startServer(ws.root, { ...gh.env, ZCODE_GITHUB_PROBE_MS: "200" });
    try {
      const res = await s.call("deck_issue_list", {});
      const err = sc(res).error || {};
      check(`错误 ${expectKind}: isError`, isErr(res), textOf(res).slice(0, 200));
      check(`错误 ${expectKind}: kind 对`, err.kind === expectKind, JSON.stringify(err));
      check(`错误 ${expectKind}: 人话可读`, textRe.test(textOf(res)), textOf(res).slice(0, 300));
      check(`错误 ${expectKind}: 原文带出`, typeof err.raw === "string" && err.raw.length > 0, JSON.stringify(err.raw));
    } finally {
      await s.stop();
      gh.cleanup();
      ws.cleanup();
    }
  }
  // 不存在但没开故障开关:议题号 999 走 GraphQL 空 → REST 404 → not-found
  {
    const ws = makeWorkspace({ repo: "owner/name", anchor: ANCHOR_GITHUB });
    const gh = makeFakeGh({ state: baseState() });
    const s = await startServer(ws.root, { ...gh.env, ZCODE_GITHUB_PROBE_MS: "200" });
    try {
      const res = await s.call("deck_issue_get", { key: "999" });
      check("错误 不存在的票: kind=not-found", isErr(res) && (sc(res).error || {}).kind === "not-found", JSON.stringify(sc(res).error));
    } finally {
      await s.stop();
      gh.cleanup();
      ws.cleanup();
    }
  }
}

// ---------------------------------------------------------------------------
// i. 票 04 起七个写工具在 GitHub 下已生效;这一片只守读套件不被写工具改坏
//    (不再回「尚未接」、不落 .scratch、写命令真发给假 gh)
// ---------------------------------------------------------------------------
async function sliceWritesWired() {
  const ws = makeWorkspace({ repo: "owner/name", anchor: ANCHOR_GITHUB });
  const gh = makeFakeGh({ state: baseState() });
  const s = await startServer(ws.root, { ...gh.env, ZCODE_GITHUB_PROBE_MS: "200" });
  try {
    // 票 04:七个写工具已按 GitHub 后端生效(这里只验读套件不被写工具改坏:它们不再回「尚未接」,
    // 也不往 .scratch 里落任何东西;回包的人话与写命令细节由 server-github-write 套件钉)。
    const tools = [
      ["deck_issue_comment", { key: "4", body: "x" }],
      ["deck_issue_close", { key: "4" }],
      ["deck_issue_reopen", { key: "4" }],
      ["deck_issue_create", { title: "新票" }],
      ["deck_issue_update", { key: "4", status: "claimed" }],
      ["deck_issue_set_labels", { key: "4", labels: ["bug"] }],
      ["deck_map_link", { key: "4", parentKey: "1" }],
    ];
    for (const [name, args] of tools) {
      const res = await s.call(name, args);
      check(`写工具 ${name}: 已按 GitHub 后端生效`, !isErr(res) && /owner\/name/.test(textOf(res)), textOf(res).slice(0, 200));
      check(`写工具 ${name}: 回包带 key`, typeof sc(res).key === "string" && sc(res).key !== "", JSON.stringify({ key: sc(res).key, error: sc(res).error }));
    }
    check("写工具: 没有创建 .scratch", !existsSync(join(ws.root, ".scratch")), readdirSync(ws.root).join(","));
    check(
      "写工具: 假 gh 收到了写命令",
      gh.calls().some((c) => /^issue (create|close|reopen|comment|edit)\b|--method (POST|DELETE)|addBlockedBy|removeBlockedBy/.test(callText(c))),
      JSON.stringify(gh.calls().map(callText))
    );

    const env = await s.call("deck_env_check", {});
    check("环境检查: 票 06 之前回尚未接", isErr(env) && /尚未接|票 06/.test(textOf(env)), textOf(env).slice(0, 200));
  } finally {
    await s.stop();
    gh.cleanup();
    ws.cleanup();
  }
}

// ---------------------------------------------------------------------------
// j. markdown 回归:同一个 fixture 手选 markdown 时,回包键集与纯 markdown 一致
// ---------------------------------------------------------------------------
async function sliceMarkdownRegression() {
  const cards = [
    { effort: "demo", n: "01", slug: "one", title: "第一张" },
    { effort: "demo", n: "02", slug: "two", title: "第二张" },
  ];
  const ghWorkspace = makeWorkspace({ repo: "owner/name", anchor: ANCHOR_GITHUB, cards });
  const plainWorkspace = makeWorkspace({ repo: "owner/name", anchor: null, cards });
  const gh = makeFakeGh({ state: baseState() });
  const ghServer = await startServer(ghWorkspace.root, { ...gh.env, ZCODE_GITHUB_PROBE_MS: "200" });
  const plainServer = await startServer(plainWorkspace.root, { ZCODE_GH_PATH: join(plainWorkspace.root, "nope.exe"), PATH: "", Path: "" });
  try {
    const use = sc(await ghServer.call("deck_backend_use", { backend: "markdown" }));
    check("回归: 手选 markdown 后活动项目 backend 是 markdown", use.active && use.active.backend && use.active.backend.id === "markdown", JSON.stringify(use.active && use.active.backend));
    const ghList = sc(await ghServer.call("deck_issue_list", {}));
    const plainList = sc(await plainServer.call("deck_issue_list", {}));
    check("回归: list 键集与纯 markdown 一致", JSON.stringify(Object.keys(ghList).sort()) === JSON.stringify(Object.keys(plainList).sort()), JSON.stringify({ gh: Object.keys(ghList), plain: Object.keys(plainList) }));
    check("回归: 行数一致", (ghList.rows || []).length === (plainList.rows || []).length && ghList.rows.length === 2, JSON.stringify({ gh: (ghList.rows || []).length, plain: (plainList.rows || []).length }));
    check("回归: revision 在场", typeof ghList.revision === "number" && typeof plainList.revision === "number", JSON.stringify({ gh: ghList.revision, plain: plainList.revision }));
    // 两个工作区的文件 mtime 不同(本地薄行的 createdAt/updatedAt 来自 mtime),比较时剥掉这三格。
    const strip = (rows) => (rows || []).map(({ createdAt, updatedAt, closedAt, url, ...rest }) => rest);
    check("回归: 薄行一致(剥掉 mtime 派生的时间与本地文件路径 url)", JSON.stringify(strip(ghList.rows)) === JSON.stringify(strip(plainList.rows)), JSON.stringify({ gh: strip(ghList.rows)[0], plain: strip(plainList.rows)[0] }));
    const ghGet = sc(await ghServer.call("deck_issue_get", { key: "01" }));
    const plainGet = sc(await plainServer.call("deck_issue_get", { key: "01" }));
    check("回归: get 键集一致", JSON.stringify(Object.keys(ghGet).sort()) === JSON.stringify(Object.keys(plainGet).sort()), JSON.stringify({ gh: Object.keys(ghGet), plain: Object.keys(plainGet) }));
    check("回归: get 卡片编号一致", ghGet.card && plainGet.card && ghGet.card.key === plainGet.card.key, JSON.stringify({ gh: ghGet.card && ghGet.card.key, plain: plainGet.card && plainGet.card.key }));
    const ghCounts = sc(await ghServer.call("deck_issue_counts", {}));
    const plainCounts = sc(await plainServer.call("deck_issue_counts", {}));
    check("回归: counts 键集一致", JSON.stringify(Object.keys(ghCounts).sort()) === JSON.stringify(Object.keys(plainCounts).sort()), JSON.stringify({ gh: Object.keys(ghCounts), plain: Object.keys(plainCounts) }));
    check("回归: GitHub 工作区下没有出站", gh.calls().length === 0, JSON.stringify(gh.calls().map(callText)));
  } finally {
    await ghServer.stop();
    await plainServer.stop();
    gh.cleanup();
    ghWorkspace.cleanup();
    plainWorkspace.cleanup();
  }
}

// ---------------------------------------------------------------------------
// 仓库身份第三层:项目根没有 .git 时用 gh repo view
// ---------------------------------------------------------------------------
async function sliceRepoViewTier3() {
  const ws = makeWorkspace({ repo: "owner/name", anchor: ANCHOR_GITHUB });
  // 去掉 .git:本地两层解析不出,房间应当走 gh repo view
  const { rmSync } = await import("node:fs");
  rmSync(join(ws.root, ".git"), { recursive: true, force: true });
  const gh = makeFakeGh({ state: baseState() });
  const s = await startServer(ws.root, { ...gh.env, ZCODE_GITHUB_PROBE_MS: "200" });
  try {
    const res = await s.call("deck_issue_list", {});
    check("仓库第三层: 没有 .git 也能读", !isErr(res) && (sc(res).rows || []).length === 4, textOf(res).slice(0, 300));
    check("仓库第三层: 发过 gh repo view", gh.calls().some((c) => callText(c).includes("repo view")), JSON.stringify(gh.calls().map(callText)));
  } finally {
    await s.stop();
    gh.cleanup();
    ws.cleanup();
  }
}

await sliceListWhole();
await sliceListTruncatedAndFallback();
await sliceListPaged();
await sliceDetail();
await sliceCounts();
await sliceLabels();
await sliceMap();
await sliceErrors();
await sliceWritesWired();
await sliceMarkdownRegression();
await sliceRepoViewTier3();

console.log(failures === 0 ? `\n全部通过(${checks} 项断言)` : `\n${failures} 项失败(${checks} 项断言)`);
process.exit(failures === 0 ? 0 : 1);
