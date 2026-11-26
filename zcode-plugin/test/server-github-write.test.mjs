// m7 票 04 缝测试:GitHub 后端的写通路与 deck_map_link。
//
// 缝:真服务进程(dist/server.mjs)+ 假 gh(test/fixtures/fake-gh.mjs,经 ZCODE_GH_PATH 递入)。
// 断言只打工具回包、假 gh 调用日志与假 gh 的状态文件;不 import 服务端内部模块。
// 覆盖:建票(标题必填/挂图/幂等键/effort 忽略)、评论、重开、标签覆盖与冲突、带原因关闭的
// 先评论后关、update 三分支、deck_map_link 的挂图/摘根/阻塞边与环拒绝、只读仓库零出站、
// 权限未知放行、revision 与计数缓存失效、摘要的仓库短名与议题号、写失败提醒、markdown 回归。
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { baseState, makeFakeGh, makeWorkspace } from "./gh-harness.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // zcode-plugin/
const ANCHOR_GITHUB = "# Issue tracker: GitHub\n\n本仓的票在 GitHub Issues 上。\n";
const REPO = "owner/name";
const RETRY_HINT = "先 deck_issue_get 读回现状";

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

/** 起一个指向指定工作区根的 server 会话(与 read 套件同形状;rpc 超时按需放宽)。 */
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

/** 写命令(含 GraphQL mutation;`api graphql --method POST` 的 node id 查询也算这条链路上的写前步骤)。 */
function isWriteCall(c) {
  const t = callText(c);
  if (/addBlockedBy|removeBlockedBy/.test(t)) return true;
  if (/--method\s+(POST|DELETE|PATCH)/i.test(t)) return true;
  if (/^issue (create|close|reopen|comment|edit)\b/.test(t)) return true;
  return false;
}
const writeCalls = (calls) => calls.filter(isWriteCall);

function permissionProbes(calls) {
  return calls.filter((c) => {
    const t = callText(c);
    return /^api repos\/owner\/name --jq \.permissions$/.test(t) || /api repos\/owner\/name --jq \.permissions$/.test(t);
  });
}

function repoState(gh) {
  return gh.state().repos[REPO];
}
function issueOf(gh, n) {
  return (repoState(gh).issues || []).find((i) => Number(i.number) === Number(n)) || null;
}
function namesOf(labels) {
  return (Array.isArray(labels) ? labels : []).map((l) => String((l && l.name) || l));
}
function loginsOf(assignees) {
  return (Array.isArray(assignees) ? assignees : []).map((a) => String((a && a.login) || a));
}

/** 失败用例统一断言:isError、kind 在场、文末带「先读回现状」提醒。 */
function checkWriteFailure(label, res, { reminder = true } = {}) {
  check(`${label}: isError`, isErr(res), textOf(res).slice(0, 400));
  const err = sc(res).error || {};
  check(`${label}: 结构化错误有 kind`, typeof err.kind === "string" && err.kind !== "", JSON.stringify(err));
  if (reminder) check(`${label}: 文末提醒先读回现状`, textOf(res).includes(RETRY_HINT) && textOf(res).includes("不要直接重发"), textOf(res).slice(-260));
}

// ---------------------------------------------------------------------------
// a. 建票:标题必填;挂图;幂等键;effort 忽略且摘要说明
// ---------------------------------------------------------------------------
async function sliceCreate() {
  const ws = makeWorkspace({ repo: REPO, anchor: ANCHOR_GITHUB });
  const gh = makeFakeGh({ state: baseState({ repo: REPO }) });
  const s = await startServer(ws.root, { ...gh.env, ZCODE_GITHUB_PROBE_MS: "60000" });
  try {
    const noTitle = await s.call("deck_issue_create", { title: "  " });
    check("建票: 缺 title 报错", isErr(noTitle) && /标题不能为空/.test(textOf(noTitle)), textOf(noTitle).slice(0, 300));
    check("建票: 缺 title 没有写命令", writeCalls(gh.calls()).length === 0, JSON.stringify(gh.calls().map(callText)));

    const made = await s.call("deck_issue_create", {
      effort: "m7-github-backend",
      title: "写通路接上",
      body: "正文里带一段话。",
      labels: ["ready-for-agent", "bug"],
      parentKey: "1",
      idempotencyKey: "ticket-04-create-1",
    });
    check("建票: 成功", !isErr(made), textOf(made).slice(0, 400));
    const body = sc(made);
    check("建票: 回包键集沿用本地形状", JSON.stringify(Object.keys(body).sort()) === JSON.stringify(["card", "changed", "key", "ok", "revision"]), JSON.stringify(Object.keys(body).sort()));
    check("建票: changed=true 且 key 是不补零的议题号", body.changed === true && body.key === "7", JSON.stringify({ changed: body.changed, key: body.key }));
    check("建票: 摘要带仓库短名与议题号", /owner\/name #7/.test(textOf(made)), textOf(made));
    check("建票: effort 被忽略且摘要说明", /effort 对 GitHub 后端无意义/.test(textOf(made)), textOf(made));
    const madeIssue = issueOf(gh, 7);
    check("建票: 正文落盘", madeIssue && String(madeIssue.body).includes("正文里带一段话"), JSON.stringify(madeIssue && madeIssue.body));
    check("建票: 标签落盘", madeIssue && namesOf(madeIssue.labels).join(",") === "ready-for-agent,bug", JSON.stringify(madeIssue && namesOf(madeIssue.labels)));
    check("建票: 带 parentKey 建出来就在地图下", madeIssue && String(madeIssue.parentKey) === "1", JSON.stringify(madeIssue && madeIssue.parentKey));
    check("建票: 回包 card 的 key 与 parentKey 与远端一致", body.card && body.card.key === "7" && String(body.card.parentKey) === "1", JSON.stringify(body.card && { key: body.card.key, parentKey: body.card.parentKey }));

    const again = await s.call("deck_issue_create", {
      effort: "m7-github-backend",
      title: "写通路接上(重试)",
      body: "同一个幂等键重试。",
      idempotencyKey: "ticket-04-create-1",
    });
    check("建票幂等: 重试成功", !isErr(again), textOf(again).slice(0, 400));
    check("建票幂等: 两次同一个号", sc(again).key === "7", JSON.stringify(sc(again).key));
    check("建票幂等: 没有建出第二张", (repoState(gh).issues || []).filter((i) => Number(i.number) === 7).length === 1 && (repoState(gh).issues || []).length === 5, String((repoState(gh).issues || []).length));
  } finally {
    await s.stop();
    gh.cleanup();
    ws.cleanup();
  }
}

// ---------------------------------------------------------------------------
// b. 评论、重开、标签覆盖式改与冲突
// ---------------------------------------------------------------------------
async function sliceCommentReopenLabels() {
  const ws = makeWorkspace({ repo: REPO, anchor: ANCHOR_GITHUB });
  const gh = makeFakeGh({ state: baseState({ repo: REPO }) });
  const s = await startServer(ws.root, { ...gh.env, ZCODE_GITHUB_PROBE_MS: "60000" });
  try {
    const commented = await s.call("deck_issue_comment", { key: "04", body: "来自 agent 的评论", actor: "不该出现的人" });
    check("评论: 成功", !isErr(commented), textOf(commented).slice(0, 400));
    const last = repoState(gh).comments["4"].at(-1);
    check("评论: 落到远端且作者是登录账号", last && last.body === "来自 agent 的评论" && last.author.login === "octocat", JSON.stringify(last));
    check("评论: 摘要不写 actor 也不写作者", !textOf(commented).includes("不该出现的人") && !textOf(commented).includes("octocat"), textOf(commented));
    check("评论: 摘要带仓库短名与议题号", /owner\/name #4/.test(textOf(commented)), textOf(commented));
    check("评论: 回包键集沿用本地形状", JSON.stringify(Object.keys(sc(commented)).sort()) === JSON.stringify(["card", "changed", "key", "ok", "revision"]), JSON.stringify(Object.keys(sc(commented)).sort()));

    const reopened = await s.call("deck_issue_reopen", { key: "6" });
    check("重开: 成功且远端已开", !isErr(reopened) && String(issueOf(gh, 6).state).toUpperCase() === "OPEN", textOf(reopened).slice(0, 300));
    check("重开: 回包 card 是写后读回", sc(reopened).card && String(sc(reopened).card.state).toLowerCase() === "open", JSON.stringify(sc(reopened).card && sc(reopened).card.state));

    const labelled = await s.call("deck_issue_set_labels", { key: "4", labels: ["bug", "ready-for-human"], expectedUpdatedAt: "2026-01-06T00:00:00Z" });
    check("标签: 覆盖式改成功", !isErr(labelled), textOf(labelled).slice(0, 400));
    check("标签: 远端就是新名单", namesOf(issueOf(gh, 4).labels).join(",") === "bug,ready-for-human", JSON.stringify(namesOf(issueOf(gh, 4).labels)));

    gh.clearCalls();
    const conflict = await s.call("deck_issue_set_labels", { key: "4", labels: ["wontfix"], expectedUpdatedAt: "2000-01-01T00:00:00Z" });
    checkWriteFailure("标签冲突", conflict);
    check("标签冲突: kind=conflict", (sc(conflict).error || {}).kind === "conflict", JSON.stringify(sc(conflict).error));
    check("标签冲突: 远端标签没被改", namesOf(issueOf(gh, 4).labels).join(",") === "bug,ready-for-human", JSON.stringify(namesOf(issueOf(gh, 4).labels)));
    check("标签冲突: 一条写命令都没发", writeCalls(gh.calls()).length === 0, JSON.stringify(gh.calls().map(callText)));
  } finally {
    await s.stop();
    gh.cleanup();
    ws.cleanup();
  }
}

// ---------------------------------------------------------------------------
// c. 带原因的关闭:先评论后关闭;评论失败就不关
// ---------------------------------------------------------------------------
async function sliceCloseWithReason() {
  const ws = makeWorkspace({ repo: REPO, anchor: ANCHOR_GITHUB });
  const gh = makeFakeGh({ state: baseState({ repo: REPO }) });
  const s = await startServer(ws.root, { ...gh.env, ZCODE_GITHUB_PROBE_MS: "60000" });
  try {
    const closed = await s.call("deck_issue_close", { key: "4", reason: "这张票做完了,原因写清楚留档。", actor: "ignored" });
    check("带原因关闭: 成功", !isErr(closed), textOf(closed).slice(0, 400));
    check("带原因关闭: 远端已关", String(issueOf(gh, 4).state).toUpperCase() === "CLOSED", String(issueOf(gh, 4).state));
    check("带原因关闭: 原因成了一条评论", repoState(gh).comments["4"].at(-1).body === "这张票做完了,原因写清楚留档。", JSON.stringify(repoState(gh).comments["4"].at(-1)));
    check("带原因关闭: 摘要说清先评论后关闭", /先评论后关闭/.test(textOf(closed)), textOf(closed));

    const calls = gh.calls().map(callText);
    const commentAt = calls.findIndex((t) => /\/issues\/4\/comments/.test(t) || /^issue comment 4\b/.test(t));
    const closeAt = calls.findIndex((t) => /^issue close 4\b/.test(t));
    check("带原因关闭: 日志次序先评论后关闭", commentAt >= 0 && closeAt > commentAt, JSON.stringify(calls));

    // 评论失败 -> 不关闭,回包说明
    gh.patch((st) => {
      st.failWrite = "comment";
    });
    gh.clearCalls();
    const blocked = await s.call("deck_issue_close", { key: "5", reason: "这次评论发不出去。" });
    checkWriteFailure("评论失败时的关闭", blocked);
    check("评论失败时的关闭: 回包说明没关票", /没关票/.test(textOf(blocked)), textOf(blocked).slice(0, 400));
    check("评论失败时的关闭: 远端仍开着", String(issueOf(gh, 5).state).toUpperCase() === "OPEN", String(issueOf(gh, 5).state));
    check("评论失败时的关闭: 没有发出关闭命令", callsWith(gh.calls(), "issue close 5").length === 0, JSON.stringify(gh.calls().map(callText)));
  } finally {
    await s.stop();
    gh.cleanup();
    ws.cleanup();
  }
}

// ---------------------------------------------------------------------------
// d. update 三分支:claim 并入不顶掉;关闭类值真关;其它值拒绝并指路
// ---------------------------------------------------------------------------
async function sliceUpdate() {
  const ws = makeWorkspace({ repo: REPO, anchor: ANCHOR_GITHUB });
  const base = baseState({ repo: REPO });
  base.repos[REPO].issues.find((i) => i.number === 5).assignees = [{ login: "alice" }];
  const gh = makeFakeGh({ state: base });
  const s = await startServer(ws.root, { ...gh.env, ZCODE_GITHUB_PROBE_MS: "60000" });
  try {
    const claimed = await s.call("deck_issue_update", { key: "5", status: "claimed" });
    check("update claimed: 成功", !isErr(claimed), textOf(claimed).slice(0, 400));
    check("update claimed: 当前登录人并进认领人", loginsOf(issueOf(gh, 5).assignees).join(",") === "alice,octocat", JSON.stringify(loginsOf(issueOf(gh, 5).assignees)));
    check("update claimed: 摘要说明加了谁", /octocat/.test(textOf(claimed)), textOf(claimed));

    const assigned = await s.call("deck_issue_update", { key: "4", assignees: ["@me", "alice"] });
    check("update assignees: 成功", !isErr(assigned), textOf(assigned).slice(0, 400));
    check("update assignees: 整份替换且 @me 换成登录人", loginsOf(issueOf(gh, 4).assignees).join(",") === "octocat,alice", JSON.stringify(loginsOf(issueOf(gh, 4).assignees)));

    const conflict = await s.call("deck_issue_update", { key: "4", status: "closed", expectedUpdatedAt: "2000-01-01T00:00:00Z" });
    checkWriteFailure("update 关闭类冲突", conflict);
    check("update 关闭类冲突: 没有关掉", String(issueOf(gh, 4).state).toUpperCase() === "OPEN", String(issueOf(gh, 4).state));

    const closed = await s.call("deck_issue_update", { key: "5", status: "Resolved" });
    check("update 关闭类: 大小写不敏感且真关", !isErr(closed) && String(issueOf(gh, 5).state).toUpperCase() === "CLOSED", textOf(closed).slice(0, 300));

    gh.clearCalls();
    const other = await s.call("deck_issue_update", { key: "4", status: "in-progress" });
    check("update 其它状态: isError", isErr(other), textOf(other).slice(0, 300));
    check("update 其它状态: 说明 GitHub 议题没有状态行", /没有状态行/.test(textOf(other)), textOf(other));
    check("update 其它状态: 指路三个工具", /claimed/.test(textOf(other)) && /deck_issue_close/.test(textOf(other)) && /deck_issue_set_labels/.test(textOf(other)), textOf(other));
    check("update 其它状态: 没有发写命令", writeCalls(gh.calls()).length === 0, JSON.stringify(gh.calls().map(callText)));

    const extra = await s.call("deck_issue_update", { key: "4", status: "claimed", title: "想改标题" });
    check("update 其它补丁字段: 成功且摘要说明忽略", !isErr(extra) && /已忽略/.test(textOf(extra)) && /title/.test(textOf(extra)), textOf(extra));
  } finally {
    await s.stop();
    gh.cleanup();
    ws.cleanup();
  }
}

// ---------------------------------------------------------------------------
// e. deck_map_link:挂图/摘根/阻塞边落地;自环与成环被拒且零写命令
// ---------------------------------------------------------------------------
async function sliceMapLink() {
  const ws = makeWorkspace({ repo: REPO, anchor: ANCHOR_GITHUB });
  const gh = makeFakeGh({ state: baseState({ repo: REPO }) });
  const s = await startServer(ws.root, { ...gh.env, ZCODE_GITHUB_PROBE_MS: "60000" });
  try {
    const detach = await s.call("deck_map_link", { key: "5", parentKey: null });
    check("map_link 摘根: 成功", !isErr(detach), textOf(detach).slice(0, 400));
    check("map_link 摘根: 远端已摘到根", issueOf(gh, 5).parentKey == null, JSON.stringify(issueOf(gh, 5).parentKey));
    check("map_link 摘根: 回包 parent.parentKey=null", sc(detach).parent && sc(detach).parent.ok === true && sc(detach).parent.parentKey === null, JSON.stringify(sc(detach).parent));
    check("map_link 摘根: 读回 card.parentKey=null", sc(detach).card && sc(detach).card.parentKey == null, JSON.stringify(sc(detach).card && sc(detach).card.parentKey));

    const attach = await s.call("deck_map_link", { key: "5", parentKey: "1" });
    check("map_link 挂图: 成功且远端 parentKey=1", !isErr(attach) && String(issueOf(gh, 5).parentKey) === "1", textOf(attach).slice(0, 300));
    const got1 = sc(await s.call("deck_issue_get", { key: "5" }));
    check("map_link 挂图: 用 deck_issue_get 读回核对", got1.card && String(got1.card.parentKey) === "1", JSON.stringify(got1.card && got1.card.parentKey));

    const blocked = await s.call("deck_map_link", { key: "5", blockedBy: ["6"] });
    check("map_link 阻塞边: 成功", !isErr(blocked), textOf(blocked).slice(0, 400));
    check("map_link 阻塞边: 远端就是新名单", JSON.stringify((issueOf(gh, 5).blockedBy || []).map((b) => String((b && b.key) || b))) === JSON.stringify(["6"]), JSON.stringify(issueOf(gh, 5).blockedBy));
    check("map_link 阻塞边: 回包 blockedBy.list", JSON.stringify(sc(blocked).blockedBy && sc(blocked).blockedBy.list) === JSON.stringify(["6"]), JSON.stringify(sc(blocked).blockedBy));
    const got2 = sc(await s.call("deck_issue_get", { key: "5" }));
    check("map_link 阻塞边: 用 deck_issue_get 读回核对", JSON.stringify((got2.card.blockedBy || []).map((b) => b.key)) === JSON.stringify(["6"]), JSON.stringify(got2.card.blockedBy));

    gh.clearCalls();
    const self = await s.call("deck_map_link", { key: "5", blockedBy: ["5"] });
    checkWriteFailure("map_link 自环", self);
    check("map_link 自环: kind=conflict", (sc(self).error || {}).kind === "conflict", JSON.stringify(sc(self).error));
    check("map_link 自环: 没有任何写命令", writeCalls(gh.calls()).length === 0, JSON.stringify(gh.calls().map(callText)));
    check("map_link 自环: 远端没变", JSON.stringify((issueOf(gh, 5).blockedBy || []).map((b) => String((b && b.key) || b))) === JSON.stringify(["6"]), JSON.stringify(issueOf(gh, 5).blockedBy));

    gh.clearCalls();
    const cycle = await s.call("deck_map_link", { key: "6", blockedBy: ["5"] });
    checkWriteFailure("map_link 成环", cycle);
    check("map_link 成环: kind=conflict", (sc(cycle).error || {}).kind === "conflict", JSON.stringify(sc(cycle).error));
    check("map_link 成环: 没有任何写命令", writeCalls(gh.calls()).length === 0, JSON.stringify(gh.calls().map(callText)));
    check("map_link 成环: 远端没变", JSON.stringify((issueOf(gh, 6).blockedBy || []).map((b) => String((b && b.key) || b))) === JSON.stringify([]), JSON.stringify(issueOf(gh, 6).blockedBy));

    gh.clearCalls();
    const parentFail = await s.call("deck_map_link", { key: "5", parentKey: "999", blockedBy: ["6"] });
    checkWriteFailure("map_link 父边失败即停", parentFail);
    check("map_link 父边失败即停: 没有写阻塞边", writeCalls(gh.calls()).every((c) => !/addBlockedBy|dependencies|blocked_by/.test(callText(c))), JSON.stringify(gh.calls().map(callText)));
  } finally {
    await s.stop();
    gh.cleanup();
    ws.cleanup();
  }
}

// ---------------------------------------------------------------------------
// f. 只读仓库:全部写工具被拒,零写命令;清单 writable=false
// ---------------------------------------------------------------------------
async function sliceReadonly() {
  const ws = makeWorkspace({ repo: REPO, anchor: ANCHOR_GITHUB });
  const state = baseState({ repo: REPO });
  state.repos[REPO].permissions = { push: false, triage: false };
  const gh = makeFakeGh({ state });
  const s = await startServer(ws.root, { ...gh.env, ZCODE_GITHUB_PROBE_MS: "60000" });
  try {
    const tools = [
      ["deck_issue_create", { title: "不该建出来" }],
      ["deck_issue_comment", { key: "4", body: "不该发出去" }],
      ["deck_issue_close", { key: "4" }],
      ["deck_issue_reopen", { key: "6" }],
      ["deck_issue_set_labels", { key: "4", labels: ["bug"] }],
      ["deck_issue_update", { key: "4", status: "claimed" }],
      ["deck_map_link", { key: "5", parentKey: "1" }],
    ];
    for (const [name, args] of tools) {
      const res = await s.call(name, args);
      check(`${name} 只读: 被拒且说明只读`, isErr(res) && /只读/.test(textOf(res)), textOf(res).slice(0, 260));
    }
    check("只读: 假 gh 零写命令", writeCalls(gh.calls()).length === 0, JSON.stringify(gh.calls().map(callText)));
    check("只读: 权限只问了一次(按根缓存)", permissionProbes(gh.calls()).length === 1, String(permissionProbes(gh.calls()).length));

    const list = sc(await s.call("deck_project_list", {}));
    check("只读: deck_project_list 的 backend.writable === false", list.active && list.active.backend && list.active.backend.writable === false, JSON.stringify(list.active && list.active.backend));
  } finally {
    await s.stop();
    gh.cleanup();
    ws.cleanup();
  }
}

// ---------------------------------------------------------------------------
// g. 权限未知:不预拒,写照常发;问不出来只问一次
// ---------------------------------------------------------------------------
async function slicePermissionUnknown() {
  // g1: 权限问不出来(permissions=null),写仍照常发并成功
  {
    const ws = makeWorkspace({ repo: REPO, anchor: ANCHOR_GITHUB });
    const state = baseState({ repo: REPO });
    state.repos[REPO].permissions = null;
    const gh = makeFakeGh({ state });
    const s = await startServer(ws.root, { ...gh.env, ZCODE_GITHUB_PROBE_MS: "60000" });
    try {
      const made = await s.call("deck_issue_create", { title: "权限未知也照写" });
      check("权限未知: 写照常发且成功", !isErr(made) && !!issueOf(gh, 5), textOf(made).slice(0, 300));
      check("权限未知: 确实发过写命令", writeCalls(gh.calls()).length > 0, JSON.stringify(gh.calls().map(callText)));
      const again = await s.call("deck_issue_create", { title: "第二次" });
      check("权限未知: 第二次写不再重问权限", !isErr(again) && permissionProbes(gh.calls()).length === 1, String(permissionProbes(gh.calls()).length));
    } finally {
      await s.stop();
      gh.cleanup();
      ws.cleanup();
    }
  }
  // g2: 权限未知 + 远端失败 -> 原话带回
  {
    const ws = makeWorkspace({ repo: REPO, anchor: ANCHOR_GITHUB });
    const state = baseState({ repo: REPO });
    state.repos[REPO].permissions = null;
    state.fail = "network";
    const gh = makeFakeGh({ state });
    const s = await startServer(ws.root, { ...gh.env, ZCODE_GITHUB_PROBE_MS: "60000" });
    try {
      const res = await s.call("deck_issue_comment", { key: "4", body: "网络断了" });
      checkWriteFailure("权限未知+网络失败", res);
      check("权限未知+网络失败: 上游原文带回", /Could not resolve host/.test(textOf(res)), textOf(res).slice(0, 400));
      check("权限未知+网络失败: 写命令真的发过(不是本地预拒)", callsWith(gh.calls(), "--method POST").length > 0, JSON.stringify(gh.calls().map(callText)));
      check("权限未知+网络失败: 权限只问一次", permissionProbes(gh.calls()).length === 1, String(permissionProbes(gh.calls()).length));
      const res2 = await s.call("deck_issue_comment", { key: "4", body: "再试一次" });
      check("权限未知+网络失败: 第二次也不重问权限", isErr(res2) && permissionProbes(gh.calls()).length === 1, String(permissionProbes(gh.calls()).length));
    } finally {
      await s.stop();
      gh.cleanup();
      ws.cleanup();
    }
  }
}

// ---------------------------------------------------------------------------
// h. 写成功推进 revision、计数缓存失效
// ---------------------------------------------------------------------------
async function sliceRevisionAndCounts() {
  const ws = makeWorkspace({ repo: REPO, anchor: ANCHOR_GITHUB });
  const gh = makeFakeGh({ state: baseState({ repo: REPO }) });
  const s = await startServer(ws.root, { ...gh.env, ZCODE_GITHUB_PROBE_MS: "60000" });
  try {
    const before = sc(await s.call("deck_issue_counts", {}));
    check("计数缓存: 写前开放 3 张", before.counts && before.counts.open === 3 && before.counts.closed === 1, JSON.stringify(before.counts));
    const countsCallsBefore = gh.calls().filter((c) => /openIssues:/.test(callText(c))).length;
    check("计数缓存: 写前出站一次", countsCallsBefore === 1, String(countsCallsBefore));

    const closed = await s.call("deck_issue_close", { key: "4", reason: "completed" });
    check("修订号: 写成功回包带 revision", !isErr(closed) && Number.isInteger(sc(closed).revision) && sc(closed).revision > before.revision, JSON.stringify({ before: before.revision, after: sc(closed).revision }));
    check("修订号: 写成功推进了项目根的修订号", sc(closed).revision === before.revision + 1, JSON.stringify({ before: before.revision, after: sc(closed).revision }));

    const after = sc(await s.call("deck_issue_counts", {}));
    check("计数缓存: 写后重新出站并看到新数", after.counts && after.counts.open === 2 && after.counts.closed === 2, JSON.stringify(after.counts));
    const countsCallsAfter = gh.calls().filter((c) => /openIssues:/.test(callText(c))).length;
    check("计数缓存: 写后计数真的又出站了一次", countsCallsAfter === 2, String(countsCallsAfter));
    check("计数缓存: 写后 revision 跟着走", after.revision === sc(closed).revision, JSON.stringify({ countsRevision: after.revision, writeRevision: sc(closed).revision }));
  } finally {
    await s.stop();
    gh.cleanup();
    ws.cleanup();
  }
}

// ---------------------------------------------------------------------------
// i. 摘要含仓库与议题号;写失败(网络)文末有先读回现状
// ---------------------------------------------------------------------------
async function sliceSummaryAndFailure() {
  const ws = makeWorkspace({ repo: REPO, anchor: ANCHOR_GITHUB });
  const gh = makeFakeGh({ state: baseState({ repo: REPO }) });
  const s = await startServer(ws.root, { ...gh.env, ZCODE_GITHUB_PROBE_MS: "60000" });
  try {
    const comment = await s.call("deck_issue_comment", { key: "4", body: "摘要检查" });
    check("摘要: 评论回包带 owner/name 与 #4", /owner\/name/.test(textOf(comment)) && /#4/.test(textOf(comment)), textOf(comment));
  } finally {
    await s.stop();
    gh.cleanup();
    ws.cleanup();
  }

  const ws2 = makeWorkspace({ repo: REPO, anchor: ANCHOR_GITHUB });
  const state = baseState({ repo: REPO });
  state.fail = "network";
  const gh2 = makeFakeGh({ state });
  const s2 = await startServer(ws2.root, { ...gh2.env, ZCODE_GITHUB_PROBE_MS: "60000" });
  try {
    const res = await s2.call("deck_issue_comment", { key: "4", body: "发不出去" });
    checkWriteFailure("网络失败", res);
    check("网络失败: 回包说明连不上", /连不上 GitHub/.test(textOf(res)), textOf(res).slice(0, 300));
    check("网络失败: 上游原文带回", /Could not resolve host/.test(textOf(res)), textOf(res).slice(0, 400));
  } finally {
    await s2.stop();
    gh2.cleanup();
    ws2.cleanup();
  }
}

// ---------------------------------------------------------------------------
// j. 本地 Markdown 回归:回包键集不变;新参数被忽略;deck_map_link 回不支持
// ---------------------------------------------------------------------------
async function sliceMarkdownRegression() {
  const cards = [{ effort: "demo", n: "01", slug: "one", title: "第一张" }];
  const ws = makeWorkspace({ repo: REPO, anchor: null, cards });
  const gh = makeFakeGh({ state: baseState({ repo: REPO }) });
  const s = await startServer(ws.root, { ...gh.env });
  const KEYS = ["card", "changed", "key", "ok", "revision"];
  const shapeOk = (res) => !isErr(res) && JSON.stringify(Object.keys(sc(res)).sort()) === JSON.stringify(KEYS);
  try {
    const created = await s.call("deck_issue_create", { effort: "demo", title: "Markdown 新票", parentKey: "1", idempotencyKey: "idem-1" });
    check("markdown 建票: 回包键集与 0.6.1 一致(新参数被忽略)", shapeOk(created), JSON.stringify({ keys: Object.keys(sc(created)), text: textOf(created) }));

    const commented = await s.call("deck_issue_comment", { key: "demo/01", body: "本地评论" });
    check("markdown 评论: 回包键集不变", shapeOk(commented), JSON.stringify(Object.keys(sc(commented))));

    const closed = await s.call("deck_issue_close", { key: "demo/01" });
    check("markdown 关闭: 回包键集不变", shapeOk(closed), JSON.stringify(Object.keys(sc(closed))));

    const reopened = await s.call("deck_issue_reopen", { key: "demo/01" });
    check("markdown 重开: 回包键集不变", shapeOk(reopened), JSON.stringify(Object.keys(sc(reopened))));

    const labelled = await s.call("deck_issue_set_labels", { key: "demo/01", labels: ["bug"] });
    check("markdown 标签: 回包键集不变", shapeOk(labelled), JSON.stringify(Object.keys(sc(labelled))));

    const updated = await s.call("deck_issue_update", { key: "demo/01", status: "ready-for-agent", assignees: ["alice"] });
    check("markdown update: 回包键集不变(assignees 被忽略)", shapeOk(updated), JSON.stringify(Object.keys(sc(updated))));

    const link = await s.call("deck_map_link", { key: "demo/01", parentKey: "1" });
    check("markdown deck_map_link: 回不支持", isErr(link) && /不支持/.test(textOf(link)), textOf(link));
    check("markdown deck_map_link: 指路 Blocked by 行", /Blocked by/.test(textOf(link)), textOf(link));
    check("markdown 回归: 假 gh 零调用", gh.calls().length === 0, JSON.stringify(gh.calls().map(callText)));
  } finally {
    await s.stop();
    gh.cleanup();
    ws.cleanup();
  }
}

await sliceCreate();
await sliceCommentReopenLabels();
await sliceCloseWithReason();
await sliceUpdate();
await sliceMapLink();
await sliceReadonly();
await slicePermissionUnknown();
await sliceRevisionAndCounts();
await sliceSummaryAndFailure();
await sliceMarkdownRegression();

console.log(failures === 0 ? `\n全部通过(${checks} 项断言)` : `\n${failures} 项失败(${checks} 项断言)`);
process.exit(failures === 0 ? 0 : 1);
