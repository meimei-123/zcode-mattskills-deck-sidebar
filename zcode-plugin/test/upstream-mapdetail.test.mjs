// M4 地图详情页:构建缝与接线缝(渲染行为在 upstream-list 的 M4 切片里真跑)。
// 断言 LEAVES 登记与文件对照、骨架标记原位(相对 ticketRow/detailActionBar/detailProjection)、
// bundle 里的组件/模型/样式/电话适配存在、旧的「未搬」占位已撤、语法过。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BUNDLE = join(ROOT, "dist", "ui", "bundle-1.txt");
const SKELETON = join(ROOT, "src", "ui", "upstream", "entry.mjs");

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`ok - ${name}`);
  else {
    failures++;
    console.error(`FAIL - ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

const code = readFileSync(BUNDLE, "utf8");
const skeleton = readFileSync(SKELETON, "utf8");

// ---- 1. LEAVES 登记(13 叶,id→文件与上游 build.mts 一致) ----
const { LEAVES } = await import(new URL("../build-upstream.mjs", import.meta.url).href);
const want = {
  "leaf:mapV2Styles": "src/client/views/mapDetailV2/view/skin/MapDetailV2Styles.ts",
  "leaf:mapDetailTop": "src/client/views/MapDetailTop.ts",
  "leaf:mapV2TicketFacts": "src/client/views/mapDetailV2/model/tickets/ticketCardFacts.ts",
  "leaf:mapV2TicketBoard": "src/client/views/mapDetailV2/model/tickets/ticketBoard.ts",
  "leaf:mapV2TicketFeed": "src/client/views/mapDetailV2/model/tickets/ticketFeed.ts",
  "leaf:mapV2Profile": "src/client/views/mapDetailV2/model/container/mapProfile.ts",
  "leaf:mapV2CardProps": "src/client/views/mapDetailV2/model/assembly/cardPropsOf.ts",
  "leaf:mapV2PageModel": "src/client/views/mapDetailV2/model/assembly/mapDetailPageModel.ts",
  "leaf:mapV2UseFeed": "src/client/views/mapDetailV2/wiring/useMapTicketsFeed.ts",
  "leaf:mapV2Actions": "src/client/views/mapDetailV2/wiring/pageActionHandlers.ts",
  "leaf:mapV2ProfileHeader": "src/client/views/mapDetailV2/view/profile/MapProfileHeader.ts",
  "leaf:mapV2CardFlow": "src/client/views/mapDetailV2/view/flow/TicketCardFlow.ts",
  "leaf:mapV2Page": "src/client/views/mapDetailV2/view/MapDetailV2Page.ts",
};
for (const [id, file] of Object.entries(want)) {
  const hit = LEAVES.find((l) => l.id === id);
  check(`LEAVES 有 ${id}`, !!hit);
  check(`${id} → ${file}`, hit && hit.file === file, hit && hit.file);
}
// 老页三叶不登记(产品入口已切 V2,#1402)
for (const dead of ["leaf:mapDetailHead", "leaf:mapDetail", "leaf:mapDetailSpecBody"]) {
  check(`老页 ${dead} 不登记(产品不可达)`, !LEAVES.some((l) => l.id === dead));
}

// ---- 2. 骨架标记原位(上游 index.ts 的保序关系) ----
const at = (m) => skeleton.indexOf("// ==== " + m + " (spliced by build) ====");
const order = [
  "leaf:mapDots",
  "leaf:mapV2Styles",
  "leaf:chainRenderer",
  "leaf:ticketRow",
  "leaf:mapDetailTop",
  "leaf:detailActionBar",
  "leaf:mapV2TicketFacts",
  "leaf:mapV2TicketBoard",
  "leaf:mapV2TicketFeed",
  "leaf:mapV2Profile",
  "leaf:mapV2CardProps",
  "leaf:mapV2PageModel",
  "leaf:mapV2UseFeed",
  "leaf:mapV2Actions",
  "leaf:mapV2ProfileHeader",
  "leaf:mapV2CardFlow",
  "leaf:mapV2Page",
  "leaf:detailProjection",
];
let prev = -1;
for (const m of order) {
  const i = at(m);
  check(`骨架有标记 ${m}`, i >= 0);
  check(`${m} 次序在 ${order[Math.max(0, order.indexOf(m) - 1)]} 之后`, i > prev, `${i} vs ${prev}`);
  prev = i;
}
check(
  "样式插入紧跟卡片样式(styles.insert(MapDetailV2) 在 mapV2Styles 之后)",
  skeleton.indexOf("styles.insert(MAP_DETAIL_V2_STYLE_TEXT)") > at("leaf:mapV2Styles")
);

// ---- 3. bundle 接线 ----
check("bundle 有 MapDetailV2Page", code.includes("function MapDetailV2Page"));
check("bundle 有页面模型 mapDetailPageModelOf", code.includes("function mapDetailPageModelOf"));
check("bundle 有档案模型 mapProfileOf", code.includes("function mapProfileOf"));
check("bundle 有样式常量 MAP_DETAIL_V2_STYLE_TEXT", code.includes("MAP_DETAIL_V2_STYLE_TEXT"));
check("bundle 插入 V2 样式", /styles\.insert\(MAP_DETAIL_V2_STYLE_TEXT\)/.test(code));
check("host 适配 wf.mapTickets", code.includes('method === "wf.mapTickets"'));
check("适配打 deck_map_tickets", code.includes('callTool("deck_map_tickets"'));
check("list 分支按 active 渲染 V2", /findGroupByIdentity\(compute\(st\), topMap, topEffort\)/.test(code) && /MapDetailV2Page, \{ st, g: activeMap \}/.test(code));
check("旧占位文案已撤", !code.includes("mapV2 家族未搬"));
check("自检面 window.MattSkillsUpstream.map", code.includes("MattSkillsUpstream.map"));
check("无拼接标记残留", !/\(spliced by build\)/.test(code));
try {
  new vm.Script(code);
  check("bundle 语法过(vm.Script)", true);
} catch (e) {
  check("bundle 语法过(vm.Script)", false, e.message);
}

if (failures) {
  console.error(`\nupstream-mapdetail: ${failures} 处失败`);
  process.exit(1);
}
console.log("\nupstream-mapdetail: 全部通过");
