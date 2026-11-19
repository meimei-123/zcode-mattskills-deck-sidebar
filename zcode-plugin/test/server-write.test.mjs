// 工单 06 缝 1 测试:写路径落盘形状。临时工作区(拷贝 fixtures 后真写盘),Node 直跑
// dist/server.mjs 的 tools/call,断言六件写工具只产生「状态行/标签行/评论追加」三种变更、
// 幂等(noop 不写盘)、并发序列不丢、坏 key 拒绝、写后 revision 前进。
// 期望值独立于实现:来自 fixtures 手工盘点 + markdown-backend.md 写回纪律。
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 起一个指向临时工作区的 server 会话(同 live-refresh 模式,缺省发条)。 */
async function startServer(workspaceRoot) {
  const child = spawn(process.execPath, [join(ROOT, "dist", "server.mjs")], {
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

/** 拷一份 fixture 到临时目录(测试里真实写盘,不动入库 fixtures)。 */
function mkws(fixture) {
  const dir = mkdtempSync(join(tmpdir(), `t06-${fixture}-`));
  cpSync(join(FIXTURES, fixture), dir, { recursive: true });
  return dir;
}
const cleanup = (ws) => rmSync(ws, { recursive: true, force: true });
const fileOf = (ws, ...rel) => join(ws, ".scratch", ...rel);
const readCard = (ws, ...rel) => readFileSync(fileOf(ws, ...rel), "utf8");
const mtimeOf = (p) => statSync(p).mtimeMs;

// ---------------------------------------------------------------------------
// 切片 1:评论追加——块格式 `### 谁 — ISO`,追加到 ## Comments 段尾;无段则文末新建;
// 正文与既有评论一字不动(磁盘形状:旧内容是新内容的前缀)。
// ---------------------------------------------------------------------------
async function sliceComment() {
  if (!existsSync(join(ROOT, "dist", "server.mjs"))) {
    check("comment: dist/server.mjs 可跑", false);
    return;
  }
  const ws = mkws("mixed");
  const s = await startServer(ws);
  try {
    const tools = await s.rpc("tools/list", {});
    const names = (tools.result?.tools || []).map((t) => t.name);
    check("comment: tools/list 声明六件写工具",
      ["deck_issue_create", "deck_issue_update", "deck_issue_set_labels", "deck_issue_comment", "deck_issue_close", "deck_issue_reopen"]
        .every((n) => names.includes(n)),
      JSON.stringify(names));

    // 有 Comments 段的卡:追加到段尾(该卡段在文末 = 追加到文件尾),旧内容一字不动
    const target = fileOf(ws, "m1-core-board", "issues", "01-skeleton.md");
    const before = readFileSync(target, "utf8");
    const r = await s.call("deck_issue_comment", { key: "m1-core-board/01", body: "面板写入的第一条评论。" });
    check("comment: 应答无错误", !r.error && !r.result?.isError, JSON.stringify(r.error || r.result?.content));
    check("comment: 摘要是中文人话", /追加评论/.test(r.result?.content?.[0]?.text || ""), r.result?.content?.[0]?.text);
    const sc = r.result?.structuredContent || {};
    check("comment: 结构化结果 ok/带 key", sc.ok === true && sc.key === "m1-core-board/01", JSON.stringify(sc));
    check("comment: 写后 revision 已前进(主动失效,不等 fs.watch 栅格)", Number.isInteger(sc.revision) && sc.revision >= 2,
      JSON.stringify(sc.revision));

    const after = readFileSync(target, "utf8");
    check("comment: 磁盘形状 = 旧内容是前缀(只追加,不重排)", after.startsWith(before),
      JSON.stringify(after.slice(0, before.length + 20)));
    check("comment: 追加块头 `### local — ISO`", /### local — \d{4}-\d{2}-\d{2}T[^\s]+/.test(after), after.slice(-120));
    check("comment: 追加块带正文", after.includes("面板写入的第一条评论。"));

    const got = await s.call("deck_issue_get", { key: "m1-core-board/01" });
    const card = got.result?.structuredContent?.card;
    check("comment: 读回 2 条评论,新评论在尾",
      card?.comments?.length === 2 && card.comments[1]?.author?.login === "local" &&
        card.comments[1]?.body === "面板写入的第一条评论。" && /^\d{4}-\d{2}-\d{2}T/.test(card.comments[1]?.createdAt || ""),
      JSON.stringify(card?.comments?.map((c) => c.author?.login)));
    check("comment: 正文一字未动(仍含原句)", (card?.body || "").includes("manifest/MCP 服务/引导态面板先立起来。"));
    check("comment: 状态行不受评论影响", card?.state === "open", card?.state);

    // 无 Comments 段的卡:文末新建段(测试自造前置:普通单元 demo 的一张无段卡)
    mkdirSync(fileOf(ws, "demo", "issues"), { recursive: true });
    const t2 = fileOf(ws, "demo", "issues", "01-无段卡.md");
    writeFileSync(t2, "# 01: 无段卡\n\n**Status:** open\n\n这张卡没有评论段。\n", "utf8");
    const before2 = readFileSync(t2, "utf8");
    const r2 = await s.call("deck_issue_comment", { key: "demo/01", body: "给没有评论段的卡补第一条。" });
    check("comment: 无段卡应答无错误", !r2.result?.isError, r2.result?.content?.[0]?.text);
    const after2 = readFileSync(t2, "utf8");
    check("comment: 无段卡也是前缀追加", after2.startsWith(before2), JSON.stringify(after2.slice(0, before2.length)));
    check("comment: 文末新建 ## Comments 段", /## Comments\n\n### local — \d{4}/.test(after2), after2.slice(-80));

    // 多行正文 + 自定义 actor
    const r3 = await s.call("deck_issue_comment", { key: "m1-core-board/01", body: "第一行\n第二行", actor: "alice" });
    check("comment: 自定义 actor 应答无错误", !r3.result?.isError, r3.result?.content?.[0]?.text);
    const after3 = readFileSync(target, "utf8");
    check("comment: actor 进块头", /### alice — \d{4}-\d{2}-\d{2}T/.test(after3), after3.slice(-120));
    check("comment: 多行正文逐行落盘", after3.includes("第一行\n第二行"));

    // 空正文拒绝
    const empty = await s.call("deck_issue_comment", { key: "m1-core-board/01", body: "  " });
    check("comment: 空正文是工具级错误",
      empty.result?.isError === true && /评论正文/.test(empty.result?.content?.[0]?.text || ""),
      empty.result?.content?.[0]?.text);
  } finally {
    await s.stop();
    cleanup(ws);
  }
}

// ---------------------------------------------------------------------------
// 切片 2:状态行三件(update / close / reopen)——只动 Status 那一行(加粗随原文件、
// 裸写法保持裸),其余行一字不动;同值幂等 noop(不写盘不换 mtime);关票原因记为评论。
// ---------------------------------------------------------------------------
function lineDiff(before, after) {
  const a = before.split("\n");
  const b = after.split("\n");
  const out = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) out.push({ i, from: a[i], to: b[i] });
  }
  return out;
}

async function sliceStatus() {
  const ws = mkws("mixed");
  const s = await startServer(ws);
  try {
    // 加粗行原地换:close 只改 Status 那一行
    const target = fileOf(ws, "m1-core-board", "issues", "02-server-read.md");
    const before = readFileSync(target, "utf8");
    const r = await s.call("deck_issue_close", { key: "m1-core-board/02" });
    check("status: close 应答无错误", !r.error && !r.result?.isError, JSON.stringify(r.error || r.result?.content));
    check("status: close 摘要含人话", /已关闭/.test(r.result?.content?.[0]?.text || ""), r.result?.content?.[0]?.text);
    check("status: close changed=true", r.result?.structuredContent?.changed === true, JSON.stringify(r.result?.structuredContent?.changed));
    const d = lineDiff(before, readFileSync(target, "utf8"));
    check("status: close 恰好只改一行", d.length === 1, JSON.stringify(d));
    check("status: 加粗写法保持,值换 closed", d[0]?.to === "**Status:** closed", JSON.stringify(d[0]));
    const card = (await s.call("deck_issue_get", { key: "m1-core-board/02" })).result?.structuredContent?.card;
    check("status: 读回 closed", card?.state === "closed", card?.state);

    // 幂等:再关一次 → noop,不写盘(mtime 不变)、revision 不再前进
    const rev1 = r.result?.structuredContent?.revision;
    const m1 = mtimeOf(target);
    await sleep(30);
    const again = await s.call("deck_issue_close", { key: "m1-core-board/02" });
    check("status: 重复 close 是成功 noop", !again.result?.isError && again.result?.structuredContent?.changed === false,
      JSON.stringify(again.result?.content?.[0]?.text));
    check("status: noop 摘要说没写盘", /没写盘|没有改动|已是/.test(again.result?.content?.[0]?.text || ""), again.result?.content?.[0]?.text);
    check("status: noop 不写盘(mtime 不变)", mtimeOf(target) === m1, `${m1} → ${mtimeOf(target)}`);
    check("status: noop 后 revision 不前进", again.result?.structuredContent?.revision === rev1,
      `${rev1} → ${again.result?.structuredContent?.revision}`);

    // 关票原因记为评论;同因再关不重复追加
    const withReason = await s.call("deck_issue_close", { key: "m1-core-board/01", reason: "验收通过。" });
    check("status: 带原因 close 无错误", !withReason.result?.isError, withReason.result?.content?.[0]?.text);
    const c1 = (await s.call("deck_issue_get", { key: "m1-core-board/01" })).result?.structuredContent?.card;
    check("status: 原因追加为一条评论", c1?.comments?.some((c) => c.body === "验收通过。" && c.author?.login === "local"),
      JSON.stringify(c1?.comments?.map((c) => c.body)));
    check("status: 带原因 close 状态也换", c1?.state === "closed", c1?.state);
    const bytesBefore = readFileSync(fileOf(ws, "m1-core-board", "issues", "01-skeleton.md"), "utf8");
    await s.call("deck_issue_close", { key: "m1-core-board/01", reason: "验收通过。" });
    check("status: 同因再关零改动(末条同文不重复)",
      readFileSync(fileOf(ws, "m1-core-board", "issues", "01-skeleton.md"), "utf8") === bytesBefore);

    // reopen → ready-for-agent
    const re = await s.call("deck_issue_reopen", { key: "m1-core-board/02" });
    check("status: reopen 无错误", !re.result?.isError, re.result?.content?.[0]?.text);
    const d2 = lineDiff(before, readFileSync(target, "utf8"));
    check("status: reopen 后状态行是 ready-for-agent", d2.length === 1 && d2[0]?.to === "**Status:** ready-for-agent",
      JSON.stringify(d2));
    check("status: reopen 读回 open",
      (await s.call("deck_issue_get", { key: "m1-core-board/02" })).result?.structuredContent?.card?.state === "open");

    // update:任意值原样写
    const up = await s.call("deck_issue_update", { key: "m1-core-board/02", status: "claimed" });
    check("status: update 无错误", !up.result?.isError, up.result?.content?.[0]?.text);
    check("status: update 改行值为 claimed",
      readFileSync(target, "utf8").includes("**Status:** claimed"));
    const upAgain = await s.call("deck_issue_update", { key: "m1-core-board/02", status: "claimed" });
    check("status: update 同值幂等 noop", !upAgain.result?.isError && upAgain.result?.structuredContent?.changed === false,
      upAgain.result?.content?.[0]?.text);
    const empty = await s.call("deck_issue_update", { key: "m1-core-board/02", status: "  " });
    check("status: 空状态值拒绝", empty.result?.isError === true && /状态/.test(empty.result?.content?.[0]?.text || ""),
      empty.result?.content?.[0]?.text);

    // 裸写法卡(手写 `Status:` 裸行):原地换值,保持裸行不升格加粗
    mkdirSync(fileOf(ws, "bare", "issues"), { recursive: true });
    const bare = fileOf(ws, "bare", "issues", "01-裸行卡.md");
    writeFileSync(bare, "# 01: 裸行卡\n\nStatus: claimed\n\n裸写法的手写卡。\n", "utf8");
    const bareBefore = readFileSync(bare, "utf8");
    const bareR = await s.call("deck_issue_close", { key: "bare/01" });
    check("status: 裸行卡 close 无错误", !bareR.result?.isError, bareR.result?.content?.[0]?.text);
    const d3 = lineDiff(bareBefore, readFileSync(bare, "utf8"));
    check("status: 裸写法保持裸行,值换 closed", d3.length === 1 && d3[0]?.to === "Status: closed", JSON.stringify(d3));

    // 无状态行卡:close 插入状态行(插在最后一条字段行后;本卡无字段行 → H1 之后)
    mkdirSync(fileOf(ws, "solo", "issues"), { recursive: true });
    const t4 = fileOf(ws, "solo", "issues", "01-裸卡.md");
    writeFileSync(t4, "# 01: 裸卡\n\n没有状态行的手写卡。\n", "utf8");
    const ins = await s.call("deck_issue_close", { key: "solo/01" });
    check("status: 无状态行卡 close 无错误", !ins.result?.isError, ins.result?.content?.[0]?.text);
    const after4 = readFileSync(t4, "utf8");
    check("status: 插入的状态行在 H1 与正文之间", /^# 01: 裸卡\n\n\*\*Status:\*\* closed\n/.test(after4), JSON.stringify(after4));
    check("status: 插入后原文都在", after4.includes("没有状态行的手写卡。"));
    check("status: 插入后读回 closed",
      (await s.call("deck_issue_get", { key: "solo/01" })).result?.structuredContent?.card?.state === "closed");
  } finally {
    await s.stop();
    cleanup(ws);
  }
}

// ---------------------------------------------------------------------------
// 切片 3:标签行——可见 Labels 行原地换值;无可见行写 DSH-LABELS 注释(清空删行);
// 两处都有则两处一起改;同值幂等 noop。
// ---------------------------------------------------------------------------
async function sliceLabels() {
  const ws = mkws("mixed");
  const s = await startServer(ws);
  try {
    // 可见加粗行:原地换值,恰好一行 diff
    const target = fileOf(ws, "m1-core-board", "issues", "02-server-read.md");
    const before = readFileSync(target, "utf8");
    const r = await s.call("deck_issue_set_labels", { key: "m1-core-board/02", labels: ["bug", "needs-triage"] });
    check("labels: 应答无错误", !r.error && !r.result?.isError, JSON.stringify(r.error || r.result?.content));
    check("labels: 摘要含人话", /标签/.test(r.result?.content?.[0]?.text || ""), r.result?.content?.[0]?.text);
    const d = lineDiff(before, readFileSync(target, "utf8"));
    check("labels: 恰好只改标签行", d.length === 1, JSON.stringify(d));
    check("labels: 加粗写法保持,名单换新", d[0]?.to === "**Labels:** bug, needs-triage", JSON.stringify(d[0]));
    const card = (await s.call("deck_issue_get", { key: "m1-core-board/02" })).result?.structuredContent?.card;
    check("labels: 读回两名", card?.labels?.map((l) => l.name).join(",") === "bug,needs-triage", JSON.stringify(card?.labels));

    // 同值幂等 noop
    const m1 = mtimeOf(target);
    await sleep(30);
    const again = await s.call("deck_issue_set_labels", { key: "m1-core-board/02", labels: ["bug", "needs-triage"] });
    check("labels: 同值幂等 noop", !again.result?.isError && again.result?.structuredContent?.changed === false,
      again.result?.content?.[0]?.text);
    check("labels: noop 不写盘", mtimeOf(target) === m1);

    // 清空:可见行写空值
    await s.call("deck_issue_set_labels", { key: "m1-core-board/02", labels: [] });
    const cleared = readFileSync(target, "utf8");
    check("labels: 清空后可见行还在(值空)", /^\*\*Labels:\*\*[ \t]*$/m.test(cleared), cleared.split("\n").slice(2, 6).join("\n"));
    check("labels: 清空读回零标签",
      ((await s.call("deck_issue_get", { key: "m1-core-board/02" })).result?.structuredContent?.card?.labels || []).length === 0);

    // 无可见行:写 DSH-LABELS 注释到文件头;清空删行,逐字节还原
    const t2 = fileOf(ws, "explore-login", "issues", "01-oauth.md");
    const before2 = readFileSync(t2, "utf8");
    await s.call("deck_issue_set_labels", { key: "explore-login/01", labels: ["needs-triage"] });
    const after2 = readFileSync(t2, "utf8");
    check("labels: 无可见行 → 文件头插 DSH-LABELS 注释", after2.startsWith("<!-- DSH-LABELS: needs-triage -->"), after2.slice(0, 60));
    check("labels: 插入不重排(原文整体保留)", after2.endsWith(before2), after2.slice(-40));
    check("labels: 注释读回标签",
      ((await s.call("deck_issue_get", { key: "explore-login/01" })).result?.structuredContent?.card?.labels || [])[0]?.name === "needs-triage");
    await s.call("deck_issue_set_labels", { key: "explore-login/01", labels: [] });
    check("labels: 清空删注释行,逐字节还原", readFileSync(t2, "utf8") === before2);

    // 两处都有:一起改(解析以可见行为准,注释不许留旧值)
    mkdirSync(fileOf(ws, "dup", "issues"), { recursive: true });
    const t3 = fileOf(ws, "dup", "issues", "01-双写.md");
    writeFileSync(t3, "<!-- DSH-LABELS: stale -->\n\n# 01: 双写\n\n**Labels:** stale\n\n正文。\n", "utf8");
    await s.call("deck_issue_set_labels", { key: "dup/01", labels: ["bug"] });
    const after3 = readFileSync(t3, "utf8");
    check("labels: 可见行换新", after3.includes("**Labels:** bug"), after3);
    check("labels: DSH-LABELS 同步换新", after3.includes("<!-- DSH-LABELS: bug -->"), after3);
    check("labels: 双写卡读回一名",
      ((await s.call("deck_issue_get", { key: "dup/01" })).result?.structuredContent?.card?.labels || [])[0]?.name === "bug");
  } finally {
    await s.stop();
    cleanup(ws);
  }
}

// ---------------------------------------------------------------------------
// 切片 4:建卡——下一个空闲编号、标题 slug(中文保留、标点折连字符)、impl 票形状、
// 新工作单元连目录一起建;缺标题/坏 effort 拒绝。
// ---------------------------------------------------------------------------
async function sliceCreate() {
  const ws = mkws("mixed");
  const s = await startServer(ws);
  try {
    const r = await s.call("deck_issue_create", {
      effort: "m1-core-board",
      title: "写路径",
      body: "六件写工具。",
      labels: ["bug"],
    });
    check("create: 应答无错误", !r.error && !r.result?.isError, JSON.stringify(r.error || r.result?.content));
    check("create: 摘要说建到哪", /#m1-core-board\/04/.test(r.result?.content?.[0]?.text || "") && /写路径/.test(r.result?.content?.[0]?.text || ""),
      r.result?.content?.[0]?.text);
    const f = fileOf(ws, "m1-core-board", "issues", "04-写路径.md");
    check("create: 文件落位 NN-slug(中文保留)", existsSync(f), f);
    const text = readFileSync(f, "utf8");
    check("create: 文件头 DSH-CREATED + 类型标记", /^<!-- DSH-CREATED: \d{4}-\d{2}-\d{2}T[^\n]+\n<!-- DSH-ISSUE-KIND: ticket -->/.test(text), text.slice(0, 100));
    check("create: H1 带编号与标题", text.includes("# 04: 写路径"));
    check("create: impl 票形状(加粗状态行 open)", text.includes("**Status:** open"));
    check("create: 标签行", text.includes("**Labels:** bug"));
    check("create: 正文", text.includes("六件写工具。"));
    const row = (await s.call("deck_issue_list", { keys: ["04"], state: "all" })).result?.structuredContent?.rows?.find((x) => x.effortId === "m1-core-board");
    check("create: list 读回新卡(open/bug)", row?.state === "open" && row?.labels?.[0]?.name === "bug", JSON.stringify(row && { s: row.state, l: row.labels }));

    const r2 = await s.call("deck_issue_create", { effort: "m1-core-board", title: "下一张" });
    check("create: 再建取下一空闲编号 05", existsSync(fileOf(ws, "m1-core-board", "issues", "05-下一张.md")), "");
    check("create: 无标签不写标签行", !readFileSync(fileOf(ws, "m1-core-board", "issues", "05-下一张.md"), "utf8").includes("Labels:"));

    const r3 = await s.call("deck_issue_create", { effort: "全新单元", title: "Fix Login Flow!" });
    check("create: 新工作单元连目录建", existsSync(fileOf(ws, "全新单元", "issues", "01-fix-login-flow.md")), "");
    check("create: 英文标题 slug 小写折连字符", /01-fix-login-flow\.md/.test(r3.result?.content?.[0]?.text || ""), r3.result?.content?.[0]?.text);

    const noTitle = await s.call("deck_issue_create", { effort: "m1-core-board" });
    check("create: 缺标题拒绝", noTitle.result?.isError === true && /标题/.test(noTitle.result?.content?.[0]?.text || ""), noTitle.result?.content?.[0]?.text);
    const noEffort = await s.call("deck_issue_create", { title: "没给单元" });
    check("create: 缺 effort 拒绝", noEffort.result?.isError === true && /effort/.test(noEffort.result?.content?.[0]?.text || ""), noEffort.result?.content?.[0]?.text);
    const badEffort = await s.call("deck_issue_create", { effort: "../越界", title: "x" });
    check("create: 路径穿越式 effort 拒绝", badEffort.result?.isError === true && /effort/.test(badEffort.result?.content?.[0]?.text || ""), badEffort.result?.content?.[0]?.text);
    check("create: 拒绝时没建任何文件", !existsSync(fileOf(ws, "m1-core-board", "issues", "06-x.md")));
  } finally {
    await s.stop();
    cleanup(ws);
  }
}

// ---------------------------------------------------------------------------
// 切片 5:写前校验与守卫——坏 key / 同号多卡 conflict 不猜 / 容器拒绝 / 旧布局只读 /
// expectedUpdatedAt 版本冲突 / 并发评论序列一条不丢。
// ---------------------------------------------------------------------------
async function sliceGuard() {
  const ws = mkws("mixed");
  const s = await startServer(ws);
  try {
    const missing = await s.call("deck_issue_update", { key: "99", status: "open" });
    check("guard: 坏 key 拒绝", missing.result?.isError === true && /找不到卡 99/.test(missing.result?.content?.[0]?.text || ""),
      missing.result?.content?.[0]?.text);

    // 同号多卡:两个单元都有 01 → 写口径不猜文件
    const fA = fileOf(ws, "m1-core-board", "issues", "01-skeleton.md");
    const fB = fileOf(ws, "explore-login", "issues", "01-oauth.md");
    const beforeA = readFileSync(fA, "utf8");
    const beforeB = readFileSync(fB, "utf8");
    const dup = await s.call("deck_issue_comment", { key: "01", body: "不该写进任何一张。" });
    check("guard: 同号多卡 conflict 拒绝", dup.result?.isError === true && /同号多张/.test(dup.result?.content?.[0]?.text || ""),
      dup.result?.content?.[0]?.text);
    check("guard: conflict 一个字都没写", readFileSync(fA, "utf8") === beforeA && readFileSync(fB, "utf8") === beforeB);

    // 容器:规格/地图行不给写
    const container = await s.call("deck_issue_close", { key: "m1-core-board/00" });
    check("guard: 容器拒绝写", container.result?.isError === true && /容器/.test(container.result?.content?.[0]?.text || ""),
      container.result?.content?.[0]?.text);

    // 旧布局(根级扁平 issues/):可读可列、写一律失败
    mkdirSync(fileOf(ws, "issues"), { recursive: true });
    writeFileSync(fileOf(ws, "issues", "07-旧布局卡.md"), "# 07: 旧布局卡\n\n**Status:** open\n", "utf8");
    const legacyKey = (await s.call("deck_issue_list", { keys: ["07"] })).result?.structuredContent?.rows?.[0];
    check("guard: 旧布局卡可读可列", legacyKey?.title === "旧布局卡", JSON.stringify(legacyKey && legacyKey.title));
    const legacy = await s.call("deck_issue_comment", { key: legacyKey.effortId ? `${legacyKey.effortId}/07` : "07", body: "不许写。" });
    check("guard: 旧布局只读拒绝", legacy.result?.isError === true && /只读/.test(legacy.result?.content?.[0]?.text || ""),
      legacy.result?.content?.[0]?.text);
    check("guard: 旧布局文件没动", readFileSync(fileOf(ws, "issues", "07-旧布局卡.md"), "utf8") === "# 07: 旧布局卡\n\n**Status:** open\n");

    // expectedUpdatedAt:错值拒绝,对值放行
    const stale = await s.call("deck_issue_update", { key: "m1-core-board/02", status: "claimed", expectedUpdatedAt: "2000-01-01T00:00:00.000Z" });
    check("guard: 版本冲突拒绝", stale.result?.isError === true && /版本冲突/.test(stale.result?.content?.[0]?.text || ""),
      stale.result?.content?.[0]?.text);
    const fresh = (await s.call("deck_issue_get", { key: "m1-core-board/02" })).result?.structuredContent?.card;
    const ok = await s.call("deck_issue_update", { key: "m1-core-board/02", status: "claimed", expectedUpdatedAt: fresh.updatedAt });
    check("guard: 版本对上放行", !ok.result?.isError, ok.result?.content?.[0]?.text);

    // 并发:同一张卡一口气 8 条评论,全部落盘、一条不丢、正文不重排
    const t = fileOf(ws, "m1-core-board", "issues", "03-panel-list.md");
    const before3 = readFileSync(t, "utf8");
    const sent = Array.from({ length: 8 }, (_, i) => s.call("deck_issue_comment", { key: "m1-core-board/03", body: `并发第 ${i + 1} 条` }));
    const results = await Promise.all(sent);
    check("guard: 并发 8 条全部成功", results.every((x) => !x.error && !x.result?.isError),
      JSON.stringify(results.map((x) => x.result?.content?.[0]?.text)));
    const card3 = (await s.call("deck_issue_get", { key: "m1-core-board/03" })).result?.structuredContent?.card;
    check("guard: 8 条评论全在(1 条旧 + 8 条新)", card3?.comments?.length === 9, String(card3?.comments?.length));
    const disk = readFileSync(t, "utf8");
    check("guard: 并发后原内容仍是前缀(不重排)", disk.startsWith(before3));
    for (let i = 1; i <= 8; i++) check(`guard: 并发第 ${i} 条在盘上`, disk.includes(`并发第 ${i} 条`));
  } finally {
    await s.stop();
    cleanup(ws);
  }
}

await sliceComment();
await sliceStatus();
await sliceLabels();
await sliceCreate();
await sliceGuard();

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
