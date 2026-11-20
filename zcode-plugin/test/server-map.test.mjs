// M4 工单 01 缝:地图子票电话与目的地字段的契约测试。
// 起 dist/server.mjs(与 server-read 同一会话模式),在临时工作区里种两张地图+子票,断言:
// list 的容器行带 destination;deck_map_tickets 返回全部子票(含已关闭)、归一后的行、统计;
// 同号多图不带 effortId 诚实拒绝;非容器键与坏键走 isError。
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { destinationOf } from "../src/cards.mjs";
import { progressOf } from "../src/map-tickets.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`ok - ${name}`);
  else {
    failures++;
    console.error(`FAIL - ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

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
      setTimeout(() => reject(new Error(`timeout waiting ${method}`)), 5000);
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

function writeCard(dir, name, text) {
  writeFileSync(join(dir, name), text, "utf8");
}

function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "dsws-map-"));
  const scratch = join(root, ".scratch");
  // 工作单元一:探索地图(带 Destination),三张子票(一开/一关/一阻塞带进度)
  const a = join(scratch, "alpha");
  mkdirSync(join(a, "issues"), { recursive: true });
  writeCard(
    a,
    "map.md",
    [
      "<!-- DSH-TITLE: Alpha 地图 -->",
      "<!-- DSH-ISSUE-KIND: map -->",
      "",
      "探索用地图。",
      "",
      "## Destination",
      "",
      "把 alpha 做完。",
      "",
      "## Notes",
      "",
      "- 不画正文。",
      "",
    ].join("\n")
  );
  writeCard(a, "issues/01-first.md", "# 01: 第一张\n\n**Status:** open\n**Labels:** ready-for-agent\n\n正文。\n");
  writeCard(a, "issues/02-done.md", "# 02: 已关的那张\n\n**Status:** resolved\n\n正文。\n");
  writeCard(
    a,
    "issues/03-blocked.md",
    [
      "# 03: 被挡的那张",
      "",
      "**Status:** open",
      "**Labels:** needs-info",
      "**Blocked by:** 01",
      "",
      "## 进度",
      "",
      "- 进度：40%（2026-11-21T10:00+08:00）：做了一半",
      "",
    ].join("\n")
  );
  writeCard(a, "issues/04-claimed.md", "# 04: 有人认领\n\n**Status:** claimed\n**Assignees:** alice\n\n正文。\n");
  // 工作单元二:规格(无 Destination),一张子票 —— 用来验证同号多图与规格行
  const b = join(scratch, "beta");
  mkdirSync(join(b, "issues"), { recursive: true });
  writeCard(b, "spec.md", "# spec: beta\n\n**Status:** open\n\n## Problem Statement\n\n随便写点。\n");
  writeCard(b, "issues/01-t.md", "# 01: beta 的票\n\n**Status:** open\n\n正文。\n");
  return root;
}

const root = makeWorkspace();
const server = await startServer(root);
try {
  // ---- 0. destination 解析:围栏与注释里的同名标题不算 ----
  check("destinationOf 取真节", destinationOf("## Destination\n\n真目的。\n\n## Notes\n不取。\n") === "真目的。");
  check(
    "destinationOf 忽略围栏与注释里的示例",
    destinationOf("```\n## Destination\n假\n```\n<!--\n## Destination\n假\n-->\n## Destination\n真目的。\n") === "真目的。"
  );
  check("destinationOf 没有该节回空串", destinationOf("## Notes\n只有笔记。\n") === "");

  // ---- 0b. 进度读侧:屏蔽代码块/注释,认 Progress/老标题/紧贴标题 ----
  check("progressOf 读普通记录", progressOf("## 进度\n\n- 进度：40%（2026-11-21T10:00+08:00）：做了一半\n") === 40);
  check("progressOf 忽略围栏里的示例", progressOf("## Notes\n\n```md\n## 进度\n\n- 进度：90%\n```\n") === null);
  check("progressOf 忽略注释里的示例", progressOf("<!--\n## 进度\n\n- 进度：88%\n-->\n") === null);
  check("progressOf 认英文标题", progressOf("## Progress\n\n- Progress: 55%\n") === 55);
  check("progressOf 认老标题百分比", progressOf("## 进度：70%\n\n随便写点。\n") === 70);
  check("progressOf 认紧贴标题", progressOf("##进度\n\n- 进度：30%\n") === 30);
  check("progressOf 认老票行首写法", progressOf("正文。\n\n进度：25%\n") === 25);
  check("progressOf 没有进度回 null", progressOf("正文提到进度：7% 而已。\n") === null);
  // ---- 1. list:容器行带 destination ----
  const list = await server.call("deck_issue_list", {});
  const sc = list.result.structuredContent;
  const alphaMap = sc.rows.find((r) => r.effortId === "alpha" && r.key === "00");
  check("list 含 alpha 地图行", !!alphaMap);
  check("地图行 type=map", alphaMap && alphaMap.type === "map");
  check("地图行带 destination", alphaMap && alphaMap.destination === "把 alpha 做完。", alphaMap && alphaMap.destination);
  const betaSpec = sc.rows.find((r) => r.effortId === "beta" && r.key === "00");
  check("规格行 type=spec", betaSpec && betaSpec.type === "spec");
  check("规格行无 destination", betaSpec && betaSpec.destination === undefined);

  // ---- 2. map_tickets:全部子票(含已关闭)、归一、统计 ----
  const got = await server.call("deck_map_tickets", { key: "00", effortId: "alpha" });
  const mt = got.result.structuredContent;
  check("map_tickets 成功", mt && mt.ok === true);
  check("items 四张全回(含已关闭)", mt && mt.items.length === 4, mt && String(mt.items.length));
  check("总数与统计对拍", mt && mt.stats.total === 4 && mt.stats.closed === 1 && mt.stats.open === 3, mt && JSON.stringify(mt.stats));
  check("总数/取回/截断字段", mt && mt.total === 4 && mt.fetched === 4 && mt.capped === false && mt.missing === 0);
  const closed = mt.items.find((t) => t.key === "02");
  check("已关闭行 state=CLOSED", closed && closed.state === "CLOSED", closed && closed.state);
  const blocked = mt.items.find((t) => t.key === "03");
  check("阻塞引用压成键串", blocked && Array.isArray(blocked.blockedBy) && blocked.blockedBy[0] === "01", blocked && JSON.stringify(blocked.blockedBy));
  const blockedRef = blocked && Array.isArray(blocked.blockedByRefs) ? blocked.blockedByRefs[0] : null;
  check("阻塞引用旁表带 key/标题/状态(上游 blockedByRefs)", !!blockedRef && blockedRef.key === "01" && blockedRef.title === "第一张" && blockedRef.state === "open", blocked && JSON.stringify(blocked.blockedByRefs));
  check("进度从正文解析", blocked && blocked.progress === 40, blocked && String(blocked.progress));
  check("行带 number", blocked && blocked.number === 3);
  const claimed = mt.items.find((t) => t.key === "04");
  check("认领人取第一个 assignee", claimed && claimed.claimedBy === "alice", claimed && claimed.claimedBy);
  check("标签原样带出", claimed && Array.isArray(claimed.labels));

  // ---- 3. 带 effort 时不受同号图干扰 ----
  const beta = await server.call("deck_map_tickets", { key: "00", effortId: "beta" });
  const bt = beta.result.structuredContent;
  check("规格的子票只回自己那张", bt && bt.items.length === 1 && bt.items[0].key === "01", bt && JSON.stringify(bt.items.map((x) => x.key)));

  // ---- 4. 同号多图不带 effortId:诚实拒绝 ----
  const ambiguous = await server.call("deck_map_tickets", { key: "00" });
  check("同号多图拒绝", ambiguous.result && ambiguous.result.isError === true);
  check("拒绝文案提示 effortId", ambiguous.result && /effortId/.test(ambiguous.result.content[0].text), ambiguous.result && ambiguous.result.content[0].text);

  // ---- 5. 非容器键 / 坏键 ----
  const notMap = await server.call("deck_map_tickets", { key: "01", effortId: "alpha" });
  check("非容器键拒绝", notMap.result && notMap.result.isError === true);
  check("拒绝文案说明不是地图", notMap.result && /不是地图/.test(notMap.result.content[0].text), notMap.result && notMap.result.content[0].text);
  const missing = await server.call("deck_map_tickets", { key: "99", effortId: "alpha" });
  check("不存在的图拒绝", missing.result && missing.result.isError === true);
  const noKey = await server.call("deck_map_tickets", {});
  check("缺 key 拒绝", noKey.result && noKey.result.isError === true);
} finally {
  await server.stop();
  rmSync(root, { recursive: true, force: true });
}

if (failures) {
  console.error(`\nserver-map: ${failures} 处失败`);
  process.exit(1);
}
console.log("\nserver-map: 全部通过");
