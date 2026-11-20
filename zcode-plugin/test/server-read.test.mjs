// 工单 02 缝 1 测试:Node 直跑 dist/server.mjs 的 tools/call,对 fixtures 工作区断言
// list / get / counts 的返回、坏卡容忍与空态语义。沿用 scaffold.test.mjs 的 spawn 会话模式,无框架。
// 工作区根经 ZCODE_WORKSPACE_ROOT 环境变量注入(模拟宿主 manifest 的 ${ZCODE_PROJECT_DIR})。
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // zcode-plugin/
const FIXTURES = join(ROOT, "test", "fixtures");

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`ok - ${name}`);
  else {
    failures++;
    console.error(`FAIL - ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

/** 起一个指向指定工作区根的 server 会话,交回 rpc/stop。extraEnv 覆盖 HOME 等环境(环境检查用)。 */
async function startServer(workspaceRoot, extraEnv = {}) {
  const child = spawn(process.execPath, [join(ROOT, "dist", "server.mjs")], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, ...extraEnv, ZCODE_WORKSPACE_ROOT: workspaceRoot },
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
      setTimeout(() => reject(new Error(`timeout waiting ${method}`)), 5000);
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

// ---------------------------------------------------------------------------
// 切片 1:list 对 mixed fixture 返回卡行(容器行 + 票行、身份/标题/状态/标签)
// ---------------------------------------------------------------------------
async function sliceList() {
  if (!existsSync(join(ROOT, "dist", "server.mjs"))) {
    check("list: dist/server.mjs 可跑", false);
    return;
  }
  const s = await startServer(join(FIXTURES, "mixed"));
  try {
    const tools = await s.rpc("tools/list", {});
    const names = (tools.result?.tools || []).map((t) => t.name);
    check("list: tools/list 声明读工具面(list/get/counts/list_labels)",
      ["deck_issue_list", "deck_issue_get", "deck_issue_counts", "deck_issue_list_labels"].every((n) => names.includes(n)), JSON.stringify(names));

    const r = await s.call("deck_issue_list", {});
    check("list: 应答无错误", !r.error && !r.result?.isError, JSON.stringify(r.error || r.result?.isError));
    const sc = r.result?.structuredContent || {};
    const rows = sc.rows || [];
    check("list: 返回 8 行(2 容器 + 6 票)", rows.length === 8, `got ${rows.length}`);

    const spec = rows.find((x) => x.type === "spec");
    check("list: 规格容器行 key=00/标题取 DSH-TITLE",
      spec && spec.key === "00" && spec.effortId === "m1-core-board" && spec.title === "M1 核心看板",
      JSON.stringify(spec));
    const map = rows.find((x) => x.type === "map");
    check("list: 地图容器行 key=00/标题取 DSH-TITLE",
      map && map.key === "00" && map.effortId === "explore-login" && map.title === "登录方式探索",
      JSON.stringify(map));

    const a01 = rows.find((x) => x.effortId === "m1-core-board" && x.key === "01");
    check("list: 实施票行 H1 剥编号前缀作标题",
      a01 && a01.title === "插件骨架 tracer", JSON.stringify(a01));
    check("list: 实施票状态 open", a01?.state === "open", a01?.state);
    check("list: 实施票标签读可见行(契约对象形状)",
      Array.isArray(a01?.labels) && a01.labels.length === 1 && a01.labels[0]?.name === "bug",
      JSON.stringify(a01?.labels));
    check("list: 薄行不带正文", a01 && !("body" in a01), JSON.stringify(Object.keys(a01 || {})));
    check("list: 薄行带评论数", a01?.commentCount === 1, String(a01?.commentCount));
    check("list: 父容器关系(容器单元子票 parentKey=00)", a01?.parentKey === "00", String(a01?.parentKey));

    const a02 = rows.find((x) => x.effortId === "m1-core-board" && x.key === "02");
    check("list: 阻塞边读可见行并补两位", a02 && Array.isArray(a02.blockedBy) && a02.blockedBy[0]?.key === "01", JSON.stringify(a02?.blockedBy));
    const a03 = rows.find((x) => x.effortId === "m1-core-board" && x.key === "03");
    check("list: resolved 计为 closed", a03?.state === "closed", a03?.state);

    const b01 = rows.find((x) => x.effortId === "explore-login" && x.key === "01");
    check("list: 地图子票裸 Type 行进自定义字段",
      b01 && Array.isArray(b01.customFields) && b01.customFields[0]?.name === "Type" && b01.customFields[0]?.value === "research",
      JSON.stringify(b01?.customFields));
    check("list: 认领人剥掉加粗装饰(login 不带 **)",
      Array.isArray(b01?.assignees) && b01.assignees[0]?.login === "dev",
      JSON.stringify(b01?.assignees));

    check("list: 摘要是中文人话", typeof r.result?.content?.[0]?.text === "string" && r.result.content[0].text.includes("8"), r.result?.content?.[0]?.text);
  } finally {
    await s.stop();
  }
}

// ---------------------------------------------------------------------------
// 切片 2:get 单卡全文 + 评论时间线;同号多卡取目录序第一张;找不到是 isError 不是协议错
// ---------------------------------------------------------------------------
async function sliceGet() {
  const s = await startServer(join(FIXTURES, "mixed"));
  try {
    const r = await s.call("deck_issue_get", { key: "01" });
    check("get: 应答无错误", !r.error && !r.result?.isError, JSON.stringify(r.error));
    const card = r.result?.structuredContent?.card;
    check("get: 同号多卡取目录序第一张(explore-login 字母序在前)",
      card && card.effortId === "explore-login" && card.key === "01", JSON.stringify(card && { e: card.effortId, k: card.key }));
    check("get: 带全文正文", typeof card?.body === "string" && card.body.includes("## Question"), card?.body?.slice(0, 60));
    check("get: H1 在正文里", card?.body?.includes("# 01: OAuth 可行吗") === true);
    check("get: 评论时间线(上游 ### 谁 — ISO 块)",
      Array.isArray(card?.comments) && card.comments.length === 1 &&
        card.comments[0]?.author?.login === "dev" &&
        card.comments[0]?.createdAt === "2026-11-16T08:30:00.000Z" &&
        card.comments[0]?.body.includes("开始调研"),
      JSON.stringify(card?.comments));

    const byPrefix = await s.call("deck_issue_get", { key: "m1-core-board/01" });
    const m1 = byPrefix.result?.structuredContent?.card;
    check("get: 前缀寻址到指定工作单元",
      m1?.effortId === "m1-core-board" && m1?.title === "插件骨架 tracer",
      JSON.stringify(m1 && m1.title));
    check("get: 创建时刻读 DSH-CREATED", m1?.createdAt === "2026-11-15T09:00:00.000Z", m1?.createdAt);
    check("get: 实施票评论块", m1?.comments?.[0]?.author?.login === "agent" && m1?.comments?.[0]?.createdAt === "2026-11-15T10:00:00.000Z",
      JSON.stringify(m1?.comments));

    const pad = await s.call("deck_issue_get", { key: "3" });
    check("get: 单位数字补零两位(m1 字母序在后不抢 03)", pad.result?.structuredContent?.card?.key === "03", pad.result?.structuredContent?.card?.key);

    const missing = await s.call("deck_issue_get", { key: "99" });
    check("get: 找不到的卡是工具级 isError + 中文消息",
      !missing.error && missing.result?.isError === true && /找不到卡 99/.test(missing.result?.content?.[0]?.text || ""),
      JSON.stringify(missing.result || missing.error));
  } finally {
    await s.stop();
  }
}

// ---------------------------------------------------------------------------
// 切片 3:counts 口径数值表(期望值来自 fixtures 手工盘点,独立于实现):
//   mixed:票 6 = m1{01 open/bug/frontier, 02 open/needs-triage/被01阻塞, 03 closed/bug}
//               + explore{01 open/claimed/无标签(无标签也算诊断), 02 closed, 03 open/无标签/被01阻塞}
//   → open 4 · closed 2 · total 6 · frontier 1 · occupied 3 · claimed 1 · blocked 2 · bug 1 · triage 3 · maps 1 · specs 1
// ---------------------------------------------------------------------------
async function sliceCounts() {
  const s = await startServer(join(FIXTURES, "mixed"));
  try {
    const r = await s.call("deck_issue_counts", {});
    check("counts: 应答无错误", !r.error && !r.result?.isError, JSON.stringify(r.error));
    const sc = r.result?.structuredContent || {};
    check("counts: empty=false", sc.empty === false, String(sc.empty));
    const c = sc.counts || {};
    const expected = {
      open: 4, closed: 2, total: 6, frontier: 1, occupied: 3, claimed: 1, blocked: 2, bug: 1, triage: 3, maps: 1, specs: 1,
    };
    for (const [k, v] of Object.entries(expected)) {
      check(`counts: ${k}=${v}`, c[k] === v, `got ${JSON.stringify(c[k])}`);
    }
    check("counts: 摘要含胶囊口径", /可接 1 · 占用 3 · 阻塞 2 · 故障 1 · 诊断 3/.test(r.result?.content?.[0]?.text || ""),
      r.result?.content?.[0]?.text);
  } finally {
    await s.stop();
  }
}

// ---------------------------------------------------------------------------
// 切片 4:坏卡容忍(broken fixture:缺字段/无标题/多余空行/撞号/无编号/断链阻塞)
//   全部降级展示不抛错:notes.md 不算票;撞号双方退化成 目录/文件名;缺 Status 按 open;
//   断链阻塞(NOT-FOUND)按安全 blocked 计。
//   票 6 张全 open → open 6 · closed 0 · blocked 1(04) · frontier 5 · bug 1(03-extra-blanks)
//   · triage 5(除 03-extra-blanks 带 bug 外全部无标签)
// ---------------------------------------------------------------------------
async function sliceBroken() {
  const s = await startServer(join(FIXTURES, "broken"));
  try {
    const r = await s.call("deck_issue_list", {});
    check("broken: list 不抛错", !r.error && !r.result?.isError, JSON.stringify(r.error));
    const rows = r.result?.structuredContent?.rows || [];
    check("broken: 6 张票(notes.md 不算,容器行无)", rows.length === 6, `got ${rows.length}`);
    check("broken: notes.md 不在行里", !rows.some((x) => (x.url || "").includes("notes.md")), rows.map((x) => x.key).join(","));

    const keys = rows.map((x) => x.key).sort();
    check("broken: 撞号双方退化成 目录/文件名",
      keys.includes("demo/03-extra-blanks") && keys.includes("demo/03-dup-number"), keys.join(","));
    check("broken: 无编号手写卡退化身份", keys.includes("demo/手写卡"), keys.join(","));
    check("broken: 正常编号保持两位", keys.includes("01") && keys.includes("02") && keys.includes("04"), keys.join(","));

    const noFields = rows.find((x) => x.key === "01");
    check("broken: 缺字段卡按 open 降级", noFields?.state === "open", noFields?.state);
    const noTitle = rows.find((x) => x.key === "02");
    check("broken: 无标题卡降级用文件名", noTitle?.title === "02-无标题", noTitle?.title);

    const c = (await s.call("deck_issue_counts", {})).result?.structuredContent?.counts || {};
    const expected = { open: 6, closed: 0, total: 6, frontier: 5, occupied: 1, claimed: 0, blocked: 1, bug: 1, triage: 5 };
    for (const [k, v] of Object.entries(expected)) {
      check(`broken: counts ${k}=${v}`, c[k] === v, `got ${JSON.stringify(c[k])}`);
    }

    const dup = await s.call("deck_issue_get", { key: "demo/03-dup-number" });
    check("broken: 退化身份可寻址", dup.result?.structuredContent?.card?.title === "撞号卡",
      dup.result?.structuredContent?.card?.title);
    const bad = await s.call("deck_issue_get", { key: "04" });
    const badCard = bad.result?.structuredContent?.card;
    check("broken: 断链阻塞边保留 key 不预写状态", badCard && badCard.blockedBy?.[0]?.key === "99" && badCard.blockedBy[0].state === undefined,
      JSON.stringify(badCard?.blockedBy));
    const blanks = await s.call("deck_issue_get", { key: "demo/03-extra-blanks" });
    check("broken: 多空行卡 Status 空值按 open、labels 正常读",
      blanks.result?.structuredContent?.card?.state === "open" &&
        blanks.result?.structuredContent?.card?.labels?.[0]?.name === "bug",
      JSON.stringify(blanks.result?.structuredContent?.card && { s: blanks.result.structuredContent.card.state, l: blanks.result.structuredContent.card.labels }));
  } finally {
    await s.stop();
  }
}

await sliceList();
await sliceGet();
await sliceCounts();
await sliceBroken();

// ---------------------------------------------------------------------------
// 切片 5:空态语义(空 .scratch 与 无 .scratch):明确空态结果而非错误
// ---------------------------------------------------------------------------
async function sliceEmpty() {
  for (const [name, fixture] of [["空 .scratch", "empty-scratch"], ["无 .scratch", "no-scratch"]]) {
    const s = await startServer(join(FIXTURES, fixture));
    try {
      const r = await s.call("deck_issue_list", {});
      check(`empty(${name}): list 是空态不是错误`,
        !r.error && !r.result?.isError && r.result?.structuredContent?.empty === true && Array.isArray(r.result?.structuredContent?.rows) && r.result.structuredContent.rows.length === 0,
        JSON.stringify(r.result?.structuredContent || r.error));
      check(`empty(${name}): 摘要指向引导技能`,
        /没有 \.scratch/.test(r.result?.content?.[0]?.text || ""), r.result?.content?.[0]?.text);
      const c = await s.call("deck_issue_counts", {});
      const sc = c.result?.structuredContent || {};
      check(`empty(${name}): counts 空态标志`,
        !c.result?.isError && sc.empty === true && sc.counts?.total === 0, JSON.stringify(sc));
    } finally {
      await s.stop();
    }
  }
}

// ---------------------------------------------------------------------------
// 切片 6:list 过滤(state / labels AND / type):数字与行同源
// ---------------------------------------------------------------------------
async function sliceFilter() {
  const s = await startServer(join(FIXTURES, "mixed"));
  try {
    const open = await s.call("deck_issue_list", { state: "open" });
    const openRows = open.result?.structuredContent?.rows || [];
    check("filter: state=open 只回 open 行(容器行也是 open)", openRows.length === 6 && openRows.every((x) => x.state === "open"),
      `got ${openRows.length}`);

    const closed = await s.call("deck_issue_list", { state: "closed" });
    const closedRows = closed.result?.structuredContent?.rows || [];
    check("filter: state=closed 只回 closed 票", closedRows.length === 2 && closedRows.every((x) => x.state === "closed"),
      `got ${closedRows.map((x) => x.key).join(",")}`);

    const bug = await s.call("deck_issue_list", { state: "open", labels: ["bug"] });
    check("filter: labels=bug AND 精确名 → 只 m1/01",
      (bug.result?.structuredContent?.rows || []).length === 1 && bug.result.structuredContent.rows[0]?.effortId === "m1-core-board",
      JSON.stringify(bug.result?.structuredContent?.rows?.map((x) => x.key)));

    const both = await s.call("deck_issue_list", { labels: ["bug", "needs-triage"] });
    check("filter: 多标签 AND 无一命中", (both.result?.structuredContent?.rows || []).length === 0,
      JSON.stringify(both.result?.structuredContent?.rows?.length));

    const maps = await s.call("deck_issue_list", { type: "map" });
    check("filter: type=map 只回地图容器行", (maps.result?.structuredContent?.rows || []).length === 1 && maps.result.structuredContent.rows[0]?.type === "map",
      JSON.stringify(maps.result?.structuredContent?.rows?.map((x) => x.key)));

    const keys = await s.call("deck_issue_list", { keys: ["01", "03"] });
    check("filter: keys 批量取(含两个单元的同号)",
      (keys.result?.structuredContent?.rows || []).length === 4,
      JSON.stringify(keys.result?.structuredContent?.rows?.map((x) => `${x.effortId}/${x.key}`)));

    const unknown = await s.call("deck_issue_nope", {});
    check("filter: 未知工具是工具级错误", unknown.result?.isError === true, JSON.stringify(unknown.result || unknown.error));
  } finally {
    await s.stop();
  }
}

await sliceEmpty();
await sliceFilter();

// ---------------------------------------------------------------------------
// 切片 7:list_labels 规范标签 + 内置标签色表(纯常量查询,不读工作区)。
//   期望值独立于实现:标签串 = docs/agents/triage-labels.md 五规范标签(与上游
//   canonical-labels.ts 一字不差);色表 11 项 = 上游 defaultLabelPalette 直值,
//   与 server.mjs LABEL_COLORS(U06 起唯一色表副本,上游 defaultLabelPalette)同源。
// ---------------------------------------------------------------------------
async function sliceLabels() {
  const s = await startServer(join(FIXTURES, "no-scratch"));
  try {
    const tools = await s.rpc("tools/list", {});
    const names = (tools.result?.tools || []).map((t) => t.name);
    check("labels: tools/list 声明 deck_issue_list_labels", names.includes("deck_issue_list_labels"), JSON.stringify(names));

    const r = await s.call("deck_issue_list_labels", {});
    check("labels: 应答无错误", !r.error && !r.result?.isError, JSON.stringify(r.error || r.result?.isError));
    const sc = r.result?.structuredContent || {};
    check("labels: 规范标签五枚(triage-labels.md 顺序)",
      JSON.stringify(sc.labels) === JSON.stringify(["needs-triage", "needs-info", "ready-for-agent", "ready-for-human", "wontfix"]),
      JSON.stringify(sc.labels));
    const want = {
      "bug": "d73a4a", "needs-triage": "fbca04", "needs-info": "5319e7",
      "ready-for-agent": "0e8a16", "ready-for-human": "b60205", "wontfix": "ffffff",
      "wayfinder:map": "8b5cf6", "wayfinder:research": "0ea5e9", "wayfinder:prototype": "f59e0b",
      "wayfinder:grilling": "9d7cd8", "wayfinder:task": "10b981",
    };
    const got = sc.colors || {};
    check("labels: 内置色表 11 项与面板色表同源(hex 无 # 前缀)",
      Object.keys(got).length === 11 && Object.keys(want).every((k) => got[k] === want[k]) && Object.keys(got).every((k) => k in want),
      JSON.stringify(got));
    check("labels: 摘要是中文人话", /规范标签/.test(r.result?.content?.[0]?.text || ""), r.result?.content?.[0]?.text);
    check("labels: 纯常量——空工作区照常返回(无 .scratch 不是空态/错误)",
      Array.isArray(sc.labels) && sc.labels.length === 5 && Object.keys(got).length === 11);
  } finally {
    await s.stop();
  }
}
await sliceLabels();

// ---------------------------------------------------------------------------
// 切片 8:deck_env_check 环境检查链(工单 03)。事实只认本地真实状态:
//   空临时工作区(无 .scratch/无 .git/假 HOME 无技能根)→ 初始化/卡片/监听/技能/git 各态;
//   造出 .scratch 与 .git 后同一工具的状态翻转;回包形状对齐上游链快照口径。
// ---------------------------------------------------------------------------
async function sliceEnvCheck() {
  const base = mkdtempSync(join(tmpdir(), "deck-env-check-"));
  const rootEmpty = join(base, "empty");
  const rootInit = join(base, "init");
  const fakeHome = join(base, "home");
  for (const p of [rootEmpty, rootInit, fakeHome]) mkdirSync(p, { recursive: true });
  // 假 HOME 收窄技能根:工作区/用户级技能根都不存在,技能一步的判据可复现。
  const fakeHomeEnv = { HOME: fakeHome, USERPROFILE: fakeHome, HOMEDRIVE: "", HOMEPATH: "" };

  const stepOf = (sc, id) => (sc.snapshot?.steps || []).find((s) => s.id === id);
  const STATUS = new Set(["done", "current", "fail", "pending"]);

  const s = await startServer(rootEmpty, fakeHomeEnv);
  try {
    const tools = await s.rpc("tools/list", {});
    const tool = (tools.result?.tools || []).find((t) => t.name === "deck_env_check");
    check("env: tools/list 声明 deck_env_check", !!tool, JSON.stringify((tools.result?.tools || []).map((t) => t.name)));
    check("env: inputSchema 只有 force 布尔(缺省不传 = 只读检查)",
      !!tool && tool.inputSchema?.type === "object" && tool.inputSchema?.properties?.force?.type === "boolean" &&
        !(tool.inputSchema.required || []).includes("force"),
      JSON.stringify(tool && tool.inputSchema));

    const r = await s.call("deck_env_check", {});
    check("env: 应答无错误", !r.error && !r.result?.isError, JSON.stringify(r.error || r.result?.isError));
    const sc = r.result?.structuredContent || {};
    const snap = sc.snapshot || {};
    const steps = snap.steps || [];
    check("env: 回包 {ok:true, snapshot, checkedAt}", sc.ok === true && !!snap && typeof sc.checkedAt === "string" && sc.checkedAt.length >= 10,
      JSON.stringify({ ok: sc.ok, checkedAt: sc.checkedAt }));
    check("env: 六步链(初始化/卡片/监听/桥/技能/git)", steps.length === 6, JSON.stringify(steps.map((x) => x.id)));
    check("env: 每步形状齐(id/status/show/actions/blockedBy)",
      steps.every((x) => typeof x.id === "string" && STATUS.has(x.status) && x.show && typeof x.show.fallback === "string" && typeof x.show.desc === "string" &&
        Array.isArray(x.actions) && x.blockedBy === null),
      JSON.stringify(steps));

    // 空工作区:没有 .scratch → 初始化一步不过且带 inject-prompt 修复动作;监听离线;桥恒在。
    const init = stepOf(sc, "tracker:initialized");
    check("env: 无 .scratch → 初始化一步非 done 且带修复动作",
      init && init.status !== "done" && init.actions.length === 1 && init.actions[0].type === "inject-prompt" &&
        typeof init.actions[0].prompt === "string" && init.actions[0].prompt.length > 0,
      JSON.stringify(init));
    check("env: 无 .scratch → 监听一步不假报在线", stepOf(sc, "env:watch")?.status !== "done", JSON.stringify(stepOf(sc, "env:watch")));
    check("env: 工具桥自身恒 done", stepOf(sc, "env:bridge")?.status === "done", JSON.stringify(stepOf(sc, "env:bridge")));
    check("env: 无技能根(假 HOME)→ 技能一步非 done", stepOf(sc, "env:skills")?.status !== "done", JSON.stringify(stepOf(sc, "env:skills")));
    check("env: 无 .git → git 一步非 done", stepOf(sc, "git:repo")?.status !== "done", JSON.stringify(stepOf(sc, "git:repo")));

    // 计数口径 = stepEvalParallel:doneCount/totalCount/currentIndex/chainState 自洽。
    const doneN = steps.filter((x) => x.status === "done").length;
    const firstNotDone = steps.findIndex((x) => x.status !== "done");
    check("env: doneCount/totalCount 与 steps 自洽", snap.doneCount === doneN && snap.totalCount === 6 && snap.applicableCount === 6,
      JSON.stringify({ done: snap.doneCount, total: snap.totalCount }));
    check("env: currentIndex 指首个未 done 步", snap.currentIndex === firstNotDone, JSON.stringify({ ci: snap.currentIndex, firstNotDone }));
    check("env: chainState = hasCurrent", snap.chainState === "hasCurrent" && snap.version === "1", JSON.stringify({ s: snap.chainState, v: snap.version }));
    check("env: 摘要是人话(N/M + 待处理)", typeof r.result?.content?.[0]?.text === "string" &&
      new RegExp(`环境检查 ${doneN}/6`).test(r.result.content[0].text) && /待处理/.test(r.result.content[0].text),
      r.result?.content?.[0]?.text);

    // force:用户亲手重检(本工具每次调用都真扫;force 只改变调用语义,不回错)
    const forced = await s.call("deck_env_check", { force: true });
    check("env: force=true 照常返回新快照", !forced.error && !forced.result?.isError && forced.result?.structuredContent?.snapshot?.totalCount === 6,
      JSON.stringify(forced.result?.structuredContent?.snapshot?.totalCount || forced.error));
    const tolerant = await s.call("deck_env_check", { force: "yes" });
    check("env: force 非布尔按未传处理(容错不报错)", !tolerant.error && !tolerant.result?.isError && tolerant.result?.structuredContent?.ok === true,
      JSON.stringify(tolerant.error || tolerant.result?.isError));
  } finally {
    await s.stop();
  }

  // 造出 .scratch 与 .git:同一工具的状态翻转(卡片/监听/git 三步变 done)。
  mkdirSync(join(rootInit, ".scratch"), { recursive: true });
  mkdirSync(join(rootInit, ".git"), { recursive: true });
  const s2 = await startServer(rootInit, fakeHomeEnv);
  try {
    const r = await s2.call("deck_env_check", {});
    const sc = r.result?.structuredContent || {};
    check("env(有 .scratch/.git): tracker:initialized done", stepOf(sc, "tracker:initialized")?.status === "done", JSON.stringify(stepOf(sc, "tracker:initialized")));
    check("env(有 .scratch/.git): md:workspace(卡片可读)done", stepOf(sc, "md:workspace")?.status === "done", JSON.stringify(stepOf(sc, "md:workspace")));
    check("env(有 .scratch/.git): env:watch 监听在线", stepOf(sc, "env:watch")?.status === "done", JSON.stringify(stepOf(sc, "env:watch")));
    check("env(有 .scratch/.git): git:repo done", stepOf(sc, "git:repo")?.status === "done", JSON.stringify(stepOf(sc, "git:repo")));
    check("env(有 .scratch/.git): 技能根仍按假 HOME 判(不假报 done)", stepOf(sc, "env:skills")?.status !== "done", JSON.stringify(stepOf(sc, "env:skills")));
    check("env(有 .scratch/.git): 计数随之上升(5/6;技能根按假 HOME 仍未过)", sc.snapshot?.doneCount === 5, JSON.stringify(sc.snapshot?.doneCount));
  } finally {
    await s2.stop();
    rmSync(base, { recursive: true, force: true });
  }
}
await sliceEnvCheck();

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
