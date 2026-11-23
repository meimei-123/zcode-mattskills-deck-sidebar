// 票 01 缝测试:项目清单(home-repo 根 .deck/projects.json)+ 活动项目。
// 沿用 server-read 的 startServer+rpc 会话形状:fixtures 工作区(无清单 = 与现状
// 逐字一致)+ mkdtemp 临时项目根(清单存在时),结束删净。断言只打工具回包,
// 不 import 服务端内部模块;清单现读口径靠调用间改盘验证。
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

/** 起一个指向指定工作区根的 server 会话,交回 rpc/stop(与 server-read 同形状)。 */
async function startServer(workspaceRoot, extraEnv = {}) {
  const child = spawn(process.execPath, [join(ROOT, "dist", "server.mjs")], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, ZCODE_WORKSPACE_ROOT: workspaceRoot, ...extraEnv },
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

/** 两个路径指到同一目录(native realpath 归一,junction/大小写差异都算同处)。 */
function samePath(a, b) {
  try {
    return realpathSync.native(a) === realpathSync.native(b);
  } catch {
    return false;
  }
}

/** 一张最小工单卡:.scratch/<effort>/issues/NN-slug.md,H1 剥编号作标题。 */
function writeCard(projectRoot, effort, n, slug, title) {
  mkdirSync(join(projectRoot, ".scratch", effort, "issues"), { recursive: true });
  writeFileSync(join(projectRoot, ".scratch", effort, "issues", `${n}-${slug}.md`), `# ${n}: ${title}\n\n**Status:** open\n\n正文。\n`, "utf8");
}

function writeRegistry(homeRoot, projects) {
  mkdirSync(join(homeRoot, ".deck"), { recursive: true });
  writeFileSync(join(homeRoot, ".deck", "projects.json"), JSON.stringify({ version: 1, projects }, null, 2), "utf8");
}

// ---------------------------------------------------------------------------
// 切片 1:没有 .deck/projects.json —— deck_project_list 只回 home-repo,
// deck_project_use 切 home-repo 幂等 noop;读工具回包与现状逐字一致(无附加字段)。
// ---------------------------------------------------------------------------
async function sliceNoRegistry() {
  const homeRoot = join(FIXTURES, "mixed");
  const s = await startServer(homeRoot);
  try {
    const tools = await s.rpc("tools/list", {});
    const all = tools.result?.tools || [];
    const names = all.map((t) => t.name);
    check("无清单: tools/list 声明 deck_project_list / deck_project_use",
      names.includes("deck_project_list") && names.includes("deck_project_use"), JSON.stringify(names));
    const use = all.find((t) => t.name === "deck_project_use");
    check("无清单: deck_project_use 的 name 必填",
      !!use && Array.isArray(use.inputSchema?.required) && use.inputSchema.required.includes("name"),
      JSON.stringify(use?.inputSchema));

    const r = await s.call("deck_project_list", {});
    check("无清单: 应答无错误", !r.error && !r.result?.isError, JSON.stringify(r.error || r.result?.isError));
    const sc = r.result?.structuredContent || {};
    check("无清单: registry.status=missing,无解析错误,带清单文件路径",
      sc.registry?.status === "missing" && sc.registry?.error === null &&
        String(sc.registry?.path || "").endsWith(join(".deck", "projects.json")),
      JSON.stringify(sc.registry));
    check("无清单: projects 只有一项(home-repo)",
      Array.isArray(sc.projects) && sc.projects.length === 1, JSON.stringify(sc.projects?.length));
    const home = sc.projects?.[0] || {};
    check("无清单: home-repo 第一,isHome=true/valid=true,名字取目录名",
      home.isHome === true && home.valid === true && home.name === "mixed" && samePath(home.path, homeRoot),
      JSON.stringify(home));
    check("无清单: 活动项目就是 home-repo",
      sc.active?.isHome === true && sc.active?.name === "mixed" && samePath(sc.active?.path, homeRoot),
      JSON.stringify(sc.active));
    check("无清单: warnings 为空", Array.isArray(sc.warnings) && sc.warnings.length === 0, JSON.stringify(sc.warnings));

    const noop = await s.call("deck_project_use", { name: "mixed" });
    check("无清单: 切到 home-repo 不报错且活动项目是 home-repo",
      !noop.error && !noop.result?.isError && noop.result?.structuredContent?.active?.isHome === true &&
        noop.result?.structuredContent?.active?.name === "mixed",
      JSON.stringify(noop.result || noop.error));
    const again = await s.call("deck_project_use", { name: "mixed" });
    check("无清单: 再切一次 home-repo 结果一致(幂等 noop)",
      again.result?.structuredContent?.active?.isHome === true && again.result?.structuredContent?.projects?.length === 1,
      JSON.stringify(again.result?.structuredContent?.active));

    const ghost = await s.call("deck_project_use", { name: "ghost" });
    check("无清单: 未知名字是工具级错误且列出可用名字(home-repo)",
      ghost.result?.isError === true && /mixed/.test(ghost.result?.content?.[0]?.text || ""),
      JSON.stringify(ghost.result || ghost.error));
    const noName = await s.call("deck_project_use", {});
    check("无清单: 缺 name 是工具级错误", noName.result?.isError === true, JSON.stringify(noName.result || noName.error));

    // 现状逐字:读工具与旧口径一致,回包不带活动项目附加字段。
    const list = await s.call("deck_issue_list", {});
    const lsc = list.result?.structuredContent || {};
    check("无清单: deck_issue_list 现状不变(8 行)",
      !list.result?.isError && lsc.rows?.length === 8, `got ${lsc.rows?.length}`);
    check("无清单: 读工具回包不带活动项目/回退附加字段",
      !("note" in lsc) && !("active" in lsc), JSON.stringify(Object.keys(lsc)));
    check("无清单: 读工具 workspaceRoot 仍是工作区根", samePath(lsc.workspaceRoot, homeRoot), lsc.workspaceRoot);
    const counts = await s.call("deck_issue_counts", {});
    check("无清单: deck_issue_counts 现状不变(open 4)",
      counts.result?.structuredContent?.counts?.open === 4, JSON.stringify(counts.result?.structuredContent?.counts));
  } finally {
    await s.stop();
  }
}

// ---------------------------------------------------------------------------
// 切片 2:有效清单 —— home-repo 第一、条目按清单顺序;name 缺省取目录名;相对路径
// 按 home-repo 根解析;切换后 list/get/counts 读活动项目;卡片 key 仍是 effort/NN。
// ---------------------------------------------------------------------------
async function sliceValidRegistry() {
  const base = mkdtempSync(join(tmpdir(), "deck-proj-valid-"));
  const homeRoot = join(base, "home");
  const projA = join(base, "proj-a");
  const projB = join(base, "proj-b");
  for (const p of [homeRoot, projA, projB]) mkdirSync(p, { recursive: true });
  writeCard(homeRoot, "m1", "01", "home-card", "home 卡");
  writeCard(projA, "alpha", "01", "alpha-card", "alpha 卡");
  writeCard(projB, "beta", "01", "beta-card", "beta 卡");
  writeRegistry(homeRoot, [
    { name: "alpha", path: projA },
    { path: "../proj-b" }, // name 缺省取目录名;相对路径按 home-repo 根解析(不按 .deck/)
  ]);
  const s = await startServer(homeRoot);
  try {
    const r = await s.call("deck_project_list", {});
    const sc = r.result?.structuredContent || {};
    check("有效清单: registry.status=ok", sc.registry?.status === "ok", JSON.stringify(sc.registry));
    check("有效清单: home-repo 第一,条目按清单顺序(alpha 在前,缺省名取目录名)",
      sc.projects?.length === 3 && sc.projects[0]?.isHome === true && sc.projects[1]?.name === "alpha" && sc.projects[2]?.name === "proj-b",
      JSON.stringify(sc.projects));
    check("有效清单: 全部条目 valid=true", (sc.projects || []).every((p) => p.valid === true), JSON.stringify(sc.projects));
    check("有效清单: 相对路径按 home-repo 根解析", samePath(sc.projects?.[2]?.path, projB), sc.projects?.[2]?.path);
    check("有效清单: 默认活动项目是 home-repo", sc.active?.isHome === true, JSON.stringify(sc.active));

    const before = await s.call("deck_issue_list", {});
    check("有效清单: 未切换时 list 读 home-repo",
      before.result?.structuredContent?.rows?.length === 1 && before.result.structuredContent.rows[0]?.effortId === "m1",
      JSON.stringify(before.result?.structuredContent?.rows));

    const use = await s.call("deck_project_use", { name: "alpha" });
    const usc = use.result?.structuredContent || {};
    check("切换: deck_project_use 返回切换后的活动项目(非 home)",
      !use.result?.isError && usc.active?.name === "alpha" && usc.active?.isHome === false && samePath(usc.active?.path, projA),
      JSON.stringify(usc.active || use.result || use.error));
    check("切换: 同一份清单状态随回包(3 项 + ok)",
      usc.projects?.length === 3 && usc.registry?.status === "ok", JSON.stringify(usc.registry));

    const after = await s.call("deck_issue_list", {});
    const asc = after.result?.structuredContent || {};
    check("切换后: deck_issue_list 读活动项目(alpha 卡)",
      asc.rows?.length === 1 && asc.rows[0]?.effortId === "alpha" && asc.rows[0]?.title === "alpha 卡",
      JSON.stringify(asc.rows));
    check("切换后: 卡片 key 仍是 effort 内编号(01)", asc.rows?.[0]?.key === "01", asc.rows?.[0]?.key);
    check("切换后: workspaceRoot 反映活动项目", samePath(asc.workspaceRoot, projA), asc.workspaceRoot);

    const get = await s.call("deck_issue_get", { key: "01" });
    const gcard = get.result?.structuredContent?.card;
    check("切换后: deck_issue_get 读活动项目",
      gcard?.effortId === "alpha" && /alpha/.test(String(gcard?.body || "")),
      JSON.stringify(gcard && { e: gcard.effortId, t: gcard.title }));

    const counts = await s.call("deck_issue_counts", {});
    const csc = counts.result?.structuredContent || {};
    check("切换后: deck_issue_counts 读活动项目(total=1)",
      csc.counts?.total === 1 && samePath(csc.workspaceRoot, projA), JSON.stringify(csc.counts));

    const useB = await s.call("deck_project_use", { name: "proj-b" });
    const rowsB = (await s.call("deck_issue_list", {})).result?.structuredContent?.rows || [];
    check("切换后: 缺省名(目录名)也能切,list 跟到 proj-b",
      !useB.result?.isError && rowsB.length === 1 && rowsB[0]?.effortId === "beta", JSON.stringify(rowsB));

    const back = await s.call("deck_project_use", { name: "home" });
    const rowsBack = (await s.call("deck_issue_list", {})).result?.structuredContent?.rows || [];
    check("切换后: 切回 home-repo,list 回到本仓卡片",
      back.result?.structuredContent?.active?.isHome === true && rowsBack.length === 1 && rowsBack[0]?.effortId === "m1",
      JSON.stringify(rowsBack));
  } finally {
    await s.stop();
    rmSync(base, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 切片 3:条目级容错 —— 路径不存在 / 名字非法 / 重名(不区分大小写) / "."(home-repo)
// / 重复 realpath / 缺 path / 非对象:全部跳过并进 warnings;其余条目照常可用。
// ---------------------------------------------------------------------------
async function sliceBadEntries() {
  const base = mkdtempSync(join(tmpdir(), "deck-proj-bad-"));
  const homeRoot = join(base, "home");
  const projA = join(base, "proj-a");
  const projB = join(base, "proj-b");
  for (const p of [homeRoot, projA, projB]) mkdirSync(p, { recursive: true });
  writeCard(homeRoot, "m1", "01", "home-card", "home 卡");
  writeCard(projA, "alpha", "01", "alpha-card", "alpha 卡");
  writeCard(projB, "beta", "01", "beta-card", "beta 卡");
  writeRegistry(homeRoot, [
    { name: "ghost", path: join(base, "nope") }, // 路径不存在
    { name: "bad/name", path: projA }, // 名字非法
    { name: "real", path: projA }, // 有效
    { name: "REAL", path: projB }, // 重名(不区分大小写)
    { path: "." }, // home-repo 本身,忽略 + warning
    { name: "alias", path: projA }, // realpath 重复
    { name: "beta", path: "../proj-b" }, // 有效
    { name: "ghost2" }, // 缺 path
    "junk", // 不是对象
  ]);
  const s = await startServer(homeRoot);
  try {
    const r = await s.call("deck_project_list", {});
    const sc = r.result?.structuredContent || {};
    const projects = sc.projects || [];
    const valid = projects.filter((p) => p.valid);
    check("坏条目: 可用的只有 home-repo + real + beta",
      valid.length === 3 && projects[0]?.isHome === true && valid.some((p) => p.name === "real") && valid.some((p) => p.name === "beta"),
      JSON.stringify(projects));
    check("坏条目: 坏条目保留在清单里,valid=false 且带原因",
      projects.some((p) => p.name === "ghost" && p.valid === false && !!p.reason),
      JSON.stringify(projects));
    const warns = sc.warnings || [];
    check("坏条目: warnings 恰 7 条(每个坏条目一条)", warns.length === 7, JSON.stringify(warns));
    const all = warns.join("|");
    check("坏条目: 各警告点名原因",
      /ghost/.test(all) && /bad\/name/.test(all) && /REAL/.test(all) && /alias/.test(all) &&
        /ghost2/.test(all) && /不是对象/.test(all) && /home-repo/.test(all),
      all);

    const g = await s.call("deck_project_use", { name: "ghost" });
    check("坏条目: 路径不存在的条目不能切换",
      g.result?.isError === true && /ghost/.test(g.result?.content?.[0]?.text || ""), JSON.stringify(g.result || g.error));
    const al = await s.call("deck_project_use", { name: "alias" });
    check("坏条目: 重复 realpath 的条目不能切换", al.result?.isError === true, JSON.stringify(al.result || al.error));
    const bn = await s.call("deck_project_use", { name: "bad/name" });
    check("坏条目: 非法名字不能切换,错误里列出可用名字(real、beta)",
      bn.result?.isError === true && /real/.test(bn.result?.content?.[0]?.text || "") && /beta/.test(bn.result?.content?.[0]?.text || ""),
      JSON.stringify(bn.result || bn.error));

    const ok = await s.call("deck_project_use", { name: "real" });
    const rows = (await s.call("deck_issue_list", {})).result?.structuredContent?.rows || [];
    check("坏条目: 其余条目照常可用(切到 real 读 alpha)",
      !ok.result?.isError && rows.length === 1 && rows[0]?.effortId === "alpha", JSON.stringify(rows));
  } finally {
    await s.stop();
    rmSync(base, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 切片 4:整份 JSON 坏 —— 退回单根(读工具照常)、deck_project_list 带解析错误;
// 活动项目已设时下一次调用回退 home-repo 并说明;回退落定后不再重复说明。
// ---------------------------------------------------------------------------
async function sliceBrokenRegistry() {
  const base = mkdtempSync(join(tmpdir(), "deck-proj-broken-"));
  const homeRoot = join(base, "home");
  const projA = join(base, "proj-a");
  for (const p of [homeRoot, projA]) mkdirSync(p, { recursive: true });
  writeCard(homeRoot, "m1", "01", "home-card", "home 卡");
  writeCard(projA, "alpha", "01", "alpha-card", "alpha 卡");
  writeRegistry(homeRoot, [{ name: "alpha", path: projA }]);
  const s = await startServer(homeRoot);
  try {
    await s.call("deck_project_use", { name: "alpha" }); // 清单还好时切到 alpha
    writeFileSync(join(homeRoot, ".deck", "projects.json"), "{ 不是 json", "utf8"); // 整份写坏

    const list = await s.call("deck_issue_list", {});
    const lsc = list.result?.structuredContent || {};
    check("整份坏: 读工具退回单根(home 卡),不是错误",
      !list.result?.isError && lsc.rows?.length === 1 && lsc.rows[0]?.effortId === "m1", JSON.stringify(lsc.rows));
    check("整份坏: 活动项目回退并在回包说明(点名 alpha)",
      typeof lsc.note === "string" && /alpha/.test(lsc.note) && /回退/.test(lsc.note), lsc.note);

    const r = await s.call("deck_project_list", {});
    const sc = r.result?.structuredContent || {};
    check("整份坏: registry.status=broken 且带解析错误",
      sc.registry?.status === "broken" && typeof sc.registry?.error === "string" && sc.registry.error.length > 0,
      JSON.stringify(sc.registry));
    check("整份坏: 退回单根(只有 home-repo)", sc.projects?.length === 1 && sc.projects[0]?.isHome === true, JSON.stringify(sc.projects));
    check("整份坏: 摘要里点出清单读不出来", /清单/.test(r.result?.content?.[0]?.text || ""), r.result?.content?.[0]?.text);

    const use = await s.call("deck_project_use", { name: "alpha" });
    check("整份坏: 切换被拒且列出可用名字(只有 home)",
      use.result?.isError === true && /home/.test(use.result?.content?.[0]?.text || ""), JSON.stringify(use.result || use.error));

    const again = await s.call("deck_issue_list", {});
    const asc = again.result?.structuredContent || {};
    check("整份坏: 回退落定后回包不再带说明",
      !("note" in asc) && asc.rows?.length === 1 && asc.rows[0]?.effortId === "m1",
      JSON.stringify({ note: asc.note, rows: asc.rows?.length }));
  } finally {
    await s.stop();
    rmSync(base, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 切片 5:清单漂移 —— 同名项改路径后下一次调用用新路径;移出清单/改名后下一次
// 调用回退 home-repo 并说明(清单是唯一信任边界,回退落定不再重复)。
// ---------------------------------------------------------------------------
async function sliceDrift() {
  const base = mkdtempSync(join(tmpdir(), "deck-proj-drift-"));
  const homeRoot = join(base, "home");
  const projA = join(base, "proj-a");
  const projB = join(base, "proj-b");
  for (const p of [homeRoot, projA, projB]) mkdirSync(p, { recursive: true });
  writeCard(homeRoot, "m1", "01", "home-card", "home 卡");
  writeCard(projA, "alpha", "01", "alpha-card", "alpha 卡");
  writeCard(projB, "beta", "01", "beta-card", "beta 卡");

  const s = await startServer(homeRoot);
  try {
    // 同名项改路径:现读口径,下一次调用起指向新路径,不算回退。
    writeRegistry(homeRoot, [{ name: "shared", path: projA }]);
    await s.call("deck_project_use", { name: "shared" });
    const rowsA = (await s.call("deck_issue_list", {})).result?.structuredContent?.rows || [];
    check("漂移: 切到 shared 后读 proj-a", rowsA.length === 1 && rowsA[0]?.effortId === "alpha", JSON.stringify(rowsA));
    writeRegistry(homeRoot, [{ name: "shared", path: projB }]);
    const moved = await s.call("deck_issue_list", {});
    const msc = moved.result?.structuredContent || {};
    check("漂移: 同名项改路径后下一次调用用新路径(无回退说明)",
      msc.rows?.length === 1 && msc.rows[0]?.effortId === "beta" && !("note" in msc), JSON.stringify(msc.rows));

    // 移出清单:下一次工具调用回退 home-repo 并说明。
    writeRegistry(homeRoot, []);
    const out = await s.call("deck_issue_list", {});
    const osc = out.result?.structuredContent || {};
    check("漂移: 活动项目被移出清单 → 回退 home-repo 且回包说明",
      osc.rows?.length === 1 && osc.rows[0]?.effortId === "m1" && typeof osc.note === "string" &&
        /shared/.test(osc.note) && /回退/.test(osc.note), osc.note);
    const out2 = await s.call("deck_issue_list", {});
    const o2sc = out2.result?.structuredContent || {};
    check("漂移: 回退只说明一次(落定后不再重复)",
      !("note" in o2sc) && o2sc.rows?.[0]?.effortId === "m1", JSON.stringify(o2sc.note));

    // 改名:同样的回退语义。
    writeRegistry(homeRoot, [{ name: "shared2", path: projA }]);
    await s.call("deck_project_use", { name: "shared2" });
    writeRegistry(homeRoot, [{ name: "renamed", path: projA }]);
    const rn = await s.call("deck_issue_list", {});
    const rnsc = rn.result?.structuredContent || {};
    check("漂移: 活动项目被改名 → 回退 home-repo 并说明(点名旧名)",
      rnsc.rows?.[0]?.effortId === "m1" && typeof rnsc.note === "string" && /shared2/.test(rnsc.note), rnsc.note);
  } finally {
    await s.stop();
    rmSync(base, { recursive: true, force: true });
  }
}

await sliceNoRegistry();
await sliceValidRegistry();
await sliceBadEntries();
await sliceBrokenRegistry();
await sliceDrift();

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
